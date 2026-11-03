//! `telepy forward` 的純邏輯：`<主機>[:port]` 怎麼讀、本機 port 怎麼挑、轉好以後印什麼網址。真正的 `ssh -L` 在 `lib.rs`。
//! The pure parts of `telepy forward`: reading `<host>[:port]`, picking the local port, and the URL to print once the
//! forward is up. The `ssh -L` itself lives in `lib.rs`.

use crate::lan_web;

/// `<主機>[:port]` → (主機, port)。IPv6 寫成 `[fd00::1]:80`；只有一個冒號才當成 port。
/// `<host>[:port]` → (host, port). IPv6 is `[fd00::1]:80`; only a single colon means a port.
pub fn parse_to(raw: &str) -> Result<(String, Option<u16>), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Say what to reach: <host>[:port], e.g. 192.168.1.10:8080".into());
    }
    let port = |p: &str| p.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| format!("'{p}' is not a port (1–65535)."));
    if let Some(rest) = raw.strip_prefix('[') {
        let (host, after) = rest.split_once(']').ok_or_else(|| format!("'{raw}': a [ without its ]."))?;
        return match after.strip_prefix(':') {
            Some(p) => Ok((host.to_string(), Some(port(p)?))),
            None if after.is_empty() => Ok((host.to_string(), None)),
            None => Err(format!("'{raw}': write [address]:port.")),
        };
    }
    match raw.matches(':').count() {
        0 => Ok((raw.to_string(), None)),
        1 => {
            let (h, p) = raw.split_once(':').unwrap();
            if h.is_empty() {
                return Err(format!("'{raw}': the host is missing."));
            }
            Ok((h.to_string(), Some(port(p)?)))
        }
        // 沒有中括號的 IPv6：整串是位址。/ A bare IPv6 address.
        _ => Ok((raw.to_string(), None)),
    }
}

/// 沒指定時本機用哪個 port：一樣的號碼，1024 以下加 10000（免管理員權限）。/ The local port by default.
pub fn suggest_local(port: u16) -> u16 {
    if port < 1024 {
        port + 10000
    } else {
        port
    }
}

/// 依序試的本機 port：建議的那個與後面 20 個。/ Local ports to try in order: the suggestion and the next 20.
pub fn local_candidates(port: u16) -> Vec<u16> {
    let start = suggest_local(port);
    (0..=20u16).filter_map(|i| start.checked_add(i)).collect()
}

/// `-L` 的參數：只聽 127.0.0.1（別台電腦連不到你開的 port）。/ The `-L` spec: loopback only.
pub fn local_spec(local: u16, host: &str, port: u16) -> String {
    let h = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    format!("127.0.0.1:{local}:{h}:{port}")
}

/// 轉好以後的網址（網頁 port 才有；`https` 強制 https）。/ The URL once forwarded (web ports only; `https` forces it).
pub fn local_url(remote_port: u16, local: u16, https: bool) -> Option<String> {
    let scheme = if https { Some("https") } else { lan_web::web_scheme(remote_port) };
    scheme.map(|s| format!("{s}://localhost:{local}/"))
}

/// 裝置自己（`localhost`、`127.0.0.1`、`::1`）。/ The device itself.
pub fn is_device_itself(host: &str) -> bool {
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_host_and_port() {
        assert_eq!(parse_to("192.168.1.10:8080").unwrap(), ("192.168.1.10".into(), Some(8080)));
        assert_eq!(parse_to("nas").unwrap(), ("nas".into(), None));
        assert_eq!(parse_to("[fd00::1]:443").unwrap(), ("fd00::1".into(), Some(443)));
        assert_eq!(parse_to("[fd00::1]").unwrap(), ("fd00::1".into(), None));
        assert_eq!(parse_to("fd00::1").unwrap(), ("fd00::1".into(), None));
        assert!(parse_to("host:0").is_err());
        assert!(parse_to("host:99999").is_err());
        assert!(parse_to(":80").is_err());
        assert!(parse_to("").is_err());
        assert!(parse_to("[fd00::1").is_err());
    }

    #[test]
    fn local_ports_and_urls() {
        assert_eq!(suggest_local(80), 10080);
        assert_eq!(suggest_local(8080), 8080);
        assert_eq!(local_candidates(443)[..3], [10443, 10444, 10445]);
        assert_eq!(local_candidates(65535), [65535]);
        assert_eq!(local_spec(8080, "192.168.1.10", 8080), "127.0.0.1:8080:192.168.1.10:8080");
        assert_eq!(local_spec(10080, "fd00::1", 80), "127.0.0.1:10080:[fd00::1]:80");
        assert_eq!(local_url(8006, 8006, false).as_deref(), Some("https://localhost:8006/"));
        assert_eq!(local_url(8080, 18080, false).as_deref(), Some("http://localhost:18080/"));
        assert_eq!(local_url(5432, 5432, false), None);
        assert_eq!(local_url(5432, 5432, true).as_deref(), Some("https://localhost:5432/"));
        assert!(is_device_itself("LOCALHOST") && is_device_itself("127.0.0.1") && !is_device_itself("10.0.0.1"));
    }
}
