//! AI（MCP）開的 SSH session：一條到裝置的 russh 連線，所有指令共用（不必每個指令重新握手），會自己關掉。
//!
//! 生命週期：
//! - 開：隧道須在 grant 的限制內、使用者有 VIEW 權限、目標 username 在允許清單（與 web terminal 完全同規則）、
//!   裝置在線、未超過每人上限（站台設定 `ai_max_sessions_per_user`）。
//! - 關：agent 呼叫 `ssh_session_close`、閒置超過 `ai_session_idle_timeout`（執行中的指令不算閒置）、存活超過
//!   `ai_session_max_lifetime`（一律關）、裝置離線、連線斷掉、grant 撤銷 / 過期、使用者停用、權限或 username 被拿掉。
//!   reaper 每 30 秒檢查一次；撤銷 grant 時立即關。
//! - MCP 2026-07-28 起沒有 transport session，所以 session 綁的是 OAuth grant（= 哪個 app），不是 MCP 連線。
//!
//! 每次開 / 關都寫稽核紀錄並通知 session 的使用者與隧道擁有者（`AI-SESSION-OPENED` / `AI-SESSION-CLOSED`）。
//! SSH sessions opened by AI agents over MCP: one russh connection per session, reused by every command, with
//! idle / lifetime / revocation / permission based expiry.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use dashmap::DashMap;
use russh::Disconnect;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Semaphore;

use crate::auth::mcp::McpPrincipal;
use crate::db::{self, settings::SiteSettings};
use crate::permissions::{self, Permission};
use crate::presence::{Entry, Kind, PresenceGuard};
use crate::sftp;
use crate::ssh::device::{self, DeviceConn};
use crate::state::AppState;
use crate::util::{db_time, now_db};

pub const REAP_INTERVAL: Duration = Duration::from_secs(30);
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(600);
/// 每個輸出串流（stdout / stderr 各自）預設與最多保留多少 bytes。/ Per-stream output budget.
pub const DEFAULT_MAX_OUTPUT: usize = 64 * 1024;
pub const MAX_OUTPUT: usize = 1024 * 1024;
pub const MAX_READ: usize = 1024 * 1024;
pub const MAX_LIST_ENTRIES: usize = 1000;
/// 同一個 session 同時執行的指令數（OpenSSH 預設 MaxSessions 10）。/ Concurrent commands per session.
pub const MAX_CONCURRENT_COMMANDS: usize = 4;
/// agent 能要求的最短 idle / lifetime。/ Shortest idle / lifetime an agent may ask for.
pub const MIN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    Idle,
    MaxLifetime,
    DeviceOffline,
    Disconnected,
    Revoked,
    PermissionRemoved,
    ClosedByUser,
    ClosedByAgent,
}

impl CloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CloseReason::Idle => "idle",
            CloseReason::MaxLifetime => "max_lifetime",
            CloseReason::DeviceOffline => "device_offline",
            CloseReason::Disconnected => "disconnected",
            CloseReason::Revoked => "revoked",
            CloseReason::PermissionRemoved => "permission_removed",
            CloseReason::ClosedByUser => "closed_by_user",
            CloseReason::ClosedByAgent => "closed_by_agent",
        }
    }
}

/// 站台設定 → 上限。/ Limits from the site settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub idle_timeout: Duration,
    pub max_lifetime: Duration,
    pub max_sessions_per_user: usize,
}

impl Limits {
    pub fn from_settings(s: &SiteSettings) -> Self {
        let secs = |v: i64, default: u64| Duration::from_secs(if v > 0 { v as u64 } else { default }).max(MIN_TIMEOUT);
        Self {
            idle_timeout: secs(s.ai_session_idle_timeout, 600),
            max_lifetime: secs(s.ai_session_max_lifetime, 7200),
            max_sessions_per_user: s.ai_max_sessions_per_user.max(0) as usize,
        }
    }
}

