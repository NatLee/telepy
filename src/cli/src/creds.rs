//! 登入狀態：`config.json`（伺服器網址、登入方式——不含祕密）與祕密（API token 或 OAuth 的 access / refresh token）。
//! 祕密放系統金鑰圈（macOS Keychain、Windows 認證管理員）；Linux、`TELEPY_NO_KEYRING=1` 或金鑰圈不能用時放
//! `credentials.json`（權限 0600）。設定目錄：`TELEPY_CONFIG_DIR`，否則 `~/.config/telepy`（Windows：`%APPDATA%\telepy`）。
//! Sign-in state: `config.json` (server URL, how you signed in — no secrets) and the secret (an API token or the
//! OAuth access / refresh tokens). Secrets go to the OS keyring on macOS / Windows; on Linux, with
//! `TELEPY_NO_KEYRING=1` or when the keyring fails, to `credentials.json` (mode 0600).

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "telepy";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// 個人 API token（`tpt_…`）。/ A personal API token.
    Token,
    /// 瀏覽器的 OAuth 登入（access + refresh token）。/ The browser OAuth sign-in.
    Oauth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub server: String,
    pub kind: Kind,
    /// OAuth：動態註冊拿到的 client id。/ OAuth: the dynamically registered client id.
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    /// 祕密存在哪裡（`keyring` / `file`）。/ Where the secret is stored.
    #[serde(default)]
    pub store: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Secret {
    pub access: String,
    #[serde(default)]
    pub refresh: Option<String>,
    /// access token 到期（Unix 秒）。/ When the access token expires (Unix seconds).
    #[serde(default)]
    pub expires_at: Option<i64>,
}

pub fn config_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("TELEPY_CONFIG_DIR") {
        return PathBuf::from(d);
    }
    if cfg!(windows) {
        if let Some(a) = std::env::var_os("APPDATA") {
            return PathBuf::from(a).join("telepy");
        }
    }
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(x).join("telepy");
    }
    home_dir().join(".config").join("telepy")
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub(crate) fn write_private(path: &std::path::Path, data: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).with_context(|| format!("write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load_profile() -> Option<Profile> {
    let raw = std::fs::read_to_string(config_dir().join("config.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_profile(p: &Profile) -> Result<()> {
    write_private(&config_dir().join("config.json"), &serde_json::to_string_pretty(p)?)
}

fn use_keyring() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows")) && std::env::var_os("TELEPY_NO_KEYRING").is_none()
}

fn file_path() -> PathBuf {
    config_dir().join("credentials.json")
}

fn read_file() -> BTreeMap<String, Secret> {
    std::fs::read_to_string(file_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keyring_set(server: &str, data: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, server)?.set_password(data)?;
    Ok(())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keyring_set(_server: &str, _data: &str) -> Result<()> {
    anyhow::bail!("no keyring on this platform")
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keyring_get(server: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, server).ok()?.get_password().ok()
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keyring_get(_server: &str) -> Option<String> {
    None
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keyring_delete(server: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, server) {
        let _ = e.delete_credential();
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn keyring_delete(_server: &str) {}

/// 存祕密；回存在哪裡（`keyring` / `file`）。/ Store the secret; returns where it went.
pub fn save_secret(server: &str, s: &Secret) -> Result<&'static str> {
    let data = serde_json::to_string(s)?;
    if use_keyring() && keyring_set(server, &data).is_ok() {
        // 檔案裡的舊值清掉（之前可能退回過檔案）。/ Drop an older file copy.
        let mut all = read_file();
        if all.remove(server).is_some() {
            write_private(&file_path(), &serde_json::to_string_pretty(&all)?)?;
        }
        return Ok("keyring");
    }
    let mut all = read_file();
    all.insert(server.to_string(), s.clone());
    write_private(&file_path(), &serde_json::to_string_pretty(&all)?)?;
    Ok("file")
}

pub fn load_secret(server: &str) -> Option<Secret> {
    if use_keyring() {
        if let Some(raw) = keyring_get(server) {
            if let Ok(s) = serde_json::from_str(&raw) {
                return Some(s);
            }
        }
    }
    read_file().remove(server)
}

pub fn forget(server: &str) -> Result<()> {
    keyring_delete(server);
    let mut all = read_file();
    if all.remove(server).is_some() {
        write_private(&file_path(), &serde_json::to_string_pretty(&all)?)?;
    }
    let _ = std::fs::remove_file(config_dir().join("config.json"));
    Ok(())
}

/// `https://t.example/` → `https://t.example`（沒寫 scheme 當 https）。/ Normalise a server URL.
pub fn normalize_server(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches('/');
    if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls() {
        assert_eq!(normalize_server("t.example/"), "https://t.example");
        assert_eq!(normalize_server("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
    }
}
