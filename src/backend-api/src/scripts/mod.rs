//! 連線腳本與 ssh config 的模板渲染。模板檔原封不動搬自 Django（templates/），置換語意沿用
//! Python `string.Template.safe_substitute`（`$name` / `${name}`；未知名稱原樣保留；`$$` → `$`）。
//! Script/config rendering with Python `string.Template.safe_substitute` semantics.

use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use regex::Regex;

pub const SSH: &str = include_str!("../../templates/ssh_template.sh");
pub const AUTOSSH: &str = include_str!("../../templates/autossh_template.sh");
pub const AUTOSSH_SERVICE: &str = include_str!("../../templates/autossh_service_template.sh");
pub const POWERSHELL: &str = include_str!("../../templates/powershell_template.ps1");
pub const DOCKER_RUN: &str = include_str!("../../templates/docker_run_template.sh");
pub const DOCKER_COMPOSE: &str = include_str!("../../templates/docker_compose_template.yml");
pub const SSH_CONFIG: &str = include_str!("../../templates/ssh_config_template.conf");

pub const ALLOWED_SCRIPT_TYPES: &[&str] = &["ssh", "powershell", "autossh", "autossh-service", "docker-run", "docker-compose"];

static TEMPLATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\$(?:(?P<escaped>\$)|(?P<named>[_a-z][_a-z0-9]*)|\{(?P<braced>[_a-z][_a-z0-9]*)\}|(?P<invalid>))").unwrap()
});

/// `string.Template(text).safe_substitute(mapping)`
pub fn safe_substitute(text: &str, mapping: &HashMap<&str, String>) -> String {
    TEMPLATE_RE
        .replace_all(text, |caps: &regex::Captures| {
            if caps.name("escaped").is_some() {
                return "$".to_string();
            }
            let name = caps.name("named").or_else(|| caps.name("braced")).map(|m| m.as_str());
            match name.and_then(|n| mapping.get(n)) {
                Some(v) => v.clone(),
                None => caps[0].to_string(),
            }
        })
        .into_owned()
}

#[derive(Debug, Clone)]
pub struct ScriptContext<'a> {
    pub host_friendly_name: &'a str,
    /// 這台 Telepy 的網域：known_hosts 別名（`HostKeyAlias`）用它，所以換 SSH 主機不會變成「另一台伺服器」。
    /// This Telepy's domain: the known_hosts alias (`HostKeyAlias`) is built from it, so a new SSH host is not "another server".
    pub server_domain: &'a str,
    /// ssh 實際連的主機（`SSH_SERVER_DOMAIN`，沒設 = `server_domain`）。/ The host ssh dials (SSH_SERVER_DOMAIN, else server_domain).
    pub ssh_host: &'a str,
    pub reverse_port: i64,
    pub ssh_port: i64,
    /// Django 的 settings.REVERSE_SERVER_SSH_PORT 是 env 原字串。
    pub reverse_server_ssh_port: &'a str,
    pub username: &'a str,
    pub key_path: Option<&'a str>,
    /// docker 模板用：第一把 service key。/ For the docker templates.
    pub telepy_public_key: Option<&'a str>,
    /// gateway 的 host key（`type base64`）：有的話腳本把它釘住，裝置就只會連到真的 Telepy；沒有就退回不驗證（舊行為）。
    /// The gateway's host keys; when known the scripts pin them, otherwise they fall back to not checking (the old behaviour).
    pub gateway_host_keys: &'a [String],
    /// SSH over WebSocket：裝置只能出網頁 port 時，ssh 經 `telepy-ws.py` 把連線包進 `/ws/gateway/`。
    /// SSH over WebSocket for devices that can only reach the web port.
    pub ws: Option<WsCarrier<'a>>,
    /// 隧道的安裝代號：裝置上的檔案、服務、容器都用它取名（`crate::device_install::names`）。
    /// The tunnel's install id: files, services and containers on the device are named after it.
    pub install_id: &'a str,
}

/// SSH over WebSocket 需要的位址。/ What the WebSocket carrier needs.
#[derive(Debug, Clone, Copy)]
pub struct WsCarrier<'a> {
    /// `wss://host/ws/gateway/`
    pub url: &'a str,
    /// `https://host/api/join/telepy-ws.py`：python3 的備胎。/ The python3 fallback.
    pub client_url: &'a str,
    /// `https://host/api/join/carrier`：`/<target>` = 這台機器的預編 telepy-carrier。/ The prebuilt carrier, per target.
    pub carrier_url: &'a str,
    /// 自動：先連這個 SSH 的 `host:port`，連不上才走 WebSocket（`telepy-ws.py --tcp`）。None = 只走 WebSocket。
    /// Automatic: the SSH `host:port` first, the WebSocket only when that fails. None = the WebSocket only.
    pub tcp: Option<&'a str>,
}

impl WsCarrier<'_> {
    /// 小程式的參數：`[--tcp host:port] <ws url>`。/ The carrier's arguments.
    pub fn args(&self) -> String {
        match self.tcp {
            Some(t) => format!("--tcp {t} {}", self.url),
            None => self.url.to_string(),
        }
    }
}

/// 筆電 / 使用者層級腳本存放小程式的路徑。/ Where the carrier lives for user-level scripts and laptops.
pub const WS_CLIENT_PATH: &str = "~/.ssh/telepy-ws.py";

/// `uname -s`/`uname -m` → 預編載體的 target，sh 的 `case`（跟 `carriers::TARGETS` 同一張表；Windows 不在 bash 腳本裡）。
/// The sh `case` that maps `uname -s`/`uname -m` to a prebuilt carrier target (the same table as `carriers::TARGETS`).
pub fn carrier_case_sh() -> String {
    let mut s = String::from("case \"$(uname -s)/$(uname -m)\" in\n");
    for t in crate::carriers::TARGETS {
        let os = match t.os {
            "linux" => "Linux",
            "darwin" => "Darwin",
            _ => continue,
        };
        let pats: Vec<String> = t.machines.iter().map(|m| format!("{os}/{m}")).collect();
        s.push_str(&format!("    {}) WS_TARGET={} ;;\n", pats.join("|"), t.name));
    }
    s.push_str("    *) WS_TARGET=\"\" ;;\nesac\n");
    s
}

/// 找載體並寫包裝腳本的 sh 片段（使用者層級腳本與 systemd 服務共用）：先下載這台機器的預編 telepy-carrier（跑一次
/// `--version` 才算），沒有就 python3 配 telepy-ws.py；結束時 `WS_SH` 非空 = 包裝腳本寫好了。`dir` = 檔案放哪
/// （`$HOME/.ssh` 或 `/etc/ssh`）；`sudo` = `$SUDO ` 或空。安裝時有 `HTTPS_PROXY` 就把 `--proxy` 寫進包裝腳本（服務沒有環境變數）。
/// The sh that finds a carrier and writes the wrapper (shared by the user scripts and the systemd flavour): the prebuilt
/// telepy-carrier for this machine first (it must run `--version`), else python3 + telepy-ws.py; afterwards a non-empty
/// `WS_SH` means the wrapper is in place. An `HTTPS_PROXY` at install time is baked into the wrapper (services have no env).
fn carrier_setup(ws: &WsCarrier, dir: &str, names: &crate::device_install::names::Names, sudo: &str) -> String {
    format!(
        "WS_SH=\"\"\nWS_CMD=\"\"\n{sudo}mkdir -p \"{dir}\"\nWS_TMP=$(mktemp -d 2>/dev/null || echo \"$HOME/.telepy-ws-tmp\"); mkdir -p \"$WS_TMP\"\n\
         {case}\
         WS_PROXY=\"\"\n[ -z \"${{HTTPS_PROXY:-${{https_proxy:-}}}}\" ] || WS_PROXY=\"--proxy ${{HTTPS_PROXY:-$https_proxy}} \"\n\
         if [ -n \"$WS_TARGET\" ] && curl -fsSL '{carrier_url}/'\"$WS_TARGET\" -o \"$WS_TMP/bin\" && chmod 755 \"$WS_TMP/bin\" && \"$WS_TMP/bin\" --version >/dev/null 2>&1; then\n\
         \x20   {sudo}mv -f \"$WS_TMP/bin\" \"{dir}/{bin}\" && WS_CMD=\"{dir}/{bin}\" && echo \"[+] Web-port carrier: telepy-carrier ($WS_TARGET)\"\n\
         elif command -v python3 >/dev/null 2>&1 && curl -fsSL '{client_url}' -o \"$WS_TMP/py\"; then\n\
         \x20   {sudo}mv -f \"$WS_TMP/py\" \"{dir}/{py}\" && {sudo}chmod 755 \"{dir}/{py}\" && WS_CMD=\"python3 {dir}/{py}\" && echo \"[+] Web-port carrier: python3 {dir}/{py}\"\n\
         fi\n\
         rm -rf \"$WS_TMP\"\n\
         if [ -n \"$WS_CMD\" ]; then\n\
         \x20   printf '#!/bin/sh\\n# {desc}: the way to Telepy.\\nexec %s %s%s\\n' \"$WS_CMD\" \"$WS_PROXY\" '{args}' | {sudo}tee \"{dir}/{sh}\" >/dev/null && {sudo}chmod 755 \"{dir}/{sh}\" && WS_SH=\"{dir}/{sh}\"\n\
         fi\n",
        case = carrier_case_sh(),
        carrier_url = ws.carrier_url,
        client_url = ws.client_url,
        bin = names.ws_bin(),
        py = names.ws_py(),
        sh = names.ws_sh(),
        desc = names.description(),
        args = ws.args(),
    )
}

