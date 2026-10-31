//! OpenAPI schema 型別：只用來產生文件（handler 仍回 `serde_json::Value`，形狀與這裡一致）。
//! Documentation-only schema types for the OpenAPI document; handlers keep returning JSON values.

#![allow(dead_code)]

use utoipa::ToSchema;

#[derive(ToSchema)]
#[schema(description = "Error body: custom views use {error}, DRF-style views use {detail}; field validation errors are {field: [message]}")]
pub struct ErrorBody {
    pub error: Option<String>,
    pub detail: Option<String>,
}

#[derive(ToSchema)]
pub struct Message {
    pub message: String,
}

#[derive(ToSchema)]
pub struct Status {
    pub status: String,
}

// ---------------------------------------------------------------- auth

#[derive(ToSchema)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(ToSchema)]
pub struct TokenPair {
    pub refresh_token: String,
    pub access_token: String,
}

#[derive(ToSchema)]
#[schema(description = "Either the token pair, or — when the account has a passkey or an authenticator app — a two-factor challenge to finish with POST /api/auth/mfa/verify")]
pub struct LoginResponse {
    pub refresh_token: Option<String>,
    pub access_token: Option<String>,
    pub mfa_required: Option<bool>,
    pub mfa_token: Option<String>,
    #[schema(example = json!(["passkey", "totp", "recovery_code"]))]
    pub methods: Option<Vec<String>>,
}

#[derive(ToSchema)]
pub struct RefreshRequest {
    pub refresh: String,
}

/// `/api/auth/token/refresh`：新的 access token 和換發的 refresh token（舊的只在 60 秒寬限內還能用）。
/// A fresh access token and the rotated refresh token (the old one works for a 60-second grace only).
#[derive(ToSchema)]
pub struct RefreshResponse {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(ToSchema)]
pub struct LogoutRequest {
    pub refresh: String,
}

#[derive(ToSchema)]
pub struct VerifyRequest {
    pub token: String,
}

#[derive(ToSchema)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
}

#[derive(ToSchema)]
pub struct UserRef {
    pub id: i64,
    pub username: String,
}

#[derive(ToSchema)]
pub struct RegisterData {
    pub user: UserRef,
}

#[derive(ToSchema)]
pub struct RegisterResponse {
    pub status: String,
    pub data: RegisterData,
    pub details: String,
}

#[derive(ToSchema)]
pub struct GoogleLoginRequest {
    #[schema(example = "eyJhbGciOi…")]
    pub credential: String,
}

#[derive(ToSchema)]
pub struct SetupStatus {
    pub first_time_setup: bool,
}

/// 登入頁的樣子（公開）。/ How the sign-in pages look (public).
#[derive(ToSchema)]
pub struct SignInPage {
    /// The sign-in page: standard | discreet
    #[schema(example = "discreet")]
    pub style: String,
    /// The OAuth (app connection) sign-in page: standard | discreet
    #[schema(example = "standard")]
    pub oauth_style: String,
    /// The page `telepy login` (the CLI's browser sign-in) shows a signed-out browser: standard | discreet
    #[schema(example = "discreet")]
    pub cli_style: String,
    /// The approval (consent) page `/oauth/authorize`, and the page `telepy login` shows once signed in: standard | discreet
    #[schema(example = "standard")]
    pub consent_style: String,
    /// The discreet page's lines, one per line, typed in turn; blank = the built-in ones
    #[schema(example = "")]
    pub message: String,
    /// Google sign-in 的 client ID（SOCIAL_GOOGLE_CLIENT_ID → 網站設定 → 空字串）。/ Google's client ID in effect (env → site setting → empty)
    #[schema(example = "376808175534-example.apps.googleusercontent.com")]
    pub google_client_id: String,
    /// The web's host from PUBLIC_URL (null when PUBLIC_URL is unset)
    #[schema(example = "telepy.example.com")]
    pub web_host: Option<String>,
    /// The SSH host when set separately (null = the same as the web)
    #[schema(example = "telepy-ssh.example.com")]
    pub ssh_host: Option<String>,
    /// PUBLIC_URL in effect (null when unset)
    #[schema(example = "https://telepy.example.com")]
    pub public_url: Option<String>,
}

/// 呼叫用的委派 token。/ The delegated token the call came with.
#[derive(ToSchema)]
pub struct ProfileCredential {
    /// api_token / oauth_app
    pub kind: String,
    pub id: i64,
    pub name: String,
    pub scopes: Vec<String>,
    /// null = every tunnel
    pub tunnel_ids: Option<Vec<i64>>,
    /// API tokens only
    pub expires_at: Option<String>,
}

#[derive(ToSchema)]
pub struct UserProfile {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub is_staff: bool,
    pub is_superuser: bool,
    pub is_active: bool,
    #[schema(example = "2026-02-22T09:04:12.123456Z")]
    pub date_joined: String,
    pub last_login: Option<String>,
    #[schema(example = "zh-TW")]
    pub language: Option<String>,
    #[schema(example = "system")]
    pub theme: String,
    pub terminal_font_size: i64,
    /// UI display scale in percent (85–130).
    pub ui_scale: i64,
    /// Terminal font id (the frontend's list; default `hack`)
    #[schema(example = "hack")]
    pub terminal_font: String,
    /// Terminal colour-scheme id (a built-in from the frontend's list or a custom `custom-…`; default `telepy`)
    #[schema(example = "telepy")]
    pub terminal_scheme: String,
    /// How bold text is drawn: face (real bold face) | bright (brighter colour only) | both
    #[schema(example = "face")]
    pub terminal_bold: String,
    /// Programming ligatures in the web terminal (fonts that have them)
    pub terminal_ligatures: bool,
    /// Card or list view per page (`tunnels`, `key_groups`, …); pages missing here use their default
    #[schema(value_type = Object, example = json!({"tunnels": "list", "key_groups": "card"}))]
    pub view_modes: serde_json::Value,
    /// Remote desktop display preferences (scale, percent, resolution, width, height, hidpi, vnc_resize, quality,
    /// audio); null = never chosen on this account
    #[schema(value_type = Option<Object>, example = json!({"scale": "fit", "percent": 100, "resolution": "window", "width": 1920, "height": 1080, "hidpi": false, "vnc_resize": false, "quality": "auto", "audio": false}))]
    pub desktop_display: Option<serde_json::Value>,
    /// Tapi 的十字髮夾顏色（空 = 還沒找到 Tapi）。/ Tapi's clip colour (empty = not found yet).
    pub tapi_color: String,
    /// 「每天換一個」解鎖了沒。/ Whether "daily" is unlocked.
    pub tapi_daily: bool,
    /// A passkey or an authenticator app is set up
    pub mfa_enabled: bool,
    /// Second factors the administrator requires that this account has not set up yet (`totp`, `passkey`).
    /// While non-empty, every other REST route answers 403 `mfa_enrollment_required`.
    #[schema(example = json!(["totp"]))]
    pub mfa_missing: Vec<String>,
    /// Feature ids this person may use (all of them for administrators); the rest answer 403 `feature_disabled`.
    #[schema(example = json!(["tunnels.create", "terminal", "files"]))]
    pub features: Vec<String>,
    /// Set when the call came with a personal API token or an OAuth app token
    pub credential: Option<ProfileCredential>,
}

// ---------------------------------------------------------------- tunnels

#[derive(ToSchema)]
pub struct Tunnel {
    pub id: i64,
    pub can_edit: bool,
    pub can_share: bool,
    pub can_delete: bool,
    pub is_owner: bool,
    #[schema(example = "owner")]
    pub user_permission: Option<String>,
    pub shared_with_count: i64,
    pub host_friendly_name: String,
    /// 裝置的公鑰（認得是哪台機器）：只給 owner / ADMIN，其他人 null。
    /// The device's public key (identifies the machine): owner / ADMIN only, null for everyone else.
    #[schema(example = "ssh-ed25519 AAAA… device")]
    pub key: Option<String>,
    pub reverse_port: i64,
    pub description: Option<String>,
    #[schema(example = "2026-02-22T17:04:12.123456+08:00")]
    pub created_at: String,
    pub updated_at: String,
    pub user: i64,
    pub default_username: Option<i64>,
    /// 列表（`/keys`、`/dashboard`）與單筆 retrieve 帶：裝置的位址與基本狀況。看不到（只看狀態的 sharee）或從沒連過時是 null。
    /// List, dashboard and single retrieve: the device's addresses and facts; null when hidden (status-only sharee) or never connected.
    pub endpoint: Option<TunnelEndpoint>,
    /// 列表與單筆都帶：裝置怎麼連 Telepy（SSH port 或網頁 port 的 WebSocket）。沒有位址，所有看得到隧道的人都有。
    /// List and single retrieve: how the device reaches Telepy (SSH port or the web port's WebSocket); holds no address,
    /// so every viewer gets it.
    pub way_in: Option<TunnelWayIn>,
    /// 只有列表帶：誰正在用。/ List / dashboard only: who is using the tunnel right now.
    pub presence: Option<TunnelPresence>,
    /// 只有列表帶：`online`（經由隧道讀得到裝置 sshd）/ `degraded`（forward 在但 sshd 連續沒回應）/ `offline` / `never`（從沒連上過）。
    /// List / dashboard only: online, degraded (forward up, device sshd not answering), offline or never (never connected).
    #[schema(example = "online")]
    pub health: Option<String>,
    /// 只有列表帶：離線時最後一次有連線的時間（UTC，`…Z`）；連著或從沒連過時 null。不含 IP，所有人都看得到。
    /// List / dashboard only: when the tunnel was last connected (UTC); null while connected or if it never was.
    pub last_seen_at: Option<String>,
    /// 只有列表帶：我有沒有釘選（每個人自己的）。/ List / dashboard only: whether I pinned it (per user).
    pub pinned: Option<bool>,
    /// 我把它放在哪個通道群組（每個人自己的；`/api/reverse/tunnel-groups`）；null = 未分組。
    /// My tunnel group for it (personal; see `/api/reverse/tunnel-groups`); null = ungrouped.
    pub group_id: Option<i64>,
    /// 只有列表帶：被分享給我、而且有期限時，我的存取到什麼時候（UTC）；否則 null。
    /// List / dashboard only: when my access ends, for a timed share with me; otherwise null.
    pub share_expires_at: Option<String>,
    /// 只有列表帶：owner / ADMIN 看得到還在等的存取申請數；其他人 0。/ List only: pending access requests (owner / ADMIN; else 0).
    pub access_requests: Option<i64>,
    /// 只有列表帶：分享給誰（分享的先後順序，權限是現在有效的那個）；只給 owner / ADMIN（能管分享的人），其他人 null。
    /// List / dashboard only: who the tunnel is shared with (in sharing order, the permission in force); owner / ADMIN only, null for everyone else.
    pub shared_with: Option<Vec<TunnelSharee>>,
    /// 開 session 前要 step-up（`POST /api/auth/step-up`，token 放 `X-Telepy-Step-Up` 或 WebSocket auth 的 `step_up`）。
    /// Sessions need a step-up first (token in `X-Telepy-Step-Up` or the WebSocket auth field `step_up`).
    pub require_step_up: bool,
    /// 網頁終端機會錄影（`PUT /api/reverse/server/{id}/recording`）。/ Web terminal sessions are recorded.
    pub record_sessions: bool,
    /// 網頁終端機斷線時：user = 照使用者的保留時間、never = 一律立刻結束（`PUT /api/reverse/server/{id}/terminal-detach`）。
    /// When a web terminal drops: user = keep the shell per the user's choice, never = always end it at once.
    #[schema(example = "user")]
    pub terminal_detach_policy: String,
    /// 只有列表帶：隧道標籤（大家共用）。/ List / dashboard only: the tunnel's labels (shared).
    #[schema(example = json!(["home", "env=prod"]))]
    pub labels: Option<Vec<String>>,
    /// Single retrieve only: this tunnel's own service key (`type base64 comment`), the one the device authorizes; owner / ADMIN only, null for everyone else
    pub service_key: Option<String>,
}

/// 連線紀錄與在線率。在線率是 0..1，從第一筆紀錄算起；沒有紀錄時是 null。
/// Connection history and uptime (0..1, counted from the first recorded session; null without data).
#[derive(ToSchema)]
pub struct TunnelConnections {
    /// 第一筆紀錄的時間（UTC）。/ When the history begins (UTC).
    pub tracked_since: Option<String>,
    pub uptime: UptimePair,
    /// 最近 24 小時每小時的在線率（舊到新）；紀錄開始前是 null。/ Last 24 hours, hour by hour, oldest first.
    pub hourly: Vec<Option<f64>>,
    /// 最近 20 次連線（新到舊）。/ The latest 20 sessions, newest first.
    pub sessions: Vec<ConnectionSession>,
}

#[derive(ToSchema)]
pub struct UptimePair {
    pub h24: Option<f64>,
    pub d7: Option<f64>,
}

#[derive(ToSchema)]
pub struct ConnectionSession {
    /// 只給能登入裝置的人（同 `endpoint`）。/ Only for people who can log in to the device (like `endpoint`).
    pub ip: Option<String>,
    pub connected_at: String,
    /// 連著時是 null。/ null while connected.
    pub disconnected_at: Option<String>,
    pub seconds: Option<i64>,
}

#[derive(ToSchema)]
pub struct PinState {
    pub pinned: bool,
}

/// 小寫英數開頭，可含 `. _ - =`，最多 32 字元、12 個；送進來的會被整理（小寫、去重複、排序）。
/// Lowercase letters / digits first, then `. _ - =`; up to 32 characters and 12 labels; normalised on save.
#[derive(ToSchema)]
pub struct LabelsRequest {
    #[schema(example = json!(["home", "env=prod"]))]
    pub labels: Vec<String>,
}

#[derive(ToSchema)]
pub struct TunnelSharee {
    /// 使用者 id。/ The sharee's user id.
    pub id: i64,
    #[schema(example = "alice")]
    pub username: String,
    /// view / edit / admin（暫時提升過期了就是原本的）。/ view / edit / admin (a temporary raise that ran out counts as the original).
    #[schema(example = "view")]
    pub permission: String,
}

#[derive(ToSchema)]
pub struct TunnelPresence {
    /// 正在用的人數（同一人多個分頁算一次）。/ Distinct users with an open session.
    pub count: i64,
    /// owner / ADMIN / 管理員才有；其他人 null。/ Owner / ADMIN / superuser only; null for everyone else.
    pub sessions: Option<Vec<PresenceSession>>,
}

#[derive(ToSchema)]
pub struct PresenceSession {
    /// `DELETE /api/sessions/{id}` 用。/ For `DELETE /api/sessions/{id}`.
    pub id: u64,
    #[schema(example = "alice")]
    pub user: String,
    /// terminal / files / browser / ssh / ai
    #[schema(example = "terminal")]
    pub kind: String,
    #[schema(example = "198.51.100.7")]
    pub ip: Option<String>,
    pub geo: Option<IpGeo>,
    #[schema(example = "2026-10-23T01:02:03.123456Z")]
    pub since: String,
    /// AI session 的 app 名稱。/ The app behind an AI session.
    pub client: Option<String>,
    /// 斷線保留中的網頁終端機（否則 null）。/ A detached web terminal (null otherwise).
    pub detached: Option<DetachedShell>,
}

/// 網頁終端機斷線後還留著 shell：從何時起、何時結束。/ A web terminal whose shell is kept after a drop: since when, until when.
#[derive(ToSchema)]
pub struct DetachedShell {
    #[schema(example = "2026-10-27T01:02:03.123456Z")]
    pub since: String,
    #[schema(example = "2026-10-27T01:07:03.123456Z")]
    pub ends_at: String,
}

/// 裝置怎麼連 Telepy。`setup` 和 `last` 不一樣 = 實際走的方式跟設定的不同。
/// How the device reaches Telepy. `setup` differing from `last` = it came in another way than it was set up for.
#[derive(ToSchema)]
pub struct TunnelWayIn {
    /// 加進來時設定的方式（一鍵加入 / 裝置下載的一次性腳本；手動貼腳本的看第一次連線）：`ssh` = SSH port，
    /// `websocket` = 網頁 port（SSH over WebSocket）；不知道是 null。
    /// The way it was set up (one-command join / the one-time script the device downloaded; a pasted script = its first
    /// connection): `ssh` = SSH port, `websocket` = web port (SSH over WebSocket); null when unknown.
    #[schema(example = "ssh")]
    pub setup: Option<String>,
    /// 現在連著的方式，離線時是最後一次的（`ssh` / `websocket`）；從沒連過或升級前連的是 null。
    /// The way it is connected now, else the way it last connected (`ssh` / `websocket`); null if never (or before the upgrade).
    #[schema(example = "websocket")]
    pub last: Option<String>,
    /// 現在連著。/ Connected now.
    pub live: bool,
    /// `last` 是 websocket 時：外面有沒有 TLS（wss）；其他情況或不知道是 null。
    /// When `last` is websocket: whether it had TLS (wss); otherwise or unknown, null.
    pub tls: Option<bool>,
}

/// 裝置連上 gateway 的來源位址（gateway 看到的 TCP 來源；中間若有 L4 proxy 會是 proxy 的 IP）。
#[derive(ToSchema)]
pub struct TunnelEndpoint {
    #[schema(example = "203.0.113.7")]
    pub ip: String,
    /// true = 現在連著；false = 最後一次連線的紀錄。/ true while connected, false = last recorded connection.
    pub live: bool,
    #[schema(example = "2026-10-22T09:15:02.123456Z")]
    pub connected_at: String,
    /// 離線時：forward 釋放的時間；連著時 null。/ When the forward went away; null while live.
    pub last_seen_at: Option<String>,
    /// 裝置怎麼連上 gateway（離線時 = 最後一次）：`tcp` = SSH port，`websocket` = 網頁 port；升級前連的是 null。
    /// How the device reached the gateway (offline: the last time): `tcp` = SSH port, `websocket` = web port; null before the upgrade.
    #[schema(example = "tcp")]
    pub transport: Option<String>,
    pub geo: Option<IpGeo>,
    /// 最近一次換「公網 IP」之前的位址（從沒換過是 null）。/ The public address before the latest change; null if it never changed.
    #[schema(example = "198.51.100.20")]
    pub previous_ip: Option<String>,
    pub changed_at: Option<String>,
    /// 裝置真正的公網 IP：gateway 看到的（是公網位址時）、裝置經 `/api/whoami` 回報的，或裝置問站台設定的查詢網址得到的；不知道是 null。
    /// The device's real public IP: the gateway's peer when public, else reported by the device via `/api/whoami`,
    /// else what the device got from the site's `device_ip_lookup_url`.
    #[schema(example = "114.34.69.11")]
    pub public_ip: Option<String>,
    /// gateway / device / lookup
    pub public_source: Option<String>,
    pub public_geo: Option<IpGeo>,
    /// 裝置的內網網卡（每次連上問一次）。/ The device's LAN interfaces (asked once per connection).
    pub lan: Vec<LanAddress>,
    #[schema(example = "pi-garage")]
    pub hostname: Option<String>,
    /// 最後一次問裝置的時間與錯誤。/ When the device was last asked, and why it failed.
    pub probed_at: Option<String>,
    pub probe_error: Option<String>,
    /// 裝置的基本狀況（跟位址同一個每天一次的唯讀腳本；沒讀過是 null）。/ Device facts from the same daily script; null if never read.
    pub facts: Option<DeviceFacts>,
    pub facts_at: Option<String>,
}

/// 裝置的基本狀況；每一項都可能是 null（那台裝置沒有那個指令）。/ Device facts; any field may be null (command missing).
#[derive(ToSchema)]
pub struct DeviceFacts {
    #[schema(example = "Debian GNU/Linux 12 (bookworm)")]
    pub os: Option<String>,
    #[schema(example = "Linux 6.1.0-26-amd64")]
    pub kernel: Option<String>,
    #[schema(example = "x86_64")]
    pub arch: Option<String>,
    /// 問的當下開機幾秒。/ Seconds since boot when asked (`facts_at`).
    pub uptime_s: Option<u64>,
    pub cpu_model: Option<String>,
    pub cpus: Option<u32>,
    pub mem_total_kb: Option<u64>,
    pub mem_avail_kb: Option<u64>,
    /// 根目錄（Windows：C:）。/ Root file system (Windows: C:).
    pub disk_total_kb: Option<u64>,
    pub disk_avail_kb: Option<u64>,
    /// 1 / 5 / 15 分鐘負載（Windows 沒有）。/ 1 / 5 / 15-minute load (none on Windows).
    pub load: Option<Vec<f64>>,
    #[schema(example = "OpenSSH_9.2p1 Debian-2+deb12u3, OpenSSL 3.0.14 4 Jun 2024")]
    pub ssh: Option<String>,
    /// 只有 Debian 家族知道。/ Debian family only.
    pub reboot_required: Option<bool>,
    pub warnings: Vec<DeviceWarning>,
}

/// 磁碟剩不到 10 % 或 2 GB、可用記憶體不到 10 %、1 分鐘負載超過 CPU 數兩倍、等著重開機。
/// Disk < 10 % or < 2 GB free, memory < 10 % available, load1 > 2 × CPUs, reboot pending.
#[derive(ToSchema)]
pub struct DeviceWarning {
    #[schema(example = "disk")]
    pub kind: String,
    #[schema(example = "root disk: 1.2 GB free of 32 GB (3%)")]
    pub detail: String,
}

#[derive(ToSchema)]
pub struct ProbeError {
    pub error: String,
    #[schema(example = "device_offline")]
    pub code: String,
    /// 429：還要等幾秒。/ 429: seconds to wait.
    pub retry_after: Option<u64>,
}

#[derive(ToSchema)]
pub struct LanAddress {
    #[schema(example = "eth0")]
    pub iface: String,
    #[schema(example = "192.168.1.23")]
    pub ip: String,
    #[schema(example = 24)]
    pub prefix: i64,
}

/// IP 的位址範圍與（有離線 GeoIP 資料庫時的）國家 / 網路業者。/ Address scope plus country / network owner when a GeoIP database is installed.
#[derive(ToSchema)]
pub struct IpGeo {
    /// public / private / loopback / link_local / shared_nat / reserved —— 裝置是非 public 通常代表前面有 proxy 吃掉了真實來源。
    #[schema(example = "public")]
    pub scope: String,
    /// ISO 3166-1 alpha-2
    #[schema(example = "TW")]
    pub country: Option<String>,
    #[schema(example = "Chunghwa Telecom Co., Ltd.")]
    pub org: Option<String>,
    #[schema(example = 3462)]
    pub asn: Option<i64>,
    /// DB-IP / MaxMind（顯示出處用）。/ Data source, for attribution.
    pub source: Option<String>,
}

