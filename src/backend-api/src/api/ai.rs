//! `/api/ai/*`：AI（MCP）SSH session 與稽核紀錄的 web 端點。
//! - `GET /api/ai/sessions`：我的 session ∪ 在我擁有的隧道上的 session；`?scope=all` = 全部（只有管理員）
//! - `DELETE /api/ai/sessions/{id}`：session 的使用者、隧道擁有者或管理員可以關
//! - `GET /api/ai/activity`：自己的 ∪ 自己擁有的隧道上的（管理員也一樣）；`?scope=all` = 全部（只有管理員）
//! - `POST /api/ai/sessions`、`POST /api/ai/sessions/{id}/exec`：MCP 的 `ssh_session_open` / `ssh_exec` 的 REST 版，
//!   只收個人 API token / OAuth app 的 token（`telepy exec`），同樣的 reaper、指令規則與稽核
//!
//! Web endpoints for AI sessions (list / close) and the MCP audit trail, plus REST equivalents of `ssh_session_open`
//! and `ssh_exec` for API tokens and OAuth app tokens (the `telepy exec` CLI): same reaper, command rules and audit.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::ai::{self, AiSession, CloseReason};
use crate::auth::extractor::Delegated;
use crate::auth::mcp::McpPrincipal;
use crate::auth::AuthUser;
use crate::db::{self, users::User};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::db_to_iso;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list_sessions, open_session))
        .routes(routes!(close_session))
        .routes(routes!(exec))
        .routes(routes!(activity))
}

/// 誰關得掉一個 session：本人、隧道擁有者、管理員。/ Who may close a session.
fn can_manage(me: &User, s: &AiSession) -> bool {
    me.is_superuser || is_mine(me, s)
}

pub(crate) fn session_json(s: &AiSession, tz: i32) -> Value {
    json!({
        "id": s.id,
        "user": { "id": s.user_id, "username": s.user_name },
        "client_name": s.client_name,
        "grant_id": s.credential.grant_id(),
        "token_id": s.credential.token_id(),
        "tunnel": { "id": s.tunnel_id, "name": s.tunnel_name },
        "username": s.target_username,
        "created_at": db_to_iso(&s.created_at(), tz),
        "last_used_at": db_to_iso(&s.last_used_at(), tz),
        "expires_at": db_to_iso(&s.expires_at(), tz),
        "idle_timeout_s": s.idle_timeout.as_secs(),
        "commands": s.commands(),
        "shells": s.shell_count(),
        "busy": s.busy(),
    })
}

/// 「我的」：我開的 ∪ 在我擁有的隧道上的（管理員也一樣；全部要 `scope=all`）。/ "Mine": mine plus those on my tunnels.
fn is_mine(me: &User, s: &AiSession) -> bool {
    s.user_id == me.id || s.tunnel_owner_id == me.id
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct ScopeQuery {
    scope: Option<String>,
}

#[utoipa::path(get, path = "/api/ai/sessions", tag = "AI", security(("bearer" = [])), params(("scope" = Option<String>, Query, description = "mine (default, admins too: yours plus those on tunnels you own) or all (admins only)")), responses((status = 200, description = "Open AI sessions in the scope, oldest first", body = Vec<super::schemas::AiSession>), (status = 403, description = "scope=all from a non-admin (code admin_only)", body = super::schemas::ErrorBody)))]
async fn list_sessions(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, Query(q): Query<ScopeQuery>) -> ApiResult<Json<Value>> {
    let all = super::ViewScope::parse(q.scope.as_deref(), me.is_superuser)? == super::ViewScope::All;
    let tz = state.config.tz_offset_minutes;
    Ok(Json(Value::Array(state.ai.list().iter().filter(|s| (all || is_mine(&me, s)) && d.allows(s.tunnel_id)).map(|s| session_json(s, tz)).collect())))
}

/// REST 版的 session 只給委派 token（session 要記是哪把 token / 哪個 app 開的）。/ Delegated tokens only.
fn principal(d: &Delegated) -> ApiResult<std::sync::Arc<McpPrincipal>> {
    d.0.clone().ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Sessions are opened with an API token or a connected app; the web app uses the terminal instead.", "code": "token_required" })))
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct OpenBody {
    tunnel_id: i64,
    username: Option<String>,
    idle_timeout_s: Option<u64>,
    max_lifetime_s: Option<u64>,
}

#[utoipa::path(post, path = "/api/ai/sessions", tag = "AI", security(("bearer" = [])), request_body = super::schemas::AiSessionOpen, responses(
    (status = 201, description = "Opened (the REST form of the MCP tool ssh_session_open; API tokens and connected apps only)", body = super::schemas::AiSession),
    (status = 400, description = "The tunnel, account, limit or device problem, as text", body = super::schemas::ErrorBody),
    (status = 403, description = "token_required (a web sign-in), token_scope, feature_disabled", body = super::schemas::ErrorBody),
))]
async fn open_session(State(state): State<AppState>, AuthUser(_me): AuthUser, d: Delegated, super::AppJson(body): super::AppJson<OpenBody>) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = principal(&d)?;
    let args = crate::mcp::OpenArgs { tunnel_id: body.tunnel_id, username: body.username, idle_timeout_s: body.idle_timeout_s, max_lifetime_s: body.max_lifetime_s };
    let s = crate::mcp::open_session(&state, &p, args).await.map_err(ApiError::bad_request)?;
    Ok((StatusCode::CREATED, Json(session_json(&s, state.config.tz_offset_minutes))))
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct ExecBody {
    command: String,
    timeout_s: Option<u64>,
    max_output_bytes: Option<usize>,
}

