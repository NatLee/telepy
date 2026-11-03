//! 裝置自己（純函式）：它在聽哪些 port（`ss` / `netstat` / `lsof` / PowerShell 的輸出）、預設閘道是誰（`ip route` /
//! `route -n get default` / `netstat -rn` / PowerShell），以及兩次掃描之間變了什麼（新出現、不見了、port 開關）。執行在
//! `scan.rs`，這裡只解析與比較。
//! The device itself (pure): which ports it listens on (from `ss` / `netstat` / `lsof` / PowerShell), its default
//! gateway (from `ip route` / `route -n get default` / `netstat -rn` / PowerShell), and what changed between two scans
//! (new hosts, gone ones, ports opened / closed). `scan.rs` runs the commands; this file parses and compares.

use std::collections::{BTreeMap, BTreeSet};
use std::net::Ipv4Addr;

use serde::Serialize;

/// 裝置上列出正在聽的 TCP port：依序試 `ss`、Linux 的 `netstat -ltn`、macOS / BSD 的 `netstat -an -p tcp`、`lsof`，用第一個
/// 真的列出 LISTEN 的。不能用 `||` 串：macOS 的 `netstat -ltn` 成功結束卻只列連線、沒有 LISTEN。包在 `sh -c` 裡，登入 shell
/// 是 fish 也能跑。
/// Lists the device's listening TCP ports: tries `ss`, Linux `netstat -ltn`, macOS / BSD `netstat -an -p tcp` and
/// `lsof` in turn and keeps the first that really lists LISTEN. Not a `||` chain: macOS' `netstat -ltn` exits 0 with
/// connections only. Wrapped in `sh -c` so a fish login shell runs it too.
pub const LISTEN_POSIX: &str = "sh -c 'for c in \"ss -ltnH\" \"netstat -ltn\" \"netstat -an -p tcp\" \"lsof -nP -iTCP -sTCP:LISTEN\"; do o=$($c 2>/dev/null) || continue; case \"$o\" in *LISTEN*) printf \"%s\\n\" \"$o\"; exit 0;; esac; done'";
pub const LISTEN_WINDOWS: &str = "powershell -NoProfile -NonInteractive -Command \"Get-NetTCPConnection -State Listen | ForEach-Object { 'LISTEN|' + $_.LocalAddress + '|' + $_.LocalPort }\"";
/// 預設閘道：三個工具都問（沒有的就沒輸出），解析取第一個。`ip route` 沒有預設路由時是空的，不擋後面的。
/// The default gateway: all three tools are asked (missing ones print nothing) and the first answer parsed wins.
pub const GATEWAY_POSIX: &str = "ip -4 route show default 2>/dev/null; route -n get default 2>/dev/null; netstat -rn 2>/dev/null";
pub const GATEWAY_WINDOWS: &str = "powershell -NoProfile -NonInteractive -Command \"Get-NetRoute -DestinationPrefix 0.0.0.0/0 | ForEach-Object { 'GATEWAY|' + $_.NextHop }\"";
/// 裝置自己的服務最多記幾個 port。/ At most this many of the device's own ports are kept.
pub const MAX_OWN_PORTS: usize = 64;

/// `位址:port` 的最後一段 port（`*:22`、`[::]:22`、`0.0.0.0:22`、macOS 的 `*.22`、`127.0.0.1.631`）。
/// Splits `address:port` (also macOS' `address.port`) into (address, port).
fn split_endpoint(s: &str) -> Option<(String, u16)> {
    let s = s.trim();
    let cut = s.rfind([':', '.'])?;
    let port: u16 = s[cut + 1..].parse().ok()?;
    let addr = s[..cut].trim_start_matches('[').trim_end_matches(']').to_string();
    Some((if addr.is_empty() { "*".into() } else { addr }, port))
}

