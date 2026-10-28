//! 一行指令加入裝置（#14）。網頁（要登入）：`POST /api/reverse/join` 發票、`GET/DELETE /api/reverse/join/{id}`
//! 查進度 / 撤銷。裝置（公開，只靠 token）：`GET /api/join/install.sh`、`POST /api/join/{token}` 註冊、
//! `GET /api/join/{token}/status` 查驗證結果。給裝置的回應是 `KEY=value` 純文字（腳本不需要 jq）。
//! One-command device join: the web mints a ticket; the device registers with it and polls the result.
//! Device-facing answers are `KEY=value` text so the POSIX script needs no JSON parser.

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use super::reverse_keys::KeyProblem;
use super::{notify, AppJson};
use crate::auth::AuthUser;
use crate::db::{self, tunnels::NewTunnel};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::join::{self, Phase, Registration, TakeError, Ticket};
use crate::monitor::find_free_port;
use crate::ssh::host_keys;
use crate::state::AppState;
use crate::util::json_str;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(create_ticket))
        .routes(routes!(ticket_status, revoke_ticket))
        .routes(routes!(install_script))
        .routes(routes!(ws_client))
        .routes(routes!(register))
        .routes(routes!(device_status))
}

const INSTALL: &str = include_str!("../../templates/join_install.sh");
/// SSH over WebSocket 的裝置端小程式（純 python3 標準函式庫）。/ The device-side WebSocket carrier (python3 stdlib only).
pub const WS_CLIENT: &str = include_str!("../../templates/telepy_ws.py");

/// `/ws/gateway/` 的完整位址（`ws://` / `wss://`，依網站的 scheme）。/ The gateway WebSocket URL for this deployment.
pub fn ws_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    let ws = base.strip_prefix("https://").map(|h| format!("wss://{h}")).or_else(|| base.strip_prefix("http://").map(|h| format!("ws://{h}"))).unwrap_or_else(|| base.to_string());
    format!("{ws}/ws/gateway/")
}

/// 裝置怎麼連：`ssh`（預設）或 `websocket`。/ Validate the transport choice.
pub fn parse_transport(v: Option<String>) -> Result<&'static str, ApiError> {
    match v.as_deref().map(str::trim) {
        None | Some("") | Some("ssh") => Ok("ssh"),
        Some("websocket") => Ok("websocket"),
        Some(_) => Err(ApiError::field("transport", "Use \"ssh\" or \"websocket\".")),
    }
}
/// 伺服器透過隧道登入一次的時限。/ Time limit for the test login through the new tunnel.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(25);