#[utoipa::path(post, path = "/api/ai/sessions/{id}/exec", tag = "AI", security(("bearer" = [])), params(("id" = String, Path, description = "Session id (ais_…)")), request_body = super::schemas::AiExecRequest, responses(
    (status = 200, description = "The command ran (exit_code / stdout / stderr; the REST form of ssh_exec). Command rules apply: a blocked or still-waiting command is a 400", body = super::schemas::AiExecResult),
    (status = 400, body = super::schemas::ErrorBody),
    (status = 404, description = "Not a session this token opened", body = super::schemas::ErrorBody),
))]
async fn exec(State(state): State<AppState>, AuthUser(_me): AuthUser, d: Delegated, Path(id): Path<String>, super::AppJson(body): super::AppJson<ExecBody>) -> ApiResult<Json<Value>> {
    let p = principal(&d)?;
    let s = state.ai.get(&id).filter(|s| s.user_id == p.user.id && s.credential == p.credential).ok_or_else(ApiError::drf_not_found)?;
    let out = crate::mcp::exec_in_session(&state, &p, &s, &body.command, body.timeout_s, body.max_output_bytes).await.map_err(ApiError::bad_request)?;
    Ok(Json(out))
}

#[utoipa::path(delete, path = "/api/ai/sessions/{id}", tag = "AI", security(("bearer" = [])), params(("id" = String, Path, description = "Session id (ais_…)")), responses((status = 204, description = "Closed; the agent's next call with this session_id fails"), (status = 404, body = super::schemas::ErrorBody)))]
async fn close_session(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, Path(id): Path<String>) -> ApiResult<StatusCode> {
    match state.ai.get(&id) {
        Some(s) if can_manage(&me, &s) && d.allows(s.tunnel_id) => {
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
    scope: Option<String>,
}

#[utoipa::path(get, path = "/api/ai/activity", tag = "AI", security(("bearer" = [])), params(
    ("limit" = Option<i64>, Query, description = "Max rows, newest first (default 200, max 1000)"),
    ("tunnel_id" = Option<i64>, Query),
    ("user_id" = Option<i64>, Query),
    ("grant_id" = Option<i64>, Query, description = "Only the calls of one connected app (OAuth grant)"),
    ("scope" = Option<String>, Query, description = "mine (default, admins too: your own calls plus calls on tunnels you own) or all (admins only)"),
), responses((status = 200, description = "MCP tool calls in the scope, newest first", body = Vec<super::schemas::AiActivity>), (status = 403, description = "scope=all from a non-admin (code admin_only)", body = super::schemas::ErrorBody)))]
async fn activity(State(state): State<AppState>, AuthUser(me): AuthUser, Query(q): Query<ActivityQuery>) -> ApiResult<Json<Value>> {
    let all = super::ViewScope::parse(q.scope.as_deref(), me.is_superuser)? == super::ViewScope::All;
    let filter = db::ai_audit::Filter {
        visible_to: (!all).then_some(me.id),
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
