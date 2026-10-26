//! 網頁內的 RustDesk：瀏覽器裡跑 RustDesk 的開源 TypeScript 核心（解碼 VP9 / AV1 / H.264），Telepy 只做中繼。
//!
//! ```text
//! 瀏覽器（Telepy 頁面 + rustdesk-web-core.js）
//!   │ wss /ws/rustdesk/<session>/?ticket=…   同一條網址兩個角色，看第一則訊息：
//!   │   punch_hole_request → 當 hbbs：回 relay_response（指向自己）
//!   │   request_relay      → 當 hbbr：之後 WS 訊息 ⇄ BytesCodec 框
//!   ▼
//! 後端 ws/rustdesk.rs ── russh direct-tcpip 通道（連線池）→ 裝置 127.0.0.1:21118（RustDesk 的 Direct IP）或區網主機
//! ```
//!
//! 不需要 hbbs / hbbr、不開新的公開埠、不用 UDP。裝置的 Direct IP 連線本身不加密（RustDesk 設計如此：沒有金鑰
//! 交換，第一則訊息就是密碼挑戰），整段由 SSH 隧道與 TLS 保護；RustDesk 的固定密碼由瀏覽器端核心直接雜湊回應，
//! **後端看不到密碼**。權限和桌面一樣：隧道 VIEW + 允許的裝置帳號 + step-up。
//! In-browser RustDesk: the browser runs RustDesk's open TypeScript core, Telepy fakes hbbs/hbbr on one WebSocket
//! and re-frames messages into a direct-tcpip channel to the device's Direct IP port. See `docs/rustdesk-spike.md`.

pub mod codec;
pub mod idserver;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::WebSocket;
use dashmap::DashMap;
use tokio::sync::{oneshot, Notify};

use crate::db::Db;
use crate::desktop::{Prepared, Target};
use crate::util::random_alnum;

/// 票證壽命：start 回來後瀏覽器要在這段時間內開兩條 WS（hbbs 角色、relay 角色）。/ Both sockets must open within this.
pub const TICKET_TTL: Duration = Duration::from_secs(60);
pub const REAP_INTERVAL: Duration = Duration::from_secs(10);
/// RustDesk 的 Direct IP Access 預設埠。/ RustDesk's default Direct IP port.
pub const DEFAULT_PORT: u16 = 21118;

/// 不是自己的 session（也不是管理員）。/ Someone else's session and not an admin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotOwner;

/// 同一張票證的兩個角色，各用一次。/ The two roles one ticket admits, once each.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    /// 假 hbbs：回 relay_response。/ Fake hbbs.
    Id,
    /// 假 hbbr：接到裝置。/ Fake hbbr, bridged to the device.
    Relay,
}

/// 這個 session 怎麼到裝置。/ How a session reaches the device.
pub enum Via {
    /// 經裝置的 Telepy 隧道：連線池的 direct-tcpip 通道接到 Direct IP 埠（start 時就開好）。
    /// Through the device's tunnel: a pooled direct-tcpip channel to the Direct IP port, opened at start.
    Tunnel {
        tunnel_id: i64,
        tunnel_name: String,
        reverse_port: i64,
        hop_username: String,
        target: Target,
        handoff: Mutex<Option<Box<Prepared>>>,
    },
    /// Telepy 是這台 RustDesk 的 ID / 中繼伺服器：瀏覽器的 punch 推給裝置，裝置的中繼連線以 uuid 交過來。
    /// Telepy is the device's ID / relay server: the punch is pushed to the device, its relay socket is handed over by uuid.
    IdServer {
        device_id: i64,
        rustdesk_id: String,
        device_name: String,
        relay_rx: Mutex<Option<oneshot::Receiver<WebSocket>>>,
    },
}

pub struct Session {
    pub id: String,
    pub user_id: i64,
    pub user_name: String,
    pub via: Via,
    /// 用了憑證庫的哪一筆（日誌用）。/ The saved login used, for the logs.
    pub saved_label: Option<String>,
    pub created: Instant,
    ticket: Mutex<Option<(String, Instant)>>,
    id_claimed: AtomicBool,
    pub connected: AtomicBool,
    pub stop: Notify,
    stop_reason: Mutex<Option<&'static str>>,
}

impl Session {
    pub fn take_handoff(&self) -> Option<Prepared> {
        match &self.via {
            Via::Tunnel { handoff, .. } => handoff.lock().unwrap().take().map(|b| *b),
            Via::IdServer { .. } => None,
        }
    }

