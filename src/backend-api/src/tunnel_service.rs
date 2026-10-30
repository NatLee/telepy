//! 刪隧道時把裝置上「跑這條隧道的服務」一起移除（使用者選了才做；裝置要在線）。
//!
//! 我們不知道當初用哪種方式裝的，所以每種都試：一行指令安裝（systemd system / --user、launchd、背景迴圈 +
//! crontab）、autossh systemd 範本、Docker（docker run / compose）、手動跑的 ssh / autossh 腳本、Windows 的
//! PowerShell 迴圈 / 排程工作 / 服務 / Run 機碼 / 啟動資料夾。只碰「這條隧道的」東西：比對它的 reverse port
//! （`-R <port>:localhost:…`、`SSH_TUNNEL_PORT=<port>`）、隧道 id / 名稱或它的金鑰，其他一概不動。
//!
//! 兩段式（停掉隧道也會切斷我們跑指令的 SSH session）：
//! 1. 對每個登入帳號（root 優先）跑 `templates/remove_tunnel.sh`（Windows：`remove_tunnel.ps1`）：找出並刪掉
//!    檔案（unit、plist、crontab 行、迴圈腳本、金鑰、解除安裝腳本、known_hosts…），把「停止」寫進一次性的停止腳本。
//! 2. 金鑰清理做完後才在背景啟動每個停止腳本（systemd-run / setsid / nohup；Windows 用 WMI 建立行程，
//!    不受 session 結束影響），它停掉服務 / 容器 / 程序、最後刪 log 和自己。
//! 驗證：等隧道的 forward **自己**消失（裝置真的停了），再觀察一下會不會又連回來（還有東西在重啟它）。
//!
//! Removing a deleted tunnel's service from the device: every install method is tried, only things that
//! belong to this tunnel are touched, files go in phase 1, stopping is a detached one-shot script started
//! last, and the gateway confirms it (the forward drops by itself and does not come back).

use std::time::Duration;

use base64::Engine;
use serde::Serialize;

use crate::db::tunnels::Tunnel;
use crate::scripts::safe_substitute;
use crate::ssh::device::{self, DeviceConn};
use crate::ssh::exec;
use crate::state::AppState;

const POSIX: &str = include_str!("../templates/remove_tunnel.sh");
const WINDOWS: &str = include_str!("../templates/remove_tunnel.ps1");

const DETECT_TIMEOUT: Duration = Duration::from_secs(15);
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(90);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_OUTPUT: usize = 256 * 1024;
/// 停止腳本啟動後，等裝置自己斷線最多這麼久。/ How long to wait for the device to drop the tunnel.
const DROP_WAIT: Duration = Duration::from_secs(25);
/// 斷線後再看這麼久會不會又連回來（join 的 unit 10 秒、launchd 10 秒後重啟）。
/// After the drop, watch this long for a comeback (join units and launchd restart after 10 s).
const COMEBACK_WATCH: Duration = Duration::from_secs(13);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Posix,
    Windows,
}

/// 腳本做什麼：刪隧道（移除）、盤點（只回報，什麼都不改）、改名（移除舊名稱的，留下金鑰與用安裝代號取名的新服務）。
/// What the script does: delete (remove), survey (report only, nothing changes), relabel (remove the older names, keep
/// the key and the new service named after the install id).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Delete,
    Survey,
    Relabel,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Delete => "delete",
            Mode::Survey => "survey",
            Mode::Relabel => "relabel",
        }
    }
}

/// 腳本回報的一行：`TELEPY|<kind>|<what>|<detail>`。
/// kind：platform / found / removed / scheduled / needs_root / kept / note / failed / stopscript / launched / done。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Item {
    pub kind: String,
    pub what: String,
    pub detail: String,
}

