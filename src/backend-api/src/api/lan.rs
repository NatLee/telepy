//! 區網主機（跳板機表）與區網掃描（#20）。
//! - `GET    /api/reverse/server/{id}/lan/hosts`：看得到隧道（VIEW）就能看
//! - `POST / PATCH / DELETE …/lan/hosts[/{host_id}]`：手動新增 / 改標籤、帳號、port / 刪除（EDIT）
//! - `POST   /api/reverse/server/{id}/lan/scan`：開始掃描（owner 或 ADMIN 分享者，且站台開關 `lan_scan_enabled`）
//! - `GET    /api/reverse/server/{id}/lan/scan`：進度 / 最近一次結果
//! - `GET    /api/reverse/lan/topology`：拓撲圖的資料（看得到的每條隧道 + 它的區網主機）
//! LAN hosts (jump-host table) and LAN discovery endpoints.

use std::net::Ipv4Addr;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::serialize::endpoint_json;
use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, lan::LanHost, tunnels::Tunnel, users::User};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::lan::{self, scan::ScanRequest, scan::Trigger, Network};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{db_to_iso, json_i64, json_str, opt_db_to_iso};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list_hosts, add_host))
        .routes(routes!(update_host, delete_host))
        .routes(routes!(start_scan, scan_status))
        .routes(routes!(get_schedule, put_schedule, delete_schedule))
        .routes(routes!(check_host))
        .routes(routes!(watch_host, unwatch_host))
        .routes(routes!(wake_host))
        .routes(routes!(os_host))
        .routes(routes!(topology))
}

fn lan_error(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// `vendor` = MAC 前綴的廠商（有 OUI 表才有）；`mac_private` = 隨機 / 私有 MAC。
/// `vendor` from the MAC prefix (when the OUI table is installed); `mac_private` = randomized MAC.
/// 掃描的整體結果給網頁 / CLI / MCP 看的樣子。/ The scan summary as the web, CLI and MCP see it.
pub fn meta_json(m: Option<&db::lan::LanMeta>, tz: i32) -> Value {
    match m {
        None => Value::Null,
        Some(m) => json!({
            "networks": m.network_list(),
            "gateway": m.gateway,
            "scanned_at": opt_db_to_iso(&m.scanned_at, tz),
            "changes": m.changes.as_deref().and_then(|c| serde_json::from_str::<Value>(c).ok()),
        }),
    }
}

/// 上次掃描有掃到它的網段、卻沒看到它（掃到過的主機才算，裝置自己不算）。/ Its network was scanned last time but it wasn't
/// seen (only hosts a scan has seen before; never the device itself).
fn missing(h: &LanHost, m: Option<&db::lan::LanMeta>) -> bool {
    if h.source == "self" || h.last_seen.is_none() {
        return false;
    }
    // 掃描（整網段或檢查這台）有記下探過它的時間：比它早看到的 = 這次沒看到。/ A covering scan was recorded: compare with it.
    if let (Some(seen), Some(checked)) = (h.last_seen.as_deref(), h.checked_at.as_deref()) {
        return seen < checked;
    }
    // 較早的資料只有最近一次整網段掃描的時間。/ Older data only has the last full scan's time.
    let (Some(m), Ok(ip), Some(seen)) = (m, h.address.parse::<std::net::Ipv4Addr>(), h.last_seen.as_deref()) else { return false };
    let scanned = m.network_list().iter().filter_map(|c| lan::parse_cidr(c).ok()).any(|n| n.contains(ip));
    scanned && m.scanned_at.as_deref().is_some_and(|at| seen < at)
}

/// 這台主機在上次掃描跟前一次比變了什麼（沒變 = null）。/ What changed for this host in the last scan (null = nothing).
fn since_last(h: &LanHost, m: Option<&db::lan::LanMeta>) -> Value {
    let Some(c) = m.and_then(|m| m.changes.as_deref()).and_then(|c| serde_json::from_str::<Value>(c).ok()) else { return Value::Null };
    let is_new = c["new"].as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some(h.address.as_str())));
    let ports = c["changed"].as_array().and_then(|a| a.iter().find(|x| x["address"].as_str() == Some(h.address.as_str())));
    if !is_new && ports.is_none() {
        return Value::Null;
    }
    json!({
        "new": is_new,
        "opened": ports.map_or(json!([]), |p| p["opened"].clone()),
        "closed": ports.map_or(json!([]), |p| p["closed"].clone()),
    })
}

pub fn host_json(h: &LanHost, tz: i32, oui: &crate::oui::Oui, meta: Option<&db::lan::LanMeta>) -> Value {
    let vendor = h.mac.as_deref().and_then(|m| oui.vendor(m));
    let mac_private = h.mac.as_deref().is_some_and(crate::oui::is_private);
    let ports = h.open_port_list();
    let services = h.service_list();
    let seen: Vec<(u16, &str)> = services.iter().filter(|s| s.proto == "http" || s.proto == "https").map(|s| (s.port, s.proto.as_str())).collect();
    let web: Vec<Value> = crate::lan::web_links(&h.address, &ports, &seen).into_iter().map(|(port, scheme, url)| json!({ "port": port, "scheme": scheme, "url": url })).collect();
    // 每次讀的時候才認（表改了不用重掃）。/ Identified when read, so a better table needs no rescan.
    let gateway = meta.and_then(|m| m.gateway.as_deref()) == Some(h.address.as_str());
    let identity = crate::lan::identify::identify(&services, vendor.as_deref(), &ports, gateway);
    json!({
        "own": h.source == "self",
        "gateway": gateway,
        "missing": missing(h, meta),
        "since_last": since_last(h, meta),
        "web": web,
        "services": services,
        "identity": identity,
        "vendor": vendor,
        "mac_private": mac_private,
        "id": h.id,
        "tunnel_id": h.tunnel_id,
        "address": h.address,
        "hostname": h.hostname,
        "mac": h.mac,
        "open_ports": ports,
        "ssh_banner": h.ssh_banner,
        "label": h.label,
        "username": h.username,
        "ssh_port": h.ssh_port,
        "source": h.source,
        "first_seen": opt_db_to_iso(&h.first_seen, tz),
        "last_seen": opt_db_to_iso(&h.last_seen, tz),
        "checked_at": opt_db_to_iso(&h.checked_at, tz),
        "notes": h.notes,
        "labels": h.label_list(),
        "os_check": os_check_json(h.os_check.as_deref(), tz),
        "created_at": db_to_iso(&h.created_at, tz),
    })
}