    /// ID 伺服器路線：這次 punch 的中繼（裝置的 socket 會從這裡來）。/ The relay receiver set by the latest punch.
    pub fn set_relay_rx(&self, rx: oneshot::Receiver<WebSocket>) {
        if let Via::IdServer { relay_rx, .. } = &self.via {
            *relay_rx.lock().unwrap() = Some(rx);
        }
    }

    pub fn take_relay_rx(&self) -> Option<oneshot::Receiver<WebSocket>> {
        match &self.via {
            Via::IdServer { relay_rx, .. } => relay_rx.lock().unwrap().take(),
            Via::Tunnel { .. } => None,
        }
    }

    /// 經隧道時的隧道 id（Logs 與 presence 用）。/ The tunnel, when going through one.
    pub fn tunnel_id(&self) -> Option<i64> {
        match &self.via {
            Via::Tunnel { tunnel_id, .. } => Some(*tunnel_id),
            Via::IdServer { .. } => None,
        }
    }

    pub fn ticket_expired(&self) -> bool {
        self.ticket.lock().unwrap().as_ref().map(|(_, exp)| *exp <= Instant::now()).unwrap_or(true)
    }

    pub fn request_stop(&self, reason: &'static str) {
        let mut r = self.stop_reason.lock().unwrap();
        if r.is_none() {
            *r = Some(reason);
        }
        self.stop.notify_one();
    }

    pub fn stop_reason(&self) -> Option<&'static str> {
        *self.stop_reason.lock().unwrap()
    }

    /// 日誌用的一句話。/ One line for the logs.
    pub fn describe(&self) -> String {
        let saved = self.saved_label.as_deref().map(|l| format!(" with saved login '{l}'")).unwrap_or_default();
        match &self.via {
            Via::Tunnel { tunnel_name, hop_username, target, .. } => {
                let to = if target.lan_host_id.is_some() { format!("{}:{}", target.host, target.port) } else { format!("device:{}", target.port) };
                format!("RustDesk in the browser by {} to {} through {}@{}{saved}", self.user_name, to, hop_username, tunnel_name)
            }
            Via::IdServer { rustdesk_id, device_name, .. } => format!("RustDesk in the browser by {} to {} ({}) through Telepy's RustDesk server{saved}", self.user_name, device_name, rustdesk_id),
        }
    }
}

/// 經隧道的新 session。/ A new session through a tunnel.
pub struct NewSession {
    pub user_id: i64,
    pub user_name: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub reverse_port: i64,
    pub hop_username: String,
    pub target: Target,
    pub prepared: Prepared,
    pub saved_label: Option<String>,
}

/// 經 ID 伺服器的新 session。/ A new session through Telepy's RustDesk server.
pub struct NewIdSession {
    pub user_id: i64,
    pub user_name: String,
    pub device_id: i64,
    pub rustdesk_id: String,
    pub device_name: String,
}

#[derive(Default)]
pub struct RustDesk {
    sessions: DashMap<String, Arc<Session>>,
}

impl RustDesk {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.get(id).map(|s| s.clone())
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    fn insert(&self, user_id: i64, user_name: String, via: Via, saved_label: Option<String>) -> (Arc<Session>, String) {
        let ticket = random_alnum(48);
        let now = Instant::now();
        let session = Arc::new(Session {
            id: uuid::Uuid::new_v4().to_string(),
            user_id,
            user_name,
            via,
            saved_label,
            created: now,
            ticket: Mutex::new(Some((ticket.clone(), now + TICKET_TTL))),
            id_claimed: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            stop: Notify::new(),
            stop_reason: Mutex::new(None),
        });
        self.sessions.insert(session.id.clone(), session.clone());
        (session, ticket)
    }

    pub fn create(&self, new: NewSession) -> (Arc<Session>, String) {
        let via = Via::Tunnel {
            tunnel_id: new.tunnel_id,
            tunnel_name: new.tunnel_name,
            reverse_port: new.reverse_port,
            hop_username: new.hop_username,
            target: new.target,
            handoff: Mutex::new(Some(Box::new(new.prepared))),
        };
        self.insert(new.user_id, new.user_name, via, new.saved_label)
    }

    pub fn create_id_session(&self, new: NewIdSession) -> (Arc<Session>, String) {
        let via = Via::IdServer { device_id: new.device_id, rustdesk_id: new.rustdesk_id, device_name: new.device_name, relay_rx: Mutex::new(None) };
        self.insert(new.user_id, new.user_name, via, None)
    }

