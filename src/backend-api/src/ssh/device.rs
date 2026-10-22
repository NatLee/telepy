//! 以 russh 原生連到裝置（取代 spawn `ssh`/`scp`）。
//! 預設單跳：直連內建 gateway 綁的 `127.0.0.1:<reverse_port>`，只有對裝置 sshd 的一次認證。
//! `SSH_TARGET_HOST=reverse`（舊 OpenSSH 容器，回滾用）才走雙跳：backend → ssh 容器（telepy@ssh:2222）→
//! `direct-tcpip localhost:<reverse_port>` → 裝置 sshd。主機金鑰不驗證（與 `StrictHostKeyChecking no` 一致，邊界不變）。
//! Native SSH connection to a device: one hop via the gateway's loopback listener (two only for the legacy container).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use russh::client::{self, Handle, Handler};
use russh::keys::{load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;

use crate::config::Config;

pub struct ClientHandler;

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 到裝置的連線；雙跳時同時持有 gateway 那條（drop 即關閉）。
pub struct DeviceConn {
    pub device: Handle<ClientHandler>,
    _gateway: Option<Handle<ClientHandler>>,
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

async fn connect_inner(config: &Config, username: &str, reverse_port: i64) -> anyhow::Result<DeviceConn> {
    let key = load_identity(&config.ssh_identity).await?;
    let cfg = client_config();
    if config.ssh_target_host == "reverse" {
        let mut gateway = client::connect(cfg.clone(), (config.ssh_gateway_host.as_str(), config.ssh_gateway_port), ClientHandler)
            .await
            .with_context(|| format!("connect to {}:{}", config.ssh_gateway_host, config.ssh_gateway_port))?;
        authenticate(&mut gateway, &config.ssh_gateway_user, &key).await.context("gateway auth")?;
        let channel = gateway
            .channel_open_direct_tcpip("localhost", u32::try_from(reverse_port).unwrap_or(0), "127.0.0.1", 0)
            .await
            .context("open direct-tcpip to the reverse port (device offline?)")?;
        let mut device = client::connect_stream(cfg, channel.into_stream(), ClientHandler).await.context("ssh handshake with the device")?;
        authenticate(&mut device, username, &key).await.context("device auth")?;
        Ok(DeviceConn { device, _gateway: Some(gateway) })
    } else {
        let port = u16::try_from(reverse_port).context("invalid reverse port")?;
        let mut device = client::connect(cfg, (config.ssh_target_host.as_str(), port), ClientHandler)
            .await
            .with_context(|| format!("connect to {}:{port}", config.ssh_target_host))?;
        authenticate(&mut device, username, &key).await.context("device auth")?;
        Ok(DeviceConn { device, _gateway: None })
    }
}

/// 連線 + 認證，整體 30s 逾時。/ Connect and authenticate with an overall timeout.
pub async fn connect(config: &Config, username: &str, reverse_port: i64) -> anyhow::Result<DeviceConn> {
    tokio::time::timeout(CONNECT_TIMEOUT, connect_inner(config, username, reverse_port))
        .await
        .map_err(|_| anyhow::anyhow!("timed out connecting to the device"))?
}

impl DeviceConn {
    /// 開 `sftp` subsystem。/ Open an SFTP subsystem channel.
    pub async fn sftp(&self) -> anyhow::Result<SftpSession> {
        let channel = self.device.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(SftpSession::new(channel.into_stream()).await?)
    }
}
