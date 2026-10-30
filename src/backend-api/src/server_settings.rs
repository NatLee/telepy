//! 伺服器設定：以前只能寫在 `.env` 的那幾個（代理層數、Cloudflare、PROXY protocol、log 等級、Swagger、Google client
//! ID、PUBLIC_URL…），現在也能在「網站設定 → 伺服器」改。優先順序只有一條：環境變數**有設**（存在且不是空白）→ 它說了算，
//! 設定頁上那一格鎖住；沒設 → 網站設定存的值；再沒有 → 內建預設。每個用到它的地方都在**用的當下**讀（[`Live`] 是存檔時
//! 換掉的記憶體快照），所以存檔不必重啟。
//! Server settings that used to live only in `.env` (proxy hops, Cloudflare, PROXY protocol, log level, Swagger, the
//! Google client ID, PUBLIC_URL…), now also editable under Site settings → Server. One rule decides: an environment
//! variable that is **set** (present and non-blank) wins and locks the field; otherwise the saved site setting;
//! otherwise the built-in default. Every consumer reads at use time ([`Live`] is an in-memory snapshot replaced on
//! save), so a save needs no restart.

use std::net::IpAddr;
use std::sync::{Arc, OnceLock, RwLock};

use serde_json::{json, Map, Value};

use crate::client_ip::Hops;
use crate::config::Config;
use crate::db::{self, settings::SiteSettings, Db};
use crate::gateway::proxy_protocol::Trusted;

/// 每個可被環境變數蓋過的設定鍵與它的環境變數（`client_ip_cloudflare` 沒有）。順序 = API `env` 的順序。
/// Every env-backed key and its variable (`client_ip_cloudflare` has none). Order = the API's `env` order.
pub const ENV_KEYS: &[(&str, &str)] = &[
    ("client_ip_hops", "TRUSTED_PROXY_HOPS"),
    ("client_ip_header", "CLIENT_IP_HEADER"),
    ("server_device_probe", "DEVICE_PROBE"),
    ("server_keep_shared_service_key", "KEEP_SHARED_SERVICE_KEY"),
    ("server_gateway_proxy_protocol_from", "GATEWAY_PROXY_PROTOCOL_FROM"),
    ("server_log_level", "LOG_LEVEL"),
    ("server_openapi_enabled", "OPENAPI_ENABLED"),
    ("server_google_client_id", "SOCIAL_GOOGLE_CLIENT_ID"),
    ("server_public_url", "PUBLIC_URL"),
];

/// 一個鍵的環境變數名稱。/ The variable behind a key.
pub fn env_var(key: &str) -> Option<&'static str> {
    ENV_KEYS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// 被環境變數鎖住時 PUT / PATCH 的錯誤訊息。/ The field error for a key locked by its variable.
pub fn locked_message(var: &str) -> String {
    format!("Set by {var} in .env; remove it there to edit it here.")
}

/// 這個值是誰決定的。/ Which layer decides a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// 環境變數（.env）。/ The environment variable (.env).
    Env,
    /// 網站設定存的值（和預設不同）。/ The saved site setting (different from the default).
    Setting,
    /// 內建預設。/ The built-in default.
    Default,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Env => "env",
            Source::Setting => "setting",
            Source::Default => "default",
        }
    }
}

/// `CF-Connecting-IP` 的用法。/ How Cloudflare's `CF-Connecting-IP` is used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Cloudflare {
    /// 被選中的那段是 Cloudflare 的位址時才用它（沒人能在不經過 Cloudflare 的情況下偽造）。
    /// Used only when the chosen hop is a Cloudflare address (nobody can spoof that without connecting from Cloudflare).
    #[default]
    Auto,
    /// 有就用（前面一定是 Cloudflare 時）。/ Used whenever present (Cloudflare is always in front).
    Always,
    /// 不看。/ Ignored.
    Off,
}

impl Cloudflare {
    pub const VALUES: [&'static str; 3] = ["auto", "always", "off"];

    pub fn parse(v: &str) -> Option<Self> {
        match v.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "always" => Some(Self::Always),
            "off" => Some(Self::Off),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Always => "always",
            Self::Off => "off",
        }
    }
}

/// 網站設定裡存的那些值（還沒套用環境變數）。/ The saved values, before environment variables apply.
#[derive(Debug, Clone, PartialEq)]
pub struct Saved {
    pub client_ip_hops: String,
    pub client_ip_header: String,
    pub client_ip_cloudflare: String,
    pub device_probe: bool,
    pub keep_shared_service_key: bool,
    pub gateway_proxy_protocol_from: String,
    pub log_level: String,
    pub openapi_enabled: bool,
    pub google_client_id: String,
    pub public_url: String,
}