    /// 某台 ID 伺服器裝置正在用的 session 數。/ Sessions open to one ID-server device.
    pub fn count_for_device(&self, device_id: i64) -> usize {
        self.sessions.iter().filter(|e| matches!(&e.via, Via::IdServer { device_id: d, .. } if *d == device_id)).count()
    }

    /// 裝置被刪掉時結束它的 session。/ End the sessions of a removed device.
    pub fn stop_device(&self, device_id: i64) {
        for e in self.sessions.iter() {
            if matches!(&e.via, Via::IdServer { device_id: d, .. } if *d == device_id) {
                e.request_stop("removed");
            }
        }
    }

    /// 驗票證（常數時間比對、未過期）並認領一個角色；同一個角色第二次 → None。
    /// Check the ticket and claim a role; a role claimed twice is refused.
    pub fn redeem(&self, id: &str, ticket: &str, role: Role) -> Option<Arc<Session>> {
        let session = self.get(id)?;
        {
            let slot = session.ticket.lock().unwrap();
            match slot.as_ref() {
                Some((t, exp)) if *exp > Instant::now() && constant_eq(t, ticket) => {}
                _ => return None,
            }
        }
        let claimed = match role {
            Role::Id => session.id_claimed.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok(),
            Role::Relay => match &session.via {
                Via::Tunnel { handoff, .. } => handoff.lock().unwrap().is_some(),
                Via::IdServer { relay_rx, .. } => relay_rx.lock().unwrap().is_some(),
            },
        };
        claimed.then_some(session)
    }

    pub fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.remove(id).map(|(_, s)| s)
    }

    /// REST stop：自己的（或管理員）；連線中 → 請中繼結束，否則直接丟。/ Stop: own or admin; connected = ask, else drop.
    pub fn stop(&self, id: &str, by_user: i64, is_admin: bool) -> Result<bool, NotOwner> {
        let Some(session) = self.get(id) else { return Ok(false) };
        if session.user_id != by_user && !is_admin {
            return Err(NotOwner);
        }
        if session.connected.load(Ordering::SeqCst) {
            session.request_stop("stopped");
        } else {
            self.sessions.remove(id);
        }
        Ok(true)
    }

    /// 沒連上的過期票證 → 移除（通道與 lease 隨之關閉）。/ Drop sessions whose ticket expired unclaimed.
    pub fn reap(&self) -> usize {
        let mut n = 0;
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            let Some(s) = self.get(&id) else { continue };
            if !s.connected.load(Ordering::SeqCst) && (s.ticket_expired() || s.created.elapsed() > TICKET_TTL * 2) {
                tracing::info!(session = %id, "rustdesk: ticket expired before the browser connected; dropping the session");
                self.sessions.remove(&id);
                n += 1;
            }
        }
        n
    }

    /// 失去權限的連線中 session → 請中繼結束。/ End connected sessions whose user lost access.
    pub async fn revoke_lost(&self, db: &Db) -> usize {
        let mut n = 0;
        let sessions: Vec<Arc<Session>> = self.sessions.iter().filter(|e| e.connected.load(Ordering::SeqCst)).map(|e| e.value().clone()).collect();
        for s in sessions {
            let allowed = match &s.via {
                Via::Tunnel { tunnel_id, hop_username, .. } => crate::desktop::allowed_for(db, s.user_id, *tunnel_id, hop_username).await,
                Via::IdServer { device_id, .. } => device_allowed(db, s.user_id, *device_id).await,
            };
            if !allowed {
                tracing::info!(session = %s.id, user = %s.user_name, "rustdesk: access revoked; closing");
                s.request_stop("revoked");
                n += 1;
            }
        }
        n
    }

    pub async fn run_reaper(self: Arc<Self>, db: Db) {
        loop {
            tokio::time::sleep(REAP_INTERVAL).await;
            self.reap();
            self.revoke_lost(&db).await;
        }
    }
}

/// ID 伺服器裝置：擁有者或管理員才能用（裝置被刪掉就不行）。/ An ID-server device is usable by its owner or an admin.
pub async fn device_allowed(db: &Db, user_id: i64, device_id: i64) -> bool {
    let Ok(Some(device)) = crate::db::rustdesk_devices::by_id(db, device_id).await else { return false };
    if device.user_id == user_id {
        return true;
    }
    matches!(crate::db::users::by_id(db, user_id).await, Ok(Some(u)) if u.is_superuser && u.is_active)
}

fn constant_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_compare() {
        assert!(constant_eq("abc", "abc"));
        assert!(!constant_eq("abc", "abd"));
        assert!(!constant_eq("abc", "ab"));
    }
}
