//! 隧道狀態來源：哪些 reverse port 正在被監聽、每個 port 的 RTT。
//! Django 版從 Redis 讀 ssh 容器的取樣；這裡由內建 SSH gateway（M5）直接餵入，或在過渡期由
//! push 端點餵入。`None` = 本輪取樣不可用（與舊版語意相同：不可誤判為全部離線）。
//! Tunnel status source (listening ports + per-port RTT), fed by the in-process gateway.

pub mod ports;

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
}

pub struct StatusState {
    inner: RwLock<Inner>,
    /// 取樣超過這個時間沒更新就視為不可用（None = 事件驅動來源，永不過期）。
    max_age: Option<Duration>,
}

impl Default for StatusState {
    fn default() -> Self {
        Self::new(Some(Duration::from_secs(15)))
    }
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

    pub fn set_latency(&self, latency: HashMap<u16, f64>) {
        let mut g = self.inner.write().unwrap();
        g.latency = Some(latency);
        g.latency_at = Some(Instant::now());
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

/// `find_multiple_free_ports(count)`：1024..65535 之間最小的 count 個未用埠。
pub fn find_free_ports(used: &HashSet<i64>, count: usize) -> Result<Vec<i64>, String> {
    let free: Vec<i64> = (1024..65535).filter(|p| !used.contains(p)).take(count).collect();
    if free.len() < count {
        return Err("Not enough free ports available.".to_string());
    }
    Ok(free)
}

/// `ss -tlnp` 原文 → LISTEN 埠集合（127.0.0.1 / 0.0.0.0）。保留給 push 來源與測試用。
pub fn parse_ss_listen(output: &str) -> HashSet<u16> {
    let re = regex::Regex::new(r"(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)").unwrap();
    re.captures_iter(output).filter_map(|c| c[1].parse::<u16>().ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_ports_skip_used() {
        let used: HashSet<i64> = [1024, 1025].into_iter().collect();
        assert_eq!(find_free_ports(&used, 2).unwrap(), vec![1026, 1027]);
    }

    #[test]
    fn ss_parse() {
        let out = "State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 127.0.0.1:12345 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:2222 0.0.0.0:*\nLISTEN 0 128 127.0.0.11:35123 0.0.0.0:*";
        let ports = parse_ss_listen(out);
        assert!(ports.contains(&12345) && ports.contains(&2222));
        assert!(!ports.contains(&35123));
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
