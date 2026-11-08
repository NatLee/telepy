//! `telepy vpn` 的純邏輯：網段怎麼讀、預設走哪些網段、SOCKS5 請求、名稱的「假 IP」DNS（查詢怎麼讀、回覆怎麼組、
//! 位址怎麼發），以及加路由、設 DNS 的指令。真正開虛擬網卡、轉連線的在 `vpn_engine.rs`，接起來的在 `lib.rs`。
//!
//! 原則：**不打擾目標機器**——裝置上不開 shell、不跑指令、不放檔案。每條連線都是裝置 sshd 原生的 TCP 轉送
//! （direct-tcpip，`ssh -D` 開的）；名稱也交給 sshd 用裝置自己的解析方式找（SOCKS5 帶名稱），不在裝置上查。
//!
//! The pure parts of `telepy vpn`: reading networks, the defaults, SOCKS5 requests, the fake-IP DNS for names (reading
//! queries, building answers, handing out addresses), and the route / DNS commands. The TUN device and the relaying live
//! in `vpn_engine.rs`, the wiring in `lib.rs`.
//!
//! The rule: **leave the target machine alone** — no shell, no command, no file on the device. Every connection is a
//! TCP forward the device's sshd does natively (direct-tcpip via `ssh -D`); names are handed to sshd too (SOCKS5 with
//! a name), which resolves them the device's own way. Nothing is looked up by running something there.

use std::collections::HashMap;
use std::fmt;
use std::net::{Ipv4Addr, SocketAddrV4};

use serde_json::Value;

/// 虛擬網卡位址與「DNS 伺服器」位址（RFC 2544 的測試網段，不會跟真的網路撞）。
/// The TUN address and its "DNS server" (RFC 2544 benchmark range: never a real network).
pub const TUN_ADDR: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 1);
pub const DNS_ADDR: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 2);
/// 發給名稱的假位址從這裡來（198.18.128.0/17，三萬多個）。/ Fake addresses for names come from here (198.18.128.0/17).
pub const FAKE_NET: Net = Net { addr: Ipv4Addr::new(198, 18, 128, 0), prefix: 17 };
/// 假位址的 TTL：短，換了機器很快就重問。/ A short TTL for fake answers.
pub const FAKE_TTL: u32 = 60;
pub const MTU: u16 = 1500;

/// 一個 IPv4 網段（位址已經對齊 prefix）。/ An IPv4 network (the address aligned to its prefix).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Net {
    pub addr: Ipv4Addr,
    pub prefix: u8,
}

impl Net {
    pub fn new(addr: Ipv4Addr, prefix: u8) -> Net {
        let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix as u32) };
        Net { addr: Ipv4Addr::from(u32::from(addr) & mask), prefix }
    }

    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        Net::new(ip, self.prefix).addr == self.addr
    }
}

