//! 區網掃描的執行：連到裝置、找網段、探測、讀鄰居表、反查名稱、辨識服務（網頁 port 一個 `GET /`）、存結果、通知、記 Log。
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

use super::device_self::{self, Changes};
use super::fingerprint::{self, Service};
use super::{parse_avahi, parse_getent, parse_nmblookup, parse_neighbours, parse_networks, targets, web_scheme, Network};
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
/// 辨識一個網頁 port 的時限（TLS 握手 + 讀回應）。/ The limit for fingerprinting one web port (TLS + the answer).
const IDENTIFY_TIMEOUT: Duration = Duration::from_secs(5);
/// 同時辨識幾個網頁 port（比探測少：每個都要讀一整個回應）。/ Web ports fingerprinted at once.
const IDENTIFY_CONCURRENCY: usize = 16;
/// 網頁回應最多讀多少（標題通常在前幾 KB）。/ How much of a page is read (the title sits in the first KBs).
const IDENTIFY_MAX: usize = 64 * 1024;
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
    /// connecting | networks | discovery | ports | identify | names | self | done | failed
    pub phase: String,
    pub networks: Vec<String>,
    pub ports: Vec<u16>,
    pub probed: usize,
    pub total: usize,
    pub hosts_found: usize,
    pub error: Option<String>,
    /// 跟上一次比變了什麼（做完才有）。/ What changed since the previous scan (once done).
    pub changes: Option<Changes>,
    /// 裝置的預設閘道（看得到的話）。/ The device's default gateway, when it could be read.
    pub gateway: Option<String>,
    /// `manual` | `schedule` | `check`（只檢查一台）。/ `manual` | `schedule` | `check` (one host only).
    pub trigger: &'static str,
    /// `check` 檢查的是哪台。/ The host a `check` looks at.
    pub host_id: Option<i64>,
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
    pub fn begin(&self, tunnel_id: i64, user: &User, ports: &[u16], trigger: Trigger) -> Result<ScanStatus, ScanStatus> {
        let mut entry = self.status.entry(tunnel_id).or_insert_with(|| blank(tunnel_id, user, ports));
        if entry.running() && !entry.scan_id.is_empty() {
            return Err(entry.clone());
        }
        *entry = ScanStatus { scan_id: crate::util::uuid_hex(), trigger: trigger.as_str(), host_id: trigger.host(), ..blank(tunnel_id, user, ports) };
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
        changes: None,
        gateway: None,
        trigger: "manual",
        host_id: None,
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
    /// 網頁 port 送一個 `GET /` 認出它是什麼（預設開；對方的紀錄裡看得到）。/ Send one `GET /` per web port (default on; visible in the host's logs).
    pub identify: bool,
    /// 使用者自己加的 port（不在預設清單裡的）：沒先說話的也試一個 GET。/ Ports the person added beyond the default list: silent ones get a GET too.
    pub listed: Vec<u16>,
    pub trigger: Trigger,
}

/// 誰叫這次掃描的。/ What started this scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// 有人按了掃描（網頁、CLI、MCP）。/ Someone asked (web, CLI, MCP).
    Manual,
    /// 定時重掃（`lan::schedule`）。/ A scheduled rescan.
    Schedule,
    /// 只檢查一台主機（它的 /32、它的 port）：不改網段的整體結果，也不看裝置自己。/ One host only (its /32 and ports):
    /// the network summary stays as it was and the device itself isn't looked at.
    Check(i64),
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Manual => "manual",
            Trigger::Schedule => "schedule",
            Trigger::Check(_) => "check",
        }
    }
    pub fn host(self) -> Option<i64> {
        match self {
            Trigger::Check(id) => Some(id),
            _ => None,
        }
    }
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

