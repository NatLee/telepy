//! direct-tcpip 目標的名稱解析（SOCKS 代理、LAN 主機跳板用）。
//!
//! macOS 自帶的 sshd（實測 macOS 27.0.1 / sshd-session 10.0.2）在 privsep 子行程裡對 direct-tcpip 的**主機名**
//! 呼叫 getaddrinfo 時會 abort（"crashed on child side of fork pre-exec"：NAT64 檢查 → Network.framework →
//! ObjC 初始化），整條 SSH 連線跟著斷 —— 連線池上同一條連線的其他 channel 也一起斷。Chromium 的 SOCKS5
//! 一律送主機名，遠端瀏覽器因此開了幾秒就被收掉。IP 字面值不會觸發，exec 出來的新行程也沒事 →
//! 在 Darwin 裝置上先 exec `dscacheutil` 在**裝置上**解析（DNS 仍走裝置的網路，內網與 `.local` 名稱照常），
//! 再對 IP 開 direct-tcpip。其他系統照舊把主機名交給裝置的 sshd（與 `ssh -D` 相同）。
//!
//! Device-side name resolution for direct-tcpip targets. Apple's sshd crashes when a direct-tcpip request
//! carries a hostname, so on Darwin devices the name is resolved with an exec of `dscacheutil` and the channel
//! is opened to the address. Other systems get the hostname unchanged.

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::bail;
use tokio::sync::{OnceCell, Semaphore};

use super::pool::Lease;
use crate::state::AppState;
use super::exec;

/// 解析結果的快取時間（找不到的名稱短一點）。/ Cache lifetime of an answer (shorter for "no such name").
const POSITIVE_TTL: Duration = Duration::from_secs(60);
const NEGATIVE_TTL: Duration = Duration::from_secs(10);
const EXEC_TIMEOUT: Duration = Duration::from_secs(6);
const OUTPUT_LIMIT: usize = 16 * 1024;
const MAX_ENTRIES: usize = 1024;
/// 同時進行的解析 exec 上限：每個都是一條 session channel（向連線池借，算在 MaxSessions 額度裡）。
/// Concurrent lookups; each one is a session channel borrowed from the pool and counted against MaxSessions.
const PARALLEL_LOOKUPS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceOs {
    Darwin,
    Other,
}

/// `uname -s` 的輸出 → 系統。登入 shell 可能先印別的東西，所以逐行找。/ OS from `uname -s` output.
pub fn parse_os(uname: &str) -> DeviceOs {
    if uname.lines().any(|l| l.trim() == "Darwin") {
        DeviceOs::Darwin
    } else {
        DeviceOs::Other
    }
}

/// 可以安全放進指令列的主機名：`[A-Za-z0-9._-]`、1–253 字、不以 `-` / `.` 開頭。
/// A hostname that is safe on a command line.
pub fn valid_hostname(host: &str) -> bool {
    (1..=253).contains(&host.len())
        && !host.starts_with(['-', '.'])
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// `dscacheutil -q host -a name …` 的輸出 → 位址（IPv4 在前、去重；帶 zone 的 link-local 略過）。
/// Addresses from `dscacheutil` output, IPv4 first.
pub fn parse_dscacheutil(out: &str) -> Vec<IpAddr> {
    let (mut v4, mut v6) = (Vec::new(), Vec::new());
    for line in out.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        let (list, ip) = match key.trim() {
            "ip_address" => (&mut v4, value.parse::<Ipv4Addr>().ok().map(IpAddr::V4)),
            "ipv6_address" => (&mut v6, value.parse::<Ipv6Addr>().ok().map(IpAddr::V6)),
            _ => continue,
        };
        if let Some(ip) = ip.filter(|ip| !list.contains(ip)) {
            list.push(ip);
        }
    }
    v4.extend(v6);
    v4
}

struct Entry {
    at: Instant,
    answer: Arc<OnceCell<Option<IpAddr>>>,
}

