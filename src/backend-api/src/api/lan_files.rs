//! 區網主機的檔案管理（`lan::files`）：打開 / 列出 / 關掉經裝置登入那台主機的檔案 session。
//! - `POST   /api/reverse/server/{id}/lan/hosts/{host_id}/files`：登入那台主機、開 SFTP → `{session: "~…", …}`；
//!   之後檔案管理的 REST / WebSocket 把 `session` 放在帳號的位置（`/api/sftp/<op>/<id>/~…`）
//! - `GET    /api/reverse/server/{id}/lan/files`：我在這條隧道開著的
//! - `DELETE /api/reverse/server/{id}/lan/files/{session}`：關掉（沒傳完的暫存檔一起刪）
//!
//! 權限跟區網終端機那一跳一樣：VIEW + 一個能用的裝置帳號（跳板）+ step-up，外加「檔案」與「網路」兩個功能。
//! Access matches the LAN terminal's hop: VIEW + an allowed device account (the jump) + step-up, plus the files and
//! network features.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, lan::LanHost, tunnels::Tunnel, users::User};
use crate::error::{ApiError, ApiResult};
use crate::features::Feature;
use crate::lan::files::{self, HostLogin, LanFiles, LoginRefused, NoSftp};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::json_str;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(open_files)).routes(routes!(list_files)).routes(routes!(close_files))
}

fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// 一個 session 給網頁 / CLI / MCP 看的樣子。/ A session as the web, CLI and MCP see it.
pub fn session_json(f: &LanFiles) -> Value {
    json!({
        "session": f.id,
        "tunnel_id": f.tunnel_id,
        "host_id": f.host_id,
        "address": f.address,
        "ssh_port": f.ssh_port,
        "login": f.login,
        "account": f.account,
        "auth": f.auth_note,
        "fingerprint": f.fingerprint,
        "idle_secs": f.idle_for().as_secs(),
        "closes_after_secs": files::IDLE.as_secs(),
    })
}

async fn tunnel_for(state: &AppState, user: &User, id: i64, headers: &HeaderMap) -> ApiResult<Tunnel> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Reverse server keys not found"))?;
    if !permissions::check_access(&state.db, user.id, &t, Permission::View).await? {
        return Err(ApiError::not_found("Reverse server keys not found"));
    }
    super::step_up::check(state, user.id, &t, headers)?;
    crate::features::check(state, user, Feature::Files).await?;
    Ok(t)
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/lan/hosts/{host_id}/files", tag = "LAN", security(("bearer" = [])),
    params(("id" = i64, Path, description = "Tunnel id"), ("host_id" = i64, Path, description = "LAN host id")),
    request_body = super::schemas::LanFilesOpen,
    responses(
        (status = 200, description = "A LAN file session: put `session` where the account goes in the file manager's routes (`/api/sftp/<op>/<id>/<session>`, `/ws/filemanager/`)", body = super::schemas::LanFilesSession),
        (status = 400, description = "code = lan_login_required | lan_login | lan_password | lan_credential | lan_files_login (the host refused it) | username | device_offline", body = super::schemas::LanError),
        (status = 403, description = "code = no_account | feature_disabled | step_up_required", body = super::schemas::LanError),
        (status = 404, body = super::schemas::ErrorBody),
        (status = 502, description = "code = lan_files_no_sftp | lan_files_failed (the device could not reach it, or the handshake failed)", body = super::schemas::LanError),
    ))]
async fn open_files(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, host_id)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = tunnel_for(&state, &user, id, &headers).await?;
    let h = db::lan::host_by_id(&state.db, host_id).await?.filter(|h| h.tunnel_id == t.id).ok_or_else(ApiError::drf_not_found)?;
    Ok(Json(open(&state, &user, &t, &h, &body).await?))
}

/// 打開的共用部分（網頁、CLI）。/ The shared part of opening (web, CLI).
pub async fn open(state: &AppState, user: &User, t: &Tunnel, h: &LanHost, body: &Value) -> ApiResult<Value> {
    let f = open_for(state, user, t, h, body, "web").await?;
    Ok(session_json(&f))
}

