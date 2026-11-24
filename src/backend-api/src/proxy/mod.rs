//! 裝置代理：已授權的 app（OAuth）或個人 API token（scope `proxy:use`）把一條通道當成網路代理——每條連線都是連線池
//! 那條裝置連線上的一條 direct-tcpip channel，由**裝置的 sshd** 連出去（跟 `ssh -D`、遠端瀏覽器的 SOCKS 一樣的機制），
//! 所以對方看到的是裝置的位址，也連得到裝置的區網與 localhost。裝置上不跑任何東西。
//!
//! 入口有兩種，共用這裡的核心：`/ws/proxy/`（一條 WebSocket = 一條 TCP 連線，穿得過只放行網頁 port 的網路與 CDN）
//! 與標準的 HTTP 代理入口（`CONNECT` + `Proxy-Authorization`，見 `listener.rs`）。兩邊都先 [`authorize`]（站台開關、
//! scope、功能、通道限制、權限、二次驗證、帳號、裝置在線），拿到一個「代理 session」＝（憑證、通道、帳號）底下所有
//! 連線的總和；再 [`ProxySession::open`] 開連線。Session 有上限、會閒置關閉、權限一變就整個切斷，開與關各記一筆通道
//! 事件（關的那筆帶連了幾條、傳了多少、去過哪些目標）。
//!
//! The device proxy: an authorized app (OAuth) or a personal API token (scope `proxy:use`) uses a tunnel as a network
//! proxy. Each connection is a direct-tcpip channel on the pooled device connection, opened by the **device's sshd**
//! (the mechanism of `ssh -D` and of the remote browser's SOCKS), so the far side sees the device's address and the
//! device's LAN and localhost are reachable. Nothing runs on the device.
//!
//! Two ways in share this core: `/ws/proxy/` (one WebSocket = one TCP connection; passes networks and CDNs that only
//! carry web ports) and a standard HTTP proxy endpoint (`CONNECT` + `Proxy-Authorization`, see `listener.rs`). Both
//! [`authorize`] first (site switch, scope, feature, tunnel restriction, permission, step-up, account, device online)
//! and get a "proxy session" = everything one (credential, tunnel, account) has open; then [`ProxySession::open`] per
//! connection. Sessions are capped, close when idle, are cut the moment access changes, and write one tunnel event at
//! open and one at close (connections, bytes, where they went).


pub mod listener;
pub mod request;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;

use crate::auth::mcp::{Credential, McpPrincipal};
use crate::db;
use crate::db::tunnels::Tunnel;
use crate::features::Feature;
use crate::permissions::{self, Permission};
use crate::ssh::pool::Lease;
use crate::ssh::resolve::Resolver;
use crate::state::AppState;

pub const SCOPE: &str = "proxy:use";
/// 沒有任何連線多久後 session 關閉。/ How long a session with no connections stays before it closes.
pub const IDLE: Duration = Duration::from_secs(60);
/// 多久檢查一次閒置與權限。/ How often idleness and access are re-checked.
pub const REAP_EVERY: Duration = Duration::from_secs(10);
/// 關閉事件裡最多列幾個去過的目標。/ How many destinations a close event lists.
pub const MAX_TARGETS: usize = 20;
/// 一個憑證同時最多經幾條通道代理。/ How many tunnels one credential may proxy through at once.
pub const MAX_SESSIONS_PER_CREDENTIAL: usize = 8;

/// 入口回給客戶端的錯誤：HTTP 狀態、機器看的代碼、人看的訊息。/ An error for the client: status, machine code, message.
#[derive(Debug, Clone)]
pub struct ProxyError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ProxyError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ProxyError { status, code, message: message.into() }
    }
    pub fn json(&self) -> Value {
        json!({ "error": self.message, "code": self.code })
    }
}

/// 目標主機名能不能交給裝置：長度、字元（字母數字、`.`、`-`、`_`，或 IPv6 的 `:`），不能以 `-` 開頭。
/// Whether a destination host may be handed to the device: length and characters only (letters, digits, `.`, `-`, `_`,
/// or `:` for IPv6), never starting with `-`.
pub fn valid_host(host: &str) -> bool {
    !host.is_empty() && host.len() <= 253 && !host.starts_with('-') && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
}

