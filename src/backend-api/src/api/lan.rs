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
use crate::lan::{self, scan::ScanRequest, Network};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{db_to_iso, json_i64, json_str, opt_db_to_iso};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list_hosts, add_host))
        .routes(routes!(update_host, delete_host))
        .routes(routes!(start_scan, scan_status))
        .routes(routes!(topology))
}

fn lan_error(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// `vendor` = MAC 前綴的廠商（有 OUI 表才有）；`mac_private` = 隨機 / 私有 MAC。
/// `vendor` from the MAC prefix (when the OUI table is installed); `mac_private` = randomized MAC.
pub fn host_json(h: &LanHost, tz: i32, oui: &crate::oui::Oui) -> Value {
    let vendor = h.mac.as_deref().and_then(|m| oui.vendor(m));
    let mac_private = h.mac.as_deref().is_some_and(crate::oui::is_private);
    json!({
        "vendor": vendor,
        "mac_private": mac_private,
        "id": h.id,
        "tunnel_id": h.tunnel_id,
        "address": h.address,
        "hostname": h.hostname,
        "mac": h.mac,
        "open_ports": h.open_port_list(),
        "ssh_banner": h.ssh_banner,
        "label": h.label,
        "username": h.username,
        "ssh_port": h.ssh_port,
        "source": h.source,
        "first_seen": opt_db_to_iso(&h.first_seen, tz),
        "last_seen": opt_db_to_iso(&h.last_seen, tz),
        "created_at": db_to_iso(&h.created_at, tz),
    })
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
pub async fn prepare_scan(state: &AppState, user: &User, tunnel: &Tunnel, eff: permissions::Effective, username: Option<&str>, subnets: Option<Vec<String>>, ports: Option<Vec<i64>>) -> ApiResult<ScanRequest> {
    if let Some(e) = scan_denied(state, eff).await? {
        return Err(e);
    }
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
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(tunnel.reverse_port).map(|p| listen.contains(&p)).unwrap_or(false) {
            return Err(lan_error(StatusCode::BAD_REQUEST, "device_offline", format!("The device '{}' is offline.", tunnel.host_friendly_name)));
        }
    }
    state
        .lan_scans
        .begin(tunnel.id, user, &ports)
        .map_err(|running| ApiError::new(StatusCode::CONFLICT, json!({ "error": "A scan of this network is already running.", "code": "lan_scan_running", "scan": running })))?;
    Ok(ScanRequest { tunnel: tunnel.clone(), username, subnets, ports, user: user.clone() })
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/lan/hosts", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::LanHostList), (status = 404, body = super::schemas::ErrorBody)))]
async fn list_hosts(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, eff) = visible(&state, user.id, id).await?;
    let tz = state.config.tz_offset_minutes;
    let hosts = db::lan::hosts_for_tunnel(&state.db, t.id).await?;
    Ok(Json(json!({
        "hosts": hosts.iter().map(|h| host_json(h, tz, &state.oui)).collect::<Vec<_>>(),
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
    Ok((StatusCode::CREATED, Json(host_json(&h, state.config.tz_offset_minutes, &state.oui))))
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
    db::lan::update(
        &state.db,
        h.id,
        db::lan::HostPatch { label: label.as_ref().map(|o| o.as_deref()), username: username.as_ref().map(|o| o.as_deref()), ssh_port: port },
    )
    .await?;
    notify_updated(&state, &t).await;
    Ok(Json(host_json(&own_host(&state, t.id, host_id).await?, state.config.tz_offset_minutes, &state.oui)))
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
    let req = prepare_scan(&state, &user, &t, eff, json_str(&body, "username").as_deref(), subnets, ports).await?;
    let status = state.lan_scans.get(t.id);
    tokio::spawn(crate::lan::scan::execute(state.clone(), req));
    Ok((StatusCode::ACCEPTED, Json(json!(status))))
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/lan/scan", tag = "LAN", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "The running or latest scan since the server started; null when none", body = super::schemas::LanScanStatus), (status = 404, body = super::schemas::ErrorBody)))]
async fn scan_status(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, _) = visible(&state, user.id, id).await?;
    Ok(Json(json!(state.lan_scans.get(t.id))))
}

#[utoipa::path(get, path = "/api/reverse/lan/topology", tag = "LAN", security(("bearer" = [])), responses((status = 200, description = "Every tunnel the user can see with its status and LAN hosts, for the topology view", body = super::schemas::LanTopology)))]
async fn topology(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let tz = state.config.tz_offset_minutes;
    let tunnels = db::tunnels::visible_to(&state.db, user.id).await?;
    let (mine, _) = db::sharing::permission_context(&state.db, user.id).await?;
    let listen = state.status.listen_ports();
    let latency = state.status.latency().unwrap_or_default();
    let scans_enabled = db::settings::get_solo(&state.db).await?.lan_scan_enabled;
    let last = db::tunnel_endpoints::visible_to(&state.db, user.id).await?;
    let live = state.status.endpoints();
    let mut out = Vec::with_capacity(tunnels.len());
    for t in &tunnels {
        let Some(eff) = permissions::effective(user.id, t.user_id, mine.get(&t.id).map(String::as_str)) else { continue };
        let port = u16::try_from(t.reverse_port).ok();
        let allowed = permissions::allowed_usernames(&state.db, user.id, t).await?;
        let default_username = t.default_username_id.and_then(|d| allowed.iter().find(|u| u.id == d)).map(|u| u.username.clone()).or_else(|| (allowed.len() == 1).then(|| allowed[0].username.clone()));
        let hosts = db::lan::hosts_for_tunnel(&state.db, t.id).await?;
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
            "hosts": hosts.iter().map(|h| host_json(h, tz, &state.oui)).collect::<Vec<_>>(),
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
            label: None,
            username: None,
            ssh_port: 22,
            source: "scan".into(),
            first_seen: None,
            last_seen: None,
            created_at: "2026-10-24 00:00:00.000000".into(),
            updated_at: "2026-10-24 00:00:00.000000".into(),
        };
        let v = host_json(&h, 480, &oui);
        assert_eq!(v["vendor"], "Raspberry Pi Foundation");
        assert_eq!(v["mac_private"], false);
        h.mac = Some("da:a1:19:00:00:01".into());
        let v = host_json(&h, 480, &oui);
        assert!(v["vendor"].is_null());
        assert_eq!(v["mac_private"], true);
    }
}