/// 正在聽的 (位址, port)。認得 `ss -ltnH`、`netstat -ltn`、`netstat -an -p tcp`（macOS）、`lsof`，以及 PowerShell 的
/// `LISTEN|位址|port`。看不懂的行略過。
/// Listening (address, port) pairs from `ss -ltnH`, `netstat -ltn`, macOS `netstat -an -p tcp`, `lsof` and the
/// PowerShell `LISTEN|address|port` lines; unknown lines are skipped.
pub fn parse_listening(text: &str) -> Vec<(String, u16)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("LISTEN|") {
            let mut parts = rest.split('|');
            if let (Some(a), Some(p)) = (parts.next(), parts.next().and_then(|p| p.trim().parse().ok())) {
                out.push((a.trim().to_string(), p));
            }
            continue;
        }
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }
        // ss -ltnH：LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*
        if words[0] == "LISTEN" && words.len() >= 4 {
            if let Some(e) = split_endpoint(words[3]) {
                out.push(e);
            }
            continue;
        }
        // netstat（Linux / macOS）：tcp[46] … 本機位址 遠端位址 LISTEN / netstat (Linux / macOS): local address is the 4th word.
        if words[0].starts_with("tcp") && words.last() == Some(&"LISTEN") && words.len() >= 6 {
            if let Some(e) = split_endpoint(words[3]) {
                out.push(e);
            }
            continue;
        }
        // lsof：… TCP *:22 (LISTEN)
        if line.ends_with("(LISTEN)") {
            if let Some(i) = words.iter().position(|w| *w == "TCP") {
                if let Some(e) = words.get(i + 1).and_then(|w| split_endpoint(w)) {
                    out.push(e);
                }
            }
        }
    }
    out
}

/// 從裝置自己連得到的 port（聽在所有位址或 loopback 上的），排好、去重、最多 [`MAX_OWN_PORTS`] 個。
/// The ports reachable from the device itself (bound to every address or to loopback), sorted, unique, capped.
pub fn local_ports(listening: &[(String, u16)]) -> Vec<u16> {
    let reachable = |a: &str| matches!(a, "*" | "0.0.0.0" | "::" | "::1" | "localhost") || a.starts_with("127.") || a.starts_with("::ffff:127.");
    let set: BTreeSet<u16> = listening.iter().filter(|(a, p)| *p > 0 && reachable(a)).map(|(_, p)| *p).collect();
    set.into_iter().take(MAX_OWN_PORTS).collect()
}

