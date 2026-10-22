//! `/api/reverse/issue/token`、`/api/reverse/create/key/{token}`、`/create/key/duplicate/{token}`
//! （reverse_keys app：精靈與金鑰頁以一次性 token 建立隧道）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::notify;
use super::serialize::is_valid_ssh_public_key;
use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::NewTunnel};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::monitor::{find_free_port, loopback_bindable};
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

#[utoipa::path(post, path = "/api/reverse/create/key/{token}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("token" = String, Path, description = "Token from /api/reverse/issue/token")), request_body = super::schemas::CreateKeyRequest, responses((status = 200, description = "Tunnel created; reverse_port allocated", body = super::schemas::CreatedKey), (status = 400, description = "Invalid token, name, key or duplicate", body = super::schemas::ErrorBody)))]
async fn create_key(State(state): State<AppState>, _user: AuthUser, Path(token): Path<String>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let user = token_user(&state, &token).await?;
    let name = json_str(&body, "host_friendly_name").filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request("Host friendly name is required"))?;
    if !name.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
        return Err(ApiError::bad_request("Host friendly name cannot start with a number."));
    }
    let key = json_str(&body, "key").filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request("Key is required"))?;
    if !is_valid_ssh_public_key(&key) {
        return Err(ApiError::bad_request("Invalid SSH public key format"));
    }
    let description = json_str(&body, "description").unwrap_or_default();
    let seed = super::device_keys::key_list_choice(&body)?;
    let used = state.status.used_ports(&state.db).await?;
    let port = find_free_port(&used, loopback_bindable).map_err(ApiError::bad_request)?;
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
    let key_exists = db::tunnels::exists_key_for_user(&state.db, user.id, &key).await?;
    let base = json!({ "host_friendly_name_exists": name_exists, "key_exists": key_exists });
    let mut obj = base.as_object().cloned().unwrap();
    let err = match (name_exists, key_exists) {
        (true, true) => Some("Host friendly name and key already exists"),
        (true, false) => Some("Host friendly name already exists"),
        (false, true) => Some("Key already exists"),
        (false, false) => None,
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
