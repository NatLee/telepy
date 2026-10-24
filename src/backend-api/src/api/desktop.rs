//! 網頁內遠端桌面（RDP / VNC）：
//! - `POST /api/reverse/server/{id}/desktop/start`：驗權限、對目標開通道、發票證（帳密只進記憶體）
//! - `POST /api/reverse/server/desktop/{sid}/stop`：結束（自己的 session；管理員任何人的）
//! 設計見 `desktop/mod.rs`。/ In-browser remote desktop endpoints; see `desktop/mod.rs`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db;
use crate::desktop::{self, Clipboard, Credentials, NewSession, Protocol, Target, TICKET_TTL};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{json_i64, json_str};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(start)).routes(routes!(stop))
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

#[utoipa::path(post, path = "/api/reverse/server/{id}/desktop/start", tag = "Remote Desktop", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::DesktopStartRequest, responses((status = 200, description = "Session created; open the WebSocket at ws_path with ?ticket= within expires_in seconds", body = super::schemas::DesktopSession), (status = 400, description = "{field: [message]}", body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 502, description = "code = device_offline | device_auth | forwarding_disabled | target_unreachable | device_unreachable", body = super::schemas::DesktopError), (status = 503, description = "code = desktop_disabled | desktop_busy", body = super::schemas::DesktopError)))]
async fn start(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let settings = db::settings::get_solo(&state.db).await?;
    if !settings.desktop_enabled {
        return Err(coded(StatusCode::SERVICE_UNAVAILABLE, "desktop_disabled", "Remote desktop is disabled on this server."));
    }
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::forbidden("Permission denied"));
    }
    let protocol = match json_str(&body, "protocol") {
        Some(p) => Protocol::parse(&p).ok_or_else(|| ApiError::field("protocol", "Must be rdp or vnc."))?,
        None => return Err(ApiError::field("protocol", "This field is required.")),
    };
    let port = parse_port(&body, protocol)?;
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
    let credentials = Credentials { login: bounded(&body, "login", 256)?, password: bounded(&body, "password", 1024)?, domain: bounded(&body, "domain", 256)? };
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
        credentials,
        prepared,
    });
    tracing::info!(session = %session.id, user = %user.username, tunnel = tunnel.id, protocol = protocol.as_str(), "desktop: session created");
    Ok(Json(json!({
        "session_id": session.id,
        "ws_path": format!("/ws/desktop/{}/", session.id),
        "ticket": ticket,
        "expires_in": TICKET_TTL.as_secs(),
        "protocol": protocol.as_str(),
        "clipboard": clipboard.as_str(),
        "target": { "host": session.target.host, "port": session.target.port, "label": session.target.label, "lan_host_id": session.target.lan_host_id },
        "username": session.hop_username,
    })))
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
