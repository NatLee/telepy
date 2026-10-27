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
//! 傳檔：RustDesk 的檔案傳輸是另一條連線（登入時帶 `file_transfer`），所以「檔案」面板向 `…/rustdesk/{sid}/files`
//! 要一個掛在畫面 session 底下的子 session（[`Kind::Files`]，自己的票證與通道，不另佔名額、不另算 presence，畫面那條
//! 結束就跟著結束）。中繼用 [`codec::LoginGuard`] 看瀏覽器送的登入：畫面 session 只准遙控、檔案 session 只准傳檔，
//! 站台設定 `desktop_file_transfer` 關掉時不發檔案 session、已開的也收掉。檔案 session 上的刪除與改名由
//! [`file_audit`] 整理成 tunnel 的 Logs 事件（`rustdesk_file_delete` / `rustdesk_file_rename`）。
//! 不需要 hbbs / hbbr、不開新的公開埠、不用 UDP。裝置的 Direct IP 連線本身不加密（RustDesk 設計如此：沒有金鑰
//! 交換，第一則訊息就是密碼挑戰），整段由 SSH 隧道與 TLS 保護；RustDesk 的固定密碼由瀏覽器端核心直接雜湊回應，
//! **後端看不到密碼**。權限和桌面一樣：隧道 VIEW + 允許的裝置帳號 + step-up。
//! In-browser RustDesk: the browser runs RustDesk's open TypeScript core, Telepy fakes hbbs/hbbr on one WebSocket
//! and re-frames messages into a direct-tcpip channel to the device's Direct IP port. See `docs/rustdesk-spike.md`.

pub mod codec;
pub mod file_audit;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use tokio::sync::Notify;

use crate::db::Db;
use crate::desktop::{Prepared, Target};
use crate::util::random_alnum;

/// 票證壽命：start 回來後瀏覽器要在這段時間內開兩條 WS（hbbs 角色、relay 角色）。/ Both sockets must open within this.
pub const TICKET_TTL: Duration = Duration::from_secs(60);
pub const REAP_INTERVAL: Duration = Duration::from_secs(10);
/// 一個畫面 session 底下最多幾個檔案 session（再開就收掉最舊的）。允許兩個：重新整理 / React 的雙重 effect
/// 時新舊兩條會短暫重疊，不能讓晚到的舊請求把新的那條收掉。
/// Files sessions per screen session; another one ends the oldest. Two, because a reload (or React's double
/// effect in development) briefly overlaps an old and a new request, and the late old one must not end the new one.
pub const MAX_FILES_PER_SCREEN: usize = 2;
/// RustDesk 的 Direct IP Access 預設埠。/ RustDesk's default Direct IP port.
pub const DEFAULT_PORT: u16 = 21118;

/// 不是自己的 session（也不是管理員）。/ Someone else's session and not an admin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotOwner;

/// 這條 RustDesk 連線做什麼：看畫面 / 操作，或傳檔（畫面 session 底下的子 session）。
/// What a RustDesk connection is for: the screen (remote control) or file transfer (a child of a screen session).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Screen,
    Files,
}

impl Kind {
    /// 中繼准許的登入。/ The login the relay admits.
    pub fn login(self) -> codec::LoginKind {
        match self {
            Self::Screen => codec::LoginKind::Control,
            Self::Files => codec::LoginKind::FileTransfer,
        }
    }
}

/// 同一張票證的兩個角色，各用一次。/ The two roles one ticket admits, once each.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    /// 假 hbbs：回 relay_response。/ Fake hbbs.
    Id,
    /// 假 hbbr：接到裝置。/ Fake hbbr, bridged to the device.
    Relay,
}

pub struct Session {
    pub id: String,
    pub kind: Kind,
    /// 檔案 session 掛在哪個畫面 session 底下。/ The screen session a files session belongs to.
    pub parent: Option<String>,
    pub user_id: i64,
    pub user_name: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub reverse_port: i64,
    pub hop_username: String,
    pub target: Target,
    /// 用了憑證庫的哪一筆（日誌用）。/ The saved login used, for the logs.
    pub saved_label: Option<String>,
    /// 開這個 session 的網頁登入（撤銷時連線以 4010 結束）。/ The web sign-in that opened it (revoked = 4010).
    pub web_session: Option<i64>,
    pub created: Instant,
    ticket: Mutex<Option<(String, Instant)>>,
    id_claimed: AtomicBool,
    handoff: Mutex<Option<Prepared>>,
    pub connected: AtomicBool,
    pub stop: Notify,
    stop_reason: Mutex<Option<&'static str>>,
}

impl Session {
    pub fn take_handoff(&self) -> Option<Prepared> {
        self.handoff.lock().unwrap().take()
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
        let to = if self.target.lan_host_id.is_some() { format!("{}:{}", self.target.host, self.target.port) } else { format!("device:{}", self.target.port) };
        let saved = self.saved_label.as_deref().map(|l| format!(" with saved login '{l}'")).unwrap_or_default();
        let what = match self.kind {
            Kind::Screen => "RustDesk in the browser",
            Kind::Files => "RustDesk file transfer",
        };
        format!("{what} by {} to {} through {}@{}{saved}", self.user_name, to, self.hop_username, self.tunnel_name)
    }
}

