//! `GET /api/site/health/stats`（管理員）：伺服器狀態頁每次按「重新整理」都會叫的便宜數字——
//! 版本 / 運行時間、隧道健康、閘道連線、在線 session、帳號、儲存空間、最近 24 小時的活動、webhook。
//! 不連任何裝置、不走稽核鏈，只有記憶體裡的狀態和幾個走索引的計數查詢（read pool），目錄大小有上限。
//! The admin Server health page's cheap numbers, fetched on every Refresh: version / uptime, tunnel health,
//! gateway connections, live sessions, accounts, storage, the last 24 hours of activity and webhooks. No device
//! round trips and no audit-chain walk: in-memory state plus a few indexed counts on the read pool; directory
//! walks are capped.

use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Duration, SecondsFormat, Timelike, Utc};
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::monitor::Health;
use crate::presence::Kind;
use crate::state::AppState;

/// 分桶數（每桶一小時）。/ Number of hourly buckets.
pub const HOURS: usize = 24;

/// 目錄走訪最多看幾個項目（檔案 + 資料夾），超過就停、回報已算到的。/ Directory walks stop after this many entries.
pub const WALK_CAP: usize = 20_000;

/// 算成「有問題」的閘道事件種類 = Logs 頁「需要注意」那一類（前端 `lib/gatewayLogs.ts` 的 `problem`）：
/// 被拒的連線 / forward / direct-tcpip / PROXY header、金鑰認證失敗、未知帳號、過期金鑰、主機金鑰不符、
/// 別的帳號宣稱這台機器、裝置警示、降級、需要再次驗證、被擋下的指令。
/// Gateway event kinds counted as problems = the Logs page's "needs attention" category (`problem` in
/// `lib/gatewayLogs.ts`): refused connections / forwards / direct-tcpip / PROXY headers, failed public keys,
/// unknown users, expired keys, host-key mismatches, claims on someone else's machine, device warnings,
/// degraded tunnels, step-up required and blocked commands.
pub const PROBLEM_KINDS: &[&str] = &[
    "refused_forward",
    "refused_direct",
    "refused_proxy",
    "failed_publickey",
    "invalid_user",
    "expired_key",
    "host_key_mismatch",
    "claim_refused",
    "claim_attempt",
    "device_warning",
    "degraded",
    "step_up_required",
    "command_blocked",
];

/// 每種在線 session，固定順序（JSON 裡每種都有，沒有就是 0）。/ Every presence kind, in a fixed order.
pub const SESSION_KINDS: [Kind; 8] = [Kind::Terminal, Kind::Files, Kind::Browser, Kind::Desktop, Kind::RustDesk, Kind::Ssh, Kind::Watch, Kind::Ai];

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(server_stats))
}

/// 把 (桶號, 全部, 有問題的) 填進兩條長度 `n` 的序列；超出範圍的桶號：負的丟掉，`≥ n` 算進最後一桶
/// （`now` 落在最後一秒時會算出 `n`）。
/// Fill (index, all, flagged) rows into two series of length `n`; negative indices are dropped and `≥ n`
/// lands in the last bucket (an event in the very last second computes `n`).
pub fn fill(rows: &[(i64, i64, i64)], n: usize) -> (Vec<i64>, Vec<i64>) {
    let mut all = vec![0; n];
    let mut flagged = vec![0; n];
    if n == 0 {
        return (all, flagged);
    }
    for &(i, a, f) in rows {
        if i < 0 {
            continue;
        }
        let i = (i as usize).min(n - 1);
        all[i] += a;
        flagged[i] += f;
    }
    (all, flagged)
}

/// 窗口起點：`now` 去掉小數秒再往前 `n` 小時（SQL 的桶號用整數秒算）。
/// The window start: `now` without sub-seconds, minus `n` hours (the SQL buckets use whole seconds).
pub fn window_start(now: DateTime<Utc>, n: usize) -> DateTime<Utc> {
    now.with_nanosecond(0).unwrap_or(now) - Duration::hours(n as i64)
}

