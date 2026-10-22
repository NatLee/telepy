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
    /// A passkey or an authenticator app is set up
    pub mfa_enabled: bool,
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
}

#[derive(ToSchema)]
pub struct TunnelWrite {
    pub host_friendly_name: String,
    pub key: String,
    pub reverse_port: i64,
    pub description: Option<String>,
    pub default_username: Option<i64>,
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
}

#[derive(ToSchema)]
pub struct UserKeyWrite {
    pub host_friendly_name: String,
    pub key: String,
    pub description: Option<String>,
}

#[derive(ToSchema)]
pub struct UserKeyPatch {
    pub description: Option<String>,
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
    pub key_exists: bool,
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
}

#[derive(ToSchema)]
pub struct SharedUser {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub permission_type: String,
    pub shared_at: String,
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
}

#[derive(ToSchema)]
pub struct UserSettingsPatch {
    #[schema(example = "auto")]
    pub language: Option<String>,
    #[schema(example = "dark")]
    pub theme: Option<String>,
    pub terminal_font_size: Option<i64>,
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
