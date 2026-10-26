//! 網頁內 RustDesk：
//! - `POST /api/reverse/server/{id}/rustdesk/start`：和桌面同一道門，先對目標的 Direct IP 埠開通道、發票證
//! - `POST /api/reverse/server/rustdesk/{sid}/stop`
//!
//! 手打的密碼不經這裡：RustDesk 的固定密碼由瀏覽器端核心直接做挑戰回應。存在憑證庫的（`credential_id`）在這裡解開、
//! 放進回應交給瀏覽器 —— 和 guacd 不同，後端沒辦法代做 RustDesk 的挑戰回應。設計見 `rustdesk/mod.rs`。
//! In-browser RustDesk endpoints. A typed password never reaches the backend; a saved one (`credential_id`) is unsealed
//! here and returned to the browser, because unlike guacd the backend cannot answer RustDesk's challenge itself.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db;
use crate::desktop;
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::rustdesk::{NewSession, DEFAULT_PORT, TICKET_TTL};
use crate::state::AppState;
use crate::util::{json_i64, json_str};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(start)).routes(routes!(stop))
}

fn parse_port(body: &Value) -> Result<u16, ApiError> {
    let n = match body.get("port") {
        None | Some(Value::Null) => return Ok(DEFAULT_PORT),
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) if s.trim().is_empty() => return Ok(DEFAULT_PORT),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    match n {
        Some(n) if (1..=65535).contains(&n) => Ok(n as u16),
        _ => Err(ApiError::field("port", "A valid port (1-65535) is required.")),
    }
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/rustdesk/start", tag = "Remote Desktop", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::RustDeskStartRequest, responses((status = 200, description = "Session created; the browser core connects to ws_path with ?ticket= (twice: hbbs role, then relay role) within expires_in seconds", body = super::schemas::RustDeskSession), (status = 400, description = "{field: [message]}", body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 502, description = "code = device_offline | device_auth | host_key_changed | forwarding_disabled | target_unreachable | device_unreachable", body = super::schemas::DesktopError), (status = 503, description = "code = desktop_disabled | desktop_busy", body = super::schemas::DesktopError)))]
async fn start(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let settings = db::settings::get_solo(&state.db).await?;
    if !settings.desktop_enabled {
        return Err(super::desktop::coded(StatusCode::SERVICE_UNAVAILABLE, "desktop_disabled", "Remote desktop is disabled on this server."));
    }
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::forbidden("Permission denied"));
    }
    super::step_up::check(&state, user.id, &tunnel, &headers)?;
    let port = parse_port(&body)?;
    // 剪貼簿：RustDesk 的資料流後端讀不到，方向由瀏覽器裡的核心照這個值套用。
    // Clipboard: the backend cannot see RustDesk's stream, so the browser's core applies this value.
    let (clipboard, clipboard_limit) = super::desktop::clipboard_for(&state, user.id, &settings, &body).await?;
    let allowed = permissions::allowed_usernames(&state.db, user.id, &tunnel).await?;
    let requested = json_str(&body, "username").filter(|u| !u.is_empty());
    let hop_username = permissions::choose_username(&allowed, tunnel.default_username_id, requested.as_deref(), &tunnel.host_friendly_name).map_err(ApiError::forbidden)?;
    let target = super::desktop::target_for(&state, tunnel.id, json_i64(&body, "lan_host_id"), port).await?;
    // 憑證庫的 RustDesk 密碼：同一個目標才解得開，解開後只放進這一次的回應。/ A saved RustDesk password: same target only, returned once.
    let (password, saved_label) = match json_i64(&body, "credential_id") {
        Some(cid) => {
            let (c, password) = super::credentials::unseal_for(&state, user.id, cid, tunnel.id, target.lan_host_id, "rustdesk").await?;
            (Some(password), Some(c.label))
        }
        None => (None, None),
    };
    let max = settings.desktop_max_sessions;
    if max > 0 && (state.desktop.count() + state.rustdesk.count()) as i64 >= max {
        return Err(super::desktop::coded(StatusCode::SERVICE_UNAVAILABLE, "desktop_busy", "All remote desktop slots are in use. Please wait for someone to disconnect and try again."));
    }
    let prepared = desktop::prepare(&state, tunnel.reverse_port, &hop_username, &target).await.map_err(|e| super::desktop::coded(StatusCode::BAD_GATEWAY, e.code(), e.to_string()))?;
    let target_out = super::desktop::target_json(&target);
    let username_out = hop_username.clone();
    let (session, ticket) = state.rustdesk.create(NewSession {
        user_id: user.id,
        user_name: user.username.clone(),
        tunnel_id: tunnel.id,
        tunnel_name: tunnel.host_friendly_name.clone(),
        reverse_port: tunnel.reverse_port,
        hop_username,
        target,
        prepared,
        saved_label,
    });
    tracing::info!(session = %session.id, user = %user.username, tunnel = tunnel.id, saved = session.saved_label.is_some(), "rustdesk: session created");
    let mut out = json!({
        "session_id": session.id,
        "ws_path": format!("/ws/rustdesk/{}/", session.id),
        "ticket": ticket,
        "expires_in": TICKET_TTL.as_secs(),
        "target": target_out,
        "username": username_out,
        "clipboard": clipboard.as_str(),
        "clipboard_limit": clipboard_limit.as_str(),
    });
    if let Some(p) = password {
        out["password"] = json!(p);
    }
    Ok(Json(out))
}

#[utoipa::path(post, path = "/api/reverse/server/rustdesk/{sid}/stop", tag = "Remote Desktop", security(("bearer" = [])), params(("sid" = String, Path, description = "Session id")), responses((status = 200, body = super::schemas::Status), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn stop(State(state): State<AppState>, AuthUser(user): AuthUser, Path(sid): Path<String>) -> ApiResult<Json<Value>> {
    match state.rustdesk.stop(&sid, user.id, user.is_superuser) {
        Ok(true) => Ok(Json(json!({ "status": "success" }))),
        Ok(false) => Err(ApiError::not_found("Session not found")),
        Err(crate::rustdesk::NotOwner) => Err(ApiError::forbidden("Permission denied")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_defaults_to_rustdesk() {
        assert_eq!(parse_port(&json!({})).unwrap(), 21118);
        assert_eq!(parse_port(&json!({"port": "21119"})).unwrap(), 21119);
        assert!(parse_port(&json!({"port": 0})).is_err());
    }
}