/// 打開（`opener` = 誰開的：`web` 或 MCP 的憑證）。/ Open one (`opener` = `web` or an MCP credential).
pub async fn open_for(state: &AppState, user: &User, t: &Tunnel, h: &LanHost, body: &Value, opener: &str) -> ApiResult<std::sync::Arc<LanFiles>> {
    let allowed = permissions::allowed_usernames(&state.db, user.id, t).await?;
    if allowed.is_empty() {
        return Err(coded(StatusCode::FORBIDDEN, "no_account", "You have no account you may use on this device."));
    }
    let account = permissions::choose_username(&allowed, t.default_username_id, json_str(body, "account").as_deref(), &t.host_friendly_name).map_err(|e| coded(StatusCode::BAD_REQUEST, "username", e))?;
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(t.reverse_port).map(|p| listen.contains(&p)).unwrap_or(false) {
            return Err(coded(StatusCode::BAD_REQUEST, "device_offline", format!("The device '{}' is offline.", t.host_friendly_name)));
        }
    }
    let login = json_str(body, "login").map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).or_else(|| h.username.clone());
    let Some(login) = login else {
        return Err(coded(StatusCode::BAD_REQUEST, "lan_login_required", "Which account on that machine? Give a login (or set one on the host)."));
    };
    if !crate::ssh::process::valid_login(&login) {
        return Err(coded(StatusCode::BAD_REQUEST, "lan_login", "A login is 1–64 letters, digits, '.', '_' or '-', not starting with '-'."));
    }
    let (how, note) = match json_str(body, "auth").as_deref().unwrap_or("telepy") {
        "password" => {
            let pw = body.get("password").and_then(Value::as_str).filter(|p| !p.is_empty()).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "lan_password", "Type the password for that account."))?;
            (HostLogin::Password(pw.to_string()), "a password".to_string())
        }
        "credential" => {
            let cid = body.get("credential_id").and_then(Value::as_i64).unwrap_or(0);
            let (row, plain) = crate::api::credentials::unseal_for(state, user.id, cid, t.id, Some(h.id), "ssh")
                .await
                .map_err(|e| coded(StatusCode::BAD_REQUEST, "lan_credential", e.body.get("credential_id").and_then(|v| v.get(0)).and_then(Value::as_str).unwrap_or("That saved login can't be used here.").to_string()))?;
            let secret = crate::api::credentials::SshSecret::parse(&plain);
            (HostLogin::Credential { private_key: secret.private_key, password: secret.password }, format!("saved login '{}'", row.label))
        }
        _ => (HostLogin::Telepy, "Telepy's key".to_string()),
    };
    match files::open(state, user, t, &account, h, &login, how, note.clone(), opener).await {
        Ok(f) => {
            let via = if opener == "web" { String::new() } else { " (MCP agent)".to_string() };
            let msg = format!("{} opened the files of {}@{} (port {}) through {}@device with {}{via}", user.username, f.login, f.address, f.ssh_port, f.account, note);
            state.gateway.event("lan_files", None, u16::try_from(t.reverse_port).ok(), Some(t.id), msg).await;
            Ok(f)
        }
        Err(e) if e.downcast_ref::<LoginRefused>().is_some() => Err(coded(StatusCode::BAD_REQUEST, "lan_files_login", format!("{e:#}"))),
        Err(e) if e.downcast_ref::<NoSftp>().is_some() => Err(coded(StatusCode::BAD_GATEWAY, "lan_files_no_sftp", format!("{e:#}"))),
        Err(e) => Err(coded(StatusCode::BAD_GATEWAY, "lan_files_failed", format!("{e:#}"))),
    }
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/lan/files", tag = "LAN", security(("bearer" = [])),
    params(("id" = i64, Path, description = "Tunnel id")),
    responses((status = 200, description = "My open LAN file sessions on this tunnel", body = super::schemas::LanFilesList), (status = 404, body = super::schemas::ErrorBody)))]
async fn list_files(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = tunnel_for(&state, &user, id, &headers).await?;
    let mut mine: Vec<_> = state.lan_files.all().into_iter().filter(|f| f.user_id == user.id && f.tunnel_id == t.id && f.healthy()).collect();
    mine.sort_by_key(|f| f.idle_for());
    Ok(Json(json!({ "sessions": mine.iter().map(|f| session_json(f)).collect::<Vec<_>>(), "closes_after_secs": files::IDLE.as_secs(), "per_person": files::MAX_PER_USER })))
}

#[utoipa::path(delete, path = "/api/reverse/server/{id}/lan/files/{session}", tag = "LAN", security(("bearer" = [])),
    params(("id" = i64, Path, description = "Tunnel id"), ("session" = String, Path, description = "The session (`~…`)")),
    responses((status = 200, description = "{closed}: whether a session of yours was open", body = super::schemas::LanFilesClosed), (status = 404, body = super::schemas::ErrorBody)))]
async fn close_files(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, session)): Path<(i64, String)>) -> ApiResult<Json<Value>> {
    let t = tunnel_for(&state, &user, id, &headers).await?;
    let ours = state.lan_files.get(&session, user.id).is_some_and(|f| f.tunnel_id == t.id);
    let closed = ours && files::close_by_owner(&state, &session, user.id).await;
    Ok(Json(json!({ "closed": closed })))
}
