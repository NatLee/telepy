//! 行程內的 SOCKS5 代理（遠端瀏覽器用），取代 `ssh -D` 子程序：每個 CONNECT 是連線池那條裝置連線上的一條
//! direct-tcpip channel（由裝置的 sshd 連出去，與 `ssh -D` 完全相同的機制）。只做 CONNECT、不做認證
//! （Chromium 的 SOCKS 不支援帳密；代理埠只在 docker network 內可達，與以前一樣）。
//! 目標是名稱時先經 `ssh::resolve`（macOS 的 sshd-session 對名稱的 direct-tcpip 會 crash、整條連線斷掉）。
//! In-process SOCKS5 (CONNECT only, no auth) over direct-tcpip channels on the shared device connection.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{bail, Context};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use super::pool::Lease;
use super::resolve::Resolver;
use crate::state::AppState;

/// 一個開著的代理。drop 即停止接新連線；lease 跟著 proxy 活（已在傳的連線各自持有一份）。
pub struct SocksProxy {
    pub port: u16,
    lease: Arc<Lease>,
    accept: JoinHandle<()>,
}

impl Drop for SocksProxy {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl SocksProxy {
    /// 在 `bind`（例如 `0.0.0.0:0`）開始聽。`lease` 是傳輸 lease（direct-tcpip 不占 session 額度）。
    /// Start listening on `bind`; `lease` is a transport lease (direct-tcpip takes no session slot).
    pub async fn start(state: AppState, lease: Lease, bind: &str) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(bind).await.with_context(|| format!("bind {bind}"))?;
        let port = listener.local_addr()?.port();
        let lease = Arc::new(lease);
        let resolver = Arc::new(Resolver::default());
        let for_task = lease.clone();
        let accept = tokio::spawn(async move {
            loop {
                let Ok((client, peer)) = listener.accept().await else { break };
                let (state, lease, resolver) = (state.clone(), for_task.clone(), resolver.clone());
                tokio::spawn(async move {
                    if let Err(e) = serve(&state, lease, resolver, client, peer).await {
                        tracing::debug!(error = %e, "socks: connection ended with error");
                    }
                });
            }
        });
        Ok(Self { port, lease, accept })
    }

    /// 底下的裝置連線還開著、也還在接連線。/ The device connection underneath is open and we still accept.
    pub fn alive(&self) -> bool {
        !self.lease.device().is_closed() && !self.accept.is_finished()
    }
}

/// SOCKS5 握手 → CONNECT → direct-tcpip → 雙向複製。/ Handshake, CONNECT, then relay.
async fn serve(state: &AppState, lease: Arc<Lease>, resolver: Arc<Resolver>, mut client: TcpStream, peer: SocketAddr) -> anyhow::Result<()> {
    let _ = client.set_nodelay(true);
    // 方法協商：只接受 0x00（無認證）。/ Method selection: only "no authentication".
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await?;
    if head[0] != 5 {
        bail!("not SOCKS5");
    }
    let mut methods = vec![0u8; head[1] as usize];
    client.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        client.write_all(&[5, 0xff]).await?;
        bail!("client offers no acceptable auth method");
    }
    client.write_all(&[5, 0]).await?;

    // 請求：VER CMD RSV ATYP DST.ADDR DST.PORT。/ The request.
    let mut req = [0u8; 4];
    client.read_exact(&mut req).await?;
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            client.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut l = [0u8; 1];
            client.read_exact(&mut l).await?;
            let mut n = vec![0u8; l[0] as usize];
            client.read_exact(&mut n).await?;
            String::from_utf8_lossy(&n).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            client.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            reply(&mut client, 8).await?;
            bail!("address type not supported");
        }
    };
    let mut p = [0u8; 2];
    client.read_exact(&mut p).await?;
    let port = u16::from_be_bytes(p);
    if req[1] != 1 {
        reply(&mut client, 7).await?;
        bail!("command {} not supported", req[1]);
    }

    // 由裝置的 sshd 連出去（名稱視裝置 OS 先解析）。/ The device's sshd connects out (names resolved per OS first).
    let target = match resolver.target(state, &lease, &host).await {
        Ok(t) => t,
        Err(e) => {
            reply(&mut client, 4).await?; // host unreachable
            bail!("resolve {host}: {e:#}");
        }
    };
    let channel = match lease.device().channel_open_direct_tcpip(target.as_str(), u32::from(port), peer.ip().to_string(), u32::from(peer.port())).await {
        Ok(c) => c,
        Err(e) => {
            reply(&mut client, 5).await?; // connection refused
            bail!("direct-tcpip to {host}:{port}: {e}");
        }
    };
    reply(&mut client, 0).await?;
    let mut device = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut client, &mut device).await;
    Ok(())
}

/// 回覆：VER REP RSV ATYP(IPv4) BND.ADDR BND.PORT（綁定位址填 0）。/ Reply with a zero bind address.
async fn reply(client: &mut TcpStream, code: u8) -> std::io::Result<()> {
    client.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}
