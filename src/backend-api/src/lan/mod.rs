//! 區網探索（#20）：找出隧道裝置「背後」的機器，給跳板機表、拓撲圖與一行連線指令用。
//!
//! 免安裝：所有連線都由**裝置自己的 sshd** 發出（direct-tcpip，與 `ssh -J` / `-W` 同一機制，需要
//! `AllowTcpForwarding`，OpenSSH 預設開啟）。流程：
//! 1. 在裝置上跑 `ip -o -4 addr` / `ifconfig` / PowerShell 找出它的 IPv4 網段（或使用者指定的 CIDR）；
//! 2. 對每個位址的第一個 port 發 direct-tcpip 探測（順便讓裝置對活著的主機做 ARP）；
//! 3. 讀裝置的鄰居表（`ip neigh` / `arp -an` / `Get-NetNeighbor`），連沒開任何 port 的活主機也找得到；
//! 4. 只對活主機探測其餘 port；開著的 22 port 讀 SSH banner；最後用 `getent hosts` 反查名稱（盡力而為）。
//!
//! 這個檔案是純邏輯（解析與範圍計算）；執行在 `scan.rs`，HTTP 在 `api/lan.rs`，SQL 在 `db/lan.rs`。
//! LAN discovery behind a tunnel's device, done entirely by the device's own sshd (no agent).

pub mod scan;

use std::collections::BTreeSet;
use std::net::Ipv4Addr;

use once_cell::sync::Lazy;
use regex::Regex;

/// 預設探測的 port：SSH、HTTP(S)、SMB、RDP、VNC、常見的 web 管理介面。/ Default probe ports.
pub const DEFAULT_PORTS: &[u16] = &[22, 80, 443, 445, 3389, 5900, 8080, 8443];
pub const MAX_PORTS: usize = 32;
/// 一次掃描最多幾個位址（= 一個 /22）。/ Address cap per scan (a /22).
pub const MAX_ADDRESSES: usize = 1024;
/// 偵測到比這更大的網段時，只掃裝置所在的 /24。/ Larger detected networks shrink to the device's /24.
pub const AUTO_MIN_PREFIX: u8 = 22;

/// 一個 IPv4 網段（介面位址 + prefix）。/ An IPv4 network: an address and its prefix length.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Network {
    pub iface: String,
    pub addr: Ipv4Addr,
    pub prefix: u8,
}

impl Network {
    fn mask(&self) -> u32 {
        if self.prefix == 0 {
            0
        } else {
            u32::MAX << (32 - u32::from(self.prefix))
        }
    }
    pub fn network(&self) -> Ipv4Addr {
        Ipv4Addr::from(u32::from(self.addr) & self.mask())
    }
    pub fn cidr(&self) -> String {
        format!("{}/{}", self.network(), self.prefix)
    }
    pub fn size(&self) -> u64 {
        1u64 << (32 - u32::from(self.prefix))
    }
    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & self.mask() == u32::from(self.addr) & self.mask()
    }
    /// 可用的主機位址（/31、/32 全部；其餘去掉網路位址與廣播）。/ Usable host addresses.
    pub fn hosts(&self) -> Vec<Ipv4Addr> {
        let base = u32::from(self.network());
        let size = self.size() as u32;
        if self.prefix >= 31 {
            return (0..size).map(|i| Ipv4Addr::from(base + i)).collect();
        }
        (1..size - 1).map(|i| Ipv4Addr::from(base + i)).collect()
    }
    /// 太大的網段縮成裝置所在的 /24。/ Shrink an oversized network to the /24 around the address.
    pub fn narrowed(&self) -> Network {
        if self.prefix >= AUTO_MIN_PREFIX {
            self.clone()
        } else {
            Network { iface: self.iface.clone(), addr: self.addr, prefix: 24 }
        }
    }
}

/// 可以掃的位址：私有網段、CGNAT、loopback、link-local（不讓裝置去掃公網）。
/// Allowed scan targets: private, CGNAT, loopback and link-local ranges only (never the internet).
pub fn is_scannable(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_private() || ip.is_loopback() || ip.is_link_local() || (o[0] == 100 && (64..128).contains(&o[1]))
}