/// 存著的「這台跑什麼系統」（時間換成 ISO）。/ The stored OS check, its time as ISO.
fn os_check_json(raw: Option<&str>, tz: i32) -> Value {
    let Some(mut v) = raw.and_then(|r| serde_json::from_str::<Value>(r).ok()) else { return Value::Null };
    if let Some(at) = v.get("at").and_then(Value::as_str).map(str::to_string) {
        v["at"] = json!(db_to_iso(&at, tz));
    }
    v
}

/// 一串主機的 JSON，加上「我有沒有在注意它」。/ Hosts as JSON, plus whether I watch each one.
pub fn hosts_json(hosts: &[LanHost], tz: i32, oui: &crate::oui::Oui, meta: Option<&db::lan::LanMeta>, watched: &std::collections::HashSet<i64>) -> Vec<Value> {
    hosts
        .iter()
        .map(|h| {
            let mut v = host_json(h, tz, oui, meta);
            v["watched"] = json!(watched.contains(&h.id));
            v
        })
        .collect()
}

/// 定時重掃的設定給網頁 / CLI / MCP 看的樣子（沒有 = null）。/ The schedule as clients see it (null when none).
pub async fn schedule_json(state: &AppState, tunnel_id: i64) -> ApiResult<Value> {
    let tz = state.config.tz_offset_minutes;
    let Some(s) = db::lan::schedule(&state.db, tunnel_id).await? else { return Ok(Value::Null) };
    let by = db::users::by_id(&state.db, s.user_id).await?.map(|u| u.username);
    Ok(json!({
        "every_secs": s.every_secs,
        "username": s.username,
        "subnets": s.subnet_list(),
        "ports": s.port_list(),
        "identify": s.identify,
        "next_at": db_to_iso(&s.next_at, tz),
        "last_at": opt_db_to_iso(&s.last_at, tz),
        "last_error": s.last_error,
        "by": by,
        "updated_at": db_to_iso(&s.updated_at, tz),
    }))
}

/// 看得到的隧道（否則 404，與其他隧道端點一致）。/ A tunnel the user can see, else 404.
async fn visible(state: &AppState, user_id: i64, id: i64) -> ApiResult<(Tunnel, permissions::Effective)> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    let eff = permissions::effective_for(&state.db, user_id, &t).await?.ok_or_else(ApiError::drf_not_found)?;
    Ok((t, eff))
}

/// 誰能掃：站台開關開著，而且是 owner 或 ADMIN 分享者。回 None = 可以；Some(錯誤) = 不行。
/// Who may scan: the site switch is on and the user owns the tunnel or has ADMIN.
pub async fn scan_denied(state: &AppState, eff: permissions::Effective) -> ApiResult<Option<ApiError>> {
    if !db::settings::get_solo(&state.db).await?.lan_scan_enabled {
        return Ok(Some(lan_error(StatusCode::FORBIDDEN, "lan_scan_disabled", "LAN discovery is turned off by the administrator.")));
    }
    if !eff.satisfies(Permission::Admin) {
        return Ok(Some(lan_error(StatusCode::FORBIDDEN, "lan_scan_forbidden", "Only the tunnel owner and ADMIN sharees can scan its network.")));
    }
    Ok(None)
}

