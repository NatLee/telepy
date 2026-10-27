//! MCP agent 開的遠端瀏覽器：就是一個普通的 remote-browser session（`remote_browser::RemoteBrowser`，經裝置的 SOCKS 上網、
//! kasm-browser 裡的 Chromium），只是沒有人在看 VNC，操作改由 agent 透過 session-manager 的 CDP 端點下達（導向、截圖、讀頁面、
//! 點、打字）。跟 AI SSH session 一樣：綁 OAuth grant、算進每人上限、閒置 / 壽命 / 撤銷 / 裝置離線由同一個 reaper 收，
//! 出現在「誰在用」（kind = browser、client = app 名稱）與即時 session 頁（可以被結束），每個動作都寫稽核。
//! An agent-opened remote browser: an ordinary remote-browser session driven over CDP through the session-manager
//! instead of VNC. Bound to the OAuth grant, counted against the per-user cap, reaped like AI SSH sessions, listed as
//! presence kind `browser` with the app as client, endable from the live sessions page, every action audited.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{audit, clamp_request, expiry, CloseReason, Limits};
use crate::auth::mcp::McpPrincipal;
use crate::db;
use crate::permissions::{self, Permission};
use crate::presence::{Entry, Kind, PresenceGuard};
use crate::session_audit::{ConsoleKind, ConsoleSession};
use crate::state::AppState;
use crate::util::{db_time, now_db};

/// 一個 CDP 動作最多等多久（session-manager 那邊也有同樣的上限）。/ How long one CDP action may take.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(30);
/// 讀頁面最多回多少字元。/ Characters of page text returned at most.
pub const MAX_PAGE_TEXT: usize = 100_000;
/// 截圖最寬幾像素（session-manager 用 CDP 的 clip.scale 縮）。/ Screenshot width cap (scaled by the session-manager).
pub const SCREENSHOT_MAX_WIDTH: u32 = 1280;
/// 記得最近關掉的瀏覽器與原因（tool 回「被誰結束」用）。/ Recently closed browsers and why (so tools can say who ended it).
const REMEMBER_CLOSED: usize = 100;

pub struct AiBrowser {
    pub id: String,
    pub user_id: i64,
    pub user_name: String,
    pub credential: crate::auth::mcp::Credential,
    pub client_name: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub tunnel_owner_id: i64,
    pub reverse_port: i64,
    pub target_username: String,
    /// remote-browser 那邊的 session id。/ The remote-browser session id.
    pub rb_session_id: String,
    pub idle_timeout: Duration,
    pub max_lifetime: Duration,
    pub created: Instant,
    pub created_utc: chrono::DateTime<chrono::Utc>,
    activity: Mutex<(Instant, String)>,
    actions: AtomicU64,
    pub ip: Option<String>,
    /// `browser_open` / `browser_close` gateway 事件。/ The gateway open / close events.
    console: Mutex<Option<ConsoleSession>>,
    _presence: PresenceGuard,
}

impl AiBrowser {
    pub fn presence_id(&self) -> u64 {
        self._presence.id()
    }
    fn touch(&self) {
        *self.activity.lock().unwrap() = (Instant::now(), now_db());
    }
    pub fn idle_for(&self) -> Duration {
        self.activity.lock().unwrap().0.elapsed()
    }
    pub fn last_used_at(&self) -> String {
        self.activity.lock().unwrap().1.clone()
    }
    pub fn created_at(&self) -> String {
        db_time(self.created_utc)
    }
    pub fn expires_at(&self) -> String {
        db_time(self.created_utc + chrono::Duration::from_std(self.max_lifetime).unwrap_or_default())
    }
    pub fn actions(&self) -> u64 {
        self.actions.load(Ordering::SeqCst)
    }
    pub fn time_expiry(&self) -> Option<CloseReason> {
        expiry(self.created.elapsed(), self.idle_for(), false, self.idle_timeout, self.max_lifetime)
    }

    /// 經 session-manager 跑一個 CDP 動作。/ Run one CDP action through the session-manager.
    pub async fn action(&self, state: &AppState, action: Value) -> Result<Value, String> {
        self.touch();
        self.actions.fetch_add(1, Ordering::SeqCst);
        let r = state.remote_browser.cdp(&self.rb_session_id, action, ACTION_TIMEOUT).await;
        self.touch();
        r
    }
}

/// 註冊表：開著的與最近關掉的。/ The registry: open browsers and recently closed ones.
#[derive(Default)]
pub struct AiBrowsers {
    map: dashmap::DashMap<String, Arc<AiBrowser>>,
    closed: Mutex<VecDeque<(String, String)>>,
}

