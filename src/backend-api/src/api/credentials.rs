//! 憑證庫（遠端桌面的登入）：
//! - `GET    /api/credentials[?tunnel_id=&lan_host_id=&protocol=&rustdesk_device_id=]`：自己存的（永遠不回密碼）
//! - `POST   /api/credentials`：存一筆（要看得到那條隧道；區網主機要屬於它）；或 `rustdesk_device_id` = 綁在 Telepy
//!   RustDesk 伺服器的裝置上（要能用那台；這時 `tunnel_id` 存 0、協定一定是 rustdesk）
//! - `PATCH  /api/credentials/{id}`、`DELETE /api/credentials/{id}`：只能動自己的
//!
//! 用法：`POST …/desktop/start` 帶 `credential_id`，後端在握手時解開；`POST …/rustdesk/start` 帶 `credential_id` 則解開後
//! 交給瀏覽器（RustDesk 的挑戰回應在瀏覽器裡的核心做）。見 `vault.rs`。
//! Credential vault endpoints; the desktop start takes `credential_id` and the backend unseals it for the handshake,
//! the RustDesk start hands the unsealed password to the browser (the core answers the challenge there).

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, credentials::Credential};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{db_to_iso_utc_z, json_i64, json_str};
use crate::vault;
use utoipa_axum::{router::OpenApiRouter, routes};

/// 憑證能綁的協定：guacd 畫的兩種，加上瀏覽器裡的 RustDesk。/ Protocols a saved login can be bound to.
pub fn parse_protocol(s: &str) -> Option<&'static str> {
    match s.trim().to_ascii_lowercase().as_str() {
        "rdp" => Some("rdp"),
        "vnc" => Some("vnc"),
        "rustdesk" => Some("rustdesk"),
        _ => None,
    }
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list, create)).routes(routes!(update, remove))
}

pub fn credential_json(c: &Credential, tunnel_name: Option<&str>, host_label: Option<&str>, device_name: Option<&str>) -> Value {
    json!({
        "rustdesk_device_id": c.rustdesk_device_id,
        "rustdesk_device": device_name,
        "id": c.id,
        "label": c.label,
        "protocol": c.protocol,
        "tunnel_id": c.tunnel_id,
        "tunnel_name": tunnel_name,
        "lan_host_id": c.lan_host_id,
        "lan_host": host_label,
        "port": c.port,
        "login": c.login,
        "domain": c.domain,
        "has_password": !c.secret.is_empty(),
        "created_at": db_to_iso_utc_z(&c.created_at),
        "last_used_at": c.last_used_at.as_deref().map(db_to_iso_utc_z),
    })
}

fn text(body: &Value, key: &str, max: usize, required: bool) -> Result<Option<String>, ApiError> {
    match body.get(key) {
        None | Some(Value::Null) if required => Err(ApiError::field(key, "This field is required.")),
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let v = if key == "password" { s.clone() } else { s.trim().to_string() };
            if required && v.is_empty() {
                return Err(ApiError::field(key, "This field may not be blank."));
            }
            if v.chars().count() > max {
                return Err(ApiError::field(key, format!("Ensure this field has no more than {max} characters.")));
            }
            Ok(Some(v))
        }
        _ => Err(ApiError::field(key, "Not a valid string.")),
    }
}

fn port(body: &Value) -> Result<Option<Option<i64>>, ApiError> {
    match body.get("port") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => match v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())) {
            Some(n) if (1..=65535).contains(&n) => Ok(Some(Some(n))),
            _ => Err(ApiError::field("port", "A valid port (1-65535) is required.")),
        },
    }
}

struct Names {
    tunnels: HashMap<i64, String>,
    hosts: HashMap<i64, String>,
    devices: HashMap<i64, String>,
}

impl Names {
    fn json(&self, c: &Credential) -> Value {
        credential_json(c, self.tunnels.get(&c.tunnel_id).map(String::as_str), c.lan_host_id.and_then(|h| self.hosts.get(&h)).map(String::as_str), c.rustdesk_device_id.and_then(|d| self.devices.get(&d)).map(String::as_str))
    }
}