/// 使用者輸入的 CIDR（`192.168.1.0/24`、單一位址 = /32）。網段要整個落在可掃範圍內、不超過 MAX_ADDRESSES。
/// Parse a user-supplied CIDR (a bare address is a /32); it must stay inside the scannable ranges.
pub fn parse_cidr(raw: &str) -> Result<Network, String> {
    let raw = raw.trim();
    let (ip, prefix) = match raw.split_once('/') {
        Some((ip, p)) => (ip, p.parse::<u8>().map_err(|_| format!("invalid prefix in {raw}"))?),
        None => (raw, 32),
    };
    let addr: Ipv4Addr = ip.parse().map_err(|_| format!("not an IPv4 address: {raw}"))?;
    if prefix > 32 {
        return Err(format!("invalid prefix in {raw}"));
    }
    let n = Network { iface: String::new(), addr, prefix };
    if n.size() > MAX_ADDRESSES as u64 {
        return Err(format!("{raw} is too large; scan at most {MAX_ADDRESSES} addresses (a /22)"));
    }
    let last = Ipv4Addr::from(u32::from(n.network()) + (n.size() as u32 - 1));
    if !is_scannable(n.network()) || !is_scannable(last) {
        return Err(format!("{raw} is not a private network"));
    }
    Ok(n)
}

pub fn parse_ports(ports: &[i64]) -> Result<Vec<u16>, String> {
    let set: BTreeSet<u16> = ports.iter().map(|p| u16::try_from(*p).ok().filter(|p| *p > 0).ok_or_else(|| format!("invalid port: {p}"))).collect::<Result<_, _>>()?;
    if set.is_empty() || set.len() > MAX_PORTS {
        return Err(format!("give between 1 and {MAX_PORTS} ports"));
    }
    Ok(set.into_iter().collect())
}

/// 不掃的虛擬介面（容器、橋接、VM）。/ Virtual interfaces that are never scanned automatically.
fn is_virtual_iface(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["docker", "br-", "veth", "virbr", "cni", "flannel", "podman", "vethernet", "vmnet", "vboxnet", "utun", "lo"]
        .iter()
        .any(|p| n.starts_with(p) || n.contains("(wsl") || n.contains("hyper-v"))
}

static IP_ADDR: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)").unwrap());
static IFCONFIG_HEAD: Lazy<Regex> = Lazy::new(|| Regex::new(r"^([A-Za-z0-9_.\-]+):?\s").unwrap());
static IFCONFIG_INET: Lazy<Regex> = Lazy::new(|| Regex::new(r"inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)\b.*?(?:netmask |Mask:)(0x[0-9a-fA-F]{8}|\d+\.\d+\.\d+\.\d+)").unwrap());
static PS_ADDR: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(.*?)\s*\|\s*(\d+\.\d+\.\d+\.\d+)/(\d+)\s*$").unwrap());

fn mask_to_prefix(mask: &str) -> Option<u8> {
    let bits = if let Some(hex) = mask.strip_prefix("0x") {
        u32::from_str_radix(hex, 16).ok()?
    } else {
        u32::from(mask.parse::<Ipv4Addr>().ok()?)
    };
    (bits.leading_ones() + bits.trailing_zeros() == 32).then_some(bits.leading_ones() as u8)
}

