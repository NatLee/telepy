//! 網頁內遠端桌面（RDP / VNC）：
//! - `POST /api/reverse/server/{id}/desktop/start`：驗權限、對目標開通道、發票證（帳密只進記憶體）
//! - `GET /api/reverse/server/{id}/desktop/screens?username=`：經裝置 SSH 問它的螢幕配置（VNC 裁切用）
//! - `POST /api/reverse/server/desktop/{sid}/stop`：結束（自己的 session；管理員任何人的）
//! 設計見 `desktop/mod.rs`。/ In-browser remote desktop endpoints; see `desktop/mod.rs`.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db;
use crate::desktop::{self, screens, Clipboard, Credentials, NewSession, Protocol, Quality, Target, TICKET_TTL};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::ssh::exec;
use crate::state::AppState;
use crate::util::{json_i64, json_str};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(start)).routes(routes!(list_screens)).routes(routes!(stop))
}

fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// 字串欄位（可省略），超過長度回欄位錯誤。/ Optional string field with a length cap.
fn bounded(body: &Value, key: &str, max: usize) -> Result<String, ApiError> {
    let v = body.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    if v.chars().count() > max {
        return Err(ApiError::field(key, format!("Ensure this field has no more than {max} characters.")));
    }
    Ok(v)
}

fn parse_port(body: &Value, protocol: Protocol) -> Result<u16, ApiError> {
    let n = match body.get("port") {
        None | Some(Value::Null) => return Ok(protocol.default_port()),
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) if s.trim().is_empty() => return Ok(protocol.default_port()),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    match n {
        Some(n) if (1..=65535).contains(&n) => Ok(n as u16),
        _ => Err(ApiError::field("port", "A valid port (1-65535) is required.")),
    }
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/desktop/start", tag = "Remote Desktop", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::DesktopStartRequest, responses((status = 200, description = "Session created; open the WebSocket at ws_path with ?ticket= within expires_in seconds", body = super::schemas::DesktopSession), (status = 400, description = "{field: [message]}", body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 502, description = "code = device_offline | device_auth | host_key_changed | forwarding_disabled | target_unreachable | device_unreachable", body = super::schemas::DesktopError), (status = 503, description = "code = desktop_disabled | desktop_busy", body = super::schemas::DesktopError)))]
async fn start(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let settings = db::settings::get_solo(&state.db).await?;
    if !settings.desktop_enabled {
        return Err(coded(StatusCode::SERVICE_UNAVAILABLE, "desktop_disabled", "Remote desktop is disabled on this server."));
    }
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::forbidden("Permission denied"));
    }
    super::step_up::check(&state, user.id, &tunnel, &headers)?;
    let protocol = match json_str(&body, "protocol") {
        Some(p) => Protocol::parse(&p).ok_or_else(|| ApiError::field("protocol", "Must be rdp or vnc."))?,
        None => return Err(ApiError::field("protocol", "This field is required.")),
    };
    let port = parse_port(&body, protocol)?;
    let quality = Quality::parse(&json_str(&body, "quality").unwrap_or_default()).ok_or_else(|| ApiError::field("quality", "Must be auto, speed or sharp."))?;
    let allowed = permissions::allowed_usernames(&state.db, user.id, &tunnel).await?;
    let requested = json_str(&body, "username").filter(|u| !u.is_empty());
    let hop_username = permissions::choose_username(&allowed, tunnel.default_username_id, requested.as_deref(), &tunnel.host_friendly_name).map_err(ApiError::forbidden)?;
    let target = match json_i64(&body, "lan_host_id") {
        Some(hid) => {
            let host = db::lan::host_by_id(&state.db, hid).await?.filter(|h| h.tunnel_id == tunnel.id).ok_or_else(|| ApiError::not_found("LAN host not found"))?;
            let label = host.label.clone().or(host.hostname.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| host.address.clone());
            Target { host: host.address, port, label, lan_host_id: Some(host.id) }
        }
        None => Target::device(port),
    };
    // 存在憑證庫的登入：後端自己解開，瀏覽器不必（也拿不到）密碼。/ A saved login: unsealed here, never sent to the browser.
    let (credentials, saved_label) = match json_i64(&body, "credential_id") {
        Some(cid) => {
            let (c, password) = crate::api::credentials::unseal_for(&state, user.id, cid, tunnel.id, target.lan_host_id, protocol).await?;
            (Credentials { login: c.login.clone(), password, domain: c.domain.clone() }, Some(c.label))
        }
        None => (Credentials { login: bounded(&body, "login", 256)?, password: bounded(&body, "password", 1024)?, domain: bounded(&body, "domain", 256)? }, None),
    };
    let max = settings.desktop_max_sessions;
    if max > 0 && state.desktop.count() as i64 >= max {
        return Err(coded(StatusCode::SERVICE_UNAVAILABLE, "desktop_busy", "All remote desktop slots are in use. Please wait for someone to disconnect and try again."));
    }
    let prepared = desktop::prepare(&state, tunnel.reverse_port, &hop_username, &target).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, e.code(), e.to_string()))?;
    let clipboard = Clipboard::parse(&settings.desktop_clipboard).unwrap_or(Clipboard::Both);
    let (session, ticket) = state.desktop.create(NewSession {
        user_id: user.id,
        user_name: user.username.clone(),
        tunnel_id: tunnel.id,
        tunnel_name: tunnel.host_friendly_name.clone(),
        reverse_port: tunnel.reverse_port,
        hop_username,
        protocol,
        target,
        clipboard,
        quality,
        credentials,
        prepared,
        saved_label,
    });
    tracing::info!(session = %session.id, user = %user.username, tunnel = tunnel.id, protocol = protocol.as_str(), quality = quality.as_str(), "desktop: session created");
    Ok(Json(json!({
        "session_id": session.id,
        "ws_path": format!("/ws/desktop/{}/", session.id),
        "ticket": ticket,
        "expires_in": TICKET_TTL.as_secs(),
        "protocol": protocol.as_str(),
        "clipboard": clipboard.as_str(),
        "quality": quality.as_str(),
        "target": { "host": session.target.host, "port": session.target.port, "label": session.target.label, "lan_host_id": session.target.lan_host_id },
        "username": session.hop_username,
    })))
}