impl fmt::Display for Net {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

/// `10.0.0.5/24` → `10.0.0.0/24`；只有位址 = /32。/ `10.0.0.5/24` → `10.0.0.0/24`; a bare address is a /32.
pub fn parse_net(raw: &str) -> Result<Net, String> {
    let raw = raw.trim();
    let (ip, prefix) = match raw.split_once('/') {
        Some((ip, p)) => (ip, p.parse::<u8>().ok().filter(|p| *p <= 32).ok_or_else(|| format!("'{raw}': the part after / must be 0–32."))?),
        None => (raw, 32),
    };
    let ip: Ipv4Addr = ip.parse().map_err(|_| format!("'{raw}' is not an IPv4 network like 192.168.1.0/24."))?;
    Ok(Net::new(ip, prefix))
}

/// 沒指定網段時：Telepy 記得的裝置內網（通道清單 `endpoint.lan` = `[{iface, ip, prefix}]`），不含回送、
/// link-local 與比 /16 還大的網段。/ The default networks: the device's own LANs Telepy knows, without loopback,
/// link-local or anything larger than a /16.
pub fn default_nets(endpoint_lan: &Value) -> Vec<Net> {
    let mut out: Vec<Net> = endpoint_lan
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| {
            let ip: Ipv4Addr = n["ip"].as_str()?.parse().ok()?;
            let prefix = u8::try_from(n["prefix"].as_u64()?).ok()?;
            ((16..=32).contains(&prefix) && !ip.is_loopback() && !ip.is_link_local()).then(|| Net::new(ip, prefix))
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// 兩個網段有沒有重疊。/ Whether two networks overlap.
pub fn overlaps(a: &Net, b: &Net) -> bool {
    let p = a.prefix.min(b.prefix);
    Net::new(a.addr, p) == Net::new(b.addr, p)
}

/// 跟這台電腦自己的網段重疊的挑出來（預設的網段就略過、自己指定的只警告）。/ Split off networks overlapping this computer's own.
pub fn split_own(nets: &[Net], own: &[Net]) -> (Vec<Net>, Vec<Net>) {
    nets.iter().copied().partition(|n| !own.iter().any(|o| overlaps(n, o)))
}

/// 會把連到 Telepy 的那條連線也導進 VPN 的網段（自己咬自己）。/ Networks that would route the connection to Telepy into the VPN itself.
pub fn swallows(nets: &[Net], server: &[Ipv4Addr]) -> Option<(Net, Ipv4Addr)> {
    nets.iter().find_map(|n| server.iter().find(|ip| n.contains(**ip)).map(|ip| (*n, *ip)))
}

/// 裝置是不是 Mac（Telepy 記得的裝置資訊）：Apple 的 sshd 收到「用名稱轉送」會整條斷線，所以 Mac 上名稱不轉。
/// Whether the device is a Mac (from the facts Telepy keeps): Apple's sshd drops the whole connection on a forward to a
/// name, so names are not carried to a Mac.
pub fn device_is_mac(facts: &Value) -> bool {
    let has = |k: &str, needle: &str| facts[k].as_str().is_some_and(|s| s.to_ascii_lowercase().contains(needle));
    has("kernel", "darwin") || has("os", "macos") || has("os", "mac os")
}

/// `--dns-domain` 的網域：字母、數字、`-`、`.`，不以 `.` 開頭結尾。/ A `--dns-domain`: letters, digits, `-`, `.`.
pub fn check_domain(raw: &str) -> Result<String, String> {
    let d = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    let ok = !d.is_empty() && d.len() <= 253 && !d.starts_with('.') && !d.contains("..") && d.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    if ok {
        Ok(d)
    } else {
        Err(format!("'{raw}' is not a domain like corp.lan."))
    }
}

/// 名稱在不在這些網域底下（網域本身也算）。/ Whether a name is under one of the domains (the domain itself counts).
pub fn in_domains(name: &str, domains: &[String]) -> bool {
    domains.iter().any(|d| name == d || name.ends_with(&format!(".{d}")))
}

/// SOCKS5 的 CONNECT 請求（沒有認證）：位址。/ A SOCKS5 CONNECT request (no auth) to an address.
pub fn socks5_connect(ip: Ipv4Addr, port: u16) -> Vec<u8> {
    let mut out = vec![5, 1, 0, 1];
    out.extend_from_slice(&ip.octets());
    out.extend_from_slice(&port.to_be_bytes());
    out
}

/// SOCKS5 的 CONNECT 請求：名稱（裝置的 sshd 用它自己的方式解析）。/ To a name (the device's sshd resolves it its own way).
pub fn socks5_connect_name(name: &str, port: u16) -> Option<Vec<u8>> {
    let len = u8::try_from(name.len()).ok().filter(|l| *l > 0)?;
    let mut out = vec![5, 1, 0, 3, len];
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&port.to_be_bytes());
    Some(out)
}

/// SOCKS5 回覆的第一段（4 個位元組）之後還要讀幾個位元組；連線被拒時回 Err。
/// After a SOCKS5 reply's first 4 bytes: how many more to read; Err when the connection was refused.
pub fn socks5_reply_rest(head: [u8; 4]) -> Result<usize, String> {
    if head[0] != 5 {
        return Err("not a SOCKS5 reply".into());
    }
    if head[1] != 0 {
        let why = match head[1] {
            2 => "not allowed by the device's sshd",
            3 => "network unreachable",
            4 => "host unreachable (or the device couldn't find that name)",
            5 => "connection refused",
            6 => "timed out",
            _ => "the device couldn't open it",
        };
        return Err(why.into());
    }
    match head[3] {
        1 => Ok(4 + 2),
        4 => Ok(16 + 2),
        3 => Err("domain replies need one more byte".into()),
        _ => Err("odd SOCKS5 address type".into()),
    }
}

/// DNS 查詢裡我們要的部分。/ What we need from a DNS query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    pub id: u16,
    pub rd: bool,
    pub name: String,
    pub qtype: u16,
    /// 問題段結束的位置（回覆照抄問題段）。/ Where the question ends (the answer copies it).
    pub end: usize,
}

pub const TYPE_A: u16 = 1;

/// 讀一個只有一個問題的 DNS 查詢（不支援壓縮指標——查詢不會用）。/ Read a one-question DNS query (no compression pointers).
pub fn parse_query(msg: &[u8]) -> Option<Query> {
    if msg.len() < 12 || msg[2] & 0x80 != 0 || u16::from_be_bytes([msg[4], msg[5]]) != 1 {
        return None;
    }
    let mut i = 12;
    let mut labels = Vec::new();
    loop {
        let len = *msg.get(i)? as usize;
        i += 1;
        if len == 0 {
            break;
        }
        if len > 63 {
            return None;
        }
        labels.push(std::str::from_utf8(msg.get(i..i + len)?).ok()?.to_ascii_lowercase());
        i += len;
    }
    let qtype = u16::from_be_bytes([*msg.get(i)?, *msg.get(i + 1)?]);
    i += 4;
    (i <= msg.len()).then(|| Query { id: u16::from_be_bytes([msg[0], msg[1]]), rd: msg[2] & 0x01 != 0, name: labels.join("."), qtype, end: i })
}

/// 組回覆：抄問題段，`ip` 有值就加一筆 A 記錄。`rcode` 0 = 成功、5 = 拒絕（不歸我們管的名稱）。
/// Build an answer: the question copied, plus one A record when `ip` is given. `rcode` 0 = ok, 5 = refused.
pub fn dns_answer(query: &[u8], q: &Query, ip: Option<Ipv4Addr>, rcode: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(q.end + 16);
    out.extend_from_slice(&q.id.to_be_bytes());
    out.push(0x80 | u8::from(q.rd));
    out.push(0x80 | (rcode & 0x0f));
    out.extend_from_slice(&[0, 1, 0, u8::from(ip.is_some()), 0, 0, 0, 0]);
    out.extend_from_slice(&query[12..q.end]);
    if let Some(ip) = ip {
        out.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1]);
        out.extend_from_slice(&FAKE_TTL.to_be_bytes());
        out.extend_from_slice(&[0, 4]);
        out.extend_from_slice(&ip.octets());
    }
    out
}

