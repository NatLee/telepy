//! SSH 主機 vs 網頁主機：裝置與筆電的 ssh 連 gateway 的 port，瀏覽器、CLI、API 連網頁的 port。網頁的名稱放在
//! Cloudflare 這類只轉 HTTP(S) 的代理後面時，那個名稱解析到代理的位址，gateway 的 port 就連不到了——所以 SSH 可以
//! 另外指定一個不經代理的名稱（`SSH_SERVER_DOMAIN` / 網站設定 → 伺服器 → SSH 主機）。這裡解析兩個名稱、判斷有沒有
//! 落在 Cloudflare 的位址上，給 `doctor` 與設定頁的說明用。只問系統的 DNS，不連任何第三方。認得出的只有 Cloudflare
//! （它公布了位址範圍）；別家 CDN、HTTP 負載平衡器、通道服務看起來就是一般位址，畫面上要說清楚。
//! SSH host vs web host: devices' and laptops' ssh dial the gateway port, browsers / the CLI / the API the web port.
//! A web name behind a proxy that only carries HTTP(S), such as Cloudflare's, resolves to the proxy, which never
//! forwards the gateway port — so SSH can get a separate, DNS-only name. This resolves both names and says whether
//! they land on Cloudflare, for `doctor` and the settings page. Only the system resolver is asked; no third party.
//! Only Cloudflare can be recognised (it publishes its ranges); another CDN, an HTTP load balancer or a tunnel service
//! looks like any other address, and the UI says so.

use std::net::IpAddr;
use std::time::Duration;

use serde_json::{json, Value};

use crate::server_settings::is_cloudflare;

/// 解析一個名稱的結果。/ What a name resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lookup {
    pub host: String,
    pub addresses: Vec<IpAddr>,
    pub error: Option<String>,
}

impl Lookup {
    /// 有任何一個位址在 Cloudflare 的範圍 = 這個名稱開了 Cloudflare 的代理（橘色雲朵）。
    /// Any address in Cloudflare's ranges = the name is proxied by Cloudflare (orange cloud).
    pub fn cloudflare(&self) -> bool {
        self.addresses.iter().any(|ip| is_cloudflare(*ip))
    }

    /// 只有這台機器自己連得到（`localhost`、loopback）。/ Only this machine can reach it.
    pub fn local(&self) -> bool {
        self.host == "localhost" || self.host.ends_with(".localhost") || (!self.addresses.is_empty() && self.addresses.iter().all(IpAddr::is_loopback))
    }

    pub fn json(&self) -> Value {
        json!({
            "host": self.host,
            "addresses": self.addresses.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "cloudflare": self.cloudflare(),
            "error": self.error,
        })
    }
}

/// 解析時間上限。/ How long a lookup may take.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

/// 用系統的 DNS 解析（IP 直接用；最多 3 秒）。/ Resolve with the system resolver (an IP is taken as is; ≤ 3 s).
pub async fn lookup(host: &str) -> Lookup {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return Lookup { host, addresses: vec![], error: Some("no host name".into()) };
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Lookup { host, addresses: vec![ip], error: None };
    }
    let answer = tokio::time::timeout(LOOKUP_TIMEOUT, tokio::net::lookup_host((host.clone(), 0))).await;
    match answer {
        Ok(Ok(found)) => {
            let mut addresses: Vec<IpAddr> = found.map(|a| a.ip()).collect();
            addresses.sort();
            addresses.dedup();
            Lookup { host, addresses, error: None }
        }
        Ok(Err(e)) => Lookup { host, addresses: vec![], error: Some(e.to_string()) },
        Err(_) => Lookup { host, addresses: vec![], error: Some("timed out".into()) },
    }
}

/// 兩個名稱合起來看的結論。/ The verdict on both names together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// localhost / loopback：只有這台機器連得到（測試用的伺服器）。/ Only this machine can connect (a test server).
    Local,
    /// SSH 主機解析不到。/ The SSH host does not resolve.
    Unresolved,
    /// SSH 主機落在 Cloudflare：裝置與筆電連不到 gateway 的 port。/ The SSH host is Cloudflare's: the gateway port is unreachable.
    SshProxied,
    /// 網頁走代理、SSH 另外一個名稱：這正是要拆開的情況。/ The web is proxied and SSH has its own name: the split working.
    Split,
    /// 同一個名稱、沒有代理：現在沒問題（之後要開代理先設 SSH 主機）。/ One name, no proxy: fine for now.
    Same,
    /// 兩個名稱、都沒有代理。/ Two names, neither proxied.
    Separate,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Local => "local",
            Verdict::Unresolved => "unresolved",
            Verdict::SshProxied => "ssh_proxied",
            Verdict::Split => "split",
            Verdict::Same => "same",
            Verdict::Separate => "separate",
        }
    }
}

