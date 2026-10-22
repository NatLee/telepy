//! 使用者的來源 IP 與 User-Agent。後端前面一定有反向代理（Traefik，正式環境再加一層 TLS 代理），
//! 所以 socket 的對端只是代理；真實來源在 `X-Forwarded-For`。那串值「最左邊」是客戶端自己能塞的，
//! 只能從右邊數回來：鏈 = XFF 各段 + socket 對端，跳過 `TRUSTED_PROXY_HOPS` 個可信代理（含 Traefik）。
//! `CLIENT_IP_HEADER`（例 Cloudflare 的 `CF-Connecting-IP`）設定時優先用那個標頭。
//! Client IP and User-Agent. The socket peer is a proxy (Traefik, plus the upstream TLS proxy in
//! production), so the address comes from X-Forwarded-For — read from the right, because the leftmost
//! entries are whatever the client sent: chain = XFF entries + socket peer, skip TRUSTED_PROXY_HOPS
//! trusted proxies (Traefik included). CLIENT_IP_HEADER, when set, wins.

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::{header, request::Parts, HeaderMap};

use crate::config::Config;
use crate::state::AppState;

const USER_AGENT_MAX: usize = 512;

/// 純函式：解析來源 IP。`peer` = socket 對端（測試或沒有 ConnectInfo 時是 None）。
/// 鏈比可信層數還短時取最左邊（只經過可信代理，或根本沒有代理）。
/// Resolve the client address; with fewer entries than trusted hops the leftmost one is used.
pub fn resolve(headers: &HeaderMap, peer: Option<IpAddr>, trusted_hops: usize, header_override: Option<&str>) -> Option<IpAddr> {
    if let Some(name) = header_override {
        let ip = headers.get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).and_then(parse_ip);
        if ip.is_some() {
            return ip;
        }
    }
    let mut chain: Vec<IpAddr> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(parse_ip)
        .collect();
    chain.extend(peer.map(|p| p.to_canonical()));
    let idx = chain.len().checked_sub(1)?.saturating_sub(trusted_hops);
    chain.get(idx).copied()
}

/// `1.2.3.4`、`1.2.3.4:80`、`[::1]:80`、`"::1"`；IPv4-mapped 轉回 IPv4。/ Accepts bare IPs and ip:port forms.
fn parse_ip(s: &str) -> Option<IpAddr> {
    let s = s.trim().trim_matches('"');
    s.parse::<IpAddr>().ok().or_else(|| s.parse::<SocketAddr>().ok().map(|a| a.ip())).map(|ip| ip.to_canonical())
}

/// 一個請求的來源：IP（字串）與 User-Agent（截到 512 字）。/ Where a request came from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClientMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl ClientMeta {
    pub fn from_parts(parts: &Parts, config: &Config) -> Self {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
        Self::from_headers(&parts.headers, peer, config)
    }

    pub fn from_headers(headers: &HeaderMap, peer: Option<IpAddr>, config: &Config) -> Self {
        let ip = resolve(headers, peer, config.trusted_proxy_hops, config.client_ip_header.as_deref()).map(|ip| ip.to_string());
        let user_agent = headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(USER_AGENT_MAX).collect());
        Self { ip, user_agent }
    }
}

impl FromRequestParts<AppState> for ClientMeta {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(Self::from_parts(parts, &state.config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(xff: &[&str]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for v in xff {
            m.append("x-forwarded-for", v.parse().unwrap());
        }
        m
    }
    fn ip(s: &str) -> Option<IpAddr> {
        Some(s.parse().unwrap())
    }
    const TRAEFIK: &str = "172.18.0.5";

    #[test]
    fn walks_the_chain_from_the_right() {
        let traefik = ip(TRAEFIK);
        // Traefik only (hops = 1): Traefik appended the client it saw.
        assert_eq!(resolve(&h(&["198.51.100.7"]), traefik, 1, None), ip("198.51.100.7"));
        // the client can only add entries on the left
        assert_eq!(resolve(&h(&["6.6.6.6, 198.51.100.7"]), traefik, 1, None), ip("198.51.100.7"));
        // upstream TLS proxy + Traefik (hops = 2)
        assert_eq!(resolve(&h(&["6.6.6.6, 198.51.100.7, 10.0.0.2"]), traefik, 2, None), ip("198.51.100.7"));
        // several XFF headers count as one list
        assert_eq!(resolve(&h(&["6.6.6.6", "198.51.100.7"]), traefik, 1, None), ip("198.51.100.7"));
        // no proxy at all: the socket peer
        assert_eq!(resolve(&h(&[]), ip("203.0.113.1"), 1, None), ip("203.0.113.1"));
        // more hops configured than the chain has: leftmost
        assert_eq!(resolve(&h(&["198.51.100.7"]), traefik, 5, None), ip("198.51.100.7"));
        // hops = 0: the socket peer itself
        assert_eq!(resolve(&h(&["198.51.100.7"]), traefik, 0, None), traefik);
        // nothing known
        assert_eq!(resolve(&h(&[]), None, 1, None), None);
    }

    #[test]
    fn parses_ports_brackets_and_mapped_addresses() {
        assert_eq!(resolve(&h(&["198.51.100.7:4711"]), None, 0, None), ip("198.51.100.7"));
        assert_eq!(resolve(&h(&["[2001:db8::1]:443"]), None, 0, None), ip("2001:db8::1"));
        assert_eq!(resolve(&h(&["\"2001:db8::2\""]), None, 0, None), ip("2001:db8::2"));
        assert_eq!(resolve(&h(&[]), ip("::ffff:192.0.2.9"), 0, None), ip("192.0.2.9"));
        // garbage entries are skipped
        assert_eq!(resolve(&h(&["unknown, 198.51.100.7"]), ip(TRAEFIK), 1, None), ip("198.51.100.7"));
    }

    #[test]
    fn header_override_wins_when_present() {
        let mut m = h(&["6.6.6.6"]);
        m.insert("cf-connecting-ip", "203.0.113.50".parse().unwrap());
        assert_eq!(resolve(&m, ip(TRAEFIK), 1, Some("CF-Connecting-IP")), ip("203.0.113.50"));
        // missing / unparseable → falls back to XFF
        assert_eq!(resolve(&h(&["198.51.100.7"]), ip(TRAEFIK), 1, Some("CF-Connecting-IP")), ip("198.51.100.7"));
    }
}
