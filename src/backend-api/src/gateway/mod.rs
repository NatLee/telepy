//! 內建 SSH gateway：後端自己終結裝置的反向隧道（取代 OpenSSH 容器 + AuthorizedKeysCommand + ss/探測腳本）。
//!
//! 只實作裝置端 `ssh -NR '*:<port>:localhost:22' telepy@server` 需要的最小子集：
//! - 公鑰認證（查自己的 DB：隧道金鑰 / 使用者金鑰）。後端自己在行程內開通道、不經 gateway 認證，所以**不接受服務金鑰**：
//!   那把金鑰在每台裝置的 authorized_keys 裡，若也能登入 gateway，外洩一把就能從外網進所有裝置。
//! - `tcpip-forward`：只**記住** port → 這條連線（不綁任何本機 port；`reverse_port` 只是識別號碼）。後端要連裝置時
//!   用 [`Gateway::open_stream`] 在行程內開 `forwarded-tcpip` channel（終端機、檔案、SFTP、SOCKS、AI 都是）。
//! - `direct-tcpip`（使用者金鑰的 `ProxyCommand ssh -W <隧道名稱>:22 telepy-<網域>-<port>`）：橋到同一條 forward。
//! - session channel：隧道金鑰一律拒絕；個人金鑰只拿到一段招呼（[`greeting`]：怎麼連到自己的裝置）就關掉，
//!   什麼都不執行（exec 的指令不看也不記）；subsystem/agent/x11/env 一律拒絕。
//!
//! 狀態：forward 註冊/消失即時寫入 `StatusState`（取代 `ss` 取樣）；延遲：每 15s 開一條 forwarded 通道讀
//! 裝置 sshd banner 的第一個 byte（與 probe_latency.sh 相同的量法，但零子程序）。
//! 日誌：sshd 風格的 `Accepted publickey … / Disconnected …` 行寫到 ssh-gateway.log，Logs 頁沿用。
//! In-process SSH gateway terminating the devices' reverse tunnels (pubkey + tcpip-forward only).

pub mod greeting;
pub mod peers;
pub mod proxy_protocol;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::bail;
use dashmap::DashMap;
use russh::keys::{load_secret_key, HashAlg, PrivateKey};
use russh::server::{self, Auth, Config as ServerConfig, Handle, Handler, Msg, Session};
use russh::{Channel, ChannelId, ChannelOpenFailure, ChannelStream, Disconnect, MethodKind, MethodSet};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db::{self, tunnels::like_prefix, Db};
use crate::monitor::{Endpoint, StatusState};
use crate::hub::Hub;
use crate::presence::{self, Presence, PresenceGuard};

/// 誰在連線：隧道金鑰（裝置）、使用者金鑰（人）。一把金鑰可以同時是自己隧道的裝置金鑰與自己的個人金鑰
/// （那台電腦既是裝置、也拿來連別的裝置）：那就是 `Tunnel { person: true }`，forward 照隧道的規則，
/// 招呼與 direct-tcpip 照人的規則。
/// Who is connecting: a tunnel key (a device) or a user key (a person). A key may be both its owner's tunnel key
/// and their personal key (the computer they work from is also a device): `Tunnel { person: true }` forwards by the
/// tunnel's rule and gets the person's greeting and direct-tcpip.
#[derive(Debug, Clone)]
pub enum Identity {
    Tunnel { tunnel_id: i64, user_id: i64, reverse_port: i64, person: bool },
    User { user_id: i64 },
}

impl Identity {
    /// 以人的身分做事時是誰（筆電：招呼、direct-tcpip、在場）。/ The person behind it, for what a laptop may do.
    pub fn person(&self) -> Option<i64> {
        match self {
            Self::User { user_id } | Self::Tunnel { user_id, person: true, .. } => Some(*user_id),
            Self::Tunnel { .. } => None,
        }
    }
}

/// `register_forward` 的結果。/ What `register_forward` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Registered {
    Primary,
    Standby,
}

pub struct Forward {
    /// 隧道自己的號碼（內部 key）。/ The tunnel's own number (the internal key).
    pub port: u16,
    /// 客戶端在 tcpip-forward 要求的位址字串（開 forwarded-tcpip 時必須原樣回傳，OpenSSH 用它比對）。
    pub address: String,
    /// 客戶端以為它轉發的 port：要求 0 時是我們回的號碼，否則就是它要求的（OpenSSH 開 forwarded-tcpip 時用
    /// (address, port) 比對自己的轉發表，不符就 administratively prohibited）。
    /// The port the client believes it forwarded (our reply for 0, else what it asked for); OpenSSH matches
    /// forwarded-tcpip channels against it.
    pub client_port: u32,
    pub conn_id: u64,
    pub handle: Handle,
}

/// 連線怎麼到 gateway 的：直接連 24242，或包在 `/ws/gateway/` 的 WebSocket 裡（只放行網頁 port 的網路）。
/// How a connection reached the gateway: plain TCP on 24242, or inside a WebSocket on `/ws/gateway/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Tcp,
    WebSocket,
}

impl Transport {
    pub fn as_str(self) -> &'static str {
        match self {
            Transport::Tcp => "tcp",
            Transport::WebSocket => "websocket",
        }
    }
}

struct ConnInfo {
    peer: SocketAddr,
    identity: Identity,
    /// 認證成功的時間（DB 格式）。/ When the connection authenticated (DB format).
    since: String,
    transport: Transport,
}

impl ConnInfo {
    fn endpoint(&self) -> Endpoint {
        // 雙堆疊 listener 上的 IPv4 會是 ::ffff:a.b.c.d，轉回一般寫法。/ Unmap IPv4-mapped addresses.
        Endpoint { ip: self.peer.ip().to_canonical().to_string(), since: self.since.clone(), transport: self.transport.as_str() }
    }
}

pub struct Gateway {
    config: Config,
    db: Db,
    status: Arc<StatusState>,
    presence: Arc<Presence>,
    hub: Arc<Hub>,
    /// webhook（AppState 共用同一份；gateway 發 IP 變更）。/ Webhooks, shared with AppState (the gateway sends IP changes).
    webhooks: Arc<crate::webhooks::Webhooks>,
    /// 敏感隧道的 step-up（網頁與 gateway 共用）。/ Step-up confirmations, shared with the web side.
    step_ups: Arc<crate::step_up::StepUps>,
    /// 功能權限（網頁與 gateway 共用；筆電的 SSH 要有「個人 SSH 金鑰」）。/ Feature permissions, shared with the web side.
    features: Arc<crate::features::Features>,
    forwards: DashMap<u16, Arc<Forward>>,
    /// 改名交接開著的 port（到期時間）：這段時間同一條隧道的第二條連線先當備援，不被拒絕。
    /// Ports with a handover open (until when): a second connection of the same tunnel waits as a standby meanwhile.
    handovers: DashMap<u16, Instant>,
    /// 備援連線的 forward（還沒接手；確認能登入後 `promote`，或舊的斷線時自動接手）。
    /// Standby forwards: promoted once checked, or automatically when the old connection drops.
    standby: DashMap<u16, Arc<Forward>>,
    /// 已認證的連線。/ Authenticated connections.
    conns: DashMap<u64, ConnInfo>,
    /// 所有活著的連線（含握手中、未認證的）；連線上限看這個，不然沒認證的連線不受限。
    /// Every live connection, authenticated or not; the connection limit counts these.
    live: AtomicUsize,
    next_id: AtomicU64,
    log: Mutex<Option<tokio::fs::File>>,
    event_counter: AtomicU64,
    server_config: Arc<ServerConfig>,
    pub host_keys_loaded: usize,
    /// 連進來的位址與 PROXY header（啟動以來，記憶體）；「PROXY protocol 來源」的選項從這裡來。
    /// Connecting addresses and PROXY headers seen (since start, memory); the options for "PROXY protocol sources".
    peers: peers::PeerStats,
    started_at: chrono::DateTime<chrono::Utc>,
}

const HOST_KEY_FILES: [&str; 3] = ["ssh_host_ed25519_key", "ssh_host_rsa_key", "ssh_host_ecdsa_key"];
/// `telepy_gateway_event` 最多保留的列數。/ Row cap for the event table.
const EVENT_RETENTION_ROWS: i64 = 100_000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

