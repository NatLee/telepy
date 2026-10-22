//! 區網掃描的執行：連到裝置、找網段、探測、讀鄰居表、反查名稱、存結果、通知、記 Log。
//! 一條隧道同時只跑一個掃描；狀態放記憶體（重啟就沒了，結果已存在 DB）。
//! Running a LAN scan through the device; one scan per tunnel at a time, status kept in memory.

use std::collections::{BTreeMap, BTreeSet};
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use futures::stream::{self, StreamExt};
use russh::client::Handle;
use russh::ChannelMsg;
use serde::Serialize;
use serde_json::json;

use super::{parse_getent, parse_neighbours, parse_networks, parse_ssh_banner, targets, Network};
use crate::db::{self, lan::Found, tunnels::Tunnel, users::User};
use crate::ssh::device::{self, ClientHandler};
use crate::state::AppState;
use crate::util::now_db;

/// 每個 direct-tcpip 探測等多久（之後就當成沒開；裝置那邊的連線由它自己逾時）。/ Per-probe wait.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
/// 同時進行的探測數。/ Probes in flight at once.
pub const CONCURRENCY: usize = 48;
/// 開著的 port 等 banner 的時間（SSH 伺服器一連上就送；任何 port 上的 SSH 都認得出來）。
/// How long an open port gets to send a banner (SSH servers send theirs at once, on any port).
const BANNER_TIMEOUT: Duration = Duration::from_millis(800);
const EXEC_TIMEOUT: Duration = Duration::from_secs(15);
const EXEC_OUTPUT: usize = 256 * 1024;

const NETWORKS_POSIX: &str = "ip -o -4 addr show scope global 2>/dev/null || ifconfig 2>/dev/null || /sbin/ifconfig 2>/dev/null";
const NETWORKS_WINDOWS: &str = "powershell -NoProfile -NonInteractive -Command \"Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $_.InterfaceAlias + '|' + $_.IPAddress + '/' + $_.PrefixLength }\"";
const NEIGHBOURS_POSIX: &str = "ip neigh show 2>/dev/null || arp -an 2>/dev/null";
const NEIGHBOURS_WINDOWS: &str = "powershell -NoProfile -NonInteractive -Command \"Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.State -ne 'Unreachable' -and $_.State -ne 'Incomplete' } | ForEach-Object { $_.IPAddress + ' ' + $_.LinkLayerAddress }\"";

#[derive(Debug, Clone, Serialize)]
pub struct ScanStatus {
    pub scan_id: String,
    pub tunnel_id: i64,
    pub started_by: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// connecting | networks | discovery | ports | names | done | failed
    pub phase: String,
    pub networks: Vec<String>,
    pub ports: Vec<u16>,
    pub probed: usize,
    pub total: usize,
    pub hosts_found: usize,
    pub error: Option<String>,
}

impl ScanStatus {
    pub fn running(&self) -> bool {
        !matches!(self.phase.as_str(), "done" | "failed")
    }
}

/// 每條隧道最近一次（或進行中）的掃描狀態。/ Latest (or running) scan per tunnel.
#[derive(Default)]
pub struct LanScans {
    status: DashMap<i64, ScanStatus>,
}

impl LanScans {
    pub fn get(&self, tunnel_id: i64) -> Option<ScanStatus> {
        self.status.get(&tunnel_id).map(|s| s.clone())
    }
    /// 開始一個掃描（同一條隧道已有進行中的就拒絕）。/ Start a scan unless one is running for the tunnel.
    pub fn begin(&self, tunnel_id: i64, user: &User, ports: &[u16]) -> Result<ScanStatus, ScanStatus> {
        let mut entry = self.status.entry(tunnel_id).or_insert_with(|| blank(tunnel_id, user, ports));
        if entry.running() && !entry.scan_id.is_empty() {
            return Err(entry.clone());
        }
        *entry = ScanStatus { scan_id: crate::util::uuid_hex(), ..blank(tunnel_id, user, ports) };
        Ok(entry.clone())
    }
    fn update(&self, tunnel_id: i64, f: impl FnOnce(&mut ScanStatus)) -> Option<ScanStatus> {
        self.status.get_mut(&tunnel_id).map(|mut s| {
            f(&mut s);
            s.clone()
        })
    }
}

