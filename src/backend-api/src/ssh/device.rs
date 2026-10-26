//! 以 russh 原生連到裝置（取代 spawn `ssh`/`scp`）。
//! 傳輸在行程內：向內建 gateway 要一條裝置隧道上的 forwarded-tcpip 通道（`Gateway::open_stream`），直接在上面做
//! 對裝置 sshd 的 SSH 握手 —— 不經 loopback TCP、不占本機 port。共用連線見 `ssh::pool`。
//! gateway 沒啟用（沒有 host key 的開發環境、自帶 sshd 的測試）時才退回 TCP `ssh_target_host:port`。
//! 主機金鑰依隧道釘選（第一次使用時記下，之後不同就拒絕），見 `ssh::host_keys`。
//! 登入先用這條隧道自己的服務金鑰（`ssh::tunnel_keys`），裝置還沒裝它才退回全站共用的那把（`SSH_IDENTITY`）；
//! 用隧道金鑰成功就記下「這個帳號驗證過」，之後 `device_keys` 才會把共用金鑰從那個帳號移掉。
//! The device's host key is pinned per tunnel (trust on first use, refused when it changes), see `ssh::host_keys`.
//! Login tries the tunnel's own service key first and falls back to the shared one; a success with the tunnel key
//! marks the account verified, which lets `device_keys` drop the shared key there.
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
use crate::ssh::sftp_watch::{Watch, Watched};
use crate::state::AppState;

/// 握手時要比對的隧道（沒有對應的隧道列時不檢查，例如測試自帶的 sshd）。/ The tunnel to check the host key against.
struct PinCheck {
    state: AppState,
    tunnel_id: i64,
    reverse_port: u16,
    /// 被拒絕時記下原因與這次看到的指紋（給錯誤訊息用）。/ Why and which fingerprint we refused, for the error message.
    refused: Arc<std::sync::Mutex<Option<(host_keys::Decision, String)>>>,
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
            Ok(host_keys::Decision::Trust) => Ok(true),
            Ok(why) => {
                *pin.refused.lock().unwrap() = Some((why, info.fingerprint));
                Ok(false)
            }
            // 查不到就拒絕（fail closed）。/ Fail closed when the check itself fails.
            Err(e) => {
                tracing::error!(tunnel_id = pin.tunnel_id, error = %e, "device host key check failed; refusing the connection");
                *pin.refused.lock().unwrap() = Some((host_keys::Decision::Changed, info.fingerprint));
                Ok(false)
            }
        }
    }
}

/// 哪把金鑰登入成功。/ Which key authenticated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthKey {
    /// 這條隧道自己的服務金鑰。/ The tunnel's own service key.
    Tunnel,
    /// 全站共用的服務金鑰（還沒遷移的裝置）。/ The shared service key (a device not migrated yet).
    Shared,
}

/// 到裝置的一條 SSH 連線（drop 即關閉）。
pub struct DeviceConn {
    pub device: Handle<ClientHandler>,
    pub auth: AuthKey,
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

/// 一次公鑰登入；回傳是否成功（失敗不是錯誤：還可以換一把再試）。/ One publickey attempt; false = refused, try another key.
async fn try_key(handle: &mut Handle<ClientHandler>, user: &str, key: &Arc<PrivateKey>) -> anyhow::Result<bool> {
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    Ok(handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(key.clone(), hash)).await?.success())
}

/// 先隧道金鑰、再共用金鑰。/ The tunnel's key first, then the shared one.
async fn authenticate(state: &AppState, handle: &mut Handle<ClientHandler>, user: &str, tunnel_id: Option<i64>) -> anyhow::Result<AuthKey> {
    let own = match tunnel_id {
        Some(id) => crate::ssh::tunnel_keys::private(state, id).await,
        None => None,
    };
    if let Some(key) = &own {
        if try_key(handle, user, key).await? {
            return Ok(AuthKey::Tunnel);
        }
    }
    match load_identity(&state.config.ssh_identity).await {
        Ok(shared) if try_key(handle, user, &shared).await? => Ok(AuthKey::Shared),
        Ok(_) => bail!("public key authentication failed for user '{user}'"),
        // 沒有共用金鑰（新部署）：只剩隧道金鑰可用。/ No shared key (a fresh deployment): only the tunnel key counts.
        Err(e) if own.is_some() => bail!("public key authentication failed for user '{user}' (the device does not accept this tunnel's key; no shared key: {e:#})"),
        Err(e) => Err(e),
    }
}

async fn connect_inner(state: &AppState, username: &str, reverse_port: i64) -> anyhow::Result<DeviceConn> {
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
            match refused.lock().unwrap().take() {
                Some((host_keys::Decision::Claimed, fp)) => bail!("{}: the device presented {fp}; {}.", host_keys::CLAIMED, host_keys::CLAIMED_HINT),
                Some((_, fp)) => bail!("{}: the device presented {fp}, which is not the key Telepy pinned for this tunnel. The owner can review it in the tunnel's details.", host_keys::CHANGED),
                None => return Err(e),
            }
        }
    };
    let auth = authenticate(state, &mut device, username, tunnel_id).await.context("device auth")?;
    if let (AuthKey::Tunnel, Some(id)) = (auth, tunnel_id) {
        crate::ssh::tunnel_keys::verified(state, id, username).await;
    }
    Ok(DeviceConn { device, auth })
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
pub async fn start_sftp(channel: Channel<client::Msg>) -> anyhow::Result<SftpSession> {
    let channel = open_sftp(channel).await?;
    SftpSession::new(channel.into_stream()).await.context("start SFTP")
}

/// [`start_sftp`]，外加看著 channel 的健康狀態（連線池共用的那條）。
/// [`start_sftp`] plus a health watch on the channel (the pool's shared one).
pub async fn start_sftp_watched(channel: Channel<client::Msg>) -> anyhow::Result<(SftpSession, Arc<Watch>)> {
    let channel = open_sftp(channel).await?;
    let (stream, watch) = Watched::new(channel.into_stream());
    Ok((SftpSession::new(stream).await.context("start SFTP")?, watch))
}

/// 要子系統；失敗就把 channel 關掉 —— 光是 drop 一條 `Channel` 不會送 close，裝置會一直算著這個 session（MaxSessions）。
/// Ask for the subsystem; on failure close the channel, since dropping a bare `Channel` sends no close and the
/// device would keep counting the session against MaxSessions.
async fn open_sftp(mut channel: Channel<client::Msg>) -> anyhow::Result<Channel<client::Msg>> {
    match ask_for_sftp(&mut channel).await {
        Ok(()) => Ok(channel),
        Err(e) => {
            let _ = channel.close().await;
            Err(e)
        }
    }
}

async fn ask_for_sftp(channel: &mut Channel<client::Msg>) -> anyhow::Result<()> {
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
        Ok(r) => r,
        Err(_) => bail!("the device did not answer the sftp request"),
    }
}