/// agent 要求的秒數只能縮短、不能超過上限（也不能短於 MIN_TIMEOUT）。/ Requests may only shorten the ceiling.
pub fn clamp_request(requested: Option<u64>, ceiling: Duration) -> Duration {
    let ceiling = ceiling.max(MIN_TIMEOUT);
    requested.map(|r| Duration::from_secs(r).clamp(MIN_TIMEOUT, ceiling)).unwrap_or(ceiling)
}

/// 純函式：時間面的關閉理由（壽命優先；執行中的指令不算閒置）。/ Time-based expiry.
pub fn expiry(age: Duration, idle: Duration, busy: bool, idle_timeout: Duration, max_lifetime: Duration) -> Option<CloseReason> {
    if age >= max_lifetime {
        Some(CloseReason::MaxLifetime)
    } else if !busy && idle >= idle_timeout {
        Some(CloseReason::Idle)
    } else {
        None
    }
}

pub struct AiSession {
    pub id: String,
    pub user_id: i64,
    pub user_name: String,
    pub grant_id: i64,
    pub client_name: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub tunnel_owner_id: i64,
    pub reverse_port: i64,
    pub target_username: String,
    pub idle_timeout: Duration,
    pub max_lifetime: Duration,
    pub created: Instant,
    pub created_utc: chrono::DateTime<chrono::Utc>,
    /// (monotonic, DB 格式的牆鐘時間)。/ Last activity (monotonic + wall clock).
    activity: Mutex<(Instant, String)>,
    in_flight: AtomicUsize,
    commands: AtomicU64,
    conn: DeviceConn,
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
    slots: Semaphore,
    /// 開 session 的 MCP 請求來源 IP。/ Client IP of the MCP request that opened it.
    pub ip: Option<String>,
    /// 存在期間算「在用這條隧道」。/ Counts as using the tunnel while the session exists.
    _presence: PresenceGuard,
}

/// 指令進行中（busy）；結束時更新最後活動時間。/ Marks the session busy for the duration of a call.
struct Busy<'a>(&'a AiSession);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.touch();
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AiSession {
    fn touch(&self) {
        *self.activity.lock().unwrap() = (Instant::now(), now_db());
    }
    fn begin(&self) -> Busy<'_> {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        self.touch();
        Busy(self)
    }
    pub fn busy(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst) > 0
    }
    pub fn commands(&self) -> u64 {
        self.commands.load(Ordering::SeqCst)
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
    /// 牆鐘的到期時間（最長壽命）。/ Wall-clock end of the maximum lifetime.
    pub fn expires_at(&self) -> String {
        db_time(self.created_utc + chrono::Duration::from_std(self.max_lifetime).unwrap_or_default())
    }
    pub fn time_expiry(&self) -> Option<CloseReason> {
        expiry(self.created.elapsed(), self.idle_for(), self.busy(), self.idle_timeout, self.max_lifetime)
    }

    /// SFTP subsystem 第一次用時才開，之後共用。每次取用先探一下（`realpath .`，順便拿到家目錄）：
    /// channel 已經不在（裝置端關掉 sftp-server、連線重置…）就丟掉重開，不然這個 session 之後每個 sftp_* 都會失敗。
    /// 回傳 (session, 家目錄)。/ Opened lazily and shared; probed on every use (which also yields the home
    /// directory) and reopened when the channel is gone. Returns (session, home).
    async fn sftp(&self) -> anyhow::Result<(Arc<SftpSession>, String)> {
        let mut slot = self.sftp.lock().await;
        if let Some(s) = slot.as_ref() {
            match s.canonicalize(".").await {
                Ok(home) => return Ok((s.clone(), home)),
                // 伺服器有回應（只是路徑解析失敗）：channel 活著。/ The server answered: the channel is alive.
                Err(russh_sftp::client::error::Error::Status(_)) => return Ok((s.clone(), "/".to_string())),
                Err(e) => {
                    tracing::info!(session = %self.id, error = %e, "AI session: SFTP channel is gone; reopening");
                    *slot = None;
                }
            }
        }
        let s = Arc::new(self.conn.sftp().await.context("open the SFTP subsystem (is sftp enabled on the device?)")?);
        let home = sftp::home(&s).await;
        *slot = Some(s.clone());
        Ok((s, home))
    }
}

