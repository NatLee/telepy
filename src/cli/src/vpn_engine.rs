//! `telepy vpn` 的引擎（要 root：開虛擬網卡、加路由）：虛擬網卡收到的 TCP 連線交給使用者空間的 TCP/IP 堆疊
//! （ipstack），每一條再經本機的 `ssh -D` SOCKS5（= 裝置的 sshd 開的 direct-tcpip）連到目的地。
//!
//! 名稱：指定網域底下的名字由這裡自己回一個假位址（198.18.128.0/17），連到假位址的連線用**名稱**交給 SOCKS5，
//! 由裝置的 sshd 照裝置自己的方式解析——裝置上不跑任何東西。UDP 的其他東西與 ping 不轉（SSH 只帶 TCP）。
//! SSH 斷了由 `lib.rs` 重連；這裡在斷線期間只是連不出去，不會收工。
//!
//! `telepy vpn`'s engine (needs root: a TUN device and routes). TCP connections reaching the TUN device are terminated
//! by a userspace TCP/IP stack (ipstack), and each one goes on through the local `ssh -D` SOCKS5 (= a direct-tcpip
//! channel the device's sshd opens).
//!
//! Names: names under the chosen domains get a fake address from here (198.18.128.0/17), and a connection to a fake
//! address is handed to SOCKS5 **by name**, so the device's sshd resolves it the device's own way — nothing runs on the
//! device. Other UDP and ping are not carried (SSH carries TCP only). When SSH drops, `lib.rs` reconnects it; meanwhile
//! connections simply fail here, the engine keeps going.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use ipstack::{IpStack, IpStackConfig, IpStackStream};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::vpn::{self, FakeDns, Net, Os, DNS_ADDR, FAKE_NET, MTU, TUN_ADDR};

pub struct Options {
    pub socks: SocketAddr,
    pub nets: Vec<Net>,
    pub dns_domains: Vec<String>,
    /// 啟動它的 `telepy`（不在了就收工）。/ The `telepy` that started it (stop once it is gone).
    pub owner: Option<u32>,
}

fn os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Macos
    } else {
        Os::Linux
    }
}

