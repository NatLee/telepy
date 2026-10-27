//! 網頁內遠端桌面（RDP / VNC）：
//! - `POST /api/reverse/server/{id}/desktop/start`：驗權限、對目標開通道、發票證（帳密只進記憶體）
//! - `GET /api/reverse/server/{id}/desktop/screens?username=`：經裝置 SSH 問它的螢幕配置（VNC 裁切用）
//! - `GET /api/reverse/server/{id}/desktop/probe?port=&username=&lan_host_id=`：從裝置試連一個埠（RustDesk 的
//!   Direct IP 21118 之類不經 guacd 的桌面）——和 start 一樣先開通道，通了就關，回 reachable
//! - `POST /api/reverse/server/desktop/{sid}/stop`：結束（自己的 session；管理員任何人的）
//! 設計見 `desktop/mod.rs`。/ In-browser remote desktop endpoints; see `desktop/mod.rs`.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::auth::extractor::CurrentSession;
use crate::db;
use crate::desktop::{self, screens, Clipboard, Credentials, NewSession, Protocol, Quality, Target, TICKET_TTL};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::ssh::exec;
use crate::state::AppState;
use crate::util::{json_i64, json_str};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(start)).routes(routes!(list_screens)).routes(routes!(probe)).routes(routes!(stop))
}

/// 桌面所在的主機：裝置自己，或這條隧道底下的區網主機（別條隧道的 → 404）。/ The device itself or one of this tunnel's LAN hosts.
pub(crate) async fn target_for(state: &AppState, tunnel_id: i64, lan_host_id: Option<i64>, port: u16) -> Result<Target, ApiError> {
    match lan_host_id {
        Some(hid) => {
            let host = db::lan::host_by_id(&state.db, hid).await?.filter(|h| h.tunnel_id == tunnel_id).ok_or_else(|| ApiError::not_found("LAN host not found"))?;
            let label = host.label.clone().or(host.hostname.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| host.address.clone());
            Ok(Target { host: host.address, port, label, lan_host_id: Some(host.id) })
        }
        None => Ok(Target::device(port)),
    }
}

pub(crate) fn target_json(t: &Target) -> Value {
    json!({ "host": t.host, "port": t.port, "label": t.label, "lan_host_id": t.lan_host_id })
}

pub(crate) fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
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

/// 這次連線的剪貼簿方向：body 的 `clipboard`（沒帶 = 個人設定）套上站台上限。回（實際、上限）。
/// The session's clipboard direction: the body's `clipboard` (else the user's setting) capped by the site limit.
pub(crate) async fn clipboard_for(state: &AppState, user_id: i64, settings: &db::settings::SiteSettings, body: &Value) -> Result<(Clipboard, Clipboard), ApiError> {
    let requested = match body.get("clipboard") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(ApiError::field("clipboard", format!("Must be one of: {}.", Clipboard::VALUES.join(", ")))),
    };
    let saved = match requested {
        Some(_) => String::new(),
        None => db::users::settings_for(&state.db, user_id).await?.map(|s| s.desktop_clipboard).unwrap_or_default(),
    };
    let effective = Clipboard::effective(&settings.desktop_clipboard, requested.as_deref(), &saved).map_err(|m| ApiError::field("clipboard", m))?;
    Ok((effective, Clipboard::parse(&settings.desktop_clipboard).unwrap_or(Clipboard::Both)))
}