pub fn load_host_keys(dir: &Path) -> Vec<PrivateKey> {
    let mut keys = Vec::new();
    for name in HOST_KEY_FILES {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        match load_secret_key(&path, None) {
            Ok(k) => keys.push(k),
            Err(e) => tracing::warn!(?path, error = %e, "gateway: cannot load host key"),
        }
    }
    keys
}

fn server_config(keys: Vec<PrivateKey>) -> Arc<ServerConfig> {
    let mut methods = MethodSet::empty();
    methods.push(MethodKind::PublicKey);
    Arc::new(ServerConfig {
        keys,
        methods,
        auth_rejection_time: Duration::from_secs(3),
        auth_rejection_time_initial: Some(Duration::from_secs(0)),
        // 與 sshd_config 的 ClientAliveInterval 30 / ClientAliveCountMax 3 相同。
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        inactivity_timeout: None,
        max_auth_attempts: 6,
        ..Default::default()
    })
}

fn alg_label(key: &russh::keys::PublicKey) -> &'static str {
    let a = key.algorithm().to_string();
    if a.starts_with("ssh-ed25519") {
        "ED25519"
    } else if a.starts_with("ssh-rsa") || a.starts_with("rsa-sha2") {
        "RSA"
    } else if a.starts_with("ecdsa") {
        "ECDSA"
    } else {
        "KEY"
    }
}

/// `type base64`（去掉註解），用來對 DB 做前綴比對。
fn bare_key(key: &russh::keys::PublicKey) -> anyhow::Result<String> {
    let s = key.to_openssh()?;
    let mut it = s.split_whitespace();
    match (it.next(), it.next()) {
        (Some(a), Some(b)) => Ok(format!("{a} {b}")),
        _ => bail!("unexpected public key encoding"),
    }
}

impl Gateway {
    pub fn new(config: Config, db: Db, status: Arc<StatusState>, presence: Arc<Presence>, hub: Arc<Hub>) -> Self {
        let keys = config.gateway_host_keys_dir.as_deref().map(load_host_keys).unwrap_or_default();
        let host_keys_loaded = keys.len();
        let webhooks = Arc::new(crate::webhooks::Webhooks::new(&config, db.clone(), hub.clone()));
        let features = Arc::new(crate::features::Features::new(db.clone()));
        Self {
            server_config: server_config(keys),
            config,
            db,
            status,
            presence,
            hub,
            webhooks,
            step_ups: Arc::new(crate::step_up::StepUps::default()),
            features,
            forwards: DashMap::new(),
            handovers: DashMap::new(),
            standby: DashMap::new(),
            conns: DashMap::new(),
            live: AtomicUsize::new(0),
            next_id: AtomicU64::new(1),
            log: Mutex::new(None),
            event_counter: AtomicU64::new(0),
            host_keys_loaded,
            peers: peers::PeerStats::default(),
            started_at: chrono::Utc::now(),
        }
    }

    /// gateway 看到的來源位址（送過 PROXY header 的在前）與從何時開始記。/ The addresses seen (header senders first) and since when.
    pub fn peer_stats(&self) -> (Vec<(std::net::IpAddr, peers::PeerSeen)>, chrono::DateTime<chrono::Utc>) {
        (self.peers.snapshot(), self.started_at)
    }

    /// 結構化事件：寫進 `telepy_gateway_event`（Logs 頁 / API 的來源），同時以 sshd 風格附加到
    /// ssh-gateway.log（運維用）。`kind` 是機器可讀的類別（accepted / forward / disconnect / refused …）。
    pub async fn event(&self, kind: &str, peer: Option<SocketAddr>, port: Option<u16>, tunnel_id: Option<i64>, message: String) {
        use crate::db::audit_chain::{self, Field, Table};
        let row = [
            ("at", Field::text(crate::util::now_db())),
            ("event", Field::text(kind)),
            ("peer", Field::Text(peer.map(|p| p.to_string()))),
            ("port", Field::Int(port.map(i64::from))),
            ("tunnel_id", Field::Int(tunnel_id)),
            ("message", Field::text(message.as_str())),
        ];
        if let Err(e) = audit_chain::append(&self.db, Table::Gateway, &row).await {
            tracing::warn!(error = %e, "gateway: cannot record event");
        }
        self.log(&message).await;
        // 保留：最多 EVENT_RETENTION_ROWS 列（每 128 筆順手清一次；先寫 prune 錨點，雜湊鏈照樣驗得過）。
        // Retention: cap the table size (every 128 events, behind a prune anchor so the chain still verifies).
        if self.event_counter.fetch_add(1, Ordering::Relaxed) % 128 == 0 {
            let cut: Option<i64> = sqlx::query_scalar("SELECT id FROM telepy_gateway_event ORDER BY id DESC LIMIT 1 OFFSET ?")
                .bind(EVENT_RETENTION_ROWS)
                .fetch_optional(&self.db.read)
                .await
                .ok()
                .flatten();
            if let Some(cut) = cut {
                if let Err(e) = audit_chain::prune_through(&self.db, Table::Gateway, cut).await {
                    tracing::warn!(error = %e, "gateway: cannot prune events");
                }
            }
        }
    }

    /// sshd 風格日誌行：`YYYY-MM-DD HH:MM:SS.fffffffff  message`。
    pub async fn log(&self, message: &str) {
        let offset = chrono::FixedOffset::east_opt(self.config.tz_offset_minutes * 60).unwrap_or_else(|| chrono::FixedOffset::east_opt(0).unwrap());
        let ts = chrono::Utc::now().with_timezone(&offset).format("%Y-%m-%d %H:%M:%S%.9f");
        let line = format!("{ts}  {message}\n");
        tracing::info!(target: "gateway", "{message}");
        let mut guard = self.log.lock().await;
        if guard.is_none() {
            if let Some(parent) = self.config.ssh_logs_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            match tokio::fs::OpenOptions::new().create(true).append(true).open(&self.config.ssh_logs_path).await {
                Ok(f) => *guard = Some(f),
                Err(e) => {
                    tracing::warn!(path = ?self.config.ssh_logs_path, error = %e, "gateway: cannot open log file");
                    return;
                }
            }
        }
        if let Some(f) = guard.as_mut() {
            let _ = f.write_all(line.as_bytes()).await;
        }
    }

    /// gateway 用的通知 hub（AppState 共用同一個）。/ The notification hub, shared with AppState.
    pub fn hub(&self) -> Arc<Hub> {
        self.hub.clone()
    }

    /// webhook（AppState 共用同一份）。/ Webhooks, shared with AppState.
    pub fn webhooks(&self) -> Arc<crate::webhooks::Webhooks> {
        self.webhooks.clone()
    }

    /// step-up 紀錄（AppState 共用同一份）。/ Step-up confirmations, shared with AppState.
    pub fn step_ups(&self) -> Arc<crate::step_up::StepUps> {
        self.step_ups.clone()
    }

    /// 功能權限快取（AppState 共用同一份）。/ The feature-permission cache, shared with AppState.
    pub fn features(&self) -> Arc<crate::features::Features> {
        self.features.clone()
    }

    /// 筆電經 gateway 連敏感隧道：這個人最近沒在網頁確認過就回那條隧道（要擋）。
    /// Laptop SSH to a sensitive tunnel: the tunnel when the user hasn't confirmed in the web recently (block it).
    async fn step_up_blocks(&self, user_id: i64, port: u16) -> anyhow::Result<Option<db::tunnels::Tunnel>> {
        if self.step_ups.recent(user_id) {
            return Ok(None);
        }
        Ok(db::tunnels::by_port(&self.db, port as i64).await?.into_iter().find(|t| t.require_step_up))
    }

    pub fn active_ports(&self) -> Vec<u16> {
        let mut v: Vec<u16> = self.forwards.iter().map(|e| *e.key()).collect();
        v.sort_unstable();
        v
    }

    /// 這個 port 現在有裝置連著（有 forward）。
    /// gateway 的 host 公鑰（OpenSSH 格式，給裝置釘在 known_hosts）。/ Host public keys for known_hosts pinning.
    pub fn host_public_keys(&self) -> Vec<String> {
        self.server_config.keys.iter().filter_map(|k| k.public_key().to_openssh().ok()).map(|s| s.split_whitespace().take(2).collect::<Vec<_>>().join(" ")).collect()
    }

