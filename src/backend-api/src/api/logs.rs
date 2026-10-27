//! `/api/log/ssh`：SSH 伺服器日誌。
//! - gateway 模式（預設）：從 `telepy_gateway_event` 渲染最後 500 筆成 sshd 風格文字行（JSON 字串，前端 unwrap），
//!   沒有事件時回空字串（200），不再 404。
//! - 外接 sshd 模式：讀 `SSH_LOGS_PATH` 的文字檔最後 500 行（舊行為）。
//! `/api/log/ssh/events`：結構化事件（JSON 陣列），給 Logs 頁與自動化用；`?tunnel_id=` 只看某條隧道。
//!
//! `/api/log/tunnels`：管理區篩選用的全站隧道清單（只有管理員）。
//!
//! 可見範圍（`?scope=`）：`mine`（預設，管理員也一樣）= 自己擁有或被分享的隧道的事件，指定別人的 tunnel_id 回 404
//! （管理員指定任何一條都可以）；`all` 只給管理員 = 全部，含 listening / 群組 / token 這類沒有隧道的事件
//! （`tunnel_id=none` 只看這些）。
//! Scope (`?scope=`): `mine` (default, admins too) = events of tunnels you own or that are shared with you, another
//! tunnel is a 404 (admins may name any); `all`, admins only = everything, including tunnel-less events such as
//! listening / groups / tokens (`tunnel_id=none` = only those).

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Value};
use sqlx::FromRow;

use super::ViewScope;
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
        .routes(routes!(all_tunnels))
}

#[derive(Debug, FromRow)]
struct TunnelRow {
    id: i64,
    name: String,
    reverse_port: i64,
    owner_id: i64,
    owner: Option<String>,
}

/// 管理區的篩選選單：全站每一條隧道與擁有者（隧道列表只列自己的與分享給自己的）。
/// The admin section's filters: every tunnel on the site with its owner (the tunnel list only has your own / shared ones).
#[utoipa::path(get, path = "/api/log/tunnels", tag = "Logs", security(("bearer" = [])), responses((status = 200, description = "Every tunnel with its owner, by name (admins only; for the admin section's tunnel filters)", body = Vec<super::schemas::AdminTunnel>), (status = 403, body = super::schemas::ErrorBody)))]
async fn all_tunnels(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    ViewScope::parse(Some("all"), user.is_superuser)?;
    let rows: Vec<TunnelRow> = sqlx::query_as(
        "SELECT t.id, t.host_friendly_name AS name, t.reverse_port, t.user_id AS owner_id, u.username AS owner \
         FROM authorized_keys_reverseserverauthorizedkeys t LEFT JOIN auth_user u ON u.id = t.user_id \
         ORDER BY lower(t.host_friendly_name), t.id",
    )
    .fetch_all(&state.db.read)
    .await?;
    Ok(Json(Value::Array(
        rows.into_iter()
            .map(|r| json!({ "id": r.id, "name": r.name, "reverse_port": r.reverse_port, "owner": { "id": r.owner_id, "username": r.owner } }))
            .collect(),
    )))
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
    /// 隧道還在時的名稱（刪掉的隧道 = None）。/ The tunnel's name while it exists (None once deleted).
    pub tunnel_name: Option<String>,
    pub message: String,
}

/// 使用者看得到哪些隧道的事件。/ Which tunnels' events a user may see.
enum Scope {
    All,
    Tunnels(Vec<i64>),
}

/// `?tunnel_id=`：一條隧道、`none` = 沒有隧道的站台事件（listening、群組、token…），或不限。
/// `?tunnel_id=`: one tunnel, `none` = the tunnel-less site events (listening, groups, tokens…), or any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TunnelFilter {
    Any,
    One(i64),
    Site,
}

fn tunnel_filter(q: &HashMap<String, String>) -> TunnelFilter {
    match q.get("tunnel_id").map(|v| v.trim()) {
        Some("none") => TunnelFilter::Site,
        Some(v) => v.parse().map(TunnelFilter::One).unwrap_or(TunnelFilter::Any),
        None => TunnelFilter::Any,
    }
}

/// `mine`（預設）= 自己擁有或被分享的隧道，管理員也一樣；`all` = 全部（管理區）。管理員指定某一條隧道時
/// （隧道列表的「日誌」）任何隧道都可以看。
/// `mine` (default) = tunnels you own or that are shared with you, admins included; `all` = everything (the admin
/// section). An admin naming one tunnel (the tunnel list's "Logs") may look at any tunnel.
async fn scope_for(state: &AppState, user: &User, wanted: ViewScope, filter: TunnelFilter) -> sqlx::Result<Scope> {
    if wanted == ViewScope::All || (user.is_superuser && matches!(filter, TunnelFilter::One(_))) {
        return Ok(Scope::All);
    }
    Ok(Scope::Tunnels(db::tunnels::visible_to(&state.db, user.id).await?.into_iter().map(|t| t.id).collect()))
}