/// 裝置的 IPv4 網段：`ip -o -4 addr`、`ifconfig`（BSD / macOS / 舊 Linux）或我們的 PowerShell 輸出
/// （`alias|ip/prefix`）。去掉 loopback、link-local、虛擬介面與不可掃的位址；去重。
/// The device's IPv4 networks from `ip -o -4 addr`, `ifconfig` or our PowerShell output.
pub fn parse_networks(output: &str) -> Vec<Network> {
    let mut out: BTreeSet<Network> = BTreeSet::new();
    let mut iface = String::new();
    for line in output.lines() {
        let found = if let Some(c) = IP_ADDR.captures(line) {
            Some((c[1].trim_end_matches(':').to_string(), c[2].parse().ok(), c[3].parse().ok()))
        } else if let Some(c) = PS_ADDR.captures(line.trim()) {
            Some((c[1].to_string(), c[2].parse().ok(), c[3].parse().ok()))
        } else {
            if !line.starts_with(char::is_whitespace) {
                if let Some(h) = IFCONFIG_HEAD.captures(line) {
                    iface = h[1].to_string();
                }
            }
            IFCONFIG_INET.captures(line).map(|c| (iface.clone(), c[1].parse().ok(), mask_to_prefix(&c[2])))
        };
        if let Some((name, Some(addr), Some(prefix))) = found {
            let addr: Ipv4Addr = addr;
            if prefix > 32 || addr.is_loopback() || addr.is_link_local() || !is_scannable(addr) || is_virtual_iface(&name) {
                continue;
            }
            out.insert(Network { iface: name, addr, prefix });
        }
    }
    out.into_iter().collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Neighbour {
    pub ip: Ipv4Addr,
    pub mac: Option<String>,
}

static NEIGH_ARP: Lazy<Regex> = Lazy::new(|| Regex::new(r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-fA-F:]{11,17}|\(incomplete\)|<incomplete>)").unwrap());
static NEIGH_PS: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d+\.\d+\.\d+\.\d+)\s+([0-9A-Fa-f]{2}(?:[-:][0-9A-Fa-f]{2}){5})\s*$").unwrap());

fn normalise_mac(mac: &str) -> Option<String> {
    let parts: Vec<String> = mac.split([':', '-']).map(|p| format!("{:0>2}", p.to_ascii_lowercase())).collect();
    if parts.len() != 6 || parts.iter().all(|p| p == "00") || parts.iter().all(|p| p == "ff") {
        return None;
    }
    Some(parts.join(":"))
}

/// 鄰居（ARP）表：`ip neigh`（略過 FAILED / INCOMPLETE）、`arp -an`、我們的 PowerShell 輸出（`ip mac`）。
/// The neighbour (ARP) table from `ip neigh`, `arp -an` or our PowerShell output.
pub fn parse_neighbours(output: &str) -> Vec<Neighbour> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for line in output.lines() {
        let line = line.trim();
        let entry = if let Some(c) = NEIGH_ARP.captures(line) {
            c[1].parse().ok().map(|ip| (ip, normalise_mac(&c[2]), !c[2].contains("incomplete")))
        } else if let Some(c) = NEIGH_PS.captures(line) {
            c[1].parse().ok().map(|ip| (ip, normalise_mac(&c[2]), true))
        } else if let Some(ip) = line.split_whitespace().next().and_then(|t| t.parse::<Ipv4Addr>().ok()) {
            // `ip neigh`：`IP dev IFACE [lladdr MAC] [router] STATE`
            let tokens: Vec<&str> = line.split_whitespace().collect();
            let mac = tokens.iter().position(|t| *t == "lladdr").and_then(|i| tokens.get(i + 1)).and_then(|m| normalise_mac(m));
            let state = tokens.last().map(|t| t.to_ascii_uppercase()).unwrap_or_default();
            Some((ip, mac.clone(), mac.is_some() && !matches!(state.as_str(), "FAILED" | "INCOMPLETE")))
        } else {
            None
        };
        if let Some((ip, mac, alive)) = entry {
            let ip: Ipv4Addr = ip;
            if alive && mac.is_some() && is_scannable(ip) && seen.insert(ip) {
                out.push(Neighbour { ip, mac });
            }
        }
    }
    out
}

/// `getent hosts ip…` 的輸出 → (ip, 名稱)。/ Names from `getent hosts` output.
pub fn parse_getent(output: &str) -> Vec<(Ipv4Addr, String)> {
    output
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let ip = it.next()?.parse().ok()?;
            let name = it.next()?.trim_end_matches('.').to_string();
            Some((ip, name))
        })
        .collect()
}

/// `avahi-resolve -a ip…` 的輸出（`ip<TAB>name.local`）→ (ip, 名稱)。/ Names from `avahi-resolve -a` (mDNS).
pub fn parse_avahi(output: &str) -> Vec<(Ipv4Addr, String)> {
    output
        .lines()
        .filter_map(|l| {
            let (ip, rest) = l.trim().split_once(char::is_whitespace)?;
            let ip: Ipv4Addr = ip.parse().ok()?;
            let name = rest.trim().trim_end_matches('.').to_string();
            (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))).then_some((ip, name))
        })
        .collect()
}

