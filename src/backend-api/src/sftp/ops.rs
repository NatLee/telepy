//! 檔案管理的檔案操作（建資料夾、改名 / 搬移、刪除、權限、新檔案、複製、stat、文字檔讀寫），全部走連線池共用的
//! 那條 sftp channel（`ssh::pool`）。純函式（名稱 / 路徑 / 權限 / 二進位判斷）有單元測試；I/O 在下面的 async 函式。
//! File operations for the file manager (mkdir, rename / move, delete, chmod, touch, copy, stat, text read / save),
//! all over the pool's shared SFTP channel. Pure helpers are unit-tested; the async functions do the I/O.
//!
//! - **不跟著 symlink 走**：計數、刪除、遞迴權限、串流複製都用 lstat / readdir 的屬性，symlink 當一個項目處理
//!   （刪掉的是連結本身，不是它指到的東西）。/ Never follow symlinks while walking a tree.
//! - **存檔不會留下半個檔案**：寫到同一個資料夾的暫存檔，再用 `posix-rename@openssh.com` 原子取代（見 `api::sftp`）；
//!   裝置的 sftp-server 不支援時改成「原檔改名備份 → 暫存檔改名 → 刪備份」，失敗就把備份改回去。
//!   Saves write a temp file next to the target and replace it atomically (see `api::sftp`).
//! - **複製**：SFTP 沒有伺服器端複製。有 shell 的裝置（unix）在裝置上跑 `cp -R`（一條 exec channel，資料不經過
//!   Telepy）；沒有 shell、`cp` 不存在、或 Windows，就經過後端串流（讀 → 寫，總量上限 [`STREAM_COPY_LIMIT`]）。
//!   Copy: SFTP has no server-side copy. Unix devices with a shell run `cp -R` on the device (data never leaves
//!   it); otherwise the backend streams read → write, capped at [`STREAM_COPY_LIMIT`].

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 編輯器 / 文字預覽最大的檔案。/ Largest file the editor or the text preview opens.
pub const TEXT_LIMIT: u64 = 1024 * 1024;
/// 二進位判斷看開頭多少位元組（有 NUL 就是二進位）。/ Bytes inspected for a NUL (binary detection).
pub const SNIFF: usize = 8 * 1024;
/// 經過後端串流複製的總量上限。/ Total bytes a streamed (through-the-backend) copy may move.
pub const STREAM_COPY_LIMIT: u64 = 256 * 1024 * 1024;
/// 刪除前計數最多走多少個項目（超過就回 truncated，確認視窗寫「超過 N 個」）。
/// How many entries the pre-delete count walks before it gives up (the dialog then says "more than N").
pub const COUNT_LIMIT: u64 = 100_000;

/// 一個檔名可以用嗎：非空、不是 `.` / `..`、沒有 `/`、`\`、NUL、≤ 255 bytes。
/// Whether a single path component is acceptable.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name.len() <= 255 && !name.contains(['/', '\\', '\0'])
}

/// `dir` + `name`（`/` 根目錄不重複斜線）。/ Join a directory and a name.
pub fn join(dir: &str, name: &str) -> String {
    let d = dir.trim_end_matches('/');
    format!("{d}/{name}")
}

/// 上一層（`/a/b` → `/a`、`/a` → `/`、`/C:/x` → `/C:`）。/ The parent directory.
pub fn parent(path: &str) -> String {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => p[..i].to_string(),
    }
}

/// `to` 在 `from` 底下（或就是它）：資料夾不能搬 / 複製進自己。/ Whether `to` is `from` or inside it.
pub fn is_within(to: &str, from: &str) -> bool {
    let from = from.trim_end_matches('/');
    let to = to.trim_end_matches('/');
    to == from || to.starts_with(&format!("{from}/"))
}

/// 八進位權限字串 → 數值（`644` / `0755` / `4755`；≤ 0o7777）。/ Parse an octal mode.
pub fn parse_mode(s: &str) -> Option<u32> {
    let s = s.trim();
    if s.is_empty() || s.len() > 5 || !s.chars().all(|c| ('0'..='7').contains(&c)) {
        return None;
    }
    let v = u32::from_str_radix(s, 8).ok()?;
    (v <= 0o7777).then_some(v)
}

/// `0644` 形式（四位、含特殊位元）。/ The mode as four octal digits.
pub fn mode_octal(mode: u32) -> String {
    format!("{:04o}", mode & 0o7777)
}