/// 每一桶的起點（RFC 3339，`Z`）。/ Each bucket's start (RFC 3339, `Z`).
pub fn bucket_starts(start: DateTime<Utc>, n: usize) -> Vec<String> {
    (0..n).map(|i| (start + Duration::hours(i as i64)).to_rfc3339_opts(SecondsFormat::Secs, true)).collect()
}

/// 依種類數在線 session（每種都列，沒有就是 0）。/ Count live sessions per kind (every kind listed).
pub fn sessions_by_kind(kinds: impl IntoIterator<Item = Kind>) -> serde_json::Map<String, Value> {
    let mut counts = [0i64; SESSION_KINDS.len()];
    for k in kinds {
        if let Some(i) = SESSION_KINDS.iter().position(|s| *s == k) {
            counts[i] += 1;
        }
    }
    SESSION_KINDS.iter().zip(counts).map(|(k, c)| (k.as_str().to_string(), json!(c))).collect()
}

/// 依健康狀態數隧道。/ Count tunnels per health.
pub fn health_counts(healths: impl IntoIterator<Item = Health>) -> Value {
    let (mut online, mut degraded, mut offline, mut never, mut total) = (0, 0, 0, 0, 0);
    for h in healths {
        total += 1;
        match h {
            Health::Online => online += 1,
            Health::Degraded => degraded += 1,
            Health::Offline => offline += 1,
            Health::Never => never += 1,
        }
    }
    json!({ "total": total, "online": online, "degraded": degraded, "offline": offline, "never": never })
}

/// 一個目錄樹的大小（不跟隨符號連結）。/ A directory tree's size (symlinks not followed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirSize {
    pub bytes: u64,
    pub entries: usize,
    /// 看到 `cap` 個項目就停了：`bytes` 只是已算到的部分。/ Stopped at `cap` entries: `bytes` is a lower bound.
    pub truncated: bool,
}

/// 走訪 `root` 加總檔案大小，最多 `cap` 個項目；`root` 不存在 = 0，讀不到 `root` = None。
/// Sum file sizes under `root`, at most `cap` entries; a missing `root` is 0, an unreadable one None.
pub fn dir_size(root: &Path, cap: usize) -> Option<DirSize> {
    let meta = match std::fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(DirSize { bytes: 0, entries: 0, truncated: false }),
        Err(_) => return None,
    };
    if !meta.is_dir() {
        return Some(DirSize { bytes: meta.len(), entries: 1, truncated: false });
    }
    let mut out = DirSize { bytes: 0, entries: 0, truncated: false };
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            if dir == root {
                return None;
            }
            continue;
        };
        for entry in read.flatten() {
            if out.entries >= cap {
                out.truncated = true;
                return Some(out);
            }
            out.entries += 1;
            let Ok(m) = entry.metadata() else { continue };
            if m.is_dir() {
                stack.push(entry.path());
            } else if m.is_file() {
                out.bytes += m.len();
            }
        }
    }
    Some(out)
}

/// 一個檔案的大小（沒有 = 0）。/ A file's size (0 when missing).
fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 資料目錄所在檔案系統的 (可用, 總共) 位元組。/ Free and total bytes of the data directory's filesystem.
fn fs_space(path: &Path) -> Option<(u64, u64)> {
    let s = nix::sys::statvfs::statvfs(path).ok()?;
    let frag = s.fragment_size() as u64;
    Some((s.blocks_available() as u64 * frag, s.blocks() as u64 * frag))
}