    /// 現在通過認證的 SSH 連線數與登記的 forward 數（伺服器狀態頁）。/ Authenticated connections and registered forwards now.
    pub fn counts(&self) -> (usize, usize) {
        (self.conns.len(), self.forwards.len())
    }

    pub fn has_forward(&self, port: u16) -> bool {
        self.forwards.contains_key(&port)
    }

    /// 連線數到上限了（listener 與 WebSocket 入口都看這個）。/ The connection limit is reached (both entrances check it).
    pub fn at_capacity(&self) -> bool {
        self.live.load(Ordering::SeqCst) >= self.config.gateway_max_connections
    }

    /// 改名交接：接下來 `for` 這段時間，這條隧道的第二條連線先當備援（`crate::device_install`）。
    /// Open a handover: for a while a second connection of this tunnel becomes a standby instead of being refused.
    pub fn arm_handover(&self, port: u16, for_: Duration) {
        self.handovers.insert(port, Instant::now() + for_);
    }

    /// 結束交接（沒接手的備援也丟掉；它的連線若還在，之後的要求照舊被拒）。/ Close the handover and drop an unpromoted standby.
    pub fn disarm_handover(&self, port: u16) {
        self.handovers.remove(&port);
        self.standby.remove(&port);
    }

    fn handover_open(&self, port: u16) -> bool {
        self.handovers.get(&port).is_some_and(|until| *until > Instant::now())
    }

    fn tunnel_of(&self, conn_id: u64) -> Option<i64> {
        self.conns.get(&conn_id).and_then(|c| match c.identity {
            Identity::Tunnel { tunnel_id, .. } => Some(tunnel_id),
            Identity::User { .. } => None,
        })
    }

    /// 現在持有這個 port 的連線。/ The connection holding this port's forward.
    pub fn forward_conn(&self, port: u16) -> Option<u64> {
        self.forwards.get(&port).map(|f| f.conn_id)
    }

    /// 備援連線（還活著的）。/ The live standby connection.
    pub fn standby_conn(&self, port: u16) -> Option<u64> {
        self.standby.get(&port).map(|f| f.conn_id).filter(|c| self.conns.contains_key(c))
    }

    pub fn conn_alive(&self, conn_id: u64) -> bool {
        self.conns.contains_key(&conn_id)
    }

    /// 這條隧道（以隧道金鑰認出的）所有活著的連線。/ Every live connection identified as this tunnel.
    pub fn tunnel_conns(&self, tunnel_id: i64) -> Vec<u64> {
        self.conns.iter().filter(|c| matches!(c.identity, Identity::Tunnel { tunnel_id: t, .. } if t == tunnel_id)).map(|c| *c.key()).collect()
    }

    /// 在備援連線上開 forwarded-tcpip（接手前先確認它真的到得了裝置的 sshd）。/ A channel through the standby, to check it first.
    pub async fn open_standby_stream(&self, port: u16) -> anyhow::Result<ChannelStream<Msg>> {
        let fwd = self.standby.get(&port).map(|f| f.clone()).ok_or_else(|| anyhow::anyhow!("no standby connection on port {port}"))?;
        let channel = fwd
            .handle
            .channel_open_forwarded_tcpip(fwd.address.clone(), fwd.client_port, "127.0.0.1", 0)
            .await
            .map_err(|e| anyhow::anyhow!("open forwarded-tcpip: {e}"))?;
        Ok(channel.into_stream())
    }

    /// 備援接手：forward 移到新的連線（舊連線還在，但之後的新通道都走新的）。/ Promote the standby to hold the forward.
    pub async fn promote(&self, port: u16) -> bool {
        let Some((_, s)) = self.standby.remove(&port) else { return false };
        let Some(peer) = self.conns.get(&s.conn_id).map(|c| c.peer) else { return false };
        let tunnel_id = self.tunnel_of(s.conn_id);
        self.forwards.insert(port, s.clone());
        self.handovers.remove(&port);
        self.publish_status();
        self.event("handover", Some(peer), Some(port), tunnel_id, format!("Remote forward on port {port} moved to the new connection from {} port {} (the device's service was renamed)", peer.ip(), peer.port())).await;
        self.remember_endpoint(s.conn_id, port).await;
        true
    }

    /// 後端自己用：直接在裝置的隧道上開一條 forwarded-tcpip 通道（不經 loopback TCP、不占本機 port）。
    /// Open a forwarded-tcpip channel to the device in-process (no loopback TCP, no local port).
    pub async fn open_stream(&self, port: u16) -> anyhow::Result<ChannelStream<Msg>> {
        let fwd = self.forwards.get(&port).map(|f| f.clone()).ok_or_else(|| anyhow::anyhow!("device offline (no tunnel on port {port})"))?;
        let channel = fwd
            .handle
            .channel_open_forwarded_tcpip(fwd.address.clone(), fwd.client_port, "127.0.0.1", 0)
            .await
            .map_err(|e| anyhow::anyhow!("open forwarded-tcpip: {e}"))?;
        Ok(channel.into_stream())
    }

    /// 隧道刪除：斷開這條隧道金鑰的連線（forward 跟著釋放；裝置重連會因金鑰已刪而被拒）。回傳斷開的連線數。
    /// 只看有 forward 的連線：沒 forward 的連線碰不到任何東西，下次重連一樣會被拒。
    /// Tunnel deleted: drop the device's connections (their forwards go with them; it cannot reconnect).
    pub async fn disconnect_tunnel(&self, tunnel_id: i64) -> usize {
        self.disconnect_tunnel_because(tunnel_id, "tunnel deleted").await
    }

    /// 同 [`Self::disconnect_tunnel`]，自己給斷線原因（例：裝置金鑰換了，舊金鑰的連線不留）。
    /// As [`Self::disconnect_tunnel`] with its own reason (e.g. the device key changed; the old key's connection goes).
    pub async fn disconnect_tunnel_because(&self, tunnel_id: i64, reason: &str) -> usize {
        let mut handles: HashMap<u64, Handle> = HashMap::new();
        for f in self.forwards.iter().chain(self.standby.iter()) {
            let is_tunnel = self.conns.get(&f.conn_id).is_some_and(|c| matches!(c.identity, Identity::Tunnel { tunnel_id: t, .. } if t == tunnel_id));
            if is_tunnel {
                handles.entry(f.conn_id).or_insert_with(|| f.handle.clone());
            }
        }
        for h in handles.values() {
            let _ = h.disconnect(Disconnect::ByApplication, reason.into(), String::new()).await;
        }
        handles.len()
    }

    fn publish_status(&self) {
        self.status.set_listen_ports(self.forwards.iter().map(|e| *e.key()).collect());
        let endpoints = self.forwards.iter().filter_map(|f| self.conns.get(&f.conn_id).map(|c| (*f.key(), c.endpoint()))).collect();
        self.status.set_endpoints(endpoints);
    }

    /// forward 註冊好之後：記下這條隧道最後一次從哪裡連上來（離線時 tunnel list 顯示「最後 IP」）；
    /// 來源是公網位址時它就是裝置的公網 IP（換了就警示）。
    /// Record where the tunnel connected from; a public peer is also the device's public IP (alerting on change).
    async fn remember_endpoint(&self, conn_id: u64, port: u16) {
        let Some((ep, peer)) = self.conns.get(&conn_id).map(|c| (c.endpoint(), c.peer)) else { return };
        if let Err(e) = db::tunnel_endpoints::record_connected(&self.db, port, &ep.ip, &ep.since, ep.transport).await {
            tracing::warn!(port, error = %e, "gateway: cannot record tunnel endpoint");
        }
        // 連線歷史每次都記（不管 IP 有沒有換）。/ The connection history records every connect.
        if let Err(e) = db::tunnel_sessions::open(&self.db, port, &ep.ip, &ep.since).await {
            tracing::warn!(port, error = %e, "gateway: cannot record tunnel session");
        }
        // 只有公網來源才算裝置的公網 IP；代理 / Docker 的內部位址交給 `device_info` 向裝置問。
        // Only a public peer is the device's public IP; behind a proxy / Docker forward `device_info` asks the device.
        let Ok(addr) = ep.ip.parse::<std::net::IpAddr>() else { return };
        if crate::geoip::scope(addr) != crate::geoip::Scope::Public {
            return;
        }
        let Some(tunnel) = db::tunnels::by_port(&self.db, port as i64).await.ok().and_then(|v| v.into_iter().next()) else { return };
        match db::tunnel_endpoints::update_public_ip(&self.db, tunnel.id, &ep.ip, "gateway", &ep.since).await {
            Ok(Some(ch)) => self.announce_ip_change(port, &ch, &ep.ip, Some(peer)).await,
            Ok(None) => {}
            Err(e) => tracing::warn!(port, error = %e, "gateway: cannot record public ip"),
        }
    }

