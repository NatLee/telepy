//! 依「隧道（reverse port）+ OS 帳號」共用的裝置 SSH 連線。
//!
//! - 第一次用到才連（`device::connect`：行程內經 gateway 開通道 + 一次 SSH 握手）；之後每個操作只在這條連線上開
//!   一條 channel，不再重新握手。
//! - **額度只算 session channel**（終端機分頁、exec、SFTP）：OpenSSH 的 MaxSessions（預設 10）只限這種。一條連線
//!   同時最多 [`MAX_SESSIONS`] 條；滿了，或裝置拒絕再開（MaxSessions 設得更小），就為同一個 key 再開一條連線。
//!   被拒時學到的上限 [`RELEARN`] 後失效 —— 被拒可能只是一時的（裝置要處理完我們的 close、shell 結束才放掉名額）。
//! - 只開 direct-tcpip 的用途（遠端瀏覽器的 SOCKS、遠端桌面 / RustDesk、區網主機那一跳）用 [`DevicePool::acquire`]
//!   借「傳輸」lease：不占額度，只讓連線不被收掉。
//! - SFTP：每條連線一條**共用**的 sftp channel（SFTP 請求有編號，多人同時用沒問題），檔案管理與 SFTP REST 都走它，
//!   不必每個請求重開 channel、重做 INIT。它占一個 session 額度；關了或卡住（`ssh::sftp_watch`）就換一條新的，
//!   沒人用超過 [`IDLE`] 就關掉。
//! - 沒有 lease 且閒置超過 [`IDLE`] 的連線由 reaper 關掉；裝置斷線時連線自己失效（`is_closed`），下次取用重連。
//! - 權限由呼叫端先檢查（`permissions::allowed_usernames`）。連線只是傳輸：不同 Telepy 使用者共用同一條時，
//!   各自是獨立的 channel（裝置端本來就只看得到同一把服務金鑰）。
//!
//! Device SSH connections shared per (tunnel port, OS account). Only session channels count against the
//! per-connection limit (that is all MaxSessions limits); direct-tcpip users hold a transport lease; SFTP shares
//! one channel per connection.

use std::ops::Deref;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use dashmap::DashMap;
use russh::client::{Handle, Msg};
use russh::{Channel, Disconnect};
use russh_sftp::client::SftpSession;

use crate::ssh::device::{self, ClientHandler, DeviceConn};
use crate::ssh::sftp_watch::Watch;
use crate::state::AppState;

/// 每條連線同時最多幾條 session channel。sshd 的 MaxSessions 預設 10；留 2 個，因為裝置要處理完我們的 close
/// （shell 還得先結束）才放掉名額，剛還回來的名額馬上再用可能被拒。
/// Session channels per connection: 2 below sshd's default MaxSessions of 10, because the device frees a slot
/// only after it has handled our close (and the shell has exited), so a slot reused at once may still be taken.
pub const MAX_SESSIONS: usize = 8;
/// 裝置拒絕開 channel 時學到的上限，過多久不再當真（再撞一次就再學一次）。
/// How long a limit learned from a refusal holds (a later refusal teaches it again).
pub const RELEARN: Duration = Duration::from_secs(120);
/// 沒人用的連線（和共用 SFTP channel）留多久。/ How long an unused connection (or shared SFTP channel) stays open.
pub const IDLE: Duration = Duration::from_secs(300);
pub const REAP_INTERVAL: Duration = Duration::from_secs(30);

/// 一條連線現在能開幾條 session channel：學到的上限還沒過期就用它，否則 [`MAX_SESSIONS`]。
/// The session limit in effect: a learned one while it is fresh, else [`MAX_SESSIONS`].
pub fn session_limit(learned: Option<(usize, Instant)>, now: Instant) -> usize {
    match learned {
        Some((n, at)) if now.saturating_duration_since(at) < RELEARN => n.min(MAX_SESSIONS),
        _ => MAX_SESSIONS,
    }
}

/// 一條連線上共用的 sftp channel。/ The SFTP channel shared on one connection.
struct SharedSftp {
    sftp: SftpSession,
    watch: Arc<Watch>,
    last_used: Mutex<Instant>,
}

struct PooledConn {
    conn: DeviceConn,
    reverse_port: i64,
    username: String,
    /// 開著的 session channel 數（含共用 SFTP 那條）。/ Open session channels, the shared SFTP one included.
    sessions: AtomicUsize,
    /// 借出中的 lease（任何一種）：有人在用就不收這條連線。/ Leases of any kind: the connection stays while > 0.
    holders: AtomicUsize,
    /// 裝置拒絕開 channel 時學到的上限與時間。/ The limit learned from a refusal, and when.
    learned: Mutex<Option<(usize, Instant)>>,
    /// 共用的 sftp channel；有的時候算一個 session。/ The shared SFTP channel; counts as one session while set.
    sftp: Mutex<Option<Arc<SharedSftp>>>,
    last_used: Mutex<Instant>,
}