/// 名稱 ↔ 假位址。第一次問到就發一個，之後一樣的名稱拿到一樣的位址。
/// Names ↔ fake addresses: one is handed out the first time a name is asked, the same one afterwards.
#[derive(Debug, Default)]
pub struct FakeDns {
    by_name: HashMap<String, Ipv4Addr>,
    by_ip: HashMap<Ipv4Addr, String>,
    next: u32,
}

impl FakeDns {
    pub fn ip_for(&mut self, name: &str) -> Option<Ipv4Addr> {
        if let Some(ip) = self.by_name.get(name) {
            return Some(*ip);
        }
        let size = 1u32 << (32 - FAKE_NET.prefix as u32);
        // 從 .1 開始，不發網段位址與廣播位址。/ From .1; never the network or broadcast address.
        if self.next + 2 >= size {
            return None;
        }
        self.next += 1;
        let ip = Ipv4Addr::from(u32::from(FAKE_NET.addr) + self.next);
        self.by_name.insert(name.to_string(), ip);
        self.by_ip.insert(ip, name.to_string());
        Some(ip)
    }

    pub fn name_of(&self, ip: Ipv4Addr) -> Option<&str> {
        self.by_ip.get(&ip).map(String::as_str)
    }
}

/// 一個查詢的回答：網域底下的 A 查詢 → 假位址；網域底下的其他類型 → 空的成功（客戶端改問 A）；其他名稱 → 拒絕。
/// The answer to one query: an A query under the domains → a fake address; other types there → an empty success (the
/// client then asks for A); other names → refused.
pub fn answer_query(msg: &[u8], domains: &[String], fake: &mut FakeDns) -> Option<Vec<u8>> {
    let q = parse_query(msg)?;
    if !in_domains(&q.name, domains) {
        return Some(dns_answer(msg, &q, None, 5));
    }
    let ip = if q.qtype == TYPE_A { fake.ip_for(&q.name) } else { None };
    Some(dns_answer(msg, &q, ip, 0))
}

/// 一個 IPv4 封包裡我們要看的部分。/ What we read from an IPv4 packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ip4 {
    pub src: Ipv4Addr,
    pub dst: Ipv4Addr,
    pub proto: u8,
    /// IP 標頭長度（位元組）。/ The IP header length in bytes.
    pub ihl: usize,
}

pub const PROTO_ICMP: u8 = 1;
pub const PROTO_TCP: u8 = 6;
pub const PROTO_UDP: u8 = 17;

pub fn parse_ipv4(p: &[u8]) -> Option<Ip4> {
    if p.len() < 20 || p[0] >> 4 != 4 {
        return None;
    }
    let ihl = usize::from(p[0] & 0x0f) * 4;
    (ihl >= 20 && p.len() >= ihl).then(|| Ip4 { src: Ipv4Addr::new(p[12], p[13], p[14], p[15]), dst: Ipv4Addr::new(p[16], p[17], p[18], p[19]), proto: p[9], ihl })
}

/// 一個新連線的 SYN（沒有 ACK）。/ A new connection's SYN (no ACK).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Syn {
    pub src: SocketAddrV4,
    pub dst: SocketAddrV4,
    pub seq: u32,
}

pub fn tcp_syn(p: &[u8]) -> Option<Syn> {
    let ip = parse_ipv4(p).filter(|ip| ip.proto == PROTO_TCP)?;
    let t = p.get(ip.ihl..ip.ihl + 20)?;
    let (syn, ack) = (t[13] & 0x02 != 0, t[13] & 0x10 != 0);
    (syn && !ack).then(|| Syn {
        src: SocketAddrV4::new(ip.src, u16::from_be_bytes([t[0], t[1]])),
        dst: SocketAddrV4::new(ip.dst, u16::from_be_bytes([t[2], t[3]])),
        seq: u32::from_be_bytes([t[4], t[5], t[6], t[7]]),
    })
}