impl AiBrowsers {
    pub fn get(&self, id: &str) -> Option<Arc<AiBrowser>> {
        self.map.get(id).map(|b| b.clone())
    }
    pub fn list(&self) -> Vec<Arc<AiBrowser>> {
        let mut v: Vec<Arc<AiBrowser>> = self.map.iter().map(|e| e.value().clone()).collect();
        v.sort_by_key(|b| b.created);
        v
    }
    pub fn count_for_user(&self, user_id: i64) -> usize {
        self.map.iter().filter(|e| e.value().user_id == user_id).count()
    }
    /// 最近關掉的原因（給「找不到這個瀏覽器」的錯誤訊息）。/ Why a recently closed browser went away.
    pub fn closed_reason(&self, id: &str) -> Option<String> {
        self.closed.lock().unwrap().iter().find(|(i, _)| i == id).map(|(_, r)| r.clone())
    }
    fn remember_closed(&self, id: &str, reason: String) {
        let mut c = self.closed.lock().unwrap();
        c.push_back((id.to_string(), reason));
        while c.len() > REMEMBER_CLOSED {
            c.pop_front();
        }
    }
}

pub struct OpenBrowserRequest {
    pub tunnel_id: i64,
    pub username: Option<String>,
    pub idle_timeout_s: Option<u64>,
    pub max_lifetime_s: Option<u64>,
}

/// 開一個瀏覽器（檢查跟 `ai::open` 一樣，再加上站台的遠端瀏覽器上限）。/ Open a browser; same checks as `ai::open`.
pub async fn open(state: &AppState, p: &McpPrincipal, req: OpenBrowserRequest) -> Result<Arc<AiBrowser>, String> {
    let db_err = |e: sqlx::Error| format!("database error: {e}");
    let not_found = || format!("Tunnel {} not found. Call list_tunnels to see the tunnels you can use.", req.tunnel_id);
    if !p.tunnel_allowed(req.tunnel_id) {
        return Err(format!("This app was not given access to tunnel {} when it was authorized. Reconnect the app in Telepy to change its tunnels.", req.tunnel_id));
    }
    let tunnel = db::tunnels::by_id(&state.db, req.tunnel_id).await.map_err(db_err)?.ok_or_else(not_found)?;
    if !permissions::check_access(&state.db, p.user.id, &tunnel, Permission::View).await.map_err(db_err)? {
        return Err(not_found());
    }
    if tunnel.reverse_port <= 0 {
        return Err("This tunnel has no reverse port configured.".into());
    }
    if tunnel.require_step_up {
        return Err(crate::mcp::STEP_UP_REFUSAL.into());
    }
    let allowed = permissions::allowed_usernames(&state.db, p.user.id, &tunnel).await.map_err(db_err)?;
    let username = permissions::choose_username(&allowed, tunnel.default_username_id, req.username.as_deref(), &tunnel.host_friendly_name)?;
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(tunnel.reverse_port).map(|port| listen.contains(&port)).unwrap_or(false) {
            return Err(format!("The device '{}' is offline (its reverse tunnel is not connected).", tunnel.host_friendly_name));
        }
    }
    let limits = Limits::from_settings(&db::settings::get_solo(&state.db).await.map_err(db_err)?);
    if limits.max_sessions_per_user == 0 {
        return Err("AI sessions are disabled by the administrator.".into());
    }
    let Some(_reservation) = state.ai.reserve(p.user.id, limits.max_sessions_per_user) else {
        return Err(format!(
            "You already have {} open AI session(s) or browser(s); the limit is {}. Close one (ssh_session_close / browser_close) first.",
            state.ai.count_for_user(p.user.id),
            limits.max_sessions_per_user
        ));
    };
    let started = state
        .remote_browser
        .start(state, &username, tunnel.reverse_port, tunnel.id)
        .await
        .map_err(|e| format!("Cannot start a remote browser through '{}': {e}", tunnel.host_friendly_name))?;
    let rb_session_id = started.get("session_id").and_then(Value::as_str).unwrap_or_default().to_string();
    let now = Instant::now();
    let what = format!("Remote browser by MCP app \"{}\" ({}) as {username}@{}", p.client_name, p.user.username, tunnel.host_friendly_name);
    let console = ConsoleSession::open(state, ConsoleKind::Browser, tunnel.id, what).await;
    crate::session_audit::webhook_started(state, tunnel.id, p.user.id, &p.user.username, "browser", Some(&username)).await;
    let browser = Arc::new(AiBrowser {
        id: format!("aib_{}", crate::util::uuid_hex()),
        user_id: p.user.id,
        user_name: p.user.username.clone(),
        credential: p.credential,
        client_name: p.client_name.clone(),
        tunnel_id: tunnel.id,
        tunnel_name: tunnel.host_friendly_name.clone(),
        tunnel_owner_id: tunnel.user_id,
        reverse_port: tunnel.reverse_port,
        target_username: username,
        rb_session_id,
        idle_timeout: clamp_request(req.idle_timeout_s, limits.idle_timeout),
        max_lifetime: clamp_request(req.max_lifetime_s, limits.max_lifetime),
        created: now,
        created_utc: chrono::Utc::now(),
        activity: Mutex::new((now, now_db())),
        actions: AtomicU64::new(0),
        ip: p.ip.clone(),
        console: Mutex::new(Some(console)),
        _presence: state.presence.join(Entry { client: Some(p.client_name.clone()), ..Entry::new(tunnel.id, p.user.id, &p.user.username, Kind::Browser, p.ip.clone()) }),
    });
    state.ai.browsers.map.insert(browser.id.clone(), browser.clone());
    tracing::info!(browser = %browser.id, user = %browser.user_name, client = %browser.client_name, tunnel = %browser.tunnel_name, "AI browser opened");
    notify(state, &browser, None, None);
    Ok(browser)
}