    /// 裝置的公網 IP 換了：記 `ip_changed`、通知擁有者與 ADMIN sharee（可能是金鑰外流，也可能只是浮動 IP），
    /// 也發給訂了的 webhook（他們自己的與全站的）。gateway 與 `device_info` 共用。
    /// The device's public IP changed: log `ip_changed`, tell the owner and ADMIN sharees, and emit the webhook event.
    pub async fn announce_ip_change(&self, port: u16, ch: &db::tunnel_endpoints::IpChange, ip: &str, peer: Option<SocketAddr>) {
        let message = format!("Tunnel {} now connects from {} (was {})", ch.tunnel_name, ip, ch.previous);
        self.event("ip_changed", peer, Some(port), Some(ch.tunnel_id), message.clone()).await;
        let mut users = vec![ch.owner_id];
        users.extend(db::sharing::admin_sharee_ids(&self.db, ch.tunnel_id).await.unwrap_or_default());
        self.hub.notify_users(
            users.clone(),
            &serde_json::json!({
                "action": "TUNNEL-IP-CHANGED",
                "tunnel_id": ch.tunnel_id,
                "tunnel_name": ch.tunnel_name,
                "ip": ip,
                "previous_ip": ch.previous,
                "details": message,
            }),
        );
        let tunnel = crate::webhooks::TunnelRef { id: ch.tunnel_id, name: ch.tunnel_name.clone(), reverse_port: i64::from(port) };
        self.webhooks.emit(
            crate::webhooks::Event::new(crate::webhooks::Kind::TunnelIpChanged)
                .tunnel_ref(tunnel)
                .to(users, None)
                .data(serde_json::json!({ "ip": ip, "previous_ip": ch.previous })),
        );
    }

    /// 筆電經 gateway 連到裝置（使用者金鑰的 direct-tcpip）：算進「誰在用這條隧道」。
    /// A laptop reaching a device through the gateway counts as using that tunnel.
    async fn ssh_presence(&self, user_id: i64, port: u16, peer: SocketAddr) -> Option<PresenceGuard> {
        let tunnel = db::tunnels::by_port(&self.db, port as i64).await.ok()?.into_iter().next()?;
        let user = db::users::by_id(&self.db, user_id).await.ok().flatten()?;
        let ip = Some(peer.ip().to_canonical().to_string());
        Some(self.presence.join(presence::Entry::new(tunnel.id, user_id, &user.username, presence::Kind::Ssh, ip)))
    }

    async fn remember_release(&self, port: u16) {
        let now = crate::util::now_db();
        if let Err(e) = db::tunnel_endpoints::record_released(&self.db, port, &now).await {
            tracing::warn!(port, error = %e, "gateway: cannot record tunnel release");
        }
        if let Err(e) = db::tunnel_sessions::close(&self.db, port, &now).await {
            tracing::warn!(port, error = %e, "gateway: cannot close tunnel session");
        }
    }

    /// 金鑰 → 身分（InternalKeysView 的規則，但不含服務金鑰）。
    async fn identify(&self, bare: &str) -> anyhow::Result<Option<Identity>> {
        let like = like_prefix(bare);
        if let Some(t) = db::tunnels::by_key_prefix(&self.db, &like).await? {
            // 也是擁有者自己（沒到期）的個人金鑰？是的話這條連線也能當人用。只認同一個人的：別人的個人金鑰
            // 本來就登記不成裝置金鑰，舊資料也不給。
            // Also the owner's own (unexpired) personal key? Then the connection may act as that person too. Only the
            // same person's: another user's personal key cannot become a device key, and old rows don't count either.
            let person = db::keys::user_key_owner_by_prefix(&self.db, &like).await? == Some(t.user_id) && self.person_allowed(t.user_id).await?;
            return Ok(Some(Identity::Tunnel { tunnel_id: t.id, user_id: t.user_id, reverse_port: t.reverse_port, person }));
        }
        if let Some(uid) = db::keys::user_key_owner_by_prefix(&self.db, &like).await? {
            if !self.person_allowed(uid).await? {
                return Ok(None);
            }
            let has_tunnels = !db::tunnels::keys_for_user(&self.db, uid).await?.is_empty();
            let has_shares = db::sharing::user_has_any_share(&self.db, uid).await?;
            if has_tunnels || has_shares {
                return Ok(Some(Identity::User { user_id: uid }));
            }
            tracing::info!(user_id = uid, "gateway: user key owner has no tunnels and no shares; rejected");
            return Ok(None);
        }
        Ok(None)
    }

    /// 這個人現在可以用個人金鑰經 gateway 連裝置嗎（帳號啟用、功能沒關）。
    /// Whether this person may use a personal key through the gateway now (account active, feature on).
    async fn person_allowed(&self, uid: i64) -> anyhow::Result<bool> {
        let Some(user) = db::users::by_id(&self.db, uid).await? else { return Ok(true) };
        // 停用的帳號：金鑰還在，但不能再經 gateway 連裝置。/ A disabled account's keys stay but are refused.
        if !user.is_active {
            tracing::info!(user_id = uid, "gateway: the key's account is disabled; rejected");
            return Ok(false);
        }
        // 功能權限：「個人 SSH 金鑰」被關掉的人不能用金鑰經 gateway 連裝置。/ Personal SSH keys turned off: refused.
        if !self.features.allowed(&user, crate::features::Feature::KeysPersonal).await? {
            tracing::info!(user_id = uid, "gateway: personal SSH keys are turned off for this user; rejected");
            return Ok(false);
        }
        Ok(true)
    }

    /// 誰可以要求在 port 上做 reverse forward：隧道金鑰只能開自己的 port；使用者金鑰只能開自己擁有的隧道。
    /// 被分享的人不行，否則裝置離線時可以佔住該 port 冒充裝置（後端連裝置不驗 host key）。
    async fn may_forward(&self, id: &Identity, port: u16) -> anyhow::Result<bool> {
        Ok(match id {
            Identity::Tunnel { reverse_port, .. } => *reverse_port == port as i64,
            Identity::User { user_id } => db::tunnels::by_port(&self.db, port as i64).await?.iter().any(|t| t.user_id == *user_id),
        })
    }

