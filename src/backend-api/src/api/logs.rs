//! `/api/log/ssh`：SSH 伺服器日誌。
//! - gateway 模式（預設）：從 `telepy_gateway_event` 渲染最後 500 筆成 sshd 風格文字行（JSON 字串，前端 unwrap），
//!   沒有事件時回空字串（200），不再 404。
//! - 外接 sshd 模式：讀 `SSH_LOGS_PATH` 的文字檔最後 500 行（舊行為）。
//! `/api/log/ssh/events`：結構化事件（JSON 陣列），給 Logs 頁與自動化用；`?tunnel_id=` 只看某條隧道。
//!
//! 可見範圍：管理員看全部（含 listening / preauth 這類沒有隧道的事件）；一般使用者只看自己擁有或被分享的
//! 隧道的事件，指定別人的 tunnel_id 回 404。
//! Scope: admins see everything (including tunnel-less events such as listening / preauth); other users only
//! see events of tunnels they own or that are shared with them, and asking for another tunnel is a 404.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::auth::AuthUser;
use crate::db::{self, users::User};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::db_to_iso;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(ssh_logs))
        .routes(routes!(ssh_events))
        .routes(routes!(audit_verify))
}

/// 稽核表的雜湊鏈驗證（只有管理員）：逐列重算 hash、檢查 prev_hash 連結，並比對 DB 外的 audit-anchors.log。
/// Verify the audit tables' hash chains and the outside checkpoints (superusers only).
#[utoipa::path(get, path = "/api/log/audit/verify", tag = "Logs", security(("bearer" = [])), responses((status = 200, description = "Per-table result of walking the hash chain of the gateway, sign-in and AI audit tables and checking the checkpoints in audit-anchors.log", body = super::schemas::AuditVerifyReport), (status = 403, description = "Not a superuser", body = super::schemas::ErrorBody)))]
async fn audit_verify(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    if !user.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can verify the audit log."));
    }
    let report = db::audit_chain::verify(&state.db).await?;
    Ok(Json(serde_json::to_value(report).map_err(|e| ApiError::internal(e.to_string()))?))
}

#[derive(Debug, FromRow)]
pub struct GatewayEvent {
    pub id: i64,
    pub at: String,
    pub event: String,
    pub peer: Option<String>,
    pub port: Option<i64>,
    pub tunnel_id: Option<i64>,
    pub message: String,
}

/// 使用者看得到哪些隧道的事件。/ Which tunnels' events a user may see.
enum Scope {
    All,
    Tunnels(Vec<i64>),
}

async fn scope_for(state: &AppState, user: &User) -> sqlx::Result<Scope> {
    if user.is_superuser {
        return Ok(Scope::All);
    }
    Ok(Scope::Tunnels(db::tunnels::visible_to(&state.db, user.id).await?.into_iter().map(|t| t.id).collect()))
}

async fn recent_events(state: &AppState, limit: i64, tunnel_id: Option<i64>, scope: &Scope) -> ApiResult<Vec<GatewayEvent>> {
    let limit = limit.clamp(1, 5000);
    // 只有整數進 SQL（tunnel id），不會有注入問題。/ Only integers reach the SQL text.
    let filter = match (tunnel_id, scope) {
        (Some(t), Scope::All) => format!("WHERE tunnel_id = {t}"),
        (Some(t), Scope::Tunnels(ids)) => {
            if !ids.contains(&t) {
                return Err(ApiError::not_found("Reverse server keys not found"));
            }
            format!("WHERE tunnel_id = {t}")
        }
        (None, Scope::All) => String::new(),
        (None, Scope::Tunnels(ids)) => {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            format!("WHERE tunnel_id IN ({})", ids.iter().map(i64::to_string).collect::<Vec<_>>().join(","))
        }
    };
    let rows: Vec<GatewayEvent> =
        sqlx::query_as(&format!("SELECT id, at, event, peer, port, tunnel_id, message FROM telepy_gateway_event {filter} ORDER BY id DESC LIMIT ?"))
            .bind(limit)
            .fetch_all(&state.db.read)
            .await?;
    Ok(rows.into_iter().rev().collect())
}

/// sshd 風格文字行：`YYYY-MM-DD HH:MM:SS.ffffff  message`（Logs 頁的 regex 吃這個格式）。
fn render_line(e: &GatewayEvent, tz: i32) -> String {
    let ts = match crate::util::parse_db_datetime(&e.at) {
        Some(naive) => {
            let offset = chrono::FixedOffset::east_opt(tz * 60).unwrap_or_else(|| chrono::FixedOffset::east_opt(0).unwrap());
            chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc).with_timezone(&offset).format("%Y-%m-%d %H:%M:%S%.6f").to_string()
        }
        None => e.at.clone(),
    };
    format!("{ts}  {}", e.message)
}

#[utoipa::path(get, path = "/api/log/ssh", tag = "Logs", security(("bearer" = [])), responses((status = 200, description = "Last 500 gateway events visible to the user (admins: all; others: their own and shared tunnels) rendered as sshd-style lines, as one JSON string", body = String)))]
async fn ssh_logs(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let scope = scope_for(&state, &user).await?;
    let events = recent_events(&state, 500, None, &scope).await?;
    let tz = state.config.tz_offset_minutes;
    let text = events.iter().map(|e| render_line(e, tz)).collect::<Vec<_>>().join("\n");
    Ok(Json(Value::String(text)))
}

/// `?limit=` (default 200, max 5000) `&tunnel_id=`
#[utoipa::path(get, path = "/api/log/ssh/events", tag = "Logs", security(("bearer" = [])), params(("limit" = Option<i64>, Query, description = "Default 200, max 5000"), ("tunnel_id" = Option<i64>, Query, description = "Only events of this tunnel (must be visible to you)")), responses((status = 200, description = "Oldest first; admins see every event, other users only those of tunnels they own or that are shared with them", body = Vec<super::schemas::GatewayEvent>), (status = 404, description = "tunnel_id is not a tunnel you can see", body = super::schemas::ErrorBody)))]
async fn ssh_events(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let limit = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(200);
    let tunnel_id = q.get("tunnel_id").and_then(|v| v.parse().ok());
    let scope = scope_for(&state, &user).await?;
    let events = recent_events(&state, limit, tunnel_id, &scope).await?;
    let tz = state.config.tz_offset_minutes;
    Ok(Json(Value::Array(
        events
            .iter()
            .map(|e| json!({
                "id": e.id,
                "at": db_to_iso(&e.at, tz),
                "event": e.event,
                "peer": e.peer,
                "port": e.port,
                "tunnel_id": e.tunnel_id,
                "message": e.message,
            }))
            .collect(),
    )))
}
