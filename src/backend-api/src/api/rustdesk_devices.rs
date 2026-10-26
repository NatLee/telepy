//! Telepy 當 RustDesk 的 ID / 中繼伺服器：裝置清單、一次性登記指令、開瀏覽器 session（要登入），以及裝置那端的
//! RustDesk API（公開；RustDesk 自己會呼叫 `api-server` 的這幾個路徑）。設計見 `rustdesk/idserver.rs`。
//!
//! 使用者：
//! - `GET /api/rustdesk/devices`：自己的裝置（管理員：全部）＋裝置要設的伺服器位址
//! - `PATCH` / `DELETE /api/rustdesk/devices/{id}`：改名 / 移除（擁有者或管理員）
//! - `POST /api/rustdesk/devices/{id}/start`：瀏覽器 session（核心用 RustDesk ID 經 Telepy 連，端對端加密）；
//!   `{credential_id}` = 憑證庫裡綁這台的 RustDesk 密碼，解開後只放進這次回應的 `password`（核心要自己回挑戰）
//! - `GET /api/rustdesk/devices/{id}/sessions`：最近的連線（誰、從哪、多久、流量）
//! - `POST /api/rustdesk/enroll`、`GET` / `DELETE /api/rustdesk/enroll/{id}`：一次性登記指令（30 分鐘）
//!
//! 裝置（RustDesk 的 API 形狀）：
//! - `POST /api/devices/deploy`（`Authorization: Bearer <登記權杖>`，`{id, pk, uuid}`）：`rustdesk --deploy --token …`。
//!   RustDesk 1.5 讀 `{"result": "OK" | "INVALID_INPUT" | "ID_TAKEN" | "NOT_ENABLED"}`，其他內容原樣印出並以 1 結束，
//!   所以權杖問題回一行純文字說明。/ RustDesk reads `result`; anything else is printed as is, so token problems are plain text.
//! - `POST /api/sysinfo`、`/api/heartbeat`、`/api/audit/{kind}`、`/api/devices/cli`
//!
//! The RustDesk-server endpoints: the device list, one-time enrolment commands and browser sessions for users,
//! plus the RustDesk API paths a device calls on its `api-server` (public; errors are 200 + `{"error"}` like RustDesk's).

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db;
use crate::db::rustdesk_devices::RustDeskDevice;
use crate::error::{ApiError, ApiResult};
use crate::rustdesk::idserver::{device_commands, device_settings, valid_rustdesk_id, ClaimError, Enrolment};
use crate::rustdesk::{NewIdSession, TICKET_TTL};
use crate::state::AppState;
use crate::util::{db_to_iso_utc_z, json_i64, json_str};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list))
        .routes(routes!(update, remove))
        .routes(routes!(start))
        .routes(routes!(sessions))
        .routes(routes!(create_enrolment))
        .routes(routes!(enrolment_status, cancel_enrolment))
        .routes(routes!(deploy))
        .routes(routes!(sysinfo))
        .routes(routes!(heartbeat))
        .routes(routes!(audit))
        .routes(routes!(assign))
}

const NAME_MAX: usize = 64;

/// 名稱：去頭尾空白、1–64 字、不含控制字元。/ A display name: trimmed, 1–64 chars, no control characters.
fn clean_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    (!name.is_empty() && name.chars().count() <= NAME_MAX && !name.chars().any(char::is_control)).then(|| name.to_string())
}

fn default_name(rustdesk_id: &str) -> String {
    format!("RustDesk {rustdesk_id}")
}

fn coded(status: StatusCode, code: &str, msg: &str) -> ApiError {
    ApiError::new(status, json!({ "error": msg, "code": code }))
}

fn base_url(state: &AppState, headers: &HeaderMap) -> String {
    crate::oauth::issuer(state.config.public_url.as_deref(), headers)
}

async fn server_enabled(state: &AppState) -> ApiResult<bool> {
    Ok(db::settings::get_solo(&state.db).await?.desktop_rustdesk_server)
}

/// 裝置要設的伺服器位址＋瀏覽器核心要的公鑰。/ What a device must be configured with, plus the core's key.
fn server_json(state: &AppState, base: &str, enabled: bool) -> Value {
    let s = device_settings(base);
    json!({ "enabled": enabled, "rendezvous": s.rendezvous, "api_server": s.api_server, "relay_url": s.relay_url, "problem": s.problem, "key": state.rustdesk_ids.key.public_b64() })
}

