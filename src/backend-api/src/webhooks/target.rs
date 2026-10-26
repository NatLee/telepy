//! webhook 的目的地：網址檢查與「只連公網位址」。個人 webhook 是任何使用者都能設的網址，伺服器會照著連，
//! 所以預設不准連到內網、本機、雲端 metadata 這些位址（SSRF）；管理員可以在網站設定放行內網，全站 webhook 一律放行。
//! 檢查在儲存時做一次（早點告訴人），送出時再由 [`PublicResolver`] 做一次：DNS 回來的位址只留公網的，
//! 連線就連那幾個位址，所以「存的時候是公網、送的時候改指內網」（DNS rebinding）也過不去。
//! Webhook targets: URL checks and "public addresses only". Anyone can set a personal webhook URL and the server
//! connects to it, so internal, loopback and cloud-metadata addresses are refused by default (SSRF); admins can
//! allow private networks in the site settings, and site-wide webhooks are always allowed. The check runs when a
//! webhook is saved and again on every delivery through [`PublicResolver`], which connects only to the public
//! addresses DNS returned (so DNS rebinding does not get around it).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use crate::geoip::{scope, Scope};

pub const URL_MAX: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    /// 不是 http(s) 網址、太長、沒有主機。/ Not an http(s) URL, too long, or no host.
    Invalid,
    /// 指向（或解析到）內網 / 本機位址。/ Points (or resolves) to a private / loopback address.
    Private,
    /// 查不到這個主機名稱。/ The host name does not resolve.
    Unresolvable,
}

impl Problem {
    pub fn code(self) -> &'static str {
        match self {
            Problem::Invalid => "invalid_url",
            Problem::Private => "private_target",
            Problem::Unresolvable => "unresolvable",
        }
    }
    pub fn message(self) -> &'static str {
        match self {
            Problem::Invalid => "Enter an http:// or https:// URL.",
            Problem::Private => "This address is on a private network or this server. Ask an administrator to allow private network targets.",
            Problem::Unresolvable => "This host name could not be resolved.",
        }
    }
}

/// 語法檢查。/ Syntax only.
pub fn parse(s: &str) -> Result<url::Url, Problem> {
    let s = s.trim();
    if s.is_empty() || s.chars().count() > URL_MAX {
        return Err(Problem::Invalid);
    }
    let u = url::Url::parse(s).map_err(|_| Problem::Invalid)?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none_or(str::is_empty) {
        return Err(Problem::Invalid);
    }
    Ok(u)
}

/// 公網位址嗎（在 GeoIP 的範圍判斷之外，再擋掉 IPv6 裡包著 IPv4 的寫法、基準測試與保留段）。
/// A public address (GeoIP's scope plus IPv6 forms that embed an IPv4 address, benchmark and reserved ranges).
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = embedded_v4(v6) {
                return public_v4(v4);
            }
            let s = v6.segments();
            // Teredo 2001::/32、文件用 2001:db8::/32、舊的 site-local fec0::/10。/ Teredo, documentation, site-local.
            if (s[0] == 0x2001 && (s[1] == 0 || s[1] == 0x0db8)) || (s[0] & 0xffc0) == 0xfec0 {
                return false;
            }
            scope(IpAddr::V6(v6)) == Scope::Public
        }
    }
}

fn public_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    // 192.0.0.0/24（IETF）、198.18.0.0/15（基準測試）、文件用的三段。/ IETF, benchmarking, documentation ranges.
    let special = (o[0] == 192 && o[1] == 0 && (o[2] == 0 || o[2] == 2)) || (o[0] == 198 && (o[1] & 0xfe) == 18) || (o[0] == 198 && o[1] == 51 && o[2] == 100) || (o[0] == 203 && o[1] == 0 && o[2] == 113);
    !special && scope(IpAddr::V4(v4)) == Scope::Public
}