/// 開頭 [`SNIFF`] bytes 裡有 NUL 就當二進位。/ Binary = a NUL within the first [`SNIFF`] bytes.
pub fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(SNIFF)].contains(&0)
}

/// 存檔用的暫存檔名，在目標旁邊（同一個檔案系統，rename 才是原子的）。/ Temp file next to the target.
pub fn temp_path(path: &str, nonce: &str) -> String {
    let name = super::basename(path);
    join(&parent(path), &format!(".{name}.telepy-{nonce}.tmp"))
}

/// 原地取代失敗時的備份檔名。/ Backup name used by the non-atomic fallback.
pub fn backup_path(path: &str, nonce: &str) -> String {
    let name = super::basename(path);
    join(&parent(path), &format!(".{name}.telepy-{nonce}.bak"))
}

/// 錯誤分類 → (HTTP 狀態, code)。訊息照 sftp-server 給的。/ Classify an SFTP error into a status + code.
pub fn classify(e: &SftpError) -> (u16, &'static str) {
    match e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => (404, "not_found"),
            StatusCode::PermissionDenied => (403, "permission_denied"),
            StatusCode::OpUnsupported => (400, "unsupported"),
            _ => (400, "failed"),
        },
        SftpError::Timeout => (504, "timeout"),
        _ => (502, "device"),
    }
}

/// 一棵樹的大小（刪除前的確認、串流複製前的上限檢查）。/ Size of a tree.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Tally {
    pub files: u64,
    pub dirs: u64,
    pub links: u64,
    pub bytes: u64,
    /// 超過 [`COUNT_LIMIT`]，沒數完。/ Stopped at [`COUNT_LIMIT`].
    pub truncated: bool,
}

impl Tally {
    pub fn entries(&self) -> u64 {
        self.files + self.dirs + self.links
    }
}

fn attrs_kind(a: &FileAttributes) -> Kind {
    if a.is_symlink() {
        Kind::Link
    } else if a.is_dir() {
        Kind::Dir
    } else {
        Kind::File
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
    Link,
}

/// 子項目（readdir 的屬性 = lstat，不跟 symlink）。/ Children with lstat attributes.
async fn children(sftp: &SftpSession, dir: &str) -> Result<Vec<(String, Kind, u64)>, SftpError> {
    let mut out = Vec::new();
    for e in sftp.read_dir(dir).await? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let m = e.metadata();
        out.push((join(dir, &name), attrs_kind(&m), m.size.unwrap_or(0)));
    }
    Ok(out)
}

/// 數一棵樹（含根）。/ Count a tree, the root included.
pub async fn count_tree(sftp: &SftpSession, path: &str) -> Result<Tally, SftpError> {
    let root = sftp.symlink_metadata(path).await?;
    let mut t = Tally::default();
    match attrs_kind(&root) {
        Kind::File => {
            t.files = 1;
            t.bytes = root.size.unwrap_or(0);
            return Ok(t);
        }
        Kind::Link => {
            t.links = 1;
            return Ok(t);
        }
        Kind::Dir => t.dirs = 1,
    }
    let mut stack = vec![path.to_string()];
    while let Some(dir) = stack.pop() {
        for (child, kind, size) in children(sftp, &dir).await? {
            match kind {
                Kind::File => {
                    t.files += 1;
                    t.bytes += size;
                }
                Kind::Link => t.links += 1,
                Kind::Dir => {
                    t.dirs += 1;
                    stack.push(child);
                }
            }
            if t.entries() >= COUNT_LIMIT {
                t.truncated = true;
                return Ok(t);
            }
        }
    }
    Ok(t)
}