/// `last_used` = 最後一次被連（誰、何時），沒連過是 null。/ The latest session (who, when) or null.
fn device_json(state: &AppState, d: &RustDeskDevice, owner: Option<&str>, me: i64, last: Option<&(String, String)>) -> Value {
    json!({
        "id": d.id,
        "name": d.name,
        "rustdesk_id": d.rustdesk_id,
        "hostname": d.hostname,
        "os": d.os,
        "version": d.version,
        "online": state.rustdesk_ids.is_online(&d.rustdesk_id),
        "online_since": state.rustdesk_ids.online_since(&d.rustdesk_id).map(|t| t.to_rfc3339()),
        "last_seen_at": d.last_seen_at.as_deref().map(db_to_iso_utc_z),
        "created_at": db_to_iso_utc_z(&d.created_at),
        "owner": { "id": d.user_id, "username": owner },
        "mine": d.user_id == me,
        "in_use": state.rustdesk.count_for_device(d.id),
        "last_used": last.map(|(username, at)| json!({ "username": username, "at": db_to_iso_utc_z(at) })),
    })
}

/// 擁有者或管理員可以管理 / 使用；別人的當作不存在（不洩漏）。/ Owner or admin; anyone else gets a 404.
async fn device_for(state: &AppState, user_id: i64, is_superuser: bool, id: i64) -> ApiResult<RustDeskDevice> {
    match db::rustdesk_devices::by_id(&state.db, id).await? {
        Some(d) if d.user_id == user_id || is_superuser => Ok(d),
        _ => Err(ApiError::not_found("Device not found")),
    }
}

fn notify(state: &AppState, user_id: i64, device_id: i64, extra: Value) {
    let mut msg = json!({ "action": "RUSTDESK-DEVICES-UPDATED", "device_id": device_id, "details": "RustDesk devices updated" });
    if let (Some(m), Some(e)) = (msg.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    state.hub.notify_user(user_id, &msg);
}

// ---- 使用者 / users ---------------------------------------------------------------------

#[utoipa::path(get, path = "/api/rustdesk/devices", tag = "RustDesk server", security(("bearer" = [])), responses((status = 200, description = "{server, devices}: the server settings a device needs and your RustDesk devices (admins: everyone's)", body = super::schemas::RustDeskDeviceList)))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let rows = if user.is_superuser { db::rustdesk_devices::all(&state.db).await? } else { db::rustdesk_devices::for_user(&state.db, user.id).await? };
    let mut owners: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    for uid in rows.iter().map(|d| d.user_id).collect::<std::collections::BTreeSet<i64>>() {
        let name = db::users::by_id(&state.db, uid).await?.map(|u| u.username).unwrap_or_default();
        owners.insert(uid, name);
    }
    let last = db::rustdesk_devices::last_sessions(&state.db).await?;
    let devices: Vec<Value> = rows.iter().map(|d| device_json(&state, d, owners.get(&d.user_id).map(String::as_str), user.id, last.get(&d.id))).collect();
    let enabled = server_enabled(&state).await?;
    Ok(Json(json!({ "server": server_json(&state, &base_url(&state, &headers), enabled), "devices": devices })))
}

#[utoipa::path(patch, path = "/api/rustdesk/devices/{id}", tag = "RustDesk server", security(("bearer" = [])), params(("id" = i64, Path, description = "Device id (Telepy's, not the RustDesk ID)")), request_body = super::schemas::RustDeskDeviceRename, responses((status = 200, body = super::schemas::RustDeskDevice), (status = 400, description = "{name: [message]}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let d = device_for(&state, user.id, user.is_superuser, id).await?;
    let name = json_str(&body, "name").and_then(|n| clean_name(&n)).ok_or_else(|| ApiError::field("name", "Use 1 to 64 characters."))?;
    db::rustdesk_devices::rename(&state.db, d.id, &name).await?;
    let d = db::rustdesk_devices::by_id(&state.db, d.id).await?.ok_or_else(|| ApiError::not_found("Device not found"))?;
    notify(&state, d.user_id, d.id, json!({}));
    let owner = db::users::by_id(&state.db, d.user_id).await?.map(|u| u.username);
    let last = db::rustdesk_devices::last_sessions(&state.db).await?;
    Ok(Json(device_json(&state, &d, owner.as_deref(), user.id, last.get(&d.id))))
}

