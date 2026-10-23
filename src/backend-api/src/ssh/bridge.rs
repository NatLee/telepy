//! 給 OpenSSH 客戶端用的一次性入口：在 `127.0.0.1:<臨時埠>` 等**一條**連線，把它橋到連線池那條裝置連線上、
//! 由裝置 sshd 開往 `host:port` 的 direct-tcpip channel（= 以前 `ProxyCommand ssh -W` 那一跳）。
//! 區網主機的網頁終端機用它：最後一跳仍是 OpenSSH（密碼 / 鍵盤互動提示要出現在 PTY 裡），第一跳不再經過
//! gateway 的 loopback listener。只收第一條連線、30 秒沒人來就關掉。
//! A one-shot local entry point for an OpenSSH client: one connection, bridged to a direct-tcpip channel
//! the device's sshd opens to `host:port` on the shared device connection.

use std::time::Duration;

use anyhow::Context;
use tokio::net::TcpListener;

use super::pool::Lease;
use super::resolve::Resolver;

/// 沒人來連的話多久關掉。/ How long to wait for the client.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);

/// 開好入口，回 loopback 埠；連線結束（或逾時）時 lease 一起歸還。/ Returns the loopback port to dial.
pub async fn one_shot(lease: Lease, host: String, port: u16) -> anyhow::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.context("bind a loopback entry point")?;
    let local = listener.local_addr()?.port();
    tokio::spawn(async move {
        let Ok(Ok((mut tcp, peer))) = tokio::time::timeout(ACCEPT_TIMEOUT, listener.accept()).await else {
            tracing::debug!(%host, port, "bridge: nobody connected; closing");
            return;
        };
        drop(listener);
        let _ = tcp.set_nodelay(true);
        // 名稱（例如 nas.local）先經 resolve：macOS 裝置上不能把名稱交給 sshd-session。
        let target = match Resolver::default().target(lease.device(), &host).await {
            Ok(t) => t,
            Err(e) => {
                tracing::info!(%host, error = format!("{e:#}"), "bridge: cannot resolve the LAN host on the device");
                return;
            }
        };
        let channel = match lease.device().channel_open_direct_tcpip(target.as_str(), u32::from(port), peer.ip().to_string(), u32::from(peer.port())).await {
            Ok(c) => c,
            Err(e) => {
                tracing::info!(%host, port, error = %e, "bridge: the device could not reach the target");
                return;
            }
        };
        let mut device = channel.into_stream();
        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut device).await;
        drop(lease);
    });
    Ok(local)
}
