//! 裝置自己的位址：hostname、內網 IP（網卡）、對外 IP。gateway 看到的來源常常只是代理或 Docker 的內部位址
//! （例如 OrbStack / Docker Desktop 的 port 轉發），所以直接問裝置：用服務金鑰登入裝置的預設帳號，跑一次唯讀腳本。
//! 對外 IP 先問 Telepy 自己的 `/api/whoami`（網頁那條路的代理會帶 X-Forwarded-For）；它看到的不是公網位址時
//! （Telepy 前面的代理 / Docker 把來源換掉了，或裝置跟 Telepy 在同一個 NAT 後面），再讓裝置問站台設定
//! `device_ip_lookup_url` 的查詢服務（留空 = 不問）。
//! 頻率：每次連上問一次（同一條隧道 10 分鐘內不重問），連著時每天最多再問一次；失敗也記時間，不會一直重試。
//! The device's own addresses: hostname, LAN interfaces and public IP. The gateway's peer is often just a proxy's
//! or Docker's internal address, so the device is asked directly — once per connection (10-minute cool-down) and
//! at most daily while connected — through a read-only script run with the service key. The public IP comes from
//! Telepy's own `/api/whoami` first; when that answer is not public (a proxy or Docker in front of Telepy hides
//! client addresses, or the device shares Telepy's NAT), the device asks the site's `device_ip_lookup_url`.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::config::Config;
use crate::db;
use crate::geoip::{scope, Scope};
use crate::lan::{parse_networks, Network};
use crate::ssh::device;
use crate::state::AppState;
use crate::util::{db_time, now_db};

const MARK: &str = "@@telepy@@";
const LOOP_INTERVAL: Duration = Duration::from_secs(30);
const COOL_DOWN: Duration = Duration::from_secs(600);
const REFRESH_AFTER_HOURS: i64 = 24;
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
const EXEC_OUTPUT: usize = 64 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// 公網 IP 來源：裝置經 Telepy 的 `/api/whoami` 回報。/ Public IP reported by the device through Telepy's `/api/whoami`.
pub const SOURCE_DEVICE: &str = "device";
/// 公網 IP 來源：裝置問站台設定的查詢服務。/ Public IP the device got from the site's public-IP lookup.
pub const SOURCE_LOOKUP: &str = "lookup";

/// 裝置回報的東西。/ What the device reported.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeviceInfo {
    pub hostname: Option<String>,
    pub lan: Vec<Network>,
    /// 只收公網位址（裝置跟 Telepy 在同一個區網時會拿到內網位址，不算）。/ Public addresses only.
    pub public_ip: Option<IpAddr>,
    /// [`SOURCE_DEVICE`] / [`SOURCE_LOOKUP`]（有 `public_ip` 時）。/ Where `public_ip` came from.
    pub public_source: Option<&'static str>,
    /// `/api/whoami` 回了一個非公網位址（只記 log，用來看出 Telepy 前面的代理把來源換掉了）。
    /// A non-public whoami answer, logged only: it shows that something in front of Telepy rewrites client addresses.
    pub whoami_saw: Option<IpAddr>,
}

impl DeviceInfo {
    fn is_empty(&self) -> bool {
        self.hostname.is_none() && self.lan.is_empty() && self.public_ip.is_none() && self.whoami_saw.is_none()
    }

    /// 存進 DB 的 `lan` 欄位。/ The `lan` column value.
    pub fn lan_json(&self) -> Option<String> {
        (!self.lan.is_empty()).then(|| json!(self.lan.iter().map(|n| json!({"iface": n.iface, "ip": n.addr.to_string(), "prefix": n.prefix})).collect::<Vec<_>>()).to_string())
    }
}

