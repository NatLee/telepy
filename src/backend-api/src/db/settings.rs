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
    pub notify_webhook_url: String,
    pub notify_down_delay: i64,
    pub user_key_max_days: i64,
    pub desktop_enabled: bool,
    pub desktop_max_sessions: i64,
    pub desktop_session_idle_timeout: i64,
    pub desktop_clipboard: String,
    pub desktop_max_resolution: i64,
    pub desktop_rustdesk_server: bool,
    pub mfa_require_totp: bool,
    pub mfa_require_passkey: bool,
    pub recording_retention_days: i64,
    pub command_approval_timeout: i64,
    pub signin_lifetime: i64,
    pub signin_access_lifetime: i64,
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
    "notify_webhook_url",
    "notify_down_delay",
    "user_key_max_days",
    "desktop_enabled",
    "desktop_max_sessions",
    "desktop_session_idle_timeout",
    "desktop_clipboard",
    "desktop_max_resolution",
    "desktop_rustdesk_server",
    "mfa_require_totp",
    "mfa_require_passkey",
    "recording_retention_days",
    "command_approval_timeout",
    "signin_lifetime",
    "signin_access_lifetime",
];

const COLS: &str = "id, allow_registration, valid_register_domains, remote_browser_session_idle_timeout, \
    remote_browser_max_sessions, remote_browser_geometry, remote_browser_ssh_timeout, remote_browser_ssh_attempts, \
    remote_browser_kasm_create_timeout, remote_browser_homepage, remote_browser_language, ai_session_idle_timeout, \
    ai_session_max_lifetime, ai_max_sessions_per_user, lan_scan_enabled, device_ip_lookup_url, notify_webhook_url, notify_down_delay, user_key_max_days, \
    desktop_enabled, desktop_max_sessions, desktop_session_idle_timeout, desktop_clipboard, desktop_max_resolution, desktop_rustdesk_server, mfa_require_totp, mfa_require_passkey, recording_retention_days, command_approval_timeout, signin_lifetime, signin_access_lifetime";

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
