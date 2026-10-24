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

#[derive(ToSchema)]
pub struct AccessToken {
    pub access_token: String,
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
    /// Terminal colour-scheme id (the frontend's list; default `telepy`)
    #[schema(example = "telepy")]
    pub terminal_scheme: String,
    /// A passkey or an authenticator app is set up
    pub mfa_enabled: bool,
    /// Second factors the administrator requires that this account has not set up yet (`totp`, `passkey`).
    /// While non-empty, every other REST route answers 403 `mfa_enrollment_required`.
    #[schema(example = json!(["totp"]))]
    pub mfa_missing: Vec<String>,
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
    #[schema(example = "ssh-ed25519 AAAA… device")]
    pub key: String,
    pub reverse_port: i64,
    pub description: Option<String>,
    #[schema(example = "2026-02-22T17:04:12.123456+08:00")]
    pub created_at: String,
    pub updated_at: String,
    pub user: i64,
    pub default_username: Option<i64>,
    /// 只有列表（`/keys`、`/dashboard`）帶：裝置的公網 IP。看不到（只看狀態的 sharee）或從沒連過時是 null。
    /// List / dashboard only: the device's public IP; null when hidden (status-only sharee) or never connected.
    pub endpoint: Option<TunnelEndpoint>,
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
    /// 只有列表帶：被分享給我、而且有期限時，我的存取到什麼時候（UTC）；否則 null。
    /// List / dashboard only: when my access ends, for a timed share with me; otherwise null.
    pub share_expires_at: Option<String>,
    /// 只有列表帶：owner / ADMIN 看得到還在等的存取申請數；其他人 0。/ List only: pending access requests (owner / ADMIN; else 0).
    pub access_requests: Option<i64>,
    /// 開 session 前要 step-up（`POST /api/auth/step-up`，token 放 `X-Telepy-Step-Up` 或 WebSocket auth 的 `step_up`）。
    /// Sessions need a step-up first (token in `X-Telepy-Step-Up` or the WebSocket auth field `step_up`).
    pub require_step_up: bool,
    /// 網頁終端機會錄影（`PUT /api/reverse/server/{id}/recording`）。/ Web terminal sessions are recorded.
    pub record_sessions: bool,
    /// 只有列表帶：隧道標籤（大家共用）。/ List / dashboard only: the tunnel's labels (shared).
    #[schema(example = json!(["home", "env=prod"]))]
    pub labels: Option<Vec<String>>,
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
    pub geo: Option<IpGeo>,
    /// 最近一次換 IP 之前的位址（從沒換過是 null）。/ The address before the latest change; null if it never changed.
    #[schema(example = "198.51.100.20")]
    pub previous_ip: Option<String>,
    pub changed_at: Option<String>,
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
    pub usernames: Vec<UsernameEntry>,
    pub default_username_id: Option<i64>,
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
}

