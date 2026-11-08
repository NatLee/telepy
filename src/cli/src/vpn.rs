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
use std::net::Ipv4Addr;

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

/// 內建引擎特權部分（`sudo telepy _vpn …`）的參數。/ The arguments of the privileged part.
pub fn helper_argv(socks_port: u16, nets: &[Net], dns_domains: &[String], owner: u32) -> Vec<String> {
    let mut out = vec!["_vpn".to_string(), "--socks".to_string(), format!("127.0.0.1:{socks_port}"), "--owner".to_string(), owner.to_string()];
    for n in nets {
        out.push("--net".into());
        out.push(n.to_string());
    }
    for d in dns_domains {
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
        assert_eq!(helper_argv(41234, &nets, &["corp.lan".into()], 77), ["_vpn", "--socks", "127.0.0.1:41234", "--owner", "77", "--net", "10.77.0.0/24", "--dns-domain", "corp.lan"]);
        assert_eq!(route_commands(Os::Linux, "tun0", &nets), [["ip", "route", "replace", "10.77.0.0/24", "dev", "tun0"]]);
        assert_eq!(route_commands(Os::Macos, "utun7", &nets), [["route", "-q", "-n", "add", "-net", "10.77.0.0/24", "-interface", "utun7"]]);
        assert!(macos_resolver("corp.lan").1.contains("nameserver 198.18.0.2"));
        assert_eq!(linux_resolved_commands("tun0", &["corp.lan".into()])[1], ["resolvectl", "domain", "tun0", "~corp.lan"]);
        assert_eq!((reconnect_delay(0), reconnect_delay(3), reconnect_delay(20)), (1, 8, 30));
    }
}
