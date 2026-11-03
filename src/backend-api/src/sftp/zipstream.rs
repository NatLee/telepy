//! 資料夾下載 = 邊打包邊送的 zip：不先在後端寫完整個暫存檔，第一個位元組馬上出去。
//!
//! 以前整包 zip 先寫進後端的暫存檔才開始回應：大資料夾在前面的代理（Nginx Proxy Manager ~90 s、Cloudflare
//! 100 s）等不到第一個位元組就切斷，axum 跟著丟掉 handler，打包做到一半；而且後端的磁碟要放得下整包。
//! 現在分兩半：
//! - **讀**（async task）：走 SFTP 樹，把「資料夾 / 檔案開頭 / 資料塊 / 連結」一則則送進一條有界的 channel；
//! - **寫**（`spawn_blocking`）：擁有 `ZipWriter`（壓縮吃 CPU，不放在 tokio worker 上），寫出來的位元組再送給
//!   回應的 body。瀏覽器慢 → body 不讀 → 兩條 channel 都滿 → 讀的那半停下來等，記憶體只有幾 MB。
//!   瀏覽器走了 → 送不出去 → 兩半都結束。
//!
//! 樹裡的東西**不跟著 symlink 走**（跟刪除、遞迴權限一樣）：連結以連結存進 zip（解開後還是連結），不會繞圈、
//! 不會跑出資料夾。讀不到的檔案 / 資料夾（權限、檔案中途消失）不會讓整包失敗：跳過，最後在 zip 根目錄放一個
//! [`NOTE_NAME`] 列出來。已經壓縮過的格式（jpg、mp4、zip…）用 Stored，其他用最快的 Deflate。
//!
//! Folder downloads as a zip written while it is sent: the first bytes leave at once instead of after the whole
//! archive was built in a temp file (proxies in front gave up on big folders before that, and the backend's disk
//! had to hold it all). An async task walks the tree and feeds a bounded channel; a blocking thread owns the
//! `ZipWriter` (deflate is CPU work) and feeds the response body. Back-pressure flows through both channels; a
//! client that goes away ends both halves. Symlinks are stored as links, never followed. Unreadable entries are
//! skipped and listed in [`NOTE_NAME`] instead of failing the whole download.

use std::cell::RefCell;
use std::io::{self, Write};
use std::ops::Deref;
use std::rc::Rc;

use bytes::Bytes;
use futures::Stream;
use russh_sftp::client::SftpSession;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

use super::{basename, list_dir};

/// 讀檔一次讀多少。/ Bytes read from the device per chunk.
pub const CHUNK: usize = 256 * 1024;
/// 寫出去的位元組攢到多少才送一次。/ Output is sent once this much has collected.
const FLUSH_AT: usize = 64 * 1024;
/// 被跳過的東西列在 zip 根目錄的這個檔案裡。/ Skipped entries are listed in this file at the root of the zip.
pub const NOTE_NAME: &str = "TELEPY-SKIPPED.txt";
/// 超過這個大小就用 zip64（檔案在下載時長大也還有空間）。/ Files above this get zip64 (room to grow meanwhile).
const LARGE_FILE: u64 = 0xE000_0000;
/// 筆記最多列幾行。/ Lines listed in the note at most.
const NOTE_MAX_LINES: usize = 1000;

/// 讀的那半送給寫的那半的一則。/ One message from the reading half to the writing half.
#[derive(Debug)]
enum Item {
    Dir { name: String, mode: u32, mtime: Option<u32> },
    File { name: String, mode: u32, mtime: Option<u32>, size: u64 },
    Data(Vec<u8>),
    Link { name: String, target: String, mtime: Option<u32> },
    Note(String),
}

/// 跳過的一個東西。/ One skipped entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    /// zip 裡的名稱（相對）。/ Its name inside the zip.
    pub name: String,
    pub reason: String,
}

/// 收件端走了（瀏覽器關掉、連線斷了）。/ The receiving side went away.
struct Gone;

/// 已經壓縮過的格式：再壓只是浪費 CPU。/ Formats that are compressed already.
pub fn stored(name: &str) -> bool {
    const EXT: &[&str] = &[
        "7z", "aac", "apk", "avif", "br", "bz2", "cab", "deb", "dmg", "docx", "epub", "flac", "gif", "gz", "heic", "heif", "iso", "jar", "jpeg", "jpg", "lz", "lz4",
        "lzma", "m4a", "m4v", "mkv", "mov", "mp3", "mp4", "odp", "ods", "odt", "ogg", "opus", "png", "pptx", "rar", "rpm", "tbz", "tgz", "txz", "webm", "webp", "whl",
        "xlsx", "xz", "zip", "zst",
    ];
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => EXT.contains(&ext.to_ascii_lowercase().as_str()),
        _ => false,
    }
}