fn text(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

fn device_error(status: StatusCode, msg: &str) -> Response {
    text(status, join::kv_lines(&[("ERROR", msg.to_string())]))
}

fn join_error(status: StatusCode, code: &str, msg: &str) -> ApiError {
    ApiError::new(status, json!({ "error": msg, "code": code }))
}

/// 網頁看到的 Telepy 位址（PUBLIC_URL，否則 X-Forwarded-*）。/ The public base URL.
fn base_url(state: &AppState, headers: &HeaderMap) -> String {
    crate::oauth::issuer(state.config.public_url.as_deref(), headers)
}

pub fn install_command(base: &str, token: &str, sudo: bool, via_web: bool) -> String {
    format!("curl -fsSL '{base}/api/join/install.sh' | {}sh -s -- --token {token}{}", if sudo { "sudo " } else { "" }, if via_web { " --via-web" } else { "" })
}

fn ticket_json(t: &Ticket) -> Value {
    json!(t)
}

fn notify_owner(state: &AppState, t: &Ticket) {
    let details = match t.phase {
        Phase::Registered => format!("{} registered; waiting for its tunnel", t.tunnel_name.as_deref().unwrap_or("Device")),
        Phase::Connected => format!("{} connected; checking the login", t.tunnel_name.as_deref().unwrap_or("Device")),
        Phase::Verified => format!("{} joined and Telepy can log in", t.tunnel_name.as_deref().unwrap_or("Device")),
        Phase::Failed => t.detail.clone().unwrap_or_else(|| "Join failed".into()),
        Phase::Waiting => "Waiting for the device".into(),
    };
    state.hub.notify_user(t.user_id, &json!({ "action": "JOIN-UPDATED", "join_id": t.id, "phase": t.phase, "tunnel_id": t.tunnel_id, "details": details }));
}

/// 隧道名稱（要求的）：與建立隧道相同的規則（[`crate::tunnel_name`]）。/ The same rule as creating a tunnel.
fn valid_name(name: &str) -> bool {
    crate::tunnel_name::ssh_safe(name)
}

#[utoipa::path(post, path = "/api/reverse/join", tag = "Device join", security(("bearer" = [])), request_body = super::schemas::JoinRequest, responses((status = 201, body = super::schemas::JoinTicketCreated), (status = 400, body = Object), (status = 429, description = "Too many open join commands", body = super::schemas::JoinError)))]
async fn create_ticket(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = json_str(&body, "name").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(n) = &name {
        if !valid_name(n) {
            return Err(ApiError::field("name", crate::tunnel_name::problem(n).map_or("", |p| p.message())));
        }
        if db::tunnels::name_taken_ignoring_case(&state.db, n, None).await? {
            return Err(ApiError::field("name", "A tunnel with this name already exists."));
        }
    }
    let mine = super::device_keys::key_list_choice(&body)?;
    let transport = parse_transport(json_str(&body, "transport"))?;
    let (token, t) = state
        .join
        .mint(user.id, name, mine, transport)
        .ok_or_else(|| join_error(StatusCode::TOO_MANY_REQUESTS, "too_many_join_tokens", "Too many open join commands; use or cancel one first."))?;
    let base = base_url(&state, &headers);
    let mut v = ticket_json(&t);
    let o = v.as_object_mut().unwrap();
    o.insert("token".into(), json!(token));
    o.insert("install_url".into(), json!(format!("{base}/api/join/install.sh")));
    let via_web = t.transport == "websocket";
    o.insert("command".into(), json!(install_command(&base, &token, true, via_web)));
    o.insert("command_no_sudo".into(), json!(install_command(&base, &token, false, via_web)));
    Ok((StatusCode::CREATED, Json(v)))
}

#[utoipa::path(get, path = "/api/reverse/join/{id}", tag = "Device join", security(("bearer" = [])), params(("id" = String, Path, description = "Join ticket id (not the token)")), responses((status = 200, body = super::schemas::JoinTicket), (status = 404, body = super::schemas::ErrorBody)))]
async fn ticket_status(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let t = state.join.by_id(user.id, &id).ok_or_else(ApiError::drf_not_found)?;
    Ok(Json(ticket_json(&advance(&state, t).await)))
}

#[utoipa::path(delete, path = "/api/reverse/join/{id}", tag = "Device join", security(("bearer" = [])), params(("id" = String, Path, description = "Join ticket id")), responses((status = 204, description = "Cancelled (only unused commands can be cancelled)"), (status = 404, body = super::schemas::ErrorBody)))]
async fn revoke_ticket(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if state.join.revoke(user.id, &id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::drf_not_found())
    }
}

#[utoipa::path(get, path = "/api/join/telepy-ws.py", tag = "Device join", responses((status = 200, description = "The python3 program that carries ssh inside a WebSocket to /ws/gateway/ (ProxyCommand)", content_type = "text/plain", body = String)))]
async fn ws_client() -> Response {
    text(StatusCode::OK, WS_CLIENT.to_string())
}

#[utoipa::path(get, path = "/api/join/install.sh", tag = "Device join", responses((status = 200, description = "The POSIX install script (run with --token)", content_type = "text/plain", body = String)))]
async fn install_script(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let mut m = HashMap::new();
    m.insert("server_url", base_url(&state, &headers));
    text(StatusCode::OK, crate::scripts::safe_substitute(INSTALL, &m))
}