/// 網際網路校驗和（RFC 1071）。/ The Internet checksum (RFC 1071).
pub fn checksum(chunks: &[&[u8]]) -> u16 {
    let mut sum: u32 = 0;
    let mut odd: Option<u8> = None;
    for c in chunks {
        for &b in c.iter() {
            match odd.take() {
                Some(hi) => sum += u32::from(u16::from_be_bytes([hi, b])),
                None => odd = Some(b),
            }
        }
    }
    if let Some(hi) = odd {
        sum += u32::from(hi) << 8;
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

fn ipv4_header(src: Ipv4Addr, dst: Ipv4Addr, proto: u8, payload_len: usize) -> [u8; 20] {
    let total = (20 + payload_len) as u16;
    let mut h = [0u8; 20];
    h[0] = 0x45;
    h[2..4].copy_from_slice(&total.to_be_bytes());
    h[8] = 64;
    h[9] = proto;
    h[12..16].copy_from_slice(&src.octets());
    h[16..20].copy_from_slice(&dst.octets());
    let c = checksum(&[&h]);
    h[10..12].copy_from_slice(&c.to_be_bytes());
    h
}

/// 回給 SYN 的 RST：程式馬上看到「連線被拒」，而不是先連上再斷。
/// The RST answering a SYN: the program sees "connection refused" at once instead of connected-then-closed.
pub fn rst_for(syn: &Syn) -> Vec<u8> {
    let mut t = [0u8; 20];
    t[0..2].copy_from_slice(&syn.dst.port().to_be_bytes());
    t[2..4].copy_from_slice(&syn.src.port().to_be_bytes());
    t[8..12].copy_from_slice(&syn.seq.wrapping_add(1).to_be_bytes());
    t[12] = 5 << 4;
    t[13] = 0x04 | 0x10;
    let (src, dst) = (*syn.dst.ip(), *syn.src.ip());
    let pseudo = [&src.octets()[..], &dst.octets()[..], &[0, PROTO_TCP, 0, 20][..]].concat();
    let c = checksum(&[&pseudo, &t]);
    t[16..18].copy_from_slice(&c.to_be_bytes());
    [&ipv4_header(src, dst, PROTO_TCP, 20)[..], &t[..]].concat()
}

/// ICMP「目的地無法到達：管理上禁止」（type 3 code 13），附原封包的標頭與前 8 個位元組：ping 與 UDP 程式
/// 馬上知道這條路不帶它，不用乾等。/ ICMP "destination unreachable: administratively prohibited" with the
/// original header and first 8 bytes: ping and UDP programs learn at once that this path doesn't carry them.
pub fn icmp_prohibited(original: &[u8], from: Ipv4Addr) -> Option<Vec<u8>> {
    let ip = parse_ipv4(original)?;
    // 別回 ICMP 錯誤給 ICMP 錯誤。/ Never answer an ICMP error with one.
    if ip.proto == PROTO_ICMP && original.get(ip.ihl).is_some_and(|t| ![0, 8].contains(t)) {
        return None;
    }
    let quoted = &original[..original.len().min(ip.ihl + 8)];
    let mut m = vec![3u8, 13, 0, 0, 0, 0, 0, 0];
    m.extend_from_slice(quoted);
    let c = checksum(&[&m]);
    m[2..4].copy_from_slice(&c.to_be_bytes());
    Some([&ipv4_header(from, ip.src, PROTO_ICMP, m.len())[..], &m[..]].concat())
}

/// 一個 ping（ICMP echo request）。/ A ping (ICMP echo request).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Echo {
    pub src: Ipv4Addr,
    pub dst: Ipv4Addr,
    pub ident: u16,
    pub seq: u16,
    pub data: Vec<u8>,
}

/// 一個 UDP 封包。/ A UDP datagram.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Datagram {
    pub src: SocketAddrV4,
    pub dst: SocketAddrV4,
    pub data: Vec<u8>,
}

/// 虛擬網卡收到的封包怎麼處理。/ What to do with a packet from the TUN device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    /// 交給 TCP/IP 堆疊（已有的連線、問這裡的 DNS）。/ Hand to the TCP/IP stack (existing connections, DNS asked here).
    Pass,
    /// 新的 TCP 連線：先從裝置連，連上了才接。/ A new TCP connection: connect from the device first, accept only then.
    Connect(Syn),
    /// ping：有裝置上的 carrier 就請它 ping，否則回 ICMP 禁止。/ A ping: the device's carrier pings when there is one.
    Ping(Echo),
    /// UDP：有 carrier 就經它送；沒有時 DNS（53）改走 TCP，其他回 ICMP 禁止。
    /// UDP: through the carrier when there is one; without it DNS (53) goes as TCP, the rest gets ICMP prohibited.
    Udp(Datagram),
    /// 這條路不帶：回 ICMP 禁止並說一次為什麼。/ Not carried: answer ICMP prohibited and say why once.
    Refuse(Refused),
    Drop,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Refused {
    Ping(Ipv4Addr),
    Udp(SocketAddrV4),
    Other(u8),
}