impl Default for Saved {
    /// 內建預設（= schema 的欄位預設）。/ The built-in defaults (= the schema's column defaults).
    fn default() -> Self {
        Self {
            client_ip_hops: "auto".into(),
            client_ip_header: String::new(),
            client_ip_cloudflare: "auto".into(),
            device_probe: true,
            keep_shared_service_key: false,
            gateway_proxy_protocol_from: String::new(),
            log_level: String::new(),
            openapi_enabled: true,
            google_client_id: String::new(),
            public_url: String::new(),
        }
    }
}

impl From<&SiteSettings> for Saved {
    fn from(s: &SiteSettings) -> Self {
        Self {
            client_ip_hops: s.client_ip_hops.clone(),
            client_ip_header: s.client_ip_header.clone(),
            client_ip_cloudflare: s.client_ip_cloudflare.clone(),
            device_probe: s.server_device_probe,
            keep_shared_service_key: s.server_keep_shared_service_key,
            gateway_proxy_protocol_from: s.server_gateway_proxy_protocol_from.clone(),
            log_level: s.server_log_level.clone(),
            openapi_enabled: s.server_openapi_enabled,
            google_client_id: s.server_google_client_id.clone(),
            public_url: s.server_public_url.clone(),
        }
    }
}

impl Saved {
    /// 一個鍵存的值，寫成字串（布林 = `true` / `false`）。/ A key's saved value as text.
    fn text(&self, key: &str) -> Option<String> {
        Some(match key {
            "client_ip_hops" => self.client_ip_hops.clone(),
            "client_ip_header" => self.client_ip_header.clone(),
            "client_ip_cloudflare" => self.client_ip_cloudflare.clone(),
            "server_device_probe" => self.device_probe.to_string(),
            "server_keep_shared_service_key" => self.keep_shared_service_key.to_string(),
            "server_gateway_proxy_protocol_from" => self.gateway_proxy_protocol_from.clone(),
            "server_log_level" => self.log_level.clone(),
            "server_openapi_enabled" => self.openapi_enabled.to_string(),
            "server_google_client_id" => self.google_client_id.clone(),
            "server_public_url" => self.public_url.clone(),
            _ => return None,
        })
    }
}

/// 存檔的值在記憶體裡的快照，Config 的每個 clone（gateway 那份也是）共用同一個。啟動時與每次存檔後換掉。
/// The saved values in memory, shared by every clone of the Config (the gateway's too); replaced at startup and on
/// every save.
#[derive(Clone, Default)]
pub struct Live(Arc<RwLock<Saved>>);

impl std::fmt::Debug for Live {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Live").field(&self.get()).finish()
    }
}

impl Live {
    pub fn get(&self) -> Saved {
        self.0.read().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn set(&self, saved: Saved) {
        if let Ok(mut s) = self.0.write() {
            *s = saved;
        }
    }

    /// 從資料庫讀一次。/ Read once from the database.
    pub async fn load(&self, db: &Db) -> sqlx::Result<()> {
        let s = db::settings::get_solo(db).await?;
        self.set(Saved::from(&s));
        Ok(())
    }
}

impl Config {
    /// 一個鍵的環境變數值（有設才有），寫成字串。/ A key's environment value when set, as text.
    pub fn env_value(&self, key: &str) -> Option<String> {
        match key {
            "client_ip_hops" => self.trusted_proxy_hops.map(Hops::setting),
            "client_ip_header" => self.client_ip_header.clone(),
            "server_device_probe" => self.device_probe.map(|b| b.to_string()),
            "server_keep_shared_service_key" => self.keep_shared_service_key.map(|b| b.to_string()),
            "server_gateway_proxy_protocol_from" => self.gateway_proxy_protocol_from.clone(),
            "server_log_level" => self.log_level.clone(),
            "server_openapi_enabled" => self.openapi_enabled.map(|b| b.to_string()),
            "server_google_client_id" => self.google_client_id.clone(),
            "server_public_url" => self.public_url.clone(),
            _ => None,
        }
        .filter(|v| !v.trim().is_empty())
    }

    /// 一個鍵現在的值與它的來源（環境變數 → 網站設定 → 預設）。唯一決定優先順序的地方。
    /// A key's value in effect and where it comes from (env → site setting → default). The one place precedence lives.
    pub fn effective(&self, key: &str) -> (String, Source) {
        if let Some(v) = self.env_value(key) {
            return (v, Source::Env);
        }
        let default = Saved::default().text(key).unwrap_or_default();
        match self.live.get().text(key) {
            Some(v) if v != default => (v, Source::Setting),
            _ => (default, Source::Default),
        }
    }