/// 關掉並移出 registry（收 remote-browser session）；寫稽核與事件、通知。重複關閉回 None。
/// Close and forget a browser (stopping the remote-browser session); audited, logged and notified once.
pub async fn close(state: &AppState, id: &str, reason: CloseReason, by: Option<&str>) -> Option<Arc<AiBrowser>> {
    let (_, b) = state.ai.browsers.map.remove(id)?;
    state.remote_browser.stop(&state.db, &b.rb_session_id).await;
    tracing::info!(browser = %b.id, tunnel = %b.tunnel_name, reason = reason.as_str(), "AI browser closed");
    let console = b.console.lock().unwrap().take();
    if let Some(console) = console {
        console.close(state).await;
    }
    let detail = match by {
        Some(who) => format!("reason: {}; by: {who}; actions: {}", reason.as_str(), b.actions()),
        None => format!("reason: {}; actions: {}", reason.as_str(), b.actions()),
    };
    audit(
        state,
        db::ai_audit::NewEvent {
            user_id: b.user_id,
            grant_id: b.credential.grant_id(),
            client_name: &b.client_name,
            tool: "browser_close",
            tunnel_id: Some(b.tunnel_id),
            session_id: Some(&b.id),
            target_username: Some(&b.target_username),
            detail: Some(&detail),
            ok: true,
            duration_ms: Some(b.created.elapsed().as_millis() as i64),
            ip: b.ip.as_deref(),
            ..Default::default()
        },
    )
    .await;
    let why = match by {
        Some(who) => format!("ended by {who}"),
        None => reason.as_str().to_string(),
    };
    state.ai.browsers.remember_closed(&b.id, why);
    notify(state, &b, Some(reason), by);
    Some(b)
}

/// 權限面的關閉理由（同 AI session）。/ Authorization-based close reasons (as for AI sessions).
async fn authorization_lost(state: &AppState, b: &AiBrowser) -> Option<CloseReason> {
    if !b.credential.is_live(&state.db).await? {
        return Some(CloseReason::Revoked);
    }
    if !db::users::by_id(&state.db, b.user_id).await.ok()?.map(|u| u.is_active).unwrap_or(false) {
        return Some(CloseReason::Revoked);
    }
    let Some(tunnel) = db::tunnels::by_id(&state.db, b.tunnel_id).await.ok()? else {
        return Some(CloseReason::PermissionRemoved);
    };
    if tunnel.reverse_port != b.reverse_port || !permissions::check_access(&state.db, b.user_id, &tunnel, Permission::View).await.ok()? {
        return Some(CloseReason::PermissionRemoved);
    }
    let allowed = permissions::allowed_usernames(&state.db, b.user_id, &tunnel).await.ok()?;
    if !allowed.iter().any(|u| u.username == b.target_username) {
        return Some(CloseReason::PermissionRemoved);
    }
    None
}

/// reaper 的一輪：時間、裝置離線、remote-browser session 不在了（它自己的 reaper 收掉、代理斷了）、權限；還活著的就續命。
/// One reaper pass: time, device offline, the remote-browser session gone, authorization; live ones are kept alive.
pub async fn reap_once(state: &AppState) {
    let listen = state.status.listen_ports();
    for b in state.ai.browsers.list() {
        let reason = if let Some(r) = b.time_expiry() {
            Some(r)
        } else if listen.as_ref().is_some_and(|l| !u16::try_from(b.reverse_port).map(|p| l.contains(&p)).unwrap_or(false)) {
            Some(CloseReason::DeviceOffline)
        } else if !state.remote_browser.ping(&state.db, &b.rb_session_id).await {
            Some(CloseReason::Disconnected)
        } else {
            authorization_lost(state, &b).await
        };
        if let Some(r) = reason {
            close(state, &b.id, r, None).await;
        }
    }
}

