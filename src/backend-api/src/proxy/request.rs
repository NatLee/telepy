//! HTTP 代理請求的讀法（純函式、沒有相依）：`CONNECT host:port` 與 `GET http://host/path` 兩種，後者改寫成 origin-form。
//! 後端的代理入口（`proxy/listener.rs`）與 CLI 的 `telepy proxy`（`#[path]` 共用這個檔）是同一份。
//! Reading HTTP proxy requests (pure, no dependencies): `CONNECT host:port` and `GET http://host/path`, the latter
//! rewritten to origin-form. The backend's proxy endpoint (`proxy/listener.rs`) and the CLI's `telepy proxy`
//! (`#[path]`-shared) use this one file.

/// 客戶端想連哪裡，以及（一般 HTTP 請求時）要先送給目標的那段改寫過的請求。
/// Where the client wants to go and, for a plain HTTP request, the rewritten request to send to the target first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    pub host: String,
    pub port: u16,
    /// `CONNECT`：None（回 200 後原樣轉接）。一般請求：改成 origin-form 的請求標頭。
    /// `CONNECT`: None (answer 200, then relay as is). A plain request: its head rewritten to origin-form.
    pub head: Option<Vec<u8>>,
}

/// `host:port` / `[v6]:port`；沒有 port 用 `default`。/ `host:port` or `[v6]:port`; `default` without a port.
pub fn host_port(raw: &str, default: u16) -> Option<(String, u16)> {
    let (host, port) = if let Some(rest) = raw.strip_prefix('[') {
        let (h, tail) = rest.split_once(']')?;
        (h, tail.strip_prefix(':'))
    } else {
        match raw.rsplit_once(':') {
            Some((h, p)) if !h.contains(':') => (h, Some(p)),
            _ => (raw, None),
        }
    };
    let port = match port {
        Some(p) => p.parse::<u16>().ok().filter(|p| *p > 0)?,
        None => default,
    };
    (!host.is_empty()).then(|| (host.to_string(), port))
}

/// 讀一個 HTTP 代理請求的標頭（到空行為止，含空行）。`CONNECT host:port` → 目標；`GET http://host/path` → 目標 +
/// 改成 `GET /path` 的請求（拿掉 `Proxy-*` 標頭、加 `Connection: close`：一條代理連線只服務一個請求，下一個請求客戶端
/// 會再連一次，就不用在中間解析回應）。
/// Reads the head of an HTTP proxy request (through the blank line). `CONNECT host:port` → the target; `GET
/// http://host/path` → the target and the request rewritten to `GET /path` (the `Proxy-*` headers dropped and
/// `Connection: close` added: one proxy connection serves one request, the client reconnects for the next, and no
/// response parsing is needed in between).
pub fn parse_request(head: &[u8]) -> std::result::Result<Wanted, String> {
    let text = std::str::from_utf8(head).map_err(|_| "the request is not text".to_string())?;
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else {
        return Err("not an HTTP request".into());
    };
    if !version.starts_with("HTTP/1.") {
        return Err(format!("only HTTP/1.x proxy requests are understood, got {version}"));
    }
    if method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = host_port(target, 443).ok_or_else(|| format!("CONNECT needs host:port, got {target}"))?;
        return Ok(Wanted { host, port, head: None });
    }
    let rest = target.strip_prefix("http://").ok_or_else(|| {
        if target.starts_with("https://") {
            "for https use CONNECT (every ordinary client does)".to_string()
        } else {
            format!("this is a proxy: the request must name a full URL, got {target}")
        }
    })?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    // 帳密寫在網址裡的不轉（user:pass@host）。/ Credentials inside the URL are not forwarded.
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let (host, port) = host_port(authority, 80).ok_or_else(|| format!("no host in {target}"))?;
    let mut out = format!("{method} {path} {version}\r\n");
    let mut has_host = false;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let name = line.split(':').next().unwrap_or_default().trim().to_ascii_lowercase();
        if name == "proxy-connection" || name == "proxy-authorization" || name == "connection" || name == "keep-alive" {
            continue;
        }
        has_host |= name == "host";
        out.push_str(line);
        out.push_str("\r\n");
    }
    if !has_host {
        out.push_str(&format!("Host: {authority}\r\n"));
    }
    out.push_str("Connection: close\r\n\r\n");
    Ok(Wanted { host, port, head: Some(out.into_bytes()) })
}

/// 標頭的值（名稱不分大小寫；第一個）。/ A header's value (case-insensitive name; the first one).
pub fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n").skip(1).take_while(|l| !l.is_empty()).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_and_plain_requests_are_read() {
        let w = parse_request(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Connection: keep-alive\r\n\r\n").unwrap();
        assert_eq!(w, Wanted { host: "example.com".into(), port: 443, head: None });
        assert_eq!(parse_request(b"CONNECT [fd00::1]:8443 HTTP/1.1\r\n\r\n").unwrap().host, "fd00::1");
        // 一般請求：改成 origin-form、拿掉給代理的標頭、一條連線一個請求。/ A plain request: origin-form, proxy headers dropped, one request per connection.
        let w = parse_request(b"GET http://192.168.1.20:8080/status?x=1 HTTP/1.1\r\nHost: 192.168.1.20:8080\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic eDp5\r\nAccept: */*\r\n\r\n").unwrap();
        assert_eq!((w.host.as_str(), w.port), ("192.168.1.20", 8080));
        assert_eq!(String::from_utf8(w.head.unwrap()).unwrap(), "GET /status?x=1 HTTP/1.1\r\nHost: 192.168.1.20:8080\r\nAccept: */*\r\nConnection: close\r\n\r\n");
        let w = parse_request(b"POST http://user:pw@nas.lan HTTP/1.0\r\n\r\n").unwrap();
        assert_eq!((w.host.as_str(), w.port), ("nas.lan", 80));
        assert_eq!(String::from_utf8(w.head.unwrap()).unwrap(), "POST / HTTP/1.0\r\nHost: nas.lan\r\nConnection: close\r\n\r\n", "no path = /, a Host is added, credentials in the URL are dropped");
        assert!(parse_request(b"GET /index.html HTTP/1.1\r\n\r\n").unwrap_err().contains("full URL"));
        assert!(parse_request(b"GET https://example.com/ HTTP/1.1\r\n\r\n").unwrap_err().contains("CONNECT"));
        assert!(parse_request(b"CONNECT example.com:0 HTTP/1.1\r\n\r\n").is_err());
        assert!(parse_request(b"\x16\x03\x01").is_err());
    }

    #[test]
    fn hosts_and_ports_are_split() {
        assert_eq!(host_port("example.com:8443", 80), Some(("example.com".into(), 8443)));
        assert_eq!(host_port("example.com", 80), Some(("example.com".into(), 80)));
        assert_eq!(host_port("[::1]:22", 80), Some(("::1".into(), 22)));
        assert_eq!(host_port("[::1]", 80), Some(("::1".into(), 80)));
        assert_eq!(host_port("x:notaport", 80), None);
        assert_eq!(host_port("", 80), None);
    }

    #[test]
    fn headers_are_found_whatever_their_case() {
        let head = "CONNECT x:443 HTTP/1.1\r\nHost: x:443\r\nproxy-authorization:  Basic abc \r\n\r\nbody: no";
        assert_eq!(header(head, "Proxy-Authorization"), Some("Basic abc"));
        assert_eq!(header(head, "host"), Some("x:443"));
        assert_eq!(header(head, "body"), None, "only the head");
        assert_eq!(header(head, "missing"), None);
    }
}