    /// `TRUSTED_PROXY_HOPS` / `client_ip_hops`。
    pub fn client_ip_hops(&self) -> Hops {
        Hops::parse(Some(&self.effective("client_ip_hops").0))
    }

    /// `CLIENT_IP_HEADER` / `client_ip_header`；空白 = 不用。/ None = no header.
    pub fn client_ip_header_name(&self) -> Option<String> {
        Some(self.effective("client_ip_header").0).filter(|h| !h.trim().is_empty()).map(|h| h.trim().to_string())
    }

    /// `client_ip_cloudflare`（沒有環境變數）。/ No environment variable.
    pub fn client_ip_cloudflare(&self) -> Cloudflare {
        Cloudflare::parse(&self.effective("client_ip_cloudflare").0).unwrap_or_default()
    }

    /// `DEVICE_PROBE` / `server_device_probe`，`device_info::run` 每一輪讀。/ Read every cycle.
    pub fn device_probe_on(&self) -> bool {
        self.effective("server_device_probe").0 == "true"
    }

    /// `KEEP_SHARED_SERVICE_KEY` / `server_keep_shared_service_key`。
    pub fn keep_shared_key(&self) -> bool {
        self.effective("server_keep_shared_service_key").0 == "true"
    }

    /// `GATEWAY_PROXY_PROTOCOL_FROM`：每一條連進 gateway 的連線解析一次；設錯 = 不啟用（並記 log）。
    /// Parsed for every gateway connection; a bad value = disabled (and logged).
    pub fn proxy_protocol_from(&self) -> Trusted {
        let (spec, source) = self.effective("server_gateway_proxy_protocol_from");
        Trusted::parse(&spec).unwrap_or_else(|e| {
            // 設錯就不啟用：代理送來的 header 會讓 SSH 握手失敗（看得出來），而不是讓人冒用 IP。
            // Disabled on a bad value: the proxy's connections then fail visibly instead of trusting anyone.
            tracing::error!(error = %e, from = source.as_str(), "GATEWAY_PROXY_PROTOCOL_FROM is invalid; PROXY protocol disabled");
            Trusted::default()
        })
    }

    /// log 等級（`LOG_LEVEL` / `server_log_level`；空白 = DEBUG 時 debug，否則 info）。/ The log level in effect.
    pub fn log_level_effective(&self) -> String {
        let (v, _) = self.effective("server_log_level");
        if v.trim().is_empty() {
            if self.debug { "debug".into() } else { "info".into() }
        } else {
            v.trim().to_string()
        }
    }

    /// `OPENAPI_ENABLED` / `server_openapi_enabled`，每個請求讀。/ Read per request.
    pub fn openapi_on(&self) -> bool {
        self.effective("server_openapi_enabled").0 == "true"
    }

    /// `SOCIAL_GOOGLE_CLIENT_ID` / `server_google_client_id`。
    pub fn google_client(&self) -> Option<String> {
        Some(self.effective("server_google_client_id").0.trim().to_string()).filter(|v| !v.is_empty())
    }

    /// `PUBLIC_URL` / `server_public_url`（去掉結尾斜線）。/ The public base URL, without a trailing slash.
    pub fn public_base(&self) -> Option<String> {
        Some(self.effective("server_public_url").0.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty())
    }

    /// API 的 `env`：每個可被環境變數蓋過的鍵 → `{var, set, value}`。/ The API's `env` map.
    pub fn env_json(&self) -> Value {
        let mut m = Map::new();
        for (key, var) in ENV_KEYS {
            let value = self.env_value(key);
            m.insert((*key).into(), json!({ "var": var, "set": value.is_some(), "value": value }));
        }
        Value::Object(m)
    }