/// 開網卡、加路由、設 DNS，轉到 Ctrl-C / SIGTERM / SIGHUP / 啟動它的 telepy 不在為止，最後把 DNS 設定收回。
/// Bring the device up, route, set DNS, relay until Ctrl-C / SIGTERM / the starting telepy is gone, then undo DNS.
pub fn run(o: Options) -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
    rt.block_on(async move {
        let dev = tun_rs::DeviceBuilder::new()
            .ipv4(TUN_ADDR, 30u8, Some(DNS_ADDR))
            .mtu(MTU)
            .build_async()
            .context("cannot create the network device (run as root / with sudo)")?;
        let name = dev.name().context("the network device has no name")?;
        let mut routed = o.nets.clone();
        if !o.dns_domains.is_empty() {
            routed.push(FAKE_NET);
        }
        for cmd in vpn::route_commands(os(), &name, &routed) {
            run_cmd(&cmd).with_context(|| format!("adding the route ({})", cmd.join(" ")))?;
        }
        let dns = Dns::set_up(&name, &o.dns_domains)?;
        let nets = o.nets.iter().map(Net::to_string).collect::<Vec<_>>().join(", ");
        let dns_note = if dns.domains.is_empty() { String::new() } else { format!("; names under {} are found by the device", dns.domains.join(", ")) };
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

        let ctx = Arc::new(Ctx { socks: o.socks, domains: dns.domains.clone(), fake: Mutex::new(FakeDns::default()), down: AtomicBool::new(false) });
        // 關掉終端機（SIGHUP）也要收好。/ A closed terminal (SIGHUP) cleans up too.
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?;
        let mut watch = tokio::time::interval(Duration::from_secs(2));
        let result: Result<()> = loop {
            tokio::select! {
                s = stack.accept() => match s {
                    Ok(IpStackStream::Tcp(tcp)) => {
                        let SocketAddr::V4(dst) = tcp.peer_addr() else { continue };
                        tokio::spawn(relay(ctx.clone(), tcp, *dst.ip(), dst.port()));
                    }
                    Ok(IpStackStream::Udp(udp)) => {
                        let to = udp.peer_addr();
                        if !ctx.domains.is_empty() && to == SocketAddr::from((DNS_ADDR, 53)) {
                            tokio::spawn(answer_udp(ctx.clone(), udp));
                        }
                    }
                    Ok(_) => {}
                    Err(e) => break Err(anyhow!("the network stack stopped: {e:?}")),
                },
                _ = tokio::signal::ctrl_c() => break Ok(()),
                _ = term.recv() => break Ok(()),
                _ = hangup.recv() => break Ok(()),
                _ = watch.tick() => {
                    if o.owner.is_some_and(|pid| !alive(pid)) {
                        break Ok(());
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

/// 這個程序還在不在（root 對誰都能 `kill(pid, 0)`）。/ Whether a process still exists.
fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn run_cmd(cmd: &[String]) -> Result<()> {
    let out = std::process::Command::new(&cmd[0]).args(&cmd[1..]).output().with_context(|| format!("cannot run {}", cmd[0]))?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// 轉連線時共用的東西。/ What the relays share.
struct Ctx {
    socks: SocketAddr,
    domains: Vec<String>,
    fake: Mutex<FakeDns>,
    /// SSH 那頭連不到（只說一次，回來再說一次）。/ The SSH side is unreachable (said once, and again when it's back).
    down: AtomicBool,
}

/// 一條 TCP 連線：假位址 → 用名稱；其他 → 用位址。/ One TCP connection: a fake address goes by name, others by address.
async fn relay(ctx: Arc<Ctx>, mut tcp: ipstack::IpStackTcpStream, ip: Ipv4Addr, port: u16) {
    let name = FAKE_NET.contains(ip).then(|| ctx.fake.lock().ok().and_then(|f| f.name_of(ip).map(str::to_string))).flatten();
    if FAKE_NET.contains(ip) && name.is_none() {
        // 重啟前發的假位址：不知道是誰，請程式重問。/ A fake address from before a restart: unknown, so it is refused.
        return;
    }
    let what = name.clone().unwrap_or_else(|| ip.to_string());
    let request = match &name {
        Some(n) => vpn::socks5_connect_name(n, port),
        None => Some(vpn::socks5_connect(ip, port)),
    };
    let Some(request) = request else { return };
    match socks_connect(&ctx, &request).await {
        Ok(mut up) => {
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut up).await;
            let _ = up.shutdown().await;
            let _ = tcp.shutdown().await;
        }
        Err(e) => eprintln!("  {what}:{port}: {e}"),
    }
}

/// 經本機的 SOCKS5（`ssh -D`）連到目的地。/ Connect through the local SOCKS5 (`ssh -D`).
async fn socks_connect(ctx: &Ctx, request: &[u8]) -> Result<TcpStream> {
    let mut s = match tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(ctx.socks)).await {
        Ok(Ok(s)) => {
            if ctx.down.swap(false, Ordering::Relaxed) {
                eprintln!("  The SSH connection is back.");
            }
            s
        }
        _ => {
            if !ctx.down.swap(true, Ordering::Relaxed) {
                eprintln!("  The SSH connection to the device is down; telepy is reconnecting.");
            }
            bail!("waiting for the SSH connection");
        }
    };
    s.set_nodelay(true).ok();
    s.write_all(&[5, 1, 0]).await?;
    let mut hello = [0u8; 2];
    s.read_exact(&mut hello).await?;
    if hello != [5, 0] {
        bail!("ssh -D didn't accept the SOCKS5 greeting");
    }
    s.write_all(request).await?;
    let mut head = [0u8; 4];
    match tokio::time::timeout(Duration::from_secs(20), s.read_exact(&mut head)).await {
        Err(_) => bail!("timed out"),
        // ssh -D 在裝置開不出連線時直接關掉（不回 SOCKS 錯誤）。/ ssh -D just closes when the device couldn't open it.
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => bail!("the device couldn't open it (no such name there, or nothing listening)"),
        Ok(r) => r?,
    };
    let rest = vpn::socks5_reply_rest(head).map_err(|e| anyhow!(e))?;
    let mut skip = vec![0u8; rest];
    s.read_exact(&mut skip).await?;
    Ok(s)
}

/// 回答送到 198.18.0.2:53 的 DNS 查詢（全在這台電腦上，不問任何伺服器）。
/// Answer DNS queries sent to 198.18.0.2:53 (all here on this computer; no server is asked).
async fn answer_udp(ctx: Arc<Ctx>, mut udp: ipstack::IpStackUdpStream) {
    let mut q = vec![0u8; 4096];
    while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(30), udp.read(&mut q)).await {
        if n == 0 {
            break;
        }
        let answer = ctx.fake.lock().ok().and_then(|mut f| vpn::answer_query(&q[..n], &ctx.domains, &mut f));
        if let Some(a) = answer {
            if udp.write_all(&a).await.is_err() {
                break;
            }
        }
    }
    let _ = udp.shutdown().await;
}

/// 設好的 DNS（結束時收回）。/ The DNS setup made (undone at the end).
struct Dns {
    domains: Vec<String>,
    files: Vec<String>,
}

impl Dns {
    fn set_up(dev: &str, domains: &[String]) -> Result<Dns> {
        let mut d = Dns { domains: vec![], files: vec![] };
        if domains.is_empty() {
            return Ok(d);
        }
        match os() {
            Os::Macos => {
                std::fs::create_dir_all("/etc/resolver").context("creating /etc/resolver")?;
                for domain in domains {
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
                d.domains = domains.to_vec();
                if !vpn::linux_resolved_commands(dev, domains).iter().all(|c| run_cmd(c).is_ok()) {
                    eprintln!("  This computer has no systemd-resolved (resolvectl), so lookups aren't sent here on their own. Ask {DNS_ADDR} directly, e.g. dig @{DNS_ADDR} <name>.");
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