/// 驗證掃描參數並 `begin`；回傳可交給 `lan::scan::execute` 的請求。網頁與 MCP 共用。
/// Validate scan parameters and reserve the tunnel's scan slot; shared by the web API and MCP.
#[allow(clippy::too_many_arguments)]
pub async fn prepare_scan(state: &AppState, user: &User, tunnel: &Tunnel, eff: permissions::Effective, username: Option<&str>, subnets: Option<Vec<String>>, ports: Option<Vec<i64>>, identify: bool, trigger: Trigger) -> ApiResult<ScanRequest> {
    if let Some(e) = scan_denied(state, eff).await? {
        return Err(e);
    }
    let user_agent = crate::lan::fingerprint::user_agent(&db::settings::get_solo(&state.db).await?.lan_scan_user_agent);
    let allowed = permissions::allowed_usernames(&state.db, user.id, tunnel).await?;
    let username = permissions::choose_username(&allowed, tunnel.default_username_id, username, &tunnel.host_friendly_name).map_err(|e| lan_error(StatusCode::BAD_REQUEST, "username", e))?;
    let subnets: Option<Vec<Network>> = match subnets.filter(|s| !s.is_empty()) {
        None => None,
        Some(list) => {
            let parsed: Vec<Network> = list.iter().map(|c| lan::parse_cidr(c)).collect::<Result<_, _>>().map_err(|e| lan_error(StatusCode::BAD_REQUEST, "subnet", e))?;
            let total: u64 = parsed.iter().map(Network::size).sum();
            if total > lan::MAX_ADDRESSES as u64 {
                return Err(lan_error(StatusCode::BAD_REQUEST, "subnet", format!("scan at most {} addresses at once", lan::MAX_ADDRESSES)));
            }
            Some(parsed)
        }
    };
    let ports = match ports {
        None => lan::DEFAULT_PORTS.to_vec(),
        Some(p) => lan::parse_ports(&p).map_err(|e| lan_error(StatusCode::BAD_REQUEST, "ports", e))?,
    };
    let listed: Vec<u16> = ports.iter().copied().filter(|p| !lan::DEFAULT_PORTS.contains(p)).collect();
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(tunnel.reverse_port).map(|p| listen.contains(&p)).unwrap_or(false) {
            return Err(lan_error(StatusCode::BAD_REQUEST, "device_offline", format!("The device '{}' is offline.", tunnel.host_friendly_name)));
        }
    }
    state
        .lan_scans
        .begin(tunnel.id, user, &ports, trigger)
        .map_err(|running| ApiError::new(StatusCode::CONFLICT, json!({ "error": "A scan of this network is already running.", "code": "lan_scan_running", "scan": running })))?;
    Ok(ScanRequest { tunnel: tunnel.clone(), username, subnets, ports, user: user.clone(), identify, user_agent, listed, trigger })
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/lan/hosts", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::LanHostList), (status = 404, body = super::schemas::ErrorBody)))]
async fn list_hosts(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, eff) = visible(&state, user.id, id).await?;
    let tz = state.config.tz_offset_minutes;
    let hosts = db::lan::hosts_for_tunnel(&state.db, t.id).await?;
    let meta = db::lan::meta(&state.db, t.id).await?;
    let watched = db::lan::watched_by(&state.db, user.id, t.id).await?;
    Ok(Json(json!({
        "hosts": hosts_json(&hosts, tz, &state.oui, meta.as_ref(), &watched),
        "lan": meta_json(meta.as_ref(), tz),
        "schedule": schedule_json(&state, t.id).await?,
        "scan": state.lan_scans.get(t.id),
        "can_scan": scan_denied(&state, eff).await?.is_none(),
        "can_edit": eff.satisfies(Permission::Edit),
    })))
}

/// 位址：IPv4（要在私有網段）或主機名稱。/ An IPv4 address in a private range, or a hostname.
fn valid_address(raw: &str) -> Result<String, ApiError> {
    let a = raw.trim();
    if let Ok(ip) = a.parse::<Ipv4Addr>() {
        return if lan::is_scannable(ip) { Ok(a.to_string()) } else { Err(ApiError::field("address", "Use an address on the device's private network.")) };
    }
    let ok = !a.is_empty() && a.len() <= 253 && a.split('.').all(|l| !l.is_empty() && l.len() <= 63 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !l.starts_with('-'));
    if ok {
        Ok(a.to_ascii_lowercase())
    } else {
        Err(ApiError::field("address", "Enter an IPv4 address or a hostname."))
    }
}

fn optional_text(body: &Value, key: &str, max: usize) -> Result<Option<Option<String>>, ApiError> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.chars().count() > max {
                return Err(ApiError::field(key, format!("Ensure this field has no more than {max} characters.")));
            }
            Ok(Some((!s.is_empty()).then(|| s.to_string())))
        }
        Some(_) => Err(ApiError::field(key, "Not a valid string.")),
    }
}

/// 登入帳號：網頁終端機會把它交給 ssh，只收安全字元。/ The login name goes to ssh: safe characters only.
/// 備註：最多 2000 字，頭尾空白去掉、換行留著；空的 = 清掉。/ Notes: up to 2000 characters, trimmed, newlines kept.
fn host_notes(body: &Value) -> Result<Option<Option<String>>, ApiError> {
    optional_text(body, "notes", 2000)
}

/// 標籤：跟通道標籤同一套規則，最多 12 個；整組換掉。/ Labels: the tunnel label rules, at most 12; replaces the set.
fn host_labels(body: &Value) -> Result<Option<String>, ApiError> {
    let Some(v) = body.get("labels") else { return Ok(None) };
    let list: Vec<String> = match v {
        Value::Null => Vec::new(),
        Value::Array(a) => a.iter().map(|x| x.as_str().map(str::to_string).ok_or_else(|| ApiError::field("labels", "Labels must be strings."))).collect::<Result<_, _>>()?,
        _ => return Err(ApiError::field("labels", "Expected a list of labels.")),
    };
    let labels = db::tunnel_tags::normalize_labels(&list).map_err(|e| ApiError::field("labels", e))?;
    if labels.len() > MAX_HOST_LABELS {
        return Err(ApiError::field("labels", format!("At most {MAX_HOST_LABELS} labels.")));
    }
    Ok(Some(json!(labels).to_string()))
}

const MAX_HOST_LABELS: usize = 12;

fn login_name(body: &Value) -> Result<Option<Option<String>>, ApiError> {
    let v = optional_text(body, "username", 64)?;
    if let Some(Some(u)) = &v {
        if !crate::ssh::process::valid_login(u) {
            return Err(ApiError::field("username", "Use letters, digits, '.', '_' or '-' (not starting with '-')."));
        }
    }
    Ok(v)
}

fn ssh_port(body: &Value) -> Result<Option<i64>, ApiError> {
    match body.get("ssh_port") {
        None | Some(Value::Null) => Ok(None),
        Some(_) => match json_i64(body, "ssh_port") {
            Some(p) if (1..=65535).contains(&p) => Ok(Some(p)),
            _ => Err(ApiError::field("ssh_port", "Enter a port between 1 and 65535.")),
        },
    }
}

