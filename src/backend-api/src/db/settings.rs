//! SiteSettings 單一列（pk=1）。/ The SiteSettings singleton row.

use sqlx::FromRow;

use super::Db;

#[derive(Debug, Clone, FromRow)]
pub struct SiteSettings {
    pub id: i64,
    pub allow_registration: bool,
    pub valid_register_domains: String,
    pub remote_browser_session_idle_timeout: i64,
    pub remote_browser_max_sessions: i64,
    pub remote_browser_geometry: String,
    pub remote_browser_ssh_timeout: i64,
    pub remote_browser_ssh_attempts: i64,
    pub remote_browser_kasm_create_timeout: i64,
    pub remote_browser_homepage: String,
    pub remote_browser_language: String,
    pub ai_session_idle_timeout: i64,
    pub ai_session_max_lifetime: i64,
    pub ai_max_sessions_per_user: i64,
    pub lan_scan_enabled: bool,
    pub device_ip_lookup_url: String,
    /// 一般使用者能不能設自己的 webhook。/ Whether everyone may set up personal webhooks.
    pub notify_user_webhooks: bool,
    /// 個人 webhook 能不能連到內網位址（全站 webhook 一律可以）。/ Personal webhooks may target private addresses.
    pub notify_private_targets: bool,
    /// 每個人最多幾個個人 webhook。/ Personal webhooks per user.
    pub notify_max_webhooks: i64,
    pub user_key_max_days: i64,
    pub desktop_enabled: bool,
    pub desktop_max_sessions: i64,
    pub desktop_session_idle_timeout: i64,
    pub desktop_clipboard: String,
    pub desktop_max_resolution: i64,
    /// 網頁內 RustDesk 可以傳檔案。/ In-browser RustDesk may transfer files.
    pub desktop_file_transfer: bool,
    pub mfa_require_totp: bool,
    pub mfa_require_passkey: bool,
    pub recording_retention_days: i64,
    pub command_approval_timeout: i64,
    pub signin_lifetime: i64,
    pub signin_access_lifetime: i64,
    /// 網頁終端機斷線後 shell 最多留幾秒（0 = 功能關閉）。/ The longest a detached web terminal shell is kept (0 = off).
    pub terminal_detach_max_secs: i64,
    /// 一般登入頁：standard | discreet。/ The sign-in page: standard | discreet.
    pub signin_page_style: String,
    /// MCP 應用程式的 OAuth 登入頁：standard | discreet。/ The OAuth (app connection) sign-in page.
    pub signin_oauth_style: String,
    /// 低調登入頁上的一句話（空白 = 內建的句子）。/ The discreet page's line (blank = the built-in ones).
    pub signin_page_message: String,
    /// `telepy login` 的瀏覽器登入頁：standard | discreet。/ The page `telepy login` opens: standard | discreet.
    pub signin_cli_style: String,
    /// 授權（同意）頁與 `telepy login` 的完成頁：standard | discreet。/ The approval page and the CLI's done page.
    pub signin_consent_style: String,
    // --- 伺服器設定（環境變數有設時以環境變數為準，見 `server_settings`）/ Server settings (a set env var wins) ---
    /// `auto` 或 0–10（TRUSTED_PROXY_HOPS）。/ `auto` or 0–10.
    pub client_ip_hops: String,
    /// 指定的來源 IP 標頭（CLIENT_IP_HEADER），空白 = 不用。/ Trusted client-IP header; blank = none.
    pub client_ip_header: String,
    /// `auto` / `always` / `off`：怎麼看 Cloudflare 的 `CF-Connecting-IP`。/ How `CF-Connecting-IP` is used.
    pub client_ip_cloudflare: String,
    pub server_device_probe: bool,
    pub server_keep_shared_service_key: bool,
    pub server_gateway_proxy_protocol_from: String,
    pub server_log_level: String,
    pub server_openapi_enabled: bool,
    pub server_google_client_id: String,
    pub server_public_url: String,
}

