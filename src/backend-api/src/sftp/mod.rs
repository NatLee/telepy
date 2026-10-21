//! SFTP 操作層（檔案管理 WS 與 /api/sftp REST 共用）：路徑解析、列目錄、shell 偵測、下載（檔案串流 /
//! 目錄打包 zip）、上傳。不再 spawn `ssh`/`scp`、不再解析 `ls` 文字。
//! SFTP helpers shared by the file-manager socket and the REST endpoints.

use std::io::Write;
use std::time::{Duration, UNIX_EPOCH};

use chrono::{DateTime, FixedOffset, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub mtime: Option<u32>,
}

static WINDOWS_ABS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/?[A-Za-z]:([\\/]|$)").unwrap());

/// 家目錄（`canonicalize(".")`）。/ Home directory as the server resolves it.
pub async fn home(sftp: &SftpSession) -> String {
    sftp.canonicalize(".").await.unwrap_or_else(|_| "/".to_string())
}

/// Windows（Win32-OpenSSH）的 realpath 長這樣：`/C:/Users/x`。
pub fn is_windows_home(home: &str) -> bool {
    WINDOWS_ABS.is_match(home)
}

/// 前端的 shell 型別只拿來決定預設路徑與顯示。/ "powershell" | "unix"（SFTP 上以家目錄形狀判斷）。
pub async fn detect_shell(sftp: &SftpSession) -> &'static str {
    if is_windows_home(&home(sftp).await) {
        "powershell"
    } else {
        "unix"
    }
}

/// 把前端送來的路徑轉成 SFTP 路徑：`~` / `~/x` → 家目錄；`C:\x`、`C:/x` → `/C:/x`；反斜線 → `/`。
pub fn resolve_path(raw: &str, home: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() || raw == "~" || raw == "~/" {
        return home.to_string();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        let rest = rest.trim_matches('/');
        return if rest.is_empty() { home.to_string() } else { format!("{}/{rest}", home.trim_end_matches('/')) };
    }
    let mut p = raw.replace('\\', "/");
    if WINDOWS_ABS.is_match(&p) && !p.starts_with('/') {
        p = format!("/{p}");
    }
    if p.len() > 1 {
        p = p.trim_end_matches('/').to_string();
    }
    p
}