#[derive(ToSchema)]
pub struct UserKeyPatch {
    pub description: Option<String>,
    /// 續期或改到期時間（null = 不到期，站台有上限時不允許）。/ Renew or change the expiry (null = never, refused under a site limit).
    pub expires_at: Option<String>,
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
    pub host_friendly_name_exists: bool,
    /// The key cannot be used: it is any user's device key already (comment ignored), a personal key, or Telepy's service key
    pub key_exists: bool,
    /// Why: taken | personal | service (null when the key is free)
    pub key_reason: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------- scripts

#[derive(ToSchema)]
pub struct ConfigResponse {
    pub config: String,
    pub usernames: Vec<UsernameEntry>,
    /// `Host telepy-ssh-server` 的連線資訊。/ Where `Host telepy-ssh-server` points.
    pub server: ConfigServer,
    /// config 裡每個裝置 Host 區塊（依 username_id 篩選後）。/ One entry per device Host stanza in `config`.
    pub hosts: Vec<ConfigHost>,
    #[schema(example = 10022)]
    pub reverse_port: i64,
}

#[derive(ToSchema)]
pub struct ConfigServer {
    #[schema(example = "telepy-ssh-server")]
    pub alias: String,
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
}

/// PUT body: a missing or null field means "follow my default"; all three null removes the override
#[derive(ToSchema)]
pub struct TerminalProfilePatch {
    pub font: Option<String>,
    pub font_size: Option<i64>,
    pub scheme: Option<String>,
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
    /// `{field: {label, description, type}}`
    #[schema(value_type = Object)]
    pub meta: serde_json::Value,
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
    pub message: String,
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

#[derive(ToSchema)]
pub struct RemoteBrowserStartRequest {
    /// Target username; omitted = the tunnel's default (or first allowed) username
    pub username: Option<String>,
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
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(ToSchema)]
pub struct SavedCredentialCreate {
    pub label: String,
    pub protocol: String,
    pub tunnel_id: i64,
    pub lan_host_id: Option<i64>,
    pub port: Option<u16>,
    pub login: Option<String>,
    pub domain: Option<String>,
    pub password: String,
}

#[derive(ToSchema)]
pub struct SavedCredentialUpdate {
    pub label: Option<String>,
    pub port: Option<u16>,
    pub login: Option<String>,
    pub domain: Option<String>,
    /// Leave out to keep the current password
    pub password: Option<String>,
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
    /// Effective clipboard policy: both | to_remote | off
    pub clipboard: String,
    /// Quality preset in effect: auto | speed | sharp
    pub quality: String,
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
    pub grant_id: i64,
    pub tunnel: AiTunnelRef,
    /// Target username on the device
    pub username: String,
    pub created_at: String,
    pub last_used_at: String,
    /// End of the maximum lifetime (it may close earlier when idle)
    pub expires_at: String,
    pub idle_timeout_s: i64,
    pub commands: i64,
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
    pub added_by: String,
    pub created_at: String,
    /// One per OS account the key's owner may use on this device
    pub targets: Vec<DeviceKeyTarget>,
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
}

/// A device's key list. Owners and ADMIN sharees see every entry and pending removals; other sharees see their own.
#[derive(ToSchema)]
pub struct DeviceKeys {
    pub tunnel: DeviceKeyTunnel,
    /// Per-account merged view: the list × what Telepy installed × the file as last read
    pub view: DeviceKeyView,
    /// Owner or ADMIN sharee
    pub can_manage: bool,
    /// OS accounts the caller may use here (their keys go into exactly these)
    pub accounts: Vec<String>,
    pub entries: Vec<DeviceKeyEntry>,
    /// Keys Telepy installed that must go (access revoked, key deleted …), removed once the device is online
    pub removals: Vec<DeviceKeyRemoval>,
    pub sync: Vec<DeviceKeySync>,
    pub my_keys: Vec<MyKeyChoice>,
}

#[derive(ToSchema)]
pub struct DeviceKeyView {
    pub accounts: Vec<DeviceKeyViewAccount>,
}

#[derive(ToSchema)]
pub struct DeviceKeyViewAccount {
    pub username: String,
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
}

#[derive(ToSchema)]
pub struct DeviceKeysAdd {
    /// Ids of your own keys to add to the device's list
    pub user_key_ids: Vec<i64>,
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
    pub targets: Vec<DeviceKeyTarget>,
}

/// One device you can use, with the state of your keys on it (keys-page matrix).
#[derive(ToSchema)]
pub struct KeyDevice {
    pub tunnel_id: i64,
    pub host_friendly_name: String,
    pub online: bool,
    pub role: String,
    pub accounts: Vec<String>,
    /// Your keys that are in this device's list
    pub keys: Vec<KeyDeviceKey>,
}

#[derive(ToSchema)]
pub struct JoinRequest {
    /// Tunnel name to use (default: the device's hostname)
    pub name: Option<String>,
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
    /// This machine's SSH host keys (`type base64`, from ssh-keyscan). Pinned at once; a machine another account's tunnel already pins is refused (409)
    pub host_keys: Option<Vec<String>>,
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
    pub online: bool,
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
    /// terminal / files / browser / desktop / ssh / ai
    #[schema(example = "terminal")]
    pub kind: String,
    pub ip: Option<String>,
    pub geo: Option<IpGeo>,
    pub since: String,
    /// MCP app name
    pub client: Option<String>,
    pub mine: bool,
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

// ---------------------------------------------------------------- command rules

/// 一條指令規則。/ A command rule.
#[derive(ToSchema)]
pub struct CommandRule {
    pub id: i64,
    /// None = 全站規則。/ None = a site-wide rule.
    pub tunnel_id: Option<i64>,
    /// site / tunnel
    pub scope: String,
    /// block / approve
    pub action: String,
    /// command（程式 + 必要參數）/ regex（整行）。/ command (program + required arguments) or regex (whole line).
    pub kind: String,
    pub pattern: String,
    /// everyone / sharees（只管不能核准的人）。/ everyone, or sharees (people who can't approve).
    pub who: String,
    /// all / terminal / agents
    pub via: String,
    pub note: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 新增或修改規則（修改時只帶要改的欄位）。/ Create or change a rule (send only what changes on PATCH).
#[derive(ToSchema)]
pub struct CommandRuleInput {
    pub action: Option<String>,
    pub kind: Option<String>,
    pub pattern: Option<String>,
    pub who: Option<String>,
    pub via: Option<String>,
    pub note: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(ToSchema)]
pub struct CommandRuleList {
    pub rules: Vec<CommandRule>,
    pub can_edit: bool,
}

#[derive(ToSchema)]
pub struct TunnelCommandRules {
    pub tunnel: UserRef,
    pub rules: Vec<CommandRule>,
    /// 也適用的全站規則。/ Site-wide rules that apply as well.
    pub site_rules: Vec<CommandRule>,
    pub can_edit: bool,
    pub can_edit_site: bool,
}

#[derive(ToSchema)]
pub struct CommandCheckInput {
    pub command: String,
    /// 不帶 = 只看全站規則。/ Omit to check the site-wide rules only.
    pub tunnel_id: Option<i64>,
    /// terminal（預設）/ agent。/ terminal (default) or agent.
    pub source: Option<String>,
    /// 還沒存的規則 `{kind, pattern}`。/ An unsaved rule `{kind, pattern}`.
    #[schema(value_type = Option<Object>)]
    pub rule: Option<serde_json::Value>,
}

#[derive(ToSchema)]
pub struct CommandVerdict {
    /// allow / block / approve
    pub action: String,
    #[schema(value_type = Option<Object>)]
    pub rule: Option<serde_json::Value>,
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
    /// {id, pattern, kind, scope, note}
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