/// `host:port` / `[v6]:port` → (host, port)。/ Splits `host:port` or `[v6]:port`.
pub fn split_target(raw: &str) -> Option<(String, u16)> {
    let (host, port) = match raw.strip_prefix('[') {
        Some(rest) => {
            let (h, p) = rest.split_once("]:")?;
            (h, p)
        }
        None => raw.rsplit_once(':')?,
    };
    let port: u16 = port.parse().ok().filter(|p| *p > 0)?;
    valid_host(host).then(|| (host.to_string(), port))
}

/// 位元組數給人看：`1.2 MB`。/ A byte count for people.
pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

/// 關閉事件的那一句（純函式）。/ The sentence of the close event (pure).
pub fn close_summary(who: &str, client: &str, account: &str, reason: &str, connections: u64, up: u64, down: u64, targets: &[String], more: usize) -> String {
    let mut s = format!("{who} via {client}: proxy through the device as {account} closed ({reason}) — {connections} connection(s), {} sent, {} received", human_bytes(up), human_bytes(down));
    if !targets.is_empty() {
        s.push_str(&format!("; to {}", targets.join(", ")));
        if more > 0 {
            s.push_str(&format!(" and {more} more"));
        }
    }
    s
}

type Key = (Credential, i64, String);

/// 一個（憑證、通道、帳號）底下的所有代理連線。/ Everything one (credential, tunnel, account) has open.
pub struct ProxySession {
    pub id: String,
    pub user_id: i64,
    pub user_name: String,
    pub credential: Credential,
    pub client_name: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub reverse_port: i64,
    pub account: String,
    pub ip: Option<String>,
    pub opened_at: chrono::DateTime<chrono::Utc>,
    last_used: Mutex<Instant>,
    open: AtomicUsize,
    total: AtomicU64,
    up: AtomicU64,
    down: AtomicU64,
    targets: Mutex<(Vec<String>, usize)>,
    lease: Arc<Lease>,
    resolver: Resolver,
    closed: AtomicBool,
    /// 關閉的原因；連線們訂閱它，一有值就全部停。/ The close reason; every connection watches it and stops when set.
    stop: watch::Sender<Option<String>>,
}

impl ProxySession {
    pub fn open_connections(&self) -> usize {
        self.open.load(Ordering::Relaxed)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    fn idle_for(&self) -> Duration {
        self.last_used.lock().map(|t| t.elapsed()).unwrap_or_default()
    }

    fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }

    fn note_target(&self, target: &str) {
        if let Ok(mut t) = self.targets.lock() {
            if t.0.iter().any(|x| x == target) {
                return;
            }
            if t.0.len() < MAX_TARGETS {
                t.0.push(target.to_string());
            } else {
                t.1 += 1;
            }
        }
    }

    pub fn json(&self, tz_offset_minutes: i32) -> Value {
        let (targets, more) = self.targets.lock().map(|t| (t.0.clone(), t.1)).unwrap_or_default();
        json!({
            "id": self.id,
            "user": { "id": self.user_id, "username": self.user_name },
            "client_name": self.client_name,
            "kind": match self.credential { Credential::Grant(_) => "app", Credential::Token(_) => "token", Credential::Web(_) => "web" },
            "grant_id": self.credential.grant_id(),
            "token_id": self.credential.token_id(),
            "tunnel": { "id": self.tunnel_id, "name": self.tunnel_name },
            "username": self.account,
            "ip": self.ip,
            "opened_at": crate::util::db_to_iso(&crate::util::db_time(self.opened_at), tz_offset_minutes),
            "connections": self.open_connections(),
            "connections_total": self.total.load(Ordering::Relaxed),
            "bytes_up": self.up.load(Ordering::Relaxed),
            "bytes_down": self.down.load(Ordering::Relaxed),
            "targets": targets,
            "targets_more": more,
        })
    }