/// 最上層每個東西在 zip 裡的名字：同名的加 ` (2)`、` (3)`；根目錄沒有名字就叫 `files`；也避開 [`NOTE_NAME`]。
/// Top-level names in the zip: duplicates get ` (2)`, ` (3)`; a nameless root is `files`; [`NOTE_NAME`] is kept free.
pub fn root_names(paths: &[String]) -> Vec<String> {
    let mut taken: Vec<String> = vec![NOTE_NAME.to_string()];
    paths
        .iter()
        .map(|p| {
            let base = basename(p);
            let base = if base.is_empty() || base.ends_with(':') { "files".to_string() } else { base };
            let mut name = base.clone();
            let mut n = 2;
            while taken.iter().any(|t| t == &name) {
                name = match base.rsplit_once('.') {
                    Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({n}).{ext}"),
                    _ => format!("{base} ({n})"),
                };
                n += 1;
            }
            taken.push(name.clone());
            name
        })
        .collect()
}

/// 跳過清單的文字（給打開 zip 的人看；英文，跟裝置上的錯誤訊息同一種語言）。
/// The note listing what was skipped (English, like the device's own error messages).
pub fn note_text(skipped: &[Skipped]) -> String {
    let mut s = String::from("Telepy could not read these from the device, so they are not in this zip (or are cut short):\n\n");
    for k in skipped.iter().take(NOTE_MAX_LINES) {
        s.push_str(&format!("{}: {}\n", k.name, k.reason));
    }
    if skipped.len() > NOTE_MAX_LINES {
        s.push_str(&format!("… and {} more\n", skipped.len() - NOTE_MAX_LINES));
    }
    s
}

/// SFTP 的 mtime（epoch 秒）→ zip 的時間（以 `tz_offset_minutes` 的當地時間；1980 以前 / 讀不到 = zip 的預設）。
/// An SFTP mtime as a zip timestamp in local time at `tz_offset_minutes`.
pub fn zip_time(mtime: Option<u32>, tz_offset_minutes: i32) -> DateTime {
    use chrono::{Datelike, Timelike};
    let Some(t) = mtime else { return DateTime::default() };
    let Some(utc) = chrono::DateTime::from_timestamp(i64::from(t), 0) else { return DateTime::default() };
    let local = utc.naive_utc() + chrono::Duration::minutes(i64::from(tz_offset_minutes));
    let (Ok(year), Ok(month), Ok(day)) = (u16::try_from(local.year()), u8::try_from(local.month()), u8::try_from(local.day())) else { return DateTime::default() };
    DateTime::from_date_and_time(year, month, day, local.hour() as u8, local.minute() as u8, local.second() as u8).unwrap_or_default()
}

fn options(name: &str, mode: u32, mtime: Option<u32>, size: u64, tz: i32) -> SimpleFileOptions {
    let method = if stored(name) || size == 0 { CompressionMethod::Stored } else { CompressionMethod::Deflated };
    let opts = SimpleFileOptions::default()
        .compression_method(method)
        .unix_permissions(mode & 0o7777)
        .last_modified_time(zip_time(mtime, tz))
        .large_file(size > LARGE_FILE);
    if method == CompressionMethod::Deflated {
        opts.compression_level(Some(1))
    } else {
        opts
    }
}