#[utoipa::path(post, path = "/api/join/{token}", tag = "Device join", params(("token" = String, Path, description = "Join token")), request_body = super::schemas::JoinRegistration, responses((status = 201, description = "KEY=value lines: TUNNEL_ID, TUNNEL_NAME, REVERSE_PORT, GATEWAY_HOST, GATEWAY_PORT, GATEWAY_USER, SERVICE_KEY, HOST_KEY (one per gateway host key), WEB_URL", content_type = "text/plain", body = String), (status = 400, description = "ERROR=… (invalid input)", content_type = "text/plain", body = String), (status = 404, description = "ERROR=… (unknown or expired token)", content_type = "text/plain", body = String), (status = 409, description = "ERROR=… (token used, or key owned by someone else)", content_type = "text/plain", body = String)))]
async fn register(State(state): State<AppState>, headers: HeaderMap, Path(token): Path<String>, AppJson(body): AppJson<Value>) -> Response {
    let t = match state.join.claim(&token) {
        Ok(t) => t,
        Err(TakeError::Invalid) => return device_error(StatusCode::NOT_FOUND, "This join command is invalid or has expired. Create a new one in Telepy."),
        Err(TakeError::Used) => return device_error(StatusCode::CONFLICT, "This join command was already used. Create a new one in Telepy."),
    };
    match do_register(&state, &headers, &t, &body).await {
        Ok(resp) => resp,
        Err((status, msg)) => {
            state.join.release(&t.token_hash);
            device_error(status, &msg)
        }
    }
}

type DeviceResult<T> = Result<T, (StatusCode, String)>;

fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    tracing::error!(error = %e, "join: registration failed");
    (StatusCode::INTERNAL_SERVER_ERROR, "Telepy could not register this machine; see the server logs.".into())
}