/// 裝置要連的 whoami 網址（`PUBLIC_URL`，否則 `https://SERVER_DOMAIN`）；只留安全字元的網址（會放進 shell 指令）。
/// The whoami URLs a device tries; only URLs made of safe characters (they go into a shell command).
pub fn whoami_urls(config: &Config) -> Vec<String> {
    let mut bases = Vec::new();
    if let Some(u) = config.public_url.as_deref() {
        bases.push(u.trim_end_matches('/').to_string());
    }
    if let Some(host) = config.server_host() {
        bases.push(format!("https://{host}"));
    }
    let mut out: Vec<String> = Vec::new();
    for b in bases {
        let url = format!("{b}/api/whoami");
        if safe_url(&url) && !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

/// 網址只能有這些字元（會放進裝置上的 shell / cmd.exe 指令，單引號裡）。站台設定存檔時也用它檢查。
/// Only these characters (the URL goes into a shell / cmd.exe command on the device); the site setting is checked with it too.
pub fn safe_url(u: &str) -> bool {
    (u.starts_with("https://") || u.starts_with("http://")) && u.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:/[]?=&".contains(c))
}

/// 依序抓網址、第一個成功的就停（curl，沒有就 wget）。/ Fetch the URLs in order and stop at the first that answers.
fn posix_fetch(urls: &[String]) -> String {
    let list = urls.iter().map(|u| format!("'{u}'")).collect::<Vec<_>>().join(" ");
    format!("for u in {list}; do curl -fsS -m 5 \"$u\" 2>/dev/null && break || wget -qO- -T 5 \"$u\" 2>/dev/null && break; done")
}

fn windows_fetch(urls: &[String]) -> String {
    let tries = urls
        .iter()
        .map(|u| format!("try {{ (Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri '{u}'); break }} catch {{}}"))
        .collect::<Vec<_>>()
        .join("; ");
    format!("foreach ($i in 1) {{ {tries} }}")
}

/// POSIX 腳本（包在 `sh -c` 裡，不管登入 shell 是 bash / zsh / fish）。/ The POSIX script, wrapped in `sh -c`.
pub fn posix_command(urls: &[String]) -> String {
    let mut script = format!(
        "hostname 2>/dev/null; echo {MARK}; ip -o -4 addr show scope global 2>/dev/null || ifconfig 2>/dev/null || /sbin/ifconfig 2>/dev/null; echo {MARK};"
    );
    if !urls.is_empty() {
        script.push(' ');
        script.push_str(&posix_fetch(urls));
    }
    format!("sh -c {}", crate::tunnel_service::sh_quote(&script))
}

/// Windows（OpenSSH 預設 shell 是 cmd.exe）：同樣三段，用 PowerShell。/ The same three sections in PowerShell.
pub fn windows_command(urls: &[String]) -> String {
    let fetch = windows_fetch(urls);
    format!(
        "powershell -NoProfile -NonInteractive -Command \"hostname; '{MARK}'; Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object {{ $_.InterfaceAlias + '|' + $_.IPAddress + '/' + $_.PrefixLength }}; '{MARK}'; {fetch}\""
    )
}

/// 只問查詢服務（`/api/whoami` 給不出公網位址時的第二次 exec）。/ Ask only the lookup service (the second exec).
pub fn posix_lookup_command(url: &str) -> String {
    format!("sh -c {}", crate::tunnel_service::sh_quote(&posix_fetch(&[url.to_string()])))
}

pub fn windows_lookup_command(url: &str) -> String {
    format!("powershell -NoProfile -NonInteractive -Command \"{}\"", windows_fetch(&[url.to_string()]))
}

/// 回答的第一個字是 IP 就收（查詢服務回純文字；`<html>…` 之類的錯誤頁不算）。/ The first word, when it is an IP.
fn first_ip(text: &str) -> Option<IpAddr> {
    text.split_whitespace().next().and_then(|s| s.parse::<IpAddr>().ok()).map(|ip| ip.to_canonical())
}

/// 查詢服務的回答：只收公網位址。/ A lookup answer: public addresses only.
pub fn parse_lookup(out: &str) -> Option<IpAddr> {
    first_ip(out).filter(|ip| scope(*ip) == Scope::Public)
}

fn valid_hostname(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

/// 解析腳本輸出：hostname / 網卡（與 LAN 掃描同一個 parser，排除虛擬網卡）/ whoami。
/// Parse the script output: hostname, interfaces (same parser as the LAN scan) and the whoami answer.
pub fn parse_output(out: &str) -> DeviceInfo {
    let mut parts = out.split(MARK);
    let host = parts.next().unwrap_or_default();
    let ifaces = parts.next().unwrap_or_default();
    let whoami = parts.next().unwrap_or_default();
    let hostname = host.lines().map(str::trim).find(|l| !l.is_empty()).filter(|h| valid_hostname(h)).map(str::to_string);
    let answer = first_ip(whoami);
    let public_ip = answer.filter(|ip| scope(*ip) == Scope::Public);
    DeviceInfo {
        hostname,
        lan: physical_first(parse_networks(ifaces)),
        public_ip,
        public_source: public_ip.map(|_| SOURCE_DEVICE),
        whoami_saw: answer.filter(|_| public_ip.is_none()),
    }
}

/// macOS 上 VM / OrbStack / Docker Desktop 的橋接網卡（`bridge100`…）不是裝置的區網。/ macOS VM bridges are not the LAN.
fn is_vm_bridge(iface: &str) -> bool {
    iface.strip_prefix("bridge").is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// 實體網卡優先（有線 / 無線），去掉 VM 橋接；全被去掉就照原樣。/ Physical interfaces first; VM bridges dropped.
fn physical_first(lan: Vec<Network>) -> Vec<Network> {
    let rank = |iface: &str| {
        let n = iface.to_ascii_lowercase();
        let physical = ["en", "eth", "wl", "wlan", "eno", "ens", "enp", "ethernet", "wi-fi", "wifi"].iter().any(|p| n.starts_with(p));
        if physical { 0 } else { 1 }
    };
    let kept: Vec<Network> = lan.iter().filter(|n| !is_vm_bridge(&n.iface)).cloned().collect();
    let mut out = if kept.is_empty() { lan } else { kept };
    out.sort_by_key(|n| rank(&n.iface));
    out
}

/// 登入裝置問一次（裝置的預設帳號，沒有就第一個）。`ask_public` = gateway 看不到公網來源時才問 whoami。
/// Log in once and ask; `ask_public` only when the gateway's peer is not a public address.
pub async fn probe(state: &AppState, tunnel: &db::tunnels::Tunnel, ask_public: bool) -> Result<DeviceInfo, String> {
    let username = match tunnel.default_username_id {
        Some(id) => db::tunnels::username_by_id(&state.db, id).await.ok().flatten().map(|u| u.username),
        None => None,
    };
    let username = match username {
        Some(u) => u,
        None => db::tunnels::usernames_for_tunnel(&state.db, tunnel.id)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .map(|u| u.username)
            .ok_or("the tunnel has no login account")?,
    };
    let conn = device::connect(state, &username, tunnel.reverse_port).await.map_err(|e| format!("cannot log in as {username}: {e:#}"))?;
    let urls = if ask_public { whoami_urls(&state.config) } else { Vec::new() };
    let mut info = parse_output(&run_cmd(&conn, &posix_command(&urls)).await);
    let mut windows = false;
    if info.is_empty() {
        info = parse_output(&run_cmd(&conn, &windows_command(&urls)).await);
        windows = true;
    }
    if info.is_empty() {
        return Err("the device answered nothing usable (no sh / ip / ifconfig / PowerShell?)".into());
    }
    if let Some(saw) = info.whoami_saw {
        tracing::info!(
            tunnel_id = tunnel.id,
            whoami = %saw,
            "device info: Telepy's /api/whoami saw a non-public address: a proxy or Docker in front of Telepy rewrites client addresses, or the device shares Telepy's network"
        );
    }
    if ask_public && info.public_ip.is_none() {
        if let Some(url) = lookup_url(state).await {
            let cmd = if windows { windows_lookup_command(&url) } else { posix_lookup_command(&url) };
            info.public_ip = parse_lookup(&run_cmd(&conn, &cmd).await);
            info.public_source = info.public_ip.map(|_| SOURCE_LOOKUP);
        }
    }
    Ok(info)
}

/// 站台設定的公網 IP 查詢網址（留空 = 不問；不安全的字元也不問）。/ The site's public-IP lookup URL, if any.
async fn lookup_url(state: &AppState) -> Option<String> {
    let url = db::settings::get_solo(&state.db).await.ok()?.device_ip_lookup_url;
    let url = url.trim();
    (!url.is_empty() && safe_url(url)).then(|| url.to_string())
}

async fn run_cmd(conn: &device::DeviceConn, cmd: &str) -> String {
    crate::ssh::exec::run(&conn.device, cmd, EXEC_TIMEOUT, EXEC_OUTPUT).await.map(|r| r.stdout.text).unwrap_or_default()
}

/// 問完存起來；拿到公網 IP 且換了就警示。/ Probe, store, and alert when the public IP changed.
pub async fn probe_and_store(state: &AppState, tunnel_id: i64, port: u16, peer_public: bool) {
    let Ok(Some(tunnel)) = db::tunnels::by_id(&state.db, tunnel_id).await else { return };
    let result = tokio::time::timeout(PROBE_TIMEOUT, probe(state, &tunnel, !peer_public)).await.unwrap_or_else(|_| Err("timed out".into()));
    let at = now_db();
    match result {
        Ok(info) => {
            let lan = info.lan_json();
            if let Err(e) = db::tunnel_endpoints::record_probe(&state.db, tunnel_id, info.hostname.as_deref(), lan.as_deref(), None, &at).await {
                tracing::warn!(tunnel_id, error = %e, "device info: cannot store");
                return;
            }
            tracing::info!(tunnel_id, hostname = ?info.hostname, lan = info.lan.len(), public = ?info.public_ip, "device info refreshed");
            if let (Some(ip), false) = (info.public_ip, peer_public) {
                let ip = ip.to_string();
                let source = info.public_source.unwrap_or(SOURCE_DEVICE);
                if let Ok(Some(ch)) = db::tunnel_endpoints::update_public_ip(&state.db, tunnel_id, &ip, source, &at).await {
                    state.gateway.announce_ip_change(port, &ch, &ip, None).await;
                }
            }
        }
        Err(e) => {
            tracing::info!(tunnel_id, error = %e, "device info: probe failed");
            let _ = db::tunnel_endpoints::record_probe(&state.db, tunnel_id, None, None, Some(&e), &at).await;
        }
    }
}

/// 常駐：每 30 秒看哪些連著的隧道該問了（依序問，一次一台）。/ Resident loop: probe due, connected tunnels one at a time.
pub async fn run(state: AppState) {
    let mut last_try: HashMap<i64, Instant> = HashMap::new();
    tracing::info!("device info probe started");
    loop {
        tokio::time::sleep(LOOP_INTERVAL).await;
        let live = state.status.endpoints();
        if live.is_empty() {
            continue;
        }
        let stale = db_time(chrono::Utc::now() - chrono::Duration::hours(REFRESH_AFTER_HOURS));
        let due = match db::tunnel_endpoints::probe_due(&state.db, &stale).await {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(error = %e, "device info: cannot list due tunnels");
                continue;
            }
        };
        for (tunnel_id, port) in due {
            let Ok(port) = u16::try_from(port) else { continue };
            let Some(ep) = live.get(&port) else { continue };
            if last_try.get(&tunnel_id).is_some_and(|t| t.elapsed() < COOL_DOWN) {
                continue;
            }
            last_try.insert(tunnel_id, Instant::now());
            let peer_public = ep.ip.parse::<IpAddr>().is_ok_and(|ip| scope(ip) == Scope::Public);
            probe_and_store(&state, tunnel_id, port, peer_public).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_linux_answer() {
        let out = "pi-garage\n@@telepy@@\n2: eth0    inet 192.168.1.23/24 brd 192.168.1.255 scope global dynamic eth0\\       valid_lft 85000sec\n3: docker0    inet 172.17.0.1/16 scope global docker0\n@@telepy@@\n114.34.69.11\n";
        let info = parse_output(out);
        assert_eq!(info.hostname.as_deref(), Some("pi-garage"));
        assert_eq!(info.lan.len(), 1, "docker0 is skipped: {:?}", info.lan);
        assert_eq!(info.lan[0].addr.to_string(), "192.168.1.23");
        assert_eq!(info.lan[0].prefix, 24);
        assert_eq!(info.public_ip, Some("114.34.69.11".parse().unwrap()));
        assert_eq!(info.public_source, Some(SOURCE_DEVICE));
        assert_eq!(info.whoami_saw, None);
        assert_eq!(info.lan_json().unwrap(), r#"[{"iface":"eth0","ip":"192.168.1.23","prefix":24}]"#);
    }

    #[test]
    fn parses_macos_ifconfig_and_windows() {
        let mac = "mini\n@@telepy@@\nen0: flags=8863<UP,BROADCAST> mtu 1500\n\tinet 192.168.0.205 netmask 0xffffff00 broadcast 192.168.0.255\n@@telepy@@\n";
        let info = parse_output(mac);
        assert_eq!(info.lan[0].addr.to_string(), "192.168.0.205");
        assert_eq!(info.public_ip, None, "no whoami answer");
        let win = "WIN-BOX\r\n@@telepy@@\r\nEthernet|10.0.0.8/24\r\nLoopback Pseudo-Interface 1|127.0.0.1/8\r\n@@telepy@@\r\n203.0.113.9\r\n";
        let info = parse_output(win);
        assert_eq!(info.hostname.as_deref(), Some("WIN-BOX"));
        assert_eq!(info.lan.iter().map(|n| n.addr.to_string()).collect::<Vec<_>>(), vec!["10.0.0.8"]);
        assert_eq!(info.public_ip, Some("203.0.113.9".parse().unwrap()));
    }

    #[test]
    fn real_interfaces_come_before_vm_bridges() {
        // 真實的 Mac mini（OrbStack）：一堆 bridge1xx，真正的區網在 en1。/ A real Mac with OrbStack bridges.
        let out = "mini\n@@telepy@@\n\
bridge100: flags=8863<UP> mtu 1500\n\tinet 192.168.139.1 netmask 0xfffffe00 broadcast 192.168.139.255\n\
bridge107: flags=8863<UP> mtu 1500\n\tinet 172.21.0.1 netmask 0xffff0000\n\
en1: flags=8863<UP> mtu 1500\n\tinet 192.168.0.205 netmask 0xffffff00 broadcast 192.168.0.255\n@@telepy@@\n";
        let lan = parse_output(out).lan;
        assert_eq!(lan.iter().map(|n| n.iface.as_str()).collect::<Vec<_>>(), vec!["en1"], "{lan:?}");
        // 只有橋接時照樣回報。/ Only bridges: keep them.
        let only = "h\n@@telepy@@\nbridge100: flags=8863<UP> mtu 1500\n\tinet 192.168.139.1 netmask 0xfffffe00\n@@telepy@@\n";
        assert_eq!(parse_output(only).lan.len(), 1);
        assert!(is_vm_bridge("bridge100") && !is_vm_bridge("bridge") && !is_vm_bridge("br-lan"));
    }

    #[test]
    fn rejects_non_public_whoami_answers_and_junk() {
        // 裝置跟 Telepy 在同一個區網：whoami 回的是內網位址，不算公網 IP，但記下來給 log。
        // Same LAN as Telepy: not a public IP, but kept for the log.
        let same_lan = parse_output("h\n@@telepy@@\n@@telepy@@\n192.168.0.205\n");
        assert_eq!((same_lan.public_ip, same_lan.public_source), (None, None));
        assert_eq!(same_lan.whoami_saw, Some("192.168.0.205".parse().unwrap()));
        // Telepy 前面的代理在 Docker 裡：每個人都是那個 bridge 位址。/ A proxy in Docker: everyone is the bridge address.
        assert_eq!(parse_output("@@telepy@@\n@@telepy@@\n172.19.0.1\n").whoami_saw, Some("172.19.0.1".parse().unwrap()));
        let junk = parse_output("h\n@@telepy@@\n@@telepy@@\n<html>error</html>\n");
        assert_eq!((junk.public_ip, junk.whoami_saw), (None, None));
        assert_eq!(parse_output("bad host name!\n@@telepy@@\n@@telepy@@\n").hostname, None);
        assert!(parse_output("").is_empty());
    }

    #[test]
    fn builds_safe_commands() {
        let urls = vec!["https://telepy.example.com/api/whoami".to_string()];
        let posix = posix_command(&urls);
        assert!(posix.starts_with("sh -c '"), "{posix}");
        assert!(posix.contains("curl -fsS -m 5"), "{posix}");
        assert!(posix.contains("https://telepy.example.com/api/whoami"));
        assert!(!posix_command(&[]).contains("curl"), "no whoami when the gateway already sees a public peer");
        assert!(windows_command(&urls).contains("Invoke-RestMethod"));
        assert!(!safe_url("https://evil.example/'; rm -rf / #"));
        assert!(!safe_url("https://x.example/$(id)"), "no command substitution");
        assert!(!safe_url("https://x.example/%PATH%"), "no cmd.exe variables");
        assert!(!safe_url("ftp://x.example/ip"));
        assert!(safe_url("http://127.0.0.1:8787/api/whoami"));
        assert!(safe_url("https://api.ipify.org/?format=text&x=1"));
        assert_eq!(posix_lookup_command("https://api.ipify.org"), "sh -c 'for u in '\\''https://api.ipify.org'\\''; do curl -fsS -m 5 \"$u\" 2>/dev/null && break || wget -qO- -T 5 \"$u\" 2>/dev/null && break; done'");
        let win = windows_lookup_command("https://api.ipify.org");
        assert!(win.starts_with("powershell -NoProfile -NonInteractive -Command \"foreach ($i in 1) { try { (Invoke-RestMethod"), "{win}");
        assert!(win.contains("-Uri 'https://api.ipify.org'"), "{win}");
    }

    #[test]
    fn lookup_answers_must_be_public() {
        assert_eq!(parse_lookup("114.34.69.11\n"), Some("114.34.69.11".parse().unwrap()));
        assert_eq!(parse_lookup("  2001:4860:4860::8888 "), Some("2001:4860:4860::8888".parse().unwrap()));
        assert_eq!(parse_lookup("::ffff:114.34.69.11"), Some("114.34.69.11".parse().unwrap()), "IPv4-mapped is canonicalised");
        for bad in ["", "192.168.0.1", "100.64.0.1", "127.0.0.1", "<html>rate limited</html>", "error: 114.34.69.11"] {
            assert_eq!(parse_lookup(bad), None, "{bad:?}");
        }
    }
}