pub async fn list_dir(sftp: &SftpSession, path: &str) -> Result<Vec<Entry>, russh_sftp::client::error::Error> {
    let mut out = Vec::new();
    for entry in sftp.read_dir(path).await? {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let ft = entry.file_type();
        out.push(Entry {
            name,
            is_dir: matches!(ft, FileType::Dir),
            is_symlink: matches!(ft, FileType::Symlink),
            size: meta.size.unwrap_or(0),
            mode: meta.permissions.unwrap_or(0),
            uid: meta.uid.unwrap_or(0),
            gid: meta.gid.unwrap_or(0),
            mtime: meta.mtime,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// `ls -l` 風格的權限字串（含 setuid/setgid/sticky）。
pub fn mode_string(mode: u32, is_dir: bool, is_symlink: bool) -> String {
    let mut s = String::with_capacity(10);
    s.push(if is_symlink { 'l' } else if is_dir { 'd' } else { '-' });
    let bits = [(0o400, 'r'), (0o200, 'w'), (0o100, 'x'), (0o040, 'r'), (0o020, 'w'), (0o010, 'x'), (0o004, 'r'), (0o002, 'w'), (0o001, 'x')];
    for (i, (bit, ch)) in bits.iter().enumerate() {
        let set = mode & bit != 0;
        let special = match i {
            2 => mode & 0o4000 != 0,
            5 => mode & 0o2000 != 0,
            8 => mode & 0o1000 != 0,
            _ => false,
        };
        s.push(match (set, special, i) {
            (true, true, 8) => 't',
            (false, true, 8) => 'T',
            (true, true, _) => 's',
            (false, true, _) => 'S',
            (true, false, _) => *ch,
            (false, false, _) => '-',
        });
    }
    s
}

/// web_sftp.views.parse_permissions
pub fn permissions_json(s: &str) -> Value {
    let c: Vec<char> = s.chars().collect();
    let at = |i: usize| c.get(i).copied().unwrap_or('-');
    json!({
        "type": if at(0) == 'd' { "directory" } else { "file" },
        "string": s,
        "user": { "read": at(1) == 'r', "write": at(2) == 'w', "execute": at(3) == 'x' || at(3) == 's', "setuid": at(3) == 's' },
        "group": { "read": at(4) == 'r', "write": at(5) == 'w', "execute": at(6) == 'x' || at(6) == 's', "setgid": at(6) == 's' },
        "others": { "read": at(7) == 'r', "write": at(8) == 'w', "execute": at(9) == 'x' || at(9) == 't', "sticky": at(9) == 't' },
    })
}

pub fn date_string(mtime: Option<u32>, tz_offset_minutes: i32) -> String {
    match mtime {
        Some(t) => {
            let dt: DateTime<Utc> = DateTime::<Utc>::from(UNIX_EPOCH + Duration::from_secs(t as u64));
            let offset = FixedOffset::east_opt(tz_offset_minutes * 60).unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
            dt.with_timezone(&offset).format("%Y-%m-%d %H:%M").to_string()
        }
        None => "Unknown".to_string(),
    }
}

/// REST `list` 的每個項目（與 Django 的 `ls -la` 解析結果同形）。
pub fn rest_entry_json(e: &Entry, tz_offset_minutes: i32) -> Value {
    let mode = mode_string(e.mode, e.is_dir, e.is_symlink);
    json!({
        "type": if e.is_dir { "directory" } else { "file" },
        "permissions": permissions_json(&mode),
        "links": "1",
        "owner": e.uid.to_string(),
        "group": e.gid.to_string(),
        "size": e.size.to_string(),
        "date": date_string(e.mtime, tz_offset_minutes),
        "name": e.name,
    })
}

/// WS `list_files` 的每個項目。
pub fn ws_entry_json(e: &Entry) -> Value {
    json!({
        "name": e.name,
        "type": if e.is_dir { "directory" } else { "file" },
        "size": crate::ws::filemanager::format_size(e.size as f64),
    })
}

/// 路徑的最後一段（`path.split("/")[-1]`）。
pub fn basename(path: &str) -> String {
    let p = path.replace('\\', "/");
    let p = p.trim_end_matches('/');
    p.rsplit('/').next().unwrap_or(p).to_string()
}

/// 遞迴把目錄打進 zip（暫存檔）。回 (暫存檔, zip 內根目錄名)。
pub async fn zip_directory(sftp: &SftpSession, path: &str) -> anyhow::Result<tempfile::NamedTempFile> {
    let root_name = basename(path);
    let tmp = tempfile::NamedTempFile::new()?;
    let file = tmp.reopen()?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut stack: Vec<(String, String)> = vec![(path.trim_end_matches('/').to_string(), root_name.clone())];
    zip.add_directory(format!("{root_name}/"), opts)?;
    let mut buf = vec![0u8; 64 * 1024];
    while let Some((dir, rel)) = stack.pop() {
        for e in list_dir(sftp, &dir).await? {
            let child = format!("{dir}/{}", e.name);
            let child_rel = format!("{rel}/{}", e.name);
            if e.is_dir {
                zip.add_directory(format!("{child_rel}/"), opts)?;
                stack.push((child, child_rel));
            } else {
                zip.start_file(child_rel, opts)?;
                let mut f = sftp.open(&child).await?;
                loop {
                    let n = f.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    zip.write_all(&buf[..n])?;
                }
            }
        }
    }
    zip.finish()?;
    Ok(tmp)
}

/// 上傳：目的地是目錄 → 放進去；否則視為完整檔名。
pub async fn upload_target(sftp: &SftpSession, destination: &str, filename: &str) -> String {
    match sftp.metadata(destination).await {
        Ok(m) if m.is_dir() => format!("{}/{}", destination.trim_end_matches('/'), filename),
        _ => destination.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_resolution() {
        assert_eq!(resolve_path("~/", "/home/u"), "/home/u");
        assert_eq!(resolve_path("~/docs/", "/home/u"), "/home/u/docs");
        assert_eq!(resolve_path("", "/home/u"), "/home/u");
        assert_eq!(resolve_path("/var/log", "/home/u"), "/var/log");
        assert_eq!(resolve_path("C:\\", "/C:/Users/x"), "/C:");
        assert_eq!(resolve_path("C:\\Users\\x", "/C:/Users/x"), "/C:/Users/x");
        assert_eq!(resolve_path("/C:/Users", "/C:/Users/x"), "/C:/Users");
        assert_eq!(resolve_path("/", "/home/u"), "/");
        assert!(is_windows_home("/C:/Users/x"));
        assert!(!is_windows_home("/home/u"));
    }

    #[test]
    fn mode_and_permissions() {
        assert_eq!(mode_string(0o755, true, false), "drwxr-xr-x");
        assert_eq!(mode_string(0o644, false, false), "-rw-r--r--");
        assert_eq!(mode_string(0o4755, false, false), "-rwsr-xr-x");
        assert_eq!(mode_string(0o1777, true, false), "drwxrwxrwt");
        let p = permissions_json("drwxr-xr-x");
        assert_eq!(p["type"], "directory");
        assert_eq!(p["user"]["execute"], true);
        assert_eq!(p["others"]["write"], false);
        assert_eq!(basename("/a/b/c.txt"), "c.txt");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("C:\\x\\y"), "y");
    }
}