async fn editable(state: &AppState, user_id: i64, id: i64) -> ApiResult<Tunnel> {
    let (t, eff) = visible(state, user_id, id).await?;
    if !eff.satisfies(Permission::Edit) {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to edit this tunnel."));
    }
    Ok(t)
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/lan/hosts", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::LanHostWrite, responses((status = 201, body = super::schemas::LanHost), (status = 400, body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn add_host(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let t = editable(&state, user.id, id).await?;
    let address = valid_address(&json_str(&body, "address").unwrap_or_default())?;
    let label = optional_text(&body, "label", 100)?.flatten();
    let username = login_name(&body)?.flatten();
    let port = ssh_port(&body)?.unwrap_or(22);
    let h = db::lan::create_manual(&state.db, t.id, &address, label.as_deref(), username.as_deref(), port).await.map_err(|e| {
        if is_unique_violation(&e) {
            ApiError::field("address", "This address is already in the list.")
        } else {
            ApiError::from(e)
        }
    })?;
    notify_updated(&state, &t).await;
    let meta = db::lan::meta(&state.db, t.id).await?;
    Ok((StatusCode::CREATED, Json(host_json(&h, state.config.tz_offset_minutes, &state.oui, meta.as_ref()))))
}

async fn own_host(state: &AppState, tunnel_id: i64, host_id: i64) -> ApiResult<LanHost> {
    db::lan::host_by_id(&state.db, host_id).await?.filter(|h| h.tunnel_id == tunnel_id).ok_or_else(ApiError::drf_not_found)
}

#[utoipa::path(patch, path = "/api/reverse/server/{id}/lan/hosts/{host_id}", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("host_id" = i64, Path)), request_body = super::schemas::LanHostPatch, responses((status = 200, body = super::schemas::LanHost), (status = 400, body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_host(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, host_id)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = editable(&state, user.id, id).await?;
    let h = own_host(&state, t.id, host_id).await?;
    let label = optional_text(&body, "label", 100)?;
    let username = login_name(&body)?;
    let port = ssh_port(&body)?;
    let notes = host_notes(&body)?;
    let labels = host_labels(&body)?;
    db::lan::update(
        &state.db,
        h.id,
        db::lan::HostPatch {
            label: label.as_ref().map(|o| o.as_deref()),
            username: username.as_ref().map(|o| o.as_deref()),
            ssh_port: port,
            notes: notes.as_ref().map(|o| o.as_deref()),
            labels: labels.as_deref(),
        },
    )
    .await?;
    notify_updated(&state, &t).await;
    let meta = db::lan::meta(&state.db, t.id).await?;
    let watched = db::lan::watched_by(&state.db, user.id, t.id).await?;
    let h = own_host(&state, t.id, host_id).await?;
    Ok(Json(hosts_json(std::slice::from_ref(&h), state.config.tz_offset_minutes, &state.oui, meta.as_ref(), &watched).remove(0)))
}

#[utoipa::path(delete, path = "/api/reverse/server/{id}/lan/hosts/{host_id}", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("host_id" = i64, Path)), responses((status = 204, description = "Removed (a later scan finds it again if it is still there)"), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_host(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, host_id)): Path<(i64, i64)>) -> ApiResult<StatusCode> {
    let t = editable(&state, user.id, id).await?;
    let h = own_host(&state, t.id, host_id).await?;
    db::lan::delete(&state.db, h.id).await?;
    notify_updated(&state, &t).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn notify_updated(state: &AppState, t: &Tunnel) {
    if let Ok(audience) = super::notify::tunnel_audience(state, t).await {
        state.hub.notify_users(audience, &json!({ "action": "UPDATED-LAN-HOSTS", "tunnel_id": t.id, "details": format!("LAN hosts of '{}' updated", t.host_friendly_name) }));
    }
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/lan/scan", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::LanScanRequest, responses(
    (status = 202, description = "Started; follow LAN-SCAN-PROGRESS / LAN-SCAN-DONE on /ws/notifications or poll GET", body = super::schemas::LanScanStatus),
    (status = 400, description = "username / subnet / ports / device_offline", body = super::schemas::LanError),
    (status = 403, description = "lan_scan_disabled / lan_scan_forbidden", body = super::schemas::LanError),
    (status = 409, description = "lan_scan_running", body = super::schemas::LanError),
))]
async fn start_scan(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (t, eff) = visible(&state, user.id, id).await?;
    super::step_up::check(&state, user.id, &t, &headers)?;
    let subnets = body.get("subnets").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());
    let ports = body.get("ports").and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_i64().unwrap_or(-1)).collect());
    let identify = body.get("identify").and_then(Value::as_bool).unwrap_or(true);
    let req = prepare_scan(&state, &user, &t, eff, json_str(&body, "username").as_deref(), subnets, ports, identify, Trigger::Manual).await?;
    let status = state.lan_scans.get(t.id);
    tokio::spawn(crate::lan::scan::execute(state.clone(), req));
    Ok((StatusCode::ACCEPTED, Json(json!(status))))
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/lan/scan", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "The running or latest scan since the server started; null when none", body = super::schemas::LanScanStatus), (status = 404, body = super::schemas::ErrorBody)))]
async fn scan_status(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, _) = visible(&state, user.id, id).await?;
    Ok(Json(json!(state.lan_scans.get(t.id))))
}

/// 定時重掃的設定：間隔、帳號、網段、port、辨識。共用的驗證（PUT 與 CLI / MCP 的說明同一套）。
/// The schedule's settings: interval, account, subnets, ports, identify. One validation for PUT.
struct ScheduleBody {
    every: i64,
    username: Option<String>,
    subnets: Option<Vec<String>>,
    ports: Option<Vec<i64>>,
    identify: bool,
}