/// 使用者層級的 bash 腳本：找載體、組 ProxyCommand。回 (setup 區塊, ssh 選項)。自動：沒有載體就只走 SSH 的 port。
/// User-level bash scripts: find a carrier, build the ProxyCommand. Returns (setup, option). Automatic: without any
/// carrier the tunnel uses the SSH port only.
fn bash_ws(ws: Option<WsCarrier>, dir: &str, names: &crate::device_install::names::Names) -> (String, String) {
    let Some(ws) = ws else { return (String::new(), String::new()) };
    let setup = carrier_setup(&ws, dir, names, "");
    if ws.tcp.is_some() {
        let setup = format!(
            "\n# Automatic: the SSH port first, the web port (a WebSocket) when that is blocked; the SSH inside is unchanged.\n{setup}\
             PROXY_ARGS=()\n\
             if [ -n \"$WS_SH\" ]; then PROXY_ARGS=(-o \"ProxyCommand=$WS_SH\"); else echo 'No prebuilt telepy-carrier for this machine and no python3 (or the download failed): the tunnel uses the SSH port only.'; fi\n"
        );
        return (setup, "\"${PROXY_ARGS[@]}\" \\\n".to_string());
    }
    let setup = format!(
        "\n# Only the web port is open here: ssh rides inside a WebSocket to Telepy (the SSH inside is unchanged).\n{setup}\
         [ -n \"$WS_SH\" ] || {{ echo 'The web port needs the carrier: no prebuilt telepy-carrier for this machine and no python3 (or the download failed).'; exit 1; }}\n"
    );
    (setup, "-o \"ProxyCommand=$WS_SH\" \\\n".to_string())
}

/// keepalive 由跟 Telepy 的握手決定——跟一鍵加入（`join_install.sh` 的 "Keepalive probe"）同一條規則：先帶 SSH keepalive
/// 握手；逾時了、而不帶它的握手卻成功（這台的 ssh 計時器一設就誤觸發，OpenWrt #12574），就改用 TCP keepalive。握手不帶
/// 金鑰，不會登入。第二次不能靠 ssh 自己的計時器（壞的正是它），有 `timeout` 就用它限時。結果：`TELEPY_COMPAT=1` 與
/// `KEEPALIVE_ARGS`。`opts` / `proxy` = 這種腳本 ssh 指令裡的 host key 選項與到 Telepy 的路（照原樣接在續行後）。
/// The keepalive is decided by a handshake with Telepy — the same rule as the one-command join ("Keepalive probe" in
/// `join_install.sh`): with SSH keepalives first; if that times out while a handshake without them completes (an ssh
/// whose timers misfire as soon as one is set, OpenWrt #12574), TCP keepalive instead. No key is offered, nothing logs
/// in. The second try cannot rely on ssh's own timers (they are what is broken), so `timeout` bounds it when present.
/// Result: `TELEPY_COMPAT=1` and `KEEPALIVE_ARGS`. `opts` / `proxy` = this flavour's host-key options and way to Telepy.
pub fn keepalive_probe_sh(opts: &str, proxy: &str, host: &str, port: &str) -> String {
    format!(
        "\n# Keepalive, decided by a handshake with Telepy (the same rule as the one-command join): SSH keepalives every 30 s,\n\
         # unless a handshake with them times out while one without them completes (an ssh whose timers misfire,\n\
         # OpenWrt #12574): then TCP keepalive instead. No key is offered here; nothing logs in.\n\
         TELEPY_COMPAT=0\n\
         KEEPALIVE_ARGS=(-o \"ServerAliveInterval 30\" -o \"ServerAliveCountMax 3\")\n\
         TELEPY_TO=\"\"; command -v timeout >/dev/null 2>&1 && TELEPY_TO=\"timeout 30\"\n\
         telepy_handshake() {{\n\
         \x20   $TELEPY_TO ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \\\n\
         {opts}{proxy}-p {port} \"$@\" telepy@{host} true 2>&1 | tail -n 1\n\
         }}\n\
         TELEPY_FIRST=$(telepy_handshake -o ConnectTimeout=15 -o ServerAliveInterval=30)\n\
         case \"$TELEPY_FIRST\" in\n\
         \x20   *\"Permission denied\"*|*refused*|*resolve*|*\"No route\"*|*nreachable*|*\"Host key verification failed\"*|*IDENTIFICATION*) ;;\n\
         \x20   *) case \"$(telepy_handshake -o ServerAliveInterval=0)\" in\n\
         \x20          *\"Permission denied\"*)\n\
         \x20              TELEPY_COMPAT=1\n\
         \x20              KEEPALIVE_ARGS=(-o \"ServerAliveInterval 0\" -o \"ServerAliveCountMax 3\" -o \"TCPKeepAlive yes\")\n\
         \x20              echo \"[!] Compat mode: a handshake with SSH keepalives failed ($TELEPY_FIRST) but one without them completed, so this tunnel uses TCP keepalive (a dead link is noticed later).\" ;;\n\
         \x20      esac ;;\n\
         esac\n"
    )
}

/// PowerShell 版的同一條規則（第二次握手用背景工作限時 30 秒）；結果在 `$keepAlive`。/ The same rule in PowerShell (the
/// second handshake runs as a job bounded to 30 s); the result is `$keepAlive`.
pub const KEEPALIVE_PROBE_PS: &str = r#"# Keepalive, decided by a handshake with Telepy (the same rule as the one-command join): SSH keepalives, unless a
# handshake with them fails while one without them completes (an ssh whose timers misfire): then TCP keepalive instead.
# No key is offered here; nothing logs in.
$keepAlive = "-o ServerAliveInterval=15 -o ServerAliveCountMax=3"
function Test-TelepyHandshake([string]$extra) {
    $probe = "ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no $extra $hostKeyOptions -p $reverseServerSSHPort $sshUserHost exit 2>&1"
    $job = Start-Job -ScriptBlock { param($c) Invoke-Expression $c | Out-String } -ArgumentList $probe
    $answer = if (Wait-Job $job -Timeout 30) { Receive-Job $job | Out-String } else { "timed out" }
    Remove-Job $job -Force
    return $answer
}
try {
    $firstTry = Test-TelepyHandshake "-o ConnectTimeout=15 -o ServerAliveInterval=15"
    if ($firstTry -notmatch 'Permission denied|refused|resolve|No route|nreachable|Host key verification failed|IDENTIFICATION') {
        if ((Test-TelepyHandshake "-o ServerAliveInterval=0") -match 'Permission denied') {
            $keepAlive = "-o ServerAliveInterval=0 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes"
            echo "[!] Compat mode: a handshake with SSH keepalives failed but one without them completed, so this tunnel uses TCP keepalive (a dead link is noticed later)."
        }
    }
} catch {
    echo "[!] Could not test the keepalive ($_); using SSH keepalives."
}"#;

/// known_hosts 裡的別名（與一鍵加入相同）。/ The known_hosts alias (the same one the join script uses).
pub fn gateway_alias(server_domain: &str, reverse_server_ssh_port: &str) -> String {
    format!("telepy-{server_domain}-{reverse_server_ssh_port}")
}

/// 裝置的 host key 在筆電 known_hosts 裡的別名：`<伺服器別名>-device-<隧道 id>`——改名不影響，兩台 Telepy 也不會撞。
/// The device's alias in the laptop's known_hosts: `<server alias>-device-<tunnel id>` — survives renames, and two
/// Telepy servers never collide.
pub fn device_key_alias(server_domain: &str, reverse_server_ssh_port: &str, tunnel_id: i64) -> String {
    format!("{}-device-{tunnel_id}", server_alias(server_domain, reverse_server_ssh_port))
}

/// 裝置區塊怎麼核對裝置自己的 host key：known_hosts 裡的別名，以及 Telepy 有沒有釘住它（有 = 只認那把；還沒有 =
/// 第一次連線記下來、之後不同就拒絕，跟 Telepy 自己的第一次使用一樣）。
/// How a device stanza checks the device's own host key: its known_hosts alias, and whether Telepy has it pinned
/// (pinned = only that key; not yet = remember it on the first connection and refuse a different one later, like
/// Telepy's own first use).
pub struct DeviceHostKey<'a> {
    pub alias: &'a str,
    pub pinned: bool,
}

/// `<alias> <type> <base64>` 行（搭配 `HostKeyAlias`）。/ known_hosts lines keyed by the alias (for `HostKeyAlias`).
pub fn known_hosts_lines(alias: &str, keys: &[String]) -> String {
    keys.iter().map(|k| format!("{alias} {k}\n")).collect()
}

/// 依主機名稱的 known_hosts 行（容器版不能用 HostKeyAlias；非 22 port 寫成 `[host]:port`）。
/// known_hosts lines keyed by host for the container flavour (no HostKeyAlias there; `[host]:port` unless port 22).
pub fn known_hosts_lines_for_host(server_domain: &str, reverse_server_ssh_port: &str, keys: &[String]) -> String {
    let host = if reverse_server_ssh_port == "22" { server_domain.to_string() } else { format!("[{server_domain}]:{reverse_server_ssh_port}") };
    keys.iter().map(|k| format!("{host} {k}\n")).collect()
}

