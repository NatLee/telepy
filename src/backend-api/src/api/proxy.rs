//! `/api/proxy/*`：裝置代理（`crate::proxy`）的 REST 部分——連線本身走 `/ws/proxy/` 或代理入口，這裡只有「能經哪些通道
//! 代理」與「現在開著哪些代理 session」。
//! - `GET /api/proxy/tunnels`：這個呼叫者能代理的通道（app / token 只看得到授權時選的那些），加上入口網址。串接的
//!   app 拿它來讓使用者挑通道。token 要 `proxy:use`；網頁登入也能打（API 頁的說明用）。
//! - `GET /api/proxy/sessions[?scope=mine|all]`：開著的代理 session（token = 自己那把開的；網頁 = 自己的與自己通道
//!   上的；`all` 只有管理員）。
//! - `DELETE /api/proxy/sessions/{id}`：結束一個（開的人、通道擁有者、管理員）。
//!
//! The REST side of the device proxy (`crate::proxy`). Connections themselves ride `/ws/proxy/` or the proxy
//! endpoint; here are only "which tunnels may I proxy through" and "which proxy sessions are open".

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::extractor::Delegated;
use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::features::Feature;
use crate::permissions;
use crate::proxy::{self, ProxyError};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(tunnels)).routes(routes!(sessions)).routes(routes!(end))
}

fn api_err(e: ProxyError) -> ApiError {
    ApiError::new(e.status, e.json())
}

/// 入口網址：`/ws/proxy/` 永遠有（跟著對外的網址）；標準 HTTP 代理入口有設才有。
/// The ways in: `/ws/proxy/` always (it follows the public URL); the standard HTTP proxy endpoint only when configured.
pub fn endpoints(state: &AppState, headers: &HeaderMap) -> Value {
    let base = crate::oauth::issuer(state.config.public_base().as_deref(), headers);
    let ws = match base.strip_prefix("https://") {
        Some(rest) => format!("wss://{rest}/ws/proxy/"),
        None => format!("ws://{}/ws/proxy/", base.trim_start_matches("http://")),
    };
    json!({ "websocket": ws, "http_proxy": Value::Null })
}

#[utoipa::path(get, path = "/api/proxy/tunnels", tag = "Device Proxy", security(("bearer" = [])), responses((status = 200, description = "The tunnels this caller may proxy through (an app or token only sees the ones chosen at authorization), whether each is usable right now, and the proxy endpoints", body = super::schemas::ProxyTunnels), (status = 403, description = "code = proxy_disabled | token_scope | feature_disabled (tokens and apps only; a web sign-in gets `enabled: false` instead)", body = super::schemas::ErrorBody)))]
async fn tunnels(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let settings = match &d.0 {
        Some(p) => proxy::check_allowed(&state, p).await.map_err(api_err)?,
        None => db::settings::get_solo(&state.db).await?,
    };
    let allowed_feature = state.features.allowed(&me, Feature::Proxy).await?;
    let listen = state.status.listen_ports();
    let mut out = Vec::new();
    for t in db::tunnels::visible_to(&state.db, me.id).await?.into_iter().filter(|t| d.allows(t.id)) {
        if permissions::effective_for(&state.db, me.id, &t).await?.is_none() {
            continue;
        }
        let accounts = permissions::allowed_usernames(&state.db, me.id, &t).await?;
        let default = t.default_username_id.and_then(|id| accounts.iter().find(|a| a.id == id)).or(if accounts.len() == 1 { accounts.first() } else { None }).map(|a| a.username.clone());
        let online = listen.as_ref().map(|l| u16::try_from(t.reverse_port).map(|p| l.contains(&p)).unwrap_or(false));
        // 為什麼現在不能用（null = 可以）。/ Why it can't be used right now (null = it can).
        let blocked = if t.require_step_up {
            Some("step_up")
        } else if accounts.is_empty() {
            Some("no_account")
        } else if online == Some(false) {
            Some("offline")
        } else {
            None
        };
        out.push(json!({
            "id": t.id,
            "name": t.host_friendly_name,
            "online": online,
            "accounts": accounts.iter().map(|a| a.username.clone()).collect::<Vec<_>>(),
            "default_account": default,
            "blocked": blocked,
        }));
    }
    Ok(Json(json!({
        "enabled": settings.proxy_enabled,
        "allowed": allowed_feature,
        "scope": proxy::SCOPE,
        "max_connections": settings.proxy_max_connections,
        "idle_seconds": proxy::IDLE.as_secs(),
        "endpoints": endpoints(&state, &headers),
        "tunnels": out,
    })))
}

#[derive(Debug, Deserialize, Default)]
struct SessionsQuery {
    scope: Option<String>,
}

#[utoipa::path(get, path = "/api/proxy/sessions", tag = "Device Proxy", security(("bearer" = [])), params(("scope" = Option<String>, Query, description = "mine (default) | all (administrators)")), responses((status = 200, description = "Open proxy sessions: one per credential, tunnel and device account, with its live connection count, totals and destinations. A token or app sees the ones it opened; a web sign-in sees its own and those on tunnels it owns", body = Vec<super::schemas::ProxySession>), (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody)))]
async fn sessions(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, Query(q): Query<SessionsQuery>) -> ApiResult<Json<Value>> {
    let scope = super::ViewScope::parse(q.scope.as_deref(), me.is_superuser && d.0.is_none())?;
    let tz = state.config.tz_offset_minutes;
    let mut out = Vec::new();
    for s in state.proxy.list() {
        let show = match (&d.0, scope) {
            (Some(p), _) => s.credential == p.credential,
            (None, super::ViewScope::All) => true,
            (None, super::ViewScope::Mine) => s.user_id == me.id || db::tunnels::by_id(&state.db, s.tunnel_id).await?.is_some_and(|t| t.user_id == me.id),
        };
        if show {
            out.push(s.json(tz));
        }
    }
    Ok(Json(Value::Array(out)))
}

#[utoipa::path(delete, path = "/api/proxy/sessions/{id}", tag = "Device Proxy", security(("bearer" = [])), params(("id" = String, Path, description = "Proxy session id (px_…)")), responses((status = 200, description = "Ended: every connection of the session is cut", body = super::schemas::Status), (status = 404, body = super::schemas::ErrorBody)))]
async fn end(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let not_found = || ApiError::new(StatusCode::NOT_FOUND, json!({ "error": "No such open proxy session.", "code": "proxy_not_found" }));
    let s = state.proxy.get(&id).ok_or_else(not_found)?;
    let may = match &d.0 {
        Some(p) => s.credential == p.credential,
        None => me.is_superuser || s.user_id == me.id || db::tunnels::by_id(&state.db, s.tunnel_id).await?.is_some_and(|t| t.user_id == me.id),
    };
    if !may {
        return Err(not_found());
    }
    let reason = if s.user_id == me.id { "ended by its owner".to_string() } else { format!("ended by {}", me.username) };
    proxy::close(&state, &s, &reason).await;
    Ok(Json(json!({ "status": "ended" })))
}