#[utoipa::path(delete, path = "/api/rustdesk/devices/{id}", tag = "RustDesk server", security(("bearer" = [])), params(("id" = i64, Path, description = "Device id")), responses((status = 204, description = "Removed; the device is disconnected and refused from now on"), (status = 404, body = super::schemas::ErrorBody)))]
async fn remove(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let d = device_for(&state, user.id, user.is_superuser, id).await?;
    db::rustdesk_devices::delete(&state.db, d.id).await?;
    state.rustdesk_ids.kick(&d.rustdesk_id);
    state.rustdesk.stop_device(d.id);
    notify(&state, d.user_id, d.id, json!({ "removed": true }));
    state.gateway.event("rustdesk_removed", None, None, None, format!("RustDesk device {} ({}) removed by {}", d.name, d.rustdesk_id, user.username)).await;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/rustdesk/devices/{id}/start", tag = "RustDesk server", security(("bearer" = [])), params(("id" = i64, Path, description = "Device id")), request_body = super::schemas::RustDeskIdStart, responses((status = 200, description = "Session created; the browser core connects to ws_path with ?ticket= (twice: ID-server role, then relay role) within expires_in seconds, asks for peer_id and verifies the device with key", body = super::schemas::RustDeskIdSession), (status = 400, description = "{credential_id: [message]}: not your saved login, saved for another desktop, or unreadable after a SECRET_KEY change", body = Object), (status = 404, body = super::schemas::ErrorBody), (status = 502, description = "code = device_offline", body = super::schemas::DesktopError), (status = 503, description = "code = desktop_disabled | rustdesk_server_disabled | desktop_busy", body = super::schemas::DesktopError)))]
async fn start(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let settings = db::settings::get_solo(&state.db).await?;
    if !settings.desktop_enabled {
        return Err(coded(StatusCode::SERVICE_UNAVAILABLE, "desktop_disabled", "Remote desktop is disabled on this server."));
    }
    if !settings.desktop_rustdesk_server {
        return Err(coded(StatusCode::SERVICE_UNAVAILABLE, "rustdesk_server_disabled", "Telepy's RustDesk server is turned off."));
    }
    let d = device_for(&state, user.id, user.is_superuser, id).await?;
    // 端對端加密：剪貼簿方向只能由瀏覽器裡的核心套用。/ End-to-end encrypted: the browser's core applies the clipboard direction.
    let (clipboard, clipboard_limit) = super::desktop::clipboard_for(&state, user.id, &settings, &body).await?;
    if !state.rustdesk_ids.is_online(&d.rustdesk_id) {
        return Err(coded(StatusCode::BAD_GATEWAY, "device_offline", "The RustDesk device is not connected to Telepy."));
    }
    let max = settings.desktop_max_sessions;
    if max > 0 && (state.desktop.count() + state.rustdesk.count()) as i64 >= max {
        return Err(coded(StatusCode::SERVICE_UNAVAILABLE, "desktop_busy", "All remote desktop slots are in use. Please wait for someone to disconnect and try again."));
    }
    // 憑證庫：只有綁這台裝置的解得開，密碼只放進這次回應（RustDesk 的挑戰由瀏覽器核心回）。
    // A saved password: only one bound to this device opens, and it goes into this response only.
    let (password, saved_label) = match json_i64(&body, "credential_id") {
        Some(cid) => {
            let (c, password) = super::credentials::unseal_for_device(&state, user.id, cid, d.id).await?;
            (Some(password), Some(c.label))
        }
        None => (None, None),
    };
    let (session, ticket) = state.rustdesk.create_id_session(NewIdSession {
        user_id: user.id,
        user_name: user.username.clone(),
        device_id: d.id,
        rustdesk_id: d.rustdesk_id.clone(),
        device_name: d.name.clone(),
        owner_id: d.user_id,
        saved_label,
    });
    tracing::info!(session = %session.id, user = %user.username, device = d.id, saved = session.saved_label.is_some(), "rustdesk: id-server session created");
    let mut out = json!({
        "session_id": session.id,
        "ws_path": format!("/ws/rustdesk/{}/", session.id),
        "ticket": ticket,
        "expires_in": TICKET_TTL.as_secs(),
        "peer_id": d.rustdesk_id,
        "key": state.rustdesk_ids.key.public_b64(),
        "device": { "id": d.id, "name": d.name, "rustdesk_id": d.rustdesk_id },
        "clipboard": clipboard.as_str(),
        "clipboard_limit": clipboard_limit.as_str(),
    });
    if let Some(p) = password {
        out["password"] = json!(p);
    }
    Ok(Json(out))
}

const SESSIONS_SHOWN: i64 = 20;

#[utoipa::path(get, path = "/api/rustdesk/devices/{id}/sessions", tag = "RustDesk server", security(("bearer" = [])), params(("id" = i64, Path, description = "Device id")), responses((status = 200, description = "The latest browser sessions to this device, newest first (owner or admin)", body = super::schemas::RustDeskDeviceSessions), (status = 404, body = super::schemas::ErrorBody)))]
async fn sessions(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let d = device_for(&state, user.id, user.is_superuser, id).await?;
    let rows = db::rustdesk_devices::recent_sessions(&state.db, d.id, SESSIONS_SHOWN).await?;
    let sessions: Vec<Value> = rows
        .iter()
        .map(|s| {
            let seconds = s.ended_at.as_deref().and_then(|end| {
                let (a, b) = (crate::util::parse_db_datetime(&s.started_at)?, crate::util::parse_db_datetime(end)?);
                Some((b - a).num_seconds().max(0))
            });
            json!({
                "id": s.id,
                "user": { "id": s.user_id, "username": s.username },
                "mine": s.user_id == user.id,
                "ip": s.ip,
                "geo": state.geoip.json(s.ip.as_deref()),
                "started_at": db_to_iso_utc_z(&s.started_at),
                "ended_at": s.ended_at.as_deref().map(db_to_iso_utc_z),
                "seconds": seconds,
                "to_browser": s.to_browser,
                "to_device": s.to_device,
                "reason": s.reason,
            })
        })
        .collect();
    Ok(Json(json!({ "sessions": sessions })))
}

fn enrolment_json(e: &Enrolment) -> Value {
    json!(e)
}

#[utoipa::path(post, path = "/api/rustdesk/enroll", tag = "RustDesk server", security(("bearer" = [])), request_body = super::schemas::RustDeskEnrollRequest, responses((status = 201, body = super::schemas::RustDeskEnrolmentCreated), (status = 400, description = "{name: [message]}", body = Object), (status = 429, description = "code = too_many_enrolments", body = super::schemas::JoinError), (status = 503, description = "code = rustdesk_server_disabled", body = super::schemas::JoinError)))]
async fn create_enrolment(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !server_enabled(&state).await? {
        return Err(coded(StatusCode::SERVICE_UNAVAILABLE, "rustdesk_server_disabled", "Telepy's RustDesk server is turned off."));
    }
    let name = match json_str(&body, "name").map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        Some(n) => Some(clean_name(&n).ok_or_else(|| ApiError::field("name", "Use 1 to 64 characters."))?),
        None => None,
    };
    let (token, e) = state
        .rustdesk_ids
        .mint_enrolment(user.id, name)
        .ok_or_else(|| coded(StatusCode::TOO_MANY_REQUESTS, "too_many_enrolments", "Too many open enrolment commands; use or cancel one first."))?;
    let base = base_url(&state, &headers);
    let settings = device_settings(&base);
    let mut v = enrolment_json(&e);
    let o = v.as_object_mut().unwrap();
    o.insert("token".into(), json!(token));
    o.insert("commands".into(), json!(device_commands(&settings, &token)));
    o.insert("server".into(), server_json(&state, &base, true));
    Ok((StatusCode::CREATED, Json(v)))
}

