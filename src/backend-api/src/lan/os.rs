//! 一台區網主機跑的是什麼作業系統（使用者對那台按了才做，掃描從來不做）。全是純函式；I/O 在 `lan::os_probe`。
//! 線索、由弱到強：
//! - **TTL**：裝置 ping 一次，回覆的 TTL 從 64（Linux / macOS / 多數 Unix）、128（Windows）或 255（網路設備）往下數。
//! - **上次掃描的 HTTP `Server` 標頭**（`Microsoft-IIS/10.0`、`Apache/2.4.58 (Ubuntu)`）與 MAC 廠商（Apple、Raspberry Pi）。
//! - **SSH 問候**：發行版會把套件版本寫在裡面（`OpenSSH_8.9p1 Ubuntu-3ubuntu0.10` = Ubuntu 22.04）。
//! - **SMB 的 NTLM 資訊**：SMB2 協商 + 一次只送 NTLM NEGOTIATE 的 SESSION_SETUP，Windows 回的 CHALLENGE 裡有版本與
//!   組建號、電腦名稱、網域（nmap 的 `smb-os-discovery` 也是這樣）；不會登入，到這裡就關掉。組建號 0 = Samba。
//! - **nmap**：裝置上有 nmap、而且是 root 或能 `sudo -n` 時，對那一台跑 `nmap -O`。
//!
//! What OS a LAN host runs — only when someone asks for that one host, never during a scan. Pure; I/O lives in
//! `lan::os_probe`. Clues, weakest first: the ping TTL, the last scan's HTTP `Server` headers and MAC vendor, the SSH
//! greeting's distribution tag, the NTLM info a Windows SMB server sends before any login, and `nmap -O` when the
//! device has nmap and root.

use serde::{Deserialize, Serialize};

use super::fingerprint::Service;

/// 裝置那段指令的每行開頭（e2e 環境的 shell.sh 也靠它攔下來）。/ The marker on every line of the device script.
pub const MARK: &str = "TELEPY_OSFP";

/// 一條線索。`weight` = 有多可靠（0 = 只是說明，不算分）。/ One clue; `weight` = how much it counts (0 = a note).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    /// `ttl` / `http` / `vendor` / `ssh` / `smb` / `nmap`
    pub source: String,
    pub text: String,
    /// `windows` / `linux` / `macos` / `bsd` / `network` / `unix`（= Linux、macOS 或其他 Unix）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub weight: u8,
    /// 組句子用的原始值（網頁用使用者的語言說；`text` 是英文版，CLI 印它）。/ Raw values for a localized sentence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

fn ev(source: &str, text: impl Into<String>, family: Option<&str>, name: Option<String>, weight: u8) -> Evidence {
    Evidence { source: source.into(), text: text.into(), family: family.map(str::to_string), name, weight, data: None }
}

impl Evidence {
    fn with(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }
}

/// 結果（存在主機那一列，網頁 / CLI / MCP 看到的也是它）。/ The result, stored on the host row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OsCheck {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `high` / `medium` / `low` / `none`
    pub confidence: String,
    pub evidence: Vec<Evidence>,
    /// 其他也有線索支持的系列（線索互相矛盾時）。/ Other families some clue points to.
    #[serde(default)]
    pub conflict: Vec<String>,
    /// nmap：`ran` / `absent`（裝置上沒有）/ `unprivileged`（不是 root、也不能 sudo）/ `windows`（Windows 裝置不跑）
    pub nmap: String,
    /// DB 時間。/ DB time.
    pub at: String,
    pub by: String,
}

// ---------------------------------------------------------------- the device script

/// 只接受數字與點（IPv4）跟數字的 port：會放進裝置的 shell。/ Only IPv4 digits / dots and port numbers go into the shell.
fn safe_ip(ip: &str) -> bool {
    !ip.is_empty() && ip.len() <= 15 && ip.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// POSIX 裝置上跑的那一段：ping 一次讀 TTL，有 nmap 而且是 root / 能 `sudo -n` 就 `nmap -O` 那一台。
/// The POSIX device script: one ping for the TTL, and `nmap -O` of that host when nmap is there with root / `sudo -n`.
pub fn posix_command(ip: &str, ports: &[u16]) -> Option<String> {
    if !safe_ip(ip) {
        return None;
    }
    let ports: Vec<String> = ports.iter().take(16).map(u16::to_string).collect();
    let nmap_ports = if ports.is_empty() { "--top-ports 20".to_string() } else { format!("-p {}", ports.join(",")) };
    // macOS 的 `-W` 是毫秒，所以再試 `-t`（秒），最後什麼都不帶。/ macOS reads `-W` as milliseconds, hence `-t`, then nothing.
    Some(format!(
        "sh -c 'h={ip}; echo \"{MARK}|start|\"; \
t=$( {{ ping -c 1 -W 2 \"$h\" 2>/dev/null || ping -c 1 -t 2 \"$h\" 2>/dev/null || ping -c 1 \"$h\" 2>/dev/null; }} | grep -io \"ttl[=:] *[0-9]*\" | head -n 1 | tr -dc 0-9); \
echo \"{MARK}|ttl|$t\"; \
if command -v nmap >/dev/null 2>&1; then \
if [ \"$(id -u)\" = 0 ]; then n=nmap; elif sudo -n true >/dev/null 2>&1; then n=\"sudo -n nmap\"; else n=; fi; \
if [ -n \"$n\" ]; then $n -O -Pn --osscan-guess --max-os-tries 1 --host-timeout 40s {nmap_ports} \"$h\" 2>/dev/null | grep -E \"^(Running|OS details|Aggressive OS guesses|Device type)\" | sed \"s/^/{MARK}|nmap|/\"; echo \"{MARK}|nmapran|\"; \
else echo \"{MARK}|nmapstate|unprivileged\"; fi; \
else echo \"{MARK}|nmapstate|absent\"; fi'"
    ))
}

/// Windows 裝置：cmd.exe 的 ping 一次（nmap 不跑）。/ A Windows device: one cmd.exe ping (no nmap).
pub fn windows_command(ip: &str) -> Option<String> {
    safe_ip(ip).then(|| format!("ping -n 1 -w 1500 {ip}"))
}

/// 裝置回來的東西。/ What the device answered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceAnswer {
    /// 有沒有跑到 POSIX 那一段（沒有 = 改跑 Windows 的）。/ Whether the POSIX script ran.
    pub posix: bool,
    pub ttl: Option<u8>,
    /// `ran` / `absent` / `unprivileged`
    pub nmap: String,
    pub nmap_lines: Vec<String>,
}

