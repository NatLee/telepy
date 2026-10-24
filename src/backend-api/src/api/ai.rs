//! `/api/ai/*`：AI（MCP）SSH session 與稽核紀錄的 web 端點。
//! - `GET /api/ai/sessions`：我的 session ∪ 在我擁有的隧道上的 session（管理員：全部）
//! - `DELETE /api/ai/sessions/{id}`：session 的使用者、隧道擁有者或管理員可以關
//! - `GET /api/ai/activity`：管理員全部；其他人 = 自己的 ∪ 自己擁有的隧道上的
//! Web endpoints for AI sessions (list / close) and the MCP audit trail.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::ai::{self, AiSession, CloseReason};
use crate::auth::AuthUser;
use crate::db::{self, users::User};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::db_to_iso;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list_sessions))
        .routes(routes!(close_session))
        .routes(routes!(activity))
}

/// 誰看得到 / 關得掉一個 session：本人、隧道擁有者、管理員。/ Who may see or close a session.
fn can_manage(me: &User, s: &AiSession) -> bool {
    me.is_superuser || s.user_id == me.id || s.tunnel_owner_id == me.id
}

pub(crate) fn session_json(s: &AiSession, tz: i32) -> Value {
    json!({
        "id": s.id,
        "user": { "id": s.user_id, "username": s.user_name },
        "client_name": s.client_name,
        "grant_id": s.grant_id,
        "tunnel": { "id": s.tunnel_id, "name": s.tunnel_name },
        "username": s.target_username,
        "created_at": db_to_iso(&s.created_at(), tz),
        "last_used_at": db_to_iso(&s.last_used_at(), tz),
        "expires_at": db_to_iso(&s.expires_at(), tz),
        "idle_timeout_s": s.idle_timeout.as_secs(),
        "commands": s.commands(),
        "busy": s.busy(),
    })
}

#[utoipa::path(get, path = "/api/ai/sessions", tag = "AI", security(("bearer" = [])), responses((status = 200, description = "Open AI sessions: yours plus those on tunnels you own (admins: all), oldest first", body = Vec<super::schemas::AiSession>)))]
async fn list_sessions(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let tz = state.config.tz_offset_minutes;
    Ok(Json(Value::Array(state.ai.list().iter().filter(|s| can_manage(&me, s)).map(|s| session_json(s, tz)).collect())))
}

#[utoipa::path(delete, path = "/api/ai/sessions/{id}", tag = "AI", security(("bearer" = [])), params(("id" = String, Path, description = "Session id (ais_…)")), responses((status = 204, description = "Closed; the agent's next call with this session_id fails"), (status = 404, body = super::schemas::ErrorBody)))]
async fn close_session(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    match state.ai.get(&id) {
        Some(s) if can_manage(&me, &s) => {
            ai::close(&state, &s.id, CloseReason::ClosedByUser).await;
            Ok(StatusCode::NO_CONTENT)
        }
        _ => Err(ApiError::drf_not_found()),
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct ActivityQuery {
    limit: Option<i64>,
    tunnel_id: Option<i64>,
    user_id: Option<i64>,
    grant_id: Option<i64>,
}

#[utoipa::path(get, path = "/api/ai/activity", tag = "AI", security(("bearer" = [])), params(
    ("limit" = Option<i64>, Query, description = "Max rows, newest first (default 200, max 1000)"),
    ("tunnel_id" = Option<i64>, Query),
    ("user_id" = Option<i64>, Query),
    ("grant_id" = Option<i64>, Query, description = "Only the calls of one connected app (OAuth grant)"),
), responses((status = 200, description = "MCP tool calls: admins see everything, others their own calls plus calls on tunnels they own", body = Vec<super::schemas::AiActivity>)))]
async fn activity(State(state): State<AppState>, AuthUser(me): AuthUser, Query(q): Query<ActivityQuery>) -> ApiResult<Json<Value>> {
    let filter = db::ai_audit::Filter {
        visible_to: (!me.is_superuser).then_some(me.id),
        user_id: q.user_id,
        tunnel_id: q.tunnel_id,
        grant_id: q.grant_id,
        limit: q.limit.unwrap_or(200).clamp(1, 1000),
    };
    let tz = state.config.tz_offset_minutes;
    let rows = db::ai_audit::list(&state.db, &filter).await?;
    Ok(Json(Value::Array(rows.iter().map(|e| activity_json(e, tz)).collect())))
}

pub(crate) fn activity_json(e: &db::ai_audit::Event, tz: i32) -> Value {
    json!({
        "id": e.id,
        "at": db_to_iso(&e.at, tz),
        "user": { "id": e.user_id, "username": e.username },
        "client_name": e.client_name,
        "grant_id": e.grant_id,
        "tool": e.tool,
        "tunnel": e.tunnel_id.map(|id| json!({ "id": id, "name": e.tunnel_name })),
        "session_id": e.session_id,
        "target_username": e.target_username,
        "detail": e.detail,
        "ok": e.ok,
        "exit_code": e.exit_code,
        "duration_ms": e.duration_ms,
        "bytes_out": e.bytes_out,
        "error": e.error,
        "ip": e.ip,
    })
}