impl PooledConn {
    fn closed(&self) -> bool {
        self.conn.device.is_closed()
    }

    fn has_session_room(&self, now: Instant) -> bool {
        !self.closed() && self.sessions.load(Ordering::SeqCst) < session_limit(*self.learned.lock().unwrap(), now)
    }

    /// 拿掉共用 SFTP（關了、卡住、或閒置）並還它的 session 額度。還有人拿著的話，channel 等他們放手才真的關。
    /// Drop the shared SFTP channel and give back its session; holders keep it open until they let go.
    fn forget_sftp(&self, slot: &mut Option<Arc<SharedSftp>>) {
        if slot.take().is_some() {
            self.sessions.fetch_sub(1, Ordering::SeqCst);
        }
    }

    /// 沒人拿著、閒置超過 `idle`（或已經壞掉）的共用 SFTP 關掉。/ Close the shared SFTP when unused or broken.
    fn reap_sftp(&self, idle: Duration) {
        let mut slot = self.sftp.lock().unwrap();
        let drop_it = slot.as_ref().is_some_and(|s| Arc::strong_count(s) == 1 && (!s.watch.healthy() || s.last_used.lock().unwrap().elapsed() >= idle));
        if drop_it {
            self.forget_sftp(&mut slot);
        }
    }
}

/// 借用中的連線；drop 時歸還。session lease 占一個 session 額度，傳輸 lease 不占。
/// A borrowed connection, returned on drop. A session lease takes a session slot, a transport lease does not.
pub struct Lease {
    conn: Arc<PooledConn>,
    session: bool,
}

impl Lease {
    fn transport(conn: Arc<PooledConn>) -> Self {
        conn.holders.fetch_add(1, Ordering::SeqCst);
        Self { conn, session: false }
    }

    fn session(conn: Arc<PooledConn>) -> Self {
        conn.holders.fetch_add(1, Ordering::SeqCst);
        conn.sessions.fetch_add(1, Ordering::SeqCst);
        Self { conn, session: true }
    }

    /// 把這個 session 的額度交給連線本身（共用 SFTP 用），自己變成傳輸 lease。
    /// Hand this session slot to the connection (the shared SFTP channel); the lease becomes a transport lease.
    fn into_transport(mut self) -> Self {
        self.session = false;
        self
    }

    pub fn device(&self) -> &Handle<ClientHandler> {
        &self.conn.conn.device
    }

    /// 這條連線屬於哪條隧道（reverse port）。/ The tunnel (reverse port) of this connection.
    pub fn reverse_port(&self) -> i64 {
        self.conn.reverse_port
    }

