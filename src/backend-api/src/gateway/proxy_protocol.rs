//! HAProxy PROXY protocol（v1 文字 / v2 二進位）：gateway 前面有 L4 代理（nginx stream、HAProxy `mode tcp`、
//! 雲端 NLB…）時，代理在每條 TCP 連線開頭先送一個 header 說出真正的來源，之後才是 SSH。
//! 只有 `GATEWAY_PROXY_PROTOCOL_FROM` 列出的來源要（也才會被讀）header；其他來源照舊——不然任何人都能自稱別的 IP。
//! 讀取剛好讀到 header 結尾（v1 到 `\r\n`、v2 到宣告的長度），一個 byte 都不多讀，後面的 SSH 資料原封不動。
//! HAProxy PROXY protocol v1/v2 for an L4 proxy in front of the gateway. Only sources listed in
//! GATEWAY_PROXY_PROTOCOL_FROM must (and may) send a header — otherwise anyone could claim any address.
//! Reads stop exactly at the end of the header, so the SSH bytes that follow are untouched.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use tokio::io::{AsyncRead, AsyncReadExt};

const V2_SIGNATURE: [u8; 12] = *b"\r\n\r\n\0\r\nQUIT\n";
/// v1 規格上限（含 `\r\n`）。/ The v1 maximum line length, CRLF included.
const V1_MAX: usize = 107;

/// 可信的代理位址（單一 IP 或 CIDR）。/ Trusted proxy addresses (IPs or CIDRs).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Trusted(Vec<(IpAddr, u8)>);

impl Trusted {
    /// `"10.0.0.5, 10.1.0.0/16, fd00::/8"`；空字串 = 不啟用。/ Comma / space separated; empty = disabled.
    pub fn parse(spec: &str) -> Result<Self, String> {
        let mut out = Vec::new();
        for item in spec.split([',', ' ']).map(str::trim).filter(|s| !s.is_empty()) {
            let (addr, bits) = match item.split_once('/') {
                Some((a, b)) => (a, Some(b)),
                None => (item, None),
            };
            let ip: IpAddr = addr.parse().map_err(|_| format!("not an IP address: {item}"))?;
            let ip = ip.to_canonical();
            let max = if ip.is_ipv4() { 32 } else { 128 };
            let bits = match bits {
                Some(b) => b.parse::<u8>().ok().filter(|b| *b <= max).ok_or_else(|| format!("bad prefix length: {item}"))?,
                None => max,
            };
            out.push((ip, bits));
        }
        Ok(Self(out))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        self.0.iter().any(|(net, bits)| match (net, ip) {
            (IpAddr::V4(n), IpAddr::V4(a)) => prefix_eq(&n.octets(), &a.octets(), *bits),
            (IpAddr::V6(n), IpAddr::V6(a)) => prefix_eq(&n.octets(), &a.octets(), *bits),
            _ => false,
        })
    }
}

fn prefix_eq(a: &[u8], b: &[u8], bits: u8) -> bool {
    let full = (bits / 8) as usize;
    if a[..full] != b[..full] {
        return false;
    }
    let rest = bits % 8;
    rest == 0 || (a[full] ^ b[full]) & (0xffu8 << (8 - rest)) == 0
}

/// header 的意思。/ What a header says.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Header {
    /// 代理轉來的連線，真正的來源。/ A proxied connection and its real source.
    Proxied(SocketAddr),
    /// 代理自己的連線（健康檢查；v1 `UNKNOWN` / v2 `LOCAL`）：沿用 socket 對端。/ The proxy's own connection.
    Local,
}

/// v1：`PROXY TCP4 <src> <dst> <sport> <dport>\r\n`（或 TCP6 / UNKNOWN）。`line` 含結尾的 `\r\n`。
pub fn parse_v1(line: &[u8]) -> Result<Header, String> {
    let text = std::str::from_utf8(line).map_err(|_| "v1 header is not ASCII".to_string())?;
    let text = text.strip_suffix("\r\n").ok_or("v1 header does not end with CRLF")?;
    let parts: Vec<&str> = text.split(' ').collect();
    match parts.as_slice() {
        ["PROXY", "UNKNOWN", ..] => Ok(Header::Local),
        ["PROXY", proto @ ("TCP4" | "TCP6"), src, _dst, sport, _dport] => {
            let ip: IpAddr = src.parse().map_err(|_| format!("bad source address {src:?}"))?;
            if (*proto == "TCP4") != ip.is_ipv4() {
                return Err(format!("{proto} with source {src}"));
            }
            let port: u16 = sport.parse().map_err(|_| format!("bad source port {sport:?}"))?;
            Ok(Header::Proxied(SocketAddr::new(ip, port)))
        }
        _ => Err(format!("unrecognised v1 header {text:?}")),
    }
}

