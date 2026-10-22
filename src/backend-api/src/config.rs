//! 執行期設定：全部來自環境變數，變數名與 Django 版一致（compose 不用改）。
//! Runtime configuration from environment variables; names match the Django backend so the
//! existing compose/.env keep working unchanged.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Django settings.py 裡硬編碼的 SECRET_KEY。沿用它是為了讓切換當下既有 JWT 不失效；
/// 正式環境請用 `SECRET_KEY` 環境變數覆蓋（啟動時會對預設值發出警告）。
/// The hard-coded Django SECRET_KEY, kept as the default so existing JWTs stay valid across the
/// cutover. Override with the SECRET_KEY env var in production (a warning is logged otherwise).
pub const DJANGO_DEFAULT_SECRET_KEY: &str =
    "django-insecure-uye!=@*gjois#e#8u*3law8=d4^&5s0sh-w*+r3_%+x5tn$lru";

#[derive(Clone, Debug)]
pub struct Config {
    pub debug: bool,
    pub bind: String,
    pub secret_key: String,
    pub secret_key_is_default: bool,
    /// settings.REVERSE_SERVER_SSH_PORT 在 Django 是「字串」(env 原文)，create-key 回應裡的 `port`
    /// 也是字串；這裡保留原文以維持回應形狀。/ Kept as the raw string: the create-key response
    /// echoes it verbatim (Django returned the env string, not an int).
    pub reverse_server_ssh_port: String,
    pub web_server_port: Option<String>,
    pub server_domain: Option<String>,
    /// 對外的 base URL（例 `https://telepy.example.com`）：OAuth issuer 與 MCP resource 由它決定；沒設就依
    /// X-Forwarded-* / Host 推導。/ Public base URL used as the OAuth issuer; derived from the request when unset.
    pub public_url: Option<String>,
    pub google_client_id: Option<String>,
    pub internal_api_token: String,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub log_root: PathBuf,
    pub log_level: String,
    pub ssh_logs_path: PathBuf,
    pub web_service_pubkey_path: PathBuf,
    pub access_token_lifetime: Duration,
    pub refresh_token_lifetime: Duration,
    /// settings.VALID_REGISTER_DOMAINS fallback when the site setting is blank.
    pub default_register_domains: Vec<String>,
    /// Asia/Taipei (+08:00, no DST) — DRF serialised datetimes in TIME_ZONE.
    pub tz_offset_minutes: i32,
    pub project_name: String,
    /// 自己的 hostname（kasm-browser 經 telepy-network 連回 SOCKS 代理用）。
    pub hostname: String,
    // --- remote browser / kasm ---
    pub kasm_api: String,
    pub kasm_host: String,
    pub kasm_ws_user: String,
    pub kasm_ws_password: String,
    pub kasm_ws_scheme: String,
    pub kasm_ws_path: String,
    pub kasm_ws_subprotocol: String,
    pub remote_browser_gc: bool,
    /// `ssh` client config/keys live here (mounted from ./ssh/backend_ssh_key in compose).
    pub ssh_home: PathBuf,
    /// OpenSSH 客戶端執行檔（測試可換成假程式）。/ The ssh client binary (swappable in tests).
    pub ssh_binary: String,
    /// russh 原生連線用的私鑰（預設 ~/.ssh/id_rsa，與 ssh 客戶端同一把）。
    pub ssh_identity: PathBuf,
    /// terminal / file manager / `ssh -D` 連線的目標主機：內建 gateway 的 loopback listener（單跳）。
    pub ssh_target_host: String,
    /// Swagger UI + /api/openapi.json，登入後可見（OPENAPI_ENABLED=false 可關）。/ Login-gated API docs.
    pub openapi_enabled: bool,
    // --- in-process SSH gateway ---
    pub gateway_enabled: bool,
    pub gateway_bind: String,
    pub gateway_host_keys_dir: Option<PathBuf>,
    pub gateway_user: String,
    pub gateway_max_connections: usize,
    pub gateway_login_grace: Duration,
    pub gateway_probe_interval: Duration,
    // --- client IP (sign-in history, presence) ---
    /// 後端前面有幾層可信的反向代理（含 Traefik）：從 X-Forwarded-For 右邊跳過這麼多段。compose 只有
    /// Traefik = 1；前面再有 TLS 代理 / LB = 2。設太大會讓客戶端能偽造 IP。
    /// Trusted reverse proxies in front of the backend, Traefik included (1 = Traefik only, 2 = plus an
    /// upstream TLS proxy). Too high lets clients spoof their address.
    pub trusted_proxy_hops: usize,
    /// 直接採用這個標頭當來源 IP（例 `CF-Connecting-IP`）；只在上游一定會覆寫它時設定。/ Trusted client-IP header.
    pub client_ip_header: Option<String>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn env_bool(name: &str, default: bool) -> bool {
    env(name)
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

fn first_existing(candidates: &[&str], fallback: PathBuf) -> PathBuf {
    for c in candidates {
        if Path::new(c).exists() {
            return PathBuf::from(c);
        }
    }
    fallback
}

impl Config {
    pub fn from_env() -> Self {
        let debug = env_bool("DEBUG", false);
        let data_dir = env("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| first_existing(&["/data"], PathBuf::from("./data")));
        let log_root = env("LOG_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| first_existing(&["/logs"], PathBuf::from("./logs")));
        let secret_key = env("SECRET_KEY");
        let secret_key_is_default = secret_key.is_none();
        let access_minutes: u64 = env("ACCESS_TOKEN_LIFETIME_MINUTES")
            .and_then(|v| v.parse().ok())
            .unwrap_or(3600);
        let refresh_days: u64 = env("REFRESH_TOKEN_LIFETIME_DAYS")
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        let home = env("HOME").unwrap_or_else(|| "/root".to_string());
        // gateway：有 host key 目錄就預設啟用（容器掛 /config/ssh_host_keys）。
        let gateway_host_keys_dir = env("GATEWAY_HOST_KEYS_DIR")
            .map(PathBuf::from)
            .or_else(|| ["/config/ssh_host_keys"].iter().find(|p| Path::new(p).is_dir()).map(PathBuf::from));
        let ssh_logs_path = env("SSH_LOGS_PATH").map(PathBuf::from);
        let gateway_enabled = env("GATEWAY_ENABLED").map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")).unwrap_or(gateway_host_keys_dir.is_some());
        let ssh_logs_path = ssh_logs_path.unwrap_or_else(|| log_root.join("ssh-gateway.log"));
        Self {
            debug,
            bind: env("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8000".to_string()),
            secret_key: secret_key.unwrap_or_else(|| DJANGO_DEFAULT_SECRET_KEY.to_string()),
            secret_key_is_default,
            reverse_server_ssh_port: env("REVERSE_SERVER_SSH_PORT").unwrap_or_default(),
            web_server_port: env("WEB_SERVER_PORT"),
            server_domain: env("SERVER_DOMAIN"),
            public_url: env("PUBLIC_URL").map(|u| u.trim().trim_end_matches('/').to_string()),
            google_client_id: env("SOCIAL_GOOGLE_CLIENT_ID"),
            internal_api_token: env("INTERNAL_API_TOKEN").unwrap_or_default(),
            db_path: env("DB_PATH").map(PathBuf::from).unwrap_or_else(|| data_dir.join("db.sqlite3")),
            data_dir,
            log_level: env("LOG_LEVEL").unwrap_or_else(|| if debug { "debug".into() } else { "info".into() }),
            log_root,
            ssh_logs_path,
            web_service_pubkey_path: env("WEB_SERVICE_SSH_PUBKEY")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(format!("{home}/.ssh/id_rsa.pub"))),
            access_token_lifetime: Duration::from_secs(access_minutes * 60),
            refresh_token_lifetime: Duration::from_secs(refresh_days * 86400),
            default_register_domains: vec!["gmail.com".to_string()],
            tz_offset_minutes: env("TIME_ZONE_OFFSET_MINUTES")
                .and_then(|v| v.parse().ok())
                .unwrap_or(8 * 60),
            project_name: env("PROJECT_NAME").unwrap_or_else(|| "main".to_string()),
            hostname: env("HOSTNAME").unwrap_or_else(|| "backend".to_string()),
            kasm_api: env("KASM_BROWSER_API").unwrap_or_else(|| "http://kasm-browser:7000".to_string()),
            kasm_host: env("KASM_BROWSER_HOST").unwrap_or_else(|| "kasm-browser".to_string()),
            kasm_ws_user: std::env::var("KASM_WS_USER").unwrap_or_else(|_| "telepy".to_string()),
            kasm_ws_password: std::env::var("KASM_WS_PASSWORD").unwrap_or_else(|_| "telepyvnc".to_string()),
            kasm_ws_scheme: env("KASM_WS_SCHEME").unwrap_or_else(|| "ws".to_string()),
            kasm_ws_path: env("KASM_WS_PATH").unwrap_or_else(|| "/websockify".to_string()),
            kasm_ws_subprotocol: std::env::var("KASM_WS_SUBPROTOCOL").unwrap_or_else(|_| "binary".to_string()),
            remote_browser_gc: env("REMOTE_BROWSER_GC").map(|v| v != "0").unwrap_or(true),
            ssh_home: PathBuf::from(format!("{home}/.ssh")),
            ssh_binary: env("SSH_BINARY").unwrap_or_else(|| "ssh".to_string()),
            ssh_identity: env("SSH_IDENTITY").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(format!("{home}/.ssh/id_rsa"))),
            ssh_target_host: "127.0.0.1".to_string(),
            openapi_enabled: env_bool("OPENAPI_ENABLED", true),
            gateway_enabled,
            gateway_bind: env("GATEWAY_BIND").unwrap_or_else(|| "0.0.0.0:2222".to_string()),
            gateway_host_keys_dir,
            gateway_user: env("GATEWAY_USER").unwrap_or_else(|| "telepy".to_string()),
            gateway_max_connections: env("GATEWAY_MAX_CONNECTIONS").and_then(|v| v.parse().ok()).unwrap_or(4096),
            gateway_login_grace: Duration::from_secs(env("GATEWAY_LOGIN_GRACE_SECS").and_then(|v| v.parse().ok()).unwrap_or(60)),
            gateway_probe_interval: Duration::from_secs(env("GATEWAY_PROBE_INTERVAL_SECS").and_then(|v| v.parse().ok()).unwrap_or(15)),
            trusted_proxy_hops: env("TRUSTED_PROXY_HOPS").and_then(|v| v.parse().ok()).unwrap_or(1),
            client_ip_header: env("CLIENT_IP_HEADER"),
        }
    }

    /// SERVER_DOMAIN 去掉 scheme 與尾斜線（容錯：env 可能填成 http://host:port）。
    pub fn server_host(&self) -> Option<String> {
        self.server_domain.as_ref().map(|d| {
            d.split("://").last().unwrap_or(d).trim_end_matches('/').to_string()
        })
    }
}