#[derive(Default)]
pub struct AiSessions {
    map: DashMap<String, Arc<AiSession>>,
    /// 正在連線中（尚未放進 map）的數量，避免並行的 open 超過上限。/ Opens in progress, counted against the cap.
    opening: Mutex<HashMap<i64, usize>>,
}

struct Reservation<'a> {
    reg: &'a AiSessions,
    user_id: i64,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut g = self.reg.opening.lock().unwrap();
        if let Some(n) = g.get_mut(&self.user_id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                g.remove(&self.user_id);
            }
        }
    }
}

impl AiSessions {
    pub fn get(&self, id: &str) -> Option<Arc<AiSession>> {
        self.map.get(id).map(|s| s.clone())
    }
    /// 依建立時間排序。/ Sorted by creation time.
    pub fn list(&self) -> Vec<Arc<AiSession>> {
        let mut v: Vec<Arc<AiSession>> = self.map.iter().map(|e| e.value().clone()).collect();
        v.sort_by_key(|s| s.created);
        v
    }
    pub fn count_for_user(&self, user_id: i64) -> usize {
        self.map.iter().filter(|e| e.value().user_id == user_id).count()
    }
    fn reserve(&self, user_id: i64, max: usize) -> Option<Reservation<'_>> {
        let mut g = self.opening.lock().unwrap();
        let pending = g.get(&user_id).copied().unwrap_or(0);
        if self.count_for_user(user_id) + pending >= max {
            return None;
        }
        *g.entry(user_id).or_insert(0) += 1;
        Some(Reservation { reg: self, user_id })
    }
}

// ---------------------------------------------------------------- open / close / reap

pub struct OpenRequest {
    pub tunnel_id: i64,
    pub username: Option<String>,
    pub idle_timeout_s: Option<u64>,
    pub max_lifetime_s: Option<u64>,
}

/// 開 session。錯誤字串直接給 agent 看（說明怎麼修）。/ Errors are shown to the agent as-is.
pub async fn open(state: &AppState, p: &McpPrincipal, req: OpenRequest) -> Result<Arc<AiSession>, String> {
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
        let open: Vec<String> = state.ai.list().iter().filter(|s| s.user_id == p.user.id).map(|s| format!("{} ({})", s.id, s.tunnel_name)).collect();
        return Err(format!(
            "You already have {} open AI session(s); the limit is {}. Close one with ssh_session_close first: {}",
            open.len(),
            limits.max_sessions_per_user,
            open.join(", ")
        ));
    };
    let conn = device::connect(&state, &username, tunnel.reverse_port)
        .await
        .map_err(|e| format!("Cannot connect to '{}' as {username}: {e:#}", tunnel.host_friendly_name))?;
    let now = Instant::now();
    let session = Arc::new(AiSession {
        id: format!("ais_{}", crate::util::uuid_hex()),
        user_id: p.user.id,
        user_name: p.user.username.clone(),
        grant_id: p.grant_id,
        client_name: p.client_name.clone(),
        tunnel_id: tunnel.id,
        tunnel_name: tunnel.host_friendly_name.clone(),
        tunnel_owner_id: tunnel.user_id,
        reverse_port: tunnel.reverse_port,
        target_username: username,
        idle_timeout: clamp_request(req.idle_timeout_s, limits.idle_timeout),
        max_lifetime: clamp_request(req.max_lifetime_s, limits.max_lifetime),
        created: now,
        created_utc: chrono::Utc::now(),
        activity: Mutex::new((now, now_db())),
        in_flight: AtomicUsize::new(0),
        commands: AtomicU64::new(0),
        conn,
        sftp: tokio::sync::Mutex::new(None),
        slots: Semaphore::new(MAX_CONCURRENT_COMMANDS),
        ip: p.ip.clone(),
        _presence: state.presence.join(Entry { client: Some(p.client_name.clone()), ..Entry::new(tunnel.id, p.user.id, &p.user.username, Kind::Ai, p.ip.clone()) }),
    });
    state.ai.map.insert(session.id.clone(), session.clone());
    tracing::info!(session = %session.id, user = %session.user_name, client = %session.client_name, tunnel = %session.tunnel_name, username = %session.target_username, "AI session opened");
    notify(state, &session, "AI-SESSION-OPENED", None);
    Ok(session)
}