#[utoipa::path(get, path = "/api/rustdesk/enroll/{id}", tag = "RustDesk server", security(("bearer" = [])), params(("id" = String, Path, description = "Enrolment id (not the token)")), responses((status = 200, body = super::schemas::RustDeskEnrolment), (status = 404, body = super::schemas::ErrorBody)))]
async fn enrolment_status(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let e = state.rustdesk_ids.enrolment(user.id, &id).ok_or_else(ApiError::drf_not_found)?;
    Ok(Json(enrolment_json(&e)))
}

#[utoipa::path(delete, path = "/api/rustdesk/enroll/{id}", tag = "RustDesk server", security(("bearer" = [])), params(("id" = String, Path, description = "Enrolment id")), responses((status = 204, description = "Cancelled (only unused commands can be cancelled)"), (status = 404, body = super::schemas::ErrorBody)))]
async fn cancel_enrolment(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if state.rustdesk_ids.revoke_enrolment(user.id, &id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::drf_not_found())
    }
}

// ---- 裝置（RustDesk 的 API）/ devices (RustDesk's API) --------------------------------------

/// RustDesk 伺服器的慣例：錯誤也是 200，body `{"error": …}`。/ RustDesk servers answer errors as 200 with `{"error": …}`.
fn rd_error(msg: &str) -> Response {
    (StatusCode::OK, Json(json!({ "error": msg }))).into_response()
}

