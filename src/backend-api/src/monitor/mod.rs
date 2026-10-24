//! 隧道狀態來源：哪些 reverse port 正在被監聽、每個 port 的 RTT。
//! Django 版從 Redis 讀 ssh 容器的取樣；這裡由內建 SSH gateway 直接餵入。
//! `None` = 狀態不可用（gateway 沒啟動；與舊版語意相同：不可誤判為全部離線）。
//! Tunnel status source (listening ports + per-port RTT), fed by the in-process gateway.

pub mod alerts;
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
    /// 每個 forward 的延遲探測連續失敗次數（成功歸零；forward 消失就移除）。
    /// Consecutive failed latency probes per forward (reset on success, dropped with the forward).
    probe_failures: HashMap<u16, u32>,
}

/// 連續幾次探測失敗才算「降級」：一次失敗可能只是裝置忙。/ Failed probes in a row before a tunnel counts as degraded.
pub const DEGRADED_AFTER: u32 = 2;

/// 隧道健康狀態（參考 Cloudflare Tunnel 的 healthy / degraded / down / inactive）。
/// - `Online`：forward 在、經由隧道讀得到裝置 sshd 的 banner。
/// - `Degraded`：forward 在，但連續 [`DEGRADED_AFTER`] 次讀不到 sshd（裝置的 sshd 停了、被防火牆擋或卡住）。
/// - `Offline`：曾經連上過，現在沒有 forward。
/// - `Never`：建好後從沒連上過（還沒在裝置上跑腳本）。
/// Tunnel health, after Cloudflare Tunnel's healthy / degraded / down / inactive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Online,
    Degraded,
    Offline,
    Never,
}

impl Health {
    pub fn as_str(self) -> &'static str {
        match self {
            Health::Online => "online",
            Health::Degraded => "degraded",
            Health::Offline => "offline",
            Health::Never => "never",
        }
    }
}

/// `listening`：forward 是否在；`failures`：連續探測失敗次數；`ever_connected`：有沒有連上過的紀錄。
/// Pure classification used by the list, MCP and the monitor.
pub fn health(listening: bool, failures: u32, ever_connected: bool) -> Health {
    match (listening, failures >= DEGRADED_AFTER, ever_connected) {
        (true, false, _) => Health::Online,
        (true, true, _) => Health::Degraded,
        (false, _, true) => Health::Offline,
        (false, _, false) => Health::Never,
    }
}

/// 撐著某個 reverse port 的那條 SSH 連線：來源 IP 與連上的時間（DB 格式）。
/// The SSH connection holding a reverse port: source IP and when it connected (DB format).
#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub ip: String,
    pub since: String,
    /// `tcp`（24242）或 `websocket`（/ws/gateway/）。/ How the device reached the gateway.
    pub transport: &'static str,
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

    /// 一輪探測的結果：`probed` 是這輪探測的 forward，`latency` 是成功的那些。成功的歸零、失敗的加一，
    /// 不在 `probed` 裡的（forward 已經不在）丟掉。
    /// One probe round: `probed` = the forwards probed, `latency` = the ones that answered.
    pub fn record_probes(&self, probed: &[u16], latency: HashMap<u16, f64>) {
        let mut g = self.inner.write().unwrap();
        let previous = std::mem::take(&mut g.probe_failures);
        g.probe_failures = probed
            .iter()
            .map(|p| (*p, if latency.contains_key(p) { 0 } else { previous.get(p).copied().unwrap_or(0).saturating_add(1) }))
            .collect();
        g.latency = Some(latency);
        g.latency_at = Some(Instant::now());
    }

    /// 這個 port 連續探測失敗幾次（沒探測過是 0）。/ Consecutive failed probes for a port (0 when never probed).
    pub fn probe_failures(&self, port: u16) -> u32 {
        self.inner.read().unwrap().probe_failures.get(&port).copied().unwrap_or(0)
    }

    /// 目前降級中的 port。/ Ports that are currently degraded.
    pub fn degraded_ports(&self) -> HashSet<u16> {
        let g = self.inner.read().unwrap();
        let listening = g.listen_ports.clone().unwrap_or_default();
        g.probe_failures.iter().filter(|(p, n)| **n >= DEGRADED_AFTER && listening.contains(p)).map(|(p, _)| *p).collect()
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

/// 新隧道的 reverse port：1024..65535 之間最小、沒被用（DB / 現有 forward）的號碼。gateway 不綁本機 port，
/// 所以它只是識別號碼，不必在主機上空著。/ The smallest unused number; the gateway binds nothing for it.
pub fn find_free_port(used: &HashSet<i64>) -> Result<i64, String> {
    (1024..65535).find(|p| !used.contains(p)).ok_or_else(|| "Not enough free ports available.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_skips_used() {
        let used: HashSet<i64> = [1024, 1025].into_iter().collect();
        assert_eq!(find_free_port(&used).unwrap(), 1026);
        let all: HashSet<i64> = (1024..65535).collect();
        assert!(find_free_port(&all).is_err());
    }

    #[test]
    fn health_states() {
        assert_eq!(health(true, 0, true), Health::Online);
        assert_eq!(health(true, 1, false), Health::Online, "one failed probe is not enough");
        assert_eq!(health(true, DEGRADED_AFTER, true), Health::Degraded);
        assert_eq!(health(false, 5, true), Health::Offline, "failures don't matter without a forward");
        assert_eq!(health(false, 0, false), Health::Never);
    }

    #[test]
    fn probe_failures_count_and_reset() {
        let s = StatusState::new(None);
        s.set_listen_ports([1u16, 2].into_iter().collect());
        s.record_probes(&[1, 2], [(1u16, 3.0)].into_iter().collect());
        assert_eq!((s.probe_failures(1), s.probe_failures(2)), (0, 1));
        assert!(s.degraded_ports().is_empty());
        s.record_probes(&[1, 2], HashMap::new());
        assert_eq!((s.probe_failures(1), s.probe_failures(2)), (1, 2));
        assert_eq!(s.degraded_ports(), [2u16].into_iter().collect());
        // 2 answers again; 1 is gone (its forward went away)
        s.record_probes(&[2], [(2u16, 4.0)].into_iter().collect());
        assert_eq!((s.probe_failures(1), s.probe_failures(2)), (0, 0));
        assert!(s.degraded_ports().is_empty());
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
