//! 終端機錄影的 API：清單、讀檔（asciicast）、刪除，以及開關隧道的錄影。
//! 看得到：自己的錄影、自己擁有或 ADMIN 的隧道上的錄影；管理員看全部。刪除與開關只給 owner / ADMIN / 管理員。
//! Terminal recordings API: list, read (asciicast), delete, and switch a tunnel's recording. You see your own
//! recordings and those on tunnels you own or ADMIN (admins see all); deleting and switching are for managers.

use std::collections::HashMap;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{mfa, notify, AppJson};
use crate::auth::AuthUser;
use crate::db::{self, recordings::Recording, tunnels::Tunnel, users::User};
use crate::error::{ApiError, ApiResult};
use crate::permissions;
use crate::recording;
use crate::state::AppState;
use crate::util::db_to_iso_utc_z;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list)).routes(routes!(cast)).routes(routes!(destroy)).routes(routes!(set_recording))
}

fn not_found() -> ApiError {
    ApiError::not_found("Recording not found")
}

/// 看得到這筆錄影嗎；能不能刪。/ Whether the recording is visible, and whether it can be deleted.
async fn access(state: &AppState, me: &User, rec: &Recording) -> ApiResult<(bool, HashMap<i64, Tunnel>)> {
    let managed = super::sessions::managed(state, me).await?;
    let manages = managed.contains_key(&rec.tunnel_id);
    if rec.user_id != me.id && !manages {
        return Err(not_found());
    }
    Ok((manages, managed))
}

fn recording_json(r: &Recording, tunnel_name: Option<&str>, can_delete: bool) -> Value {
    json!({
        "id": r.id,
        "tunnel": { "id": r.tunnel_id, "name": tunnel_name },
        "user": { "id": r.user_id, "username": r.username },
        "os_user": r.os_user,
        "lan_host": r.lan_host,
        "started_at": db_to_iso_utc_z(&r.started_at),
        "ended_at": r.ended_at.as_deref().map(db_to_iso_utc_z),
        "live": r.ended_at.is_none(),
        "duration_ms": r.duration_ms,
        "bytes": r.bytes,
        "truncated": r.truncated,
        "can_delete": can_delete,
    })
}

/// 錄影清單（新的在前，最多 500 筆）；`tunnel_id` 只看一條。/ Recordings, newest first (at most 500); `tunnel_id` narrows.
#[utoipa::path(get, path = "/api/recordings", tag = "Recordings", security(("bearer" = [])), params(("tunnel_id" = Option<i64>, Query, description = "Only this tunnel"), ("limit" = Option<i64>, Query, description = "At most this many (default 200, max 500)")), responses((status = 200, body = super::schemas::RecordingList)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let managed = super::sessions::managed(&state, &me).await?;
    let ids: Vec<i64> = managed.keys().copied().collect();
    let tunnel_id = q.get("tunnel_id").and_then(|v| v.parse().ok());
    let limit = q.get("limit").and_then(|v| v.parse::<i64>().ok()).unwrap_or(200).clamp(1, 500);
    let rows = db::recordings::visible(&state.db, me.is_superuser, me.id, &ids, tunnel_id, limit).await?;
    let mut names: HashMap<i64, String> = managed.iter().map(|(id, t)| (*id, t.host_friendly_name.clone())).collect();
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        if !names.contains_key(&r.tunnel_id) {
            if let Some(t) = db::tunnels::by_id(&state.db, r.tunnel_id).await? {
                names.insert(t.id, t.host_friendly_name);
            }
        }
        out.push(recording_json(r, names.get(&r.tunnel_id).map(String::as_str), managed.contains_key(&r.tunnel_id)));
    }
    Ok(Json(json!({ "recordings": out })))
}