/// 刪掉一個檔案、連結或整個資料夾（先刪裡面再刪自己）。回傳刪了幾個項目；中途失敗時連同已刪的數量一起回。
/// Delete a file, a link or a whole folder (children first). Returns how many entries went; on an error, the count
/// so far comes back with it.
pub async fn remove_tree(sftp: &SftpSession, path: &str) -> Result<u64, (SftpError, u64)> {
    let root = sftp.symlink_metadata(path).await.map_err(|e| (e, 0))?;
    if attrs_kind(&root) != Kind::Dir {
        sftp.remove_file(path).await.map_err(|e| (e, 0))?;
        return Ok(1);
    }
    let mut removed = 0u64;
    // (資料夾, 子項目已經處理過了)：第二次看到它時才 rmdir。/ (dir, children done): rmdir on the second visit.
    let mut stack = vec![(path.to_string(), false)];
    while let Some((dir, done)) = stack.pop() {
        if done {
            sftp.remove_dir(dir.as_str()).await.map_err(|e| (e, removed))?;
            removed += 1;
            continue;
        }
        stack.push((dir.clone(), true));
        for (child, kind, _) in children(sftp, &dir).await.map_err(|e| (e, removed))? {
            if kind == Kind::Dir {
                stack.push((child, false));
            } else {
                sftp.remove_file(child.as_str()).await.map_err(|e| (e, removed))?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn mode_attrs(mode: u32) -> FileAttributes {
    FileAttributes { permissions: Some(mode & 0o7777), ..FileAttributes::empty() }
}

/// 改權限；`recursive` 時連同裡面的檔案與資料夾（連結跳過；先改裡面，免得先拿掉自己的讀取權限就列不到了）。
/// 回傳改了幾個。/ chmod, optionally recursive (links skipped; children first so removing r/x from a folder
/// doesn't stop the walk). Returns how many entries changed.
pub async fn chmod_tree(sftp: &SftpSession, path: &str, mode: u32, recursive: bool) -> Result<u64, SftpError> {
    let root = sftp.symlink_metadata(path).await?;
    let kind = attrs_kind(&root);
    if kind == Kind::Link {
        // 連結本身沒有權限；改它指到的東西（和 chmod 一樣）。/ Like chmod(1): a link's target changes.
        sftp.set_metadata(path, mode_attrs(mode)).await?;
        return Ok(1);
    }
    let mut changed = 0;
    if recursive && kind == Kind::Dir {
        let mut dirs = vec![path.to_string()];
        let mut order = Vec::new();
        while let Some(dir) = dirs.pop() {
            for (child, k, _) in children(sftp, &dir).await? {
                match k {
                    Kind::Dir => {
                        dirs.push(child.clone());
                        order.push(child);
                    }
                    Kind::File => {
                        sftp.set_metadata(child.as_str(), mode_attrs(mode)).await?;
                        changed += 1;
                    }
                    Kind::Link => {}
                }
            }
        }
        for dir in order.iter().rev() {
            sftp.set_metadata(dir.as_str(), mode_attrs(mode)).await?;
            changed += 1;
        }
    }
    sftp.set_metadata(path, mode_attrs(mode)).await?;
    Ok(changed + 1)
}

/// 新的空檔案；已經存在就失敗（不會清掉別人的檔案）。/ Create an empty file; fails when it exists.
pub async fn touch(sftp: &SftpSession, path: &str) -> Result<(), SftpError> {
    let mut f = sftp.open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await?;
    f.shutdown().await.map_err(SftpError::from)
}

/// 存在嗎（lstat；連到不存在目標的連結也算存在）。/ Exists (lstat: a dangling link counts).
pub async fn exists(sftp: &SftpSession, path: &str) -> Result<bool, SftpError> {
    match sftp.symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(false),
        Err(e) => Err(e),
    }
}

/// 讀整個檔案（呼叫端先確認大小）。/ Read a whole (size-checked) file.
pub async fn read_all(sftp: &SftpSession, path: &str, limit: u64) -> Result<Vec<u8>, SftpError> {
    let f = sftp.open(path).await?;
    let mut buf = Vec::new();
    f.take(limit + 1).read_to_end(&mut buf).await.map_err(SftpError::from)?;
    Ok(buf)
}

/// 寫一個新檔案（暫存檔用；`EXCLUDE`：不覆蓋任何現有的東西），權限 `mode`。
/// Write a fresh file (the temp file; EXCLUDE so nothing existing is ever overwritten) with `mode`.
pub async fn write_new(sftp: &SftpSession, path: &str, data: &[u8], mode: u32) -> Result<(), SftpError> {
    let mut f = sftp
        .open_with_flags_and_attributes(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE, mode_attrs(mode))
        .await?;
    f.write_all(data).await.map_err(SftpError::from)?;
    f.shutdown().await.map_err(SftpError::from)?;
    // umask 可能吃掉 open 時給的權限，補一次。/ The umask may have masked the requested mode.
    let _ = sftp.set_metadata(path, mode_attrs(mode)).await;
    Ok(())
}

/// 經過後端串流複製（裝置沒有 `cp` 時）。目標已存在就失敗；資料夾整棵複製，權限照抄，連結照原目標重建。
/// 總量先用 [`count_tree`] 檢查過（[`STREAM_COPY_LIMIT`]）。
/// Copy through the backend (no `cp` on the device). Fails when the target exists; folders are copied whole with
/// their modes, links are recreated with the same target. The caller checks the size first.
pub async fn stream_copy(sftp: &SftpSession, from: &str, to: &str) -> Result<u64, SftpError> {
    let mut copied = 0u64;
    let mut stack = vec![(from.to_string(), to.to_string())];
    let mut buf = vec![0u8; 64 * 1024];
    while let Some((src, dst)) = stack.pop() {
        let meta = sftp.symlink_metadata(src.as_str()).await?;
        let mode = meta.permissions.unwrap_or(0o644) & 0o7777;
        match attrs_kind(&meta) {
            Kind::Link => {
                let target = sftp.read_link(src.as_str()).await?;
                sftp.symlink(dst.as_str(), target).await?;
            }
            Kind::Dir => {
                sftp.create_dir(dst.as_str()).await?;
                let _ = sftp.set_metadata(dst.as_str(), mode_attrs(mode)).await;
                for (child, _, _) in children(sftp, &src).await? {
                    let name = super::basename(&child);
                    stack.push((child, join(&dst, &name)));
                }
            }
            Kind::File => {
                let mut r = sftp.open(src.as_str()).await?;
                let mut w = sftp
                    .open_with_flags_and_attributes(dst.as_str(), OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE, mode_attrs(mode))
                    .await?;
                loop {
                    let n = r.read(&mut buf).await.map_err(SftpError::from)?;
                    if n == 0 {
                        break;
                    }
                    w.write_all(&buf[..n]).await.map_err(SftpError::from)?;
                }
                w.shutdown().await.map_err(SftpError::from)?;
            }
        }
        copied += 1;
    }
    Ok(copied)
}

/// `cp` 的指令列（裝置上跑；路徑一律加引號，`--` 之後才是路徑）。/ The `cp` command line run on the device.
pub fn cp_command(from: &str, to: &str) -> String {
    use crate::tunnel_service::sh_quote;
    format!("cp -R -p -- {} {}", sh_quote(from), sh_quote(to))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_paths() {
        assert!(valid_name("notes.txt") && valid_name(".bashrc") && valid_name("a b"));
        for bad in ["", ".", "..", "a/b", "a\\b", "x\0y"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        assert!(!valid_name(&"x".repeat(256)));
        assert_eq!(join("/home/u", "a"), "/home/u/a");
        assert_eq!(join("/home/u/", "a"), "/home/u/a");
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(parent("/home/u/a"), "/home/u");
        assert_eq!(parent("/home"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(parent("/C:/Users/x/"), "/C:/Users");
        assert!(is_within("/a/b", "/a/b"));
        assert!(is_within("/a/b/c", "/a/b/"));
        assert!(!is_within("/a/bc", "/a/b"));
        assert!(!is_within("/a", "/a/b"));
    }

    #[test]
    fn modes() {
        assert_eq!(parse_mode("755"), Some(0o755));
        assert_eq!(parse_mode("0644"), Some(0o644));
        assert_eq!(parse_mode("4755"), Some(0o4755));
        assert_eq!(parse_mode(" 600 "), Some(0o600));
        for bad in ["", "8", "79", "rwx", "17777", "-1", "0x1ff"] {
            assert_eq!(parse_mode(bad), None, "{bad}");
        }
        assert_eq!(mode_octal(0o100644), "0644");
        assert_eq!(mode_octal(0o41777), "1777");
    }

    #[test]
    fn binary_sniff_and_temp_names() {
        assert!(!is_binary(b"hello\nworld"));
        assert!(is_binary(b"\x7fELF\0\0"));
        let mut late = vec![b'a'; SNIFF];
        late.push(0);
        assert!(!is_binary(&late), "only the first 8 KiB count");
        assert_eq!(temp_path("/etc/app.conf", "ab12"), "/etc/.app.conf.telepy-ab12.tmp");
        assert_eq!(backup_path("/x", "z"), "/.x.telepy-z.bak");
        assert_eq!(cp_command("/a/it's", "/b/c d"), "cp -R -p -- '/a/it'\\''s' '/b/c d'");
    }

    #[test]
    fn error_classes() {
        use russh_sftp::protocol::Status;
        let st = |c| SftpError::Status(Status { id: 0, status_code: c, error_message: String::new(), language_tag: String::new() });
        assert_eq!(classify(&st(StatusCode::NoSuchFile)), (404, "not_found"));
        assert_eq!(classify(&st(StatusCode::PermissionDenied)), (403, "permission_denied"));
        assert_eq!(classify(&st(StatusCode::Failure)), (400, "failed"));
        assert_eq!(classify(&SftpError::Timeout), (504, "timeout"));
    }
}
