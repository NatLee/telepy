//! MCP server（`POST /mcp`，rmcp 的 stateless Streamable HTTP + JSON 回應）：讓 AI 工具看隧道、開會自己關掉的
//! SSH session、跑指令、讀寫檔案。認證是 OAuth 2.1 access token（`auth::mcp::resolve`）；沒帶或無效 → 401 +
//! `WWW-Authenticate: Bearer resource_metadata=…`，客戶端據此走 OAuth（見 `oauth/mod.rs`）。
//! 權限完全照 web 規則（VIEW + 允許的 username），再加上 grant 的 scope 與隧道限制；每次 tool call 都寫稽核。
//! The MCP endpoint: tools over the user's tunnels, auto-expiring SSH sessions, exec and SFTP, all under the
//! web permission rules plus the OAuth grant's scopes and tunnel restriction; every call is audited.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::ai::{self, AiSession, CloseReason, OpenRequest};
use crate::client_ip::ClientMeta;
use crate::auth::mcp::{self as mcp_auth, McpAuthError, McpPrincipal};
use crate::db;
use crate::oauth;
use crate::permissions;
use crate::state::AppState;

const INSTRUCTIONS: &str = "Telepy manages reverse SSH tunnels to the user's devices. Typical flow: list_tunnels → \
ssh_session_open (pick a tunnel and one of its usernames) → ssh_exec / sftp_list / sftp_read / sftp_write → \
ssh_session_close when you are done. Sessions close themselves after a period of inactivity and after a maximum \
lifetime, when the device goes offline, or when the user revokes this app, so open a new one if a session_id stops \
working. Commands run without a TTY: avoid interactive programs and pagers (use e.g. `--no-pager`, `-y`, `| cat`). \
Output is truncated to max_output_bytes per stream (start and end are kept). The tunnel owner is notified when you \
open a session on a tunnel shared with the user.";

// ---------------------------------------------------------------- HTTP wiring

/// `/mcp` 路由：Bearer 驗證中介層 + rmcp 的 stateless Streamable HTTP service。
/// The /mcp route: bearer check, then rmcp's stateless Streamable HTTP service.
pub fn router(state: AppState) -> Router<AppState> {
    let mut config = StreamableHttpServerConfig::default().disable_allowed_hosts();
    // 2026-07-28 起沒有 transport session；舊版客戶端也能在不帶 Mcp-Session-Id 的模式下運作。
    // No transport sessions (removed in 2026-07-28); older clients work without Mcp-Session-Id as well.
    config.legacy_session_mode = false;
    config.json_response = true;
    // Host 檢查是防本機 server 的 DNS rebinding；這裡每個請求都要 Bearer，而且部署在反向代理後面。
    // Host validation guards local servers against DNS rebinding; every request here needs a bearer token.
    let factory_state = state.clone();
    let service: StreamableHttpService<TelepyMcp, NeverSessionManager> =
        StreamableHttpService::new(move || Ok(TelepyMcp::new(factory_state.clone())), Arc::new(NeverSessionManager::default()), config);
    // route_layer：只套在 /mcp；用 layer 的話 merge 後連 fallback（任何不存在的路徑）都會變成 401。
    // route_layer, not layer: a layer would also wrap the merged fallback and turn every 404 into a 401.
    Router::new().nest_service(oauth::MCP_PATH, service).route_layer(middleware::from_fn_with_state(state, require_token))
}

fn unauthorized(issuer: &str, err: McpAuthError) -> Response {
    let (code, description) = match err {
        McpAuthError::Missing => ("invalid_request", "An OAuth access token is required"),
        McpAuthError::Invalid => ("invalid_token", "The access token is invalid, expired or revoked"),
    };
    let mut resp = (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": code, "error_description": description }))).into_response();
    if let Ok(v) = HeaderValue::from_str(&mcp_auth::www_authenticate(issuer, err)) {
        resp.headers_mut().insert(header::WWW_AUTHENTICATE, v);
    }
    resp
}

async fn require_token(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let issuer = oauth::issuer(state.config.public_url.as_deref(), req.headers());
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, t)| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let Some(token) = token else { return unauthorized(&issuer, McpAuthError::Missing) };
    match mcp_auth::resolve(&state, &token).await {
        Ok(mut p) => {
            let peer = req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|c| c.0.ip());
            p.ip = ClientMeta::from_headers(req.headers(), peer, &state.config).ip;
            req.extensions_mut().insert(p);
            next.run(req).await
        }
        Err(e) => unauthorized(&issuer, e),
    }
}

