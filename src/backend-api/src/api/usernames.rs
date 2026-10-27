//! `/api/reverse/server/usernames`：目標主機使用者名稱 ViewSet（`ReverseServerUsernamesViewSet`）。
//! 新增 / 改 / 刪只有隧道擁有者與 ADMIN 分享者能做；其他被分享者能用哪些帳號由擁有者 / ADMIN 的允許清單決定
//! （見 `permissions::allowed_usernames`）。同一條隧道上名字不重複（不分建立者）。
//! Only the owner and ADMIN sharees manage a tunnel's target OS accounts; names are unique per tunnel.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::notify;
use super::serialize::username_json;
use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Username};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::{json_i64, json_str};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, create))
        .routes(routes!(retrieve, update, replace, destroy))
}

#[utoipa::path(get, path = "/api/reverse/server/usernames", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, description = "Usernames you created plus all usernames on tunnels shared with you", body = Vec<super::schemas::Username>)))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let rows = db::tunnels::usernames_visible_to(&state.db, user.id).await?;
    let tz = state.config.tz_offset_minutes;
    Ok(Json(Value::Array(rows.iter().map(|u| username_json(u, tz)).collect())))
}

/// get_object()：自己建立的、或分享給我的隧道上的。
async fn visible_username(state: &AppState, user_id: i64, id: i64) -> ApiResult<Username> {
    let u = db::tunnels::username_by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    if u.user_id == user_id {
        return Ok(u);
    }
    if db::sharing::get(&state.db, u.reverse_server_id, user_id).await?.is_some() {
        return Ok(u);
    }
    Err(ApiError::drf_not_found())
}

#[utoipa::path(post, path = "/api/reverse/server/usernames", tag = "Reverse Server Keys", security(("bearer" = [])), request_body = super::schemas::UsernameWrite, responses((status = 201, body = super::schemas::Username), (status = 400, description = "Validation error or duplicate ([message] or {field: [message]})", body = Object), (status = 403, description = "Needs owner or ADMIN permission", body = super::schemas::ErrorBody)))]
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    // serializer 驗證：reverse_server 必填且存在、username 必填非空。
    let mut errors = serde_json::Map::new();
    let tunnel_id = json_i64(&body, "reverse_server");
    let username = json_str(&body, "username").map(|s| s.trim().to_string());
    let tunnel = match tunnel_id {
        None => {
            errors.insert("reverse_server".into(), json!(["This field is required."]));
            None
        }
        Some(id) => {
            let t = db::tunnels::by_id(&state.db, id).await?;
            if t.is_none() {
                errors.insert("reverse_server".into(), json!([format!("Invalid pk \"{id}\" - object does not exist.")]));
            }
            t
        }
    };
    match &username {
        None => {
            errors.insert("username".into(), json!(["This field is required."]));
        }
        Some(u) if u.is_empty() => {
            errors.insert("username".into(), json!(["This field may not be blank."]));
        }
        Some(u) if u.chars().count() > 128 => {
            errors.insert("username".into(), json!(["Ensure this field has no more than 128 characters."]));
        }
        _ => {}
    }
    if !errors.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, Value::Object(errors)));
    }
    let (tunnel, username) = (tunnel.unwrap(), username.unwrap());

    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::Admin).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to add usernames to this tunnel."));
    }
    if db::tunnels::username_taken(&state.db, tunnel.id, &username, None).await? {
        return Err(duplicate(&username));
    }
    let u = db::tunnels::username_create(&state.db, user.id, tunnel.id, &username).await.map_err(|e| if is_unique_violation(&e) { duplicate(&username) } else { ApiError::from(e) })?;
    notify::tunnel_users(&state, &tunnel, "TUNNEL-USERNAMES-UPDATED", &format!("Usernames updated for tunnel '{}'", tunnel.host_friendly_name)).await?;
    state.device_keys.kick(tunnel.id);
    Ok((StatusCode::CREATED, Json(username_json(&u, state.config.tz_offset_minutes))))
}

#[utoipa::path(get, path = "/api/reverse/server/usernames/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Username id")), responses((status = 200, body = super::schemas::Username), (status = 404, body = super::schemas::ErrorBody)))]
async fn retrieve(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let u = visible_username(&state, user.id, id).await?;
    Ok(Json(username_json(&u, state.config.tz_offset_minutes)))
}

fn duplicate(username: &str) -> ApiError {
    ApiError::validation_list(format!("This tunnel already has a target user named '{username}'."))
}

#[utoipa::path(patch, path = "/api/reverse/server/usernames/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Username id")), request_body = super::schemas::UsernamePatch, responses((status = 200, body = super::schemas::Username), (status = 403, description = "Needs owner or ADMIN permission", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let u = visible_username(&state, user.id, id).await?;
    let tunnel = db::tunnels::by_id(&state.db, u.reverse_server_id).await?.ok_or_else(ApiError::drf_not_found)?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::Admin).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to edit this username."));
    }
    let username = json_str(&body, "username").map(|s| s.trim().to_string());
    if let Some(name) = &username {
        if name.is_empty() {
            return Err(ApiError::field("username", "This field may not be blank."));
        }
        if db::tunnels::username_taken(&state.db, tunnel.id, name, Some(id)).await? {
            return Err(duplicate(name));
        }
    }
    let updated = db::tunnels::username_update(&state.db, id, username.as_deref())
        .await
        .map_err(|e| if is_unique_violation(&e) { duplicate(username.as_deref().unwrap_or_default()) } else { ApiError::from(e) })?;
    state.device_keys.kick(tunnel.id);
    crate::access_recheck::kick(&state, Some(tunnel.id), None);
    Ok(Json(username_json(&updated, state.config.tz_offset_minutes)))
}

/// PUT 與 PATCH 語意相同（ModelSerializer 只有 username 可寫）。
#[utoipa::path(put, path = "/api/reverse/server/usernames/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Username id")), request_body = super::schemas::UsernamePatch, responses((status = 200, body = super::schemas::Username), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn replace(state: State<AppState>, user: AuthUser, id: Path<i64>, body: AppJson<Value>) -> ApiResult<Json<Value>> {
    update(state, user, id, body).await
}

/// 刪除（連帶從所有允許清單移除）：只有 owner / ADMIN。
#[utoipa::path(delete, path = "/api/reverse/server/usernames/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Username id")), responses((status = 204, description = "Deleted (also removed from every allow-list)"), (status = 403, description = "Needs owner or ADMIN permission", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let u = visible_username(&state, user.id, id).await?;
    let tunnel = db::tunnels::by_id(&state.db, u.reverse_server_id).await?.ok_or_else(ApiError::drf_not_found)?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::Admin).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to delete this username."));
    }
    db::tunnels::username_delete(&state.db, id).await?;
    let details = format!("Usernames updated for tunnel '{}'", tunnel.host_friendly_name);
    notify::tunnel_users(&state, &tunnel, "TUNNEL-USERNAMES-UPDATED", &details).await?;
    state.device_keys.kick(tunnel.id);
    crate::access_recheck::kick(&state, Some(tunnel.id), None);
    Ok(StatusCode::NO_CONTENT)
}
