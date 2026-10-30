//! 純邏輯：讀懂盤點結果（裝置上跑這條隧道的是什麼、叫什麼名字）、讀懂正在跑的 ssh 指令，排出「換成新名稱」的計畫，
//! 再把新服務的檔案（systemd unit / launchd plist / 迴圈腳本）與安裝、復原腳本產生出來。I/O 在 `super`。
//!
//! Pure: read the survey (what runs this tunnel on the device and what it is called), read the running ssh command,
//! plan the switch to private names, and render the new service (unit / plist / loop) plus its install and undo
//! scripts. The I/O lives in `super`.

use serde::Serialize;

use super::names::Names;
use crate::tunnel_service::{sh_quote, AccountResult, Item, Platform};

/// 跑隧道的方式。/ How the tunnel is kept running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    /// `/etc/systemd/system/*.service`
    Systemd,
    /// `~/.config/systemd/user/*.service`
    SystemdUser,
    /// `/Library/LaunchDaemons/*.plist`
    LaunchdDaemon,
    /// `~/Library/LaunchAgents/*.plist`
    LaunchdAgent,
    /// 重連迴圈 + `@reboot` crontab。/ A reconnect loop plus an @reboot crontab line.
    Loop,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Systemd => "systemd",
            Method::SystemdUser => "systemd --user",
            Method::LaunchdDaemon => "launchd daemon",
            Method::LaunchdAgent => "launchd agent",
            Method::Loop => "reconnect loop",
        }
    }
    /// 要 root 才裝得了。/ Needs root to install.
    pub fn system(self) -> bool {
        matches!(self, Method::Systemd | Method::LaunchdDaemon)
    }
    fn rank(self) -> u8 {
        match self {
            Method::Systemd | Method::LaunchdDaemon => 3,
            Method::SystemdUser | Method::LaunchdAgent => 2,
            Method::Loop => 1,
        }
    }
}

/// 盤點看到的一樣東西。/ One thing the survey found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Part {
    /// `service` | `process` | `cron` | `container` | `script` | `file`
    pub kind: &'static str,
    /// systemd / systemd-user / launchd / loop / docker / task / key / known_hosts / log / uninstall …
    pub what: String,
    /// 顯示用的名稱：unit、label、容器名或路徑。/ What to show: unit, label, container or path.
    pub name: String,
    pub account: String,
    /// 用這條隧道的安裝代號取的名稱。/ Named after this tunnel's install id.
    pub private: bool,
    /// Telepy 以前的標準名稱（`telepy-tunnel-<n>`、`com.telepy.tunnel.<n>`、autossh 的 `telepy-tunnel.service`）：
    /// 不帶人名、刪除腳本也認得，可以不改。/ Telepy's earlier standard names: no person in them and the removal
    /// script knows them, so they may stay.
    pub earlier: bool,
}

/// Telepy 以前自己的標準名稱嗎（不是代號、也不是別人取的）。/ One of Telepy's earlier standard names?
pub fn earlier_name(name: &str) -> bool {
    let numbered = |s: &str, prefix: &str, suffix: &str| s.strip_prefix(prefix).and_then(|r| r.strip_suffix(suffix)).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    name == "telepy-tunnel.service"
        || name == "telepy-tunnel"
        || numbered(name, "telepy-tunnel-", ".service")
        || numbered(name, "telepy-tunnel-", ".sh")
        || numbered(name, "com.telepy.tunnel.", "")
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// 舊的 Windows 項目沒有路徑 / unit 的概念，名稱就是 detail。/ Windows items: the detail is the name.
pub fn parts(accounts: &[AccountResult], names: &Names) -> Vec<Part> {
    let mut out: Vec<Part> = Vec::new();
    for a in accounts {
        for i in a.items.iter().filter(|i| i.kind == "found") {
            let (kind, name) = match i.what.as_str() {
                // initd = `/etc/init.d/…`（OpenWrt 的 procd 服務也在那裡）。/ initd: `/etc/init.d/…` (OpenWrt's procd services too).
                "systemd" | "systemd-user" | "loop" | "initd" => ("service", base_name(&i.detail).to_string()),
                "launchd" => ("service", base_name(&i.detail).trim_end_matches(".plist").to_string()),
                "task" | "service" | "run-key" | "startup" => ("service", i.detail.clone()),
                "docker" => ("container", i.detail.clone()),
                "process" => ("process", i.detail.split_once(' ').map(|(_, a)| a.to_string()).unwrap_or_default()),
                "cron" | "rc.local" => ("cron", i.detail.clone()),
                "script" => ("script", i.detail.clone()),
                "owner" => continue,
                _ => ("file", i.detail.clone()),
            };
            let private = names.owns(&i.detail);
            let earlier = !private && (kind == "service" || kind == "container") && earlier_name(&name);
            let part = Part { kind, what: i.what.clone(), name, account: a.account.clone(), private, earlier };
            // 每個帳號都看得到系統層的 unit：同一個只列一次。/ System units show up in every account: list once.
            if !out.iter().any(|p| p.kind == part.kind && p.what == part.what && p.name == part.name && (part.kind != "file" || p.account == part.account)) {
                out.push(part);
            }
        }
    }
    out
}

/// 裝置上連到**別台**伺服器的東西（盤點時標成 `kept other-server`，什麼模式都不碰）。
/// Things on the device that dial another server (reported as `kept other-server`; never touched in any mode).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Other {
    /// unit / plist / 腳本的檔名，或正在跑的 ssh。/ The unit / plist / script's file name, or the running ssh.
    pub name: String,
    /// 它連的 port。/ The port it dials.
    pub port: Option<u16>,
    /// 是正在跑的程序（不是檔案）。/ A running process rather than a file.
    pub process: bool,
    pub account: String,
}