fn base_mapping(ctx: &ScriptContext) -> HashMap<&'static str, String> {
    let mut m = HashMap::new();
    m.insert("host_friendly_name", ctx.host_friendly_name.to_string());
    m.insert("username", ctx.username.to_string());
    // 模板裡的 `$server_domain` 都是 ssh 連的主機。/ `$server_domain` in the templates is always the host ssh dials.
    m.insert("server_domain", ctx.ssh_host.to_string());
    m.insert("reverse_port", ctx.reverse_port.to_string());
    m.insert("ssh_port", ctx.ssh_port.to_string());
    m.insert("reverse_server_ssh_port", ctx.reverse_server_ssh_port.to_string());
    let names = crate::device_install::names::Names::new(ctx.install_id);
    m.insert("install_id", ctx.install_id.to_string());
    m.insert("install_base", names.base());
    m.insert("install_description", names.description());
    m.insert("known_hosts_file", names.known_hosts());
    m
}

/// 「不驗證」的 ssh 選項（gateway 沒有 host key 時）。/ The no-check options (no gateway host key known).
const NO_CHECK_OPTIONS: &str = "-o \"StrictHostKeyChecking=no\" \\\n-o \"UserKnownHostsFile=/dev/null\" \\\n";

/// 使用者層級的 bash 腳本：先寫 `~/.ssh/telepy-<安裝代號>.known_hosts`，再用 `HostKeyAlias` 比對。回 (setup 區塊, ssh 選項)。
/// User-level bash scripts: write `~/.ssh/telepy-<install id>.known_hosts`, then pin through `HostKeyAlias`.
fn bash_pinning(ctx: &ScriptContext) -> (String, String) {
    if ctx.gateway_host_keys.is_empty() {
        return (String::new(), NO_CHECK_OPTIONS.to_string());
    }
    let alias = gateway_alias(ctx.server_domain, ctx.reverse_server_ssh_port);
    let setup = format!(
        "\n# Telepy's SSH host key: this tunnel only ever talks to the real server (no prompt, no impostor).\n\
         KNOWN_HOSTS=\"$HOME/.ssh/{}\"\n\
         mkdir -p \"$HOME/.ssh\" && chmod 700 \"$HOME/.ssh\"\n\
         cat > \"$KNOWN_HOSTS\" <<'TELEPY_HOST_KEYS'\n{}TELEPY_HOST_KEYS\n\
         chmod 600 \"$KNOWN_HOSTS\"\n",
        crate::device_install::names::Names::new(ctx.install_id).known_hosts(),
        known_hosts_lines(&alias, ctx.gateway_host_keys)
    );
    let options = format!("-o \"StrictHostKeyChecking=yes\" \\\n-o \"UserKnownHostsFile=$KNOWN_HOSTS\" \\\n-o \"HostKeyAlias={alias}\" \\\n");
    (setup, options)
}

/// `ssh_tunnel_script_factory(tunnel_type, ...).render()`；回 (script, language)。
pub fn render_script(tunnel_type: &str, ctx: &ScriptContext) -> Result<(String, &'static str), String> {
    let mut m = base_mapping(ctx);
    let names = crate::device_install::names::Names::new(ctx.install_id);
    let alias = gateway_alias(ctx.server_domain, ctx.reverse_server_ssh_port);
    let pinned = !ctx.gateway_host_keys.is_empty();
    match tunnel_type.to_ascii_lowercase().as_str() {
        "ssh" | "autossh" => {
            m.insert("key_option", ctx.key_path.map(|k| format!(" \\\n-i {k} ")).unwrap_or_else(|| " ".into()));
            let (setup, options) = bash_pinning(ctx);
            m.insert("known_hosts_setup", setup);
            m.insert("host_key_options", options);
            let (ws_setup, proxy) = bash_ws(ctx.ws, "$HOME/.ssh", &names);
            m.insert("ws_client_setup", ws_setup);
            m.insert("proxy_option", proxy);
            m.insert("keepalive_setup", keepalive_probe_sh(&m["host_key_options"], &m["proxy_option"], ctx.ssh_host, ctx.reverse_server_ssh_port));
            m.insert("keepalive_option", "\"${KEEPALIVE_ARGS[@]}\" \\\n".into());
            let tpl = if tunnel_type.eq_ignore_ascii_case("ssh") { SSH } else { AUTOSSH };
            Ok((safe_substitute(tpl, &m), "bash"))
        }
        "autossh-service" => {
            m.insert("key_option", ctx.key_path.map(|k| format!("-i {k} ")).unwrap_or_default());
            m.insert("unit_fixup", String::new());
            // 系統服務：載體與包裝腳本放 /etc/ssh（服務跑在別的帳號下）。unit 是引號 heredoc，不能用變數，所以 ProxyCommand
            // 寫死包裝腳本的路徑；自動模式下沒有載體就在寫好 unit 後把它拿掉。
            // System service: the carrier and its wrapper go to /etc/ssh (the service runs as another account). The unit
            // is a quoted heredoc, so the ProxyCommand names the wrapper's fixed path; in automatic mode it is taken
            // out of the written unit when no carrier could be installed.
            match ctx.ws {
                Some(ws) if ws.tcp.is_some() => {
                    m.insert(
                        "ws_client_setup",
                        format!("\n# Automatic: the SSH port first, the web port (a WebSocket) when that is blocked; the SSH inside is unchanged.\n{}", carrier_setup(&ws, "/etc/ssh", &names, "$SUDO ")),
                    );
                    m.insert("proxy_option", format!("-o \"ProxyCommand=/etc/ssh/{}\" ", names.ws_sh()));
                    m.insert("unit_fixup", "[ -n \"$WS_SH\" ] || { echo 'No prebuilt telepy-carrier for this machine and no python3 (or the download failed): the tunnel uses the SSH port only.'; $SUDO sed -i 's| -o \"ProxyCommand=[^\"]*\"||' \"$SERVICE_PATH\"; }\n".into());
                }
                Some(ws) => {
                    m.insert(
                        "ws_client_setup",
                        format!(
                            "\n# Only the web port is open here: ssh rides inside a WebSocket to Telepy (the SSH inside is unchanged).\n{}\
                             [ -n \"$WS_SH\" ] || {{ echo 'The web port needs the carrier: no prebuilt telepy-carrier for this machine and no python3 (or the download failed).'; exit 1; }}\n",
                            carrier_setup(&ws, "/etc/ssh", &names, "$SUDO ")
                        ),
                    );
                    m.insert("proxy_option", format!("-o \"ProxyCommand=/etc/ssh/{}\" ", names.ws_sh()));
                }
                None => {
                    m.insert("ws_client_setup", String::new());
                    m.insert("proxy_option", String::new());
                }
            }
            // 系統服務：known_hosts 放 /etc/ssh（服務跑在別的帳號下，家目錄不一定在）；unit 檔是引號 heredoc，路徑要寫死。
            // System service: the known_hosts goes to /etc/ssh (the service runs as another account); the unit is a
            // quoted heredoc, so the path is spelled out.
            if pinned {
                m.insert(
                    "known_hosts_setup",
                    format!(
                        "\n# Telepy's SSH host key: the service only ever talks to the real server (no prompt, no impostor).\n\
                         KNOWN_HOSTS=/etc/ssh/{}\n\
                         printf '%s' '{}' | $SUDO tee \"$KNOWN_HOSTS\" > /dev/null\n\
                         $SUDO chmod 644 \"$KNOWN_HOSTS\"\n",
                        names.known_hosts(),
                        known_hosts_lines(&alias, ctx.gateway_host_keys)
                    ),
                );
                m.insert("host_key_options", format!("-o \"StrictHostKeyChecking=yes\" -o \"UserKnownHostsFile=/etc/ssh/{}\" -o \"HostKeyAlias={alias}\" ", names.known_hosts()));
            } else {
                m.insert("known_hosts_setup", String::new());
                m.insert("host_key_options", "-o \"StrictHostKeyChecking=no\" -o \"UserKnownHostsFile=/dev/null\" ".into());
            }
            // keepalive：寫好 unit（引號 heredoc，不能用變數）後依握手的結果改。/ Keepalive: the unit is a quoted heredoc,
            // so the handshake's result is applied to the written file.
            m.insert("keepalive_setup", keepalive_probe_sh(&m["host_key_options"], "${WS_SH:+-o \"ProxyCommand=$WS_SH\" }", ctx.ssh_host, ctx.reverse_server_ssh_port));
            let fixup = format!(
                "{}[ \"$TELEPY_COMPAT\" != 1 ] || $SUDO sed -i 's|-o \"ServerAliveInterval 30\" -o \"ServerAliveCountMax 3\"|-o \"ServerAliveInterval 0\" -o \"ServerAliveCountMax 3\" -o \"TCPKeepAlive yes\"|' \"$SERVICE_PATH\"\n",
                m["unit_fixup"]
            );
            m.insert("unit_fixup", fixup);
            Ok((safe_substitute(AUTOSSH_SERVICE, &m), "bash"))
        }
        // 只走網頁 port 這兩種做不到；自動 = 只走 SSH 的 port（跟以前一樣）。
        // These cannot use the web port only; automatic = the SSH port only, as before.
        "powershell" if ctx.ws.is_some_and(|w| w.tcp.is_none()) => Err("The web-port carrier is only available for the ssh, autossh and systemd scripts.".into()),
        "docker-run" | "docker-compose" if ctx.ws.is_some_and(|w| w.tcp.is_none()) => Err("The web-port carrier is only available for the ssh, autossh and systemd scripts.".into()),
        "powershell" => {
            m.insert("key_option", ctx.key_path.map(|k| format!("-i '{k}' ")).unwrap_or_default());
            // 模板裡已經有 $knownHosts / $hostKeyOptions 的預設（不驗證）；有金鑰就寫檔並改成釘住。
            // The template defaults $knownHosts / $hostKeyOptions to no checking; with keys, write the file and pin.
            m.insert(
                "known_hosts_setup",
                if pinned {
                    format!(
                        "New-Item -ItemType Directory -Force \"$env:USERPROFILE\\.ssh\" | Out-Null\n\
                         [IO.File]::WriteAllText($knownHosts, @'\n{}'@ + \"`n\")\n\
                         $hostKeyOptions = \"-o StrictHostKeyChecking=yes -o UserKnownHostsFile=`\"$knownHosts`\" -o HostKeyAlias={alias}\"",
                        known_hosts_lines(&alias, ctx.gateway_host_keys)
                    )
                } else {
                    String::new()
                },
            );
            m.insert("keepalive_setup", KEEPALIVE_PROBE_PS.to_string());
            Ok((safe_substitute(POWERSHELL, &m), "powershell"))
        }
        "docker-run" | "docker-compose" => {
            // 容器版（jnovack/autossh）：金鑰掛到 /id_rsa、用環境變數設定；沒給 key_path 就用預設的 ~/.ssh/id_rsa
            //（compose 會展開 ~，shell 版用 $HOME 讓 bash 展開）。容器透過 host.docker.internal 連本機 sshd。
            // Container flavour (jnovack/autossh): key mounted at /id_rsa, env-driven; key_path defaults to
            // ~/.ssh/id_rsa (compose expands ~, the shell flavour uses $HOME). The container reaches the host's
            // sshd via host.docker.internal.
            let compose = tunnel_type.eq_ignore_ascii_case("docker-compose");
            let default_key = if compose { "~/.ssh/id_rsa" } else { "$HOME/.ssh/id_rsa" };
            m.insert("key_path", ctx.key_path.unwrap_or(default_key).to_string());
            // jnovack/autossh：/known_hosts 存在就 StrictHostKeyChecking=yes；沒有 HostKeyAlias，所以依主機名稱寫。
            // jnovack/autossh pins when /known_hosts exists; no HostKeyAlias there, so the lines are keyed by host.
            let host_lines = known_hosts_lines_for_host(ctx.ssh_host, ctx.reverse_server_ssh_port, ctx.gateway_host_keys);
            if pinned {
                m.insert(
                    "known_hosts_setup",
                    format!(
                        "\n# Telepy's SSH host key: the container only ever talks to the real server (no impostor).\n\
                         KNOWN_HOSTS=\"$HOME/.ssh/{kh}\"\n\
                         mkdir -p \"$HOME/.ssh\" && chmod 700 \"$HOME/.ssh\"\n\
                         cat > \"$KNOWN_HOSTS\" <<'TELEPY_HOST_KEYS'\n{host_lines}TELEPY_HOST_KEYS\n\
                         chmod 644 \"$KNOWN_HOSTS\"\n",
                        kh = names.known_hosts()
                    ),
                );
                m.insert("known_hosts_mount", "  -v \"$KNOWN_HOSTS\":/known_hosts:ro \\\n  -e SSH_STRICT_HOST_IP_CHECK=false \\\n".into());
                let args: Vec<String> = host_lines.lines().map(|l| format!("'{l}'")).collect();
                m.insert(
                    "known_hosts_step",
                    format!("#\n# 3) Pin Telepy's SSH host key, so the container only ever talks to the real server (save next to this file):\n#\n#      printf '%s\\n' {} > telepy_known_hosts\n", args.join(" ")),
                );
                m.insert("known_hosts_volume", "      - \"./telepy_known_hosts:/known_hosts:ro\"\n".into());
                m.insert("known_hosts_env", "      SSH_STRICT_HOST_IP_CHECK: \"false\"\n".into());
            } else {
                for k in ["known_hosts_setup", "known_hosts_mount", "known_hosts_step", "known_hosts_volume", "known_hosts_env"] {
                    m.insert(k, String::new());
                }
            }
            m.insert(
                "telepy_public_key",
                match ctx.telepy_public_key {
                    Some(k) => k.to_string(),
                    None if compose => "<Telepy service key not found - add one on the Keys page>".to_string(),
                    None => String::new(),
                },
            );
            let tpl = if compose { DOCKER_COMPOSE } else { DOCKER_RUN };
            Ok((safe_substitute(tpl, &m), if compose { "yaml" } else { "bash" }))
        }
        other => Err(format!("Invalid tunnel type {other}.")),
    }
}

