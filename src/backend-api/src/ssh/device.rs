//! 以 russh 原生連到裝置（取代 spawn `ssh`/`scp`）。
//! 傳輸在行程內：向內建 gateway 要一條裝置隧道上的 forwarded-tcpip 通道（`Gateway::open_stream`），直接在上面做
//! 對裝置 sshd 的 SSH 握手 —— 不經 loopback TCP、不占本機 port。共用連線見 `ssh::pool`。
//! gateway 沒啟用（沒有 host key 的開發環境、自帶 sshd 的測試）時才退回 TCP `ssh_target_host:port`。
//! 主機金鑰不驗證（與 `StrictHostKeyChecking no` 一致，邊界不變）。
//! Native SSH connection to a device over an in-process gateway channel (no loopback TCP).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use russh::client::{self, Handle, Handler};
use russh::{Channel, ChannelMsg};
use russh::keys::{load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;

use crate::state::AppState;

pub struct ClientHandler;

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(true)
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
    let mut device = if state.config.gateway_enabled {
        let stream = state.gateway.open_stream(port).await?;
        client::connect_stream(client_config(), stream, ClientHandler).await.context("ssh handshake with the device")?
    } else {
        let host = state.config.ssh_target_host.as_str();
        client::connect(client_config(), (host, port), ClientHandler).await.with_context(|| format!("connect to {host}:{port}"))?
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
