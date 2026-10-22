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
    /// Empty list = only self-created usernames
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

#[derive(ToSchema)]
pub struct PushAck {
    pub status: String,
    pub ports: i64,
}