/// 由裝置的 sshd 對 ip:port 開 direct-tcpip；開得起來 = port 開著。不是網頁 port 時聽它自己先說的那一行（SSH、FTP、VNC…）——
/// 只聽、不送。網頁 port 不等（HTTP 伺服器不會先說話），留給辨識那一步。
/// Ask the device's sshd for a direct-tcpip channel to ip:port; success = open. Non-web ports are listened to for the
/// line they send first (SSH, FTP, VNC…) — listen only, never send. Web ports aren't waited on (HTTP servers don't
/// speak first); the identify step handles them.
async fn probe(handle: &Handle<ClientHandler>, ip: Ipv4Addr, port: u16) -> Option<Option<Service>> {
    let ch = tokio::time::timeout(PROBE_TIMEOUT, handle.channel_open_direct_tcpip(ip.to_string(), u32::from(port), "127.0.0.1", 0))
        .await
        .ok()?
        .ok()?;
    let mut ch = ch;
    if web_scheme(port).is_some() {
        let _ = ch.close().await;
        return Some(None);
    }
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
    let _ = ch.close().await;
    Some(fingerprint::parse_banner(&buf).map(|(proto, text)| Service { port, proto: proto.into(), banner: Some(text), ..Default::default() }))
}

/// 一個網頁 port：照 port 猜的 scheme 先試（https 先 TLS 握手讀憑證），不通再試另一種；送一個 `GET /`、讀回應。
/// One web port: the scheme the port suggests first (https = a TLS handshake that reads the certificate), then the
/// other; one `GET /`, then the answer.
async fn identify_web(handle: &Handle<ClientHandler>, ip: Ipv4Addr, port: u16) -> Option<Service> {
    let https_first = web_scheme(port) == Some("https");
    for tls in if https_first { [true, false] } else { [false, true] } {
        // 逾時（對方收了不回）就不再試另一種：多半一樣不回，只會讓掃描多等。失敗得快（被拒、TLS 握手不成）才換。
        // A timeout (it took the request and said nothing) ends it: the other way would most likely hang too. Only a
        // quick failure (refused, no TLS) tries the other way.
        let Ok(r) = tokio::time::timeout(IDENTIFY_TIMEOUT, fetch(handle, ip, port, tls)).await else { return None };
        // 送到 HTTPS port 的明文請求常回 400「plain HTTP request was sent to HTTPS port」：再試 TLS。
        // A plain request to an HTTPS port often gets a 400 saying so: try TLS then.
        if let Some(s) = r {
            let wrong_door = !tls && s.status == Some(400) && s.title.as_deref().is_some_and(|t| t.to_ascii_lowercase().contains("https"));
            if !wrong_door {
                return Some(s);
            }
        }
    }
    None
}

async fn fetch(handle: &Handle<ClientHandler>, ip: Ipv4Addr, port: u16, tls: bool) -> Option<Service> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let ch = handle.channel_open_direct_tcpip(ip.to_string(), u32::from(port), "127.0.0.1", 0).await.ok()?;
    let stream = ch.into_stream();
    let default_port = (tls && port == 443) || (!tls && port == 80);
    let request = fingerprint::http_request(&ip.to_string(), port, default_port);
    let mut buf = Vec::new();
    let cert = if tls {
        let connector = tokio_rustls::TlsConnector::from(super::tls::any_cert_config());
        let name = rustls::pki_types::ServerName::IpAddress(std::net::IpAddr::V4(ip).into());
        let mut s = connector.connect(name, stream).await.ok()?;
        let cert = s.get_ref().1.peer_certificates().and_then(|c| c.first()).and_then(|c| fingerprint::cert_info(c.as_ref()));
        s.write_all(&request).await.ok()?;
        let _ = (&mut s).take(IDENTIFY_MAX as u64).read_to_end(&mut buf).await;
        cert
    } else {
        let mut s = stream;
        s.write_all(&request).await.ok()?;
        let _ = (&mut s).take(IDENTIFY_MAX as u64).read_to_end(&mut buf).await;
        None
    };
    let mut svc = fingerprint::parse_http(&buf, tls, port).or_else(|| cert.is_some().then(|| Service { port, proto: "https".into(), ..Default::default() }))?;
    svc.cert = cert;
    Some(svc)
}