/// `for ip; do echo "@@ $ip"; nmblookup -A $ip; done` 的輸出 → (ip, NetBIOS 名稱)：每段第一個 `<00>` 的唯一名稱
/// （不是 `<GROUP>`，那是工作群組）。/ NetBIOS names: the first unique `<00>` name of each section.
pub fn parse_nmblookup(output: &str) -> Vec<(Ipv4Addr, String)> {
    let mut out = Vec::new();
    let mut current: Option<Ipv4Addr> = None;
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("@@ ") {
            current = rest.trim().parse().ok();
            continue;
        }
        let Some(ip) = current else { continue };
        if line.contains("<GROUP>") {
            continue;
        }
        if let Some(i) = line.find("<00>") {
            let name = line[..i].trim();
            if !name.is_empty() && name.len() <= 15 && !name.contains(char::is_whitespace) {
                out.push((ip, name.to_string()));
                current = None;
            }
        }
    }
    out
}

/// SSH banner 的第一行（`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13`）。/ First line of an SSH banner.
pub fn parse_ssh_banner(bytes: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(bytes);
    let first = line.lines().next()?.trim();
    first.starts_with("SSH-").then(|| first.chars().take(200).collect())
}

/// 依偵測到的網段算出要掃的位址（每個網段先縮到最多 /22 的大小、整體上限 MAX_ADDRESSES，不含裝置自己）。
/// The addresses to probe for the detected (or given) networks, without the device's own addresses.
pub fn targets(networks: &[Network], own: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    let mut out = BTreeSet::new();
    for n in networks {
        for ip in n.hosts() {
            if out.len() >= MAX_ADDRESSES {
                break;
            }
            if !own.contains(&ip) && is_scannable(ip) {
                out.insert(ip);
            }
        }
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avahi_and_netbios_names() {
        let avahi = "192.168.1.5\tprinter.local\n192.168.1.6\tbad name;rm\nFailed to resolve address '192.168.1.7': Timeout reached\n";
        assert_eq!(parse_avahi(avahi), vec![("192.168.1.5".parse().unwrap(), "printer.local".to_string())]);
        let nmb = "@@ 192.168.1.20\nLooking up status of 192.168.1.20\n\tWORKGROUP       <00> - <GROUP> B <ACTIVE> \n\tDESKTOP-ABC     <00> -         B <ACTIVE> \n\tDESKTOP-ABC     <20> -         B <ACTIVE> \n@@ 192.168.1.21\nNo reply from 192.168.1.21\n";
        assert_eq!(parse_nmblookup(nmb), vec![("192.168.1.20".parse().unwrap(), "DESKTOP-ABC".to_string())]);
    }

    #[test]
    fn networks_from_ip_addr() {
        let out = "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever\n\
                   2: eth0    inet 192.168.1.23/24 brd 192.168.1.255 scope global dynamic noprefixroute eth0\\       valid_lft 85613sec\n\
                   3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\n\
                   4: wlan0    inet 10.0.0.5/8 scope global wlan0\n\
                   5: tun0    inet 203.0.113.9/32 scope global tun0\n";
        let n = parse_networks(out);
        assert_eq!(n.iter().map(|x| (x.iface.as_str(), x.cidr())).collect::<Vec<_>>(), vec![("eth0", "192.168.1.0/24".to_string()), ("wlan0", "10.0.0.0/8".to_string())]);
        assert_eq!(n[1].narrowed().cidr(), "10.0.0.0/24", "an oversized network shrinks to the /24 around the device");
    }

    #[test]
    fn networks_from_ifconfig_and_powershell() {
        let mac = "lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n\tinet 127.0.0.1 netmask 0xff000000\n\
                   en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tether 3c:22:fb:00:11:22\n\tinet 192.168.50.7 netmask 0xffffff00 broadcast 192.168.50.255\n\
                   utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380\n\tinet 100.101.1.2 --> 100.101.1.2 netmask 0xffffffff\n";
        assert_eq!(parse_networks(mac).iter().map(|x| x.cidr()).collect::<Vec<_>>(), vec!["192.168.50.0/24"]);
        let old = "eth0      Link encap:Ethernet  HWaddr 00:11:22:33:44:55\n          inet addr:10.1.2.3  Bcast:10.1.2.255  Mask:255.255.254.0\n";
        assert_eq!(parse_networks(old)[0].cidr(), "10.1.2.0/23");
        let ps = "Ethernet|192.168.0.15/24\r\nLoopback Pseudo-Interface 1|127.0.0.1/8\r\nvEthernet (WSL)|172.20.48.1/20\r\n";
        assert_eq!(parse_networks(ps).iter().map(|x| (x.iface.as_str(), x.cidr())).collect::<Vec<_>>(), vec![("Ethernet", "192.168.0.0/24".to_string())]);
    }

    #[test]
    fn neighbours_from_all_formats() {
        let ip = "192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:01 REACHABLE\n192.168.1.20 dev eth0 lladdr aa:bb:cc:dd:ee:14 STALE\n192.168.1.30 dev eth0  FAILED\n192.168.1.31 dev eth0  INCOMPLETE\n";
        assert_eq!(parse_neighbours(ip).iter().map(|n| n.ip.to_string()).collect::<Vec<_>>(), vec!["192.168.1.1", "192.168.1.20"]);
        assert_eq!(parse_neighbours(ip)[0].mac.as_deref(), Some("aa:bb:cc:dd:ee:01"));
        let arp = "? (192.168.50.1) at 0:11:22:33:44:5 on en0 ifscope [ethernet]\n? (192.168.50.9) at (incomplete) on en0 ifscope [ethernet]\n? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]\n";
        let n = parse_neighbours(arp);
        assert_eq!(n.len(), 1, "{n:?}");
        assert_eq!(n[0].mac.as_deref(), Some("00:11:22:33:44:05"));
        let ps = "192.168.0.1 AA-BB-CC-00-11-22\r\n192.168.0.255 FF-FF-FF-FF-FF-FF\r\n192.168.0.7 00-00-00-00-00-00\r\n";
        assert_eq!(parse_neighbours(ps).iter().map(|n| n.ip.to_string()).collect::<Vec<_>>(), vec!["192.168.0.1"]);
    }

    #[test]
    fn cidr_rules_and_targets() {
        assert_eq!(parse_cidr("192.168.1.0/24").unwrap().hosts().len(), 254);
        assert_eq!(parse_cidr("10.0.0.7").unwrap().hosts(), vec![Ipv4Addr::new(10, 0, 0, 7)]);
        assert_eq!(parse_cidr("127.0.0.1/32").unwrap().cidr(), "127.0.0.1/32");
        assert!(parse_cidr("10.0.0.0/16").unwrap_err().contains("too large"));
        assert!(parse_cidr("8.8.8.0/24").unwrap_err().contains("not a private"));
        assert!(parse_cidr("100.64.0.0/24").is_ok(), "CGNAT (Tailscale) is allowed");
        assert!(parse_cidr("nope").is_err());
        let n = parse_cidr("192.168.1.0/30").unwrap();
        assert_eq!(targets(&[n], &[Ipv4Addr::new(192, 168, 1, 1)]), vec![Ipv4Addr::new(192, 168, 1, 2)]);
        assert_eq!(parse_ports(&[443, 22, 22]).unwrap(), vec![22, 443]);
        assert!(parse_ports(&[0]).is_err());
        assert!(parse_ports(&[]).is_err());
    }

    #[test]
    fn names_and_banners() {
        assert_eq!(parse_getent("192.168.1.20    nas.lan nas\n192.168.1.1 router.\n"), vec![(Ipv4Addr::new(192, 168, 1, 20), "nas.lan".into()), (Ipv4Addr::new(192, 168, 1, 1), "router".into())]);
        assert_eq!(parse_ssh_banner(b"SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n").as_deref(), Some("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13"));
        assert_eq!(parse_ssh_banner(b"HTTP/1.1 400 Bad Request\r\n"), None);
    }
}