fn schedule_body(body: &Value) -> ApiResult<ScheduleBody> {
    let every = body.get("every_secs").and_then(Value::as_i64).unwrap_or(0);
    if !lan::watch::valid_every(every) {
        return Err(lan_error(StatusCode::BAD_REQUEST, "every", format!("every_secs must be one of {:?}", lan::watch::EVERY)));
    }
    let subnets: Option<Vec<String>> = body.get("subnets").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>()).filter(|v| !v.is_empty());
    if let Some(list) = &subnets {
        let parsed: Vec<Network> = list.iter().map(|c| lan::parse_cidr(c)).collect::<Result<_, _>>().map_err(|e| lan_error(StatusCode::BAD_REQUEST, "subnet", e))?;
        if parsed.iter().map(Network::size).sum::<u64>() > lan::MAX_ADDRESSES as u64 {
            return Err(lan_error(StatusCode::BAD_REQUEST, "subnet", format!("scan at most {} addresses at once", lan::MAX_ADDRESSES)));
        }
    }
    let ports: Option<Vec<i64>> = body.get("ports").and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_i64().unwrap_or(-1)).collect::<Vec<_>>()).filter(|v| !v.is_empty());
    if let Some(p) = &ports {
        lan::parse_ports(p).map_err(|e| lan_error(StatusCode::BAD_REQUEST, "ports", e))?;
    }
    let identify = body.get("identify").and_then(Value::as_bool).unwrap_or(true);
    Ok(ScheduleBody { every, username: json_str(body, "username"), subnets, ports, identify })
}

fn every_words(secs: i64) -> String {
    match secs {
        s if s % 86_400 == 0 && s / 86_400 == 7 => "every week".into(),
        s if s % 86_400 == 0 => format!("every {} day(s)", s / 86_400),
        s => format!("every {} h", s / 3600),
    }
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/lan/schedule", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "The tunnel's scheduled rescan; null when none", body = super::schemas::LanSchedule), (status = 404, body = super::schemas::ErrorBody)))]
async fn get_schedule(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, _) = visible(&state, user.id, id).await?;
    Ok(Json(schedule_json(&state, t.id).await?))
}

#[utoipa::path(put, path = "/api/reverse/server/{id}/lan/schedule", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::LanScheduleInput, responses(
    (status = 200, description = "Saved; scans run as you, with these settings, while the device is online", body = super::schemas::LanSchedule),
    (status = 400, description = "every / subnet / ports / username", body = super::schemas::LanError),
    (status = 403, description = "lan_scan_disabled / lan_scan_forbidden", body = super::schemas::LanError),
    (status = 404, body = super::schemas::ErrorBody),
))]
async fn put_schedule(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (t, eff) = visible(&state, user.id, id).await?;
    super::step_up::check(&state, user.id, &t, &headers)?;
    if let Some(e) = scan_denied(&state, eff).await? {
        return Err(e);
    }
    let ScheduleBody { every, username, subnets, ports, identify } = schedule_body(&body)?;
    // 帳號要是自己在這條隧道能用的（之後每次跑還會再檢查）。/ The account must be one you may use here (checked again on every run).
    let allowed = permissions::allowed_usernames(&state.db, user.id, &t).await?;
    let username = permissions::choose_username(&allowed, t.default_username_id, username.as_deref(), &t.host_friendly_name).map_err(|e| lan_error(StatusCode::BAD_REQUEST, "username", e))?;
    let now = crate::util::now_db();
    let next = crate::util::db_time(chrono::Utc::now() + chrono::Duration::seconds(every));
    let created = db::lan::schedule(&state.db, t.id).await?.map(|s| s.created_at).unwrap_or_else(|| now.clone());
    db::lan::save_schedule(
        &state.db,
        &db::lan::LanSchedule {
            tunnel_id: t.id,
            user_id: user.id,
            every_secs: every,
            username: Some(username),
            subnets: subnets.as_ref().map(|v| json!(v).to_string()),
            ports: ports.as_ref().map(|v| json!(v).to_string()),
            identify,
            next_at: next,
            last_at: None,
            last_error: None,
            created_at: created,
            updated_at: now,
        },
    )
    .await?;
    state.gateway.event("lan_schedule", None, None, Some(t.id), format!("{} set a LAN rescan of {} {}", user.username, t.host_friendly_name, every_words(every))).await;
    notify_updated(&state, &t).await;
    Ok(Json(schedule_json(&state, t.id).await?))
}