    /// 使用者是否可以經 direct-tcpip 連到 port：擁有者、ADMIN sharee，或至少有一個允許帳號的 sharee。
    /// 只看狀態的 sharee（沒有允許帳號）連不到裝置的 sshd：允許清單是唯一邊界（裝置分不出 Telepy 使用者），
    /// 沒有金鑰他登不進去，但裝置若開了密碼登入就能一直試。
    /// Owner, ADMIN sharee, or a sharee with at least one allowed account; a status-only sharee never reaches the device's sshd.
    async fn user_can_reach(&self, user_id: i64, port: u16) -> anyhow::Result<bool> {
        for t in db::tunnels::by_port(&self.db, port as i64).await? {
            if self.reaches(user_id, &t).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `direct-tcpip` 的名稱 → 隧道號碼。OpenSSH 會把 `HostName` 轉成小寫再放進 ProxyCommand 的 `%h`（`MyBox` 到這裡是
    /// `mybox`），所以不分大小寫：完全相同的排前面，挑第一條這個身分有權連的；都沒有權限就回完全相同的那條（沒有完全相同、
    /// 又只有一條時就是那條），拒絕才記在對的隧道上。只差大小寫又都能連的兩條：完全相同的那條。
    /// A `direct-tcpip` name → the tunnel's number. OpenSSH lowercases `HostName` before ProxyCommand's `%h` (`MyBox`
    /// arrives as `mybox`), so case is ignored: exact first, then the first match this identity may reach; with none
    /// reachable, the exact match (else the only one), so a refusal is logged on the right tunnel.
    async fn port_by_name(&self, id: Option<&Identity>, name: &str) -> anyhow::Result<Option<u16>> {
        let matches = db::tunnels::by_name_ignoring_case(&self.db, name).await?;
        if let Some(user_id) = id.and_then(Identity::person) {
            for t in &matches {
                if self.reaches(user_id, t).await? {
                    return Ok(u16::try_from(t.reverse_port).ok());
                }
            }
        }
        let fallback = matches.iter().find(|t| t.host_friendly_name == name).or(if matches.len() == 1 { matches.first() } else { None });
        Ok(fallback.and_then(|t| u16::try_from(t.reverse_port).ok()))
    }

    /// 這個人能不能經 gateway 連到這條隧道的裝置（`user_can_reach` 與招呼的裝置清單共用）。
    /// Whether this person may reach the tunnel's device through the gateway (shared by `user_can_reach` and the greeting).
    async fn reaches(&self, user_id: i64, t: &db::tunnels::Tunnel) -> anyhow::Result<bool> {
        if t.user_id == user_id {
            return Ok(true);
        }
        let Some(share) = db::sharing::get(&self.db, t.id, user_id).await? else { return Ok(false) };
        let eff = crate::permissions::effective(user_id, t.user_id, Some(share.permission()));
        Ok(crate::permissions::can_reach_device(eff, !db::sharing::allowed_usernames(&self.db, share.id).await?.is_empty()))
    }

    /// 招呼全文：使用者的語言、名稱、能連的裝置（照名稱排序）。/ The greeting in the user's language with their reachable devices.
    async fn greeting(&self, user_id: i64, tty: bool) -> anyhow::Result<String> {
        let username = db::users::by_id(&self.db, user_id).await?.map(|u| u.username).unwrap_or_default();
        let settings = db::users::settings_for(&self.db, user_id).await?;
        let language = settings.as_ref().and_then(|s| s.language.clone());
        let clip = settings.as_ref().and_then(|s| crate::mascot::clip_color(crate::mascot::clip_name(&s.tapi_color, crate::mascot::unix_day())));
        let mut names = Vec::new();
        for t in db::tunnels::visible_to(&self.db, user_id).await? {
            if self.reaches(user_id, &t).await? {
                names.push(t.host_friendly_name);
            }
        }
        names.sort_by_key(|n| n.to_lowercase());
        Ok(greeting::text(greeting::Lang::from_setting(language.as_deref()), &username, &names, tty, self.config.public_base().as_deref(), clip))
    }

    async fn may_connect(&self, id: &Identity, port: u16) -> anyhow::Result<bool> {
        if !self.forwards.contains_key(&port) {
            return Ok(false);
        }
        Ok(match id.person() {
            Some(user_id) => self.user_can_reach(user_id, port).await?,
            None => false,
        })
    }

    /// 記住 port → 這條連線（不綁本機 port）。交接開著、而且是同一條隧道的第二條連線時，先當備援。
    /// Remember port → connection; nothing is bound locally. During a handover a second connection of the same tunnel
    /// becomes the standby instead of being refused.
    fn register_forward(&self, conn_id: u64, address: &str, port: u16, client_port: u32, handle: Handle) -> anyhow::Result<Registered> {
        let fwd = || Arc::new(Forward { port, address: address.to_string(), client_port, conn_id, handle: handle.clone() });
        if let Some(existing) = self.forwards.get(&port).map(|f| f.clone()) {
            if existing.conn_id == conn_id {
                return Ok(Registered::Primary);
            }
            if self.conns.contains_key(&existing.conn_id) {
                let same_tunnel = self.tunnel_of(conn_id).is_some() && self.tunnel_of(conn_id) == self.tunnel_of(existing.conn_id);
                if self.handover_open(port) && same_tunnel {
                    if self.standby_conn(port).is_some_and(|c| c != conn_id) {
                        bail!("port {port} already has a standby connection");
                    }
                    self.standby.insert(port, fwd());
                    return Ok(Registered::Standby);
                }
                bail!("port {port} is already forwarded by another live connection");
            }
            // 擁有者已斷線但尚未清理：接手。/ Stale owner: take over.
            self.forwards.remove(&port);
        }
        self.forwards.insert(port, fwd());
        self.publish_status();
        Ok(Registered::Primary)
    }

    fn unregister_forward(&self, conn_id: u64, port: u16) -> bool {
        self.standby.remove_if(&port, |_, f| f.conn_id == conn_id);
        let owned = self.forwards.get(&port).map(|f| f.conn_id == conn_id).unwrap_or(false);
        if owned {
            self.forwards.remove(&port);
            self.publish_status();
        }
        owned
    }

    /// 斷線：放掉它的 forward；有活著的備援就由備援接手（回傳接手的 port 與新連線）。
    /// Disconnect: release its forwards, except where a live standby takes over (returned with the new connection).
    fn on_disconnect(&self, conn_id: u64) -> (Vec<u16>, Vec<(u16, u64)>, Option<ConnInfo>) {
        let info = self.conns.remove(&conn_id).map(|(_, v)| v);
        self.standby.retain(|_, f| f.conn_id != conn_id);
        let mut dropped = Vec::new();
        self.forwards.retain(|port, f| {
            if f.conn_id == conn_id {
                dropped.push(*port);
                false
            } else {
                true
            }
        });
        let mut promoted = Vec::new();
        dropped.retain(|port| match self.standby.remove(port) {
            Some((_, s)) if self.conns.contains_key(&s.conn_id) => {
                promoted.push((*port, s.conn_id));
                self.forwards.insert(*port, s);
                false
            }
            _ => true,
        });
        self.publish_status();
        (dropped, promoted, info)
    }

    /// 每條 forward 開一條 forwarded-tcpip 通道、讀裝置 sshd banner 的第一個 byte，當作 RTT。
    pub async fn probe_latency(&self) -> HashMap<u16, f64> {
        let forwards: Vec<Arc<Forward>> = self.forwards.iter().map(|e| e.value().clone()).collect();
        let probed: Vec<u16> = forwards.iter().map(|f| f.port).collect();
        let probes = forwards.into_iter().map(|f| async move {
            let started = Instant::now();
            let res = tokio::time::timeout(PROBE_TIMEOUT, async {
                let ch = f.handle.channel_open_forwarded_tcpip(f.address.clone(), f.client_port, "127.0.0.1", 0).await.map_err(|e| anyhow::anyhow!("{e}"))?;
                let mut s = ch.into_stream();
                let mut b = [0u8; 1];
                let n = s.read(&mut b).await?;
                if n == 0 {
                    bail!("eof before banner");
                }
                Ok::<_, anyhow::Error>(())
            })
            .await;
            match res {
                Ok(Ok(())) => Some((f.port, (started.elapsed().as_secs_f64() * 10000.0).round() / 10.0)),
                _ => None,
            }
        });
        let results = futures::future::join_all(probes).await;
        let map: HashMap<u16, f64> = results.into_iter().flatten().collect();
        let before = self.status.degraded_ports();
        self.status.record_probes(&probed, map.clone());
        self.log_health_changes(&before, &self.status.degraded_ports()).await;
        map
    }

    /// 降級 / 恢復寫進 gateway 事件（隧道的 Logs 頁看得到）。forward 已經不在的不記：斷線事件已經說明了。
    /// Degraded / recovered go to the gateway events (the tunnel's Logs); ports whose forward is gone are skipped.
    async fn log_health_changes(&self, before: &HashSet<u16>, after: &HashSet<u16>) {
        for port in after.difference(before) {
            let tunnel_id = db::tunnels::by_port(&self.db, *port as i64).await.ok().and_then(|t| t.into_iter().next()).map(|t| t.id);
            let n = self.status.probe_failures(*port);
            self.event("degraded", None, Some(*port), tunnel_id, format!("Tunnel on port {port} is up but the device's SSH server is not answering ({n} probes in a row failed)")).await;
        }
        for port in before.difference(after) {
            if !self.forwards.contains_key(port) {
                continue;
            }
            let tunnel_id = db::tunnels::by_port(&self.db, *port as i64).await.ok().and_then(|t| t.into_iter().next()).map(|t| t.id);
            self.event("recovered", None, Some(*port), tunnel_id, format!("The device's SSH server answers again on port {port}")).await;
        }
    }

    pub async fn run_probes(self: Arc<Self>, interval: Duration) {
        loop {
            tokio::time::sleep(interval).await;
            self.probe_latency().await;
        }
    }
}

/// direct-tcpip channel ↔ forwarded-tcpip channel（使用者金鑰的 `ssh -W`）。
async fn bridge_channels(fwd: Arc<Forward>, client: Channel<Msg>, originator: String, originator_port: u32) -> anyhow::Result<()> {
    let device = fwd
        .handle
        .channel_open_forwarded_tcpip(fwd.address.clone(), fwd.client_port, originator, originator_port)
        .await
        .map_err(|e| anyhow::anyhow!("open forwarded-tcpip: {e}"))?;
    let mut a = client.into_stream();
    let mut b = device.into_stream();
    tokio::io::copy_bidirectional(&mut a, &mut b).await?;
    Ok(())
}

pub struct GatewayHandler {
    gw: Arc<Gateway>,
    conn_id: u64,
    peer: SocketAddr,
    transport: Transport,
    identity: Option<Identity>,
    offered: Option<String>,
    key_desc: String,
    authed: Arc<AtomicBool>,
    /// 開著的招呼 channel → 有沒有要過 pty。/ Open greeting channels → whether a pty was asked for.
    greetings: HashMap<ChannelId, bool>,
}

/// 一條連線最多同時開幾個招呼 channel。/ Greeting channels open at once per connection.
const MAX_GREETINGS: usize = 2;

impl GatewayHandler {
    /// 招呼一個 shell / exec 要求：印出招呼、exit 1、關掉。什麼都不執行。
    /// Answer a shell / exec request: print the greeting, exit 1, close. Nothing is run.
    async fn greet(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), anyhow::Error> {
        let Some(tty) = self.greetings.remove(&channel) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        let Some(user_id) = self.identity.as_ref().and_then(Identity::person) else {
            session.channel_failure(channel)?;
            session.close(channel)?;
            return Ok(());
        };
        session.channel_success(channel)?;
        let text = match self.gw.greeting(user_id, tty).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, "gateway: cannot build the greeting");
                greeting::text(greeting::Lang::En, "", &[], tty, None, None)
            }
        };
        session.data(channel, text.into_bytes())?;
        session.exit_status_request(channel, 1)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

impl Handler for GatewayHandler {
    type Error = anyhow::Error;

