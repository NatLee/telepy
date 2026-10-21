//! `/api/reverse/server/usernames`：目標主機使用者名稱 ViewSet（`ReverseServerUsernamesViewSet`）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::notify;
use super::serialize::username_json;
use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Username};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{json_i64, json_str};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/reverse/server/usernames", get(list).post(create))
        .route("/api/reverse/server/usernames/{id}", get(retrieve).put(update).patch(update).delete(destroy))
}

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

    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::Edit).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to add usernames to this tunnel."));
    }
    if db::tunnels::username_exists(&state.db, user.id, tunnel.id, &username).await? {
        return Err(ApiError::validation_list(format!("You already have a target user named '{username}' on this tunnel.")));
    }
    let u = db::tunnels::username_create(&state.db, user.id, tunnel.id, &username).await.map_err(|e| {
        if is_unique_violation(&e) {
            ApiError::validation_list(format!("You already have a target user named '{username}' on this tunnel."))
        } else {
            ApiError::from(e)
        }
    })?;
    notify::tunnel_users(&state, &tunnel, "TUNNEL-USERNAMES-UPDATED", &format!("Usernames updated for tunnel '{}'", tunnel.host_friendly_name)).await?;
    Ok((StatusCode::CREATED, Json(username_json(&u, state.config.tz_offset_minutes))))
}

async fn retrieve(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let u = visible_username(&state, user.id, id).await?;
    Ok(Json(username_json(&u, state.config.tz_offset_minutes)))
}

async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let u = visible_username(&state, user.id, id).await?;
    let tunnel = db::tunnels::by_id(&state.db, u.reverse_server_id).await?.ok_or_else(ApiError::drf_not_found)?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::Edit).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to edit this username."));
    }
    let username = json_str(&body, "username").map(|s| s.trim().to_string());
    if let Some(name) = &username {
        if name.is_empty() {
            return Err(ApiError::field("username", "This field may not be blank."));
        }
    }
    let updated = db::tunnels::username_update(&state.db, id, username.as_deref()).await.map_err(|e| {
        if is_unique_violation(&e) {
            ApiError::validation_list(format!(
                "You already have a target user named '{}' on this tunnel.",
                username.clone().unwrap_or_default()
            ))
        } else {
            ApiError::from(e)
        }
    })?;
    Ok(Json(username_json(&updated, state.config.tz_offset_minutes)))
}

/// Owner / Admin / 建立者 → 真刪除；只有 Editor 權限的非建立者 → 從自己的允許清單「離開」。
async fn destroy(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let u = visible_username(&state, user.id, id).await?;
    let tunnel = db::tunnels::by_id(&state.db, u.reverse_server_id).await?.ok_or_else(ApiError::drf_not_found)?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::Edit).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to delete this username."));
    }
    let can_full_delete = user.id == tunnel.user_id
        || user.id == u.user_id
        || permissions::check_access(&state.db, user.id, &tunnel, Permission::Admin).await?;
    let details = if can_full_delete {
        db::tunnels::username_delete(&state.db, id).await?;
        format!("Usernames updated for tunnel '{}'", tunnel.host_friendly_name)
    } else {
        if let Some(sharing) = db::sharing::get(&state.db, tunnel.id, user.id).await? {
            db::sharing::remove_allowed_username(&state.db, sharing.id, id).await?;
        }
        format!("A user left Target Server Users for tunnel '{}'", tunnel.host_friendly_name)
    };
    notify::tunnel_users(&state, &tunnel, "TUNNEL-USERNAMES-UPDATED", &details).await?;
    Ok(StatusCode::NO_CONTENT)
}