#[utoipa::path(delete, path = "/api/reverse/server/{id}/lan/schedule", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 204, description = "Stopped (also when there was none)"), (status = 403, body = super::schemas::LanError), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_schedule(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let (t, eff) = visible(&state, user.id, id).await?;
    // 站台關掉掃描時也能停（只看權限）。/ Stopping works even with scanning turned off (permission only).
    if !eff.satisfies(Permission::Admin) {
        return Err(lan_error(StatusCode::FORBIDDEN, "lan_scan_forbidden", "Only the tunnel owner and ADMIN sharees can change its scans."));
    }
    if db::lan::delete_schedule(&state.db, t.id).await? {
        state.gateway.event("lan_schedule", None, None, Some(t.id), format!("{} stopped the LAN rescans of {}", user.username, t.host_friendly_name)).await;
        notify_updated(&state, &t).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// 「檢查這台」用的 port：它上次開著的在前，再補預設的，最多 `MAX_PORTS` 個。/ Ports for a check: its last open ones, then defaults.
pub fn check_ports(h: &LanHost, asked: Option<Vec<i64>>) -> Vec<i64> {
    if let Some(p) = asked.filter(|p| !p.is_empty()) {
        return p;
    }
    let mut out: Vec<i64> = h.open_port_list().into_iter().map(i64::from).collect();
    for p in lan::DEFAULT_PORTS {
        if out.len() >= lan::MAX_PORTS {
            break;
        }
        if !out.contains(&i64::from(*p)) {
            out.push(i64::from(*p));
        }
    }
    out.truncate(lan::MAX_PORTS);
    out
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/lan/hosts/{host_id}/check", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("host_id" = i64, Path)), request_body = Object, responses(
    (status = 202, description = "Checking that one host (every port on it, no network sweep); progress like a scan", body = super::schemas::LanScanStatus),
    (status = 400, description = "lan_check_address (hostnames can't be checked) / ports / device_offline", body = super::schemas::LanError),
    (status = 403, description = "lan_scan_disabled / lan_scan_forbidden", body = super::schemas::LanError),
    (status = 404, body = super::schemas::ErrorBody),
    (status = 409, description = "lan_scan_running", body = super::schemas::LanError),
))]
async fn check_host(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path((id, host_id)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (t, eff) = visible(&state, user.id, id).await?;
    super::step_up::check(&state, user.id, &t, &headers)?;
    let h = own_host(&state, t.id, host_id).await?;
    let ip: Ipv4Addr = h.address.parse().ok().filter(|ip| lan::is_scannable(*ip)).ok_or_else(|| lan_error(StatusCode::BAD_REQUEST, "lan_check_address", "Only hosts with a private IPv4 address can be checked."))?;
    let asked = body.get("ports").and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_i64().unwrap_or(-1)).collect());
    let identify = body.get("identify").and_then(Value::as_bool).unwrap_or(true);
    let req = prepare_scan(&state, &user, &t, eff, json_str(&body, "username").as_deref(), Some(vec![format!("{ip}/32")]), Some(check_ports(&h, asked)), identify, Trigger::Check(h.id)).await?;
    let status = state.lan_scans.get(t.id);
    tokio::spawn(crate::lan::scan::execute(state.clone(), req));
    Ok((StatusCode::ACCEPTED, Json(json!(status))))
}

#[utoipa::path(put, path = "/api/reverse/server/{id}/lan/hosts/{host_id}/watch", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("host_id" = i64, Path)), responses((status = 200, description = "You'll be told when a scan finds it gone, back or with other ports", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn watch_host(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, host_id)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    let (t, _) = visible(&state, user.id, id).await?;
    let h = own_host(&state, t.id, host_id).await?;
    db::lan::set_watch(&state.db, user.id, h.id, true).await?;
    Ok(Json(json!({ "watched": true })))
}

#[utoipa::path(delete, path = "/api/reverse/server/{id}/lan/hosts/{host_id}/watch", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("host_id" = i64, Path)), responses((status = 200, description = "No longer watched", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn unwatch_host(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, host_id)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    let (t, _) = visible(&state, user.id, id).await?;
    let h = own_host(&state, t.id, host_id).await?;
    db::lan::set_watch(&state.db, user.id, h.id, false).await?;
    Ok(Json(json!({ "watched": false })))
}

/// 這台跑什麼系統（`lan::os`）：使用者對這一台按了才跑，跟掃描同一套權限（owner / ADMIN + 站台開關）。
/// Which OS this host runs (`lan::os`): only on request for this one host, with the scan's rules (owner / ADMIN + the site switch).
#[utoipa::path(post, path = "/api/reverse/server/{id}/lan/hosts/{host_id}/os", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("host_id" = i64, Path)), request_body = super::schemas::LanOsRequest, responses(
    (status = 200, description = "The host with its `os_check` (family, name, confidence and every clue)", body = super::schemas::LanHost),
    (status = 400, description = "lan_check_address (private IPv4 only) / device_offline / username / smb_port", body = super::schemas::LanError),
    (status = 403, description = "lan_scan_disabled / lan_scan_forbidden / step_up_required", body = super::schemas::LanError),
    (status = 404, body = super::schemas::ErrorBody),
    (status = 409, description = "lan_os_running (already checking this host)", body = super::schemas::LanError),
    (status = 502, description = "lan_os_failed (the device could not run the command)", body = super::schemas::LanError),
))]
async fn os_host(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path((id, host_id)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (t, eff) = visible(&state, user.id, id).await?;
    super::step_up::check(&state, user.id, &t, &headers)?;
    let h = own_host(&state, t.id, host_id).await?;
    let smb_port = match body.get("smb_port") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).ok_or_else(|| lan_error(StatusCode::BAD_REQUEST, "smb_port", "smb_port must be 1–65535."))?),
    };
    Ok(Json(identify_os(&state, &user, &t, eff, &h, json_str(&body, "username").as_deref(), smb_port).await?))
}