/// 來源 IP 判定鏈上的一段。/ One entry of the client-address chain.
#[derive(ToSchema)]
pub struct ClientIpHop {
    #[schema(example = "172.19.0.1")]
    pub ip: String,
    /// public / private / loopback / link_local / shared_nat / reserved
    pub scope: String,
    /// forwarded_for（X-Forwarded-For 的一段）/ peer（連進後端的 socket 對端）
    pub source: String,
    /// ignored（選中那段左邊，客戶端能塞的）/ client（選中）/ proxy（跳過的可信代理）
    pub role: String,
}

/// 帶位址的標頭（X-Real-IP、Forwarded、CF-Connecting-IP…）。/ A header that carries addresses.
#[derive(ToSchema)]
pub struct ClientIpHeader {
    #[schema(example = "x-real-ip")]
    pub name: String,
    pub value: String,
    pub addresses: Vec<ClientIpAddress>,
}

#[derive(ToSchema)]
pub struct ClientIpAddress {
    pub ip: String,
    pub scope: String,
}

#[derive(ToSchema)]
pub struct ClientIpSuggest {
    pub trusted_proxy_hops: Option<i64>,
    pub client_ip_header: Option<String>,
}

/// `GET /api/auth/client-ip-check`：Telepy 怎麼判定這個請求的來源 IP。/ How Telepy resolved this request's address.
#[derive(ToSchema)]
pub struct ClientIpCheck {
    #[schema(example = "198.51.100.7")]
    pub ip: Option<String>,
    pub scope: Option<String>,
    /// chain（X-Forwarded-For + socket 對端）/ header（`CLIENT_IP_HEADER`）/ cloudflare（`CF-Connecting-IP`）
    pub from: Option<String>,
    pub geo: Option<IpGeo>,
    /// `auto`（內部位址都算代理）/ `fixed`（`TRUSTED_PROXY_HOPS` 是數字）。/ `auto` or `fixed`.
    #[schema(example = "auto")]
    pub hops_mode: String,
    /// 固定層數；自動模式是 null。/ The fixed count; null in auto mode.
    pub trusted_proxy_hops: Option<i64>,
    /// 這個請求實際被當成代理跳過的段數。/ Entries skipped as proxies on this request.
    pub skipped_hops: i64,
    pub client_ip_header: Option<String>,
    /// 左（離瀏覽器近）到右（離 Telepy 近），最後一段是 socket 對端。/ Left (browser side) to right; the last one is the socket peer.
    pub chain: Vec<ClientIpHop>,
    pub headers: Vec<ClientIpHeader>,
    /// ok / hops_too_low / hops_too_high / use_header / header_private / all_private / unknown
    #[schema(example = "all_private")]
    pub verdict: String,
    pub suggest: ClientIpSuggest,
    /// 這個請求經過的代理比 `TRUSTED_PROXY_HOPS` 少。/ Fewer proxies than configured.
    pub short_chain: bool,
    /// 設了 `CLIENT_IP_HEADER` 但請求沒有它。/ The configured header was missing.
    pub header_absent: bool,
    /// 每個值由誰決定。/ Which layer decides each value.
    pub sources: ClientIpSources,
    pub cloudflare: ClientIpCloudflare,
    /// 提示碼：`cloudflare_masked`（有 CF-Connecting-IP 但看不到 Cloudflare 的位址：前面的代理換掉了它）。
    /// Hint codes: `cloudflare_masked` (the header is there but no Cloudflare address: a proxy in front replaced it).
    pub hints: Vec<String>,
}

/// `env` / `setting` / `default` per key.
#[derive(ToSchema)]
pub struct ClientIpSources {
    #[schema(example = "env")]
    pub client_ip_hops: String,
    pub client_ip_header: String,
    pub client_ip_cloudflare: String,
}

/// Cloudflare 那一段。/ How `CF-Connecting-IP` was judged.
#[derive(ToSchema)]
pub struct ClientIpCloudflare {
    /// auto / always / off
    #[schema(example = "auto")]
    pub mode: String,
    /// `CF-Connecting-IP` 的原文。/ The header as sent.
    pub header: Option<String>,
    /// 鏈上有 Cloudflare 的位址。/ A Cloudflare address is on the chain.
    pub edge_seen: bool,
    /// 位址取自 `CF-Connecting-IP`。/ The address came from `CF-Connecting-IP`.
    pub used: bool,
}

/// `telepy-server doctor` 的一項檢查。/ One `telepy-server doctor` check.
#[derive(ToSchema)]
pub struct HealthCheck {
    /// 穩定的機器 id（前端分組、翻譯用）。/ Stable machine id the frontend groups and translates by.
    #[schema(example = "database")]
    pub id: String,
    #[schema(example = "database")]
    pub name: String,
    /// ok / info / warn / fail
    #[schema(example = "ok")]
    pub status: String,
    pub detail: String,
    /// 結果的指紋（16 hex）：問題一變就變。/ The result's fingerprint (16 hex): changes whenever the problem does.
    #[schema(example = "3f9a0c1e5b7d2a64")]
    pub fingerprint: String,
    /// 對現在這個結果（同一指紋、仍是 warn / fail）的確認。/ An acknowledgement of this exact result.
    pub ack: Option<HealthAck>,
    /// 之前的確認，但結果已經變了。/ An earlier acknowledgement of a result that has changed since.
    pub stale_ack: Option<HealthAck>,
}

/// 管理員對一項檢查的確認。/ An admin's acknowledgement of a check.
#[derive(ToSchema)]
pub struct HealthAck {
    /// 確認的管理員。/ The admin who acknowledged it.
    #[schema(example = "admin")]
    pub by: String,
    #[schema(example = "2026-10-30T01:02:03Z")]
    pub at: String,
    pub note: String,
}

/// `POST /api/site/health/ack`：確認一個 ⚠ / ✗。/ Acknowledge a warning or failure.
#[derive(ToSchema)]
pub struct HealthAckBody {
    #[schema(example = "audit_log")]
    pub check_id: String,
    /// 頁面載入時看到的指紋；結果變了 = 409 `changed`。/ The fingerprint the page showed; a changed result = 409 `changed`.
    pub fingerprint: String,
    /// 1–500 字元（去頭尾空白）。/ 1–500 characters, trimmed.
    pub note: String,
    /// 帳號有第二因素時必填的再驗證證明。/ Re-authentication proof, required once the account has a second factor.
    pub reauth: Option<serde_json::Value>,
}

/// `GET /api/site/health`：伺服器狀態（管理員）。/ The server's health (superusers).
#[derive(ToSchema)]
pub struct ServerHealth {
    pub checks: Vec<HealthCheck>,
    /// 各級的原始筆數（確認過的也算在 warnings / failures 裡）。/ Raw counts per level (acknowledged ones included).
    pub ok: i64,
    pub info: i64,
    pub warnings: i64,
    pub failures: i64,
    /// 已確認的 warn / fail 數。/ Acknowledged warnings and failures.
    pub acknowledged: i64,
    #[schema(example = "2026-10-30T01:02:03Z")]
    pub ran_at: String,
    /// Only in the answer to a re-seal: one record per table re-sealed
    pub resealed: Option<Vec<AuditReseal>>,
}

/// 一次登入嘗試（成功或失敗）。/ One sign-in attempt.
#[derive(ToSchema)]
pub struct SignInEvent {
    pub id: i64,
    #[schema(example = "2026-10-23T01:02:03.123456Z")]
    pub at: String,
    pub ok: bool,
    /// password / google / passkey
    #[schema(example = "password")]
    pub method: String,
    /// totp / recovery_code / passkey; null without a second step
    pub second_factor: Option<String>,
    /// 依 X-Forwarded-For（`TRUSTED_PROXY_HOPS`）或 `CLIENT_IP_HEADER` 判定。/ Resolved from the proxy chain.
    #[schema(example = "198.51.100.7")]
    pub ip: Option<String>,
    pub geo: Option<IpGeo>,
    pub user_agent: Option<String>,
    /// bad_password / inactive / mfa_failed / google_account_conflict
    pub reason: Option<String>,
}

/// 一個還有效的網頁登入（一個瀏覽器）。/ One live web sign-in (one browser).
#[derive(ToSchema)]
pub struct WebSession {
    pub id: i64,
    /// 最後一次續期 / 使用時的 IP。/ The IP of the last renewal or use.
    #[schema(example = "198.51.100.7")]
    pub ip: Option<String>,
    pub geo: Option<IpGeo>,
    pub user_agent: Option<String>,
    /// 「瀏覽器 · 作業系統」，認不出來為 null。/ "browser · OS", null when unrecognised.
    #[schema(example = "Chrome · macOS")]
    pub device: Option<String>,
    #[schema(example = "2026-10-23T01:02:03.123456Z")]
    pub created_at: String,
    /// 最後一次續期，或最多每 5 分鐘記一次的 REST 使用。/ Last renewal, or REST use recorded at most every 5 minutes.
    pub last_seen_at: String,
    /// 沒有再用的話何時登出（每次續期往後推）。/ When it ends without further use (slides on every renewal).
    pub expires_at: String,
    /// 就是發出這個請求的瀏覽器。/ The browser making this request.
    pub current: bool,
    /// password / google / passkey；升級前的登入為 null。/ First factor; null for sign-ins from before the upgrade.
    pub sign_in_method: Option<String>,
    /// totp / recovery_code / passkey
    pub mfa_method: Option<String>,
}

/// `GET /api/auth/sessions` 與管理員版本。/ The sessions list and the admin version.
#[derive(ToSchema)]
pub struct WebSessionList {
    pub sessions: Vec<WebSession>,
    /// 網站設定 `signin_lifetime`（秒）：多久沒用就要重新登入。/ Seconds of no use before a sign-in ends.
    pub signin_lifetime: i64,
    /// 網站設定 `signin_access_lifetime`（秒）：access token 多久換一次。/ Seconds between access-token renewals.
    pub access_lifetime: i64,
}

#[derive(ToSchema)]
pub struct TunnelWrite {
    pub host_friendly_name: String,
    pub key: String,
    pub reverse_port: i64,
    pub description: Option<String>,
    pub default_username: Option<i64>,
    /// `mine` starts the device key list with all of your keys; `empty` (default) starts it empty
    pub key_list: Option<String>,
}

