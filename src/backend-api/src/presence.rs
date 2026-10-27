//! 誰正在用哪條隧道（只在記憶體）：網頁終端機、檔案管理、遠端瀏覽器、筆電經 gateway 的 ssh、AI session。
//! 每條連線持有一個 [`PresenceGuard`]，連線結束 drop 就移除。有變動的隧道記進 dirty，由 monitor runner
//! 每輪推 `UPDATE-TUNNEL-PRESENCE`（同步的 drop 裡不碰 DB / hub）。
//! Who is using which tunnel right now (memory only). Each connection holds a guard that removes its
//! entry on drop; changed tunnels are marked dirty and the monitor runner sends the notifications.
//! 每筆都能被結束（即時 session 頁的「結束」）：[`Presence::end`] 通知持有 guard 的連線，它的迴圈等
//! [`PresenceGuard::ended`] 就收掉自己。/ Every entry can be ended (the live sessions page): [`Presence::end`]
//! signals the connection holding the guard, whose loop waits on [`PresenceGuard::ended`].

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use tokio::sync::watch;

use crate::util::now_db;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Terminal,
    Files,
    Browser,
    /// 筆電的 ssh 經 gateway（ProxyCommand / ProxyJump）。/ A laptop's ssh through the gateway.
    Ssh,
    Ai,
    /// 網頁內遠端桌面（RDP / VNC）。/ In-browser remote desktop.
    Desktop,
    /// 網頁內 RustDesk。/ In-browser RustDesk.
    RustDesk,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Terminal => "terminal",
            Kind::Files => "files",
            Kind::Browser => "browser",
            Kind::Ssh => "ssh",
            Kind::Ai => "ai",
            Kind::Desktop => "desktop",
            Kind::RustDesk => "rustdesk",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    /// 加入時才配發（`join` 之前是 0）。/ Assigned on join (0 before).
    pub id: u64,
    pub tunnel_id: i64,
    pub user_id: i64,
    pub username: String,
    pub kind: Kind,
    pub ip: Option<String>,
    /// DB 格式。/ DB format.
    pub since: String,
    /// AI session 的 app 名稱。/ The app behind an AI session.
    pub client: Option<String>,
    /// 網頁終端機斷線保留中：(從何時起, 何時結束)，DB 格式（見 `crate::terminal_detach`）。
    /// A detached web terminal: (since, ends at) in DB format (see `crate::terminal_detach`).
    pub detached: Option<(String, String)>,
}

impl Entry {
    pub fn new(tunnel_id: i64, user_id: i64, username: &str, kind: Kind, ip: Option<String>) -> Self {
        Self { id: 0, tunnel_id, user_id, username: username.to_string(), kind, ip, since: now_db(), client: None, detached: None }
    }
}

#[derive(Default)]
pub struct Presence {
    next: AtomicU64,
    map: DashMap<u64, (Entry, watch::Sender<Option<String>>)>,
    dirty: Mutex<HashSet<i64>>,
}

/// 連線期間持有；drop = 離開。/ Held for the connection's lifetime; dropping it leaves.
pub struct PresenceGuard {
    presence: Arc<Presence>,
    id: u64,
    tunnel_id: i64,
    ended: watch::Receiver<Option<String>>,
}

impl PresenceGuard {
    pub fn id(&self) -> u64 {
        self.id
    }

    /// 被結束時回傳是誰結束的；沒被結束就一直等。放在連線迴圈的 `select!` 裡。
    /// Resolves with who ended this session; pends forever otherwise. Put it in the connection loop's `select!`.
    pub async fn ended(&mut self) -> String {
        // 讀鎖要在 await 之前放掉（不然 future 不是 Send）。/ Drop the read guard before any further await.
        let by = self.ended.wait_for(Option::is_some).await.ok().map(|v| v.clone().unwrap_or_default());
        match by {
            Some(by) => by,
            None => std::future::pending().await,
        }
    }
}

impl PresenceGuard {
    /// 標成斷線保留中（Some((since, ends_at))）或接回來了（None）。/ Mark as detached (since, ends at) or attached again.
    pub fn set_detached(&self, detached: Option<(String, String)>) {
        if let Some(mut slot) = self.presence.map.get_mut(&self.id) {
            slot.0.detached = detached;
        }
        self.presence.mark(self.tunnel_id);
    }
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        self.presence.map.remove(&self.id);
        self.presence.mark(self.tunnel_id);
    }
}