/// 預設閘道（IPv4）。認得 `ip route` 的 `default via X`、macOS 的 `gateway: X`、`netstat -rn` 的 `default X` /
/// `0.0.0.0 X`，以及 PowerShell 的 `GATEWAY|X`（0.0.0.0 = 沒有）。
/// The default IPv4 gateway from `ip route` (`default via X`), macOS (`gateway: X`), `netstat -rn` (`default X` /
/// `0.0.0.0 X`) or the PowerShell `GATEWAY|X` lines (0.0.0.0 = none).
pub fn parse_gateway(text: &str) -> Option<Ipv4Addr> {
    let ip = |s: &str| s.trim().parse::<Ipv4Addr>().ok().filter(|a| !a.is_unspecified());
    for line in text.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        let found = if let Some(rest) = line.trim().strip_prefix("GATEWAY|") {
            ip(rest)
        } else if let Some(i) = words.iter().position(|w| *w == "via") {
            words.get(i + 1).and_then(|w| ip(w))
        } else if words.first() == Some(&"gateway:") {
            words.get(1).and_then(|w| ip(w))
        } else if matches!(words.first(), Some(&"default") | Some(&"0.0.0.0")) {
            words.get(1).and_then(|w| ip(w))
        } else {
            None
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// 兩次掃描之間變了什麼。/ What changed between two scans.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Changes {
    /// 這次第一次看到的位址。/ Addresses seen for the first time.
    pub new: Vec<String>,
    /// 上次在、這次（同一批網段裡）沒看到的。/ Seen before, missing this time (within the scanned networks).
    pub gone: Vec<String>,
    /// port 有開有關的。/ Hosts whose open ports changed.
    pub changed: Vec<PortChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PortChange {
    pub address: String,
    pub opened: Vec<u16>,
    pub closed: Vec<u16>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.new.is_empty() && self.gone.is_empty() && self.changed.is_empty()
    }
}

/// 比較掃描前（位址 → 上次的 port，只含掃描找到的、在這次網段裡的）與這次看到的（位址 → port）。只比這次也探過的
/// port：使用者這次少給幾個 port，不算「關了」。
/// Compare before (address → last ports; scan-found hosts within this scan's networks only) with what this scan saw.
/// Only ports probed this time are compared, so a shorter port list is not "closed".
pub fn changes(before: &BTreeMap<String, Vec<u16>>, after: &BTreeMap<String, Vec<u16>>, probed: &[u16]) -> Changes {
    let mut c = Changes::default();
    for (addr, ports) in after {
        match before.get(addr) {
            None => c.new.push(addr.clone()),
            Some(old) => {
                let old: BTreeSet<u16> = old.iter().copied().filter(|p| probed.contains(p)).collect();
                let now: BTreeSet<u16> = ports.iter().copied().filter(|p| probed.contains(p)).collect();
                let opened: Vec<u16> = now.difference(&old).copied().collect();
                let closed: Vec<u16> = old.difference(&now).copied().collect();
                if !opened.is_empty() || !closed.is_empty() {
                    c.changed.push(PortChange { address: addr.clone(), opened, closed });
                }
            }
        }
    }
    c.gone = before.keys().filter(|a| !after.contains_key(*a)).cloned().collect();
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listening_ports_from_every_tool() {
        let ss = "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\nLISTEN 0 4096 [::]:22 [::]:*\nLISTEN 0 128 192.168.1.5:8080 0.0.0.0:*\n";
        let l = parse_listening(ss);
        assert_eq!(l.len(), 4);
        assert_eq!(local_ports(&l), [22, 3000], "a port bound to the LAN address only is not on localhost");
        let netstat = "Active Internet connections\nProto Recv-Q Send-Q Local Address Foreign Address State\ntcp        0      0 0.0.0.0:5000            0.0.0.0:*               LISTEN\ntcp6       0      0 :::80                   :::*                    LISTEN\n";
        assert_eq!(local_ports(&parse_listening(netstat)), [80, 5000]);
        let mac = "tcp4       0      0  127.0.0.1.631          *.*                    LISTEN     \ntcp46      0      0  *.5000                 *.*                    LISTEN     \ntcp4       0      0  10.0.0.2.52000         1.2.3.4.443            ESTABLISHED\n";
        assert_eq!(local_ports(&parse_listening(mac)), [631, 5000]);
        let lsof = "COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nsshd     812 root    3u  IPv4  1234      0t0  TCP *:22 (LISTEN)\nnode    1010 pi     21u  IPv6  5678      0t0  TCP [::1]:5173 (LISTEN)\n";
        assert_eq!(local_ports(&parse_listening(lsof)), [22, 5173]);
        let ps = "LISTEN|0.0.0.0|3389\nLISTEN|::|445\nLISTEN|127.0.0.1|5939\n";
        assert_eq!(local_ports(&parse_listening(ps)), [445, 3389, 5939]);
    }

    /// 在這台機器上真的跑一次（Linux 的 `ss`、macOS 的 `netstat -an -p tcp`）：剛開的 port 要列得出來。
    /// Run for real on this machine (Linux `ss`, macOS `netstat -an -p tcp`): a port just opened must be listed.
    #[cfg(unix)]
    #[test]
    fn the_listing_command_finds_a_real_listener() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(LISTEN_POSIX).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(local_ports(&parse_listening(&text)).contains(&port) || parse_listening(&text).len() >= MAX_OWN_PORTS, "port {port} not in:\n{text}");
    }

    #[test]
    fn gateways_from_every_tool() {
        assert_eq!(parse_gateway("default via 192.168.1.1 dev eth0 proto dhcp metric 100\n"), Some(Ipv4Addr::new(192, 168, 1, 1)));
        assert_eq!(parse_gateway("   route to: default\ndestination: default\n       mask: default\n    gateway: 10.0.0.1\n  interface: en0\n"), Some(Ipv4Addr::new(10, 0, 0, 1)));
        assert_eq!(parse_gateway("Kernel IP routing table\nDestination Gateway Genmask\n0.0.0.0 172.16.0.254 0.0.0.0 UG 0 0 0 eth0\n"), Some(Ipv4Addr::new(172, 16, 0, 254)));
        assert_eq!(parse_gateway("Routing tables\ndefault            192.168.50.1       UGScg                 en0\n"), Some(Ipv4Addr::new(192, 168, 50, 1)));
        assert_eq!(parse_gateway("GATEWAY|0.0.0.0\nGATEWAY|192.168.0.1\n"), Some(Ipv4Addr::new(192, 168, 0, 1)));
        assert_eq!(parse_gateway("nothing here"), None);
    }

    #[test]
    fn what_changed_between_scans() {
        let before: BTreeMap<String, Vec<u16>> = [("10.0.0.2".to_string(), vec![22, 80]), ("10.0.0.3".to_string(), vec![445]), ("10.0.0.4".to_string(), vec![22, 9999])].into();
        let after: BTreeMap<String, Vec<u16>> = [("10.0.0.2".to_string(), vec![22, 443]), ("10.0.0.4".to_string(), vec![22]), ("10.0.0.9".to_string(), vec![80])].into();
        let c = changes(&before, &after, &[22, 80, 443, 445]);
        assert_eq!(c.new, ["10.0.0.9"]);
        assert_eq!(c.gone, ["10.0.0.3"]);
        assert_eq!(c.changed, [PortChange { address: "10.0.0.2".into(), opened: vec![443], closed: vec![80] }], "9999 was not probed this time, so it isn't 'closed'");
        assert!(changes(&after, &after, &[22]).is_empty());
    }
}