#[derive(ToSchema)]
pub struct TunnelPatch {
    pub description: Option<String>,
    pub host_friendly_name: Option<String>,
    pub default_username: Option<i64>,
    /// 新的裝置公鑰：只有 owner / ADMIN；換了會斷開現在的連線。/ A new device key: owner / ADMIN only; drops the live connection.
    pub key: Option<String>,
    /// 新的隧道號碼：只有 owner / ADMIN。/ A new reverse port: owner / ADMIN only.
    pub reverse_port: Option<i64>,
    /// 換金鑰或號碼、帳號有第二因素時要的再驗證。/ Re-authentication when changing the key or port and the account has a factor.
    #[schema(value_type = Option<Object>)]
    pub reauth: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct Dashboard {
    pub tunnels: Vec<Tunnel>,
    /// `{"<reverse_port>": true|false}`
    #[schema(value_type = Object)]
    pub ports: serde_json::Value,
    /// `{"<reverse_port>": rtt_ms}`
    #[schema(value_type = Object)]
    pub latency: serde_json::Value,
}

#[derive(ToSchema)]
pub struct Username {
    pub id: i64,
    pub username: String,
    pub created_at: String,
    pub updated_at: String,
    pub reverse_server: i64,
    pub user: i64,
}

#[derive(ToSchema)]
pub struct UsernameWrite {
    pub reverse_server: i64,
    pub username: String,
}

#[derive(ToSchema)]
pub struct UsernamePatch {
    pub username: String,
}

#[derive(ToSchema)]
pub struct UsernameEntry {
    pub id: i64,
    pub username: String,
    pub created_by: Option<String>,
    pub created_by_id: Option<i64>,
}

#[derive(ToSchema)]
pub struct UsernamesForServer {
    /// 每列另有 `shared_with`：幾位 sharee 的允許清單上有它（只給 owner / ADMIN，其餘 null）。/ Each row also carries
    /// `shared_with`: how many sharees' allow-lists hold it (owner / ADMIN only, else null).
    pub usernames: Vec<UsernameEntry>,
    pub default_username_id: Option<i64>,
    /// ADMIN sharee 人數（不用清單、每個帳號都能用；只給 owner / ADMIN）。/ ADMIN sharees (owner / ADMIN only).
    pub admin_sharees: Option<i64>,
    /// 你能不能新增 / 刪除帳號（owner / ADMIN）。/ Whether you may add / remove accounts.
    pub can_manage: bool,
}

#[derive(ToSchema)]
pub struct DefaultUsernameRequest {
    /// `null` clears the default
    pub default_username_id: Option<i64>,
}

#[derive(ToSchema)]
pub struct DefaultUsernameResponse {
    pub message: String,
    pub default_username_id: Option<i64>,
}

#[derive(ToSchema)]
pub struct UserKey {
    pub id: i64,
    pub host_friendly_name: String,
    pub key: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub user: i64,
    /// `SHA256:…` (same as `ssh-keygen -lf`); null when the stored key cannot be parsed
    pub fingerprint: Option<String>,
    /// ED25519 / RSA / ECDSA / SK-ED25519 / SK-ECDSA
    pub key_type: Option<String>,
    pub bits: Option<u32>,
    pub comment: Option<String>,
    /// Last successful SSH gateway login with this key
    pub last_used_at: Option<String>,
    pub last_used_ip: Option<String>,
    /// 到期時間；null = 不到期。到期後 gateway 拒絕它、裝置清單把它移除。/ Expiry; null = never. Expired keys are refused and removed from devices.
    pub expires_at: Option<String>,
    pub expired: bool,
    /// 它在哪個金鑰群組（`/api/reverse/user/key-groups`）；null = 未分組。/ Its key group; null = none.
    pub group_id: Option<i64>,
    /// 這把也是你哪些隧道的裝置金鑰（那台電腦既是裝置、也拿這把連別的裝置）；通常是空的。
    /// Your tunnels whose device key this also is (that computer is a device and reaches others with it); usually empty.
    pub device_of: Vec<NamedRef>,
}

#[derive(ToSchema)]
pub struct UserKeyWrite {
    pub host_friendly_name: String,
    pub key: String,
    pub description: Option<String>,
    /// RFC 3339 時間或 `YYYY-MM-DD`（那天 UTC 結束）；null = 不到期。沒給時用站台的 `user_key_max_days`（0 = 不到期）。
    /// RFC 3339 or `YYYY-MM-DD` (end of that day, UTC); null = never. Omitted = the site's `user_key_max_days` (0 = never).
    #[schema(example = "2026-12-31")]
    pub expires_at: Option<String>,
    /// 放進這個金鑰群組（它授予的裝置都會裝上）。/ Put it in this key group (every device the group is granted to gets it).
    pub group_id: Option<i64>,
}

#[derive(ToSchema)]
pub struct UserKeyPatch {
    pub description: Option<String>,
    /// 續期或改到期時間（null = 不到期，站台有上限時不允許）。/ Renew or change the expiry (null = never, refused under a site limit).
    pub expires_at: Option<String>,
    /// 換金鑰群組（null = 拿出群組）；沒給 = 不動。/ Move it to a key group (null = none); absent = unchanged.
    pub group_id: Option<i64>,
}

/// 分享到什麼時候：RFC 3339 或 `YYYY-MM-DD`（那天 UTC 結束），null = 一直有效。到期後 30 秒內自動取消分享。
/// When a share ends: RFC 3339 or `YYYY-MM-DD` (end of that day, UTC), null = never. Ended within 30 s of expiry.
#[derive(ToSchema)]
pub struct ShareExpiryRequest {
    #[schema(example = "2026-12-31T18:00:00+08:00")]
    pub expires_at: Option<String>,
}

/// 存取申請：要哪些帳號、要不要更高權限、多久（15 分鐘到 7 天）、理由。
/// An access request: accounts, an optional higher permission, how long (15 minutes to 7 days), and why.
#[derive(ToSchema)]
pub struct AccessRequestCreate {
    pub account_ids: Vec<i64>,
    #[schema(example = "edit")]
    pub permission: Option<String>,
    #[schema(example = 28800)]
    pub duration_secs: i64,
    pub reason: Option<String>,
}

/// 核准時可以改時長（省略 = 照申請的）。/ Approve with a different duration (omit = as requested).
#[derive(ToSchema)]
pub struct AccessRequestDecision {
    pub duration_secs: Option<i64>,
}

#[derive(ToSchema)]
pub struct AccessRequestItem {
    pub id: i64,
    pub tunnel_id: i64,
    pub requester: UserRef,
    pub accounts: Vec<UserRef>,
    pub permission: Option<String>,
    pub duration_secs: i64,
    pub reason: String,
    /// pending / approved / denied / cancelled
    pub status: String,
    pub created_at: String,
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
    /// 核准後暫時授權到什麼時候。/ When an approved grant ends.
    pub ends_at: Option<String>,
}

#[derive(ToSchema)]
pub struct RequestableAccount {
    pub id: i64,
    pub username: String,
    pub allowed: bool,
    pub until: Option<String>,
}

/// owner / ADMIN：等待中與最近的申請；其他 sharee：自己的申請 + 可以要的帳號。
/// Owner / ADMIN: pending and recent requests. Other sharees: their own + the accounts they could ask for.
#[derive(ToSchema)]
pub struct AccessRequestList {
    pub can_decide: bool,
    pub can_request: bool,
    pub permission: String,
    pub requests: Vec<AccessRequestItem>,
    pub accounts: Option<Vec<RequestableAccount>>,
    pub permission_until: Option<String>,
}

#[derive(ToSchema)]
pub struct ServiceKey {
    pub id: i64,
    pub service: String,
    pub key: String,
    pub description: Option<String>,
}

#[derive(ToSchema)]
pub struct IssuedToken {
    pub token: String,
    pub issuer: UserRef,
    pub created_at: String,
}

#[derive(ToSchema)]
pub struct CreateKeyRequest {
    pub host_friendly_name: String,
    pub key: String,
    pub description: Option<String>,
    /// `mine` starts the device key list with all of your keys; `empty` (default) starts it empty
    pub key_list: Option<String>,
}

#[derive(ToSchema)]
pub struct CreatedKey {
    pub id: i64,
    pub host_friendly_name: String,
    pub key: String,
    /// This tunnel's own service key (`type base64 comment`): the device authorizes it so Telepy can log in
    pub service_key: String,
    /// The SSH port devices connect to (REVERSE_SERVER_SSH_PORT), as a string
    pub port: String,
    pub issuer: UserRef,
    pub reverse_port: i64,
    pub description: Option<String>,
}

#[derive(ToSchema)]
pub struct DuplicateCheckRequest {
    pub host_friendly_name: String,
    pub key: String,
}

#[derive(ToSchema)]
pub struct DuplicateCheck {
    /// Another tunnel already has this name, ignoring case (ssh lowercases host names)
    pub host_friendly_name_exists: bool,
    /// Why the name can't be a tunnel name: name_empty | name_too_long | name_first_char | name_chars (null = fine)
    pub host_friendly_name_problem: Option<String>,
    /// The key cannot be used: it is any user's device key already (comment ignored), another user's personal key, or Telepy's service key
    pub key_exists: bool,
    /// Why: taken | personal | service (null when the key is free)
    pub key_reason: Option<String>,
    /// The key is free and is one of your own personal keys: the device will be the computer you work from (both roles); null otherwise
    pub key_personal: Option<NamedRef>,
    pub message: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------- scripts

#[derive(ToSchema)]
pub struct ConfigResponse {
    pub config: String,
    pub usernames: Vec<UsernameEntry>,
    /// 伺服器區塊（`Host telepy-<網域>-<port>`）的連線資訊。/ Where the server stanza points.
    pub server: ConfigServer,
    /// config 裡每個裝置 Host 區塊（依 username_ids 篩選後）。/ One entry per device Host stanza in `config`.
    pub hosts: Vec<ConfigHost>,
    /// 隧道的預設帳號（你能用時），否則 null。/ The tunnel's default account when you may use it, else null.
    pub default_username_id: Option<i64>,
    /// 你的裝置別名前綴（個人設定 `ssh_alias_prefix`，空 = 不加）。/ Your device alias prefix (empty = none).
    pub alias_prefix: String,
    #[schema(example = 10022)]
    pub reverse_port: i64,
    /// Lines to save as `known_hosts_path` on your computer (`<alias> <type> <base64>`): one per gateway host key, then one per pinned host key of each device in the config (alias `<server alias>-device-<tunnel id>`, the device stanza's `HostKeyAlias`); empty when nothing is known
    pub known_hosts: String,
    #[schema(example = "~/.ssh/telepy_known_hosts")]
    pub known_hosts_path: String,
    /// ssh | websocket (as requested with ?transport=)
    pub transport: String,
    /// The gateway's WebSocket address (`wss://host/ws/gateway/`)
    pub ws_url: String,
    /// Where to download the python3 carrier from (laptops; devices get the prebuilt telepy-carrier from `/api/join/carrier/{target}`)
    pub ws_client_url: String,
    #[schema(example = "~/.ssh/telepy-ws.py")]
    pub ws_client_path: String,
}

/// `GET /tunnels/server/config`：多台裝置一次。/ Several devices at once.
#[derive(ToSchema)]
pub struct BulkConfigResponse {
    /// 一個伺服器區塊 + 每台裝置的區塊。/ One server stanza plus every listed device's stanzas.
    pub config: String,
    pub server: ConfigServer,
    /// default = 每台一個 Host（隧道預設帳號）；all = 每個帳號一個。/ default = one Host per device; all = one per account.
    #[schema(example = "default")]
    pub accounts: String,
    /// 你的裝置別名前綴（個人設定 `ssh_alias_prefix`，空 = 不加）。/ Your device alias prefix (empty = none).
    pub alias_prefix: String,
    /// 寫進 config 的裝置，依名稱排序。/ The devices in `config`, sorted by name.
    pub tunnels: Vec<BulkConfigTunnel>,
    /// 看得到但沒有可用帳號的裝置。/ Devices you can see but have no login account on.
    pub skipped: Vec<BulkConfigSkipped>,
    /// As in the single config: the gateway's host keys, then every listed device's pinned host keys
    pub known_hosts: String,
    #[schema(example = "~/.ssh/telepy_known_hosts")]
    pub known_hosts_path: String,
    /// ssh | websocket
    pub transport: String,
    pub ws_url: String,
    pub ws_client_url: String,
    #[schema(example = "~/.ssh/telepy-ws.py")]
    pub ws_client_path: String,
}

#[derive(ToSchema)]
pub struct BulkConfigTunnel {
    pub id: i64,
    #[schema(example = "my-pi")]
    pub name: String,
    pub reverse_port: i64,
    /// 這台的 Host 區塊。/ This device's Host stanzas.
    pub hosts: Vec<ConfigHost>,
    /// 我在這台能用的帳號。/ The accounts I may use here.
    pub usernames: Vec<serde_json::Value>,
    /// 隧道的預設帳號（你能用時）。/ The tunnel's default account when you may use it.
    pub default_username_id: Option<i64>,
    /// 這台的帳號是 `pick` 指定的。/ This device's accounts came from `pick`.
    pub picked: bool,
}

#[derive(ToSchema)]
pub struct BulkConfigSkipped {
    pub id: i64,
    pub name: String,
    /// no_accounts
    #[schema(example = "no_accounts")]
    pub reason: String,
}

#[derive(ToSchema)]
pub struct ConfigServer {
    /// `telepy-<網域>-<port>`，與 HostKeyAlias 相同，每台 Telepy 各自一個。/ Same as the HostKeyAlias; one per Telepy server.
    #[schema(example = "telepy-telepy.example.com-24242")]
    pub alias: String,
    /// 舊版共用的別名；安裝指令只在它確定屬於這台、又沒有區塊再用時拿掉。/ The old shared alias, cleaned up when safe.
    #[schema(example = "telepy-ssh-server")]
    pub legacy_alias: String,
    #[schema(example = "telepy.example.com")]
    pub host: String,
    /// REVERSE_SERVER_SSH_PORT（未設定時是空字串）。/ REVERSE_SERVER_SSH_PORT (empty string when unset).
    #[schema(example = "24242")]
    pub port: String,
}

#[derive(ToSchema)]
pub struct ConfigHost {
    #[schema(example = "my-pi")]
    pub alias: String,
    #[schema(example = "root")]
    pub username: String,
    pub username_id: i64,
}

#[derive(ToSchema)]
pub struct ScriptResponse {
    pub script: String,
    #[schema(example = "bash")]
    pub language: String,
}

#[derive(ToSchema)]
pub struct OneTimeTokenRequest {
    pub server_id: i64,
    pub ssh_port: i64,
    #[schema(example = "autossh")]
    pub script_type: String,
    pub key_path: Option<String>,
    pub username_id: Option<i64>,
    /// `ssh` (default, port 24242) or `websocket` (the tunnel rides inside a WebSocket on the web port; ssh, autossh and systemd scripts only)
    pub transport: Option<String>,
}

#[derive(ToSchema)]
pub struct OneTimeToken {
    pub token: String,
    pub url: String,
}

// ---------------------------------------------------------------- sharing

#[derive(ToSchema)]
pub struct ShareRequest {
    pub shared_with_user_id: i64,
    #[schema(example = "view")]
    pub permission_type: Option<String>,
    pub allowed_target_username_ids: Option<Vec<i64>>,
    /// 分享到什麼時候（RFC 3339 / `YYYY-MM-DD`）；不給 = 一直有效。/ When the share ends; omitted = never.
    pub expires_at: Option<String>,
}

#[derive(ToSchema)]
pub struct PermissionUpdateRequest {
    #[schema(example = "edit")]
    pub permission_type: String,
}

#[derive(ToSchema)]
pub struct PermissionUpdated {
    pub message: String,
    pub permission_type: String,
}

#[derive(ToSchema)]
pub struct AllowedUsername {
    pub id: i64,
    pub username: String,
    /// 存取申請給的暫時帳號：到什麼時候（UTC）；永久的是 null。/ Temporary (access request): when it ends; null = permanent.
    pub until: Option<String>,
}

#[derive(ToSchema)]
pub struct SharedUser {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub permission_type: String,
    pub shared_at: String,
    /// 分享到什麼時候（UTC）；null = 一直有效。/ When the share ends (UTC); null = never.
    pub expires_at: Option<String>,
    /// 存取申請暫時提升了權限：到什麼時候、之後回到哪個。/ A temporary raise: until when, and the permission after it.
    pub permission_until: Option<String>,
    pub base_permission: Option<String>,
    pub allowed_target_usernames: Vec<AllowedUsername>,
}

#[derive(ToSchema)]
pub struct SharedUsers {
    pub users: Vec<SharedUser>,
}

#[derive(ToSchema)]
pub struct AvailableUser {
    pub id: i64,
    pub username: String,
    pub email: String,
}

#[derive(ToSchema)]
pub struct AvailableUsers {
    pub users: Vec<AvailableUser>,
}

#[derive(ToSchema)]
pub struct AllowedUsernamesRequest {
    /// The only target users this sharee (VIEW / EDIT) may log in as; empty = none
    pub allowed_target_username_ids: Vec<i64>,
}

// ---------------------------------------------------------------- users / settings

#[derive(ToSchema)]
pub struct UserSettings {
    pub language: Option<String>,
    pub theme: String,
    pub terminal_font_size: i64,
    /// UI display scale in percent (85–130).
    pub ui_scale: i64,
    #[schema(example = "hack")]
    pub terminal_font: String,
    #[schema(example = "telepy")]
    pub terminal_scheme: String,
    /// face | bright | both
    #[schema(example = "face")]
    pub terminal_bold: String,
    pub terminal_ligatures: bool,
    /// Remote desktop clipboard direction this user picked: both | to_remote | off
    #[schema(example = "both")]
    pub desktop_clipboard: String,
    /// The site's ceiling for it (read-only; the narrower of the two applies)
    #[schema(example = "both")]
    pub desktop_clipboard_limit: String,
    /// Seconds a web terminal's shell is kept after its browser drops: 0 | 60 | 300 | 900 | 1800 | 3600 (0 = end at once)
    #[schema(example = 300)]
    pub terminal_detach_secs: i64,
    /// The site's ceiling for it (read-only; 0 = the feature is off)
    #[schema(example = 1800)]
    pub terminal_detach_max_secs: i64,
    /// Card or list view per page; pages missing here use their default
    #[schema(value_type = Object, example = json!({"tunnels": "list", "key_groups": "card"}))]
    pub view_modes: serde_json::Value,
    /// Remote desktop display preferences (scale, percent, resolution, width, height, hidpi, vnc_resize, quality,
    /// audio); null = never chosen on this account
    #[schema(value_type = Option<Object>, example = json!({"scale": "fit", "percent": 100, "resolution": "window", "width": 1920, "height": 1080, "hidpi": false, "vnc_resize": false, "quality": "auto", "audio": false}))]
    pub desktop_display: Option<serde_json::Value>,
    /// ~/.ssh/config 裡裝置別名的前綴（空 = 不加）。/ The device alias prefix in ~/.ssh/config (empty = none).
    #[schema(example = "work-")]
    pub ssh_alias_prefix: String,
    /// Tapi 的十字髮夾顏色（teal / sakura / lemon / grape / sky / cream / daily；空 = 還沒找到 Tapi）。
    /// Tapi's clip colour (teal / sakura / lemon / grape / sky / cream / daily; empty = Tapi not found yet).
    pub tapi_color: String,
    /// 「每天換一個」解鎖了沒。/ Whether "daily" is unlocked.
    pub tapi_daily: bool,
    /// keep = commands typed in Telepy's shells (web terminal, your agents' shells) go into the device's shell
    /// history as usual; skip = Telepy turns the history file off in each new shell (per-tunnel override:
    /// `/api/reverse/server/{id}/shell-history`)
    #[schema(example = "keep")]
    pub shell_history: String,
}

#[derive(ToSchema)]
pub struct UserSettingsPatch {
    #[schema(example = "auto")]
    pub language: Option<String>,
    #[schema(example = "dark")]
    pub theme: Option<String>,
    pub terminal_font_size: Option<i64>,
    #[schema(example = 100)]
    pub ui_scale: Option<i64>,
    /// 1-32 lowercase letters, digits or '-' (ids are defined by the frontend)
    #[schema(example = "jetbrains-mono")]
    pub terminal_font: Option<String>,
    #[schema(example = "solarized-dark")]
    pub terminal_scheme: Option<String>,
    /// face | bright | both
    #[schema(example = "bright")]
    pub terminal_bold: Option<String>,
    pub terminal_ligatures: Option<bool>,
    /// both | to_remote | off (capped by the site setting at connect time)
    #[schema(example = "to_remote")]
    pub desktop_clipboard: Option<String>,
    /// 0 | 60 | 300 | 900 | 1800 | 3600 (capped by the site setting and the tunnel's policy)
    #[schema(example = 300)]
    pub terminal_detach_secs: Option<i64>,
    /// Replaces the whole map: page id (lowercase letters, digits, `_`; up to 32) → `card` | `list`, at most 20
    #[schema(value_type = Option<Object>, example = json!({"tunnels": "list", "key_groups": "card"}))]
    pub view_modes: Option<serde_json::Value>,
    /// Replaces the whole object (missing fields = defaults; percent clamped to 25–400; anything else out of range is a
    /// field error); null clears it
    #[schema(value_type = Option<Object>)]
    pub desktop_display: Option<serde_json::Value>,
    /// 裝置別名前綴：英數字、`.`、`_`、`-`，最多 24 個，不以 `-` 開頭；空字串 = 不加。/ Device alias prefix; empty = none.
    pub ssh_alias_prefix: Option<String>,
    /// Tapi 的十字髮夾顏色；`daily` 要先解鎖（`tapi_daily`）；null / 空 = 回到沒解鎖。/ Tapi's clip colour; `daily` needs `tapi_daily`.
    pub tapi_color: Option<String>,
    /// 解鎖「每天換一個」（只能是 true）。/ Unlock "daily" (true only).
    pub tapi_daily: Option<bool>,
    /// keep | skip
    #[schema(example = "skip")]
    pub shell_history: Option<String>,
}

/// The caller's shell history choice for one tunnel
#[derive(ToSchema)]
pub struct ShellHistoryPref {
    pub tunnel_id: i64,
    /// keep | skip; null = follow the personal default
    #[schema(example = "skip")]
    pub mode: Option<String>,
    /// The personal default (`shell_history` in /api/user/settings): keep | skip
    #[schema(example = "keep")]
    pub default: String,
    /// What new shells on this tunnel get: keep | skip
    #[schema(example = "skip")]
    pub effective: String,
    /// Which one decided: default | tunnel
    #[schema(example = "tunnel")]
    pub source: String,
}

/// PUT body
#[derive(ToSchema)]
pub struct ShellHistoryPrefPatch {
    /// keep | skip; null = follow my default
    #[schema(example = "skip")]
    pub mode: Option<String>,
}

/// The caller's terminal appearance override for one tunnel; a null field follows the personal default
#[derive(ToSchema)]
pub struct TerminalProfile {
    pub tunnel_id: i64,
    #[schema(example = "fira-code")]
    pub font: Option<String>,
    /// 10-24
    pub font_size: Option<i64>,
    #[schema(example = "nord")]
    pub scheme: Option<String>,
    /// face | bright | both
    pub bold: Option<String>,
    pub ligatures: Option<bool>,
}

/// PUT body: a missing or null field means "follow my default"; every field null removes the override
#[derive(ToSchema)]
pub struct TerminalProfilePatch {
    pub font: Option<String>,
    pub font_size: Option<i64>,
    pub scheme: Option<String>,
    /// face | bright | both
    pub bold: Option<String>,
    pub ligatures: Option<bool>,
}

/// The colours of a custom terminal scheme: every value is `#rrggbb`; `cursorAccent` and `selectionForeground` are optional
#[derive(ToSchema)]
pub struct TerminalSchemeColors {
    #[schema(example = "#f0f0f0")]
    pub foreground: String,
    #[schema(example = "#000000")]
    pub background: String,
    pub cursor: String,
    /// The glyph under the cursor (defaults to the background in the frontend)
    pub cursor_accent: Option<String>,
    pub selection_background: String,
    pub selection_foreground: Option<String>,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

/// A custom terminal colour scheme (the caller's own; `id` is what `terminal_scheme` and per-tunnel overrides store)
#[derive(ToSchema)]
pub struct TerminalScheme {
    #[schema(example = "custom-1a2b3c4d")]
    pub id: String,
    #[schema(example = "Office dark")]
    pub name: String,
    pub colors: TerminalSchemeColors,
    pub created_at: String,
    pub updated_at: String,
}

/// POST body (keys of `colors` are camelCase: `selectionBackground`, `brightBlack`, …)
#[derive(ToSchema)]
pub struct TerminalSchemeBody {
    /// 1–40 characters
    pub name: String,
    pub colors: TerminalSchemeColors,
}

/// PATCH body: only the given fields change; `colors` replaces the whole set
#[derive(ToSchema)]
pub struct TerminalSchemePatch {
    pub name: Option<String>,
    pub colors: Option<TerminalSchemeColors>,
}

#[derive(ToSchema)]
pub struct ManagedUser {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub is_active: bool,
    pub is_superuser: bool,
    pub date_joined: String,
    pub last_login: Option<String>,
    pub language: Option<String>,
    pub mfa_enabled: bool,
    /// 這次更新停用了帳號時：切掉了什麼。/ Present when this update disabled the account: what was cut.
    pub disabled: Option<DisableImpact>,
}

/// 停用一個帳號切掉的東西（`GET …/disable-preview` = 預估；`POST /api/user/users/{id}` 停用時 = 實際）。
/// What disabling an account cuts (the preview's estimate, or what the update did).
#[derive(ToSchema)]
pub struct DisableImpact {
    /// 撤銷的網頁登入（瀏覽器）。/ Web sign-ins revoked.
    pub web_sessions: u64,
    /// 結束的進行中 session（含斷線保留中的終端機）。/ Live sessions ended, detached terminals included.
    pub live_sessions: u64,
    /// 關掉的 MCP agent session / 瀏覽器。/ MCP agent sessions / browsers closed.
    pub agent_sessions: u64,
    /// 暫停的個人 API token（重新啟用就恢復）。/ API tokens suspended (back on re-enable).
    pub api_tokens: u64,
    /// 暫停的已連接 app。/ Connected apps suspended.
    pub connected_apps: u64,
    /// Telepy 替他裝在裝置上的金鑰（移除；離線的裝置上線後才移除；手動加的不動）。/ Keys Telepy installed for them.
    pub device_keys: DisableDeviceKeys,
}

/// 停用帳號時從裝置移除的金鑰。/ The keys disabling an account removes from devices.
#[derive(ToSchema)]
pub struct DisableDeviceKeys {
    /// 有 Telepy 替他裝過金鑰的裝置數。/ Devices holding keys Telepy installed for them.
    pub devices: u64,
    /// （裝置, 帳號）組數。/ (device, login account) pairs.
    pub accounts: u64,
    /// 其中離線、上線後才移除的裝置數。/ Of those, devices offline now (cleaned when they reconnect).
    pub offline_devices: u64,
}

#[derive(ToSchema)]
pub struct ManagedUsers {
    pub users: Vec<ManagedUser>,
}

#[derive(ToSchema)]
pub struct ManagedUserUpdate {
    pub is_active: Option<bool>,
    pub is_superuser: Option<bool>,
    pub language: Option<String>,
}

#[derive(ToSchema)]
pub struct SiteSettingsResponse {
    /// Current values keyed by setting name (empty for non-admins)
    #[schema(value_type = Object)]
    pub values: serde_json::Value,
    /// `{field: {label, description, type}}`（`choice` 另有 `choices`）/ `choice` fields also carry `choices`
    #[schema(value_type = Object)]
    pub meta: serde_json::Value,
    /// 可被環境變數蓋過的鍵 → `{var, set, value}`；`set` = 環境變數有設（它說了算，欄位鎖住），`value` = 它的值（沒設 = null）。
    /// `values` 是存的值；生效的值 = `set` 時的 `value`，否則 `values`。
    /// Env-backed keys → `{var, set, value}`: `set` = the variable is present and non-blank (it wins; the field is
    /// locked), `value` = its value (null when unset). `values` holds the saved value; in effect = `value` when `set`.
    #[schema(value_type = Object, example = json!({"client_ip_hops": {"var": "TRUSTED_PROXY_HOPS", "set": true, "value": "auto"}, "server_public_url": {"var": "PUBLIC_URL", "set": false, "value": null}}))]
    pub env: serde_json::Value,
}

// ---------------------------------------------------------------- logs / sftp / remote browser

#[derive(ToSchema)]
pub struct GatewayEvent {
    pub id: i64,
    pub at: String,
    #[schema(example = "accepted")]
    pub event: String,
    pub peer: Option<String>,
    pub port: Option<i64>,
    pub tunnel_id: Option<i64>,
    /// 隧道還在時的名稱。/ The tunnel's name while it exists.
    pub tunnel_name: Option<String>,
    pub message: String,
}

#[derive(ToSchema)]
#[schema(description = "A tunnel and its owner, for the admin section's filters")]
pub struct AdminTunnel {
    pub id: i64,
    pub name: String,
    pub reverse_port: i64,
    pub owner: AdminTunnelOwner,
}

#[derive(ToSchema)]
pub struct AdminTunnelOwner {
    pub id: i64,
    pub username: Option<String>,
}

#[derive(ToSchema)]
#[schema(description = "Hash-chain verification of one audit table")]
pub struct AuditTableReport {
    #[schema(example = "telepy_gateway_event")]
    pub table: String,
    pub ok: bool,
    /// Hashed rows walked
    pub checked: i64,
    pub first_id: Option<i64>,
    pub last_id: Option<i64>,
    /// Rows written before the chain existed (NULL hash), not counted as breaks
    pub unhashed_before: i64,
    /// First row id where the chain or an outside checkpoint does not match
    pub broken_at: Option<i64>,
    /// hash_mismatch | link_mismatch | missing_hash | checkpoint_mismatch | checkpoint_missing
    #[schema(example = "hash_mismatch")]
    pub reason: Option<String>,
    /// Lines of audit-anchors.log for rows that are still present (or should be)
    pub checkpoints_checked: i64,
    pub checkpoints_mismatched: i64,
    /// The chain's own first issue (hash_mismatch | link_mismatch | missing_hash)
    pub chain_broken_at: Option<i64>,
    pub chain_reason: Option<String>,
    /// Rows that break the chain
    pub chain_issues: i64,
    /// First mismatch with audit-anchors.log (checkpoint_mismatch | checkpoint_missing)
    pub checkpoint_broken_at: Option<i64>,
    pub checkpoint_reason: Option<String>,
    /// Lines of audit-anchors.log written by another database (restored / replaced), not compared
    pub checkpoints_foreign: i64,
    /// Lines of audit-anchors.log set aside by a re-seal, not compared
    pub checkpoints_retired: i64,
    /// The table's latest re-seal
    pub last_reseal: Option<AuditReseal>,
}

/// 審計鏈的一次重新封存（一張表）。/ One table of one re-seal of the audit chain.
#[derive(ToSchema)]
pub struct AuditReseal {
    /// Shared by the tables re-sealed together; the matching line in audit-anchors.log carries it as `reseal`
    #[schema(example = "9c1f0a3b5e7d2468")]
    pub reseal_id: String,
    #[schema(example = "2026-10-30T01:02:03Z")]
    pub at: String,
    #[schema(example = "telepy_gateway_event")]
    pub table: String,
    /// The chain head afterwards (0 = no hashed rows)
    pub row_id: i64,
    /// Rows whose prev_hash / hash were rewritten, and the first one
    pub rehashed: i64,
    pub from_row: Option<i64>,
    /// audit-anchors.log lines set aside
    pub retired: i64,
    /// The problem it covered, in the doctor's words
    #[schema(example = "telepy_gateway_event: checkpoint at row 58 (checkpoint_mismatch)")]
    pub problem: String,
    pub user_id: Option<i64>,
    #[schema(example = "admin")]
    pub username: String,
    pub note: String,
}

/// 一張表的驗證結果加上重新封存的試算。/ One table's verification plus what re-sealing would do.
#[derive(ToSchema)]
pub struct AuditResealTable {
    #[schema(inline)]
    #[serde(flatten)]
    pub report: AuditTableReport,
    /// The doctor's words for a failing table, null when intact
    pub problem: Option<String>,
    /// Rows re-sealing would re-hash, and the first one
    pub rehash: i64,
    pub from_row: Option<i64>,
    /// audit-anchors.log lines re-sealing would set aside
    pub retire: i64,
}

/// `GET /api/site/health/audit`：審計鏈現況與重新封存的試算（管理員）。/ The audit log now and the re-seal dry run.
#[derive(ToSchema)]
pub struct AuditResealPlan {
    /// The audit-log check's status: ok / warn (cannot verify) / fail
    #[schema(example = "fail")]
    pub status: String,
    /// Send it back to re-seal; a different one now = 409 `changed`
    pub fingerprint: String,
    pub detail: String,
    /// Only a failing audit log can be re-sealed
    pub can_reseal: bool,
    /// Empty when verification itself failed
    pub tables: Vec<AuditResealTable>,
    /// Earlier re-seals, newest first (at most 1000 records, one per table)
    pub reseals: Vec<AuditReseal>,
    /// Whether this server writes audit-anchors.log
    pub anchors_file: bool,
}

/// `POST /api/site/health/audit/reseal`：重新封存審計鏈。/ Re-seal the audit chain.
#[derive(ToSchema)]
pub struct AuditResealBody {
    /// The audit-log fingerprint the page showed
    pub fingerprint: String,
    /// 1–500 characters, trimmed: what happened
    pub note: String,
    /// Re-authentication proof, required once the account has a second factor
    pub reauth: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct AuditVerifyReport {
    pub ok: bool,
    pub tables: Vec<AuditTableReport>,
}

#[derive(ToSchema)]
pub struct SftpShell {
    #[schema(example = "unix")]
    pub shell: String,
}

#[derive(ToSchema)]
pub struct SftpEntry {
    #[schema(example = "file")]
    pub r#type: String,
    #[schema(value_type = Object)]
    pub permissions: serde_json::Value,
    pub links: String,
    pub owner: String,
    pub group: String,
    pub size: String,
    pub date: String,
    pub name: String,
}

#[derive(ToSchema)]
pub struct SftpListing {
    pub shell: String,
    pub total: i64,
    pub path: String,
    pub files: Vec<SftpEntry>,
}

#[derive(ToSchema)]
pub struct UploadForm {
    #[schema(value_type = String, format = Binary)]
    pub file: Vec<u8>,
}

#[derive(ToSchema)]
pub struct UploadResult {
    pub success: String,
}

/// `{error, code}`；code = path_required | invalid_name | exists | not_found | permission_denied | dir_not_writable |
/// protected | into_itself | invalid_mode | is_directory | too_large | binary | not_utf8 | modified | timeout | device | failed
#[derive(ToSchema)]
pub struct SftpError {
    pub error: String,
    #[schema(example = "exists")]
    pub code: String,
}

#[derive(ToSchema)]
pub struct SftpPathRequest {
    /// Full path of the new folder / file (`~/x`, `/abs/x`, `C:\x`)
    pub path: String,
}

#[derive(ToSchema)]
pub struct SftpPathResult {
    pub path: String,
}

#[derive(ToSchema)]
pub struct SftpPathsRequest {
    /// 1–500 paths
    pub paths: Vec<String>,
}

/// A rename (`from` + `to`) or a move of several entries into `destination` (`paths` + `destination`). Never overwrites.
#[derive(ToSchema)]
pub struct SftpRenameRequest {
    pub from: Option<String>,
    pub to: Option<String>,
    pub paths: Option<Vec<String>>,
    pub destination: Option<String>,
}

#[derive(ToSchema)]
pub struct SftpMoveRequest {
    pub paths: Vec<String>,
    /// Folder the entries go into (they keep their names)
    pub destination: String,
}

#[derive(ToSchema)]
pub struct SftpChmodRequest {
    pub paths: Vec<String>,
    /// Octal, e.g. `644` / `0755`
    #[schema(example = "0644")]
    pub mode: String,
    /// Folders: everything inside too (links skipped)
    pub recursive: Option<bool>,
}

#[derive(ToSchema)]
pub struct SftpFailure {
    pub path: String,
    pub code: String,
    pub error: String,
}

/// Counters present depend on the call: moved / copied (+ method `device` | `stream`) / changed (+ mode).
#[derive(ToSchema)]
pub struct SftpBatchResult {
    pub path: Option<String>,
    pub moved: Option<u64>,
    pub copied: Option<u64>,
    pub changed: Option<u64>,
    pub method: Option<String>,
    pub mode: Option<String>,
    pub destination: Option<String>,
    pub failed: Vec<SftpFailure>,
}

/// Dry run (`?count=1`): files / dirs / links / bytes / entries / truncated; otherwise removed + failed.
#[derive(ToSchema)]
pub struct SftpDeleteResult {
    pub files: Option<u64>,
    pub dirs: Option<u64>,
    pub links: Option<u64>,
    pub bytes: Option<u64>,
    pub entries: Option<u64>,
    pub truncated: Option<bool>,
    pub removed: Option<u64>,
    pub failed: Option<Vec<SftpFailure>>,
}

#[derive(ToSchema)]
pub struct SftpStat {
    pub path: String,
    pub name: String,
    /// file | directory | symlink
    pub r#type: String,
    pub size: u64,
    #[schema(example = "0644")]
    pub mode: String,
    #[schema(example = "-rw-r--r--")]
    pub permissions: String,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub mtime: Option<String>,
    pub mtime_epoch: Option<u32>,
    pub atime: Option<String>,
    pub link_target: Option<String>,
    /// file | directory | missing (links only)
    pub target_type: Option<String>,
}

/// A text file: GET returns `content`; PUT returns the saved file's size / mtime_epoch / mode.
#[derive(ToSchema)]
pub struct SftpText {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime_epoch: Option<u32>,
    pub mode: String,
    pub content: Option<String>,
}

#[derive(ToSchema)]
pub struct SftpSaveRequest {
    pub path: String,
    /// UTF-8 text, ≤ 1 MiB
    pub content: String,
    /// mtime_epoch / size from when the file was opened; a mismatch answers 409 `modified`
    pub mtime: Option<u64>,
    pub size: Option<u64>,
    /// Overwrite even when the file changed meanwhile
    pub force: Option<bool>,
}

#[derive(ToSchema)]
pub struct RemoteBrowserStartRequest {
    /// Target username; omitted = the tunnel's default (or first allowed) username
    pub username: Option<String>,
    /// Optional id chosen by the caller (letters, digits, `-`, ≤ 64). With it, each start step is pushed to the caller as a `REMOTE-BROWSER-PROGRESS` notification `{tunnel_id, progress_id, step: proxy|browser, state: active|done|failed, attempt?, attempts?, secs?, reason?}`
    pub progress_id: Option<String>,
}

#[derive(ToSchema)]
pub struct RemoteBrowserSession {
    pub session_id: String,
    #[schema(example = "/ws/remote-browser/<session_id>/")]
    pub ws_path: String,
}

#[derive(ToSchema)]
pub struct RemoteBrowserError {
    pub error: String,
    #[schema(example = "device_offline")]
    pub code: Option<String>,
}

// ---------------------------------------------------------------- Device host key pinning

#[derive(ToSchema)]
pub struct DeviceHostKey {
    #[schema(example = "ssh-ed25519")]
    pub key_type: String,
    #[schema(example = "SHA256:…")]
    pub fingerprint: String,
    /// `type base64`
    pub public_key: String,
    /// first_use | join (sent by the install script) | accepted
    pub source: String,
    /// Connections that presented this key (rejected keys)
    pub attempts: i64,
    pub first_seen: String,
    pub last_seen: String,
}

#[derive(ToSchema)]
pub struct DeviceHostKeys {
    /// Keys Telepy trusts for this device (pinned on first use, sent by the install script, or confirmed by the owner)
    pub pinned: Vec<DeviceHostKey>,
    /// Different keys the device presented since; connections were refused
    pub rejected: Vec<DeviceHostKey>,
    /// Owner or ADMIN sharee: may accept or forget
    pub can_manage: bool,
    /// Other tunnels of yours that trust the same host key, i.e. the same machine (only those you can see)
    pub same_machine: Vec<SameMachineTunnel>,
    /// The last connection refused because the machine's host key is pinned by another account's tunnel (null = none)
    pub refused_claim: Option<RefusedClaim>,
}

#[derive(ToSchema)]
pub struct SameMachineTunnel {
    pub id: i64,
    pub name: String,
}

#[derive(ToSchema)]
pub struct RefusedClaim {
    pub key_type: String,
    pub fingerprint: String,
    pub at: String,
}

#[derive(ToSchema)]
pub struct HostKeyAccept {
    /// Fingerprint of the refused key to trust
    pub fingerprint: String,
}

// ---------------------------------------------------------------- Credential vault

#[derive(ToSchema)]
pub struct SavedCredential {
    pub id: i64,
    pub label: String,
    /// rdp | vnc
    pub protocol: String,
    pub tunnel_id: i64,
    pub tunnel_name: Option<String>,
    /// null = the device itself
    pub lan_host_id: Option<i64>,
    pub lan_host: Option<String>,
    pub port: Option<i64>,
    pub login: String,
    pub domain: String,
    /// The password itself is never returned
    pub has_password: bool,
    /// `ssh` rows only: a private key is stored (never returned)
    pub has_key: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(ToSchema)]
pub struct SavedCredentialCreate {
    pub label: String,
    /// `rdp`, `vnc`, `rustdesk`, or `ssh` (a LAN host's SSH login for the web terminal's hop)
    pub protocol: String,
    pub tunnel_id: i64,
    pub lan_host_id: Option<i64>,
    pub port: Option<u16>,
    pub login: Option<String>,
    pub domain: Option<String>,
    /// Required for rdp / vnc / rustdesk; for `ssh` a password and / or `private_key`
    pub password: Option<String>,
    /// `ssh` only: an unencrypted private key (OpenSSH or PEM); keys with a passphrase are refused
    pub private_key: Option<String>,
}

#[derive(ToSchema)]
pub struct SavedCredentialUpdate {
    pub label: Option<String>,
    pub port: Option<u16>,
    pub login: Option<String>,
    pub domain: Option<String>,
    /// Leave out to keep the current password (`ssh`: an empty string removes it)
    pub password: Option<String>,
    /// `ssh` only: replace the private key (an empty string removes it)
    pub private_key: Option<String>,
}

// ---------------------------------------------------------------- Remote desktop (RDP / VNC over guacd)

#[derive(ToSchema)]
pub struct DesktopStartRequest {
    /// `rdp` or `vnc`
    #[schema(example = "rdp")]
    pub protocol: String,
    /// Device account for the SSH hop; omitted = the tunnel's default (or only) allowed username
    pub username: Option<String>,
    /// A LAN host of this tunnel (see `/lan/hosts`); omitted = the device itself
    pub lan_host_id: Option<i64>,
    /// Desktop port on the target; default 3389 (RDP) / 5900 (VNC)
    pub port: Option<u16>,
    /// Desktop login (the RDP user, or the VNC username where the server uses one); memory only
    pub login: Option<String>,
    /// Desktop password; memory only, dropped after the guacd handshake
    pub password: Option<String>,
    /// Quality preset: auto (default) | speed (16-bit colour, more compression) | sharp (24-bit, lossless only)
    pub quality: Option<String>,
    /// RDP domain
    pub domain: Option<String>,
    /// Use a saved login from the credential vault instead of login / password / domain
    pub credential_id: Option<i64>,
    /// Clipboard direction: both | to_remote | off; omitted = the user's `desktop_clipboard` setting. Capped by the
    /// site setting `desktop_clipboard`
    #[schema(example = "to_remote")]
    pub clipboard: Option<String>,
    /// Play the remote's sound (RDP only; ignored for VNC). Default false: audio costs bandwidth
    pub audio: Option<bool>,
    /// Let the remote resolution follow the browser's frame (the browser sends `size`, clamped to
    /// `desktop_max_resolution`). Omitted = true for RDP (resize-method display-update), false for VNC (only
    /// servers with SetDesktopSize, e.g. TigerVNC / KasmVNC virtual desktops, follow; otherwise `disable-display-resize`)
    pub resize: Option<bool>,
}

#[derive(ToSchema)]
pub struct DesktopTarget {
    /// As seen from the device: `127.0.0.1` for the device itself
    pub host: String,
    pub port: u16,
    pub label: String,
    pub lan_host_id: Option<i64>,
}

#[derive(ToSchema)]
pub struct DesktopSession {
    pub session_id: String,
    #[schema(example = "/ws/desktop/<session_id>/")]
    pub ws_path: String,
    /// One-time ticket, passed as `?ticket=` when opening ws_path (subprotocol `guacamole`)
    pub ticket: String,
    /// Seconds the ticket stays valid
    pub expires_in: u64,
    pub protocol: String,
    /// Clipboard direction in effect (the request or the user's setting, capped by the site): both | to_remote | off
    pub clipboard: String,
    /// The site's ceiling (`desktop_clipboard`), so the page can say when it narrowed the choice
    pub clipboard_limit: String,
    /// Quality preset in effect: auto | speed | sharp
    pub quality: String,
    /// Remote sound in effect (RDP only; offered to guacd as audio/L8 + audio/L16, otherwise `disable-audio`)
    pub audio: bool,
    /// Whether the remote resolution follows the browser's frame (see the request's `resize`)
    pub resize: bool,
    /// The site's ceiling (`desktop_max_resolution`) for the longer side; larger sizes are scaled down keeping the shape
    pub max_resolution: i64,
    pub target: DesktopTarget,
    /// The device account used for the hop
    pub username: String,
}

#[derive(ToSchema)]
pub struct DesktopScreen {
    /// Monitor name as the device reports it (`eDP-1`, `Color LCD`, `DISPLAY1`)
    pub name: String,
    /// Position in the device's combined framebuffer; null when the OS does not report it (macOS)
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(ToSchema)]
pub struct RustDeskStartRequest {
    /// Device account for the SSH hop; omitted = the tunnel's default (or only) allowed username
    pub username: Option<String>,
    /// A LAN host of this tunnel; omitted = the device itself
    pub lan_host_id: Option<i64>,
    /// RustDesk's Direct IP Access port on the target; default 21118
    pub port: Option<u16>,
    /// A saved login of yours (protocol `rustdesk`, same tunnel and LAN host): its password comes back in `password`
    pub credential_id: Option<i64>,
    /// Clipboard direction: both | to_remote | off; omitted = the user's setting; capped by the site
    pub clipboard: Option<String>,
}

/// An in-browser RustDesk session. The browser's RustDesk core connects to `ws_path` twice with `?ticket=`:
/// first as its ID server (it sends a punch-hole request and gets a relay response), then as its relay (it
/// sends a relay request and the socket becomes the peer stream, bridged to the device's Direct IP port).
/// The RustDesk password is handled by the core in the browser and never sent to Telepy.
#[derive(ToSchema)]
pub struct RustDeskSession {
    pub session_id: String,
    #[schema(example = "/ws/rustdesk/<session_id>/")]
    pub ws_path: String,
    /// One-time-per-role ticket, passed as `?ticket=`
    pub ticket: String,
    /// Seconds the ticket stays valid
    pub expires_in: u64,
    pub target: DesktopTarget,
    /// The device account used for the hop
    pub username: String,
    /// Only with `credential_id`: the saved RustDesk password, unsealed for this start and handed to the browser's core
    /// for the hash challenge (the backend cannot answer it itself). Never logged.
    pub password: Option<String>,
    /// Clipboard direction the browser's core applies (Telepy cannot read the RustDesk stream): both | to_remote | off
    pub clipboard: String,
    /// The site's ceiling (`desktop_clipboard`)
    pub clipboard_limit: String,
    /// The site allows file transfer (`desktop_file_transfer`): the page shows the Files panel
    pub file_transfer: bool,
}

/// A file-transfer child of a connected in-browser RustDesk session (RustDesk transfers files on a second
/// connection that logs in for file transfer). Same target and device account; the relay admits only a
/// file-transfer login on it. It ends with its screen session and takes no desktop slot.
#[derive(ToSchema)]
pub struct RustDeskFilesSession {
    pub session_id: String,
    /// The screen session it belongs to
    pub parent: String,
    #[schema(example = "/ws/rustdesk/<session_id>/")]
    pub ws_path: String,
    pub ticket: String,
    pub expires_in: u64,
    pub target: DesktopTarget,
    pub username: String,
}

/// A port on the target answered a TCP connection opened from the device (the same path a desktop session
/// takes). Used for desktops Telepy forwards instead of rendering, such as RustDesk's Direct IP port.
#[derive(ToSchema)]
pub struct DesktopProbe {
    pub reachable: bool,
    pub target: DesktopTarget,
    /// The device account the channel was opened as
    pub username: String,
}

/// The device's monitor layout, asked over SSH (`xrandr`, `system_profiler`, PowerShell). Used by the
/// VNC viewer to show one screen of a multi-monitor desktop.
#[derive(ToSchema)]
pub struct DesktopScreens {
    /// darwin | linux | windows | unknown
    pub os: String,
    /// xrandr | system_profiler | powershell; null when nothing answered
    pub source: Option<String>,
    pub screens: Vec<DesktopScreen>,
    /// The device account the commands ran as
    pub username: String,
}

#[derive(ToSchema)]
pub struct DesktopError {
    pub error: String,
    #[schema(example = "device_offline")]
    pub code: String,
}

// ---------------------------------------------------------------- OAuth 2.1 (MCP connectors)

#[derive(ToSchema)]
#[schema(description = "OAuth error (RFC 6749 §5.2); the consent endpoints add `redirect_to` when the error may be returned to the client")]
pub struct OAuthErrorBody {
    #[schema(example = "invalid_grant")]
    pub error: String,
    pub error_description: Option<String>,
    pub redirect_to: Option<String>,
}

#[derive(ToSchema)]
pub struct OAuthServerMetadata {
    #[schema(example = "https://telepy.example.com")]
    pub issuer: String,
    #[schema(example = "https://telepy.example.com/oauth/authorize")]
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: String,
    pub revocation_endpoint: String,
    pub scopes_supported: Vec<String>,
    pub response_types_supported: Vec<String>,
    pub grant_types_supported: Vec<String>,
    pub token_endpoint_auth_methods_supported: Vec<String>,
    pub code_challenge_methods_supported: Vec<String>,
    /// Telepy extension: where `telepy login` sends the browser once it has its token (`?client_id=&result=ok|denied|failed[&reason=]`)
    #[schema(example = "https://telepy.example.com/oauth/done")]
    pub telepy_cli_done_page: String,
}

#[derive(ToSchema)]
pub struct ProtectedResourceMetadata {
    #[schema(example = "https://telepy.example.com/mcp")]
    pub resource: String,
    pub authorization_servers: Vec<String>,
    pub scopes_supported: Vec<String>,
    pub bearer_methods_supported: Vec<String>,
    pub resource_name: String,
}

#[derive(ToSchema)]
pub struct ClientRegistrationRequest {
    #[schema(example = json!(["http://localhost:33418/callback"]))]
    pub redirect_uris: Vec<String>,
    pub client_name: Option<String>,
    /// `none` (public client, PKCE only), `client_secret_post` or `client_secret_basic` (default)
    #[schema(example = "none")]
    pub token_endpoint_auth_method: Option<String>,
    pub grant_types: Option<Vec<String>>,
    pub response_types: Option<Vec<String>>,
    pub scope: Option<String>,
    pub client_uri: Option<String>,
    pub logo_uri: Option<String>,
}

#[derive(ToSchema)]
pub struct ClientRegistrationResponse {
    pub client_id: String,
    /// Only for confidential clients; shown once
    pub client_secret: Option<String>,
    pub client_id_issued_at: i64,
    pub client_secret_expires_at: Option<i64>,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub grant_types: Vec<String>,
    pub response_types: Vec<String>,
    pub token_endpoint_auth_method: String,
}

#[derive(ToSchema)]
pub struct OAuthScope {
    #[schema(example = "ssh:exec")]
    pub name: String,
    pub description: String,
}

#[derive(ToSchema)]
pub struct OAuthClientInfo {
    pub client_id: String,
    pub client_name: String,
    pub client_uri: Option<String>,
    pub logo_uri: Option<String>,
}

#[derive(ToSchema)]
pub struct OAuthTunnelChoice {
    pub id: i64,
    pub name: String,
    #[schema(example = "owner")]
    pub permission: Option<String>,
}

#[derive(ToSchema)]
pub struct AuthorizeInfo {
    pub client: OAuthClientInfo,
    pub redirect_uri: String,
    #[schema(example = "localhost:33418")]
    pub redirect_host: String,
    pub scopes: Vec<OAuthScope>,
    /// Tunnels the user can restrict the grant to
    pub tunnels: Vec<OAuthTunnelChoice>,
    #[schema(value_type = Object)]
    pub user: serde_json::Value,
    /// `{required, methods}`: accounts with a passkey or an authenticator app confirm the approval
    #[schema(value_type = Object)]
    pub reauth: serde_json::Value,
    /// The user's active grants for this same app — this client, or the `telepy` CLI on the same computer (it registers
    /// anew on every sign-in); `replace` on the decision revokes them
    pub existing: Vec<OAuthExistingGrant>,
    /// The `telepy` CLI asking: `{host, signed_in, limit}` — at most `limit` CLI sign-ins are kept, the least recently
    /// used one is signed out when a new one exceeds it. null for any other app
    #[schema(value_type = Option<Object>)]
    pub cli: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct OAuthExistingGrant {
    pub id: i64,
    pub scopes: Vec<String>,
    #[schema(example = "2026-10-20T09:15:00.000000+08:00")]
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// Public preview of an authorization request, shown on the OAuth sign-in page before a login
#[derive(ToSchema)]
pub struct AuthorizePreview {
    pub client: OAuthClientInfo,
    #[schema(example = "localhost:33418")]
    pub redirect_host: String,
    pub scopes: Vec<OAuthScope>,
    /// Where "Cancel" sends the browser: the client's redirect URI with `error=access_denied`
    pub cancel_to: String,
}

#[derive(ToSchema)]
pub struct AuthorizeDecision {
    pub response_type: String,
    pub client_id: String,
    pub redirect_uri: Option<String>,
    pub code_challenge: String,
    pub code_challenge_method: String,
    pub scope: Option<String>,
    pub state: Option<String>,
    pub resource: Option<String>,
    /// false = deny (the client gets error=access_denied)
    pub approve: bool,
    /// Scopes the user kept; omitted = every requested scope
    pub scopes: Option<Vec<String>>,
    /// null = every tunnel the user can see; an array restricts the grant to those tunnels
    pub tunnel_ids: Option<Vec<i64>>,
    /// Required (when approving) for accounts with a second factor
    pub reauth: Option<MfaProof>,
    /// Revoke the user's earlier grants for this client once the new code is redeemed (default false)
    pub replace: Option<bool>,
}

#[derive(ToSchema)]
pub struct AuthorizeRedirect {
    #[schema(example = "http://localhost:33418/callback?code=…&state=…&iss=https%3A%2F%2Ftelepy.example.com")]
    pub redirect_to: String,
}

#[derive(ToSchema)]
pub struct TokenRequest {
    #[schema(example = "authorization_code")]
    pub grant_type: String,
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub code_verifier: Option<String>,
    pub refresh_token: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    /// Optional narrower scope (refresh_token grant)
    pub scope: Option<String>,
    pub resource: Option<String>,
}

#[derive(ToSchema)]
pub struct TokenResponse {
    /// JWT for `Authorization: Bearer` on /mcp (1 hour); not accepted by the REST API
    pub access_token: String,
    #[schema(example = "Bearer")]
    pub token_type: String,
    #[schema(example = 3600)]
    pub expires_in: i64,
    /// Rotated on every refresh (30 days)
    #[schema(example = "tpr_…")]
    pub refresh_token: String,
    #[schema(example = "tunnels:read ssh:exec ssh:files")]
    pub scope: String,
}

#[derive(ToSchema)]
pub struct RevokeRequest {
    pub token: String,
    pub token_type_hint: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

#[derive(ToSchema)]
pub struct OAuthGrantTunnel {
    pub id: i64,
    pub name: String,
}

#[derive(ToSchema)]
pub struct OAuthGrant {
    pub id: i64,
    /// `cli` = a browser sign-in of the `telepy` CLI (`telepy login`; shown on the API page), `app` = an MCP app.
    /// Told apart by the registered name `telepy CLI (<host>)`, which is self-declared: labels only, no permissions
    #[schema(example = "app")]
    pub kind: String,
    /// The computer a CLI sign-in came from (may be empty); null for apps
    pub cli_host: Option<String>,
    pub client_id: String,
    pub client_name: String,
    pub client_uri: Option<String>,
    pub scopes: Vec<String>,
    /// null = every tunnel
    pub tunnels: Option<Vec<OAuthGrantTunnel>>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    /// When the refresh token expires without further use
    pub expires_at: Option<String>,
    /// CLI sign-ins only: their REST requests in the API call log, summarised like a token's
    pub calls: Option<ApiCallSummary>,
}

#[derive(ToSchema)]
pub struct OAuthGrantClient {
    pub redirect_uris: Vec<String>,
    /// Hosts the app sends you back to (registration is open, so the name alone proves nothing)
    pub redirect_hosts: Vec<String>,
    pub logo_uri: Option<String>,
    /// Public client (PKCE only, no secret)
    pub public: bool,
    pub registered_at: String,
}

#[derive(ToSchema)]
pub struct OAuthGrantStats {
    pub calls: i64,
    pub failed: i64,
    pub last_call_at: Option<String>,
}

#[derive(ToSchema)]
pub struct OAuthGrantDetail {
    pub id: i64,
    pub client_id: String,
    pub client_name: String,
    pub client_uri: Option<String>,
    pub scopes: Vec<String>,
    /// null = every tunnel
    pub tunnels: Option<Vec<OAuthGrantTunnel>>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub expires_at: Option<String>,
    /// Who authorized it (admins can open other users' grants)
    pub user: AiUserRef,
    pub client: OAuthGrantClient,
    /// Open AI sessions of this app
    pub sessions: Vec<AiSession>,
    pub stats: OAuthGrantStats,
    /// The latest tool calls, newest first
    pub activity: Vec<AiActivity>,
}

// ---------------------------------------------------------------- AI sessions (MCP)

#[derive(ToSchema)]
pub struct AiUserRef {
    pub id: i64,
    pub username: Option<String>,
}

#[derive(ToSchema)]
pub struct AiTunnelRef {
    pub id: i64,
    pub name: Option<String>,
}

#[derive(ToSchema)]
pub struct AiSession {
    #[schema(example = "ais_3f2a…")]
    pub id: String,
    pub user: AiUserRef,
    pub client_name: String,
    /// The OAuth grant (connected app) that opened it; null for an API token
    pub grant_id: Option<i64>,
    /// The personal API token that opened it; null for a connected app
    pub token_id: Option<i64>,
    pub tunnel: AiTunnelRef,
    /// Target username on the device
    pub username: String,
    pub created_at: String,
    pub last_used_at: String,
    /// End of the maximum lifetime (it may close earlier when idle)
    pub expires_at: String,
    pub idle_timeout_s: i64,
    pub commands: i64,
    /// Interactive shells open on this session
    pub shells: i64,
    /// A command or file transfer is running
    pub busy: bool,
}

#[derive(ToSchema)]
pub struct AiActivity {
    pub id: i64,
    pub at: String,
    pub user: AiUserRef,
    pub client_name: String,
    #[schema(example = "ssh_exec")]
    pub tool: String,
    pub tunnel: Option<AiTunnelRef>,
    pub session_id: Option<String>,
    pub target_username: Option<String>,
    /// Command, path or close reason
    pub detail: Option<String>,
    pub ok: bool,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bytes_out: Option<i64>,
    pub error: Option<String>,
    /// MCP 請求的來源 IP（AI app 的出口）。/ The MCP client's address.
    #[schema(example = "203.0.113.40")]
    pub ip: Option<String>,
}

// ---------------------------------------------------------------- two-factor

#[derive(ToSchema)]
#[schema(description = "Two-factor error: {error, code}; code is mfa_expired, mfa_invalid, mfa_locked, reauth_required (with methods), passkey_failed or passkey_unavailable")]
pub struct MfaError {
    pub error: String,
    #[schema(example = "reauth_required")]
    pub code: String,
    pub methods: Option<Vec<String>>,
}

#[derive(ToSchema)]
pub struct MfaTokenRequest {
    pub mfa_token: String,
}

#[derive(ToSchema)]
#[schema(description = "A second-factor proof: {method: totp|recovery_code, code} or {method: passkey, challenge_id, credential}")]
pub struct MfaProof {
    #[schema(example = "totp")]
    pub method: String,
    pub code: Option<String>,
    pub challenge_id: Option<String>,
    /// PublicKeyCredential JSON from navigator.credentials.get()
    #[schema(value_type = Option<Object>)]
    pub credential: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct MfaVerifyRequest {
    pub mfa_token: String,
    #[schema(example = "totp")]
    pub method: String,
    pub code: Option<String>,
    pub challenge_id: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub credential: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct ReauthRequest {
    /// Required when the account already has a second factor
    pub reauth: Option<MfaProof>,
}

/// 15 分鐘、只屬於這個瀏覽器的 step-up token。/ A 15-minute, browser-bound step-up token.
#[derive(ToSchema)]
pub struct StepUpGrant {
    #[schema(example = "tps_9f2c…")]
    pub token: String,
    pub until: String,
    pub window_secs: i64,
}

/// 開關隧道的 step-up；關掉要 `reauth`。/ Turn a tunnel's step-up on or off; turning it off needs `reauth`.
#[derive(ToSchema)]
pub struct StepUpSetting {
    pub required: bool,
    pub reauth: Option<MfaProof>,
}

#[derive(ToSchema)]
pub struct PasskeyOptions {
    pub challenge_id: String,
    /// PublicKeyCredentialCreationOptions / RequestOptions (JSON, base64url binary fields) for the browser
    #[serde(rename = "publicKey")]
    #[schema(value_type = Object)]
    pub public_key: serde_json::Value,
    #[schema(example = "conditional")]
    pub mediation: Option<String>,
}

#[derive(ToSchema)]
pub struct PasskeyCredentialRequest {
    pub challenge_id: String,
    #[schema(value_type = Object)]
    pub credential: serde_json::Value,
}

#[derive(ToSchema)]
pub struct PasskeyRegisterRequest {
    pub challenge_id: String,
    #[schema(example = "MacBook Touch ID")]
    pub name: Option<String>,
    /// PublicKeyCredential JSON from navigator.credentials.create()
    #[schema(value_type = Object)]
    pub credential: serde_json::Value,
}

#[derive(ToSchema)]
pub struct PasskeyInfo {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(ToSchema)]
pub struct PasskeyRename {
    pub name: String,
}

#[derive(ToSchema)]
pub struct PasskeyRegistered {
    pub passkey: PasskeyInfo,
    pub recovery_codes: Option<Vec<String>>,
}

#[derive(ToSchema)]
pub struct MfaStatus {
    pub mfa_enabled: bool,
    pub methods: Vec<String>,
    pub totp_enabled: bool,
    pub totp_enabled_at: Option<String>,
    pub passkeys: Vec<PasskeyInfo>,
    pub recovery_codes_remaining: i64,
}

#[derive(ToSchema)]
pub struct TotpSetup {
    /// Base32 secret for manual entry
    pub secret: String,
    #[schema(example = "otpauth://totp/Telepy%3Aadmin%40telepy.example.com?secret=…")]
    pub otpauth_uri: String,
    /// The otpauth URI as an SVG QR code
    pub qr_svg: String,
}

#[derive(ToSchema)]
pub struct TotpEnableRequest {
    #[schema(example = "123456")]
    pub code: String,
}

#[derive(ToSchema)]
pub struct RecoveryCodes {
    /// Shown once; each works one time
    #[schema(example = json!(["abcd-efgh-jkmn"]))]
    pub recovery_codes: Option<Vec<String>>,
}

#[derive(ToSchema)]
#[schema(description = "Google sign-in error; `code` is one of google_invalid, google_expired, google_no_email, google_domain_not_allowed (with `domain`), registration_closed, google_account_conflict (with `username`), account_disabled, google_not_configured, google_client_mismatch, google_unreachable")]
pub struct GoogleLoginError {
    #[schema(example = "error")]
    pub status: String,
    /// English fallback text
    pub detail: String,
    #[schema(example = "google_domain_not_allowed")]
    pub code: String,
    pub domain: Option<String>,
    pub username: Option<String>,
}

// ---------------------------------------------------------------- LAN hosts / discovery (#20)

#[derive(ToSchema)]
pub struct LanHost {
    pub id: i64,
    pub tunnel_id: i64,
    #[schema(example = "192.168.1.20")]
    pub address: String,
    #[schema(example = "nas.lan")]
    pub hostname: Option<String>,
    pub mac: Option<String>,
    /// Ports open at the last scan
    pub open_ports: Vec<i64>,
    #[schema(example = "SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13")]
    pub ssh_banner: Option<String>,
    pub label: Option<String>,
    /// Default login user on this machine
    pub username: Option<String>,
    pub ssh_port: i64,
    /// `scan` or `manual`
    pub source: String,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub created_at: String,
}

#[derive(ToSchema)]
pub struct LanScanStatus {
    pub scan_id: String,
    pub tunnel_id: i64,
    pub started_by: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// connecting | networks | discovery | ports | names | done | failed
    pub phase: String,
    #[schema(example = json!(["192.168.1.0/24"]))]
    pub networks: Vec<String>,
    pub ports: Vec<i64>,
    pub probed: i64,
    pub total: i64,
    pub hosts_found: i64,
    pub error: Option<String>,
}

#[derive(ToSchema)]
pub struct LanHostList {
    pub hosts: Vec<LanHost>,
    pub scan: Option<LanScanStatus>,
    /// The site switch is on and the user owns the tunnel or has ADMIN
    pub can_scan: bool,
    /// The user may add / edit / remove hosts (EDIT)
    pub can_edit: bool,
}

#[derive(ToSchema)]
pub struct LanHostWrite {
    /// IPv4 address on a private network, or a hostname
    pub address: String,
    pub label: Option<String>,
    /// Default login on this machine (letters, digits, `.`, `_`, `-`; up to 64)
    pub username: Option<String>,
    #[schema(example = 22)]
    pub ssh_port: Option<i64>,
}

#[derive(ToSchema)]
pub struct LanHostPatch {
    pub label: Option<String>,
    /// Default login on this machine (letters, digits, `.`, `_`, `-`; up to 64)
    pub username: Option<String>,
    pub ssh_port: Option<i64>,
}

#[derive(ToSchema)]
pub struct LanScanRequest {
    /// Account on the device used for the scan; omitted = the tunnel's default
    pub username: Option<String>,
    /// Private CIDRs (at most 1024 addresses in total); omitted = the device's own networks
    #[schema(example = json!(["192.168.1.0/24"]))]
    pub subnets: Option<Vec<String>>,
    /// Ports to probe; omitted = 22, 80, 443, 445, 3389, 5900, 8080, 8443
    pub ports: Option<Vec<i64>>,
}

#[derive(ToSchema)]
pub struct LanError {
    pub error: String,
    #[schema(example = "lan_scan_running")]
    pub code: String,
}

#[derive(ToSchema)]
pub struct LanTopologyTunnel {
    pub id: i64,
    pub name: String,
    pub reverse_port: i64,
    /// null when the status source is unavailable
    pub online: Option<bool>,
    pub rtt_ms: Option<f64>,
    #[schema(example = "owner")]
    pub permission: String,
    pub can_scan: bool,
    pub can_edit: bool,
    /// Device accounts the user may use (the first hop of a jump)
    pub usernames: Vec<String>,
    pub default_username: Option<String>,
    /// The device's own addresses (public IP, LAN interfaces, hostname), as on the tunnel list; null for viewers without an allowed account
    pub endpoint: Option<TunnelEndpoint>,
    pub scan: Option<LanScanStatus>,
    pub hosts: Vec<LanHost>,
}

#[derive(ToSchema)]
pub struct LanTopology {
    pub tunnels: Vec<LanTopologyTunnel>,
}

// ---------------------------------------------------------------- device keys

#[derive(ToSchema)]
pub struct DeviceKeyTarget {
    /// OS account on the device
    pub username: String,
    /// installed / pending / error
    pub status: String,
    pub error: Option<String>,
}

#[derive(ToSchema)]
pub struct DeviceKeyOwner {
    pub id: i64,
    pub username: String,
}

#[derive(ToSchema)]
pub struct DeviceKeyEntry {
    pub user_key_id: i64,
    pub name: String,
    pub fingerprint: Option<String>,
    pub key_type: Option<String>,
    pub owner: DeviceKeyOwner,
    pub mine: bool,
    /// The owner's account is disabled: the entry stays on the list, but Telepy takes the key off the device (back on re-enable)
    pub owner_disabled: bool,
    pub added_by: String,
    pub created_at: String,
    /// Login account ids this key is limited to on the direct entry (null = every account its owner may use)
    pub accounts: Option<Vec<i64>>,
    /// The key is on the list directly (it can also come through key groups, see `groups`)
    pub direct: bool,
    /// Key group grants that bring the key here
    pub groups: Vec<KeyGroupSource>,
    /// One per OS account the key goes into (the owner's allowed accounts ∩ the chosen accounts of every source)
    pub targets: Vec<DeviceKeyTarget>,
}

/// A key group grant that puts a key on a device.
#[derive(ToSchema)]
pub struct KeyGroupSource {
    /// Key group id
    pub id: i64,
    pub name: String,
    /// When granted through a tunnel group: which one
    pub tunnel_group: Option<NamedRef>,
    /// Account names the grant is limited to (null = all)
    pub accounts: Option<Vec<String>>,
}

#[derive(ToSchema)]
pub struct NamedRef {
    pub id: i64,
    pub name: String,
}

#[derive(ToSchema)]
pub struct DeviceKeyRemoval {
    pub username: String,
    pub fingerprint: String,
    pub owner: Option<String>,
    /// pending / error
    pub status: String,
    pub error: Option<String>,
}

#[derive(ToSchema)]
pub struct DeviceKeySync {
    pub username: String,
    pub ok: bool,
    pub error: Option<String>,
    pub synced_at: String,
}

#[derive(ToSchema)]
pub struct DeviceKeyTunnel {
    pub id: i64,
    pub host_friendly_name: String,
    pub online: bool,
    /// owner / admin / edit / view
    pub role: String,
}

#[derive(ToSchema)]
pub struct MyKeyChoice {
    pub id: i64,
    pub name: String,
    pub fingerprint: Option<String>,
    pub key_type: Option<String>,
    pub in_list: bool,
    /// When on the list: login account ids it is limited to (null = all)
    pub accounts: Option<Vec<i64>>,
    /// Its key group (null = none)
    pub group_id: Option<i64>,
    /// Key group grants that put it on this device
    pub via_groups: Vec<KeyGroupSource>,
}

/// One of your key groups, as seen from a device.
#[derive(ToSchema)]
pub struct MyKeyGroupHere {
    pub id: i64,
    pub name: String,
    pub key_count: i64,
    /// The group is granted to this device directly
    pub grant: Option<KeyGroupGrantHere>,
    /// The group is granted to your tunnel group that holds this device
    pub via_tunnel_group: Option<KeyGroupGrantVia>,
}

#[derive(ToSchema)]
pub struct KeyGroupGrantHere {
    pub id: i64,
    pub accounts: Option<Vec<String>>,
}

#[derive(ToSchema)]
pub struct KeyGroupGrantVia {
    /// Tunnel group id
    pub id: i64,
    pub name: String,
    pub grant_id: i64,
    pub accounts: Option<Vec<String>>,
}

/// A login account with its id (for the per-key account choice).
#[derive(ToSchema)]
pub struct DeviceAccount {
    pub id: i64,
    pub username: String,
}

/// What Telepy knows about the device's OS (null until the device was dialed).
#[derive(ToSchema)]
pub struct DevicePlatform {
    /// Windows: administrators' keys go to `%ProgramData%\ssh\administrators_authorized_keys`
    pub windows: bool,
    /// Why the probe failed (the device is then treated as not Windows)
    pub error: Option<String>,
}

/// A device's key list. Owners and ADMIN sharees see every entry and pending removals; other sharees see their own.
#[derive(ToSchema)]
pub struct DeviceKeys {
    pub tunnel: DeviceKeyTunnel,
    /// Per-account merged view: the list × what Telepy installed × the file as last read
    pub view: DeviceKeyView,
    pub platform: Option<DevicePlatform>,
    /// Owner or ADMIN sharee
    pub can_manage: bool,
    /// OS accounts the caller may use here (their keys go into these, or a chosen subset)
    pub accounts: Vec<String>,
    /// The same accounts with their ids (what `accounts` on an entry refers to)
    pub account_ids: Vec<DeviceAccount>,
    pub entries: Vec<DeviceKeyEntry>,
    /// Keys Telepy installed that must go (access revoked, key deleted …), removed once the device is online
    pub removals: Vec<DeviceKeyRemoval>,
    pub sync: Vec<DeviceKeySync>,
    pub my_keys: Vec<MyKeyChoice>,
    /// Your key groups and whether each reaches this device
    pub my_key_groups: Vec<MyKeyGroupHere>,
}

#[derive(ToSchema)]
pub struct DeviceKeyView {
    pub accounts: Vec<DeviceKeyViewAccount>,
    /// `KEEP_SHARED_SERVICE_KEY` is set: the legacy shared key stays on devices (another server still uses it)
    pub keep_shared: bool,
}

#[derive(ToSchema)]
pub struct DeviceKeyViewAccount {
    pub username: String,
    /// `~/.ssh/authorized_keys`, or `%ProgramData%\ssh\administrators_authorized_keys` for a Windows administrator
    pub file: String,
    /// A member of the local Administrators group on a Windows device (sshd ignores its own authorized_keys)
    pub windows_admin: bool,
    /// When Telepy last read this account's authorized_keys (null = never; "sync" re-reads)
    pub checked_at: Option<String>,
    /// Whether the file exists (null until read)
    pub exists: Option<bool>,
    /// Last sync or read error of this account
    pub error: Option<String>,
    pub rows: Vec<DeviceKeyViewRow>,
}

/// One key in one account. Owners / ADMIN sharees see every row; other users only their own keys.
#[derive(ToSchema)]
pub struct DeviceKeyViewRow {
    /// service / installed / pending / error / removing / manual (a Telepy user's key added by hand) / unknown / invalid
    pub state: String,
    /// `service` rows: the legacy shared service key (removed once every tunnel on the machine uses its own key)
    pub legacy: bool,
    /// Seen in the file at `checked_at`
    pub verified: bool,
    /// On the device's key list
    pub on_list: bool,
    /// The viewer's own key
    pub mine: bool,
    pub user_key_id: Option<i64>,
    pub name: Option<String>,
    pub owner: Option<String>,
    pub fingerprint: Option<String>,
    pub key_type: Option<String>,
    pub bits: Option<u32>,
    pub comment: Option<String>,
    pub options: Option<String>,
    /// First line holding this key
    pub line_no: Option<i64>,
    /// Lines holding this key (more than 1 when it was pasted twice; removing it removes every one)
    pub line_count: i64,
    pub error: Option<String>,
    /// First 120 characters of an unreadable line
    pub raw: Option<String>,
    /// For keys on the list: the login account ids the key is limited to (null = all; the union of every source)
    pub accounts: Option<Vec<i64>>,
    /// For keys on the list: listed directly (can be taken off the list directly)
    pub direct: bool,
    /// For keys on the list: the key groups that bring it here
    pub groups: Vec<NamedRef>,
    /// The key owner's account is disabled (`removing`: Telepy is taking it off; `manual`: added by hand, Telepy leaves it)
    pub owner_disabled: bool,
}

#[derive(ToSchema)]
pub struct DeviceKeysAdd {
    /// Ids of your own keys to add to the device's list
    pub user_key_ids: Vec<i64>,
    /// Limit the keys to these login account ids (null / absent = every account you may use)
    pub accounts: Option<Vec<i64>>,
}

/// `PATCH …/device-keys/{key_id}`: which login accounts the key goes into.
#[derive(ToSchema)]
pub struct DeviceKeyAccounts {
    /// Login account ids (non-empty), or null for every account the owner may use
    pub accounts: Option<Vec<i64>>,
}

#[derive(ToSchema)]
pub struct AuthorizedKeyLine {
    pub line_no: i64,
    /// service / managed / telepy_user / unknown / invalid
    pub kind: String,
    pub key_type: Option<String>,
    pub bits: Option<u32>,
    pub fingerprint: Option<String>,
    pub comment: Option<String>,
    pub options: Option<String>,
    /// In the device key list for this account
    pub in_list: Option<bool>,
    /// Telepy user who owns this key (managed / telepy_user)
    pub owner: Option<String>,
    pub key_name: Option<String>,
    /// First 120 characters of an unparseable line
    pub raw: Option<String>,
}

#[derive(ToSchema)]
pub struct AuthorizedKeysAccount {
    pub username: String,
    pub ok: bool,
    pub error: Option<String>,
    pub exists: bool,
    pub lines: Vec<AuthorizedKeyLine>,
}

#[derive(ToSchema)]
pub struct AuthorizedKeysAudit {
    pub tunnel_id: i64,
    pub accounts: Vec<AuthorizedKeysAccount>,
}

/// Send `fingerprint` for one key (errors if it can't be removed) or `fingerprints` for a batch
/// (one rewrite of the file; keys that can't be removed are reported in `skipped`).
#[derive(ToSchema)]
pub struct AuthorizedKeyRemove {
    pub username: String,
    pub fingerprint: Option<String>,
    /// 1 to 10000 fingerprints
    pub fingerprints: Option<Vec<String>>,
}

#[derive(ToSchema)]
pub struct AuthorizedKeyRemoved {
    /// Lines removed
    pub removed: i64,
    /// Keys removed
    pub keys: i64,
    pub skipped: Vec<AuthorizedKeySkipped>,
    /// Undo handle for `POST …/authorized-keys/restore/{removal_id}` (null when nothing was removed); kept 7 days
    pub removal_id: Option<i64>,
}

/// One manual removal from an account's authorized_keys (restorable for 7 days).
#[derive(ToSchema)]
pub struct AuthorizedKeyRemoval {
    pub id: i64,
    pub username: String,
    /// Keys removed
    pub keys: i64,
    /// Lines removed
    pub lines: i64,
    pub removed_by: String,
    pub removed_at: String,
    /// Set once restored
    pub restored_at: Option<String>,
}

#[derive(ToSchema)]
pub struct AuthorizedKeyRemovals {
    pub tunnel_id: i64,
    pub retention_days: i64,
    /// Newest first
    pub removals: Vec<AuthorizedKeyRemoval>,
}

#[derive(ToSchema)]
pub struct AuthorizedKeyRestored {
    /// Lines appended back
    pub restored: i64,
    /// Lines skipped because that key is in the file again
    pub skipped: i64,
    pub username: String,
}

/// A key the batch left alone.
#[derive(ToSchema)]
pub struct AuthorizedKeySkipped {
    pub fingerprint: String,
    /// `not_found` | `service_key` | `in_key_list`
    pub code: String,
}

#[derive(ToSchema)]
pub struct KeyDeviceKey {
    pub user_key_id: i64,
    /// Login account ids the direct entry is limited to (null = all)
    pub accounts: Option<Vec<i64>>,
    /// On the device's list directly
    pub direct: bool,
    /// Key group grants that bring it here
    pub groups: Vec<KeyGroupSource>,
    pub targets: Vec<DeviceKeyTarget>,
}

/// One device you can use, with the state of your keys on it (keys-page matrix; sorted by device name).
#[derive(ToSchema)]
pub struct KeyDevice {
    pub tunnel_id: i64,
    pub host_friendly_name: String,
    pub online: bool,
    pub role: String,
    /// My tunnel group for it (null = ungrouped)
    pub group_id: Option<i64>,
    pub accounts: Vec<String>,
    /// The same accounts with ids
    pub account_list: Vec<DeviceAccount>,
    /// Your keys that are in this device's list
    pub keys: Vec<KeyDeviceKey>,
}

#[derive(ToSchema)]
pub struct JoinRequest {
    /// Tunnel name to use (default: the device's hostname)
    pub name: Option<String>,
    /// `ssh` (default) or `websocket`: the command gets `--via-web` and the device carries the tunnel inside a WebSocket on the web port
    pub transport: Option<String>,
    /// "mine" seeds the new device's key list with your keys; "empty" (default) leaves it empty
    #[schema(example = "mine")]
    pub key_list: Option<String>,
}

#[derive(ToSchema)]
#[schema(description = "A join ticket as the owner sees it; the token itself is only returned once, on creation")]
pub struct JoinTicket {
    pub id: String,
    pub name: Option<String>,
    pub key_list_mine: bool,
    /// ssh | websocket
    pub transport: String,
    /// waiting | registered | connected | verified | failed
    pub phase: String,
    pub detail: Option<String>,
    pub tunnel_id: Option<i64>,
    pub tunnel_name: Option<String>,
    pub reverse_port: Option<i64>,
    pub username: Option<String>,
    pub ssh_port: Option<i64>,
    pub hostname: Option<String>,
    pub os: Option<String>,
    /// Your other tunnel on this very machine (same SSH host key), when there is one
    pub same_machine_as: Option<SameMachineTunnel>,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(ToSchema)]
pub struct JoinTicketCreated {
    #[schema(inline)]
    pub ticket: JoinTicket,
    /// Single-use secret for the device (`tpj_…`)
    pub token: String,
    pub install_url: String,
    /// `curl -fsSL '<install_url>' | sudo sh -s -- --token <token>`
    pub command: String,
    /// The same without sudo (user-level service)
    pub command_no_sudo: String,
}

#[derive(ToSchema)]
#[schema(description = "Sent by the install script")]
pub struct JoinRegistration {
    pub public_key: String,
    pub hostname: Option<String>,
    /// Account on the device that Telepy logs in to
    pub username: String,
    #[schema(example = 22)]
    pub ssh_port: Option<i64>,
    pub os: Option<String>,
    pub name: Option<String>,
    /// This machine's SSH host keys (`type base64`, verified by the script with a strict handshake). Pinned at once; a machine another account's tunnel already pins is refused (409)
    pub host_keys: Option<Vec<String>>,
    /// What the script found on the device: `shell`, `os`, `arch`, `http`, `client`, `server`, `init`, `keepalive` (ssh | tcp), `key_format`, `authorized_keys`, `ssh_host`, `transport` (ssh | websocket | auto), `carrier` (`binary <target>` | `python3` | `none`: which web-port carrier was installed), `compat` (list, e.g. `no_server_alive`). Allow-listed, ≤ 120 chars each
    #[schema(value_type = Object)]
    pub facts: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct JoinError {
    pub error: String,
    /// too_many_join_tokens
    pub code: String,
}

// ---------------------------------------------------------------- tunnel delete

#[derive(ToSchema)]
pub struct TunnelDeleteTunnel {
    pub id: i64,
    pub name: String,
    pub reverse_port: i64,
}

#[derive(ToSchema)]
pub struct TunnelDeleteSharee {
    pub id: i64,
    pub username: String,
    #[schema(example = "view")]
    pub permission: String,
}

/// A key Telepy installed on the device (from the device key list)
#[derive(ToSchema)]
pub struct TunnelDeleteKey {
    #[schema(example = "SHA256:…")]
    pub fingerprint: String,
    pub owner: Option<String>,
    /// Key name; null when the key already left the list (pending removal)
    pub name: Option<String>,
    pub in_list: bool,
    /// Login accounts it is installed in
    pub accounts: Vec<String>,
}

#[derive(ToSchema)]
pub struct TunnelDeleteGrant {
    pub id: i64,
    pub client_name: String,
    pub user: AiUserRef,
    pub mine: bool,
    /// `only` = restricted to this tunnel alone, `shared` = this and `other_tunnels` more, `all` = every tunnel
    #[schema(example = "only")]
    pub coverage: String,
    pub other_tunnels: i64,
    /// The caller may revoke the whole authorization here (own grant, admin, or limited to this tunnel);
    /// otherwise deleting only drops this tunnel from it
    pub can_revoke: bool,
}

#[derive(ToSchema)]
pub struct TunnelDeleteCheck {
    pub tunnel: TunnelDeleteTunnel,
    /// The uninstall script a one-command install left on the device (`~/.ssh/telepy-<install id>-uninstall.sh`)
    #[schema(example = "~/.ssh/telepy-k7m2q9xd-uninstall.sh")]
    pub uninstall_script: String,
    pub online: bool,
    /// No other tunnel pins this machine's host key: removing the service key is the default, or the machine stays reachable with it and has no owner
    pub last_on_machine: bool,
    /// Your other tunnels on the same machine (the ones you can see)
    pub same_machine: Vec<SameMachineTunnel>,
    /// Login accounts (target usernames) of the tunnel
    pub accounts: Vec<String>,
    pub sharees: Vec<TunnelDeleteSharee>,
    /// People using the tunnel right now (distinct users)
    pub in_use: i64,
    pub lan_hosts: i64,
    pub device_keys: Vec<TunnelDeleteKey>,
    pub grants: Vec<TunnelDeleteGrant>,
    pub ai_sessions: Vec<AiSession>,
}

#[derive(ToSchema)]
pub struct TunnelDeleteAccount {
    pub account: String,
    /// Telepy-managed keys removed from authorized_keys
    pub removed: i64,
    pub service_key_removed: bool,
    pub error: Option<String>,
}

#[derive(ToSchema)]
pub struct TunnelDeleteReport {
    pub deleted: bool,
    /// The device was online, so its accounts could be cleaned
    pub online: bool,
    pub accounts: Vec<TunnelDeleteAccount>,
    /// Keys Telepy installed that are still on the device (offline, failed or kept)
    pub keys_left: i64,
    pub grants_revoked: i64,
    /// Authorizations that keep other tunnels; this one was dropped from their list
    pub grants_detached: i64,
    pub ai_sessions_closed: i64,
    pub device_disconnected: bool,
    /// Removal of the tunnel's service from the device (null unless remove_service and the device was online)
    pub service: Option<TunnelServiceRemoval>,
    /// How each step ended, in order (service, keys, stop, watch, telepy, disconnect); the same objects were pushed live as `TUNNEL-DELETE-PROGRESS` notifications to the person deleting
    pub steps: Vec<TunnelDeleteStep>,
}

/// One step of a tunnel delete (also sent live as `TUNNEL-DELETE-PROGRESS` with `tunnel_id`, first with `state: active`)
#[derive(ToSchema)]
pub struct TunnelDeleteStep {
    /// service = find and delete what runs the tunnel on the device; keys = authorized_keys; stop = start the stop scripts and wait for the device to drop; watch = check it stays down; telepy = AI sessions, recordings, rows, authorizations; disconnect = the gateway
    #[schema(example = "keys")]
    pub step: String,
    /// active (only in the live notification) / done / warn / failed / skipped
    #[schema(example = "done")]
    pub state: String,
    /// skipped: off / offline / not_stopped; stop warn: not_found / still_connected; watch failed: came_back
    pub reason: Option<String>,
    /// stop / watch while active: the longest wait in seconds
    pub secs: Option<i64>,
    /// service: items found / accounts that failed
    pub found: Option<i64>,
    pub errors: Option<i64>,
    /// keys: user keys removed, accounts that failed, whether a service key went, keys still on the device
    pub removed: Option<i64>,
    pub failed: Option<i64>,
    pub service_key: Option<bool>,
    pub keys_left: Option<i64>,
    /// telepy: AI sessions closed, authorizations revoked / detached
    pub ai_sessions: Option<i64>,
    pub revoked: Option<i64>,
    pub detached: Option<i64>,
    /// disconnect: the device was still connected
    pub was_connected: Option<bool>,
}

/// One result line of the device-side removal script
#[derive(ToSchema)]
pub struct TunnelServiceItem {
    /// platform / found / removed / scheduled / needs_root / kept / note / failed / stopscript / launched / done
    #[schema(example = "found")]
    pub kind: String,
    /// What it is about: systemd, systemd-user, launchd, cron, loop, docker, process, script, task, service, run-key, startup, file, unit, key, log, stop…
    #[schema(example = "systemd")]
    pub what: String,
    /// Path, unit name, command line, or the command to run by hand (needs_root)
    pub detail: String,
}

#[derive(ToSchema)]
pub struct TunnelServiceAccount {
    pub account: String,
    #[schema(example = "posix")]
    pub platform: Option<String>,
    #[schema(example = "Linux")]
    pub os: Option<String>,
    pub items: Vec<TunnelServiceItem>,
    pub error: Option<String>,
}

#[derive(ToSchema)]
pub struct TunnelServiceRemoval {
    pub accounts: Vec<TunnelServiceAccount>,
    /// At least one install method or running process was found
    pub found: bool,
    /// A stop script was started on the device
    pub launched: bool,
    /// The device dropped the tunnel by itself afterwards (the service really stopped)
    pub stopped: bool,
    /// …and it came back: something still restarts it
    pub came_back: bool,
}

// ---------------------------------------------------------------- live sessions

#[derive(ToSchema)]
pub struct LiveSessionTunnel {
    pub id: i64,
    pub name: Option<String>,
}

#[derive(ToSchema)]
pub struct LiveSession {
    pub id: u64,
    pub tunnel: LiveSessionTunnel,
    pub user: UserRef,
    /// terminal / files / browser / desktop / rustdesk / ssh / ai / watch
    #[schema(example = "terminal")]
    pub kind: String,
    pub ip: Option<String>,
    pub geo: Option<IpGeo>,
    pub since: String,
    /// MCP app name
    pub client: Option<String>,
    /// kind = ai: interactive shells open on the agent's session
    pub shells: Option<i64>,
    /// kind = terminal: the shell is kept after its browser dropped, until `ends_at`
    pub detached: Option<DetachedShell>,
    pub mine: bool,
    /// kind = terminal on a tunnel you manage, not yours: the shell to watch at `/ws/terminal-watch/{shell_id}/`
    pub shell_id: Option<String>,
    /// kind = terminal: who is watching it right now
    pub watched_by: Vec<String>,
    /// kind = watch: whose shell this session watches
    pub watching: Option<WatchingShell>,
}

/// 看的是誰的哪個 shell。/ Whose shell a watch session watches.
#[derive(ToSchema)]
pub struct WatchingShell {
    pub user: UserRef,
    pub shell_id: String,
}

/// 自己的、自己擁有或 ADMIN 的隧道上的（管理員看全部）。/ Yours plus everyone's on tunnels you own or ADMIN (all for admins).
#[derive(ToSchema)]
pub struct LiveSessions {
    pub sessions: Vec<LiveSession>,
}

// ---------------------------------------------------------------- terminal recordings

#[derive(ToSchema)]
pub struct RecordingItem {
    pub id: i64,
    pub tunnel: LiveSessionTunnel,
    pub user: UserRef,
    /// 裝置上的帳號（區網主機時是跳板帳號）。/ The device account (the jump account for a LAN host).
    pub os_user: String,
    /// 區網主機 `login@address`。/ A LAN host as `login@address`.
    pub lan_host: Option<String>,
    /// `terminal` = 網頁終端機；`agent` = MCP agent 的互動 shell（`user` 是授權那個 app 的人）。
    /// `terminal` = the web terminal; `agent` = an MCP agent's interactive shell (`user` is who authorized the app).
    #[schema(example = "terminal")]
    pub kind: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// 還在錄。/ Still recording.
    pub live: bool,
    pub duration_ms: i64,
    pub bytes: i64,
    /// 超過 64 MB，後面沒錄到。/ Hit the 64 MB cap; the rest was not recorded.
    pub truncated: bool,
    pub can_delete: bool,
}

#[derive(ToSchema)]
pub struct RecordingList {
    pub recordings: Vec<RecordingItem>,
}

/// 開關隧道的終端機錄影；關掉要 `reauth`（帳號有第二因素時）。/ Switch recording; turning it off needs `reauth`.
#[derive(ToSchema)]
pub struct RecordingSetting {
    pub enabled: bool,
    pub reauth: Option<MfaProof>,
}

/// 隧道的網頁終端機斷線政策：user = 照每個人的選擇（受站台上限）、never = 斷線就結束。
/// A tunnel's web terminal detach policy: user = each person's choice (within the site ceiling), never = end at once.
#[derive(ToSchema)]
pub struct TerminalDetachPolicy {
    #[schema(example = "never")]
    pub policy: String,
}

// ---------------------------------------------------------------- command rules

/// 規則套用的一條隧道。/ A tunnel a rule covers.
#[derive(ToSchema)]
pub struct CommandRuleTunnel {
    pub id: i64,
    pub name: String,
    /// 只有自己的個人規則有：這條隧道上算不算數（管別人的規則要你是 owner / ADMIN）。
    /// Your own personal rules only: whether it counts there (rules about other people need you to own or administer it).
    pub applies: Option<bool>,
}

/// 一條指令規則。/ A command rule.
#[derive(ToSchema)]
pub struct CommandRule {
    pub id: i64,
    /// site（管理員的全站規則）/ personal（某個人自己的）。/ site (admins') or personal (someone's own).
    pub scope: String,
    /// 個人規則的主人。/ The owner of a personal rule.
    pub owner: Option<UserRef>,
    /// 是你的個人規則。/ It is your own personal rule.
    pub mine: bool,
    /// 套用所有隧道（個人：你管的 / 能用的全部，之後加的也算）；否則只有 `tunnels`。
    /// Every tunnel (personal: all you manage / can use, later ones too); otherwise only `tunnels`.
    pub all_tunnels: bool,
    /// 限定的隧道（你看不到的只算在 `hidden_tunnels`）。/ The tunnels it is limited to (ones you can't see are only counted).
    pub tunnels: Vec<CommandRuleTunnel>,
    pub hidden_tunnels: i64,
    /// 全站規則能不能覆寫：default（隧道的 owner / ADMIN 可以在自己的隧道上關掉；提醒每個人可以靜音）/ enforced（誰都不行）。個人規則一律 default。
    /// Site rules: default (owners / ADMINs may turn it off on their tunnels; anyone may mute a reminder) or enforced (nobody). Personal rules: default.
    #[schema(example = "default")]
    pub mode: String,
    /// 「要核准」等多久（秒）；null = 網站設定。/ How long an approval waits (seconds); null = the site setting.
    pub approval_timeout: Option<i64>,
    /// 我的覆寫：`{off: {all_tunnels, tunnels} | null, muted}`。/ My overrides: `{off: {all_tunnels, tunnels} | null, muted}`.
    #[schema(value_type = Object)]
    pub my_override: serde_json::Value,
    /// 在一條隧道上看時：誰（現在的 owner / ADMIN）在這裡關掉了它。/ On one tunnel: who (current owners / ADMINs) turned it off there.
    pub off_here: Option<Vec<UserRef>>,
    /// block / approve / allow（例外：只豁免同一位主人的規則）。/ block, approve or allow (an exception for the same owner's rules only).
    pub action: String,
    /// command（程式 + 必要參數）/ regex（整行）。/ command (program + required arguments) or regex (whole line).
    pub kind: String,
    pub pattern: String,
    /// everyone / sharees（只管不能核准的人）/ me（只管主人自己，個人規則才有）。
    /// everyone, sharees (people who can't approve) or me (just the owner; personal rules only).
    pub who: String,
    /// all / terminal / agents
    pub via: String,
    pub note: String,
    pub enabled: bool,
    /// 「要核准」規則指定的核准人；空 = owner + ADMIN sharee。/ The approvers an approve rule names; empty = owner + ADMIN.
    pub approver_ids: Vec<i64>,
    /// 同上，附名字。/ The same with usernames.
    pub approvers: Vec<UserRef>,
    pub created_at: String,
    pub updated_at: String,
}

/// 新增或修改規則（修改時只帶要改的欄位）。/ Create or change a rule (send only what changes on PATCH).
#[derive(ToSchema)]
pub struct CommandRuleInput {
    /// 新增時：personal（預設）/ site（管理員）。/ On create: personal (default) or site (admins).
    pub scope: Option<String>,
    /// 全站規則：default（預設，可以覆寫）/ enforced。/ Site rules: default (overridable, the default) or enforced.
    pub mode: Option<String>,
    /// 「要核准」等多久（30–86400 秒，不能比網站設定長）；null = 網站設定。/ Approval wait (30–86400 s, ≤ the site setting); null = the site setting.
    pub approval_timeout: Option<i64>,
    /// block / approve / allow
    pub action: Option<String>,
    pub kind: Option<String>,
    pub pattern: Option<String>,
    pub who: Option<String>,
    pub via: Option<String>,
    pub note: Option<String>,
    pub enabled: Option<bool>,
    /// 核准人（只對 approve 有意義；null / [] = owner + ADMIN；「只有我」= 自己）。個人規則：你管的隧道的 owner / ADMIN
    /// sharee；全站規則：任何啟用中的帳號。
    /// Approvers (approve rules only; null / [] = owner + ADMIN; "me" rules = yourself). Personal rules: owners / ADMIN
    /// sharees of tunnels you manage; site rules: any active user.
    pub approver_ids: Option<Vec<i64>>,
    /// 預設 true。/ Defaults to true.
    pub all_tunnels: Option<bool>,
    /// `all_tunnels` false 時的隧道（≤ 200）。管別人的個人規則只能選你是 owner / ADMIN 的。
    /// The tunnels when `all_tunnels` is false (≤ 200). A personal rule about other people only takes tunnels you own or administer.
    pub tunnel_ids: Option<Vec<i64>>,
}

/// 覆寫的範圍。/ The reach of an override.
#[derive(ToSchema)]
pub struct CommandRuleOverrideInput {
    /// 預設 true：我現在與之後管（關掉）/ 能用（靜音）的全部隧道。/ Default true: all tunnels I manage (off) / use (mute), later ones too.
    pub all_tunnels: Option<bool>,
    pub tunnel_ids: Option<Vec<i64>>,
}

/// 隧道選單的一項。/ One entry of the tunnel picker.
#[derive(ToSchema)]
pub struct CommandRuleTunnelChoice {
    pub id: i64,
    pub name: String,
    /// 你是 owner / ADMIN（能替別人設規則）。/ You own or administer it (rules about other people are possible).
    pub manage: bool,
}

#[derive(ToSchema)]
pub struct CommandRuleList {
    /// 你的個人規則。/ Your personal rules.
    pub mine: Vec<CommandRule>,
    /// 全站規則（大家都看得到）。/ The site-wide rules (everyone reads them).
    pub site: Vec<CommandRule>,
    pub can_edit_site: bool,
    /// 每個人 / 全站最多幾條。/ Rules per person / site-wide at most.
    pub limit: i64,
    /// 規則自己的核准等待最多幾秒（網站設定）。/ The longest a rule's own approval wait may be (the site setting).
    pub approval_timeout_max: i64,
    /// 你看得到的隧道。/ The tunnels you can see.
    pub tunnels: Vec<CommandRuleTunnelChoice>,
    /// 個人規則可以指定的核准人。/ Who a personal rule may name.
    pub approver_candidates: Vec<UserRef>,
    /// 全站規則可以指定的核准人（管理員才有；其他人為空）。/ Who a site rule may name (admins only; empty otherwise).
    pub site_approver_candidates: Vec<UserRef>,
    /// 全站規則可以限定的隧道（管理員才有）。/ Tunnels a site rule may be limited to (admins only).
    pub site_tunnels: Option<Vec<UserRef>>,
}

#[derive(ToSchema)]
pub struct TunnelCommandRules {
    pub tunnel: UserRef,
    /// 這裡算數的個人規則：owner / ADMIN 寫的，加上你自己「只有我」的。/ Personal rules in force here: by the owner /
    /// ADMINs, plus your own "only me" ones.
    pub rules: Vec<CommandRule>,
    /// 也適用的全站規則。/ Site-wide rules that apply as well.
    pub site_rules: Vec<CommandRule>,
    pub can_edit: bool,
    pub can_edit_site: bool,
    /// 可以指定的核准人：owner 與 ADMIN sharee（能改規則的人才有）。/ Who a tunnel rule may name: owner + ADMIN sharees (editors only).
    pub approver_candidates: Vec<UserRef>,
}

#[derive(ToSchema)]
pub struct CommandCheckInput {
    pub command: String,
    /// 不帶 = 全站與你自己管所有隧道的規則（想成一條你管的隧道）。/ Omit for the site's and your own every-tunnel rules
    /// (as on a tunnel you manage).
    pub tunnel_id: Option<i64>,
    /// site = 只看全站規則。/ site = site-wide rules only.
    pub scope: Option<String>,
    /// terminal（預設）/ agent。/ terminal (default) or agent.
    pub source: Option<String>,
    /// 還沒存的規則 `{kind, pattern}`。/ An unsaved rule `{kind, pattern}`.
    #[schema(value_type = Option<Object>)]
    pub rule: Option<serde_json::Value>,
}

/// 一個範圍（全站 / 個人）的結果。/ One scope's outcome (site-wide / personal).
#[derive(ToSchema)]
pub struct CommandScopeVerdict {
    /// 符合的擋下 / 要核准規則（被豁免時也列出）。/ The block / approve rule that matched (listed even when exempted).
    #[schema(value_type = Option<Object>)]
    pub hit: Option<serde_json::Value>,
    /// 豁免這個範圍的允許規則。/ The allow rule that exempts this scope.
    #[schema(value_type = Option<Object>)]
    pub allowed_by: Option<serde_json::Value>,
    /// `hit` 被 `allowed_by` 豁免了。/ `hit` was exempted by `allowed_by`.
    pub exempted: bool,
}

#[derive(ToSchema)]
pub struct CommandVerdict {
    /// allow / block / approve
    pub action: String,
    /// 決定的那條規則（擋下 / 要核准）。/ The deciding rule (block / approve).
    #[schema(value_type = Option<Object>)]
    pub rule: Option<serde_json::Value>,
    /// 放行是因為這條允許規則（本來會被擋下 / 要核准）。/ Allowed thanks to this allow rule (it would otherwise be caught).
    #[schema(value_type = Option<Object>)]
    pub allowed_by: Option<serde_json::Value>,
    pub site: CommandScopeVerdict,
    /// 個人規則：每位主人各自算完後最嚴的那個。/ Personal rules: the strictest of each owner's own outcome.
    pub personal: CommandScopeVerdict,
    /// 要核准時：`{default, users: [{id, username}]}`（`default` = owner + ADMIN，沒選隧道時 users 為空）。
    /// For approve: `{default, users}` (`default` = owner + ADMIN; `users` empty when no tunnel was given).
    #[schema(value_type = Option<Object>)]
    pub approvers: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct CommandCheckResult {
    /// 拆出來的簡單指令。/ The simple commands found.
    #[schema(value_type = Vec<Object>)]
    pub commands: Vec<serde_json::Value>,
    pub for_approvers: CommandVerdict,
    pub for_sharees: CommandVerdict,
    /// 你能不能核准這條隧道。/ Whether you approve on this tunnel.
    pub you_approve: bool,
    /// `{matches, error}`，帶 `rule` 時才有。/ Only with `rule`.
    #[schema(value_type = Option<Object>)]
    pub draft: Option<serde_json::Value>,
}

/// 一筆被擋下或送核准的指令。/ A command that was blocked or held for approval.
#[derive(ToSchema)]
pub struct CommandRequest {
    pub id: i64,
    pub tunnel_id: i64,
    pub tunnel_name: Option<String>,
    pub user: UserRef,
    /// terminal / agent
    pub source: String,
    /// agent 的 app 名稱。/ The agent's app name.
    pub client: Option<String>,
    pub account: String,
    pub lan_host: Option<String>,
    pub command: String,
    /// {id, pattern, kind, scope, note, approver_ids}（scope = site / personal / self / tunnel（升級前）；approver_ids = 當時能決定的人）
    /// {id, pattern, kind, scope, note, approver_ids} (scope = site / personal / self / tunnel (pre-upgrade); approver_ids = who could decide)
    #[schema(value_type = Object)]
    pub rule: serde_json::Value,
    /// blocked / pending / approved / denied / cancelled / expired
    pub status: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
    pub reason: String,
    pub used: bool,
    pub can_decide: Option<bool>,
    pub can_cancel: Option<bool>,
}

#[derive(ToSchema)]
pub struct CommandRequestList {
    pub requests: Vec<CommandRequest>,
    /// 等你決定的筆數。/ How many wait for your decision.
    pub pending: i64,
}

#[derive(ToSchema)]
pub struct CommandDecision {
    pub reason: Option<String>,
}
/// 一個 webhook。/ A webhook.
#[derive(ToSchema)]
pub struct Webhook {
    pub id: i64,
    /// user（個人的）/ site（管理員共管）。/ user (personal) or site (shared by the admins).
    pub scope: String,
    pub name: String,
    pub url: String,
    pub host: String,
    /// auto / json / slack / discord / google_chat / teams / telegram / ntfy
    pub format: String,
    /// `auto` 依網址判斷出來的格式。/ The format `auto` resolves to for this URL.
    pub format_resolved: Option<String>,
    /// 訊息語言：en / zh-TW / ja。/ Message language.
    pub language: String,
    /// 訂的事件（`GET /api/webhooks` 的 catalog）。/ Subscribed events (see the catalog).
    pub events: Vec<String>,
    /// true = 所有（看得到的）隧道，包含之後的。/ All (visible) tunnels, later ones included.
    pub all_tunnels: bool,
    /// all_tunnels = false 時限定的隧道 `{id, name}`。/ The tunnels it is limited to.
    #[schema(value_type = Vec<Object>)]
    pub tunnels: Vec<serde_json::Value>,
    /// 離線 / 降級要持續幾秒才送。/ Seconds a status condition must last before it is sent.
    pub delay: i64,
    pub enabled: bool,
    /// `failing` = 連續失敗太多次被暫停。/ `failing` = paused after too many failures in a row.
    pub paused_reason: Option<String>,
    /// 連續失敗次數。/ Consecutive failed deliveries.
    pub failures: i64,
    /// 最近一次送出 `{status, at, http_status, error}`。/ The latest delivery.
    #[schema(value_type = Option<Object>)]
    pub last: Option<serde_json::Value>,
    /// 自訂 header `{name, value}`。/ Custom headers.
    #[schema(value_type = Vec<Object>)]
    pub headers: Vec<serde_json::Value>,
    /// 自訂 header 解不開（換了 SECRET_KEY），要重新輸入。/ The custom headers can't be opened (SECRET_KEY changed).
    pub headers_unreadable: bool,
    /// 建立的人（全站 webhook 給管理員看）。/ Who created it.
    pub created_by: Option<String>,
    /// 全站的：`enforced`（沒人能退出）/ `default`（隧道的 owner / ADMIN 可以退出）；個人的 null。
    /// Site webhooks: `enforced` (nobody opts out) or `default` (tunnel owners / ADMINs may); null for personal ones.
    pub mode: Option<String>,
    /// 全站的退出 `{tunnel_id, tunnel_name, by, at, active}`（active = 退的人現在還管那條隧道）。
    /// A site webhook's opt-outs (active = whoever opted out still manages the tunnel).
    #[schema(value_type = Vec<Object>)]
    pub optouts: Vec<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

/// 我要退出的隧道（整組取代我對這個 webhook 的退出）。/ The tunnels I opt out (replaces my opt-outs of this webhook).
#[derive(ToSchema)]
pub struct WebhookOptOutInput {
    pub tunnel_ids: Vec<i64>,
}

/// 新增或修改 webhook（PATCH 只帶要改的欄位）。/ Create or change a webhook (send only what changes on PATCH).
#[derive(ToSchema)]
pub struct WebhookInput {
    /// user（預設）/ site（管理員）；只在新增時有用。/ user (default) or site (admins); create only.
    pub scope: Option<String>,
    pub name: Option<String>,
    pub url: Option<String>,
    pub format: Option<String>,
    pub language: Option<String>,
    pub events: Option<Vec<String>>,
    pub all_tunnels: Option<bool>,
    pub tunnel_ids: Option<Vec<i64>>,
    pub delay: Option<i64>,
    pub enabled: Option<bool>,
    /// 全站的：enforced / default（預設）。/ Site webhooks: enforced or default (the default).
    pub mode: Option<String>,
    /// 自訂 header `[{name, value}]`（≤ 10；整組取代，沒帶 = 不變）。/ Custom headers (replaces the set; omitted = unchanged).
    #[schema(value_type = Option<Vec<Object>>)]
    pub headers: Option<Vec<serde_json::Value>>,
}

#[derive(ToSchema)]
pub struct WebhookCreated {
    pub webhook: Webhook,
    /// 簽章密鑰（之後也能在 `/secret` 取得）。/ The signing secret (also available from `/secret`).
    pub secret: String,
}

/// 目錄裡的一個事件。/ One catalogue event.
#[derive(ToSchema)]
pub struct WebhookCatalogEvent {
    pub event: String,
    /// status / device / sharing / commands / sessions / account / admin
    pub group: String,
    /// 個人 webhook 上誰收得到（全站目錄是 `site`）。/ Who receives it on a personal webhook (`site` in the site catalogue).
    pub audience: String,
    /// 狀態事件（套用延遲）。/ A status event (the delay applies).
    pub status: bool,
    /// 跟某條隧道有關（套用隧道篩選）。/ About a tunnel (the tunnel filter applies).
    pub tunnel: bool,
    /// info / ok / warning
    pub severity: String,
}

/// 全站 webhook 的摘要：沒有網址、header、密鑰、送出紀錄或建立者。
/// A redacted site-wide webhook: no URL, headers, secret, deliveries or creator.
#[derive(ToSchema)]
pub struct SiteWebhookSummary {
    pub id: i64,
    /// 沒取名（= 網址的主機）時非管理員拿到 null。/ null for non-admins when it was left unnamed (= the URL's host).
    pub name: Option<String>,
    /// 實際的送出格式（`auto` 已依網址判斷）。/ The effective format (`auto` resolved from the URL).
    pub service: Option<String>,
    pub events: Vec<String>,
    pub all_tunnels: bool,
    /// 選的隧道裡呼叫者看得到的 `{id, name}`，依名稱排序。/ Picked tunnels the caller can see, by name.
    #[schema(value_type = Vec<Object>)]
    pub tunnels: Vec<serde_json::Value>,
    /// 選的隧道裡呼叫者看不到的數量。/ How many picked tunnels the caller cannot see.
    pub hidden_tunnels: i64,
    pub enabled: bool,
    pub paused: bool,
    /// enforced / default
    pub mode: String,
    /// 我退出的隧道 id。/ Tunnel ids I opted out.
    pub my_optout: Vec<i64>,
    /// 它涵蓋的、我管的隧道 `{id, name, opted_out, by: [username], mine}`（opted_out = 有現在的管理者退出了）。
    /// Tunnels I manage that it covers (opted_out = a current manager opted it out; by = who).
    #[schema(value_type = Vec<Object>)]
    pub managed: Vec<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct WebhookList {
    pub mine: Vec<Webhook>,
    /// 全站 webhook（只有管理員）。/ Site-wide webhooks (admins only).
    pub site: Option<Vec<Webhook>>,
    /// 全站 webhook 的摘要，給每個登入者（非管理員只有開著的）。/ Redacted site-wide webhooks for everyone (non-admins: enabled only).
    pub site_summary: Vec<SiteWebhookSummary>,
    /// `{personal: [...], site: [...] | null}`
    #[schema(value_type = Object)]
    pub catalog: serde_json::Value,
    /// `{personal_enabled, private_targets, max, used, pause_after, per_minute}`
    #[schema(value_type = Object)]
    pub policy: serde_json::Value,
    pub can_manage_site: bool,
    /// 全站 webhook 能限定的隧道 `{id, name}`（只給管理員）。/ Every tunnel, for site-wide webhooks (admins only).
    #[schema(value_type = Option<Vec<Object>>)]
    pub site_tunnels: Option<Vec<serde_json::Value>>,
    /// 訊息裡連結用的網址（PUBLIC_URL）。/ The base URL used for links in messages.
    pub public_url: Option<String>,
}

#[derive(ToSchema)]
pub struct WebhookDelivery {
    pub id: i64,
    pub event: String,
    /// `webhook-id` header。/ The `webhook-id` header.
    pub message_id: String,
    pub at: String,
    /// ok / failed / skipped
    pub status: String,
    pub http_status: Option<i64>,
    pub error: String,
    pub attempts: i64,
    pub duration_ms: i64,
    pub test: bool,
    /// 送出的內容（最多 16 KB）。/ What was sent (up to 16 KB).
    pub body: String,
    /// 這是重送的話，原本那一筆。/ For a re-send, the original delivery.
    pub redelivered_from: Option<i64>,
    /// 能不能重送（測試送出不行）。/ Whether it can be sent again (test sends can't).
    pub can_redeliver: bool,
}

#[derive(ToSchema)]
pub struct WebhookTestResult {
    pub ok: bool,
    pub http_status: Option<i64>,
    pub error: Option<String>,
    pub duration_ms: i64,
}

#[derive(ToSchema)]
pub struct WebhookSecret {
    /// `whsec_…`（Standard Webhooks）。/ `whsec_…` (Standard Webhooks).
    pub secret: String,
}

// ---------------------------------------------------------------- feature permissions (access)

#[derive(ToSchema)]
pub struct AccessFeature {
    #[schema(example = "terminal")]
    pub id: String,
    /// Built-in value when nothing is set (true for every feature)
    pub default: bool,
}

#[derive(ToSchema)]
#[schema(description = "Effective value of one feature and where it comes from: superuser | user | group (with group_id) | everyone | default")]
pub struct AccessResolved {
    pub allowed: bool,
    #[schema(example = "group")]
    pub from: String,
    pub group_id: Option<i64>,
}

#[derive(ToSchema)]
pub struct AccessGroup {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub created_at: String,
    /// User ids
    pub members: Vec<i64>,
    /// feature id → true (allow) / false (deny); missing = inherit
    #[schema(example = json!({"terminal": false}))]
    pub grants: std::collections::HashMap<String, bool>,
}

#[derive(ToSchema)]
pub struct AccessUser {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub is_superuser: bool,
    pub is_active: bool,
    /// Group ids
    pub groups: Vec<i64>,
    /// The user's own settings (the leaf that overrides their groups); missing = inherit
    pub grants: std::collections::HashMap<String, bool>,
    /// feature id → effective value
    pub effective: std::collections::HashMap<String, AccessResolved>,
}

#[derive(ToSchema)]
#[schema(description = "Feature permissions. Resolution: administrators have everything; else the user's own setting; else their groups (a deny in any group wins, else an allow); else everyone; else the default")]
pub struct AccessPolicy {
    pub features: Vec<AccessFeature>,
    /// feature id → allow / deny for everyone; missing = the default
    pub everyone: std::collections::HashMap<String, bool>,
    pub groups: Vec<AccessGroup>,
    pub users: Vec<AccessUser>,
    /// Only on POST /api/access/groups: the new group's id
    pub created_id: Option<i64>,
}

#[derive(ToSchema)]
pub struct AccessGroupWrite {
    /// 1–64 characters, unique (case-insensitive); required on create
    pub name: Option<String>,
    pub description: Option<String>,
    /// Replaces the member list (user ids)
    pub members: Option<Vec<i64>>,
}

#[derive(ToSchema)]
pub struct AccessGrantWrite {
    /// everyone | group | user
    #[schema(example = "group")]
    pub subject: String,
    /// Group or user id (not for everyone)
    pub id: Option<i64>,
    #[schema(example = "terminal")]
    pub feature: String,
    /// allow | deny | inherit (removes the setting)
    #[schema(example = "deny")]
    pub value: String,
}

// ---------------------------------------------------------------- toolbox (command snippets)

/// 片段要問的變數。秘密變數沒有預設值（值永遠不存）。/ A variable a snippet asks for; a secret one never has a default.
#[derive(ToSchema)]
pub struct SnippetVariable {
    /// `$name` / `${name}` 裡的名稱。/ The name used as `$name` / `${name}`.
    pub name: String,
    pub label: String,
    pub default: String,
    pub secret: bool,
}

/// 工具箱裡的一個指令片段。/ A command snippet in the toolbox.
#[derive(ToSchema)]
pub struct Snippet {
    pub id: i64,
    /// user（自己的）/ tunnel（這條隧道的）/ site（全站）。/ user (your own), tunnel (this tunnel's) or site (site-wide).
    pub scope: String,
    pub tunnel_id: Option<i64>,
    pub name: String,
    pub command: String,
    pub description: String,
    pub variables: Vec<SnippetVariable>,
    /// 送出前先問一次。/ Ask before running.
    pub confirm: bool,
    pub sort_order: i64,
    pub use_count: i64,
    pub last_used_at: Option<String>,
    /// 你能不能改它。/ Whether you may change it.
    pub can_edit: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(ToSchema)]
pub struct SnippetTunnel {
    pub id: i64,
    pub name: String,
    /// 能用這條隧道的片段（能開它的終端機）。/ May use this tunnel's snippets (can open its terminal).
    pub can_use: bool,
    /// owner / ADMIN：能新增 / 修改它的片段。/ Owner / ADMIN: may add and change its snippets.
    pub can_edit: bool,
}

/// `GET /api/snippets`：自己的 + 那條隧道的 + 全站的。/ Your own + that tunnel's + site-wide.
#[derive(ToSchema)]
pub struct SnippetList {
    pub snippets: Vec<Snippet>,
    /// 帶了 `tunnel_id` 才有。/ Present with `tunnel_id`.
    pub tunnel: Option<SnippetTunnel>,
    pub can_edit_site: bool,
    /// 每個範圍最多幾個。/ Snippets per scope at most.
    pub limit: i64,
}

/// 新增或修改片段（修改時只帶要改的欄位；`scope` / `tunnel_id` 只在新增時用）。
/// Create or change a snippet (send only what changes on PATCH; `scope` / `tunnel_id` only on create).
#[derive(ToSchema)]
pub struct SnippetInput {
    /// user（預設）/ tunnel / site
    pub scope: Option<String>,
    pub tunnel_id: Option<i64>,
    /// ≤ 60
    pub name: Option<String>,
    /// ≤ 4000；多行 = 每行一個 Enter。/ ≤ 4000; several lines = one Enter each.
    pub command: Option<String>,
    pub description: Option<String>,
    /// ≤ 20
    pub variables: Option<Vec<SnippetVariable>>,
    pub confirm: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(ToSchema)]
pub struct SnippetUse {
    pub id: i64,
    pub use_count: i64,
    pub last_used_at: Option<String>,
}

// ---------------------------------------------------------------- groups

/// 我的通道群組（照我排的順序）；改動回傳整份。/ My tunnel groups, in my order; every write answers the whole list.
#[derive(ToSchema)]
pub struct TunnelGroups {
    pub groups: Vec<TunnelGroup>,
    /// The group just created or changed (null for list / delete / reorder)
    pub group: Option<TunnelGroup>,
}

#[derive(ToSchema)]
pub struct TunnelGroup {
    pub id: i64,
    #[schema(example = "Production")]
    pub name: String,
    /// Free text, up to 500 characters ("" = none)
    #[schema(example = "Customer-facing web servers")]
    pub description: String,
    /// Same rules as tunnel labels: lowercase, sorted, up to 12
    #[schema(example = json!(["env=prod", "web"]))]
    pub labels: Vec<String>,
    pub position: i64,
    /// Tunnels in it that I can see
    pub tunnel_ids: Vec<i64>,
    pub created_at: String,
}

#[derive(ToSchema)]
pub struct TunnelGroupWrite {
    /// 1–48 characters, unique among your groups (ignoring case)
    #[schema(example = "Production")]
    pub name: String,
    pub description: Option<String>,
    pub labels: Option<Vec<String>>,
    /// Tunnels to move into it (out of any other group)
    pub tunnel_ids: Option<Vec<i64>>,
}

/// Only the fields given change; `description` / `labels` null clears them.
#[derive(ToSchema)]
pub struct GroupUpdate {
    pub name: Option<String>,
    /// Up to 500 characters
    pub description: Option<String>,
    /// Same rules as tunnel labels (up to 12)
    pub labels: Option<Vec<String>>,
}

/// Group ids in the new order; groups not listed keep their order after them.
#[derive(ToSchema)]
pub struct GroupOrder {
    pub ids: Vec<i64>,
}

/// The whole member list: listed tunnels move in, former members not listed become ungrouped.
#[derive(ToSchema)]
pub struct TunnelGroupMembers {
    pub tunnel_ids: Vec<i64>,
}

#[derive(ToSchema)]
pub struct TunnelGroupChoice {
    /// One of your tunnel groups, or null to take the tunnel out of its group
    pub group_id: Option<i64>,
}

/// 我的金鑰群組（依名稱）；改動回傳整份。/ My key groups by name; every write answers the whole list.
#[derive(ToSchema)]
pub struct KeyGroups {
    pub groups: Vec<KeyGroup>,
    pub group: Option<KeyGroup>,
}

#[derive(ToSchema)]
pub struct KeyGroup {
    pub id: i64,
    #[schema(example = "Laptops")]
    pub name: String,
    pub description: String,
    pub labels: Vec<String>,
    pub key_ids: Vec<i64>,
    pub grants: Vec<KeyGroupGrant>,
    pub created_at: String,
}

/// A key group given to one tunnel or one of your tunnel groups (exactly one is set). Live: keys added to the
/// group and tunnels added to the tunnel group are installed on the next sync, removed ones are taken off.
#[derive(ToSchema)]
pub struct KeyGroupGrant {
    pub id: i64,
    pub tunnel: Option<NamedRef>,
    pub tunnel_group: Option<NamedRef>,
    /// Account names the keys go into (null = every account you may use there)
    pub accounts: Option<Vec<String>>,
    pub created_at: String,
}

#[derive(ToSchema)]
pub struct KeyGroupWrite {
    #[schema(example = "Laptops")]
    pub name: String,
    pub description: Option<String>,
    pub labels: Option<Vec<String>>,
    /// Your keys to move into it (out of any other group)
    pub key_ids: Option<Vec<i64>>,
}

#[derive(ToSchema)]
pub struct KeyGroupMembers {
    pub key_ids: Vec<i64>,
}

#[derive(ToSchema)]
pub struct KeyGroupGrantWrite {
    /// A tunnel you can see (or give `tunnel_group_id`)
    pub tunnel_id: Option<i64>,
    /// One of your tunnel groups (or give `tunnel_id`)
    pub tunnel_group_id: Option<i64>,
    /// Account names to limit it to; null / absent = every account you may use
    #[schema(example = json!(["deploy"]))]
    pub accounts: Option<Vec<String>>,
}

#[derive(ToSchema)]
pub struct KeyGroupGrantAccounts {
    pub accounts: Option<Vec<String>>,
}

// ---------------------------------------------------------------- REST exec sessions (API tokens / connected apps)

#[derive(ToSchema)]
pub struct AiSessionOpen {
    pub tunnel_id: i64,
    /// Device account; omit for the tunnel's default
    pub username: Option<String>,
    pub idle_timeout_s: Option<i64>,
    pub max_lifetime_s: Option<i64>,
}

#[derive(ToSchema)]
pub struct AiExecRequest {
    #[schema(example = "uptime")]
    pub command: String,
    /// Seconds before the command is killed (default 60, max 600)
    pub timeout_s: Option<i64>,
    /// Bytes kept per stream (default 65536, max 1048576)
    pub max_output_bytes: Option<i64>,
}

#[derive(ToSchema)]
pub struct AiExecResult {
    pub exit_code: Option<i64>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub duration_ms: i64,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: i64,
    pub stderr_bytes: i64,
    pub truncated: bool,
}

// ---------------------------------------------------------------- personal API tokens

#[derive(ToSchema)]
pub struct ApiTokenTunnel {
    pub id: i64,
    /// null when the tunnel was deleted
    pub name: Option<String>,
}

#[derive(ToSchema)]
pub struct ApiToken {
    pub id: i64,
    #[schema(example = "ci deploy")]
    pub name: String,
    /// The start of the secret, to recognise it
    #[schema(example = "tpt_Ab12Cd")]
    pub prefix: String,
    #[schema(example = json!(["tunnels:read", "ssh:exec"]))]
    pub scopes: Vec<String>,
    /// null = every tunnel the user can see
    pub tunnels: Option<Vec<ApiTokenTunnel>>,
    pub expires_at: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub last_used_ip: Option<String>,
    pub revoked_at: Option<String>,
    pub expired: bool,
    pub active: bool,
    /// Exec sessions it has open right now
    pub sessions: i64,
    /// Scripted browsers it has open right now
    pub browsers: i64,
    /// Calls made with it since it was created (the call log itself keeps 90 days)
    pub call_count: i64,
    pub calls: ApiCallSummary,
}

#[derive(ToSchema)]
pub struct ApiTokenCreate {
    pub name: String,
    /// Any of tunnels:read, ssh:exec, ssh:files, network:scan, browser:use, tunnels:manage
    pub scopes: Vec<String>,
    /// Tunnel ids, or null for every tunnel the user can see
    pub tunnel_ids: Option<Vec<i64>>,
    /// Required, at most 365 days away: RFC 3339 or YYYY-MM-DD (end of that day, UTC)
    #[schema(example = "2027-01-31")]
    pub expires_at: String,
    /// Second-factor proof, required once the account has a factor (see /api/auth/mfa/reauth/options)
    pub reauth: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct ApiTokenCreated {
    pub token: ApiToken,
    /// The secret (`tpt_…`); shown only in this response
    pub secret: String,
}

// ---------------------------------------------------------------- browser automation (REST form of the MCP browser tools)

#[derive(ToSchema)]
pub struct ApiBrowserTunnel {
    pub id: i64,
    pub name: String,
}

#[derive(ToSchema)]
pub struct ApiBrowser {
    #[schema(example = "aib_3f2a…")]
    pub id: String,
    /// Same as `id` (the MCP tools' name for it)
    pub browser_id: String,
    pub tunnel: ApiBrowserTunnel,
    /// Device account the browser's SOCKS proxy logs in as
    pub username: String,
    pub created_at: String,
    pub last_used_at: String,
    /// End of the maximum lifetime (it closes earlier when idle)
    pub expires_at: String,
    pub idle_timeout_s: i64,
    pub max_lifetime_s: i64,
    pub actions: i64,
    /// Only on open with a url: the page that loaded
    pub page: Option<ApiBrowserPage>,
    /// Only on open with a url that did not load
    pub navigate_error: Option<String>,
}

#[derive(ToSchema)]
pub struct ApiBrowserOpen {
    pub tunnel_id: i64,
    /// Device account; omit for the tunnel's default
    pub username: Option<String>,
    /// http / https (https:// is added when no scheme is given)
    #[schema(example = "http://192.168.1.1/")]
    pub url: Option<String>,
    pub idle_timeout_s: Option<i64>,
    pub max_lifetime_s: Option<i64>,
}

#[derive(ToSchema)]
pub struct ApiBrowserNavigate {
    #[schema(example = "http://192.168.1.1/status")]
    pub url: String,
}

#[derive(ToSchema)]
pub struct ApiBrowserPage {
    pub id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    /// click: what was clicked
    pub clicked: Option<String>,
    /// type: how many characters were typed
    pub typed: Option<i64>,
}

#[derive(ToSchema)]
pub struct ApiBrowserLink {
    pub text: String,
    pub href: String,
}

#[derive(ToSchema)]
pub struct ApiBrowserText {
    pub id: String,
    pub title: String,
    pub url: String,
    pub text: String,
    /// The text was cut at 100,000 characters
    pub truncated: bool,
    pub links: Vec<ApiBrowserLink>,
}

#[derive(ToSchema)]
pub struct ApiBrowserClick {
    /// CSS selector
    pub selector: Option<String>,
    /// Or the visible text of a link, button or label
    pub text: Option<String>,
}

#[derive(ToSchema)]
pub struct ApiBrowserType {
    pub selector: String,
    pub text: String,
    pub press_enter: Option<bool>,
    /// Default true: the audit row only records the length
    pub sensitive: Option<bool>,
}

// ---------------------------------------------------------------- API token call log + endpoint catalogue

#[derive(ToSchema)]
pub struct ApiCallToken {
    pub id: i64,
    pub name: Option<String>,
    pub prefix: Option<String>,
}

#[derive(ToSchema)]
pub struct ApiCallUser {
    pub id: i64,
    pub username: Option<String>,
}

#[derive(ToSchema)]
pub struct ApiCallTunnel {
    pub id: i64,
    /// null when the tunnel is gone or you can't see it
    pub name: Option<String>,
}

#[derive(ToSchema)]
pub struct ApiCall {
    pub id: i64,
    pub at: String,
    pub user: ApiCallUser,
    /// The personal API token; null for a connected app
    pub token: Option<ApiCallToken>,
    /// The connected app (OAuth grant); null for a personal token
    pub grant_id: Option<i64>,
    #[schema(example = "API token \"ci\"")]
    pub client_name: String,
    /// rest | mcp
    pub kind: String,
    /// HTTP method, or MCP for a tool call
    pub method: String,
    /// The route template (e.g. /api/reverse/server/{id}/lan/hosts) or the MCP tool name; never a query string
    pub route: String,
    pub tunnel: Option<ApiCallTunnel>,
    /// HTTP status; MCP tool calls: 200, or 400 when the tool returned an error
    pub status: i64,
    pub duration_ms: i64,
    pub ip: Option<String>,
    /// MCP tool calls: the start of the error the tool returned
    pub error: Option<String>,
}

#[derive(ToSchema)]
pub struct ApiCallPage {
    pub calls: Vec<ApiCall>,
    pub limit: i64,
    /// A full page came back: pass the last id as `before` (or a larger limit) for older rows
    pub has_more: bool,
    /// Admins: calls dropped since startup because the write queue was full; null for others
    pub dropped: Option<i64>,
}

#[derive(ToSchema)]
pub struct ApiCallSummary {
    pub calls_24h: i64,
    pub calls_7d: i64,
    /// Calls with a status of 400 or more in the last 7 days
    pub errors_7d: i64,
    pub last_call_at: Option<String>,
    pub last_status: Option<i64>,
}

#[derive(ToSchema)]
pub struct ApiRoute {
    pub method: String,
    #[schema(example = "/api/reverse/server/{id}/lan/hosts")]
    pub path: String,
    pub tag: String,
    pub summary: String,
    /// An API token may call it
    pub token: bool,
    /// The scope it needs; null = any token (or not reachable)
    pub scope: Option<String>,
    /// path (the id in the path is checked against the token's tunnels), handler (the handler checks), unrestricted (only tokens without a tunnel limit), none; null when not reachable
    pub tunnel: Option<String>,
    /// The feature permission that gates it, if any
    pub feature: Option<String>,
}

#[derive(ToSchema)]
pub struct ApiRouteCatalogue {
    /// PUBLIC_URL, else the origin this request came to
    pub base_url: String,
    pub scopes: Vec<String>,
    pub routes: Vec<ApiRoute>,
}

/// Per-channel values: `toast` (in-app) and / or `desktop` (desktop notification), only the channels the event has
#[derive(ToSchema)]
pub struct NotifyChannels {
    pub toast: Option<bool>,
    pub desktop: Option<bool>,
}

/// One event of the site defaults (`site` value null = built-in on)
#[derive(ToSchema)]
pub struct NotifyDefaultEvent {
    #[schema(example = "tunnel.host_key_changed")]
    pub event: String,
    #[schema(example = "device")]
    pub group: String,
    #[schema(example = "tunnel")]
    pub audience: String,
    /// About a tunnel (tunnel mutes apply)
    pub tunnel: bool,
    /// A status event (online / offline / degraded / recovered)
    pub status: bool,
    #[schema(example = json!(["toast", "desktop"]))]
    pub channels: Vec<String>,
    /// Enforced by an admin: always shown, nobody can turn it off or mute it
    pub locked: bool,
    pub site: NotifyChannels,
}

/// One event of my preferences
#[derive(ToSchema)]
pub struct NotifyPrefEvent {
    pub event: String,
    pub group: String,
    pub audience: String,
    pub tunnel: bool,
    pub status: bool,
    pub channels: Vec<String>,
    pub locked: bool,
    pub site: NotifyChannels,
    /// My override per channel (null = follow the site default)
    pub mine: NotifyChannels,
    /// The result before any tunnel mute
    pub effective: NotifyChannels,
    /// Which layer decided, per channel: locked | mine | site | builtin
    #[schema(value_type = Object)]
    pub source: serde_json::Value,
}

#[derive(ToSchema)]
pub struct NotifyMute {
    pub tunnel_id: i64,
    /// all | status | null (unmuted)
    pub scope: Option<String>,
}

#[derive(ToSchema)]
pub struct NotifyMuteRow {
    pub tunnel_id: i64,
    pub tunnel_name: String,
    /// all | status
    pub scope: String,
}

#[derive(ToSchema)]
pub struct NotifyPreferences {
    pub events: Vec<NotifyPrefEvent>,
    pub mutes: Vec<NotifyMuteRow>,
}

#[derive(ToSchema)]
pub struct NotifyDefaults {
    pub events: Vec<NotifyDefaultEvent>,
}

/// One change: `value` = on | off | inherit (also true / false / null)
#[derive(ToSchema)]
pub struct NotifyChange {
    pub event: String,
    #[schema(example = "toast")]
    pub channel: String,
    #[schema(value_type = String, example = "off")]
    pub value: serde_json::Value,
}

/// PUT body: only the listed event × channel pairs change
#[derive(ToSchema)]
pub struct NotifyPrefsBody {
    pub prefs: Vec<NotifyChange>,
}

#[derive(ToSchema)]
pub struct NotifyLock {
    pub event: String,
    pub locked: bool,
}

/// PUT body (admins): site values (inherit = built-in on) and locks; both optional
#[derive(ToSchema)]
pub struct NotifyDefaultsBody {
    pub defaults: Option<Vec<NotifyChange>>,
    pub locks: Option<Vec<NotifyLock>>,
}

#[derive(ToSchema)]
pub struct NotifyMuteBody {
    /// all (default) | status
    pub scope: Option<String>,
}

#[derive(ToSchema)]
pub struct DeviceInstallNames {
    /// systemd unit (`telepy-<install id>.service`)
    pub systemd: String,
    /// launchd label (`com.telepy.tunnel.<install id>`)
    pub launchd: String,
    /// The reconnect loop (`~/.ssh/telepy-<install id>.sh`)
    #[schema(rename = "loop")]
    pub loop_: String,
    pub known_hosts: String,
    /// Docker container name
    pub container: String,
    /// The unit / plist description (the install id only)
    pub description: String,
}

#[derive(ToSchema)]
pub struct DeviceInstallPart {
    /// service | process | cron | container | script | file
    pub kind: String,
    /// systemd / systemd-user / launchd / loop / docker / key / known_hosts / log …
    pub what: String,
    /// Unit, label, container or path
    pub name: String,
    /// The login account whose survey found it
    pub account: String,
    /// Named after this tunnel's install id
    pub private: bool,
    /// One of Telepy's earlier standard names
    pub earlier: bool,
    /// An extra copy: the tunnel already runs from its install-id service and this one would fight it on boot (decided from the key, server and what runs — not the name)
    pub extra: bool,
    /// The deleted tunnel whose install id this name carries (from the ledger); tunnel_id / tunnel_name only when it had the same owner
    pub retired: Option<DeviceInstallRetired>,
}

#[derive(ToSchema)]
pub struct DeviceInstallRetired {
    pub install_id: String,
    pub tunnel_id: Option<i64>,
    pub tunnel_name: Option<String>,
    pub retired_at: String,
}

#[derive(ToSchema)]
pub struct DeviceInstallTidyPlan {
    pub possible: bool,
    /// not_surveyed | windows | nothing_extra | needs_root (null when possible)
    pub blocker: Option<String>,
    /// The extra services / containers that would be removed
    pub names: Vec<String>,
}

#[derive(ToSchema)]
pub struct DeviceInstallOther {
    /// Unit / plist / script file name, or the running ssh command
    pub name: String,
    pub port: Option<u16>,
    pub process: bool,
    pub account: String,
}

#[derive(ToSchema)]
pub struct DeviceInstallRenamePlan {
    pub possible: bool,
    /// not_surveyed | windows | nothing_to_rename | no_process | unparsed | needs_root | unknown_owner | odd_command | unsupported | extra (null when possible)
    pub blocker: Option<String>,
    /// systemd | systemd_user | launchd_daemon | launchd_agent | loop
    pub method: Option<String>,
    /// The login account that installs the new service
    pub account: Option<String>,
    /// The account the tunnel runs as
    pub run_user: Option<String>,
    pub new_name: Option<String>,
    /// Older service names that would be replaced
    pub old: Vec<String>,
}

#[derive(ToSchema)]
pub struct DeviceInstallAccount {
    pub account: String,
    /// posix | windows (null = could not log in)
    pub platform: Option<String>,
    pub os: Option<String>,
    pub error: Option<String>,
}

#[derive(ToSchema)]
#[schema(description = "A tunnel's names on its device (a random install id, so nothing reveals who set it up) and what the last survey found there")]
pub struct DeviceInstall {
    pub install_id: String,
    pub names: DeviceInstallNames,
    pub online: bool,
    /// A rename is running
    pub busy: bool,
    pub surveyed_at: Option<String>,
    pub survey_error: Option<String>,
    pub accounts: Vec<DeviceInstallAccount>,
    pub parts: Vec<DeviceInstallPart>,
    /// Services to rename: neither named after the install id nor one of Telepy's earlier standard names (e.g. a name that shows who set the device up)
    pub older: Vec<String>,
    /// Telepy's earlier standard names (telepy-tunnel-<n>.service, com.telepy.tunnel.<n>, telepy-tunnel.service): fine to keep, may be renamed
    pub earlier: Vec<String>,
    /// Extra copies to remove (the tunnel already runs from its install-id service)
    pub extra: Vec<String>,
    /// Things on the device that dial another server; never touched by delete, survey or rename
    pub others: Vec<DeviceInstallOther>,
    /// The tunnel's key file when another server's tunnel uses it too (kept on delete)
    pub shared_key: Option<String>,
    /// The gateway port this server's devices dial
    pub server_port: String,
    pub rename: DeviceInstallRenamePlan,
    pub tidy: DeviceInstallTidyPlan,
    /// 換連線方式（例如改成自動）。/ Switching how it connects (e.g. to automatic).
    pub switch: DeviceInstallSwitchPlan,
    pub renamed_at: Option<String>,
    pub renamed_from: Vec<String>,
}

#[derive(ToSchema)]
pub struct DeviceInstallStep {
    /// survey | install | standby | check | switch | remove | confirm (removing an extra copy: survey | remove | confirm)
    pub id: String,
    /// done | failed
    pub state: String,
    pub detail: Option<String>,
}

#[derive(ToSchema)]
pub struct DeviceInstallReport {
    /// The new service took over and nothing of the old one is left
    pub ok: bool,
    pub steps: Vec<DeviceInstallStep>,
    /// Failure code: a blocker, survey_failed, login_failed, install_failed, standby_timeout, check_failed, switch_failed, old_left, old_came_back, connection_lost
    pub code: Option<String>,
    pub error: Option<String>,
    pub method: Option<String>,
    pub account: Option<String>,
    pub new_name: Option<String>,
    pub old: Vec<String>,
    /// The new service's last log lines when it did not connect
    pub log: Option<String>,
}

/// `POST …/device-install/switch` 的內容。/ The switch request.
#[derive(ToSchema)]
pub struct DeviceInstallSwitchRequest {
    /// `auto`（SSH port 優先，被擋時走網頁 port）/ `websocket`（只走網頁 port）/ `ssh`（只走 SSH port）。
    #[schema(example = "auto")]
    pub transport: String,
}

/// 換連線方式能不能做、現在怎麼設定的。/ Whether a switch is possible, and how the device is set up now.
#[derive(ToSchema)]
pub struct DeviceInstallSwitchPlan {
    pub possible: bool,
    /// 不能做的原因（同改名的 blocker）。/ Why not (the rename's blockers).
    pub blocker: Option<String>,
    /// 隧道的 `way_in`（`ssh` / `websocket` / `auto`；null = 不知道）。/ The tunnel's way in.
    pub way_in: Option<String>,
    /// 會被換掉的服務（現在跑這條隧道的）。/ The services a switch replaces (what runs the tunnel now).
    pub old: Option<Vec<String>>,
}

#[derive(ToSchema)]
pub struct DeviceInstallRename {
    pub report: DeviceInstallReport,
    pub view: DeviceInstall,
}

/// `GET /api/site/ssh-host`：網頁與 SSH 的名稱各解析到哪裡、有沒有走 Cloudflare 的代理（管理員）。
/// Where the web and SSH names resolve and whether either sits on Cloudflare's proxy (superusers).
#[derive(ToSchema)]
pub struct SshHostCheck {
    pub ssh: SshHostName,
    pub web: SshHostName,
    /// SSH 與網頁是同一個名稱。/ SSH and the web use the same name.
    pub same: bool,
    /// `local` / `unresolved` / `ssh_proxied`（裝置連不到）/ `split` / `same` / `separate`。
    #[schema(example = "split")]
    pub verdict: String,
}

#[derive(ToSchema)]
pub struct SshHostName {
    #[schema(example = "telepy-ssh.example.com")]
    pub host: String,
    #[schema(example = json!(["203.0.113.10"]))]
    pub addresses: Vec<String>,
    /// 有位址落在 Cloudflare 的範圍。/ An address is in Cloudflare's ranges.
    pub cloudflare: bool,
    /// 解析失敗的原因。/ Why the lookup failed.
    pub error: Option<String>,
    /// SSH：gateway 對外的 port。/ SSH only: the gateway's public port.
    #[schema(example = "56767")]
    pub port: Option<String>,
    /// SSH：`env` / `setting` / `web`（沒另外設，跟網頁同一個）。/ SSH only: where the name comes from.
    #[schema(example = "env")]
    pub source: Option<String>,
    /// 網頁：`public_url` / `request`。/ Web only: where the name comes from.
    pub from: Option<String>,
    /// 網頁：這次請求帶著 Cloudflare 的標頭。/ Web only: this request carried Cloudflare's headers.
    pub via_cloudflare: Option<bool>,
    /// 網頁：DNS 或標頭顯示走 Cloudflare 的代理。/ Web only: DNS or headers say it is proxied by Cloudflare.
    pub proxied: Option<bool>,
}

/// `GET /api/site/address-sources`：「PROXY protocol 來源」的選項（管理員）。/ Options for PROXY protocol sources (superusers).
#[derive(ToSchema)]
pub struct AddressSources {
    /// gateway 從何時開始記（後端啟動的時間）。/ When the gateway started counting (backend start).
    #[schema(example = "2026-10-30T01:02:03Z")]
    pub since: String,
    /// 送過 PROXY header、內網或已列出的位址，送過 header 的在前。/ Header senders, private and listed addresses; header senders first.
    pub peers: Vec<AddressSourcePeer>,
    /// 其他公網位址（裝置或掃描器）的數量，不列出。/ How many other public addresses (devices or scanners) were seen, not listed.
    pub other_public: u64,
    pub presets: Vec<AddressSourcePreset>,
}

#[derive(ToSchema)]
pub struct AddressSourcePeer {
    #[schema(example = "10.0.0.5")]
    pub ip: String,
    /// public / private / loopback / link_local / shared_nat / reserved
    #[schema(example = "private")]
    pub scope: String,
    /// 送了資料的連線數。/ Connections that sent data.
    pub connections: u64,
    /// 其中開頭是 PROXY protocol header 的。/ Of those, the ones that began with a PROXY protocol header.
    pub proxy_headers: u64,
    pub first_at: String,
    pub last_at: String,
    pub last_header_at: Option<String>,
    /// 現在是不是 PROXY protocol 來源（沒列出的 header 從不被讀）。/ Whether it is a source now (an unlisted one's header is never read).
    pub listed: bool,
}

#[derive(ToSchema)]
pub struct AddressSourcePreset {
    /// loopback / private / cloudflare
    #[schema(example = "private")]
    pub id: String,
    pub cidrs: Vec<String>,
}

/// `GET /api/site/health/stats`：伺服器狀態頁的數字（管理員）。/ The Server health page's numbers (superusers).
#[derive(ToSchema)]
pub struct ServerStats {
    pub server: ServerStatsServer,
    pub tunnels: ServerStatsTunnels,
    pub gateway: ServerStatsGateway,
    pub sessions: ServerStatsSessions,
    pub users: ServerStatsUsers,
    pub storage: ServerStatsStorage,
    pub activity: ServerStatsActivity,
    pub webhooks: ServerStatsWebhooks,
}

#[derive(ToSchema)]
pub struct ServerStatsServer {
    /// 發行版建置蓋上的版本；本機建的是 null。/ The release version stamped at build time; null for local builds.
    #[schema(example = "2.9.0")]
    pub version: Option<String>,
    /// When this backend process started
    #[schema(example = "2026-10-30T01:02:03Z")]
    pub started_at: String,
    pub uptime_secs: i64,
    #[schema(example = "2026-10-30T05:06:07Z")]
    pub now: String,
}

/// Tunnels per health, the same classification as list items' `health`
#[derive(ToSchema)]
pub struct ServerStatsTunnels {
    pub total: i64,
    pub online: i64,
    pub degraded: i64,
    pub offline: i64,
    pub never: i64,
}

#[derive(ToSchema)]
pub struct ServerStatsGateway {
    /// Authenticated SSH connections to the gateway now (devices and laptops)
    pub connections: i64,
    /// Registered reverse forwards now
    pub forwards: i64,
}

#[derive(ToSchema)]
pub struct ServerStatsSessions {
    pub total: i64,
    pub by_kind: ServerStatsSessionKinds,
}

/// Live sessions per presence kind (every kind is present, 0 when none)
#[derive(ToSchema)]
pub struct ServerStatsSessionKinds {
    pub terminal: i64,
    pub files: i64,
    pub browser: i64,
    pub desktop: i64,
    pub rustdesk: i64,
    /// A laptop's ssh through the gateway
    pub ssh: i64,
    /// Watching someone's web terminal
    pub watch: i64,
    /// MCP agent SSH sessions
    pub ai: i64,
}

#[derive(ToSchema)]
pub struct ServerStatsUsers {
    pub total: i64,
    pub active: i64,
    /// Active superusers
    pub admins: i64,
    /// Distinct accounts with a successful sign-in in the last 24 hours
    pub signed_in_24h: i64,
}

#[derive(ToSchema)]
pub struct ServerStatsStorage {
    pub db_bytes: i64,
    /// The SQLite write-ahead log (0 when absent)
    pub wal_bytes: i64,
    /// The data directory's filesystem; null when it can't be read
    pub data_dir: Option<ServerStatsDisk>,
    /// Sum of `DATA_DIR/recordings`; null when unreadable
    pub recordings_bytes: Option<i64>,
    /// The walk stopped after 20000 entries, so `recordings_bytes` is a lower bound
    pub recordings_truncated: bool,
    /// Sum of `LOG_ROOT`; null when unreadable
    pub logs_bytes: Option<i64>,
    pub logs_truncated: bool,
}

#[derive(ToSchema)]
pub struct ServerStatsDisk {
    #[schema(example = "/data")]
    pub path: String,
    pub free_bytes: i64,
    pub total_bytes: i64,
}

/// The last 24 hours in hourly buckets, oldest first; bucket i covers [hours[i], hours[i] + 1 h)
#[derive(ToSchema)]
pub struct ServerStatsActivity {
    /// Each bucket's start (24, RFC 3339 Z)
    pub hours: Vec<String>,
    pub gateway_events: Vec<i64>,
    /// Gateway events of the Logs page's "needs attention" kinds (refused, failed_publickey, invalid_user, expired_key, host_key_mismatch, claim_*, device_warning, degraded, step_up_required, command_blocked)
    pub gateway_problems: Vec<i64>,
    pub sign_ins: Vec<i64>,
    pub sign_ins_failed: Vec<i64>,
    /// Delegated (API token / CLI sign-in) calls from the call log
    pub api_calls: Vec<i64>,
    /// Calls with status >= 400 or an error
    pub api_errors: Vec<i64>,
}

#[derive(ToSchema)]
pub struct ServerStatsWebhooks {
    pub total: i64,
    pub enabled: i64,
    pub paused: i64,
    /// Webhooks with a failed (non-test) delivery in the last 24 hours
    pub failing_recent: i64,
}
