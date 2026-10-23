//! 依「隧道（reverse port）+ OS 帳號」共用的裝置 SSH 連線。
//!
//! - 第一次用到才連（`device::connect`：行程內經 gateway 開通道 + 一次 SSH 握手）；之後 SFTP REST、檔案管理……
//!   每個操作只在這條連線上開一條 channel，不再重新握手。
//! - 一條連線同時最多 [`MAX_CHANNELS`] 個 lease（OpenSSH sshd 的 MaxSessions 預設 10）。滿了，或裝置拒絕再開
//!   channel（MaxSessions 設得更小），就為同一個 key 再開一條連線；之後那條的額度就是它實際撐得住的數量。
//! - 沒有 lease 且閒置超過 [`IDLE`] 的連線由 reaper 關掉；裝置斷線時連線自己失效（`is_closed`），下次取用重連。
//! - 權限由呼叫端先檢查（`permissions::allowed_usernames`）。連線只是傳輸：不同 Telepy 使用者共用同一條時，
//!   各自是獨立的 channel（裝置端本來就只看得到同一把服務金鑰）。
//! - 誰在用：SFTP REST、檔案管理（含 exec 備援）、網頁終端機（一個分頁一條 PTY channel）、遠端瀏覽器的 SOCKS 與
//!   區網主機那一跳（direct-tcpip；MaxSessions 只限 session channel，不限 direct-tcpip，所以它們只占一個 lease）。
//! Device SSH connections shared per (tunnel port, OS account): one handshake, then one channel per operation.

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
use crate::state::AppState;

/// 每條連線同時最多幾個 lease（留 2 個給 sshd 預設 MaxSessions 10 的餘裕）。
pub const MAX_CHANNELS: usize = 8;
/// 沒人用的連線留多久。/ How long an unused connection stays open.
pub const IDLE: Duration = Duration::from_secs(300);
pub const REAP_INTERVAL: Duration = Duration::from_secs(30);

struct PooledConn {
    conn: DeviceConn,
    active: AtomicUsize,
    /// 這條連線同時最多幾個 lease；裝置拒絕開 channel 時降到當下撐得住的數量。
    capacity: AtomicUsize,
    last_used: Mutex<Instant>,
}

impl PooledConn {
    fn closed(&self) -> bool {
        self.conn.device.is_closed()
    }
    fn has_room(&self) -> bool {
        !self.closed() && self.active.load(Ordering::SeqCst) < self.capacity.load(Ordering::SeqCst)
    }
}

/// 借用中的連線（= 一條 channel 的額度）；drop 時歸還。
pub struct Lease {
    conn: Arc<PooledConn>,
}

impl Lease {
    fn new(conn: Arc<PooledConn>) -> Self {
        conn.active.fetch_add(1, Ordering::SeqCst);
        Self { conn }
    }