    /// 經裝置開一條到 `host:port` 的連線。`max` = 這個 session 同時最多幾條（站台設定）。名稱先照裝置的系統解析
    /// （Apple 的 sshd 收到名稱會整條斷線，見 `ssh::resolve`）。
    /// Opens a connection to `host:port` through the device. `max` = the session's concurrent limit (a site setting).
    /// Names are resolved the device's way first (Apple's sshd drops the whole connection on a name, see `ssh::resolve`).
    pub async fn open(self: &Arc<Self>, state: &AppState, host: &str, port: u16, max: usize) -> Result<ProxyConn, ProxyError> {
        if self.is_closed() {
            return Err(ProxyError::new(StatusCode::FORBIDDEN, "proxy_closed", "This proxy session was closed. Connect again."));
        }
        if !valid_host(host) || port == 0 {
            return Err(ProxyError::new(StatusCode::BAD_REQUEST, "bad_target", "The destination must be host:port, with a plain host name or address."));
        }
        // 先占位再連：一次湧進來的連線不會超過上限。/ Take the slot before connecting, so a burst can't exceed the limit.
        if self.open.fetch_add(1, Ordering::SeqCst) >= max {
            self.open.fetch_sub(1, Ordering::SeqCst);
            return Err(ProxyError::new(StatusCode::TOO_MANY_REQUESTS, "proxy_busy", format!("This credential already has {max} connections open through this tunnel. Close some or try again.")));
        }
        let guard = ConnGuard { session: self.clone() };
        self.touch();
        let target = match self.resolver.target(state, &self.lease, host).await {
            Ok(t) => t,
            Err(e) => return Err(ProxyError::new(StatusCode::BAD_GATEWAY, "resolve_failed", format!("The device could not find {host}: {e:#}"))),
        };
        let channel = match self.lease.device().channel_open_direct_tcpip(target.as_str(), u32::from(port), "127.0.0.1", 0).await {
            Ok(c) => c,
            Err(e) => return Err(ProxyError::new(StatusCode::BAD_GATEWAY, "connect_failed", format!("The device could not connect to {host}:{port}: {e}"))),
        };
        self.total.fetch_add(1, Ordering::Relaxed);
        self.note_target(&format!("{host}:{port}"));
        Ok(ProxyConn { stream: Box::new(channel.into_stream()), guard })
    }
}

/// 一條連線占的位子：放掉時還回去並更新「最後使用」。/ One connection's slot: released on drop, which also refreshes "last used".
pub struct ConnGuard {
    session: Arc<ProxySession>,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.session.open.fetch_sub(1, Ordering::SeqCst);
        self.session.touch();
    }
}

pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// 一條開好的代理連線（裝置那一頭）。/ An open proxy connection (the device's end).
pub struct ProxyConn {
    stream: Box<dyn Duplex>,
    guard: ConnGuard,
}

impl ProxyConn {
    /// 兩邊互相轉送，直到任一邊結束，或 session 被關掉。位元組數記在 session 上。
    /// Relays both ways until either side ends or the session is closed. Byte counts go to the session.
    pub async fn relay<S: AsyncRead + AsyncWrite + Unpin>(mut self, mut client: S) {
        let session = self.guard.session.clone();
        let mut stop = session.stop.subscribe();
        if stop.borrow().is_some() {
            return;
        }
        let copy = tokio::io::copy_bidirectional(&mut client, &mut self.stream);
        tokio::pin!(copy);
        let moved = tokio::select! {
            r = &mut copy => r.ok(),
            _ = stop.wait_for(Option::is_some) => None,
        };
        if let Some((up, down)) = moved {
            session.up.fetch_add(up, Ordering::Relaxed);
            session.down.fetch_add(down, Ordering::Relaxed);
        }
    }
}

/// 所有開著的代理 session。/ Every open proxy session.
#[derive(Default)]
pub struct ProxyHub {
    sessions: Mutex<HashMap<Key, Arc<ProxySession>>>,
}

impl ProxyHub {
    pub fn list(&self) -> Vec<Arc<ProxySession>> {
        let mut v: Vec<Arc<ProxySession>> = self.sessions.lock().map(|m| m.values().cloned().collect()).unwrap_or_default();
        v.sort_by_key(|s| s.opened_at);
        v
    }

    pub fn get(&self, id: &str) -> Option<Arc<ProxySession>> {
        self.sessions.lock().ok()?.values().find(|s| s.id == id).cloned()
    }

    fn find(&self, key: &Key) -> Option<Arc<ProxySession>> {
        self.sessions.lock().ok()?.get(key).filter(|s| !s.is_closed()).cloned()
    }