/// 執行一次掃描（呼叫端已做權限檢查並 `LanScans::begin` 過）。結果存進 DB、通知、寫進隧道的 Logs。
/// Run one scan (permissions checked and `begin` called by the caller); persists, notifies and logs.
pub async fn execute(state: AppState, req: ScanRequest) -> ScanSummary {
    let tunnel_id = req.tunnel.id;
    let started = Instant::now();
    let result = run(&state, &req).await;
    let mut changed: Option<Changes> = None;
    let mut gateway: Option<String> = None;
    let (inserted, updated, error) = match result {
        Ok(r) => {
            // 掃描前後比，只在這次掃的網段裡：「之前看過」= 掃描或手動加、但曾經被掃到過的（裝置自己除外）；
            // 「新的」= 清單裡完全沒有的位址（手動加過、第一次被掃到的不算新）。
            // Before vs after, within this scan's networks only: "seen before" = any host but the device itself that a
            // scan has seen; "new" = an address the list doesn't have at all (a manual host seen for the first time isn't).
            let in_scan = |h: &db::lan::LanHost| h.source != "self" && h.address.parse::<Ipv4Addr>().is_ok_and(|ip| r.networks.iter().any(|n| n.contains(ip)));
            let listed: Vec<db::lan::LanHost> = db::lan::hosts_for_tunnel(&state.db, tunnel_id).await.unwrap_or_default().into_iter().filter(|h| in_scan(h)).collect();
            let meta_before = db::lan::meta(&state.db, tunnel_id).await.ok().flatten();
            let check = req.trigger.host();
            let before: BTreeMap<String, Vec<u16>> = listed
                .iter()
                .filter(|h| h.last_seen.is_some())
                .map(|h| (h.address.clone(), h.open_port_list()))
                .collect();
            let known: BTreeSet<String> = listed.iter().map(|h| h.address.clone()).collect();
            let after: BTreeMap<String, Vec<u16>> = r.found.iter().filter(|f| !f.own).map(|f| (f.address.clone(), f.open_ports.clone())).collect();
            let mut c = device_self::changes(&before, &after, &req.ports);
            c.new.retain(|a| !known.contains(a));
            gateway = r.gateway.map(|g| g.to_string());
            let at = now_db();
            match db::lan::upsert_scanned(&state.db, tunnel_id, &r.found, &at).await {
                Ok((i, u)) => {
                    // 這次探過的每台（找到或沒找到）記下時間：之後 `last_seen` 比它早 = 這次沒看到。
                    // Every host this scan covered, found or not: a `last_seen` older than this = not seen this time.
                    let covered: Vec<i64> = db::lan::hosts_for_tunnel(&state.db, tunnel_id).await.unwrap_or_default().iter().filter(|h| in_scan(h)).map(|h| h.id).collect();
                    if let Err(e) = db::lan::mark_checked(&state.db, &covered, &at).await {
                        tracing::warn!(tunnel_id, error = %e, "could not record which hosts were covered");
                    }
                    // 「檢查這台」不改網段的整體結果。/ A single-host check leaves the network summary alone.
                    if check.is_none() {
                        let meta = db::lan::LanMeta {
                            tunnel_id,
                            networks: serde_json::to_string(&r.networks.iter().map(Network::cidr).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into()),
                            gateway: gateway.clone(),
                            scanned_at: Some(at.clone()),
                            changes: serde_json::to_string(&c).ok(),
                        };
                        if let Err(e) = db::lan::save_meta(&state.db, &meta).await {
                            tracing::warn!(tunnel_id, error = %e, "could not save the scan summary");
                        }
                    }
                    announce(&state, &req.tunnel, &listed, meta_before.as_ref(), &c, &after, check.is_none()).await;
                    changed = Some(c);
                    (i, u, None)
                }
                Err(e) => (0, 0, Some(format!("could not save the results: {e}"))),
            }
        }
        Err(e) => (0, 0, Some(e)),
    };
    let status = state
        .lan_scans
        .update(tunnel_id, |s| {
            s.finished_at = Some(now_db());
            s.phase = if error.is_some() { "failed".into() } else { "done".into() };
            s.error = error.clone();
            s.changes = changed.clone();
            s.gateway = gateway.clone();
        })
        .unwrap_or_else(|| blank(tunnel_id, &req.user, &req.ports));
    let secs = started.elapsed().as_secs_f64();
    let what = match req.trigger {
        Trigger::Manual => "LAN scan",
        Trigger::Schedule => "Scheduled LAN scan",
        Trigger::Check(_) => "LAN check",
    };
    let message = match &error {
        None => format!(
            "{what} of {} (ports {}) by {}: {} host(s), {} new, {} gone, {} with port changes, in {secs:.1} s",
            if status.networks.is_empty() { "-".to_string() } else { status.networks.join(", ") },
            req.ports.iter().map(u16::to_string).collect::<Vec<_>>().join(","),
            req.user.username,
            status.hosts_found,
            inserted,
            changed.as_ref().map_or(0, |c| c.gone.len()),
            changed.as_ref().map_or(0, |c| c.changed.len()),
        ),
        Some(e) => format!("{what} by {} failed: {e}", req.user.username),
    };
    state.gateway.event("lan_scan", None, None, Some(tunnel_id), message).await;
    tracing::info!(tunnel_id, user = %req.user.username, hosts = status.hosts_found, inserted, error = ?error, "LAN scan finished");
    state.hub.notify_user(
        req.user.id,
        &json!({ "action": "LAN-SCAN-DONE", "tunnel_id": tunnel_id, "trigger": req.trigger.as_str(), "host_id": req.trigger.host(), "hosts_found": status.hosts_found, "inserted": inserted, "gone": changed.as_ref().map_or(0, |c| c.gone.len()), "changed": changed.as_ref().map_or(0, |c| c.changed.len()), "error": error, "details": format!("LAN scan of '{}' finished", req.tunnel.host_friendly_name) }),
    );
    if error.is_none() {
        if let Ok(audience) = crate::api::notify::tunnel_audience(&state, &req.tunnel).await {
            state.hub.notify_users(audience, &json!({ "action": "UPDATED-LAN-HOSTS", "tunnel_id": tunnel_id, "details": format!("LAN hosts of '{}' updated", req.tunnel.host_friendly_name) }));
        }
    }
    ScanSummary { status, inserted, updated }
}