pub fn parse_posix(out: &str) -> DeviceAnswer {
    let mut a = DeviceAnswer { nmap: "absent".into(), ..Default::default() };
    for line in out.lines() {
        let mut parts = line.trim_end_matches('\r').splitn(3, '|');
        if parts.next() != Some(MARK) {
            continue;
        }
        let (kind, value) = (parts.next().unwrap_or(""), parts.next().unwrap_or("").trim());
        match kind {
            "start" => a.posix = true,
            "ttl" => a.ttl = value.parse().ok(),
            "nmap" if !value.is_empty() => a.nmap_lines.push(value.to_string()),
            "nmapran" => a.nmap = "ran".into(),
            "nmapstate" => a.nmap = value.to_string(),
            _ => {}
        }
    }
    a
}

/// cmd.exe 的 `Reply from …: bytes=32 time<1ms TTL=128`（語系不同也有 `TTL=`）。/ The TTL from Windows ping output.
pub fn parse_windows_ping(out: &str) -> Option<u8> {
    let up = out.to_ascii_uppercase();
    let at = up.find("TTL=")? + 4;
    up[at..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
}

// ---------------------------------------------------------------- clues

/// TTL → 起始值與系列。/ A TTL → its starting value and family.
pub fn ttl_evidence(ttl: u8) -> Evidence {
    let (start, family, what) = if ttl <= 64 {
        (64u16, "unix", "Linux, macOS, BSD and most devices")
    } else if ttl <= 128 {
        (128, "windows", "Windows")
    } else {
        (255, "network", "network equipment (routers, switches) or Solaris")
    };
    let hops = start - u16::from(ttl);
    ev("ttl", format!("ping TTL {ttl}: starts at {start} ({what}), {hops} hop(s) away"), Some(family), None, 1).with(serde_json::json!({ "ttl": ttl, "start": start, "hops": hops }))
}

const UBUNTU: &[(&str, &str)] = &[
    ("10.0p1", "Ubuntu 25.10"),
    ("9.9p1", "Ubuntu 25.04"),
    ("9.7p1", "Ubuntu 24.10"),
    ("9.6p1", "Ubuntu 24.04 LTS"),
    ("9.3p1", "Ubuntu 23.10"),
    ("8.9p1", "Ubuntu 22.04 LTS"),
    ("8.4p1", "Ubuntu 21.04"),
    ("8.2p1", "Ubuntu 20.04 LTS"),
    ("7.6p1", "Ubuntu 18.04 LTS"),
    ("7.2p2", "Ubuntu 16.04 LTS"),
];

const DEBIAN: &[(&str, &str)] = &[("10.0p1", "13"), ("9.2p1", "12"), ("8.4p1", "11"), ("7.9p1", "10"), ("7.4p1", "9")];

/// `OpenSSH_8.9p1` → `8.9p1`
fn openssh_version(banner: &str) -> Option<&str> {
    let at = banner.find("OpenSSH_")? + 8;
    banner[at..].split(|c: char| c.is_whitespace() || c == '-').next().filter(|v| !v.is_empty())
}

/// SSH 問候 → 線索（發行版、版本）。沒有發行版字樣的 OpenSSH 只當說明。/ An SSH greeting → a clue.
pub fn ssh_evidence(banner: &str) -> Option<Evidence> {
    let line = banner.trim().trim_start_matches("SSH-2.0-").trim_start_matches("SSH-1.99-");
    if line.is_empty() {
        return None;
    }
    ssh_clue(line).map(|e| {
        let tagged = e.weight > 0;
        e.with(serde_json::json!({ "line": line, "tagged": tagged }))
    })
}

fn ssh_clue(line: &str) -> Option<Evidence> {
    let lower = line.to_ascii_lowercase();
    let text = format!("SSH greeting: {line}");
    if let Some(v) = lower.strip_prefix("openssh_for_windows_") {
        let v = v.split_whitespace().next().unwrap_or("");
        return Some(ev("ssh", text, Some("windows"), Some(format!("Windows (OpenSSH for Windows {v})")), 4));
    }
    if lower.contains("ubuntu") {
        let name = openssh_version(line).and_then(|v| UBUNTU.iter().find(|(o, _)| *o == v)).map(|(_, n)| n.to_string()).unwrap_or_else(|| "Ubuntu".into());
        return Some(ev("ssh", text, Some("linux"), Some(name), 4));
    }
    if lower.contains("debian") || lower.contains("raspbian") {
        let base = if lower.contains("raspbian") { "Raspberry Pi OS" } else { "Debian" };
        // `+deb12u7` 直接寫著；沒有就照 OpenSSH 版本。/ `+deb12u7` says it; else by the OpenSSH version.
        let release = lower
            .find("+deb")
            .map(|i| lower[i + 4..].chars().take_while(char::is_ascii_digit).collect::<String>())
            .filter(|n| !n.is_empty())
            .or_else(|| openssh_version(line).and_then(|v| DEBIAN.iter().find(|(o, _)| *o == v)).map(|(_, n)| n.to_string()));
        let name = match release {
            Some(r) if base == "Debian" => format!("Debian {r}"),
            Some(r) => format!("{base} (Debian {r})"),
            None => base.to_string(),
        };
        return Some(ev("ssh", text, Some("linux"), Some(name), 4));
    }
    for (word, family, name) in [("freebsd", "bsd", "FreeBSD"), ("openbsd", "bsd", "OpenBSD"), ("netbsd", "bsd", "NetBSD")] {
        if lower.contains(word) {
            return Some(ev("ssh", text, Some(family), Some(name.into()), 4));
        }
    }
    if lower.starts_with("dropbear") {
        return Some(ev("ssh", text, Some("linux"), Some("embedded Linux (Dropbear SSH)".into()), 2));
    }
    if lower.starts_with("rosssh") {
        return Some(ev("ssh", text, Some("network"), Some("MikroTik RouterOS".into()), 4));
    }
    if lower.starts_with("cisco") {
        return Some(ev("ssh", text, Some("network"), Some("Cisco".into()), 4));
    }
    // 沒寫發行版：macOS、Arch、Fedora、Alpine… 都這樣。/ No distribution tag: macOS, Arch, Fedora, Alpine… all send none.
    Some(ev("ssh", format!("{text} (no distribution tag)"), None, None, 0))
}

/// 上次掃描看到的 HTTP `Server` 標頭 → 線索。/ The last scan's HTTP `Server` headers → clues.
pub fn http_evidence(services: &[Service]) -> Vec<Evidence> {
    let mut out: Vec<Evidence> = Vec::new();
    for s in services {
        let Some(server) = s.server.as_deref() else { continue };
        let lower = server.to_ascii_lowercase();
        let text = format!("HTTP Server on port {}: {server}", s.port);
        let hit = if let Some(v) = lower.strip_prefix("microsoft-iis/") {
            let name = match v.split_whitespace().next().unwrap_or("") {
                "10.0" => "Windows Server 2016 or later",
                "8.5" => "Windows Server 2012 R2",
                "8.0" => "Windows Server 2012",
                "7.5" => "Windows Server 2008 R2",
                _ => "Windows Server",
            };
            Some(("windows", name.to_string(), 3))
        } else {
            [
                ("(ubuntu)", "linux", "Ubuntu"),
                ("(debian)", "linux", "Debian"),
                ("(raspbian)", "linux", "Raspberry Pi OS"),
                ("(centos", "linux", "CentOS"),
                ("(red hat", "linux", "Red Hat Enterprise Linux"),
                ("(rocky", "linux", "Rocky Linux"),
                ("(almalinux", "linux", "AlmaLinux"),
                ("(fedora)", "linux", "Fedora"),
                ("(freebsd)", "bsd", "FreeBSD"),
                ("(win64)", "windows", "Windows"),
                ("(win32)", "windows", "Windows"),
            ]
            .iter()
            .find(|(w, _, _)| lower.contains(w))
            .map(|(_, f, n)| (*f, n.to_string(), 2))
        };
        if let Some((family, name, weight)) = hit {
            if !out.iter().any(|e| e.name.as_deref() == Some(name.as_str())) {
                out.push(ev("http", text, Some(family), Some(name), weight).with(serde_json::json!({ "port": s.port, "server": server })));
            }
        }
    }
    out
}

/// MAC 廠商 → 線索（只有說得出系統的那幾家）。/ The MAC vendor → a clue (only vendors that tell the OS).
pub fn vendor_evidence(vendor: &str) -> Option<Evidence> {
    let lower = vendor.to_ascii_lowercase();
    let data = serde_json::json!({ "vendor": vendor });
    if lower.contains("raspberry pi") {
        return Some(ev("vendor", format!("network card by {vendor}"), Some("linux"), Some("Raspberry Pi (Linux)".into()), 2).with(data));
    }
    if lower.starts_with("apple") {
        return Some(ev("vendor", format!("network card by {vendor}"), Some("macos"), Some("Apple device (macOS / iOS)".into()), 1).with(data));
    }
    None
}

/// nmap 的輸出行 → 線索。/ nmap's lines → clues.
pub fn nmap_evidence(lines: &[String]) -> Vec<Evidence> {
    let family_of = |s: &str| {
        let l = s.to_ascii_lowercase();
        if l.contains("windows") {
            Some("windows")
        } else if l.contains("mac os") || l.contains("macos") || l.contains("apple") {
            Some("macos")
        } else if l.contains("freebsd") || l.contains("openbsd") || l.contains("netbsd") {
            Some("bsd")
        } else if l.contains("cisco") || l.contains("routeros") || l.contains("juniper") || l.contains("fortinet") {
            Some("network")
        } else if l.contains("linux") {
            Some("linux")
        } else {
            None
        }
    };
    let mut out = Vec::new();
    for line in lines {
        let (label, rest) = line.split_once(':').map(|(a, b)| (a.trim(), b.trim())).unwrap_or(("", line.as_str()));
        let (weight, name) = match label {
            "OS details" => (5, Some(rest.split(',').next().unwrap_or(rest).trim().to_string())),
            "Running" => (4, Some(rest.to_string())),
            "Aggressive OS guesses" => (3, Some(rest.split(" (").next().unwrap_or(rest).trim().to_string())),
            _ => (0, None),
        };
        out.push(ev("nmap", format!("nmap: {line}"), if weight > 0 { family_of(rest) } else { None }, name.filter(|n| !n.is_empty()), weight).with(serde_json::json!({ "line": line })));
    }
    out
}

// ---------------------------------------------------------------- SMB / NTLM

/// NetBIOS session 的 4 位元組長度表頭。/ The NetBIOS session header.
fn netbios(payload: &[u8]) -> Vec<u8> {
    let n = payload.len() as u32;
    let mut out = vec![0u8, (n >> 16) as u8, (n >> 8) as u8, n as u8];
    out.extend_from_slice(payload);
    out
}

fn smb2_header(command: u16, message_id: u64) -> Vec<u8> {
    let mut h = Vec::with_capacity(64);
    h.extend_from_slice(b"\xfeSMB");
    h.extend_from_slice(&64u16.to_le_bytes()); // StructureSize
    h.extend_from_slice(&0u16.to_le_bytes()); // CreditCharge
    h.extend_from_slice(&0u32.to_le_bytes()); // Status
    h.extend_from_slice(&command.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes()); // CreditRequest
    h.extend_from_slice(&0u32.to_le_bytes()); // Flags
    h.extend_from_slice(&0u32.to_le_bytes()); // NextCommand
    h.extend_from_slice(&message_id.to_le_bytes());
    h.extend_from_slice(&0u32.to_le_bytes()); // Reserved
    h.extend_from_slice(&0u32.to_le_bytes()); // TreeId
    h.extend_from_slice(&0u64.to_le_bytes()); // SessionId
    h.extend_from_slice(&[0u8; 16]); // Signature
    h
}

/// SMB2 NEGOTIATE（2.0.2 – 3.0.2；不帶 3.1.1，所以不需要 negotiate context）。/ SMB2 NEGOTIATE without 3.1.1 contexts.
pub fn smb_negotiate() -> Vec<u8> {
    let dialects: [u16; 4] = [0x0202, 0x0210, 0x0300, 0x0302];
    let mut p = smb2_header(0x0000, 0);
    p.extend_from_slice(&36u16.to_le_bytes()); // StructureSize
    p.extend_from_slice(&(dialects.len() as u16).to_le_bytes());
    p.extend_from_slice(&1u16.to_le_bytes()); // SecurityMode: signing enabled
    p.extend_from_slice(&0u16.to_le_bytes()); // Reserved
    p.extend_from_slice(&0u32.to_le_bytes()); // Capabilities
    p.extend_from_slice(b"TelepyOSCheck\0\0\0"); // ClientGuid (16)
    p.extend_from_slice(&[0u8; 8]); // ClientStartTime
    for d in dialects {
        p.extend_from_slice(&d.to_le_bytes());
    }
    netbios(&p)
}

fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let n = content.len();
    if n < 0x80 {
        out.push(n as u8);
    } else {
        out.push(0x82);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    }
    out.extend_from_slice(content);
    out
}