/// `rustdesk --deploy` 認得的結果。/ A result `rustdesk --deploy` understands.
fn deploy_result(result: &str) -> Response {
    (StatusCode::OK, Json(json!({ "result": result }))).into_response()
}

/// `rustdesk --deploy` 會把不認得的回應原樣印出：給它一行人看得懂的話。/ Printed as is by `rustdesk --deploy`.
fn deploy_message(msg: &'static str) -> Response {
    (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], msg).into_response()
}

fn rd_text(body: &'static str) -> Response {
    (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let t = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))?.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// 裝置送來的 `{id, uuid}` 對得上登記過的那一列。/ The `{id, uuid}` a device sent matches its enrolled row.
async fn known_device(state: &AppState, body: &Value) -> Option<RustDeskDevice> {
    let id = json_str(body, "id")?;
    let uuid = json_str(body, "uuid")?;
    let d = db::rustdesk_devices::by_rustdesk_id(&state.db, &id).await.ok()??;
    (!uuid.is_empty() && d.uuid == uuid).then_some(d)
}

#[utoipa::path(post, path = "/api/devices/deploy", tag = "RustDesk server", request_body = super::schemas::RustDeskDeploy, responses((status = 200, description = "`{\"result\": \"OK\"}` when enrolled, `INVALID_INPUT` / `ID_TAKEN` results, or one line of plain text that `rustdesk --deploy` prints (token problems, server turned off)", body = Object)))]
async fn deploy(State(state): State<AppState>, headers: HeaderMap, AppJson(body): AppJson<Value>) -> Response {
    let Some(token) = bearer(&headers) else { return deploy_message("Missing the enrolment token. Copy the command from Telepy again.") };
    let rid = json_str(&body, "id").unwrap_or_default();
    let uuid = json_str(&body, "uuid").unwrap_or_default();
    let pk = json_str(&body, "pk").unwrap_or_default();
    let pk_ok = base64::engine::general_purpose::STANDARD.decode(&pk).map(|b| b.len() == 32).unwrap_or(false);
    if !valid_rustdesk_id(&rid) || uuid.is_empty() || uuid.len() > 128 || !pk_ok {
        return deploy_result("INVALID_INPUT");
    }
    if !matches!(server_enabled(&state).await, Ok(true)) {
        return deploy_message("Telepy's RustDesk server is turned off. Ask an administrator to turn it on.");
    }
    let e = match state.rustdesk_ids.claim_enrolment(&token) {
        Ok(e) => e,
        Err(ClaimError::Used) => return deploy_message("This enrolment command was already used. Create a new one in Telepy."),
        Err(ClaimError::Invalid) => return deploy_message("This enrolment command is not valid any more. Create a new one in Telepy."),
    };
    let result = async {
        if let Some(existing) = db::rustdesk_devices::by_rustdesk_id(&state.db, &rid).await? {
            if existing.user_id != e.user_id {
                return Ok::<_, sqlx::Error>(Err(deploy_result("ID_TAKEN")));
            }
        }
        let name = e.name.clone().unwrap_or_else(|| default_name(&rid));
        Ok(Ok(db::rustdesk_devices::enrol(&state.db, e.user_id, &rid, &uuid, &pk, &name).await?))
    }
    .await;
    let (device, created) = match result {
        Ok(Ok(v)) => v,
        Ok(Err(refusal)) => {
            state.rustdesk_ids.release_enrolment(&e.token_hash);
            return refusal;
        }
        Err(err) => {
            tracing::error!(error = %err, "rustdesk server: enrolment failed");
            state.rustdesk_ids.release_enrolment(&e.token_hash);
            return deploy_message("Telepy could not save the device. Try again.");
        }
    };
    // 已在線的同一台換了金鑰：踢掉舊連線，讓它用新的重新註冊。/ Re-enrolled while online: drop the old socket.
    if !created {
        state.rustdesk_ids.kick(&device.rustdesk_id);
    }
    state.rustdesk_ids.mark_enrolled(&e.token_hash, device.id, &device.rustdesk_id);
    notify(&state, e.user_id, device.id, json!({ "enroll_id": e.id, "phase": "enrolled" }));
    let who = db::users::by_id(&state.db, e.user_id).await.ok().flatten().map(|u| u.username).unwrap_or_default();
    state.gateway.event("rustdesk_enrolled", None, None, None, format!("RustDesk device {} ({}) {} by {who}", device.name, device.rustdesk_id, if created { "enrolled" } else { "re-enrolled" })).await;
    // RustDesk 收到 OK 會印「Device deployed.」並通知自己的服務，馬上重新註冊。/ RustDesk prints "Device deployed." and re-registers.
    deploy_result("OK")
}