pub async fn close_where(state: &AppState, pick: impl Fn(&AiBrowser) -> bool, reason: CloseReason) -> usize {
    let ids: Vec<String> = state.ai.browsers.list().iter().filter(|b| pick(b)).map(|b| b.id.clone()).collect();
    let mut n = 0;
    for id in ids {
        if close(state, &id, reason, None).await.is_some() {
            n += 1;
        }
    }
    n
}

/// 跟 AI SSH session 同一組通知（`AI-SESSION-OPENED` / `-CLOSED`），多一個 `kind: "browser"`；webhook 同樣沿用。
/// The same notifications as AI SSH sessions, with `kind: "browser"`; the webhook kinds are reused too.
fn notify(state: &AppState, b: &AiBrowser, reason: Option<CloseReason>, by: Option<&str>) {
    let details = match (reason, by) {
        (None, _) => format!("{} ({}) opened a remote browser through '{}' as {}", b.client_name, b.user_name, b.tunnel_name, b.target_username),
        (Some(_), Some(who)) => format!("The remote browser of {} ({}) on '{}' was ended by {who}", b.client_name, b.user_name, b.tunnel_name),
        (Some(r), None) => format!("The remote browser of {} ({}) on '{}' was closed ({})", b.client_name, b.user_name, b.tunnel_name, r.as_str()),
    };
    let mut msg = json!({
        "action": if reason.is_some() { "AI-SESSION-CLOSED" } else { "AI-SESSION-OPENED" },
        "kind": "browser",
        "details": details,
        "tunnel_id": b.tunnel_id,
        "session_id": b.id,
        "by": b.user_name,
        "client": b.client_name,
    });
    if let Some(r) = reason {
        msg["reason"] = json!(r.as_str());
    }
    state.hub.notify_users([b.user_id, b.tunnel_owner_id], &msg);
    let kind = if reason.is_some() { crate::webhooks::Kind::McpSessionClosed } else { crate::webhooks::Kind::McpSessionOpened };
    let tunnel = crate::webhooks::TunnelRef { id: b.tunnel_id, name: b.tunnel_name.clone(), reverse_port: b.reverse_port };
    state.webhooks.emit(
        crate::webhooks::Event::new(kind)
            .tunnel_ref(tunnel)
            .to([b.user_id, b.tunnel_owner_id], None)
            .data(json!({ "session_id": b.id, "kind": "browser", "by": b.user_name, "client": b.client_name, "account": b.target_username, "reason": reason.map(|r| r.as_str()) }))
            .link("/tunnels/activity"),
    );
}

/// 給 agent / 網頁看的 JSON。/ JSON for the agent and the web.
pub fn browser_json(b: &AiBrowser, tz: i32) -> Value {
    json!({
        "browser_id": b.id,
        "tunnel": { "id": b.tunnel_id, "name": b.tunnel_name },
        "username": b.target_username,
        "created_at": crate::util::db_to_iso(&b.created_at(), tz),
        "last_used_at": crate::util::db_to_iso(&b.last_used_at(), tz),
        "expires_at": crate::util::db_to_iso(&b.expires_at(), tz),
        "idle_timeout_s": b.idle_timeout.as_secs(),
        "max_lifetime_s": b.max_lifetime.as_secs(),
        "actions": b.actions(),
    })
}

/// agent 給的網址 → 能交給瀏覽器的網址：只接受 http / https（沒寫 scheme 就補 https://）。`file:`、`javascript:`、
/// `chrome:`、`data:` 之類一律拒絕——`file:` 會讀到 kasm-browser 容器自己的檔案，其他會繞過頁面的權限。
/// An agent's URL → one the browser may open: http / https only (https:// added when no scheme is given). `file:`
/// would read the kasm-browser container's own files; the other schemes bypass page permissions.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("url is empty".into());
    }
    if raw.len() > 4096 {
        return Err("url is too long (4096 characters at most)".into());
    }
    let has_scheme = raw.find(':').is_some_and(|i| raw[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) && !raw[i + 1..].starts_with(|c: char| c.is_ascii_digit()));
    let candidate = if has_scheme { raw.to_string() } else { format!("https://{raw}") };
    let url = url::Url::parse(&candidate).map_err(|e| format!("'{raw}' is not a valid URL: {e}"))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(url.to_string()),
        "http" | "https" => Err(format!("'{raw}' has no host")),
        other => Err(format!("Only http and https URLs can be opened (not `{other}:`).")),
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn urls_are_http_only() {
        assert_eq!(normalize_url("example.com").unwrap(), "https://example.com/");
        assert_eq!(normalize_url(" http://192.168.1.10:8080/admin ").unwrap(), "http://192.168.1.10:8080/admin");
        assert_eq!(normalize_url("localhost:3000/x").unwrap(), "https://localhost:3000/x", "host:port is not a scheme");
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("chrome://settings").is_err());
        assert!(normalize_url("data:text/html,hi").is_err());
        assert!(normalize_url("").is_err());
        assert!(normalize_url("https://").is_err());
    }
}