impl Entry {
    /// 還在解析中的不算過期。/ An answer still in flight never expires.
    fn expired(&self, now: Instant) -> bool {
        match self.answer.get() {
            Some(ip) => now.duration_since(self.at) > if ip.is_some() { POSITIVE_TTL } else { NEGATIVE_TTL },
            None => false,
        }
    }
}

/// 一個 SOCKS 代理（或一次區網跳板）一個：系統偵測一次、Darwin 的答案快取、同名併發只 exec 一次。
/// One per SOCKS proxy (or LAN hop): detects the OS once, caches Darwin answers, shares a lookup between callers.
pub struct Resolver {
    os: OnceCell<DeviceOs>,
    entries: Mutex<HashMap<String, Entry>>,
    lookups: Semaphore,
}

impl Default for Resolver {
    fn default() -> Self {
        Self::new()
    }
}

impl Resolver {
    pub fn new() -> Self {
        Self { os: OnceCell::new(), entries: Mutex::new(HashMap::new()), lookups: Semaphore::new(PARALLEL_LOOKUPS) }
    }

    /// direct-tcpip 該連的目標：IP 字面值原樣回（不 exec）、非 Darwin 回原主機名、Darwin 回裝置解析出的位址
    /// （IPv4 優先）。Darwin 上解析不了、或還不知道是什麼系統時回錯誤 —— 絕不把主機名交給 Apple 的 sshd。
    /// 指令跑在向連線池借的 session channel 上（同一台、同一個帳號，`lease` 只用來認 key），所以算在額度裡。
    /// The address to open a direct-tcpip channel to. Errors rather than ever sending a hostname to Apple's sshd.
    /// Commands run on session channels borrowed from the pool for the lease's key, so they count against the limit.
    pub async fn target(&self, state: &AppState, lease: &Lease, host: &str) -> anyhow::Result<String> {
        let (reverse_port, username) = (lease.reverse_port(), lease.username());
        self.target_with(host, |cmd| async move {
            let (_session, channel) = state.pool.session_channel(state, reverse_port, username).await?;
            let r = exec::run_on(channel, &cmd, EXEC_TIMEOUT, OUTPUT_LIMIT).await?;
            Ok((r.exit_code, r.stdout.text))
        })
        .await
    }

    /// `target` 的本體；`run` 在裝置上跑一個指令、回 (exit code, stdout)。/ `target` over an injectable exec.
    async fn target_with<F, Fut>(&self, host: &str, run: F) -> anyhow::Result<String>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = anyhow::Result<(Option<u32>, String)>>,
    {
        if host.parse::<IpAddr>().is_ok() {
            return Ok(host.to_string());
        }
        // 偵測失敗（channel 開不起來、逾時）不快取，下次再試；指令跑完但不是 Darwin（例如 Windows 沒有 uname）就記住。
        // A failed probe is retried next time; a probe that ran is remembered.
        let os = self
            .os
            .get_or_try_init(|| async {
                let (code, out) = run("uname -s".to_string()).await?;
                anyhow::Ok(if code == Some(0) { parse_os(&out) } else { DeviceOs::Other })
            })
            .await
            .map_err(|e| e.context("detect the device OS"))?;
        if *os != DeviceOs::Darwin {
            return Ok(host.to_string());
        }
        if !valid_hostname(host) {
            bail!("not a hostname: {host:?}");
        }
        let name = host.trim_end_matches('.').to_ascii_lowercase();
        let answer = self.entry(&name);
        let ip = answer
            .get_or_try_init(|| async {
                let _slot = self.lookups.acquire().await?;
                let (code, out) = run(format!("/usr/bin/dscacheutil -q host -a name '{name}'")).await?;
                if code != Some(0) {
                    bail!("dscacheutil exited with {code:?}");
                }
                let ip = parse_dscacheutil(&out).into_iter().next();
                tracing::debug!(name, ?ip, "resolve: resolved on the device");
                Ok(ip)
            })
            .await?;
        match ip {
            Some(ip) => Ok(ip.to_string()),
            None => bail!("{name} does not resolve on the device"),
        }
    }