/// NTLM NEGOTIATE（只問、不帶任何帳號）。/ An NTLM NEGOTIATE message (asks, carries no account).
fn ntlm_negotiate() -> Vec<u8> {
    let mut m = Vec::with_capacity(40);
    m.extend_from_slice(b"NTLMSSP\0");
    m.extend_from_slice(&1u32.to_le_bytes());
    m.extend_from_slice(&0xe208_8297u32.to_le_bytes()); // unicode, NTLM, ext. session security, version, 128/56…
    m.extend_from_slice(&[0u8; 8]); // DomainNameFields
    m.extend_from_slice(&[0u8; 8]); // WorkstationFields
    m.extend_from_slice(&[10, 0, 0x61, 0x4a, 0, 0, 0, 15]); // Version 10.0.19041, NTLM revision 15
    m
}

/// SESSION_SETUP，安全緩衝 = SPNEGO NegTokenInit 包著 NTLM NEGOTIATE。/ SESSION_SETUP carrying SPNEGO + NTLM NEGOTIATE.
pub fn smb_session_setup() -> Vec<u8> {
    const SPNEGO: &[u8] = &[0x2b, 0x06, 0x01, 0x05, 0x05, 0x02];
    const NTLMSSP: &[u8] = &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x02, 0x0a];
    let mech_types = der(0xa0, &der(0x30, &der(0x06, NTLMSSP)));
    let mech_token = der(0xa2, &der(0x04, &ntlm_negotiate()));
    let init = der(0xa0, &der(0x30, &[mech_types, mech_token].concat()));
    let blob = der(0x60, &[der(0x06, SPNEGO), init].concat());
    let mut p = smb2_header(0x0001, 1);
    p.extend_from_slice(&25u16.to_le_bytes()); // StructureSize
    p.push(0); // Flags
    p.push(1); // SecurityMode
    p.extend_from_slice(&0u32.to_le_bytes()); // Capabilities
    p.extend_from_slice(&0u32.to_le_bytes()); // Channel
    p.extend_from_slice(&(64u16 + 24).to_le_bytes()); // SecurityBufferOffset
    p.extend_from_slice(&(blob.len() as u16).to_le_bytes());
    p.extend_from_slice(&0u64.to_le_bytes()); // PreviousSessionId
    p.extend_from_slice(&blob);
    netbios(&p)
}