pub fn others(accounts: &[AccountResult]) -> Vec<Other> {
    let mut out: Vec<Other> = Vec::new();
    for a in accounts {
        for i in a.items.iter().filter(|i| i.kind == "kept" && i.what == "other-server") {
            let (what, port) = match i.detail.rsplit_once(" (port ") {
                Some((w, p)) => (w.to_string(), p.trim_end_matches(')').parse::<u16>().ok()),
                None => (i.detail.clone(), None),
            };
            let process = what.split_whitespace().next().is_some_and(|w| w.bytes().all(|b| b.is_ascii_digit()));
            let name = if process { what.split_once(' ').map(|(_, rest)| rest.to_string()).unwrap_or_default() } else { base_name(&what).to_string() };
            let o = Other { name, port, process, account: a.account.clone() };
            // 系統層的 unit 每個帳號都看得到；同一個程序也是。/ System units and processes show up in every account.
            if !out.iter().any(|x| x.name == o.name && x.port == o.port) {
                out.push(o);
            }
        }
    }
    out
}

/// 這條隧道的金鑰檔也被別台伺服器的隧道用著（刪除時會留著）。/ The tunnel's key file another server's tunnel also uses.
pub fn shared_key(accounts: &[AccountResult]) -> Option<String> {
    accounts.iter().flat_map(|a| a.items.iter()).find(|i| i.kind == "note" && i.what == "key-shared").map(|i| i.detail.clone())
}

/// 要改名的服務：不是用安裝代號、也不是 Telepy 以前的標準名稱（例如 `telepy-natlee.service`，可能看得出是誰裝的）。
/// Services to rename: neither named after the install id nor one of Telepy's earlier standard names.
pub fn older_services(parts: &[Part]) -> Vec<String> {
    let mut out: Vec<String> = parts.iter().filter(|p| (p.kind == "service" || p.kind == "container") && !p.private && !p.earlier).map(|p| p.name.clone()).collect();
    out.dedup();
    out
}

/// Telepy 以前的標準名稱（可以留著；要改也行）。/ Earlier standard names (fine to keep, may be renamed).
pub fn earlier_services(parts: &[Part]) -> Vec<String> {
    let mut out: Vec<String> = parts.iter().filter(|p| (p.kind == "service" || p.kind == "container") && p.earlier).map(|p| p.name.clone()).collect();
    out.dedup();
    out
}

/// 正在跑的 ssh 指令裡需要的部分。/ What we need from the running ssh command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshSpec {
    pub program: String,
    /// `-i`；沒有 = 帳號自己的預設金鑰。/ `-i`; none = the account's default keys.
    pub key: Option<String>,
    pub port: Option<u16>,
    /// `-R` 轉到哪裡（`localhost:22`）。/ Where the `-R` forward leads.
    pub target: String,
    /// `user@host`
    pub dest: String,
    pub proxy_command: Option<String>,
}

/// 帶值的短選項（`man ssh`）。/ Short options that take a value.
const VALUE_FLAGS: &str = "BbcDEeFIiJLlmOoPpQRSWw";

/// `-R` 的值 → 目標 `host:port`（`*:0:localhost:22`、`0:[::1]:22`、`40001:127.0.0.1:2222`）。
fn forward_target(spec: &str) -> Option<String> {
    let (rest, port) = spec.rsplit_once(':')?;
    port.parse::<u16>().ok()?;
    let host = if let Some(stripped) = rest.strip_suffix(']') {
        let open = stripped.rfind('[')?;
        &rest[open..]
    } else {
        rest.rsplit(':').next()?
    };
    // 只有 port（`-R 2222`，動態 SOCKS）不是我們要的。/ A bare port (dynamic SOCKS) is not ours.
    if host.is_empty() || host.parse::<u16>().is_ok() || !rest.contains(':') {
        return None;
    }
    Some(format!("{host}:{port}"))
}