    async fn auth_publickey_offered(&mut self, user: &str, key: &russh::keys::PublicKey) -> Result<Auth, Self::Error> {
        if user != self.gw.config.gateway_user {
            self.gw.event("invalid_user", Some(self.peer), None, None, format!("Invalid user {user} from {} port {}", self.peer.ip(), self.peer.port())).await;
            return Ok(Auth::reject());
        }
        let bare = bare_key(key)?;
        match self.gw.identify(&bare).await? {
            Some(id) => {
                self.identity = Some(id);
                self.offered = Some(bare);
                self.key_desc = format!("{} {}", alg_label(key), key.fingerprint(HashAlg::Sha256));
                Ok(Auth::Accept)
            }
            None => {
                // 到期的個人金鑰：講清楚是到期，不是不認得。/ An expired personal key says so, not just "failed".
                if let Ok(Some((name, at))) = db::keys::expired_user_key_by_prefix(&self.gw.db, &like_prefix(&bare)).await {
                    self.gw.event("expired_key", Some(self.peer), None, None, format!("Expired key \"{name}\" (expired {at} UTC) for {user} from {} port {} ssh2: {} {}", self.peer.ip(), self.peer.port(), alg_label(key), key.fingerprint(HashAlg::Sha256))).await;
                    return Ok(Auth::reject());
                }
                self.gw.event("failed_publickey", Some(self.peer), None, None, format!("Failed publickey for {user} from {} port {} ssh2: {} {}", self.peer.ip(), self.peer.port(), alg_label(key), key.fingerprint(HashAlg::Sha256))).await;
                Ok(Auth::reject())
            }
        }
    }