    /// 存檔後：換掉記憶體快照，套用 log 等級。/ After a save: replace the snapshot and apply the log level.
    pub async fn reload_saved(&self, db: &Db) -> sqlx::Result<()> {
        self.live.load(db).await?;
        apply_log_level(&self.log_level_effective());
        Ok(())
    }
}

// --- log 等級即時套用 / applying the log level live ---

type Reloader = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
static LOG_RELOADER: OnceLock<Reloader> = OnceLock::new();

/// `main` 開 log 時登記一次（`tracing_subscriber::reload` 的 handle）；測試與子命令沒有。
/// Registered once by `main` when logging starts (the `tracing_subscriber::reload` handles); tests and subcommands have none.
pub fn set_log_reloader(f: impl Fn(&str) -> Result<(), String> + Send + Sync + 'static) {
    let _ = LOG_RELOADER.set(Box::new(f));
}

/// 換 log 等級（指令壞掉時留在原本的，記一筆）。/ Switch the log level (a bad directive keeps the current one).
pub fn apply_log_level(level: &str) {
    if let Some(f) = LOG_RELOADER.get() {
        if let Err(e) = f(&log_directive(level)) {
            tracing::warn!(error = %e, level, "cannot apply the log level");
        }
    }
}

/// LOG_LEVEL 可以是單一等級或完整的 EnvFilter 指令；單一 `debug` 時把 sqlx/hyper/russh 的內部 debug 壓掉
/// （否則每個 SQL 都會印一行）。
/// A single level or a full EnvFilter directive; a bare `debug` keeps our own modules verbose but silences
/// sqlx/hyper/russh internals.
pub fn log_directive(level: &str) -> String {
    match level.trim().to_ascii_lowercase().as_str() {
        "" => "info".to_string(),
        "debug" => "debug,sqlx=warn,hyper=info,hyper_util=info,h2=info,russh=info,tokio_tungstenite=info,tungstenite=info".to_string(),
        "trace" => "trace,sqlx=info,hyper=info,hyper_util=info,h2=info".to_string(),
        _ => level.trim().to_string(),
    }
}

// --- 存檔前的檢查（純函式）/ validation before a save (pure) ---

/// `auto` 或 0–10。/ `auto` or 0–10.
pub fn check_hops(v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.eq_ignore_ascii_case("auto") {
        return Ok("auto".into());
    }
    match v.parse::<u32>() {
        Ok(n) if n <= 10 => Ok(n.to_string()),
        _ => Err("Use auto or a whole number from 0 to 10.".into()),
    }
}

/// HTTP 標頭名稱（token 字元），可以空白。/ An HTTP header name (token characters), or blank.
pub fn check_header_name(v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c)) {
        Ok(v.to_string())
    } else {
        Err("Use a header name such as CF-Connecting-IP (letters, digits and - only), or leave it blank.".into())
    }
}

/// IP / CIDR 清單（逗號或空白分開），可以空白；存成逗號加空白接起來。/ An IP / CIDR list, or blank.
pub fn check_cidr_list(v: &str) -> Result<String, String> {
    Trusted::parse(v)?;
    Ok(v.split([',', ' ']).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "))
}

/// log 等級或 EnvFilter 指令，可以空白。/ A log level or EnvFilter directive, or blank.
pub fn check_log_level(v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.is_empty() {
        return Ok(String::new());
    }
    match tracing_subscriber::EnvFilter::try_new(log_directive(v)) {
        Ok(_) => Ok(v.to_string()),
        Err(e) => Err(format!("Not a valid log level or filter: {e}.")),
    }
}

/// `https://host[:port]`（http 也可以），沒有路徑、查詢、帳密；可以空白。存的時候去掉結尾斜線。
/// `https://host[:port]` (http too), no path / query / credentials, or blank. Stored without a trailing slash.
pub fn check_public_url(v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.is_empty() {
        return Ok(String::new());
    }
    let bad = || "Enter the address people open Telepy at, like https://telepy.example.com (no path), or leave it blank.".to_string();
    let u = reqwest::Url::parse(v).map_err(|_| bad())?;
    let ok = matches!(u.scheme(), "http" | "https")
        && u.host_str().is_some_and(|h| !h.is_empty())
        && u.username().is_empty()
        && u.password().is_none()
        && matches!(u.path(), "" | "/")
        && u.query().is_none()
        && u.fragment().is_none();
    if !ok {
        return Err(bad());
    }
    Ok(v.trim_end_matches('/').to_string())
}

/// Google OAuth client ID：沒有空白或控制字元，可以空白。/ No whitespace or control characters, or blank.
pub fn check_google_client_id(v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("A client ID has no spaces.".into());
    }
    Ok(v.to_string())
}

// --- Cloudflare 的位址範圍 / Cloudflare's address ranges ---

/// https://www.cloudflare.com/ips-v4 與 /ips-v6，2026-10-30 抄下（從 2023 年起沒變過）。執行時不上網抓。
/// https://www.cloudflare.com/ips-v4 and /ips-v6 as of 2026-10-30 (unchanged since 2023). Never fetched at runtime.
pub const CLOUDFLARE_RANGES: &[&str] = &[
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
];

