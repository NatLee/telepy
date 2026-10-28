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

use crate::ai::{self, shell, AiBrowser, AiSession, AiShell, CloseReason, OpenRequest};
use crate::client_ip::ClientMeta;
use crate::command_rules::{self, Action, AgentApproval, Requester, Source};
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
open a session on a tunnel shared with the user. Command rules may block a command or hold it until the tunnel owner \
approves it in Telepy: don't try to get around a rule; for a held command, tell the user and run exactly the same \
command again once they approve it. For interactive programs (TUIs, prompts, REPLs) open a shell on a session with \
shell_open, type with shell_send (control characters such as \\u0003 for Ctrl+C are allowed; press_enter adds Enter) and \
read with shell_read, which returns the new output and the current screen as text. With the browser:use permission, \
browser_open starts a real Chromium that browses through the device (so it reaches the device's LAN and localhost); \
drive it with browser_navigate / browser_read / browser_click / browser_type / browser_screenshot and close it with \
browser_close.";

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
            let token_id = p.credential.token_id();
            if let Some(id) = token_id {
                state.api_tokens.note_use(&state.db, id, p.ip.as_deref()).await;
            }
            let Some(token_id) = token_id else {
                req.extensions_mut().insert(p);
                return next.run(req).await;
            };
            // 個人 API token 的 tool call 進呼叫紀錄（OAuth app 的已經在 AI 稽核裡）：讀 body 認出 tools/call，回應出來後看 isError。
            // A personal token's tool calls go into the call log (OAuth apps' are in the AI audit already).
            let (parts, body) = req.into_parts();
            let Ok(bytes) = axum::body::to_bytes(body, MAX_LOGGED_BODY).await else {
                return (StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response();
            };
            let call = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| tool_call(&v));
            let mut req = Request::from_parts(parts, axum::body::Body::from(bytes));
            let (user_id, client_name, ip) = (p.user.id, p.client_name.clone(), p.ip.clone());
            let tunnel_id = call.as_ref().and_then(|(_, t)| *t).filter(|t| p.tunnel_allowed(*t));
            req.extensions_mut().insert(p);
            let started = Instant::now();
            let resp = next.run(req).await;
            let Some((tool, _)) = call else { return resp };
            let (parts, body) = resp.into_parts();
            let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default();
            let outcome = serde_json::from_slice::<Value>(&bytes).ok().map(|v| tool_error(&v)).unwrap_or(None);
            let status = if !parts.status.is_success() { i64::from(parts.status.as_u16()) } else if outcome.is_some() { 400 } else { 200 };
            state.api_calls.record(crate::api_calls::NewCall {
                at: crate::util::now_db(),
                user_id,
                token_id: Some(token_id),
                grant_id: None,
                client_name,
                kind: "mcp",
                method: "MCP".into(),
                route: tool,
                tunnel_id,
                status,
                duration_ms: started.elapsed().as_millis() as i64,
                ip,
                error: outcome,
            });
            Response::from_parts(parts, axum::body::Body::from(bytes))
        }
        Err(e) => unauthorized(&issuer, e),
    }
}

/// 為了記 tool call 而讀進記憶體的請求 body 上限（sftp_write 的內容也在 body 裡）。/ Request bodies read to log a tool call.
const MAX_LOGGED_BODY: usize = 64 * 1024 * 1024;

/// JSON-RPC `tools/call` → (tool 名稱, 參數裡的 tunnel_id)。其他方法（initialize、tools/list…）不記。
/// A JSON-RPC `tools/call` → (tool name, its tunnel_id argument). Other methods are not logged.
pub fn tool_call(v: &Value) -> Option<(String, Option<i64>)> {
    if v.get("method").and_then(Value::as_str) != Some("tools/call") {
        return None;
    }
    let params = v.get("params")?;
    let name = params.get("name").and_then(Value::as_str)?.chars().take(100).collect();
    Some((name, params.get("arguments").and_then(|a| a.get("tunnel_id")).and_then(Value::as_i64)))
}

/// 回應是錯誤嗎：JSON-RPC error 或 tool 的 `isError`；回錯誤開頭（≤ 200 字）。/ The error of a response, if any.
pub fn tool_error(v: &Value) -> Option<String> {
    let clip = |s: &str| s.chars().take(200).collect::<String>();
    if let Some(e) = v.get("error") {
        return Some(clip(e.get("message").and_then(Value::as_str).unwrap_or("JSON-RPC error")));
    }
    let r = v.get("result")?;
    if r.get("isError").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    Some(clip(r.pointer("/content/0/text").and_then(Value::as_str).unwrap_or("tool error")))
}

// ---------------------------------------------------------------- tool parameters