#[utoipa::path(post, path = "/api/sysinfo", tag = "RustDesk server", request_body = super::schemas::RustDeskSysinfo, responses((status = 200, description = "`SYSINFO_UPDATED` or `ID_NOT_FOUND` (plain text, RustDesk's protocol)", content_type = "text/plain", body = String)))]
async fn sysinfo(State(state): State<AppState>, AppJson(body): AppJson<Value>) -> Response {
    let Some(d) = known_device(&state, &body).await else { return rd_text("ID_NOT_FOUND") };
    let cut = |s: Option<String>, n: usize| s.map(|s| s.trim().chars().filter(|c| !c.is_control()).take(n).collect::<String>()).unwrap_or_default();
    let hostname = cut(json_str(&body, "hostname"), 255);
    let os = cut(json_str(&body, "os"), 255);
    let version = cut(json_str(&body, "version"), 32);
    if db::rustdesk_devices::set_sysinfo(&state.db, d.id, &hostname, &os, &version).await.is_err() {
        return rd_text("ID_NOT_FOUND");
    }
    // 登記時沒取名：用主機名稱。/ No name given at enrolment: use the hostname.
    if d.name == default_name(&d.rustdesk_id) {
        if let Some(name) = clean_name(&hostname) {
            let _ = db::rustdesk_devices::rename(&state.db, d.id, &name).await;
        }
    }
    notify(&state, d.user_id, d.id, json!({}));
    rd_text("SYSINFO_UPDATED")
}

#[utoipa::path(post, path = "/api/heartbeat", tag = "RustDesk server", request_body = Object, responses((status = 200, description = "`{}`", body = Object)))]
async fn heartbeat() -> Json<Value> {
    // 在線與否看註冊連線；心跳不用寫 DB。/ Online state comes from the registration socket.
    Json(json!({}))
}

#[utoipa::path(post, path = "/api/audit/{kind}", tag = "RustDesk server", params(("kind" = String, Path, description = "conn | file | alarm")), request_body = Object, responses((status = 200, description = "Empty body (anything else makes RustDesk retry)")))]
async fn audit(Path(_kind): Path<String>) -> StatusCode {
    // 連線紀錄 Telepy 自己有（rustdesk_open / rustdesk_close）；只要回空 body 讓裝置別重送。
    // Telepy logs sessions itself; an empty 2xx body stops the device from retrying.
    StatusCode::OK
}

#[utoipa::path(post, path = "/api/devices/cli", tag = "RustDesk server", request_body = Object, responses((status = 200, description = "`{\"error\": …}`: assigning devices is not supported", body = Object)))]
async fn assign() -> Response {
    rd_error("Telepy does not support rustdesk --assign; enrol devices from Telepy's web page.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(clean_name("  office pc "), Some("office pc".into()));
        assert_eq!(clean_name(""), None);
        assert_eq!(clean_name(&"x".repeat(65)), None);
        assert_eq!(clean_name("a\nb"), None);
        assert_eq!(clean_name("會議室電腦").as_deref(), Some("會議室電腦"));
    }

    #[test]
    fn bearer_tokens() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer(&h), None);
        h.insert(header::AUTHORIZATION, "Bearer tpr_abc".parse().unwrap());
        assert_eq!(bearer(&h).as_deref(), Some("tpr_abc"));
        h.insert(header::AUTHORIZATION, "Basic xyz".parse().unwrap());
        assert_eq!(bearer(&h), None);
    }
}