    fn count_for(&self, credential: Credential) -> usize {
        self.sessions.lock().map(|m| m.keys().filter(|k| k.0 == credential).count()).unwrap_or(0)
    }
}

/// 這個呼叫者想經哪條通道代理：id 或名稱（名稱要唯一）。看不到、被憑證限制擋掉、沒有權限都一樣回 404。
/// Which tunnel the caller wants: an id or a name (the name must be unique among what they see). Not visible, outside
/// the credential's tunnels and no permission all answer 404 alike.
pub async fn find_tunnel(state: &AppState, p: &McpPrincipal, tunnel: &str) -> Result<Tunnel, ProxyError> {
    let not_found = || ProxyError::new(StatusCode::NOT_FOUND, "tunnel_not_found", format!("No tunnel '{tunnel}' that this credential may use."));
    let db_err = |_| ProxyError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Database error.");
    let t = match tunnel.parse::<i64>() {
        Ok(id) => db::tunnels::by_id(&state.db, id).await.map_err(db_err)?,
        Err(_) => {
            let mut named: Vec<Tunnel> = db::tunnels::visible_to(&state.db, p.user.id).await.map_err(db_err)?.into_iter().filter(|t| t.host_friendly_name == tunnel && p.tunnel_allowed(t.id)).collect();
            if named.len() > 1 {
                return Err(ProxyError::new(StatusCode::BAD_REQUEST, "tunnel_ambiguous", format!("More than one tunnel is called '{tunnel}'. Use its id.")));
            }
            named.pop()
        }
    };
    let Some(t) = t else { return Err(not_found()) };
    if !p.tunnel_allowed(t.id) || !permissions::check_access(&state.db, p.user.id, &t, Permission::View).await.map_err(db_err)? {
        return Err(not_found());
    }
    Ok(t)
}

