//! `/api/reverse/issue/token`、`/api/reverse/create/key/{token}`、`/create/key/duplicate/{token}`
//! （reverse_keys app：精靈與金鑰頁以一次性 token 建立隧道）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::notify;
use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::NewTunnel};
use crate::device_keys::authorized_keys::{parse_public_key, weak_key_reason};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::monitor::find_free_port;
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::{json_str, now_iso_naive};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(issue_token))
        .routes(routes!(create_key))
        .routes(routes!(check_duplicate))
}

#[utoipa::path(get, path = "/api/reverse/issue/token", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, description = "One-time token (10 minutes) for creating a tunnel key", body = super::schemas::IssuedToken)))]
async fn issue_token(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let token = state.tokens.issue_token(user.id);
    Ok(Json(json!({
        "token": token,
        "issuer": { "id": user.id, "username": user.username },
        "created_at": now_iso_naive(),
    })))
}

async fn token_user(state: &AppState, token: &str) -> ApiResult<db::users::User> {
    if token.is_empty() {
        return Err(ApiError::bad_request("Token is required"));
    }
    let uid = state.tokens.issue_token_user(token).ok_or_else(|| ApiError::bad_request("Invalid or expired token"))?;
    db::users::by_id(&state.db, uid).await?.ok_or_else(|| ApiError::bad_request("Invalid or expired token"))
}

/// 為什麼這把公鑰不能當裝置金鑰。/ Why a public key cannot become a device key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyProblem {
    /// 格式不對或太弱。/ Garbage or a weak key.
    Invalid(&'static str),
    /// 已經是某條隧道的金鑰（不看註解、不分誰的）。/ Already a tunnel's key (any user, comment ignored).
    Taken,
    /// 是某人的個人金鑰。/ Someone's personal key.
    Personal,
    /// 是 Telepy 自己的服務金鑰。/ Telepy's own service key.
    Service,
}

impl KeyProblem {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::Taken => "taken",
            Self::Personal => "personal",
            Self::Service => "service",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::Invalid(reason) => reason,
            Self::Taken => "This key is already registered as a device key. Each device needs its own key pair.",
            Self::Personal => "This is a personal key. A device needs its own key pair (ssh-keygen -t ed25519 on the device).",
            Self::Service => "This is Telepy's own service key. A device needs its own key pair.",
        }
    }
}

/// 裝置金鑰的檢查：格式、強度，而且不能是任何人的隧道金鑰、個人金鑰或服務金鑰（都不看註解）。
/// 不分誰的，因為公鑰不是祕密：別人拿你裝置的公鑰換個註解就能在自己帳號下登記，gateway 只認金鑰，
/// 先登記的那條隧道就會被當成那台裝置。
/// Format, strength, and not any user's tunnel key, personal key or the service key (comments ignored): public
/// keys are not secret, and the gateway identifies a connection by its key alone.
pub async fn device_key_problem(state: &AppState, key: &str) -> ApiResult<Option<KeyProblem>> {
    let Some(parsed) = parse_public_key(key) else { return Ok(Some(KeyProblem::Invalid("Invalid SSH public key format"))) };
    if let Some(reason) = weak_key_reason(&parsed) {
        return Ok(Some(KeyProblem::Invalid(reason)));
    }
    let like = db::tunnels::like_prefix(&parsed.bare);
    if db::tunnels::by_key_prefix(&state.db, &like).await?.is_some() {
        return Ok(Some(KeyProblem::Taken));
    }
    if db::keys::user_key_bare_taken(&state.db, &like, None).await? {
        return Ok(Some(KeyProblem::Personal));
    }
    let service = db::keys::service_keys(&state.db).await?;
    if service.iter().any(|s| parse_public_key(&s.key).is_some_and(|p| p.bare == parsed.bare)) {
        return Ok(Some(KeyProblem::Service));
    }
    Ok(None)
}

