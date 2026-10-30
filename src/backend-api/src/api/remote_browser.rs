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
    match state.remote_browser.start_observed(&state, &username, tunnel.reverse_port, id, on).await {
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

#[utoipa::path(post, path = "/api/reverse/server/remote-browser/{sid}/ping", tag = "Remote Browser", security(("bearer" = [])), params(("sid" = String, Path, description = "Session id")), responses((status = 200, description = "Session alive (TTL refreshed)", body = super::schemas::Status), (status = 404, description = "Unknown or dead session (reaped)", body = super::schemas::ErrorBody)))]
async fn ping(State(state): State<AppState>, _user: AuthUser, Path(sid): Path<String>) -> ApiResult<Json<Value>> {
    if state.remote_browser.ping(&state.db, &sid).await {
        Ok(Json(json!({ "status": "ok" })))
    } else {
        Err(ApiError::not_found("Session not found"))
    }
}