    /// 登入裝置的 OS 帳號。/ The OS account this connection is logged in as.
    pub fn username(&self) -> &str {
        &self.conn.username
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        *self.conn.last_used.lock().unwrap() = Instant::now();
        if self.session {
            self.conn.sessions.fetch_sub(1, Ordering::SeqCst);
        }
        self.conn.holders.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 借來的共用 SFTP。drop 只是放手，channel 留給下一個人。/ A handle on the shared SFTP channel; drop lets go.
pub struct PooledSftp {
    shared: Arc<SharedSftp>,
    lease: Lease,
}

impl PooledSftp {
    /// channel 還能用（沒關、沒卡住）。不能用時 [`PooledSftp::renew`] 換一條。
    /// The channel still works (not closed, not stuck); otherwise [`PooledSftp::renew`].
    pub fn healthy(&self) -> bool {
        self.shared.watch.healthy()
    }

    /// 換成連線池現在那條（壞掉的會被換掉）。/ Switch to the pool's current channel (a broken one is replaced).
    pub async fn renew(&mut self, state: &AppState) -> anyhow::Result<()> {
        *self = state.pool.sftp(state, self.lease.reverse_port(), self.lease.username()).await?;
        Ok(())
    }
}

impl Deref for PooledSftp {
    type Target = SftpSession;
    fn deref(&self) -> &SftpSession {
        &self.shared.sftp
    }
}

impl Drop for PooledSftp {
    fn drop(&mut self) {
        *self.shared.last_used.lock().unwrap() = Instant::now();
    }
}

#[derive(Default)]
struct Slot {
    /// 現有連線。同步鎖、短臨界區，從不跨 await。/ Live connections; a short critical section, never held across an await.
    conns: Mutex<Vec<Arc<PooledConn>>>,
    /// 同一個 key 一次只握手一條：要新連線的人在這裡排隊，能重用現成連線的人不必等。
    /// One handshake at a time per key; callers that can reuse a connection never wait for it.
    connecting: tokio::sync::Mutex<()>,
    /// 同一個 key 一次只開一條共用 SFTP。/ One shared SFTP channel being opened at a time per key.
    opening_sftp: tokio::sync::Mutex<()>,
}

impl Slot {
    fn live(&self) -> std::sync::MutexGuard<'_, Vec<Arc<PooledConn>>> {
        let mut conns = self.conns.lock().unwrap();
        conns.retain(|c| !c.closed());
        conns
    }

    /// 一條現成連線（傳輸 lease 不占額度）。剛學到「一條 channel 都開不了」的連線多半已經半死，跳過它、寧可新連。
    /// A live connection (a transport lease takes no slot), skipping one that just could not open any channel.
    fn lease_transport(&self) -> Option<Lease> {
        let now = Instant::now();
        self.live().iter().find(|c| session_limit(*c.learned.lock().unwrap(), now) > 0).map(|c| Lease::transport(c.clone()))
    }

    /// 還有 session 額度的現成連線。檢查與占用都在鎖裡，不會超借。
    /// A live connection with a free session slot; checked and taken under the lock.
    fn lease_session(&self) -> Option<Lease> {
        let now = Instant::now();
        self.live().iter().find(|c| c.has_session_room(now)).map(|c| Lease::session(c.clone()))
    }

    /// 現成、還能用的共用 SFTP；順手拿掉壞掉的。/ A working shared SFTP channel; broken ones are dropped on the way.
    fn shared_sftp(&self) -> Option<PooledSftp> {
        for c in self.live().iter() {
            let mut slot = c.sftp.lock().unwrap();
            match slot.as_ref() {
                Some(s) if s.watch.healthy() => return Some(PooledSftp { shared: s.clone(), lease: Lease::transport(c.clone()) }),
                Some(_) => {
                    tracing::info!(reverse_port = c.reverse_port, username = %c.username, "device pool: shared SFTP channel closed or stuck; opening a new one");
                    c.forget_sftp(&mut slot);
                }
                None => {}
            }
        }
        None
    }
}

/// 登入 shell 的答案留多久（`crate::shell_history`）。/ How long a login shell answer is kept.
const LOGIN_SHELL_TTL: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct DevicePool {
    slots: DashMap<(i64, String), Arc<Slot>>,
    handshakes: AtomicU64,
    /// (port, 帳號) 的登入 shell：開終端機前不必每次都 exec 問一次。/ Each account's login shell, cached.
    login_shells: DashMap<(i64, String), (crate::shell_history::LoginShell, Instant)>,
}

impl DevicePool {
    /// 這個 Arc 一直握到操作結束：reaper 看到 strong_count > 1 就不會把 slot 從 map 移掉（見 `reap`）。
    /// Held for the whole operation, so the reaper leaves the slot in the map meanwhile (see `reap`).
    fn slot(&self, reverse_port: i64, username: &str) -> Arc<Slot> {
        self.slots.entry((reverse_port, username.to_string())).or_default().clone()
    }

    /// 握手一條新連線，先借出（`lease` 決定哪一種）再放進 slot，別人不會搶在前面把它借滿。
    /// Handshake a new connection and lease it before adding it to the slot, so nobody fills it first.
    async fn connect(&self, state: &AppState, slot: &Slot, reverse_port: i64, username: &str, lease: fn(Arc<PooledConn>) -> Lease) -> anyhow::Result<Lease> {
        let conn = device::connect(state, username, reverse_port).await?;
        self.handshakes.fetch_add(1, Ordering::SeqCst);
        let pooled = Arc::new(PooledConn {
            conn,
            reverse_port,
            username: username.to_string(),
            sessions: AtomicUsize::new(0),
            holders: AtomicUsize::new(0),
            learned: Mutex::new(None),
            sftp: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
        });
        let leased = lease(pooled.clone());
        let connections = {
            let mut conns = slot.conns.lock().unwrap();
            conns.push(pooled);
            conns.len()
        };
        tracing::debug!(reverse_port, %username, connections, "device pool: new connection");
        Ok(leased)
    }

