//! 區網主機的服務指紋（純函式）：掃描時對網頁 port 送一個 `GET /`（TLS 的先握手讀憑證）、其他 port 只聽它自己先說的
//! 那一行（SSH / FTP / SMTP / VNC / MySQL…）。這裡只負責「送什麼」與「讀回來的怎麼解析」；連線在 `scan.rs`，
//! 「所以這是什麼機器」在 `identify.rs`。**從不對其他 port 送東西**：像 9100（原始列印）收到什麼就印什麼。
//! Service fingerprints for LAN hosts (pure): web ports get one `GET /` (TLS ones a handshake first, to read the
//! certificate); every other port is only listened to for the line it sends by itself (SSH / FTP / SMTP / VNC /
//! MySQL…). This file builds the request and parses what comes back; connections live in `scan.rs`, "so what is this
//! machine" in `identify.rs`. **Nothing is ever sent to other ports**: a raw print port like 9100 prints whatever it gets.

use serde::{Deserialize, Serialize};

/// 一個 port 上認出來的東西。/ What was recognised on one port.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Service {
    pub port: u16,
    /// `http` / `https` / `ssh` / `ftp` / `smtp` / `vnc` / `mysql` / `rtsp` / `raw`（只讀到一行字）。
    pub proto: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// `WWW-Authenticate` 的 realm（路由器、印表機常在這裡寫型號）。/ The Basic-auth realm (often the model name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert: Option<CertInfo>,
    /// 伺服器自己先說的那一行（SSH 版本、FTP 歡迎詞…）。/ The line the server sent by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CertInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    /// 到期（Unix 秒）。/ Expiry, Unix seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_after: Option<i64>,
    pub self_signed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<String>,
}

/// 從不送任何東西的 port：原始列印（9100–9102、515 LPD 收到什麼就印什麼）與會把它當指令的文字協定。
/// Ports that never get anything sent: raw printing (9100–9102 and LPD 515 print whatever arrives) and text protocols
/// that would take it as commands.
pub const NEVER_SEND: &[u16] = &[9100, 9101, 9102, 515, 21, 22, 23, 25, 110, 143, 587, 1883, 3306, 5432, 6379, 27017];

/// 要不要對這個開著的 port 送一個 `GET /`：網頁表裡的 port 一定送；使用者自己列的 port 若沒先說話（不是 SSH / FTP…）、
/// 又不在 [`NEVER_SEND`]，也試一次（自己架的網頁常在奇怪的 port 上）。
/// Whether an open port gets one `GET /`: ports in the web table always; a port the person listed themselves too when
/// it said nothing first and isn't in [`NEVER_SEND`] (self-hosted pages live on odd ports).
pub fn worth_a_get(port: u16, listed: bool, spoke: bool) -> bool {
    if NEVER_SEND.contains(&port) || spoke {
        return false;
    }
    super::web::web_scheme(port).is_some() || listed
}

/// 送給網頁 port 的請求：最小的 GET，帶 Telepy 的 User-Agent（主機的紀錄裡看得出是誰）。
/// The request for a web port: a minimal GET with Telepy's User-Agent (so the host's log says who asked).
pub fn http_request(host: &str, port: u16, default_port: bool) -> Vec<u8> {
    let h = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    let host_header = if default_port { h } else { format!("{h}:{port}") };
    format!("GET / HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: Telepy-LAN-scan (+https://github.com/NatLee/telepy)\r\nAccept: text/html,*/*;q=0.5\r\nConnection: close\r\n\r\n").into_bytes()
}