/// 一台主機給人看的名字：標籤 > 主機名稱 > 位址。/ A host's display name.
fn host_name(h: &db::lan::LanHost) -> String {
    h.label.clone().or_else(|| h.hostname.clone()).unwrap_or_else(|| h.address.clone())
}

/// 存好之後要說的：網段上出現新機器（整網段掃描、而且之前掃過，才不會第一次就全部算新的）→ owner 與 ADMIN；被注意的
/// 主機不見了 / 回來了 / port 變了 → 注意它、而且還看得到這條隧道的人。站內通知、webhook（推播跟著 webhook 走）。
/// What to tell after saving: new machines on the network (full scans only, and only after an earlier scan, so the first
/// one doesn't call everything new) → the owner and ADMIN sharees; a watched host down / back / ports changed → whoever
/// watches it and can still see the tunnel. In-app notifications and webhooks (pushes follow the webhooks).
async fn announce(state: &AppState, tunnel: &Tunnel, before: &[db::lan::LanHost], meta_before: Option<&db::lan::LanMeta>, c: &Changes, after: &BTreeMap<String, Vec<u16>>, full: bool) {
    let link = format!("/tunnels/network?tunnel={}", tunnel.id);
    if full && meta_before.is_some() && !c.new.is_empty() {
        let hosts = db::lan::hosts_for_tunnel(&state.db, tunnel.id).await.unwrap_or_default();
        let new: Vec<serde_json::Value> = c
            .new
            .iter()
            .map(|a| {
                let h = hosts.iter().find(|h| &h.address == a);
                json!({ "id": h.map(|h| h.id), "address": a, "name": h.map(host_name).unwrap_or_else(|| a.clone()) })
            })
            .collect();
        let mut managers = vec![tunnel.user_id];
        managers.extend(db::sharing::admin_sharee_ids(&state.db, tunnel.id).await.unwrap_or_default());
        let shown: Vec<&str> = c.new.iter().take(8).map(String::as_str).collect();
        let more = if c.new.len() > 8 { format!(" +{} more", c.new.len() - 8) } else { String::new() };
        state.gateway.event("lan_new_hosts", None, None, Some(tunnel.id), format!("{} new machine(s) on the network of {}: {}{more}", c.new.len(), tunnel.host_friendly_name, shown.join(", "))).await;
        state.webhooks.emit(
            crate::webhooks::Event::new(crate::webhooks::Kind::LanNewHosts)
                .tunnel(tunnel)
                .to(managers.clone(), None)
                .link(link.clone())
                .data(json!({ "count": c.new.len(), "hosts": new })),
        );
        state.hub.notify_users(managers, &json!({ "action": "LAN-NEW-HOSTS", "tunnel_id": tunnel.id, "tunnel_name": tunnel.host_friendly_name, "count": c.new.len(), "hosts": new }));
    }
    let watchers = db::lan::watchers(&state.db, tunnel.id).await.unwrap_or_default();
    if watchers.is_empty() {
        return;
    }
    for h in before {
        let users: Vec<i64> = watchers.iter().filter(|(hid, _)| *hid == h.id).map(|(_, u)| *u).collect();
        if users.is_empty() {
            continue;
        }
        let was_up = super::watch::was_seen(h.last_seen.as_deref(), h.checked_at.as_deref(), meta_before.and_then(|m| m.scanned_at.as_deref()));
        let now_up = after.contains_key(&h.address);
        let delta = c.changed.iter().find(|x| x.address == h.address);
        let (opened, closed) = delta.map_or((vec![], vec![]), |d| (d.opened.clone(), d.closed.clone()));
        let Some(st) = super::watch::transition(was_up, now_up, &opened, &closed) else { continue };
        // 只告訴還看得到這條隧道的人。/ Only people who can still see the tunnel.
        let mut to = Vec::new();
        for u in users {
            if crate::permissions::effective_for(&state.db, u, tunnel).await.ok().flatten().is_some() {
                to.push(u);
            }
        }
        if to.is_empty() {
            continue;
        }
        let data = json!({ "host_id": h.id, "host": host_name(h), "address": h.address, "state": st.as_str(), "opened": opened, "closed": closed });
        state.webhooks.emit(crate::webhooks::Event::new(crate::webhooks::Kind::LanWatchedHost).tunnel(tunnel).to(to.clone(), None).link(link.clone()).data(data.clone()));
        let mut msg = json!({ "action": "LAN-HOST-WATCH", "tunnel_id": tunnel.id, "tunnel_name": tunnel.host_friendly_name });
        if let (Some(m), Some(d)) = (msg.as_object_mut(), data.as_object()) {
            m.extend(d.clone());
        }
        state.hub.notify_users(to, &msg);
    }
}

