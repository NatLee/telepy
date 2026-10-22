//! `/api/reverse/server/*`：隧道（ReverseServerAuthorizedKeys）ViewSet、dashboard、狀態、
//! 目標使用者名稱查詢、預設使用者名稱、服務金鑰。對應 authorized_keys/views.py。

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::notify;
use super::serialize::{endpoint_json, tunnel_json};
use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::{NewTunnel, Tunnel, TunnelPatch}};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::{json_i64, json_str};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(status_ports))
        .routes(routes!(status_latency))
        .routes(routes!(dashboard))
        .routes(routes!(list, create))
        .routes(routes!(retrieve, update, partial_update, destroy))
        .routes(routes!(usernames_for_server))
        .routes(routes!(set_default_username))
        .routes(routes!(service_keys))
}

/// `{port: bool}`；取樣不可用回 `{}`。/ Port map, `{}` when the sample is unavailable.
pub async fn ports_json(state: &AppState) -> ApiResult<Value> {
    let map = state.status.ports_status(&state.db).await?.unwrap_or_default();
    Ok(Value::Object(map.into_iter().map(|(p, v)| (p.to_string(), Value::Bool(v))).collect()))
}

pub fn latency_json(state: &AppState) -> Value {
    let map: BTreeMap<u16, f64> = state.status.latency().unwrap_or_default().into_iter().collect();
    Value::Object(map.into_iter().map(|(p, v)| (p.to_string(), json!(v))).collect())
}

#[utoipa::path(get, path = "/api/reverse/server/status/ports", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, description = "{\"<reverse_port>\": listening} for every tunnel; {} when the status source is unavailable", body = Object)))]
async fn status_ports(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(ports_json(&state).await?))
}

#[utoipa::path(get, path = "/api/reverse/server/status/latency", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, description = "{\"<reverse_port>\": rtt_ms}", body = Object)))]
async fn status_latency(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(latency_json(&state)))
}

/// 列表序列化：以預先算好的表避免每列查詢（`tunnel_permission_context`）。
/// 列表多一個 `endpoint`（裝置的公網 IP）：只給 [`permissions::can_see_endpoint`] 允許的人，其他人是 null。
async fn list_json(state: &AppState, user_id: i64, is_superuser: bool) -> ApiResult<Vec<Value>> {
    let tunnels = db::tunnels::visible_to(&state.db, user_id).await?;
    let (my_shares, counts) = db::sharing::permission_context(&state.db, user_id).await?;
    let with_accounts = db::sharing::tunnels_with_allowed_usernames(&state.db, user_id).await?;
    let last = db::tunnel_endpoints::visible_to(&state.db, user_id).await?;
    let live = state.status.endpoints();
    let tz = state.config.tz_offset_minutes;
    Ok(tunnels
        .iter()
        .map(|t| {
            let eff = permissions::effective(user_id, t.user_id, my_shares.get(&t.id).map(String::as_str));
            let mut v = tunnel_json(t, eff, counts.get(&t.id).copied().unwrap_or(0), tz);
            v["endpoint"] = if permissions::can_see_endpoint(eff, with_accounts.contains(&t.id), is_superuser) {
                let port = u16::try_from(t.reverse_port).ok();
                endpoint_json(port.and_then(|p| live.get(&p)), last.get(&t.id))
            } else {
                Value::Null
            };
            v
        })
        .collect())
}

async fn single_json(state: &AppState, user_id: i64, t: &Tunnel) -> ApiResult<Value> {
    let eff = permissions::effective_for(&state.db, user_id, t).await?;
    let count = db::sharing::sharee_ids(&state.db, t.id).await?.len() as i64;
    Ok(tunnel_json(t, eff, count, state.config.tz_offset_minutes))
}

#[utoipa::path(get, path = "/api/reverse/server/dashboard", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, description = "Tunnels visible to the user plus live port status and latency", body = super::schemas::Dashboard)))]
async fn dashboard(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(json!({
        "tunnels": list_json(&state, user.id, user.is_superuser).await?,
        "ports": ports_json(&state).await?,
        "latency": latency_json(&state),
    })))
}

#[utoipa::path(get, path = "/api/reverse/server/keys", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, body = Vec<super::schemas::Tunnel>)))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Array(list_json(&state, user.id, user.is_superuser).await?)))
}