pub fn classify(p: &[u8]) -> Inbound {
    let Some(ip) = parse_ipv4(p) else { return Inbound::Drop };
    match ip.proto {
        PROTO_TCP => tcp_syn(p).map_or(Inbound::Pass, Inbound::Connect),
        PROTO_UDP => {
            let Some(h) = p.get(ip.ihl..ip.ihl + 8) else { return Inbound::Drop };
            let src = SocketAddrV4::new(ip.src, u16::from_be_bytes([h[0], h[1]]));
            let dst = SocketAddrV4::new(ip.dst, u16::from_be_bytes([h[2], h[3]]));
            // 問這裡（198.18.0.2）的 DNS 由堆疊交給我們答。/ DNS asked here goes to the stack, which hands it to us.
            if dst == SocketAddrV4::new(DNS_ADDR, 53) {
                return Inbound::Pass;
            }
            let len = usize::from(u16::from_be_bytes([h[4], h[5]])).clamp(8, p.len() - ip.ihl);
            Inbound::Udp(Datagram { src, dst, data: p[ip.ihl + 8..ip.ihl + len].to_vec() })
        }
        PROTO_ICMP => match p.get(ip.ihl..ip.ihl + 8) {
            Some(m) if m[0] == 8 => Inbound::Ping(Echo {
                src: ip.src,
                dst: ip.dst,
                ident: u16::from_be_bytes([m[4], m[5]]),
                seq: u16::from_be_bytes([m[6], m[7]]),
                data: p[ip.ihl + 8..].to_vec(),
            }),
            _ => Inbound::Drop,
        },
        other => Inbound::Refuse(Refused::Other(other)),
    }
}

/// ping 的回覆（從被 ping 的位址回來）。/ The reply to a ping (coming back from the pinged address).
pub fn echo_reply(e: &Echo) -> Vec<u8> {
    let mut m = vec![0u8, 0, 0, 0];
    m.extend_from_slice(&e.ident.to_be_bytes());
    m.extend_from_slice(&e.seq.to_be_bytes());
    m.extend_from_slice(&e.data);
    let c = checksum(&[&m]);
    m[2..4].copy_from_slice(&c.to_be_bytes());
    [&ipv4_header(e.dst, e.src, PROTO_ICMP, m.len())[..], &m[..]].concat()
}

/// 一個 UDP 封包（含校驗和）。/ A UDP datagram (with its checksum).
pub fn udp_packet(src: SocketAddrV4, dst: SocketAddrV4, data: &[u8]) -> Vec<u8> {
    let len = (8 + data.len()) as u16;
    let mut u = Vec::with_capacity(usize::from(len));
    u.extend_from_slice(&src.port().to_be_bytes());
    u.extend_from_slice(&dst.port().to_be_bytes());
    u.extend_from_slice(&len.to_be_bytes());
    u.extend_from_slice(&[0, 0]);
    u.extend_from_slice(data);
    let pseudo = [&src.ip().octets()[..], &dst.ip().octets()[..], &[0, PROTO_UDP][..], &len.to_be_bytes()[..]].concat();
    let c = match checksum(&[&pseudo, &u]) {
        0 => 0xffff,
        c => c,
    };
    u[6..8].copy_from_slice(&c.to_be_bytes());
    [&ipv4_header(*src.ip(), *dst.ip(), PROTO_UDP, u.len())[..], &u[..]].concat()
}

/// DNS 查詢走 TCP 時的前綴長度。/ The length prefix of DNS over TCP.
pub fn dns_tcp_frame(query: &[u8]) -> Vec<u8> {
    let mut out = (query.len() as u16).to_be_bytes().to_vec();
    out.extend_from_slice(query);
    out
}

/// `ssh -D` 的 stderr 一行怎麼處理：每條連不上的轉送它都會印一行，我們已經回了 RST、也會自己說；
/// 裝置不准轉送則要說清楚，因為那樣什麼都過不去。
/// What to do with a line of `ssh -D`'s stderr: it prints one per refused forward, which the RST and our own line
/// already cover; a device that forbids forwarding is spelled out, because then nothing goes through.
#[derive(Debug, PartialEq, Eq)]
pub enum SshLine {
    Keep,
    Drop,
    NoForwarding,
}

pub fn ssh_stderr_line(line: &str) -> SshLine {
    if line.contains("open failed: administratively prohibited") {
        SshLine::NoForwarding
    } else if line.contains("open failed: connect failed:") || line.contains("open failed: unknown channel type") {
        SshLine::Drop
    } else {
        SshLine::Keep
    }
}

/// 特權那一半（`sudo telepy _vpn …`）要知道的事。/ What the privileged half (`sudo telepy _vpn …`) needs to know.
#[derive(Debug, Clone, Default)]
pub struct Helper {
    pub socks_port: u16,
    pub nets: Vec<Net>,
    pub dns_domains: Vec<String>,
    pub dns_server: Option<Ipv4Addr>,
    /// 裝置上 carrier 的 agent：本機轉接的 port 與通行碼檔。/ The device carrier's agent: the local bridge port and token file.
    pub agent: Option<(u16, String)>,
    /// 名稱能不能交給裝置的 sshd（Mac 不行）。/ Whether names may be handed to the device's sshd (not on a Mac).
    pub sshd_names: bool,
    pub owner: u32,
}

