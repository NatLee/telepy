//! 執行期設定：來自環境變數（其中幾個也能在網站設定裡改，見 `server_settings`），變數名與 Django 版一致（compose 不用改）。
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
    /// X-Forwarded-* / Host 推導。這裡只是 `PUBLIC_URL` 環境變數；用的地方讀 [`Config::public_base`]（環境變數 →
    /// 網站設定 → 沒有）。/ Only the PUBLIC_URL variable; consumers read [`Config::public_base`] (env → site setting).
    pub public_url: Option<String>,
    /// SSH_SERVER_DOMAIN：裝置與筆電的 SSH 連到這個名稱（空 = 跟網頁同一個）。/ The host devices' and laptops' SSH dial (blank = the web host).
    pub ssh_server_domain: Option<String>,
    /// `SOCIAL_GOOGLE_CLIENT_ID`；用的地方讀 [`Config::google_client`]。/ The variable; consumers read `google_client`.
    pub google_client_id: Option<String>,
    pub internal_api_token: String,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub log_root: PathBuf,
    /// `LOG_LEVEL`（有設才有）；生效的等級看 [`Config::log_level_effective`]。/ The variable; see `log_level_effective`.
    pub log_level: Option<String>,
    pub ssh_logs_path: PathBuf,
    pub web_service_pubkey_path: PathBuf,
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
    // --- remote desktop / guacd ---
    /// guacd 的 `host:port`。/ guacd address.
    pub guacd_addr: String,
    /// guacd 連回後端的主機名稱（預設 = 自己的 hostname）。/ Host name guacd dials back to (default: our hostname).
    pub desktop_callback_host: String,
    /// `ssh` client config/keys live here (mounted from ./ssh/backend_ssh_key in compose).
    pub ssh_home: PathBuf,
    /// OpenSSH 客戶端執行檔（測試可換成假程式）。/ The ssh client binary (swappable in tests).
    pub ssh_binary: String,
    /// russh 原生連線用的私鑰（預設 ~/.ssh/id_rsa，與 ssh 客戶端同一把）。
    pub ssh_identity: PathBuf,
    /// gateway 沒啟用時（開發環境、自帶 sshd 的測試）russh 直連裝置用的主機；有 gateway 時不用（行程內開通道）。
    pub ssh_target_host: String,
    /// Swagger UI + /api/openapi.json，登入後可見（OPENAPI_ENABLED=false 可關）；None = 環境變數沒設，看網站設定。
    /// Login-gated API docs; None = the variable is unset, the site setting decides ([`Config::openapi_on`]).
    pub openapi_enabled: Option<bool>,
    // --- in-process SSH gateway ---
    pub gateway_enabled: bool,
    pub gateway_bind: String,
    pub gateway_host_keys_dir: Option<PathBuf>,
    pub gateway_user: String,
    pub gateway_max_connections: usize,
    pub gateway_login_grace: Duration,
    pub gateway_probe_interval: Duration,
    /// gateway 前面送 PROXY protocol header 的 L4 代理（IP / CIDR，逗號分隔）；空 = 不啟用。
    /// L4 proxies in front of the gateway that send a PROXY protocol header (IPs / CIDRs); empty = off.
    /// None = 環境變數沒設（看網站設定，[`Config::proxy_protocol_from`]）。/ None = unset; see `proxy_protocol_from`.
    pub gateway_proxy_protocol_from: Option<String>,
    /// 每次裝置連上時登入問一次它的 hostname / 內網 / 公網 IP（`DEVICE_PROBE=false` 關閉）。
    /// Ask each device for its hostname / LAN / public IP once per connection (DEVICE_PROBE=false turns it off).
    /// None = 環境變數沒設（[`Config::device_probe_on`]）。/ None = unset; see `device_probe_on`.
    pub device_probe: Option<bool>,
    /// 共用服務金鑰永遠留在裝置上（`KEEP_SHARED_SERVICE_KEY=true`）：另一台還在用它登入的 Telepy（例如並行運作的舊站）
    /// 才不會在這裡的隧道換上自己的金鑰後被切斷。/ Never remove the shared service key from devices, so another Telepy
    /// server that still logs in with it (an old one running in parallel) keeps working after tunnels move to their own keys.
    /// None = 環境變數沒設（[`Config::keep_shared_key`]）。/ None = unset; see `keep_shared_key`.
    pub keep_shared_service_key: Option<bool>,
    // --- client IP (sign-in history, presence) ---
    /// 後端前面的可信反向代理：`auto`（預設）= X-Forwarded-For 右邊的每一段內部位址都是代理，取第一個公網位址
    /// （Traefik、前面的 Nginx Proxy Manager 都在內網，不必數）；數字 = 從右邊跳過固定這麼多段（含 Traefik；
    /// 只有 Traefik = 1，前面再一層 TLS 代理 = 2）。數字設太大會讓客戶端能偽造 IP。
    /// Trusted reverse proxies in front of the backend: `auto` (default) = every internal address at the right of
    /// X-Forwarded-For is a proxy, the first public one is the visitor (Traefik and an upstream Nginx Proxy
    /// Manager sit on internal addresses, so nothing to count); a number = skip exactly that many entries
    /// (Traefik included: 1 = Traefik only, 2 = plus an upstream TLS proxy). Too high lets clients spoof it.
    /// None = 環境變數沒設（看網站設定，[`Config::client_ip_hops`]）。/ None = unset; see `client_ip_hops`.
    pub trusted_proxy_hops: Option<crate::client_ip::Hops>,
    /// 直接採用這個標頭當來源 IP（例 `CF-Connecting-IP`）；只在上游一定會覆寫它時設定。這裡只是環境變數，生效的值看
    /// [`Config::client_ip_header_name`]。/ Trusted client-IP header (the variable only; see `client_ip_header_name`).
    pub client_ip_header: Option<String>,
    /// 離線 GeoIP 資料庫所在目錄（DB-IP Lite / GeoLite2 mmdb）；沒有檔案就不顯示國家 / ISP。/ GeoIP database directory.
    pub geoip_dir: PathBuf,
    /// 裝置端載體（`telepy-carrier` 各平台的 binary）的快取目錄（`CARRIER_DIR`，預設 `<DATA_DIR>/carriers`）。/ Device carrier cache.
    pub carrier_dir: PathBuf,
    /// 載體從哪個 release 頁抓（`TELEPY_RELEASES_URL`，鏡像用）。/ Where carriers are fetched from (a mirror for offline sites).
    pub releases_url: String,
    /// IEEE OUI 廠商表的目錄（`oui.csv`）。/ Directory with IEEE's oui.csv.
    pub oui_dir: PathBuf,
    // --- WebSocket liveness (terminal / file manager / remote browser) ---
    /// 每隔多久送一次 WebSocket Ping（瀏覽器自動回 Pong，背景分頁也一樣）。/ How often the server pings.
    pub ws_ping_interval: Duration,
    /// Ping 送出後這麼久什麼都沒收到、或一個 frame 這麼久送不出去 = 對方已經不在（睡眠、換網路、代理斷線），
    /// 結束連線並移出「使用中」。/ No answer to a ping (or a send stuck) this long = the client is gone.
    pub ws_peer_timeout: Duration,
    /// 網站設定裡存的伺服器設定（記憶體快照，所有 clone 共用）。/ The saved server settings, shared by every clone.
    pub live: crate::server_settings::Live,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn env_bool(name: &str, default: bool) -> bool {
    env_opt_bool(name).unwrap_or(default)
}