/// 錄影檔（asciicast v2）；還在錄的也讀得到目前為止的部分。/ The asciicast v2 file; a live one returns what is recorded so far.
#[utoipa::path(get, path = "/api/recordings/{id}/cast", tag = "Recordings", security(("bearer" = [])), params(("id" = i64, Path, description = "Recording id")), responses((status = 200, description = "asciicast v2 (one JSON value per line)", content_type = "application/x-asciicast"), (status = 404, body = super::schemas::ErrorBody)))]
async fn cast(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Response> {
    let rec = db::recordings::get(&state.db, id).await?.ok_or_else(not_found)?;
    access(&state, &me, &rec).await?;
    let path = recording::resolve(&recording::root(&state), &rec.file).ok_or_else(not_found)?;
    let bytes = tokio::fs::read(&path).await.map_err(|_| not_found())?;
    let name = format!("telepy-recording-{}.cast", rec.id);
    Ok((
        [(header::CONTENT_TYPE, "application/x-asciicast".to_string()), (header::CONTENT_DISPOSITION, format!("inline; filename=\"{name}\""))],
        Body::from(bytes),
    )
        .into_response())
}

/// 刪一筆錄影（owner / ADMIN / 管理員；自己被錄的那個人不能刪）。/ Delete a recording (managers only; the recorded person can't).
#[utoipa::path(delete, path = "/api/recordings/{id}", tag = "Recordings", security(("bearer" = [])), params(("id" = i64, Path, description = "Recording id")), responses((status = 204, description = "Deleted"), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "Still recording", body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let rec = db::recordings::get(&state.db, id).await?.ok_or_else(not_found)?;
    let (manages, managed) = access(&state, &me, &rec).await?;
    if !manages {
        return Err(ApiError::forbidden("Only the tunnel owner, its admins or a site admin can delete recordings."));
    }
    if rec.ended_at.is_none() {
        return Err(ApiError::error(StatusCode::CONFLICT, "This session is still being recorded."));
    }
    recording::remove(&state, &rec).await?;
    let t = managed.get(&rec.tunnel_id);
    let name = t.map(|t| t.host_friendly_name.as_str()).unwrap_or("");
    state
        .gateway
        .event("recording_deleted", None, t.and_then(|t| u16::try_from(t.reverse_port).ok()), Some(rec.tunnel_id), format!("{} deleted the recording of {}'s terminal on {name} ({})", me.username, rec.username, rec.started_at))
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// 開 / 關隧道的終端機錄影（owner / ADMIN）；關掉要再驗證（帳號有第二因素時）。
/// Switch a tunnel's terminal recording (owner / ADMIN); turning it off needs a re-authentication when you have a factor.
#[utoipa::path(put, path = "/api/reverse/server/{id}/recording", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::RecordingSetting, responses((status = 200, body = super::schemas::RecordingSetting), (status = 403, description = "Needs owner / ADMIN, or reauth_required", body = super::schemas::MfaError), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_recording(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let nf = || ApiError::not_found("Tunnel not found");
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(nf)?;
    let eff = permissions::effective_for(&state.db, user.id, &t).await?.ok_or_else(nf)?;
    if !eff.satisfies(permissions::Permission::Admin) {
        return Err(ApiError::forbidden("Only the tunnel owner or an ADMIN sharee can change this."));
    }
    let enabled = body.get("enabled").and_then(Value::as_bool).ok_or_else(|| ApiError::field("enabled", "enabled must be true or false"))?;
    if enabled == t.record_sessions {
        return Ok(Json(json!({ "enabled": enabled })));
    }
    if !enabled {
        mfa::require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    }
    db::tunnels::set_record_sessions(&state.db, t.id, enabled).await?;
    let t = db::tunnels::by_id(&state.db, t.id).await?.unwrap_or(t);
    notify::tunnel_updated(&state, &t).await?;
    let what = if enabled { "now records web terminal sessions" } else { "no longer records web terminal sessions" };
    state
        .gateway
        .event("recording_setting", None, u16::try_from(t.reverse_port).ok(), Some(t.id), format!("{} changed tunnel {}: {what}", user.username, t.host_friendly_name))
        .await;
    Ok(Json(json!({ "enabled": enabled })))
}