/// 欄位順序 = serializer 的 fields 順序（決定 values/meta 的輸出順序）。
pub const FIELDS: &[&str] = &[
    "allow_registration",
    "valid_register_domains",
    "remote_browser_session_idle_timeout",
    "remote_browser_max_sessions",
    "remote_browser_geometry",
    "remote_browser_ssh_timeout",
    "remote_browser_ssh_attempts",
    "remote_browser_kasm_create_timeout",
    "remote_browser_homepage",
    "remote_browser_language",
    "ai_session_idle_timeout",
    "ai_session_max_lifetime",
    "ai_max_sessions_per_user",
    "lan_scan_enabled",
    "device_ip_lookup_url",
    "notify_user_webhooks",
    "notify_private_targets",
    "notify_max_webhooks",
    "user_key_max_days",
    "desktop_enabled",
    "desktop_max_sessions",
    "desktop_session_idle_timeout",
    "desktop_clipboard",
    "desktop_max_resolution",
    "desktop_file_transfer",
    "mfa_require_totp",
    "mfa_require_passkey",
    "recording_retention_days",
    "command_approval_timeout",
    "signin_lifetime",
    "signin_access_lifetime",
    "terminal_detach_max_secs",
    "signin_page_style",
    "signin_oauth_style",
    "signin_cli_style",
    "signin_consent_style",
    "signin_page_message",
    "client_ip_hops",
    "client_ip_header",
    "client_ip_cloudflare",
    "server_device_probe",
    "server_keep_shared_service_key",
    "server_gateway_proxy_protocol_from",
    "server_log_level",
    "server_openapi_enabled",
    "server_google_client_id",
    "server_public_url",
];

const COLS: &str = "id, allow_registration, valid_register_domains, remote_browser_session_idle_timeout, \
    remote_browser_max_sessions, remote_browser_geometry, remote_browser_ssh_timeout, remote_browser_ssh_attempts, \
    remote_browser_kasm_create_timeout, remote_browser_homepage, remote_browser_language, ai_session_idle_timeout, \
    ai_session_max_lifetime, ai_max_sessions_per_user, lan_scan_enabled, device_ip_lookup_url, notify_user_webhooks, notify_private_targets, notify_max_webhooks, user_key_max_days, \
    desktop_enabled, desktop_max_sessions, desktop_session_idle_timeout, desktop_clipboard, desktop_max_resolution, desktop_file_transfer, mfa_require_totp, mfa_require_passkey, recording_retention_days, command_approval_timeout, signin_lifetime, signin_access_lifetime, terminal_detach_max_secs, \
    signin_page_style, signin_oauth_style, signin_page_message, signin_cli_style, signin_consent_style, \
    client_ip_hops, client_ip_header, client_ip_cloudflare, server_device_probe, server_keep_shared_service_key, \
    server_gateway_proxy_protocol_from, server_log_level, server_openapi_enabled, server_google_client_id, server_public_url";

pub async fn get_solo(db: &Db) -> sqlx::Result<SiteSettings> {
    if let Some(s) = sqlx::query_as::<_, SiteSettings>(&format!("SELECT {COLS} FROM site_settings_sitesettings WHERE id = 1"))
        .fetch_optional(&db.read)
        .await?
    {
        return Ok(s);
    }
    sqlx::query("INSERT OR IGNORE INTO site_settings_sitesettings (id, allow_registration) VALUES (1, 0)")
        .execute(&db.write)
        .await?;
    sqlx::query_as(&format!("SELECT {COLS} FROM site_settings_sitesettings WHERE id = 1"))
        .fetch_one(&db.read)
        .await
}

pub enum SettingValue {
    Bool(bool),
    Int(i64),
    Str(String),
}

pub async fn update_field(db: &Db, field: &str, value: SettingValue) -> sqlx::Result<()> {
    if !FIELDS.contains(&field) {
        return Ok(());
    }
    let sql = format!("UPDATE site_settings_sitesettings SET \"{field}\" = ? WHERE id = 1");
    let q = sqlx::query(&sql);
    let q = match value {
        SettingValue::Bool(b) => q.bind(b),
        SettingValue::Int(i) => q.bind(i),
        SettingValue::Str(s) => q.bind(s),
    };
    q.execute(&db.write).await?;
    Ok(())
}

impl SiteSettings {
    /// 註冊 email 網域白名單；空白時退回預設。/ Registration domain allowlist with fallback.
    pub fn register_domains(&self, fallback: &[String]) -> Vec<String> {
        let list: Vec<String> = self
            .valid_register_domains
            .split(',')
            .map(|d| d.trim().to_ascii_lowercase())
            .filter(|d| !d.is_empty())
            .collect();
        if list.is_empty() {
            fallback.iter().map(|d| d.to_ascii_lowercase()).collect()
        } else {
            list
        }
    }
}