/// 關閉並移出 registry；寫稽核（`ssh_session_close`，detail = 原因）並通知。重複關閉回 None。
/// Close and forget a session; audited and notified once.
pub async fn close(state: &AppState, id: &str, reason: CloseReason) -> Option<Arc<AiSession>> {
    let (_, s) = state.ai.map.remove(id)?;
    let _ = s.conn.device.disconnect(Disconnect::ByApplication, reason.as_str(), "en").await;
    tracing::info!(session = %s.id, tunnel = %s.tunnel_name, reason = reason.as_str(), "AI session closed");
    audit(
        state,
        db::ai_audit::NewEvent {
            user_id: s.user_id,
            grant_id: Some(s.grant_id),
            client_name: &s.client_name,
            tool: "ssh_session_close",
            tunnel_id: Some(s.tunnel_id),
            session_id: Some(&s.id),
            target_username: Some(&s.target_username),
            detail: Some(&format!("reason: {}; commands: {}", reason.as_str(), s.commands())),
            ok: true,
            duration_ms: Some(s.created.elapsed().as_millis() as i64),
            ip: s.ip.as_deref(),
            ..Default::default()
        },
    )
    .await;
    notify(state, &s, "AI-SESSION-CLOSED", Some(reason));
    Some(s)
}

/// grant 撤銷時立即關掉它的所有 session。/ Close every session of a grant (on revocation).
pub async fn close_for_grant(state: &AppState, grant_id: i64, reason: CloseReason) -> usize {
    let ids: Vec<String> = state.ai.list().iter().filter(|s| s.grant_id == grant_id).map(|s| s.id.clone()).collect();
    let mut n = 0;
    for id in ids {
        if close(state, &id, reason).await.is_some() {
            n += 1;
        }
    }
    n
}

/// 權限面的關閉理由：grant / 使用者 / 隧道 / 權限 / username 是否仍然有效（DB 錯誤時不關）。
async fn authorization_lost(state: &AppState, s: &AiSession) -> Option<CloseReason> {
    let grant = db::oauth::grant_by_id(&state.db, s.grant_id).await.ok()?;
    if !grant.map(|g| g.is_active(&now_db())).unwrap_or(false) {
        return Some(CloseReason::Revoked);
    }
    if !db::users::by_id(&state.db, s.user_id).await.ok()?.map(|u| u.is_active).unwrap_or(false) {
        return Some(CloseReason::Revoked);
    }
    let Some(tunnel) = db::tunnels::by_id(&state.db, s.tunnel_id).await.ok()? else {
        return Some(CloseReason::PermissionRemoved);
    };
    if tunnel.reverse_port != s.reverse_port || !permissions::check_access(&state.db, s.user_id, &tunnel, Permission::View).await.ok()? {
        return Some(CloseReason::PermissionRemoved);
    }
    let allowed = permissions::allowed_usernames(&state.db, s.user_id, &tunnel).await.ok()?;
    if !allowed.iter().any(|u| u.username == s.target_username) {
        return Some(CloseReason::PermissionRemoved);
    }
    None
}

/// 檢查一輪。/ One reaper pass.
pub async fn reap_once(state: &AppState) {
    let listen = state.status.listen_ports();
    for s in state.ai.list() {
        let reason = if let Some(r) = s.time_expiry() {
            Some(r)
        } else if s.conn.device.is_closed() {
            Some(CloseReason::Disconnected)
        } else if listen.as_ref().is_some_and(|l| !u16::try_from(s.reverse_port).map(|p| l.contains(&p)).unwrap_or(false)) {
            Some(CloseReason::DeviceOffline)
        } else {
            authorization_lost(state, &s).await
        };
        if let Some(r) = reason {
            close(state, &s.id, r).await;
        }
    }
}

