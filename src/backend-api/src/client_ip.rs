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
    chain.get(chosen_index(chain.len(), trusted_hops)?).copied()
}

/// `1.2.3.4`、`1.2.3.4:80`、`[::1]:80`、`"::1"`；IPv4-mapped 轉回 IPv4。/ Accepts bare IPs and ip:port forms.
fn parse_ip(s: &str) -> Option<IpAddr> {
    let s = s.trim().trim_matches('"');
    s.parse::<IpAddr>().ok().or_else(|| s.parse::<SocketAddr>().ok().map(|a| a.ip())).map(|ip| ip.to_canonical())
}

/// 鏈上被選中那一段的位置（從左數）；鏈是空的回 None。和 [`resolve`] 同一個規則。
/// Index of the chain entry [`resolve`] picks (from the left), or None for an empty chain.
fn chosen_index(len: usize, trusted_hops: usize) -> Option<usize> {
    Some(len.checked_sub(1)?.saturating_sub(trusted_hops))
}

/// 常見「代理把客戶端位址放在這裡」的標頭（診斷時列出來，看哪個能拿來當 `CLIENT_IP_HEADER`）。
/// Headers proxies and CDNs commonly put the client address in; listed by the diagnostic.
pub const CANDIDATE_HEADERS: &[&str] = &["x-real-ip", "forwarded", "cf-connecting-ip", "true-client-ip", "x-client-ip", "fastly-client-ip", "x-cluster-client-ip"];

/// 標頭值裡的位址：`Forwarded` 讀每個 `for=`（RFC 7239），其他依逗號分。
/// Addresses in a header value: each `for=` of `Forwarded` (RFC 7239), comma-separated otherwise.
pub fn header_addresses(name: &str, value: &str) -> Vec<IpAddr> {
    if name.eq_ignore_ascii_case("forwarded") {
        return value
            .split([',', ';'])
            .filter_map(|part| {
                let (k, v) = part.split_once('=')?;
                k.trim().eq_ignore_ascii_case("for").then(|| parse_ip(v)).flatten()
            })
            .collect();
    }
    value.split(',').filter_map(parse_ip).collect()
}

/// 診斷用：鏈上的一段。/ One entry of the chain, for the diagnostic.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ChainEntry {
    pub ip: String,
    pub scope: &'static str,
    /// `forwarded_for`（X-Forwarded-For 的一段）或 `peer`（連進後端的 socket 對端）。
    pub source: &'static str,
    /// `ignored`（被選中那段的左邊：客戶端自己能塞的）、`client`（被選中）、`proxy`（跳過的可信代理）。
    pub role: &'static str,
}

/// 診斷用：一個帶著位址的標頭。/ A header that carries addresses.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct HeaderSeen {
    pub name: String,
    pub value: String,
    pub addresses: Vec<(String, &'static str)>,
}

/// 「Telepy 怎麼看你的位址」的完整結果（純資料；`/api/auth/client-ip-check` 轉成 JSON）。
/// How Telepy resolved this request's address, step by step.
#[derive(Debug, Clone, PartialEq)]
pub struct Diagnosis {
    pub chain: Vec<ChainEntry>,
    pub headers: Vec<HeaderSeen>,
    pub ip: Option<String>,
    pub scope: Option<&'static str>,
    /// `header`（`CLIENT_IP_HEADER`）/ `chain` / None（什麼都不知道）。
    pub from: Option<&'static str>,
    /// ok / hops_too_low / hops_too_high / use_header / header_private / all_private / unknown
    pub verdict: &'static str,
    pub suggest_hops: Option<usize>,
    pub suggest_header: Option<String>,
    /// 這個請求經過的代理比 `TRUSTED_PROXY_HOPS` 少（取了最左邊那段）。/ Fewer proxies than configured.
    pub short_chain: bool,
    /// 設了 `CLIENT_IP_HEADER` 但這個請求沒有它（或讀不出位址）。/ The configured header was missing.
    pub header_absent: bool,
}

fn is_public(ip: IpAddr) -> bool {
    crate::geoip::scope(ip) == crate::geoip::Scope::Public
}

