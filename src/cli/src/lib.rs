//! `telepy`：Telepy 的命令列。給「在終端機裡」的那些事：看隧道（`ls` / `status`）、直接 `ssh` / `scp` / `sftp` 進裝置
//! （寫好 ssh config 與 Telepy 的 known_hosts 再交給系統的 OpenSSH）、在一台或一群裝置上跑指令（`exec`，經後端，
//! 指令規則與稽核照舊）、搬檔案（`cp`）、看 / 結束 session、播錄影、跑工具箱片段，以及 `doctor`。
//! 登入用瀏覽器的 OAuth（PKCE、loopback）或個人 API token（`--token tpt_…`、`TELEPY_TOKEN`，給 CI）。
//! `telepy`, Telepy's command line: list tunnels (`ls` / `status`), `ssh` / `scp` / `sftp` straight into devices
//! (the generated ssh config and Telepy's known_hosts, then the system OpenSSH), run commands on one device or a
//! group (`exec`, through the backend: command rules and audit apply), copy files (`cp`), see / end sessions, play
//! recordings, run toolbox snippets, and `doctor`. Sign in with the browser (OAuth + PKCE, loopback) or a personal
//! API token (`--token tpt_…`, `TELEPY_TOKEN` for CI).

pub mod activity;
pub mod api;
pub mod cast;
pub mod creds;
pub mod tapi;
/// Tapi 的像素格：與伺服器共用同一個檔（網頁的 `lib/mascot.ts` 是同一份）。/ Tapi's grids, shared with the server.
#[path = "../../backend-api/src/mascot.rs"]
pub mod mascot;
pub mod oauth;
pub mod signed_in;
pub mod snippets;
pub mod sshcfg;
pub mod table;
pub mod target;

use std::collections::HashMap;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use reqwest::Method;
use serde_json::{json, Value};

use api::Api;
use creds::Kind;

/// OAuth 登入預設要的 scope（不含 `network:scan` / `browser:use`；要就用 `--scope`）。
/// Scopes the browser sign-in asks for by default.
pub const DEFAULT_SCOPE: &str = "tunnels:read ssh:exec ssh:files";

/// 版本：發行版由 CI 帶 `TELEPY_VERSION`（Telepy 發行的 tag，去掉開頭的 `v`）編進來，跟伺服器同一個版號；
/// 自己編的就是 Cargo.toml 的版本（一直是 0.1.0）。
/// The version: release builds get `TELEPY_VERSION` (the Telepy release tag without its `v`) from CI, so the CLI
/// carries the server's version number; a local build reports Cargo.toml's (always 0.1.0).
pub const VERSION: &str = match option_env!("TELEPY_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

#[derive(Parser, Debug)]
#[command(name = "telepy", version = VERSION, about = "Telepy from the command line: tunnels, SSH, commands, files, sessions and recordings.")]
pub struct Cli {
    /// Telepy server URL (default: the one you signed in to)
    #[arg(long, global = true, env = "TELEPY_URL")]
    pub server: Option<String>,
    /// Personal API token (tpt_…) instead of the stored sign-in; handy in CI
    #[arg(long, global = true, env = "TELEPY_TOKEN", hide_env_values = true)]
    pub token: Option<String>,
    #[command(subcommand)]
    pub command: Cmd,
}

#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Sign in: the browser (OAuth) or a personal API token
    Login(LoginArgs),
    /// Forget the stored sign-in (and revoke it on the server when it was a browser sign-in)
    Logout,
    /// Who you are signed in as, and with what
    Whoami(JsonFlag),
    /// List tunnels with health, latency, accounts and labels
    Ls(LsArgs),
    /// One tunnel in detail: health, uptime, device facts and warnings
    Status(StatusArgs),
    /// SSH into a device through its tunnel (system ssh with Telepy's generated config)
    Ssh(SshArgs),
    /// Copy files with scp; write a remote side as <tunnel>[@account]:<path>
    Scp(ScpArgs),
    /// Open sftp to a device
    Sftp(SftpArgs),
    /// Install Telepy's ssh config blocks into ~/.ssh/config (like the web's SSH config dialog)
    Config(ConfigArgs),
    /// Run a command on one or many devices through Telepy (command rules apply)
    Exec(ExecArgs),
    /// Copy a file to or from a device over SFTP; write the remote side as <tunnel>[@account]:<path>
    Cp(CpArgs),
    /// Live sessions on your tunnels; `sessions end <id>` ends one
    Sessions(SessionsArgs),
    /// Terminal recordings: list or play one in this terminal
    Recordings(RecordingsArgs),
    /// Your toolbox snippets
    Snippets(SnippetsArgs),
    /// Run a toolbox snippet on a device
    Run(RunArgs),
    /// A scripted browser that browses through a device: `browse <tunnel> [url]` opens one, then text / shot / click / type / go / close
    Browse(BrowseArgs),
    /// The LAN hosts behind a device: ls / add / rm
    Lan(LanArgs),
    /// Your API tokens and the calls made with them: `api tokens`, `api activity [--follow]`
    Api(ApiArgs),
    /// Check the server, the sign-in, its scopes and the local ssh
    Doctor,
    #[command(hide = true)]
    Dig,
}