/// 列表用的名稱（一次查完）。/ Names for the list, looked up once.
async fn names(state: &AppState, rows: &[Credential]) -> ApiResult<Names> {
    let mut tunnels = HashMap::new();
    let mut hosts = HashMap::new();
    let mut devices = HashMap::new();
    for c in rows {
        if let Some(d) = c.rustdesk_device_id.filter(|d| !devices.contains_key(d)) {
            if let Some(row) = db::rustdesk_devices::by_id(&state.db, d).await? {
                devices.insert(d, row.name);
            }
            continue;
        }
        if !tunnels.contains_key(&c.tunnel_id) {
            if let Some(t) = db::tunnels::by_id(&state.db, c.tunnel_id).await? {
                tunnels.insert(t.id, t.host_friendly_name);
            }
        }
        if let Some(h) = c.lan_host_id.filter(|h| !hosts.contains_key(h)) {
            if let Some(row) = db::lan::host_by_id(&state.db, h).await? {
                hosts.insert(h, row.label.clone().or(row.hostname.clone()).filter(|s| !s.is_empty()).unwrap_or(row.address));
            }
        }
    }
    Ok(Names { tunnels, hosts, devices })
}

#[utoipa::path(get, path = "/api/credentials", tag = "Credential vault", security(("bearer" = [])), params(("tunnel_id" = Option<i64>, Query), ("lan_host_id" = Option<i64>, Query, description = "0 or absent with tunnel_id = the device itself"), ("protocol" = Option<String>, Query), ("rustdesk_device_id" = Option<i64>, Query, description = "Logins saved for a RustDesk-server device")), responses((status = 200, description = "Your saved logins (passwords are never returned)", body = [super::schemas::SavedCredential])))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let mut rows = db::credentials::for_user(&state.db, user.id).await?;
    if let Some(d) = q.get("rustdesk_device_id").and_then(|v| v.parse::<i64>().ok()) {
        rows.retain(|c| c.rustdesk_device_id == Some(d));
    }
    if let Some(t) = q.get("tunnel_id").and_then(|v| v.parse::<i64>().ok()) {
        let host = q.get("lan_host_id").and_then(|v| v.parse::<i64>().ok()).filter(|h| *h > 0);
        rows.retain(|c| c.tunnel_id == t && c.lan_host_id == host && c.rustdesk_device_id.is_none());
    }
    if let Some(p) = q.get("protocol").filter(|p| !p.is_empty()) {
        rows.retain(|c| &c.protocol == p);
    }
    let names = names(&state, &rows).await?;
    Ok(Json(json!(rows.iter().map(|c| names.json(c)).collect::<Vec<_>>())))
}

#[utoipa::path(post, path = "/api/credentials", tag = "Credential vault", security(("bearer" = [])), request_body = super::schemas::SavedCredentialCreate, responses((status = 201, body = super::schemas::SavedCredential), (status = 400, description = "{field: [message]}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let protocol = match json_str(&body, "protocol") {
        Some(p) => parse_protocol(&p).ok_or_else(|| ApiError::field("protocol", "Must be rdp, vnc or rustdesk."))?,
        None => return Err(ApiError::field("protocol", "This field is required.")),
    };
    let label = text(&body, "label", 100, true)?.unwrap_or_default();
    // Telepy RustDesk 伺服器的裝置：只有密碼，沒有隧道。/ A RustDesk-server device: a password only, no tunnel.
    if let Some(device_id) = json_i64(&body, "rustdesk_device_id").filter(|d| *d > 0) {
        if protocol != "rustdesk" {
            return Err(ApiError::field("protocol", "A RustDesk device only takes a RustDesk password."));
        }
        if !crate::rustdesk::device_allowed(&state.db, user.id, device_id).await {
            return Err(ApiError::not_found("Device not found"));
        }
        let device = db::rustdesk_devices::by_id(&state.db, device_id).await?.ok_or_else(|| ApiError::not_found("Device not found"))?;
        let password = text(&body, "password", 1024, true)?.unwrap_or_default();
        let vault = &state.vault;
        let row = db::credentials::create(
            &state.db,
            db::credentials::NewCredential { user_id: user.id, label: &label, protocol, tunnel_id: 0, lan_host_id: None, port: None, login: "", domain: "", rustdesk_device_id: Some(device.id) },
            |id| vault.seal(&vault::aad(user.id, id), password.as_bytes()),
        )
        .await?;
        return Ok((StatusCode::CREATED, Json(credential_json(&row, None, None, Some(&device.name)))));
    }
    let tunnel_id = json_i64(&body, "tunnel_id").ok_or_else(|| ApiError::field("tunnel_id", "This field is required."))?;
    let tunnel = db::tunnels::by_id(&state.db, tunnel_id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::not_found("Tunnel not found"));
    }
    let lan_host_id = json_i64(&body, "lan_host_id").filter(|h| *h > 0);
    if let Some(h) = lan_host_id {
        db::lan::host_by_id(&state.db, h).await?.filter(|row| row.tunnel_id == tunnel.id).ok_or_else(|| ApiError::not_found("LAN host not found"))?;
    }
    let login = text(&body, "login", 256, false)?.unwrap_or_default();
    let domain = text(&body, "domain", 256, false)?.unwrap_or_default();
    let password = text(&body, "password", 1024, true)?.unwrap_or_default();
    let port = port(&body)?.flatten();
    let vault = &state.vault;
    let row = db::credentials::create(
        &state.db,
        db::credentials::NewCredential { user_id: user.id, label: &label, protocol, tunnel_id: tunnel.id, lan_host_id, port, login: &login, domain: &domain, rustdesk_device_id: None },
        |id| vault.seal(&vault::aad(user.id, id), password.as_bytes()),
    )
    .await?;
    let host = match lan_host_id {
        Some(h) => db::lan::host_by_id(&state.db, h).await?.map(|r| r.label.or(r.hostname).filter(|s| !s.is_empty()).unwrap_or(r.address)),
        None => None,
    };
    Ok((StatusCode::CREATED, Json(credential_json(&row, Some(&tunnel.host_friendly_name), host.as_deref(), None))))
}