async fn recent_events(state: &AppState, limit: i64, filter: TunnelFilter, scope: &Scope) -> ApiResult<Vec<GatewayEvent>> {
    let limit = limit.clamp(1, 5000);
    // 只有整數進 SQL（tunnel id），不會有注入問題。/ Only integers reach the SQL text.
    let filter = match (filter, scope) {
        (TunnelFilter::One(t), Scope::All) => format!("WHERE e.tunnel_id = {t}"),
        (TunnelFilter::One(t), Scope::Tunnels(ids)) => {
            if !ids.contains(&t) {
                return Err(ApiError::not_found("Reverse server keys not found"));
            }
            format!("WHERE e.tunnel_id = {t}")
        }
        (TunnelFilter::Site, Scope::All) => "WHERE e.tunnel_id IS NULL".to_string(),
        // 站台事件只在 `all` 裡。/ Site events only exist in `all`.
        (TunnelFilter::Site, Scope::Tunnels(_)) => return Ok(Vec::new()),
        (TunnelFilter::Any, Scope::All) => String::new(),
        (TunnelFilter::Any, Scope::Tunnels(ids)) => {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            format!("WHERE e.tunnel_id IN ({})", ids.iter().map(i64::to_string).collect::<Vec<_>>().join(","))
        }
    };
    let rows: Vec<GatewayEvent> = sqlx::query_as(&format!(
        "SELECT e.id, e.at, e.event, e.peer, e.port, e.tunnel_id, t.host_friendly_name AS tunnel_name, e.message \
         FROM telepy_gateway_event e LEFT JOIN authorized_keys_reverseserverauthorizedkeys t ON t.id = e.tunnel_id \
         {filter} ORDER BY e.id DESC LIMIT ?"
    ))
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

#[utoipa::path(get, path = "/api/log/ssh", tag = "Logs", security(("bearer" = [])), params(("scope" = Option<String>, Query, description = "mine (default: tunnels you own or that are shared with you) or all (admins only)")), responses((status = 200, description = "Last 500 gateway events in the scope rendered as sshd-style lines, as one JSON string", body = String), (status = 403, description = "scope=all from a non-admin (code admin_only)", body = super::schemas::ErrorBody)))]
async fn ssh_logs(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let wanted = ViewScope::parse(q.get("scope").map(String::as_str), user.is_superuser)?;
    let scope = scope_for(&state, &user, wanted, TunnelFilter::Any).await?;
    let events = recent_events(&state, 500, TunnelFilter::Any, &scope).await?;
    let tz = state.config.tz_offset_minutes;
    let text = events.iter().map(|e| render_line(e, tz)).collect::<Vec<_>>().join("\n");
    Ok(Json(Value::String(text)))
}

/// `?limit=` (default 200, max 5000) `&tunnel_id=<id>|none` `&scope=mine|all`
#[utoipa::path(get, path = "/api/log/ssh/events", tag = "Logs", security(("bearer" = [])), params(
    ("limit" = Option<i64>, Query, description = "Default 200, max 5000"),
    ("tunnel_id" = Option<String>, Query, description = "Only events of this tunnel (must be visible to you; admins may name any tunnel), or `none` = the tunnel-less site events (scope=all only)"),
    ("scope" = Option<String>, Query, description = "mine (default, also for admins: tunnels you own or that are shared with you) or all (admins only: every event, tunnel-less ones included)"),
), responses((status = 200, description = "Oldest first", body = Vec<super::schemas::GatewayEvent>), (status = 403, description = "scope=all from a non-admin (code admin_only)", body = super::schemas::ErrorBody), (status = 404, description = "tunnel_id is not a tunnel you can see", body = super::schemas::ErrorBody)))]
async fn ssh_events(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let limit = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(200);
    let wanted = ViewScope::parse(q.get("scope").map(String::as_str), user.is_superuser)?;
    let filter = tunnel_filter(&q);
    let scope = scope_for(&state, &user, wanted, filter).await?;
    let events = recent_events(&state, limit, filter, &scope).await?;
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
                "tunnel_name": e.tunnel_name,
                "message": e.message,
            }))
            .collect(),
    )))
}