/// 儲存空間：資料庫檔與 WAL、資料目錄的檔案系統、錄影與日誌目錄（在 blocking 執行緒上跑）。
/// Storage: the database file and its WAL, the data directory's filesystem, recordings and logs (blocking thread).
fn storage(db_path: PathBuf, data_dir: PathBuf, log_root: PathBuf) -> Value {
    let mut wal = db_path.clone().into_os_string();
    wal.push("-wal");
    let data = fs_space(&data_dir).map(|(free, total)| json!({ "path": data_dir.display().to_string(), "free_bytes": free, "total_bytes": total }));
    let recordings = dir_size(&data_dir.join("recordings"), WALK_CAP);
    let logs = dir_size(&log_root, WALK_CAP);
    json!({
        "db_bytes": file_len(&db_path),
        "wal_bytes": file_len(Path::new(&wal)),
        "data_dir": data,
        "recordings_bytes": recordings.map(|d| d.bytes),
        "recordings_truncated": recordings.is_some_and(|d| d.truncated),
        "logs_bytes": logs.map(|d| d.bytes),
        "logs_truncated": logs.is_some_and(|d| d.truncated),
    })
}

#[utoipa::path(get, path = "/api/site/health/stats", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "Cheap server numbers for the Server health page (superusers): version and uptime, tunnel health, gateway connections, live sessions, accounts, storage, the last 24 hours of activity in hourly buckets and webhooks. No device round trips; safe to call on every refresh", body = super::schemas::ServerStats),
    (status = 403, body = super::schemas::ErrorBody)
))]
async fn server_stats(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<impl IntoResponse> {
    if !me.is_superuser {
        return Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Only administrators can see the server's statistics.", "code": "admin_only" })));
    }
    let now = Utc::now();
    let start = window_start(now, HOURS);
    let (start_db, end_db, since_db) = (crate::util::db_time(start), crate::util::db_time(now), crate::util::db_time(now - Duration::hours(24)));
    let start_unix = start.timestamp();

    // 隧道健康：與列表的 `health` 同一個分類。/ Tunnel health: the list items' classification.
    let ports = db::server_stats::tunnel_ports(&state.db).await?;
    let ever = db::server_stats::ever_connected(&state.db).await?;
    let listen = state.status.listen_ports().unwrap_or_default();
    let tunnels = health_counts(ports.iter().map(|&(id, port)| {
        let port = u16::try_from(port).ok();
        let listening = port.is_some_and(|p| listen.contains(&p));
        let failures = port.map(|p| state.status.probe_failures(p)).unwrap_or(0);
        crate::monitor::health(listening, failures, listening || ever.contains(&id))
    }));

    let (connections, forwards) = state.gateway.counts();
    let entries = state.presence.all();
    let (u_total, u_active, u_admins, u_signed) = db::server_stats::users(&state.db, &since_db).await?;

    let gw = db::server_stats::gateway_buckets(&state.db, &start_db, &end_db, start_unix, PROBLEM_KINDS).await?;
    let si = db::server_stats::sign_in_buckets(&state.db, &start_db, &end_db, start_unix).await?;
    let api = db::server_stats::api_call_buckets(&state.db, &start_db, &end_db, start_unix).await?;
    let (gw_all, gw_bad) = fill(&gw, HOURS);
    let (si_all, si_bad) = fill(&si, HOURS);
    let (api_all, api_bad) = fill(&api, HOURS);

    let (w_total, w_enabled, w_paused, w_failing) = db::server_stats::webhooks(&state.db, &since_db).await?;

    let c = &state.config;
    let (db_path, data_dir, log_root) = (c.db_path.clone(), c.data_dir.clone(), c.log_root.clone());
    let storage = tokio::task::spawn_blocking(move || storage(db_path, data_dir, log_root)).await.unwrap_or(Value::Null);

    let body = json!({
        "server": {
            // 發行版建置時蓋上的版本（和 CLI 一樣的 TELEPY_VERSION）；本機建的映像沒有 → null（crate 的 0.1.0 不是發行版號）。
            // The release version stamped at build time (TELEPY_VERSION, as for the CLI); locally built images have none
            // → null (the crate's 0.1.0 is not a release number).
            "version": option_env!("TELEPY_VERSION"),
            "started_at": state.started_at.to_rfc3339_opts(SecondsFormat::Secs, true),
            "uptime_secs": state.started.elapsed().as_secs(),
            "now": now.to_rfc3339_opts(SecondsFormat::Secs, true),
        },
        "tunnels": tunnels,
        "gateway": { "connections": connections, "forwards": forwards },
        "sessions": { "total": entries.len(), "by_kind": sessions_by_kind(entries.iter().map(|e| e.kind)) },
        "users": { "total": u_total, "active": u_active, "admins": u_admins, "signed_in_24h": u_signed },
        "storage": storage,
        "activity": {
            "hours": bucket_starts(start, HOURS),
            "gateway_events": gw_all,
            "gateway_problems": gw_bad,
            "sign_ins": si_all,
            "sign_ins_failed": si_bad,
            "api_calls": api_all,
            "api_errors": api_bad,
        },
        "webhooks": { "total": w_total, "enabled": w_enabled, "paused": w_paused, "failing_recent": w_failing },
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn fill_places_rows_and_clamps_the_edges() {
        let rows = [(0, 3, 1), (5, 2, 0), (23, 1, 1), (24, 4, 2), (-1, 9, 9)];
        let (all, bad) = fill(&rows, HOURS);
        assert_eq!(all.len(), 24);
        assert_eq!(bad.len(), 24);
        assert_eq!((all[0], bad[0]), (3, 1));
        assert_eq!((all[5], bad[5]), (2, 0));
        // 23 與「剛好 now 的那一秒」(24) 都進最後一桶；負的丟掉。/ 23 and the last second (24) share the last bucket.
        assert_eq!((all[23], bad[23]), (5, 3));
        assert_eq!(all.iter().sum::<i64>(), 10);
        assert_eq!(fill(&rows, 0), (vec![], vec![]));
    }

    #[test]
    fn buckets_start_a_day_back_on_whole_seconds() {
        let now = Utc.with_ymd_and_hms(2026, 10, 30, 12, 34, 56).unwrap() + Duration::milliseconds(789);
        let start = window_start(now, HOURS);
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 10, 29, 12, 34, 56).unwrap());
        let hours = bucket_starts(start, HOURS);
        assert_eq!(hours.len(), 24);
        assert_eq!(hours[0], "2026-10-29T12:34:56Z");
        assert_eq!(hours[1], "2026-10-29T13:34:56Z");
        assert_eq!(hours[23], "2026-10-30T11:34:56Z");
    }

    #[test]
    fn sessions_list_every_kind() {
        let m = sessions_by_kind([Kind::Terminal, Kind::Terminal, Kind::Ai, Kind::Watch]);
        assert_eq!(m.len(), SESSION_KINDS.len());
        assert_eq!(m["terminal"], 2);
        assert_eq!(m["ai"], 1);
        assert_eq!(m["watch"], 1);
        assert_eq!(m["rustdesk"], 0);
        assert_eq!(m["ssh"], 0);
    }

    #[test]
    fn health_is_counted_per_state() {
        let v = health_counts([Health::Online, Health::Online, Health::Degraded, Health::Never]);
        assert_eq!(v, json!({ "total": 4, "online": 2, "degraded": 1, "offline": 0, "never": 1 }));
    }

    #[test]
    fn problem_kinds_are_plain_identifiers() {
        assert!(PROBLEM_KINDS.iter().all(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')));
    }

    #[test]
    fn dir_size_sums_files_and_stops_at_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(dir_size(&dir.path().join("missing"), 10), Some(DirSize { bytes: 0, entries: 0, truncated: false }));
        std::fs::write(dir.path().join("a"), b"hello").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/b"), b"123").unwrap();
        assert_eq!(dir_size(dir.path(), 10), Some(DirSize { bytes: 8, entries: 3, truncated: false }));
        let capped = dir_size(dir.path(), 1).unwrap();
        assert!(capped.truncated);
        assert_eq!(capped.entries, 1);
    }
}