/// 純函式：把 [`resolve`] 的每一步攤開，並判斷問題出在哪、該怎麼設。
/// Spell out every step of [`resolve`] and say what is wrong and what to set.
pub fn diagnose(headers: &HeaderMap, peer: Option<IpAddr>, trusted_hops: usize, header_override: Option<&str>) -> Diagnosis {
    let scope_of = |ip: IpAddr| crate::geoip::scope(ip).as_str();
    let mut raw: Vec<(IpAddr, &'static str)> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(parse_ip)
        .map(|ip| (ip, "forwarded_for"))
        .collect();
    raw.extend(peer.map(|p| (p.to_canonical(), "peer")));
    let idx = chosen_index(raw.len(), trusted_hops);
    let chain: Vec<ChainEntry> = raw
        .iter()
        .enumerate()
        .map(|(i, (ip, source))| ChainEntry {
            ip: ip.to_string(),
            scope: scope_of(*ip),
            source,
            role: match idx {
                Some(c) if i < c => "ignored",
                Some(c) if i == c => "client",
                _ => "proxy",
            },
        })
        .collect();

    let mut seen = Vec::new();
    for name in CANDIDATE_HEADERS.iter().copied().chain(header_override.filter(|h| !CANDIDATE_HEADERS.iter().any(|c| c.eq_ignore_ascii_case(h)))) {
        let values: Vec<&str> = headers.get_all(name).iter().filter_map(|v| v.to_str().ok()).collect();
        if values.is_empty() {
            continue;
        }
        let value = values.join(", ");
        let addresses = header_addresses(name, &value).into_iter().map(|ip| (ip.to_string(), scope_of(ip))).collect();
        seen.push(HeaderSeen { name: name.to_ascii_lowercase(), value: value.chars().take(200).collect(), addresses });
    }

    let resolved = resolve(headers, peer, trusted_hops, header_override);
    // resolve 的同一個規則：設定的標頭有讀得出的位址就用它。/ Same rule as `resolve`.
    let from_header = header_override.is_some_and(|h| headers.get(h).and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).and_then(parse_ip).is_some());
    let header_absent = header_override.is_some() && !from_header;
    let short_chain = !raw.is_empty() && raw.len() <= trusted_hops;
    let from = match (resolved, from_header) {
        (None, _) => None,
        (Some(_), true) => Some("header"),
        (Some(_), false) => Some("chain"),
    };

    let (mut verdict, mut suggest_hops, mut suggest_header) = ("unknown", None, None);
    match resolved {
        Some(ip) if is_public(ip) => verdict = "ok",
        // 指定的標頭本身就是內部位址：那個標頭不對（或上游沒設好）。/ The configured header itself is internal.
        Some(_) if from_header => verdict = "header_private",
        Some(_) => {
            let c = idx.unwrap_or(0);
            let left = (0..c).rev().find(|&i| is_public(raw[i].0));
            let right = (c + 1..raw.len()).find(|&i| is_public(raw[i].0));
            let header = seen.iter().find(|h| h.addresses.iter().any(|(_, s)| *s == "public"));
            if let Some(i) = left {
                verdict = "hops_too_low";
                suggest_hops = Some(raw.len() - 1 - i);
            } else if let Some(i) = right {
                verdict = "hops_too_high";
                suggest_hops = Some(raw.len() - 1 - i);
            } else if let Some(h) = header {
                verdict = "use_header";
                suggest_header = Some(h.name.clone());
            } else {
                verdict = "all_private";
            }
        }
        None => {}
    }
    Diagnosis {
        chain,
        headers: seen,
        ip: resolved.map(|ip| ip.to_string()),
        scope: resolved.map(scope_of),
        from,
        verdict,
        suggest_hops,
        suggest_header,
        short_chain,
        header_absent,
    }
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

    fn d(xff: &[&str], extra: &[(&str, &str)], hops: usize, over: Option<&str>) -> Diagnosis {
        let mut m = h(xff);
        for (k, v) in extra {
            m.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        diagnose(&m, ip(TRAEFIK), hops, over)
    }

    #[test]
    fn diagnosis_marks_each_hop_and_agrees_with_resolve() {
        let r = d(&["6.6.6.6, 198.51.100.7, 10.0.0.2"], &[], 2, None);
        assert_eq!(r.ip.as_deref(), Some("198.51.100.7"));
        assert_eq!((r.verdict, r.from, r.scope), ("ok", Some("chain"), Some("public")));
        let roles: Vec<_> = r.chain.iter().map(|e| (e.ip.as_str(), e.source, e.role)).collect();
        assert_eq!(
            roles,
            vec![
                ("6.6.6.6", "forwarded_for", "ignored"),
                ("198.51.100.7", "forwarded_for", "client"),
                ("10.0.0.2", "forwarded_for", "proxy"),
                (TRAEFIK, "peer", "proxy"),
            ]
        );
        assert!(!r.short_chain);
    }

    #[test]
    fn every_hop_private_means_the_proxy_lost_the_address() {
        // 正式環境的樣子：上游代理的 Docker 把每個人都換成 172.19.0.1，OrbStack 再換一次。
        // What production sees: the upstream proxy's Docker hands everyone 172.19.0.1, OrbStack rewrites once more.
        let r = d(&["172.19.0.1, 192.168.167.1"], &[("x-real-ip", "172.19.0.1")], 2, None);
        assert_eq!(r.ip.as_deref(), Some("172.19.0.1"));
        assert_eq!(r.verdict, "all_private");
        assert_eq!((r.suggest_hops, r.suggest_header.as_deref()), (None, None));
        assert_eq!(r.headers[0].name, "x-real-ip");
        assert_eq!(r.headers[0].addresses, vec![("172.19.0.1".to_string(), "private")]);
    }

    #[test]
    fn suggests_hops_and_headers() {
        // 少算一層：公網位址在被選中那段的左邊。/ One hop too few: the public address is left of the chosen one.
        let r = d(&["198.51.100.7, 10.0.0.2"], &[], 1, None);
        assert_eq!((r.verdict, r.suggest_hops), ("hops_too_low", Some(2)));
        // 多算一層：選到客戶端那側的內部位址，公網的在右邊被當成代理跳過。
        let r = d(&["10.9.9.9, 198.51.100.7, 10.0.0.2"], &[], 3, None);
        assert_eq!((r.verdict, r.suggest_hops), ("hops_too_high", Some(2)));
        // 鏈上都是內部位址，但 CDN 標頭有公網位址。/ Only a CDN header has the public address.
        let r = d(&["172.19.0.1"], &[("cf-connecting-ip", "203.0.113.50")], 1, None);
        assert_eq!((r.verdict, r.suggest_header.as_deref()), ("use_header", Some("cf-connecting-ip")));
        // 經過的代理比設定少。/ Fewer proxies than configured.
        let r = d(&[], &[], 2, None);
        assert!(r.short_chain);
        assert_eq!(r.chain[0].role, "client");
    }

    #[test]
    fn diagnosis_reports_the_configured_header() {
        let r = d(&["172.19.0.1"], &[("cf-connecting-ip", "203.0.113.50")], 1, Some("CF-Connecting-IP"));
        assert_eq!((r.ip.as_deref(), r.from, r.verdict, r.header_absent), (Some("203.0.113.50"), Some("header"), "ok", false));
        let r = d(&["198.51.100.7"], &[], 1, Some("CF-Connecting-IP"));
        assert_eq!((r.from, r.header_absent, r.verdict), (Some("chain"), true, "ok"));
        let r = d(&["198.51.100.7"], &[("x-client", "10.1.1.1")], 1, Some("X-Client"));
        assert_eq!((r.verdict, r.from), ("header_private", Some("header")));
        assert!(r.headers.iter().any(|h| h.name == "x-client"), "the configured header is listed too");
    }

    #[test]
    fn forwarded_header_reads_every_for() {
        let v = "for=192.0.2.60;proto=http;by=203.0.113.43, for=\"[2001:db8:cafe::17]:4711\"";
        assert_eq!(header_addresses("Forwarded", v), vec!["192.0.2.60".parse::<IpAddr>().unwrap(), "2001:db8:cafe::17".parse().unwrap()]);
        assert_eq!(header_addresses("x-real-ip", " 198.51.100.7 "), vec!["198.51.100.7".parse::<IpAddr>().unwrap()]);
    }
}