pub fn parse_items(stdout: &str) -> Vec<Item> {
    stdout
        .lines()
        .filter_map(|l| l.trim_end_matches('\r').strip_prefix("TELEPY|"))
        .map(|rest| {
            let mut it = rest.splitn(3, '|');
            let kind = it.next().unwrap_or("").to_string();
            let what = it.next().unwrap_or("").to_string();
            let detail = it.next().unwrap_or("").to_string();
            Item { kind, what, detail }
        })
        .filter(|i| !i.kind.is_empty())
        .collect()
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct AccountResult {
    pub account: String,
    pub platform: Option<Platform>,
    /// `uname -s` / `Windows`。
    pub os: Option<String>,
    pub items: Vec<Item>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Removal {
    pub accounts: Vec<AccountResult>,
    /// 至少找到一種安裝方式或一個在跑的程序。/ At least one install method or running process was found.
    pub found: bool,
    /// 啟動了停止腳本。/ A stop script was started.
    pub launched: bool,
    /// 裝置自己斷線了（服務真的停了）。/ The device dropped the tunnel by itself.
    pub stopped: bool,
    /// 停了之後又連回來（還有東西在重啟它）。/ It came back afterwards (something restarts it).
    pub came_back: bool,
    /// 改名：舊的連線斷了，forward 留在新的服務上。/ Relabel: the old connection dropped and the forward stayed on the new one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handed_over: Option<bool>,
    /// 拿掉多出來的那份：這條隧道自己的連線一直在，forward 也沒換人。/ Removing an extra copy: the tunnel's own
    /// connection stayed up and kept the forward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept: Option<bool>,
}

/// 第一段做完、還沒停的狀態：留著每個帳號的連線（等一下金鑰可能被移掉，新連線就登不進去了）。
/// Phase 1 done; keeps each account's connection, since the key cleanup may remove the service key next.
pub struct Prepared {
    accounts: Vec<AccountResult>,
    pending: Vec<(usize, DeviceConn, Platform, String)>,
}

pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 隧道金鑰的 base64 部分（比對裝置上的 `telepy_tunnel_*.pub`）。/ The base64 part of the tunnel key.
fn key_body(key: &str) -> String {
    key.split_whitespace().nth(1).unwrap_or("").to_string()
}

/// 這條隧道在腳本裡的身分：安裝代號（還沒有 = 空）、裝置連的 gateway port（空 = 不比對伺服器）。
/// The tunnel's install id (empty when none yet) and the gateway port devices dial (empty = no server check).
#[derive(Debug, Clone, Default)]
pub struct Context {
    pub install_id: Option<String>,
    pub gateway_port: String,
}

impl Context {
    pub async fn load(state: &AppState, tunnel: &Tunnel) -> Self {
        let install_id = crate::db::device_install::get(&state.db, tunnel.id).await.ok().flatten().map(|r| r.install_id);
        let gateway_port = state.config.reverse_server_ssh_port.trim().to_string();
        Self { install_id, gateway_port: if gateway_port.bytes().all(|b| b.is_ascii_digit()) { gateway_port } else { String::new() } }
    }
}

/// 把範本填好。/ Fill in the template for a platform.
pub fn render(platform: Platform, tunnel: &Tunnel, mode: Mode, ctx: &Context) -> String {
    let mut m = std::collections::HashMap::new();
    m.insert("t_id", tunnel.id.to_string());
    m.insert("t_port", tunnel.reverse_port.to_string());
    match platform {
        Platform::Posix => {
            m.insert("t_name", sh_quote(&tunnel.host_friendly_name));
            m.insert("t_key", sh_quote(&key_body(&tunnel.key)));
            m.insert("t_mode", mode.as_str().to_string());
            let id = ctx.install_id.as_deref().filter(|i| crate::device_install::names::is_id(i)).unwrap_or("");
            m.insert("t_install", id.to_string());
            m.insert("t_gw_port", ctx.gateway_port.clone());
            safe_substitute(POSIX, &m)
        }
        Platform::Windows => {
            m.insert("t_key", ps_quote(&key_body(&tunnel.key)));
            safe_substitute(WINDOWS, &m)
        }
    }
}

/// `powershell -EncodedCommand`：UTF-16LE + base64，不必處理 cmd / PowerShell 的引號。
/// PowerShell's -EncodedCommand (UTF-16LE base64): no quoting through cmd.exe or PowerShell.
pub fn powershell_command(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    format!(
        "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(utf16)
    )
}

/// 在背景啟動停止腳本，脫離這個 SSH session（session 會跟著隧道一起斷）。
/// Start the stop script detached from this SSH session (the session dies with the tunnel).
pub fn launch_command(platform: Platform, path: &str) -> String {
    match platform {
        Platform::Posix => {
            let p = sh_quote(path);
            format!(
                "P={p}; if [ \"$(id -u)\" = 0 ] && command -v systemd-run >/dev/null 2>&1 && systemd-run --quiet --collect --no-block sh \"$P\" >/dev/null 2>&1; then echo 'TELEPY|launched|systemd-run|'; \
                 elif command -v setsid >/dev/null 2>&1; then setsid sh \"$P\" </dev/null >/dev/null 2>&1 & echo 'TELEPY|launched|setsid|'; \
                 else nohup sh \"$P\" </dev/null >/dev/null 2>&1 & echo 'TELEPY|launched|nohup|'; fi"
            )
        }
        Platform::Windows => {
            let inner = format!("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{path}\"");
            powershell_command(&format!(
                "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine = {} }}; \
                 if ($r.ReturnValue -eq 0) {{ 'TELEPY|launched|wmi|' + $r.ProcessId }} else {{ 'TELEPY|failed|launch|' + $r.ReturnValue }}",
                ps_quote(&inner)
            ))
        }
    }
}

/// root 帳號先跑（系統層的 unit / plist / 服務只有它清得掉）。/ Root first: only it can clean system-level parts.
pub fn order_accounts(accounts: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in accounts.iter().filter(|a| a.as_str() == "root").chain(accounts.iter().filter(|a| a.as_str() != "root")) {
        if !out.contains(a) {
            out.push(a.clone());
        }
    }
    out
}

async fn detect(conn: &DeviceConn) -> Option<(Platform, String)> {
    if let Ok(r) = exec::run(&conn.device, "uname -s", DETECT_TIMEOUT, 4096).await {
        let os = r.stdout.text.trim().to_string();
        if r.exit_code == Some(0) && !os.is_empty() && !os.contains(' ') {
            return Some((Platform::Posix, os));
        }
    }
    let r = exec::run(&conn.device, &powershell_command("Write-Output 'telepy-windows'"), DETECT_TIMEOUT, 4096).await.ok()?;
    r.stdout.text.contains("telepy-windows").then(|| (Platform::Windows, "Windows".to_string()))
}

/// 第一段：每個帳號找出並刪掉檔案、寫好停止腳本。/ Phase 1 on every account.
pub async fn prepare(state: &AppState, tunnel: &Tunnel, accounts: &[String]) -> Prepared {
    let ctx = Context::load(state, tunnel).await;
    prepare_with(state, tunnel, accounts, Mode::Delete, &ctx).await
}

/// 盤點：每個帳號跑一次「只回報」的腳本（Windows 還沒有，只回平台）。/ Survey every account (report only; not on Windows yet).
pub async fn survey(state: &AppState, tunnel: &Tunnel, accounts: &[String]) -> Vec<AccountResult> {
    let ctx = Context::load(state, tunnel).await;
    prepare_with(state, tunnel, accounts, Mode::Survey, &ctx).await.accounts
}

pub async fn prepare_with(state: &AppState, tunnel: &Tunnel, accounts: &[String], mode: Mode, ctx: &Context) -> Prepared {
    let mut prepared = Prepared { accounts: Vec::new(), pending: Vec::new() };
    for account in order_accounts(accounts) {
        let mut result = AccountResult { account: account.clone(), platform: None, os: None, items: Vec::new(), error: None };
        let conn = match device::connect(state, &account, tunnel.reverse_port).await {
            Ok(c) => c,
            Err(e) => {
                result.error = Some(format!("cannot log in: {e:#}"));
                prepared.accounts.push(result);
                continue;
            }
        };
        let Some((platform, os)) = detect(&conn).await else {
            result.error = Some("unsupported shell (neither POSIX sh nor PowerShell answered)".to_string());
            prepared.accounts.push(result);
            continue;
        };
        result.platform = Some(platform);
        result.os = Some(os);
        if platform == Platform::Windows && mode != Mode::Delete {
            // Windows 的腳本只會移除：盤點 / 改名不跑它。/ The Windows script only removes: no survey or relabel there.
            result.items.push(Item { kind: "note".into(), what: "windows".into(), detail: "listing what runs the tunnel is not available on Windows yet".into() });
            prepared.accounts.push(result);
            continue;
        }
        let script = render(platform, tunnel, mode, ctx);
        // POSIX：長腳本分段送（dropbear 不收超過 9000 字的指令）。/ POSIX: long scripts go in pieces (dropbear's limit).
        let ran = match platform {
            Platform::Posix => exec::run_script(&conn.device, &script, SCRIPT_TIMEOUT, MAX_OUTPUT).await,
            Platform::Windows => exec::run(&conn.device, &powershell_command(&script), SCRIPT_TIMEOUT, MAX_OUTPUT).await,
        };
        match ran {
            Ok(r) => {
                result.items = parse_items(&r.stdout.text);
                if r.timed_out {
                    result.error = Some("timed out".to_string());
                } else if !result.items.iter().any(|i| i.kind == "done") {
                    let err = r.stderr.text.trim();
                    result.error = Some(if err.is_empty() { format!("the script stopped early (exit {:?})", r.exit_code) } else { err.chars().take(500).collect() });
                }
            }
            Err(e) => result.error = Some(format!("{e:#}")),
        }
        let stop = result.items.iter().find(|i| i.kind == "stopscript").map(|i| i.detail.clone());
        let idx = prepared.accounts.len();
        prepared.accounts.push(result);
        if let Some(path) = stop {
            prepared.pending.push((idx, conn, platform, path));
        }
    }
    prepared
}

fn listening(state: &AppState, port: i64) -> bool {
    crate::device_keys::online(state, port)
}

async fn wait_for(state: &AppState, port: i64, want_listening: bool, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if listening(state, port) == want_listening {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// 第二段：啟動停止腳本，確認裝置自己斷線、而且沒有再連回來。/ Phase 2: start the stop scripts and confirm.
pub async fn finish(state: &AppState, tunnel: &Tunnel, mut prepared: Prepared) -> Removal {
    let mut launched = false;
    for (idx, conn, platform, path) in std::mem::take(&mut prepared.pending) {
        let items = match exec::run(&conn.device, &launch_command(platform, &path), LAUNCH_TIMEOUT, 4096).await {
            Ok(r) => parse_items(&r.stdout.text),
            Err(e) => vec![Item { kind: "failed".into(), what: "launch".into(), detail: format!("{e:#}") }],
        };
        launched |= items.iter().any(|i| i.kind == "launched");
        prepared.accounts[idx].items.extend(items);
        // 停止腳本已脫離 session 在背景跑，這條連線可以先關。/ The stop script runs detached; close our session.
        drop(conn);
    }
    let found = prepared.accounts.iter().any(|a| a.items.iter().any(|i| i.kind == "found"));
    let (mut stopped, mut came_back) = (false, false);
    if launched {
        stopped = wait_for(state, tunnel.reverse_port, false, DROP_WAIT).await;
        if stopped {
            came_back = wait_for(state, tunnel.reverse_port, true, COMEBACK_WATCH).await;
        }
    }
    tracing::info!(tunnel = tunnel.id, found, launched, stopped, came_back, "device tunnel service removal");
    Removal { accounts: prepared.accounts, found, launched, stopped, came_back, handed_over: None, kept: None }
}

/// 改名的第二段：舊服務的停止腳本跑在**新**連線上（舊的會斷，我們不在它上面）。確認舊連線斷了、forward 還在
/// 新的那條上，而且沒有別的連線又冒出來（還有東西在重啟舊的）。
/// Relabel phase 2: the stop scripts run over the new connection. Confirm the old connection dropped, the forward
/// stayed on the new one, and nothing else came back (something still restarting the old service).
pub async fn finish_relabel(state: &AppState, tunnel: &Tunnel, mut prepared: Prepared, old_conn: u64) -> Removal {
    let mut launched = false;
    for (idx, conn, platform, path) in std::mem::take(&mut prepared.pending) {
        let items = match exec::run(&conn.device, &launch_command(platform, &path), LAUNCH_TIMEOUT, 4096).await {
            Ok(r) => parse_items(&r.stdout.text),
            Err(e) => vec![Item { kind: "failed".into(), what: "launch".into(), detail: format!("{e:#}") }],
        };
        launched |= items.iter().any(|i| i.kind == "launched");
        prepared.accounts[idx].items.extend(items);
        drop(conn);
    }
    let found = prepared.accounts.iter().any(|a| a.items.iter().any(|i| i.kind == "found"));
    let port = u16::try_from(tunnel.reverse_port).unwrap_or(0);
    let deadline = tokio::time::Instant::now() + DROP_WAIT;
    while state.gateway.conn_alive(old_conn) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let stopped = !state.gateway.conn_alive(old_conn);
    let new_conn = state.gateway.forward_conn(port);
    let mut came_back = false;
    if stopped {
        let watch = tokio::time::Instant::now() + COMEBACK_WATCH;
        while tokio::time::Instant::now() < watch {
            if state.gateway.tunnel_conns(tunnel.id).iter().any(|c| Some(*c) != new_conn) {
                came_back = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    let handed_over = stopped && new_conn.is_some() && new_conn != Some(old_conn) && state.gateway.forward_conn(port) == new_conn;
    tracing::info!(tunnel = tunnel.id, found, launched, stopped, came_back, handed_over, "device tunnel service relabel cleanup");
    Removal { accounts: prepared.accounts, found, launched, stopped, came_back, handed_over: Some(handed_over), kept: None }
}

/// 拿掉多出來那份的第二段：停止腳本跑在這條隧道**自己的**連線上（它不會被停）。看一陣子：連線還在、forward 沒換、
/// 也沒有別的連線冒出來（多出來的那份還在被重啟）。
/// Phase 2 of removing an extra copy: the stop scripts run over the tunnel's own connection, which they never stop.
/// Watch for a while that it stays up, keeps the forward, and that nothing else shows up (the extra still restarting).
pub async fn finish_tidy(state: &AppState, tunnel: &Tunnel, mut prepared: Prepared, keep_conn: u64) -> Removal {
    let mut launched = false;
    for (idx, conn, platform, path) in std::mem::take(&mut prepared.pending) {
        let items = match exec::run(&conn.device, &launch_command(platform, &path), LAUNCH_TIMEOUT, 4096).await {
            Ok(r) => parse_items(&r.stdout.text),
            Err(e) => vec![Item { kind: "failed".into(), what: "launch".into(), detail: format!("{e:#}") }],
        };
        launched |= items.iter().any(|i| i.kind == "launched");
        prepared.accounts[idx].items.extend(items);
        drop(conn);
    }
    let found = prepared.accounts.iter().any(|a| a.items.iter().any(|i| i.kind == "found"));
    let port = u16::try_from(tunnel.reverse_port).unwrap_or(0);
    let (mut kept, mut came_back) = (true, false);
    let watch = tokio::time::Instant::now() + COMEBACK_WATCH;
    while tokio::time::Instant::now() < watch {
        if !state.gateway.conn_alive(keep_conn) || state.gateway.forward_conn(port) != Some(keep_conn) {
            kept = false;
            break;
        }
        if state.gateway.tunnel_conns(tunnel.id).iter().any(|c| *c != keep_conn) {
            came_back = true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    tracing::info!(tunnel = tunnel.id, found, launched, kept, came_back, "device tunnel extra copy removal");
    Removal { accounts: prepared.accounts, found, launched, stopped: launched, came_back, handed_over: None, kept: Some(kept) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tunnel() -> Tunnel {
        Tunnel {
            id: 7,
            user_id: 1,
            host_friendly_name: "pi's lab".into(),
            key: "ssh-ed25519 AAAAC3Nza+/= telepy-tunnel@pi".into(),
            reverse_port: 40001,
            description: None,
            default_username_id: None,
            created_at: String::new(),
            updated_at: String::new(),
            require_step_up: false,
            record_sessions: false,
            terminal_detach_policy: "user".into(),
            way_in: None,
        }
    }

    #[test]
    fn items_are_parsed_from_marked_lines_only() {
        let out = "noise\nTELEPY|found|systemd|telepy-tunnel-7.service\r\nTELEPY|needs_root|launchd|sudo launchctl bootout system/x; sudo rm -f a|b\nTELEPY|\n";
        assert_eq!(
            parse_items(out),
            vec![
                Item { kind: "found".into(), what: "systemd".into(), detail: "telepy-tunnel-7.service".into() },
                Item { kind: "needs_root".into(), what: "launchd".into(), detail: "sudo launchctl bootout system/x; sudo rm -f a|b".into() },
            ]
        );
    }

    #[test]
    fn templates_are_filled_without_touching_shell_syntax() {
        let ctx = Context { install_id: Some("k7m2q9xd".into()), gateway_port: "24242".into() };
        let sh = render(Platform::Posix, &tunnel(), Mode::Delete, &ctx);
        assert!(sh.contains("T_ID=7\nT_PORT=40001\nT_NAME='pi'\\''s lab'\nT_KEY='AAAAC3Nza+/='\nT_MODE=delete\nT_INSTALL=k7m2q9xd\nT_GW_PORT=24242\n"), "{sh}");
        let survey = render(Platform::Posix, &tunnel(), Mode::Survey, &Context { install_id: Some("bad id;".into()), gateway_port: String::new() });
        assert!(survey.contains("T_MODE=survey\nT_INSTALL=\nT_GW_PORT=\n"), "an odd id never reaches the shell: {survey}");
        assert!(!sh.contains("${t_"), "every key is filled");
        for kept in ["${TMPDIR:-/tmp}", "${r%.sh}", "\"$0\"", "$((STOPS + 1))", "${d#/proc/}"] {
            assert!(sh.contains(kept), "{kept} survives");
        }
        assert!(sh.starts_with("# telepy-remove-tunnel"), "the marker that keeps the script out of its own process match");
        let ps = render(Platform::Windows, &tunnel(), Mode::Delete, &ctx);
        assert!(ps.contains("$TunnelId = 7\n$TunnelPort = 40001\n$TunnelKey = 'AAAAC3Nza+/='"), "{ps}");
        assert!(!ps.contains("${t_"));
        assert!(ps.contains("$PSCommandPath") && ps.contains("$_.Execute"));
    }

    #[test]
    fn commands_quote_and_encode() {
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
        assert_eq!(ps_quote("a'b"), "'a''b'");
        let cmd = powershell_command("Write-Output 'é'");
        let b64 = cmd.rsplit(' ').next().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&units).unwrap(), "Write-Output 'é'");
        let posix = launch_command(Platform::Posix, "/tmp/telepy-stop-7.ab'c");
        assert!(posix.starts_with("P='/tmp/telepy-stop-7.ab'\\''c';"), "{posix}");
        assert!(posix.contains("setsid") && posix.contains("nohup") && posix.contains("systemd-run"));
        assert_eq!(order_accounts(&["pi".into(), "root".into(), "pi".into()]), vec!["root".to_string(), "pi".to_string()]);
    }
}
