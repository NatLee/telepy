//! Wake-on-LAN（純函式）：喚醒封包要從裝置那邊的網路送出去（Telepy 只走得到 TCP），所以是在裝置上跑一段指令，依序試
//! `wakeonlan`、`etherwake` / `ether-wake`（含 `sudo -n`）、`python3`，Windows 用 PowerShell 的 UdpClient。這裡只組指令、
//! 讀結果；執行在 `api/lan.rs`。封包 = 6 個 0xFF + MAC 重複 16 次，送到那台主機所在網段的廣播位址（不知道就 255.255.255.255）
//! 的 UDP 9。
//! Wake-on-LAN (pure). The magic packet has to leave from the device's network (Telepy only reaches TCP), so a command
//! runs on the device and tries `wakeonlan`, `etherwake` / `ether-wake` (also with `sudo -n`), then `python3`; Windows
//! uses PowerShell's UdpClient. This file builds the commands and reads the answer; `api/lan.rs` runs them. Packet =
//! six 0xFF then the MAC sixteen times, to the host's network broadcast (else 255.255.255.255) on UDP 9.

use std::net::Ipv4Addr;

use super::Network;

/// `aa:bb:cc:dd:ee:ff`、`aa-bb-…`、`aabb.ccdd.eeff`、`aabbccddeeff` 都認。/ Common MAC spellings.
pub fn parse_mac(raw: &str) -> Option<[u8; 6]> {
    let hex: String = raw.trim().chars().filter(|c| !matches!(c, ':' | '-' | '.')).collect();
    if hex.len() != 12 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 6];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    // 全 0、全 FF、群播位址都不是一張網卡。/ All zeros, all ones and multicast are not a NIC.
    if out == [0; 6] || out == [0xff; 6] || out[0] & 1 == 1 {
        return None;
    }
    Some(out)
}

