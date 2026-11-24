//! `/api/reverse/server/{id}/remote-browser/start`、`/remote-browser/{sid}/{stop,ping}`（browse_views.py）。

use axum::extract::{Path, Query, State};
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
        .routes(routes!(ports))
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

fn ports_error(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// 裝置自己現在在聽哪些 port，給瀏覽器面板 / `telepy browse ports` / MCP `browser_ports` 看：用這個人的裝置帳號跑一次
/// 掃描用的那個唯讀指令（`ss` / `netstat` / `lsof`，再來 PowerShell），不探測、不存檔；上次掃描存下來的標題拿來標名字。
/// 呼叫的人已經看過 VIEW（與 step-up）。
/// The ports the device itself listens on right now, for the browser panel / `telepy browse ports` / MCP
/// `browser_ports`: one run of the scan's read-only command (`ss` / `netstat` / `lsof`, then PowerShell) as this
/// person's device account; nothing is probed or stored, and the titles the last scan kept name the ports. The caller
/// has checked VIEW (and step-up).
pub async fn device_ports(state: &AppState, user: &crate::db::users::User, t: &crate::db::tunnels::Tunnel, username: Option<&str>) -> ApiResult<Value> {
    use crate::lan::device_self;
    let allowed = permissions::allowed_usernames(&state.db, user.id, t).await?;
    if allowed.is_empty() {
        return Err(ports_error(StatusCode::FORBIDDEN, "no_account", "You have no account you may use on this device."));
    }
    let username = permissions::choose_username(&allowed, t.default_username_id, username, &t.host_friendly_name).map_err(|e| ports_error(StatusCode::BAD_REQUEST, "username", e))?;
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(t.reverse_port).map(|p| listen.contains(&p)).unwrap_or(false) {
            return Err(ports_error(StatusCode::BAD_REQUEST, "device_offline", format!("The device '{}' is offline.", t.host_friendly_name)));
        }
    }
    let run = |cmd: &'static str| {
        let state = state.clone();
        let username = username.clone();
        async move {
            match state.pool.session_channel(&state, t.reverse_port, &username).await {
                Ok((_lease, ch)) => crate::ssh::exec::run_on(ch, cmd, std::time::Duration::from_secs(10), 256 * 1024).await.map(|r| r.stdout.text).map_err(|e| format!("{e:#}")),
                Err(e) => Err(format!("cannot log in to the device as {username}: {e:#}")),
            }
        }
    };
    let mut listening = device_self::parse_listening(&run(device_self::LISTEN_POSIX).await.map_err(|e| ports_error(StatusCode::BAD_GATEWAY, "ports_failed", e))?);
    if listening.is_empty() {
        listening = device_self::parse_listening(&run(device_self::LISTEN_WINDOWS).await.unwrap_or_default());
    }
    // 上次掃描看到的裝置自己的服務（標題、協定）。/ What the last scan saw on the device itself (titles, protocols).
    let own = db::lan::hosts_for_tunnel(&state.db, t.id).await?.into_iter().find(|h| h.source == "self");
    let seen = own.as_ref().map(|h| h.service_list()).unwrap_or_default();
    let ports = device_self::browse_ports(&listening, &seen);
    Ok(json!({
        "tunnel_id": t.id,
        "username": username,
        // 裝置上沒有任何一個列得出 port 的工具。/ No tool on the device could list its ports.
        "listed": !listening.is_empty(),
        "scanned": own.is_some(),
        "ports": ports,
    }))
}

#[derive(serde::Deserialize)]
struct PortsQuery {
    username: Option<String>,
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/remote-browser/ports", tag = "Remote Browser", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = Option<String>, Query, description = "Device account to ask as; omit for the tunnel's default")), responses((status = 200, description = "The ports the device listens on right now, web pages first; `url` is what the remote browser would open", body = super::schemas::RemoteBrowserPorts), (status = 400, description = "code = device_offline | username", body = super::schemas::ErrorBody), (status = 403, description = "code = no_account", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 502, description = "code = ports_failed", body = super::schemas::ErrorBody)))]
async fn ports(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path(id): Path<i64>, Query(q): Query<PortsQuery>) -> ApiResult<Json<Value>> {
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::forbidden("Permission denied"));
    }
    super::step_up::check(&state, user.id, &tunnel, &headers)?;
    Ok(Json(device_ports(&state, &user, &tunnel, q.username.as_deref().filter(|u| !u.is_empty())).await?))
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