pub fn helper_argv(h: &Helper) -> Vec<String> {
    let mut out = vec!["_vpn".to_string(), "--socks".to_string(), format!("127.0.0.1:{}", h.socks_port), "--owner".to_string(), h.owner.to_string()];
    if let Some(ip) = h.dns_server {
        out.push("--dns-server".into());
        out.push(ip.to_string());
    }
    if let Some((port, token)) = &h.agent {
        out.extend(["--agent".to_string(), format!("127.0.0.1:{port}"), "--agent-token".to_string(), token.clone()]);
    }
    if !h.sshd_names {
        out.push("--no-sshd-names".into());
    }
    for n in &h.nets {
        out.push("--net".into());
        out.push(n.to_string());
    }
    for d in &h.dns_domains {
        out.push("--dns-domain".into());
        out.push(d.clone());
    }
    out
}

/// 這台電腦是哪種系統（路由 / DNS 指令不同）。/ Which OS (route / DNS commands differ).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Macos,
    Linux,
}

/// 把網段導進虛擬網卡的指令。/ The commands routing the networks into the TUN device.
pub fn route_commands(os: Os, dev: &str, nets: &[Net]) -> Vec<Vec<String>> {
    nets.iter()
        .map(|n| match os {
            Os::Macos => vec!["route".into(), "-q".into(), "-n".into(), "add".into(), "-net".into(), n.to_string(), "-interface".into(), dev.into()],
            Os::Linux => vec!["ip".into(), "route".into(), "replace".into(), n.to_string(), "dev".into(), dev.into()],
        })
        .collect()
}

/// macOS：每個網域一個 `/etc/resolver/<網域>`，只有這些名字問 VPN。/ macOS: one `/etc/resolver/<domain>` per domain.
pub fn macos_resolver(domain: &str) -> (String, String) {
    (format!("/etc/resolver/{domain}"), format!("# telepy vpn: names under {domain} go to the device\nnameserver {DNS_ADDR}\n"))
}

/// Linux（systemd-resolved）：這張網卡的 DNS 與只走它的網域。/ Linux (systemd-resolved): this link's DNS and routing-only domains.
pub fn linux_resolved_commands(dev: &str, domains: &[String]) -> Vec<Vec<String>> {
    let mut domain = vec!["resolvectl".to_string(), "domain".into(), dev.into()];
    domain.extend(domains.iter().map(|d| format!("~{d}")));
    vec![vec!["resolvectl".into(), "dns".into(), dev.into(), DNS_ADDR.to_string()], domain]
}