/// 這個位址是不是 Cloudflare 的邊緣節點。/ Whether an address belongs to Cloudflare's edge.
pub fn is_cloudflare(ip: IpAddr) -> bool {
    static RANGES: OnceLock<Trusted> = OnceLock::new();
    RANGES.get_or_init(|| Trusted::parse(&CLOUDFLARE_RANGES.join(",")).expect("Cloudflare ranges parse")).contains(ip)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloudflare_ranges() {
        for ip in ["104.16.1.1", "172.67.200.3", "162.159.0.1", "2606:4700::6810:84e5", "::ffff:104.16.1.1", "2a06:98c7::1"] {
            assert!(is_cloudflare(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "198.51.100.7", "172.19.0.1", "2001:db8::1", "104.32.0.1"] {
            assert!(!is_cloudflare(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn validation() {
        assert_eq!(check_hops(" AUTO ").unwrap(), "auto");
        assert_eq!(check_hops("2").unwrap(), "2");
        assert_eq!(check_hops("0").unwrap(), "0");
        assert!(check_hops("11").is_err() && check_hops("two").is_err() && check_hops("-1").is_err() && check_hops("").is_err());

        assert_eq!(check_header_name(" CF-Connecting-IP ").unwrap(), "CF-Connecting-IP");
        assert_eq!(check_header_name("").unwrap(), "");
        assert!(check_header_name("X Real").is_err() && check_header_name("a:b").is_err() && check_header_name("é").is_err());

        assert_eq!(check_cidr_list("10.0.0.5,  172.16.0.0/12 fd00::/8").unwrap(), "10.0.0.5, 172.16.0.0/12, fd00::/8");
        assert_eq!(check_cidr_list(" ").unwrap(), "");
        assert!(check_cidr_list("proxy.local").is_err() && check_cidr_list("10.0.0.0/33").is_err());

        assert_eq!(check_log_level("").unwrap(), "");
        assert_eq!(check_log_level("debug").unwrap(), "debug");
        assert_eq!(check_log_level("info,telepy_server=debug").unwrap(), "info,telepy_server=debug");
        assert!(check_log_level("info,x=[").is_err());

        assert_eq!(check_public_url("https://t.example.com/").unwrap(), "https://t.example.com");
        assert_eq!(check_public_url("http://192.168.1.10:8787").unwrap(), "http://192.168.1.10:8787");
        assert_eq!(check_public_url("").unwrap(), "");
        for bad in ["t.example.com", "ftp://t.example.com", "https://t.example.com/app", "https://t.example.com/?a=1", "https://u:p@t.example.com"] {
            assert!(check_public_url(bad).is_err(), "{bad}");
        }

        assert_eq!(check_google_client_id(" 1-abc.apps.googleusercontent.com ").unwrap(), "1-abc.apps.googleusercontent.com");
        assert!(check_google_client_id("a b").is_err());
    }

    #[test]
    fn env_wins_then_setting_then_default() {
        let mut c = Config::from_env();
        c.trusted_proxy_hops = None;
        c.public_url = None;
        c.live = Live::default();
        assert_eq!(c.effective("client_ip_hops"), ("auto".to_string(), Source::Default));
        let mut saved = Saved::default();
        saved.client_ip_hops = "1".into();
        saved.public_url = "https://saved.example".into();
        c.live.set(saved);
        assert_eq!(c.effective("client_ip_hops"), ("1".to_string(), Source::Setting));
        assert_eq!(c.client_ip_hops(), Hops::Fixed(1));
        assert_eq!(c.public_base().as_deref(), Some("https://saved.example"));
        c.trusted_proxy_hops = Some(Hops::Fixed(2));
        assert_eq!(c.effective("client_ip_hops"), ("2".to_string(), Source::Env));
        assert_eq!(c.env_json()["client_ip_hops"], json!({"var": "TRUSTED_PROXY_HOPS", "set": true, "value": "2"}));
        assert_eq!(c.env_json()["server_public_url"], json!({"var": "PUBLIC_URL", "set": false, "value": null}));
        assert!(c.env_json().get("client_ip_cloudflare").is_none());
        // 空白的環境變數 = 沒設。/ A blank variable counts as unset.
        c.public_url = Some("  ".into());
        assert_eq!(c.effective("server_public_url").1, Source::Setting);
    }

    #[test]
    fn log_directive_expands_bare_levels() {
        assert!(log_directive("DEBUG").starts_with("debug,sqlx=warn"));
        assert_eq!(log_directive(""), "info");
        assert_eq!(log_directive("warn,telepy_server=info"), "warn,telepy_server=info");
    }
}
