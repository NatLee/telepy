//! 使用者的來源 IP 與 User-Agent。後端前面一定有反向代理（Traefik，正式環境再加一層 TLS 代理），
//! 所以 socket 的對端只是代理；真實來源在 `X-Forwarded-For`。那串值「最左邊」是客戶端自己能塞的，
//! 只能從右邊數回來：鏈 = XFF 各段 + socket 對端。`TRUSTED_PROXY_HOPS=auto`（預設）把每一段內部位址都當成
//! 代理跳過，取從右邊數來第一個公網位址——Traefik、前面的 Nginx Proxy Manager / Caddy 都在內網，不必數
//! 幾層；設數字就跳過固定那麼多段（含 Traefik）。`CLIENT_IP_HEADER`（例 Cloudflare 的 `CF-Connecting-IP`）
//! 設定時優先用那個標頭。
//! Client IP and User-Agent. The socket peer is a proxy (Traefik, plus the upstream TLS proxy in
//! production), so the address comes from X-Forwarded-For — read from the right, because the leftmost
//! entries are whatever the client sent: chain = XFF entries + socket peer. `TRUSTED_PROXY_HOPS=auto` (the
//! default) skips every internal address as a proxy and takes the first public one from the right — Traefik and
//! an upstream Nginx Proxy Manager / Caddy all sit on internal addresses, so nobody has to count them; a number
//! skips exactly that many entries (Traefik included). CLIENT_IP_HEADER, when set, wins.

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::{header, request::Parts, HeaderMap};

use crate::config::Config;
use crate::server_settings::{is_cloudflare, Cloudflare};
use crate::state::AppState;

const USER_AGENT_MAX: usize = 512;

/// `TRUSTED_PROXY_HOPS`：`auto`（內部位址都是代理）或固定層數。/ The hop rule: automatic or a fixed count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Hops {
    /// 從右邊跳過每一段內部位址，取第一個公網位址；一個都沒有就取最左邊。
    /// Skip every internal address from the right and take the first public one; none public = the leftmost.
    #[default]
    Auto,
    /// 從右邊跳過固定這麼多段（含 Traefik）。/ Skip exactly this many entries from the right (Traefik included).
    Fixed(usize),
}

impl Hops {
    /// 環境變數的值：沒設、空白或 `auto` = 自動；非負整數 = 固定；其他 = 自動（而不是悄悄變成某個數字）。
    /// The env value: unset, blank or `auto` = automatic; a non-negative integer = fixed; anything else = automatic.
    pub fn parse(value: Option<&str>) -> Hops {
        match value.map(str::trim).filter(|v| !v.is_empty()) {
            None => Hops::Auto,
            Some(v) if v.eq_ignore_ascii_case("auto") => Hops::Auto,
            Some(v) => v.parse().map(Hops::Fixed).unwrap_or(Hops::Auto),
        }
    }

    /// 設定值的寫法（`auto` / `2`）。/ The setting as written (`auto` / `2`).
    pub fn setting(self) -> String {
        match self {
            Hops::Auto => "auto".to_string(),
            Hops::Fixed(n) => n.to_string(),
        }
    }

    pub fn fixed(self) -> Option<usize> {
        match self {
            Hops::Auto => None,
            Hops::Fixed(n) => Some(n),
        }
    }
}

/// 純函式：解析來源 IP。`peer` = socket 對端（測試或沒有 ConnectInfo 時是 None）。
/// 固定層數時，鏈比層數還短就取最左邊（只經過可信代理，或根本沒有代理）。不看 `CF-Connecting-IP`（見 [`resolve_with`]）。
/// Resolve the client address; with a fixed count and fewer entries than that, the leftmost one is used.
/// Ignores `CF-Connecting-IP` (see [`resolve_with`]).
pub fn resolve(headers: &HeaderMap, peer: Option<IpAddr>, trusted_hops: Hops, header_override: Option<&str>) -> Option<IpAddr> {
    resolve_with(headers, peer, trusted_hops, header_override, Cloudflare::Off)
}

/// 標頭第一個逗號前的位址。/ The address before a header's first comma.
fn first_ip(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    headers.get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).and_then(|part| part_ip(name, part))
}

