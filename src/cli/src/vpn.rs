//! `telepy vpn` 的純邏輯：網段怎麼讀、預設走哪些網段、用哪個引擎、sshuttle 的參數、內建引擎的 SOCKS5 / DNS-over-TCP
//! 封包，以及加路由、設 DNS 的指令。真正開虛擬網卡、轉連線的在 `vpn_engine.rs`，接起來的在 `lib.rs`。
//!
//! The pure parts of `telepy vpn`: reading networks, the default networks, which engine, sshuttle's arguments, the
//! built-in engine's SOCKS5 / DNS-over-TCP framing, and the route / DNS commands. The TUN device and the relaying live
//! in `vpn_engine.rs`, the wiring in `lib.rs`.

use std::fmt;
use std::net::Ipv4Addr;

use serde_json::Value;

/// 內建引擎的虛擬網卡位址與「DNS 伺服器」位址（RFC 2544 的測試網段，不會跟真的網路撞）。
/// The built-in engine's TUN address and its "DNS server" (RFC 2544 benchmark range: never a real network).
pub const TUN_ADDR: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 1);
pub const DNS_ADDR: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 2);
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

    /// 遮罩（macOS 的 `route` 要）。/ The netmask.
    pub fn mask(&self) -> Ipv4Addr {
        Ipv4Addr::from(if self.prefix == 0 { 0 } else { u32::MAX << (32 - self.prefix as u32) })
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

/// 走哪個引擎。/ Which engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// Telepy 自己的：虛擬網卡 + 每條連線經裝置的 sshd（`ssh -D`）。裝置什麼都不用裝。
    /// Telepy's own: a TUN device + each connection through the device's sshd (`ssh -D`); nothing needed on the device.
    Builtin,
    /// 系統的 sshuttle：裝置要有 python3。/ The system's sshuttle: the device needs python3.
    Sshuttle,
}

/// `auto` = 這台電腦有 sshuttle、裝置也有 python3 就用 sshuttle（成熟、可以把所有 DNS 送過去），否則內建的。
/// `auto` = sshuttle when this computer has it and the device has python3 (mature, can carry all DNS), else built-in.
pub fn choose(requested: &str, have_sshuttle: bool, device_python: Option<bool>, builtin_here: bool) -> Result<Engine, String> {
    match requested {
        "sshuttle" if !have_sshuttle => Err("sshuttle isn't installed on this computer (e.g. brew install sshuttle, apt install sshuttle, pip install sshuttle).".into()),
        "sshuttle" => Ok(Engine::Sshuttle),
        "builtin" if !builtin_here => Err("The built-in VPN runs on macOS and Linux. On this computer use --engine sshuttle.".into()),
        "builtin" => Ok(Engine::Builtin),
        _ => {
            if have_sshuttle && device_python == Some(true) {
                Ok(Engine::Sshuttle)
            } else if builtin_here {
                Ok(Engine::Builtin)
            } else if have_sshuttle {
                Err("The device has no python3, which sshuttle needs, and the built-in VPN doesn't run on this computer.".into())
            } else {
                Err("Install sshuttle on this computer: the built-in VPN doesn't run here.".into())
            }
        }
    }
}

