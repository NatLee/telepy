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
pub mod carrier;
pub mod cast;
pub mod color;
pub mod complete;
pub mod creds;
pub mod forward;
pub mod keycheck;
pub mod keys;
/// 區網主機的網頁 port 表：與伺服器共用同一個檔。/ LAN web ports, shared with the server.
#[path = "../../backend-api/src/lan/web.rs"]
pub mod lan_web;
pub mod tapi;
/// Tapi 的像素格：與伺服器共用同一個檔（網頁的 `lib/mascot.ts` 是同一份）。/ Tapi's grids, shared with the server.
#[path = "../../backend-api/src/mascot.rs"]
pub mod mascot;
pub mod oauth;
pub mod prefs;
#[path = "../../backend-api/src/release_key.rs"]
pub mod release_key;
pub mod signed_in;
pub mod snippets;
pub mod sshcfg;
pub mod table;
pub mod target;
pub mod tidy;
pub mod update;

/// `release_key.rs` 跟後端共用，兩邊都以 `crate::ssh_key` 找到 ssh-key crate。/ Shared with the backend: both reach ssh-key as `crate::ssh_key`.
pub use ssh_key;

use std::collections::HashMap;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::engine::ArgValueCompleter;
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
#[command(name = "telepy", version = VERSION, about = "Telepy from the command line: tunnels, SSH, commands, files, sessions and recordings.", styles = color::styles())]
pub struct Cli {
    /// Telepy server URL (default: the one you signed in to)
    #[arg(long, global = true, env = "TELEPY_URL")]
    pub server: Option<String>,
    /// Personal API token (tpt_…) instead of the stored sign-in; handy in CI
    #[arg(long, global = true, env = "TELEPY_TOKEN", hide_env_values = true)]
    pub token: Option<String>,
    /// Colour the output: auto (a terminal that shows colour; NO_COLOR turns it off), always or never
    #[arg(long, global = true, value_enum, value_name = "WHEN", default_value_t = color::When::Auto)]
    pub color: color::When,
    #[command(subcommand)]
    pub command: Cmd,
}

/// `telepy` 的 clap 指令（Tab 補完與 `main` 用）。/ telepy's clap command (for Tab completion and `main`).
pub fn command() -> clap::Command {
    Cli::command()
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
    /// Bring a port behind a device to your computer (ssh -L through Telepy): `forward <tunnel> <host>[:port] --open` opens a LAN web page in your own browser
    Forward(ForwardArgs),
    /// Install Telepy's ssh config blocks into ~/.ssh/config (like the web's SSH config dialog)
    Config(ConfigArgs),
    /// Run a command on one or many devices through Telepy (command rules apply)
    Exec(ExecArgs),
    /// Copy a file to or from a device over SFTP; write the remote side as <tunnel>[@account]:<path>, or a LAN host behind it as <tunnel>/[login@]<host>:<path>
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
    /// Your SSH keys in Telepy: ls / add (in your browser) / check whether ssh gets into a device and fix it
    Keys(KeysArgs),
    /// Check the server, the sign-in, its scopes, the local ssh and whether a newer telepy is out
    Doctor,
    /// Update telepy to the latest release (checked against the release's SHA256SUMS); --check only reports
    Update(UpdateArgs),
    /// Tab completion for your shell, tunnel names included: `eval "$(telepy completions zsh)"`; without a shell it says what to add where
    Completions(CompletionsArgs),
    #[command(hide = true)]
    Dig,
    /// The ProxyCommand `telepy ssh` writes for the hop to Telepy (SSH inside a WebSocket on the web port)
    #[command(name = "_carrier")]
    #[command(hide = true)]
    Carrier(CarrierArgs),
}

#[derive(Args, Debug)]
pub struct CarrierArgs {
    /// wss://…/ws/gateway/
    #[arg(long)]
    pub url: String,
    /// The SSH port (host:port) to fall back to
    #[arg(long)]
    pub tcp: Option<String>,
    #[arg(long, value_parser = ["ask", "always", "never"], default_value = "ask")]
    pub fallback: String,
    /// The Telepy server (where an "always" answer is saved)
    #[arg(long)]
    pub server: String,
}

#[derive(Args, Debug)]
pub struct CompletionsArgs {
    /// The shell; omit it to see the line for yours
    #[arg(value_parser = ["bash", "zsh", "fish", "powershell", "elvish"])]
    pub shell: Option<String>,
}

#[derive(Args, Debug)]
pub struct JsonFlag {
    /// Machine-readable output
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    /// Only say whether a newer release is out; change nothing
    #[arg(long)]
    pub check: bool,
    /// Install this release instead of the latest, e.g. v2.9.0 (also to go back)
    #[arg(long, value_name = "VERSION")]
    pub to: Option<String>,
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
    #[arg(long, add = ArgValueCompleter::new(complete::label))]
    pub label: Vec<String>,
    /// Only tunnels in this group of yours
    #[arg(long, add = ArgValueCompleter::new(complete::group))]
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
    #[arg(add = ArgValueCompleter::new(complete::tunnel))]
    pub tunnel: String,
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone, Default)]
pub struct SshOpts {
    /// Private key for both hops (adds IdentityFile + IdentitiesOnly)
    #[arg(short = 'i', long, value_hint = clap::ValueHint::FilePath)]
    pub identity: Option<PathBuf>,
    /// Extra option for ssh, e.g. --ssh-opt "-L 8080:localhost:80" (repeatable)
    #[arg(long = "ssh-opt", allow_hyphen_values = true)]
    pub ssh_opt: Vec<String>,
    /// How to reach Telepy: web = its web port, so Telepy sees your real address (default); ssh = its SSH port
    #[arg(long, value_parser = ["web", "ssh"], default_value = "web", env = "TELEPY_SSH_VIA")]
    pub via: String,
    /// When the web port can't be reached: ask, always or never fall back to the SSH port (overrides `telepy config fallback`)
    #[arg(long, value_parser = ["ask", "always", "never"], env = "TELEPY_SSH_FALLBACK")]
    pub fallback: Option<String>,
    /// Skip Telepy's check that your SSH key gets in before connecting (also TELEPY_NO_KEY_CHECK=1)
    #[arg(long)]
    pub no_check: bool,
}

#[derive(Args, Debug)]
pub struct SshArgs {
    /// <tunnel>[@account] (account@tunnel works too)
    #[arg(add = ArgValueCompleter::new(complete::target))]
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
    #[arg(required = true, num_args = 2.., add = ArgValueCompleter::new(complete::remote_or_path))]
    pub paths: Vec<String>,
}

#[derive(Args, Debug)]
pub struct ForwardArgs {
    /// <tunnel>[@account] (account@tunnel works too)
    #[arg(add = ArgValueCompleter::new(complete::target))]
    pub target: String,
    /// What to reach, as the device sees it: <host>[:port]. A LAN host's address, label or id, or localhost for the device itself; without a port, the host's first web port
    pub to: String,
    /// Local port (default: the same port, +10000 below 1024, or the next free one)
    #[arg(short = 'l', long)]
    pub local: Option<u16>,
    /// Open the page in your browser once the forward is up
    #[arg(long)]
    pub open: bool,
    /// Use https:// in the printed address (default: by the port, like the web app)
    #[arg(long)]
    pub https: bool,
    #[command(flatten)]
    pub opts: SshOpts,
}