    pub fn device(&self) -> &Handle<ClientHandler> {
        &self.conn.conn.device
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        *self.conn.last_used.lock().unwrap() = Instant::now();
        self.conn.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 借來的 SFTP session。欄位順序 = drop 順序：先關 SFTP channel，再歸還 lease。
pub struct PooledSftp {
    pub sftp: SftpSession,
    _lease: Lease,
}

impl Deref for PooledSftp {
    type Target = SftpSession;
    fn deref(&self) -> &SftpSession {
        &self.sftp
    }
}

#[derive(Default)]
struct Slot {
    /// 現有連線。同步鎖、短臨界區，從不跨 await。/ Live connections; a short critical section, never held across an await.
    conns: Mutex<Vec<Arc<PooledConn>>>,
    /// 同一個 key 一次只握手一條：要新連線的人在這裡排隊，能重用現成連線的人不必等。
    /// One handshake at a time per key; callers that can reuse a connection never wait for it.
    connecting: tokio::sync::Mutex<()>,
}

impl Slot {
    /// 有空位的現成連線就借出。/ Lease an existing connection with room, if any.
    fn lease_if_room(&self) -> Option<Lease> {
        let mut conns = self.conns.lock().unwrap();
        conns.retain(|c| !c.closed());
        conns.iter().find(|c| c.has_room()).map(|c| Lease::new(c.clone()))
    }
}

#[derive(Default)]
pub struct DevicePool {
    slots: DashMap<(i64, String), Arc<Slot>>,
    handshakes: AtomicU64,
}

impl DevicePool {
    /// 借一條到 (port, username) 的連線：有空位的現成連線優先，否則新連一條。
    pub async fn acquire(&self, state: &AppState, reverse_port: i64, username: &str) -> anyhow::Result<Lease> {
        // 這個 Arc 一直握到回傳：reaper 看到 strong_count > 1 就不會把 slot 從 map 移掉（見 `reap`）。
        // Held until we return, so the reaper leaves the slot in the map while we use it (see `reap`).
        let slot = self.slots.entry((reverse_port, username.to_string())).or_default().clone();
        if let Some(lease) = slot.lease_if_room() {
            return Ok(lease);
        }
        // 沒空位：排隊握手。輪到時再看一次，前一個人剛連好的那條可能就有位子。
        // No room: queue for a handshake, and re-check first since the previous one may have just added a connection.
        let _connecting = slot.connecting.lock().await;
        if let Some(lease) = slot.lease_if_room() {
            return Ok(lease);
        }
        let conn = device::connect(state, username, reverse_port).await?;
        self.handshakes.fetch_add(1, Ordering::SeqCst);
        let pooled = Arc::new(PooledConn { conn, active: AtomicUsize::new(0), capacity: AtomicUsize::new(MAX_CHANNELS), last_used: Mutex::new(Instant::now()) });
        let lease = Lease::new(pooled.clone());
        let connections = {
            let mut conns = slot.conns.lock().unwrap();
            conns.push(pooled);
            conns.len()
        };
        tracing::debug!(reverse_port, %username, connections, "device pool: new connection");
        Ok(lease)
    }

    /// 借一條連線並開 `sftp` 子系統（用完 drop 即關 channel、還 lease）。
    pub async fn sftp(&self, state: &AppState, reverse_port: i64, username: &str) -> anyhow::Result<PooledSftp> {
        let (lease, channel) = self.session_channel(state, reverse_port, username).await?;
        let sftp = device::start_sftp(channel).await?;
        Ok(PooledSftp { sftp, _lease: lease })
    }

    /// 借一條連線並在上面開一條 session channel（shell / exec / subsystem 用）。
    /// 裝置拒絕再開 channel（MaxSessions）時，把那條的額度降到目前用量並換一條新連線重試一次。
    pub async fn session_channel(&self, state: &AppState, reverse_port: i64, username: &str) -> anyhow::Result<(Lease, Channel<Msg>)> {
        let mut retried = false;
        loop {
            let lease = self.acquire(state, reverse_port, username).await?;
            let channel = match lease.device().channel_open_session().await {
                Ok(c) => c,
                Err(e) => {
                    if retried {
                        return Err(e).context("open a channel to the device");
                    }
                    retried = true;
                    // 其他 lease 還在用 → 裝置的 MaxSessions 到頂：這條的額度就是目前用量。
                    // 一條都開不了（連線已失效，例如裝置剛重連）→ 這條不再借出，等 reaper 收。
                    let others = lease.conn.active.load(Ordering::SeqCst) - 1;
                    let capacity = if lease.conn.closed() { 0 } else { others };
                    lease.conn.capacity.store(capacity, Ordering::SeqCst);
                    tracing::info!(reverse_port, %username, capacity, error = %e, "device pool: channel refused; retrying on another connection");
                    continue;
                }
            };
            return Ok((lease, channel));
        }
    }

    /// 關掉沒有 lease 且閒置超過 `idle` 的連線（含已失效的）；回傳關掉幾條。
    pub fn reap(&self, idle: Duration) -> usize {
        let mut closed = 0;
        for slot in self.slots.iter() {
            let mut conns = slot.conns.lock().unwrap();
            conns.retain(|c| {
                let idle_for = c.last_used.lock().unwrap().elapsed();
                let keep = !c.closed() && !(c.active.load(Ordering::SeqCst) == 0 && idle_for >= idle);
                if !keep {
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

    /// 開機以來總共握手幾次。/ Handshakes since start.
    pub fn handshakes(&self) -> u64 {
        self.handshakes.load(Ordering::SeqCst)
    }
}