/// `audio`：省略 / null = 不要聲音；其他型別回欄位錯誤。/ `audio`: omitted or null = no sound; anything but a boolean is a field error.
fn parse_audio(body: &Value) -> Result<bool, ApiError> {
    match body.get("audio") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(ApiError::field("audio", "Must be true or false.")),
    }
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
async fn start(State(state): State<AppState>, AuthUser(user): AuthUser, CurrentSession(web_session): CurrentSession, headers: axum::http::HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
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
    let (clipboard, clipboard_limit) = clipboard_for(&state, user.id, &settings, &body).await?;
    // 聲音：這次要不要（預設不要，吃頻寬）；只有 RDP 有，VNC 帶 true 也當 false。/ Sound: asked per start, RDP only.
    let audio = parse_audio(&body)? && protocol == Protocol::Rdp;
    let allowed = permissions::allowed_usernames(&state.db, user.id, &tunnel).await?;
    let requested = json_str(&body, "username").filter(|u| !u.is_empty());
    let hop_username = permissions::choose_username(&allowed, tunnel.default_username_id, requested.as_deref(), &tunnel.host_friendly_name).map_err(ApiError::forbidden)?;
    let target = target_for(&state, tunnel.id, json_i64(&body, "lan_host_id"), port).await?;
    // 存在憑證庫的登入：後端自己解開，瀏覽器不必（也拿不到）密碼。/ A saved login: unsealed here, never sent to the browser.
    let (credentials, saved_label) = match json_i64(&body, "credential_id") {
        Some(cid) => {
            let (c, password) = crate::api::credentials::unseal_for(&state, user.id, cid, tunnel.id, target.lan_host_id, protocol.as_str()).await?;
            (Credentials { login: c.login.clone(), password, domain: c.domain.clone() }, Some(c.label))
        }
        None => (Credentials { login: bounded(&body, "login", 256)?, password: bounded(&body, "password", 1024)?, domain: bounded(&body, "domain", 256)? }, None),
    };
    let max = settings.desktop_max_sessions;
    if max > 0 && state.desktop.count() as i64 >= max {
        return Err(coded(StatusCode::SERVICE_UNAVAILABLE, "desktop_busy", "All remote desktop slots are in use. Please wait for someone to disconnect and try again."));
    }
    let prepared = desktop::prepare(&state, tunnel.reverse_port, &hop_username, &target).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, e.code(), e.to_string()))?;
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
        audio,
        credentials,
        prepared,
        saved_label,
        web_session,
    });
    tracing::info!(session = %session.id, user = %user.username, tunnel = tunnel.id, protocol = protocol.as_str(), quality = quality.as_str(), clipboard = clipboard.as_str(), audio, "desktop: session created");
    Ok(Json(json!({
        "session_id": session.id,
        "ws_path": format!("/ws/desktop/{}/", session.id),
        "ticket": ticket,
        "expires_in": TICKET_TTL.as_secs(),
        "protocol": protocol.as_str(),
        "clipboard": clipboard.as_str(),
        "clipboard_limit": clipboard_limit.as_str(),
        "quality": quality.as_str(),
        "audio": audio,
        "target": target_json(&session.target),
        "username": session.hop_username,
    })))
}

/// 從裝置試連目標的一個埠（例如 RustDesk 的 Direct IP 21118）：和 start 同一道門、同一條路（連線池的 lease +
/// direct-tcpip 通道），通了立刻關掉。不經 guacd，所以不看 `desktop_enabled`。錯誤碼和 start 一樣。
/// Try one port on the target from the device, the same way start opens its channel; closed at once.
#[utoipa::path(get, path = "/api/reverse/server/{id}/desktop/probe", tag = "Remote Desktop", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("port" = u16, Query, description = "Port to try on the target"), ("username" = Option<String>, Query, description = "Device account for the SSH hop; omitted = the default allowed one"), ("lan_host_id" = Option<i64>, Query, description = "A LAN host of this tunnel; omitted = the device itself")), responses((status = 200, body = super::schemas::DesktopProbe), (status = 400, description = "{field: [message]}", body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 502, description = "code = device_offline | device_auth | host_key_changed | forwarding_disabled | target_unreachable | device_unreachable", body = super::schemas::DesktopError)))]
async fn probe(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path(id): Path<i64>, Query(query): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::forbidden("Permission denied"));
    }
    super::step_up::check(&state, user.id, &tunnel, &headers)?;
    let port = match query.get("port").map(|p| p.trim().parse::<u16>()) {
        Some(Ok(p)) if p > 0 => p,
        _ => return Err(ApiError::field("port", "A valid port (1-65535) is required.")),
    };
    let lan_host_id = match query.get("lan_host_id").map(|v| v.trim()).filter(|v| !v.is_empty()) {
        Some(v) => Some(v.parse::<i64>().map_err(|_| ApiError::field("lan_host_id", "Must be a LAN host id."))?),
        None => None,
    };
    let allowed = permissions::allowed_usernames(&state.db, user.id, &tunnel).await?;
    let requested = query.get("username").map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    let hop_username = permissions::choose_username(&allowed, tunnel.default_username_id, requested.as_deref(), &tunnel.host_friendly_name).map_err(ApiError::forbidden)?;
    let target = target_for(&state, tunnel.id, lan_host_id, port).await?;
    let prepared = desktop::prepare(&state, tunnel.reverse_port, &hop_username, &target).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, e.code(), e.to_string()))?;
    drop(prepared);
    tracing::debug!(tunnel = tunnel.id, user = %user.username, target = %format!("{}:{}", target.host, target.port), "desktop: port probe succeeded");
    Ok(Json(json!({ "reachable": true, "target": target_json(&target), "username": hop_username })))
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
    fn audio_is_a_boolean_that_defaults_to_off() {
        assert!(!parse_audio(&json!({})).unwrap());
        assert!(!parse_audio(&json!({"audio": null})).unwrap());
        assert!(parse_audio(&json!({"audio": true})).unwrap());
        assert!(parse_audio(&json!({"audio": "yes"})).is_err());
    }

    #[test]
    fn passwords_keep_their_spaces() {
        assert_eq!(bounded(&json!({"password": " a b "}), "password", 10).unwrap(), " a b ");
        assert_eq!(bounded(&json!({}), "password", 10).unwrap(), "");
        assert!(bounded(&json!({"login": "x".repeat(11)}), "login", 10).is_err());
    }
}
