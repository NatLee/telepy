//! 網頁終端機錄影：開了 `record_sessions` 的隧道，終端機的**輸出**與視窗大小變化寫成 asciicast v2（一行 JSON 一個事件），
//! 存在 `DATA_DIR/recordings/<tunnel>/<random>.cast`，索引在 `telepy_terminal_recording`。不錄鍵盤輸入（打的密碼不會進檔）。
//! 每個檔最多 [`MAX_BYTES`]，超過就停錄並標 `truncated`。保留天數看站台設定 `recording_retention_days`（每小時清一次）。
//! Web terminal recording: for tunnels with `record_sessions`, terminal **output** and resizes are written as asciicast
//! v2 (one JSON event per line). Keystrokes are never recorded, so typed passwords stay out of the file. Each file is
//! capped at [`MAX_BYTES`] (then marked `truncated`); retention follows `recording_retention_days`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};

use crate::db;
use crate::state::AppState;
use crate::util::{db_time, random_alnum};

/// 單一錄影檔的上限。/ The cap per recording file.
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
const FLUSH_EVERY: Duration = Duration::from_secs(1);
const PURGE_INTERVAL: Duration = Duration::from_secs(3600);

/// 錄影檔的根目錄。/ The recordings directory.
pub fn root(state: &AppState) -> PathBuf {
    state.config.data_dir.join("recordings")
}

/// asciicast v2 的檔頭。/ The asciicast v2 header line.
pub fn header(cols: u32, rows: u32, unix: i64, title: &str) -> String {
    json!({ "version": 2, "width": cols, "height": rows, "timestamp": unix, "title": title, "env": { "TERM": "xterm-256color" } }).to_string()
}

/// 一個事件：`[秒數, 種類, 資料]`（`o` = 輸出，`r` = 視窗大小 "COLSxROWS"）。/ One event: `[seconds, kind, data]`.
pub fn event(seconds: f64, kind: &str, data: &str) -> String {
    let t = (seconds * 1_000_000.0).round() / 1_000_000.0;
    json!([t, kind, data]).to_string()
}

/// 錄影檔的實際路徑：只接受 `<數字>/<英數>.cast`，免得索引被竄改時讀到別的檔。
/// The file on disk; only `<digits>/<alnum>.cast` is accepted, so a tampered index can't point elsewhere.
pub fn resolve(root: &Path, file: &str) -> Option<PathBuf> {
    let (dir, name) = file.split_once('/')?;
    let stem = name.strip_suffix(".cast")?;
    let ok = !dir.is_empty() && dir.chars().all(|c| c.is_ascii_digit()) && !stem.is_empty() && stem.chars().all(|c| c.is_ascii_alphanumeric());
    ok.then(|| root.join(dir).join(name))
}

/// 檔案裡最後一個事件的時間（毫秒）：重啟時沒收尾的錄影用它補長度。/ The last event's time in ms (for recordings a restart cut off).
pub fn duration_from(contents: &str) -> i64 {
    contents
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v.get(0).and_then(serde_json::Value::as_f64)))
        .map(|s| (s * 1000.0).round() as i64)
        .unwrap_or(0)
}

pub struct Recorder {
    id: i64,
    out: BufWriter<File>,
    started: Instant,
    last_flush: Instant,
    bytes: u64,
    truncated: bool,
}

impl Recorder {
    /// 開始錄（檔案 + 索引）。失敗只記 log，不影響終端機。/ Start recording; a failure is logged and never blocks the terminal.
    pub async fn start(state: &AppState, tunnel_id: i64, user_id: i64, username: &str, os_user: &str, lan_host: Option<&str>, title: &str) -> Option<Self> {
        let rel = format!("{tunnel_id}/{}.cast", random_alnum(20));
        let path = resolve(&root(state), &rel)?;
        let result = async {
            if let Some(dir) = path.parent() {
                tokio::fs::create_dir_all(dir).await?;
            }
            let mut out = BufWriter::new(File::create(&path).await?);
            let head = header(80, 24, chrono::Utc::now().timestamp(), title);
            out.write_all(head.as_bytes()).await?;
            out.write_all(b"\n").await?;
            out.flush().await?;
            let id = db::recordings::create(&state.db, tunnel_id, user_id, username, os_user, lan_host, &rel).await?;
            anyhow::Ok(Self { id, out, started: Instant::now(), last_flush: Instant::now(), bytes: head.len() as u64 + 1, truncated: false })
        };
        match result.await {
            Ok(r) => Some(r),
            Err(e) => {
                tracing::warn!(error = format!("{e:#}"), tunnel = tunnel_id, "terminal recording could not start");
                None
            }
        }
    }

    pub fn id(&self) -> i64 {
        self.id
    }