/// 標頭值裡一段的位址。CloudFront-Viewer-Address 是 `位址:port`，IPv6 不加括號（`2001:db8::1:46532`），
/// 一般的解析會把 port 當成位址的一段，所以這個標頭一律去掉最後一個 `:port`。
/// One part of a header value. CloudFront-Viewer-Address is `address:port` with an unbracketed IPv6
/// (`2001:db8::1:46532`), which a plain parse would read as part of the address, so its last `:port` is always cut.
fn part_ip(name: &str, part: &str) -> Option<IpAddr> {
    if name.eq_ignore_ascii_case("cloudfront-viewer-address") {
        let (addr, port) = part.trim().rsplit_once(':')?;
        port.parse::<u16>().ok()?;
        return parse_ip(addr.trim_start_matches('[').trim_end_matches(']'));
    }
    parse_ip(part)
}

/// [`resolve`] 加上 Cloudflare：指定的標頭優先；`always` = 有 `CF-Connecting-IP` 就用；`auto` = 鏈上被選中的那段是
/// Cloudflare 的位址時才用它（沒有從 Cloudflare 連進來就偽造不了）；`off` = 不看。
/// [`resolve`] plus Cloudflare: the configured header first; `always` = `CF-Connecting-IP` whenever it parses; `auto` =
/// only when the chain's chosen hop is a Cloudflare address (unspoofable without connecting from Cloudflare); `off` = ignored.
pub fn resolve_with(headers: &HeaderMap, peer: Option<IpAddr>, trusted_hops: Hops, header_override: Option<&str>, cloudflare: Cloudflare) -> Option<IpAddr> {
    resolve_traced(headers, peer, trusted_hops, header_override, cloudflare).0
}

/// 同 [`resolve_with`]，另外說位址從哪來：`header` / `cloudflare` / `chain`。/ Also says where it came from.
fn resolve_traced(headers: &HeaderMap, peer: Option<IpAddr>, trusted_hops: Hops, header_override: Option<&str>, cloudflare: Cloudflare) -> (Option<IpAddr>, Option<&'static str>) {
    if let Some(ip) = header_override.and_then(|name| first_ip(headers, name)) {
        return (Some(ip), Some("header"));
    }
    let cf = first_ip(headers, CF_HEADER);
    if let (Cloudflare::Always, Some(ip)) = (cloudflare, cf) {
        return (Some(ip), Some("cloudflare"));
    }
    let mut chain: Vec<IpAddr> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(parse_ip)
        .collect();
    chain.extend(peer.map(|p| p.to_canonical()));
    let chosen = chosen_index(&chain, trusted_hops).and_then(|i| chain.get(i).copied());
    match (cloudflare, chosen, cf) {
        (Cloudflare::Auto, Some(hop), Some(ip)) if is_cloudflare(hop) => (Some(ip), Some("cloudflare")),
        (_, Some(hop), _) => (Some(hop), Some("chain")),
        _ => (None, None),
    }
}

/// Cloudflare 放訪客位址的標頭。/ The header Cloudflare puts the visitor's address in.
pub const CF_HEADER: &str = "cf-connecting-ip";

/// `1.2.3.4`、`1.2.3.4:80`、`[::1]:80`、`"::1"`；IPv4-mapped 轉回 IPv4。/ Accepts bare IPs and ip:port forms.
fn parse_ip(s: &str) -> Option<IpAddr> {
    let s = s.trim().trim_matches('"');
    s.parse::<IpAddr>().ok().or_else(|| s.parse::<SocketAddr>().ok().map(|a| a.ip())).map(|ip| ip.to_canonical())
}

/// 鏈上被選中那一段的位置（從左數）；鏈是空的回 None。和 [`resolve`] 同一個規則。
/// Index of the chain entry [`resolve`] picks (from the left), or None for an empty chain.
fn chosen_index(chain: &[IpAddr], trusted_hops: Hops) -> Option<usize> {
    let last = chain.len().checked_sub(1)?;
    Some(match trusted_hops {
        Hops::Fixed(n) => last.saturating_sub(n),
        Hops::Auto => chain.iter().rposition(|ip| is_public(*ip)).unwrap_or(0),
    })
}

