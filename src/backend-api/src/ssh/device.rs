//! 以 russh 原生連到裝置（取代 spawn `ssh`/`scp`）。
//! 傳輸在行程內：向內建 gateway 要一條裝置隧道上的 forwarded-tcpip 通道（`Gateway::open_stream`），直接在上面做
//! 對裝置 sshd 的 SSH 握手 —— 不經 loopback TCP、不占本機 port。共用連線見 `ssh::pool`。
//! gateway 沒啟用（沒有 host key 的開發環境、自帶 sshd 的測試）時才退回 TCP `ssh_target_host:port`。
//! 主機金鑰依隧道釘選（第一次使用時記下，之後不同就拒絕），見 `ssh::host_keys`。
//! The device's host key is pinned per tunnel (trust on first use, refused when it changes), see `ssh::host_keys`.
//! Native SSH connection to a device over an in-process gateway channel (no loopback TCP).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use russh::client::{self, Handle, Handler};
use russh::{Channel, ChannelMsg};
use russh::keys::{load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;

use crate::ssh::host_keys;
use crate::state::AppState;

/// 握手時要比對的隧道（沒有對應的隧道列時不檢查，例如測試自帶的 sshd）。/ The tunnel to check the host key against.
struct PinCheck {
    state: AppState,
    tunnel_id: i64,
    reverse_port: u16,
    /// 被拒絕時記下這次看到的指紋（給錯誤訊息用）。/ The fingerprint we refused, for the error message.
    refused: Arc<std::sync::Mutex<Option<String>>>,
}

pub struct ClientHandler {
    pin: Option<PinCheck>,
}

impl ClientHandler {
    /// 不比對 host key（測試連 gateway 本身用；連裝置一律經 [`connect`]）。/ No host-key check (tests that dial the gateway itself).
    pub fn unchecked() -> Self {
        Self { pin: None }
    }
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let Some(pin) = &self.pin else { return Ok(true) };
        let info = host_keys::key_info(key);
        match host_keys::verify(&pin.state, pin.tunnel_id, pin.reverse_port, &info).await {
            Ok(true) => Ok(true),
            Ok(false) => {
                *pin.refused.lock().unwrap() = Some(info.fingerprint);
                Ok(false)
            }
            // 查不到就拒絕（fail closed）。/ Fail closed when the check itself fails.
            Err(e) => {
                tracing::error!(tunnel_id = pin.tunnel_id, error = %e, "device host key check failed; refusing the connection");
                *pin.refused.lock().unwrap() = Some(info.fingerprint);
                Ok(false)
            }
        }
    }
}

/// 到裝置的一條 SSH 連線（drop 即關閉）。
pub struct DeviceConn {
    pub device: Handle<ClientHandler>,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    })
}

pub async fn load_identity(path: &Path) -> anyhow::Result<Arc<PrivateKey>> {
    let path = path.to_path_buf();
    let key = tokio::task::spawn_blocking(move || load_secret_key(&path, None))
        .await
        .context("join")?
        .with_context(|| "cannot load the backend SSH private key")?;
    Ok(Arc::new(key))
}

async fn authenticate(handle: &mut Handle<ClientHandler>, user: &str, key: &Arc<PrivateKey>) -> anyhow::Result<()> {
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let result = handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(key.clone(), hash)).await?;
    if !result.success() {
        bail!("public key authentication failed for user '{user}'");
    }
    Ok(())
}

async fn connect_inner(state: &AppState, username: &str, reverse_port: i64) -> anyhow::Result<DeviceConn> {
    let key = load_identity(&state.config.ssh_identity).await?;
    let port = u16::try_from(reverse_port).context("invalid reverse port")?;
    let refused = Arc::new(std::sync::Mutex::new(None));
    let tunnel_id = crate::db::tunnels::by_port(&state.db, reverse_port).await.ok().and_then(|t| t.first().map(|t| t.id));
    let handler = || ClientHandler { pin: tunnel_id.map(|tunnel_id| PinCheck { state: state.clone(), tunnel_id, reverse_port: port, refused: refused.clone() }) };
    let connected = if state.config.gateway_enabled {
        let stream = state.gateway.open_stream(port).await?;
        client::connect_stream(client_config(), stream, handler()).await.context("ssh handshake with the device")
    } else {
        let host = state.config.ssh_target_host.as_str();
        client::connect(client_config(), (host, port), handler()).await.with_context(|| format!("connect to {host}:{port}"))
    };
    let mut device = match connected {
        Ok(d) => d,
        Err(e) => {
            if let Some(fp) = refused.lock().unwrap().take() {
                bail!("{}: the device presented {fp}, which is not the key Telepy pinned for this tunnel. The owner can review it in the tunnel's details.", host_keys::CHANGED);
            }
            return Err(e);
        }
    };
    authenticate(&mut device, username, &key).await.context("device auth")?;
    Ok(DeviceConn { device })
}

/// 連線 + 認證，整體 30s 逾時。每次都是新的一條；要共用請走 `ssh::pool`。
/// Connect and authenticate (30 s overall). Always a fresh connection; use `ssh::pool` to share one.
pub async fn connect(state: &AppState, username: &str, reverse_port: i64) -> anyhow::Result<DeviceConn> {
    tokio::time::timeout(CONNECT_TIMEOUT, connect_inner(state, username, reverse_port))
        .await
        .map_err(|_| anyhow::anyhow!("timed out connecting to the device"))?
}

impl DeviceConn {
    /// 開 `sftp` subsystem。/ Open an SFTP subsystem channel.
    pub async fn sftp(&self) -> anyhow::Result<SftpSession> {
        let channel = self.device.channel_open_session().await?;
        start_sftp(channel).await
    }
}

/// 等裝置回覆 `sftp` 子系統要求的時間。/ How long to wait for the subsystem reply.
const SUBSYSTEM_REPLY: Duration = Duration::from_secs(10);

/// 在 session channel 上要 `sftp` 子系統並**等裝置回覆**：沒有這個子系統的裝置回 failure，立刻報錯，
/// 不必等 SFTP 初始化逾時（檔案管理因此能馬上退回 exec）。
/// Request the sftp subsystem and wait for the reply, so a device without it fails fast.
pub async fn start_sftp(mut channel: Channel<client::Msg>) -> anyhow::Result<SftpSession> {
    channel.request_subsystem(true, "sftp").await.context("request the sftp subsystem")?;
    let reply = tokio::time::timeout(SUBSYSTEM_REPLY, async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => bail!("the device has no sftp subsystem"),
                Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => bail!("the device closed the channel"),
                Some(_) => {}
            }
        }
    })
    .await;
    match reply {
        Ok(r) => r?,
        Err(_) => bail!("the device did not answer the sftp request"),
    }
    SftpSession::new(channel.into_stream()).await.context("start SFTP")
}