    /// 借一條到 (port, username) 的連線來開 direct-tcpip（不占 session 額度）：有現成的就用，否則新連一條。
    /// 要開 session channel（shell / exec / subsystem）請用 [`DevicePool::session_channel`]。
    /// Borrow a connection for direct-tcpip channels (no session slot). For session channels use `session_channel`.
    pub async fn acquire(&self, state: &AppState, reverse_port: i64, username: &str) -> anyhow::Result<Lease> {
        let slot = self.slot(reverse_port, username);
        if let Some(lease) = slot.lease_transport() {
            return Ok(lease);
        }
        let _connecting = slot.connecting.lock().await;
        if let Some(lease) = slot.lease_transport() {
            return Ok(lease);
        }
        self.connect(state, &slot, reverse_port, username, Lease::transport).await
    }

    /// 借一個 session 額度：有空位的現成連線優先，否則新連一條。/ A session slot: an existing connection first.
    async fn acquire_session(&self, state: &AppState, slot: &Slot, reverse_port: i64, username: &str) -> anyhow::Result<Lease> {
        if let Some(lease) = slot.lease_session() {
            return Ok(lease);
        }
        // 沒空位：排隊握手。輪到時再看一次，前一個人剛連好的那條可能就有位子。
        // No room: queue for a handshake, and re-check first since the previous one may have just added a connection.
        let _connecting = slot.connecting.lock().await;
        if let Some(lease) = slot.lease_session() {
            return Ok(lease);
        }
        self.connect(state, slot, reverse_port, username, Lease::session).await
    }

    /// 借一條連線並在上面開一條 session channel（shell / exec / subsystem 用）。
    /// 裝置拒絕再開 channel（MaxSessions）時，記下那條撐得住的數量（[`RELEARN`] 內有效）並換一條連線重試一次。
    /// Open a session channel; on a refusal, learn that connection's limit for a while and retry once elsewhere.
    pub async fn session_channel(&self, state: &AppState, reverse_port: i64, username: &str) -> anyhow::Result<(Lease, Channel<Msg>)> {
        let slot = self.slot(reverse_port, username);
        self.session_channel_in(state, &slot, reverse_port, username).await
    }

    async fn session_channel_in(&self, state: &AppState, slot: &Slot, reverse_port: i64, username: &str) -> anyhow::Result<(Lease, Channel<Msg>)> {
        let mut retried = false;
        loop {
            let lease = self.acquire_session(state, slot, reverse_port, username).await?;
            let channel = match lease.device().channel_open_session().await {
                Ok(c) => c,
                Err(e) => {
                    if retried {
                        return Err(e).context("open a channel to the device");
                    }
                    retried = true;
                    // 其他 session 還開著 → 裝置的 MaxSessions 到頂：這條的上限就是目前用量。
                    // 一條都開不了（連線已失效，例如裝置剛重連）→ 這條暫時不再借出 session，等 reaper 收或過期再試。
                    let others = lease.conn.sessions.load(Ordering::SeqCst).saturating_sub(1);
                    let limit = if lease.conn.closed() { 0 } else { others };
                    *lease.conn.learned.lock().unwrap() = Some((limit, Instant::now()));
                    tracing::info!(reverse_port, %username, limit, error = %e, "device pool: channel refused; retrying on another connection");
                    continue;
                }
            };
            return Ok((lease, channel));
        }
    }

    /// 借共用的 SFTP channel（沒有或壞掉就開一條新的，占一個 session 額度）。
    /// Borrow the shared SFTP channel, opening one (one session slot) when there is none or it broke.
    pub async fn sftp(&self, state: &AppState, reverse_port: i64, username: &str) -> anyhow::Result<PooledSftp> {
        let slot = self.slot(reverse_port, username);
        if let Some(sftp) = slot.shared_sftp() {
            return Ok(sftp);
        }
        let _opening = slot.opening_sftp.lock().await;
        if let Some(sftp) = slot.shared_sftp() {
            return Ok(sftp);
        }
        let (lease, channel) = self.session_channel_in(state, &slot, reverse_port, username).await?;
        // 失敗時 lease 跟著 drop，額度還回去。/ On failure the lease drops and the slot goes back.
        let (sftp, watch) = device::start_sftp_watched(channel).await?;
        let shared = Arc::new(SharedSftp { sftp, watch, last_used: Mutex::new(Instant::now()) });
        {
            let mut current = lease.conn.sftp.lock().unwrap();
            lease.conn.forget_sftp(&mut current);
            *current = Some(shared.clone());
        }
        // 這個 session 額度從此歸連線（拿掉共用 SFTP 時才還）。/ The connection owns the slot from now on.
        Ok(PooledSftp { shared, lease: lease.into_transport() })
    }