/// 有設才有值的布林環境變數。/ A boolean variable, None when unset.
fn env_opt_bool(name: &str) -> Option<bool> {
    env(name).map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
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
        let home = env("HOME").unwrap_or_else(|| "/root".to_string());
        // gateway：有 host key 目錄就預設啟用（容器掛 /config/ssh_host_keys）。
        let gateway_host_keys_dir = env("GATEWAY_HOST_KEYS_DIR")
            .map(PathBuf::from)
            .or_else(|| ["/config/ssh_host_keys"].iter().find(|p| Path::new(p).is_dir()).map(PathBuf::from));
        let ssh_logs_path = env("SSH_LOGS_PATH").map(PathBuf::from);
        let gateway_enabled = env("GATEWAY_ENABLED").map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")).unwrap_or(gateway_host_keys_dir.is_some());
        let ssh_logs_path = ssh_logs_path.unwrap_or_else(|| log_root.join("ssh-gateway.log"));
        let geoip_dir = env("GEOIP_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir.join("geoip"));
        let oui_dir = env("OUI_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir.join("oui"));
        let carrier_dir = env("CARRIER_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir.join("carriers"));
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
            ssh_server_domain: env("SSH_SERVER_DOMAIN"),
            internal_api_token: env("INTERNAL_API_TOKEN").unwrap_or_default(),
            db_path: env("DB_PATH").map(PathBuf::from).unwrap_or_else(|| data_dir.join("db.sqlite3")),
            data_dir,
            log_level: env("LOG_LEVEL"),
            log_root,
            ssh_logs_path,
            web_service_pubkey_path: env("WEB_SERVICE_SSH_PUBKEY")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(format!("{home}/.ssh/id_rsa.pub"))),
            default_register_domains: vec!["gmail.com".to_string()],
            tz_offset_minutes: env("TIME_ZONE_OFFSET_MINUTES")
                .and_then(|v| v.parse().ok())
                .unwrap_or(8 * 60),
            project_name: env("PROJECT_NAME").unwrap_or_else(|| "main".to_string()),
            hostname: env("HOSTNAME").unwrap_or_else(|| "backend".to_string()),
            guacd_addr: env("GUACD_ADDR").unwrap_or_else(|| "guacd:4822".to_string()),
            desktop_callback_host: env("DESKTOP_CALLBACK_HOST").or_else(|| env("HOSTNAME")).unwrap_or_else(|| "backend".to_string()),
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
            openapi_enabled: env_opt_bool("OPENAPI_ENABLED"),
            gateway_enabled,
            gateway_bind: env("GATEWAY_BIND").unwrap_or_else(|| "0.0.0.0:2222".to_string()),
            gateway_host_keys_dir,
            gateway_user: env("GATEWAY_USER").unwrap_or_else(|| "telepy".to_string()),
            gateway_max_connections: env("GATEWAY_MAX_CONNECTIONS").and_then(|v| v.parse().ok()).unwrap_or(4096),
            gateway_login_grace: Duration::from_secs(env("GATEWAY_LOGIN_GRACE_SECS").and_then(|v| v.parse().ok()).unwrap_or(60)),
            gateway_probe_interval: Duration::from_secs(env("GATEWAY_PROBE_INTERVAL_SECS").and_then(|v| v.parse().ok()).unwrap_or(15)),
            gateway_proxy_protocol_from: env("GATEWAY_PROXY_PROTOCOL_FROM"),
            device_probe: env_opt_bool("DEVICE_PROBE"),
            keep_shared_service_key: env_opt_bool("KEEP_SHARED_SERVICE_KEY"),
            trusted_proxy_hops: env("TRUSTED_PROXY_HOPS").map(|v| crate::client_ip::Hops::parse(Some(&v))),
            client_ip_header: env("CLIENT_IP_HEADER"),
            geoip_dir,
            oui_dir,
            carrier_dir,
            releases_url: env("TELEPY_RELEASES_URL").map(|s| s.trim().trim_end_matches('/').to_string()).unwrap_or_else(|| crate::carriers::RELEASES.to_string()),
            ws_ping_interval: Duration::from_secs(env("WS_PING_INTERVAL_SECS").and_then(|v| v.parse().ok()).filter(|v| *v > 0).unwrap_or(20)),
            ws_peer_timeout: Duration::from_secs(env("WS_PEER_TIMEOUT_SECS").and_then(|v| v.parse().ok()).filter(|v| *v > 0).unwrap_or(40)),
            live: Default::default(),
        }
    }

    /// SERVER_DOMAIN 去掉 scheme 與尾斜線（容錯：env 可能填成 http://host:port）。
    pub fn server_host(&self) -> Option<String> {
        self.server_domain.as_ref().map(|d| {
            d.split("://").last().unwrap_or(d).trim_end_matches('/').to_string()
        })
    }
}