// ---------------------------------------------------------------- tool parameters

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TunnelArgs {
    /// Tunnel id from list_tunnels
    pub tunnel_id: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LanScanArgs {
    /// Tunnel id from list_tunnels
    pub tunnel_id: i64,
    /// Device account used for the scan; omit for the tunnel's default
    pub username: Option<String>,
    /// Private CIDRs to scan (at most 1024 addresses), e.g. ["192.168.1.0/24"]; omit to scan the device's own networks
    pub subnets: Option<Vec<String>>,
    /// Ports to probe; omit for 22, 80, 443, 445, 3389, 5900, 8080, 8443
    pub ports: Option<Vec<i64>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenArgs {
    /// Tunnel id from list_tunnels
    pub tunnel_id: i64,
    /// Target username on the device; must be one of the tunnel's usernames. Omit to use the tunnel's default.
    pub username: Option<String>,
    /// Close after this many seconds without a command (can only be shorter than the site limit)
    pub idle_timeout_s: Option<u64>,
    /// Close after this many seconds in any case (can only be shorter than the site limit)
    pub max_lifetime_s: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SessionArgs {
    /// session_id returned by ssh_session_open
    pub session_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ExecArgs {
    /// session_id returned by ssh_session_open
    pub session_id: String,
    /// Shell command line to run (no TTY; runs in the user's login shell on the device)
    pub command: String,
    /// Seconds before the command is killed (default 60, max 600)
    pub timeout_s: Option<u64>,
    /// Bytes kept per output stream (default 65536, max 1048576); the start and the end are kept
    pub max_output_bytes: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListArgs {
    /// session_id returned by ssh_session_open
    pub session_id: String,
    /// Directory; `~` (default) is the home directory, `~/x` is relative to it
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadArgs {
    /// session_id returned by ssh_session_open
    pub session_id: String,
    /// File path (`~/x` is relative to the home directory)
    pub path: String,
    /// Byte offset to start reading at (default 0)
    pub offset: Option<u64>,
    /// Maximum bytes to return (default 65536, max 1048576)
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WriteArgs {
    /// session_id returned by ssh_session_open
    pub session_id: String,
    /// File path (`~/x` is relative to the home directory); parent directories must exist
    pub path: String,
    /// File content, as text or base64 depending on `encoding`
    pub content: String,
    /// "utf-8" (default) or "base64"
    pub encoding: Option<String>,
    /// Append instead of replacing the file (default false)
    pub append: Option<bool>,
}

// ---------------------------------------------------------------- server

#[derive(Clone)]
pub struct TelepyMcp {
    state: AppState,
    tool_router: ToolRouter<Self>,
}

fn principal(parts: &axum::http::request::Parts) -> Result<McpPrincipal, ErrorData> {
    parts.extensions.get::<McpPrincipal>().cloned().ok_or_else(|| ErrorData::internal_error("request was not authenticated", None))
}

fn fail(msg: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(msg.into())])
}

fn missing_scope(scope: &str) -> CallToolResult {
    fail(format!("This app was not granted the `{scope}` permission. Ask the user to reconnect it in Telepy and approve `{scope}`."))
}

/// 一次 tool call 的稽核欄位。/ Audit fields of one tool call.
#[derive(Default)]
struct Audit<'a> {
    tunnel_id: Option<i64>,
    session: Option<&'a AiSession>,
    detail: Option<String>,
    exit_code: Option<i64>,
    bytes_out: Option<i64>,
    error: Option<String>,
}

impl TelepyMcp {
    pub fn new(state: AppState) -> Self {
        Self { state, tool_router: Self::tool_router() }
    }

    async fn audit(&self, p: &McpPrincipal, tool: &str, started: Instant, a: Audit<'_>) {
        let tunnel_id = a.tunnel_id.or(a.session.map(|s| s.tunnel_id));
        ai::audit(
            &self.state,
            db::ai_audit::NewEvent {
                user_id: p.user.id,
                grant_id: Some(p.grant_id),
                client_name: &p.client_name,
                tool,
                tunnel_id,
                session_id: a.session.map(|s| s.id.as_str()),
                target_username: a.session.map(|s| s.target_username.as_str()),
                detail: a.detail.as_deref(),
                ok: a.error.is_none(),
                exit_code: a.exit_code,
                duration_ms: Some(started.elapsed().as_millis() as i64),
                bytes_out: a.bytes_out,
                error: a.error.as_deref(),
                ip: p.ip.as_deref(),
            },
        )
        .await;
    }

    /// 只能用「同一個使用者、同一個 app」開的 session。/ Sessions are scoped to the user and the app (grant).
    fn session(&self, p: &McpPrincipal, id: &str) -> Result<Arc<AiSession>, String> {
        match self.state.ai.get(id) {
            Some(s) if s.user_id == p.user.id && s.grant_id == p.grant_id => Ok(s),
            _ => Err(format!("Unknown or expired session_id '{id}'. Sessions close when idle, at their maximum lifetime, or when the device goes offline; open a new one with ssh_session_open.")),
        }
    }

    fn online(&self, reverse_port: i64) -> Option<bool> {
        let listen = self.state.status.listen_ports()?;
        Some(u16::try_from(reverse_port).map(|p| listen.contains(&p)).unwrap_or(false))
    }

    /// online / degraded（forward 在但 sshd 連續沒回應）/ offline；狀態不可用時 None。
    /// online, degraded (forward up, device sshd not answering) or offline; None when status is unavailable.
    fn health(&self, reverse_port: i64) -> Option<&'static str> {
        let listening = self.online(reverse_port)?;
        let failures = u16::try_from(reverse_port).map(|p| self.state.status.probe_failures(p)).unwrap_or(0);
        Some(crate::monitor::health(listening, failures, true).as_str())
    }

    fn rtt(&self, reverse_port: i64) -> Option<f64> {
        let lat = self.state.status.latency()?;
        u16::try_from(reverse_port).ok().and_then(|p| lat.get(&p).copied())
    }

    fn session_json(s: &AiSession, tz: i32) -> Value {
        json!({
            "session_id": s.id,
            "tunnel": { "id": s.tunnel_id, "name": s.tunnel_name },
            "username": s.target_username,
            "created_at": crate::util::db_to_iso(&s.created_at(), tz),
            "last_used_at": crate::util::db_to_iso(&s.last_used_at(), tz),
            "expires_at": crate::util::db_to_iso(&s.expires_at(), tz),
            "idle_timeout_s": s.idle_timeout.as_secs(),
            "max_lifetime_s": s.max_lifetime.as_secs(),
            "commands": s.commands(),
            "busy": s.busy(),
        })
    }
}

#[tool_router]
impl TelepyMcp {
    #[tool(description = "List the tunnels (devices) you can reach: id, name, labels, whether the device is online, its health (degraded = the tunnel is up but the device's SSH server does not answer), latency, your permission, the target usernames you may log in as, and your open sessions.", annotations(title = "List tunnels", read_only_hint = true, open_world_hint = false))]
    async fn list_tunnels(&self, Extension(parts): Extension<axum::http::request::Parts>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("tunnels:read") {
            return Ok(missing_scope("tunnels:read"));
        }
        let db = &self.state.db;
        let result: Result<Vec<Value>, sqlx::Error> = async {
            let tunnels = db::tunnels::visible_to(db, p.user.id).await?;
            let (mine, _) = db::sharing::permission_context(db, p.user.id).await?;
            let sessions = self.state.ai.list();
            let labels = db::tunnel_tags::labels_visible_to(db, p.user.id).await?;
            let mut out = Vec::new();
            for t in tunnels.iter().filter(|t| p.tunnel_allowed(t.id)) {
                let allowed = permissions::allowed_usernames(db, p.user.id, t).await?;
                let default = t.default_username_id.and_then(|d| allowed.iter().find(|u| u.id == d)).map(|u| u.username.clone());
                let eff = permissions::effective(p.user.id, t.user_id, mine.get(&t.id).map(String::as_str));
                out.push(json!({
                    "id": t.id,
                    "name": t.host_friendly_name,
                    "description": t.description,
                    "labels": labels.get(&t.id).cloned().unwrap_or_default(),
                    "online": self.online(t.reverse_port),
                    "health": self.health(t.reverse_port),
                    "rtt_ms": self.rtt(t.reverse_port),
                    "permission": eff.map(|e| e.label()),
                    "usernames": allowed.iter().map(|u| u.username.clone()).collect::<Vec<_>>(),
                    "default_username": default,
                    "open_sessions": sessions.iter().filter(|s| s.tunnel_id == t.id && s.grant_id == p.grant_id).map(|s| s.id.clone()).collect::<Vec<_>>(),
                }));
            }
            Ok(out)
        }
        .await;
        match result {
            Ok(tunnels) => {
                self.audit(&p, "list_tunnels", started, Audit { detail: Some(format!("{} tunnels", tunnels.len())), ..Default::default() }).await;
                Ok(CallToolResult::structured(json!({ "tunnels": tunnels })))
            }
            Err(e) => {
                self.audit(&p, "list_tunnels", started, Audit { error: Some(e.to_string()), ..Default::default() }).await;
                Ok(fail(format!("database error: {e}")))
            }
        }
    }

    #[tool(description = "Status of one tunnel: online, health (online, degraded = the tunnel is up but the device's SSH server does not answer, offline), latency and the latest SSH gateway events (connects, disconnects, forwards, degraded, recovered).", annotations(title = "Tunnel status", read_only_hint = true, open_world_hint = false))]
    async fn tunnel_status(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<TunnelArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("tunnels:read") {
            return Ok(missing_scope("tunnels:read"));
        }
        let db = &self.state.db;
        let tunnel = match db::tunnels::by_id(db, args.tunnel_id).await {
            Ok(Some(t)) if p.tunnel_allowed(t.id) && permissions::effective_for(db, p.user.id, &t).await.ok().flatten().is_some() => t,
            _ => return Ok(fail(format!("Tunnel {} not found. Call list_tunnels to see the tunnels you can use.", args.tunnel_id))),
        };
        let tz = self.state.config.tz_offset_minutes;
        let events: Vec<Value> = db::tunnels::recent_gateway_events(db, tunnel.id, 10)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(at, event, message)| json!({ "at": crate::util::db_to_iso(&at, tz), "event": event, "message": message }))
            .collect();
        self.audit(&p, "tunnel_status", started, Audit { tunnel_id: Some(tunnel.id), ..Default::default() }).await;
        Ok(CallToolResult::structured(json!({
            "id": tunnel.id,
            "name": tunnel.host_friendly_name,
            "online": self.online(tunnel.reverse_port),
            "health": self.health(tunnel.reverse_port),
            "rtt_ms": self.rtt(tunnel.reverse_port),
            "recent_events": events,
        })))
    }

    #[tool(description = "Machines on the local network behind a tunnel's device, from earlier scans and manual entries: address, hostname, open ports, SSH banner, label and the login user to use. Reach them with ssh_exec on the device (e.g. `ssh -o BatchMode=yes user@address …`) or let the user open a web terminal.", annotations(title = "LAN hosts", read_only_hint = true, open_world_hint = false))]
    async fn lan_hosts(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<TunnelArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("tunnels:read") {
            return Ok(missing_scope("tunnels:read"));
        }
        let db = &self.state.db;
        let tunnel = match db::tunnels::by_id(db, args.tunnel_id).await {
            Ok(Some(t)) if p.tunnel_allowed(t.id) && permissions::effective_for(db, p.user.id, &t).await.ok().flatten().is_some() => t,
            _ => return Ok(fail(format!("Tunnel {} not found. Call list_tunnels to see the tunnels you can use.", args.tunnel_id))),
        };
        let tz = self.state.config.tz_offset_minutes;
        let hosts: Vec<Value> = db::lan::hosts_for_tunnel(db, tunnel.id).await.unwrap_or_default().iter().map(|h| crate::api::lan::host_json(h, tz)).collect();
        self.audit(&p, "lan_hosts", started, Audit { tunnel_id: Some(tunnel.id), detail: Some(format!("{} hosts", hosts.len())), ..Default::default() }).await;
        Ok(CallToolResult::structured(json!({ "tunnel": { "id": tunnel.id, "name": tunnel.host_friendly_name }, "hosts": hosts, "last_scan": self.state.lan_scans.get(tunnel.id) })))
    }

    #[tool(description = "Scan the local network behind a tunnel's device for machines and open ports. The device's own sshd makes the connections (nothing is installed on it); only private networks, at most 1024 addresses; it can take about a minute. Requires owner or ADMIN on the tunnel. Results are saved to the tunnel's LAN host list.", annotations(title = "Scan LAN", read_only_hint = false, destructive_hint = false, open_world_hint = true))]
    async fn lan_scan(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<LanScanArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("network:scan") {
            return Ok(missing_scope("network:scan"));
        }
        let db = &self.state.db;
        let not_found = || fail(format!("Tunnel {} not found. Call list_tunnels to see the tunnels you can use.", args.tunnel_id));
        if !p.tunnel_allowed(args.tunnel_id) {
            return Ok(not_found());
        }
        let Some(tunnel) = db::tunnels::by_id(db, args.tunnel_id).await.ok().flatten() else { return Ok(not_found()) };
        let Some(eff) = permissions::effective_for(db, p.user.id, &tunnel).await.ok().flatten() else { return Ok(not_found()) };
        let req = match crate::api::lan::prepare_scan(&self.state, &p.user, &tunnel, eff, args.username.as_deref(), args.subnets, args.ports).await {
            Ok(r) => r,
            Err(e) => {
                let msg = e.body.get("error").or(e.body.get("detail")).and_then(Value::as_str).unwrap_or("The scan could not start.").to_string();
                self.audit(&p, "lan_scan", started, Audit { tunnel_id: Some(tunnel.id), error: Some(msg.clone()), ..Default::default() }).await;
                return Ok(fail(msg));
            }
        };
        let summary = crate::lan::scan::execute(self.state.clone(), req).await;
        let tz = self.state.config.tz_offset_minutes;
        let hosts: Vec<Value> = db::lan::hosts_for_tunnel(db, tunnel.id).await.unwrap_or_default().iter().map(|h| crate::api::lan::host_json(h, tz)).collect();
        let detail = format!("{} — {} host(s)", summary.status.networks.join(", "), summary.status.hosts_found);
        self.audit(&p, "lan_scan", started, Audit { tunnel_id: Some(tunnel.id), detail: Some(detail), error: summary.status.error.clone(), ..Default::default() }).await;
        if let Some(e) = &summary.status.error {
            return Ok(fail(format!("The scan failed: {e}")));
        }
        Ok(CallToolResult::structured(json!({ "scan": summary.status, "new_hosts": summary.inserted, "hosts": hosts })))
    }

    #[tool(description = "Open an SSH session to a tunnel's device as one of its usernames. Returns a session_id for ssh_exec and sftp_*. The session closes itself when idle or at its maximum lifetime; close it with ssh_session_close when you are done.", annotations(title = "Open SSH session", read_only_hint = false, destructive_hint = false, open_world_hint = false))]
    async fn ssh_session_open(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<OpenArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("ssh:exec") && !p.has_scope("ssh:files") {
            return Ok(fail("This app was granted neither `ssh:exec` nor `ssh:files`. Ask the user to reconnect it in Telepy and approve one of them."));
        }
        let tunnel_id = args.tunnel_id;
        let detail = Some(format!("username: {}", args.username.as_deref().unwrap_or("(default)")));
        let req = OpenRequest { tunnel_id, username: args.username, idle_timeout_s: args.idle_timeout_s, max_lifetime_s: args.max_lifetime_s };
        match ai::open(&self.state, &p, req).await {
            Ok(s) => {
                self.audit(&p, "ssh_session_open", started, Audit { session: Some(&s), detail, ..Default::default() }).await;
                let mut body = Self::session_json(&s, self.state.config.tz_offset_minutes);
                body["hint"] = json!("Run commands with ssh_exec and close the session with ssh_session_close when you are done.");
                Ok(CallToolResult::structured(body))
            }
            Err(e) => {
                self.audit(&p, "ssh_session_open", started, Audit { tunnel_id: Some(tunnel_id), detail, error: Some(e.clone()), ..Default::default() }).await;
                Ok(fail(e))
            }
        }
    }

    #[tool(description = "Run a shell command in an open session (no TTY). Returns exit_code, stdout, stderr and whether the output was truncated or the command timed out (it is killed after timeout_s).", annotations(title = "Run command", read_only_hint = false, destructive_hint = true, open_world_hint = true))]
    async fn ssh_exec(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ExecArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("ssh:exec") {
            return Ok(missing_scope("ssh:exec"));
        }
        let s = match self.session(&p, &args.session_id) {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };
        if args.command.trim().is_empty() {
            return Ok(fail("command is empty"));
        }
        let timeout = Duration::from_secs(args.timeout_s.unwrap_or(ai::DEFAULT_COMMAND_TIMEOUT.as_secs()).max(1)).min(ai::MAX_COMMAND_TIMEOUT);
        let max_output = args.max_output_bytes.unwrap_or(ai::DEFAULT_MAX_OUTPUT).clamp(1024, ai::MAX_OUTPUT);
        match ai::exec(&s, &args.command, timeout, max_output).await {
            Ok(r) => {
                let bytes = (r.stdout.bytes + r.stderr.bytes) as i64;
                let error = r.timed_out.then(|| format!("timed out after {} s", timeout.as_secs()));
                self.audit(&p, "ssh_exec", started, Audit { session: Some(&s), detail: Some(args.command.clone()), exit_code: r.exit_code.map(i64::from), bytes_out: Some(bytes), error, ..Default::default() }).await;
                Ok(CallToolResult::structured(json!({
                    "exit_code": r.exit_code,
                    "signal": r.signal,
                    "timed_out": r.timed_out,
                    "duration_ms": r.duration.as_millis() as u64,
                    "stdout": r.stdout.text,
                    "stderr": r.stderr.text,
                    "stdout_bytes": r.stdout.bytes,
                    "stderr_bytes": r.stderr.bytes,
                    "truncated": r.stdout.truncated || r.stderr.truncated,
                })))
            }
            Err(e) => {
                let msg = format!("{e:#}");
                self.audit(&p, "ssh_exec", started, Audit { session: Some(&s), detail: Some(args.command.clone()), error: Some(msg.clone()), ..Default::default() }).await;
                Ok(fail(format!("Command failed to run: {msg}")))
            }
        }
    }

    #[tool(description = "Close an SSH session you opened.", annotations(title = "Close SSH session", read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn ssh_session_close(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<SessionArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let s = match self.session(&p, &args.session_id) {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };
        // 稽核由 ai::close 寫（detail = 原因）。/ ai::close writes the audit row.
        ai::close(&self.state, &s.id, CloseReason::ClosedByAgent).await;
        Ok(CallToolResult::structured(json!({ "session_id": s.id, "closed": true })))
    }

    #[tool(description = "List the SSH sessions this app has open, with their remaining lifetime.", annotations(title = "List SSH sessions", read_only_hint = true, open_world_hint = false))]
    async fn ssh_session_list(&self, Extension(parts): Extension<axum::http::request::Parts>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let tz = self.state.config.tz_offset_minutes;
        let sessions: Vec<Value> = self.state.ai.list().iter().filter(|s| s.user_id == p.user.id && s.grant_id == p.grant_id).map(|s| Self::session_json(s, tz)).collect();
        Ok(CallToolResult::structured(json!({ "sessions": sessions })))
    }

    #[tool(description = "List a directory on the device over SFTP (name, type, size, permissions, modification time).", annotations(title = "List directory", read_only_hint = true, open_world_hint = true))]
    async fn sftp_list(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ListArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("ssh:files") {
            return Ok(missing_scope("ssh:files"));
        }
        let s = match self.session(&p, &args.session_id) {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };
        let path = args.path.unwrap_or_else(|| "~".to_string());
        match ai::sftp_list(&s, &path).await {
            Ok(l) => {
                self.audit(&p, "sftp_list", started, Audit { session: Some(&s), detail: Some(l.path.clone()), ..Default::default() }).await;
                let entries: Vec<Value> = l
                    .entries
                    .iter()
                    .map(|e| {
                        json!({
                            "name": e.name,
                            "type": if e.is_dir { "directory" } else if e.is_symlink { "symlink" } else { "file" },
                            "size": e.size,
                            "mode": crate::sftp::mode_string(e.mode, e.is_dir, e.is_symlink),
                            "mtime": e.mtime,
                        })
                    })
                    .collect();
                Ok(CallToolResult::structured(json!({ "path": l.path, "entries": entries, "truncated": l.truncated })))
            }
            Err(e) => {
                let msg = format!("{e:#}");
                self.audit(&p, "sftp_list", started, Audit { session: Some(&s), detail: Some(path), error: Some(msg.clone()), ..Default::default() }).await;
                Ok(fail(msg))
            }
        }
    }

    #[tool(description = "Read a file on the device over SFTP. Text is returned as UTF-8, anything else as base64 (see `encoding`). Use offset/max_bytes to page through large files.", annotations(title = "Read file", read_only_hint = true, open_world_hint = true))]
    async fn sftp_read(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ReadArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("ssh:files") {
            return Ok(missing_scope("ssh:files"));
        }
        let s = match self.session(&p, &args.session_id) {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };
        let max = args.max_bytes.unwrap_or(ai::DEFAULT_MAX_OUTPUT).clamp(1, ai::MAX_READ);
        match ai::sftp_read(&s, &args.path, args.offset.unwrap_or(0), max).await {
            Ok(r) => {
                self.audit(&p, "sftp_read", started, Audit { session: Some(&s), detail: Some(r.path.clone()), bytes_out: Some(r.data.len() as i64), ..Default::default() }).await;
                let n = r.data.len();
                let (encoding, content) = match String::from_utf8(r.data) {
                    Ok(text) => ("utf-8", text),
                    Err(e) => ("base64", STANDARD.encode(e.into_bytes())),
                };
                Ok(CallToolResult::structured(json!({
                    "path": r.path,
                    "size": r.size,
                    "offset": r.offset,
                    "bytes": n,
                    "eof": r.eof,
                    "encoding": encoding,
                    "content": content,
                })))
            }
            Err(e) => {
                let msg = format!("{e:#}");
                self.audit(&p, "sftp_read", started, Audit { session: Some(&s), detail: Some(args.path.clone()), error: Some(msg.clone()), ..Default::default() }).await;
                Ok(fail(msg))
            }
        }
    }

    #[tool(description = "Write (or append to) a file on the device over SFTP. The parent directory must exist.", annotations(title = "Write file", read_only_hint = false, destructive_hint = true, open_world_hint = true))]
    async fn sftp_write(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<WriteArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if !p.has_scope("ssh:files") {
            return Ok(missing_scope("ssh:files"));
        }
        let s = match self.session(&p, &args.session_id) {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };
        let data = match args.encoding.as_deref().unwrap_or("utf-8").to_ascii_lowercase().as_str() {
            "utf-8" | "utf8" | "text" => args.content.into_bytes(),
            "base64" => match STANDARD.decode(args.content.trim()) {
                Ok(d) => d,
                Err(e) => return Ok(fail(format!("content is not valid base64: {e}"))),
            },
            other => return Ok(fail(format!("unsupported encoding '{other}' (use utf-8 or base64)"))),
        };
        let append = args.append.unwrap_or(false);
        match ai::sftp_write(&s, &args.path, &data, append).await {
            Ok((path, n)) => {
                let detail = format!("{path} ({}{n} bytes)", if append { "append, " } else { "" });
                self.audit(&p, "sftp_write", started, Audit { session: Some(&s), detail: Some(detail), bytes_out: Some(n as i64), ..Default::default() }).await;
                Ok(CallToolResult::structured(json!({ "path": path, "bytes_written": n, "appended": append })))
            }
            Err(e) => {
                let msg = format!("{e:#}");
                self.audit(&p, "sftp_write", started, Audit { session: Some(&s), detail: Some(args.path.clone()), error: Some(msg.clone()), ..Default::default() }).await;
                Ok(fail(msg))
            }
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for TelepyMcp {
    fn get_info(&self) -> ServerConfig {
        let mut info = Implementation::new("telepy", env!("CARGO_PKG_VERSION"));
        info.title = Some("Telepy".to_string());
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(info).with_instructions(INSTRUCTIONS)
    }
}
