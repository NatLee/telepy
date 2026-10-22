//! `/api/reverse/user/keys`：使用者金鑰 ViewSet（`UserAuthorizedKeysViewSet`）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::serialize::user_key_json;
use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, keys::UserKey};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::json_str;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, create))
        .routes(routes!(retrieve, update, replace, destroy))
}

fn unique_error(e: sqlx::Error) -> ApiError {
    if is_unique_violation(&e) {
        let msg = crate::error::db_error_message(&e);
        if msg.contains("host_friendly_name") {
            ApiError::field("host_friendly_name", "user keys with this Host Friendly Name already exists.")
        } else {
            ApiError::field("key", "user keys with this SSH Key (public) already exists.")
        }
    } else {
        ApiError::from(e)
    }
}

#[utoipa::path(get, path = "/api/reverse/user/keys", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, body = Vec<super::schemas::UserKey>)))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let rows = db::keys::user_keys(&state.db, user.id).await?;
    let tz = state.config.tz_offset_minutes;
    Ok(Json(Value::Array(rows.iter().map(|k| user_key_json(k, tz)).collect())))
}

async fn own_key(state: &AppState, user_id: i64, id: i64) -> ApiResult<UserKey> {
    db::keys::user_key_by_id(&state.db, user_id, id).await?.ok_or_else(ApiError::drf_not_found)
}

fn validate_full(body: &Value) -> Result<(String, String), ApiError> {
    let mut errors = serde_json::Map::new();
    let name = json_str(body, "host_friendly_name").filter(|s| !s.is_empty());
    let key = json_str(body, "key").filter(|s| !s.is_empty());
    if name.is_none() {
        errors.insert("host_friendly_name".into(), json!(["This field is required."]));
    }
    if key.is_none() {
        errors.insert("key".into(), json!(["This field is required."]));
    }
    if !errors.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, Value::Object(errors)));
    }
    Ok((name.unwrap(), key.unwrap()))
}

#[utoipa::path(post, path = "/api/reverse/user/keys", tag = "Reverse Server Keys", security(("bearer" = [])), request_body = super::schemas::UserKeyWrite, responses((status = 201, body = super::schemas::UserKey), (status = 400, description = "Validation error {field: [message]}", body = Object)))]
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (name, key) = validate_full(&body)?;
    let description = json_str(&body, "description");
    let k = db::keys::user_key_create(&state.db, user.id, &name, &key, description.as_deref()).await.map_err(unique_error)?;
    state.hub.notify_user(
        user.id,
        &json!({
            "action": "CREATED-USER-KEYS",
            "details": format!("A new user authorized key has been created by {}", user.username),
        }),
    );
    Ok((StatusCode::CREATED, Json(user_key_json(&k, state.config.tz_offset_minutes))))
}

#[utoipa::path(get, path = "/api/reverse/user/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Key id")), responses((status = 200, body = super::schemas::UserKey), (status = 404, body = super::schemas::ErrorBody)))]
async fn retrieve(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let k = own_key(&state, user.id, id).await?;
    Ok(Json(user_key_json(&k, state.config.tz_offset_minutes)))
}

#[utoipa::path(patch, path = "/api/reverse/user/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Key id")), request_body = super::schemas::UserKeyPatch, responses((status = 200, body = super::schemas::UserKey), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    own_key(&state, user.id, id).await?;
    let name = json_str(&body, "host_friendly_name");
    let key = json_str(&body, "key");
    let description = body.get("description").map(|v| v.as_str().map(str::to_string));
    let k = db::keys::user_key_update(&state.db, id, name.as_deref(), key.as_deref(), description.as_ref().map(|d| d.as_deref()))
        .await
        .map_err(unique_error)?;
    Ok(Json(user_key_json(&k, state.config.tz_offset_minutes)))
}

#[utoipa::path(put, path = "/api/reverse/user/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Key id")), request_body = super::schemas::UserKeyWrite, responses((status = 200, body = super::schemas::UserKey), (status = 404, body = super::schemas::ErrorBody)))]
async fn replace(state: State<AppState>, user: AuthUser, id: Path<i64>, body: AppJson<Value>) -> ApiResult<Json<Value>> {
    update(state, user, id, body).await
}

#[utoipa::path(delete, path = "/api/reverse/user/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Key id")), responses((status = 204, description = "Deleted"), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    own_key(&state, user.id, id).await?;
    db::keys::user_key_delete(&state.db, id).await?;
    state.hub.notify_user(
        user.id,
        &json!({
            "action": "DELETED-USER-KEYS",
            "details": format!("An user authorized key has been deleted by {}", user.username),
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}