pub async fn run_reaper(state: AppState, interval: Duration) {
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        reap_once(&state).await;
    }
}

fn notify(state: &AppState, s: &AiSession, action: &str, reason: Option<CloseReason>) {
    let details = match reason {
        None => format!("{} ({}) opened an SSH session to '{}' as {}", s.client_name, s.user_name, s.tunnel_name, s.target_username),
        Some(r) => format!("The AI session of {} ({}) on '{}' was closed ({})", s.client_name, s.user_name, s.tunnel_name, r.as_str()),
    };
    let mut msg = json!({
        "action": action,
        "details": details,
        "tunnel_id": s.tunnel_id,
        "session_id": s.id,
        "by": s.user_name,
        "client": s.client_name,
    });
    if let Some(r) = reason {
        msg["reason"] = json!(r.as_str());
    }
    state.hub.notify_users([s.user_id, s.tunnel_owner_id], &msg);
}

/// 寫稽核；失敗只記 log（不影響 tool 結果）。/ Write an audit row; failures are only logged.
pub async fn audit(state: &AppState, e: db::ai_audit::NewEvent<'_>) {
    if let Err(err) = db::ai_audit::insert(&state.db, e).await {
        tracing::warn!(error = %err, "cannot write the AI audit event");
    }
}

// ---------------------------------------------------------------- exec

pub use crate::ssh::exec::{Captured, ExecResult, HeadTail};

/// 在 session 上開一個 exec channel 跑指令（無 PTY）。逾時送 KILL 並關 channel。
/// Run a command on its own exec channel (no PTY); on timeout send KILL and close the channel.
pub async fn exec(s: &AiSession, command: &str, timeout: Duration, max_output: usize) -> anyhow::Result<ExecResult> {
    let _slot = s.slots.acquire().await.context("session is closing")?;
    let _busy = s.begin();
    s.commands.fetch_add(1, Ordering::SeqCst);
    crate::ssh::exec::run(&s.conn.device, command, timeout, max_output).await
}

// ---------------------------------------------------------------- sftp

#[derive(Debug, Clone)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<sftp::Entry>,
    pub truncated: bool,
}

pub async fn sftp_list(s: &AiSession, path: &str) -> anyhow::Result<Listing> {
    let _busy = s.begin();
    let (session, home) = s.sftp().await?;
    let path = sftp::resolve_path(path, &home);
    let mut entries = sftp::list_dir(&session, &path).await.with_context(|| format!("list {path}"))?;
    let truncated = entries.len() > MAX_LIST_ENTRIES;
    entries.truncate(MAX_LIST_ENTRIES);
    Ok(Listing { path, entries, truncated })
}

#[derive(Debug, Clone)]
pub struct ReadResult {
    pub path: String,
    pub size: u64,
    pub offset: u64,
    pub data: Vec<u8>,
    pub eof: bool,
}

pub async fn sftp_read(s: &AiSession, path: &str, offset: u64, max_bytes: usize) -> anyhow::Result<ReadResult> {
    let _busy = s.begin();
    let (session, home) = s.sftp().await?;
    let path = sftp::resolve_path(path, &home);
    let meta = session.metadata(&path).await.with_context(|| format!("stat {path}"))?;
    if meta.is_dir() {
        bail!("{path} is a directory; use sftp_list");
    }
    let size = meta.size.unwrap_or(0);
    let mut f = session.open(&path).await.with_context(|| format!("open {path}"))?;
    if offset > 0 {
        f.seek(std::io::SeekFrom::Start(offset)).await?;
    }
    let mut data = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut buf = vec![0u8; 32 * 1024];
    while data.len() < max_bytes {
        let want = (max_bytes - data.len()).min(buf.len());
        let n = f.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
    }
    let eof = offset + data.len() as u64 >= size;
    Ok(ReadResult { path, size, offset, data, eof })
}