#[derive(Args, Debug)]
pub struct JsonFlag {
    /// Machine-readable output
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct LoginArgs {
    /// Telepy server URL, e.g. https://telepy.example.com
    pub url: String,
    /// Sign in with a personal API token (the API page → Your tokens) instead of the browser
    #[arg(long = "with-token", alias = "api-token")]
    pub with_token: Option<String>,
    /// Scopes for the browser sign-in (space-separated)
    #[arg(long, default_value = DEFAULT_SCOPE)]
    pub scope: String,
    /// Print the sign-in URL instead of opening a browser
    #[arg(long)]
    pub no_browser: bool,
}

#[derive(Args, Debug)]
pub struct LsArgs {
    /// Only tunnels with this label (k or k=v; repeat to require several)
    #[arg(long)]
    pub label: Vec<String>,
    /// Only tunnels in this group of yours
    #[arg(long)]
    pub group: Option<String>,
    /// Only tunnels that are online
    #[arg(long)]
    pub online: bool,
    /// Machine-readable output
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct StatusArgs {
    /// Tunnel name or id
    pub tunnel: String,
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone, Default)]
pub struct SshOpts {
    /// Private key for both hops (adds IdentityFile + IdentitiesOnly)
    #[arg(short = 'i', long)]
    pub identity: Option<PathBuf>,
    /// Extra option for ssh, e.g. --ssh-opt "-L 8080:localhost:80" (repeatable)
    #[arg(long = "ssh-opt", allow_hyphen_values = true)]
    pub ssh_opt: Vec<String>,
}

#[derive(Args, Debug)]
pub struct SshArgs {
    /// <tunnel>[@account] (account@tunnel works too)
    pub target: String,
    #[command(flatten)]
    pub opts: SshOpts,
    /// Forward a local port: -L 8080:localhost:80
    #[arg(short = 'L')]
    pub local: Vec<String>,
    /// Dynamic SOCKS proxy: -D 1080
    #[arg(short = 'D')]
    pub dynamic: Option<String>,
    /// Command to run instead of a shell (after --)
    #[arg(last = true)]
    pub command: Vec<String>,
}

#[derive(Args, Debug)]
pub struct ScpArgs {
    /// Copy directories recursively
    #[arg(short = 'r')]
    pub recursive: bool,
    #[command(flatten)]
    pub opts: SshOpts,
    /// Sources and destination; the remote one as <tunnel>[@account]:<path>
    #[arg(required = true, num_args = 2..)]
    pub paths: Vec<String>,
}

#[derive(Args, Debug)]
pub struct SftpArgs {
    pub target: String,
    #[command(flatten)]
    pub opts: SshOpts,
}

#[derive(Args, Debug)]
pub struct ConfigArgs {
    #[command(subcommand)]
    pub action: ConfigAction,
}

#[derive(Subcommand, Debug)]
pub enum ConfigAction {
    /// Add (or refresh) the blocks for these tunnels in ~/.ssh/config
    Install {
        /// Tunnels (names or ids); omit with --all
        tunnels: Vec<String>,
        /// Every tunnel you can use
        #[arg(long)]
        all: bool,
        /// Print the blocks instead of writing them
        #[arg(long)]
        print: bool,
        /// Write to this file instead of ~/.ssh/config
        #[arg(long)]
        file: Option<PathBuf>,
    },
}

#[derive(Args, Debug)]
pub struct ExecArgs {
    /// Targets: <tunnel>[@account] (several allowed)
    pub targets: Vec<String>,
    /// Every tunnel with this label (k or k=v)
    #[arg(long)]
    pub label: Vec<String>,
    /// Every tunnel in this group of yours
    #[arg(long)]
    pub group: Option<String>,
    /// Account on the device for --label / --group targets (default: each tunnel's default)
    #[arg(long, short = 'u')]
    pub user: Option<String>,
    /// Seconds before the command is killed (max 600)
    #[arg(long, default_value_t = 60)]
    pub timeout: u64,
    /// Keep waiting while a command rule holds the command for approval (up to 10 minutes)
    #[arg(long)]
    pub wait_approval: bool,
    /// Machine-readable output (one object per target)
    #[arg(long)]
    pub json: bool,
    /// The command (after --)
    #[arg(last = true, required = true)]
    pub command: Vec<String>,
}

#[derive(Args, Debug)]
pub struct CpArgs {
    pub from: String,
    pub to: String,
}

#[derive(Args, Debug)]
pub struct SessionsArgs {
    #[command(subcommand)]
    pub action: Option<SessionsAction>,
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum SessionsAction {
    /// End one live session (they can reconnect; this is not a revoke)
    End { id: u64 },
}

#[derive(Args, Debug)]
pub struct RecordingsArgs {
    #[command(subcommand)]
    pub action: RecordingsAction,
}

#[derive(Subcommand, Debug)]
pub enum RecordingsAction {
    /// List recordings (newest first)
    Ls {
        /// Only this tunnel
        #[arg(long)]
        tunnel: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Play a recording in this terminal, with its timing
    Play {
        id: i64,
        /// Playback speed
        #[arg(long, default_value_t = 1.0)]
        speed: f64,
        /// Longest pause in seconds (0 = keep every pause)
        #[arg(long, default_value_t = 2.0)]
        idle_limit: f64,
    },
}

#[derive(Args, Debug)]
pub struct SnippetsArgs {
    #[command(subcommand)]
    pub action: Option<SnippetsAction>,
}

#[derive(Subcommand, Debug)]
pub enum SnippetsAction {
    /// List snippets (yours, the site's, and a tunnel's with --tunnel)
    Ls {
        #[arg(long)]
        tunnel: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args, Debug)]
pub struct RunArgs {
    /// Snippet name or id
    pub snippet: String,
    /// <tunnel>[@account]
    pub target: String,
    /// Variable value: --var name=value (repeatable)
    #[arg(long = "var")]
    pub vars: Vec<String>,
    /// Skip the confirmation snippets marked "ask first" need
    #[arg(long, short = 'y')]
    pub yes: bool,
    #[arg(long, default_value_t = 60)]
    pub timeout: u64,
}

#[derive(Args, Debug)]
#[command(args_conflicts_with_subcommands = true)]
pub struct BrowseArgs {
    #[command(subcommand)]
    pub action: Option<BrowseAction>,
    /// <tunnel>[@account] to open a browser through (same as `browse open`)
    pub target: Option<String>,
    /// First page to load (http / https)
    pub url: Option<String>,
    /// Machine-readable output
    #[arg(long, global = true)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum BrowseAction {
    /// Open a browser through a device and print its id
    Open {
        /// <tunnel>[@account]
        target: String,
        url: Option<String>,
    },
    /// The browsers this sign-in has open
    Ls,
    /// Go to a URL
    Go { id: String, url: String },
    /// Print the page's text (of one element with --selector)
    Text {
        id: String,
        #[arg(long)]
        selector: Option<String>,
    },
    /// Save a PNG screenshot
    Shot {
        id: String,
        /// Output file (default: <id>.png)
        #[arg(long, short = 'o')]
        output: Option<PathBuf>,
    },
    /// Click an element by CSS selector, or by its visible text with --text
    Click {
        id: String,
        selector: Option<String>,
        #[arg(long)]
        text: Option<String>,
    },
    /// Type into a field (logged by length only unless --show)
    Type {
        id: String,
        selector: String,
        text: String,
        /// Press Enter afterwards (submits most forms)
        #[arg(long)]
        enter: bool,
        /// Let the audit log show the text (it only records the length otherwise)
        #[arg(long)]
        show: bool,
    },
    /// Close a browser
    Close { id: String },
}

#[derive(Args, Debug)]
pub struct LanArgs {
    #[command(subcommand)]
    pub action: LanAction,
}

#[derive(Subcommand, Debug)]
pub enum LanAction {
    /// List the LAN hosts Telepy knows behind a device
    Ls {
        /// Tunnel name or id
        tunnel: String,
        #[arg(long)]
        json: bool,
    },
    /// Add a host by hand
    Add {
        tunnel: String,
        /// Private IPv4 address
        address: String,
        #[arg(long)]
        label: Option<String>,
        /// Login for the jump host terminal
        #[arg(long)]
        user: Option<String>,
        /// SSH port (default 22)
        #[arg(long)]
        port: Option<u16>,
    },
    /// Remove a host (by id, address or label); a later scan finds it again if it is still there
    Rm { tunnel: String, host: String },
}

#[derive(Args, Debug)]
pub struct ApiArgs {
    #[command(subcommand)]
    pub action: ApiAction,
}

#[derive(Subcommand, Debug)]
pub enum ApiAction {
    /// Your API tokens: scopes, expiry, last use and calls in the last 24 hours / 7 days
    Tokens {
        #[arg(long)]
        json: bool,
    },
    /// Calls made with your API tokens and CLI sign-ins, newest first (the web API page's Activity tab)
    Activity(ActivityArgs),
}

#[derive(Args, Debug)]
pub struct ActivityArgs {
    /// Only one token's calls: its name, id or prefix (`--token` is taken: it is the sign-in override)
    #[arg(long = "api-token", value_name = "NAME|ID")]
    pub api_token: Option<String>,
    /// ok, 4xx, 5xx or error (= 4xx + 5xx)
    #[arg(long, value_parser = |s: &str| activity::parse_status(s))]
    pub status: Option<String>,
    /// GET, POST, PUT, PATCH, DELETE, or MCP for tool calls
    #[arg(long, value_parser = |s: &str| activity::parse_method(s))]
    pub method: Option<String>,
    /// Only calls since then: 30m, 2h, 7d, or an RFC 3339 time
    #[arg(long)]
    pub since: Option<String>,
    /// How many calls (at most 1000)
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=1000))]
    pub limit: u16,
    /// Everyone's calls (admins only)
    #[arg(long)]
    pub all: bool,
    /// Only this person's calls, by username or id (admins only; implies --all)
    #[arg(long, value_name = "NAME|ID")]
    pub user: Option<String>,
    /// Keep watching and print new calls as they come (every 2 s); Ctrl+C stops
    #[arg(long, short = 'f')]
    pub follow: bool,
    /// Machine-readable output (with --follow: one JSON object per line)
    #[arg(long)]
    pub json: bool,
}

// ---------------------------------------------------------------- entry

/// 跑一次指令列；回 process 的結束碼。/ Run one command line; returns the exit code.
pub fn run(cli: Cli) -> Result<i32> {
    let server = cli.server.as_deref();
    let token = cli.token.as_deref();
    match cli.command {
        Cmd::Login(a) => login(a, token).map(|_| 0),
        Cmd::Logout => logout().map(|_| 0),
        Cmd::Doctor => doctor(server, token),
        Cmd::Dig => tapi::dig().map(|_| 0).map_err(Into::into),
        cmd => {
            let api = Api::open(server, token)?;
            match cmd {
                Cmd::Whoami(a) => whoami(&api, a.json).map(|_| 0),
                Cmd::Ls(a) => ls(&api, &a).map(|_| 0),
                Cmd::Status(a) => status(&api, &a).map(|_| 0),
                Cmd::Ssh(a) => ssh(&api, &a),
                Cmd::Scp(a) => scp(&api, &a),
                Cmd::Sftp(a) => sftp(&api, &a),
                Cmd::Config(a) => config(&api, a).map(|_| 0),
                Cmd::Exec(a) => exec(&api, &a),
                Cmd::Cp(a) => cp(&api, &a).map(|_| 0),
                Cmd::Sessions(a) => sessions(&api, &a).map(|_| 0),
                Cmd::Recordings(a) => recordings(&api, a),
                Cmd::Snippets(a) => snippet_list(&api, a).map(|_| 0),
                Cmd::Run(a) => run_snippet(&api, &a),
                Cmd::Browse(a) => browse(&api, a).map(|_| 0),
                Cmd::Lan(a) => lan(&api, a).map(|_| 0),
                Cmd::Api(a) => api_cmd(&api, a).map(|_| 0),
                Cmd::Login(_) | Cmd::Logout | Cmd::Doctor | Cmd::Dig => unreachable!(),
            }
        }
    }
}

