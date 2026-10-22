//! 內建 SSH gateway：後端自己終結裝置的反向隧道（取代 OpenSSH 容器 + AuthorizedKeysCommand + ss/探測腳本）。
//!
//! 只實作裝置端 `ssh -NR '*:<port>:localhost:22' telepy@server` 需要的最小子集：
//! - 公鑰認證（查自己的 DB：隧道金鑰 / 使用者金鑰 / 服務金鑰，規則同 InternalKeysView）
//! - `tcpip-forward`：記住 port → 連線，並在 **127.0.0.1:<port>** 綁一個 loopback listener，把進來的 TCP
//!   橋到 `forwarded-tcpip` channel（= sshd 在 GatewayPorts no 下的行為），所以 OpenSSH 客戶端（terminal、
//!   `ssh -D`）與 russh（SFTP）都能用 `127.0.0.1:<port>` 單跳到裝置。
//! - `direct-tcpip`（使用者金鑰的 `ProxyCommand ssh -W localhost:<port> telepy-ssh-server`）：橋到同一條 forward。
//! - 其餘（session/shell/exec/pty/subsystem/agent/x11）一律拒絕，等同現在 `Match User telepy` 的 sshd 設定。
//!
//! 狀態：forward 註冊/消失即時寫入 `StatusState`（取代 `ss` 取樣）；延遲：每 15s 開一條 forwarded 通道讀
//! 裝置 sshd banner 的第一個 byte（與 probe_latency.sh 相同的量法，但零子程序）。
//! 日誌：sshd 風格的 `Accepted publickey … / Disconnected …` 行寫到 ssh-gateway.log，Logs 頁沿用。
//! In-process SSH gateway terminating the devices' reverse tunnels (pubkey + tcpip-forward only).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use dashmap::DashMap;
use russh::keys::{load_secret_key, HashAlg, PrivateKey};
use russh::server::{self, Auth, Config as ServerConfig, Handle, Handler, Msg, Session};
use russh::{Channel, ChannelOpenFailure, Disconnect, MethodKind, MethodSet};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db::{self, tunnels::like_prefix, Db};
use crate::monitor::StatusState;

/// 誰在連線：隧道金鑰（裝置）、使用者金鑰（人）、服務金鑰（後端自己）。
#[derive(Debug, Clone)]
pub enum Identity {
    Tunnel { tunnel_id: i64, user_id: i64, reverse_port: i64 },
    User { user_id: i64 },
    Service { name: String },
}

pub struct Forward {
    pub port: u16,
    /// 客戶端在 tcpip-forward 要求的位址字串（開 forwarded-tcpip 時必須原樣回傳，OpenSSH 用它比對）。
    pub address: String,
    pub conn_id: u64,
    pub handle: Handle,
    listener: tokio::task::JoinHandle<()>,
}

struct ConnInfo {
    peer: SocketAddr,
    identity: Identity,
}

pub struct Gateway {
    config: Config,
    db: Db,
    status: Arc<StatusState>,
    forwards: DashMap<u16, Arc<Forward>>,
    conns: DashMap<u64, ConnInfo>,
    next_id: AtomicU64,
    log: Mutex<Option<tokio::fs::File>>,
    event_counter: AtomicU64,
    server_config: Arc<ServerConfig>,
    pub host_keys_loaded: usize,
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
    pub fn new(config: Config, db: Db, status: Arc<StatusState>) -> Self {
        let keys = config.gateway_host_keys_dir.as_deref().map(load_host_keys).unwrap_or_default();
        let host_keys_loaded = keys.len();
        Self {
            server_config: server_config(keys),
            config,
            db,
            status,
            forwards: DashMap::new(),
            conns: DashMap::new(),
            next_id: AtomicU64::new(1),
            log: Mutex::new(None),
            event_counter: AtomicU64::new(0),
            host_keys_loaded,
        }
    }

