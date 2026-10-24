//! 憑證庫（遠端桌面的登入）：
//! - `GET    /api/credentials[?tunnel_id=&lan_host_id=&protocol=]`：自己存的（永遠不回密碼）
//! - `POST   /api/credentials`：存一筆（要看得到那條隧道；區網主機要屬於它）
//! - `PATCH  /api/credentials/{id}`、`DELETE /api/credentials/{id}`：只能動自己的
//! 用法：`POST …/desktop/start` 帶 `credential_id`，後端在握手時解開。見 `vault.rs`。
//! Credential vault endpoints; the desktop start takes `credential_id` and the backend unseals it for the handshake.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, credentials::Credential};
use crate::desktop::Protocol;
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{db_to_iso_utc_z, json_i64, json_str};
use crate::vault;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list, create)).routes(routes!(update, remove))
}

pub fn credential_json(c: &Credential, tunnel_name: Option<&str>, host_label: Option<&str>) -> Value {
    json!({
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

/// 列表用的名稱（一次查完）。/ Names for the list, looked up once.
async fn names(state: &AppState, rows: &[Credential]) -> ApiResult<(HashMap<i64, String>, HashMap<i64, String>)> {
    let mut tunnels = HashMap::new();
    let mut hosts = HashMap::new();
    for c in rows {
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
    Ok((tunnels, hosts))
}

#[utoipa::path(get, path = "/api/credentials", tag = "Credential vault", security(("bearer" = [])), params(("tunnel_id" = Option<i64>, Query), ("lan_host_id" = Option<i64>, Query, description = "0 or absent with tunnel_id = the device itself"), ("protocol" = Option<String>, Query)), responses((status = 200, description = "Your saved logins (passwords are never returned)", body = [super::schemas::SavedCredential])))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let mut rows = db::credentials::for_user(&state.db, user.id).await?;
    if let Some(t) = q.get("tunnel_id").and_then(|v| v.parse::<i64>().ok()) {
        let host = q.get("lan_host_id").and_then(|v| v.parse::<i64>().ok()).filter(|h| *h > 0);
        rows.retain(|c| c.tunnel_id == t && c.lan_host_id == host);
    }
    if let Some(p) = q.get("protocol").filter(|p| !p.is_empty()) {
        rows.retain(|c| &c.protocol == p);
    }
    let (tunnels, hosts) = names(&state, &rows).await?;
    Ok(Json(json!(rows.iter().map(|c| credential_json(c, tunnels.get(&c.tunnel_id).map(String::as_str), c.lan_host_id.and_then(|h| hosts.get(&h)).map(String::as_str))).collect::<Vec<_>>())))
}

#[utoipa::path(post, path = "/api/credentials", tag = "Credential vault", security(("bearer" = [])), request_body = super::schemas::SavedCredentialCreate, responses((status = 201, body = super::schemas::SavedCredential), (status = 400, description = "{field: [message]}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let protocol = match json_str(&body, "protocol") {
        Some(p) => Protocol::parse(&p).ok_or_else(|| ApiError::field("protocol", "Must be rdp or vnc."))?,
        None => return Err(ApiError::field("protocol", "This field is required.")),
    };
    let tunnel_id = json_i64(&body, "tunnel_id").ok_or_else(|| ApiError::field("tunnel_id", "This field is required."))?;
    let tunnel = db::tunnels::by_id(&state.db, tunnel_id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::not_found("Tunnel not found"));
    }
    let lan_host_id = json_i64(&body, "lan_host_id").filter(|h| *h > 0);
    if let Some(h) = lan_host_id {
        db::lan::host_by_id(&state.db, h).await?.filter(|row| row.tunnel_id == tunnel.id).ok_or_else(|| ApiError::not_found("LAN host not found"))?;
    }
    let label = text(&body, "label", 100, true)?.unwrap_or_default();
    let login = text(&body, "login", 256, false)?.unwrap_or_default();
    let domain = text(&body, "domain", 256, false)?.unwrap_or_default();
    let password = text(&body, "password", 1024, true)?.unwrap_or_default();
    let port = port(&body)?.flatten();
    let vault = &state.vault;
    let row = db::credentials::create(
        &state.db,
        db::credentials::NewCredential { user_id: user.id, label: &label, protocol: protocol.as_str(), tunnel_id: tunnel.id, lan_host_id, port, login: &login, domain: &domain },
        |id| vault.seal(&vault::aad(user.id, id), password.as_bytes()),
    )
    .await?;
    let host = match lan_host_id {
        Some(h) => db::lan::host_by_id(&state.db, h).await?.map(|r| r.label.or(r.hostname).filter(|s| !s.is_empty()).unwrap_or(r.address)),
        None => None,
    };
    Ok((StatusCode::CREATED, Json(credential_json(&row, Some(&tunnel.host_friendly_name), host.as_deref()))))
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
    let (tunnels, hosts) = names(&state, std::slice::from_ref(&row)).await?;
    Ok(Json(credential_json(&row, tunnels.get(&row.tunnel_id).map(String::as_str), row.lan_host_id.and_then(|h| hosts.get(&h)).map(String::as_str))))
}

#[utoipa::path(delete, path = "/api/credentials/{id}", tag = "Credential vault", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 204), (status = 404, body = super::schemas::ErrorBody)))]
async fn remove(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    if db::credentials::delete(&state.db, user.id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("Saved login not found"))
    }
}

/// 遠端桌面用：讀自己的那筆、確認綁定的是這個桌面、解開。/ For the desktop start: own row, same target, unsealed.
pub async fn unseal_for(state: &AppState, user_id: i64, id: i64, tunnel_id: i64, lan_host_id: Option<i64>, protocol: Protocol) -> ApiResult<(Credential, String)> {
    let c = db::credentials::by_id(&state.db, user_id, id).await?.ok_or_else(|| ApiError::field("credential_id", "Saved login not found."))?;
    if c.tunnel_id != tunnel_id || c.lan_host_id != lan_host_id || c.protocol != protocol.as_str() {
        return Err(ApiError::field("credential_id", "This saved login belongs to a different desktop."));
    }
    let plain = state
        .vault
        .open(&vault::aad(user_id, c.id), &c.secret)
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or_else(|| ApiError::field("credential_id", "This saved login cannot be decrypted any more (the server's SECRET_KEY changed). Save it again."))?;
    let _ = db::credentials::touch_used(&state.db, c.id).await;
    Ok((c, plain))
}