/// 常見「代理把客戶端位址放在這裡」的標頭（診斷時列出來，看哪個能拿來當 `CLIENT_IP_HEADER`）。前端的
/// `lib/clientIpHeaders.ts` 說明每個是誰送的，它的測試會讀這份清單。
/// Headers proxies and CDNs commonly put the client address in; listed by the diagnostic. The frontend's
/// `lib/clientIpHeaders.ts` says who sends each, and its test reads this list.
pub const CANDIDATE_HEADERS: &[&str] = &[
    "x-real-ip",
    "forwarded",
    "cf-connecting-ip",
    "true-client-ip",
    "x-client-ip",
    "fastly-client-ip",
    "x-cluster-client-ip",
    "cloudfront-viewer-address",
    "x-azure-clientip",
    "fly-client-ip",
    "do-connecting-ip",
];

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
    value.split(',').filter_map(|part| part_ip(name, part)).collect()
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
    /// 這個請求經過的代理比 `TRUSTED_PROXY_HOPS` 少（取了最左邊那段）；自動模式永遠 false。
    /// Fewer proxies than configured (never in auto mode).
    pub short_chain: bool,
    /// 設了 `CLIENT_IP_HEADER` 但這個請求沒有它（或讀不出位址）。/ The configured header was missing.
    pub header_absent: bool,
    /// 這個請求實際被當成代理跳過的段數（自動模式下才有意思）。/ Entries skipped as proxies on this request.
    pub skipped_hops: usize,
    /// Cloudflare 那一段怎麼判斷。/ How Cloudflare was judged.
    pub cloudflare: CloudflareSeen,
    /// 額外的提示碼（`cloudflare_masked`）。/ Extra hint codes (`cloudflare_masked`).
    pub hints: Vec<&'static str>,
}

/// 診斷用：`CF-Connecting-IP` 與 Cloudflare 的邊緣節點。/ `CF-Connecting-IP` and Cloudflare's edge, for the diagnostic.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CloudflareSeen {
    /// auto / always / off
    pub mode: &'static str,
    /// `CF-Connecting-IP` 的原文（沒有 = None）。/ The header as sent, if any.
    pub header: Option<String>,
    /// 鏈上有 Cloudflare 的位址。/ A Cloudflare address is on the chain.
    pub edge_seen: bool,
    /// 位址取自 `CF-Connecting-IP`。/ The address was taken from `CF-Connecting-IP`.
    pub used: bool,
}

fn is_public(ip: IpAddr) -> bool {
    crate::geoip::scope(ip) == crate::geoip::Scope::Public
}

/// 純函式：把 [`resolve`] 的每一步攤開，並判斷問題出在哪、該怎麼設。
/// Spell out every step of [`resolve`] and say what is wrong and what to set.
pub fn diagnose(headers: &HeaderMap, peer: Option<IpAddr>, trusted_hops: Hops, header_override: Option<&str>) -> Diagnosis {
    diagnose_with(headers, peer, trusted_hops, header_override, Cloudflare::Off)
}