fn blank(tunnel_id: i64, user: &User, ports: &[u16]) -> ScanStatus {
    ScanStatus {
        scan_id: String::new(),
        tunnel_id,
        started_by: user.username.clone(),
        started_at: now_db(),
        finished_at: None,
        phase: "connecting".into(),
        networks: vec![],
        ports: ports.to_vec(),
        probed: 0,
        total: 0,
        hosts_found: 0,
        error: None,
    }
}

pub struct ScanRequest {
    pub tunnel: Tunnel,
    /// 裝置上的帳號（掃描者在這條隧道允許的 username）。/ Device account used for the scan.
    pub username: String,
    /// None = 自動偵測裝置的網段。/ None = detect the device's networks.
    pub subnets: Option<Vec<Network>>,
    pub ports: Vec<u16>,
    pub user: User,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanSummary {
    pub status: ScanStatus,
    pub inserted: usize,
    pub updated: usize,
}

async fn device_exec(handle: &Handle<ClientHandler>, command: &str) -> String {
    match crate::ssh::exec::run(handle, command, EXEC_TIMEOUT, EXEC_OUTPUT).await {
        Ok(r) => r.stdout.text,
        Err(_) => String::new(),
    }
}

/// 先試 POSIX，沒結果再試 Windows PowerShell。/ POSIX first, then Windows PowerShell.
async fn detect_networks(handle: &Handle<ClientHandler>) -> Vec<Network> {
    let n = parse_networks(&device_exec(handle, NETWORKS_POSIX).await);
    if !n.is_empty() {
        return n;
    }
    parse_networks(&device_exec(handle, NETWORKS_WINDOWS).await)
}

async fn read_neighbours(handle: &Handle<ClientHandler>) -> Vec<super::Neighbour> {
    let n = parse_neighbours(&device_exec(handle, NEIGHBOURS_POSIX).await);
    if !n.is_empty() {
        return n;
    }
    parse_neighbours(&device_exec(handle, NEIGHBOURS_WINDOWS).await)
}

/// 由裝置的 sshd 對 ip:port 開 direct-tcpip；開得起來 = port 開著。要 banner 時讀第一行（SSH）。
/// Ask the device's sshd for a direct-tcpip channel to ip:port; success = open. Optionally read a banner.
async fn probe(handle: &Handle<ClientHandler>, ip: Ipv4Addr, port: u16, banner: bool) -> Option<Option<String>> {
    let ch = tokio::time::timeout(PROBE_TIMEOUT, handle.channel_open_direct_tcpip(ip.to_string(), u32::from(port), "127.0.0.1", 0))
        .await
        .ok()?
        .ok()?;
    let mut text = None;
    if banner {
        let mut ch = ch;
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(BANNER_TIMEOUT, async {
            while let Some(msg) = ch.wait().await {
                if let ChannelMsg::Data { data } = msg {
                    buf.extend_from_slice(&data);
                    if buf.contains(&b'\n') || buf.len() >= 255 {
                        break;
                    }
                }
            }
        })
        .await;
        text = parse_ssh_banner(&buf);
        let _ = ch.close().await;
    } else {
        let _ = ch.close().await;
    }
    Some(text)
}

/// 執行一次掃描（呼叫端已做權限檢查並 `LanScans::begin` 過）。結果存進 DB、通知、寫進隧道的 Logs。
/// Run one scan (permissions checked and `begin` called by the caller); persists, notifies and logs.
pub async fn execute(state: AppState, req: ScanRequest) -> ScanSummary {
    let tunnel_id = req.tunnel.id;
    let started = Instant::now();
    let result = run(&state, &req).await;
    let (inserted, updated, error) = match result {
        Ok(found) => match db::lan::upsert_scanned(&state.db, tunnel_id, &found).await {
            Ok((i, u)) => (i, u, None),
            Err(e) => (0, 0, Some(format!("could not save the results: {e}"))),
        },
        Err(e) => (0, 0, Some(e)),
    };
    let status = state
        .lan_scans
        .update(tunnel_id, |s| {
            s.finished_at = Some(now_db());
            s.phase = if error.is_some() { "failed".into() } else { "done".into() };
            s.error = error.clone();
        })
        .unwrap_or_else(|| blank(tunnel_id, &req.user, &req.ports));
    let secs = started.elapsed().as_secs_f64();
    let message = match &error {
        None => format!(
            "LAN scan of {} (ports {}) by {}: {} host(s), {} new, in {secs:.1} s",
            if status.networks.is_empty() { "-".to_string() } else { status.networks.join(", ") },
            req.ports.iter().map(u16::to_string).collect::<Vec<_>>().join(","),
            req.user.username,
            status.hosts_found,
            inserted
        ),
        Some(e) => format!("LAN scan by {} failed: {e}", req.user.username),
    };
    state.gateway.event("lan_scan", None, None, Some(tunnel_id), message).await;
    tracing::info!(tunnel_id, user = %req.user.username, hosts = status.hosts_found, inserted, error = ?error, "LAN scan finished");
    state.hub.notify_user(
        req.user.id,
        &json!({ "action": "LAN-SCAN-DONE", "tunnel_id": tunnel_id, "hosts_found": status.hosts_found, "inserted": inserted, "error": error, "details": format!("LAN scan of '{}' finished", req.tunnel.host_friendly_name) }),
    );
    if error.is_none() {
        if let Ok(audience) = crate::api::notify::tunnel_audience(&state, &req.tunnel).await {
            state.hub.notify_users(audience, &json!({ "action": "UPDATED-LAN-HOSTS", "tunnel_id": tunnel_id, "details": format!("LAN hosts of '{}' updated", req.tunnel.host_friendly_name) }));
        }
    }
    ScanSummary { status, inserted, updated }
}

fn progress(state: &AppState, req: &ScanRequest, f: impl FnOnce(&mut ScanStatus)) {
    if let Some(s) = state.lan_scans.update(req.tunnel.id, f) {
        state.hub.notify_user(req.user.id, &json!({ "action": "LAN-SCAN-PROGRESS", "tunnel_id": s.tunnel_id, "phase": s.phase, "probed": s.probed, "total": s.total, "hosts_found": s.hosts_found }));
    }
}

async fn run(state: &AppState, req: &ScanRequest) -> Result<Vec<Found>, String> {
    let conn = device::connect(state, &req.username, req.tunnel.reverse_port)
        .await
        .map_err(|e| format!("cannot connect to the device as {}: {e:#}", req.username))?;
    let handle = &conn.device;

    progress(state, req, |s| s.phase = "networks".into());
    let detected = detect_networks(handle).await;
    let own: Vec<Ipv4Addr> = detected.iter().map(|n| n.addr).collect();
    let networks: Vec<Network> = match &req.subnets {
        Some(s) => s.clone(),
        None => detected.iter().map(Network::narrowed).collect(),
    };
    if networks.is_empty() {
        return Err("could not find the device's private networks; enter a subnet such as 192.168.1.0/24".into());
    }
    let addresses = targets(&networks, &own);
    let cidrs: Vec<String> = networks.iter().map(Network::cidr).collect::<BTreeSet<_>>().into_iter().collect();
    progress(state, req, |s| {
        s.phase = "discovery".into();
        s.networks = cidrs.clone();
        s.total = addresses.len();
    });

    // 1) 每個位址探測第一個 port（同時讓裝置對活主機做 ARP）。/ First port on every address (also primes ARP).
    let first = req.ports[0];
    let probed = AtomicUsize::new(0);
    let last_note = std::sync::Mutex::new(Instant::now());
    let mut open: BTreeMap<Ipv4Addr, (BTreeSet<u16>, Option<String>)> = BTreeMap::new();
    let results: Vec<(Ipv4Addr, Option<Option<String>>)> = stream::iter(addresses.iter().copied())
        .map(|ip| {
            let probed = &probed;
            let last_note = &last_note;
            async move {
                let r = probe(handle, ip, first, true).await;
                let n = probed.fetch_add(1, Ordering::Relaxed) + 1;
                let due = {
                    let mut t = last_note.lock().unwrap();
                    let due = t.elapsed() >= Duration::from_millis(800);
                    if due {
                        *t = Instant::now();
                    }
                    due
                };
                if due {
                    progress(state, req, |s| s.probed = n);
                }
                (ip, r)
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    for (ip, r) in results {
        if let Some(banner) = r {
            let e = open.entry(ip).or_default();
            e.0.insert(first);
            if banner.is_some() {
                e.1 = banner;
            }
        }
    }

    // 2) 鄰居表：找出沒開 port 的活主機與 MAC。/ The neighbour table: live hosts without open ports, MACs.
    let target_set: BTreeSet<Ipv4Addr> = addresses.iter().copied().collect();
    let neighbours = read_neighbours(handle).await;
    let macs: BTreeMap<Ipv4Addr, Option<String>> = neighbours.into_iter().filter(|n| target_set.contains(&n.ip)).map(|n| (n.ip, n.mac)).collect();
    let live: Vec<Ipv4Addr> = open.keys().chain(macs.keys()).copied().collect::<BTreeSet<_>>().into_iter().collect();

    // 3) 只對活主機探測其餘 port。/ The remaining ports, on live hosts only.
    let rest: Vec<(Ipv4Addr, u16)> = live.iter().flat_map(|ip| req.ports.iter().skip(1).map(move |p| (*ip, *p))).collect();
    progress(state, req, |s| {
        s.phase = "ports".into();
        s.probed = 0;
        s.total = rest.len();
        s.hosts_found = live.len();
    });
    let probed = AtomicUsize::new(0);
    let results: Vec<(Ipv4Addr, u16, Option<Option<String>>)> = stream::iter(rest.into_iter())
        .map(|(ip, port)| {
            let probed = &probed;
            async move {
                let r = probe(handle, ip, port, true).await;
                probed.fetch_add(1, Ordering::Relaxed);
                (ip, port, r)
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    for (ip, port, r) in results {
        if let Some(banner) = r {
            let e = open.entry(ip).or_default();
            e.0.insert(port);
            if banner.is_some() {
                e.1 = banner;
            }
        }
    }

    // 4) 名稱（POSIX 的 getent；盡力而為）。/ Names via getent (best effort).
    progress(state, req, |s| {
        s.phase = "names".into();
        s.probed = s.total;
    });
    let live: Vec<Ipv4Addr> = open.keys().chain(macs.keys()).copied().collect::<BTreeSet<_>>().into_iter().collect();
    let mut names: BTreeMap<Ipv4Addr, String> = BTreeMap::new();
    for chunk in live.chunks(64) {
        let cmd = format!("getent hosts {} 2>/dev/null", chunk.iter().map(Ipv4Addr::to_string).collect::<Vec<_>>().join(" "));
        names.extend(parse_getent(&device_exec(handle, &cmd).await));
    }

    let found: Vec<Found> = live
        .iter()
        .map(|ip| {
            let (ports, banner) = open.get(ip).cloned().unwrap_or_default();
            Found {
                address: ip.to_string(),
                hostname: names.get(ip).cloned(),
                mac: macs.get(ip).cloned().flatten(),
                open_ports: ports.into_iter().collect(),
                ssh_banner: banner,
            }
        })
        .collect();
    progress(state, req, |s| s.hosts_found = found.len());
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> User {
        User {
            id: 1,
            password: String::new(),
            last_login: None,
            is_superuser: false,
            username: "alice".into(),
            last_name: String::new(),
            email: String::new(),
            is_staff: false,
            is_active: true,
            date_joined: String::new(),
            first_name: String::new(),
        }
    }

    #[test]
    fn one_scan_per_tunnel() {
        let scans = LanScans::default();
        let first = scans.begin(7, &user(), &[22]).unwrap();
        assert!(first.running() && !first.scan_id.is_empty());
        assert_eq!(scans.begin(7, &user(), &[22]).unwrap_err().scan_id, first.scan_id, "a running scan blocks another");
        assert!(scans.begin(8, &user(), &[22]).is_ok(), "per tunnel");
        scans.update(7, |s| s.phase = "done".into());
        let second = scans.begin(7, &user(), &[80]).unwrap();
        assert_ne!(second.scan_id, first.scan_id, "a finished scan can be followed by a new one");
        assert_eq!(second.ports, vec![80]);
    }
}
