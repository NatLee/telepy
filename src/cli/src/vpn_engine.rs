//! `telepy vpn` 的引擎（要 root：開虛擬網卡、加路由）：虛擬網卡收到的 TCP 連線交給使用者空間的 TCP/IP 堆疊
//! （ipstack），每一條再經本機的 `ssh -D` SOCKS5（= 裝置的 sshd 開的 direct-tcpip）連到目的地。
//!
//! **先連再接**：新連線的 SYN 先攔下來，等裝置那頭真的連上了才交給堆疊回 SYN+ACK；連不上就回 RST，
//! 程式馬上看到「連線被拒」（不然每個埠看起來都開著，等伺服器先說話的程式還會一直等）。
//!
//! 名稱：指定網域底下的名字由這裡自己回一個假位址（198.18.128.0/17），連到假位址的連線用**名稱**交給 SOCKS5，
//! 由裝置的 sshd 照裝置自己的方式解析——裝置上不跑任何東西；給了 `--dns-server` 就改問那台 DNS（走 TCP）。
//! 問任何 DNS 伺服器的 UDP 查詢都改走 TCP 經裝置送過去。ping 與其他 UDP 不轉（SSH 只帶 TCP），回 ICMP
//! 「禁止」讓程式馬上知道。SSH 斷了由 `lib.rs` 重連；這裡在斷線期間只是連不出去，不會收工。
//!
//! `telepy vpn`'s engine (needs root: a TUN device and routes). TCP connections reaching the TUN device are terminated
//! by a userspace TCP/IP stack (ipstack), and each one goes on through the local `ssh -D` SOCKS5 (= a direct-tcpip
//! channel the device's sshd opens).
//!
//! **Connect first, accept after**: a new connection's SYN is held until the device side really connected, and only
//! then the stack answers SYN+ACK; when it can't, an RST goes back, so the program sees "connection refused" at once
//! (otherwise every port looked open and programs waiting for the server to speak first hung).
//!
//! Names: names under the chosen domains get a fake address from here (198.18.128.0/17), and a connection to a fake
//! address is handed to SOCKS5 **by name**, so the device's sshd resolves it the device's own way — nothing runs on the
//! device; with `--dns-server` that DNS server is asked instead (over TCP). UDP DNS queries to any server are carried as
//! TCP through the device. Ping and other UDP are not carried (SSH carries TCP only); an ICMP "prohibited" tells the
//! program at once. When SSH drops, `lib.rs` reconnects it; meanwhile connections simply fail here, the engine goes on.

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use ipstack::{IpStack, IpStackConfig, IpStackStream, TcpConfig};
use telepy_carrier::agent::{self, Frame};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

use crate::vpn::{self, Datagram, Echo, FakeDns, Inbound, Net, Os, Refused, Syn, DNS_ADDR, FAKE_NET, MTU, TUN_ADDR};

pub struct Options {
    pub socks: SocketAddr,
    pub nets: Vec<Net>,
    pub dns_domains: Vec<String>,
    /// 網域底下的名稱改問這台 DNS（經裝置、走 TCP）。/ Ask this DNS server for the domains' names (through the device, over TCP).
    pub dns_server: Option<Ipv4Addr>,
    /// 啟動它的 `telepy`（不在了就收工）。/ The `telepy` that started it (stop once it is gone).
    pub owner: Option<u32>,
    /// 裝置上 carrier 的 agent：`telepy` 開的本機轉接與通行碼。/ The device carrier's agent: telepy's local bridge and its token.
    pub agent: Option<(SocketAddr, Vec<u8>)>,
    /// 名稱能不能交給裝置的 sshd（Mac 的 sshd 一收到名稱就整條斷）。/ Whether names may go to the device's sshd (a Mac's drops the connection).
    pub sshd_names: bool,
}

