//! guacd ↔ 裝置之間的橋。guacd 只會主動連 TCP，所以每個 session 在後端開一個**一次性**的 listener
//! （compose 內網、隨機埠），guacd 連進來的那一條就接到裝置 sshd 的 direct-tcpip 通道：目標是裝置自己的
//! `127.0.0.1:<port>`，或裝置區網裡的另一台。只收 guacd 那個位址來的連線，接到一條後 listener 就關掉。
//! Bridge between guacd (which can only dial TCP) and the device: a one-shot rendezvous listener per session,
//! whose single accepted connection is piped into a direct-tcpip channel opened on the device's sshd.

use std::net::IpAddr;
use std::time::Duration;

use russh::client::Msg;
use russh::ChannelStream;
use tokio::net::{TcpListener, TcpStream};

use crate::ssh::pool::Lease;

/// 等 guacd 回連的 listener。/ The listener guacd connects back to.
pub struct Rendezvous {
    listener: TcpListener,
    pub port: u16,
}

impl Rendezvous {
    pub async fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("0.0.0.0", 0)).await?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    /// 接 guacd 的那一條（來源要在 `expected` 裡；空清單 = 不檢查）。逾時回 Err；回傳後 listener 關閉。
    /// Accept guacd's connection (peer must be in `expected`; empty = unchecked). The listener closes on return.
    pub async fn accept(self, expected: &[IpAddr], timeout: Duration) -> std::io::Result<TcpStream> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let (stream, peer) = tokio::time::timeout_at(deadline, self.listener.accept())
                .await
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "guacd did not connect back in time"))??;
            if expected.is_empty() || expected.iter().any(|ip| canonical(*ip) == canonical(peer.ip())) {
                stream.set_nodelay(true)?;
                return Ok(stream);
            }
            tracing::warn!(%peer, "desktop: refused a connection to the rendezvous port from an unexpected peer");
        }
    }
}

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

/// guacd 位址解析成 IP（給 rendezvous 驗證來源）。解析不到就回空（不檢查）並記 log。
/// Resolve guacd's address for the peer check; unresolvable = unchecked (logged).
pub async fn resolve(addr: &str) -> Vec<IpAddr> {
    match tokio::net::lookup_host(addr).await {
        Ok(it) => it.map(|s| s.ip()).collect(),
        Err(e) => {
            tracing::warn!(addr, error = %e, "desktop: cannot resolve the guacd address; rendezvous peer check disabled");
            Vec::new()
        }
    }
}

/// 把 guacd 那條 TCP 跟裝置通道對接到任一端關閉為止。lease 跟著活（= 池裡那條連線的一個額度）。
/// Pipe guacd's TCP connection and the device channel until either side closes; the lease lives as long.
pub fn spawn_bridge(tcp: TcpStream, channel: ChannelStream<Msg>, lease: Lease) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _lease = lease;
        let mut tcp = tcp;
        let mut channel = channel;
        match tokio::io::copy_bidirectional(&mut tcp, &mut channel).await {
            Ok((to_device, to_guacd)) => tracing::debug!(to_device, to_guacd, "desktop: bridge closed"),
            Err(e) => tracing::debug!(error = %e, "desktop: bridge ended with an error"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn mapped_ipv4_matches_ipv4() {
        let v4 = IpAddr::V4(Ipv4Addr::new(172, 18, 0, 5));
        let mapped = IpAddr::V6(Ipv4Addr::new(172, 18, 0, 5).to_ipv6_mapped());
        assert_eq!(canonical(v4), canonical(mapped));
        assert_ne!(canonical(v4), canonical(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[tokio::test]
    async fn rendezvous_refuses_unexpected_peers_and_times_out() {
        let r = Rendezvous::bind().await.unwrap();
        let port = r.port;
        // 來源 127.0.0.1，但只允許 10.0.0.9 → 拒收，然後逾時。/ Loopback peer, only 10.0.0.9 allowed: refused, then timeout.
        let _intruder = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let err = r.accept(&[IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9))], Duration::from_millis(300)).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn rendezvous_accepts_the_expected_peer() {
        let r = Rendezvous::bind().await.unwrap();
        let port = r.port;
        let client = tokio::spawn(async move { TcpStream::connect(("127.0.0.1", port)).await.unwrap() });
        let accepted = r.accept(&[IpAddr::V4(Ipv4Addr::LOCALHOST)], Duration::from_secs(2)).await.unwrap();
        let client = client.await.unwrap();
        assert_eq!(accepted.peer_addr().unwrap().port(), client.local_addr().unwrap().port());
    }
}