pub fn mac_text(m: &[u8; 6]) -> String {
    m.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

/// 主機所在網段的廣播位址（掃描記下的網段裡第一個包含它的；/31、/32 沒有廣播）。/ The host's network broadcast.
pub fn broadcast_for(ip: Option<Ipv4Addr>, networks: &[Network]) -> Ipv4Addr {
    let Some(ip) = ip else { return Ipv4Addr::BROADCAST };
    networks
        .iter()
        .filter(|n| n.prefix < 31 && n.contains(ip))
        .map(|n| Ipv4Addr::from(u32::from(n.network()) | (u32::MAX >> n.prefix)))
        .next()
        .unwrap_or(Ipv4Addr::BROADCAST)
}

/// 裝置上跑的 POSIX 指令（包在 `sh -c` 裡；只有十六進位字與 IP，沒有使用者給的文字）。成功印一行
/// `TELEPY_WAKE|<工具>|<廣播>`，全都沒有就 `TELEPY_WAKE|none|` 並以 1 結束。
/// The POSIX command for the device (wrapped in `sh -c`; only hex digits and an IP, nothing the person typed). Prints
/// `TELEPY_WAKE|<tool>|<broadcast>` on success, `TELEPY_WAKE|none|` and exit 1 when nothing could send it.
pub fn posix_command(mac: &[u8; 6], broadcast: Ipv4Addr) -> String {
    let m = mac_text(mac);
    let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
    let py = format!(
        "import socket;p=b\\\"\\\\xff\\\"*6+bytes.fromhex(\\\"{hex}\\\")*16;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);[s.sendto(p,(a,9)) for a in (\\\"{broadcast}\\\",\\\"255.255.255.255\\\")]"
    );
    format!(
        "sh -c 'm={m}; b={broadcast}; \
         ok() {{ echo \"TELEPY_WAKE|$1|$2\"; exit 0; }}; \
         if command -v wakeonlan >/dev/null 2>&1; then wakeonlan -i \"$b\" \"$m\" >/dev/null 2>&1 && ok wakeonlan \"$b\"; fi; \
         for t in etherwake ether-wake; do if command -v $t >/dev/null 2>&1; then $t -b \"$m\" >/dev/null 2>&1 && ok $t \"\"; sudo -n $t -b \"$m\" >/dev/null 2>&1 && ok \"sudo $t\" \"\"; fi; done; \
         if command -v python3 >/dev/null 2>&1; then python3 -c \"{py}\" && ok python3 \"$b\"; fi; \
         echo \"TELEPY_WAKE|none|\"; exit 1'"
    )
}

/// Windows：PowerShell 的 UdpClient 送到廣播位址。/ Windows: PowerShell's UdpClient to the broadcast addresses.
pub fn windows_command(mac: &[u8; 6], broadcast: Ipv4Addr) -> String {
    let bytes = mac.iter().map(|b| format!("0x{b:02X}")).collect::<Vec<_>>().join(",");
    format!(
        "powershell -NoProfile -NonInteractive -Command \"$m=[byte[]]({bytes}); $p=[byte[]](((,0xFF)*6)+($m*16)); $c=New-Object System.Net.Sockets.UdpClient; $c.EnableBroadcast=$true; [void]$c.Send($p,$p.Length,'{broadcast}',9); [void]$c.Send($p,$p.Length,'255.255.255.255',9); $c.Close(); 'TELEPY_WAKE|powershell|{broadcast}'\""
    )
}

/// 讀結果：送出去了 = Some((工具, 廣播位址))。/ The answer: sent = Some((tool, broadcast)).
pub fn parse_result(out: &str) -> Option<(String, String)> {
    out.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("TELEPY_WAKE|")?;
        let mut parts = rest.splitn(2, '|');
        let tool = parts.next()?.trim().to_string();
        let b = parts.next().unwrap_or("").trim().to_string();
        (!tool.is_empty() && tool != "none").then_some((tool, b))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_spellings() {
        let m = [0xaa, 0xbb, 0xcc, 0x00, 0x00, 0x01];
        for raw in ["aa:bb:cc:00:00:01", "AA-BB-CC-00-00-01", "aabb.cc00.0001", "aabbcc000001"] {
            assert_eq!(parse_mac(raw), Some(m), "{raw}");
        }
        assert_eq!(mac_text(&m), "aa:bb:cc:00:00:01");
        assert_eq!(parse_mac("00:00:00:00:00:00"), None);
        assert_eq!(parse_mac("ff:ff:ff:ff:ff:ff"), None);
        assert_eq!(parse_mac("01:00:5e:00:00:01"), None, "multicast");
        assert_eq!(parse_mac("aa:bb:cc"), None);
        assert_eq!(parse_mac("zz:bb:cc:00:00:01"), None);
    }

    #[test]
    fn broadcast_of_the_hosts_network() {
        let nets = vec![super::super::parse_cidr("10.0.0.0/22").unwrap(), super::super::parse_cidr("192.168.77.0/24").unwrap()];
        assert_eq!(broadcast_for(Some(Ipv4Addr::new(192, 168, 77, 20)), &nets), Ipv4Addr::new(192, 168, 77, 255));
        assert_eq!(broadcast_for(Some(Ipv4Addr::new(10, 0, 1, 3)), &nets), Ipv4Addr::new(10, 0, 3, 255));
        assert_eq!(broadcast_for(Some(Ipv4Addr::new(172, 16, 0, 5)), &nets), Ipv4Addr::BROADCAST, "outside every known network");
        assert_eq!(broadcast_for(None, &nets), Ipv4Addr::BROADCAST);
        let single = vec![super::super::parse_cidr("127.0.0.1/32").unwrap()];
        assert_eq!(broadcast_for(Some(Ipv4Addr::LOCALHOST), &single), Ipv4Addr::BROADCAST, "a /32 has no broadcast");
    }

    #[test]
    fn results() {
        assert_eq!(parse_result("TELEPY_WAKE|python3|192.168.1.255\n"), Some(("python3".into(), "192.168.1.255".into())));
        assert_eq!(parse_result("noise\nTELEPY_WAKE|sudo etherwake|\n"), Some(("sudo etherwake".into(), String::new())));
        assert_eq!(parse_result("TELEPY_WAKE|none|\n"), None);
        assert_eq!(parse_result(""), None);
    }

    /// POSIX 指令在 sh 裡真的跑得起來：用假的 `wakeonlan` 接住參數（不送任何封包）。
    /// The POSIX command really runs in sh: a stub `wakeonlan` catches the arguments (no packet is sent).
    #[cfg(unix)]
    #[test]
    fn the_command_runs_in_sh_with_a_stub_tool() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("args");
        let stub = dir.path().join("wakeonlan");
        std::fs::write(&stub, format!("#!/bin/sh\necho \"$@\" > '{}'\n", log.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cmd = posix_command(&[0xaa, 0xbb, 0xcc, 0, 0, 1], Ipv4Addr::new(192, 168, 77, 255));
        let path = format!("{}:/usr/bin:/bin", dir.path().display());
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(&cmd).env("PATH", &path).output().unwrap();
        assert_eq!(parse_result(&String::from_utf8_lossy(&out.stdout)), Some(("wakeonlan".into(), "192.168.77.255".into())), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "-i 192.168.77.255 aa:bb:cc:00:00:01");
    }

    /// 沒有任何工具（PATH 只有一個空目錄、沒有 python3）：說 none、結束碼 1。/ No tool at all: `none`, exit 1.
    #[cfg(unix)]
    #[test]
    fn without_any_tool_it_says_none() {
        let dir = tempfile::tempdir().unwrap();
        // 只有 sh（指令本身包在 `sh -c` 裡）。/ Only sh (the command itself is wrapped in `sh -c`).
        std::os::unix::fs::symlink("/bin/sh", dir.path().join("sh")).unwrap();
        let cmd = posix_command(&[0xaa, 0xbb, 0xcc, 0, 0, 1], Ipv4Addr::BROADCAST);
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(&cmd).env("PATH", dir.path()).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("TELEPY_WAKE|none|"), "{text}");
        assert_eq!(parse_result(&text), None);
        assert_eq!(out.status.code(), Some(1));
    }
}