/// `ZipWriter` 寫進來的位元組先放這裡，攢夠了再送給 body。/ Bytes from the `ZipWriter`, collected before sending.
#[derive(Clone, Default)]
struct Sink(Rc<RefCell<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Sink {
    /// 送出攢著的（`all` = 不管多少都送）。/ Send what collected (`all` = whatever the amount).
    fn drain(&self, out: &mpsc::Sender<io::Result<Bytes>>, all: bool) -> Result<(), Gone> {
        let mut buf = self.0.borrow_mut();
        if buf.is_empty() || (!all && buf.len() < FLUSH_AT) {
            return Ok(());
        }
        let bytes = Bytes::from(std::mem::take(&mut *buf));
        out.blocking_send(Ok(bytes)).map_err(|_| Gone)
    }
}

/// 寫的那半（在 `spawn_blocking` 裡跑）。/ The writing half, run in `spawn_blocking`.
fn write_zip(mut rx: mpsc::Receiver<Item>, out: mpsc::Sender<io::Result<Bytes>>, tz: i32) {
    let sink = Sink::default();
    let mut zip = ZipWriter::new_stream(sink.clone());
    let fail = |e: zip::result::ZipError| {
        tracing::warn!(error = %e, "streamed zip failed");
        let _ = out.blocking_send(Err(io::Error::other(e.to_string())));
    };
    while let Some(item) = rx.blocking_recv() {
        let done = match item {
            Item::Dir { name, mode, mtime } => {
                zip.add_directory(format!("{name}/"), SimpleFileOptions::default().unix_permissions(mode & 0o7777).last_modified_time(zip_time(mtime, tz)))
            }
            Item::File { name, mode, mtime, size } => {
                let opts = options(&name, mode, mtime, size, tz);
                zip.start_file(name, opts)
            }
            Item::Data(data) => zip.write_all(&data).map_err(zip::result::ZipError::from),
            Item::Link { name, target, mtime } => zip.add_symlink(name, target, SimpleFileOptions::default().last_modified_time(zip_time(mtime, tz))),
            Item::Note(text) => zip.start_file(NOTE_NAME, SimpleFileOptions::default()).and_then(|_| zip.write_all(text.as_bytes()).map_err(Into::into)),
        };
        if let Err(e) = done {
            return fail(e);
        }
        if sink.drain(&out, false).is_err() {
            return;
        }
    }
    if let Err(e) = zip.finish() {
        return fail(e);
    }
    let _ = sink.drain(&out, true);
}

async fn send(tx: &mpsc::Sender<Item>, item: Item) -> Result<(), Gone> {
    tx.send(item).await.map_err(|_| Gone)
}

/// 一個檔案：先開得起來才寫開頭（開不了 = 跳過，不留空殼）；讀到一半失敗 = 留下讀到的部分並記下來。
/// One file: the header goes out only once it opens (no empty shell for an unreadable file); a read error halfway
/// keeps what was read and is noted.
async fn send_file(sftp: &SftpSession, path: &str, name: String, mode: u32, mtime: Option<u32>, size: u64, tx: &mpsc::Sender<Item>, skipped: &mut Vec<Skipped>) -> Result<(), Gone> {
    let mut f = match sftp.open(path).await {
        Ok(f) => f,
        Err(e) => {
            skipped.push(Skipped { name, reason: e.to_string() });
            return Ok(());
        }
    };
    send(tx, Item::File { name: name.clone(), mode, mtime, size }).await?;
    let mut read = 0u64;
    loop {
        let mut buf = vec![0u8; CHUNK];
        let mut filled = 0;
        // 填滿一塊再送（SFTP 一次回的通常比 CHUNK 小）。/ Fill a whole chunk before sending.
        while filled < CHUNK {
            match f.read(&mut buf[filled..]).await {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => {
                    if filled > 0 {
                        buf.truncate(filled);
                        send(tx, Item::Data(buf)).await?;
                    }
                    skipped.push(Skipped { name, reason: format!("stopped after {} bytes: {e}", read + filled as u64) });
                    return Ok(());
                }
            }
        }
        if filled == 0 {
            return Ok(());
        }
        read += filled as u64;
        buf.truncate(filled);
        send(tx, Item::Data(buf)).await?;
    }
}

/// 讀的那半：走每個根（根本身跟著 symlink，讓「指到資料夾的連結」也能整包下載），裡面不跟。
/// The reading half: each root is followed (a link to a folder downloads the folder), nothing below it is.
async fn walk(sftp: &SftpSession, roots: Vec<(String, String)>, tx: &mpsc::Sender<Item>) -> Result<(), Gone> {
    let mut skipped = Vec::new();
    let mut stack: Vec<(String, String)> = Vec::new();
    for (path, name) in roots {
        match sftp.metadata(path.as_str()).await {
            Err(e) => skipped.push(Skipped { name, reason: e.to_string() }),
            Ok(m) if m.is_dir() => {
                send(tx, Item::Dir { name: name.clone(), mode: m.permissions.unwrap_or(0o755), mtime: m.mtime }).await?;
                stack.push((path, name));
            }
            Ok(m) => send_file(sftp, &path, name, m.permissions.unwrap_or(0o644), m.mtime, m.size.unwrap_or(0), tx, &mut skipped).await?,
        }
        while let Some((dir, rel)) = stack.pop() {
            let entries = match list_dir(sftp, &dir).await {
                Ok(e) => e,
                Err(e) => {
                    skipped.push(Skipped { name: format!("{rel}/"), reason: e.to_string() });
                    continue;
                }
            };
            for e in entries {
                let child = super::ops::join(&dir, &e.name);
                let child_rel = format!("{rel}/{}", e.name);
                if e.is_symlink {
                    match sftp.read_link(child.as_str()).await {
                        Ok(target) => send(tx, Item::Link { name: child_rel, target, mtime: e.mtime }).await?,
                        Err(err) => skipped.push(Skipped { name: child_rel, reason: err.to_string() }),
                    }
                } else if e.is_dir {
                    send(tx, Item::Dir { name: child_rel.clone(), mode: e.mode, mtime: e.mtime }).await?;
                    stack.push((child, child_rel));
                } else {
                    send_file(sftp, &child, child_rel, e.mode, e.mtime, e.size, tx, &mut skipped).await?;
                }
            }
        }
    }
    if !skipped.is_empty() {
        tracing::info!(skipped = skipped.len(), "streamed zip: some entries could not be read");
        send(tx, Item::Note(note_text(&skipped))).await?;
    }
    Ok(())
}

/// 把 `paths`（已解析的 SFTP 路徑）打成一個 zip 串流。`sftp` 會一直借到串流結束。
/// 呼叫端先確認路徑存在（開始串流之後就只能「跳過」，不能再回錯誤碼了）。
/// Zip `paths` (resolved SFTP paths) as a stream. `sftp` is held until the stream ends. Callers check that the paths
/// exist first: once streaming, problems can only be skipped, not answered with a status.
pub fn zip_stream<S>(sftp: S, paths: Vec<String>, tz_offset_minutes: i32) -> impl Stream<Item = io::Result<Bytes>> + Send + 'static
where
    S: Deref<Target = SftpSession> + Send + Sync + 'static,
{
    let (item_tx, item_rx) = mpsc::channel::<Item>(8);
    let (out_tx, out_rx) = mpsc::channel::<io::Result<Bytes>>(8);
    let roots: Vec<(String, String)> = paths.iter().cloned().zip(root_names(&paths)).collect();
    tokio::spawn(async move {
        let _ = walk(&sftp, roots, &item_tx).await;
        // item_tx 在這裡 drop = 寫的那半收尾。/ Dropping item_tx tells the writer to finish.
    });
    tokio::task::spawn_blocking(move || write_zip(item_rx, out_tx, tz_offset_minutes));
    use futures::StreamExt;
    futures::stream::unfold(out_rx, |mut rx| async move { rx.recv().await.map(|b| (b, rx)) }).fuse()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_formats_are_stored() {
        for name in ["a.jpg", "dir/movie.MP4", "x.tar.gz", "pkg.zip", "b.webp"] {
            assert!(stored(name), "{name}");
        }
        for name in ["notes.txt", "main.rs", "Makefile", ".zip", "dir.zip/readme", "archive"] {
            assert!(!stored(name), "{name}");
        }
    }

    #[test]
    fn top_level_names_never_collide() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(root_names(&p(&["/home/u/docs", "/home/u/a.txt"])), vec!["docs", "a.txt"]);
        assert_eq!(root_names(&p(&["/a/x", "/b/x", "/c/x"])), vec!["x", "x (2)", "x (3)"]);
        assert_eq!(root_names(&p(&["/a/r.txt", "/b/r.txt"])), vec!["r.txt", "r (2).txt"]);
        assert_eq!(root_names(&p(&["/", "/C:"])), vec!["files", "files (2)"]);
        assert_eq!(root_names(&p(&[&format!("/x/{NOTE_NAME}")])), vec!["TELEPY-SKIPPED (2).txt"]);
    }

    #[test]
    fn note_lists_what_was_skipped() {
        let s = vec![Skipped { name: "docs/secret".into(), reason: "Permission denied".into() }];
        let text = note_text(&s);
        assert!(text.contains("docs/secret: Permission denied"), "{text}");
        let many: Vec<Skipped> = (0..NOTE_MAX_LINES + 5).map(|i| Skipped { name: format!("f{i}"), reason: "x".into() }).collect();
        assert!(note_text(&many).ends_with("… and 5 more\n"));
    }

    #[test]
    fn times_follow_the_configured_offset() {
        // 2024-01-02 03:04:06 UTC
        let t = Some(1_704_164_646u32);
        let utc = zip_time(t, 0);
        assert_eq!((utc.year(), utc.month(), utc.day(), utc.hour(), utc.minute(), utc.second()), (2024, 1, 2, 3, 4, 6));
        let taipei = zip_time(t, 480);
        assert_eq!((taipei.day(), taipei.hour()), (2, 11));
        assert_eq!(zip_time(None, 0), DateTime::default());
        assert_eq!(zip_time(Some(0), 0), DateTime::default(), "before 1980");
    }
}