/// 讀 `<pid> <args>`（/proc 或 ps 的形式，引號已經沒了）。/ Read a `<pid> <args>` line (quotes already gone).
pub fn parse_ssh(line: &str) -> Option<SshSpec> {
    let mut words: Vec<&str> = line.split_whitespace().collect();
    if words.first().is_some_and(|w| w.bytes().all(|b| b.is_ascii_digit())) {
        words.remove(0);
    }
    let program = (*words.first()?).to_string();
    if base_name(&program) != "ssh" {
        return None;
    }
    let (mut key, mut port, mut target, mut dest, mut proxy, mut login) = (None, None, None, None, None, None);
    let mut i = 1;
    while i < words.len() {
        let w = words[i];
        if dest.is_none() && !w.starts_with('-') {
            dest = Some(w.to_string());
            i += 1;
            continue;
        }
        if !w.starts_with('-') || w == "-" {
            i += 1;
            continue;
        }
        let flags = &w[1..];
        let mut handled = false;
        for (pos, c) in flags.char_indices() {
            if !VALUE_FLAGS.contains(c) {
                continue;
            }
            let inline = &flags[pos + c.len_utf8()..];
            let value = if inline.is_empty() {
                i += 1;
                words.get(i).map(|s| s.to_string())?
            } else {
                inline.to_string()
            };
            match c {
                'i' => key = Some(value),
                'p' => port = Some(value.parse::<u16>().ok()?),
                'R' => target = forward_target(&value).or(target),
                'l' => login = Some(value),
                'o' => {
                    let (k, v) = value.split_once(['=', ' ']).unwrap_or((value.as_str(), ""));
                    match k.to_ascii_lowercase().as_str() {
                        "port" => port = Some(v.parse::<u16>().ok()?),
                        "identityfile" => key = Some(v.to_string()),
                        "user" => login = Some(v.to_string()),
                        "proxycommand" => {
                            // 指令裡的空白在 /proc 裡分不出來：接著讀到下一個選項為止（最後一個字是目的地）。
                            // Spaces inside it are lost in /proc: read on until the next option (the last word is the destination).
                            let mut pc = v.to_string();
                            while i + 2 < words.len() && !words[i + 1].starts_with('-') {
                                i += 1;
                                pc.push(' ');
                                pc.push_str(words[i]);
                            }
                            proxy = Some(pc);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
            handled = true;
            break;
        }
        let _ = handled;
        i += 1;
    }
    let mut dest = dest?;
    if !dest.contains('@') {
        dest = format!("{}@{dest}", login?);
    }
    Some(SshSpec { program, key, port, target: target?, dest, proxy_command: proxy })
}

/// 為什麼不能自動改名（前端用 `deviceInstall.block.<code>` 翻譯）。/ Why an automatic rename is not possible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocker {
    /// 還沒盤點過。/ Not surveyed yet.
    NotSurveyed,
    /// Windows：只列出來，不自動改。/ Windows: listed only.
    Windows,
    /// 已經都是新名稱了。/ Already private.
    NothingToRename,
    /// 找不到跑這條隧道的 ssh。/ The tunnel's ssh was not found.
    NoProcess,
    /// ssh 指令讀不懂。/ The ssh command could not be read.
    Unparsed,
    /// 系統層的服務，但沒有能用 root 的登入帳號。/ A system service and no login account has root.
    NeedsRoot,
    /// 不知道是哪個帳號在跑它（或它不是登入帳號）。/ Unknown owner, or the owner is not a login account.
    UnknownOwner,
    /// 路徑或參數有空白 / 特殊字元。/ A path or argument with spaces or special characters.
    OddCommand,
    /// 只有 Telepy 不會自動換的種類（OpenWrt 的 init.d 腳本）。/ Only kinds Telepy does not replace (OpenWrt init scripts).
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub method: Method,
    /// 用哪個登入帳號跑安裝腳本。/ The login account that runs the install script.
    pub account: String,
    /// 那個帳號不是 root，要 `sudo -n`。/ That account is not root: use `sudo -n`.
    pub sudo: bool,
    /// 隧道跑在哪個帳號下、它的家目錄。/ The account the tunnel runs as, and its home.
    pub run_user: String,
    pub home: String,
    pub spec: SshSpec,
    /// 要換掉的舊服務。/ The older services to replace.
    pub old: Vec<String>,
}

fn safe_word(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._/~@:+-[]*=,".contains(&b))
}

fn platform_of(a: &AccountResult) -> (bool, bool) {
    let root = a.items.iter().any(|i| i.kind == "platform" && i.detail.ends_with("root=1"));
    let is_root_account = a.account == "root";
    (root, is_root_account)
}

/// 從盤點結果排出改名計畫。/ Plan the rename from a survey.
pub fn plan(accounts: &[AccountResult], names: &Names) -> Result<Plan, Blocker> {
    if accounts.is_empty() || accounts.iter().all(|a| a.platform.is_none()) {
        return Err(Blocker::NotSurveyed);
    }
    if accounts.iter().any(|a| a.platform == Some(Platform::Windows)) {
        return Err(Blocker::Windows);
    }
    // 舊的、有名字的服務（每個找到它的帳號都算一次）。/ Older named services, with the account that found them.
    let mut services: Vec<(Method, &AccountResult, &Item)> = Vec::new();
    for a in accounts {
        for i in a.items.iter().filter(|i| i.kind == "found" && !names.owns(&i.detail)) {
            let m = match i.what.as_str() {
                "systemd" => Method::Systemd,
                "systemd-user" => Method::SystemdUser,
                "launchd" if i.detail.starts_with("/Library/") => Method::LaunchdDaemon,
                "launchd" => Method::LaunchdAgent,
                "loop" => Method::Loop,
                _ => continue,
            };
            services.push((m, a, i));
        }
    }
    if services.is_empty() {
        // 有舊名稱、但只在 Telepy 不會自動換的地方（init.d）。/ Older names only where Telepy does not replace them.
        let older = accounts.iter().flat_map(|a| a.items.iter()).any(|i| i.kind == "found" && i.what == "initd" && !names.owns(&i.detail) && !earlier_name(base_name(&i.detail)));
        return Err(if older { Blocker::Unsupported } else { Blocker::NothingToRename });
    }
    let mut old: Vec<String> = services
        .iter()
        .map(|(m, _, i)| match m {
            Method::LaunchdDaemon | Method::LaunchdAgent => base_name(&i.detail).trim_end_matches(".plist").to_string(),
            _ => base_name(&i.detail).to_string(),
        })
        .collect();
    old.sort();
    old.dedup();
    // 正在跑的 ssh（不是我們新名稱的）與它的擁有者。/ The running ssh (not ours) and who runs it.
    let mut procs: Vec<(&AccountResult, &Item)> = Vec::new();
    for a in accounts {
        for i in a.items.iter().filter(|i| i.kind == "found" && i.what == "process" && !names.owns(&i.detail)) {
            procs.push((a, i));
        }
    }
    if procs.is_empty() {
        return Err(Blocker::NoProcess);
    }
    let Some((pa, pi, spec)) = procs.iter().find_map(|(a, i)| parse_ssh(&i.detail).map(|s| (*a, *i, s))) else {
        return Err(Blocker::Unparsed);
    };
    let pid = pi.detail.split_whitespace().next().unwrap_or("");
    let owner = pa
        .items
        .iter()
        .filter(|i| i.kind == "found" && i.what == "owner")
        .find_map(|i| {
            let mut w = i.detail.splitn(3, ' ');
            (w.next() == Some(pid)).then(|| (w.next().unwrap_or("").to_string(), w.next().unwrap_or("").to_string()))
        });
    let Some((run_user, home)) = owner.filter(|(u, h)| !u.is_empty() && h.starts_with('/')) else {
        return Err(Blocker::UnknownOwner);
    };
    let words = [spec.key.as_deref().unwrap_or("x"), &spec.target, &spec.dest, &home, &run_user, &spec.program];
    if !words.iter().all(|w| safe_word(w)) || spec.key.as_deref().is_some_and(|k| !k.starts_with('/') && !k.starts_with("~/")) {
        return Err(Blocker::OddCommand);
    }
    if spec.proxy_command.as_deref().is_some_and(|p| p.contains(['\'', '"', '\\', '`', '$', '\n', '<', '>', '&', ';', '|'])) {
        return Err(Blocker::OddCommand);
    }
    let method = services.iter().map(|(m, _, _)| *m).max_by_key(|m| m.rank()).unwrap_or(Method::Loop);
    let (account, sudo) = if method.system() {
        let roots: Vec<&AccountResult> = accounts.iter().filter(|a| platform_of(a).0).collect();
        let Some(a) = roots.iter().find(|a| platform_of(a).1).or(roots.first()) else { return Err(Blocker::NeedsRoot) };
        (a.account.clone(), !platform_of(a).1)
    } else {
        // 使用者層級：只能用跑它的那個帳號裝（systemd --user / LaunchAgent / 迴圈都屬於它）。
        // User level: only the account that runs it can install (the user unit / agent / loop belong to it).
        let Some(a) = accounts.iter().find(|a| a.account == run_user) else { return Err(Blocker::UnknownOwner) };
        (a.account.clone(), false)
    };
    Ok(Plan { method, account, sudo, run_user, home, spec, old })
}

/// 新服務的 ssh 參數（不含程式本身）。/ The new service's ssh arguments (without the program).
pub fn ssh_args(plan: &Plan, names: &Names, alias: &str, pinned: bool) -> Vec<String> {
    let ssh_dir = format!("{}/.ssh", plan.home);
    let mut a: Vec<String> = ["-NT", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "BatchMode=yes"].map(String::from).to_vec();
    if pinned {
        a.extend(["-o".into(), "StrictHostKeyChecking=yes".into(), "-o".into(), format!("UserKnownHostsFile={ssh_dir}/{}", names.known_hosts()), "-o".into(), format!("HostKeyAlias={alias}")]);
    } else {
        a.extend(["-o".into(), "StrictHostKeyChecking=no".into(), "-o".into(), "UserKnownHostsFile=/dev/null".into()]);
    }
    if let Some(pc) = proxy_for(plan, names) {
        a.extend(["-o".into(), format!("ProxyCommand={pc}")]);
    }
    if let Some(k) = &plan.spec.key {
        let k = match k.strip_prefix("~/") {
            Some(rest) => format!("{}/{rest}", plan.home),
            None => k.clone(),
        };
        a.extend(["-o".into(), "IdentitiesOnly=yes".into(), "-i".into(), k]);
    }
    if let Some(p) = plan.spec.port {
        a.extend(["-p".into(), p.to_string()]);
    }
    a.extend(["-R".into(), format!("0:{}", plan.spec.target), plan.spec.dest.clone()]);
    a
}

/// 一鍵加入的 WebSocket 載具（`telepy-ws-<id>.sh`）換成新名稱；其他 ProxyCommand 原樣保留。
/// The join's WebSocket carrier gets the new name; any other ProxyCommand stays as it is.
fn carrier(plan: &Plan) -> Option<(String, String)> {
    let pc = plan.spec.proxy_command.as_deref()?;
    let file = base_name(pc);
    let n = file.strip_prefix("telepy-ws-")?.strip_suffix(".sh")?;
    (!pc.contains(' ') && n.bytes().all(|b| b.is_ascii_digit())).then(|| (pc.to_string(), pc.replace(&format!("telepy-ws-{n}.sh"), &format!("telepy-ws-{n}.py"))))
}

fn proxy_for(plan: &Plan, names: &Names) -> Option<String> {
    match carrier(plan) {
        Some(_) => Some(format!("{}/.ssh/{}", plan.home, names.ws_sh())),
        None => plan.spec.proxy_command.clone(),
    }
}

fn systemd_quote(arg: &str) -> String {
    let a = arg.replace('%', "%%");
    if a.contains(' ') {
        format!("\"{a}\"")
    } else {
        a
    }
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 新服務的檔案路徑與內容。/ The new service file's path and content.
pub fn service_file(plan: &Plan, names: &Names, args: &[String]) -> (String, String) {
    // systemd / launchd 要絕對路徑；`ps` 只顯示 `ssh` 時用系統的。/ Units and plists need an absolute path.
    let program = if plan.spec.program.starts_with('/') { plan.spec.program.clone() } else { "/usr/bin/ssh".to_string() };
    let exec = std::iter::once(program.clone()).chain(args.iter().cloned()).map(|a| systemd_quote(&a)).collect::<Vec<_>>().join(" ");
    match plan.method {
        Method::Systemd => (
            format!("/etc/systemd/system/{}", names.unit()),
            format!(
                "[Unit]\nDescription={}\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nUser={}\nExecStart={exec}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n",
                names.description(),
                plan.run_user
            ),
        ),
        Method::SystemdUser => (
            format!("{}/.config/systemd/user/{}", plan.home, names.unit()),
            format!("[Unit]\nDescription={}\nStartLimitIntervalSec=0\n\n[Service]\nExecStart={exec}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n", names.description()),
        ),
        Method::LaunchdDaemon | Method::LaunchdAgent => {
            let daemon = plan.method == Method::LaunchdDaemon;
            let path = if daemon { format!("/Library/LaunchDaemons/{}.plist", names.launchd_label()) } else { format!("{}/Library/LaunchAgents/{}.plist", plan.home, names.launchd_label()) };
            let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n");
            s.push_str(&format!("    <key>Label</key><string>{}</string>\n", names.launchd_label()));
            if daemon {
                s.push_str(&format!("    <key>UserName</key><string>{}</string>\n", xml(&plan.run_user)));
            }
            s.push_str("    <key>ProgramArguments</key>\n    <array>\n");
            for a in std::iter::once(&program).chain(args.iter()) {
                s.push_str(&format!("        <string>{}</string>\n", xml(a)));
            }
            s.push_str("    </array>\n    <key>RunAtLoad</key><true/>\n    <key>KeepAlive</key><true/>\n    <key>ThrottleInterval</key><integer>10</integer>\n");
            s.push_str(&format!("    <key>StandardErrorPath</key><string>{}/Library/Logs/{}</string>\n</dict>\n</plist>\n", xml(&plan.home), names.log()));
            (path, s)
        }
        Method::Loop => {
            let line = std::iter::once(plan.spec.program.clone()).chain(args.iter().cloned()).map(|a| sh_quote(&a)).collect::<Vec<_>>().join(" ");
            (
                format!("{}/.ssh/{}", plan.home, names.runner()),
                format!("#!/bin/sh\n# {}: reconnects forever.\nwhile :; do\n    {line} >> {} 2>&1\n    sleep 10\ndone\n", names.description(), sh_quote(&format!("{}/.ssh/{}", plan.home, names.log()))),
            )
        }
    }
}

/// 安裝腳本：寫 known_hosts（與 WebSocket 載具）、寫服務檔、啟動。每個結果一行 `TELEPY|…`。
/// The install script: known_hosts (and the WebSocket carrier), the service file, start it.
pub fn install_script(plan: &Plan, names: &Names, args: &[String], known_hosts: &str) -> String {
    let (path, content) = service_file(plan, names, args);
    let ssh_dir = format!("{}/.ssh", plan.home);
    let kh = format!("{ssh_dir}/{}", names.known_hosts());
    let sudo = if plan.sudo { "sudo -n " } else { "" };
    let owner = format!("{}:$(id -gn {} 2>/dev/null || echo {})", plan.run_user, sh_quote(&plan.run_user), sh_quote(&plan.run_user));
    let mut s = String::from("# telepy-install-tunnel: run by Telepy over SSH to give this tunnel's service private names.\nout() { printf 'TELEPY|%s|%s|%s\\n' \"$1\" \"$2\" \"$3\"; }\n");
    s.push_str(&format!("S='{sudo}'\nexport XDG_RUNTIME_DIR=\"${{XDG_RUNTIME_DIR:-/run/user/$(id -u)}}\"\n"));
    // 檔案：先寫到旁邊的暫存檔再改名，寫一半的不會被服務讀到。/ Files: written beside, then renamed.
    s.push_str("put() { $S mkdir -p \"$(dirname \"$1\")\" && printf '%s' \"$2\" | $S tee \"$1.telepy-new\" >/dev/null && $S chmod \"$3\" \"$1.telepy-new\" && $S mv -f \"$1.telepy-new\" \"$1\" && out wrote file \"$1\" || { out failed file \"$1\"; exit 0; }; }\n");
    if !known_hosts.is_empty() {
        s.push_str(&format!("put {} {} 644\n", sh_quote(&kh), sh_quote(known_hosts)));
    }
    if let Some((from_sh, from_py)) = carrier(plan) {
        let to_sh = format!("{ssh_dir}/{}", names.ws_sh());
        let to_py = format!("{ssh_dir}/{}", names.ws_py());
        s.push_str(&format!(
            "[ -f {fp} ] && [ -f {fs} ] || {{ out failed carrier {fs}; exit 0; }}\nput {tp} \"$(cat {fp})\" 700\nput {ts} \"$(sed 's#{fpe}#{tpe}#g' {fs})\" 700\n",
            fp = sh_quote(&from_py),
            fs = sh_quote(&from_sh),
            tp = sh_quote(&to_py),
            ts = sh_quote(&to_sh),
            fpe = from_py.replace('#', ""),
            tpe = to_py.replace('#', ""),
        ));
    }
    let mode = if plan.method == Method::Loop { "700" } else { "644" };
    s.push_str(&format!("put {} {} {mode}\n", sh_quote(&path), sh_quote(&content)));
    // 家目錄裡的檔案歸隧道的帳號。/ Files in the home belong to the tunnel's account.
    if plan.sudo || plan.account == "root" {
        let mut owned = vec![kh.clone()];
        if carrier(plan).is_some() {
            owned.push(format!("{ssh_dir}/{}", names.ws_sh()));
            owned.push(format!("{ssh_dir}/{}", names.ws_py()));
        }
        if !plan.method.system() {
            owned.push(path.clone());
        }
        let list = owned.iter().map(|p| sh_quote(p)).collect::<Vec<_>>().join(" ");
        s.push_str(&format!("for f in {list}; do [ -e \"$f\" ] && $S chown {owner} \"$f\" 2>/dev/null; done\n"));
    }
    let unit = names.unit();
    let label = names.launchd_label();
    s.push_str(&match plan.method {
        Method::Systemd => format!("$S systemctl daemon-reload && $S systemctl enable {unit} >/dev/null 2>&1 && $S systemctl restart {unit} && out started systemd {unit} || out failed start {unit}\n"),
        Method::SystemdUser => format!("systemctl --user daemon-reload && systemctl --user enable {unit} >/dev/null 2>&1 && systemctl --user restart {unit} && out started systemd-user {unit} || out failed start {unit}\n"),
        Method::LaunchdDaemon => format!("$S launchctl bootout system/{label} >/dev/null 2>&1; $S chown root:wheel {p}; $S launchctl bootstrap system {p} && out started launchd {label} || out failed start {label}\n", p = sh_quote(&path)),
        Method::LaunchdAgent => format!(
            "D=gui/$(id -u); launchctl print \"$D\" >/dev/null 2>&1 || D=user/$(id -u); launchctl bootout \"$D/{label}\" >/dev/null 2>&1; launchctl bootstrap \"$D\" {p} && out started launchd {label} || out failed start {label}\n",
            p = sh_quote(&path)
        ),
        Method::Loop => format!(
            "R={r}\nif command -v crontab >/dev/null 2>&1; then {{ crontab -l 2>/dev/null | grep -vF \"$R\"; printf '@reboot sh %s >/dev/null 2>&1\\n' \"$R\"; }} | crontab - && out wrote cron \"@reboot sh $R\"; fi\n\
             if command -v setsid >/dev/null 2>&1; then setsid sh \"$R\" </dev/null >/dev/null 2>&1 & else nohup sh \"$R\" </dev/null >/dev/null 2>&1 & fi\nout started loop \"$R\"\n",
            r = sh_quote(&path)
        ),
    });
    s.push_str("out done install ok\n");
    s
}

/// 復原：新服務沒連上來時，把剛裝的停掉、刪掉（舊的完全沒動）。/ Undo: stop and delete what was just installed.
pub fn undo_script(plan: &Plan, names: &Names) -> String {
    let (path, _) = service_file(plan, names, &[]);
    let ssh_dir = format!("{}/.ssh", plan.home);
    let sudo = if plan.sudo { "sudo -n " } else { "" };
    let unit = names.unit();
    let label = names.launchd_label();
    let mut s = format!("S='{sudo}'\nexport XDG_RUNTIME_DIR=\"${{XDG_RUNTIME_DIR:-/run/user/$(id -u)}}\"\n");
    s.push_str(&match plan.method {
        Method::Systemd => format!("$S systemctl disable --now {unit} >/dev/null 2>&1\n"),
        Method::SystemdUser => format!("systemctl --user disable --now {unit} >/dev/null 2>&1\n"),
        Method::LaunchdDaemon => format!("$S launchctl bootout system/{label} >/dev/null 2>&1\n"),
        Method::LaunchdAgent => format!("launchctl bootout gui/$(id -u)/{label} >/dev/null 2>&1 || launchctl bootout user/$(id -u)/{label} >/dev/null 2>&1\n"),
        Method::Loop => format!(
            "R={r}\npkill -f \"[s]h $R\" 2>/dev/null; pkill -f '[t]elepy-{id}.known_hosts' 2>/dev/null\nif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF \"$R\"; then crontab -l 2>/dev/null | grep -vF \"$R\" | crontab -; fi\n",
            r = sh_quote(&path),
            id = names.id
        ),
    });
    let mut files = vec![path, format!("{ssh_dir}/{}", names.known_hosts()), format!("{ssh_dir}/{}", names.log())];
    if carrier(plan).is_some() {
        files.push(format!("{ssh_dir}/{}", names.ws_sh()));
        files.push(format!("{ssh_dir}/{}", names.ws_py()));
    }
    s.push_str(&format!("$S rm -f {}\n", files.iter().map(|f| sh_quote(f)).collect::<Vec<_>>().join(" ")));
    if plan.method == Method::Systemd {
        s.push_str("$S systemctl daemon-reload >/dev/null 2>&1\n");
    }
    if plan.method == Method::SystemdUser {
        s.push_str("systemctl --user daemon-reload >/dev/null 2>&1\n");
    }
    s.push_str("printf 'TELEPY|done|undo|ok\\n'\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: &str, what: &str, detail: &str) -> Item {
        Item { kind: kind.into(), what: what.into(), detail: detail.into() }
    }

    fn account(name: &str, root: bool, items: Vec<Item>) -> AccountResult {
        let mut all = vec![item("platform", "Linux", &format!("{name} root={}", root as u8))];
        all.extend(items);
        AccountResult { account: name.into(), platform: Some(Platform::Posix), os: Some("Linux".into()), items: all, error: None }
    }

    const HDRE: &str = "4242 /usr/bin/ssh -N -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/ssh/telepy_natlee_known_hosts -o HostKeyAlias=telepy-telepy.natlee.info-56767 -o IdentitiesOnly=yes -i /home/pi/.ssh/id_ed25519 -p 56767 -R *:0:localhost:22 telepy@telepy.natlee.info";

    #[test]
    fn ssh_commands_are_read_like_ssh_reads_them() {
        let s = parse_ssh(HDRE).unwrap();
        assert_eq!(s.program, "/usr/bin/ssh");
        assert_eq!(s.key.as_deref(), Some("/home/pi/.ssh/id_ed25519"));
        assert_eq!((s.port, s.target.as_str(), s.dest.as_str()), (Some(56767), "localhost:22", "telepy@telepy.natlee.info"));
        // 合在一起的旗標、黏著的值、-l、-oPort、IPv6 目標。/ Bundled flags, glued values, -l, -oPort, an IPv6 target.
        let s = parse_ssh("ssh -NTR 0:[::1]:2222 -p24242 -i~/.ssh/k -l telepy gw.example").unwrap();
        assert_eq!((s.key.as_deref(), s.port, s.target.as_str(), s.dest.as_str()), (Some("~/.ssh/k"), Some(24242), "[::1]:2222", "telepy@gw.example"));
        let s = parse_ssh("ssh -oPort=7 -oIdentityFile=/k -R 40001:127.0.0.1:22 telepy@h").unwrap();
        assert_eq!((s.key.as_deref(), s.port, s.target.as_str()), (Some("/k"), Some(7), "127.0.0.1:22"));
        // 一鍵加入走 WebSocket 時的 ProxyCommand。/ The join's WebSocket ProxyCommand.
        let s = parse_ssh("ssh -NT -o ProxyCommand=/home/pi/.ssh/telepy-ws-12.sh -i /home/pi/.ssh/telepy_tunnel_ed25519 -p 443 -R 0:localhost:22 telepy@h").unwrap();
        assert_eq!(s.proxy_command.as_deref(), Some("/home/pi/.ssh/telepy-ws-12.sh"));
        // 不是 ssh、沒有 -R 目標、只有 SOCKS 的 -R。/ Not ssh, no -R target, a dynamic -R.
        assert!(parse_ssh("1 autossh -M 0 -NR 0:localhost:22 telepy@h").is_none());
        assert!(parse_ssh("1 ssh -N telepy@h").is_none());
        assert!(parse_ssh("1 ssh -R 1080 telepy@h").is_none());
    }

    fn survey_hdre() -> Vec<AccountResult> {
        vec![
            account(
                "root",
                true,
                vec![
                    item("found", "systemd", "/etc/systemd/system/telepy-natlee.service"),
                    item("found", "process", HDRE),
                    item("found", "owner", "4242 pi /home/pi"),
                ],
            ),
            account("pi", false, vec![item("found", "systemd", "/etc/systemd/system/telepy-natlee.service"), item("found", "process", HDRE), item("found", "owner", "4242 pi /home/pi")]),
        ]
    }

    #[test]
    fn parts_are_listed_once_and_marked_private_or_not() {
        let names = Names::new("k7m2q9xd");
        let mut s = survey_hdre();
        s[1].items.push(item("found", "systemd-user", "/home/pi/.config/systemd/user/telepy-k7m2q9xd.service"));
        let p = parts(&s, &names);
        let services: Vec<(&str, bool)> = p.iter().filter(|p| p.kind == "service").map(|p| (p.name.as_str(), p.private)).collect();
        assert_eq!(services, vec![("telepy-natlee.service", false), ("telepy-k7m2q9xd.service", true)]);
        assert_eq!(older_services(&p), vec!["telepy-natlee.service".to_string()]);
        assert_eq!(p.iter().filter(|p| p.kind == "process").count(), 1, "the same process seen by two accounts is one");
        // Telepy 以前的標準名稱：可以留著，不算「要改名」。/ Earlier standard names may stay and are not "to rename".
        let s = vec![account(
            "natlee",
            false,
            vec![
                item("found", "launchd", "/Library/LaunchDaemons/com.telepy.tunnel.62.plist"),
                item("found", "systemd", "/etc/systemd/system/telepy-tunnel.service"),
                item("found", "loop", "/home/pi/.ssh/telepy-tunnel-7.sh"),
                item("found", "docker", "telepy-tunnel"),
                item("found", "launchd", "/Users/gil/Library/LaunchAgents/info.natlee.telepy.plist"),
            ],
        )];
        let p = parts(&s, &names);
        assert_eq!(earlier_services(&p), vec!["com.telepy.tunnel.62", "telepy-tunnel.service", "telepy-tunnel-7.sh", "telepy-tunnel"]);
        assert_eq!(older_services(&p), vec!["info.natlee.telepy".to_string()]);
        for name in ["telepy-tunnel-.service", "com.telepy.tunnel.", "com.telepy.tunnel.abc", "telepy-tunnel-7x.sh", "telepy-natlee.service"] {
            assert!(!earlier_name(name), "{name}");
        }
    }

    #[test]
    fn a_system_unit_is_replaced_by_root_with_the_same_key_target_and_server() {
        let names = Names::new("k7m2q9xd");
        let p = plan(&survey_hdre(), &names).unwrap();
        assert_eq!((p.method, p.account.as_str(), p.sudo, p.run_user.as_str(), p.home.as_str()), (Method::Systemd, "root", false, "pi", "/home/pi"));
        assert_eq!(p.old, vec!["telepy-natlee.service".to_string()]);
        let args = ssh_args(&p, &names, "telepy-telepy.natlee.info-56767", true);
        let line = args.join(" ");
        assert!(line.contains("-o UserKnownHostsFile=/home/pi/.ssh/telepy-k7m2q9xd.known_hosts -o HostKeyAlias=telepy-telepy.natlee.info-56767"), "{line}");
        assert!(line.ends_with("-o IdentitiesOnly=yes -i /home/pi/.ssh/id_ed25519 -p 56767 -R 0:localhost:22 telepy@telepy.natlee.info"), "{line}");
        assert!(!line.contains("natlee_known_hosts"), "the old known_hosts is not reused");
        let (path, unit) = service_file(&p, &names, &args);
        assert_eq!(path, "/etc/systemd/system/telepy-k7m2q9xd.service");
        assert!(unit.contains("Description=Telepy reverse tunnel k7m2q9xd\n") && unit.contains("User=pi\nExecStart=/usr/bin/ssh -NT "), "{unit}");
        let script = install_script(&p, &names, &args, "telepy-x ssh-ed25519 AAAA\n");
        assert!(script.contains("put '/home/pi/.ssh/telepy-k7m2q9xd.known_hosts' 'telepy-x ssh-ed25519 AAAA\n' 644"), "{script}");
        assert!(script.contains("systemctl restart telepy-k7m2q9xd.service"), "{script}");
        assert!(script.contains("chown pi:$(id -gn 'pi'"), "root writes into pi's home and hands the files over: {script}");
        assert!(!script.contains("natlee.service"), "the old unit is not touched by the install script");
        let undo = undo_script(&p, &names);
        assert!(undo.contains("systemctl disable --now telepy-k7m2q9xd.service") && undo.contains("'/etc/systemd/system/telepy-k7m2q9xd.service'"), "{undo}");
    }

    #[test]
    fn user_level_services_are_installed_by_their_own_account() {
        let names = Names::new("k7m2q9xd");
        let proc_line = "77 /usr/bin/ssh -NT -i /Users/gil/.ssh/k -p 56767 -R 0:localhost:22 telepy@telepy.natlee.info";
        let s = vec![account(
            "gil",
            false,
            vec![item("found", "launchd", "/Users/gil/Library/LaunchAgents/info.natlee.telepy.plist"), item("found", "process", proc_line), item("found", "owner", "77 gil /Users/gil")],
        )];
        let p = plan(&s, &names).unwrap();
        assert_eq!((p.method, p.account.as_str(), p.sudo), (Method::LaunchdAgent, "gil", false));
        assert_eq!(p.old, vec!["info.natlee.telepy".to_string()]);
        let (path, plist) = service_file(&p, &names, &ssh_args(&p, &names, "a", true));
        assert_eq!(path, "/Users/gil/Library/LaunchAgents/com.telepy.tunnel.k7m2q9xd.plist");
        assert!(plist.contains("<key>Label</key><string>com.telepy.tunnel.k7m2q9xd</string>") && !plist.contains("UserName"), "{plist}");
        assert!(plist.contains("<string>/Users/gil/Library/Logs/telepy-k7m2q9xd.log</string>"), "{plist}");
        // 迴圈：自己的帳號、crontab。/ A loop: its own account and crontab.
        let s = vec![account("pi", false, vec![item("found", "loop", "/home/pi/.ssh/telepy-natlee-loop.sh"), item("found", "process", HDRE), item("found", "owner", "4242 pi /home/pi")])];
        let p = plan(&s, &names).unwrap();
        assert_eq!((p.method, p.account.as_str()), (Method::Loop, "pi"));
        let args = ssh_args(&p, &names, "a", true);
        let (path, runner) = service_file(&p, &names, &args);
        assert_eq!(path, "/home/pi/.ssh/telepy-k7m2q9xd.sh");
        assert!(runner.contains("'/usr/bin/ssh' '-NT'") && runner.contains(">> '/home/pi/.ssh/telepy-k7m2q9xd.log' 2>&1"), "{runner}");
        let script = install_script(&p, &names, &args, "");
        assert!(script.contains("@reboot sh %s") && !script.contains("chown"), "{script}");
    }

    #[test]
    fn the_join_websocket_carrier_moves_to_the_new_name() {
        let names = Names::new("k7m2q9xd");
        let line = "9 ssh -NT -o ProxyCommand=/home/pi/.ssh/telepy-ws-12.sh -i /home/pi/.ssh/telepy_tunnel_ed25519 -p 443 -R 0:localhost:22 telepy@h";
        let s = vec![account("pi", false, vec![item("found", "systemd-user", "/home/pi/.config/systemd/user/telepy-tunnel-12.service"), item("found", "process", line), item("found", "owner", "9 pi /home/pi")])];
        let p = plan(&s, &names).unwrap();
        let args = ssh_args(&p, &names, "a", true);
        assert!(args.contains(&"ProxyCommand=/home/pi/.ssh/telepy-k7m2q9xd-ws.sh".to_string()), "{args:?}");
        let script = install_script(&p, &names, &args, "");
        assert!(script.contains("sed 's#/home/pi/.ssh/telepy-ws-12.py#/home/pi/.ssh/telepy-k7m2q9xd-ws.py#g'"), "{script}");
        assert!(undo_script(&p, &names).contains("telepy-k7m2q9xd-ws.py"));
    }

    #[test]
    fn other_servers_and_a_shared_key_are_read_from_the_survey() {
        let s = vec![
            account(
                "root",
                true,
                vec![
                    item("kept", "other-server", "/etc/systemd/system/telepy-tunnel.service (port 57575)"),
                    item("kept", "other-server", "812 /usr/bin/ssh -N -i /home/pi/.ssh/telepy_tunnel_ed25519 -p 57575 -R *:0:localhost:22 telepy@hdre (port 57575)"),
                    item("note", "key-shared", "/home/pi/.ssh/telepy_tunnel_ed25519"),
                ],
            ),
            account("pi", false, vec![item("kept", "other-server", "/etc/systemd/system/telepy-tunnel.service (port 57575)"), item("kept", "other-server", "/home/pi/old.sh")]),
        ];
        let o = others(&s);
        assert_eq!(o.len(), 3, "the unit both accounts saw is listed once: {o:?}");
        assert_eq!((o[0].name.as_str(), o[0].port, o[0].process), ("telepy-tunnel.service", Some(57575), false));
        assert!(o[1].process && o[1].name.starts_with("/usr/bin/ssh -N") && o[1].port == Some(57575), "{o:?}");
        assert_eq!((o[2].name.as_str(), o[2].port), ("old.sh", None));
        assert_eq!(shared_key(&s).as_deref(), Some("/home/pi/.ssh/telepy_tunnel_ed25519"));
    }

    #[test]
    fn launchd_plists_and_openwrt_init_scripts_are_read() {
        let names = Names::new("k7m2q9xd");
        let s = vec![account(
            "root",
            true,
            vec![item("found", "initd", "/etc/init.d/telepy-natlee"), item("found", "rc.local", "ssh -N -p 56767 -R *:0:localhost:22 telepy@h &")],
        )];
        let p = parts(&s, &names);
        assert_eq!(p.iter().map(|p| (p.kind, p.name.as_str())).collect::<Vec<_>>(), vec![("service", "telepy-natlee"), ("cron", "ssh -N -p 56767 -R *:0:localhost:22 telepy@h &")]);
        assert_eq!(older_services(&p), vec!["telepy-natlee".to_string()]);
        assert_eq!(plan(&s, &names), Err(Blocker::Unsupported), "an init script is listed but not replaced automatically");
        let ours = vec![account("root", true, vec![item("found", "initd", "/etc/init.d/telepy-k7m2q9xd")])];
        assert_eq!(plan(&ours, &names), Err(Blocker::NothingToRename));
    }

    #[test]
    fn blockers_say_why() {
        let names = Names::new("k7m2q9xd");
        assert_eq!(plan(&[], &names), Err(Blocker::NotSurveyed));
        let mut win = account("u", false, vec![]);
        win.platform = Some(Platform::Windows);
        assert_eq!(plan(&[win], &names), Err(Blocker::Windows));
        // 已經是新名稱。/ Already private.
        let ours = vec![account("pi", false, vec![item("found", "systemd-user", "/home/pi/.config/systemd/user/telepy-k7m2q9xd.service")])];
        assert_eq!(plan(&ours, &names), Err(Blocker::NothingToRename));
        // 系統 unit，沒有 root。/ A system unit without root.
        let s = vec![account("pi", false, vec![item("found", "systemd", "/etc/systemd/system/telepy-natlee.service"), item("found", "process", HDRE), item("found", "owner", "4242 pi /home/pi")])];
        assert_eq!(plan(&s, &names), Err(Blocker::NeedsRoot));
        // sudo -n 可以：用那個帳號加 sudo。/ sudo -n works: that account with sudo.
        let s = vec![account("pi", true, vec![item("found", "systemd", "/etc/systemd/system/telepy-natlee.service"), item("found", "process", HDRE), item("found", "owner", "4242 pi /home/pi")])];
        let p = plan(&s, &names).unwrap();
        assert_eq!((p.account.as_str(), p.sudo), ("pi", true));
        assert!(install_script(&p, &names, &[], "").starts_with("# telepy-install-tunnel") && install_script(&p, &names, &[], "").contains("S='sudo -n '"));
        // 沒找到程序 / 讀不懂 / 不知道擁有者 / 怪路徑。/ No process, unreadable, unknown owner, odd path.
        let s = vec![account("root", true, vec![item("found", "systemd", "/etc/systemd/system/telepy-tunnel.service")])];
        assert_eq!(plan(&s, &names), Err(Blocker::NoProcess));
        let s = vec![account("root", true, vec![item("found", "systemd", "/etc/systemd/system/x.service"), item("found", "process", "5 autossh -M 0 telepy@h")])];
        assert_eq!(plan(&s, &names), Err(Blocker::Unparsed));
        let s = vec![account("root", true, vec![item("found", "systemd", "/etc/systemd/system/x.service"), item("found", "process", HDRE)])];
        assert_eq!(plan(&s, &names), Err(Blocker::UnknownOwner));
        let odd = HDRE.replace("/home/pi/.ssh/id_ed25519", "id_ed25519");
        let s = vec![account("root", true, vec![item("found", "systemd", "/etc/systemd/system/x.service"), item("found", "process", &odd), item("found", "owner", "4242 pi /home/pi")])];
        assert_eq!(plan(&s, &names), Err(Blocker::OddCommand), "a relative key path cannot be resolved");
    }
}