    /// 結構化事件：寫進 `telepy_gateway_event`（Logs 頁 / API 的來源），同時以 sshd 風格附加到
    /// ssh-gateway.log（運維用）。`kind` 是機器可讀的類別（accepted / forward / disconnect / refused …）。
    pub async fn event(&self, kind: &str, peer: Option<SocketAddr>, port: Option<u16>, tunnel_id: Option<i64>, message: String) {
        let _ = sqlx::query("INSERT INTO telepy_gateway_event (at, event, peer, port, tunnel_id, message) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(crate::util::now_db())
            .bind(kind)
            .bind(peer.map(|p| p.to_string()))
            .bind(port.map(|p| p as i64))
            .bind(tunnel_id)
            .bind(&message)
            .execute(&self.db.write)
            .await;
        self.log(&message).await;
        // 保留：最多 EVENT_RETENTION_ROWS 列（每 128 筆順手清一次）。/ Retention: cap the table size.
        if self.event_counter.fetch_add(1, Ordering::Relaxed) % 128 == 0 {
            let _ = sqlx::query("DELETE FROM telepy_gateway_event WHERE id <= (SELECT id FROM telepy_gateway_event ORDER BY id DESC LIMIT 1 OFFSET ?)")
                .bind(EVENT_RETENTION_ROWS)
                .execute(&self.db.write)
                .await;
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

    pub fn active_ports(&self) -> Vec<u16> {
        let mut v: Vec<u16> = self.forwards.iter().map(|e| *e.key()).collect();
        v.sort_unstable();
        v
    }

    fn publish_status(&self) {
        self.status.set_listen_ports(self.forwards.iter().map(|e| *e.key()).collect());
    }

    /// 金鑰 → 身分（InternalKeysView 的規則）。
    async fn identify(&self, bare: &str) -> anyhow::Result<Option<Identity>> {
        let like = like_prefix(bare);
        if let Some(t) = db::tunnels::by_key_prefix(&self.db, &like).await? {
            return Ok(Some(Identity::Tunnel { tunnel_id: t.id, user_id: t.user_id, reverse_port: t.reverse_port }));
        }
        if let Some(uid) = db::keys::user_key_owner_by_prefix(&self.db, &like).await? {
            let has_tunnels = !db::tunnels::keys_for_user(&self.db, uid).await?.is_empty();
            let has_shares = db::sharing::user_has_any_share(&self.db, uid).await?;
            if has_tunnels || has_shares {
                return Ok(Some(Identity::User { user_id: uid }));
            }
            tracing::info!(user_id = uid, "gateway: user key owner has no tunnels and no shares; rejected");
            return Ok(None);
        }
        if db::keys::service_key_matches_prefix(&self.db, &like).await? {
            return Ok(Some(Identity::Service { name: "web-service".into() }));
        }
        Ok(None)
    }

    /// 誰可以要求在 port 上做 reverse forward。
    async fn may_forward(&self, id: &Identity, port: u16) -> anyhow::Result<bool> {
        Ok(match id {
            Identity::Tunnel { reverse_port, .. } => *reverse_port == port as i64,
            Identity::Service { .. } => !db::tunnels::by_port(&self.db, port as i64).await?.is_empty(),
            Identity::User { user_id } => self.user_can_reach(*user_id, port).await?,
        })
    }

    /// 使用者是否可以經 direct-tcpip 連到 port（owner 或被分享）。
    async fn user_can_reach(&self, user_id: i64, port: u16) -> anyhow::Result<bool> {
        for t in db::tunnels::by_port(&self.db, port as i64).await? {
            if t.user_id == user_id || db::sharing::get(&self.db, t.id, user_id).await?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn may_connect(&self, id: &Identity, port: u16) -> anyhow::Result<bool> {
        if !self.forwards.contains_key(&port) {
            return Ok(false);
        }
        Ok(match id {
            Identity::Service { .. } => true,
            Identity::User { user_id } => self.user_can_reach(*user_id, port).await?,
            Identity::Tunnel { .. } => false,
        })
    }

    async fn register_forward(self: &Arc<Self>, conn_id: u64, address: &str, port: u16, handle: Handle) -> anyhow::Result<()> {
        if let Some(existing) = self.forwards.get(&port).map(|f| f.clone()) {
            if existing.conn_id == conn_id {
                return Ok(());
            }
            if self.conns.contains_key(&existing.conn_id) {
                bail!("port {port} is already forwarded by another live connection");
            }
            // 擁有者已斷線但尚未清理：接手。/ Stale owner: take over.
            existing.listener.abort();
            self.forwards.remove(&port);
        }
        let listener = TcpListener::bind(("127.0.0.1", port)).await.with_context(|| format!("bind 127.0.0.1:{port}"))?;
        let gw = self.clone();
        let task_handle = handle.clone();
        let task_address = address.to_string();
        let listener_task = tokio::spawn(async move {
            loop {
                let Ok((tcp, peer)) = listener.accept().await else { break };
                let h = task_handle.clone();
                let addr = task_address.clone();
                tokio::spawn(async move {
                    if let Err(e) = bridge_tcp(h, addr, port, tcp, peer).await {
                        tracing::debug!(port, error = %e, "gateway: loopback bridge ended with error");
                    }
                });
            }
            let _ = gw; // keep the gateway alive for the task's lifetime
        });
        self.forwards.insert(port, Arc::new(Forward { port, address: address.to_string(), conn_id, handle, listener: listener_task }));
        self.publish_status();
        Ok(())
    }

    fn unregister_forward(&self, conn_id: u64, port: u16) -> bool {
        let owned = self.forwards.get(&port).map(|f| f.conn_id == conn_id).unwrap_or(false);
        if owned {
            if let Some((_, f)) = self.forwards.remove(&port) {
                f.listener.abort();
            }
            self.publish_status();
        }
        owned
    }

    fn on_disconnect(&self, conn_id: u64) -> (Vec<u16>, Option<ConnInfo>) {
        let info = self.conns.remove(&conn_id).map(|(_, v)| v);
        let mut dropped = Vec::new();
        self.forwards.retain(|port, f| {
            if f.conn_id == conn_id {
                f.listener.abort();
                dropped.push(*port);
                false
            } else {
                true
            }
        });
        self.publish_status();
        (dropped, info)
    }

    /// 每條 forward 開一條 forwarded-tcpip 通道、讀裝置 sshd banner 的第一個 byte，當作 RTT。
    pub async fn probe_latency(&self) -> HashMap<u16, f64> {
        let forwards: Vec<Arc<Forward>> = self.forwards.iter().map(|e| e.value().clone()).collect();
        let probes = forwards.into_iter().map(|f| async move {
            let started = Instant::now();
            let res = tokio::time::timeout(PROBE_TIMEOUT, async {
                let ch = f.handle.channel_open_forwarded_tcpip(f.address.clone(), f.port as u32, "127.0.0.1", 0).await.map_err(|e| anyhow::anyhow!("{e}"))?;
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
        self.status.set_latency(map.clone());
        map
    }

    pub async fn run_probes(self: Arc<Self>, interval: Duration) {
        loop {
            tokio::time::sleep(interval).await;
            self.probe_latency().await;
        }
    }
}

/// loopback TCP ↔ forwarded-tcpip channel。
async fn bridge_tcp(handle: Handle, address: String, port: u16, mut tcp: TcpStream, peer: SocketAddr) -> anyhow::Result<()> {
    let channel = handle
        .channel_open_forwarded_tcpip(address, port as u32, peer.ip().to_string(), peer.port() as u32)
        .await
        .map_err(|e| anyhow::anyhow!("open forwarded-tcpip: {e}"))?;
    let mut stream = channel.into_stream();
    let _ = tcp.set_nodelay(true);
    tokio::io::copy_bidirectional(&mut tcp, &mut stream).await?;
    Ok(())
}

/// direct-tcpip channel ↔ forwarded-tcpip channel（使用者金鑰的 `ssh -W`）。
async fn bridge_channels(fwd: Arc<Forward>, client: Channel<Msg>, originator: String, originator_port: u32) -> anyhow::Result<()> {
    let device = fwd
        .handle
        .channel_open_forwarded_tcpip(fwd.address.clone(), fwd.port as u32, originator, originator_port)
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
    identity: Option<Identity>,
    offered: Option<String>,
    key_desc: String,
    authed: Arc<AtomicBool>,
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
            self.gw.conns.insert(self.conn_id, ConnInfo { peer: self.peer, identity: id.clone() });
        }
        let tunnel_id = match &self.identity {
            Some(Identity::Tunnel { tunnel_id, .. }) => Some(*tunnel_id),
            _ => None,
        };
        self.gw
            .event("accepted", Some(self.peer), None, tunnel_id, format!("Accepted publickey for {} from {} port {} ssh2: {}", self.gw.config.gateway_user, self.peer.ip(), self.peer.port(), self.key_desc))
            .await;
        Ok(())
    }

    async fn tcpip_forward(&mut self, address: &str, port: &mut u32, session: &mut Session) -> Result<bool, Self::Error> {
        let Some(id) = self.identity.clone() else { return Ok(false) };
        let Ok(p) = u16::try_from(*port) else { return Ok(false) };
        if p == 0 {
            return Ok(false);
        }
        let tunnel_id = match &id {
            Identity::Tunnel { tunnel_id, .. } => Some(*tunnel_id),
            _ => None,
        };
        if !self.gw.may_forward(&id, p).await? {
            self.gw.event("refused_forward", Some(self.peer), Some(p), tunnel_id, format!("Refused remote forward for port {p} from {} port {} (not authorized)", self.peer.ip(), self.peer.port())).await;
            return Ok(false);
        }
        match self.gw.register_forward(self.conn_id, address, p, session.handle()).await {
            Ok(()) => {
                self.gw.event("forward", Some(self.peer), Some(p), tunnel_id, format!("Remote forward registered on port {p} for {} port {}", self.peer.ip(), self.peer.port())).await;
                Ok(true)
            }
            Err(e) => {
                self.gw.event("refused_forward", Some(self.peer), Some(p), tunnel_id, format!("Refused remote forward for port {p} from {} port {}: {e}", self.peer.ip(), self.peer.port())).await;
                Ok(false)
            }
        }
    }

    async fn cancel_tcpip_forward(&mut self, _address: &str, port: u32, _session: &mut Session) -> Result<bool, Self::Error> {
        let Ok(p) = u16::try_from(port) else { return Ok(false) };
        Ok(self.gw.unregister_forward(self.conn_id, p))
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        // 不開 shell/exec/pty（= PermitTTY no + 無 shell 的 sshd 設定）。
        reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
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
        let loopback = matches!(host_to_connect, "localhost" | "127.0.0.1" | "::1");
        let port = u16::try_from(port_to_connect).ok();
        let allowed = match (loopback, port, &self.identity) {
            (true, Some(p), Some(id)) => self.gw.may_connect(id, p).await?,
            _ => false,
        };
        let Some(fwd) = port.and_then(|p| self.gw.forwards.get(&p).map(|f| f.clone())).filter(|_| allowed) else {
            self.gw.event("refused_direct", Some(self.peer), port, None, format!("Refused direct-tcpip to {host_to_connect}:{port_to_connect} from {} port {}", self.peer.ip(), self.peer.port())).await;
            reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        };
        reply.accept().await;
        let originator = originator_address.to_string();
        tokio::spawn(async move {
            if let Err(e) = bridge_channels(fwd, channel, originator, originator_port).await {
                tracing::debug!(error = %e, "gateway: direct-tcpip bridge ended with error");
            }
        });
        Ok(())
    }
}

impl Drop for GatewayHandler {
    fn drop(&mut self) {
        let (dropped, info) = self.gw.on_disconnect(self.conn_id);
        let gw = self.gw.clone();
        let peer = info.as_ref().map(|i| i.peer).unwrap_or(self.peer);
        let identity = info.map(|i| i.identity);
        let tunnel_id = match &identity {
            Some(Identity::Tunnel { tunnel_id, .. }) => Some(*tunnel_id),
            _ => None,
        };
        let who = match identity {
            Some(Identity::Tunnel { tunnel_id, .. }) => format!(" (tunnel {tunnel_id})"),
            Some(Identity::User { user_id }) => format!(" (user {user_id})"),
            Some(Identity::Service { name }) => format!(" (service {name})"),
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
                    }
                } else {
                    gw.event("preauth_close", Some(peer), None, None, format!("Connection closed by authenticating user {user} {} port {} [preauth]", peer.ip(), peer.port())).await;
                }
            });
        }
    }
}

async fn handle_connection(gw: Arc<Gateway>, stream: TcpStream, peer: SocketAddr) {
    let _ = stream.set_nodelay(true);
    let conn_id = gw.next_id.fetch_add(1, Ordering::SeqCst);
    let authed = Arc::new(AtomicBool::new(false));
    let handler = GatewayHandler { gw: gw.clone(), conn_id, peer, identity: None, offered: None, key_desc: String::new(), authed: authed.clone() };
    let session = match server::run_stream(gw.server_config.clone(), stream, handler).await {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!(%peer, error = %e, "gateway: handshake failed");
            return;
        }
    };
    // LoginGraceTime：逾時未認證就斷線。
    let grace_handle = session.handle();
    let grace = gw.config.gateway_login_grace;
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
            if gw.conns.len() >= gw.config.gateway_max_connections {
                tracing::warn!(%peer, "gateway: connection limit reached; dropping");
                continue;
            }
            tokio::spawn(handle_connection(gw.clone(), stream, peer));
        }
    }))
}
