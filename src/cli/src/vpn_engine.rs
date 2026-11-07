//! `telepy vpn` 的內建引擎（要 root：開虛擬網卡、加路由）：虛擬網卡收到的 TCP 連線交給使用者空間的 TCP/IP 堆疊
//! （ipstack），每一條再經本機的 `ssh -D` SOCKS5（= 裝置的 sshd 開的 direct-tcpip）連到目的地。指定網域的 DNS 查詢
//! 改走 TCP 問裝置自己的 DNS 伺服器。UDP 的其他東西與 ping 不轉（SSH 只帶 TCP）。
//!
//! `telepy vpn`'s built-in engine (needs root: a TUN device and routes). TCP connections reaching the TUN device are
//! terminated by a userspace TCP/IP stack (ipstack), and each one goes on through the local `ssh -D` SOCKS5 (= a
//! direct-tcpip channel the device's sshd opens). DNS for the chosen domains is asked of the device's own resolver over
//! TCP. Other UDP and ping are not carried (SSH carries TCP only).

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use ipstack::{IpStack, IpStackConfig, IpStackStream};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::vpn::{self, Net, Os, DNS_ADDR, MTU, TUN_ADDR};

pub struct Options {
    pub socks: SocketAddr,
    pub nets: Vec<Net>,
    pub dns_server: Option<Ipv4Addr>,
    pub dns_domains: Vec<String>,
}

fn os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Macos
    } else {
        Os::Linux
    }
}

/// 開網卡、加路由、設 DNS，轉到 Ctrl-C 或 SOCKS 那頭不見為止，最後把 DNS 設定收回。
/// Bring the device up, route, set DNS, relay until Ctrl-C or the SOCKS side goes away, then undo the DNS setup.
pub fn run(o: Options) -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
    rt.block_on(async move {
        let dev = tun_rs::DeviceBuilder::new()
            .ipv4(TUN_ADDR, 30u8, Some(DNS_ADDR))
            .mtu(MTU)
            .build_async()
            .context("cannot create the network device (run as root / with sudo)")?;
        let name = dev.name().context("the network device has no name")?;
        for cmd in vpn::route_commands(os(), &name, &o.nets) {
            run_cmd(&cmd).with_context(|| format!("adding the route ({})", cmd.join(" ")))?;
        }
        let dns = Dns::set_up(&name, &o)?;
        let nets = o.nets.iter().map(Net::to_string).collect::<Vec<_>>().join(", ");
        let dns_note = match (&o.dns_server, dns.domains.is_empty()) {
            (Some(_), false) => format!("; names under {} are looked up on the device", dns.domains.join(", ")),
            (Some(_), true) => format!("; the device's DNS answers at {DNS_ADDR}"),
            (None, _) => String::new(),
        };
        eprintln!("VPN up on {name}: {nets}{dns_note}. Press Ctrl-C to stop.");

        let dev = Arc::new(dev);
        let (to_stack, from_dev) = mpsc::channel::<Vec<u8>>(1024);
        let (to_dev, mut from_stack) = mpsc::unbounded_channel::<Vec<u8>>();
        let reader = {
            let dev = dev.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; MTU as usize + 64];
                while let Ok(n) = dev.recv(&mut buf).await {
                    if to_stack.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            })
        };
        let writer = {
            let dev = dev.clone();
            tokio::spawn(async move {
                while let Some(p) = from_stack.recv().await {
                    if dev.send(&p).await.is_err() {
                        break;
                    }
                }
            })
        };
        let mut cfg = IpStackConfig::default();
        cfg.mtu(MTU).map_err(|e| anyhow!("{e:?}"))?;
        let mut stack = IpStack::new(cfg, Packets { rx: from_dev, tx: to_dev });

        let socks = o.socks;
        let resolver = o.dns_server;
        let mut watch = tokio::time::interval(Duration::from_secs(5));
        let result: Result<()> = loop {
            tokio::select! {
                s = stack.accept() => match s {
                    Ok(IpStackStream::Tcp(mut tcp)) => {
                        let SocketAddr::V4(dst) = tcp.peer_addr() else { continue };
                        tokio::spawn(async move {
                            match socks_connect(socks, *dst.ip(), dst.port()).await {
                                Ok(mut up) => {
                                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut up).await;
                                    let _ = up.shutdown().await;
                                    let _ = tcp.shutdown().await;
                                }
                                Err(e) => eprintln!("  {}:{}: {e}", dst.ip(), dst.port()),
                            }
                        });
                    }
                    Ok(IpStackStream::Udp(mut udp)) => {
                        let to = udp.peer_addr();
                        if let (Some(server), SocketAddr::V4(to)) = (resolver, to) {
                            if *to.ip() == DNS_ADDR && to.port() == 53 {
                                tokio::spawn(async move {
                                    let mut q = vec![0u8; 4096];
                                    while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(30), udp.read(&mut q)).await {
                                        if n == 0 {
                                            break;
                                        }
                                        match dns_over_tcp(socks, server, &q[..n]).await {
                                            Ok(answer) => {
                                                if udp.write_all(&answer).await.is_err() {
                                                    break;
                                                }
                                            }
                                            Err(e) => eprintln!("  DNS: {e}"),
                                        }
                                    }
                                    let _ = udp.shutdown().await;
                                });
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) => break Err(anyhow!("the network stack stopped: {e:?}")),
                },
                _ = tokio::signal::ctrl_c() => break Ok(()),
                _ = watch.tick() => {
                    // ssh -D 不見了（連線斷了）= 沒得轉，收工。/ The SOCKS side is gone (ssh ended): stop.
                    if TcpStream::connect(socks).await.is_err() {
                        break Err(anyhow!("the SSH connection to the device ended"));
                    }
                }
            }
        };
        reader.abort();
        writer.abort();
        dns.undo();
        eprintln!("VPN down.");
        result
    })
}