/// IPv4-mapped、IPv4-compatible、NAT64（64:ff9b::/96、64:ff9b:1::/48）、6to4（2002::/16）裡的 IPv4。
fn embedded_v4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    let s = v6.segments();
    let tail = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    if s[..6] == [0, 0, 0, 0, 0, 0] && !v6.is_loopback() && !v6.is_unspecified() {
        return Some(tail);
    }
    if s[0] == 0x64 && s[1] == 0xff9b && (s[2..6] == [0, 0, 0, 0] || s[2] == 1) {
        return Some(tail);
    }
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8));
    }
    None
}

/// 主機名稱 → 位址（DNS）；IP 直接回自己。/ Resolve a host; an IP literal resolves to itself.
pub async fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, Problem> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port)).await.map_err(|_| Problem::Unresolvable)?.collect();
    if addrs.is_empty() {
        Err(Problem::Unresolvable)
    } else {
        Ok(addrs)
    }
}

/// 儲存時的檢查：語法 +（不放行內網時）每個解析出來的位址都要是公網。
/// The save-time check: syntax and, unless private targets are allowed, every resolved address must be public.
pub async fn check(s: &str, allow_private: bool) -> Result<url::Url, Problem> {
    let u = parse(s)?;
    if allow_private {
        return Ok(u);
    }
    let host = u.host_str().unwrap_or_default();
    let addrs = resolve(host, u.port_or_known_default().unwrap_or(443)).await?;
    if addrs.iter().all(|a| is_public(a.ip())) {
        Ok(u)
    } else {
        Err(Problem::Private)
    }
}

/// 送出時的 DNS：只留公網位址；一個都不剩就連不出去。/ Delivery-time DNS: public addresses only.
pub struct PublicResolver;

impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| is_public(a.ip())).collect();
            if addrs.is_empty() {
                return Err(format!("{host} does not resolve to a public address").into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// 網址的主機是 IP 字面值時，DNS resolver 不會經手，送之前自己擋。/ IP literals skip the resolver; check them here.
pub fn literal_allowed(u: &url::Url) -> bool {
    match u.host() {
        Some(url::Host::Ipv4(ip)) => is_public(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_public(IpAddr::V6(ip)),
        Some(url::Host::Domain(_)) => true,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> bool {
        is_public(s.parse().unwrap())
    }

    #[test]
    fn private_and_special_addresses_are_refused() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "192.0.0.8",
            "192.0.2.1",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "fec0::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b:1::a00:1",
            "2002:7f00:1::",
            "2001:0:4136:e378::1",
            "2001:db8::1",
        ] {
            assert!(!p(ip), "{ip} must not count as public");
        }
    }

    #[test]
    fn public_addresses_pass() {
        for ip in ["1.1.1.1", "8.8.8.8", "140.112.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::"] {
            assert!(p(ip), "{ip} is public");
        }
    }

    #[test]
    fn url_syntax() {
        assert!(parse("https://hooks.slack.com/x").is_ok());
        assert!(parse(" http://example.com:8080/a?b=c ").is_ok());
        assert_eq!(parse("ftp://example.com").unwrap_err(), Problem::Invalid);
        assert_eq!(parse("not a url").unwrap_err(), Problem::Invalid);
        assert_eq!(parse("").unwrap_err(), Problem::Invalid);
        assert_eq!(parse(&format!("https://e.com/{}", "a".repeat(URL_MAX))).unwrap_err(), Problem::Invalid);
    }

    #[test]
    fn literals() {
        assert!(!literal_allowed(&parse("http://127.0.0.1:9/x").unwrap()));
        assert!(!literal_allowed(&parse("http://[::1]/x").unwrap()));
        assert!(literal_allowed(&parse("http://8.8.8.8/x").unwrap()));
        assert!(literal_allowed(&parse("https://example.com/x").unwrap()));
    }

    #[tokio::test]
    async fn save_time_check() {
        assert_eq!(check("http://127.0.0.1:1/x", false).await.unwrap_err(), Problem::Private);
        assert_eq!(check("http://localhost:1/x", false).await.unwrap_err(), Problem::Private);
        assert!(check("http://127.0.0.1:1/x", true).await.is_ok(), "allowed by the site setting");
        assert_eq!(check("http://[fd00::1]/x", false).await.unwrap_err(), Problem::Private);
    }
}