/// `web_proxied` = 網頁的名稱落在 Cloudflare，或這次請求帶著 Cloudflare 的標頭（前面的代理換掉了位址時 DNS 看得出來、
/// 標頭也看得出來）。/ `web_proxied` = the web name resolves to Cloudflare, or this request carried Cloudflare's headers.
pub fn verdict(ssh: &Lookup, web_host: &str, web_proxied: bool) -> Verdict {
    if ssh.local() {
        return Verdict::Local;
    }
    if ssh.error.is_some() || ssh.addresses.is_empty() {
        return Verdict::Unresolved;
    }
    if ssh.cloudflare() {
        return Verdict::SshProxied;
    }
    if ssh.host == web_host.trim().to_ascii_lowercase() {
        // 同名卻有 Cloudflare 的標頭、DNS 又不是 Cloudflare：請求是從別條路（例如內網）進來的，照 DNS 判斷。
        // Same name with Cloudflare headers but non-Cloudflare DNS: the request came another way; DNS decides.
        return Verdict::Same;
    }
    if web_proxied {
        Verdict::Split
    } else {
        Verdict::Separate
    }
}

/// 請求有沒有經過 Cloudflare（它一定加 `CF-Ray`；`CF-Connecting-IP` 也是它加的）。
/// Whether a request passed through Cloudflare (it always adds `CF-Ray`, and `CF-Connecting-IP`).
pub fn via_cloudflare(headers: &axum::http::HeaderMap) -> bool {
    headers.contains_key("cf-ray") || headers.contains_key("cf-connecting-ip")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(host: &str, ips: &[&str]) -> Lookup {
        Lookup { host: host.into(), addresses: ips.iter().map(|i| i.parse().unwrap()).collect(), error: None }
    }

    #[test]
    fn verdicts() {
        // 網頁開了 Cloudflare、SSH 用同一個名稱 → 裝置連不到。/ Proxied web name reused for SSH → unreachable.
        assert_eq!(verdict(&l("t.example.com", &["104.21.35.8", "172.67.167.40"]), "t.example.com", true), Verdict::SshProxied);
        assert_eq!(verdict(&l("t.example.com", &["2606:4700:3033::6815:2308"]), "t.example.com", false), Verdict::SshProxied);
        // 網頁走代理、SSH 另一個只走 DNS 的名稱。/ Proxied web, DNS-only SSH name.
        assert_eq!(verdict(&l("ssh.example.com", &["114.34.69.11"]), "t.example.com", true), Verdict::Split);
        assert_eq!(verdict(&l("ssh.example.com", &["114.34.69.11"]), "t.example.com", false), Verdict::Separate);
        assert_eq!(verdict(&l("t.example.com", &["114.34.69.11"]), "T.example.com", false), Verdict::Same);
        assert_eq!(verdict(&l("localhost", &[]), "localhost", false), Verdict::Local);
        assert_eq!(verdict(&l("dev.test", &["127.0.0.1", "::1"]), "dev.test", false), Verdict::Local);
        let missing = Lookup { host: "nope.example.com".into(), addresses: vec![], error: Some("failed to lookup".into()) };
        assert_eq!(verdict(&missing, "t.example.com", true), Verdict::Unresolved);
    }

    #[test]
    fn cloudflare_headers() {
        let mut h = axum::http::HeaderMap::new();
        assert!(!via_cloudflare(&h));
        h.insert("cf-ray", "a52afa4e18c6ddff-SJC".parse().unwrap());
        assert!(via_cloudflare(&h));
    }

    #[tokio::test]
    async fn literals_and_blank_skip_dns() {
        assert_eq!(lookup("203.0.113.9").await, l("203.0.113.9", &["203.0.113.9"]));
        assert!(lookup(" ").await.error.is_some());
        assert!(lookup("localhost").await.local());
    }
}