/// 讀回來的 HTTP 回應 → 狀態、Server、Location、realm、`<title>`。不是 HTTP 回 None。
/// An HTTP response → status, Server, Location, realm, `<title>`. None when it isn't HTTP.
pub fn parse_http(buf: &[u8], tls: bool, port: u16) -> Option<Service> {
    let text = String::from_utf8_lossy(buf);
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.splitn(3, ' ');
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    let status: u16 = parts.next()?.parse().ok()?;
    let mut s = Service { port, proto: if tls { "https" } else { "http" }.into(), status: Some(status), ..Default::default() };
    for line in lines.by_ref() {
        if line.is_empty() {
            break;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = clean(v);
        match k.trim().to_ascii_lowercase().as_str() {
            "server" if !v.is_empty() => s.server = Some(v),
            "location" if !v.is_empty() => s.location = Some(v),
            "www-authenticate" => s.realm = realm_of(&v),
            _ => {}
        }
    }
    let body_at = text.find("\r\n\r\n").map(|i| i + 4).unwrap_or(text.len());
    s.title = title_of(&text[body_at..]);
    Some(s)
}

fn realm_of(header: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    let i = lower.find("realm=")? + 6;
    let rest = header[i..].trim_start_matches('"');
    let end = rest.find('"').unwrap_or(rest.len());
    let r = clean(&rest[..end]);
    (!r.is_empty()).then_some(r)
}

/// `<title>…</title>`：大小寫不分、解開常見的 HTML 實體、空白收成一個、最多 120 字。
/// The `<title>`: case-insensitive, common HTML entities decoded, whitespace collapsed, 120 characters at most.
pub fn title_of(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let t = clean(&decode_entities(&html[start..end]));
    (!t.is_empty()).then_some(t)
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(semi) = tail[..tail.len().min(10)].find(';') else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let name = &tail[1..semi];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// 收空白、去控制字元、最多 120 個字。/ Collapse whitespace, drop control characters, 120 characters at most.
fn clean(s: &str) -> String {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let printable: String = joined.chars().filter(|c| !c.is_control()).collect();
    printable.chars().take(120).collect()
}

/// 伺服器先說的那一行 → (協定, 文字)。SSH、FTP / SMTP 的 220、VNC 的 `RFB 003.008`、MySQL 的握手（二進位，取版本字串）、
/// 其他看得懂的文字就當 `raw`。什麼都沒有 / 看不懂回 None。
/// The line a server sends first → (protocol, text): SSH, FTP / SMTP `220`, VNC `RFB 003.008`, the MySQL handshake
/// (binary; its version string), other readable text as `raw`. None for nothing or noise.
pub fn parse_banner(buf: &[u8]) -> Option<(&'static str, String)> {
    if buf.is_empty() {
        return None;
    }
    // MySQL：4 位元組封包頭 + 協定版本 10 + 以 NUL 結尾的版本字串。/ MySQL: 4-byte header, protocol 10, NUL-terminated version.
    if buf.len() > 6 && buf[4] == 10 {
        if let Some(end) = buf[5..].iter().position(|b| *b == 0) {
            let v = String::from_utf8_lossy(&buf[5..5 + end]).to_string();
            if !v.is_empty() && v.chars().all(|c| c.is_ascii_graphic()) {
                let name = if v.to_ascii_lowercase().contains("mariadb") { "MariaDB" } else { "MySQL" };
                return Some(("mysql", format!("{name} {}", v.trim_end_matches("-log"))));
            }
        }
    }
    let line = String::from_utf8_lossy(buf);
    let line = clean(line.lines().next().unwrap_or(""));
    if line.len() < 3 || line.chars().filter(|c| c.is_alphanumeric()).count() < 3 {
        return None;
    }
    let proto = if line.starts_with("SSH-") {
        "ssh"
    } else if line.starts_with("RFB ") {
        "vnc"
    } else if line.starts_with("220") && line.to_ascii_lowercase().contains("ftp") {
        "ftp"
    } else if line.starts_with("220") && (line.contains("SMTP") || line.contains("ESMTP")) {
        "smtp"
    } else if line.starts_with("RTSP/") {
        "rtsp"
    } else {
        "raw"
    };
    Some((proto, line))
}

/// DER 憑證 → 主體、簽發者、組織、到期、自簽、名稱（最多 5 個）。/ A DER certificate → its parts.
pub fn cert_info(der: &[u8]) -> Option<CertInfo> {
    use x509_parser::prelude::*;
    let (_, cert) = X509Certificate::from_der(der).ok()?;
    let cn = |name: &X509Name| name.iter_common_name().next().and_then(|a| a.as_str().ok()).map(clean);
    let org = cert.subject().iter_organization().next().and_then(|a| a.as_str().ok()).map(clean);
    let mut names: Vec<String> = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for n in &san.value.general_names {
            if let GeneralName::DNSName(d) = n {
                if names.len() < 5 {
                    names.push(clean(d));
                }
            }
        }
    }
    Some(CertInfo {
        subject: cn(cert.subject()),
        issuer: cn(cert.issuer()),
        org,
        not_after: Some(cert.validity().not_after.timestamp()),
        self_signed: cert.subject() == cert.issuer(),
        names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_http_answer() {
        let r = b"HTTP/1.1 401 Unauthorized\r\nServer: lighttpd/1.4\r\nWWW-Authenticate: Basic realm=\"TL-WR841N\"\r\n\r\n<html><HEAD><Title>  Router &amp; Admin\n</title></head>";
        let s = parse_http(r, false, 80).unwrap();
        assert_eq!(s.status, Some(401));
        assert_eq!(s.server.as_deref(), Some("lighttpd/1.4"));
        assert_eq!(s.realm.as_deref(), Some("TL-WR841N"));
        assert_eq!(s.title.as_deref(), Some("Router & Admin"));
        assert_eq!(s.proto, "http");
        let r = b"HTTP/1.1 301 Moved\r\nLocation: https://nas.lan:5001/\r\n\r\n";
        assert_eq!(parse_http(r, true, 5000).unwrap().location.as_deref(), Some("https://nas.lan:5001/"));
        assert!(parse_http(b"SSH-2.0-OpenSSH_9.6\r\n", false, 22).is_none());
    }

    #[test]
    fn titles_and_entities() {
        assert_eq!(title_of("<title>Proxmox Virtual Environment</title>").as_deref(), Some("Proxmox Virtual Environment"));
        assert_eq!(title_of("<title lang=\"en\">A&#x26;B &#169; &lt;x&gt;</title>").as_deref(), Some("A&B © <x>"));
        assert_eq!(title_of("<title></title>"), None);
        assert_eq!(title_of("no title here"), None);
        assert_eq!(title_of(&format!("<title>{}</title>", "x".repeat(300))).unwrap().len(), 120);
    }

    #[test]
    fn banners() {
        assert_eq!(parse_banner(b"SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n"), Some(("ssh", "SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13".into())));
        assert_eq!(parse_banner(b"220 (vsFTPd 3.0.5)\r\n").unwrap().0, "ftp");
        assert_eq!(parse_banner(b"220 ProFTPD Server (ftp.lan)\r\n").unwrap().0, "ftp");
        assert_eq!(parse_banner(b"220 mail.lan ESMTP Postfix\r\n").unwrap().0, "smtp");
        assert_eq!(parse_banner(b"RFB 003.008\n").unwrap(), ("vnc", "RFB 003.008".into()));
        let mut mysql = vec![0x4a, 0, 0, 0, 10];
        mysql.extend_from_slice(b"8.0.36\0rest");
        assert_eq!(parse_banner(&mysql).unwrap(), ("mysql", "MySQL 8.0.36".into()));
        let mut maria = vec![0x4a, 0, 0, 0, 10];
        maria.extend_from_slice(b"5.5.5-10.11.6-MariaDB-log\0");
        assert_eq!(parse_banner(&maria).unwrap().1, "MariaDB 5.5.5-10.11.6-MariaDB");
        assert_eq!(parse_banner(b""), None);
        assert_eq!(parse_banner(&[0x00, 0xff, 0x13, 0x10]), None);
    }

    #[test]
    fn which_ports_get_a_request() {
        assert!(worth_a_get(8080, false, false));
        assert!(!worth_a_get(8088, false, false), "not in the table and not listed");
        assert!(worth_a_get(8088, true, false), "listed and silent");
        assert!(!worth_a_get(8088, true, true), "it spoke first (SSH, FTP…)");
        assert!(!worth_a_get(9100, true, false), "raw print ports never get anything");
    }

    #[test]
    fn the_request_names_telepy() {
        let r = String::from_utf8(http_request("192.168.1.10", 8080, false)).unwrap();
        assert!(r.starts_with("GET / HTTP/1.1\r\nHost: 192.168.1.10:8080\r\nUser-Agent: Telepy-LAN-scan"));
        assert!(r.ends_with("\r\n\r\n"));
        assert!(String::from_utf8(http_request("10.0.0.1", 80, true)).unwrap().contains("Host: 10.0.0.1\r\n"));
    }
}