/// 敏感隧道（要人確認身分）上 agent 不能開 session。/ Agents can't open sessions on step-up tunnels.
pub const STEP_UP_REFUSAL: &str = "This tunnel asks people to confirm it's them (step-up) before every session, which an AI agent can't do. Ask the user to run this in the Telepy web app, or to turn the setting off for this tunnel.";
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

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShellOpenArgs {
    /// session_id returned by ssh_session_open
    pub session_id: String,
    /// Terminal width in columns (default 120, 20–500)
    pub cols: Option<u32>,
    /// Terminal height in rows (default 40, 5–200)
    pub rows: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShellSendArgs {
    /// shell_id returned by shell_open
    pub shell_id: String,
    /// Keystrokes to send, as text; control characters are allowed (e.g. "\u0003" = Ctrl+C, "\u001b" = Esc, "\r" = Enter)
    pub input: String,
    /// Press Enter after the input (default false)
    pub press_enter: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShellReadArgs {
    /// shell_id returned by shell_open
    pub shell_id: String,
    /// Wait up to this many milliseconds for new output when there is none yet (default 1500, max 10000)
    pub timeout_ms: Option<u64>,
    /// Bytes of output returned at most (default 65536, max 1048576); `more` tells whether more is waiting
    pub max_bytes: Option<usize>,
    /// Include the current screen as text (default true)
    pub screen: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShellResizeArgs {
    /// shell_id returned by shell_open
    pub shell_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShellArgs {
    /// shell_id returned by shell_open
    pub shell_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserOpenArgs {
    /// Tunnel id from list_tunnels; the browser reaches the web (and the device's LAN / localhost) through this device
    pub tunnel_id: i64,
    /// Device account used for the connection; omit for the tunnel's default
    pub username: Option<String>,
    /// Page to open first (http or https)
    pub url: Option<String>,
    /// Close after this many seconds without an action (can only be shorter than the site limit)
    pub idle_timeout_s: Option<u64>,
    /// Close after this many seconds in any case (can only be shorter than the site limit)
    pub max_lifetime_s: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserArgs {
    /// browser_id returned by browser_open
    pub browser_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserNavigateArgs {
    /// browser_id returned by browser_open
    pub browser_id: String,
    /// http or https URL (https:// is added when no scheme is given)
    pub url: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserReadArgs {
    /// browser_id returned by browser_open
    pub browser_id: String,
    /// CSS selector to read only part of the page; omit for the whole page
    pub selector: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserClickArgs {
    /// browser_id returned by browser_open
    pub browser_id: String,
    /// CSS selector of the element to click
    pub selector: Option<String>,
    /// Or: visible text of a link, button or label to click
    pub text: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrowserTypeArgs {
    /// browser_id returned by browser_open
    pub browser_id: String,
    /// CSS selector of the field to type into
    pub selector: String,
    /// Text to type (appended to what the field already holds)
    pub text: String,
    /// Press Enter afterwards, e.g. to submit a form (default false)
    pub press_enter: Option<bool>,
    /// The text is sensitive (default true): only its length is kept in Telepy's audit log. Pass false to log it
    pub sensitive: Option<bool>,
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

/// 管理員替這個人關掉了某個功能：跟 web 一樣拒絕（`crate::features`）。/ The feature is turned off for this person.
fn feature_off(f: crate::features::Feature) -> CallToolResult {
    fail(format!("{} The tool needs it, so it can't run for this user.", crate::features::disabled_message(f)))
}

/// tool 需要 `scope`：沒給 → 缺 scope；給了但對應的功能被關掉 → 功能關閉。/ Why a tool needing `scope` is refused, if it is.
fn refused(p: &McpPrincipal, scope: &str) -> Option<CallToolResult> {
    if !p.has_scope(scope) {
        return Some(missing_scope(scope));
    }
    crate::features::Feature::for_scope(scope).filter(|f| p.feature_denied(*f)).map(feature_off)
}

/// 一次 tool call 的稽核欄位。/ Audit fields of one tool call.
#[derive(Default)]
pub(crate) struct Audit<'a> {
    pub tunnel_id: Option<i64>,
    pub session: Option<&'a AiSession>,
    pub detail: Option<String>,
    pub exit_code: Option<i64>,
    pub bytes_out: Option<i64>,
    pub error: Option<String>,
}

/// 寫一筆 tool call 稽核（MCP 與 REST 版的 session 共用）。/ Audit one call (shared by MCP and the REST sessions).
pub(crate) async fn audit_call(state: &AppState, p: &McpPrincipal, tool: &str, started: Instant, a: Audit<'_>) {
    let tunnel_id = a.tunnel_id.or(a.session.map(|s| s.tunnel_id));
    ai::audit(
        state,
        db::ai_audit::NewEvent {
            user_id: p.user.id,
            grant_id: p.credential.grant_id(),
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

/// 開 session（scope / 功能檢查 + `ai::open` + 稽核）；MCP 的 `ssh_session_open` 與 `POST /api/ai/sessions` 共用。
/// Open a session (scope and feature checks, `ai::open`, audit); shared by `ssh_session_open` and the REST route.
pub(crate) async fn open_session(state: &AppState, p: &McpPrincipal, args: OpenArgs) -> Result<Arc<AiSession>, String> {
    let started = Instant::now();
    if !p.has_scope("ssh:exec") && !p.has_scope("ssh:files") {
        return Err("This app was granted neither `ssh:exec` nor `ssh:files`. Ask the user to reconnect it in Telepy and approve one of them.".into());
    }
    if !p.may_use("ssh:exec") && !p.may_use("ssh:files") {
        let f = if p.has_scope("ssh:exec") { crate::features::Feature::Terminal } else { crate::features::Feature::Files };
        return Err(format!("{} The tool needs it, so it can't run for this user.", crate::features::disabled_message(f)));
    }
    let tunnel_id = args.tunnel_id;
    let detail = Some(format!("username: {}", args.username.as_deref().unwrap_or("(default)")));
    let req = OpenRequest { tunnel_id, username: args.username, idle_timeout_s: args.idle_timeout_s, max_lifetime_s: args.max_lifetime_s };
    match ai::open(state, p, req).await {
        Ok(s) => {
            audit_call(state, p, "ssh_session_open", started, Audit { session: Some(&s), detail, ..Default::default() }).await;
            Ok(s)
        }
        Err(e) => {
            audit_call(state, p, "ssh_session_open", started, Audit { tunnel_id: Some(tunnel_id), detail, error: Some(e.clone()), ..Default::default() }).await;
            Err(e)
        }
    }
}

/// 在 session 上跑一個指令：指令規則（擋下 / 等核准）、執行、稽核。MCP 的 `ssh_exec` 與 `POST /api/ai/sessions/{id}/exec` 共用；
/// 錯誤字串直接給呼叫端看。/ Run one command in a session: command rules, exec, audit. Shared by `ssh_exec` and the REST
/// route; errors are shown to the caller as-is.
pub(crate) async fn exec_in_session(state: &AppState, p: &McpPrincipal, s: &Arc<AiSession>, command: &str, timeout_s: Option<u64>, max_output_bytes: Option<usize>) -> Result<Value, String> {
    let started = Instant::now();
    if command.trim().is_empty() {
        return Err("command is empty".into());
    }
    // 指令規則：擋下，或等 owner / ADMIN 核准。/ Command rules: refused, or held until the owner or an ADMIN approves.
    let requester = Requester {
        tunnel_id: s.tunnel_id,
        user_id: p.user.id,
        username: p.user.username.clone(),
        source: Source::Agent,
        account: s.target_username.clone(),
        lan_host: None,
        client: Some(p.client_name.clone()),
        grant_id: p.credential.grant_id(),
        token_id: p.credential.token_id(),
        session_ref: Some(s.id.clone()),
    };
    let mut reminder: Option<String> = None;
    if let Some(rule) = command_rules::check(state, &requester, &[command.to_string()]).await {
        let why = if rule.note.is_empty() { String::new() } else { format!(" The rule says: {}", rule.note) };
        let refused = |msg: String| Audit { session: Some(s), detail: Some(command.to_string()), error: Some(msg), ..Default::default() };
        match rule.action {
            // `check` 只回擋下 / 要核准 / 提醒（允許 = None）。/ `check` only returns block / approve / warn (allow = None).
            Action::Allow => {}
            // 提醒：照跑，結果附上提醒給 agent 轉告。/ A reminder: it runs, and the result carries the note for the agent.
            Action::Warn => reminder = Some(command_rules::reminder_text(&rule)),
            Action::Block => {
                command_rules::record_block(state, &requester, command, &rule).await;
                audit_call(state, p, "ssh_exec", started, refused(format!("blocked by the rule `{}`", rule.pattern))).await;
                return Err(format!("Telepy's command rules don't allow this command (rule `{}`).{why} Don't try to get around the rule; ask the user if it really has to run.", rule.pattern));
            }
            Action::Approve => match command_rules::agent_approval(state, &requester, command, &rule).await {
                Ok(AgentApproval::Approved { .. }) => {}
                Ok(AgentApproval::Denied { id, message }) => {
                    audit_call(state, p, "ssh_exec", started, refused(format!("approval request #{id}: {message}"))).await;
                    return Err(format!("{message} (rule `{}`, request #{id}). Don't run it another way.", rule.pattern));
                }
                Ok(AgentApproval::Waiting { id }) => {
                    audit_call(state, p, "ssh_exec", started, refused(format!("waiting for approval (request #{id})"))).await;
                    return Err(format!(
                        "This command needs the tunnel owner's approval (rule `{}`).{why} Request #{id} is waiting in Telepy. Tell the user, and once they approve it run ssh_exec again with exactly the same command; an approval is good for one run within 10 minutes.",
                        rule.pattern
                    ));
                }
                Err(e) => {
                    let msg = format!("{e:#}");
                    audit_call(state, p, "ssh_exec", started, refused(msg.clone())).await;
                    return Err(format!("This command needs approval, but the request could not be filed: {msg}"));
                }
            },
        }
    }
    let timeout = Duration::from_secs(timeout_s.unwrap_or(ai::DEFAULT_COMMAND_TIMEOUT.as_secs()).max(1)).min(ai::MAX_COMMAND_TIMEOUT);
    let max_output = max_output_bytes.unwrap_or(ai::DEFAULT_MAX_OUTPUT).clamp(1024, ai::MAX_OUTPUT);
    match ai::exec(s, command, timeout, max_output).await {
        Ok(r) => {
            let bytes = (r.stdout.bytes + r.stderr.bytes) as i64;
            let error = r.timed_out.then(|| format!("timed out after {} s", timeout.as_secs()));
            audit_call(state, p, "ssh_exec", started, Audit { session: Some(s), detail: Some(command.to_string()), exit_code: r.exit_code.map(i64::from), bytes_out: Some(bytes), error, ..Default::default() }).await;
            Ok(json!({
                "exit_code": r.exit_code,
                "signal": r.signal,
                "timed_out": r.timed_out,
                "duration_ms": r.duration.as_millis() as u64,
                "stdout": r.stdout.text,
                "stderr": r.stderr.text,
                "stdout_bytes": r.stdout.bytes,
                "stderr_bytes": r.stderr.bytes,
                "truncated": r.stdout.truncated || r.stderr.truncated,
                "reminder": reminder,
            }))
        }
        Err(e) => {
            let msg = format!("{e:#}");
            audit_call(state, p, "ssh_exec", started, Audit { session: Some(s), detail: Some(command.to_string()), error: Some(msg.clone()), ..Default::default() }).await;
            Err(format!("Command failed to run: {msg}"))
        }
    }
}

impl TelepyMcp {
    pub fn new(state: AppState) -> Self {
        Self { state, tool_router: Self::tool_router() }
    }

    async fn audit(&self, p: &McpPrincipal, tool: &str, started: Instant, a: Audit<'_>) {
        audit_call(&self.state, p, tool, started, a).await;
    }

    /// 只能用「同一個使用者、同一個 app」開的 session。/ Sessions are scoped to the user and the app (grant).
    fn session(&self, p: &McpPrincipal, id: &str) -> Result<Arc<AiSession>, String> {
        match self.state.ai.get(id) {
            Some(s) if s.user_id == p.user.id && s.credential == p.credential => Ok(s),
            _ => Err(format!("Unknown or expired session_id '{id}'. Sessions close when idle, at their maximum lifetime, or when the device goes offline; open a new one with ssh_session_open.")),
        }
    }

    /// 這個 app 的 shell（找出它所在的 session）。/ A shell of this app, with its session.
    fn shell(&self, p: &McpPrincipal, id: &str) -> Result<(Arc<AiSession>, Arc<AiShell>), String> {
        for s in self.state.ai.list() {
            if s.user_id == p.user.id && s.credential == p.credential {
                if let Some(sh) = s.shell(id) {
                    return Ok((s, sh));
                }
            }
        }
        Err(format!("Unknown or closed shell_id '{id}'. Shells close with their session, after a stretch without use, or when the program in them exits and you call shell_close; open a new one with shell_open."))
    }

    /// 這個 app 開的瀏覽器；被關掉的說明原因（例如「被誰結束」）。/ A browser of this app; a closed one says why.
    fn browser(&self, p: &McpPrincipal, id: &str) -> Result<Arc<AiBrowser>, String> {
        ai::browser::lookup(&self.state, p, id).map_err(|closed| match closed {
            Some(why) => format!("The browser '{id}' was closed ({why}). Open a new one with browser_open if you still need it."),
            None => format!("Unknown or closed browser_id '{id}'. Browsers close when idle, at their maximum lifetime or when the device goes offline; open a new one with browser_open."),
        })
    }

    /// 一個瀏覽器動作：查 scope、找瀏覽器、跑、寫稽核。/ One browser action: scope, lookup, run, audit.
    async fn browser_action(&self, parts: &axum::http::request::Parts, tool: &str, id: &str, action: Value, detail: String) -> Result<Result<(Arc<AiBrowser>, Value), CallToolResult>, ErrorData> {
        let p = principal(parts)?;
        if let Some(r) = refused(&p, "browser:use") {
            return Ok(Err(r));
        }
        let b = match self.browser(&p, id) {
            Ok(b) => b,
            Err(e) => return Ok(Err(fail(e))),
        };
        match ai::browser::run_action(&self.state, &p, tool, &b, action, detail).await {
            Ok(v) => Ok(Ok((b, v))),
            Err(e) => Ok(Err(fail(format!("The browser action failed: {e}")))),
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
            "shells": s.shells().iter().map(|sh| sh.id.clone()).collect::<Vec<_>>(),
            "busy": s.busy(),
        })
    }
}

/// 規則擋下 / 等核准時 `shell_send` 的說明。/ What `shell_send` says when a command rule stepped in.
fn hold_message(h: &shell::Hold, unsent: usize) -> Option<String> {
    let why = |r: &command_rules::Rule| if r.note.is_empty() { String::new() } else { format!(" The rule says: {}", r.note) };
    let rest = if unsent > 0 { format!(" {unsent} byte(s) of input after that Enter were not sent.") } else { String::new() };
    match h {
        shell::Hold::Sent => None,
        shell::Hold::Blocked { rule, .. } => Some(format!("Telepy's command rules don't allow that command (rule `{}`).{} Ctrl+C was sent instead of Enter, so it did not run.{rest} Don't try to get around the rule; ask the user if it really has to run.", rule.pattern, why(rule))),
        shell::Hold::Denied { rule, id, message, .. } => Some(format!("{message} (rule `{}`, request #{id}). Ctrl+C was sent instead of Enter.{rest} Don't run it another way.", rule.pattern)),
        shell::Hold::Waiting { rule, id, .. } => Some(format!("This command needs the tunnel owner's approval (rule `{}`).{} Request #{id} is waiting in Telepy; the command is still typed at the prompt and has not run.{rest} Tell the user, and once they approve it call shell_send with input \"\" and press_enter: true; an approval is good for one run within 10 minutes.", rule.pattern, why(rule))),
        shell::Hold::Error { rule, message, .. } => Some(format!("This command needs approval (rule `{}`), but the request could not be filed: {message}. Ctrl+C was sent instead of Enter.{rest}", rule.pattern)),
    }
}

#[tool_router]
impl TelepyMcp {
    #[tool(description = "List the tunnels (devices) you can reach: id, name, labels, whether the device is online, its health (degraded = the tunnel is up but the device's SSH server does not answer), latency, your permission, the target usernames you may log in as, and your open sessions.", annotations(title = "List tunnels", read_only_hint = true, open_world_hint = false))]
    async fn list_tunnels(&self, Extension(parts): Extension<axum::http::request::Parts>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "tunnels:read") {
            return Ok(r);
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
                    // 要人在網頁確認身分的隧道：agent 在上面開不了 session。/ Agents can't open sessions on these.
                    "requires_step_up": t.require_step_up,
                    "health": self.health(t.reverse_port),
                    "rtt_ms": self.rtt(t.reverse_port),
                    "permission": eff.map(|e| e.label()),
                    "usernames": allowed.iter().map(|u| u.username.clone()).collect::<Vec<_>>(),
                    "default_username": default,
                    "open_sessions": sessions.iter().filter(|s| s.tunnel_id == t.id && s.credential == p.credential).map(|s| s.id.clone()).collect::<Vec<_>>(),
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

    #[tool(description = "Status of one tunnel: online, health (online, degraded = the tunnel is up but the device's SSH server does not answer, offline), latency, uptime over the last 24 hours (0..1, null without history), the device facts read once a day (OS, kernel, arch, uptime_s, CPU, memory / root disk in KB, load average, ssh version, reboot_required; null when you may not see the device's details or it was never read), `warnings` (disk, memory, load or reboot, each with a detail) and the latest SSH gateway events (connects, disconnects, forwards, degraded, recovered).", annotations(title = "Tunnel status", read_only_hint = true, open_world_hint = false))]
    async fn tunnel_status(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<TunnelArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "tunnels:read") {
            return Ok(r);
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
        // 裝置的基本狀況：跟網頁一樣只給能登入裝置的人（`can_see_endpoint`）。/ Facts follow `can_see_endpoint`, as on the web.
        let eff = permissions::effective_for(db, p.user.id, &tunnel).await.ok().flatten();
        let with_accounts = db::sharing::tunnels_with_allowed_usernames(db, p.user.id).await.map(|s| s.contains(&tunnel.id)).unwrap_or(false);
        let facts: Value = if permissions::can_see_endpoint(eff, with_accounts, p.user.is_superuser) {
            db::tunnel_endpoints::of_tunnel(db, tunnel.id).await.ok().flatten().and_then(|e| e.facts).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let warnings = facts.get("warnings").cloned().unwrap_or_else(|| json!([]));
        self.audit(&p, "tunnel_status", started, Audit { tunnel_id: Some(tunnel.id), ..Default::default() }).await;
        Ok(CallToolResult::structured(json!({
            "facts": facts,
            "warnings": warnings,
            "id": tunnel.id,
            "name": tunnel.host_friendly_name,
            "online": self.online(tunnel.reverse_port),
            "health": self.health(tunnel.reverse_port),
            "rtt_ms": self.rtt(tunnel.reverse_port),
            "uptime_24h": db::tunnel_sessions::summary(db, tunnel.id).await.ok().and_then(|s| s.h24),
            "recent_events": events,
        })))
    }

    #[tool(description = "Machines on the local network behind a tunnel's device, from earlier scans and manual entries: address, hostname, open ports, SSH banner, label and the login user to use. Reach them with ssh_exec on the device (e.g. `ssh -o BatchMode=yes user@address …`) or let the user open a web terminal.", annotations(title = "LAN hosts", read_only_hint = true, open_world_hint = false))]
    async fn lan_hosts(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<TunnelArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "tunnels:read") {
            return Ok(r);
        }
        // web 的區網頁要「區網探索」，這裡一樣。/ Like the web's Network page.
        if p.feature_denied(crate::features::Feature::Network) {
            return Ok(feature_off(crate::features::Feature::Network));
        }
        let db = &self.state.db;
        let tunnel = match db::tunnels::by_id(db, args.tunnel_id).await {
            Ok(Some(t)) if p.tunnel_allowed(t.id) && permissions::effective_for(db, p.user.id, &t).await.ok().flatten().is_some() => t,
            _ => return Ok(fail(format!("Tunnel {} not found. Call list_tunnels to see the tunnels you can use.", args.tunnel_id))),
        };
        let tz = self.state.config.tz_offset_minutes;
        let hosts: Vec<Value> = db::lan::hosts_for_tunnel(db, tunnel.id).await.unwrap_or_default().iter().map(|h| crate::api::lan::host_json(h, tz, &self.state.oui)).collect();
        self.audit(&p, "lan_hosts", started, Audit { tunnel_id: Some(tunnel.id), detail: Some(format!("{} hosts", hosts.len())), ..Default::default() }).await;
        Ok(CallToolResult::structured(json!({ "tunnel": { "id": tunnel.id, "name": tunnel.host_friendly_name }, "hosts": hosts, "last_scan": self.state.lan_scans.get(tunnel.id) })))
    }

    #[tool(description = "Scan the local network behind a tunnel's device for machines and open ports. The device's own sshd makes the connections (nothing is installed on it); only private networks, at most 1024 addresses; it can take about a minute. Requires owner or ADMIN on the tunnel. Results are saved to the tunnel's LAN host list.", annotations(title = "Scan LAN", read_only_hint = false, destructive_hint = false, open_world_hint = true))]
    async fn lan_scan(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<LanScanArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "network:scan") {
            return Ok(r);
        }
        let db = &self.state.db;
        let not_found = || fail(format!("Tunnel {} not found. Call list_tunnels to see the tunnels you can use.", args.tunnel_id));
        if !p.tunnel_allowed(args.tunnel_id) {
            return Ok(not_found());
        }
        let Some(tunnel) = db::tunnels::by_id(db, args.tunnel_id).await.ok().flatten() else { return Ok(not_found()) };
        let Some(eff) = permissions::effective_for(db, p.user.id, &tunnel).await.ok().flatten() else { return Ok(not_found()) };
        if tunnel.require_step_up {
            return Ok(fail(STEP_UP_REFUSAL.to_string()));
        }
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
        let hosts: Vec<Value> = db::lan::hosts_for_tunnel(db, tunnel.id).await.unwrap_or_default().iter().map(|h| crate::api::lan::host_json(h, tz, &self.state.oui)).collect();
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
        match open_session(&self.state, &p, args).await {
            Ok(s) => {
                let mut body = Self::session_json(&s, self.state.config.tz_offset_minutes);
                body["hint"] = json!("Run commands with ssh_exec and close the session with ssh_session_close when you are done.");
                Ok(CallToolResult::structured(body))
            }
            Err(e) => Ok(fail(e)),
        }
    }

    #[tool(description = "Run a shell command in an open session (no TTY). Returns exit_code, stdout, stderr and whether the output was truncated or the command timed out (it is killed after timeout_s). Command rules set in Telepy may refuse a command, or hold it until the tunnel owner approves it (the call then waits up to 45 seconds; if it is still waiting, run exactly the same command again after the user approves).", annotations(title = "Run command", read_only_hint = false, destructive_hint = true, open_world_hint = true))]
    async fn ssh_exec(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ExecArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        if let Some(r) = refused(&p, "ssh:exec") {
            return Ok(r);
        }
        let s = match self.session(&p, &args.session_id) {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };
        match exec_in_session(&self.state, &p, &s, &args.command, args.timeout_s, args.max_output_bytes).await {
            Ok(v) => Ok(CallToolResult::structured(v)),
            Err(e) => Ok(fail(e)),
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

    #[tool(description = "List the SSH sessions (with their shells) and browsers this app has open, with their remaining lifetime.", annotations(title = "List SSH sessions", read_only_hint = true, open_world_hint = false))]
    async fn ssh_session_list(&self, Extension(parts): Extension<axum::http::request::Parts>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let tz = self.state.config.tz_offset_minutes;
        let sessions: Vec<Value> = self.state.ai.list().iter().filter(|s| s.user_id == p.user.id && s.credential == p.credential).map(|s| Self::session_json(s, tz)).collect();
        let browsers: Vec<Value> = self.state.ai.browsers.list().iter().filter(|b| b.user_id == p.user.id && b.credential == p.credential).map(|b| ai::browser::browser_json(b, tz)).collect();
        Ok(CallToolResult::structured(json!({ "sessions": sessions, "browsers": browsers })))
    }

    #[tool(description = "List a directory on the device over SFTP (name, type, size, permissions, modification time).", annotations(title = "List directory", read_only_hint = true, open_world_hint = true))]
    async fn sftp_list(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ListArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "ssh:files") {
            return Ok(r);
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
        if let Some(r) = refused(&p, "ssh:files") {
            return Ok(r);
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
        if let Some(r) = refused(&p, "ssh:files") {
            return Ok(r);
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

    #[tool(description = "Open an interactive shell (a PTY, TERM=xterm-256color) on an SSH session, for TUI programs, prompts and REPLs. Returns a shell_id for shell_send / shell_read. At most 2 shells per session; a shell closes with its session, after the session's idle timeout without use, or with shell_close.", annotations(title = "Open shell", read_only_hint = false, destructive_hint = false, open_world_hint = false))]
    async fn shell_open(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ShellOpenArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "ssh:exec") {
            return Ok(r);
        }
        let s = match self.session(&p, &args.session_id) {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };
        let (cols, rows) = shell::clamp_size(args.cols, args.rows);
        match ai::open_shell(&self.state, &s, cols, rows).await {
            Ok(sh) => {
                self.audit(&p, "shell_open", started, Audit { session: Some(&s), detail: Some(format!("shell {}: {cols}x{rows}{}", sh.id, if sh.recorded { ", recorded" } else { "" })), ..Default::default() }).await;
                Ok(CallToolResult::structured(json!({
                    "shell_id": sh.id,
                    "session_id": s.id,
                    "cols": cols,
                    "rows": rows,
                    "recorded": sh.recorded,
                    "hint": "Read the prompt with shell_read, then type with shell_send (press_enter: true runs the line).",
                })))
            }
            Err(e) => {
                self.audit(&p, "shell_open", started, Audit { session: Some(&s), error: Some(e.clone()), ..Default::default() }).await;
                Ok(fail(e))
            }
        }
    }

    #[tool(description = "Type into an interactive shell. `input` is sent as keystrokes (control characters allowed: \\u0003 = Ctrl+C, \\u0004 = Ctrl+D, \\u001b = Esc, \\u001b[A = Up); press_enter adds Enter. Command rules apply to every Enter at a shell prompt: a blocked command gets Ctrl+C instead of Enter, a command that needs approval waits up to 45 seconds. Read the result with shell_read.", annotations(title = "Type into shell", read_only_hint = false, destructive_hint = true, open_world_hint = true))]
    async fn shell_send(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ShellSendArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "ssh:exec") {
            return Ok(r);
        }
        let (s, sh) = match self.shell(&p, &args.shell_id) {
            Ok(v) => v,
            Err(e) => return Ok(fail(e)),
        };
        let mut input = args.input;
        if args.press_enter.unwrap_or(false) {
            input.push('\r');
        }
        if input.len() > shell::MAX_INPUT {
            return Ok(fail(format!("input is too long ({} bytes; {} at most per call)", input.len(), shell::MAX_INPUT)));
        }
        if sh.exited().is_some() {
            return Ok(fail("The program in this shell has exited. Close it with shell_close and open a new one."));
        }
        let detail = format!("shell {}: {}", sh.id, shell::describe_input(&input));
        let requester = Requester {
            tunnel_id: s.tunnel_id,
            user_id: p.user.id,
            username: p.user.username.clone(),
            source: Source::Agent,
            account: s.target_username.clone(),
            lan_host: None,
            client: Some(p.client_name.clone()),
            grant_id: p.credential.grant_id(),
            token_id: p.credential.token_id(),
            session_ref: Some(s.id.clone()),
        };
        s.touch();
        let result = sh.send(&self.state, &requester, &input).await;
        s.touch();
        match result {
            Ok(r) => {
                let refused = hold_message(&r.hold, r.unsent);
                let error = match &r.hold {
                    shell::Hold::Sent => None,
                    shell::Hold::Blocked { rule, .. } => Some(format!("blocked by the rule `{}`", rule.pattern)),
                    shell::Hold::Denied { id, message, .. } => Some(format!("approval request #{id}: {message}")),
                    shell::Hold::Waiting { id, .. } => Some(format!("waiting for approval (request #{id})")),
                    shell::Hold::Error { message, .. } => Some(message.clone()),
                };
                self.audit(&p, "shell_send", started, Audit { session: Some(&s), detail: Some(detail), bytes_out: Some(r.sent as i64), error, ..Default::default() }).await;
                match refused {
                    Some(msg) => Ok(fail(msg)),
                    None => Ok(CallToolResult::structured(json!({ "shell_id": sh.id, "bytes_sent": r.sent, "reminders": r.reminders, "hint": "Call shell_read to see what happened." }))),
                }
            }
            Err(e) => {
                let msg = format!("{e:#}");
                self.audit(&p, "shell_send", started, Audit { session: Some(&s), detail: Some(detail), error: Some(msg.clone()), ..Default::default() }).await;
                Ok(fail(msg))
            }
        }
    }

    #[tool(description = "Read from an interactive shell: `output` is the raw output since the last read (escape sequences included), `screen` the current screen as plain text (one line per row, like what a person would see, so full-screen programs such as top or vim are readable), `cursor` its {row, col} (0-based), `more` whether more output is waiting, `exited` whether the program ended. Waits up to timeout_ms for new output when there is none yet.", annotations(title = "Read shell", read_only_hint = true, open_world_hint = true))]
    async fn shell_read(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ShellReadArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "ssh:exec") {
            return Ok(r);
        }
        let (s, sh) = match self.shell(&p, &args.shell_id) {
            Ok(v) => v,
            Err(e) => return Ok(fail(e)),
        };
        let wait = args.timeout_ms.map(Duration::from_millis).unwrap_or(shell::DEFAULT_READ_WAIT).min(shell::MAX_READ_WAIT);
        let max = args.max_bytes.unwrap_or(shell::DEFAULT_MAX_READ).clamp(1, shell::MAX_READ);
        s.touch();
        let r = sh.read(wait, max).await;
        s.touch();
        self.audit(&p, "shell_read", started, Audit { session: Some(&s), detail: Some(format!("shell {}", sh.id)), bytes_out: Some(r.output.len() as i64), ..Default::default() }).await;
        let mut body = json!({
            "shell_id": sh.id,
            "output": String::from_utf8_lossy(&r.output),
            "output_bytes": r.output.len(),
            "more": r.more,
            "cursor": { "row": r.cursor.0, "col": r.cursor.1 },
            "size": { "cols": r.size.0, "rows": r.size.1 },
            "exited": r.exited.is_some(),
            "exit_status": r.exited.flatten(),
        });
        if r.dropped > 0 {
            body["dropped_bytes"] = json!(r.dropped);
        }
        if args.screen.unwrap_or(true) {
            body["screen"] = json!(r.screen);
        }
        Ok(CallToolResult::structured(body))
    }

    #[tool(description = "Change the size of an interactive shell's terminal.", annotations(title = "Resize shell", read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn shell_resize(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ShellResizeArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let started = Instant::now();
        if let Some(r) = refused(&p, "ssh:exec") {
            return Ok(r);
        }
        let (s, sh) = match self.shell(&p, &args.shell_id) {
            Ok(v) => v,
            Err(e) => return Ok(fail(e)),
        };
        let (cols, rows) = shell::clamp_size(Some(args.cols), Some(args.rows));
        s.touch();
        let r = sh.resize(cols, rows).await;
        let error = r.as_ref().err().map(|e| format!("{e:#}"));
        self.audit(&p, "shell_resize", started, Audit { session: Some(&s), detail: Some(format!("shell {}: {cols}x{rows}", sh.id)), error: error.clone(), ..Default::default() }).await;
        match error {
            Some(e) => Ok(fail(e)),
            None => Ok(CallToolResult::structured(json!({ "shell_id": sh.id, "cols": cols, "rows": rows }))),
        }
    }

    #[tool(description = "Close an interactive shell (the program in it is ended).", annotations(title = "Close shell", read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn shell_close(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<ShellArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let (s, sh) = match self.shell(&p, &args.shell_id) {
            Ok(v) => v,
            Err(e) => return Ok(fail(e)),
        };
        // 稽核由 ai::close_shell 寫。/ ai::close_shell writes the audit row.
        ai::close_shell(&self.state, &s, &sh, "closed_by_agent").await;
        Ok(CallToolResult::structured(json!({ "shell_id": sh.id, "closed": true })))
    }

    #[tool(description = "Open a real Chromium browser that reaches the web through a tunnel's device, as if it ran there: it sees the device's LAN, its localhost and its public IP. Returns a browser_id. The browser closes itself when idle or at its maximum lifetime (it counts against the same per-user limit as SSH sessions); close it with browser_close when you are done. The tunnel owner is notified.", annotations(title = "Open browser", read_only_hint = false, destructive_hint = false, open_world_hint = true))]
    async fn browser_open(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<BrowserOpenArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        if let Some(r) = refused(&p, "browser:use") {
            return Ok(r);
        }
        let url = match args.url.as_deref().map(ai::browser::normalize_url).transpose() {
            Ok(u) => u,
            Err(e) => return Ok(fail(e)),
        };
        let req = ai::browser::OpenBrowserRequest { tunnel_id: args.tunnel_id, username: args.username, idle_timeout_s: args.idle_timeout_s, max_lifetime_s: args.max_lifetime_s };
        let (b, page, error) = match ai::browser::open_at(&self.state, &p, req, url).await {
            Ok(r) => r,
            Err(e) => return Ok(fail(e)),
        };
        let mut body = ai::browser::browser_json(&b, self.state.config.tz_offset_minutes);
        if let Some(page) = page {
            body["page"] = page;
        }
        if let Some(e) = error {
            body["navigate_error"] = json!(e);
        }
        body["hint"] = json!("Read the page with browser_read, look at it with browser_screenshot, and close it with browser_close when you are done.");
        Ok(CallToolResult::structured(body))
    }

    #[tool(description = "Go to a URL (http or https) in the browser and wait for the page to load. Returns the final URL and the page title.", annotations(title = "Navigate", read_only_hint = false, destructive_hint = false, open_world_hint = true))]
    async fn browser_navigate(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<BrowserNavigateArgs>) -> Result<CallToolResult, ErrorData> {
        let url = match ai::browser::normalize_url(&args.url) {
            Ok(u) => u,
            Err(e) => return Ok(fail(e)),
        };
        match self.browser_action(&parts, "browser_navigate", &args.browser_id, json!({ "action": "navigate", "url": url }), url.clone()).await? {
            Ok((b, v)) => Ok(CallToolResult::structured(json!({ "browser_id": b.id, "url": v.get("url"), "title": v.get("title") }))),
            Err(r) => Ok(r),
        }
    }

    #[tool(description = "Take a PNG screenshot of what the browser shows (scaled to at most 1280 pixels wide).", annotations(title = "Screenshot", read_only_hint = true, open_world_hint = true))]
    async fn browser_screenshot(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<BrowserArgs>) -> Result<CallToolResult, ErrorData> {
        let action = json!({ "action": "screenshot", "max_width": ai::browser::SCREENSHOT_MAX_WIDTH });
        match self.browser_action(&parts, "browser_screenshot", &args.browser_id, action, "screenshot".into()).await? {
            Ok((_, v)) => {
                let Some(data) = v.get("data").and_then(Value::as_str) else { return Ok(fail("The browser returned no image.")) };
                let meta = json!({ "url": v.get("url"), "title": v.get("title"), "width": v.get("width"), "height": v.get("height") });
                Ok(CallToolResult::success(vec![ContentBlock::image(data.to_string(), "image/png"), ContentBlock::text(meta.to_string())]))
            }
            Err(r) => Ok(r),
        }
    }

    #[tool(description = "Read the page as text: title, URL and the visible text (of the element matching `selector`, or of the whole page), plus the links on it.", annotations(title = "Read page", read_only_hint = true, open_world_hint = true))]
    async fn browser_read(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<BrowserReadArgs>) -> Result<CallToolResult, ErrorData> {
        let action = json!({ "action": "read", "selector": args.selector, "max_chars": ai::browser::MAX_PAGE_TEXT });
        let detail = args.selector.clone().unwrap_or_else(|| "(page)".into());
        match self.browser_action(&parts, "browser_read", &args.browser_id, action, detail).await? {
            Ok((b, mut v)) => {
                if let Some(o) = v.as_object_mut() {
                    o.insert("browser_id".into(), json!(b.id));
                }
                Ok(CallToolResult::structured(v))
            }
            Err(r) => Ok(r),
        }
    }

    #[tool(description = "Click an element: by CSS `selector`, or by the visible `text` of a link, button or label. The click is a real mouse click in the page.", annotations(title = "Click", read_only_hint = false, destructive_hint = true, open_world_hint = true))]
    async fn browser_click(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<BrowserClickArgs>) -> Result<CallToolResult, ErrorData> {
        let detail = match (&args.selector, &args.text) {
            (Some(s), _) if !s.trim().is_empty() => format!("selector: {s}"),
            (_, Some(t)) if !t.trim().is_empty() => format!("text: {t}"),
            _ => return Ok(fail("Give a selector or a text to click.")),
        };
        let action = json!({ "action": "click", "selector": args.selector, "text": args.text });
        match self.browser_action(&parts, "browser_click", &args.browser_id, action, detail).await? {
            Ok((b, v)) => Ok(CallToolResult::structured(json!({ "browser_id": b.id, "clicked": v.get("clicked"), "url": v.get("url"), "title": v.get("title") }))),
            Err(r) => Ok(r),
        }
    }

    #[tool(description = "Type text into a field (found by CSS selector), like a person typing; press_enter submits. Passwords and other secrets are only logged by length unless you pass sensitive: false.", annotations(title = "Type", read_only_hint = false, destructive_hint = true, open_world_hint = true))]
    async fn browser_type(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<BrowserTypeArgs>) -> Result<CallToolResult, ErrorData> {
        if args.selector.trim().is_empty() {
            return Ok(fail("selector is empty"));
        }
        let n = args.text.chars().count();
        let enter = args.press_enter.unwrap_or(false);
        let detail = ai::browser::type_detail(&args.selector, &args.text, enter, args.sensitive.unwrap_or(true));
        let action = json!({ "action": "type", "selector": args.selector, "text": args.text, "press_enter": enter });
        match self.browser_action(&parts, "browser_type", &args.browser_id, action, detail).await? {
            Ok((b, v)) => Ok(CallToolResult::structured(json!({ "browser_id": b.id, "typed": n, "url": v.get("url"), "title": v.get("title") }))),
            Err(r) => Ok(r),
        }
    }

    #[tool(description = "Close a browser you opened.", annotations(title = "Close browser", read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false))]
    async fn browser_close(&self, Extension(parts): Extension<axum::http::request::Parts>, Parameters(args): Parameters<BrowserArgs>) -> Result<CallToolResult, ErrorData> {
        let p = principal(&parts)?;
        let b = match self.browser(&p, &args.browser_id) {
            Ok(b) => b,
            Err(e) => return Ok(fail(e)),
        };
        // 稽核由 ai::browser::close 寫。/ ai::browser::close writes the audit row.
        ai::browser::close(&self.state, &b.id, CloseReason::ClosedByAgent, None).await;
        Ok(CallToolResult::structured(json!({ "browser_id": b.id, "closed": true })))
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

#[cfg(test)]
mod call_log_tests {
    use super::{tool_call, tool_error};
    use serde_json::json;

    #[test]
    fn tool_calls_are_recognised_and_errors_read() {
        let c = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "browser_open", "arguments": {"tunnel_id": 4}}});
        assert_eq!(tool_call(&c), Some(("browser_open".to_string(), Some(4))));
        assert_eq!(tool_call(&json!({"method": "tools/call", "params": {"name": "list_tunnels"}})), Some(("list_tunnels".to_string(), None)));
        assert_eq!(tool_call(&json!({"method": "tools/list"})), None);
        assert_eq!(tool_call(&json!([c])), None, "batches are not logged");
        assert_eq!(tool_error(&json!({"result": {"content": [{"type": "text", "text": "fine"}]}})), None);
        assert_eq!(tool_error(&json!({"result": {"isError": true, "content": [{"type": "text", "text": "Tunnel 9 not found."}]}})).as_deref(), Some("Tunnel 9 not found."));
        assert_eq!(tool_error(&json!({"error": {"code": -32602, "message": "bad params"}})).as_deref(), Some("bad params"));
    }
}