/// 檢查的共用部分（網頁、CLI、MCP）。/ The shared part (web, CLI, MCP).
pub async fn identify_os(state: &AppState, user: &User, t: &Tunnel, eff: permissions::Effective, h: &LanHost, username: Option<&str>, smb_port: Option<u16>) -> ApiResult<Value> {
    if let Some(e) = scan_denied(state, eff).await? {
        return Err(e);
    }
    let ip: Ipv4Addr = h.address.parse().ok().filter(|ip| lan::is_scannable(*ip)).ok_or_else(|| lan_error(StatusCode::BAD_REQUEST, "lan_check_address", "Only hosts with a private IPv4 address can be checked."))?;
    let allowed = permissions::allowed_usernames(&state.db, user.id, t).await?;
    let account = permissions::choose_username(&allowed, t.default_username_id, username, &t.host_friendly_name).map_err(|e| lan_error(StatusCode::BAD_REQUEST, "username", e))?;
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(t.reverse_port).map(|p| listen.contains(&p)).unwrap_or(false) {
            return Err(lan_error(StatusCode::BAD_REQUEST, "device_offline", format!("The device '{}' is offline.", t.host_friendly_name)));
        }
    }
    let _running = lan::os_probe::begin(h.id).ok_or_else(|| lan_error(StatusCode::CONFLICT, "lan_os_running", "Telepy is already checking this host."))?;
    let vendor = h.mac.as_deref().and_then(|m| state.oui.vendor(m));
    let check = lan::os_probe::run(state, t, h, &account, smb_port, vendor.as_deref(), &user.username).await.map_err(|e| lan_error(StatusCode::BAD_GATEWAY, "lan_os_failed", format!("{e:#}")))?;
    let raw = serde_json::to_string(&check).unwrap_or_default();
    db::lan::save_os_check(&state.db, h.id, &raw).await?;
    let sources: Vec<&str> = check.evidence.iter().filter(|e| e.weight > 0).map(|e| e.source.as_str()).collect();
    let said = match &check.name {
        Some(n) => format!("{n} ({} confidence)", check.confidence),
        None => check.family.clone().map(|f| format!("a {f} system ({} confidence)", check.confidence)).unwrap_or_else(|| "nothing conclusive".into()),
    };
    let msg = format!("{} checked which OS {ip} runs: {said}; clues: {}", user.username, if sources.is_empty() { "none".to_string() } else { sources.join(", ") });
    state.gateway.event("lan_os", None, u16::try_from(t.reverse_port).ok(), Some(t.id), msg).await;
    let fresh = db::lan::host_by_id(&state.db, h.id).await?.ok_or_else(ApiError::drf_not_found)?;
    let meta = db::lan::meta(&state.db, t.id).await?;
    let watched = db::lan::watched_by(&state.db, user.id, t.id).await?;
    notify_updated(state, t).await;
    Ok(hosts_json(&[fresh], state.config.tz_offset_minutes, &state.oui, meta.as_ref(), &watched).remove(0))
}

/// 喚醒：在裝置上跑一段指令送出 Wake-on-LAN 封包（`lan::wake`）。誰能用：看得到這條隧道、而且在這裡有能用的帳號的人
/// （跟開終端機一樣：能在那個帳號跑指令的人本來就能自己送）。
/// Wake: run a command on the device that sends the Wake-on-LAN packet (`lan::wake`). Who: anyone who can see the tunnel
/// and has an account they may use here (like opening a terminal: whoever can run commands there could send it anyway).
#[utoipa::path(post, path = "/api/reverse/server/{id}/lan/hosts/{host_id}/wake", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("host_id" = i64, Path)), request_body = Object, responses(
    (status = 200, description = "Sent: `{tool, broadcast, mac}`; the machine needs Wake-on-LAN turned on and usually 10–60 s to start", body = Object),
    (status = 400, description = "lan_wake_mac (no MAC known) / device_offline / username", body = super::schemas::LanError),
    (status = 403, description = "no_account (no account you may use on the device)", body = super::schemas::LanError),
    (status = 404, body = super::schemas::ErrorBody),
    (status = 502, description = "lan_wake_failed (the device had no tool to send it, or the login failed)", body = super::schemas::LanError),
))]
async fn wake_host(State(state): State<AppState>, AuthUser(user): AuthUser, headers: axum::http::HeaderMap, Path((id, host_id)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (t, _) = visible(&state, user.id, id).await?;
    super::step_up::check(&state, user.id, &t, &headers)?;
    let h = own_host(&state, t.id, host_id).await?;
    let out = wake(&state, &user, &t, &h, json_str(&body, "username").as_deref()).await?;
    Ok(Json(out))
}

/// 喚醒的共用部分（網頁、CLI、MCP）。/ The shared part of waking (web, CLI, MCP).
pub async fn wake(state: &AppState, user: &User, t: &Tunnel, h: &LanHost, username: Option<&str>) -> ApiResult<Value> {
    let mac = h.mac.as_deref().and_then(lan::wake::parse_mac).ok_or_else(|| lan_error(StatusCode::BAD_REQUEST, "lan_wake_mac", "Telepy doesn't know this machine's MAC address yet: a scan reads it from the device's neighbour table while the machine is on."))?;
    let allowed = permissions::allowed_usernames(&state.db, user.id, t).await?;
    if allowed.is_empty() {
        return Err(lan_error(StatusCode::FORBIDDEN, "no_account", "You have no account you may use on this device."));
    }
    let username = permissions::choose_username(&allowed, t.default_username_id, username, &t.host_friendly_name).map_err(|e| lan_error(StatusCode::BAD_REQUEST, "username", e))?;
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(t.reverse_port).map(|p| listen.contains(&p)).unwrap_or(false) {
            return Err(lan_error(StatusCode::BAD_REQUEST, "device_offline", format!("The device '{}' is offline.", t.host_friendly_name)));
        }
    }
    let networks: Vec<Network> = db::lan::meta(&state.db, t.id).await?.map(|m| m.network_list().iter().filter_map(|c| lan::parse_cidr(c).ok()).collect()).unwrap_or_default();
    let broadcast = lan::wake::broadcast_for(h.address.parse().ok(), &networks);
    let run = |cmd: String| {
        let state = state.clone();
        let username = username.clone();
        async move {
            match state.pool.session_channel(&state, t.reverse_port, &username).await {
                Ok((_lease, ch)) => crate::ssh::exec::run_on(ch, &cmd, std::time::Duration::from_secs(20), 16 * 1024).await.map(|r| r.stdout.text).map_err(|e| format!("{e:#}")),
                Err(e) => Err(format!("cannot log in to the device as {username}: {e:#}")),
            }
        }
    };
    let mut sent = run(lan::wake::posix_command(&mac, broadcast)).await.map(|o| lan::wake::parse_result(&o));
    if matches!(sent, Ok(None)) {
        sent = run(lan::wake::windows_command(&mac, broadcast)).await.map(|o| lan::wake::parse_result(&o));
    }
    let name = h.label.clone().or_else(|| h.hostname.clone()).unwrap_or_else(|| h.address.clone());
    let mac_s = lan::wake::mac_text(&mac);
    match sent {
        Ok(Some((tool, b))) => {
            state.gateway.event("lan_wake", None, None, Some(t.id), format!("{} sent a wake-up packet to {name} ({mac_s}) through the device, with {tool}", user.username)).await;
            Ok(json!({ "tool": tool, "broadcast": if b.is_empty() { Value::Null } else { json!(b) }, "mac": mac_s, "username": username }))
        }
        Ok(None) => Err(lan_error(
            StatusCode::BAD_GATEWAY,
            "lan_wake_failed",
            "The device has nothing to send a wake-up packet with: install wakeonlan (or etherwake, or python3) on it, or use a Windows device's PowerShell.",
        )),
        Err(e) => Err(lan_error(StatusCode::BAD_GATEWAY, "lan_wake_failed", e)),
    }
}