/// v2：16 bytes 固定開頭（簽章 + 版本/指令 + 協定族 + 長度）之後的位址區塊。/ v2 address block after the 16-byte prefix.
pub fn parse_v2(prefix: &[u8; 16], body: &[u8]) -> Result<Header, String> {
    if prefix[..12] != V2_SIGNATURE {
        return Err("bad v2 signature".into());
    }
    let (version, command) = (prefix[12] >> 4, prefix[12] & 0x0f);
    if version != 2 {
        return Err(format!("unsupported version {version}"));
    }
    match command {
        0 => return Ok(Header::Local),
        1 => {}
        c => return Err(format!("unknown command {c}")),
    }
    match prefix[13] {
        // TCP over IPv4：src(4) dst(4) sport(2) dport(2)
        0x11 if body.len() >= 12 => {
            let ip = Ipv4Addr::new(body[0], body[1], body[2], body[3]);
            Ok(Header::Proxied(SocketAddr::new(IpAddr::V4(ip), u16::from_be_bytes([body[8], body[9]]))))
        }
        // TCP over IPv6：src(16) dst(16) sport(2) dport(2)
        0x21 if body.len() >= 36 => {
            let mut a = [0u8; 16];
            a.copy_from_slice(&body[..16]);
            Ok(Header::Proxied(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(a)), u16::from_be_bytes([body[32], body[33]]))))
        }
        0x11 | 0x21 => Err("v2 address block too short".into()),
        // UNSPEC / UDP / UNIX：沒有可用的 TCP 來源，當作代理自己的連線。/ No TCP source to use.
        _ => Ok(Header::Local),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProxyError {
    /// 一個 byte 都沒送就斷了（代理的 TCP 健康檢查）：安靜丟掉，不記事件。/ Closed before any byte (a TCP health check).
    Closed,
    Bad(String),
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyError::Closed => f.write_str("closed before sending a PROXY protocol header"),
            ProxyError::Bad(e) => f.write_str(e),
        }
    }
}

/// 從連線開頭讀一個 header，剛好讀到它的結尾。/ Read one header from the start of the stream, and nothing more.
pub async fn read_header<R: AsyncRead + Unpin>(r: &mut R) -> Result<Header, ProxyError> {
    let first = r.read_u8().await.map_err(|_| ProxyError::Closed)?;
    read_rest(r, first).await.map_err(ProxyError::Bad)
}