/// 從 NetBIOS 收到的位元組裡取出完整的一則訊息（長度不夠 = None）。/ One whole NetBIOS message, when it has arrived.
pub fn netbios_message(buf: &[u8]) -> Option<&[u8]> {
    if buf.len() < 4 {
        return None;
    }
    let n = (usize::from(buf[1]) << 16) | (usize::from(buf[2]) << 8) | usize::from(buf[3]);
    buf.get(4..4 + n)
}

/// SMB2 回覆的狀態碼（不是 SMB2 = None）。/ An SMB2 reply's status.
pub fn smb_status(msg: &[u8]) -> Option<u32> {
    (msg.len() >= 12 && msg.starts_with(b"\xfeSMB")).then(|| u32::from_le_bytes([msg[8], msg[9], msg[10], msg[11]]))
}

/// NTLM CHALLENGE 裡的東西。/ What an NTLM CHALLENGE says.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NtlmInfo {
    pub major: u8,
    pub minor: u8,
    pub build: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns_computer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns_domain: Option<String>,
}

/// UTF-16LE → 字串；空的（Samba 會送一個 `\0`）= None。/ UTF-16LE → a string; empty (Samba sends a lone NUL) = None.
fn utf16(bytes: &[u8]) -> Option<String> {
    let (pairs, _) = bytes.as_chunks::<2>();
    let units: Vec<u16> = pairs.iter().map(|c| u16::from_le_bytes(*c)).collect();
    let s = String::from_utf16_lossy(&units).trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string();
    (!s.is_empty()).then_some(s)
}