/// 安靜多久的 TCP 連線才放掉：跟一般網路一樣幾乎不放（堆疊預設 60 秒，閒置的 SSH 一分鐘就被切）。
/// How long a quiet TCP connection is kept: practically for good, like a normal network (the stack's default of 60 s cut
/// an idle SSH session after a minute).
const IDLE: Duration = Duration::from_secs(7 * 24 * 3600);
/// 連上了但堆疊還沒接的連線最多留多久。/ How long a connected upstream waits for the stack to accept.
const READY_FOR: Duration = Duration::from_secs(30);
/// 同一句說明多久內不重複。/ How long the same note stays quiet.
const NOTE_EVERY: Duration = Duration::from_secs(60);

fn os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Macos
    } else {
        Os::Linux
    }
}

/// 開網卡、加路由、設 DNS，轉到 Ctrl-C / SIGTERM / SIGHUP / 啟動它的 telepy 不在為止，最後把 DNS 設定收回。
/// Bring the device up, route, set DNS, relay until Ctrl-C / SIGTERM / SIGHUP / the starting telepy is gone, then undo DNS.
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
        let dns_note = match (dns.domains.is_empty(), o.dns_server) {
            (true, _) => String::new(),
            (false, Some(server)) => format!("; names under {} are asked of {server}", dns.domains.join(", ")),
            (false, None) => format!("; names under {} are found by the device", dns.domains.join(", ")),
        };
        let carries = if o.agent.is_some() { "TCP and DNS go through; asking the device's carrier for ping and UDP" } else { "TCP and DNS go through; ping and other UDP don't" };
        eprintln!("VPN up on {name}: {nets}{dns_note}. {carries}. Press Ctrl-C to stop.");

        let dev = Arc::new(dev);
        let (to_stack, from_dev) = mpsc::channel::<Vec<u8>>(1024);
        let (to_dev, mut from_stack) = mpsc::unbounded_channel::<Vec<u8>>();
        let ctx = Arc::new(Ctx {
            socks: o.socks,
            domains: dns.domains.clone(),
            dns_server: o.dns_server,
            fake: Mutex::new(FakeDns::default()),
            down: AtomicBool::new(false),
            to_stack: to_stack.clone(),
            to_dev: to_dev.clone(),
            conns: Mutex::new(Conns::default()),
            said: Mutex::new(HashMap::new()),
            agent: Agent::new(o.agent.clone()),
            sshd_names: o.sshd_names,
        });
        tokio::spawn(run_agent(ctx.clone()));
        let reader = {
            let (dev, ctx) = (dev.clone(), ctx.clone());
            tokio::spawn(async move {
                let mut buf = vec![0u8; MTU as usize + 64];
                while let Ok(n) = dev.recv(&mut buf).await {
                    let p = buf[..n].to_vec();
                    match vpn::classify(&p) {
                        Inbound::Pass => {
                            if to_stack.send(p).await.is_err() {
                                break;
                            }
                        }
                        Inbound::Connect(syn) => on_syn(&ctx, syn, p).await,
                        Inbound::Ping(echo) => on_ping(&ctx, echo, p),
                        Inbound::Udp(d) if ctx.agent.up() => {
                            tokio::spawn(udp_out(ctx.clone(), d));
                        }
                        // 沒有 carrier：DNS 交給堆疊改走 TCP，其他的回 ICMP 禁止。/ Without the carrier: DNS goes as TCP, the rest is refused.
                        Inbound::Udp(d) if d.dst.port() == 53 => {
                            if to_stack.send(p).await.is_err() {
                                break;
                            }
                        }
                        Inbound::Udp(d) => {
                            if let Some(reply) = vpn::icmp_prohibited(&p, DNS_ADDR) {
                                let _ = ctx.to_dev.send(reply);
                            }
                            ctx.refused(&Refused::Udp(d.dst));
                        }
                        Inbound::Refuse(why) => {
                            if let Some(reply) = vpn::icmp_prohibited(&p, DNS_ADDR) {
                                let _ = ctx.to_dev.send(reply);
                            }
                            ctx.refused(&why);
                        }
                        Inbound::Drop => {}
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
        let mut tcp = TcpConfig::default();
        tcp.timeout = IDLE;
        cfg.with_tcp_config(tcp);
        let mut stack = IpStack::new(cfg, Packets { rx: from_dev, tx: to_dev });

        // 關掉終端機（SIGHUP）也要收好。/ A closed terminal (SIGHUP) cleans up too.
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?;
        let mut watch = tokio::time::interval(Duration::from_secs(2));
        let result: Result<()> = loop {
            tokio::select! {
                s = stack.accept() => match s {
                    Ok(IpStackStream::Tcp(tcp)) => {
                        let (SocketAddr::V4(src), SocketAddr::V4(dst)) = (tcp.local_addr(), tcp.peer_addr()) else { continue };
                        let up = ctx.accepted((src, dst));
                        tokio::spawn(relay(ctx.clone(), tcp, (src, dst), up));
                    }
                    Ok(IpStackStream::Udp(udp)) => {
                        let SocketAddr::V4(to) = udp.peer_addr() else { continue };
                        if to == SocketAddrV4::new(DNS_ADDR, 53) {
                            tokio::spawn(answer_here(ctx.clone(), udp));
                        } else if to.port() == 53 {
                            tokio::spawn(dns_relay(ctx.clone(), udp, *to.ip()));
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

/// (程式那頭, 目的地)。/ (the program's end, the destination).
type Key = (SocketAddrV4, SocketAddrV4);

/// 連線在哪一步：連線中、連上了等堆疊接、已經在轉。/ Where connections stand: connecting, connected waiting, relaying.
#[derive(Default)]
struct Conns {
    pending: HashSet<Key>,
    ready: HashMap<Key, (TcpStream, Instant)>,
    live: HashSet<Key>,
}

/// 轉連線時共用的東西。/ What the relays share.
struct Ctx {
    socks: SocketAddr,
    domains: Vec<String>,
    dns_server: Option<Ipv4Addr>,
    fake: Mutex<FakeDns>,
    /// SSH 那頭連不到（只說一次，回來再說一次）。/ The SSH side is unreachable (said once, and again when it's back).
    down: AtomicBool,
    to_stack: mpsc::Sender<Vec<u8>>,
    to_dev: mpsc::UnboundedSender<Vec<u8>>,
    conns: Mutex<Conns>,
    said: Mutex<HashMap<String, Instant>>,
    agent: Agent,
    sshd_names: bool,
}

enum Fail {
    /// SSH 那頭不在（重連中）：不回 RST，程式會自己重送 SYN。/ The SSH side is away (reconnecting): no RST, the program resends its SYN.
    Down,
    Refused(String),
}

impl Ctx {
    /// 同一句話一分鐘內只說一次。/ Say the same thing at most once a minute.
    fn note(&self, key: String, line: String) {
        let Ok(mut said) = self.said.lock() else { return };
        let now = Instant::now();
        if said.get(&key).is_some_and(|t| now.duration_since(*t) < NOTE_EVERY) {
            return;
        }
        said.insert(key, now);
        eprintln!("  {line}");
    }

    fn refused(&self, why: &Refused) {
        // 給了 --carrier 卻沒找到 carrier：不要再叫人加 --carrier。/ --carrier given but none found: don't suggest it again.
        let without = if self.agent.link.is_some() { "without a carrier on the device" } else { "without the device's carrier (--carrier)" };
        match why {
            Refused::Ping(ip) => self.note(format!("ping {ip}"), format!("ping {ip}: ping (ICMP) doesn't go through the VPN {without}; TCP does. To check a host, try a port: nc -vz {ip} 22")),
            Refused::Udp(to) => self.note(format!("udp {to}"), format!("UDP to {to} doesn't go through the VPN {without}; DNS does, as TCP.")),
            Refused::Other(proto) => self.note(format!("proto {proto}"), format!("IP protocol {proto} doesn't go through the VPN, only TCP does.")),
        }
    }

    /// 假位址背後的名稱。/ The name behind a fake address.
    fn name_of(&self, ip: Ipv4Addr) -> Option<String> {
        self.fake.lock().ok()?.name_of(ip).map(str::to_string)
    }

    /// 這個位址真正要去哪：一般位址就是它；假位址 = 它的名稱，有 carrier 時請裝置查成位址。
    /// Where this address really goes: an ordinary one is itself; a fake one is its name, looked up on the device when
    /// the carrier is there.
    async fn real_ip(&self, ip: Ipv4Addr) -> Result<Ipv4Addr, String> {
        if !FAKE_NET.contains(ip) {
            return Ok(ip);
        }
        let name = self.name_of(ip).ok_or("a name from before a restart; look it up again")?;
        match self.agent.resolve(&name).await {
            Some(ips) => ips.first().copied().ok_or_else(|| format!("{name}: no such name on the device")),
            None => Err(format!("{name}: names need the device's carrier here")),
        }
    }

    /// 連到這個位址要送的 SOCKS5 請求與說給人看的名字。假位址：有 carrier 時由它查成位址，否則把名稱交給裝置的
    /// sshd（Mac 不行）。/ The SOCKS5 request for this address and the name to show. A fake address is looked up by the
    /// carrier when it is there, else the name goes to the device's sshd (not on a Mac).
    async fn request(&self, ip: Ipv4Addr, port: u16) -> Result<(Vec<u8>, String), String> {
        if !FAKE_NET.contains(ip) {
            return Ok((vpn::socks5_connect(ip, port), ip.to_string()));
        }
        let name = self.name_of(ip).ok_or("a name from before a restart; look it up again")?;
        if self.agent.up() {
            let real = self.real_ip(ip).await?;
            return Ok((vpn::socks5_connect(real, port), name));
        }
        if !self.sshd_names {
            return Err(format!("{name}: the device is a Mac, whose sshd can't take a name; names need its carrier (--carrier) or --dns-server"));
        }
        Ok((vpn::socks5_connect_name(&name, port).ok_or("a name too long for SOCKS")?, name))
    }

    /// 堆疊接下一條連線：拿走先連好的那頭。/ The stack accepted a connection: take the upstream connected for it.
    fn accepted(&self, key: Key) -> Option<TcpStream> {
        let mut c = self.conns.lock().ok()?;
        c.live.insert(key);
        c.ready.remove(&key).map(|(s, _)| s)
    }

    fn finished(&self, key: Key) {
        if let Ok(mut c) = self.conns.lock() {
            c.live.remove(&key);
        }
    }
}

/// 新連線的 SYN：已經在轉 / 已經連上的重送照常交給堆疊；連線中的重送丟掉；新的先去連。
/// A new connection's SYN: a resend for one relaying / connected goes to the stack; a resend while connecting is
/// dropped; a new one starts connecting.
async fn on_syn(ctx: &Arc<Ctx>, syn: Syn, packet: Vec<u8>) {
    let key = (syn.src, syn.dst);
    let start = {
        let Ok(mut c) = ctx.conns.lock() else { return };
        if c.live.contains(&key) || c.ready.contains_key(&key) {
            false
        } else if c.pending.contains(&key) {
            return;
        } else {
            let now = Instant::now();
            c.ready.retain(|_, (_, at)| now.duration_since(*at) < READY_FOR);
            c.pending.insert(key);
            true
        }
    };
    if !start {
        let _ = ctx.to_stack.send(packet).await;
        return;
    }
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let outcome = match ctx.request(*syn.dst.ip(), syn.dst.port()).await {
            Ok((request, what)) => socks_connect(&ctx, &request).await.map_err(|f| (f, what)),
            Err(why) => Err((Fail::Refused(why), syn.dst.ip().to_string())),
        };
        // 先在鎖裡記好，鎖放掉之後才送封包。/ Record under the lock, send packets after releasing it.
        let refused = {
            let Ok(mut c) = ctx.conns.lock() else { return };
            c.pending.remove(&key);
            match outcome {
                Ok(up) => {
                    c.ready.insert(key, (up, Instant::now()));
                    None
                }
                Err((Fail::Down, _)) => return,
                Err((Fail::Refused(why), what)) => Some((why, what)),
            }
        };
        match refused {
            None => {
                let _ = ctx.to_stack.send(packet).await;
            }
            Some((why, what)) => {
                let _ = ctx.to_dev.send(vpn::rst_for(&syn));
                let port = syn.dst.port();
                ctx.note(format!("refused {what}:{port}"), format!("{what}:{port}: {why}"));
            }
        }
    });
}

/// 一條 TCP 連線：通常裝置那頭已經連好；沒有的話（不該發生）現在連。
/// One TCP connection: the device side is normally connected already; if not (it shouldn't happen) connect now.
async fn relay(ctx: Arc<Ctx>, mut tcp: ipstack::IpStackTcpStream, key: Key, up: Option<TcpStream>) {
    let up = match up {
        Some(up) => Some(up),
        None => match ctx.request(*key.1.ip(), key.1.port()).await {
            Ok((request, _)) => socks_connect(&ctx, &request).await.ok(),
            Err(_) => None,
        },
    };
    if let Some(mut up) = up {
        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut up).await;
        let _ = up.shutdown().await;
    }
    let _ = tcp.shutdown().await;
    ctx.finished(key);
}

/// 裝置上 carrier 的 agent（`telepy vpn --carrier`）：ping、UDP、查名稱。沒接上時 `up()` 是 false，一切照沒有它的方式走。
/// The device carrier's agent (`telepy vpn --carrier`): ping, UDP, names. While it isn't connected `up()` is false and
/// everything goes the way it does without it.
struct Agent {
    link: Option<(SocketAddr, Vec<u8>)>,
    tx: Mutex<Option<mpsc::Sender<Frame>>>,
    can_ping: AtomicBool,
    next: AtomicU32,
    pings: Mutex<HashMap<u32, oneshot::Sender<u8>>>,
    resolves: Mutex<HashMap<u32, oneshot::Sender<Vec<Ipv4Addr>>>>,
    flows: Mutex<HashMap<Key, u32>>,
    by_id: Mutex<HashMap<u32, Key>>,
}

impl Agent {
    fn new(link: Option<(SocketAddr, Vec<u8>)>) -> Agent {
        Agent {
            link,
            tx: Mutex::new(None),
            can_ping: AtomicBool::new(false),
            next: AtomicU32::new(1),
            pings: Mutex::new(HashMap::new()),
            resolves: Mutex::new(HashMap::new()),
            flows: Mutex::new(HashMap::new()),
            by_id: Mutex::new(HashMap::new()),
        }
    }

    fn up(&self) -> bool {
        self.tx.lock().is_ok_and(|t| t.is_some())
    }

    async fn send(&self, f: Frame) -> bool {
        let tx = self.tx.lock().ok().and_then(|t| t.clone());
        match tx {
            Some(tx) => tx.send(f).await.is_ok(),
            None => false,
        }
    }

    fn id(&self) -> u32 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    async fn resolve(&self, name: &str) -> Option<Vec<Ipv4Addr>> {
        let id = self.id();
        let (tx, rx) = oneshot::channel();
        self.resolves.lock().ok()?.insert(id, tx);
        if !self.send(Frame::Resolve { id, name: name.to_string() }).await {
            return None;
        }
        tokio::time::timeout(Duration::from_secs(10), rx).await.ok()?.ok()
    }

    async fn ping(&self, to: Ipv4Addr, seq: u16, data: Vec<u8>) -> Option<u8> {
        let id = self.id();
        let (tx, rx) = oneshot::channel();
        self.pings.lock().ok()?.insert(id, tx);
        if !self.send(Frame::Ping { id, to, seq, data }).await {
            return None;
        }
        tokio::time::timeout(agent::PING_WAIT + Duration::from_secs(2), rx).await.ok()?.ok()
    }

    /// 這個 (程式那頭, 目的地) 的 UDP 流編號。/ The UDP flow id of this (program end, destination).
    fn flow(&self, key: Key) -> u32 {
        if let Some(id) = self.flows.lock().ok().and_then(|f| f.get(&key).copied()) {
            return id;
        }
        let id = self.id();
        if let (Ok(mut f), Ok(mut b)) = (self.flows.lock(), self.by_id.lock()) {
            f.insert(key, id);
            b.insert(id, key);
        }
        id
    }

    fn forget_flow(&self, id: u32) {
        if let (Ok(mut f), Ok(mut b)) = (self.flows.lock(), self.by_id.lock()) {
            if let Some(key) = b.remove(&id) {
                f.remove(&key);
            }
        }
    }

    /// 連線斷了：等著的 ping / 查詢都失敗，流都忘掉。/ The link dropped: waiting pings / lookups fail, flows are forgotten.
    fn reset(&self) {
        if let Ok(mut t) = self.tx.lock() {
            *t = None;
        }
        if let Ok(mut m) = self.pings.lock() {
            m.clear();
        }
        if let Ok(mut m) = self.resolves.lock() {
            m.clear();
        }
        if let (Ok(mut f), Ok(mut b)) = (self.flows.lock(), self.by_id.lock()) {
            f.clear();
            b.clear();
        }
    }
}

enum AgentEnd {
    /// 裝置上沒有能用的 carrier：不再試。/ No usable carrier on the device: stop trying.
    NoCarrier,
    /// 連線斷了（SSH 重連中之類）：等一下再試。/ The link dropped (SSH reconnecting, say): try again shortly.
    Dropped,
}

/// 一直接著 agent（經 `telepy` 的本機轉接）；斷了就隔 2 秒再接。/ Keep the agent connected (through telepy's local bridge).
async fn run_agent(ctx: Arc<Ctx>) {
    let Some((addr, token)) = ctx.agent.link.clone() else { return };
    loop {
        let end = agent_session(&ctx, addr, &token).await;
        ctx.agent.reset();
        if let AgentEnd::NoCarrier = end {
            eprintln!("  No Telepy carrier that can help was found on the device (one is installed with the automatic or web-port way, and needs this release or newer), so ping and UDP other than DNS don't go through.");
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn agent_session(ctx: &Arc<Ctx>, addr: SocketAddr, token: &[u8]) -> AgentEnd {
    let Ok(mut s) = TcpStream::connect(addr).await else { return AgentEnd::Dropped };
    s.set_nodelay(true).ok();
    if s.write_all(token).await.is_err() {
        return AgentEnd::Dropped;
    }
    let (r, mut w) = s.into_split();
    let mut r = BufReader::new(r);
    match agent::read_opening(&mut r).await {
        Ok(true) => {}
        Ok(false) => return AgentEnd::NoCarrier,
        Err(_) => return AgentEnd::Dropped,
    }
    let (tx, mut rx) = mpsc::channel::<Frame>(256);
    let writer = tokio::spawn(async move {
        while let Some(f) = rx.recv().await {
            if w.write_all(&agent::encode(&f)).await.is_err() {
                break;
            }
        }
    });
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 65536];
    'read: while let Ok(n) = r.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        loop {
            let (f, used) = match agent::decode(&buf) {
                Ok(Some(x)) => x,
                Ok(None) => break,
                Err(_) => break 'read,
            };
            buf.drain(..used);
            match f {
                Frame::Hello { version, ping } => {
                    ctx.agent.can_ping.store(ping, Ordering::Relaxed);
                    if let Ok(mut t) = ctx.agent.tx.lock() {
                        *t = Some(tx.clone());
                    }
                    let what = if ping { "ping, UDP and names" } else { "UDP and names (this account may not ping there)" };
                    ctx.note("agent up".into(), format!("The device's carrier ({version}) is helping: {what} go through too."));
                }
                Frame::UdpIn { flow, data, .. } => {
                    let key = ctx.agent.by_id.lock().ok().and_then(|b| b.get(&flow).copied());
                    if let Some((app, dst)) = key {
                        // 回覆一律從程式送去的那個位址回來（假位址也是）。/ Replies come from where the program sent (fake addresses too).
                        let _ = ctx.to_dev.send(vpn::udp_packet(dst, app, &data));
                    }
                }
                Frame::Close { flow } => ctx.agent.forget_flow(flow),
                Frame::Pong { id, status } => {
                    if let Some(tx) = ctx.agent.pings.lock().ok().and_then(|mut m| m.remove(&id)) {
                        let _ = tx.send(status);
                    }
                }
                Frame::Resolved { id, ips } => {
                    if let Some(tx) = ctx.agent.resolves.lock().ok().and_then(|mut m| m.remove(&id)) {
                        let _ = tx.send(ips);
                    }
                }
                Frame::UdpOut { .. } | Frame::Ping { .. } | Frame::Resolve { .. } => {}
            }
        }
    }
    writer.abort();
    AgentEnd::Dropped
}

/// ping：有 carrier 且能 ping 就請裝置 ping，通了回 echo reply；不然回 ICMP 禁止。
/// A ping: the device pings through the carrier when it can, and an echo reply comes back; else ICMP prohibited.
fn on_ping(ctx: &Arc<Ctx>, echo: Echo, packet: Vec<u8>) {
    let refuse = |ctx: &Ctx, packet: &[u8]| {
        if let Some(reply) = vpn::icmp_prohibited(packet, DNS_ADDR) {
            let _ = ctx.to_dev.send(reply);
        }
    };
    if !ctx.agent.up() || !ctx.agent.can_ping.load(Ordering::Relaxed) {
        refuse(ctx, &packet);
        if ctx.agent.up() {
            ctx.note(format!("ping {}", echo.dst), format!("ping {}: the account you log in with may not ping on the device (Linux: net.ipv4.ping_group_range).", echo.dst));
        } else {
            ctx.refused(&Refused::Ping(echo.dst));
        }
        return;
    }
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let Ok(to) = ctx.real_ip(echo.dst).await else { return };
        match ctx.agent.ping(to, echo.seq, echo.data.clone()).await {
            Some(agent::PONG_OK) => {
                let _ = ctx.to_dev.send(vpn::echo_reply(&echo));
            }
            Some(agent::PONG_NOT_ALLOWED) => {
                refuse(&ctx, &packet);
                ctx.note(format!("ping {}", echo.dst), format!("ping {}: the account you log in with may not ping on the device (Linux: net.ipv4.ping_group_range).", echo.dst));
            }
            // 沒回應就像真的網路一樣不回。/ No answer, like a real network.
            _ => {}
        }
    });
}

/// 一個 UDP 封包經裝置的 carrier 送出。/ One UDP datagram sent through the device's carrier.
async fn udp_out(ctx: Arc<Ctx>, d: Datagram) {
    let to = match ctx.real_ip(*d.dst.ip()).await {
        Ok(ip) => SocketAddrV4::new(ip, d.dst.port()),
        Err(why) => {
            ctx.note(format!("udp {}", d.dst), format!("UDP to {}: {why}", d.dst));
            return;
        }
    };
    let flow = ctx.agent.flow((d.src, d.dst));
    ctx.agent.send(Frame::UdpOut { flow, to, data: d.data }).await;
}

/// 經本機的 SOCKS5（`ssh -D`）連到目的地。/ Connect through the local SOCKS5 (`ssh -D`).
async fn socks_connect(ctx: &Ctx, request: &[u8]) -> std::result::Result<TcpStream, Fail> {
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
            return Err(Fail::Down);
        }
    };
    let refused = |why: &str| Fail::Refused(why.to_string());
    s.set_nodelay(true).ok();
    let mut hello = [0u8; 2];
    if s.write_all(&[5, 1, 0]).await.is_err() || s.read_exact(&mut hello).await.is_err() || hello != [5, 0] {
        return Err(Fail::Down);
    }
    s.write_all(request).await.map_err(|_| Fail::Down)?;
    let mut head = [0u8; 4];
    match tokio::time::timeout(Duration::from_secs(20), s.read_exact(&mut head)).await {
        Err(_) => return Err(refused("the device didn't get through within 20 seconds")),
        // ssh -D 在裝置開不出連線時直接關掉（不回 SOCKS 錯誤）。/ ssh -D just closes when the device couldn't open it.
        Ok(Err(_)) => return Err(refused("the device couldn't connect (refused, unreachable, or no such name there)")),
        Ok(Ok(_)) => {}
    }
    let rest = vpn::socks5_reply_rest(head).map_err(|e| refused(&e))?;
    let mut skip = vec![0u8; rest];
    s.read_exact(&mut skip).await.map_err(|_| refused("the SOCKS reply was cut short"))?;
    Ok(s)
}

/// 一個 DNS 查詢經 SOCKS 用 TCP 問那台 DNS 伺服器。/ One DNS query asked of a server over TCP through SOCKS.
async fn dns_over_tcp(ctx: &Ctx, server: Ipv4Addr, query: &[u8]) -> Option<Vec<u8>> {
    let mut s = socks_connect(ctx, &vpn::socks5_connect(server, 53)).await.ok()?;
    s.write_all(&vpn::dns_tcp_frame(query)).await.ok()?;
    let mut len = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut len)).await.ok()?.ok()?;
    let mut answer = vec![0u8; usize::from(u16::from_be_bytes(len))];
    s.read_exact(&mut answer).await.ok()?;
    Some(answer)
}

/// 送到 198.18.0.2:53 的查詢：網域底下的名稱給假位址（或問 `--dns-server`），其他的拒絕。
/// Queries to 198.18.0.2:53: names under the domains get a fake address (or are asked of `--dns-server`), others are refused.
async fn answer_here(ctx: Arc<Ctx>, mut udp: ipstack::IpStackUdpStream) {
    let mut q = vec![0u8; 4096];
    while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(30), udp.read(&mut q)).await {
        if n == 0 {
            break;
        }
        let query = q[..n].to_vec();
        let ours = vpn::parse_query(&query).is_some_and(|parsed| vpn::in_domains(&parsed.name, &ctx.domains));
        let answer = match ctx.dns_server {
            Some(server) if ours => dns_over_tcp(&ctx, server, &query).await,
            _ => ctx.fake.lock().ok().and_then(|mut f| vpn::answer_query(&query, &ctx.domains, &mut f)),
        };
        if let Some(a) = answer {
            if udp.write_all(&a).await.is_err() {
                break;
            }
        }
    }
    let _ = udp.shutdown().await;
}

/// 問 VPN 後面某台 DNS 伺服器的 UDP 查詢：改走 TCP，經裝置送過去。
/// A UDP query to a DNS server behind the VPN: carried as TCP through the device.
async fn dns_relay(ctx: Arc<Ctx>, mut udp: ipstack::IpStackUdpStream, server: Ipv4Addr) {
    let mut q = vec![0u8; 4096];
    while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(30), udp.read(&mut q)).await {
        if n == 0 {
            break;
        }
        match dns_over_tcp(&ctx, server, &q[..n]).await {
            Some(a) => {
                if udp.write_all(&a).await.is_err() {
                    break;
                }
            }
            None => ctx.note(format!("dns {server}"), format!("DNS server {server} didn't answer over TCP through the device.")),
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