/// ViewSet.get_object()：只在「我看得到」的集合內找，否則 404。
async fn visible_tunnel(state: &AppState, user_id: i64, id: i64) -> ApiResult<Tunnel> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    if permissions::effective_for(&state.db, user_id, &t).await?.is_none() {
        return Err(ApiError::drf_not_found());
    }
    Ok(t)
}

fn unique_error(e: sqlx::Error) -> ApiError {
    if is_unique_violation(&e) {
        let msg = crate::error::db_error_message(&e);
        let (field, label) = if msg.contains("host_friendly_name") {
            ("host_friendly_name", "Host Friendly Name")
        } else if msg.contains("reverse_port") {
            ("reverse_port", "Reverse Port")
        } else {
            ("key", "SSH Key (public)")
        };
        ApiError::field(field, format!("reverse server key with this {label} already exists."))
    } else {
        ApiError::from(e)
    }
}

/// DRF ModelSerializer 的必填/型別檢查（create 與 PUT 用）。
fn validate_full(body: &Value) -> Result<(String, String, i64), ApiError> {
    let mut errors = serde_json::Map::new();
    let name = json_str(body, "host_friendly_name").filter(|s| !s.is_empty());
    let key = json_str(body, "key").filter(|s| !s.is_empty());
    let port = json_i64(body, "reverse_port");
    if name.is_none() {
        errors.insert("host_friendly_name".into(), json!(["This field is required."]));
    }
    if key.is_none() {
        errors.insert("key".into(), json!(["This field is required."]));
    }
    match port {
        None if body.get("reverse_port").is_none() => {
            errors.insert("reverse_port".into(), json!(["This field is required."]));
        }
        None => {
            errors.insert("reverse_port".into(), json!(["A valid integer is required."]));
        }
        Some(p) if p < 0 => {
            errors.insert("reverse_port".into(), json!(["Ensure this value is greater than or equal to 0."]));
        }
        _ => {}
    }
    if !errors.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, Value::Object(errors)));
    }
    Ok((name.unwrap(), key.unwrap(), port.unwrap()))
}

#[utoipa::path(post, path = "/api/reverse/server/keys", tag = "Reverse Server Keys", security(("bearer" = [])), request_body = super::schemas::TunnelWrite, responses((status = 201, body = super::schemas::Tunnel), (status = 400, description = "Validation error {field: [message]}", body = Object)))]
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (name, key, port) = validate_full(&body)?;
    let seed = super::device_keys::key_list_choice(&body)?;
    let description = json_str(&body, "description");
    let default_username_id = json_i64(&body, "default_username");
    let t = db::tunnels::create(
        &state.db,
        NewTunnel {
            user_id: user.id,
            host_friendly_name: &name,
            key: &key,
            reverse_port: port,
            description: description.as_deref(),
            default_username_id,
        },
    )
    .await
    .map_err(unique_error)?;
    if seed {
        super::device_keys::seed_key_list(&state, t.id, user.id).await?;
    }
    notify::tunnel_updated(&state, &t).await?;
    Ok((StatusCode::CREATED, Json(single_json(&state, user.id, &t).await?)))
}

#[utoipa::path(get, path = "/api/reverse/server/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::Tunnel), (status = 404, body = super::schemas::ErrorBody)))]
async fn retrieve(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(&state, user.id, id).await?;
    Ok(Json(single_json(&state, user.id, &t).await?))
}

async fn apply_update(state: &AppState, user_id: i64, id: i64, body: Value, partial: bool) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(state, user_id, id).await?;
    if !partial {
        validate_full(&body)?;
    }
    if !permissions::check_access(&state.db, user_id, &t, Permission::Edit).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to edit this tunnel."));
    }
    let name = json_str(&body, "host_friendly_name");
    let key = json_str(&body, "key");
    let port = json_i64(&body, "reverse_port");
    let description = body.get("description").map(|v| v.as_str().map(str::to_string));
    let default_username = body.get("default_username").map(|v| v.as_i64());
    let updated = db::tunnels::update(
        &state.db,
        id,
        TunnelPatch {
            host_friendly_name: name.as_deref(),
            key: key.as_deref(),
            reverse_port: port,
            description: description.as_ref().map(|d| d.as_deref()),
            default_username_id: default_username,
        },
    )
    .await
    .map_err(unique_error)?;
    notify::tunnel_updated(state, &updated).await?;
    Ok(Json(single_json(state, user_id, &updated).await?))
}