/// [`diagnose`] 加上 Cloudflare 的用法（跟 [`resolve_with`] 同一個規則）。/ [`diagnose`] with the Cloudflare mode.
pub fn diagnose_with(headers: &HeaderMap, peer: Option<IpAddr>, trusted_hops: Hops, header_override: Option<&str>, cloudflare: Cloudflare) -> Diagnosis {
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
    let ips: Vec<IpAddr> = raw.iter().map(|(ip, _)| *ip).collect();
    let idx = chosen_index(&ips, trusted_hops);
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

    let (resolved, source) = resolve_traced(headers, peer, trusted_hops, header_override, cloudflare);
    let from_header = source == Some("header");
    let cf_used = source == Some("cloudflare");
    // 以下的判斷把 Cloudflare 標頭當成「指定的標頭」一樣看。/ Below, the Cloudflare header counts like a configured one.
    let via_header = from_header || cf_used;
    let header_absent = header_override.is_some() && !from_header;
    let cf_raw: Option<String> = headers.get(CF_HEADER).and_then(|v| v.to_str().ok()).map(|v| v.chars().take(200).collect());
    let edge_seen = raw.iter().any(|(ip, _)| is_cloudflare(*ip));
    let mut hints = Vec::new();
    // 有 CF-Connecting-IP 卻看不到 Cloudflare 的位址：前面還有一層代理把它換掉了（例如 Docker 裡的 NPM）。
    // The header is there but no Cloudflare address is: a proxy in front replaced it (NPM in Docker, say).
    if cloudflare == Cloudflare::Auto && cf_raw.is_some() && !edge_seen && !from_header {
        hints.push("cloudflare_masked");
    }
    let short_chain = trusted_hops.fixed().is_some_and(|n| !raw.is_empty() && raw.len() <= n);
    let skipped_hops = match idx {
        Some(c) => raw.len() - 1 - c,
        None => 0,
    };
    let from = source;

    let (mut verdict, mut suggest_hops, mut suggest_header) = ("unknown", None, None);
    match resolved {
        // 自動模式取的是最右邊的公網位址；它左邊還有公網位址 = 前面有一層公網 IP 的代理（例如 VPS 上的 Nginx），
        // 被當成訪客了。自己的瀏覽器不會塞 X-Forwarded-For，所以這裡不是偽造。固定層數時左邊的公網位址才是訪客能塞的。
        // Auto takes the rightmost public address; another public one left of it = a proxy with a public IP (a VPS
        // nginx, say) taken for the visitor. The admin's own browser sends no X-Forwarded-For, so this is not a spoof.
        Some(ip) if is_public(ip) && !via_header && trusted_hops == Hops::Auto && idx.is_some_and(|c| (0..c).any(|i| is_public(raw[i].0))) => {
            let c = idx.unwrap_or(0);
            let i = (0..c).rev().find(|&i| is_public(raw[i].0)).unwrap_or(0);
            verdict = "hops_too_low";
            suggest_hops = Some(raw.len() - 1 - i);
        }
        Some(ip) if is_public(ip) => verdict = "ok",
        // 指定的標頭本身就是內部位址：那個標頭不對（或上游沒設好）。/ The configured header itself is internal.
        Some(_) if via_header => verdict = "header_private",
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
        skipped_hops,
        cloudflare: CloudflareSeen { mode: cloudflare.as_str(), header: cf_raw, edge_seen, used: cf_used },
        hints,
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
        // 用的當下讀生效的設定（環境變數 → 網站設定 → 預設）。/ The settings in effect, read now.
        let header = config.client_ip_header_name();
        let ip = resolve_with(headers, peer, config.client_ip_hops(), header.as_deref(), config.client_ip_cloudflare()).map(|ip| ip.to_string());
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
        assert_eq!(resolve(&h(&["198.51.100.7"]), traefik, Hops::Fixed(1), None), ip("198.51.100.7"));
        // the client can only add entries on the left
        assert_eq!(resolve(&h(&["6.6.6.6, 198.51.100.7"]), traefik, Hops::Fixed(1), None), ip("198.51.100.7"));
        // upstream TLS proxy + Traefik (hops = 2)
        assert_eq!(resolve(&h(&["6.6.6.6, 198.51.100.7, 10.0.0.2"]), traefik, Hops::Fixed(2), None), ip("198.51.100.7"));
        // several XFF headers count as one list
        assert_eq!(resolve(&h(&["6.6.6.6", "198.51.100.7"]), traefik, Hops::Fixed(1), None), ip("198.51.100.7"));
        // no proxy at all: the socket peer
        assert_eq!(resolve(&h(&[]), ip("203.0.113.1"), Hops::Fixed(1), None), ip("203.0.113.1"));
        // more hops configured than the chain has: leftmost
        assert_eq!(resolve(&h(&["198.51.100.7"]), traefik, Hops::Fixed(5), None), ip("198.51.100.7"));
        // hops = 0: the socket peer itself
        assert_eq!(resolve(&h(&["198.51.100.7"]), traefik, Hops::Fixed(0), None), traefik);
        // nothing known
        assert_eq!(resolve(&h(&[]), None, Hops::Fixed(1), None), None);
    }

    #[test]
    fn parses_ports_brackets_and_mapped_addresses() {
        assert_eq!(resolve(&h(&["198.51.100.7:4711"]), None, Hops::Fixed(0), None), ip("198.51.100.7"));
        assert_eq!(resolve(&h(&["[2001:db8::1]:443"]), None, Hops::Fixed(0), None), ip("2001:db8::1"));
        assert_eq!(resolve(&h(&["\"2001:db8::2\""]), None, Hops::Fixed(0), None), ip("2001:db8::2"));
        assert_eq!(resolve(&h(&[]), ip("::ffff:192.0.2.9"), Hops::Fixed(0), None), ip("192.0.2.9"));
        // garbage entries are skipped
        assert_eq!(resolve(&h(&["unknown, 198.51.100.7"]), ip(TRAEFIK), Hops::Fixed(1), None), ip("198.51.100.7"));
    }

    #[test]
    fn header_override_wins_when_present() {
        let mut m = h(&["6.6.6.6"]);
        m.insert("cf-connecting-ip", "203.0.113.50".parse().unwrap());
        assert_eq!(resolve(&m, ip(TRAEFIK), Hops::Fixed(1), Some("CF-Connecting-IP")), ip("203.0.113.50"));
        // missing / unparseable → falls back to XFF
        assert_eq!(resolve(&h(&["198.51.100.7"]), ip(TRAEFIK), Hops::Fixed(1), Some("CF-Connecting-IP")), ip("198.51.100.7"));
    }

    fn d(xff: &[&str], extra: &[(&str, &str)], hops: Hops, over: Option<&str>) -> Diagnosis {
        let mut m = h(xff);
        for (k, v) in extra {
            m.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        diagnose(&m, ip(TRAEFIK), hops, over)
    }

    #[test]
    fn diagnosis_marks_each_hop_and_agrees_with_resolve() {
        let r = d(&["6.6.6.6, 198.51.100.7, 10.0.0.2"], &[], Hops::Fixed(2), None);
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
        let r = d(&["172.19.0.1, 192.168.167.1"], &[("x-real-ip", "172.19.0.1")], Hops::Fixed(2), None);
        assert_eq!(r.ip.as_deref(), Some("172.19.0.1"));
        assert_eq!(r.verdict, "all_private");
        assert_eq!((r.suggest_hops, r.suggest_header.as_deref()), (None, None));
        assert_eq!(r.headers[0].name, "x-real-ip");
        assert_eq!(r.headers[0].addresses, vec![("172.19.0.1".to_string(), "private")]);
    }

    #[test]
    fn suggests_hops_and_headers() {
        // 少算一層：公網位址在被選中那段的左邊。/ One hop too few: the public address is left of the chosen one.
        let r = d(&["198.51.100.7, 10.0.0.2"], &[], Hops::Fixed(1), None);
        assert_eq!((r.verdict, r.suggest_hops), ("hops_too_low", Some(2)));
        // 多算一層：選到客戶端那側的內部位址，公網的在右邊被當成代理跳過。
        let r = d(&["10.9.9.9, 198.51.100.7, 10.0.0.2"], &[], Hops::Fixed(3), None);
        assert_eq!((r.verdict, r.suggest_hops), ("hops_too_high", Some(2)));
        // 鏈上都是內部位址，但 CDN 標頭有公網位址。/ Only a CDN header has the public address.
        let r = d(&["172.19.0.1"], &[("cf-connecting-ip", "203.0.113.50")], Hops::Fixed(1), None);
        assert_eq!((r.verdict, r.suggest_header.as_deref()), ("use_header", Some("cf-connecting-ip")));
        // 經過的代理比設定少。/ Fewer proxies than configured.
        let r = d(&[], &[], Hops::Fixed(2), None);
        assert!(r.short_chain);
        assert_eq!(r.chain[0].role, "client");
    }

    #[test]
    fn diagnosis_reports_the_configured_header() {
        let r = d(&["172.19.0.1"], &[("cf-connecting-ip", "203.0.113.50")], Hops::Fixed(1), Some("CF-Connecting-IP"));
        assert_eq!((r.ip.as_deref(), r.from, r.verdict, r.header_absent), (Some("203.0.113.50"), Some("header"), "ok", false));
        let r = d(&["198.51.100.7"], &[], Hops::Fixed(1), Some("CF-Connecting-IP"));
        assert_eq!((r.from, r.header_absent, r.verdict), (Some("chain"), true, "ok"));
        let r = d(&["198.51.100.7"], &[("x-client", "10.1.1.1")], Hops::Fixed(1), Some("X-Client"));
        assert_eq!((r.verdict, r.from), ("header_private", Some("header")));
        assert!(r.headers.iter().any(|h| h.name == "x-client"), "the configured header is listed too");
    }

    #[test]
    fn forwarded_header_reads_every_for() {
        let v = "for=192.0.2.60;proto=http;by=203.0.113.43, for=\"[2001:db8:cafe::17]:4711\"";
        assert_eq!(header_addresses("Forwarded", v), vec!["192.0.2.60".parse::<IpAddr>().unwrap(), "2001:db8:cafe::17".parse().unwrap()]);
        assert_eq!(header_addresses("x-real-ip", " 198.51.100.7 "), vec!["198.51.100.7".parse::<IpAddr>().unwrap()]);
    }

    #[test]
    fn auto_skips_every_internal_address_from_the_right() {
        let traefik = ip(TRAEFIK);
        // Traefik only: the entry Traefik appended is the visitor.
        assert_eq!(resolve(&h(&["198.51.100.7"]), traefik, Hops::Auto, None), ip("198.51.100.7"));
        // Nginx Proxy Manager (internal) in front of Traefik: skipped without counting.
        assert_eq!(resolve(&h(&["198.51.100.7, 10.0.0.2"]), traefik, Hops::Auto, None), ip("198.51.100.7"));
        // the visitor's own entries are left of their real address
        assert_eq!(resolve(&h(&["6.6.6.6, 198.51.100.7, 10.0.0.2"]), traefik, Hops::Auto, None), ip("198.51.100.7"));
        // no public address anywhere (the proxy lost it): the leftmost, like a fixed count that is too high
        assert_eq!(resolve(&h(&["172.19.0.1, 10.0.0.2"]), traefik, Hops::Auto, None), ip("172.19.0.1"));
        // no proxy at all: a public socket peer is the visitor
        assert_eq!(resolve(&h(&[]), ip("203.0.113.1"), Hops::Auto, None), ip("203.0.113.1"));
        assert_eq!(resolve(&h(&[]), None, Hops::Auto, None), None);
    }

    #[test]
    fn hops_setting_parses_auto_numbers_and_junk() {
        assert_eq!(Hops::parse(None), Hops::Auto);
        assert_eq!(Hops::parse(Some("")), Hops::Auto);
        assert_eq!(Hops::parse(Some(" AUTO ")), Hops::Auto);
        assert_eq!(Hops::parse(Some("2")), Hops::Fixed(2));
        assert_eq!(Hops::parse(Some("0")), Hops::Fixed(0));
        assert_eq!(Hops::parse(Some("two")), Hops::Auto);
        assert_eq!((Hops::Auto.setting(), Hops::Fixed(2).setting()), ("auto".to_string(), "2".to_string()));
        assert_eq!((Hops::Auto.fixed(), Hops::Fixed(3).fixed()), (None, Some(3)));
    }

    #[test]
    fn cloudfront_viewer_address_drops_the_port_even_for_bare_ipv6() {
        let name = "cloudfront-viewer-address";
        assert_eq!(header_addresses(name, "198.51.100.10:46532"), vec!["198.51.100.10".parse::<IpAddr>().unwrap()]);
        assert_eq!(header_addresses(name, "2001:db8::1:443"), vec!["2001:db8::1".parse::<IpAddr>().unwrap()], "the last group is the port, not the address");
        assert_eq!(header_addresses(name, "[2001:db8::2]:8080"), vec!["2001:db8::2".parse::<IpAddr>().unwrap()]);
        assert!(header_addresses(name, "198.51.100.10").is_empty(), "without a port it is not CloudFront's format");
        let mut h = HeaderMap::new();
        h.insert("cloudfront-viewer-address", "2001:db8:abcd::7:60776".parse().unwrap());
        assert_eq!(resolve(&h, Some("10.0.0.2".parse().unwrap()), Hops::Fixed(1), Some("CloudFront-Viewer-Address")), Some("2001:db8:abcd::7".parse().unwrap()));
        // 其他標頭照舊。/ Other headers are unchanged.
        assert_eq!(header_addresses("x-real-ip", "2001:db8::1:443"), vec!["2001:db8::1:443".parse::<IpAddr>().unwrap()]);
    }

    #[test]
    fn cloudflare_header_only_from_a_cloudflare_hop() {
        const EDGE: &str = "104.16.1.1";
        let mut m = h(&["198.51.100.7, 104.16.1.1"]);
        m.insert("cf-connecting-ip", "203.0.113.50".parse().unwrap());
        // auto：被選中的是 Cloudflare 的位址 → 用標頭。/ The chosen hop is Cloudflare's → the header.
        assert_eq!(resolve_with(&m, ip(TRAEFIK), Hops::Auto, None, Cloudflare::Auto), ip("203.0.113.50"));
        assert_eq!(resolve_with(&m, ip(TRAEFIK), Hops::Fixed(1), None, Cloudflare::Auto), ip("203.0.113.50"));
        assert_eq!(resolve_with(&m, ip(TRAEFIK), Hops::Fixed(1), None, Cloudflare::Off), ip(EDGE));
        // 被選中的不是 Cloudflare：auto 不採用（任何人都能塞這個標頭）。/ Not Cloudflare → auto ignores it.
        let mut m2 = h(&["198.51.100.7"]);
        m2.insert("cf-connecting-ip", "203.0.113.50".parse().unwrap());
        assert_eq!(resolve_with(&m2, ip(TRAEFIK), Hops::Auto, None, Cloudflare::Auto), ip("198.51.100.7"));
        assert_eq!(resolve_with(&m2, ip(TRAEFIK), Hops::Auto, None, Cloudflare::Always), ip("203.0.113.50"));
        // 指定的標頭還是最優先。/ The configured header still wins.
        m2.insert("x-real-ip", "198.51.100.99".parse().unwrap());
        assert_eq!(resolve_with(&m2, ip(TRAEFIK), Hops::Auto, Some("X-Real-IP"), Cloudflare::Always), ip("198.51.100.99"));

        let r = diagnose_with(&m, ip(TRAEFIK), Hops::Auto, None, Cloudflare::Auto);
        assert_eq!((r.ip.as_deref(), r.from, r.verdict), (Some("203.0.113.50"), Some("cloudflare"), "ok"));
        assert_eq!((r.cloudflare.edge_seen, r.cloudflare.used, r.cloudflare.header.as_deref()), (true, true, Some("203.0.113.50")));
        assert!(r.hints.is_empty());
        // 前面的代理把 Cloudflare 的位址換掉了。/ A proxy in front replaced Cloudflare's address.
        let mut m3 = h(&["172.19.0.1"]);
        m3.insert("cf-connecting-ip", "203.0.113.50".parse().unwrap());
        let r = diagnose_with(&m3, ip(TRAEFIK), Hops::Auto, None, Cloudflare::Auto);
        assert_eq!((r.cloudflare.edge_seen, r.cloudflare.used, r.hints.clone()), (false, false, vec!["cloudflare_masked"]));
        assert_eq!(r.verdict, "use_header");
        let r = diagnose_with(&m3, ip(TRAEFIK), Hops::Auto, None, Cloudflare::Off);
        assert!(r.hints.is_empty());
    }

    #[test]
    fn auto_diagnosis_counts_skipped_hops_and_spots_a_public_proxy() {
        let r = d(&["198.51.100.7, 10.0.0.2"], &[], Hops::Auto, None);
        assert_eq!((r.ip.as_deref(), r.verdict, r.skipped_hops, r.short_chain), (Some("198.51.100.7"), "ok", 2, false));
        assert_eq!(r.chain.iter().map(|e| e.role).collect::<Vec<_>>(), ["client", "proxy", "proxy"]);
        // a proxy with a public address in front: taken for the visitor → say so and suggest the fixed count
        let r = d(&["198.51.100.7, 203.0.113.9"], &[], Hops::Auto, None);
        assert_eq!((r.ip.as_deref(), r.verdict, r.suggest_hops), (Some("203.0.113.9"), "hops_too_low", Some(2)));
        // every hop internal: the same verdict as with a fixed count
        let r = d(&["172.19.0.1, 192.168.167.1"], &[], Hops::Auto, None);
        assert_eq!((r.ip.as_deref(), r.verdict, r.skipped_hops), (Some("172.19.0.1"), "all_private", 2));
        // a fixed count never calls a public address left of the chosen one a proxy (that side is the visitor's)
        let r = d(&["6.6.6.6, 198.51.100.7"], &[], Hops::Fixed(1), None);
        assert_eq!((r.verdict, r.skipped_hops), ("ok", 1));
    }
}