#[utoipa::path(post, path = "/api/reverse/create/key/{token}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("token" = String, Path, description = "Token from /api/reverse/issue/token")), request_body = super::schemas::CreateKeyRequest, responses((status = 200, description = "Tunnel created; reverse_port allocated", body = super::schemas::CreatedKey), (status = 400, description = "Invalid token, name, key or duplicate", body = super::schemas::ErrorBody)))]
async fn create_key(State(state): State<AppState>, _user: AuthUser, Path(token): Path<String>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let user = token_user(&state, &token).await?;
    let name = json_str(&body, "host_friendly_name").filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request("Host friendly name is required"))?;
    if !name.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
        return Err(ApiError::bad_request("Host friendly name cannot start with a number."));
    }
    let key = json_str(&body, "key").filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request("Key is required"))?;
    if let Some(problem) = device_key_problem(&state, &key).await? {
        return Err(ApiError::bad_request(problem.message()));
    }
    let description = json_str(&body, "description").unwrap_or_default();
    let seed = super::device_keys::key_list_choice(&body)?;
    let used = state.status.used_ports(&state.db).await?;
    let port = find_free_port(&used).map_err(ApiError::bad_request)?;
    let t = db::tunnels::create(
        &state.db,
        NewTunnel { user_id: user.id, host_friendly_name: &name, key: &key, reverse_port: port, description: Some(&description), default_username_id: None },
    )
    .await
    .map_err(|e| if is_unique_violation(&e) { ApiError::bad_request(crate::error::db_error_message(&e)) } else { ApiError::from(e) })?;
    state.tokens.remove_issue_token(&token);
    if seed {
        super::device_keys::seed_key_list(&state, t.id, user.id).await?;
    }
    notify::tunnel_updated(&state, &t).await?;
    Ok(Json(json!({
        "id": t.id,
        "host_friendly_name": t.host_friendly_name,
        "key": t.key,
        "port": state.config.reverse_server_ssh_port,
        "issuer": { "id": user.id, "username": user.username },
        "reverse_port": t.reverse_port,
        "description": t.description,
    })))
}

#[utoipa::path(post, path = "/api/reverse/create/key/duplicate/{token}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("token" = String, Path, description = "Token from /api/reverse/issue/token")), request_body = super::schemas::DuplicateCheckRequest, responses((status = 200, description = "Name and key are free", body = super::schemas::DuplicateCheck), (status = 400, description = "Name and/or key already used", body = super::schemas::DuplicateCheck)))]
async fn check_duplicate(State(state): State<AppState>, _user: AuthUser, Path(token): Path<String>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let user = token_user(&state, &token).await?;
    let name = json_str(&body, "host_friendly_name").filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request("Host friendly name is required"))?;
    let key = json_str(&body, "key").filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request("Key is required"))?;
    let name_exists = db::tunnels::exists_name_for_user(&state.db, user.id, &name).await?;
    // `key_exists` = 這把不能用（別人的裝置金鑰、個人金鑰、服務金鑰、格式錯 / 太弱），`key_reason` 說為什麼。
    // `key_exists` = the key cannot be used; `key_reason` says why.
    let problem = device_key_problem(&state, &key).await?;
    let key_exists = problem.is_some();
    let base = json!({ "host_friendly_name_exists": name_exists, "key_exists": key_exists, "key_reason": problem.as_ref().map(KeyProblem::code) });
    let mut obj = base.as_object().cloned().unwrap();
    let err = match (name_exists, &problem) {
        (true, Some(KeyProblem::Taken)) => Some("Host friendly name and key already exists".to_string()),
        (true, Some(p)) => Some(format!("Host friendly name already exists. {}", p.message())),
        (true, None) => Some("Host friendly name already exists".to_string()),
        (false, Some(KeyProblem::Taken)) => Some("Key already exists".to_string()),
        (false, Some(p)) => Some(p.message().to_string()),
        (false, None) => None,
    };
    match err {
        Some(e) => {
            obj.insert("error".into(), json!(e));
            Err(ApiError::new(StatusCode::BAD_REQUEST, Value::Object(obj)))
        }
        None => {
            obj.insert("message".into(), json!("Host friendly name and key are not used"));
            Ok(Json(Value::Object(obj)))
        }
    }
}