pub struct NewSession {
    pub kind: Kind,
    pub parent: Option<String>,
    pub user_id: i64,
    pub user_name: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub reverse_port: i64,
    pub hop_username: String,
    pub target: Target,
    pub prepared: Prepared,
    pub saved_label: Option<String>,
    /// 開這個 session 的網頁登入（撤銷時連線以 4010 結束）。/ The web sign-in that opened it (revoked = 4010).
    pub web_session: Option<i64>,
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

    /// 佔名額的 session（畫面）；檔案 session 是畫面那條的一部分，不另算。/ Sessions that take a slot (screens only).
    pub fn count(&self) -> usize {
        self.sessions.iter().filter(|e| e.kind == Kind::Screen).count()
    }

    /// 某個畫面 session 底下的檔案 session。/ The files sessions of a screen session.
    pub fn children(&self, parent: &str) -> Vec<Arc<Session>> {
        self.sessions.iter().filter(|e| e.parent.as_deref() == Some(parent)).map(|e| e.value().clone()).collect()
    }

    /// 再開一個檔案 session 之前：已經有 [`MAX_FILES_PER_SCREEN`] 個就收掉最舊的。/ Make room for another files session.
    pub fn make_room_for_files(&self, parent: &str) {
        let mut list = self.children(parent);
        if list.len() < MAX_FILES_PER_SCREEN {
            return;
        }
        list.sort_by_key(|s| s.created);
        for old in list.iter().take(list.len() + 1 - MAX_FILES_PER_SCREEN) {
            if old.connected.load(Ordering::SeqCst) {
                old.request_stop("replaced");
            } else {
                self.sessions.remove(&old.id);
            }
        }
    }

    /// 畫面 session 結束：它的檔案 session 也結束（連線中的請中繼收尾，還沒連的直接丟）。
    /// A screen session ended: end its files sessions too.
    pub fn end_children(&self, parent: &str, reason: &'static str) -> usize {
        let list = self.children(parent);
        for c in &list {
            if c.connected.load(Ordering::SeqCst) {
                c.request_stop(reason);
            } else {
                self.sessions.remove(&c.id);
            }
        }
        list.len()
    }

    pub fn create(&self, new: NewSession) -> (Arc<Session>, String) {
        let ticket = random_alnum(48);
        let now = Instant::now();
        let session = Arc::new(Session {
            id: uuid::Uuid::new_v4().to_string(),
            kind: new.kind,
            parent: new.parent,
            user_id: new.user_id,
            user_name: new.user_name,
            tunnel_id: new.tunnel_id,
            tunnel_name: new.tunnel_name,
            reverse_port: new.reverse_port,
            hop_username: new.hop_username,
            target: new.target,
            saved_label: new.saved_label,
            web_session: new.web_session,
            created: now,
            ticket: Mutex::new(Some((ticket.clone(), now + TICKET_TTL))),
            id_claimed: AtomicBool::new(false),
            handoff: Mutex::new(Some(new.prepared)),
            connected: AtomicBool::new(false),
            stop: Notify::new(),
            stop_reason: Mutex::new(None),
        });
        self.sessions.insert(session.id.clone(), session.clone());
        (session, ticket)
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
            Role::Relay => session.handoff.lock().unwrap().is_some(),
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
            } else if let Some(parent) = s.parent.as_deref().filter(|p| self.get(p).is_none()) {
                // 保險：畫面 session 不在了，檔案 session 也收掉。/ Safety net: the screen session is gone.
                tracing::info!(session = %id, parent, "rustdesk: files session without its screen session; closing");
                s.request_stop("parent ended");
                if !s.connected.load(Ordering::SeqCst) {
                    self.sessions.remove(&id);
                }
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
            if !crate::desktop::allowed_for(db, s.user_id, s.tunnel_id, &s.hop_username).await {
                tracing::info!(session = %s.id, user = %s.user_name, "rustdesk: access revoked; closing");
                s.request_stop("revoked");
                n += 1;
            }
        }
        n
    }

    /// 站台關掉了檔案傳輸：收掉所有檔案 session。/ The site turned file transfer off: end every files session.
    pub fn end_all_files(&self) -> usize {
        let files: Vec<Arc<Session>> = self.sessions.iter().filter(|e| e.kind == Kind::Files).map(|e| e.value().clone()).collect();
        for s in &files {
            if s.connected.load(Ordering::SeqCst) {
                s.request_stop("file transfer turned off");
            } else {
                self.sessions.remove(&s.id);
            }
        }
        files.len()
    }

    pub async fn run_reaper(self: Arc<Self>, db: Db) {
        loop {
            tokio::time::sleep(REAP_INTERVAL).await;
            self.reap();
            self.revoke_lost(&db).await;
            if let Ok(settings) = crate::db::settings::get_solo(&db).await {
                if !settings.desktop_file_transfer {
                    self.end_all_files();
                }
            }
        }
    }
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