/// 站台開關、scope 與功能：任何代理動作（列通道也算）之前都要過。/ The site switch, the scope and the feature: before any proxy action, listing included.
pub async fn check_allowed(state: &AppState, p: &McpPrincipal) -> Result<db::settings::SiteSettings, ProxyError> {
    let settings = db::settings::get_solo(&state.db).await.map_err(|_| ProxyError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Database error."))?;
    if !settings.proxy_enabled {
        return Err(ProxyError::new(StatusCode::FORBIDDEN, "proxy_disabled", "An administrator turned the device proxy off on this Telepy server (Site settings → Features → Device proxy)."));
    }
    if !p.has_scope(SCOPE) {
        return Err(ProxyError::new(StatusCode::FORBIDDEN, "token_scope", format!("This credential lacks the {SCOPE} permission.")));
    }
    if p.feature_denied(Feature::Proxy) {
        return Err(ProxyError::new(StatusCode::FORBIDDEN, "feature_disabled", crate::features::disabled_message(Feature::Proxy)));
    }
    Ok(settings)
}

/// 全部的門都過了以後回這個（憑證、通道、帳號）的 session（沒有就開一個）與同時連線上限。
/// After every gate, the session of this (credential, tunnel, account) — opened when there is none — and the
/// concurrent connection limit.
pub async fn authorize(state: &AppState, p: &McpPrincipal, tunnel: &str, account: Option<&str>) -> Result<(Arc<ProxySession>, usize), ProxyError> {
    let settings = check_allowed(state, p).await?;
    let max = usize::try_from(settings.proxy_max_connections).unwrap_or(64).max(1);
    let t = find_tunnel(state, p, tunnel).await?;
    if t.require_step_up {
        return Err(ProxyError::new(StatusCode::FORBIDDEN, "step_up_refused", "This tunnel asks for a fresh verification before every session, which an app or token cannot give."));
    }
    let db_err = |_| ProxyError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Database error.");
    let allowed = permissions::allowed_usernames(&state.db, p.user.id, &t).await.map_err(db_err)?;
    if allowed.is_empty() {
        return Err(ProxyError::new(StatusCode::FORBIDDEN, "no_account", "You have no account you may use on this device."));
    }
    let account = permissions::choose_username(&allowed, t.default_username_id, account.filter(|a| !a.is_empty()), &t.host_friendly_name).map_err(|e| ProxyError::new(StatusCode::BAD_REQUEST, "username", e))?;
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(t.reverse_port).map(|port| listen.contains(&port)).unwrap_or(false) {
            return Err(ProxyError::new(StatusCode::BAD_GATEWAY, "device_offline", format!("The device '{}' is offline.", t.host_friendly_name)));
        }
    }
    let key: Key = (p.credential, t.id, account.clone());
    if let Some(s) = state.proxy.find(&key) {
        return Ok((s, max));
    }
    if state.proxy.count_for(p.credential) >= MAX_SESSIONS_PER_CREDENTIAL {
        return Err(ProxyError::new(StatusCode::TOO_MANY_REQUESTS, "proxy_busy", format!("This credential already proxies through {MAX_SESSIONS_PER_CREDENTIAL} tunnels. Wait for one to go idle.")));
    }
    let lease = state
        .pool
        .acquire(state, t.reverse_port, &account)
        .await
        .map_err(|e| ProxyError::new(StatusCode::BAD_GATEWAY, "device_login_failed", format!("Telepy could not log in to the device as {account}: {e:#}")))?;
    let (stop, _) = watch::channel(None);
    let session = Arc::new(ProxySession {
        id: format!("px_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
        user_id: p.user.id,
        user_name: p.user.username.clone(),
        credential: p.credential,
        client_name: p.client_name.clone(),
        tunnel_id: t.id,
        tunnel_name: t.host_friendly_name.clone(),
        reverse_port: t.reverse_port,
        account: account.clone(),
        ip: p.ip.clone(),
        opened_at: chrono::Utc::now(),
        last_used: Mutex::new(Instant::now()),
        open: AtomicUsize::new(0),
        total: AtomicU64::new(0),
        up: AtomicU64::new(0),
        down: AtomicU64::new(0),
        targets: Mutex::new((Vec::new(), 0)),
        lease: Arc::new(lease),
        resolver: Resolver::new(),
        closed: AtomicBool::new(false),
        stop,
    });
    // 兩條連線同時進來：只留先放進去的那個。/ Two connections at once: the first one in wins.
    let session = {
        let mut map = state.proxy.sessions.lock().map_err(|_| ProxyError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Internal error."))?;
        match map.get(&key).filter(|s| !s.is_closed()) {
            Some(existing) => return Ok((existing.clone(), max)),
            None => {
                map.insert(key, session.clone());
                session
            }
        }
    };
    state
        .gateway
        .event("proxy_open", None, None, Some(t.id), format!("{} via {}: proxy through the device as {account} opened", p.user.username, p.client_name))
        .await;
    notify(state, &session, "PROXY-SESSION-OPENED", None);
    Ok((session, max))
}

/// 關掉一個 session：切斷它所有連線、記事件、通知。重複呼叫只做一次。/ Close a session: cut every connection, write the event, notify. Idempotent.
pub async fn close(state: &AppState, session: &Arc<ProxySession>, reason: &str) -> bool {
    if session.closed.swap(true, Ordering::SeqCst) {
        return false;
    }
    if let Ok(mut map) = state.proxy.sessions.lock() {
        map.retain(|_, s| s.id != session.id);
    }
    let _ = session.stop.send(Some(reason.to_string()));
    let (targets, more) = session.targets.lock().map(|t| (t.0.clone(), t.1)).unwrap_or_default();
    let msg = close_summary(&session.user_name, &session.client_name, &session.account, reason, session.total.load(Ordering::Relaxed), session.up.load(Ordering::Relaxed), session.down.load(Ordering::Relaxed), &targets, more);
    state.gateway.event("proxy_close", None, None, Some(session.tunnel_id), msg).await;
    notify(state, session, "PROXY-SESSION-CLOSED", Some(reason));
    true
}

/// 通知這個人與通道的擁有者（頁面據此重抓清單）。/ Tells the person and the tunnel's owner (pages refetch on it).
fn notify(state: &AppState, s: &ProxySession, action: &str, reason: Option<&str>) {
    let msg = json!({ "action": action, "session_id": s.id, "tunnel_id": s.tunnel_id, "tunnel_name": s.tunnel_name, "by": s.user_name, "client_name": s.client_name, "reason": reason });
    let state = state.clone();
    let (user_id, tunnel_id) = (s.user_id, s.tunnel_id);
    tokio::spawn(async move {
        let mut to = vec![user_id];
        if let Ok(Some(t)) = db::tunnels::by_id(&state.db, tunnel_id).await {
            if t.user_id != user_id {
                to.push(t.user_id);
            }
        }
        state.hub.notify_users(to, &msg);
    });
}

/// 這個 session 還該不該開著；不該的話回原因。/ Whether a session may stay open; the reason when it may not.
async fn lost(state: &AppState, s: &ProxySession) -> Option<&'static str> {
    if s.lease.device().is_closed() {
        return Some("the device connection ended");
    }
    if let Some(listen) = state.status.listen_ports() {
        if !u16::try_from(s.reverse_port).map(|p| listen.contains(&p)).unwrap_or(false) {
            return Some("the device went offline");
        }
    }
    if !db::settings::get_solo(&state.db).await.ok()?.proxy_enabled {
        return Some("the device proxy was turned off");
    }
    if !s.credential.is_live(&state.db).await? {
        return Some("the credential was revoked or expired");
    }
    let user = db::users::by_id(&state.db, s.user_id).await.ok()?;
    let Some(user) = user.filter(|u| u.is_active) else { return Some("the account was disabled") };
    if !state.features.allowed(&user, Feature::Proxy).await.ok()? {
        return Some("the device proxy was turned off for this account");
    }
    let Some(tunnel) = db::tunnels::by_id(&state.db, s.tunnel_id).await.ok()? else { return Some("the tunnel was deleted") };
    if tunnel.reverse_port != s.reverse_port || tunnel.require_step_up || !permissions::check_access(&state.db, s.user_id, &tunnel, Permission::View).await.ok()? {
        return Some("access to the tunnel was removed");
    }
    let allowed = permissions::allowed_usernames(&state.db, s.user_id, &tunnel).await.ok()?;
    if !allowed.iter().any(|u| u.username == s.account) {
        return Some("the account is no longer allowed");
    }
    None
}

/// 一輪：閒置的關掉、失去資格的切斷。回關了幾個。/ One pass: close the idle, cut the ones that lost access. Returns how many closed.
pub async fn reap_once(state: &AppState) -> usize {
    let mut n = 0;
    for s in state.proxy.list() {
        let reason = if s.open_connections() == 0 && s.idle_for() >= IDLE { Some("idle") } else { lost(state, &s).await };
        if let Some(r) = reason {
            if close(state, &s, r).await {
                n += 1;
            }
        }
    }
    n
}

pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(REAP_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if !state.proxy.list().is_empty() {
            reap_once(&state).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destinations_are_checked_before_they_reach_a_device() {
        assert_eq!(split_target("example.com:443"), Some(("example.com".into(), 443)));
        assert_eq!(split_target("192.168.1.20:8080"), Some(("192.168.1.20".into(), 8080)));
        assert_eq!(split_target("[fd00::1]:22"), Some(("fd00::1".into(), 22)));
        assert_eq!(split_target("localhost:3000"), Some(("localhost".into(), 3000)));
        for bad in ["example.com", "example.com:0", "example.com:99999", ":443", "-oProxyCommand=x:22", "a b:80", "exa$mple.com:80", "http://x:80", "x/y:80"] {
            assert_eq!(split_target(bad), None, "{bad}");
        }
        assert!(!valid_host(&"a".repeat(254)));
    }

    #[test]
    fn the_close_event_says_how_much_went_where() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MB");
        let s = close_summary("alice", "API token \"ci\"", "ubuntu", "idle", 3, 2048, 5 * 1024 * 1024, &["10.0.0.5:5432".into(), "example.com:443".into()], 0);
        assert_eq!(s, "alice via API token \"ci\": proxy through the device as ubuntu closed (idle) — 3 connection(s), 2.0 KB sent, 5.0 MB received; to 10.0.0.5:5432, example.com:443");
        let s = close_summary("bob", "Acme app", "root", "revoked", 0, 0, 0, &[], 0);
        assert!(s.ends_with("0 B received"), "{s}");
        assert!(close_summary("bob", "x", "root", "idle", 30, 1, 1, &["a:1".into()], 4).ends_with("to a:1 and 4 more"));
    }
}