pub async fn sftp_write(s: &AiSession, path: &str, data: &[u8], append: bool) -> anyhow::Result<(String, u64)> {
    let _busy = s.begin();
    let (session, home) = s.sftp().await?;
    let path = sftp::resolve_path(path, &home);
    let flags = OpenFlags::WRITE | OpenFlags::CREATE | if append { OpenFlags::APPEND } else { OpenFlags::TRUNCATE };
    let mut f = session.open_with_flags(&path, flags).await.with_context(|| format!("open {path} for writing"))?;
    if append {
        f.seek(std::io::SeekFrom::End(0)).await?;
    }
    f.write_all(data).await.with_context(|| format!("write {path}"))?;
    f.shutdown().await?;
    Ok((path, data.len() as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_rules() {
        let (idle, max) = (Duration::from_secs(600), Duration::from_secs(7200));
        assert_eq!(expiry(Duration::from_secs(10), Duration::from_secs(10), false, idle, max), None);
        assert_eq!(expiry(Duration::from_secs(700), Duration::from_secs(601), false, idle, max), Some(CloseReason::Idle));
        assert_eq!(expiry(Duration::from_secs(700), Duration::from_secs(601), true, idle, max), None, "a running command is not idle");
        assert_eq!(expiry(Duration::from_secs(7200), Duration::from_secs(0), true, idle, max), Some(CloseReason::MaxLifetime), "the lifetime is hard");
    }

    #[test]
    fn requests_only_shorten_the_limits() {
        let ceiling = Duration::from_secs(600);
        assert_eq!(clamp_request(None, ceiling), ceiling);
        assert_eq!(clamp_request(Some(60), ceiling), Duration::from_secs(60));
        assert_eq!(clamp_request(Some(99_999), ceiling), ceiling);
        assert_eq!(clamp_request(Some(1), ceiling), MIN_TIMEOUT);
        assert_eq!(clamp_request(Some(1), Duration::from_secs(1)), MIN_TIMEOUT, "a tiny ceiling cannot panic");
    }

    #[test]
    fn limits_from_settings() {
        let mut s = SiteSettings {
            id: 1,
            allow_registration: false,
            valid_register_domains: String::new(),
            remote_browser_session_idle_timeout: 60,
            remote_browser_max_sessions: 10,
            remote_browser_geometry: String::new(),
            remote_browser_ssh_timeout: 30,
            remote_browser_ssh_attempts: 2,
            remote_browser_kasm_create_timeout: 30,
            remote_browser_homepage: String::new(),
            remote_browser_language: String::new(),
            ai_session_idle_timeout: 600,
            ai_session_max_lifetime: 7200,
            ai_max_sessions_per_user: 3,
            lan_scan_enabled: true,
        };
        assert_eq!(Limits::from_settings(&s), Limits { idle_timeout: Duration::from_secs(600), max_lifetime: Duration::from_secs(7200), max_sessions_per_user: 3 });
        s.ai_session_idle_timeout = 0;
        s.ai_session_max_lifetime = 2;
        s.ai_max_sessions_per_user = -1;
        let l = Limits::from_settings(&s);
        assert_eq!((l.idle_timeout, l.max_lifetime, l.max_sessions_per_user), (Duration::from_secs(600), MIN_TIMEOUT, 0));
    }

    #[test]
    fn reservations_count_against_the_cap() {
        let reg = AiSessions::default();
        let a = reg.reserve(1, 2).unwrap();
        let b = reg.reserve(1, 2).unwrap();
        assert!(reg.reserve(1, 2).is_none());
        assert!(reg.reserve(2, 2).is_some(), "per user");
        drop(a);
        assert!(reg.reserve(1, 2).is_some());
        drop(b);
        assert!(reg.opening.lock().unwrap().is_empty(), "every reservation is released on drop");
    }
}