#[utoipa::path(get, path = "/api/reverse/lan/topology", tag = "LAN", security(("bearer" = [])), responses((status = 200, description = "Every tunnel the user can see with its status and LAN hosts, for the topology view", body = super::schemas::LanTopology)))]
async fn topology(State(state): State<AppState>, AuthUser(user): AuthUser, d: crate::auth::extractor::Delegated) -> ApiResult<Json<Value>> {
    let tz = state.config.tz_offset_minutes;
    let tunnels = db::tunnels::visible_to(&state.db, user.id).await?;
    let (mine, _) = db::sharing::permission_context(&state.db, user.id).await?;
    let listen = state.status.listen_ports();
    let latency = state.status.latency().unwrap_or_default();
    let scans_enabled = db::settings::get_solo(&state.db).await?.lan_scan_enabled;
    let last = db::tunnel_endpoints::visible_to(&state.db, user.id).await?;
    let live = state.status.endpoints();
    let mut out = Vec::with_capacity(tunnels.len());
    // API token / app 的隧道限制。/ A token's tunnel restriction.
    for t in tunnels.iter().filter(|t| d.allows(t.id)) {
        let Some(eff) = permissions::effective(user.id, t.user_id, mine.get(&t.id).map(String::as_str)) else { continue };
        let port = u16::try_from(t.reverse_port).ok();
        let allowed = permissions::allowed_usernames(&state.db, user.id, t).await?;
        let default_username = t.default_username_id.and_then(|d| allowed.iter().find(|u| u.id == d)).map(|u| u.username.clone()).or_else(|| (allowed.len() == 1).then(|| allowed[0].username.clone()));
        let hosts = db::lan::hosts_for_tunnel(&state.db, t.id).await?;
        let meta = db::lan::meta(&state.db, t.id).await?;
        let watched = db::lan::watched_by(&state.db, user.id, t.id).await?;
        // 裝置自己的位址（內網網卡、公網 IP），跟隧道列表同一個 `endpoint`、同一道門檻。
        // The device's own addresses (LAN interfaces, public IP): the tunnel list's `endpoint`, same gate.
        let endpoint = if permissions::can_see_endpoint(Some(eff), !allowed.is_empty(), user.is_superuser) {
            endpoint_json(port.and_then(|p| live.get(&p)), last.get(&t.id), &state.geoip)
        } else {
            Value::Null
        };
        out.push(json!({
            "id": t.id,
            "name": t.host_friendly_name,
            "reverse_port": t.reverse_port,
            "online": listen.as_ref().map(|l| port.map(|p| l.contains(&p)).unwrap_or(false)),
            "rtt_ms": port.and_then(|p| latency.get(&p).copied()),
            "permission": eff.label(),
            "can_scan": scans_enabled && eff.satisfies(Permission::Admin),
            "can_edit": eff.satisfies(Permission::Edit),
            "usernames": allowed.iter().map(|u| u.username.clone()).collect::<Vec<_>>(),
            "default_username": default_username,
            "endpoint": endpoint,
            "scan": state.lan_scans.get(t.id),
            "lan": meta_json(meta.as_ref(), tz),
            "schedule": schedule_json(&state, t.id).await?,
            "hosts": hosts_json(&hosts, tz, &state.oui, meta.as_ref(), &watched),
        }));
    }
    Ok(Json(json!({ "tunnels": out })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_json_adds_the_vendor_and_flags_private_macs() {
        let oui = crate::oui::Oui::from_csv("Registry,Assignment,Organization Name\nMA-L,B827EB,Raspberry Pi Foundation\n");
        let mut h = LanHost {
            id: 1,
            tunnel_id: 1,
            address: "192.168.1.9".into(),
            hostname: None,
            mac: Some("b8:27:eb:01:02:03".into()),
            open_ports: "[22]".into(),
            ssh_banner: None,
            services: "[]".into(),
            label: None,
            username: None,
            ssh_port: 22,
            source: "scan".into(),
            first_seen: None,
            last_seen: None,
            checked_at: None,
            notes: None,
            labels: "[]".into(),
            os_check: None,
            created_at: "2026-10-24 00:00:00.000000".into(),
            updated_at: "2026-10-24 00:00:00.000000".into(),
        };
        let v = host_json(&h, 480, &oui, None);
        assert_eq!(v["vendor"], "Raspberry Pi Foundation");
        assert_eq!(v["mac_private"], false);
        h.mac = Some("da:a1:19:00:00:01".into());
        let v = host_json(&h, 480, &oui, None);
        assert!(v["vendor"].is_null());
        assert_eq!(v["mac_private"], true);
    }
}