static HOST_ALIAS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^A-Za-z0-9._-]+").unwrap());

/// `_sanitize_ssh_host_alias`
pub fn sanitize_host_alias(value: &str) -> String {
    let v = HOST_ALIAS_RE.replace_all(value.trim(), "-");
    let v = v.trim_matches('-');
    if v.is_empty() {
        "telepy-endpoint".to_string()
    } else {
        v.to_string()
    }
}

/// 舊版每台 Telepy 都用的伺服器區塊別名；第二台 Telepy 裝進同一份 config 時會把前一台的裝置導到自己。安裝指令在它
/// 確定是這台的、而且沒有區塊再用它時才拿掉。/ The server stanza alias every Telepy used before: a second Telepy in
/// the same config repointed the first one's devices. Install commands drop it only when it is provably this server's
/// and nothing uses it any more.
pub const LEGACY_SERVER_ALIAS: &str = "telepy-ssh-server";

/// 筆電 config 裡伺服器區塊的別名 = `telepy-<網域>-<port>`，跟 `HostKeyAlias`（known_hosts 的名字）同一個字串，所以每台
/// Telepy 各有自己的區塊。/ The laptop's server stanza alias: `telepy-<domain>-<port>`, the same string as its
/// `HostKeyAlias` (the known_hosts name), so every Telepy server gets its own block.
pub fn server_alias(server_domain: &str, reverse_server_ssh_port: &str) -> String {
    sanitize_host_alias(&gateway_alias(server_domain, reverse_server_ssh_port))
}

/// 裝置別名前綴的上限（個人設定 `ssh_alias_prefix`）。/ The longest device alias prefix (personal setting).
pub const MAX_ALIAS_PREFIX: usize = 24;

/// 裝置別名前綴（個人設定，例如 `work-` → `ssh work-pi`）：空 = 不加；只能用 Host 別名的字元、最多 24 個。
/// 同一台筆電裝了兩台 Telepy、裝置又同名時，給其中一台一個前綴就不會撞。回錯誤訊息或 None。
/// The device alias prefix (personal setting, e.g. `work-` → `ssh work-pi`): empty = none; alias characters only,
/// at most 24. Gives one of two Telepy servers on the same laptop distinct device names. Returns the problem, if any.
pub fn alias_prefix_problem(prefix: &str) -> Option<&'static str> {
    if prefix.chars().count() > MAX_ALIAS_PREFIX {
        return Some("At most 24 characters.");
    }
    if !prefix.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Some("Use letters, digits, '.', '_' or '-' only.");
    }
    if prefix.starts_with('-') {
        return Some("Must not start with '-'.");
    }
    None
}

/// 一台裝置的 Host 別名：`prefix` + 一個帳號 = 裝置名稱；多個帳號 = `<名稱>-<帳號>`。`used` 裡已有的（多台一起產生時，
/// 名稱經過清理後撞名，或撞到伺服器別名）加上 `-2`、`-3`…，並記進 `used`。
/// A device's Host aliases: one account = the device name; several = `<name>-<account>`. An alias already in `used`
/// (two devices whose cleaned names collide in a bulk config, or the server alias) gets `-2`, `-3`, …; every alias
/// returned is added to `used`.
pub fn device_aliases(prefix: &str, tunnel_name: &str, usernames: &[&str], used: &mut HashSet<String>) -> Vec<String> {
    let multi = usernames.len() > 1;
    usernames
        .iter()
        .map(|u| {
            let base = sanitize_host_alias(&if multi { format!("{prefix}{tunnel_name}-{u}") } else { format!("{prefix}{tunnel_name}") });
            let alias = if used.contains(&base) { (2..).map(|n| format!("{base}-{n}")).find(|a| !used.contains(a)).unwrap() } else { base };
            used.insert(alias.clone());
            alias
        })
        .collect()
}

/// `1,2,3` → id 清單（空白忽略）；有一個不是數字就是 `Err`。/ `1,2,3` → ids; any non-number is an error.
pub fn parse_id_list(s: &str) -> Result<Vec<i64>, ()> {
    s.split(',').map(str::trim).filter(|p| !p.is_empty()).map(|p| p.parse::<i64>().map_err(|_| ())).collect()
}