async fn do_register(state: &AppState, headers: &HeaderMap, t: &Ticket, body: &Value) -> DeviceResult<Response> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, m.to_string());
    let user = db::users::by_id(&state.db, t.user_id).await.map_err(internal)?.filter(|u| u.is_active).ok_or((StatusCode::FORBIDDEN, "The Telepy account that created this command is disabled.".to_string()))?;

    let key_line = json_str(body, "public_key").unwrap_or_default();
    let mut parts = key_line.split_whitespace();
    let (Some(kind), Some(b64)) = (parts.next(), parts.next()) else { return Err(bad("public_key is missing")) };
    let key = match parts.collect::<Vec<_>>().join(" ") {
        c if c.is_empty() => format!("{kind} {b64}"),
        c => format!("{kind} {b64} {c}"),
    };
    if !super::serialize::is_valid_ssh_public_key(&key) {
        return Err(bad("public_key is not a valid SSH public key"));
    }
    // 腳本自己產的金鑰不會撞到，但 gateway 先認隧道金鑰：把某人的個人金鑰登記成裝置金鑰會讓那個人再也登不上 gateway。
    // The script's own key never collides, but a personal or service key registered here would shadow its real use.
    match super::reverse_keys::device_key_problem(state, &key, user.id).await.map_err(|e| internal(e.body))? {
        Some(p @ (KeyProblem::Personal | KeyProblem::Service | KeyProblem::Invalid(_))) => return Err(bad(p.message())),
        _ => {}
    }
    // 這台機器的 SSH host key（腳本用 ssh-keyscan 讀的）：辨認機器用。/ The machine's host keys (ssh-keyscan on the device).
    let host_keys: Vec<host_keys::KeyInfo> = body
        .get("host_keys")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).filter_map(host_keys::parse_line).take(8).collect())
        .unwrap_or_default();
    let username = json_str(body, "username").unwrap_or_default();
    if !crate::ssh::process::valid_login(&username) {
        return Err(bad("username must use letters, digits, '.', '_' or '-'"));
    }
    let ssh_port = crate::util::json_i64(body, "ssh_port").filter(|p| (1..=65535).contains(p)).unwrap_or(22);
    let hostname = join::clean_hostname(&json_str(body, "hostname").unwrap_or_default());
    let os: String = json_str(body, "os").unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' ')).take(64).collect();
    let requested = json_str(body, "name").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(n) = &requested {
        if !valid_name(n) {
            return Err(bad("--name must start with a letter or digit and use letters, digits, '.', '_' or '-' (up to 63)"));
        }
    }

    // 同一把裝置金鑰再跑一次 = 重新加入同一條隧道（只限同一個使用者）。/ Same key again = rejoin the same tunnel.
    let prefix = db::tunnels::like_prefix(&format!("{kind} {b64}"));
    let existing = db::tunnels::by_key_prefix(&state.db, &prefix).await.map_err(internal)?;
    if existing.as_ref().is_some_and(|e| e.user_id != user.id) {
        return Err((StatusCode::CONFLICT, "This machine's tunnel key is already registered by another Telepy user.".into()));
    }
    // 這台機器已經是誰的（host key 被哪些隧道釘選）？別的帳號的 → 拒絕並告訴那位擁有者；自己的 → 提醒。
    // Whose machine is this already (who pins its host key)? Another account's → refuse and tell its owner; mine → a note.
    // 沒指定名稱就用主機名稱，整理成合規的名稱（例如 `Nat's MacBook` → `Nat-s-MacBook`）。/ Else the hostname, made valid.
    let proposed_name = requested.clone().or_else(|| t.name.clone()).unwrap_or_else(|| crate::tunnel_name::suggest(&hostname));
    let mut same_machine_as = None;
    for hk in &host_keys {
        let others = db::host_keys::claimants(&state.db, &hk.line, existing.as_ref().map_or(0, |e| e.id)).await.map_err(internal)?;
        if let Some(foreign) = host_keys::foreign_claimant(&others, user.id) {
            host_keys::report_claim_attempt(state, foreign, &user.username, &proposed_name, hk).await;
            return Err((StatusCode::CONFLICT, format!("This machine is already managed by another Telepy account: {}.", host_keys::CLAIMED_HINT)));
        }
        if same_machine_as.is_none() {
            same_machine_as = others.first().map(|c| join::SameMachine { id: c.tunnel_id, name: c.host_friendly_name.clone() });
        }
    }
    let (tunnel, is_new) = match existing {
        Some(existing) => (existing, false),
        None => {
            let base = join::tunnel_name_from(&proposed_name);
            let description = if hostname.is_empty() { format!("Joined with one command ({os})") } else { format!("Joined from {hostname} ({os})") };
            (create_tunnel(state, user.id, &base, &key, &description).await?, true)
        }
    };
    // 釘住腳本送來的 host key（第一次連線就不用「看到什麼信什麼」）。重新加入時只在還沒釘、或至少一把對得上時才加：
    // 全都不同就留給連線時的比對去拒絕（金鑰外流 + 冒充的機器也會重跑腳本）。
    // Pin the host keys the script sent. On a rejoin only when nothing is pinned yet or one of them matches: an impostor
    // with a stolen tunnel key would run the script too, so a complete change is left to the mismatch path.
    let pinned = db::host_keys::pinned_lines(&state.db, tunnel.id).await.map_err(internal)?;
    if !host_keys.is_empty() && (pinned.is_empty() || host_keys.iter().any(|k| pinned.contains(&k.line))) {
        let mut added = Vec::new();
        for hk in &host_keys {
            if db::host_keys::pin(&state.db, tunnel.id, &hk.key_type, &hk.fingerprint, &hk.line, "join").await.map_err(internal)? {
                added.push(format!("{} {}", hk.key_type, hk.fingerprint));
            }
        }
        state.host_keys.invalidate(tunnel.id);
        if !added.is_empty() {
            let same = host_keys::same_machine_note(&db::host_keys::same_machine(&state.db, tunnel.id).await.map_err(internal)?);
            state
                .gateway
                .event("host_key_pinned", None, u16::try_from(tunnel.reverse_port).ok(), Some(tunnel.id), format!("Pinned the device host key {} of '{}' (sent by the install script){same}", added.join(", "), tunnel.host_friendly_name))
                .await;
        }
    }
    if t.key_list_mine && is_new {
        super::device_keys::seed_key_list(state, tunnel.id, user.id).await.map_err(|_| internal("could not seed the device key list"))?;
    }

    // Telepy 登入裝置用的帳號，第一個就設成預設。/ The login account; the first one becomes the default.
    let existing = db::tunnels::usernames_for_tunnel(&state.db, tunnel.id).await.map_err(internal)?;
    let uid = match existing.iter().find(|u| u.username == username) {
        Some(u) => u.id,
        None => {
            let u = db::tunnels::username_create(&state.db, user.id, tunnel.id, &username).await.map_err(internal)?;
            notify::tunnel_users(state, &tunnel, "TUNNEL-USERNAMES-UPDATED", &format!("Usernames updated for tunnel '{}'", tunnel.host_friendly_name)).await.map_err(internal)?;
            u.id
        }
    };
    if tunnel.default_username_id.is_none() {
        db::tunnels::set_default_username(&state.db, tunnel.id, Some(uid)).await.map_err(internal)?;
    }
    state.device_keys.kick(tunnel.id);
    notify::tunnel_updated(state, &tunnel).await.map_err(internal)?;

    // 裝置只授權這條隧道自己的服務金鑰。/ The device authorizes this tunnel's own service key only.
    let service_key = crate::ssh::tunnel_keys::ensure(state, tunnel.id).await.map_err(internal)?;
    let gateway_host = crate::api::scripts::server_domain(headers, state);
    if gateway_host.is_empty() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "Telepy does not know its public host name; set SERVER_DOMAIN.".into()));
    }
    let gateway_port = Some(state.config.reverse_server_ssh_port.trim()).filter(|p| !p.is_empty()).unwrap_or("22").to_string();

    let reg = Registration { tunnel_id: tunnel.id, tunnel_name: tunnel.host_friendly_name.clone(), reverse_port: tunnel.reverse_port, username: username.clone(), ssh_port, hostname: hostname.clone(), os: os.clone(), same_machine_as: same_machine_as.clone() };
    if let Some(updated) = state.join.registered(&t.token_hash, reg) {
        notify_owner(state, &updated);
    }
    state
        .gateway
        .event(
            "join",
            None,
            u16::try_from(tunnel.reverse_port).ok(),
            Some(tunnel.id),
            format!("Device {} joined as '{}' with a one-command install by {} (login {username})", if hostname.is_empty() { "?" } else { &hostname }, tunnel.host_friendly_name, user.username),
        )
        .await;

    let mut lines = vec![
        ("TUNNEL_ID", tunnel.id.to_string()),
        ("TUNNEL_NAME", tunnel.host_friendly_name.clone()),
        ("REVERSE_PORT", tunnel.reverse_port.to_string()),
        ("GATEWAY_HOST", gateway_host),
        ("GATEWAY_PORT", gateway_port),
        ("GATEWAY_USER", state.config.gateway_user.clone()),
        ("SERVICE_KEY", service_key.trim().to_string()),
    ];
    for k in state.gateway.host_public_keys() {
        lines.push(("HOST_KEY", k));
    }
    if let Some(same) = &same_machine_as {
        lines.push(("SAME_MACHINE_AS", same.name.clone()));
        lines.push(("SAME_MACHINE_ID", same.id.to_string()));
    }
    lines.push(("WEB_URL", format!("{}/tunnels", base_url(state, headers))));
    lines.push(("WS_URL", ws_url(&base_url(state, headers))));
    Ok(text(StatusCode::CREATED, join::kv_lines(&lines)))
}