    /// 關掉沒有 lease 且閒置超過 `idle` 的連線（含已失效的）與沒人用的共用 SFTP；回傳關掉幾條連線。
    /// Close idle connections (and unused shared SFTP channels); returns how many connections were closed.
    pub fn reap(&self, idle: Duration) -> usize {
        let mut closed = 0;
        for slot in self.slots.iter() {
            let mut conns = slot.conns.lock().unwrap();
            conns.retain(|c| {
                let idle_for = c.last_used.lock().unwrap().elapsed();
                let keep = !c.closed() && !(c.holders.load(Ordering::SeqCst) == 0 && idle_for >= idle);
                if keep {
                    c.reap_sftp(idle);
                } else {
                    closed += 1;
                    let c = c.clone();
                    tokio::spawn(async move {
                        let _ = c.conn.device.disconnect(Disconnect::ByApplication, "idle", "en").await;
                    });
                }
                keep
            });
        }
        // 空的 slot 移掉。有人剛從 map 拿到這個 Arc、正要用（strong_count > 1）就留著，否則他接著建的連線會掛在
        // 一個已經不在 map 裡的 slot 上：沒人重用得到、也沒人回收。/ Drop empty slots, except one somebody just
        // fetched and is about to use: a connection added to an orphaned slot would be neither reused nor reaped.
        self.slots.retain(|_, s| Arc::strong_count(s) > 1 || !s.conns.lock().unwrap().is_empty());
        closed
    }

    pub async fn run_reaper(self: Arc<Self>) {
        loop {
            tokio::time::sleep(REAP_INTERVAL).await;
            let n = self.reap(IDLE);
            if n > 0 {
                tracing::debug!(closed = n, "device pool: reaped idle connections");
            }
        }
    }

    /// 目前 (port, username) 開著幾條連線。/ Live connections for a key.
    pub fn connections(&self, reverse_port: i64, username: &str) -> usize {
        self.slots
            .get(&(reverse_port, username.to_string()))
            .map(|s| s.conns.lock().unwrap().iter().filter(|c| !c.closed()).count())
            .unwrap_or(0)
    }

    /// 目前 (port, username) 開著幾條 session channel（含共用 SFTP）。/ Open session channels for a key.
    pub fn sessions(&self, reverse_port: i64, username: &str) -> usize {
        self.slots
            .get(&(reverse_port, username.to_string()))
            .map(|s| s.conns.lock().unwrap().iter().filter(|c| !c.closed()).map(|c| c.sessions.load(Ordering::SeqCst)).sum())
            .unwrap_or(0)
    }

    /// 開機以來總共握手幾次。/ Handshakes since start.
    pub fn handshakes(&self) -> u64 {
        self.handshakes.load(Ordering::SeqCst)
    }

    /// 這個帳號的登入 shell（一個 exec 問 `echo $SHELL $PSHOME`，看得懂的答案快取 10 分鐘；問不到 = Unknown、下次再問）。
    /// The account's login shell: one exec, a recognised answer cached for 10 minutes; a failure is retried next time.
    pub async fn login_shell(&self, state: &AppState, reverse_port: i64, username: &str) -> crate::shell_history::LoginShell {
        use crate::shell_history::{parse_probe, LoginShell, PROBE};
        let key = (reverse_port, username.to_string());
        if let Some(hit) = self.login_shells.get(&key).filter(|e| e.1.elapsed() < LOGIN_SHELL_TTL) {
            return hit.0.clone();
        }
        let probe = async {
            let (_lease, channel) = self.session_channel(state, reverse_port, username).await?;
            crate::ssh::exec::run_on(channel, PROBE, Duration::from_secs(8), 4096).await
        };
        let shell = match probe.await {
            Ok(r) => parse_probe(&r.stdout.text),
            Err(e) => {
                tracing::debug!(reverse_port, %username, error = format!("{e:#}"), "login shell probe failed");
                LoginShell::Unknown
            }
        };
        if shell != LoginShell::Unknown {
            self.login_shells.insert(key, (shell.clone(), Instant::now()));
        }
        shell
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_learned_limit_holds_for_a_while_then_expires() {
        let now = Instant::now();
        assert_eq!(session_limit(None, now), MAX_SESSIONS);
        assert_eq!(session_limit(Some((2, now)), now + RELEARN - Duration::from_secs(1)), 2);
        assert_eq!(session_limit(Some((2, now)), now + RELEARN), MAX_SESSIONS, "a refusal is not forever");
        assert_eq!(session_limit(Some((0, now)), now), 0, "a connection that cannot open any channel");
        assert_eq!(session_limit(Some((50, now)), now), MAX_SESSIONS, "never above the default");
    }
}