impl Presence {
    pub fn join(self: &Arc<Self>, mut entry: Entry) -> PresenceGuard {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        entry.id = id;
        let tunnel_id = entry.tunnel_id;
        let (tx, rx) = watch::channel(None);
        self.map.insert(id, (entry, tx));
        self.mark(tunnel_id);
        PresenceGuard { presence: self.clone(), id, tunnel_id, ended: rx }
    }

    /// 結束一筆（`by` = 誰結束的）；連線自己收掉並 drop guard。找不到回 None。
    /// End one session (`by` = who ended it); the connection tears itself down. None when unknown.
    pub fn end(&self, id: u64, by: &str) -> Option<Entry> {
        let slot = self.map.get(&id)?;
        slot.1.send_replace(Some(by.to_string()));
        Some(slot.0.clone())
    }

    pub fn get(&self, id: u64) -> Option<Entry> {
        self.map.get(&id).map(|s| s.0.clone())
    }

    /// 全部（依開始時間）。/ Every entry, oldest first.
    pub fn all(&self) -> Vec<Entry> {
        let mut v: Vec<Entry> = self.map.iter().map(|s| s.value().0.clone()).collect();
        v.sort_by(|a, b| a.since.cmp(&b.since).then(a.id.cmp(&b.id)));
        v
    }

    fn mark(&self, tunnel_id: i64) {
        self.dirty.lock().unwrap().insert(tunnel_id);
    }

    /// 依隧道分組，每組依開始時間排序。/ Entries grouped by tunnel, oldest first.
    pub fn by_tunnel(&self) -> HashMap<i64, Vec<Entry>> {
        let mut out: HashMap<i64, Vec<Entry>> = HashMap::new();
        for e in self.map.iter() {
            let entry = &e.value().0;
            out.entry(entry.tunnel_id).or_default().push(entry.clone());
        }
        for v in out.values_mut() {
            v.sort_by(|a, b| a.since.cmp(&b.since));
        }
        out
    }

    pub fn for_tunnel(&self, tunnel_id: i64) -> Vec<Entry> {
        self.by_tunnel().remove(&tunnel_id).unwrap_or_default()
    }

    /// 取出並清空「有變動的隧道」。/ Drain the set of tunnels whose presence changed.
    pub fn take_dirty(&self) -> Vec<i64> {
        self.dirty.lock().unwrap().drain().collect()
    }
}

/// 「有幾個人在用」：同一人開多個分頁只算一次。/ Distinct users (several tabs count once).
pub fn distinct_users(entries: &[Entry]) -> usize {
    entries.iter().map(|e| e.user_id).collect::<HashSet<_>>().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guards_join_and_leave() {
        let p = Arc::new(Presence::default());
        let a = p.join(Entry::new(1, 10, "alice", Kind::Terminal, Some("198.51.100.7".into())));
        let b = p.join(Entry::new(1, 10, "alice", Kind::Files, None));
        let c = p.join(Entry::new(2, 11, "bob", Kind::Ssh, None));
        assert_eq!(distinct_users(&p.for_tunnel(1)), 1, "two tabs of one user count once");
        assert_eq!(p.for_tunnel(1).len(), 2);
        let mut dirty = p.take_dirty();
        dirty.sort();
        assert_eq!(dirty, vec![1, 2]);
        assert!(p.take_dirty().is_empty());
        drop(a);
        drop(b);
        assert!(p.for_tunnel(1).is_empty());
        assert_eq!(p.take_dirty(), vec![1]);
        drop(c);
        assert!(p.by_tunnel().is_empty());
    }

    #[tokio::test]
    async fn sessions_can_be_ended() {
        let p = Arc::new(Presence::default());
        let mut a = p.join(Entry::new(1, 10, "alice", Kind::Terminal, None));
        let b = p.join(Entry::new(1, 11, "bob", Kind::Files, None));
        assert_ne!(a.id(), b.id());
        assert_eq!(p.all().len(), 2);
        assert_eq!(p.get(a.id()).unwrap().username, "alice");
        a.set_detached(Some(("2026-10-27 01:00:00.000000".into(), "2026-10-27 01:05:00.000000".into())));
        assert_eq!(p.get(a.id()).unwrap().detached.unwrap().1, "2026-10-27 01:05:00.000000");
        a.set_detached(None);
        assert!(p.get(a.id()).unwrap().detached.is_none());
        let ended = p.end(a.id(), "carol").unwrap();
        assert_eq!(ended.user_id, 10);
        assert_eq!(a.ended().await, "carol");
        assert!(p.end(999, "carol").is_none());
        // 沒被結束的一直等。/ An entry nobody ended keeps waiting.
        let mut b = b;
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), b.ended()).await.is_err());
        drop(a);
        assert_eq!(p.all().len(), 1);
    }
}