/// 建新隧道：名稱撞到就加 `-2`…，反向 port 撞到（同時建立）就重選。/ Create with a free name and port.
async fn create_tunnel(state: &AppState, user_id: i64, base: &str, key: &str, description: &str) -> DeviceResult<db::tunnels::Tunnel> {
    for _attempt in 0..3 {
        let mut name = None;
        for candidate in join::name_candidates(base) {
            if !db::tunnels::name_taken_ignoring_case(&state.db, &candidate, None).await.map_err(internal)? {
                name = Some(candidate);
                break;
            }
        }
        let name = name.ok_or((StatusCode::CONFLICT, "Every variant of this tunnel name is taken; pass --name.".to_string()))?;
        let used = state.status.used_ports(&state.db).await.map_err(internal)?;
        let port = find_free_port(&used).map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
        match db::tunnels::create(&state.db, NewTunnel { user_id, host_friendly_name: &name, key, reverse_port: port, description: Some(description), default_username_id: None }).await {
            Ok(t) => return Ok(t),
            Err(e) if is_unique_violation(&e) => continue,
            Err(e) => return Err(internal(e)),
        }
    }
    Err((StatusCode::CONFLICT, "Could not reserve a tunnel; run the command again.".into()))
}

/// 推進進度：隧道連上 → 已連線，並在背景試登入一次（每張票同時只跑一個）。
/// Move the ticket forward: tunnel up → connected, then one background test login at a time.
async fn advance(state: &AppState, t: Ticket) -> Ticket {
    let (Some(port), Some(username)) = (t.reverse_port, t.username.clone()) else { return t };
    if !matches!(t.phase, Phase::Registered | Phase::Connected) {
        return t;
    }
    let online = u16::try_from(port).map(|p| state.gateway.has_forward(p)).unwrap_or(false);
    if !online {
        return t;
    }
    let mut current = t.clone();
    if t.phase == Phase::Registered {
        if let Some(u) = state.join.set_phase(&t.token_hash, Phase::Connected, None) {
            notify_owner(state, &u);
            current = u;
        }
    }
    if state.join.begin_verify(&t.token_hash) {
        let state = state.clone();
        let hash = t.token_hash.clone();
        let tunnel_id = t.tunnel_id;
        tokio::spawn(async move {
            let result = tokio::time::timeout(VERIFY_TIMEOUT, crate::ssh::device::connect(&state, &username, port)).await;
            let (phase, detail) = match result {
                Ok(Ok(_conn)) => (Phase::Verified, None),
                Ok(Err(e)) => (Phase::Failed, Some(join::explain_login_error(&format!("{e:#}"), &username))),
                Err(_) => (Phase::Failed, Some(join::explain_login_error("timed out", &username))),
            };
            state.join.end_verify(&hash);
            if let Some(u) = state.join.set_phase(&hash, phase, detail.clone()) {
                let msg = match &detail {
                    None => format!("One-command join of '{}' verified: Telepy logged in as {username}", u.tunnel_name.as_deref().unwrap_or("?")),
                    Some(d) => format!("One-command join of '{}' failed: {d}", u.tunnel_name.as_deref().unwrap_or("?")),
                };
                state.gateway.event("join", None, u16::try_from(port).ok(), tunnel_id, msg).await;
                notify_owner(&state, &u);
            }
        });
    }
    current
}

#[utoipa::path(get, path = "/api/join/{token}/status", tag = "Device join", params(("token" = String, Path, description = "Join token")), responses((status = 200, description = "KEY=value lines: PHASE (waiting | registered | connected | verified | failed), DETAIL, TUNNEL_ID", content_type = "text/plain", body = String), (status = 404, description = "ERROR=…", content_type = "text/plain", body = String)))]
async fn device_status(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    let Some(t) = state.join.by_token(&token) else {
        return device_error(StatusCode::NOT_FOUND, "This join command is invalid or has expired.");
    };
    let t = advance(&state, t).await;
    let phase = serde_json::to_value(t.phase).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    text(
        StatusCode::OK,
        join::kv_lines(&[("PHASE", phase), ("DETAIL", t.detail.clone().unwrap_or_default()), ("TUNNEL_ID", t.tunnel_id.map(|i| i.to_string()).unwrap_or_default())]),
    )
}