/// 斷線後隔多久重連：1、2、4…最多 30 秒。/ How long to wait before reconnecting: 1, 2, 4… at most 30 s.
pub fn reconnect_delay(attempt: u32) -> u64 {
    (1u64 << attempt.min(5)).min(30)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn networks_are_read_and_aligned() {
        assert_eq!(parse_net("10.77.0.5/24").unwrap().to_string(), "10.77.0.0/24");
        assert_eq!(parse_net("192.168.1.9").unwrap().to_string(), "192.168.1.9/32");
        assert!(parse_net("10.0.0.0/33").is_err());
        assert!(parse_net("box").is_err());
        assert!(parse_net("10.77.0.0/24").unwrap().contains(Ipv4Addr::new(10, 77, 0, 200)));
        let nets = [parse_net("192.168.1.0/24").unwrap(), parse_net("10.77.0.0/24").unwrap()];
        let (keep, own) = split_own(&nets, &[parse_net("192.168.1.40/24").unwrap()]);
        assert_eq!((keep, own), (vec![nets[1]], vec![nets[0]]), "the computer's own LAN is left out");
        assert_eq!(swallows(&[parse_net("0.0.0.0/0").unwrap()], &[Ipv4Addr::new(203, 0, 113, 9)]).map(|(n, _)| n.to_string()), Some("0.0.0.0/0".into()));
        assert_eq!(swallows(&nets, &[Ipv4Addr::new(203, 0, 113, 9)]), None);
    }

    #[test]
    fn the_default_is_the_devices_own_lans() {
        let lan = json!([
            {"iface": "eth0", "ip": "192.168.1.23", "prefix": 24},
            {"iface": "lo", "ip": "127.0.0.1", "prefix": 8},
            {"iface": "big", "ip": "10.0.0.1", "prefix": 8},
            {"iface": "eth1", "ip": "10.77.0.5", "prefix": 24}
        ]);
        assert_eq!(default_nets(&lan).iter().map(Net::to_string).collect::<Vec<_>>(), ["10.77.0.0/24", "192.168.1.0/24"]);
        assert!(default_nets(&json!(null)).is_empty());
    }

    #[test]
    fn macs_are_recognised_from_the_facts() {
        assert!(device_is_mac(&json!({"kernel": "Darwin 24.1.0", "os": "macOS 15.1"})));
        assert!(device_is_mac(&json!({"os": "macOS 14"})));
        assert!(!device_is_mac(&json!({"kernel": "Linux 6.1", "os": "Debian GNU/Linux 12"})));
        assert!(!device_is_mac(&json!(null)));
    }

    #[test]
    fn domains_and_socks_requests() {
        assert_eq!(check_domain("Corp.LAN.").unwrap(), "corp.lan");
        assert!(check_domain(".lan").is_err() && check_domain("a b").is_err() && check_domain("../etc").is_err());
        let d = ["corp.lan".to_string()];
        assert!(in_domains("nas.corp.lan", &d) && in_domains("corp.lan", &d));
        assert!(!in_domains("evilcorp.lan", &d) && !in_domains("example.com", &d));
        assert_eq!(socks5_connect(Ipv4Addr::new(10, 77, 0, 10), 8000), [5, 1, 0, 1, 10, 77, 0, 10, 0x1f, 0x40]);
        assert_eq!(socks5_connect_name("nas", 80).unwrap(), [5, 1, 0, 3, 3, b'n', b'a', b's', 0, 80]);
        assert!(socks5_connect_name("", 80).is_none());
        assert_eq!(socks5_reply_rest([5, 0, 0, 1]), Ok(6));
        assert!(socks5_reply_rest([5, 4, 0, 1]).unwrap_err().contains("name"));
    }

    /// `dig nas.corp.lan A` 的查詢（id 0x1234，要遞迴）。/ The query `dig nas.corp.lan A` sends.
    fn query(name: &str, qtype: u16) -> Vec<u8> {
        let mut m = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for l in name.split('.') {
            m.push(l.len() as u8);
            m.extend_from_slice(l.as_bytes());
        }
        m.push(0);
        m.extend_from_slice(&qtype.to_be_bytes());
        m.extend_from_slice(&[0, 1]);
        m
    }

    #[test]
    fn names_under_the_domains_get_a_fake_address_and_keep_it() {
        let d = ["corp.lan".to_string()];
        let mut fake = FakeDns::default();
        let q = query("NAS.corp.lan", TYPE_A);
        assert_eq!(parse_query(&q).unwrap().name, "nas.corp.lan");
        let a = answer_query(&q, &d, &mut fake).unwrap();
        assert_eq!(&a[..2], &[0x12, 0x34]);
        assert_eq!(a[3] & 0x0f, 0, "NOERROR");
        assert_eq!(u16::from_be_bytes([a[6], a[7]]), 1, "one answer");
        let ip = Ipv4Addr::new(a[a.len() - 4], a[a.len() - 3], a[a.len() - 2], a[a.len() - 1]);
        assert!(FAKE_NET.contains(ip) && ip != FAKE_NET.addr);
        assert_eq!(fake.name_of(ip), Some("nas.corp.lan"));
        let again = answer_query(&query("nas.corp.lan", TYPE_A), &d, &mut fake).unwrap();
        assert_eq!(&again[again.len() - 4..], &ip.octets(), "the same name keeps its address");
        // AAAA：空的成功（不發 IPv6），其他名稱：拒絕。/ AAAA: an empty success; other names: refused.
        let aaaa = answer_query(&query("nas.corp.lan", 28), &d, &mut fake).unwrap();
        assert_eq!((aaaa[3] & 0x0f, u16::from_be_bytes([aaaa[6], aaaa[7]])), (0, 0));
        let other = answer_query(&query("example.com", TYPE_A), &d, &mut fake).unwrap();
        assert_eq!(other[3] & 0x0f, 5);
        assert!(parse_query(&[0u8; 5]).is_none());
    }

    #[test]
    fn the_helper_and_the_commands() {
        let nets = [parse_net("10.77.0.0/24").unwrap()];
        let h = Helper { socks_port: 41234, nets: nets.to_vec(), dns_domains: vec!["corp.lan".into()], dns_server: Some(Ipv4Addr::new(10, 77, 0, 1)), agent: None, sshd_names: true, owner: 77 };
        assert_eq!(helper_argv(&h), ["_vpn", "--socks", "127.0.0.1:41234", "--owner", "77", "--dns-server", "10.77.0.1", "--net", "10.77.0.0/24", "--dns-domain", "corp.lan"]);
        let h = Helper { agent: Some((41300, "/tmp/t".into())), sshd_names: false, dns_server: None, ..h };
        assert_eq!(helper_argv(&h)[5..9], ["--agent", "127.0.0.1:41300", "--agent-token", "/tmp/t"]);
        assert!(helper_argv(&h).contains(&"--no-sshd-names".to_string()));
        assert_eq!(route_commands(Os::Linux, "tun0", &nets), [["ip", "route", "replace", "10.77.0.0/24", "dev", "tun0"]]);
        assert_eq!(route_commands(Os::Macos, "utun7", &nets), [["route", "-q", "-n", "add", "-net", "10.77.0.0/24", "-interface", "utun7"]]);
        assert!(macos_resolver("corp.lan").1.contains("nameserver 198.18.0.2"));
        assert_eq!(linux_resolved_commands("tun0", &["corp.lan".into()])[1], ["resolvectl", "domain", "tun0", "~corp.lan"]);
        assert_eq!((reconnect_delay(0), reconnect_delay(3), reconnect_delay(20)), (1, 8, 30));
    }

    /// 從筆電 10.0.0.2:40000 到 10.77.0.10:9999 的 SYN。/ A SYN from 10.0.0.2:40000 to 10.77.0.10:9999.
    fn syn_packet(flags: u8) -> Vec<u8> {
        let mut t = [0u8; 20];
        t[0..2].copy_from_slice(&40000u16.to_be_bytes());
        t[2..4].copy_from_slice(&9999u16.to_be_bytes());
        t[4..8].copy_from_slice(&1000u32.to_be_bytes());
        t[12] = 5 << 4;
        t[13] = flags;
        [&ipv4_header(Ipv4Addr::new(10, 0, 0, 2), Ipv4Addr::new(10, 77, 0, 10), PROTO_TCP, 20)[..], &t[..]].concat()
    }

    #[test]
    fn new_connections_are_told_apart_and_refused_with_a_valid_rst() {
        let p = syn_packet(0x02);
        let Inbound::Connect(syn) = classify(&p) else { panic!("a SYN is a new connection") };
        assert_eq!((syn.src.to_string(), syn.dst.to_string(), syn.seq), ("10.0.0.2:40000".into(), "10.77.0.10:9999".into(), 1000));
        assert_eq!(classify(&syn_packet(0x12)), Inbound::Pass, "SYN+ACK isn't new");
        assert_eq!(classify(&syn_packet(0x10)), Inbound::Pass);
        let r = rst_for(&syn);
        let ip = parse_ipv4(&r).unwrap();
        assert_eq!((ip.src, ip.dst, ip.proto), (Ipv4Addr::new(10, 77, 0, 10), Ipv4Addr::new(10, 0, 0, 2), PROTO_TCP));
        assert_eq!(checksum(&[&r[..20]]), 0, "IP header checksum");
        let pseudo = [&r[12..20], &[0, PROTO_TCP, 0, 20][..]].concat();
        assert_eq!(checksum(&[&pseudo, &r[20..]]), 0, "TCP checksum");
        assert_eq!((u16::from_be_bytes([r[20], r[21]]), u16::from_be_bytes([r[22], r[23]])), (9999, 40000));
        assert_eq!(u32::from_be_bytes([r[28], r[29], r[30], r[31]]), 1001, "acknowledges the SYN");
        assert_eq!(r[33], 0x14, "RST + ACK");
    }

    #[test]
    fn pings_and_udp_are_read_and_answered() {
        let mut echo = vec![8u8, 0, 0, 0, 0x12, 0x34, 0, 1, b'h', b'i'];
        let c = checksum(&[&echo]);
        echo[2..4].copy_from_slice(&c.to_be_bytes());
        let ping = [&ipv4_header(Ipv4Addr::new(10, 0, 0, 2), Ipv4Addr::new(10, 77, 0, 10), PROTO_ICMP, echo.len())[..], &echo[..]].concat();
        let Inbound::Ping(e) = classify(&ping) else { panic!("an echo request is a ping") };
        assert_eq!((e.ident, e.seq, e.data.as_slice()), (0x1234, 1, &b"hi"[..]));
        let r = echo_reply(&e);
        let ip = parse_ipv4(&r).unwrap();
        assert_eq!((ip.src, ip.dst, r[20]), (Ipv4Addr::new(10, 77, 0, 10), Ipv4Addr::new(10, 0, 0, 2), 0), "a reply from the pinged host");
        assert_eq!((checksum(&[&r[..20]]), checksum(&[&r[20..]])), (0, 0));
        assert_eq!(&r[24..], &echo[4..], "same id, seq and data");
        // 不支援時：ICMP 禁止，附原封包。/ Without support: ICMP prohibited quoting the original.
        let m = icmp_prohibited(&ping, DNS_ADDR).unwrap();
        assert_eq!((m[20], m[21]), (3, 13));
        assert_eq!((checksum(&[&m[..20]]), checksum(&[&m[20..]])), (0, 0));
        assert_eq!(&m[28..], &ping[..28], "quotes the header and first 8 bytes");
        assert!(icmp_prohibited(&m, DNS_ADDR).is_none(), "no ICMP error for an ICMP error");

        let from = SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 2), 40000);
        let lan = |port: u16| SocketAddrV4::new(Ipv4Addr::new(10, 77, 0, 1), port);
        let ntp = udp_packet(from, lan(123), b"time?");
        assert_eq!(classify(&ntp), Inbound::Udp(Datagram { src: from, dst: lan(123), data: b"time?".to_vec() }));
        let pseudo = [&ntp[12..20], &[0, PROTO_UDP, 0, 13][..]].concat();
        assert_eq!(checksum(&[&pseudo, &ntp[20..]]), 0, "UDP checksum");
        assert!(matches!(classify(&udp_packet(from, lan(53), b"q")), Inbound::Udp(d) if d.dst.port() == 53));
        assert_eq!(classify(&udp_packet(from, SocketAddrV4::new(DNS_ADDR, 53), b"q")), Inbound::Pass, "DNS asked here");
        assert_eq!(classify(&[0x60, 0, 0, 0]), Inbound::Drop, "IPv6 isn't routed here");
        assert_eq!(dns_tcp_frame(&[1, 2, 3]), [0, 3, 1, 2, 3]);
    }

    #[test]
    fn ssh_lines_about_refused_forwards_are_folded() {
        assert_eq!(ssh_stderr_line("channel 2: open failed: connect failed: Connection refused"), SshLine::Drop);
        assert_eq!(ssh_stderr_line("channel 3: open failed: administratively prohibited: open failed"), SshLine::NoForwarding);
        assert_eq!(ssh_stderr_line("Permission denied (publickey)."), SshLine::Keep);
    }
}
