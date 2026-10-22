//! 誰正在用哪條隧道（只在記憶體）：網頁終端機、檔案管理、遠端瀏覽器、筆電經 gateway 的 ssh、AI session。
//! 每條連線持有一個 [`PresenceGuard`]，連線結束 drop 就移除。有變動的隧道記進 dirty，由 monitor runner
//! 每輪推 `UPDATE-TUNNEL-PRESENCE`（同步的 drop 裡不碰 DB / hub）。
//! Who is using which tunnel right now (memory only). Each connection holds a guard that removes its
//! entry on drop; changed tunnels are marked dirty and the monitor runner sends the notifications.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;

use crate::util::now_db;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Terminal,
    Files,
    Browser,
    /// 筆電的 ssh 經 gateway（ProxyCommand / ProxyJump）。/ A laptop's ssh through the gateway.
    Ssh,
    Ai,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Terminal => "terminal",
            Kind::Files => "files",
            Kind::Browser => "browser",
            Kind::Ssh => "ssh",
            Kind::Ai => "ai",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub tunnel_id: i64,
    pub user_id: i64,
    pub username: String,
    pub kind: Kind,
    pub ip: Option<String>,
    /// DB 格式。/ DB format.
    pub since: String,
    /// AI session 的 app 名稱。/ The app behind an AI session.
    pub client: Option<String>,
}

impl Entry {
    pub fn new(tunnel_id: i64, user_id: i64, username: &str, kind: Kind, ip: Option<String>) -> Self {
        Self { tunnel_id, user_id, username: username.to_string(), kind, ip, since: now_db(), client: None }
    }
}

#[derive(Default)]
pub struct Presence {
    next: AtomicU64,
    map: DashMap<u64, Entry>,
    dirty: Mutex<HashSet<i64>>,
}

/// 連線期間持有；drop = 離開。/ Held for the connection's lifetime; dropping it leaves.
pub struct PresenceGuard {
    presence: Arc<Presence>,
    id: u64,
    tunnel_id: i64,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        self.presence.map.remove(&self.id);
        self.presence.mark(self.tunnel_id);
    }
}

impl Presence {
    pub fn join(self: &Arc<Self>, entry: Entry) -> PresenceGuard {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let tunnel_id = entry.tunnel_id;
        self.map.insert(id, entry);
        self.mark(tunnel_id);
        PresenceGuard { presence: self.clone(), id, tunnel_id }
    }

    fn mark(&self, tunnel_id: i64) {
        self.dirty.lock().unwrap().insert(tunnel_id);
    }

    /// 依隧道分組，每組依開始時間排序。/ Entries grouped by tunnel, oldest first.
    pub fn by_tunnel(&self) -> HashMap<i64, Vec<Entry>> {
        let mut out: HashMap<i64, Vec<Entry>> = HashMap::new();
        for e in self.map.iter() {
            out.entry(e.tunnel_id).or_default().push(e.value().clone());
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
}