    async fn auth_publickey(&mut self, user: &str, key: &russh::keys::PublicKey) -> Result<Auth, Self::Error> {
        if user != self.gw.config.gateway_user || self.identity.is_none() {
            return Ok(Auth::reject());
        }
        let bare = bare_key(key)?;
        if self.offered.as_deref() == Some(bare.as_str()) {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_succeeded(&mut self, _session: &mut Session) -> Result<(), Self::Error> {
        self.authed.store(true, Ordering::SeqCst);
        if let Some(id) = &self.identity {
            self.gw.conns.insert(self.conn_id, ConnInfo { peer: self.peer, identity: id.clone(), since: crate::util::now_db(), transport: self.transport });
        }
        let tunnel_id = match &self.identity {
            Some(Identity::Tunnel { tunnel_id, .. }) => Some(*tunnel_id),
            _ => None,
        };
        // 使用者金鑰：記下最後使用時間與來源（金鑰頁顯示）。/ Record when and from where a user key was last used.
        if let (Some(_), Some(bare)) = (self.identity.as_ref().and_then(Identity::person), &self.offered) {
            if let Err(e) = db::keys::touch_last_used(&self.gw.db, &like_prefix(bare), &self.peer.ip().to_string()).await {
                tracing::debug!(error = %e, "gateway: cannot record user key use");
            }
        }
        self.gw
            .event(
                "accepted",
                Some(self.peer),
                None,
                tunnel_id,
                format!(
                    "Accepted publickey for {} from {} port {} ssh2: {}{}",
                    self.gw.config.gateway_user,
                    self.peer.ip(),
                    self.peer.port(),
                    self.key_desc,
                    if self.transport == Transport::WebSocket { " (over websocket)" } else { "" }
                ),
            )
            .await;
        Ok(())
    }

    async fn tcpip_forward(&mut self, address: &str, port: &mut u32, session: &mut Session) -> Result<bool, Self::Error> {
        let Some(id) = self.identity.clone() else { return Ok(false) };
        let requested = *port;
        // 隧道金鑰已經認出是哪條隧道：裝置要求哪個號碼都無所謂（0 也行），forward 一律記在隧道自己的號碼下，
        // 回給裝置的也是那個號碼。使用者金鑰認不出隧道，照舊只能開自己擁有的隧道的號碼。
        // A tunnel key identifies the tunnel: whatever number the device asks for (0 included), the forward is
        // registered under the tunnel's own number, which is also what the device is told. A user key cannot
        // identify a tunnel, so it still has to ask for the number of a tunnel the user owns.
        let (p, tunnel_id) = match &id {
            Identity::Tunnel { tunnel_id, reverse_port, .. } => match u16::try_from(*reverse_port) {
                Ok(p) => (p, Some(*tunnel_id)),
                Err(_) => return Ok(false),
            },
            Identity::User { .. } => {
                let Ok(p) = u16::try_from(requested) else { return Ok(false) };
                if p == 0 || !self.gw.may_forward(&id, p).await? {
                    self.gw.event("refused_forward", Some(self.peer), Some(p), None, format!("Refused remote forward for port {p} from {} port {} (not authorized)", self.peer.ip(), self.peer.port())).await;
                    return Ok(false);
                }
                (p, None)
            }
        };
        *port = u32::from(p);
        // 裝置要求了一個號碼（不是 0）時，它的 OpenSSH 只記得那個號碼：之後開 forwarded-tcpip 要用它。
        // A device that asked for a number (not 0) only remembers that one: forwarded-tcpip channels must use it.
        let client_port = if requested == 0 { u32::from(p) } else { requested };
        let asked = if requested != u32::from(p) { format!(" (the device asked for {requested})") } else { String::new() };
        match self.gw.register_forward(self.conn_id, address, p, client_port, session.handle()) {
            Ok(Registered::Standby) => {
                self.gw.event("standby_forward", Some(self.peer), Some(p), tunnel_id, format!("Standby forward on port {p} from {} port {} (waiting to take over from the running connection)", self.peer.ip(), self.peer.port())).await;
                Ok(true)
            }
            Ok(Registered::Primary) => {
                self.gw.event("forward", Some(self.peer), Some(p), tunnel_id, format!("Remote forward registered on port {p} for {} port {}{asked}", self.peer.ip(), self.peer.port())).await;
                self.gw.remember_endpoint(self.conn_id, p).await;
                Ok(true)
            }
            Err(e) => {
                self.gw.event("refused_forward", Some(self.peer), Some(p), tunnel_id, format!("Refused remote forward for port {p} from {} port {}: {e}", self.peer.ip(), self.peer.port())).await;
                Ok(false)
            }
        }
    }

    async fn cancel_tcpip_forward(&mut self, _address: &str, port: u32, _session: &mut Session) -> Result<bool, Self::Error> {
        // 隧道金鑰：取消的是它自己的號碼（不管當初要求的是什麼）。/ A tunnel key cancels its own number.
        let p = match &self.identity {
            Some(Identity::Tunnel { reverse_port, .. }) => match u16::try_from(*reverse_port) {
                Ok(p) => p,
                Err(_) => return Ok(false),
            },
            _ => match u16::try_from(port) {
                Ok(p) => p,
                Err(_) => return Ok(false),
            },
        };
        let released = self.gw.unregister_forward(self.conn_id, p);
        if released {
            self.gw.remember_release(p).await;
        }
        Ok(released)
    }

    async fn channel_open_session(&mut self, channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        // 隧道金鑰（裝置）不開 session；個人金鑰只開來印招呼（最多同時 2 個），不配 pty、不執行任何東西。
        // Tunnel keys get no session; a personal key gets one only for the greeting (≤ 2 at once): no pty, nothing run.
        if self.identity.as_ref().and_then(Identity::person).is_none() || self.greetings.len() >= MAX_GREETINGS {
            reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        }
        self.greetings.insert(channel.id(), false);
        reply.accept().await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(&mut self, channel: ChannelId, _term: &str, _cols: u32, _rows: u32, _pw: u32, _ph: u32, _modes: &[(russh::Pty, u32)], session: &mut Session) -> Result<(), Self::Error> {
        // 只記下「要了 pty」（招呼可以畫圖、上色）；什麼都不配。/ Only remember a pty was asked for; nothing is allocated.
        match self.greetings.get_mut(&channel) {
            Some(tty) => {
                *tty = true;
                session.channel_success(channel)?;
            }
            None => session.channel_failure(channel)?,
        }
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        self.greet(channel, session).await
    }

    async fn exec_request(&mut self, channel: ChannelId, _data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        // 指令內容不看、不記、不執行。/ The command is neither read, logged nor run.
        self.greet(channel, session).await
    }

    async fn subsystem_request(&mut self, channel: ChannelId, _name: &str, session: &mut Session) -> Result<(), Self::Error> {
        // sftp 等 subsystem：拒絕並關掉。/ sftp and other subsystems: refused, channel closed.
        session.channel_failure(channel)?;
        if self.greetings.remove(&channel).is_some() {
            session.close(channel)?;
        }
        Ok(())
    }

    async fn x11_request(&mut self, channel: ChannelId, _single: bool, _proto: &str, _cookie: &str, _screen: u32, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn env_request(&mut self, channel: ChannelId, _name: &str, _value: &str, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn channel_close(&mut self, channel: ChannelId, _session: &mut Session) -> Result<(), Self::Error> {
        self.greetings.remove(&channel);
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        originator_address: &str,
        originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // `localhost:<號碼>`（舊寫法）或 `<隧道名稱>:<任意 port>`：名稱全站唯一，直接換成那條隧道的號碼。
        // `localhost:<number>` (the old form) or `<tunnel name>:<any port>`: names are unique, so the name picks the tunnel.
        let loopback = matches!(host_to_connect, "localhost" | "127.0.0.1" | "::1");
        let port = if loopback { u16::try_from(port_to_connect).ok() } else { self.gw.port_by_name(self.identity.as_ref(), host_to_connect).await? };
        let allowed = match (port, &self.identity) {
            (Some(p), Some(id)) => self.gw.may_connect(id, p).await?,
            _ => false,
        };
        let Some(fwd) = port.and_then(|p| self.gw.forwards.get(&p).map(|f| f.clone())).filter(|_| allowed) else {
            // 記在那條隧道上（有的話）：擁有者在 Logs 看得到誰敲過門。/ On the tunnel when there is one, so its owner sees it in Logs.
            let tunnel_id = match port {
                Some(p) => db::tunnels::by_port(&self.gw.db, p as i64).await?.first().map(|t| t.id),
                None => None,
            };
            self.gw.event("refused_direct", Some(self.peer), port, tunnel_id, format!("Refused direct-tcpip to {host_to_connect}:{port_to_connect} from {} port {}", self.peer.ip(), self.peer.port())).await;
            reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        };
        // 敏感隧道：這個人 15 分鐘內在網頁確認過才放行；沒有就拒絕，並請他到網頁確認。
        // Sensitive tunnel: only after a web confirmation within the window; otherwise refuse and ask in the web.
        if let (Some(user_id), Some(p)) = (self.identity.as_ref().and_then(Identity::person), port) {
            if let Some(t) = self.gw.step_up_blocks(user_id, p).await? {
                let msg = format!("Refused direct-tcpip to tunnel {} for user {user_id}: confirm it's you in Telepy first (step-up) from {} port {}", t.host_friendly_name, self.peer.ip(), self.peer.port());
                self.gw.event("step_up_required", Some(self.peer), port, Some(t.id), msg).await;
                self.gw.hub.notify_user(
                    user_id,
                    &serde_json::json!({ "action": "STEP-UP-REQUIRED", "tunnel_id": t.id, "tunnel_name": t.host_friendly_name,
                                         "details": format!("SSH to \"{}\" needs you to confirm it's you in Telepy first", t.host_friendly_name) }),
                );
                reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
                return Ok(());
            }
        }
        reply.accept().await;
        let originator = originator_address.to_string();
        let guard = match (self.identity.as_ref().and_then(Identity::person), port) {
            (Some(user_id), Some(p)) => self.gw.ssh_presence(user_id, p, self.peer).await,
            _ => None,
        };
        let gw = self.gw.clone();
        let peer = self.peer;
        let fwd_port = fwd.port;
        tokio::spawn(async move {
            let bridge = bridge_channels(fwd, channel, originator, originator_port);
            let result = match guard {
                // 有人從即時 session 頁結束它：丟掉兩端的 stream，筆電的 ssh 跟著斷。
                // Ended from the live sessions page: dropping both streams ends the laptop's ssh.
                Some(mut presence) => tokio::select! {
                    r = bridge => r,
                    by = presence.ended() => {
                        tracing::info!(by = %by, "gateway: laptop ssh session ended from the web");
                        // 失去權限 / 功能被關掉（有原因）：記在隧道的 Logs，跟其他 session 的 `*_close` 一樣說為什麼。
                        // Access lost / feature off (a reason is given): log it on the tunnel, like the other `*_close` events.
                        if presence.why().is_some() {
                            if let Some(e) = gw.presence.get(presence.id()) {
                                let msg = format!("Laptop SSH by {} from {} {}", e.username, peer.ip(), presence.ended_note(&by));
                                gw.event("session_ended", Some(peer), Some(fwd_port), Some(e.tunnel_id), msg).await;
                            }
                        }
                        Ok(())
                    }
                },
                None => bridge.await,
            };
            if let Err(e) = result {
                tracing::debug!(error = %e, "gateway: direct-tcpip bridge ended with error");
            }
        });
        Ok(())
    }
}

impl Drop for GatewayHandler {
    fn drop(&mut self) {
        self.gw.live.fetch_sub(1, Ordering::SeqCst);
        let (dropped, promoted, info) = self.gw.on_disconnect(self.conn_id);
        let gw = self.gw.clone();
        let peer = info.as_ref().map(|i| i.peer).unwrap_or(self.peer);
        let identity = info.map(|i| i.identity);
        let tunnel_id = match &identity {
            Some(Identity::Tunnel { tunnel_id, .. }) => Some(*tunnel_id),
            _ => None,
        };
        let who = match identity {
            Some(Identity::Tunnel { tunnel_id, user_id, person: true, .. }) => format!(" (tunnel {tunnel_id}, user {user_id})"),
            Some(Identity::Tunnel { tunnel_id, .. }) => format!(" (tunnel {tunnel_id})"),
            Some(Identity::User { user_id }) => format!(" (user {user_id})"),
            None => String::new(),
        };
        let authed = self.authed.load(Ordering::SeqCst);
        let user = gw.config.gateway_user.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                if authed {
                    gw.event("disconnect", Some(peer), None, tunnel_id, format!("Disconnected from user {user}{who} {} port {}", peer.ip(), peer.port())).await;
                    for p in dropped {
                        gw.event("forward_released", Some(peer), Some(p), tunnel_id, format!("Remote forward on port {p} released ({} port {})", peer.ip(), peer.port())).await;
                        gw.remember_release(p).await;
                    }
                    for (p, new_conn) in promoted {
                        gw.event("handover", Some(peer), Some(p), tunnel_id, format!("Remote forward on port {p} moved to the standby connection ({} port {} disconnected)", peer.ip(), peer.port())).await;
                        gw.remember_endpoint(new_conn, p).await;
                    }
                } else {
                    gw.event("preauth_close", Some(peer), None, None, format!("Connection closed by authenticating user {user} {} port {} [preauth]", peer.ip(), peer.port())).await;
                }
            });
        }
    }
}

/// 等代理送 PROXY header 最多多久。/ How long a proxy gets to send its header.
const PROXY_HEADER_TIMEOUT: Duration = Duration::from_secs(5);

async fn handle_connection(gw: Arc<Gateway>, mut stream: TcpStream, peer: SocketAddr) {
    let _ = stream.set_nodelay(true);
    // 前面有 L4 代理時，真正的來源在它送的 PROXY header 裡；只有列出的代理要送、也才會被讀。
    // Behind an L4 proxy the real source is in its PROXY header; only listed proxies send one (and are read).
    // 列出的來源：先偷看第一個 byte（不消耗），是 header 才讀；沒有 header 就是直連。
    // Listed sources: peek at the first byte (not consumed); read a header only if one starts there.
    // 會先送 PROXY header 的 L4 代理（GATEWAY_PROXY_PROTOCOL_FROM / 網站設定），每條連線讀一次，存檔不必重啟。
    // The proxies that send a PROXY header (env / site setting), read per connection so a save needs no restart.
    if !gw.config.proxy_protocol_from().contains(peer.ip()) {
        // 沒列出的來源：header 從不讀、不採信（誰都能自稱別的 IP）；只看第一段資料認出它，提醒管理員。
        // russh 不接受 banner 前的東西，所以這條連線會在握手失敗。
        // Unlisted: a header is never read or trusted (anyone could claim any address); the first chunk is only
        // looked at to point the admin to it. russh accepts nothing before the banner, so the handshake fails.
        let watcher = gw.clone();
        let stream = peers::FirstRead::new(
            stream,
            Box::new(move |first: &[u8]| {
                let header = peers::looks_like_proxy_header(first);
                if watcher.peers.record(peer.ip(), header, false) {
                    let message = format!(
                        "Connection from {} port {} began with a PROXY protocol header, but {} is not a PROXY protocol source: the header was not read and the connection failed",
                        peer.ip(),
                        peer.port(),
                        peer.ip()
                    );
                    tokio::spawn(async move { watcher.event("proxy_unlisted", Some(peer), None, None, message).await });
                }
            }),
        );
        serve(gw, stream, peer, Transport::Tcp).await;
        return;
    }
    let mut first = [0u8; 1];
    let peer = match tokio::time::timeout(PROXY_HEADER_TIMEOUT, stream.peek(&mut first)).await {
        Ok(Ok(0)) | Ok(Err(_)) => {
            tracing::debug!(%peer, "gateway: connection closed before sending anything (health check)");
            return;
        }
        // 直連（SSH 以 `SSH-` 開頭），或 5 秒都沒送東西的客戶端（等我們先送 banner）。/ Direct, or a client waiting for our banner.
        Ok(Ok(_)) if !proxy_protocol::starts_header(first[0]) => {
            gw.peers.record(peer.ip(), false, true);
            peer
        }
        Err(_) => {
            gw.peers.record(peer.ip(), false, true);
            peer
        }
        Ok(Ok(_)) => match tokio::time::timeout(PROXY_HEADER_TIMEOUT, proxy_protocol::read_header(&mut stream)).await {
            Ok(Ok(header)) => {
                gw.peers.record(peer.ip(), true, true);
                match header {
                    proxy_protocol::Header::Proxied(source) => source,
                    proxy_protocol::Header::Local => peer,
                }
            }
            Ok(Err(e)) => {
                let message = format!("Refused connection from {} port {}: bad PROXY protocol header: {e}", peer.ip(), peer.port());
                gw.event("refused_proxy", Some(peer), None, None, message).await;
                return;
            }
            Err(_) => {
                let message = format!("Refused connection from {} port {}: incomplete PROXY protocol header after {}s", peer.ip(), peer.port(), PROXY_HEADER_TIMEOUT.as_secs());
                gw.event("refused_proxy", Some(peer), None, None, message).await;
                return;
            }
        },
    };
    serve(gw, stream, peer, Transport::Tcp).await;
}

/// 在任何雙向串流上跑一條 gateway 連線：24242 的 TCP、或 `/ws/gateway/` 轉成的串流（`ws::gateway::WsStream`）。
/// 握手、認證、forward、事件都一樣；`transport` 只記在連線資訊與 `accepted` 事件裡。
/// One gateway connection on any byte stream: the TCP listener or a WebSocket. Everything else is identical.
pub async fn serve<S>(gw: Arc<Gateway>, stream: S, peer: SocketAddr, transport: Transport)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let conn_id = gw.next_id.fetch_add(1, Ordering::SeqCst);
    let authed = Arc::new(AtomicBool::new(false));
    // `live` 在 GatewayHandler::drop 歸還，握手失敗 / 逾時時 handler 也會被 drop。/ Released in GatewayHandler::drop.
    gw.live.fetch_add(1, Ordering::SeqCst);
    let handler = GatewayHandler { gw: gw.clone(), conn_id, peer, transport, identity: None, offered: None, key_desc: String::new(), authed: authed.clone(), greetings: HashMap::new() };
    let grace = gw.config.gateway_login_grace;
    // 握手（版本交換 + KEX）也受 LoginGraceTime 約束：連上來不講話的連線不能無限期占位。
    // The handshake is bounded by the login grace time too, so an idle pre-KEX connection cannot hold a slot forever.
    let session = match tokio::time::timeout(grace, server::run_stream(gw.server_config.clone(), stream, handler)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            tracing::debug!(%peer, error = %e, "gateway: handshake failed");
            return;
        }
        Err(_) => {
            tracing::debug!(%peer, "gateway: handshake timed out");
            return;
        }
    };
    // LoginGraceTime：逾時未認證就斷線。
    let grace_handle = session.handle();
    let grace_flag = authed.clone();
    tokio::spawn(async move {
        tokio::time::sleep(grace).await;
        if !grace_flag.load(Ordering::SeqCst) {
            let _ = grace_handle.disconnect(Disconnect::ByApplication, "login grace time exceeded".into(), String::new()).await;
        }
    });
    if let Err(e) = session.await {
        tracing::debug!(%peer, error = %e, "gateway: session ended with error");
    }
}

/// 接受連線直到 listener 關閉。回傳 accept loop 的 JoinHandle。
pub fn start(gw: Arc<Gateway>, listener: TcpListener) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    if gw.host_keys_loaded == 0 {
        bail!("no host keys loaded; set GATEWAY_HOST_KEYS_DIR to a directory with ssh_host_*_key files");
    }
    gw.publish_status();
    let addr = listener.local_addr()?;
    tracing::info!(%addr, host_keys = gw.host_keys_loaded, "SSH gateway listening");
    let startup = gw.clone();
    Ok(tokio::spawn(async move {
        let gw = startup;
        // sshd 也會寫這行；確保 Logs 頁從第一天就有內容。/ sshd logs this too; the Logs page is never empty.
        gw.event("listening", None, Some(addr.port()), None, format!("Server listening on {} port {}.", addr.ip(), addr.port())).await;
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "gateway: accept failed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            if gw.at_capacity() {
                tracing::warn!(%peer, "gateway: connection limit reached; dropping");
                continue;
            }
            tokio::spawn(handle_connection(gw.clone(), stream, peer));
        }
    }))
}
