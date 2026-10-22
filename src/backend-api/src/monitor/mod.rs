//! 隧道狀態來源：哪些 reverse port 正在被監聽、每個 port 的 RTT。
//! Django 版從 Redis 讀 ssh 容器的取樣；這裡由內建 SSH gateway 直接餵入。
//! `None` = 狀態不可用（gateway 沒啟動；與舊版語意相同：不可誤判為全部離線）。
//! Tunnel status source (listening ports + per-port RTT), fed by the in-process gateway.

pub mod ports;
pub mod runner;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use crate::db::{self, Db};

#[derive(Default)]
struct Inner {
    listen_ports: Option<HashSet<u16>>,
    listen_at: Option<Instant>,
    latency: Option<HashMap<u16, f64>>,
    latency_at: Option<Instant>,
    /// 去彈跳後「已承認」的狀態（Django 的 cache `ports_status`）。/ The debounced, committed map.
    committed: BTreeMap<i64, bool>,
    /// 每個 forward 是從哪個公網位址連進來的（gateway 看到的 TCP 來源）。/ Who holds each forward, as the gateway sees it.
    endpoints: HashMap<u16, Endpoint>,
}

/// 撐著某個 reverse port 的那條 SSH 連線：來源 IP 與連上的時間（DB 格式）。
/// The SSH connection holding a reverse port: source IP and when it connected (DB format).
#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub ip: String,
    pub since: String,
}

pub struct StatusState {
    inner: RwLock<Inner>,
    /// 取樣超過這個時間沒更新就視為不可用（None = 事件驅動來源，永不過期）。
    max_age: Option<Duration>,
}

impl StatusState {
    pub fn new(max_age: Option<Duration>) -> Self {
        Self { inner: RwLock::new(Inner::default()), max_age }
    }

    fn fresh(&self, at: Option<Instant>) -> bool {
        match (self.max_age, at) {
            (None, Some(_)) => true,
            (Some(max), Some(t)) => t.elapsed() <= max,
            (_, None) => false,
        }
    }

    pub fn set_listen_ports(&self, ports: HashSet<u16>) {
        let mut g = self.inner.write().unwrap();
        g.listen_ports = Some(ports);
        g.listen_at = Some(Instant::now());
    }

    pub fn set_endpoints(&self, endpoints: HashMap<u16, Endpoint>) {
        self.inner.write().unwrap().endpoints = endpoints;
    }

    /// 目前每個 forward 的來源（沒有 gateway 時是空的）。/ Live source of every forward (empty without a gateway).
    pub fn endpoints(&self) -> HashMap<u16, Endpoint> {
        self.inner.read().unwrap().endpoints.clone()
    }

    pub fn set_latency(&self, latency: HashMap<u16, f64>) {
        let mut g = self.inner.write().unwrap();
        g.latency = Some(latency);
        g.latency_at = Some(Instant::now());
    }

    pub fn committed_ports(&self) -> BTreeMap<i64, bool> {
        self.inner.read().unwrap().committed.clone()
    }

    pub fn set_committed(&self, committed: BTreeMap<i64, bool>) {
        self.inner.write().unwrap().committed = committed;
    }

    /// 目前監聽中的埠（含非隧道的 LISTEN）；取樣不可用回 None。
    pub fn listen_ports(&self) -> Option<HashSet<u16>> {
        let g = self.inner.read().unwrap();
        if !self.fresh(g.listen_at) {
            return None;
        }
        g.listen_ports.clone()
    }

    /// `get_ss_latency_from_redis()`：{reverse_port: rtt_ms}，不可用回 None。
    pub fn latency(&self) -> Option<HashMap<u16, f64>> {
        let g = self.inner.read().unwrap();
        if !self.fresh(g.latency_at) {
            return None;
        }
        g.latency.clone()
    }

    /// `get_ss_output_from_redis(filter=True)`：DB 裡每個 reverse_port → 是否在監聽。
    pub async fn ports_status(&self, db: &Db) -> sqlx::Result<Option<BTreeMap<i64, bool>>> {
        let Some(listen) = self.listen_ports() else { return Ok(None) };
        let ports = db::tunnels::all_ports(db).await?;
        Ok(Some(ports.into_iter().map(|p| (p, u16::try_from(p).map(|p16| listen.contains(&p16)).unwrap_or(false))).collect()))
    }

    /// `find_multiple_free_ports` 的「已用埠」：取樣可用 → LISTEN ∪ DB；不可用 → 只用 DB。
    pub async fn used_ports(&self, db: &Db) -> sqlx::Result<HashSet<i64>> {
        let mut used: HashSet<i64> = db::tunnels::all_ports(db).await?.into_iter().collect();
        if let Some(listen) = self.listen_ports() {
            used.extend(listen.into_iter().map(i64::from));
        }
        Ok(used)
    }
}

/// 新隧道的 reverse port：1024..65535 之間最小、沒被用（DB / 現有 forward）而且 `usable` 的埠。
/// `usable` 在正式環境是 [`loopback_bindable`]：後端自己也在聽一些 port（gateway 2222、API 8000、遠端瀏覽器的
/// SOCKS…），只看 DB 會把它們發給隧道，裝置的 forward 就永遠綁不起來。
pub fn find_free_port(used: &HashSet<i64>, usable: impl Fn(i64) -> bool) -> Result<i64, String> {
    (1024..65535).find(|p| !used.contains(p) && usable(*p)).ok_or_else(|| "Not enough free ports available.".to_string())
}

/// 這個 port 現在在 127.0.0.1 綁得起來（gateway 之後就是綁在這裡）。
pub fn loopback_bindable(port: i64) -> bool {
    u16::try_from(port).map(|p| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_skips_used_and_unusable() {
        let used: HashSet<i64> = [1024, 1025].into_iter().collect();
        assert_eq!(find_free_port(&used, |_| true).unwrap(), 1026);
        // 1026 is taken by something else on the host (e.g. the gateway's own listener)
        assert_eq!(find_free_port(&used, |p| p != 1026).unwrap(), 1027);
        assert!(find_free_port(&used, |_| false).is_err());
        // a port held by a live listener is not bindable
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(!loopback_bindable(held.local_addr().unwrap().port() as i64));
    }

    #[test]
    fn staleness() {
        let s = StatusState::new(Some(Duration::from_millis(0)));
        s.set_listen_ports([1u16].into_iter().collect());
        std::thread::sleep(Duration::from_millis(5));
        assert!(s.listen_ports().is_none());
        let live = StatusState::new(None);
        live.set_listen_ports([1u16].into_iter().collect());
        assert!(live.listen_ports().is_some());
    }
}
