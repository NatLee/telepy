//! 每台伺服器的偏好設定（`<設定目錄>/prefs.json`）：「網頁 port 連不到時要不要退回 SSH 的 port」，以及「不用幫我把
//! 金鑰放上這台裝置的清單」的回答（金鑰可能是用別的方式加的；說過不用就不再問）。
//! 退回去 Telepy 就看不到這台電腦真正的位址，所以預設先問（`ask`），使用者可以改成一律退回（`always`）或從不（`never`）。
//! Per-server preferences (`<config dir>/prefs.json`): whether to fall back to the SSH port when the web port can't be
//! reached, and the "don't put my key on this device's list" answers (the key may have been added another way; once
//! declined, not asked again). Falling back hides this computer's real address from Telepy, so the default asks first.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// 網頁 port 連不到時怎麼辦。/ What to do when the web port can't be reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Fallback {
    /// 在終端機問（沒有終端機就不退回）。/ Ask in the terminal (no terminal = don't fall back).
    #[default]
    Ask,
    /// 一律退回 SSH 的 port。/ Always fall back to the SSH port.
    Always,
    /// 從不退回。/ Never fall back.
    Never,
}

impl Fallback {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ask" => Some(Self::Ask),
            "always" => Some(Self::Always),
            "never" => Some(Self::Never),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Always => "always",
            Self::Never => "never",
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Prefs {
    #[serde(default)]
    servers: BTreeMap<String, ServerPrefs>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct ServerPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh_fallback: Option<String>,
    /// `<隧道 id>:<帳號>:<指紋>`：說過不用放上清單的。/ Declined placements, as `<tunnel id>:<account>:<fingerprint>`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    key_offer_declined: Vec<String>,
}

impl ServerPrefs {
    fn is_empty(&self) -> bool {
        self.ssh_fallback.is_none() && self.key_offer_declined.is_empty()
    }
}

fn path() -> PathBuf {
    crate::creds::config_dir().join("prefs.json")
}

/// 伺服器網址當鍵：去掉結尾斜線、小寫主機。/ The server URL as the key: no trailing slash, lower-case.
fn key(server: &str) -> String {
    server.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn load() -> Prefs {
    std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// 這台伺服器存的設定（沒存 = ask）。/ The saved setting for this server (none = ask).
pub fn fallback(server: &str) -> Fallback {
    load().servers.get(&key(server)).and_then(|p| p.ssh_fallback.as_deref()).and_then(Fallback::parse).unwrap_or_default()
}

/// 存下這台伺服器的設定（`ask` = 刪掉，回到預設）。/ Save it for this server (`ask` = remove, back to the default).
pub fn set_fallback(server: &str, f: Fallback) -> Result<()> {
    let mut p = load();
    let k = key(server);
    if f == Fallback::Ask {
        if let Some(sp) = p.servers.get_mut(&k) {
            sp.ssh_fallback = None;
        }
        p.servers.retain(|_, sp| !sp.is_empty());
    } else {
        p.servers.entry(k).or_default().ssh_fallback = Some(f.as_str().to_string());
    }
    save(&p)
}

/// 說過「不用把金鑰放上這台裝置的清單」嗎。/ Whether placing this key on this device was declined before.
pub fn declined(server: &str, item: &str) -> bool {
    load().servers.get(&key(server)).is_some_and(|p| p.key_offer_declined.iter().any(|d| d == item))
}

/// 記下「不用放」（最多留 200 筆，舊的先丟）。/ Remember a declined placement (the newest 200 are kept).
pub fn decline(server: &str, item: &str) -> Result<()> {
    let mut p = load();
    let list = &mut p.servers.entry(key(server)).or_default().key_offer_declined;
    if !list.iter().any(|d| d == item) {
        list.push(item.to_string());
        let extra = list.len().saturating_sub(200);
        list.drain(..extra);
    }
    save(&p)
}

fn save(p: &Prefs) -> Result<()> {
    let file = path();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    std::fs::write(&file, serde_json::to_string_pretty(p)? + "\n").with_context(|| format!("write {}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_and_keys() {
        assert_eq!(Fallback::parse(" Always "), Some(Fallback::Always));
        assert_eq!(Fallback::parse("nope"), None);
        assert_eq!(Fallback::default(), Fallback::Ask);
        for f in [Fallback::Ask, Fallback::Always, Fallback::Never] {
            assert_eq!(Fallback::parse(f.as_str()), Some(f));
        }
        assert_eq!(key("https://Telepy.Example.com/"), "https://telepy.example.com");
    }

    #[test]
    fn saved_per_server() {
        let dir = tempfile::tempdir().unwrap();
        // 只在這個測試裡改設定目錄。/ Point the config dir at a scratch folder for this test only.
        std::env::set_var("TELEPY_CONFIG_DIR", dir.path());
        assert_eq!(fallback("https://a.example"), Fallback::Ask);
        set_fallback("https://a.example/", Fallback::Always).unwrap();
        set_fallback("https://b.example", Fallback::Never).unwrap();
        assert_eq!((fallback("https://A.example"), fallback("https://b.example")), (Fallback::Always, Fallback::Never));
        set_fallback("https://a.example", Fallback::Ask).unwrap();
        assert_eq!(fallback("https://a.example"), Fallback::Ask);
        let text = std::fs::read_to_string(dir.path().join("prefs.json")).unwrap();
        assert!(!text.contains("a.example") && text.contains("b.example"), "{text}");
        // 「不用放上清單」的回答：每台伺服器各自記；fallback 回到預設時不會被一起丟掉。
        // Declined placements are per server and survive the fallback going back to the default.
        assert!(!declined("https://b.example", "4:pi:SHA256:x"));
        decline("https://B.example/", "4:pi:SHA256:x").unwrap();
        decline("https://b.example", "4:pi:SHA256:x").unwrap();
        assert!(declined("https://b.example", "4:pi:SHA256:x") && !declined("https://a.example", "4:pi:SHA256:x"));
        set_fallback("https://b.example", Fallback::Ask).unwrap();
        assert!(declined("https://b.example", "4:pi:SHA256:x"), "kept when the fallback goes back to ask");
        let text = std::fs::read_to_string(dir.path().join("prefs.json")).unwrap();
        assert_eq!(text.matches("4:pi:SHA256:x").count(), 1, "{text}");
        std::env::remove_var("TELEPY_CONFIG_DIR");
    }
}