fn print_json(v: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

// ---------------------------------------------------------------- login

fn login(a: LoginArgs, global_token: Option<&str>) -> Result<()> {
    let server = creds::normalize_server(&a.url);
    // `telepy login <url> --token tpt_…`（全域的 --token / TELEPY_TOKEN）或 `--with-token`。/ Either spelling.
    let token = a.with_token.or_else(|| global_token.map(str::to_string)).filter(|t| !t.is_empty());
    let (kind, secret, client_id) = match token {
        Some(t) => {
            if !t.starts_with("tpt_") {
                bail!("That does not look like a Telepy API token (they start with tpt_).");
            }
            (Kind::Token, creds::Secret { access: t, refresh: None, expires_at: None }, None)
        }
        None => {
            let l = oauth::login(&server, &a.scope, a.no_browser)?;
            (Kind::Oauth, l.secret, Some(l.client_id))
        }
    };
    let probe = Api::with_token(&server, &secret.access)?;
    let me = probe.get("/api/auth/user/profile").context("check the sign-in")?;
    let store = creds::save_secret(&server, &secret)?;
    creds::save_profile(&api::profile_of(kind, &server, client_id, Some(s(&me, "username").to_string()), store))?;
    let msg = format!("Signed in to {server} as {} (credentials in the {}).", s(&me, "username"), if store == "keyring" { "system keyring" } else { "config file" });
    match tapi::paint_for(&std::io::stderr()) {
        // 終端機：Tapi 揮手，訊息在旁邊；不是終端機時輸出跟以前一樣。/ A terminal gets Tapi waving beside it; otherwise unchanged.
        Some(paint) => {
            // 十字髮夾用帳號選的顏色（「每天換一個」照 UTC 日期）。/ The clips wear the account's colour.
            let clip = mascot::clip_color(mascot::clip_name(s(&me, "tapi_color"), mascot::unix_day()));
            for line in tapi::beside(&mascot::render_with(mascot::WAVE, paint, clip), &[&msg], tapi::columns(tapi::Out::Stderr)) {
                eprintln!("{line}");
            }
        }
        None => eprintln!("{msg}"),
    }
    Ok(())
}

fn logout() -> Result<()> {
    let Some(p) = creds::load_profile() else {
        eprintln!("Not signed in.");
        return Ok(());
    };
    if p.kind == Kind::Oauth {
        if let (Some(sec), Some(cid)) = (creds::load_secret(&p.server), p.client_id.as_deref()) {
            if let Some(r) = sec.refresh.as_deref() {
                // 盡力撤銷（伺服器連不上也照樣忘掉本機的）。/ Best effort; local state is forgotten anyway.
                let _ = api::http_client()?.post(format!("{}/api/oauth/revoke", p.server)).form(&[("token", r), ("client_id", cid)]).send();
            }
        }
    }
    creds::forget(&p.server)?;
    eprintln!("Signed out of {}.", p.server);
    if p.kind == Kind::Token {
        eprintln!("The API token itself still works until you revoke it in Telepy (the API page → Your tokens).");
    }
    Ok(())
}

fn whoami(api: &Api, as_json: bool) -> Result<()> {
    let me = api.get("/api/auth/user/profile")?;
    if as_json {
        return print_json(&json!({ "server": api.server, "user": me }));
    }
    println!("{} on {}", s(&me, "username"), api.server);
    if let Some(c) = me.get("credential").filter(|c| c.is_object()) {
        let scopes: Vec<&str> = c["scopes"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        println!("  via {} · {}", s(c, "name"), scopes.join(" "));
        let tunnels = c["tunnel_ids"].as_array().map(|a| format!("{} tunnel(s)", a.len())).unwrap_or_else(|| "every tunnel".into());
        println!("  tunnels: {tunnels}");
        if let Some(e) = c["expires_at"].as_str() {
            println!("  expires: {e}");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- tunnels

struct Dashboard {
    tunnels: Vec<Value>,
    latency: Value,
}

fn dashboard(api: &Api) -> Result<Dashboard> {
    let d = api.get("/api/reverse/server/dashboard")?;
    Ok(Dashboard { tunnels: d["tunnels"].as_array().cloned().unwrap_or_default(), latency: d["latency"].clone() })
}

fn name_of(t: &Value) -> &str {
    s(t, "host_friendly_name")
}

fn find_tunnel<'a>(tunnels: &'a [Value], name: &str) -> Option<&'a Value> {
    tunnels.iter().find(|t| name_of(t) == name).or_else(|| name.parse::<i64>().ok().and_then(|id| tunnels.iter().find(|t| t["id"].as_i64() == Some(id))))
}

/// `<tunnel>[@account]`（或 `account@tunnel`）→ 隧道 + 帳號。/ A target → the tunnel and the account.
fn resolve(tunnels: &[Value], raw: &str) -> Result<(Value, Option<String>)> {
    for c in target::candidates(raw) {
        if let Some(t) = find_tunnel(tunnels, &c.tunnel) {
            return Ok((t.clone(), c.account));
        }
    }
    let names: Vec<&str> = tunnels.iter().map(name_of).collect();
    bail!("No tunnel called '{raw}'. You can use: {}", if names.is_empty() { "(none)".to_string() } else { names.join(", ") })
}

/// 這條隧道上要用哪個帳號（給了就照給的、否則預設、否則唯一的那個）。/ Which device account to use.
fn account(api: &Api, tunnel: &Value, wanted: Option<&str>) -> Result<(i64, String)> {
    let id = tunnel["id"].as_i64().unwrap_or_default();
    let v = api.get(&format!("/api/reverse/server/{id}/usernames"))?;
    let list: Vec<(i64, String)> = v["usernames"].as_array().map(|a| a.iter().map(|u| (u["id"].as_i64().unwrap_or_default(), s(u, "username").to_string())).collect()).unwrap_or_default();
    let names = || list.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ");
    if list.is_empty() {
        bail!("You have no accounts on '{}'. Ask its owner to allow one.", name_of(tunnel));
    }
    if let Some(w) = wanted {
        return list.iter().find(|(_, n)| n == w).cloned().ok_or_else(|| anyhow!("'{w}' is not an account you can use on '{}'. Allowed: {}", name_of(tunnel), names()));
    }
    if let Some(d) = v["default_username_id"].as_i64() {
        if let Some(hit) = list.iter().find(|(i, _)| *i == d) {
            return Ok(hit.clone());
        }
    }
    if list.len() == 1 {
        return Ok(list[0].clone());
    }
    bail!("'{}' has several accounts; pick one with {}@<account>: {}", name_of(tunnel), name_of(tunnel), names())
}

fn label_list(t: &Value) -> Vec<String> {
    t["labels"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn group_ids(api: &Api, group: &str) -> Result<Option<i64>> {
    let v = api.get("/api/reverse/tunnel-groups")?;
    let groups = v["groups"].as_array().cloned().unwrap_or_default();
    let hit = groups.iter().find(|g| s(g, "name").eq_ignore_ascii_case(group) || g["id"].as_i64().map(|i| i.to_string()) == Some(group.to_string()));
    match hit {
        Some(g) => Ok(g["id"].as_i64()),
        None => bail!("No tunnel group called '{group}'. Yours: {}", groups.iter().map(|g| s(g, "name")).collect::<Vec<_>>().join(", ")),
    }
}

fn group_names(api: &Api) -> HashMap<i64, String> {
    api.get("/api/reverse/tunnel-groups")
        .ok()
        .and_then(|v| v["groups"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|g| Some((g["id"].as_i64()?, s(g, "name").to_string())))
        .collect()
}

fn latency_of(d: &Dashboard, t: &Value) -> Option<f64> {
    d.latency.get(t["reverse_port"].as_i64().unwrap_or_default().to_string()).and_then(Value::as_f64)
}

fn filter_tunnels(api: &Api, d: &Dashboard, labels: &[String], group: Option<&str>, online: bool) -> Result<Vec<Value>> {
    let gid = match group {
        Some(g) => group_ids(api, g)?,
        None => None,
    };
    Ok(d.tunnels
        .iter()
        .filter(|t| labels.iter().all(|l| target::label_matches(&label_list(t), l)))
        .filter(|t| gid.is_none() || t["group_id"].as_i64() == gid)
        .filter(|t| !online || matches!(s(t, "health"), "online" | "degraded"))
        .cloned()
        .collect())
}

/// 每條隧道我能用的帳號（並行查）。/ The accounts I may use on each tunnel, fetched in parallel.
fn accounts_of(api: &Api, tunnels: &[Value]) -> Vec<Vec<String>> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = tunnels
            .iter()
            .map(|t| {
                let id = t["id"].as_i64().unwrap_or_default();
                scope.spawn(move || {
                    api.get(&format!("/api/reverse/server/{id}/usernames"))
                        .ok()
                        .and_then(|v| v["usernames"].as_array().map(|a| a.iter().map(|u| s(u, "username").to_string()).collect()))
                        .unwrap_or_default()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    })
}

fn ls(api: &Api, a: &LsArgs) -> Result<()> {
    let d = dashboard(api)?;
    let list = filter_tunnels(api, &d, &a.label, a.group.as_deref(), a.online)?;
    let accounts = accounts_of(api, &list);
    let groups = group_names(api);
    if a.json {
        let out: Vec<Value> = list
            .iter()
            .zip(&accounts)
            .map(|(t, acc)| {
                json!({
                    "id": t["id"], "name": name_of(t), "health": t["health"], "latency_ms": latency_of(&d, t),
                    "accounts": acc, "labels": t["labels"], "group": t["group_id"].as_i64().and_then(|g| groups.get(&g)),
                    "last_seen_at": t["last_seen_at"], "permission": t["user_permission"], "pinned": t["pinned"],
                })
            })
            .collect();
        return print_json(&Value::Array(out));
    }
    if list.is_empty() {
        eprintln!("No tunnels{}.", if a.label.is_empty() && a.group.is_none() && !a.online { "" } else { " match" });
        return Ok(());
    }
    let n = now();
    let rows: Vec<Vec<String>> = list
        .iter()
        .zip(&accounts)
        .map(|(t, acc)| {
            vec![
                name_of(t).to_string(),
                s(t, "health").to_string(),
                table::ms(latency_of(&d, t)),
                if acc.is_empty() { "-".into() } else { acc.join(",") },
                label_list(t).join(" "),
                t["group_id"].as_i64().and_then(|g| groups.get(&g).cloned()).unwrap_or_default(),
                if s(t, "health") == "online" || s(t, "health") == "degraded" { "now".into() } else { table::ago(t["last_seen_at"].as_str(), n) },
            ]
        })
        .collect();
    print!("{}", table::render(&["NAME", "HEALTH", "LATENCY", "ACCOUNTS", "LABELS", "GROUP", "SEEN"], &rows));
    Ok(())
}

fn status(api: &Api, a: &StatusArgs) -> Result<()> {
    let d = dashboard(api)?;
    let (t, _) = resolve(&d.tunnels, &a.tunnel)?;
    let id = t["id"].as_i64().unwrap_or_default();
    let conn = api.get(&format!("/api/reverse/server/{id}/connections")).unwrap_or(Value::Null);
    let acc = accounts_of(api, std::slice::from_ref(&t)).pop().unwrap_or_default();
    let facts = t["endpoint"]["facts"].clone();
    if a.json {
        return print_json(&json!({ "tunnel": t, "latency_ms": latency_of(&d, &t), "accounts": acc, "connections": conn, "facts": facts }));
    }
    let line = |k: &str, v: String| println!("{k:<12} {v}");
    line("name", name_of(&t).into());
    line("health", s(&t, "health").into());
    line("latency", table::ms(latency_of(&d, &t)));
    line("accounts", if acc.is_empty() { "-".into() } else { acc.join(", ") });
    line("labels", label_list(&t).join(" "));
    line("permission", s(&t, "user_permission").into());
    if let Some(ip) = t["endpoint"]["public_ip"].as_str().or(t["endpoint"]["ip"].as_str()) {
        line("address", ip.into());
    }
    if let Some(h) = t["endpoint"]["hostname"].as_str() {
        line("hostname", h.into());
    }
    let pct = |v: &Value| v.as_f64().map(|x| format!("{:.1}%", x * 100.0)).unwrap_or_else(|| "-".into());
    if conn.is_object() {
        line("uptime 24h", pct(&conn["uptime"]["h24"]));
        line("uptime 7d", pct(&conn["uptime"]["d7"]));
    }
    if facts.is_object() {
        for k in ["os", "kernel", "uptime", "load", "disk", "memory"] {
            if let Some(v) = facts.get(k).filter(|v| !v.is_null()) {
                line(k, v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()));
            }
        }
        for w in facts["warnings"].as_array().cloned().unwrap_or_default() {
            println!("warning      {}", w.as_str().map(str::to_string).or_else(|| w.get("message").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| w.to_string()));
        }
    }
    if t["require_step_up"].as_bool() == Some(true) {
        println!("note         this tunnel asks to confirm it's you; tokens can't open sessions on it");
    }
    Ok(())
}

// ---------------------------------------------------------------- ssh / scp / sftp / config

fn ssh_dir() -> PathBuf {
    std::env::var_os("TELEPY_SSH_DIR").map(PathBuf::from).unwrap_or_else(|| creds::home_dir().join(".ssh").join("telepy"))
}

fn server_slug(server: &str) -> String {
    server.split("://").nth(1).unwrap_or(server).chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect()
}

/// 寫好這條隧道 + 帳號的 `ssh -F` 檔，回 (檔案, 別名)。/ Write the `ssh -F` file for a tunnel + account.
fn prepare_ssh(api: &Api, raw: &str, opts: &SshOpts) -> Result<(PathBuf, String)> {
    let d = dashboard(api)?;
    let (t, wanted) = resolve(&d.tunnels, raw)?;
    let (uid, _) = account(api, &t, wanted.as_deref())?;
    let id = t["id"].as_i64().unwrap_or_default();
    let cfg = api.get(&format!("/tunnels/server/config/{id}?username_id={uid}"))?;
    let stanzas = sshcfg::parse_stanzas(s(&cfg, "config"));
    let alias = sshcfg::device_alias(&stanzas, sshcfg::server_alias(&cfg)).ok_or_else(|| anyhow!("the server sent no device stanza"))?.to_string();
    let dir = ssh_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let kh = dir.join(format!("known_hosts-{}", server_slug(&api.server)));
    std::fs::write(&kh, s(&cfg, "known_hosts"))?;
    let file = dir.join(format!("{}.conf", alias));
    let identity = opts.identity.as_ref().map(|p| sshcfg::config_path(p));
    let text = sshcfg::standalone(&stanzas, &sshcfg::config_path(&file), &sshcfg::config_path(&kh), identity.as_deref());
    std::fs::write(&file, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }
    Ok((file, alias))
}

fn extra_opts(opts: &SshOpts) -> Vec<String> {
    opts.ssh_opt.iter().flat_map(|o| o.split_whitespace().map(str::to_string).collect::<Vec<_>>()).collect()
}

/// 交給 OpenSSH：Unix 直接換成那個 process，Windows 等它結束。/ Hand over to OpenSSH (exec on Unix, wait on Windows).
fn hand_over(mut cmd: Command) -> Result<i32> {
    #[cfg(unix)]
    {
        if std::env::var_os("TELEPY_NO_EXEC").is_none() {
            use std::os::unix::process::CommandExt;
            let err = cmd.exec();
            bail!("cannot run {:?}: {err} (is OpenSSH installed?)", cmd.get_program());
        }
    }
    let status = cmd.status().with_context(|| format!("cannot run {:?} (is OpenSSH installed?)", cmd.get_program()))?;
    Ok(status.code().unwrap_or(1))
}

fn ssh(api: &Api, a: &SshArgs) -> Result<i32> {
    let (file, alias) = prepare_ssh(api, &a.target, &a.opts)?;
    let mut cmd = Command::new("ssh");
    cmd.arg("-F").arg(&file);
    for l in &a.local {
        cmd.arg("-L").arg(l);
    }
    if let Some(dd) = &a.dynamic {
        cmd.arg("-D").arg(dd);
    }
    cmd.args(extra_opts(&a.opts)).arg(&alias).args(&a.command);
    hand_over(cmd)
}

fn scp(api: &Api, a: &ScpArgs) -> Result<i32> {
    let remote: Vec<(usize, String, String)> = a.paths.iter().enumerate().filter_map(|(i, p)| target::parse_remote(p).map(|(t, path)| (i, t, path))).collect();
    let Some((_, tgt, _)) = remote.first() else { bail!("Write the remote side as <tunnel>[@account]:<path>.") };
    if remote.iter().any(|(_, t, _)| t != tgt) {
        bail!("All remote paths must be on the same tunnel and account.");
    }
    let (file, alias) = prepare_ssh(api, tgt, &a.opts)?;
    let mut cmd = Command::new("scp");
    cmd.arg("-F").arg(&file).args(extra_opts(&a.opts));
    if a.recursive {
        cmd.arg("-r");
    }
    for (i, p) in a.paths.iter().enumerate() {
        match remote.iter().find(|(j, _, _)| *j == i) {
            Some((_, _, path)) => cmd.arg(format!("{alias}:{path}")),
            None => cmd.arg(p),
        };
    }
    hand_over(cmd)
}

fn sftp(api: &Api, a: &SftpArgs) -> Result<i32> {
    let (file, alias) = prepare_ssh(api, &a.target, &a.opts)?;
    let mut cmd = Command::new("sftp");
    cmd.arg("-F").arg(&file).args(extra_opts(&a.opts)).arg(&alias);
    hand_over(cmd)
}

fn config(api: &Api, a: ConfigArgs) -> Result<()> {
    let ConfigAction::Install { tunnels, all, print, file } = a.action;
    let d = dashboard(api)?;
    let picked: Vec<Value> = if all {
        d.tunnels.clone()
    } else if tunnels.is_empty() {
        bail!("Name the tunnels to install, or pass --all.");
    } else {
        tunnels.iter().map(|n| resolve(&d.tunnels, n).map(|(t, _)| t)).collect::<Result<_>>()?
    };
    let mut stanzas: Vec<sshcfg::Stanza> = Vec::new();
    let mut known: Vec<String> = Vec::new();
    // 這台 Telepy 的伺服器區塊別名與舊版的共用別名（每個回應都一樣）。/ This server's alias and the old shared one.
    let mut server = sshcfg::LEGACY_SERVER_ALIAS.to_string();
    let mut legacy = sshcfg::LEGACY_SERVER_ALIAS.to_string();
    for t in &picked {
        let id = t["id"].as_i64().unwrap_or_default();
        let cfg = api.get(&format!("/tunnels/server/config/{id}"))?;
        server = sshcfg::server_alias(&cfg).to_string();
        legacy = cfg["server"]["legacy_alias"].as_str().unwrap_or(sshcfg::LEGACY_SERVER_ALIAS).to_string();
        for st in sshcfg::parse_stanzas(s(&cfg, "config")) {
            if !stanzas.iter().any(|x| x.alias == st.alias) {
                stanzas.push(st);
            }
        }
        for l in s(&cfg, "known_hosts").lines().filter(|l| !l.trim().is_empty()) {
            if !known.iter().any(|k| k == l) {
                known.push(l.to_string());
            }
        }
    }
    if stanzas.iter().all(|s| s.alias == server) {
        bail!("None of these tunnels has an account you can use.");
    }
    if print {
        print!("{}", sshcfg::marked_blocks(&stanzas));
        return Ok(());
    }
    let ssh_home = creds::home_dir().join(".ssh");
    let target = file.unwrap_or_else(|| ssh_home.join("config"));
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // 生成的 config 指到 ~/.ssh/telepy_known_hosts：先存它（只換這台的行，別的伺服器的留著）。
    // The generated config points at ~/.ssh/telepy_known_hosts: save it first (this server's lines replaced, others kept).
    if !known.is_empty() {
        let kh = target.parent().unwrap_or(&ssh_home).join("telepy_known_hosts");
        std::fs::write(&kh, sshcfg::merge_known_hosts(&std::fs::read_to_string(&kh).unwrap_or_default(), &known))?;
    }
    let existing = std::fs::read_to_string(&target).unwrap_or_default();
    if !existing.is_empty() {
        std::fs::write(target.with_extension("bak"), &existing)?;
    }
    let done = sshcfg::install_checked(&existing, &stanzas, &server, &legacy);
    std::fs::write(&target, &done.text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))?;
    }
    // 別台 Telepy 已經用了同名的裝置：留著它、這裡不寫，請使用者設前綴。/ Another Telepy server's device of the same name.
    if !done.kept.is_empty() {
        eprintln!("Kept {}: another Telepy server already uses these names in {}. Set a name prefix for this server (web: SSH config dialog, or ssh_alias_prefix in your settings) and run this again.", done.kept.join(", "), target.display());
    }
    if !done.shadowed.is_empty() {
        eprintln!("Note: {} also has its own `Host {}` outside Telepy's blocks; ssh uses whichever comes first.", target.display(), done.shadowed.join(" "));
    }
    let aliases: Vec<&str> = stanzas.iter().map(|s| s.alias.as_str()).filter(|a| *a != server && !done.kept.iter().any(|k| k == a)).collect();
    eprintln!("Wrote {} host(s) to {}: {}. Connect with: ssh {}", aliases.len(), target.display(), aliases.join(", "), aliases.first().unwrap_or(&""));
    Ok(())
}

// ---------------------------------------------------------------- exec

#[derive(Debug, Clone)]
struct Job {
    tunnel: Value,
    account: Option<String>,
}

#[derive(Debug)]
struct Outcome {
    name: String,
    account: String,
    result: Result<Value, String>,
}

/// 指令列的參數接成一行（一個參數就照原樣，像 ssh）。/ Join the command words into one line, as ssh does.
pub fn command_line(words: &[String]) -> String {
    words.join(" ")
}

/// 在一條隧道上開 session、跑、關。/ Open a session on one tunnel, run, close.
fn run_on(api: &Api, job: &Job, command: &str, timeout: u64, wait: bool) -> Outcome {
    let name = name_of(&job.tunnel).to_string();
    let id = job.tunnel["id"].as_i64().unwrap_or_default();
    let fail = |account: String, e: anyhow::Error| Outcome { name: name.clone(), account, result: Err(format!("{e:#}")) };
    let account = match account(api, &job.tunnel, job.account.as_deref()) {
        Ok((_, a)) => a,
        Err(e) => return fail(job.account.clone().unwrap_or_default(), e),
    };
    let session = match api.json(Method::POST, "/api/ai/sessions", Some(&json!({ "tunnel_id": id, "username": account }))) {
        Ok(v) => v,
        Err(e) => return fail(account, e),
    };
    let sid = s(&session, "id").to_string();
    let body = json!({ "command": command, "timeout_s": timeout.min(600) });
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    let result = loop {
        match api.json_timeout(Method::POST, &format!("/api/ai/sessions/{sid}/exec"), Some(&body), Some(Duration::from_secs(timeout.min(600) + 120))) {
            Ok(v) => break Ok(v),
            Err(e) => {
                let msg = format!("{e:#}");
                // 指令規則要核准：`--wait-approval` 時每 10 秒再問一次（核准一次只能跑一次、10 分鐘內）。
                // Held for approval: with --wait-approval ask again every 10 s (an approval is good for one run within 10 minutes).
                if wait && msg.contains("is waiting in Telepy") && std::time::Instant::now() < deadline {
                    eprintln!("[{name}] waiting for approval…");
                    std::thread::sleep(Duration::from_secs(10));
                    continue;
                }
                break Err(msg);
            }
        }
    };
    let _ = api.json(Method::DELETE, &format!("/api/ai/sessions/{sid}"), None);
    Outcome { name, account, result }
}

fn exec_jobs(api: &Api, targets: &[String], labels: &[String], group: Option<&str>, user: Option<&str>) -> Result<Vec<Job>> {
    let d = dashboard(api)?;
    let mut jobs: Vec<Job> = Vec::new();
    for raw in targets {
        let (t, acc) = resolve(&d.tunnels, raw)?;
        jobs.push(Job { tunnel: t, account: acc.or_else(|| user.map(str::to_string)) });
    }
    if !labels.is_empty() || group.is_some() {
        let more = filter_tunnels(api, &d, labels, group, false)?;
        if more.is_empty() {
            bail!("No tunnels match those labels / that group.");
        }
        for t in more {
            if !jobs.iter().any(|j| j.tunnel["id"] == t["id"]) {
                jobs.push(Job { tunnel: t, account: user.map(str::to_string) });
            }
        }
    }
    if jobs.is_empty() {
        bail!("Name a tunnel, or pick tunnels with --label / --group.");
    }
    Ok(jobs)
}

fn exec(api: &Api, a: &ExecArgs) -> Result<i32> {
    let jobs = exec_jobs(api, &a.targets, &a.label, a.group.as_deref(), a.user.as_deref())?;
    let command = command_line(&a.command);
    run_jobs(api, &jobs, &command, a.timeout, a.wait_approval, a.json)
}

/// 每個目標一個 thread；一個目標就照原樣印輸出，多個就每行加 `名稱 | ` 前綴。結束碼：一個目標 = 它的、多個 = 有任何失敗就 1。
/// One thread per target; a single target prints its output as is, several get a `name | ` prefix per line.
fn run_jobs(api: &Api, jobs: &[Job], command: &str, timeout: u64, wait: bool, as_json: bool) -> Result<i32> {
    let single = jobs.len() == 1;
    let stdout = std::sync::Mutex::new(());
    let outcomes: Vec<Outcome> = std::thread::scope(|scope| {
        let handles: Vec<_> = jobs
            .iter()
            .map(|job| {
                let stdout = &stdout;
                scope.spawn(move || {
                    let o = run_on(api, job, command, timeout, wait);
                    if !as_json {
                        let _g = stdout.lock().unwrap();
                        print_outcome(&o, single);
                    }
                    o
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("exec thread")).collect()
    });
    let code_of = |o: &Outcome| match &o.result {
        Ok(v) => v["exit_code"].as_i64().unwrap_or(if v["timed_out"].as_bool() == Some(true) { 124 } else { 1 }) as i32,
        Err(_) => 255,
    };
    if as_json {
        let out: Vec<Value> = outcomes
            .iter()
            .map(|o| match &o.result {
                Ok(v) => json!({ "tunnel": o.name, "account": o.account, "ok": code_of(o) == 0, "result": v }),
                Err(e) => json!({ "tunnel": o.name, "account": o.account, "ok": false, "error": e }),
            })
            .collect();
        print_json(&Value::Array(out))?;
    }
    if single {
        return Ok(code_of(&outcomes[0]));
    }
    let failed = outcomes.iter().filter(|o| code_of(o) != 0).count();
    if !as_json {
        eprintln!("{} ok, {failed} failed", outcomes.len() - failed);
    }
    Ok(if failed > 0 { 1 } else { 0 })
}

fn print_outcome(o: &Outcome, single: bool) {
    let prefix = if single { String::new() } else { format!("{} | ", o.name) };
    let emit = |text: &str, err: bool| {
        if text.is_empty() {
            return;
        }
        if single {
            if err {
                eprint!("{text}");
            } else {
                print!("{text}");
            }
            return;
        }
        for line in text.lines() {
            if err {
                eprintln!("{prefix}{line}");
            } else {
                println!("{prefix}{line}");
            }
        }
    };
    match &o.result {
        Ok(v) => {
            emit(s(v, "stdout"), false);
            emit(s(v, "stderr"), true);
            if v["truncated"].as_bool() == Some(true) {
                eprintln!("{prefix}(output truncated; the start and the end are kept)");
            }
            if v["timed_out"].as_bool() == Some(true) {
                eprintln!("{prefix}(timed out and killed)");
            }
            if !single {
                let code = v["exit_code"].as_i64().map(|c| c.to_string()).unwrap_or_else(|| "-".into());
                eprintln!("{prefix}exit {code}");
            }
        }
        Err(e) => eprintln!("{prefix}error: {e}"),
    }
    let _ = std::io::stdout().flush();
}

// ---------------------------------------------------------------- cp

fn cp(api: &Api, a: &CpArgs) -> Result<()> {
    let from = target::parse_remote(&a.from);
    let to = target::parse_remote(&a.to);
    let d = dashboard(api)?;
    match (from, to) {
        (Some((tgt, path)), None) => {
            let (t, acc) = resolve(&d.tunnels, &tgt)?;
            let (_, user) = account(api, &t, acc.as_deref())?;
            let id = t["id"].as_i64().unwrap_or_default();
            let url = format!("/api/sftp/download/{id}/{}?path={}", urlencoding::encode(&user), urlencoding::encode(&path));
            let res = api.send(Method::GET, &url, None, Some(Duration::from_secs(3600)))?;
            if res.status().as_u16() >= 400 {
                return Err(api::read(res).unwrap_err());
            }
            let zip = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|c| c.contains("zip"));
            let base = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
            let mut dest = PathBuf::from(&a.to);
            if dest.is_dir() {
                dest = dest.join(if zip { format!("{base}.zip") } else { base });
            }
            let bytes = res.bytes()?;
            std::fs::write(&dest, &bytes).with_context(|| format!("write {}", dest.display()))?;
            eprintln!("{} → {} ({} bytes{})", a.from, dest.display(), bytes.len(), if zip { ", zipped directory" } else { "" });
        }
        (None, Some((tgt, path))) => {
            let (t, acc) = resolve(&d.tunnels, &tgt)?;
            let (_, user) = account(api, &t, acc.as_deref())?;
            let id = t["id"].as_i64().unwrap_or_default();
            let src = Path::new(&a.from);
            if src.is_dir() {
                bail!("{} is a directory; telepy cp copies files (use `telepy scp -r` for directories).", src.display());
            }
            let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "upload".into());
            let part = reqwest::blocking::multipart::Part::file(src).with_context(|| format!("read {}", src.display()))?.file_name(name);
            let form = reqwest::blocking::multipart::Form::new().part("file", part);
            let url = format!("/api/sftp/upload/{id}/{}?destination_path={}", urlencoding::encode(&user), urlencoding::encode(if path.is_empty() { "." } else { &path }));
            let res = api.request(Method::POST, &url)?.timeout(Duration::from_secs(3600)).multipart(form).send()?;
            let v = api::read(res)?;
            eprintln!("{} → {} {}", a.from, tgt, v.get("path").and_then(Value::as_str).unwrap_or(&path));
        }
        (Some(_), Some(_)) => bail!("Copy between a device and this computer; device-to-device isn't supported."),
        (None, None) => bail!("Write the device side as <tunnel>[@account]:<path>."),
    }
    Ok(())
}

// ---------------------------------------------------------------- sessions / recordings / snippets

fn sessions(api: &Api, a: &SessionsArgs) -> Result<()> {
    if let Some(SessionsAction::End { id }) = a.action {
        api.json(Method::DELETE, &format!("/api/sessions/{id}"), None)?;
        eprintln!("Ended session {id}.");
        return Ok(());
    }
    let v = api.get("/api/sessions")?;
    let list = v["sessions"].as_array().cloned().unwrap_or_default();
    if a.json {
        return print_json(&Value::Array(list));
    }
    if list.is_empty() {
        eprintln!("No live sessions.");
        return Ok(());
    }
    let n = now();
    let rows: Vec<Vec<String>> = list
        .iter()
        .map(|e| {
            vec![
                e["id"].to_string(),
                s(&e["tunnel"], "name").to_string(),
                s(&e["user"], "username").to_string(),
                s(e, "kind").to_string(),
                s(e, "ip").to_string(),
                table::ago(e["since"].as_str(), n),
                s(e, "client").to_string(),
            ]
        })
        .collect();
    print!("{}", table::render(&["ID", "TUNNEL", "USER", "KIND", "IP", "SINCE", "CLIENT"], &rows));
    Ok(())
}

fn recordings(api: &Api, a: RecordingsArgs) -> Result<i32> {
    match a.action {
        RecordingsAction::Ls { tunnel, json: as_json } => {
            let mut path = "/api/recordings".to_string();
            if let Some(tn) = tunnel {
                let d = dashboard(api)?;
                let (t, _) = resolve(&d.tunnels, &tn)?;
                path = format!("{path}?tunnel_id={}", t["id"]);
            }
            let v = api.get(&path)?;
            let list = v["recordings"].as_array().cloned().unwrap_or_default();
            if as_json {
                print_json(&Value::Array(list))?;
                return Ok(0);
            }
            if list.is_empty() {
                eprintln!("No recordings.");
                return Ok(0);
            }
            let n = now();
            let rows: Vec<Vec<String>> = list
                .iter()
                .map(|r| {
                    let secs = r["duration_ms"].as_i64().unwrap_or(0) / 1000;
                    vec![
                        r["id"].to_string(),
                        s(&r["tunnel"], "name").to_string(),
                        s(&r["user"], "username").to_string(),
                        s(r, "os_user").to_string(),
                        table::ago(r["started_at"].as_str(), n),
                        if r["live"].as_bool() == Some(true) { "recording".into() } else { format!("{}m{:02}s", secs / 60, secs % 60) },
                    ]
                })
                .collect();
            print!("{}", table::render(&["ID", "TUNNEL", "USER", "ACCOUNT", "STARTED", "LENGTH"], &rows));
            Ok(0)
        }
        RecordingsAction::Play { id, speed, idle_limit } => {
            let res = api.send(Method::GET, &format!("/api/recordings/{id}/cast"), None, None)?;
            if res.status().as_u16() >= 400 {
                return Err(api::read(res).unwrap_err());
            }
            let c = cast::parse(&res.text()?).map_err(|e| anyhow!(e))?;
            if std::io::stdout().is_terminal() {
                eprintln!("Playing recording {id} ({}x{}); Ctrl+C stops.", c.width, c.height);
            }
            let mut out = std::io::stdout();
            for ((_, data), wait) in c.events.iter().zip(cast::schedule(&c.events, speed, idle_limit)) {
                if wait > 0.0 {
                    std::thread::sleep(Duration::from_secs_f64(wait));
                }
                out.write_all(data.as_bytes())?;
                out.flush()?;
            }
            Ok(0)
        }
    }
}

fn snippet_list(api: &Api, a: SnippetsArgs) -> Result<()> {
    let (tunnel, as_json) = match a.action {
        Some(SnippetsAction::Ls { tunnel, json }) => (tunnel, json),
        None => (None, false),
    };
    let v = snippets_for(api, tunnel.as_deref())?;
    if as_json {
        return print_json(&Value::Array(v));
    }
    if v.is_empty() {
        eprintln!("No snippets.");
        return Ok(());
    }
    let rows: Vec<Vec<String>> = v.iter().map(|x| vec![x["id"].to_string(), s(x, "scope").into(), s(x, "name").into(), s(x, "command").replace('\n', " ⏎ ")]).collect();
    print!("{}", table::render(&["ID", "SCOPE", "NAME", "COMMAND"], &rows));
    Ok(())
}

fn snippets_for(api: &Api, tunnel: Option<&str>) -> Result<Vec<Value>> {
    let mut path = "/api/snippets".to_string();
    if let Some(tn) = tunnel {
        let d = dashboard(api)?;
        let (t, _) = resolve(&d.tunnels, tn)?;
        path = format!("{path}?tunnel_id={}", t["id"]);
    }
    Ok(api.get(&path)?["snippets"].as_array().cloned().unwrap_or_default())
}

fn run_snippet(api: &Api, a: &RunArgs) -> Result<i32> {
    let d = dashboard(api)?;
    let (t, acc) = resolve(&d.tunnels, &a.target)?;
    let list = snippets_for(api, Some(&t["id"].to_string()))?;
    let snip = list
        .iter()
        .find(|x| s(x, "name") == a.snippet || x["id"].as_i64().map(|i| i.to_string()) == Some(a.snippet.clone()))
        .ok_or_else(|| anyhow!("No snippet called '{}'. See `telepy snippets ls --tunnel {}`.", a.snippet, name_of(&t)))?;
    let mut vars: HashMap<String, String> = HashMap::new();
    for v in snip["variables"].as_array().cloned().unwrap_or_default() {
        if !s(&v, "default").is_empty() {
            vars.insert(s(&v, "name").to_string(), s(&v, "default").to_string());
        }
    }
    for kv in &a.vars {
        let (k, v) = kv.split_once('=').ok_or_else(|| anyhow!("Write variables as --var name=value."))?;
        vars.insert(k.to_string(), v.to_string());
    }
    let missing: Vec<&str> = snip["variables"].as_array().map(|a| a.iter().map(|v| s(v, "name")).filter(|n| !vars.contains_key(*n)).collect()).unwrap_or_default();
    if !missing.is_empty() {
        bail!("This snippet needs: {}. Pass them with --var name=value.", missing.join(", "));
    }
    let command = snippets::substitute(s(snip, "command"), &vars);
    if snip["confirm"].as_bool() == Some(true) && !a.yes {
        eprint!("Run on {}?\n  {command}\n[y/N] ", name_of(&t));
        let mut answer = String::new();
        std::io::stdin().read_line(&mut answer)?;
        if !matches!(answer.trim(), "y" | "Y" | "yes") {
            eprintln!("Not run.");
            return Ok(1);
        }
    }
    let _ = api.json(Method::POST, &format!("/api/snippets/{}/used", snip["id"]), None);
    run_jobs(api, &[Job { tunnel: t, account: acc }], &command, a.timeout, false, false)
}

// ---------------------------------------------------------------- doctor

fn doctor(server: Option<&str>, token: Option<&str>) -> Result<i32> {
    let mut bad = 0;
    let mut check = |ok: bool, what: &str, detail: String| {
        println!("{} {what}{}", if ok { "✓" } else { "✗" }, if detail.is_empty() { String::new() } else { format!(": {detail}") });
        if !ok {
            bad += 1;
        }
    };
    let profile = creds::load_profile();
    // Tapi 的顏色（帳號設定），最後全部通過時用。/ Tapi's colour from the account, for the all-good line.
    let mut tapi_color = String::new();
    let server_url = server.map(creds::normalize_server).or_else(|| profile.as_ref().map(|p| p.server.clone()));
    match &server_url {
        None => check(false, "server", "not signed in; run `telepy login <url>`".into()),
        Some(url) => {
            let reachable = api::http_client().ok().and_then(|c| c.get(format!("{url}/api/auth/setup-status")).timeout(Duration::from_secs(10)).send().ok()).map(|r| r.status().is_success()).unwrap_or(false);
            check(reachable, "server", url.clone());
            match Api::open(server, token) {
                Err(e) => check(false, "sign-in", format!("{e:#}")),
                Ok(api) => match api.get("/api/auth/user/profile") {
                    Err(e) => check(false, "sign-in", format!("{e:#}")),
                    Ok(me) => {
                        let how = if token.is_some() { "token from the environment".to_string() } else { profile.as_ref().map(|p| format!("{:?} in the {}", p.kind, p.store.clone().unwrap_or_default())).unwrap_or_default() };
                        check(true, "sign-in", format!("{} ({how})", s(&me, "username")));
                        tapi_color = s(&me, "tapi_color").to_string();
                        if let Some(c) = me.get("credential").filter(|c| c.is_object()) {
                            let scopes: Vec<&str> = c["scopes"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                            check(!scopes.is_empty(), "scopes", scopes.join(" "));
                            for (need, what) in [("tunnels:read", "ls / status / ssh"), ("ssh:exec", "exec / run / recordings"), ("ssh:files", "cp")] {
                                if !scopes.contains(&need) {
                                    println!("  (without {need}: {what} won't work)");
                                }
                            }
                            if let Some(e) = c["expires_at"].as_str() {
                                let left = table::parse_iso(e).map(|t| (t - now()) / 86_400).unwrap_or(0);
                                check(left > 0, "expiry", format!("{e} ({left} day(s) left)"));
                            }
                        }
                    }
                },
            }
        }
    }
    for bin in ["ssh", "scp", "sftp"] {
        let found = Command::new(bin).arg("-V").output().is_ok();
        check(found, bin, if found { "found".into() } else { format!("not found on PATH (needed for `telepy {bin}`)") });
    }
    let dir = ssh_dir();
    let writable = std::fs::create_dir_all(&dir).is_ok();
    check(writable, "ssh config dir", dir.display().to_string());
    if bad == 0 {
        // 全部通過、而且是終端機：Tapi 開心一下。/ All good in a terminal: a happy Tapi.
        if let Some(paint) = tapi::paint_for(&std::io::stdout()) {
            println!();
            let clip = mascot::clip_color(mascot::clip_name(&tapi_color, mascot::unix_day()));
            for line in tapi::beside(&mascot::render_with(mascot::HAPPY, paint, clip), &["Everything looks good."], tapi::columns(tapi::Out::Stdout)) {
                println!("{line}");
            }
        }
    }
    Ok(if bad > 0 { 1 } else { 0 })
}

// ---------------------------------------------------------------- browse

fn page_line(v: &Value) -> String {
    let title = s(v, "title");
    let url = s(v, "url");
    if title.is_empty() { url.to_string() } else { format!("{title} — {url}") }
}

fn browse(api: &Api, a: BrowseArgs) -> Result<()> {
    let as_json = a.json;
    let action = match (a.action, a.target) {
        (Some(action), _) => action,
        (None, Some(target)) => BrowseAction::Open { target, url: a.url },
        (None, None) => BrowseAction::Ls,
    };
    let path = |id: &str, rest: &str| format!("/api/browser/sessions/{id}{rest}");
    let out = match action {
        BrowseAction::Open { target, url } => {
            let d = dashboard(api)?;
            let (t, acct) = resolve(&d.tunnels, &target)?;
            let body = json!({ "tunnel_id": t["id"], "username": acct, "url": url });
            let v = api.json_timeout(Method::POST, "/api/browser/sessions", Some(&body), Some(Duration::from_secs(90)))?;
            if !as_json {
                println!("{}", s(&v, "id"));
                if let Some(page) = v.get("page").filter(|p| p.is_object()) {
                    eprintln!("Opened through {}: {}", name_of(&t), page_line(page));
                } else {
                    eprintln!("Opened through {}. Next: telepy browse go {} <url>", name_of(&t), s(&v, "id"));
                }
                if let Some(e) = v.get("navigate_error").and_then(Value::as_str) {
                    eprintln!("The first page did not load: {e}");
                }
                return Ok(());
            }
            v
        }
        BrowseAction::Ls => {
            let v = api.get("/api/browser/sessions")?;
            if !as_json {
                let list = v.as_array().cloned().unwrap_or_default();
                if list.is_empty() {
                    eprintln!("No open browsers.");
                    return Ok(());
                }
                let n = now();
                let rows: Vec<Vec<String>> = list.iter().map(|b| vec![s(b, "id").to_string(), s(&b["tunnel"], "name").to_string(), s(b, "username").to_string(), b["actions"].to_string(), table::ago(b["last_used_at"].as_str(), n)]).collect();
                print!("{}", table::render(&["ID", "TUNNEL", "ACCOUNT", "ACTIONS", "LAST USED"], &rows));
                return Ok(());
            }
            v
        }
        BrowseAction::Go { id, url } => api.json_timeout(Method::POST, &path(&id, "/navigate"), Some(&json!({ "url": url })), Some(Duration::from_secs(60)))?,
        BrowseAction::Text { id, selector } => {
            let q = selector.map(|sel| format!("?selector={}", url_escape(&sel))).unwrap_or_default();
            let v = api.json_timeout(Method::GET, &path(&id, &format!("/text{q}")), None, Some(Duration::from_secs(60)))?;
            if !as_json {
                eprintln!("{}", page_line(&v));
                println!("{}", s(&v, "text"));
                if v["truncated"] == true {
                    eprintln!("(cut at 100,000 characters)");
                }
                return Ok(());
            }
            v
        }
        BrowseAction::Shot { id, output } => {
            let res = api.send(Method::GET, &path(&id, "/screenshot"), None, Some(Duration::from_secs(60)))?;
            if res.status().as_u16() >= 400 {
                api::read(res)?;
                unreachable!("read() returns the error");
            }
            let page = res.headers().get("x-telepy-page-url").and_then(|v| v.to_str().ok()).map(str::to_string);
            let bytes = res.bytes().context("read the screenshot")?;
            let file = output.unwrap_or_else(|| PathBuf::from(format!("{id}.png")));
            std::fs::write(&file, &bytes).with_context(|| format!("write {}", file.display()))?;
            let v = json!({ "file": file.display().to_string(), "bytes": bytes.len(), "url": page });
            if !as_json {
                println!("{}", file.display());
                return Ok(());
            }
            v
        }
        BrowseAction::Click { id, selector, text } => {
            if selector.is_none() && text.is_none() {
                bail!("Give a CSS selector, or --text with the visible text to click.");
            }
            api.json_timeout(Method::POST, &path(&id, "/click"), Some(&json!({ "selector": selector, "text": text })), Some(Duration::from_secs(60)))?
        }
        BrowseAction::Type { id, selector, text, enter, show } => {
            let body = json!({ "selector": selector, "text": text, "press_enter": enter, "sensitive": !show });
            api.json_timeout(Method::POST, &path(&id, "/type"), Some(&body), Some(Duration::from_secs(60)))?
        }
        BrowseAction::Close { id } => {
            api.json(Method::DELETE, &path(&id, ""), None)?;
            if !as_json {
                eprintln!("Closed {id}.");
                return Ok(());
            }
            json!({ "id": id, "closed": true })
        }
    };
    if as_json {
        return print_json(&out);
    }
    if let Some(c) = out.get("clicked").and_then(Value::as_str) {
        eprintln!("Clicked {c}.");
    }
    println!("{}", page_line(&out));
    Ok(())
}

/// query string 用的百分比編碼（只留 unreserved）。/ Percent-encoding for a query value (unreserved kept).
pub fn url_escape(raw: &str) -> String {
    raw.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

// ---------------------------------------------------------------- lan

/// `<id | 位址 | 標籤>` → 主機。/ A host by id, address or label.
fn find_host<'a>(hosts: &'a [Value], raw: &str) -> Option<&'a Value> {
    hosts
        .iter()
        .find(|h| h["id"].as_i64().map(|i| i.to_string()).as_deref() == Some(raw))
        .or_else(|| hosts.iter().find(|h| s(h, "address") == raw))
        .or_else(|| hosts.iter().find(|h| s(h, "label").eq_ignore_ascii_case(raw)))
}

fn lan(api: &Api, a: LanArgs) -> Result<()> {
    let d = dashboard(api)?;
    let tunnel_of = |raw: &str| find_tunnel(&d.tunnels, raw).cloned().ok_or_else(|| anyhow!("No tunnel called '{raw}'."));
    match a.action {
        LanAction::Ls { tunnel, json: as_json } => {
            let t = tunnel_of(&tunnel)?;
            let v = api.get(&format!("/api/reverse/server/{}/lan/hosts", t["id"]))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            if as_json {
                return print_json(&Value::Array(hosts));
            }
            if hosts.is_empty() {
                eprintln!("No LAN hosts on {} yet. Scan in the web app (Network page) or add one: telepy lan add {} <address>", name_of(&t), name_of(&t));
                return Ok(());
            }
            let rows: Vec<Vec<String>> = hosts
                .iter()
                .map(|h| {
                    let ports = h["open_ports"].as_array().map(|p| p.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")).unwrap_or_default();
                    let name = [s(h, "label"), s(h, "hostname")].into_iter().find(|x| !x.is_empty()).unwrap_or("").to_string();
                    vec![h["id"].to_string(), s(h, "address").to_string(), name, s(h, "username").to_string(), ports, s(h, "source").to_string()]
                })
                .collect();
            print!("{}", table::render(&["ID", "ADDRESS", "NAME", "LOGIN", "OPEN PORTS", "SOURCE"], &rows));
        }
        LanAction::Add { tunnel, address, label, user, port } => {
            let t = tunnel_of(&tunnel)?;
            let body = json!({ "address": address, "label": label, "username": user, "ssh_port": port });
            let h = api.json(Method::POST, &format!("/api/reverse/server/{}/lan/hosts", t["id"]), Some(&body))?;
            println!("{}", h["id"]);
            eprintln!("Added {} behind {}.", s(&h, "address"), name_of(&t));
        }
        LanAction::Rm { tunnel, host } => {
            let t = tunnel_of(&tunnel)?;
            let v = api.get(&format!("/api/reverse/server/{}/lan/hosts", t["id"]))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            let h = find_host(&hosts, &host).ok_or_else(|| anyhow!("No host '{host}' behind {}.", name_of(&t)))?;
            api.json(Method::DELETE, &format!("/api/reverse/server/{}/lan/hosts/{}", t["id"], h["id"]), None)?;
            eprintln!("Removed {} from {}.", s(h, "address"), name_of(&t));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- api tokens / activity

/// 本機時區（這一刻的位移）。/ This machine's UTC offset right now.
fn local_offset() -> chrono::FixedOffset {
    *chrono::Local::now().offset()
}

fn api_cmd(api: &Api, a: ApiArgs) -> Result<()> {
    match a.action {
        ApiAction::Tokens { json: as_json } => {
            let list = api.get("/api/auth/tokens")?.as_array().cloned().unwrap_or_default();
            if as_json {
                return print_json(&Value::Array(list));
            }
            if list.is_empty() {
                eprintln!("No API tokens. Create one on the web app's API page.");
                return Ok(());
            }
            let (n, off) = (now(), local_offset());
            let rows: Vec<Vec<String>> = list.iter().map(|t| activity::token_row(t, n, off)).collect();
            print!("{}", table::render(activity::TOKEN_HEADERS, &rows));
            Ok(())
        }
        ApiAction::Activity(a) => api_activity(api, &a),
    }
}

/// 管理員才能看全站：把 403 admin_only 說清楚。/ Say plainly that the admin view needs an admin.
fn admin_only(e: anyhow::Error) -> anyhow::Error {
    match e.downcast_ref::<api::HttpError>() {
        Some(h) if h.status == 403 && h.body["code"] == "admin_only" => anyhow!("Only admins can see other people's API activity. Leave out --all / --user to see your own."),
        _ => e,
    }
}

/// 一頁一頁往前翻（`before`），直到夠 `limit` 列、比 `since` 舊、或沒有了。`skip` 的列不算數。
/// Page back with `before` until `limit` rows, a row older than `since`, or the end. Rows `skip` hides don't count.
fn fetch_calls(api: &Api, f: &activity::Filters, limit: usize, since: Option<i64>, skip: impl Fn(&Value) -> bool) -> Result<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    let mut before: Option<i64> = None;
    loop {
        let want = (limit - out.len()).clamp(1, activity::PAGE_MAX);
        let v = api.get(&activity::query(f, want, before)).map_err(admin_only)?;
        let rows = v["calls"].as_array().cloned().unwrap_or_default();
        for r in &rows {
            if since.is_some_and(|s| activity::call_time(r).is_some_and(|t| t < s)) {
                return Ok(out);
            }
            if skip(r) {
                continue;
            }
            out.push(r.clone());
            if out.len() >= limit {
                return Ok(out);
            }
        }
        match rows.last().and_then(|r| r["id"].as_i64()) {
            Some(last) if v["has_more"].as_bool() == Some(true) => before = Some(last),
            _ => return Ok(out),
        }
    }
}

fn api_activity(api: &Api, a: &ActivityArgs) -> Result<()> {
    let mut f = activity::Filters { all: a.all || a.user.is_some(), status: a.status.clone(), method: a.method.clone(), ..Default::default() };
    if let Some(u) = &a.user {
        activity::user_filter(u, &mut f);
    }
    if let Some(t) = &a.api_token {
        let tokens = api.get("/api/auth/tokens")?.as_array().cloned().unwrap_or_default();
        f.token_id = Some(activity::find_token(&tokens, t).map_err(|e| anyhow!(e))?);
    }
    let since = a.since.as_deref().map(|s| activity::parse_since(s, now())).transpose().map_err(|e| anyhow!(e))?;
    let show_user = f.all;
    let off = local_offset();
    if !a.follow {
        let rows = fetch_calls(api, &f, a.limit as usize, since, |_| false)?;
        if a.json {
            return print_json(&Value::Array(rows));
        }
        if rows.is_empty() {
            eprintln!("No API calls{}.", if f == (activity::Filters { all: f.all, ..Default::default() }) && since.is_none() { "" } else { " match" });
            return Ok(());
        }
        let cells: Vec<Vec<String>> = rows.iter().map(|c| activity::row(c, off, show_user)).collect();
        print!("{}", table::render(&activity::headers(show_user), &cells));
        return Ok(());
    }
    // --follow：先印最近的（舊的在上，像 tail），再每 2 秒印新的；自己的輪詢不印。
    // --follow: the recent ones first (oldest on top, like tail), then new ones every 2 s; our own polling is hidden.
    let first = fetch_calls(api, &f, a.limit as usize, since, activity::is_log_read)?;
    let mut last_id = first.iter().filter_map(|c| c["id"].as_i64()).max().unwrap_or(0);
    let emit = |c: &Value| -> Result<()> {
        if a.json {
            println!("{}", serde_json::to_string(c)?);
        } else {
            println!("{}", activity::follow_line(c, off, show_user));
        }
        std::io::stdout().flush()?;
        Ok(())
    };
    for c in first.iter().rev() {
        emit(c)?;
    }
    if !a.json {
        eprintln!("(watching for new calls every 2 s; Ctrl+C stops)");
    }
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let page = match api.get(&activity::query(&f, activity::PAGE_MAX, None)) {
            Ok(v) => v,
            Err(e) => {
                // 登入失效 / 權限不足就停；網路抖一下就下次再試。/ Stop on auth errors; retry on a network hiccup.
                if e.downcast_ref::<api::HttpError>().is_some_and(|h| matches!(h.status, 401 | 403)) {
                    return Err(admin_only(e));
                }
                eprintln!("(cannot reach the server: {e:#}; trying again)");
                continue;
            }
        };
        let fresh: Vec<Value> = page["calls"].as_array().cloned().unwrap_or_default().into_iter().filter(|c| c["id"].as_i64().is_some_and(|i| i > last_id)).collect();
        if let Some(max) = fresh.iter().filter_map(|c| c["id"].as_i64()).max() {
            last_id = max;
        }
        for c in fresh.iter().rev().filter(|c| !activity::is_log_read(c)) {
            emit(c)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_names_ids_and_both_account_orders() {
        let tunnels = vec![json!({"id": 3, "host_friendly_name": "box"}), json!({"id": 9, "host_friendly_name": "nas"})];
        assert_eq!(resolve(&tunnels, "box").unwrap().0["id"], 3);
        assert_eq!(resolve(&tunnels, "9").unwrap().0["id"], 9);
        let (t, a) = resolve(&tunnels, "box@pi").unwrap();
        assert_eq!((t["id"].as_i64(), a.as_deref()), (Some(3), Some("pi")));
        let (t, a) = resolve(&tunnels, "pi@nas").unwrap();
        assert_eq!((t["id"].as_i64(), a.as_deref()), (Some(9), Some("pi")));
        assert!(resolve(&tunnels, "nope").unwrap_err().to_string().contains("box, nas"));
    }

    #[test]
    fn command_lines_and_slugs() {
        assert_eq!(command_line(&["uname".into(), "-a".into()]), "uname -a");
        assert_eq!(server_slug("https://t.example:8443"), "t.example_8443");
    }

    #[test]
    fn clap_definition_is_valid() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
        let c = Cli::try_parse_from(["telepy", "exec", "box@pi", "--", "uname", "-a"]).unwrap();
        match c.command {
            Cmd::Exec(e) => assert_eq!((e.targets, e.command), (vec!["box@pi".to_string()], vec!["uname".to_string(), "-a".to_string()])),
            other => panic!("{other:?}"),
        }
        let c = Cli::try_parse_from(["telepy", "exec", "--label", "env=prod", "--", "uptime"]).unwrap();
        assert!(matches!(c.command, Cmd::Exec(ref e) if e.label == ["env=prod"]));
        // `browse <tunnel> [url]` 或子命令。/ `browse <tunnel> [url]` or a subcommand.
        let c = Cli::try_parse_from(["telepy", "browse", "box@pi", "http://192.168.1.1"]).unwrap();
        assert!(matches!(c.command, Cmd::Browse(ref b) if b.action.is_none() && b.target.as_deref() == Some("box@pi") && b.url.as_deref() == Some("http://192.168.1.1")));
        let c = Cli::try_parse_from(["telepy", "browse", "shot", "aib_1", "-o", "x.png"]).unwrap();
        assert!(matches!(c.command, Cmd::Browse(BrowseArgs { action: Some(BrowseAction::Shot { ref id, .. }), .. }) if id == "aib_1"));
        let c = Cli::try_parse_from(["telepy", "browse", "type", "aib_1", "#q", "weather", "--enter"]).unwrap();
        assert!(matches!(c.command, Cmd::Browse(BrowseArgs { action: Some(BrowseAction::Type { enter: true, show: false, .. }), .. })));
        let c = Cli::try_parse_from(["telepy", "lan", "add", "box", "192.168.1.9", "--label", "nas", "--port", "2222"]).unwrap();
        assert!(matches!(c.command, Cmd::Lan(LanArgs { action: LanAction::Add { port: Some(2222), .. } })));
    }

    #[test]
    fn api_activity_arguments() {
        let parse = |args: &[&str]| Cli::try_parse_from([&["telepy", "api"], args].concat());
        let c = parse(&["activity", "--api-token", "ci", "--status", "4XX", "--method", "post", "--since", "2h", "-f", "--json"]).unwrap();
        match c.command {
            Cmd::Api(ApiArgs { action: ApiAction::Activity(a) }) => {
                assert_eq!((a.api_token.as_deref(), a.status.as_deref(), a.method.as_deref(), a.since.as_deref()), (Some("ci"), Some("4xx"), Some("POST"), Some("2h")));
                assert!(a.follow && a.json && !a.all);
                assert_eq!(a.limit, 50);
            }
            other => panic!("{other:?}"),
        }
        assert!(parse(&["activity", "--status", "teapot"]).is_err());
        assert!(parse(&["activity", "--method", "HEAD"]).is_err());
        assert!(parse(&["activity", "--limit", "1001"]).is_err());
        assert!(parse(&["activity", "--limit", "0"]).is_err());
        assert!(matches!(parse(&["activity", "--all", "--user", "bob", "--limit", "1000"]).unwrap().command, Cmd::Api(ApiArgs { action: ApiAction::Activity(ActivityArgs { all: true, limit: 1000, .. }) })));
        assert!(matches!(parse(&["tokens", "--json"]).unwrap().command, Cmd::Api(ApiArgs { action: ApiAction::Tokens { json: true } })));
        // 全域的 --token（登入用）照舊能跟 api 一起用。/ The global sign-in --token still works with it.
        let c = Cli::try_parse_from(["telepy", "--token", "tpt_x", "api", "activity"]).unwrap();
        assert_eq!(c.token.as_deref(), Some("tpt_x"));
    }

    #[test]
    fn hosts_by_id_address_or_label_and_escaping() {
        let hosts = vec![json!({"id": 4, "address": "192.168.1.4", "label": "NAS"}), json!({"id": 7, "address": "192.168.1.7", "label": null})];
        assert_eq!(find_host(&hosts, "7").unwrap()["id"], 7);
        assert_eq!(find_host(&hosts, "192.168.1.4").unwrap()["id"], 4);
        assert_eq!(find_host(&hosts, "nas").unwrap()["id"], 4);
        assert!(find_host(&hosts, "printer").is_none());
        assert_eq!(url_escape("div.main > a"), "div.main%20%3E%20a");
    }
}
