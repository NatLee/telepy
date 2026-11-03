//! `/api/reverse/server/{id}/remote-browser/start`、`/remote-browser/{sid}/{stop,ping}`（browse_views.py）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::remote_browser::StartError;
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::json_str;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(start))
        .routes(routes!(stop))
        .routes(routes!(open_tab))
        .routes(routes!(ping))
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/remote-browser/start", tag = "Remote Browser", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::RemoteBrowserStartRequest, responses((status = 200, description = "Session started; connect the KasmVNC client to ws_path", body = super::schemas::RemoteBrowserSession), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 500, description = "code = device_offline when the SOCKS proxy never came up", body = super::schemas::RemoteBrowserError)))]
async fn start(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::forbidden("Permission denied"));
    }
    super::step_up::check(&state, user.id, &tunnel, &headers)?;
    let allowed = permissions::allowed_usernames(&state.db, user.id, &tunnel).await?;
    let username = match json_str(&body, "username").filter(|u| !u.is_empty()) {
        Some(u) => {
            if !allowed.iter().any(|a| a.username == u) {
                return Err(ApiError::forbidden("Username not authorized"));
            }
            u
        }
        None => {
            if allowed.is_empty() {
                return Err(ApiError::forbidden("No authorized target user available"));
            }
            let default = tunnel.default_username_id.and_then(|d| allowed.iter().find(|a| a.id == d));
            default.or_else(|| allowed.first()).map(|a| a.username.clone()).unwrap()
        }
    };
    // 一開始要打開的網址（區網主機的網頁）：只收 http / https。/ The page to open first (a LAN host's web page): http / https only.
    let url = match json_str(&body, "url").filter(|u| !u.trim().is_empty()) {
        Some(u) => Some(crate::ai::browser::normalize_url(&u).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": e, "code": "bad_url" })))?),
        None => None,
    };
    // 開始畫面的進度：每一步送給按下開始的人，帶著瀏覽器給的 `progress_id`（同一條隧道開兩個分頁也分得開）。
    // Start progress goes to the person starting it, tagged with the tab's `progress_id` (two tabs on one tunnel stay apart).
    let progress_id: Option<String> = json_str(&body, "progress_id").filter(|p| !p.is_empty() && p.len() <= 64 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    let hub = state.hub.clone();
    let on = move |step: &'static str, phase: &'static str, extra: Value| {
        let Some(pid) = &progress_id else { return };
        let mut msg = json!({ "action": "REMOTE-BROWSER-PROGRESS", "tunnel_id": id, "progress_id": pid, "step": step, "state": phase });
        if let (Some(m), Some(e)) = (msg.as_object_mut(), extra.as_object()) {
            m.extend(e.clone());
        }
        hub.notify_user(user.id, &msg);
    };
    match state.remote_browser.start_observed(&state, &username, tunnel.reverse_port, id, url, on).await {
        Ok(v) => Ok(Json(v)),
        Err(StartError::Coded { message, code }) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": message, "code": code }))),
        Err(StartError::Other(message)) => Err(ApiError::internal(message)),
    }
}

#[utoipa::path(post, path = "/api/reverse/server/remote-browser/{sid}/stop", tag = "Remote Browser", security(("bearer" = [])), params(("sid" = String, Path, description = "Session id")), responses((status = 200, body = super::schemas::Status), (status = 404, body = super::schemas::ErrorBody)))]
async fn stop(State(state): State<AppState>, _user: AuthUser, Path(sid): Path<String>) -> ApiResult<Json<Value>> {
    if state.remote_browser.stop(&state.db, &sid).await {
        Ok(Json(json!({ "status": "success" })))
    } else {
        Err(ApiError::not_found("Session not found"))
    }
}

/// 在開著的遠端瀏覽器裡開一個新分頁（網路頁「在這裡開」同一台裝置的另一個網頁時）。只有還能用這個 session 的人：
/// 看得到那條隧道、而且它的裝置帳號還在你的允許清單裡（跟 WebSocket 同一條規則）。
/// Open a new tab in an open remote browser (the network page opening another page on the same device). Only for
/// someone who may still use the session: sees the tunnel and still has its device account (the WebSocket's rule).
#[utoipa::path(post, path = "/api/reverse/server/remote-browser/{sid}/open", tag = "Remote Browser", security(("bearer" = [])), params(("sid" = String, Path, description = "Session id")), request_body = super::schemas::RemoteBrowserOpenRequest, responses((status = 200, description = "The new tab", body = super::schemas::RemoteBrowserTab), (status = 400, description = "code = bad_url", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 502, description = "code = browser_action_failed", body = super::schemas::ErrorBody)))]
async fn open_tab(State(state): State<AppState>, AuthUser(user): AuthUser, Path(sid): Path<String>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let session = state.remote_browser.get(&sid).ok_or_else(|| ApiError::not_found("Session not found"))?;
    let tunnel = db::tunnels::by_id(&state.db, session.server_id).await?.ok_or_else(|| ApiError::not_found("Session not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::not_found("Session not found"));
    }
    if !permissions::allowed_usernames(&state.db, user.id, &tunnel).await?.iter().any(|a| a.username == session.username) {
        return Err(ApiError::not_found("Session not found"));
    }
    let raw = json_str(&body, "url").unwrap_or_default();
    let url = crate::ai::browser::normalize_url(&raw).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": e, "code": "bad_url" })))?;
    match state.remote_browser.open_tab(&sid, &url).await {
        Ok(v) => Ok(Json(json!({ "url": v.get("url").cloned().unwrap_or(json!(url)), "id": v.get("id") }))),
        Err(e) => Err(ApiError::new(StatusCode::BAD_GATEWAY, json!({ "error": e, "code": "browser_action_failed" }))),
    }
}

#[utoipa::path(post, path = "/api/reverse/server/remote-browser/{sid}/ping", tag = "Remote Browser", security(("bearer" = [])), params(("sid" = String, Path, description = "Session id")), responses((status = 200, description = "Session alive (TTL refreshed)", body = super::schemas::Status), (status = 404, description = "Unknown or dead session (reaped)", body = super::schemas::ErrorBody)))]
async fn ping(State(state): State<AppState>, _user: AuthUser, Path(sid): Path<String>) -> ApiResult<Json<Value>> {
    if state.remote_browser.ping(&state.db, &sid).await {
        Ok(Json(json!({ "status": "ok" })))
    } else {
        Err(ApiError::not_found("Session not found"))
    }
}