/// 多台 config 的逐台帳號：`<隧道>:<帳號>.<帳號>,<隧道>:<帳號>` → 隧道 id → 帳號 id。同一條隧道出現兩次 = 錯。
/// Per-device accounts for the bulk config: `<tunnel>:<account>.<account>,…` → tunnel id → account ids.
pub fn parse_picks(s: &str) -> Result<HashMap<i64, Vec<i64>>, ()> {
    let mut out = HashMap::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (tunnel, accounts) = part.split_once(':').ok_or(())?;
        let tunnel = tunnel.trim().parse::<i64>().map_err(|_| ())?;
        let ids: Vec<i64> = accounts.split('.').map(|a| a.trim().parse::<i64>().map_err(|_| ())).collect::<Result<_, _>>()?;
        if ids.is_empty() || out.insert(tunnel, ids).is_some() {
            return Err(());
        }
    }
    Ok(out)
}

fn ensure_newline(mut s: String) -> String {
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// 筆電端 `~/.ssh/known_hosts` 旁的檔案。/ The laptop-side file next to `~/.ssh/known_hosts`.
pub const LAPTOP_KNOWN_HOSTS: &str = "~/.ssh/telepy_known_hosts";

/// `SshClientTemplate`：筆電 `~/.ssh/config` 的裝置區塊（經伺服器區塊 [`server_alias`] 跳板）。`HostName` 是隧道的名稱：
/// gateway 的 direct-tcpip 以名稱認隧道（名稱全站唯一），port 只是給 ssh 看的（裝置的 sshd 在隧道另一端），舊的
/// `localhost:<號碼>` 寫法照常可用。裝置自己的 host key 跟伺服器的放在同一個 `~/.ssh/telepy_known_hosts`，用
/// [`device_key_alias`] 核對（見 [`DeviceHostKey`]）——不然拿到隧道金鑰的人就能在筆電這端冒充裝置。
/// 名稱不能當 ssh 主機名稱的舊隧道（有空白、`%`…，見 [`crate::tunnel_name`]）改寫 `HostName localhost` /
/// `Port <號碼>`：閘道照樣認得，ssh 也不會讀壞設定。
/// The laptop's device stanza: `HostName` is the tunnel's name (the gateway resolves it; the old
/// `localhost:<number>` form keeps working). An older tunnel whose name can't be an ssh host name (spaces, `%`…, see
/// [`crate::tunnel_name`]) gets `HostName localhost` / `Port <number>` instead, which the gateway resolves just the same.
/// The device's own host key is checked against the same `~/.ssh/telepy_known_hosts` under [`device_key_alias`] (see
/// [`DeviceHostKey`]) — otherwise whoever holds the tunnel key could pose as the device to laptops.
pub fn render_client_config(host_friendly_name: &str, ssh_username: &str, tunnel_name: &str, reverse_port: i64, server_alias: &str, key: &DeviceHostKey) -> String {
    let (host, port) = if crate::tunnel_name::ssh_safe(tunnel_name) { (tunnel_name.to_string(), "22".to_string()) } else { ("localhost".to_string(), reverse_port.to_string()) };
    let mut m: HashMap<&str, String> = HashMap::new();
    m.insert("username", "root".into());
    m.insert("server_domain", host);
    m.insert("reverse_port", port);
    m.insert("ssh_port", "-1".into());
    m.insert("reverse_server_ssh_port", String::new());
    m.insert("ssh_username", ssh_username.into());
    m.insert("host_friendly_name", sanitize_host_alias(host_friendly_name));
    let strict = if key.pinned { "yes" } else { "accept-new" };
    m.insert("host_key_lines", format!("StrictHostKeyChecking {strict}\n    UserKnownHostsFile {LAPTOP_KNOWN_HOSTS}\n    HostKeyAlias {}", key.alias));
    m.insert("client_proxy_command", format!("ProxyCommand ssh -W %h:%p {server_alias}"));
    ensure_newline(safe_substitute(SSH_CONFIG, &m))
}

/// 筆電側的 ProxyCommand（SSH over WebSocket；有 `tcp` = 自動，先試 SSH 的 port）。Windows 的寫法（`python`、`%d`）
/// 由前端在安裝時換。/ The laptop's ProxyCommand line (`tcp` = automatic: the SSH port first); the frontend rewrites
/// it for PowerShell (`python`, `%d`) at install time.
pub fn laptop_proxy_command(tcp: Option<&str>, ws_url: &str) -> String {
    match tcp {
        Some(t) => format!("ProxyCommand python3 {WS_CLIENT_PATH} --tcp {t} {ws_url}"),
        None => format!("ProxyCommand python3 {WS_CLIENT_PATH} {ws_url}"),
    }
}

/// `SshServerTemplate`：`Host telepy-<網域>-<port>` 區塊（[`server_alias`]）。有 gateway host key 就釘住（`~/.ssh/telepy_known_hosts` +
/// `HostKeyAlias`，檔案內容見 [`known_hosts_lines`]），沒有就照舊不驗證。`ws_proxy` = SSH over WebSocket 的
/// ProxyCommand 行（[`laptop_proxy_command`]），筆電只能出網頁 port 時用。
/// `ssh_host` = `HostName`（`SSH_SERVER_DOMAIN`，沒設就是網域）；別名與 `HostKeyAlias` 一律用網域。
/// The `Host telepy-<domain>-<port>` stanza ([`server_alias`]); pins the gateway's host keys when known, else no checking as before.
/// `ssh_host` is the `HostName` (SSH_SERVER_DOMAIN, else the domain); the alias and `HostKeyAlias` always use the domain.
pub fn render_server_config(server_domain: &str, ssh_host: &str, reverse_server_ssh_port: &str, gateway_host_keys: &[String], ws_proxy: Option<&str>) -> String {
    let mut m: HashMap<&str, String> = HashMap::new();
    m.insert("username", "root".into());
    m.insert("server_domain", ssh_host.into());
    m.insert("reverse_port", String::new());
    m.insert("ssh_port", "-1".into());
    m.insert("reverse_server_ssh_port", reverse_server_ssh_port.into());
    m.insert("ssh_username", "telepy".into());
    m.insert("host_friendly_name", server_alias(server_domain, reverse_server_ssh_port));
    m.insert(
        "host_key_lines",
        if gateway_host_keys.is_empty() {
            "StrictHostKeyChecking no".into()
        } else {
            format!("StrictHostKeyChecking yes\n    UserKnownHostsFile {LAPTOP_KNOWN_HOSTS}\n    HostKeyAlias {}", gateway_alias(server_domain, reverse_server_ssh_port))
        },
    );
    m.insert("client_proxy_command", ws_proxy.unwrap_or_default().to_string());
    ensure_newline(safe_substitute(SSH_CONFIG, &m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_lists_and_picks() {
        assert_eq!(parse_id_list("3, 1,,2"), Ok(vec![3, 1, 2]));
        assert_eq!(parse_id_list(""), Ok(vec![]));
        assert!(parse_id_list("1,x").is_err());
        let p = parse_picks("12:5.6, 13:7").unwrap();
        assert_eq!(p.get(&12), Some(&vec![5, 6]));
        assert_eq!(p.get(&13), Some(&vec![7]));
        assert!(parse_picks("").unwrap().is_empty());
        for bad in ["12", "12:", "x:1", "12:1.y", "12:1,12:2"] {
            assert!(parse_picks(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn device_aliases_follow_the_account_count_and_never_repeat() {
        let mut used = HashSet::from([server_alias("telepy.test", "24242")]);
        assert_eq!(device_aliases("", "pi", &["root"], &mut used), ["pi"]);
        assert_eq!(device_aliases("", "nas", &["root", "admin"], &mut used), ["nas-root", "nas-admin"]);
        // 前綴：每個別名都加，撞名規則照舊。/ A prefix goes on every alias; collisions are handled as before.
        assert_eq!(device_aliases("work-", "nas", &["root", "admin"], &mut used), ["work-nas-root", "work-nas-admin"]);
        assert_eq!(device_aliases("work.", "pi", &["root"], &mut used), ["work.pi"]);
        // 清理後撞名、撞到別台的「名稱-帳號」或伺服器別名 → 加編號。/ Collisions get a number.
        assert_eq!(device_aliases("", "pi!", &["root"], &mut used), ["pi-2"]);
        assert_eq!(device_aliases("", "nas-root", &["x"], &mut used), ["nas-root-2"]);
        assert_eq!(device_aliases("", "telepy-telepy.test-24242", &["x"], &mut used), ["telepy-telepy.test-24242-2"]);
        // 單台（空的 used）跟以前一樣。/ The single config (empty set) is unchanged.
        assert_eq!(device_aliases("", "my pi", &["a", "b"], &mut HashSet::new()), ["my-pi-a", "my-pi-b"]);
        assert!(device_aliases("", "pi", &[], &mut HashSet::new()).is_empty());
        assert_eq!(alias_prefix_problem(""), None);
        assert_eq!(alias_prefix_problem("work-"), None);
        assert!(alias_prefix_problem("work pi").is_some() && alias_prefix_problem("-x").is_some() && alias_prefix_problem(&"a".repeat(25)).is_some());
    }

    /// 假的 `ssh`：照 ServerAliveInterval 回答，並記下每次被叫。/ A stub `ssh` that answers by ServerAliveInterval and logs calls.
    fn stub_ssh(dir: &std::path::Path, with_alive: &str, without: &str) {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = format!(
            "#!/bin/sh\necho \"$*\" >> '{log}'\ncase \"$*\" in *ServerAliveInterval=0*) echo '{without}' >&2 ;; *) echo '{with_alive}' >&2 ;; esac\nexit 255\n",
            log = dir.join("calls").display()
        );
        std::fs::write(bin.join("ssh"), script).unwrap();
        std::fs::set_permissions(bin.join("ssh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// 真的 bash 跑握手片段（假的 ssh）：健康 = 30 秒的 SSH keepalive、只握一次；計時器誤觸發 = 相容模式；連不到 = 不猜。
    /// The handshake snippet in a real bash with a stub ssh: healthy = SSH keepalives after one handshake; misfiring
    /// timers = compat mode; unreachable = no guessing.
    #[test]
    fn the_keepalive_is_decided_by_a_handshake() {
        if std::process::Command::new("bash").arg("--version").output().is_err() {
            return;
        }
        let denied = "telepy@t: Permission denied (publickey).";
        let cases = [
            ("healthy", denied, denied, "-o ServerAliveInterval 30 -o ServerAliveCountMax 3", "0", 1),
            ("misfire", "Connection to 203.0.113.9 port 24242 timed out", denied, "-o ServerAliveInterval 0 -o ServerAliveCountMax 3 -o TCPKeepAlive yes", "1", 2),
            ("refused", "ssh: connect to host t port 24242: Connection refused", denied, "-o ServerAliveInterval 30 -o ServerAliveCountMax 3", "0", 1),
            ("down", "Connection to 203.0.113.9 port 24242 timed out", "Connection to 203.0.113.9 port 24242 timed out", "-o ServerAliveInterval 30 -o ServerAliveCountMax 3", "0", 2),
        ];
        for (name, with_alive, without, want, compat, calls) in cases {
            let dir = std::env::temp_dir().join(format!("telepy-keepalive-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            stub_ssh(&dir, with_alive, without);
            let snippet = keepalive_probe_sh("-o \"StrictHostKeyChecking=yes\" \\\n", "", "t", "24242");
            let out = std::process::Command::new("bash")
                .arg("-c")
                .arg(format!("{snippet}\nprintf '%s ' \"${{KEEPALIVE_ARGS[@]}}\"; echo; echo \"COMPAT=$TELEPY_COMPAT\""))
                .env("PATH", format!("{}:{}", dir.join("bin").display(), std::env::var("PATH").unwrap_or_default()))
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            assert!(text.contains(&format!("{want} \n")) && text.contains(&format!("COMPAT={compat}")), "{name}: {text}");
            let log = std::fs::read_to_string(dir.join("calls")).unwrap();
            assert_eq!(log.lines().count(), calls, "{name}: {log}");
            assert!(log.lines().all(|l| l.contains("-o PubkeyAuthentication=no") && l.contains("StrictHostKeyChecking=yes") && l.contains("-p 24242") && l.ends_with("telepy@t true")), "{name}: no key, same pinning: {log}");
            assert!(!log.lines().nth(1).is_some_and(|l| l.contains("ConnectTimeout")), "{name}: the second try uses no ssh timer: {log}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// 同一條規則的 PowerShell 版，用真的 pwsh 跑（`PWSH=<pwsh 的路徑>` 才跑）。/ The PowerShell twin in a real pwsh
    /// (only with `PWSH=<path to pwsh>`).
    #[test]
    fn the_powershell_keepalive_follows_the_same_rule() {
        let Ok(pwsh) = std::env::var("PWSH") else { return };
        let denied = "telepy@t: Permission denied (publickey).";
        for (name, with_alive, want) in [("healthy", denied, "-o ServerAliveInterval=15 -o ServerAliveCountMax=3"), ("misfire", "Connection to 203.0.113.9 port 24242 timed out", "-o ServerAliveInterval=0 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes")] {
            let dir = std::env::temp_dir().join(format!("telepy-keepalive-ps-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            stub_ssh(&dir, with_alive, denied);
            let script = dir.join("t.ps1");
            std::fs::write(&script, format!("$hostKeyOptions = \"-o StrictHostKeyChecking=yes\"\n$reverseServerSSHPort = \"24242\"\n$sshUserHost = \"telepy@t\"\n{KEEPALIVE_PROBE_PS}\nWrite-Output \"KA=$keepAlive\"\n")).unwrap();
            let out = std::process::Command::new(&pwsh)
                .args(["-NoProfile", "-File"])
                .arg(&script)
                .env("PATH", format!("{}:{}", dir.join("bin").display(), std::env::var("PATH").unwrap_or_default()))
                .env("HOME", &dir)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            assert!(text.contains(&format!("KA={want}")), "{name}: {text}{}", String::from_utf8_lossy(&out.stderr));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn substitute_semantics() {
        let mut m = HashMap::new();
        m.insert("a", "1".to_string());
        assert_eq!(safe_substitute("$a ${a} $b ${b} $$ $(x) $_", &m), "1 1 $b ${b} $ $(x) $_");
    }

    #[test]
    fn ssh_script_with_and_without_key() {
        let ctx = ScriptContext {
            host_friendly_name: "My Box",
            server_domain: "telepy.test",
            ssh_host: "telepy.test",
            reverse_port: 12345,
            ssh_port: 22,
            reverse_server_ssh_port: "24242",
            username: "root",
            key_path: None,
            telepy_public_key: None,
            gateway_host_keys: &[],
            ws: None,
            install_id: "k7m2q9xd",
        };
        let (s, lang) = render_script("ssh", &ctx).unwrap();
        assert_eq!(lang, "bash");
        assert!(s.contains("ssh  \\\n\"${KEEPALIVE_ARGS[@]}\" \\\n"), "the keepalive the handshake chose: {s}");
        assert!(s.contains("telepy_handshake() {") && s.contains("TELEPY_FIRST=$(telepy_handshake -o ConnectTimeout=15 -o ServerAliveInterval=30)"), "{s}");
        assert!(s.contains("-NR '*:0:localhost:22'"), "the number is the gateway's business; the device asks for 0: {s}");
        assert!(s.contains("telepy@telepy.test"));
        let ctx2 = ScriptContext { key_path: Some("~/.ssh/id_rsa"), ..ctx.clone() };
        let (s, _) = render_script("autossh", &ctx2).unwrap();
        assert!(s.contains("-i ~/.ssh/id_rsa"));
        let (s, lang) = render_script("powershell", &ctx2).unwrap();
        assert_eq!(lang, "powershell");
        assert!(s.contains("$sshOptions = \"-i '~/.ssh/id_rsa' $keepAlive $hostKeyOptions\"") && s.contains("function Test-TelepyHandshake"), "{s}");
        assert!(s.contains("$Host.UI.RawUI.ReadKey"), "unknown $identifiers must survive");
        assert!(render_script("nope", &ctx).is_err());
    }

    #[test]
    fn docker_scripts_use_a_real_image_and_reach_the_host() {
        let ctx = ScriptContext {
            host_friendly_name: "My Box",
            server_domain: "telepy.test",
            ssh_host: "telepy.test",
            reverse_port: 12345,
            ssh_port: 22,
            reverse_server_ssh_port: "24242",
            username: "root",
            key_path: None,
            telepy_public_key: Some("ssh-ed25519 AAAAtest web-service"),
            gateway_host_keys: &[],
            ws: None,
            install_id: "k7m2q9xd",
        };
        let (s, lang) = render_script("docker-compose", &ctx).unwrap();
        assert_eq!(lang, "yaml");
        assert!(s.contains("image: jnovack/autossh:latest"), "{s}");
        assert!(s.contains("- \"~/.ssh/id_rsa:/id_rsa:ro\""), "default key path: {s}");
        assert!(s.contains("- \"host.docker.internal:host-gateway\""));
        assert!(s.contains("SSH_TARGET_HOST: host.docker.internal"));
        assert!(s.contains("SSH_TUNNEL_PORT: \"0\"") && s.contains("SSH_TARGET_PORT: \"22\"") && s.contains("SSH_REMOTE_PORT: \"24242\""));
        assert!(s.contains("SSH_REMOTE_HOST: \"telepy.test\"") && s.contains("SSH_REMOTE_USER: telepy"));
        assert!(s.contains("grep -qxF 'ssh-ed25519 AAAAtest web-service' ~/.ssh/authorized_keys"), "append, never overwrite: {s}");
        assert!(s.contains("docker compose -f telepy-docker-compose.yml up -d"));
        assert!(!s.contains("ports:"), "the reverse port is bound on the Telepy server, not on the device");
        assert!(!s.contains("${"), "every placeholder must be substituted (compose would try to expand it): {s}");
        // 裝置上的名稱用安裝代號，不用隧道名稱。/ Named after the install id, not the tunnel.
        assert!(s.contains("container_name: telepy-k7m2q9xd\n") && !s.contains("My Box"), "{s}");

        let (s, lang) = render_script("docker-run", &ScriptContext { key_path: Some("/keys/dev.pem"), ..ctx.clone() }).unwrap();
        assert_eq!(lang, "bash");
        assert!(s.contains("KEY_FILE=/keys/dev.pem\n"), "{s}");
        assert!(s.contains("-v \"$KEY_FILE\":/id_rsa:ro"));
        assert!(s.contains("--add-host host.docker.internal:host-gateway"));
        assert!(s.contains("-e SSH_TUNNEL_PORT=0") && s.contains("-e SSH_TARGET_PORT=22") && s.contains("-e SSH_REMOTE_HOST=telepy.test"));
        assert!(s.contains("TELEPY_KEY='ssh-ed25519 AAAAtest web-service'"));
        assert!(s.contains(">> ~/.ssh/authorized_keys") && !s.contains(" > ~/.ssh/authorized_keys"), "append only: {s}");
        assert!(s.contains("jnovack/autossh:latest"));
        assert!(s.contains("docker rm -f telepy-k7m2q9xd ") && s.contains("--name telepy-k7m2q9xd \\\n") && !s.contains("My Box"), "{s}");
        let (s, _) = render_script("docker-run", &ctx).unwrap();
        assert!(s.contains("KEY_FILE=$HOME/.ssh/id_rsa\n"), "{s}");
        let (s, _) = render_script("docker-run", &ScriptContext { telepy_public_key: None, ..ctx.clone() }).unwrap();
        assert!(s.contains("TELEPY_KEY=''"), "no service key → nothing appended: {s}");
    }

    /// gateway 有 host key：每種腳本都把它釘住（known_hosts + StrictHostKeyChecking=yes），沒有就照舊不驗證。
    /// With gateway host keys every script pins them; without, the old no-check options stay.
    #[test]
    fn scripts_pin_the_gateway_host_key_when_known() {
        let keys = vec!["ssh-ed25519 AAAAgateway".to_string(), "ssh-rsa AAAArsa".to_string()];
        let ctx = ScriptContext {
            host_friendly_name: "My Box",
            server_domain: "telepy.test",
            ssh_host: "telepy.test",
            reverse_port: 12345,
            ssh_port: 22,
            reverse_server_ssh_port: "24242",
            username: "ubuntu",
            key_path: Some("~/.ssh/id_rsa"),
            telepy_public_key: Some("ssh-ed25519 AAAAtest web-service"),
            gateway_host_keys: &keys,
            ws: None,
            install_id: "k7m2q9xd",
        };
        for kind in ["ssh", "autossh"] {
            let (s, _) = render_script(kind, &ctx).unwrap();
            assert!(s.contains("telepy-telepy.test-24242 ssh-ed25519 AAAAgateway\ntelepy-telepy.test-24242 ssh-rsa AAAArsa\nTELEPY_HOST_KEYS"), "{kind}: {s}");
            assert!(s.contains("-o \"StrictHostKeyChecking=yes\" \\\n-o \"UserKnownHostsFile=$KNOWN_HOSTS\" \\\n-o \"HostKeyAlias=telepy-telepy.test-24242\" \\\n"), "{kind}: {s}");
            assert!(!s.contains("StrictHostKeyChecking=no"), "{kind}: {s}");
            assert!(s.contains("chmod 600 \"$KNOWN_HOSTS\""), "{kind}: {s}");
            assert!(s.contains("KNOWN_HOSTS=\"$HOME/.ssh/telepy-k7m2q9xd.known_hosts\""), "one file per tunnel: {kind}: {s}");
        }
        let (s, _) = render_script("autossh-service", &ctx).unwrap();
        assert!(s.contains("| $SUDO tee \"$KNOWN_HOSTS\""), "{s}");
        assert!(s.contains("-o \"UserKnownHostsFile=/etc/ssh/telepy-k7m2q9xd.known_hosts\" -o \"HostKeyAlias=telepy-telepy.test-24242\" -i ~/.ssh/id_rsa -p 24242"), "{s}");
        assert!(s.contains("SERVICE_PATH=\"/etc/systemd/system/telepy-k7m2q9xd.service\"") && s.contains("Description=Telepy reverse tunnel k7m2q9xd\n"), "{s}");
        assert!(s.contains("LogsDirectory=telepy-k7m2q9xd\n") && s.contains("systemctl restart telepy-k7m2q9xd.service"), "{s}");
        let (s, _) = render_script("powershell", &ctx).unwrap();
        assert!(s.contains("$knownHosts = \"$env:USERPROFILE\\.ssh\\telepy-k7m2q9xd.known_hosts\""), "{s}");
        assert!(s.contains("[IO.File]::WriteAllText($knownHosts, @'\ntelepy-telepy.test-24242 ssh-ed25519 AAAAgateway\ntelepy-telepy.test-24242 ssh-rsa AAAArsa\n'@"), "{s}");
        assert!(s.contains("$hostKeyOptions = \"-o StrictHostKeyChecking=yes -o UserKnownHostsFile=`\"$knownHosts`\" -o HostKeyAlias=telepy-telepy.test-24242\""), "{s}");
        assert!(s.contains("$keepAlive $hostKeyOptions\"") && s.contains("$keepAlive = \"-o ServerAliveInterval=15 -o ServerAliveCountMax=3\""), "{s}");
        // 容器版依主機名稱（非 22 port → [host]:port），掛到 /known_hosts。/ Container: keyed by host, mounted at /known_hosts.
        let (s, _) = render_script("docker-run", &ctx).unwrap();
        assert!(s.contains("[telepy.test]:24242 ssh-ed25519 AAAAgateway\n[telepy.test]:24242 ssh-rsa AAAArsa\nTELEPY_HOST_KEYS"), "{s}");
        assert!(s.contains("-v \"$KNOWN_HOSTS\":/known_hosts:ro \\\n  -e SSH_STRICT_HOST_IP_CHECK=false \\\n  -e SSH_REMOTE_USER=telepy"), "{s}");
        let (s, _) = render_script("docker-compose", &ctx).unwrap();
        assert!(s.contains("printf '%s\\n' '[telepy.test]:24242 ssh-ed25519 AAAAgateway' '[telepy.test]:24242 ssh-rsa AAAArsa' > telepy_known_hosts"), "{s}");
        assert!(s.contains("- \"./telepy_known_hosts:/known_hosts:ro\"\n    environment:\n      SSH_STRICT_HOST_IP_CHECK: \"false\"\n"), "{s}");
        assert!(!s.contains("${"), "{s}");
        let port22 = ScriptContext { reverse_server_ssh_port: "22", ..ctx.clone() };
        let (s, _) = render_script("docker-run", &port22).unwrap();
        assert!(s.contains("\ntelepy.test ssh-ed25519 AAAAgateway\n"), "port 22 is keyed by the bare host: {s}");

        // 沒有金鑰：舊行為。/ No keys: the old behaviour.
        let bare = ScriptContext { gateway_host_keys: &[], ..ctx.clone() };
        for kind in ["ssh", "autossh", "autossh-service"] {
            let (s, _) = render_script(kind, &bare).unwrap();
            assert!(s.contains("StrictHostKeyChecking=no") && s.contains("UserKnownHostsFile=/dev/null") && !s.contains("telepy_known_hosts"), "{kind}: {s}");
        }
        let (s, _) = render_script("powershell", &bare).unwrap();
        assert!(s.contains("$hostKeyOptions = \"-o StrictHostKeyChecking=no\"") && !s.contains("WriteAllText($knownHosts"), "{s}");
        for kind in ["docker-run", "docker-compose"] {
            let (s, _) = render_script(kind, &bare).unwrap();
            assert!(!s.contains("known_hosts") && !s.contains("${"), "{kind}: {s}");
        }
    }

    /// SSH 主機另外設：ssh 連到它，known_hosts 別名（伺服器身分）仍然是網域，所以舊的筆電設定與裝置都認得。
    /// A separate SSH host: ssh dials it, while the known_hosts alias (the server's identity) stays the domain.
    #[test]
    fn a_separate_ssh_host_changes_only_where_ssh_dials() {
        let keys = vec!["ssh-ed25519 AAAAgateway".to_string()];
        let ctx = ScriptContext {
            host_friendly_name: "My Box",
            server_domain: "telepy.test",
            ssh_host: "ssh.telepy.test",
            reverse_port: 12345,
            ssh_port: 22,
            reverse_server_ssh_port: "24242",
            username: "ubuntu",
            key_path: None,
            telepy_public_key: Some("ssh-ed25519 AAAAtest web-service"),
            gateway_host_keys: &keys,
            ws: None,
            install_id: "k7m2q9xd",
        };
        for kind in ["ssh", "autossh"] {
            let (s, _) = render_script(kind, &ctx).unwrap();
            assert!(s.contains("telepy@ssh.telepy.test") && !s.contains("telepy@telepy.test"), "{kind}: {s}");
            assert!(s.contains("HostKeyAlias=telepy-telepy.test-24242"), "{kind}: {s}");
        }
        let (s, _) = render_script("autossh-service", &ctx).unwrap();
        assert!(s.contains("-p 24242 -NR '*:0:localhost:22' telepy@ssh.telepy.test") && s.contains("HostKeyAlias=telepy-telepy.test-24242"), "{s}");
        let (s, _) = render_script("powershell", &ctx).unwrap();
        assert!(s.contains("\"telepy@ssh.telepy.test\"") && s.contains("HostKeyAlias=telepy-telepy.test-24242"), "{s}");
        // 容器版沒有 HostKeyAlias：known_hosts 依連的主機寫。/ Containers have no alias: keyed by the dialled host.
        let (s, _) = render_script("docker-run", &ctx).unwrap();
        assert!(s.contains("-e SSH_REMOTE_HOST=ssh.telepy.test") && s.contains("[ssh.telepy.test]:24242 ssh-ed25519 AAAAgateway\n"), "{s}");
        let (s, _) = render_script("docker-compose", &ctx).unwrap();
        assert!(s.contains("SSH_REMOTE_HOST: \"ssh.telepy.test\"") && s.contains("'[ssh.telepy.test]:24242 ssh-ed25519 AAAAgateway'"), "{s}");
        let server = render_server_config("telepy.test", "ssh.telepy.test", "24242", &keys, None);
        assert!(server.starts_with("Host telepy-telepy.test-24242\n"), "the alias stays the server's identity: {server}");
        assert!(server.contains("HostName ssh.telepy.test\n") && server.contains("HostKeyAlias telepy-telepy.test-24242\n"), "{server}");
    }

    /// 自動：小程式帶 `--tcp <SSH 主機>:<port>`；沒有 python3 就只走 SSH 的 port；PowerShell / Docker 只走 SSH 的 port。
    /// Automatic: the carrier gets `--tcp <ssh host>:<port>`; no python3 = the SSH port only; PowerShell / Docker use the SSH port.
    #[test]
    fn automatic_scripts_try_the_ssh_port_first() {
        let ws = WsCarrier { url: "wss://t.test/ws/gateway/", client_url: "https://t.test/api/join/telepy-ws.py", carrier_url: "https://t.test/api/join/carrier", tcp: Some("ssh.t.test:24242") };
        let ctx = ScriptContext {
            host_friendly_name: "box",
            server_domain: "t.test",
            ssh_host: "ssh.t.test",
            reverse_port: 1,
            ssh_port: 22,
            reverse_server_ssh_port: "24242",
            username: "ubuntu",
            key_path: None,
            telepy_public_key: Some("ssh-ed25519 AAAAtest web-service"),
            gateway_host_keys: &[],
            ws: Some(ws),
            install_id: "k7m2q9xd",
        };
        for kind in ["ssh", "autossh"] {
            let (s, _) = render_script(kind, &ctx).unwrap();
            // 先抓預編的 telepy-carrier，沒有再 python3；包裝腳本帶 --tcp；兩者都沒有就只走 SSH 的 port，不是錯。
            // The prebuilt carrier first, python3 second; the wrapper carries --tcp; neither = the SSH port only, no error.
            assert!(s.contains("curl -fsSL 'https://t.test/api/join/carrier/'\"$WS_TARGET\"") && s.contains("Linux/x86_64|Linux/amd64) WS_TARGET=x86_64-unknown-linux-musl ;;"), "{kind}: {s}");
            assert!(s.contains("curl -fsSL 'https://t.test/api/join/telepy-ws.py'") && s.contains("'--tcp ssh.t.test:24242 wss://t.test/ws/gateway/'"), "{kind}: {s}");
            assert!(s.contains("PROXY_ARGS=(-o \"ProxyCommand=$WS_SH\")") && s.contains("$HOME/.ssh/telepy-k7m2q9xd-ws.sh"), "{kind}: {s}");
            assert!(s.contains("\"${PROXY_ARGS[@]}\" \\\n") && s.contains("-p 24242"), "{kind}: {s}");
            assert!(s.contains("the tunnel uses the SSH port only") && !s.contains("The web port needs the carrier"), "{kind}: no carrier is not fatal: {s}");
            assert!(s.contains("WS_PROXY=\"--proxy ${HTTPS_PROXY:-$https_proxy} \""), "{kind}: an HTTPS_PROXY at install time is baked in: {s}");
        }
        let (s, _) = render_script("autossh-service", &ctx).unwrap();
        assert!(s.contains("-o \"ProxyCommand=/etc/ssh/telepy-k7m2q9xd-ws.sh\" "), "{s}");
        assert!(s.contains("$SUDO mv -f \"$WS_TMP/bin\" \"/etc/ssh/telepy-k7m2q9xd-ws.bin\"") && s.contains("[ -n \"$WS_SH\" ] || { echo") && s.contains("$SUDO sed -i"), "{s}");
        assert!(!s.contains("${ws_") && !s.contains("${proxy_option}") && !s.contains("${unit_fixup}") && !s.contains("${known_hosts_setup}"), "every placeholder substituted: {s}");
        let web_only_ssh = render_script("ssh", &ScriptContext { ws: Some(WsCarrier { tcp: None, ..ws }), ..ctx.clone() }).unwrap().0;
        assert!(web_only_ssh.contains("The web port needs the carrier") && web_only_ssh.contains("-o \"ProxyCommand=$WS_SH\" \\\n"), "{web_only_ssh}");
        for kind in ["powershell", "docker-run", "docker-compose"] {
            let (s, _) = render_script(kind, &ctx).unwrap();
            assert!(!s.contains("ProxyCommand") && !s.contains("telepy-ws"), "{kind}: {s}");
        }
        // 只走網頁 port：PowerShell / Docker 照舊拒絕。/ Web port only: still refused there.
        let web_only = ScriptContext { ws: Some(WsCarrier { tcp: None, ..ws }), ..ctx.clone() };
        assert!(render_script("powershell", &web_only).is_err() && render_script("docker-run", &web_only).is_err());
        assert_eq!(laptop_proxy_command(Some("ssh.t.test:24242"), "wss://t.test/ws/gateway/"), "ProxyCommand python3 ~/.ssh/telepy-ws.py --tcp ssh.t.test:24242 wss://t.test/ws/gateway/");
        assert_eq!(laptop_proxy_command(None, "wss://t.test/ws/gateway/"), "ProxyCommand python3 ~/.ssh/telepy-ws.py wss://t.test/ws/gateway/");
    }

    /// sh 的 case 跟 `carriers::TARGETS` 同一張表。/ The sh case lists every target of the table.
    #[test]
    fn carrier_case_matches_the_target_table() {
        let case = carrier_case_sh();
        for t in crate::carriers::TARGETS.iter().filter(|t| t.os != "windows") {
            let os = if t.os == "linux" { "Linux" } else { "Darwin" };
            for m in t.machines {
                assert!(case.contains(&format!("{os}/{m}")), "{os}/{m} missing in:\n{case}");
            }
            assert!(case.contains(&format!("WS_TARGET={} ;;", t.name)));
        }
        assert!(!case.contains("windows"));
    }

    #[test]
    fn ssh_config_blocks() {
        let server = render_server_config("telepy.test", "telepy.test", "24242", &[], None);
        assert!(server.contains("StrictHostKeyChecking no\n"), "{server}");
        let pinned = render_server_config("telepy.test", "telepy.test", "24242", &["ssh-ed25519 AAAAgateway".to_string()], None);
        assert!(pinned.contains("    StrictHostKeyChecking yes\n    UserKnownHostsFile ~/.ssh/telepy_known_hosts\n    HostKeyAlias telepy-telepy.test-24242\n    User telepy\n"), "{pinned}");
        assert_eq!(known_hosts_lines("telepy-telepy.test-24242", &["ssh-ed25519 AAAAgateway".to_string()]), "telepy-telepy.test-24242 ssh-ed25519 AAAAgateway\n");
        let server = render_server_config("telepy.test", "telepy.test", "24242", &[], None);
        assert!(server.starts_with("Host telepy-telepy.test-24242\n"), "the server alias is its HostKeyAlias: {server}");
        assert_eq!(server_alias("telepy.test", ""), "telepy-telepy.test");
        assert!(server.contains("Port  24242\n"));
        assert!(server.contains("User telepy\n"));
        assert!(server.ends_with('\n'));
        let alias = device_key_alias("telepy.test", "24242", 7);
        assert_eq!(alias, "telepy-telepy.test-24242-device-7");
        assert_eq!(device_key_alias("telepy.test", "", 7), "telepy-telepy.test-device-7", "built on the cleaned server alias");
        let client = render_client_config("MyBox", "ubuntu", "MyBox", 30101, "telepy-telepy.test-24242", &DeviceHostKey { alias: &alias, pinned: true });
        assert!(client.starts_with("Host MyBox\n"), "{client}");
        assert!(
            client.contains("    StrictHostKeyChecking yes\n    UserKnownHostsFile ~/.ssh/telepy_known_hosts\n    HostKeyAlias telepy-telepy.test-24242-device-7\n"),
            "a pinned device is checked like the server: {client}"
        );
        let fresh = render_client_config("MyBox", "ubuntu", "MyBox", 30101, "telepy-telepy.test-24242", &DeviceHostKey { alias: &alias, pinned: false });
        assert!(fresh.contains("    StrictHostKeyChecking accept-new\n    UserKnownHostsFile ~/.ssh/telepy_known_hosts\n"), "nothing pinned yet: first use: {fresh}");
        assert!(client.contains("HostName MyBox\n"), "the tunnel's name picks the tunnel at the gateway: {client}");
        assert!(client.contains("Port 22 \n"));
        assert!(client.contains("ProxyCommand ssh -W %h:%p telepy-telepy.test-24242\n"), "{client}");
        // 舊名稱不能當主機名稱（空白會讓 ssh 讀壞設定）：改用閘道的 `localhost:<號碼>`。
        // An older name that can't be a host name (a space breaks the config): the gateway's `localhost:<number>`.
        let old = render_client_config("My Box!", "ubuntu", "My Box!", 30101, "telepy-telepy.test-24242", &DeviceHostKey { alias: &alias, pinned: true });
        assert!(old.starts_with("Host My-Box\n"), "{old}");
        assert!(old.contains("HostName localhost\n") && old.contains("Port 30101 \n"), "{old}");
        assert_eq!(sanitize_host_alias("   "), "telepy-endpoint");
    }
}