#[utoipa::path(put, path = "/api/reverse/server/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::TunnelWrite, responses((status = 200, body = super::schemas::Tunnel), (status = 403, description = "Needs EDIT permission", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    apply_update(&state, user.id, id, body, false).await
}

#[utoipa::path(patch, path = "/api/reverse/server/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::TunnelPatch, responses((status = 200, body = super::schemas::Tunnel), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn partial_update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    apply_update(&state, user.id, id, body, true).await
}

#[utoipa::path(delete, path = "/api/reverse/server/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 204, description = "Deleted (usernames and shares cascade)"), (status = 403, description = "Needs ADMIN / owner", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let t = visible_tunnel(&state, user.id, id).await?;
    if !permissions::check_share_access(&state.db, user.id, &t).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to delete this tunnel."));
    }
    let audience = notify::tunnel_audience(&state, &t).await?;
    crate::device_keys::forget_tunnel(&state, &t).await;
    db::tunnels::delete(&state.db, id).await?;
    state.hub.notify_users(
        audience,
        &json!({
            "action": "UPDATED-TUNNELS",
            "details": format!("Tunnel '{}' has been updated", t.host_friendly_name),
            "tunnel_id": t.id,
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `ReverseServerUsernamesMapServerId`：`{"usernames": [...], "default_username_id": ...}`
#[utoipa::path(get, path = "/api/reverse/server/{id}/usernames", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "Target usernames the caller may use on this tunnel", body = super::schemas::UsernamesForServer), (status = 404, body = super::schemas::ErrorBody)))]
async fn usernames_for_server(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let not_found = || ApiError::not_found("Server not found");
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(not_found)?;
    if permissions::effective_for(&state.db, user.id, &t).await?.is_none() {
        return Err(not_found());
    }
    let usernames = permissions::allowed_usernames(&state.db, user.id, &t).await?;
    let ids: Vec<i64> = usernames.iter().map(|u| u.id).collect();
    let default_id = t.default_username_id.filter(|d| ids.contains(d));
    Ok(Json(json!({
        "usernames": usernames.iter().map(|u| json!({
            "id": u.id,
            "username": u.username,
            "created_by": u.created_by,
            "created_by_id": u.user_id,
        })).collect::<Vec<_>>(),
        "default_username_id": default_id,
    })))
}

/// `SetDefaultUsernameView`
#[utoipa::path(patch, path = "/api/reverse/server/{id}/default-username", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::DefaultUsernameRequest, responses((status = 200, body = super::schemas::DefaultUsernameResponse), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_default_username(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &t, Permission::Edit).await? {
        return Err(ApiError::forbidden("You do not have permission to update this tunnel"));
    }
    let details = format!("Default username updated for tunnel '{}'", t.host_friendly_name);
    match json_i64(&body, "default_username_id") {
        None => {
            db::tunnels::set_default_username(&state.db, id, None).await?;
            let t = db::tunnels::by_id(&state.db, id).await?.unwrap_or(t);
            notify::tunnel_updated(&state, &t).await?;
            notify::tunnel_users(&state, &t, "TUNNEL-USERNAMES-UPDATED", &details).await?;
            Ok(Json(json!({ "message": "Default username cleared" })))
        }
        Some(uid) => {
            let u = db::tunnels::username_by_id(&state.db, uid).await?.filter(|u| u.reverse_server_id == id);
            let Some(u) = u else {
                return Err(ApiError::bad_request("Username not found for this tunnel"));
            };
            db::tunnels::set_default_username(&state.db, id, Some(u.id)).await?;
            let t = db::tunnels::by_id(&state.db, id).await?.unwrap_or(t);
            notify::tunnel_updated(&state, &t).await?;
            notify::tunnel_users(&state, &t, "TUNNEL-USERNAMES-UPDATED", &details).await?;
            Ok(Json(json!({
                "message": format!("Default username set to {}", u.username),
                "default_username_id": u.id,
            })))
        }
    }
}

#[utoipa::path(get, path = "/api/reverse/service/keys", tag = "Service Keys", security(("bearer" = [])), responses((status = 200, description = "Public keys devices must authorize (the backend's own key)", body = Vec<super::schemas::ServiceKey>)))]
async fn service_keys(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    let keys = db::keys::service_keys(&state.db).await?;
    Ok(Json(Value::Array(
        keys.iter()
            .map(|k| json!({ "id": k.id, "service": k.service, "key": k.key, "description": k.description }))
            .collect(),
    )))
}