/// 單引號包起來給 shell（sshuttle 用 shlex 拆 `-e`）。/ Single-quote for a shell (sshuttle splits `-e` with shlex).
pub fn shq(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@=,+".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `sshuttle -r <別名> -e 'ssh -F <設定檔> …' [--dns] <網段>…`：sshuttle 自己開 ssh，所以用 Telepy 產生的設定。
/// sshuttle opens ssh itself, so it gets the config Telepy wrote.
pub fn sshuttle_argv(alias: &str, conf: &str, nets: &[Net], dns: bool, extra_ssh: &[String]) -> Vec<String> {
    let mut ssh = format!("ssh -F {}", shq(conf));
    for o in extra_ssh {
        ssh.push(' ');
        ssh.push_str(&shq(o));
    }
    let mut out = vec!["-r".to_string(), alias.to_string(), "-e".to_string(), ssh];
    if dns {
        out.push("--dns".into());
    }
    out.extend(nets.iter().map(Net::to_string));
    out
}

/// 內建引擎的特權部分（`sudo telepy _vpn …`）的參數。/ The arguments of the built-in engine's privileged part.
pub fn helper_argv(socks_port: u16, nets: &[Net], dns_server: Option<Ipv4Addr>, dns_domains: &[String]) -> Vec<String> {
    let mut out = vec!["_vpn".to_string(), "--socks".to_string(), format!("127.0.0.1:{socks_port}")];
    for n in nets {
        out.push("--net".into());
        out.push(n.to_string());
    }
    if let Some(ip) = dns_server {
        out.push("--dns-server".into());
        out.push(ip.to_string());
        for d in dns_domains {
            out.push("--dns-domain".into());
            out.push(d.clone());
        }
    }
    out
}

/// `/etc/resolv.conf` 的第一個 IPv4 nameserver。/ The first IPv4 nameserver of a resolv.conf.
pub fn parse_resolv(text: &str) -> Option<Ipv4Addr> {
    text.lines().find_map(|l| {
        let mut w = l.split_whitespace();
        (w.next() == Some("nameserver")).then(|| w.next()?.parse().ok()).flatten()
    })
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

/// SOCKS5 的 CONNECT 請求（沒有認證、IPv4）。/ A SOCKS5 CONNECT request (no auth, IPv4).
pub fn socks5_connect(ip: Ipv4Addr, port: u16) -> Vec<u8> {
    let mut out = vec![5, 1, 0, 1];
    out.extend_from_slice(&ip.octets());
    out.extend_from_slice(&port.to_be_bytes());
    out
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
            4 => "host unreachable",
            5 => "connection refused",
            6 => "timed out",
            _ => "refused",
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

/// DNS 查詢走 TCP：前面加兩個位元組的長度。/ DNS over TCP: a two-byte length in front.
pub fn dns_tcp_frame(query: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(query.len() + 2);
    out.extend_from_slice(&(query.len() as u16).to_be_bytes());
    out.extend_from_slice(query);
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

/// macOS：每個網域一個 `/etc/resolver/<網域>`，只有這些名字問裝置。/ macOS: one `/etc/resolver/<domain>` per domain.
pub fn macos_resolver(domain: &str) -> (String, String) {
    (format!("/etc/resolver/{domain}"), format!("# telepy vpn: names under {domain} are looked up on the device\nnameserver {DNS_ADDR}\n"))
}

/// Linux（systemd-resolved）：這張網卡的 DNS 與只走它的網域。/ Linux (systemd-resolved): this link's DNS and routing-only domains.
pub fn linux_resolved_commands(dev: &str, domains: &[String]) -> Vec<Vec<String>> {
    let mut domain = vec!["resolvectl".to_string(), "domain".into(), dev.into()];
    domain.extend(domains.iter().map(|d| format!("~{d}")));
    vec![vec!["resolvectl".into(), "dns".into(), dev.into(), DNS_ADDR.to_string()], domain]
}

/// 網段裡有沒有這台電腦自己所在的網段（會把自己的區網也導過去）。/ Whether a network overlaps one of this computer's own.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn networks_are_read_and_aligned() {
        assert_eq!(parse_net("10.77.0.5/24").unwrap().to_string(), "10.77.0.0/24");
        assert_eq!(parse_net("192.168.1.9").unwrap().to_string(), "192.168.1.9/32");
        assert_eq!(parse_net("0.0.0.0/0").unwrap().to_string(), "0.0.0.0/0");
        assert!(parse_net("10.0.0.0/33").is_err());
        assert!(parse_net("box").is_err());
        assert_eq!(parse_net("172.16.5.1/12").unwrap().mask(), Ipv4Addr::new(255, 240, 0, 0));
        assert!(parse_net("10.77.0.0/24").unwrap().contains(Ipv4Addr::new(10, 77, 0, 200)));
        assert!(overlaps(&parse_net("10.0.0.0/8").unwrap(), &parse_net("10.77.0.0/24").unwrap()));
        assert!(!overlaps(&parse_net("10.1.0.0/16").unwrap(), &parse_net("10.77.0.0/24").unwrap()));
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
            {"iface": "wlan0", "ip": "192.168.1.40", "prefix": 24},
            {"iface": "lo", "ip": "127.0.0.1", "prefix": 8},
            {"iface": "big", "ip": "10.0.0.1", "prefix": 8},
            {"iface": "ll", "ip": "169.254.3.3", "prefix": 16},
            {"iface": "eth1", "ip": "10.77.0.5", "prefix": 24}
        ]);
        assert_eq!(default_nets(&lan).iter().map(Net::to_string).collect::<Vec<_>>(), ["10.77.0.0/24", "192.168.1.0/24"]);
        assert!(default_nets(&json!(null)).is_empty());
    }

    #[test]
    fn auto_prefers_sshuttle_only_when_both_ends_can_run_it() {
        assert_eq!(choose("auto", true, Some(true), true), Ok(Engine::Sshuttle));
        assert_eq!(choose("auto", true, Some(false), true), Ok(Engine::Builtin), "no python3 on the device");
        assert_eq!(choose("auto", false, None, true), Ok(Engine::Builtin));
        assert!(choose("auto", true, Some(false), false).is_err());
        assert!(choose("sshuttle", false, None, true).is_err());
        assert!(choose("builtin", true, None, false).is_err());
        assert_eq!(choose("builtin", true, Some(true), true), Ok(Engine::Builtin));
    }

    #[test]
    fn sshuttle_gets_telepys_ssh_config() {
        let nets = [parse_net("10.77.0.0/24").unwrap()];
        assert_eq!(
            sshuttle_argv("box", "/home/me/.ssh/telepy/box.conf", &nets, true, &["-o".into(), "ServerAliveInterval=30".into()]),
            ["-r", "box", "-e", "ssh -F /home/me/.ssh/telepy/box.conf -o ServerAliveInterval=30", "--dns", "10.77.0.0/24"]
        );
        assert_eq!(sshuttle_argv("box", "/Users/A B/x.conf", &nets, false, &[])[3], "ssh -F '/Users/A B/x.conf'");
        assert_eq!(shq("it's"), r"'it'\''s'");
    }

    #[test]
    fn the_helper_is_told_everything_it_needs() {
        let nets = [parse_net("10.77.0.0/24").unwrap()];
        assert_eq!(
            helper_argv(41234, &nets, Some(Ipv4Addr::new(127, 0, 0, 11)), &["corp.lan".into()]),
            ["_vpn", "--socks", "127.0.0.1:41234", "--net", "10.77.0.0/24", "--dns-server", "127.0.0.11", "--dns-domain", "corp.lan"]
        );
        assert_eq!(helper_argv(1, &nets, None, &["x".into()]).len(), 5, "no resolver = no DNS part");
    }

    #[test]
    fn resolvers_and_domains() {
        assert_eq!(parse_resolv("# x\nsearch lan\nnameserver fe80::1\nnameserver 192.168.1.1\n"), Some(Ipv4Addr::new(192, 168, 1, 1)));
        assert_eq!(parse_resolv("search x"), None);
        assert_eq!(check_domain("Corp.LAN.").unwrap(), "corp.lan");
        assert!(check_domain(".lan").is_err());
        assert!(check_domain("a b").is_err());
        assert!(check_domain("../etc").is_err());
    }

    #[test]
    fn socks5_and_dns_framing() {
        assert_eq!(socks5_connect(Ipv4Addr::new(10, 77, 0, 10), 8000), [5, 1, 0, 1, 10, 77, 0, 10, 0x1f, 0x40]);
        assert_eq!(socks5_reply_rest([5, 0, 0, 1]), Ok(6));
        assert_eq!(socks5_reply_rest([5, 5, 0, 1]), Err("connection refused".to_string()));
        assert!(socks5_reply_rest([4, 0, 0, 1]).is_err());
        assert_eq!(dns_tcp_frame(&[1, 2, 3]), [0, 3, 1, 2, 3]);
    }

    #[test]
    fn route_and_dns_commands() {
        let nets = [parse_net("10.77.0.0/24").unwrap()];
        assert_eq!(route_commands(Os::Linux, "tun0", &nets), [["ip", "route", "replace", "10.77.0.0/24", "dev", "tun0"]]);
        assert_eq!(route_commands(Os::Macos, "utun7", &nets), [["route", "-q", "-n", "add", "-net", "10.77.0.0/24", "-interface", "utun7"]]);
        assert_eq!(macos_resolver("corp.lan").0, "/etc/resolver/corp.lan");
        assert!(macos_resolver("corp.lan").1.contains("nameserver 198.18.0.2"));
        assert_eq!(linux_resolved_commands("tun0", &["corp.lan".into()])[1], ["resolvectl", "domain", "tun0", "~corp.lan"]);
    }
}