/// 裝置的螢幕配置：經連線池的那條裝置連線跑 `uname` / `xrandr` / `system_profiler` / PowerShell（見
/// `desktop/screens.rs`）。和 start 同一道門（VIEW + 允許的裝置帳號 + step-up）。問不到不是錯誤：`screens: []`。
/// The device's monitor layout over the pooled connection; same gate as start. Nothing found = an empty list.
#[utoipa::path(get, path = "/api/reverse/server/{id}/desktop/screens", tag = "Remote Desktop", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = Option<String>, Query, description = "Device account for the SSH hop; omitted = the default allowed one")), responses((status = 200, body = super::schemas::DesktopScreens), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 502, description = "code = device_offline | device_auth | host_key_changed | device_unreachable", body = super::schemas::DesktopError)))]
async fn list_screens(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path(id): Path<i64>, Query(query): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::forbidden("Permission denied"));
    }
    super::step_up::check(&state, user.id, &tunnel, &headers)?;
    let allowed = permissions::allowed_usernames(&state.db, user.id, &tunnel).await?;
    let requested = query.get("username").map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    let hop_username = permissions::choose_username(&allowed, tunnel.default_username_id, requested.as_deref(), &tunnel.host_friendly_name).map_err(ApiError::forbidden)?;
    // 先確定連得上（離線 / 金鑰被拒在這裡回 502），之後每個指令各開一個 session channel。
    // Make sure the device answers first (offline / refused key = 502); each command then gets its own channel.
    let probe = state.pool.acquire(&state, tunnel.reverse_port, &hop_username).await.map_err(|e| {
        let m = format!("{e:#}");
        let code = if m.contains(crate::ssh::host_keys::CHANGED) { "host_key_changed" } else if m.contains(crate::ssh::host_keys::CLAIMED) { "device_claimed" } else if m.contains("device offline") { "device_offline" } else if m.contains("device auth") || m.contains("authentication failed") { "device_auth" } else { "device_unreachable" };
        coded(StatusCode::BAD_GATEWAY, code, m)
    })?;
    drop(probe);
    let reverse_port = tunnel.reverse_port;
    let state_ref: &AppState = &state;
    let username: &str = hop_username.as_str();
    let found = screens::detect_with(move |cmd: String, timeout| async move {
        let (lease, ch) = state_ref.pool.session_channel(state_ref, reverse_port, username).await?;
        let r = exec::run_on(ch, &cmd, timeout, screens::OUTPUT_LIMIT).await?;
        drop(lease);
        Ok((r.exit_code, r.stdout.text))
    })
    .await;
    tracing::debug!(tunnel = tunnel.id, os = found.os, source = ?found.source, screens = found.screens.len(), "desktop: screens detected");
    Ok(Json(json!({ "os": found.os, "source": found.source, "screens": found.screens, "username": hop_username })))
}

#[utoipa::path(post, path = "/api/reverse/server/desktop/{sid}/stop", tag = "Remote Desktop", security(("bearer" = [])), params(("sid" = String, Path, description = "Session id")), responses((status = 200, body = super::schemas::Status), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn stop(State(state): State<AppState>, AuthUser(user): AuthUser, Path(sid): Path<String>) -> ApiResult<Json<Value>> {
    match state.desktop.stop(&sid, user.id, user.is_superuser) {
        Ok(true) => Ok(Json(json!({ "status": "success" }))),
        Ok(false) => Err(ApiError::not_found("Session not found")),
        Err(()) => Err(ApiError::forbidden("Permission denied")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_default_per_protocol_and_are_validated() {
        assert_eq!(parse_port(&json!({}), Protocol::Rdp).unwrap(), 3389);
        assert_eq!(parse_port(&json!({"port": ""}), Protocol::Vnc).unwrap(), 5900);
        assert_eq!(parse_port(&json!({"port": "5901"}), Protocol::Vnc).unwrap(), 5901);
        assert_eq!(parse_port(&json!({"port": 13389}), Protocol::Rdp).unwrap(), 13389);
        assert!(parse_port(&json!({"port": 0}), Protocol::Rdp).is_err());
        assert!(parse_port(&json!({"port": "70000"}), Protocol::Rdp).is_err());
        assert!(parse_port(&json!({"port": true}), Protocol::Rdp).is_err());
    }

    #[test]
    fn passwords_keep_their_spaces() {
        assert_eq!(bounded(&json!({"password": " a b "}), "password", 10).unwrap(), " a b ");
        assert_eq!(bounded(&json!({}), "password", 10).unwrap(), "");
        assert!(bounded(&json!({"login": "x".repeat(11)}), "login", 10).is_err());
    }
}