fn progress(state: &AppState, req: &ScanRequest, f: impl FnOnce(&mut ScanStatus)) {
    if let Some(s) = state.lan_scans.update(req.tunnel.id, f) {
        state.hub.notify_user(req.user.id, &json!({ "action": "LAN-SCAN-PROGRESS", "tunnel_id": s.tunnel_id, "phase": s.phase, "probed": s.probed, "total": s.total, "hosts_found": s.hosts_found }));
    }
}

/// 一次掃描的結果：找到的主機（含裝置自己）、掃了哪些網段、預設閘道。/ What a scan found, which networks, the gateway.
struct ScanResult {
    found: Vec<Found>,
    networks: Vec<Network>,
    gateway: Option<Ipv4Addr>,
}

/// 裝置自己在聽的 port（從 loopback 連得到的），跟區網主機一樣先聽它先說的；`identify` 開著時，沒先說話的 port 都送一個
/// GET（裝置自己說它在聽，像使用者自己列的 port 一樣看待；[`fingerprint::NEVER_SEND`] 照樣不送）。
/// The device's own listening ports (those reachable on its loopback), listened to like LAN hosts first; with
/// `identify` every port that stayed silent gets one GET (the device itself says it listens, so they count like ports
/// the person listed; [`fingerprint::NEVER_SEND`] still never gets one).
async fn own_services(handle: &Handle<ClientHandler>, identify: bool) -> Option<Found> {
    let mut listening = device_self::parse_listening(&device_exec(handle, device_self::LISTEN_POSIX).await);
    if listening.is_empty() {
        listening = device_self::parse_listening(&device_exec(handle, device_self::LISTEN_WINDOWS).await);
    }
    let ports = device_self::local_ports(&listening);
    if ports.is_empty() {
        return None;
    }
    let lo = Ipv4Addr::LOCALHOST;
    let seen: Vec<(u16, Option<Option<Service>>)> = stream::iter(ports.iter().copied())
        .map(|port| async move { (port, probe(handle, lo, port).await) })
        .buffer_unordered(IDENTIFY_CONCURRENCY)
        .collect()
        .await;
    let mut open: Vec<u16> = Vec::new();
    let mut services: Vec<Service> = Vec::new();
    for (port, r) in seen {
        if let Some(svc) = r {
            open.push(port);
            services.extend(svc);
        }
    }
    if identify {
        let web: Vec<u16> = open.iter().copied().filter(|p| fingerprint::worth_a_get(*p, true, services.iter().any(|s| s.port == *p))).collect();
        let pages: Vec<Option<Service>> = stream::iter(web).map(|port| identify_web(handle, lo, port)).buffer_unordered(IDENTIFY_CONCURRENCY).collect().await;
        services.extend(pages.into_iter().flatten());
    }
    open.sort_unstable();
    services.sort_by_key(|s| s.port);
    let ssh_banner = services.iter().find(|s| s.proto == "ssh").and_then(|s| s.banner.clone());
    Some(Found { address: "localhost".into(), hostname: None, mac: None, open_ports: open, ssh_banner, services, own: true })
}