    async fn write(&mut self, kind: &str, data: &str) {
        if self.truncated {
            return;
        }
        let line = event(self.started.elapsed().as_secs_f64(), kind, data);
        if self.bytes + line.len() as u64 + 1 > MAX_BYTES {
            self.truncated = true;
            return;
        }
        if self.out.write_all(line.as_bytes()).await.is_err() || self.out.write_all(b"\n").await.is_err() {
            self.truncated = true;
            return;
        }
        self.bytes += line.len() as u64 + 1;
        // 每秒寫一次盤，正在錄的也看得到。/ Flush every second so a live recording can be watched too.
        if self.last_flush.elapsed() >= FLUSH_EVERY {
            let _ = self.out.flush().await;
            self.last_flush = Instant::now();
        }
    }

    pub async fn output(&mut self, text: &str) {
        self.write("o", text).await;
    }

    pub async fn resize(&mut self, cols: u32, rows: u32) {
        self.write("r", &format!("{cols}x{rows}")).await;
    }

    /// 收尾：寫盤、更新長度與大小。/ Finish: flush and record the duration and size.
    pub async fn finish(mut self, state: &AppState) {
        let _ = self.out.flush().await;
        let ms = self.started.elapsed().as_millis() as i64;
        if let Err(e) = db::recordings::finish(&state.db, self.id, ms, self.bytes as i64, self.truncated).await {
            tracing::warn!(error = %e, recording = self.id, "terminal recording could not be finished");
        }
    }
}

/// 刪一筆錄影（檔案 + 索引）。/ Delete one recording, file and row.
pub async fn remove(state: &AppState, rec: &db::recordings::Recording) -> sqlx::Result<()> {
    if let Some(path) = resolve(&root(state), &rec.file) {
        let _ = tokio::fs::remove_file(path).await;
    }
    db::recordings::delete(&state.db, rec.id).await
}

/// 隧道刪除前先拿走它的錄影檔（列會跟著隧道一起刪）。/ Remove a tunnel's recording files before it is deleted.
pub async fn forget_tunnel(state: &AppState, tunnel_id: i64) {
    if let Ok(list) = db::recordings::for_tunnel(&state.db, tunnel_id).await {
        for r in list {
            if let Some(path) = resolve(&root(state), &r.file) {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
    }
    let _ = tokio::fs::remove_dir(root(state).join(tunnel_id.to_string())).await;
}

/// 刪掉超過保留天數的錄影，回傳刪了幾筆（0 天 = 一直留）。/ Delete recordings past the retention; 0 days keeps them.
pub async fn purge_expired(state: &AppState) -> sqlx::Result<usize> {
    let days = db::settings::get_solo(&state.db).await?.recording_retention_days;
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = db_time(chrono::Utc::now() - chrono::Duration::days(days));
    let old = db::recordings::ended_before(&state.db, &cutoff).await?;
    for r in &old {
        remove(state, r).await?;
    }
    Ok(old.len())
}

/// 啟動時：重啟前沒收尾的標成結束；之後每小時清過期的。/ On start, close recordings a restart left open; then purge hourly.
pub async fn run(state: AppState) {
    if let Ok(open) = db::recordings::close_dangling(&state.db).await {
        for r in open {
            let contents = match resolve(&root(&state), &r.file) {
                Some(p) => tokio::fs::read_to_string(p).await.unwrap_or_default(),
                None => String::new(),
            };
            let _ = db::recordings::finish(&state.db, r.id, duration_from(&contents), contents.len() as i64, r.truncated).await;
        }
    }
    loop {
        match purge_expired(&state).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(recordings = n, "retention: purged old terminal recordings"),
            Err(e) => tracing::warn!(error = %e, "retention: recording purge failed"),
        }
        tokio::time::sleep(PURGE_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asciicast_lines() {
        let h: serde_json::Value = serde_json::from_str(&header(120, 40, 1_700_000_000, "alice@box")).unwrap();
        assert_eq!((h["version"].as_i64(), h["width"].as_i64(), h["height"].as_i64()), (Some(2), Some(120), Some(40)));
        assert_eq!(event(1.234_567_89, "o", "hi\r\n"), r#"[1.234568,"o","hi\r\n"]"#);
        assert_eq!(event(2.0, "r", "100x30"), r#"[2.0,"r","100x30"]"#);
        let file = format!("{}\n{}\n{}\n", header(80, 24, 0, "x"), event(0.5, "o", "a"), event(3.25, "r", "90x30"));
        assert_eq!(duration_from(&file), 3250);
        assert_eq!(duration_from(&header(80, 24, 0, "x")), 0, "header only");
    }

    #[test]
    fn only_our_own_file_names_resolve() {
        let root = Path::new("/data/recordings");
        assert_eq!(resolve(root, "12/abcDEF123.cast"), Some(PathBuf::from("/data/recordings/12/abcDEF123.cast")));
        assert_eq!(resolve(root, "../etc/passwd"), None);
        assert_eq!(resolve(root, "12/../../x.cast"), None);
        assert_eq!(resolve(root, "12/a.b.cast"), None);
        assert_eq!(resolve(root, "x/abc.cast"), None);
        assert_eq!(resolve(root, "12/abc.txt"), None);
    }
}