async fn read_rest<R: AsyncRead + Unpin>(r: &mut R, first: u8) -> Result<Header, String> {
    let io = |e: std::io::Error| format!("read: {e}");
    if first == b'P' {
        let mut line = vec![first];
        while !line.ends_with(b"\r\n") {
            if line.len() >= V1_MAX {
                return Err("v1 header too long".into());
            }
            line.push(r.read_u8().await.map_err(io)?);
        }
        return parse_v1(&line);
    }
    if first == V2_SIGNATURE[0] {
        let mut prefix = [0u8; 16];
        prefix[0] = first;
        r.read_exact(&mut prefix[1..]).await.map_err(io)?;
        let len = u16::from_be_bytes([prefix[14], prefix[15]]) as usize;
        let mut body = vec![0u8; len];
        r.read_exact(&mut body).await.map_err(io)?;
        return parse_v2(&prefix, &body);
    }
    Err("no PROXY protocol header (the proxy must send one)".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sa(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn trusted_matches_ips_and_cidrs() {
        let t = Trusted::parse("10.0.0.5, 172.16.0.0/12 fd00::/8").unwrap();
        assert!(t.contains("10.0.0.5".parse().unwrap()));
        assert!(!t.contains("10.0.0.6".parse().unwrap()));
        assert!(t.contains("172.31.255.1".parse().unwrap()));
        assert!(!t.contains("172.32.0.1".parse().unwrap()));
        assert!(t.contains("fd12::1".parse().unwrap()));
        assert!(t.contains("::ffff:10.0.0.5".parse().unwrap()), "IPv4-mapped peers match IPv4 entries");
        assert!(Trusted::parse("").unwrap().is_empty());
        assert!(Trusted::parse("10.0.0.0/33").is_err());
        assert!(Trusted::parse("proxy.local").is_err());
        assert!(Trusted::parse("0.0.0.0/0").unwrap().contains("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn parses_v1() {
        assert_eq!(parse_v1(b"PROXY TCP4 203.0.113.50 10.0.0.2 40000 2222\r\n"), Ok(Header::Proxied(sa("203.0.113.50:40000"))));
        assert_eq!(parse_v1(b"PROXY TCP6 2001:db8::7 2001:db8::1 51000 2222\r\n"), Ok(Header::Proxied(sa("[2001:db8::7]:51000"))));
        assert_eq!(parse_v1(b"PROXY UNKNOWN\r\n"), Ok(Header::Local));
        assert!(parse_v1(b"PROXY TCP4 203.0.113.50 10.0.0.2 40000 2222\n").is_err(), "LF only");
        assert!(parse_v1(b"PROXY TCP4 2001:db8::7 10.0.0.2 40000 2222\r\n").is_err(), "family mismatch");
        assert!(parse_v1(b"PROXY TCP4 203.0.113.50 10.0.0.2 70000 2222\r\n").is_err(), "port out of range");
        assert!(parse_v1(b"SSH-2.0-OpenSSH_9.8\r\n").is_err());
    }

    fn v2(command: u8, family: u8, body: &[u8]) -> Vec<u8> {
        let mut v = V2_SIGNATURE.to_vec();
        v.push(0x20 | command);
        v.push(family);
        v.extend_from_slice(&(body.len() as u16).to_be_bytes());
        v.extend_from_slice(body);
        v
    }

    #[tokio::test]
    async fn reads_exactly_one_header_and_leaves_the_ssh_bytes() {
        // v1
        let mut data: &[u8] = b"PROXY TCP4 198.51.100.9 10.0.0.2 51234 2222\r\nSSH-2.0-client\r\n";
        assert_eq!(read_header(&mut data).await, Ok(Header::Proxied(sa("198.51.100.9:51234"))));
        assert_eq!(data, b"SSH-2.0-client\r\n");
        // v2, IPv4 + a TLV after the addresses (must be skipped too)
        let mut body = vec![203, 0, 113, 77, 10, 0, 0, 2, 0xc3, 0x50, 0x08, 0xae];
        body.extend_from_slice(&[0x04, 0x00, 0x01, 0xaa]);
        let mut wire = v2(1, 0x11, &body);
        wire.extend_from_slice(b"SSH-2.0-x\r\n");
        let mut slice = wire.as_slice();
        assert_eq!(read_header(&mut slice).await, Ok(Header::Proxied(sa("203.0.113.77:50000"))));
        assert_eq!(slice, b"SSH-2.0-x\r\n");
        // v2 IPv6
        let mut b6 = vec![0u8; 36];
        b6[..16].copy_from_slice(&"2001:db8::42".parse::<Ipv6Addr>().unwrap().octets());
        b6[32..34].copy_from_slice(&443u16.to_be_bytes());
        assert_eq!(read_header(&mut v2(1, 0x21, &b6).as_slice()).await, Ok(Header::Proxied(sa("[2001:db8::42]:443"))));
        // v2 LOCAL (health check) and UNSPEC
        assert_eq!(read_header(&mut v2(0, 0x00, &[]).as_slice()).await, Ok(Header::Local));
        assert_eq!(read_header(&mut v2(1, 0x00, &[]).as_slice()).await, Ok(Header::Local));
        // missing / truncated headers are errors; an empty connection is just "closed"
        assert_eq!(read_header(&mut &b""[..]).await, Err(ProxyError::Closed));
        assert!(matches!(read_header(&mut &b"SSH-2.0-OpenSSH_9.8\r\n"[..]).await, Err(ProxyError::Bad(_))));
        assert!(read_header(&mut &v2(1, 0x11, &[1, 2, 3])[..]).await.is_err());
        assert!(read_header(&mut &b"PROXY TCP4 1.2.3.4"[..]).await.is_err(), "EOF before CRLF");
        let long = [b"PROXY ".as_slice(), &[b'x'; 120]].concat();
        assert!(read_header(&mut long.as_slice()).await.is_err(), "v1 longer than 107 bytes");
    }
}