    fn entry(&self, name: &str) -> Arc<OnceCell<Option<IpAddr>>> {
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= MAX_ENTRIES {
            entries.retain(|_, e| !e.expired(now));
            if entries.len() >= MAX_ENTRIES {
                entries.clear();
            }
        }
        match entries.get(name) {
            Some(e) if !e.expired(now) => e.answer.clone(),
            _ => {
                let answer = Arc::new(OnceCell::new());
                entries.insert(name.to_string(), Entry { at: now, answer: answer.clone() });
                answer
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const MAC_EXAMPLE: &str = "name: example.com\nipv6_address: 2606:4700:10::6814:179a\nipv6_address: 2606:4700:10::ac42:93f3\n\n\
                               name: example.com\nip_address: 172.66.147.243\nip_address: 104.20.23.154\n\n";

    /// 假裝置：記下跑過的指令，依指令回固定輸出。/ A fake device that records commands.
    struct Fake {
        uname: &'static str,
        fail_uname: bool,
        commands: Mutex<Vec<String>>,
        lookups: AtomicUsize,
    }

    impl Fake {
        fn new(uname: &'static str) -> Self {
            Self { uname, fail_uname: false, commands: Mutex::new(Vec::new()), lookups: AtomicUsize::new(0) }
        }
        async fn run(&self, cmd: String) -> anyhow::Result<(Option<u32>, String)> {
            self.commands.lock().unwrap().push(cmd.clone());
            if cmd == "uname -s" {
                if self.fail_uname {
                    bail!("open a channel");
                }
                return Ok((Some(0), self.uname.to_string()));
            }
            self.lookups.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            let out = if cmd.ends_with("'example.com'") { MAC_EXAMPLE } else { "" };
            Ok((Some(0), out.to_string()))
        }
        fn commands(&self) -> Vec<String> {
            self.commands.lock().unwrap().clone()
        }
    }

    #[test]
    fn os_detection() {
        assert_eq!(parse_os("Darwin\n"), DeviceOs::Darwin);
        assert_eq!(parse_os("welcome!\nDarwin\n"), DeviceOs::Darwin);
        assert_eq!(parse_os("Linux\n"), DeviceOs::Other);
        assert_eq!(parse_os(""), DeviceOs::Other);
        assert_eq!(parse_os("NotDarwin\n"), DeviceOs::Other);
    }

    #[test]
    fn hostnames_safe_for_the_shell() {
        for ok in ["example.com", "example.com.", "nas", "my_host.lan", "a-b.c", "x1.local"] {
            assert!(valid_hostname(ok), "{ok}");
        }
        for bad in ["", "-oProxyCommand=x", ".hidden", "a b", "a'b", "a;b", "$(id)", "a\nb", "ä.com", &"a".repeat(254)] {
            assert!(!valid_hostname(bad), "{bad:?}");
        }
    }

    #[test]
    fn dscacheutil_output() {
        // 真實輸出（macOS 27）：IPv6 那段先出現，回傳時 IPv4 在前。/ Real output; IPv4 is returned first.
        let ips: Vec<String> = parse_dscacheutil(MAC_EXAMPLE).iter().map(IpAddr::to_string).collect();
        assert_eq!(ips, ["172.66.147.243", "104.20.23.154", "2606:4700:10::6814:179a", "2606:4700:10::ac42:93f3"]);
        // 重複、zone、垃圾行都略過；找不到的名稱是空輸出。/ Duplicates, zones and noise are skipped.
        let out = "name: localhost\nipv6_address: ::1\nipv6_address: fe80::1%lo0\n\nname: localhost\nip_address: 127.0.0.1\nip_address: 127.0.0.1\nbogus\n";
        assert_eq!(parse_dscacheutil(out), vec![IpAddr::from([127, 0, 0, 1]), "::1".parse::<IpAddr>().unwrap()]);
        assert!(parse_dscacheutil("").is_empty());
    }

    #[test]
    fn cache_expiry() {
        let now = Instant::now();
        let pending = Entry { at: now - Duration::from_secs(3600), answer: Arc::new(OnceCell::new()) };
        assert!(!pending.expired(now), "a lookup in flight is shared, not replaced");
        let found = Entry { at: now - Duration::from_secs(30), answer: Arc::new(OnceCell::new_with(Some(Some(IpAddr::from([10, 0, 0, 1]))))) };
        assert!(!found.expired(now));
        let missing = Entry { at: now - Duration::from_secs(30), answer: Arc::new(OnceCell::new_with(Some(None))) };
        assert!(missing.expired(now), "a missing name is retried sooner");
    }

    #[tokio::test]
    async fn ip_literals_never_exec() {
        let (r, dev) = (Resolver::new(), Fake::new("Darwin\n"));
        for ip in ["10.0.0.5", "::1", "2606:4700:10::6814:179a"] {
            assert_eq!(r.target_with(ip, |c| dev.run(c)).await.unwrap(), ip);
        }
        assert!(dev.commands().is_empty());
    }

    #[tokio::test]
    async fn other_systems_get_the_hostname() {
        let (r, dev) = (Resolver::new(), Fake::new("Linux\n"));
        assert_eq!(r.target_with("nas.lan", |c| dev.run(c)).await.unwrap(), "nas.lan");
        assert_eq!(r.target_with("example.com", |c| dev.run(c)).await.unwrap(), "example.com");
        assert_eq!(dev.commands(), ["uname -s"], "the OS is probed once, nothing is resolved");
    }

    #[tokio::test]
    async fn darwin_resolves_on_the_device_and_caches() {
        let (r, dev) = (Resolver::new(), Fake::new("Darwin\n"));
        assert_eq!(r.target_with("Example.COM.", |c| dev.run(c)).await.unwrap(), "172.66.147.243");
        assert_eq!(r.target_with("example.com", |c| dev.run(c)).await.unwrap(), "172.66.147.243");
        assert_eq!(dev.commands(), ["uname -s", "/usr/bin/dscacheutil -q host -a name 'example.com'"]);
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_lookup() {
        let (r, dev) = (Resolver::new(), Fake::new("Darwin\n"));
        let all = futures::future::join_all((0..6).map(|_| r.target_with("example.com", |c| dev.run(c)))).await;
        assert!(all.iter().all(|t| t.as_deref().ok() == Some("172.66.147.243")), "{all:?}");
        assert_eq!(dev.lookups.load(Ordering::SeqCst), 1);
        assert_eq!(dev.commands().iter().filter(|c| *c == "uname -s").count(), 1);
    }

    #[tokio::test]
    async fn darwin_never_falls_back_to_the_hostname() {
        let (r, dev) = (Resolver::new(), Fake::new("Darwin\n"));
        let err = r.target_with("nope.invalid", |c| dev.run(c)).await.unwrap_err();
        assert!(err.to_string().contains("does not resolve"), "{err}");
        assert!(r.target_with("a;reboot", |c| dev.run(c)).await.is_err(), "unsafe names never reach the shell");
        assert!(dev.commands().iter().all(|c| !c.contains(';')));
    }

    #[tokio::test]
    async fn unknown_os_is_an_error_and_retried() {
        let r = Resolver::new();
        let mut dev = Fake::new("Darwin\n");
        dev.fail_uname = true;
        assert!(r.target_with("example.com", |c| dev.run(c)).await.is_err(), "no hostname while the OS is unknown");
        dev.fail_uname = false;
        assert_eq!(r.target_with("example.com", |c| dev.run(c)).await.unwrap(), "172.66.147.243");
    }

    #[tokio::test]
    async fn windows_without_uname_passes_through() {
        let (r, dev) = (Resolver::new(), Fake::new(""));
        let dev = &dev;
        let run = |c: String| async move {
            if c == "uname -s" {
                return Ok((Some(1), String::new()));
            }
            dev.run(c).await
        };
        assert_eq!(r.target_with("intranet", run).await.unwrap(), "intranet");
    }
}