#[utoipa::path(patch, path = "/api/credentials/{id}", tag = "Credential vault", security(("bearer" = [])), params(("id" = i64, Path)), request_body = super::schemas::SavedCredentialUpdate, responses((status = 200, body = super::schemas::SavedCredential), (status = 400, body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let current = db::credentials::by_id(&state.db, user.id, id).await?.ok_or_else(|| ApiError::not_found("Saved login not found"))?;
    let label = text(&body, "label", 100, false)?;
    if label.as_deref() == Some("") {
        return Err(ApiError::field("label", "This field may not be blank."));
    }
    let login = text(&body, "login", 256, false)?;
    let domain = text(&body, "domain", 256, false)?;
    let password = text(&body, "password", 1024, false)?.filter(|p| !p.is_empty());
    let secret = password.map(|p| state.vault.seal(&vault::aad(user.id, current.id), p.as_bytes()));
    db::credentials::update(&state.db, current.id, db::credentials::CredentialPatch { label: label.as_deref(), port: port(&body)?, login: login.as_deref(), domain: domain.as_deref(), secret }).await?;
    let row = db::credentials::by_id(&state.db, user.id, id).await?.ok_or_else(|| ApiError::not_found("Saved login not found"))?;
    Ok(Json(names(&state, std::slice::from_ref(&row)).await?.json(&row)))
}

#[utoipa::path(delete, path = "/api/credentials/{id}", tag = "Credential vault", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 204), (status = 404, body = super::schemas::ErrorBody)))]
async fn remove(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    if db::credentials::delete(&state.db, user.id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("Saved login not found"))
    }
}

/// 遠端桌面 / RustDesk 用：讀自己的那筆、確認綁定的是這個桌面（隧道、主機、協定）、解開。
/// For the desktop and RustDesk starts: own row, same target (tunnel, host, protocol), unsealed.
pub async fn unseal_for(state: &AppState, user_id: i64, id: i64, tunnel_id: i64, lan_host_id: Option<i64>, protocol: &str) -> ApiResult<(Credential, String)> {
    let c = db::credentials::by_id(&state.db, user_id, id).await?.ok_or_else(|| ApiError::field("credential_id", "Saved login not found."))?;
    if c.tunnel_id != tunnel_id || c.lan_host_id != lan_host_id || c.protocol != protocol || c.rustdesk_device_id.is_some() {
        return Err(ApiError::field("credential_id", "This saved login belongs to a different desktop."));
    }
    let (c, plain) = open(state, user_id, c)?;
    let _ = db::credentials::touch_used(&state.db, c.id).await;
    Ok((c, plain))
}

/// Telepy RustDesk 伺服器的裝置用：自己的、綁在這台上的那筆。/ For a RustDesk-server device: own row bound to it.
pub async fn unseal_for_device(state: &AppState, user_id: i64, id: i64, device_id: i64) -> ApiResult<(Credential, String)> {
    let c = db::credentials::by_id(&state.db, user_id, id).await?.ok_or_else(|| ApiError::field("credential_id", "Saved login not found."))?;
    if c.rustdesk_device_id != Some(device_id) {
        return Err(ApiError::field("credential_id", "This saved login belongs to a different desktop."));
    }
    let (c, plain) = open(state, user_id, c)?;
    let _ = db::credentials::touch_used(&state.db, c.id).await;
    Ok((c, plain))
}

fn open(state: &AppState, user_id: i64, c: Credential) -> ApiResult<(Credential, String)> {
    let plain = state
        .vault
        .open(&vault::aad(user_id, c.id), &c.secret)
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or_else(|| ApiError::field("credential_id", "This saved login cannot be decrypted any more (the server's SECRET_KEY changed). Save it again."))?;
    Ok((c, plain))
}