#[derive(Args, Debug)]
pub struct SftpArgs {
    #[arg(add = ArgValueCompleter::new(complete::target))]
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
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnels: Vec<String>,
        /// Every tunnel you can use
        #[arg(long)]
        all: bool,
        /// Print the blocks instead of writing them
        #[arg(long)]
        print: bool,
        /// Write to this file instead of ~/.ssh/config
        #[arg(long, value_hint = clap::ValueHint::FilePath)]
        file: Option<PathBuf>,
    },
    /// When `telepy ssh / scp / sftp` can't reach Telepy's web port: ask (default), always or never use the SSH port instead
    Fallback {
        /// ask | always | never; omit to show the current setting
        #[arg(value_parser = ["ask", "always", "never"])]
        value: Option<String>,
    },
    /// Simplify ~/.ssh/config: shared lines once, repeats ssh never reads dropped; every name checked to read the same
    Tidy {
        /// Simplify this file instead of ~/.ssh/config
        #[arg(long, value_hint = clap::ValueHint::FilePath)]
        file: Option<PathBuf>,
        /// Also use a wildcard where names share a start or an end (it then applies to other matching names too)
        #[arg(long)]
        wildcards: bool,
        /// Only report; exit 1 when the file could be simpler or has lines worth a look
        #[arg(long)]
        check: bool,
        /// Write without asking (a backup is still made)
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

#[derive(Args, Debug)]
pub struct ExecArgs {
    /// Targets: <tunnel>[@account] (several allowed)
    #[arg(add = ArgValueCompleter::new(complete::target))]
    pub targets: Vec<String>,
    /// Every tunnel with this label (k or k=v)
    #[arg(long, add = ArgValueCompleter::new(complete::label))]
    pub label: Vec<String>,
    /// Every tunnel in this group of yours
    #[arg(long, add = ArgValueCompleter::new(complete::group))]
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
    #[arg(add = ArgValueCompleter::new(complete::remote_or_path))]
    pub from: String,
    #[arg(add = ArgValueCompleter::new(complete::remote_or_path))]
    pub to: String,
}

#[derive(Args, Debug)]
pub struct KeysArgs {
    #[command(subcommand)]
    pub action: Option<KeysAction>,
    /// Machine-readable output (for the list)
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum KeysAction {
    /// Your keys in Telepy, and which of them this computer has (the default)
    Ls {
        #[arg(long)]
        json: bool,
    },
    /// Add this computer's key to Telepy: the web app's add dialog opens prefilled and you confirm it there (no key yet = ssh-keygen makes one)
    Add {
        /// The public key file (or a private key with a readable public half); default: the key ssh offers
        #[arg(value_hint = clap::ValueHint::FilePath)]
        file: Option<PathBuf>,
        /// The key's name in Telepy (default: this computer's name)
        #[arg(long)]
        name: Option<String>,
        /// Then also put it on this device's key list: <tunnel>[@account]
        #[arg(long, add = ArgValueCompleter::new(complete::target))]
        device: Option<String>,
    },
    /// Check, hop by hop, whether `telepy ssh <target>` gets in, and fix what Telepy can
    Check {
        /// <tunnel>[@account] (account@tunnel works too)
        #[arg(add = ArgValueCompleter::new(complete::target))]
        target: String,
        /// Fix without asking: put your key on the device's key list for this account
        #[arg(long, short = 'y')]
        yes: bool,
        /// Machine-readable output (the keys offered and the server's answer)
        #[arg(long)]
        json: bool,
    },
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
        #[arg(long, add = ArgValueCompleter::new(complete::tunnel))]
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
        #[arg(long, add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args, Debug)]
pub struct RunArgs {
    /// Snippet name or id
    #[arg(add = ArgValueCompleter::new(complete::snippet))]
    pub snippet: String,
    /// <tunnel>[@account]
    #[arg(add = ArgValueCompleter::new(complete::target))]
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
    #[arg(add = ArgValueCompleter::new(complete::target))]
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
        #[arg(add = ArgValueCompleter::new(complete::target))]
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
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        #[arg(long)]
        json: bool,
    },
    /// Scan the device's network (needs network:scan): waits, shows progress, then lists what it found
    Scan {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        /// Private CIDR to scan instead of the device's own networks (repeatable), e.g. 192.168.1.0/24
        #[arg(long = "subnet")]
        subnets: Vec<String>,
        /// Ports to probe, comma-separated (default: the server's list)
        #[arg(long, value_delimiter = ',')]
        ports: Vec<u16>,
        /// Don't send a GET / to web ports (by default each open web port gets one, so the scan can tell what the machine is)
        #[arg(long)]
        no_identify: bool,
        /// Device account to scan as (default: the tunnel's default)
        #[arg(long)]
        account: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Check one host again now (needs network:scan): every port it had open plus the defaults, that address only
    Check {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        /// Id, address or label
        host: String,
        /// Ports to probe, comma-separated (default: the ones it had open plus the server's list)
        #[arg(long, value_delimiter = ',')]
        ports: Vec<u16>,
        #[arg(long)]
        json: bool,
    },
    /// Show or set the scheduled rescan (setting needs network:scan): --every 1h|6h|12h|1d|1w, or --every off
    Schedule {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        /// How often: 1h, 6h, 12h, 1d or 1w; `off` stops it. Leave out to show the current one
        #[arg(long)]
        every: Option<String>,
        /// Private CIDR to scan instead of the device's own networks (repeatable)
        #[arg(long = "subnet")]
        subnets: Vec<String>,
        /// Ports to probe, comma-separated (default: the server's list)
        #[arg(long, value_delimiter = ',')]
        ports: Vec<u16>,
        /// Don't send a GET / to web ports
        #[arg(long)]
        no_identify: bool,
        /// Device account to scan as (default: the tunnel's default)
        #[arg(long)]
        account: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Watch a host: be told when a scan finds it gone, back or with other ports (--off stops)
    Watch {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        /// Id, address or label
        host: String,
        #[arg(long)]
        off: bool,
    },
    /// Send a Wake-on-LAN packet from the device to a host (needs ssh:exec and a MAC from an earlier scan)
    Wake {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        /// Id, address or label
        host: String,
        /// Device account to run it as (default: the tunnel's default)
        #[arg(long)]
        account: Option<String>,
    },
    /// Change a host's name, login, SSH port, labels or note (needs tunnels:manage)
    Edit {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        /// Id, address or label
        host: String,
        /// Display name (empty clears it)
        #[arg(long)]
        label: Option<String>,
        /// Default login on that machine (empty clears it)
        #[arg(long)]
        user: Option<String>,
        #[arg(long)]
        port: Option<u16>,
        /// Labels, comma-separated; replaces them (empty clears them)
        #[arg(long)]
        labels: Option<String>,
        /// A note (empty clears it)
        #[arg(long)]
        note: Option<String>,
    },
    /// Draw the device's networks as a map of addresses: hosts, the gateway, the device itself, free ones
    Map {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
    },
    /// What Telepy saw on one host: what it is, and each port's page title, server, certificate or banner
    Show {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        /// Id, address or label
        host: String,
        #[arg(long)]
        json: bool,
    },
    /// Add a host by hand
    Add {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
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
    Rm {
        #[arg(add = ArgValueCompleter::new(complete::tunnel))]
        tunnel: String,
        host: String,
    },
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

/// 跑一次指令列；回 process 的結束碼。發行版一天最多一次在背景問有沒有新版，指令成功後才印提示
/// （`update` / `doctor` 自己會說、`dig` 是彩蛋，不問）。
/// Run one command line; returns the exit code. A release build asks for a newer version in the background at most
/// once a day and prints the notice only after a successful command (`update` / `doctor` say it themselves, `dig`
/// is the egg: no check).
pub fn run(cli: Cli) -> Result<i32> {
    #[cfg(windows)]
    if let Ok(exe) = std::env::current_exe() {
        // Windows 刪不掉正在跑的舊檔，上次更新的備份留到現在才清。/ Windows leaves the previous update's backup for now.
        update::clean_leftovers(&exe);
    }
    // `completions` 在每個 shell 開啟時跑（設定檔裡的那行），不該順便查新版。/ `completions` runs at every shell start; no update check there.
    let check = if matches!(cli.command, Cmd::Update(_) | Cmd::Doctor | Cmd::Dig | Cmd::Carrier(_) | Cmd::Completions(_)) { None } else { update::start() };
    let result = run_command(cli);
    if matches!(result, Ok(0)) {
        update::finish(check);
    }
    // 金鑰檢查擋下、說明已經印過：結束碼 1，不再多一行 `telepy: …`。/ Stopped by the key check (explained): exit 1, no extra line.
    match result {
        Err(e) if e.is::<keycheck::Stopped>() => Ok(1),
        other => other,
    }
}

fn run_command(cli: Cli) -> Result<i32> {
    let server = cli.server.as_deref();
    let token = cli.token.as_deref();
    match cli.command {
        Cmd::Login(a) => login(a, token).map(|_| 0),
        Cmd::Logout => logout().map(|_| 0),
        Cmd::Doctor => doctor(server, token),
        Cmd::Update(a) => update_cmd(a),
        Cmd::Dig => tapi::dig().map(|_| 0).map_err(Into::into),
        Cmd::Completions(a) => complete::run(a.shell.as_deref()),
        // ssh 執行的 ProxyCommand：不用登入（網址與退回的設定都在參數裡）。/ Run by ssh; everything it needs is in its arguments.
        Cmd::Carrier(a) => carrier::run(&a.url, a.tcp.as_deref(), prefs::Fallback::parse(&a.fallback).unwrap_or_default(), &a.server),
        // 只讀寫本機的檔，不用登入。/ Only touches a local file: no sign-in needed.
        Cmd::Config(ConfigArgs { action: ConfigAction::Tidy { file, wildcards, check, yes } }) => config_tidy(file, wildcards, check, yes),
        cmd => {
            let api = Api::open(server, token)?;
            match cmd {
                Cmd::Whoami(a) => whoami(&api, a.json).map(|_| 0),
                Cmd::Ls(a) => ls(&api, &a).map(|_| 0),
                Cmd::Status(a) => status(&api, &a).map(|_| 0),
                Cmd::Ssh(a) => ssh(&api, &a),
                Cmd::Scp(a) => scp(&api, &a),
                Cmd::Sftp(a) => sftp(&api, &a),
                Cmd::Forward(a) => forward_cmd(&api, &a),
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
                Cmd::Keys(a) => keys_cmd(&api, a),
                Cmd::Login(_) | Cmd::Logout | Cmd::Doctor | Cmd::Update(_) | Cmd::Dig | Cmd::Carrier(_) | Cmd::Completions(_) => unreachable!(),
            }
        }
    }
}

/// 表格印到標準輸出：終端機上標題粗體、每格照 `style(欄, 字)` 上色。/ A table on stdout: in a terminal, bold headers and cells styled by `style(column, text)`.
fn print_table(headers: &[&str], rows: &[Vec<String>], style: impl Fn(usize, &str) -> anstyle::Style) {
    print!("{}", table::render_styled(headers, rows, color::enabled(color::Stream::Out), style));
}

fn plain(_: usize, _: &str) -> anstyle::Style {
    color::PLAIN
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
    match tapi::paint_for(color::Stream::Err) {
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
    complete::forget();
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
    println!("{} on {}", color::out(color::BOLD, s(&me, "username")), api.server);
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
    let tunnels = d["tunnels"].as_array().cloned().unwrap_or_default();
    // Tab 補完的名字順手更新；CI 用環境變數的 token 時不留檔。/ Tab completion's names, refreshed on the way; none written for a token from the environment (CI).
    if api.is_stored() {
        complete::remember_tunnels(&api.server, &tunnels);
    }
    Ok(Dashboard { tunnels, latency: d["latency"].clone() })
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

/// 每條隧道我能用的帳號（並行查；也記給 Tab 補完）。/ The accounts I may use on each tunnel, fetched in parallel (and noted for Tab completion).
fn accounts_of(api: &Api, tunnels: &[Value]) -> Vec<Vec<String>> {
    let found = accounts_fetch(api, tunnels);
    if api.is_stored() {
        let ids = tunnels.iter().map(|t| t["id"].as_i64().unwrap_or_default());
        complete::remember_accounts(&api.server, &ids.zip(found.iter().cloned()).collect::<Vec<_>>());
    }
    found
}

fn accounts_fetch(api: &Api, tunnels: &[Value]) -> Vec<Vec<String>> {
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
    print_table(&["NAME", "HEALTH", "LATENCY", "ACCOUNTS", "LABELS", "GROUP", "SEEN"], &rows, |col, text| match col {
        1 => color::health(text),
        _ if text == "-" => color::DIM,
        _ => color::PLAIN,
    });
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
    line("name", color::out(color::BOLD, name_of(&t)));
    line("health", color::out(color::health(s(&t, "health")), s(&t, "health")));
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
            println!("{}      {}", color::out(color::WARN, "warning"), w.as_str().map(str::to_string).or_else(|| w.get("message").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| w.to_string()));
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

/// 寫好的 `ssh -F` 檔與它是給哪條隧道、哪個帳號的。/ A written `ssh -F` file and the tunnel + account it is for.
struct Prepared {
    file: PathBuf,
    alias: String,
    tunnel_id: i64,
    tunnel: String,
    account: String,
}

/// 寫好這條隧道 + 帳號的 `ssh -F` 檔，再檢查這台電腦的金鑰進不進得去（`--no-check` 不檢查），回 (檔案, 別名)。
/// Write the `ssh -F` file for a tunnel + account, check that this computer's key gets in (unless `--no-check`).
fn prepare_ssh(api: &Api, raw: &str, opts: &SshOpts) -> Result<(PathBuf, String)> {
    let p = write_ssh_config(api, raw, opts)?;
    // 交給 OpenSSH 之前先問 Telepy 這台電腦的金鑰進不進得去（被擋就說哪一關、為什麼、怎麼修）。
    // Before OpenSSH: ask Telepy whether this computer's key gets in (a refusal says which hop, why and the fix).
    if !opts.no_check {
        keycheck::before_ssh(api, &keycheck::Target { tunnel_id: p.tunnel_id, tunnel: &p.tunnel, account: &p.account }, &p.file, &p.alias, &extra_opts(opts))?;
    }
    Ok((p.file, p.alias))
}

fn write_ssh_config(api: &Api, raw: &str, opts: &SshOpts) -> Result<Prepared> {
    let d = dashboard(api)?;
    let (t, wanted) = resolve(&d.tunnels, raw)?;
    let (uid, account_name) = account(api, &t, wanted.as_deref())?;
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
    let proxy = if opts.via == "web" { carrier_command(api, &cfg, opts)? } else { None };
    let server_alias = sshcfg::server_alias(&cfg).to_string();
    let text = sshcfg::standalone(&stanzas, &sshcfg::config_path(&file), &sshcfg::config_path(&kh), identity.as_deref(), proxy.as_deref().map(|c| (server_alias.as_str(), c)));
    std::fs::write(&file, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }
    Ok(Prepared { file, alias, tunnel_id: id, tunnel: name_of(&t).to_string(), account: account_name })
}

/// 經網頁 port 那一跳的 ProxyCommand：`telepy _carrier --url <ws> --tcp <SSH 主機:port> --fallback … --server …`。
/// 伺服器太舊、沒給 `ws_url` 就回 None（照舊走 SSH 的 port）。`TELEPY_WS_URL` 可以換掉網址（鏡像 / 測試）。
/// The ProxyCommand of the hop through the web port; None when the server sends no `ws_url` (too old: the SSH port as
/// before). `TELEPY_WS_URL` replaces the URL (mirrors / tests).
fn carrier_command(api: &Api, cfg: &Value, opts: &SshOpts) -> Result<Option<String>> {
    let Some(url) = std::env::var("TELEPY_WS_URL").ok().filter(|u| !u.is_empty()).or_else(|| cfg["ws_url"].as_str().filter(|u| !u.is_empty()).map(str::to_string)) else {
        return Ok(None);
    };
    let fallback = opts.fallback.as_deref().and_then(prefs::Fallback::parse).unwrap_or_else(|| prefs::fallback(&api.server));
    let exe = std::env::current_exe().context("where is telepy?")?;
    // ssh_config 的 ProxyCommand 會展開 `%`：網址裡的 `%` 寫成 `%%`。/ ssh_config expands `%` in ProxyCommand.
    let pct = |s: &str| s.replace('%', "%%");
    let mut cmd = format!("{} _carrier --url {}", sshcfg::config_path(&exe), pct(&url));
    let host = cfg["server"]["host"].as_str().unwrap_or("");
    let port = cfg["server"]["port"].as_str().map(str::to_string).or_else(|| cfg["server"]["port"].as_i64().map(|p| p.to_string())).unwrap_or_default();
    if !host.is_empty() && !port.is_empty() {
        cmd.push_str(&format!(" --tcp {host}:{port}"));
    }
    cmd.push_str(&format!(" --fallback {} --server {}", fallback.as_str(), pct(&api.server)));
    Ok(Some(cmd))
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

/// `telepy forward`：寫好 ssh config，`ssh -N -L 127.0.0.1:<本機>:<主機>:<port>` 經裝置，等本機 port 接得通再印網址
/// （`--open` 打開瀏覽器），然後一直轉到 Ctrl+C。主機可以是區網主機表裡的位址、標籤或 id。
/// `telepy forward`: the ssh config, then `ssh -N -L 127.0.0.1:<local>:<host>:<port>` through the device; once the
/// local port answers, print the address (`--open` opens the browser) and keep forwarding until Ctrl+C. The host may
/// be an address, label or id from the device's LAN host list.
fn forward_cmd(api: &Api, a: &ForwardArgs) -> Result<i32> {
    let (raw_host, raw_port) = forward::parse_to(&a.to).map_err(|e| anyhow!(e))?;
    let d = dashboard(api)?;
    let (t, _) = resolve(&d.tunnels, &a.target)?;
    // 區網主機表裡的名字 → 位址；沒給 port 就用它第一個網頁 port。/ A LAN host's name → its address; its first web port by default.
    let (host, known_web) = if forward::is_device_itself(&raw_host) {
        (raw_host.clone(), None)
    } else {
        let hosts = api.get(&format!("/api/reverse/server/{}/lan/hosts", t["id"])).ok().and_then(|v| v["hosts"].as_array().cloned()).unwrap_or_default();
        match find_host(&hosts, &raw_host) {
            Some(h) => {
                let web = h["web"].as_array().and_then(|w| w.first()).and_then(|w| w["port"].as_u64()).and_then(|p| u16::try_from(p).ok());
                (s(h, "address").to_string(), web)
            }
            None => (raw_host.clone(), None),
        }
    };
    let port = raw_port.or(known_web).ok_or_else(|| anyhow!("No port given and no web port known for '{raw_host}' behind {}. Write it as {raw_host}:<port>.", name_of(&t)))?;
    let local = match a.local {
        Some(p) => {
            if std::net::TcpListener::bind(("127.0.0.1", p)).is_err() {
                bail!("Port {p} on this computer is in use. Pick another with --local, or leave it out.");
            }
            p
        }
        None => forward::local_candidates(port)
            .into_iter()
            .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
            .or_else(|| std::net::TcpListener::bind(("127.0.0.1", 0)).ok().and_then(|l| l.local_addr().ok()).map(|a| a.port()))
            .ok_or_else(|| anyhow!("No free local port found."))?,
    };
    let (file, alias) = prepare_ssh(api, &a.target, &a.opts)?;
    let mut cmd = Command::new("ssh");
    cmd.arg("-F").arg(&file).args(["-N", "-o", "ExitOnForwardFailure=yes", "-L"]).arg(forward::local_spec(local, &host, port));
    cmd.args(extra_opts(&a.opts)).arg(&alias);
    let mut child = cmd.spawn().with_context(|| "cannot run ssh (is OpenSSH installed?)")?;
    // 本機 port 接得通 = 轉好了（ssh 起不來就說它怎麼結束的）。/ The local port answering = forwarding (or say how ssh ended).
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            bail!("ssh ended before the forward was up ({status}). Run with --ssh-opt -v to see why.");
        }
        if std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], local)), std::time::Duration::from_millis(300)).is_ok() {
            break;
        }
        if started.elapsed() > std::time::Duration::from_secs(30) {
            let _ = child.kill();
            bail!("The forward did not come up within 30 seconds.");
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let shown = forward::local_url(port, local, a.https).unwrap_or_else(|| format!("localhost:{local}"));
    let target_text = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    println!("{shown}");
    eprintln!("Forwarding {shown} → {target_text} behind {}. Press Ctrl+C to stop.", name_of(&t));
    if a.open {
        match forward::local_url(port, local, a.https) {
            Some(url) => {
                if let Err(e) = open_in_browser(&url) {
                    eprintln!("Could not open a browser ({e}); open {url} yourself.");
                }
            }
            None => eprintln!("Port {port} is not a known web port, so nothing was opened (add --https or open it yourself)."),
        }
    }
    let status = child.wait()?;
    Ok(status.code().unwrap_or(0))
}

/// 打開瀏覽器；`TELEPY_NO_BROWSER` = 不開（測試）。/ Open the browser; `TELEPY_NO_BROWSER` = don't (tests).
fn open_in_browser(url: &str) -> std::io::Result<()> {
    if std::env::var_os("TELEPY_NO_BROWSER").is_some() || oauth::open_browser(url) {
        Ok(())
    } else {
        Err(std::io::Error::other("no browser opener worked"))
    }
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

/// `telepy config fallback [ask|always|never]`：這台伺服器的網頁 port 連不到時要不要改走 SSH 的 port。
/// Whether `telepy ssh / scp / sftp` may use the SSH port when this server's web port can't be reached.
fn config_fallback(api: &Api, value: Option<&str>) -> Result<()> {
    let explain = |f: prefs::Fallback| match f {
        prefs::Fallback::Ask => "ask in the terminal each time (no terminal = don't)",
        prefs::Fallback::Always => "use the SSH port without asking (Telepy then can't see your real address)",
        prefs::Fallback::Never => "never use the SSH port; fail instead",
    };
    match value.and_then(prefs::Fallback::parse) {
        Some(f) => {
            prefs::set_fallback(&api.server, f)?;
            println!("{}: when the web port can't be reached, {}", api.server, explain(f));
        }
        None => {
            let f = prefs::fallback(&api.server);
            println!("{}: {} — when the web port can't be reached, {}", api.server, f.as_str(), explain(f));
        }
    }
    Ok(())
}

/// `telepy config tidy`：在這台電腦上簡化 ~/.ssh/config（規則跟網頁的 SSH config 編輯器一樣，見 `tidy.rs`）——列出改了什麼、
/// 值得看一下的行與差異，問過才寫回去，寫之前備份成 `<檔名>.bak`。`--check` 只回報，能更短或有值得看的行就結束碼 1。
/// `telepy config tidy`: simplify ~/.ssh/config on this computer (the web SSH config editor's rules, see `tidy.rs`) —
/// lists what changed, lines worth a look and the diff, asks before writing and backs up to `<file>.bak` first.
/// `--check` only reports and exits 1 when the file could be shorter or has lines worth a look.
fn config_tidy(file: Option<PathBuf>, wildcards: bool, check: bool, yes: bool) -> Result<i32> {
    use std::io::{BufRead, IsTerminal, Write};
    let target = file.unwrap_or_else(|| creds::home_dir().join(".ssh").join("config"));
    let text = std::fs::read_to_string(&target).with_context(|| format!("reading {}", target.display()))?;
    let r = tidy::tidy(&text, wildcards);
    let paint = |style: anstyle::Style, s: &str| color::out(style, s);
    if !r.failed.is_empty() {
        bail!("The final check found a difference for {}, so nothing was changed. Please report this config.", r.failed.join(", "));
    }
    let worth: Vec<&tidy::Note> = r.notes.iter().filter(|n| !matches!(n, tidy::Note::Wall { .. })).collect();
    let changed = r.text != text;
    if changed {
        println!(
            "{}: {} -> {} lines ({} -> {} settings). Checked {} names: ssh reads each one exactly as before.",
            target.display(),
            r.before.lines,
            r.after.lines,
            r.before.settings,
            r.after.settings,
            r.checked.len()
        );
        println!("\nWhat changed:");
        for c in &r.changes {
            let line = match c {
                tidy::Change::Duplicate { n, key, host } => format!("line {n}: {key} is set again in the same block (Host {host}); removed, ssh only reads the first"),
                tidy::Change::Repeat { n, key, host, by } => format!("line {n}: {key} repeats what line {by} already gives Host {host}; removed"),
                tidy::Change::Shared { hosts, keys, removed, telepy } => format!(
                    "{} written once for {} ({removed} lines moved into one {}block)",
                    keys.join(", "),
                    hosts.join(" "),
                    if *telepy { "telepy shared " } else { "" }
                ),
                tidy::Change::Wildcard { pattern, hosts } => format!("Host {pattern} instead of {} (also applies to other names matching {pattern})", hosts.join(" ")),
            };
            println!("  - {line}");
        }
    } else {
        println!("{}: nothing to simplify.", target.display());
    }
    if !worth.is_empty() {
        println!("\nWorth a look:");
        for n in &worth {
            let line = match n {
                tidy::Note::Shadowed { n, key, host, by, value, winner } => format!("line {n}: {key} {value} (Host {host}) never takes effect: line {by} already sets {winner}"),
                tidy::Note::Unknown { n, key } => format!("line {n}: {key} is not an OpenSSH option; ssh refuses the whole file unless IgnoreUnknown lists it"),
                tidy::Note::Ignored { n, key } => format!("line {n}: ssh ignores {key}, an option it no longer supports"),
                tidy::Note::Invalid { n } => format!("line {n} can't be read (an unclosed quote?); its block is left alone"),
                tidy::Note::Wall { .. } => unreachable!(),
            };
            println!("  {} {line}", paint(color::WARN, "!"));
        }
        println!("  The SSH config editor in Telepy (SSH config editor in the sidebar) offers one-click fixes for these.");
    }
    if changed {
        println!();
        println!("{}", paint(color::BOLD, &format!("--- {}", target.display())));
        println!("{}", paint(color::BOLD, "+++ simplified"));
        for h in tidy::hunks(&tidy::diff(&text, &r), 2) {
            match h {
                None => println!("{}", paint(color::CODE, "@@")),
                Some(l) if l.sign == '-' => println!("{}", paint(color::BAD, &format!("-{}", l.text))),
                Some(l) if l.sign == '+' => println!("{}", paint(color::GOOD, &format!("+{}", l.text))),
                Some(l) => println!(" {}", l.text),
            }
        }
    }
    if check {
        return Ok(i32::from(changed || !worth.is_empty()));
    }
    if !changed {
        return Ok(0);
    }
    let backup = PathBuf::from(format!("{}.bak", target.display()));
    if !yes {
        if !std::io::stdin().is_terminal() {
            eprintln!("\nNot written. Run again with --yes to write it (the current file is kept as {}).", backup.display());
            return Ok(0);
        }
        print!("\nWrite it to {}? The current file is kept as {}. [y/N] ", target.display(), backup.display());
        std::io::stdout().flush()?;
        let mut answer = String::new();
        std::io::stdin().lock().read_line(&mut answer)?;
        if !matches!(answer.trim().to_lowercase().as_str(), "y" | "yes") {
            println!("Not written.");
            return Ok(0);
        }
    }
    std::fs::write(&backup, &text).with_context(|| format!("writing {}", backup.display()))?;
    // 覆寫既有的檔：權限（例如 600）照舊。/ Overwriting the existing file keeps its permissions (e.g. 600).
    std::fs::write(&target, &r.text).with_context(|| format!("writing {}", target.display()))?;
    println!("Wrote {} ({} -> {} lines); the previous version is {}.", target.display(), r.before.lines, r.after.lines, backup.display());
    Ok(0)
}

fn sftp(api: &Api, a: &SftpArgs) -> Result<i32> {
    let (file, alias) = prepare_ssh(api, &a.target, &a.opts)?;
    let mut cmd = Command::new("sftp");
    cmd.arg("-F").arg(&file).args(extra_opts(&a.opts)).arg(&alias);
    hand_over(cmd)
}

fn config(api: &Api, a: ConfigArgs) -> Result<()> {
    if let ConfigAction::Fallback { value } = &a.action {
        return config_fallback(api, value.as_deref());
    }
    let ConfigAction::Install { tunnels, all, print, file } = a.action else { unreachable!("config tidy runs before signing in") };
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
            .enumerate()
            .map(|(i, job)| {
                let stdout = &stdout;
                scope.spawn(move || {
                    let o = run_on(api, job, command, timeout, wait);
                    if !as_json {
                        let _g = stdout.lock().unwrap();
                        print_outcome(&o, single, color::PREFIXES[i % color::PREFIXES.len()]);
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
        let ok = format!("{} ok", outcomes.len() - failed);
        let bad = format!("{failed} failed");
        eprintln!("{}, {}", color::err(color::GOOD, &ok), if failed > 0 { color::err(color::BAD, &bad) } else { bad });
    }
    Ok(if failed > 0 { 1 } else { 0 })
}

fn print_outcome(o: &Outcome, single: bool, style: anstyle::Style) {
    // 前綴上色，裝置的輸出原樣轉過去（不管它有沒有自己的顏色碼）。/ The prefix is coloured; the device's output passes through as is.
    let prefix = if single { String::new() } else { format!("{} {} ", color::out(style, &o.name), color::out(color::DIM, "|")) };
    let eprefix = if single { String::new() } else { format!("{} {} ", color::err(style, &o.name), color::err(color::DIM, "|")) };
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
                eprintln!("{eprefix}{line}");
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
                eprintln!("{eprefix}{}", color::err(color::WARN, "(output truncated; the start and the end are kept)"));
            }
            if v["timed_out"].as_bool() == Some(true) {
                eprintln!("{eprefix}{}", color::err(color::WARN, "(timed out and killed)"));
            }
            if !single {
                let code = v["exit_code"].as_i64();
                let text = format!("exit {}", code.map(|c| c.to_string()).unwrap_or_else(|| "-".into()));
                eprintln!("{eprefix}{}", color::err(if code == Some(0) { color::GOOD } else { color::BAD }, &text));
            }
        }
        Err(e) => eprintln!("{eprefix}{} {e}", color::err(color::BAD, "error:")),
    }
    let _ = std::io::stdout().flush();
}

// ---------------------------------------------------------------- cp

/// 區網主機那一邊的檔案 session（`<tunnel>/<host>:path`）：用完關掉（沒傳完的暫存檔一起刪）。
/// A LAN host's file session for `cp` (`<tunnel>/<host>:path`), closed when done.
struct LanFiles<'a> {
    api: &'a Api,
    tunnel_id: i64,
    session: String,
}

impl Drop for LanFiles<'_> {
    fn drop(&mut self) {
        let _ = self.api.send(Method::DELETE, &format!("/api/reverse/server/{}/lan/files/{}", self.tunnel_id, urlencoding::encode(&self.session)), None, Some(Duration::from_secs(10)));
    }
}

/// 經裝置登入那台主機：Telepy 的金鑰，或 `TELEPY_LAN_PASSWORD` 的密碼（只拿來登入）。
/// Log in to the LAN host through the device: Telepy's key, or the password in `TELEPY_LAN_PASSWORD`.
fn open_lan_files<'a>(api: &'a Api, t: &Value, device_account: &str, side: &target::LanSide) -> Result<LanFiles<'a>> {
    let id = t["id"].as_i64().unwrap_or_default();
    let hosts = api.get(&format!("/api/reverse/server/{id}/lan/hosts"))?["hosts"].as_array().cloned().unwrap_or_default();
    let h = find_host(&hosts, &side.host).ok_or_else(|| anyhow!("No LAN host '{}' behind {}. `telepy lan ls {}` lists them (by label, address or id).", side.host, name_of(t), name_of(t)))?;
    let mut body = json!({ "account": device_account, "auth": "telepy" });
    if let Some(login) = &side.login {
        body["login"] = json!(login);
    }
    if let Ok(pw) = std::env::var("TELEPY_LAN_PASSWORD") {
        if !pw.is_empty() {
            body["auth"] = json!("password");
            body["password"] = json!(pw);
        }
    }
    let res = api.send(Method::POST, &format!("/api/reverse/server/{id}/lan/hosts/{}/files", h["id"]), Some(&body), Some(Duration::from_secs(60)))?;
    match api::read(res) {
        Ok(v) => {
            eprintln!("{}", color::err(color::DIM, &format!("{}@{} through {}@{} ({})", s(&v, "login"), s(&v, "address"), device_account, name_of(t), s(&v, "auth"))));
            Ok(LanFiles { api, tunnel_id: id, session: s(&v, "session").to_string() })
        }
        Err(e) => {
            let code = e.downcast_ref::<api::HttpError>().and_then(|h| h.body["code"].as_str().map(str::to_string)).unwrap_or_default();
            let hint = match code.as_str() {
                "lan_files_login" if body["auth"] == "telepy" => "\nSet TELEPY_LAN_PASSWORD to log in with a password instead (it's used once and not stored).",
                "lan_login_required" => "\nWrite the login as <tunnel>/<login>@<host>:<path>.",
                _ => "",
            };
            Err(anyhow!("{e}{hint}"))
        }
    }
}

fn cp(api: &Api, a: &CpArgs) -> Result<()> {
    let from = target::parse_remote(&a.from);
    let to = target::parse_remote(&a.to);
    let d = dashboard(api)?;
    match (from, to) {
        (Some((tgt, path)), None) => {
            let (device, lan) = target::split_lan(&tgt);
            let (t, acc) = resolve(&d.tunnels, &device)?;
            let (_, mut user) = account(api, &t, acc.as_deref())?;
            let id = t["id"].as_i64().unwrap_or_default();
            let _lan = match &lan {
                Some(side) => {
                    let f = open_lan_files(api, &t, &user, side)?;
                    user = f.session.clone();
                    Some(f)
                }
                None => None,
            };
            let url = format!("/api/sftp/download/{id}/{}?path={}", urlencoding::encode(&user), urlencoding::encode(&path));
            // 沒有整體時限：大檔 / 大資料夾要多久就多久（資料一直在流）。/ No overall limit: big downloads take as long as they take.
            let mut res = api.request(Method::GET, &url)?.timeout(Duration::from_secs(24 * 3600)).send().with_context(|| format!("download {}", a.from))?;
            if res.status().as_u16() >= 400 {
                return Err(api::read(res).unwrap_err());
            }
            let zip = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|c| c.contains("zip"));
            let base = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
            let mut dest = PathBuf::from(&a.to);
            if dest.is_dir() {
                dest = dest.join(if zip { format!("{base}.zip") } else { base });
            }
            // 直接寫到磁碟，不先放進記憶體；失敗就不留半個檔案。/ Straight to disk; a failure leaves no half file.
            let mut file = std::fs::File::create(&dest).with_context(|| format!("write {}", dest.display()))?;
            let written = match res.copy_to(&mut file) {
                Ok(n) => n,
                Err(e) => {
                    drop(file);
                    let _ = std::fs::remove_file(&dest);
                    return Err(anyhow!(e).context(format!("download {}", a.from)));
                }
            };
            eprintln!("{} → {} ({} bytes{})", a.from, dest.display(), written, if zip { ", zipped directory" } else { "" });
        }
        (None, Some((tgt, path))) => {
            let (device, lan) = target::split_lan(&tgt);
            let (t, acc) = resolve(&d.tunnels, &device)?;
            let (_, mut user) = account(api, &t, acc.as_deref())?;
            let id = t["id"].as_i64().unwrap_or_default();
            let _lan = match &lan {
                Some(side) => {
                    let f = open_lan_files(api, &t, &user, side)?;
                    user = f.session.clone();
                    Some(f)
                }
                None => None,
            };
            let src = Path::new(&a.from);
            if src.is_dir() {
                bail!("{} is a directory; telepy cp copies files (use `telepy scp -r` for directories).", src.display());
            }
            let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "upload".into());
            if let Some(landed) = upload_in_parts(api, id, &user, src, &path, &name)? {
                eprintln!("{} → {} {}", a.from, tgt, landed);
                return Ok(());
            }
            // 舊的伺服器沒有分段上傳：整個檔案一個請求。/ An older server without parts: one request.
            let part = reqwest::blocking::multipart::Part::file(src).with_context(|| format!("read {}", src.display()))?.file_name(name);
            let form = reqwest::blocking::multipart::Form::new().part("file", part);
            let url = format!("/api/sftp/upload/{id}/{}?destination_path={}", urlencoding::encode(&user), urlencoding::encode(if path.is_empty() { "." } else { &path }));
            let res = api.request(Method::POST, &url)?.timeout(Duration::from_secs(3600)).multipart(form).send()?;
            let v = api::read(res)?;
            eprintln!("{} → {} {}", a.from, tgt, v.get("path").and_then(Value::as_str).unwrap_or(&path));
        }
        (Some(_), Some(_)) => bail!("Copy between a device and this computer; device-to-device isn't supported."),
        (None, None) => bail!("Write the device side as <tunnel>[@account]:<path>, or a LAN host behind it as <tunnel>[@account]/[login@]<host>:<path>."),
    }
    Ok(())
}

/// 分段上傳的一段多大（後端最多收 32 MiB；前面的代理常常一個請求只放 100 MB）。/ Bytes per upload part.
const UPLOAD_PART: u64 = 8 * 1024 * 1024;

/// 這個狀態值得等一下重送嗎（連線斷了、前面的代理放棄了、太忙）。/ Worth resending after a wait?
fn transient(status: u16) -> bool {
    matches!(status, 408 | 429 | 502 | 503 | 504 | 520..=524)
}

/// 分段上傳（`PUT /api/sftp/upload-part/…`，每段一個請求，斷了重送那一段，完成才改名成目標）。
/// 目標：裝置上的資料夾 → 放進去（保留檔名），否則就是完整路徑；同名就取代（跟以前的 `cp` 一樣）。
/// `Ok(None)` = 伺服器還沒有這個端點（舊版），呼叫端改用一個請求的上傳。
/// Upload in parts (one request per part, failed parts resent, renamed onto the target when complete). A folder on
/// the device keeps the file's name; otherwise the path is the target; an existing file is replaced, as `cp` always
/// did. `Ok(None)` = an older server without the endpoint.
fn upload_in_parts(api: &Api, id: i64, user: &str, src: &Path, path: &str, name: &str) -> Result<Option<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let remote = if path.is_empty() { "~" } else { path };
    let stat = api.send(Method::GET, &format!("/api/sftp/stat/{id}/{}?path={}", urlencoding::encode(user), urlencoding::encode(remote)), None, None)?;
    let target = match stat.status().as_u16() {
        200 => {
            let v = api::read(stat)?;
            if v["type"] == "directory" {
                format!("{}/{name}", v["path"].as_str().unwrap_or(remote).trim_end_matches('/'))
            } else {
                remote.to_string()
            }
        }
        404 => remote.to_string(),
        _ => return Err(api::read(stat).unwrap_err()),
    };
    let mut file = std::fs::File::open(src).with_context(|| format!("read {}", src.display()))?;
    let size = file.metadata()?.len();
    let upload: String = {
        use rand::Rng;
        let abc = b"abcdefghijklmnopqrstuvwxyz0123456789";
        let mut rng = rand::thread_rng();
        (0..16).map(|_| abc[rng.gen_range(0..abc.len())] as char).collect()
    };
    let base = format!("/api/sftp/upload-part/{id}/{}", urlencoding::encode(user));
    let mut offset = 0u64;
    let mut attempt = 0u32;
    loop {
        let len = UPLOAD_PART.min(size - offset);
        let mut buf = vec![0u8; len as usize];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut buf).with_context(|| format!("read {}", src.display()))?;
        let q = format!("path={}&upload={upload}&offset={offset}&total={size}&overwrite=1{}", urlencoding::encode(&target), if attempt > 0 { "&retry=1" } else { "" });
        let sent = api
            .request(Method::PUT, &format!("{base}?{q}"))?
            .timeout(Duration::from_secs(600))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(buf)
            .send();
        let status = sent.as_ref().map(|r| r.status().as_u16()).unwrap_or(0);
        if (status == 0 || transient(status)) && attempt < 5 {
            attempt += 1;
            std::thread::sleep(Duration::from_secs(1 << attempt.min(4)));
            continue;
        }
        let res = sent.with_context(|| format!("upload {}", src.display()))?;
        if offset == 0 && attempt == 0 && matches!(status, 404 | 405) {
            return Ok(None);
        }
        let body: Value = res.json().unwrap_or(Value::Null);
        match (status, body["code"].as_str()) {
            (200, _) if body["done"] == true => return Ok(Some(body["path"].as_str().unwrap_or(&target).to_string())),
            (200, _) | (409, Some("upload_offset")) if body["received"].is_u64() => {
                offset = body["received"].as_u64().unwrap_or(offset);
                attempt = 0;
            }
            _ => return Err(api::HttpError { status, body }.into()),
        }
    }
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
    print_table(&["ID", "TUNNEL", "USER", "KIND", "IP", "SINCE", "CLIENT"], &rows, plain);
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
            print_table(&["ID", "TUNNEL", "USER", "ACCOUNT", "STARTED", "LENGTH"], &rows, plain);
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
    print_table(&["ID", "SCOPE", "NAME", "COMMAND"], &rows, plain);
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

// ---------------------------------------------------------------- keys

fn keys_cmd(api: &Api, a: KeysArgs) -> Result<i32> {
    match a.action.unwrap_or(KeysAction::Ls { json: false }) {
        KeysAction::Ls { json } => keys_ls(api, json || a.json).map(|_| 0),
        KeysAction::Add { file, name, device } => {
            let offered = keys::offered_by_default(&ssh_dir(), &creds::home_dir());
            keycheck::register(api, &offered, file.as_deref(), name.as_deref())?;
            match device {
                Some(target) => keys_check(api, &target, true, false),
                None => Ok(0),
            }
        }
        KeysAction::Check { target, yes, json } => keys_check(api, &target, yes, json),
    }
}

/// `telepy keys check <target>`：寫好這條的 ssh config（跟 `telepy ssh` 一樣），再一關一關看。
/// `telepy keys check <target>`: the same ssh config as `telepy ssh`, then hop by hop.
fn keys_check(api: &Api, target: &str, yes: bool, as_json: bool) -> Result<i32> {
    let opts = SshOpts { via: "web".into(), no_check: true, ..Default::default() };
    let p = write_ssh_config(api, target, &opts)?;
    keycheck::report(api, &keycheck::Target { tunnel_id: p.tunnel_id, tunnel: &p.tunnel, account: &p.account }, &p.file, &p.alias, yes, as_json)
}

/// `telepy keys`：你在 Telepy 的金鑰，與這台電腦有哪幾把。/ Your keys in Telepy and which of them this computer has.
fn keys_ls(api: &Api, as_json: bool) -> Result<()> {
    let mine = keycheck::my_keys(api)?;
    let home = creds::home_dir();
    let offered = keys::offered_by_default(&ssh_dir(), &home);
    let here = |k: &Value| k["fingerprint"].as_str().and_then(|fp| offered.find(fp));
    if as_json {
        let rows: Vec<Value> = mine
            .iter()
            .map(|k| {
                let local = here(k);
                json!({
                    "id": k["id"], "name": k["host_friendly_name"], "type": k["key_type"], "fingerprint": k["fingerprint"],
                    "expires_at": k["expires_at"], "expired": k["expired"], "last_used_at": k["last_used_at"],
                    "on_this_computer": local.is_some(), "path": local.and_then(|l| l.path.clone()),
                })
            })
            .collect();
        return print_json(&Value::Array(rows));
    }
    if mine.is_empty() {
        println!("You have no SSH keys in Telepy yet; `telepy ssh` needs one. Add this computer's: telepy keys add");
        return Ok(());
    }
    let t = now();
    let rows: Vec<Vec<String>> = mine
        .iter()
        .map(|k| {
            let expires = match (k["expired"].as_bool(), k["expires_at"].as_str()) {
                (Some(true), _) => "expired".to_string(),
                (_, Some(e)) => e.get(..10).unwrap_or(e).to_string(),
                _ => "never".to_string(),
            };
            let local = match here(k) {
                Some(l) => l.path.as_ref().map(|p| keys::display_path(p, &home)).unwrap_or_else(|| "ssh agent".into()),
                None => String::new(),
            };
            vec![s(k, "host_friendly_name").to_string(), s(k, "key_type").to_string(), s(k, "fingerprint").to_string(), expires, table::ago(k["last_used_at"].as_str(), t), local]
        })
        .collect();
    print_table(&["NAME", "TYPE", "FINGERPRINT", "EXPIRES", "LAST USED", "ON THIS COMPUTER"], &rows, |col, text| match (col, text) {
        (3, "expired") => color::BAD,
        (5, t) if !t.is_empty() => color::GOOD,
        _ => color::PLAIN,
    });
    if !mine.iter().any(|k| here(k).is_some() && k["expired"] != true) {
        println!();
        println!("None of these is on this computer, so `telepy ssh` from here would be refused. Add its key: telepy keys add");
    }
    Ok(())
}

// ---------------------------------------------------------------- doctor

fn doctor(server: Option<&str>, token: Option<&str>) -> Result<i32> {
    let mut bad = 0;
    let warn = || color::out(color::WARN, "!");
    let mut check = |ok: bool, what: &str, detail: String| {
        let mark = if ok { color::out(color::GOOD, "✓") } else { color::out(color::BAD, "✗") };
        println!("{mark} {what}{}", if detail.is_empty() { String::new() } else { format!(": {detail}") });
        if !ok {
            bad += 1;
        }
    };
    // 這個 telepy 的版本與有沒有新版（舊版不算錯，只提醒）。/ This telepy's version and whether a newer one is out (a warning, not a failure).
    if update::release_build() {
        match update::latest_tag(Duration::from_secs(5)) {
            Ok(tag) if update::newer(&tag, VERSION) => println!("{} telepy: {VERSION} ({} is out: run `telepy update`)", warn(), update::plain(&tag)),
            Ok(_) => check(true, "telepy", format!("{VERSION} (latest)")),
            Err(e) => println!("{} telepy: {VERSION} (couldn't check for a newer release: {e:#})", warn()),
        }
    } else {
        check(true, "telepy", format!("{VERSION} (a local build, not checked for updates)"));
    }
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
                        // 這台電腦的金鑰在不在 Telepy（ssh / scp / sftp 要它）；伺服器太舊讀不到就不說。
                        // Whether this computer's key is in Telepy (ssh / scp / sftp need it); silent on an older server.
                        if let Ok(mine) = keycheck::my_keys(&api) {
                            let offered = keys::offered_by_default(&ssh_dir(), &creds::home_dir());
                            let hit = mine.iter().find(|k| k["expired"] != true && k["fingerprint"].as_str().is_some_and(|fp| offered.find(fp).is_some()));
                            match (hit, offered.keys.is_empty()) {
                                (Some(k), _) => check(true, "ssh key", format!("\"{}\" ({}) is in Telepy", s(k, "host_friendly_name"), s(k, "fingerprint"))),
                                // 只是提醒：只用 exec / cp 的人不需要金鑰。/ A warning only: exec / cp need no key.
                                (None, true) => println!("{} ssh key: this computer has none; `telepy keys add` makes and adds one (ssh / scp / sftp need it)", warn()),
                                (None, false) => println!("{} ssh key: none of this computer's keys is in Telepy; `telepy keys add` adds it (ssh / scp / sftp need it)", warn()),
                            }
                        }
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
    if let Some(url) = &server_url {
        // `telepy ssh` 經網頁 port 連 Telepy；連不到時怎麼辦。/ `telepy ssh` rides the web port; what happens when it can't.
        let via = std::env::var("TELEPY_SSH_VIA").ok().filter(|v| v == "ssh").map(|_| "the SSH port (TELEPY_SSH_VIA)").unwrap_or("the web port");
        check(true, "ssh way in", format!("{via}; if the web port can't be reached: {} (telepy config fallback)", prefs::fallback(url).as_str()));
    }
    if bad == 0 {
        // 全部通過、而且是終端機：Tapi 開心一下。/ All good in a terminal: a happy Tapi.
        if let Some(paint) = tapi::paint_for(color::Stream::Out) {
            println!();
            let clip = mascot::clip_color(mascot::clip_name(&tapi_color, mascot::unix_day()));
            for line in tapi::beside(&mascot::render_with(mascot::HAPPY, paint, clip), &["Everything looks good."], tapi::columns(tapi::Out::Stdout)) {
                println!("{line}");
            }
        }
    }
    Ok(if bad > 0 { 1 } else { 0 })
}

// ---------------------------------------------------------------- update

/// `telepy update [--check] [--to <version>]`：下載這個平台的發行檔、對雜湊、換掉自己（`update::replace`）。
/// `telepy update [--check] [--to <version>]`: download this platform's release, check its hash, replace ourselves.
fn update_cmd(a: UpdateArgs) -> Result<i32> {
    let target = update::target().ok_or_else(|| anyhow!("there is no prebuilt telepy for {}-{}; build it from src/cli", std::env::consts::OS, std::env::consts::ARCH))?;
    let tag = match &a.to {
        Some(v) => {
            let v = v.trim();
            if update::parse_version(v).is_none() {
                bail!("{v} is not a version (e.g. v2.9.0)");
            }
            if v.starts_with('v') { v.to_string() } else { format!("v{v}") }
        }
        None => {
            let tag = update::latest_tag(Duration::from_secs(15)).context("find the latest release")?;
            update::write_cache(&update::Cache { checked_at: now(), latest: tag.clone() });
            tag
        }
    };
    let version = update::plain(&tag).to_string();
    let is_newer = update::newer(&tag, VERSION);
    if a.check {
        if is_newer {
            println!("telepy {version} is out (you have {VERSION}): run `telepy update`.");
        } else {
            println!("telepy {VERSION} is up to date (the latest release is {version}).");
        }
        return Ok(0);
    }
    if version == VERSION || (a.to.is_none() && !is_newer) {
        println!("telepy {VERSION} is up to date.");
        return Ok(0);
    }
    let exe = std::env::current_exe().and_then(|p| p.canonicalize()).context("find this telepy")?;
    if let Some(how) = update::managed_by(&exe) {
        bail!("this telepy ({}) was installed with {how}", exe.display());
    }
    update::clean_leftovers(&exe);
    eprintln!("Downloading telepy {version} for {target}…");
    let bytes = update::fetch_binary(&tag, target)?;
    let reported = update::replace(&exe, &bytes)?;
    println!("Updated {} from {VERSION} to {version} ({reported}).", exe.display());
    Ok(0)
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
                print_table(&["ID", "TUNNEL", "ACCOUNT", "ACTIONS", "LAST USED"], &rows, plain);
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

/// `lan ls` / `lan scan` 的表：WHAT（認出來的產品或類型）與 NOTE（裝置自己、閘道、上次掃描的變化）。裝置自己排第一、
/// 閘道第二、這次沒看到的排最後。
/// The host table, with WHAT (the recognised product or type) and NOTE (the device itself, the gateway, what the last
/// scan changed). The device itself first, the gateway second, hosts not seen last.
fn print_hosts(hosts: &[Value]) {
    let rank = |h: &Value| if h["own"] == true { 0 } else if h["gateway"] == true { 1 } else if h["missing"] == true { 3 } else { 2 };
    let mut sorted: Vec<&Value> = hosts.iter().collect();
    sorted.sort_by_key(|h| rank(h));
    let rows: Vec<Vec<String>> = sorted
        .iter()
        .map(|h| {
            let ports = h["open_ports"].as_array().map(|p| p.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")).unwrap_or_default();
            let name = [s(h, "label"), s(h, "hostname")].into_iter().find(|x| !x.is_empty()).unwrap_or("").to_string();
            vec![h["id"].to_string(), s(h, "address").to_string(), name, lan_what(h), s(h, "username").to_string(), ports, s(h, "source").to_string(), lan_note(h)]
        })
        .collect();
    print_table(&["ID", "ADDRESS", "NAME", "WHAT", "LOGIN", "OPEN PORTS", "SOURCE", "NOTE"], &rows, |col, text| match col {
        3 => color::DIM,
        7 if text.contains("not seen") => color::WARN,
        7 if text.contains("new") || text.contains('+') => color::GOOD,
        7 => color::DIM,
        _ => color::PLAIN,
    });
}

/// NOTE 一格：裝置自己、閘道、上次掃描新出現 / port 開關、這次沒看到。/ The NOTE cell.
fn lan_note(h: &Value) -> String {
    let mut out: Vec<String> = Vec::new();
    if h["own"] == true {
        out.push("this device".into());
    }
    if h["gateway"] == true {
        out.push("gateway".into());
    }
    let since = &h["since_last"];
    if since["new"] == true {
        out.push("new".into());
    }
    let ports = port_changes(since);
    if !ports.is_empty() {
        out.push(ports);
    }
    if h["missing"] == true {
        out.push("not seen".into());
    }
    if h["watched"] == true {
        out.push("watched".into());
    }
    for l in h["labels"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        out.push(format!("#{l}"));
    }
    out.join(", ")
}

/// `--every` 的值 → 秒（跟後端的間隔一樣）；`off` = 0。/ An `--every` value as seconds (the server's intervals); `off` = 0.
fn parse_every(raw: &str) -> Result<i64> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "off" | "none" | "0" => Ok(0),
        "1h" | "60m" | "hourly" => Ok(3600),
        "6h" => Ok(6 * 3600),
        "12h" => Ok(12 * 3600),
        "1d" | "24h" | "daily" => Ok(86_400),
        "1w" | "7d" | "weekly" => Ok(7 * 86_400),
        other => bail!("--every takes 1h, 6h, 12h, 1d, 1w or off (not '{other}')."),
    }
}

fn every_words(secs: i64) -> String {
    match secs {
        3600 => "every hour".into(),
        86_400 => "every day".into(),
        604_800 => "every week".into(),
        s if s % 3600 == 0 => format!("every {} hours", s / 3600),
        s => format!("every {s} s"),
    }
}

/// 排程的一行（沒有 = None）。/ The schedule as one line (None when there is none).
fn lan_schedule_line(sched: &Value, off: chrono::FixedOffset) -> Option<String> {
    let every = sched["every_secs"].as_i64()?;
    let when = |k: &str| chrono::DateTime::parse_from_rfc3339(s(sched, k)).ok().map(|t| t.with_timezone(&off).format("%Y-%m-%d %H:%M").to_string());
    let mut line = format!("Rescans {}, next {}", every_words(every), when("next_at").unwrap_or_else(|| "-".into()));
    if !s(sched, "by").is_empty() {
        line.push_str(&format!(" (set by {})", s(sched, "by")));
    }
    line.push('.');
    if !s(sched, "last_error").is_empty() {
        line.push_str(&format!(" The last run failed: {}", s(sched, "last_error")));
    }
    Some(line)
}

/// 等掃描（或檢查）結束，一路印進度。/ Wait for a scan or check to end, printing progress.
fn wait_lan(api: &Api, id: i64, quiet: bool) -> Result<Value> {
    let (mut last, started) = (String::new(), std::time::Instant::now());
    loop {
        let st = api.get(&format!("/api/reverse/server/{id}/lan/scan"))?;
        let phase = s(&st, "phase").to_string();
        let line = lan_scan_line(&st);
        if line != last && !quiet {
            eprintln!("{line}");
            last = line;
        }
        if phase == "done" || phase == "failed" {
            return Ok(st);
        }
        if started.elapsed() > std::time::Duration::from_secs(600) {
            bail!("The scan is still running after 10 minutes; check the web app's Network page.");
        }
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
}

/// `{opened, closed}` → `+443 -80`。/ Opened and closed ports as `+443 -80`.
fn port_changes(v: &Value) -> String {
    let list = |k: &str, sign: char| v[k].as_array().into_iter().flatten().filter_map(Value::as_u64).map(|p| format!("{sign}{p}")).collect::<Vec<_>>();
    [list("opened", '+'), list("closed", '-')].concat().join(" ")
}

/// 一串位址，最多列 8 個。/ A list of addresses, at most 8 shown.
fn some_addresses(v: &Value) -> String {
    let all: Vec<&str> = v.as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let shown = all.iter().take(8).copied().collect::<Vec<_>>().join(", ");
    if all.len() > 8 {
        format!("{shown} +{} more", all.len() - 8)
    } else {
        shown
    }
}

/// 跟前一次掃描比的一行（`changes` 是 null = 還沒比過，回 None）。/ What the last scan changed, as one line (None without data).
fn lan_changes_line(c: &Value) -> Option<String> {
    if !c.is_object() {
        return None;
    }
    let count = |k: &str| c[k].as_array().map_or(0, Vec::len);
    let mut parts = Vec::new();
    if count("new") > 0 {
        parts.push(format!("{} new ({})", count("new"), some_addresses(&c["new"])));
    }
    if count("gone") > 0 {
        parts.push(format!("{} not seen ({})", count("gone"), some_addresses(&c["gone"])));
    }
    let changed: Vec<String> = c["changed"].as_array().into_iter().flatten().map(|x| format!("{} {}", s(x, "address"), port_changes(x))).collect();
    if !changed.is_empty() {
        let shown = changed.iter().take(8).cloned().collect::<Vec<_>>().join(", ");
        parts.push(format!("ports changed on {} ({shown}{})", changed.len(), if changed.len() > 8 { ", …" } else { "" }));
    }
    Some(if parts.is_empty() { "Nothing changed since the previous scan.".into() } else { format!("Since the previous scan: {}.", parts.join("; ")) })
}

/// `lan ls` 上面那一行：上次什麼時候、掃了哪些網段、閘道是誰。/ The line above `lan ls`: when, which networks, the gateway.
fn lan_meta_line(lan: &Value, off: chrono::FixedOffset) -> Option<String> {
    let at = chrono::DateTime::parse_from_rfc3339(s(lan, "scanned_at")).ok()?;
    let nets = lan["networks"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let mut line = format!("Last scan {} of {}", at.with_timezone(&off).format("%Y-%m-%d %H:%M"), if nets.is_empty() { "-" } else { &nets });
    if !s(lan, "gateway").is_empty() {
        line.push_str(&format!(", gateway {}", s(lan, "gateway")));
    }
    line.push('.');
    Some(line)
}

/// 「這台是什麼」一格：產品（· 系統）、只有類型時是類型。/ The WHAT cell: product (· OS), else the type.
fn lan_what(h: &Value) -> String {
    let id = &h["identity"];
    let (product, kind, os) = (s(id, "product"), s(id, "kind"), s(id, "os"));
    match (product.is_empty(), os.is_empty()) {
        (false, false) if !product.to_ascii_lowercase().contains(&os.to_ascii_lowercase()) => format!("{product} · {os}"),
        (false, _) => product.to_string(),
        (true, false) => format!("{kind} · {os}"),
        (true, true) => kind.to_string(),
    }
}

/// 掃描進度的一行（只在變了才印）。/ One progress line (printed when it changes).
fn lan_scan_line(st: &Value) -> String {
    let phase = s(st, "phase");
    let (n, total, found) = (st["probed"].as_u64().unwrap_or(0), st["total"].as_u64().unwrap_or(0), st["hosts_found"].as_u64().unwrap_or(0));
    let nets = st["networks"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    match phase {
        "connecting" => "Connecting to the device…".into(),
        "networks" => "Finding the device's networks…".into(),
        "discovery" => format!("Looking for machines on {nets} ({n}/{total})"),
        "ports" => format!("Checking ports on {found} machine(s)"),
        "identify" => format!("Recognising web pages ({n}/{total})"),
        "names" => "Looking up names…".into(),
        "self" => "Listing what the device itself listens on…".into(),
        "done" if s(st, "trigger") == "check" => "Done.".into(),
        "done" => format!("Done: {found} machine(s)."),
        other => other.to_string(),
    }
}

/// `lan show` 的內容。/ The lines of `lan show`.
fn lan_show_lines(h: &Value) -> Vec<String> {
    let mut out = vec![format!("{}  {}", s(h, "address"), [s(h, "label"), s(h, "hostname")].into_iter().find(|x| !x.is_empty()).unwrap_or(""))];
    if h["own"] == true {
        out.push("  this device: what the device itself listens on (reached at localhost on it)".into());
    }
    if h["gateway"] == true {
        out.push("  the device's default gateway".into());
    }
    if h["since_last"]["new"] == true {
        out.push("  new in the last scan".into());
    }
    let ports = port_changes(&h["since_last"]);
    if !ports.is_empty() {
        out.push(format!("  ports since the previous scan: {ports}"));
    }
    if h["missing"] == true {
        out.push(format!("  not seen in the last scan (last seen {})", s(h, "last_seen")));
    }
    if h["watched"] == true {
        out.push("  you watch it (told when a scan finds it gone, back or with other ports)".into());
    }
    let labels: Vec<&str> = h["labels"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if !labels.is_empty() {
        out.push(format!("  labels: {}", labels.join(", ")));
    }
    if !s(h, "notes").is_empty() {
        for (i, line) in s(h, "notes").lines().enumerate() {
            out.push(format!("  {}{line}", if i == 0 { "note: " } else { "      " }));
        }
    }
    let what = lan_what(h);
    if !what.is_empty() {
        let by = &h["identity"]["by"];
        out.push(format!("  is: {what}  (from {} {})", s(by, "source"), s(by, "text")).trim_end().to_string());
    }
    if !s(h, "vendor").is_empty() {
        out.push(format!("  vendor: {}", s(h, "vendor")));
    }
    for w in h["web"].as_array().into_iter().flatten() {
        out.push(format!("  web: {}", s(w, "url")));
    }
    for svc in h["services"].as_array().into_iter().flatten() {
        let mut parts = vec![format!("{}/{}", svc["port"], s(svc, "proto"))];
        if let Some(st) = svc["status"].as_u64() {
            parts.push(st.to_string());
        }
        for k in ["title", "server", "realm", "banner"] {
            if !s(svc, k).is_empty() {
                parts.push(format!("{k}: {}", s(svc, k)));
            }
        }
        if let Some(c) = svc.get("cert").filter(|c| c.is_object()) {
            let mut cert = format!("cert: {}", s(c, "subject"));
            if c["self_signed"].as_bool() == Some(true) {
                cert.push_str(" (self-signed)");
            }
            parts.push(cert);
        }
        out.push(format!("  {}", parts.join("  ")));
    }
    out
}

fn ipv4(s: &str) -> Option<u32> {
    s.trim().parse::<std::net::Ipv4Addr>().ok().map(u32::from)
}

/// 一塊 /24：起點、屬於網段的那一段、網路 / 廣播位址、標題、是不是從主機推出來的。/ One /24 block of the map.
struct MapBlock {
    base: u32,
    from: u32,
    to: u32,
    edges: Vec<u32>,
    label: String,
}

/// 跟網頁 `lib/ipMap.ts` 一樣切：掃描的網段（大的切成 /24、小的只畫它那段），沒有就用主機位址的 /24；最多 8 塊。
/// Cut like the web's `lib/ipMap.ts`: the scanned networks, else the hosts' /24s; at most 8 blocks.
fn map_blocks(networks: &[String], host_ips: &[u32]) -> Vec<MapBlock> {
    let mut out: Vec<MapBlock> = Vec::new();
    for c in networks {
        let Some((ip, prefix)) = c.split_once('/').and_then(|(ip, p)| Some((ipv4(ip)?, p.parse::<u32>().ok().filter(|p| *p <= 32)?))) else { continue };
        let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
        let net = ip & mask;
        let last = net | !mask;
        let edges: Vec<u32> = if prefix <= 30 { vec![net, last] } else { vec![] };
        let mut start = net;
        while start <= last && out.len() < 8 {
            let base = start & 0xffff_ff00;
            let end = last.min(base + 255);
            let label = if prefix >= 24 { c.clone() } else { format!("{}/24", std::net::Ipv4Addr::from(base)) };
            match out.iter_mut().find(|b| b.base == base) {
                Some(b) => {
                    b.from = b.from.min(start - base);
                    b.to = b.to.max(end - base);
                    b.edges.extend(edges.iter().filter(|e| **e >= base && **e <= base + 255));
                }
                None => out.push(MapBlock { base, from: start - base, to: end - base, edges: edges.iter().copied().filter(|e| *e >= base && *e <= base + 255).collect(), label }),
            }
            match base.checked_add(256) {
                Some(n) => start = n,
                None => break,
            }
        }
    }
    if out.is_empty() {
        for ip in host_ips {
            let base = ip & 0xffff_ff00;
            if out.len() < 8 && !out.iter().any(|b| b.base == base) {
                out.push(MapBlock { base, from: 0, to: 255, edges: vec![], label: format!("{}/24", std::net::Ipv4Addr::from(base)) });
            }
        }
    }
    out.sort_by_key(|b| b.base);
    out
}

/// `lan map` 的文字地圖：每塊 /24 一個標題加 16 列，每列 16 格（`#` 主機、`G` 閘道、`D` 裝置自己、`x` 這次沒看到、
/// `-` 網路 / 廣播位址、`.` 空著），最後一行圖例。`paint` 給顏色（測試裡不上色）。
/// The text map of `lan map`: per /24 a heading and 16 rows of 16 cells, then a legend. `paint` colours the marks.
fn lan_map_lines(networks: &[String], hosts: &[Value], device_ips: &[String], paint: &dyn Fn(char) -> String) -> Vec<String> {
    let host_at: Vec<(u32, &Value)> = hosts.iter().filter(|h| h["own"] != true && s(h, "source") != "self").filter_map(|h| Some((ipv4(s(h, "address"))?, h))).collect();
    let device: Vec<u32> = device_ips.iter().filter_map(|ip| ipv4(ip)).collect();
    let blocks = map_blocks(networks, &host_at.iter().map(|(ip, _)| *ip).collect::<Vec<_>>());
    let mut out = Vec::new();
    if blocks.is_empty() {
        out.push("No scanned network or LAN hosts yet.".to_string());
        return out;
    }
    for b in &blocks {
        let mut rows = Vec::new();
        let (mut used, mut free) = (0, 0);
        for row in 0..16u32 {
            let mut line = format!("{:>5} ", format!(".{}", row * 16));
            for col in 0..16u32 {
                let i = row * 16 + col;
                let ip = b.base + i;
                let mark = if i < b.from || i > b.to {
                    ' '
                } else if device.contains(&ip) {
                    'D'
                } else if let Some((_, h)) = host_at.iter().find(|(a, _)| *a == ip) {
                    used += 1;
                    if h["gateway"] == true {
                        'G'
                    } else if h["missing"] == true {
                        'x'
                    } else {
                        '#'
                    }
                } else if b.edges.contains(&ip) {
                    '-'
                } else {
                    free += 1;
                    '.'
                };
                line.push_str(&paint(mark));
                line.push(' ');
            }
            rows.push(line.trim_end().to_string());
        }
        out.push(format!("{}  {used} used, {free} free", b.label));
        out.extend(rows);
        out.push(String::new());
    }
    out.push("# host  G gateway  D this device  x not seen this time  - network / broadcast  . free".into());
    out
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
            if let Some(line) = lan_meta_line(&v["lan"], local_offset()) {
                eprintln!("{line}");
            }
            if let Some(line) = lan_schedule_line(&v["schedule"], local_offset()) {
                eprintln!("{line}");
            }
            print_hosts(&hosts);
        }
        LanAction::Scan { tunnel, subnets, ports, no_identify, account, json: as_json } => {
            let t = tunnel_of(&tunnel)?;
            let id = t["id"].as_i64().unwrap_or_default();
            let mut body = json!({ "identify": !no_identify });
            if !subnets.is_empty() {
                body["subnets"] = json!(subnets);
            }
            if !ports.is_empty() {
                body["ports"] = json!(ports);
            }
            if let Some(a) = &account {
                body["username"] = json!(a);
            }
            api.json(Method::POST, &format!("/api/reverse/server/{id}/lan/scan"), Some(&body))?;
            let st = wait_lan(api, id, as_json)?;
            if s(&st, "phase") == "failed" {
                bail!("The scan failed: {}", s(&st, "error"));
            }
            let v = api.get(&format!("/api/reverse/server/{id}/lan/hosts"))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            if as_json {
                return print_json(&json!({ "scan": st, "hosts": hosts, "lan": v["lan"] }));
            }
            print_hosts(&hosts);
            if let Some(line) = lan_changes_line(&st["changes"]) {
                eprintln!("{line}");
            }
        }
        LanAction::Check { tunnel, host, ports, json: as_json } => {
            let t = tunnel_of(&tunnel)?;
            let id = t["id"].as_i64().unwrap_or_default();
            let v = api.get(&format!("/api/reverse/server/{id}/lan/hosts"))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            let h = find_host(&hosts, &host).ok_or_else(|| anyhow!("No host '{host}' behind {}.", name_of(&t)))?;
            let hid = h["id"].as_i64().unwrap_or_default();
            let mut body = json!({});
            if !ports.is_empty() {
                body["ports"] = json!(ports);
            }
            api.json(Method::POST, &format!("/api/reverse/server/{id}/lan/hosts/{hid}/check"), Some(&body))?;
            let st = wait_lan(api, id, as_json)?;
            if s(&st, "phase") == "failed" {
                bail!("The check failed: {}", s(&st, "error"));
            }
            let v = api.get(&format!("/api/reverse/server/{id}/lan/hosts"))?;
            let now = v["hosts"].as_array().and_then(|a| a.iter().find(|x| x["id"].as_i64() == Some(hid)).cloned()).unwrap_or(Value::Null);
            if as_json {
                return print_json(&json!({ "scan": st, "host": now }));
            }
            let answered = st["hosts_found"].as_u64().unwrap_or(0) > 0;
            let ports = now["open_ports"].as_array().map(|p| p.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            if answered {
                println!("{} answered: ports {}.", s(&now, "address"), if ports.is_empty() { "-" } else { &ports });
            } else {
                println!("{} didn't answer on any of the ports tried.", s(h, "address"));
            }
            if let Some(line) = lan_changes_line(&st["changes"]).filter(|_| answered) {
                eprintln!("{line}");
            }
        }
        LanAction::Schedule { tunnel, every, subnets, ports, no_identify, account, json: as_json } => {
            let t = tunnel_of(&tunnel)?;
            let id = t["id"].as_i64().unwrap_or_default();
            let path = format!("/api/reverse/server/{id}/lan/schedule");
            let shown = match every.as_deref().map(parse_every).transpose()? {
                None => api.get(&path)?,
                Some(0) => {
                    api.json(Method::DELETE, &path, None)?;
                    eprintln!("Stopped the rescans of {}.", name_of(&t));
                    Value::Null
                }
                Some(secs) => {
                    let mut body = json!({ "every_secs": secs, "identify": !no_identify });
                    if !subnets.is_empty() {
                        body["subnets"] = json!(subnets);
                    }
                    if !ports.is_empty() {
                        body["ports"] = json!(ports);
                    }
                    if let Some(a) = &account {
                        body["username"] = json!(a);
                    }
                    api.json(Method::PUT, &path, Some(&body))?
                }
            };
            if as_json {
                return print_json(&shown);
            }
            match lan_schedule_line(&shown, local_offset()) {
                Some(line) => println!("{line}"),
                None if every.is_none() => println!("No scheduled rescan for {}. Set one with: telepy lan schedule {} --every 6h", name_of(&t), name_of(&t)),
                None => {}
            }
        }
        LanAction::Map { tunnel } => {
            let t = tunnel_of(&tunnel)?;
            let v = api.get(&format!("/api/reverse/server/{}/lan/hosts", t["id"]))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            let networks: Vec<String> = v["lan"]["networks"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
            let device: Vec<String> = t["endpoint"]["lan"].as_array().into_iter().flatten().filter_map(|a| a["ip"].as_str()).map(str::to_string).collect();
            let paint = |c: char| {
                let style = match c {
                    'G' => color::BOLD,
                    'D' => color::GOOD,
                    'x' => color::WARN,
                    '.' | '-' => color::DIM,
                    _ => color::PLAIN,
                };
                color::out(style, &c.to_string())
            };
            for line in lan_map_lines(&networks, &hosts, &device, &paint) {
                println!("{line}");
            }
        }
        LanAction::Wake { tunnel, host, account } => {
            let t = tunnel_of(&tunnel)?;
            let v = api.get(&format!("/api/reverse/server/{}/lan/hosts", t["id"]))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            let h = find_host(&hosts, &host).ok_or_else(|| anyhow!("No host '{host}' behind {}.", name_of(&t)))?;
            let mut body = json!({});
            if let Some(a) = &account {
                body["username"] = json!(a);
            }
            let r = api.json(Method::POST, &format!("/api/reverse/server/{}/lan/hosts/{}/wake", t["id"], h["id"]), Some(&body))?;
            let to = if s(&r, "broadcast").is_empty() { String::new() } else { format!(" to {}", s(&r, "broadcast")) };
            println!("Sent a wake-up packet for {} ({}){to} with {}.", s(h, "address"), s(&r, "mac"), s(&r, "tool"));
            eprintln!("It usually takes 10–60 s to start. Then: telepy lan check {} {}", name_of(&t), s(h, "address"));
        }
        LanAction::Edit { tunnel, host, label, user, port, labels, note } => {
            let t = tunnel_of(&tunnel)?;
            let v = api.get(&format!("/api/reverse/server/{}/lan/hosts", t["id"]))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            let h = find_host(&hosts, &host).ok_or_else(|| anyhow!("No host '{host}' behind {}.", name_of(&t)))?;
            let mut body = json!({});
            if let Some(x) = label {
                body["label"] = json!(x);
            }
            if let Some(x) = user {
                body["username"] = json!(x);
            }
            if let Some(x) = port {
                body["ssh_port"] = json!(x);
            }
            if let Some(x) = labels {
                body["labels"] = json!(x.split(',').map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>());
            }
            if let Some(x) = note {
                body["notes"] = json!(x);
            }
            if body.as_object().is_some_and(|o| o.is_empty()) {
                bail!("Nothing to change: give --label, --user, --port, --labels or --note.");
            }
            let r = api.json(Method::PATCH, &format!("/api/reverse/server/{}/lan/hosts/{}", t["id"], h["id"]), Some(&body))?;
            for line in lan_show_lines(&r) {
                println!("{line}");
            }
        }
        LanAction::Watch { tunnel, host, off } => {
            let t = tunnel_of(&tunnel)?;
            let v = api.get(&format!("/api/reverse/server/{}/lan/hosts", t["id"]))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            let h = find_host(&hosts, &host).ok_or_else(|| anyhow!("No host '{host}' behind {}.", name_of(&t)))?;
            let method = if off { Method::DELETE } else { Method::PUT };
            api.json(method, &format!("/api/reverse/server/{}/lan/hosts/{}/watch", t["id"], h["id"]), None)?;
            if off {
                eprintln!("No longer watching {}.", s(h, "address"));
            } else {
                eprintln!("Watching {}: you'll be told when a scan finds it gone, back or with other ports.", s(h, "address"));
            }
        }
        LanAction::Show { tunnel, host, json: as_json } => {
            let t = tunnel_of(&tunnel)?;
            let v = api.get(&format!("/api/reverse/server/{}/lan/hosts", t["id"]))?;
            let hosts = v["hosts"].as_array().cloned().unwrap_or_default();
            let h = find_host(&hosts, &host).ok_or_else(|| anyhow!("No host '{host}' behind {}.", name_of(&t)))?;
            if as_json {
                return print_json(h);
            }
            for line in lan_show_lines(h) {
                println!("{line}");
            }
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
            print_table(activity::TOKEN_HEADERS, &rows, |col, text| match (activity::TOKEN_HEADERS[col], text) {
                ("STATE", "active") => color::GOOD,
                ("STATE", _) => color::DIM,
                ("ERRORS 7D", n) if n != "0" => color::WARN,
                _ => color::PLAIN,
            });
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
        let headers = activity::headers(show_user);
        print_table(&headers, &cells, |col, text| if headers[col] == "STATUS" { color::status_code(text) } else { color::PLAIN });
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
    fn lan_map_draws_the_addresses() {
        let hosts = vec![
            json!({"address": "192.168.1.1", "gateway": true}),
            json!({"address": "192.168.1.20"}),
            json!({"address": "192.168.1.30", "missing": true}),
            json!({"address": "localhost", "own": true, "source": "self"}),
        ];
        let plain = |c: char| c.to_string();
        let lines = lan_map_lines(&["192.168.1.0/24".to_string()], &hosts, &["192.168.1.10".to_string()], &plain);
        assert_eq!(lines[0], "192.168.1.0/24  3 used, 250 free");
        assert_eq!(lines[1], "   .0 - G . . . . . . . . D . . . . .");
        assert_eq!(lines[2], "  .16 . . . . # . . . . . . . . . x .", "20 is a host, 30 was not seen this time");
        assert_eq!(lines[16], " .240 . . . . . . . . . . . . . . . -");
        assert!(lines.last().unwrap().starts_with("# host  G gateway"));
        // 比 /24 小的網段只畫它那一段。/ A network smaller than a /24 draws only its part.
        let part = lan_map_lines(&["192.168.1.64/27".to_string()], &[], &[], &plain);
        assert_eq!(part[0], "192.168.1.64/27  0 used, 30 free");
        assert_eq!(part[1], "   .0");
        assert_eq!(part[5], "  .64 - . . . . . . . . . . . . . . .");
        // 沒有掃描紀錄：主機所在的 /24。/ No scan record: the hosts' /24.
        let derived = lan_map_lines(&[], &hosts, &[], &plain);
        assert!(derived[0].starts_with("192.168.1.0/24  3 used"), "{derived:?}");
        assert_eq!(lan_map_lines(&[], &[], &[], &plain), vec!["No scanned network or LAN hosts yet.".to_string()]);
    }

    #[test]
    fn lan_labels_and_notes() {
        assert_eq!(lan_note(&json!({"labels": ["prod", "rack-2"], "since_last": null})), "#prod, #rack-2");
        let lines = lan_show_lines(&json!({"address": "10.0.0.5", "labels": ["prod"], "notes": "rack 2\nUPS left", "services": [], "web": []}));
        assert!(lines.contains(&"  labels: prod".to_string()), "{lines:?}");
        assert!(lines.contains(&"  note: rack 2".to_string()) && lines.contains(&"        UPS left".to_string()), "{lines:?}");
    }

    #[test]
    fn lan_schedule_words() {
        assert_eq!(parse_every("6h").unwrap(), 21_600);
        assert_eq!(parse_every("1W").unwrap(), 604_800);
        assert_eq!(parse_every("off").unwrap(), 0);
        assert!(parse_every("90m").is_err());
        let off = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let sched = json!({"every_secs": 21600, "next_at": "2026-11-03T10:00:00+00:00", "by": "alice", "last_error": null});
        assert_eq!(lan_schedule_line(&sched, off).unwrap(), "Rescans every 6 hours, next 2026-11-03 18:00 (set by alice).");
        assert_eq!(lan_schedule_line(&Value::Null, off), None);
        assert_eq!(lan_note(&json!({"watched": true, "since_last": null})), "watched");
    }

    #[test]
    fn lan_notes_changes_and_the_scan_line() {
        let h = json!({"own": false, "gateway": true, "missing": false, "since_last": {"new": false, "opened": [443], "closed": [80]}});
        assert_eq!(lan_note(&h), "gateway, +443 -80");
        assert_eq!(lan_note(&json!({"own": true, "since_last": null})), "this device");
        assert_eq!(lan_note(&json!({"missing": true, "since_last": null})), "not seen");
        assert_eq!(lan_note(&json!({"since_last": {"new": true, "opened": [], "closed": []}})), "new");
        assert_eq!(lan_changes_line(&Value::Null), None);
        assert_eq!(lan_changes_line(&json!({"new": [], "gone": [], "changed": []})).unwrap(), "Nothing changed since the previous scan.");
        let c = json!({"new": ["10.0.0.9"], "gone": ["10.0.0.3"], "changed": [{"address": "10.0.0.2", "opened": [443], "closed": [80]}]});
        assert_eq!(lan_changes_line(&c).unwrap(), "Since the previous scan: 1 new (10.0.0.9); 1 not seen (10.0.0.3); ports changed on 1 (10.0.0.2 +443 -80).");
        let many: Vec<String> = (1..=10).map(|i| format!("10.0.0.{i}")).collect();
        assert!(lan_changes_line(&json!({"new": many, "gone": [], "changed": []})).unwrap().contains("10.0.0.8 +2 more"));
        let off = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let lan = json!({"networks": ["192.168.1.0/24"], "gateway": "192.168.1.1", "scanned_at": "2026-11-03T06:05:00+00:00"});
        assert_eq!(lan_meta_line(&lan, off).unwrap(), "Last scan 2026-11-03 14:05 of 192.168.1.0/24, gateway 192.168.1.1.");
        assert_eq!(lan_meta_line(&Value::Null, off), None);
    }

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