/// 在回覆裡找 NTLM CHALLENGE（`NTLMSSP\0` + 類型 2）並讀出版本與名稱；位移都相對於訊息開頭。
/// Find the NTLM CHALLENGE (`NTLMSSP\0` + type 2) anywhere in the reply and read the version and names.
pub fn parse_challenge(buf: &[u8]) -> Option<NtlmInfo> {
    let sig = b"NTLMSSP\0\x02\0\0\0";
    let start = buf.windows(sig.len()).position(|w| w == sig)?;
    let m = &buf[start..];
    if m.len() < 56 {
        return None;
    }
    let u16_at = |i: usize| u16::from_le_bytes([m[i], m[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([m[i], m[i + 1], m[i + 2], m[i + 3]]);
    let flags = u32_at(20);
    let mut info = NtlmInfo::default();
    if flags & 0x0200_0000 != 0 {
        info.major = m[48];
        info.minor = m[49];
        info.build = u16_at(50);
    }
    let (len, off) = (usize::from(u16_at(40)), u32_at(44) as usize);
    if let Some(mut av) = m.get(off..off.saturating_add(len)) {
        while av.len() >= 4 {
            let (id, n) = (u16::from_le_bytes([av[0], av[1]]), usize::from(u16::from_le_bytes([av[2], av[3]])));
            let Some(value) = av.get(4..4 + n) else { break };
            match id {
                0 => break,
                1 => info.computer = utf16(value),
                2 => info.domain = utf16(value),
                3 => info.dns_computer = utf16(value),
                4 => info.dns_domain = utf16(value),
                _ => {}
            }
            av = &av[4 + n..];
        }
    }
    Some(info)
}

/// Windows 的版本號 → 名字（同一個組建號可能是桌面版或伺服器版，兩個都寫）。/ A Windows version → its name.
pub fn windows_name(major: u8, minor: u8, build: u16) -> String {
    match (major, minor) {
        (10, 0) => match build {
            b if b >= 26100 => "Windows 11 24H2 or Server 2025".into(),
            b if b >= 22631 => "Windows 11 23H2".into(),
            b if b >= 22621 => "Windows 11 22H2".into(),
            b if b >= 22000 => "Windows 11 21H2".into(),
            20348 => "Windows Server 2022".into(),
            19045 => "Windows 10 22H2".into(),
            19044 => "Windows 10 21H2".into(),
            19043 => "Windows 10 21H1".into(),
            19042 => "Windows 10 20H2".into(),
            19041 => "Windows 10 2004".into(),
            18363 => "Windows 10 1909".into(),
            18362 => "Windows 10 1903".into(),
            17763 => "Windows 10 1809 or Server 2019".into(),
            17134 => "Windows 10 1803".into(),
            16299 => "Windows 10 1709".into(),
            15063 => "Windows 10 1703".into(),
            14393 => "Windows 10 1607 or Server 2016".into(),
            10586 => "Windows 10 1511".into(),
            10240 => "Windows 10 1507".into(),
            _ => "Windows 10 / 11".into(),
        },
        (6, 3) => "Windows 8.1 or Server 2012 R2".into(),
        (6, 2) => "Windows 8 or Server 2012".into(),
        (6, 1) => "Windows 7 or Server 2008 R2".into(),
        (6, 0) => "Windows Vista or Server 2008".into(),
        (5, 2) => "Windows XP x64 or Server 2003".into(),
        (5, 1) => "Windows XP".into(),
        _ => format!("Windows {major}.{minor}"),
    }
}

/// NTLM 資訊 → 線索。組建號 0 = Samba（Linux / Unix 的 SMB 伺服器）。/ NTLM info → a clue; build 0 = Samba.
pub fn smb_evidence(port: u16, info: &NtlmInfo) -> Evidence {
    let name = info.dns_computer.clone().or_else(|| info.computer.clone());
    let domain_name = info.dns_domain.clone().or_else(|| info.domain.clone());
    let data = serde_json::json!({ "port": port, "major": info.major, "minor": info.minor, "build": info.build, "samba": info.build == 0, "computer": name, "domain": domain_name });
    smb_clue(port, info).with(data)
}

fn smb_clue(port: u16, info: &NtlmInfo) -> Evidence {
    let names = [info.dns_computer.as_deref(), info.computer.as_deref()].into_iter().flatten().next().map(|n| format!(", named {n}")).unwrap_or_default();
    let domain = [info.dns_domain.as_deref(), info.domain.as_deref()].into_iter().flatten().next().map(|d| format!(" in {d}")).unwrap_or_default();
    if info.build == 0 {
        let text = format!("SMB on port {port}: NTLM version {}.{} build 0 (Samba){names}{domain}", info.major, info.minor);
        return ev("smb", text, Some("unix"), Some("Samba (SMB on Linux / Unix)".into()), 3);
    }
    let text = format!("SMB on port {port}: Windows {}.{} build {}{names}{domain}", info.major, info.minor, info.build);
    ev("smb", text, Some("windows"), Some(format!("{} (build {})", windows_name(info.major, info.minor, info.build), info.build)), 5)
}

// ---------------------------------------------------------------- the verdict

const FAMILIES: [&str; 5] = ["windows", "linux", "macos", "bsd", "network"];

fn unix_like(f: &str) -> bool {
    matches!(f, "linux" | "macos" | "bsd")
}

/// 把線索秤一秤：每個系列加總（`unix` 的線索算進 Linux / macOS / BSD），分數最高的贏；名字取那個系列裡最重的線索。
/// 信心：最重的一條 ≥ 4 而且沒有別的系列 ≥ 3 = high；總分 ≥ 3 = medium；有分 = low。
/// Weigh the clues: each family sums its own (unix clues count for Linux / macOS / BSD); the name is the heaviest named
/// clue of the winner. Confidence: a clue ≥ 4 and no rival ≥ 3 = high; a total ≥ 3 = medium; anything = low.
pub fn verdict(evidence: &[Evidence]) -> (Option<String>, Option<String>, String, Vec<String>) {
    let own = |f: &str| evidence.iter().filter(|e| e.family.as_deref() == Some(f)).map(|e| u32::from(e.weight)).sum::<u32>();
    let unix = own("unix");
    let score = |f: &str| own(f) + if unix_like(f) { unix } else { 0 };
    let best = FAMILIES.iter().copied().filter(|f| own(f) > 0).max_by_key(|f| (score(f), evidence.iter().filter(|e| e.family.as_deref() == Some(*f)).map(|e| e.weight).max().unwrap_or(0)));
    let (family, total) = match best {
        Some(f) => (f, score(f)),
        None if unix > 0 => ("unix", unix),
        None => return (None, None, "none".into(), Vec::new()),
    };
    let named = |f: &str| evidence.iter().filter(|e| e.family.as_deref() == Some(f) && e.name.is_some()).max_by_key(|e| e.weight).and_then(|e| e.name.clone());
    let name = named(family).or_else(|| (unix_like(family)).then(|| named("unix")).flatten());
    let heaviest = evidence.iter().filter(|e| e.family.as_deref() == Some(family) || (unix_like(family) && e.family.as_deref() == Some("unix"))).map(|e| e.weight).max().unwrap_or(0);
    let conflict: Vec<String> = FAMILIES.iter().filter(|f| **f != family && own(f) >= 2).map(|f| f.to_string()).collect();
    let rival = FAMILIES.iter().filter(|f| **f != family).map(|f| own(f)).max().unwrap_or(0);
    let confidence = if heaviest >= 4 && rival < 3 {
        "high"
    } else if total >= 3 {
        "medium"
    } else {
        "low"
    };
    (Some(family.to_string()), name, confidence.to_string(), conflict)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_script_is_built_only_from_safe_values() {
        let s = posix_command("192.168.1.20", &[22, 445]).unwrap();
        assert!(s.contains("h=192.168.1.20") && s.contains("-p 22,445") && s.contains("TELEPY_OSFP|start|"));
        assert!(s.starts_with("sh -c '") && s.ends_with('\''), "one single-quoted script");
        assert_eq!(s.matches('\'').count(), 2, "no inner single quotes");
        assert!(posix_command("192.168.1.20; rm -rf /", &[]).is_none());
        assert!(posix_command("host.lan", &[]).is_none(), "names never go into the shell");
        assert!(posix_command("192.168.1.20", &[]).unwrap().contains("--top-ports 20"));
        assert_eq!(windows_command("10.0.0.5").as_deref(), Some("ping -n 1 -w 1500 10.0.0.5"));
    }

    #[test]
    fn the_script_runs_in_a_real_shell_with_stub_tools() {
        let dir = std::env::temp_dir().join(format!("telepy-osfp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            let mut perm = std::fs::metadata(&p).unwrap().permissions();
            std::os::unix::fs::PermissionsExt::set_mode(&mut perm, 0o755);
            std::fs::set_permissions(&p, perm).unwrap();
        };
        stub("ping", "echo '64 bytes from 10.0.0.9: icmp_seq=1 ttl=127 time=0.4 ms'");
        stub("nmap", "echo 'Running: Microsoft Windows 10|11'; echo 'OS details: Microsoft Windows 10 1607 - 11'");
        stub("id", "echo 1000");
        stub("sudo", "[ \"$1\" = -n ] && shift; [ \"$1\" = true ] && exit 0; exec \"$@\"");
        for tool in ["sh", "grep", "head", "tr", "sed"] {
            let real = ["/bin", "/usr/bin"].iter().map(|d| std::path::Path::new(d).join(tool)).find(|p| p.exists()).unwrap();
            let _ = std::os::unix::fs::symlink(real, dir.join(tool));
        }
        let cmd = posix_command("10.0.0.9", &[445]).unwrap();
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(&cmd).env("PATH", &dir).output().unwrap();
        let a = parse_posix(&String::from_utf8_lossy(&out.stdout));
        assert!(a.posix);
        assert_eq!(a.ttl, Some(127));
        assert_eq!(a.nmap, "ran");
        assert_eq!(a.nmap_lines, vec!["Running: Microsoft Windows 10|11", "OS details: Microsoft Windows 10 1607 - 11"]);
        // 不能 sudo：說 unprivileged，不跑 nmap。/ No sudo: unprivileged, nmap not run.
        stub("sudo", "exit 1");
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(&cmd).env("PATH", &dir).output().unwrap();
        let a = parse_posix(&String::from_utf8_lossy(&out.stdout));
        assert_eq!((a.nmap.as_str(), a.nmap_lines.len()), ("unprivileged", 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_ping_answers_have_a_ttl() {
        assert_eq!(parse_windows_ping("Reply from 10.0.0.5: bytes=32 time<1ms TTL=128\r\n"), Some(128));
        assert_eq!(parse_windows_ping("回覆自 10.0.0.5: 位元組=32 時間<1ms TTL=64"), Some(64));
        assert_eq!(parse_windows_ping("Request timed out."), None);
    }

    #[test]
    fn ttls_point_at_families() {
        assert_eq!(ttl_evidence(64).family.as_deref(), Some("unix"));
        assert!(ttl_evidence(63).text.contains("1 hop"));
        assert_eq!(ttl_evidence(128).family.as_deref(), Some("windows"));
        assert_eq!(ttl_evidence(250).family.as_deref(), Some("network"));
    }

    #[test]
    fn ssh_greetings_name_releases() {
        let name = |b: &str| ssh_evidence(b).and_then(|e| e.name);
        assert_eq!(name("SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10").as_deref(), Some("Ubuntu 22.04 LTS"));
        assert_eq!(name("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5").as_deref(), Some("Ubuntu 24.04 LTS"));
        assert_eq!(name("SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3").as_deref(), Some("Debian 12"));
        assert_eq!(name("SSH-2.0-OpenSSH_8.4p1 Debian-5+deb11u1").as_deref(), Some("Debian 11"));
        assert_eq!(name("SSH-2.0-OpenSSH_9.2p1 Raspbian-2+deb12u2").as_deref(), Some("Raspberry Pi OS (Debian 12)"));
        assert_eq!(name("SSH-2.0-OpenSSH_for_Windows_9.5").as_deref(), Some("Windows (OpenSSH for Windows 9.5)"));
        assert_eq!(name("SSH-2.0-dropbear_2022.82").as_deref(), Some("embedded Linux (Dropbear SSH)"));
        assert_eq!(name("SSH-2.0-OpenSSH_8.8 FreeBSD-20211221").as_deref(), Some("FreeBSD"));
        let plain = ssh_evidence("SSH-2.0-OpenSSH_9.8").unwrap();
        assert_eq!((plain.weight, plain.family.clone()), (0, None), "no tag = a note only");
        assert_eq!(plain.data, Some(serde_json::json!({ "line": "OpenSSH_9.8", "tagged": false })), "the raw values for the web's own sentence");
        assert!(ssh_evidence("").is_none());
    }

    #[test]
    fn http_server_headers_and_vendors() {
        let svc = |port: u16, server: &str| Service { port, proto: "http".into(), server: Some(server.into()), ..Default::default() };
        let e = http_evidence(&[svc(80, "Microsoft-IIS/10.0"), svc(8080, "Apache/2.4.58 (Ubuntu)"), svc(81, "Apache/2.4.58 (Ubuntu)"), svc(82, "nginx")]);
        assert_eq!(e.len(), 2, "one clue per name, nginx tells nothing");
        assert_eq!((e[0].family.as_deref(), e[0].name.as_deref()), (Some("windows"), Some("Windows Server 2016 or later")));
        assert_eq!(e[1].name.as_deref(), Some("Ubuntu"));
        assert_eq!(vendor_evidence("Raspberry Pi Trading Ltd").unwrap().family.as_deref(), Some("linux"));
        assert_eq!(vendor_evidence("Apple, Inc.").unwrap().weight, 1);
        assert!(vendor_evidence("Intel Corporate").is_none());
    }

    /// 照 MS-NLMP 手工組一個 CHALLENGE。/ A hand-built CHALLENGE per MS-NLMP.
    fn challenge(major: u8, minor: u8, build: u16, names: &[(u16, &str)]) -> Vec<u8> {
        let mut av = Vec::new();
        for (id, s) in names {
            let v: Vec<u8> = s.encode_utf16().flat_map(u16::to_le_bytes).collect();
            av.extend_from_slice(&id.to_le_bytes());
            av.extend_from_slice(&(v.len() as u16).to_le_bytes());
            av.extend_from_slice(&v);
        }
        av.extend_from_slice(&[0, 0, 0, 0]);
        let mut m = Vec::new();
        m.extend_from_slice(b"NTLMSSP\0");
        m.extend_from_slice(&2u32.to_le_bytes());
        m.extend_from_slice(&[0u8; 8]); // TargetNameFields
        m.extend_from_slice(&0x0281_8215u32.to_le_bytes()); // flags incl. VERSION + TARGET_INFO
        m.extend_from_slice(&[7u8; 8]); // ServerChallenge
        m.extend_from_slice(&[0u8; 8]); // Reserved
        m.extend_from_slice(&(av.len() as u16).to_le_bytes());
        m.extend_from_slice(&(av.len() as u16).to_le_bytes());
        m.extend_from_slice(&56u32.to_le_bytes());
        m.extend_from_slice(&[major, minor]);
        m.extend_from_slice(&build.to_le_bytes());
        m.extend_from_slice(&[0, 0, 0, 15]);
        m.extend_from_slice(&av);
        m
    }

    #[test]
    fn an_ntlm_challenge_tells_the_windows_build_and_names() {
        let mut reply = b"\xfeSMB....some SPNEGO bytes".to_vec();
        reply.extend_from_slice(&challenge(10, 0, 22631, &[(2, "WORKGROUP"), (1, "DESKTOP-7Q"), (3, "desktop-7q"), (4, "")]));
        let info = parse_challenge(&reply).unwrap();
        assert_eq!((info.major, info.minor, info.build), (10, 0, 22631));
        assert_eq!(info.dns_domain, None, "an empty name is none");
        assert_eq!((info.computer.as_deref(), info.domain.as_deref(), info.dns_computer.as_deref()), (Some("DESKTOP-7Q"), Some("WORKGROUP"), Some("desktop-7q")));
        let e = smb_evidence(445, &info);
        assert_eq!((e.family.as_deref(), e.name.as_deref(), e.weight), (Some("windows"), Some("Windows 11 23H2 (build 22631)"), 5));
        assert!(e.text.contains("named desktop-7q"), "{}", e.text);
        let d = e.data.unwrap();
        assert_eq!((d["build"].as_u64(), d["computer"].as_str(), d["domain"].as_str(), d["samba"].as_bool()), (Some(22631), Some("desktop-7q"), Some("WORKGROUP"), Some(false)));
        assert_eq!(ttl_evidence(63).data.unwrap()["hops"], 1);
        // 真的 Samba 4.13 送的：6.1 build 0，DNS 網域是一個 NUL。/ What a real Samba 4.13 sent: 6.1 build 0, a NUL domain.
        let samba_info = parse_challenge(&challenge(6, 1, 0, &[(1, "NAS"), (4, "\0")])).unwrap();
        assert_eq!(samba_info.dns_domain, None);
        let samba = smb_evidence(445, &samba_info);
        assert_eq!((samba.family.as_deref(), samba.weight), (Some("unix"), 3));
        assert!(parse_challenge(b"no ntlm here").is_none());
        assert!(parse_challenge(b"NTLMSSP\0\x02\0\0\0short").is_none());
    }

    #[test]
    fn windows_builds_have_names() {
        assert_eq!(windows_name(10, 0, 17763), "Windows 10 1809 or Server 2019");
        assert_eq!(windows_name(10, 0, 20348), "Windows Server 2022");
        assert_eq!(windows_name(10, 0, 26100), "Windows 11 24H2 or Server 2025");
        assert_eq!(windows_name(6, 1, 7601), "Windows 7 or Server 2008 R2");
        assert_eq!(windows_name(10, 0, 12345), "Windows 10 / 11");
    }

    #[test]
    fn the_smb_requests_are_well_formed() {
        let n = smb_negotiate();
        assert_eq!(netbios_message(&n).unwrap().len(), n.len() - 4);
        let msg = netbios_message(&n).unwrap();
        assert!(msg.starts_with(b"\xfeSMB") && msg.len() == 64 + 36 + 8);
        let s = smb_session_setup();
        let msg = netbios_message(&s).unwrap();
        assert_eq!(u16::from_le_bytes([msg[12], msg[13]]), 1, "SESSION_SETUP");
        let blob_len = usize::from(u16::from_le_bytes([msg[64 + 14], msg[64 + 15]]));
        assert_eq!(msg.len(), 64 + 24 + blob_len);
        let blob = &msg[88..];
        assert_eq!((blob[0], usize::from(blob[1])), (0x60, blob.len() - 2), "GSS-API token length");
        assert!(blob.windows(8).any(|w| w == b"NTLMSSP\0"));
        assert_eq!(smb_status(b"\xfeSMB\x40\0\0\0\x16\0\0\xc0"), Some(0xc000_0016));
        assert_eq!(netbios_message(&[0, 0, 0, 9, 1]), None, "not all there yet");
    }

    /// 對一台真的 SMB 伺服器（Samba / Windows）試一次：`SMB_TEST_ADDR=127.0.0.1:14450 cargo test -- --ignored real_smb`。
    /// Against a real SMB server; run by hand with `SMB_TEST_ADDR`.
    #[test]
    #[ignore = "needs a real SMB server: SMB_TEST_ADDR=host:port"]
    fn a_real_smb_server_answers_with_ntlm_info() {
        use std::io::{Read, Write};
        let addr = std::env::var("SMB_TEST_ADDR").expect("SMB_TEST_ADDR");
        let mut s = std::net::TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let read = |s: &mut std::net::TcpStream| {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            while netbios_message(&buf).is_none() {
                let n = s.read(&mut chunk).unwrap();
                assert!(n > 0, "closed");
                buf.extend_from_slice(&chunk[..n]);
            }
            netbios_message(&buf).unwrap().to_vec()
        };
        s.write_all(&smb_negotiate()).unwrap();
        let neg = read(&mut s);
        assert_eq!(smb_status(&neg), Some(0), "negotiate");
        s.write_all(&smb_session_setup()).unwrap();
        let reply = read(&mut s);
        println!("status {:#x?}", smb_status(&reply));
        let info = parse_challenge(&reply).expect("an NTLM challenge");
        println!("{info:?}\n{:?}", smb_evidence(445, &info));
    }

    #[test]
    fn the_verdict_weighs_the_clues() {
        let ttl = ttl_evidence(128);
        let smb = smb_evidence(445, &NtlmInfo { major: 10, minor: 0, build: 19045, ..Default::default() });
        let (f, n, c, x) = verdict(&[ttl.clone(), smb]);
        assert_eq!((f.as_deref(), n.as_deref(), c.as_str()), (Some("windows"), Some("Windows 10 22H2 (build 19045)"), "high"));
        assert!(x.is_empty());
        // TTL 64 + Ubuntu 的 SSH：Linux / Ubuntu。/ TTL 64 + an Ubuntu greeting.
        let (f, n, c, _) = verdict(&[ttl_evidence(64), ssh_evidence("SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10").unwrap()]);
        assert_eq!((f.as_deref(), n.as_deref(), c.as_str()), (Some("linux"), Some("Ubuntu 22.04 LTS"), "high"));
        // 只有 TTL：低信心，系列 = unix。/ Only a TTL: low, the unix family.
        let (f, n, c, _) = verdict(&[ttl_evidence(64)]);
        assert_eq!((f.as_deref(), n, c.as_str()), (Some("unix"), None, "low"));
        // 互相矛盾：SSH 說 Ubuntu、SMB 說 Windows → 說出另一個。/ Disagreeing clues name the rival.
        let (f, _, c, x) = verdict(&[ssh_evidence("SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10").unwrap(), smb_evidence(445, &NtlmInfo { major: 10, build: 22631, ..Default::default() })]);
        assert_eq!((f.as_deref(), c.as_str()), (Some("windows"), "medium"));
        assert_eq!(x, vec!["linux".to_string()]);
        // nmap 最重。/ nmap weighs most.
        let n = nmap_evidence(&["Running: Linux 5.X|6.X".into(), "OS details: Linux 5.0 - 5.14, Linux 6.1".into(), "Device type: general purpose".into()]);
        assert_eq!(n[1].name.as_deref(), Some("Linux 5.0 - 5.14"));
        let (f, name, c, _) = verdict(&[ttl_evidence(64), n[0].clone(), n[1].clone()]);
        assert_eq!((f.as_deref(), name.as_deref(), c.as_str()), (Some("linux"), Some("Linux 5.0 - 5.14"), "high"));
        assert_eq!(verdict(&[]).2, "none");
        assert_eq!(verdict(&[ssh_evidence("SSH-2.0-OpenSSH_9.8").unwrap()]).2, "none", "a note alone decides nothing");
    }
}