fn run_cmd(cmd: &[String]) -> Result<()> {
    let out = std::process::Command::new(&cmd[0]).args(&cmd[1..]).output().with_context(|| format!("cannot run {}", cmd[0]))?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// 設好的 DNS（結束時收回）。/ The DNS setup made (undone at the end).
struct Dns {
    domains: Vec<String>,
    files: Vec<String>,
}

impl Dns {
    fn set_up(dev: &str, o: &Options) -> Result<Dns> {
        let mut d = Dns { domains: vec![], files: vec![] };
        if o.dns_server.is_none() || o.dns_domains.is_empty() {
            return Ok(d);
        }
        match os() {
            Os::Macos => {
                std::fs::create_dir_all("/etc/resolver").context("creating /etc/resolver")?;
                for domain in &o.dns_domains {
                    let (path, text) = vpn::macos_resolver(domain);
                    if std::path::Path::new(&path).exists() && !std::fs::read_to_string(&path).unwrap_or_default().contains("telepy vpn") {
                        eprintln!("  {path} already exists and isn't Telepy's; names under {domain} keep using it.");
                        continue;
                    }
                    std::fs::write(&path, text).with_context(|| format!("writing {path}"))?;
                    d.files.push(path);
                    d.domains.push(domain.clone());
                }
            }
            Os::Linux => {
                let ok = vpn::linux_resolved_commands(dev, &o.dns_domains).iter().all(|c| run_cmd(c).is_ok());
                if ok {
                    d.domains = o.dns_domains.clone();
                } else {
                    eprintln!("  This computer has no systemd-resolved (resolvectl), so lookups aren't sent to the device on their own. Ask {DNS_ADDR} directly, e.g. dig @{DNS_ADDR} <name>.");
                }
            }
        }
        Ok(d)
    }

    fn undo(&self) {
        for f in &self.files {
            let _ = std::fs::remove_file(f);
        }
    }
}

/// 經本機的 SOCKS5（`ssh -D`）連到目的地。/ Connect through the local SOCKS5 (`ssh -D`).
async fn socks_connect(socks: SocketAddr, ip: Ipv4Addr, port: u16) -> Result<TcpStream> {
    let mut s = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(socks)).await.map_err(|_| anyhow!("the SSH connection doesn't answer"))??;
    s.set_nodelay(true).ok();
    s.write_all(&[5, 1, 0]).await?;
    let mut hello = [0u8; 2];
    s.read_exact(&mut hello).await?;
    if hello != [5, 0] {
        bail!("ssh -D didn't accept the SOCKS5 greeting");
    }
    s.write_all(&vpn::socks5_connect(ip, port)).await?;
    let mut head = [0u8; 4];
    tokio::time::timeout(Duration::from_secs(20), s.read_exact(&mut head)).await.map_err(|_| anyhow!("timed out"))??;
    let rest = vpn::socks5_reply_rest(head).map_err(|e| anyhow!(e))?;
    let mut skip = vec![0u8; rest];
    s.read_exact(&mut skip).await?;
    Ok(s)
}

/// 一個 DNS 查詢經 SOCKS 用 TCP 問裝置的 DNS 伺服器。/ One DNS query asked of the device's resolver over TCP via SOCKS.
async fn dns_over_tcp(socks: SocketAddr, server: Ipv4Addr, query: &[u8]) -> Result<Vec<u8>> {
    let mut s = socks_connect(socks, server, 53).await?;
    s.write_all(&vpn::dns_tcp_frame(query)).await?;
    let mut len = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut len)).await.map_err(|_| anyhow!("the resolver didn't answer"))??;
    let mut answer = vec![0u8; u16::from_be_bytes(len) as usize];
    s.read_exact(&mut answer).await?;
    Ok(answer)
}

/// 一次一個封包的 AsyncRead / AsyncWrite（ipstack 要的介面），兩端是通往虛擬網卡的 channel。
/// One packet per read / write (what ipstack wants); both ends are channels to the TUN device.
struct Packets {
    rx: mpsc::Receiver<Vec<u8>>,
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

impl AsyncRead for Packets {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        use std::task::Poll;
        let p = match self.rx.poll_recv(cx) {
            Poll::Ready(Some(p)) => p,
            Poll::Ready(None) => return Poll::Ready(Ok(())),
            Poll::Pending => return Poll::Pending,
        };
        if p.len() > buf.remaining() {
            // 太大的封包丟掉（MTU 之外，不該發生）。/ An oversized packet is dropped (beyond the MTU).
            return Poll::Ready(Ok(()));
        }
        buf.put_slice(&p);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for Packets {
    fn poll_write(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>, data: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        // 一次寫入 = 一個封包；寫網卡的工作很快就收走。/ One write = one packet; the device writer drains it quickly.
        match self.tx.send(data.to_vec()) {
            Ok(()) => std::task::Poll::Ready(Ok(data.len())),
            Err(_) => std::task::Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into())),
        }
    }
    fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}