/// 預設閘道：先 POSIX，再 PowerShell。/ The default gateway: POSIX first, then PowerShell.
async fn read_gateway(handle: &Handle<ClientHandler>) -> Option<Ipv4Addr> {
    device_self::parse_gateway(&device_exec(handle, device_self::GATEWAY_POSIX).await).or(device_self::parse_gateway(&device_exec(handle, device_self::GATEWAY_WINDOWS).await))
}

async fn run(state: &AppState, req: &ScanRequest) -> Result<ScanResult, String> {
    let conn = device::connect(state, &req.username, req.tunnel.reverse_port)
        .await
        .map_err(|e| format!("cannot connect to the device as {}: {e:#}", req.username))?;
    let handle = &conn.device;

    progress(state, req, |s| s.phase = "networks".into());
    let detected = detect_networks(handle).await;
    let gateway = read_gateway(handle).await;
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
    let mut open: BTreeMap<Ipv4Addr, (BTreeSet<u16>, Vec<Service>)> = BTreeMap::new();
    let results: Vec<(Ipv4Addr, Option<Option<Service>>)> = stream::iter(addresses.iter().copied())
        .map(|ip| {
            let probed = &probed;
            let last_note = &last_note;
            async move {
                let r = probe(handle, ip, first).await;
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
        if let Some(service) = r {
            let e = open.entry(ip).or_default();
            e.0.insert(first);
            e.1.extend(service);
        }
    }

    // 2) 鄰居表：找出沒開 port 的活主機與 MAC。/ The neighbour table: live hosts without open ports, MACs.
    let target_set: BTreeSet<Ipv4Addr> = addresses.iter().copied().collect();
    let neighbours = read_neighbours(handle).await;
    let macs: BTreeMap<Ipv4Addr, Option<String>> = neighbours.into_iter().filter(|n| target_set.contains(&n.ip)).map(|n| (n.ip, n.mac)).collect();
    let live: Vec<Ipv4Addr> = open.keys().chain(macs.keys()).copied().collect::<BTreeSet<_>>().into_iter().collect();

    // 3) 只對活主機探測其餘 port；只掃一個位址（「檢查這台」）時每個 port 都試，不靠第一個 port 開著。
    // The remaining ports, on live hosts only; a single address ("check this host") gets every port regardless.
    let probe_on: Vec<Ipv4Addr> = if addresses.len() == 1 { addresses.clone() } else { live.clone() };
    let rest: Vec<(Ipv4Addr, u16)> = probe_on.iter().flat_map(|ip| req.ports.iter().skip(1).map(move |p| (*ip, *p))).collect();
    progress(state, req, |s| {
        s.phase = "ports".into();
        s.probed = 0;
        s.total = rest.len();
        s.hosts_found = live.len();
    });
    let probed = AtomicUsize::new(0);
    let results: Vec<(Ipv4Addr, u16, Option<Option<Service>>)> = stream::iter(rest.into_iter())
        .map(|(ip, port)| {
            let probed = &probed;
            async move {
                let r = probe(handle, ip, port).await;
                probed.fetch_add(1, Ordering::Relaxed);
                (ip, port, r)
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    for (ip, port, r) in results {
        if let Some(service) = r {
            let e = open.entry(ip).or_default();
            e.0.insert(port);
            e.1.extend(service);
        }
    }

    // 3b) 辨識：每個開著的網頁 port 一個 `GET /`（TLS 的順便讀憑證）。/ Identify: one `GET /` per open web port.
    if req.identify {
        let listed = &req.listed;
        let web: Vec<(Ipv4Addr, u16)> = open
            .iter()
            .flat_map(|(ip, (ports, services))| ports.iter().filter(move |p| fingerprint::worth_a_get(**p, listed.contains(p), services.iter().any(|s| s.port == **p))).map(move |p| (*ip, *p)))
            .collect();
        progress(state, req, |s| {
            s.phase = "identify".into();
            s.probed = 0;
            s.total = web.len();
        });
        let probed = AtomicUsize::new(0);
        let seen: Vec<(Ipv4Addr, Option<Service>)> = stream::iter(web.into_iter())
            .map(|(ip, port)| {
                let probed = &probed;
                async move {
                    let r = identify_web(handle, ip, port).await;
                    let n = probed.fetch_add(1, Ordering::Relaxed) + 1;
                    progress(state, req, |s| s.probed = n);
                    (ip, r)
                }
            })
            .buffer_unordered(IDENTIFY_CONCURRENCY)
            .collect()
            .await;
        for (ip, svc) in seen {
            if let (Some(svc), Some(e)) = (svc, open.get_mut(&ip)) {
                e.1.push(svc);
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
    // getent 叫不出名字的：mDNS（avahi-resolve），有開 SMB 的再試 NetBIOS（nmblookup）。裝置上沒有這些工具就略過。
    // Hosts getent could not name: mDNS via avahi-resolve, then NetBIOS for hosts with SMB open. Skipped when absent.
    let unnamed = |names: &BTreeMap<Ipv4Addr, String>| live.iter().filter(|ip| !names.contains_key(ip)).copied().collect::<Vec<_>>();
    for chunk in unnamed(&names).chunks(32) {
        let ips = chunk.iter().map(Ipv4Addr::to_string).collect::<Vec<_>>().join(" ");
        let cmd = format!("command -v avahi-resolve >/dev/null 2>&1 && timeout 8 avahi-resolve -a {ips} 2>/dev/null");
        names.extend(parse_avahi(&device_exec(handle, &cmd).await));
    }
    let smb: Vec<Ipv4Addr> = unnamed(&names).into_iter().filter(|ip| open.get(ip).is_some_and(|(ports, _)| ports.contains(&445) || ports.contains(&139))).collect();
    for chunk in smb.chunks(16) {
        let ips = chunk.iter().map(Ipv4Addr::to_string).collect::<Vec<_>>().join(" ");
        let cmd = format!("command -v nmblookup >/dev/null 2>&1 && for ip in {ips}; do echo \"@@ $ip\"; timeout 3 nmblookup -A $ip 2>/dev/null; done");
        names.extend(parse_nmblookup(&device_exec(handle, &cmd).await));
    }

    let found: Vec<Found> = live
        .iter()
        .map(|ip| {
            let (ports, mut services) = open.get(ip).cloned().unwrap_or_default();
            services.sort_by_key(|s| s.port);
            let ssh_banner = services.iter().find(|s| s.proto == "ssh").and_then(|s| s.banner.clone());
            Found {
                address: ip.to_string(),
                hostname: names.get(ip).cloned(),
                mac: macs.get(ip).cloned().flatten(),
                open_ports: ports.into_iter().collect(),
                ssh_banner,
                services,
                own: false,
            }
        })
        .collect();
    progress(state, req, |s| s.hosts_found = found.len());
    // 5) 裝置自己在聽什麼（本機 loopback）。/ What the device itself listens on (its loopback).
    let mut found = found;
    if req.trigger.host().is_none() {
        progress(state, req, |s| s.phase = "self".into());
        if let Some(own) = own_services(handle, req.identify).await {
            found.push(own);
        }
    }
    Ok(ScanResult { found, networks, gateway })
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
        let first = scans.begin(7, &user(), &[22], Trigger::Manual).unwrap();
        assert!(first.running() && !first.scan_id.is_empty());
        assert_eq!(scans.begin(7, &user(), &[22], Trigger::Manual).unwrap_err().scan_id, first.scan_id, "a running scan blocks another");
        assert!(scans.begin(8, &user(), &[22], Trigger::Manual).is_ok(), "per tunnel");
        scans.update(7, |s| s.phase = "done".into());
        let second = scans.begin(7, &user(), &[80], Trigger::Manual).unwrap();
        assert_ne!(second.scan_id, first.scan_id, "a finished scan can be followed by a new one");
        assert_eq!(second.ports, vec![80]);
    }
}
