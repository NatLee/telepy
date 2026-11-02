//! 內建的 SSH client：`telepy-carrier tunnel` 自己跟 Telepy 的 gateway 講 SSH、要反向 forward，再把 gateway 開過來的
//! 每條 forwarded-tcpip 通道接到裝置的 sshd。給沒有可用 ssh 的裝置用：原廠 OpenWrt 的 dbclient 連不上 gateway（Dropbear
//! 的 kex 猜測 vs russh 的 strict kex）、有些 build 一設 ServerAliveInterval 就逾時、dbclient 讀不了 OpenSSH 格式的金鑰、
//! 有的機器只有 sshd。連線方式跟 ProxyCommand 模式一模一樣（SSH 的 port 先，不通走網頁 port 的 WebSocket，HTTP CONNECT
//! 代理），只是 SSH 由這裡自己講。
//!
//! 安全上跟 `ssh -R` 一樣：gateway 的 host key 一定要給（`--host-key` / `--known-hosts`），對不上就不連（fail closed）；
//! 只用金鑰登入；只要求一個 forward、只接 gateway 開過來的 forwarded-tcpip，一律轉到 `--forward` 的目標。斷線就結束
//! （回非 0），由服務管理器（systemd / procd / launchd / 迴圈）重新啟動，這裡不自己重連。
//!
//! The built-in SSH client: `telepy-carrier tunnel` speaks SSH to Telepy's gateway itself, asks for the reverse
//! forward and pipes every forwarded-tcpip channel the gateway opens to the device's sshd. For devices without a usable
//! ssh: stock OpenWrt's dbclient cannot connect to the gateway (Dropbear's kex guess vs russh's strict kex), some builds
//! time out as soon as ServerAliveInterval is set, dbclient cannot read OpenSSH keys, and some boxes only ship an sshd.
//! The connection is the same as in ProxyCommand mode (the SSH port first, the web port's WebSocket when that is
//! blocked, HTTP CONNECT proxies); only the SSH is spoken here.
//!
//! As strict as `ssh -R`: the gateway's host keys are mandatory and a mismatch refuses the connection; public-key
//! authentication only; one forward, and only forwarded-tcpip channels, all to the `--forward` target. A lost
//! connection ends the process (non-zero) and the service manager restarts it; there is no inner reconnect loop.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context as _, Result};
use russh::client::{self, ChannelOpenHandle, Handler, Msg, Session};
use russh::keys::ssh_key::{self, LineEnding};
use russh::keys::{Algorithm, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{Channel, Disconnect, Preferred};
use tokio::net::TcpStream;

use crate::{connect_link, proxy_choice, split_host_port, wait_ssh_port_back, ws_endpoint, Link, VERSION};

/// 結束碼。/ Exit codes.
pub const EXIT_OK: i32 = 0;
/// 握手、登入、forward 失敗，或連線斷了（服務管理器會重啟）。/ Handshake, login or forward failed, or the link dropped.
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
/// gateway 的 host key 不是給的那幾把。/ The gateway's host key is not one of those given.
pub const EXIT_HOST_KEY: i32 = 3;
/// SSH 的 port 與網頁 port 都連不上。/ Neither the SSH port nor the web port could be reached.
pub const EXIT_UNREACHABLE: i32 = 4;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const TARGET_TIMEOUT: Duration = Duration::from_secs(10);

/// `--forward [<遠端 port>:]<host>:<port>`：gateway 那邊要的號碼（0 = 由 gateway 依金鑰指定）與裝置這邊的目標。
/// `--forward [<remote port>:]<host>:<port>`: the number asked for (0 = the gateway assigns it from the key) and the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Forward {
    pub remote: u32,
    pub host: String,
    pub port: u16,
}

impl Default for Forward {
    fn default() -> Self {
        Forward { remote: 0, host: "127.0.0.1".into(), port: 22 }
    }
}

/// `0:127.0.0.1:22`、`127.0.0.1:22`、`0:[::1]:22`、`192.168.1.1:22`。/ Parse a forward spec.
pub fn parse_forward(s: &str) -> Option<Forward> {
    let (rest, port) = s.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let (remote, host) = if let Some(inner) = rest.strip_suffix(']') {
        let open = inner.rfind('[')?;
        let host = &inner[open + 1..];
        let before = &inner[..open];
        let remote = if before.is_empty() { 0 } else { before.strip_suffix(':')?.parse().ok()? };
        (remote, host)
    } else {
        match rest.rsplit_once(':') {
            Some((r, h)) => (r.parse().ok()?, h),
            None => (0, rest),
        }
    };
    let ok = !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-_:".contains(&b));
    ok.then(|| Forward { remote, host: host.to_string(), port })
}

/// `telepy-carrier tunnel …` 的參數。/ The arguments of `telepy-carrier tunnel`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelArgs {
    pub identity: Option<PathBuf>,
    /// gateway 的 SSH port（`host:port`）。/ The gateway's SSH port.
    pub server: Option<String>,
    /// `/ws/gateway/` 的網址。/ The web port's WebSocket URL.
    pub ws: Option<String>,
    pub proxy: Option<String>,
    pub no_proxy: bool,
    pub host_keys: Vec<String>,
    pub known_hosts: Vec<PathBuf>,
    pub forward: Forward,
    /// 秒；0 = 不送 SSH keepalive。/ Seconds; 0 = no SSH keepalive.
    pub keepalive: u64,
    pub user: String,
    pub probe: bool,
    pub help: bool,
}

impl Default for TunnelArgs {
    fn default() -> Self {
        TunnelArgs {
            identity: None,
            server: None,
            ws: None,
            proxy: None,
            no_proxy: false,
            host_keys: Vec::new(),
            known_hosts: Vec::new(),
            forward: Forward::default(),
            keepalive: 30,
            user: "telepy".into(),
            probe: false,
            help: false,
        }
    }
}

pub const TUNNEL_USAGE: &str = "telepy-carrier tunnel: run a device's reverse tunnel to Telepy with the built-in SSH client\n\n\
usage: telepy-carrier tunnel --identity KEY (--host-key 'TYPE BASE64' | --known-hosts FILE)\n\
                             [--server HOST:PORT] [--ws wss://HOST/ws/gateway/] [--forward [0:]HOST:PORT]\n\
                             [--proxy http://[user:pass@]host:port | --no-proxy] [--keepalive SECS] [--user telepy]\n\
       telepy-carrier tunnel --probe [--host-key … | --known-hosts …] [--server …] [--ws …]\n\
       telepy-carrier keygen [-C COMMENT] FILE\n\n\
  --identity KEY      the tunnel's private key (OpenSSH format, no passphrase; `telepy-carrier keygen` makes one)\n\
  --host-key LINE     a host key of Telepy's gateway (repeatable); a different key refuses the connection\n\
  --known-hosts FILE  read the gateway's host keys from this file (every key in it is trusted; the host names are ignored)\n\
  --server HOST:PORT  Telepy's SSH port; with --ws too it is tried first (success = its SSH banner)\n\
  --ws URL            Telepy's web port (/ws/gateway/), used when the SSH port is blocked or not given;\n\
                      a working web port is remembered for 30 minutes, then the SSH port is tried first again;\n\
                      on the web port the SSH port is tried again for about 10 minutes, and once it answers the\n\
                      tunnel ends (exit 1) so the service restarts it there\n\
  --forward SPEC      where forwarded connections go on this machine (default 0:127.0.0.1:22; 0 = Telepy assigns\n\
                      this tunnel's own port from the key)\n\
  --proxy URL         go through this HTTP proxy (CONNECT); without it HTTPS_PROXY / ALL_PROXY and NO_PROXY apply\n\
  --no-proxy          ignore the proxy variables\n\
  --keepalive SECS    an SSH keepalive after SECS without traffic, the connection ends after 3 unanswered (default 30;\n\
                      0 = off)\n\
  --user NAME         the gateway login (default telepy)\n\
  --probe             only check the way to the gateway: full key exchange, no key offered; prints PROBE=ok|hostkey|\n\
                      unreachable|closed, the gateway's HOST_KEY and FINGERPRINT, and WAY=ssh|web\n\n\
It exits when the connection ends (1; 3 = wrong host key, 4 = nothing reachable) and is meant to be restarted by a\n\
service manager; SIGTERM ends it cleanly (0). No shell, no agent forwarding, no ~/.ssh/config: one forward only.\n";

fn valid_user(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// 解析 `tunnel` 之後的參數（`--x value` 與 `--x=value` 都可以）。/ Parse the arguments after `tunnel`.
pub fn parse_tunnel_args<I: IntoIterator<Item = String>>(args: I) -> Result<TunnelArgs, String> {
    let mut t = TunnelArgs::default();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
            _ => (a.clone(), None),
        };
        let mut value = |what: &str| -> Result<String, String> {
            match &inline {
                Some(v) => Ok(v.clone()),
                None => it.next().ok_or_else(|| format!("{name} wants {what}")),
            }
        };
        match name.as_str() {
            "--identity" | "-i" => t.identity = Some(PathBuf::from(value("a key file")?)),
            "--server" | "--tcp" => t.server = Some(value("host:port")?),
            "--ws" => t.ws = Some(value("a ws:// or wss:// URL")?),
            "--proxy" => t.proxy = Some(value("a URL")?),
            "--host-key" => t.host_keys.push(value("a key line")?),
            "--known-hosts" => t.known_hosts.push(PathBuf::from(value("a file")?)),
            "--forward" => {
                let v = value("[0:]host:port")?;
                t.forward = parse_forward(&v).ok_or_else(|| format!("--forward wants [<remote port>:]<host>:<port>, got {v:?}"))?;
            }
            "--keepalive" => {
                let v = value("seconds")?;
                t.keepalive = v.parse().ok().filter(|s| *s <= 3600).ok_or_else(|| format!("--keepalive wants 0..3600 seconds, got {v:?}"))?;
            }
            "--user" => {
                let v = value("a name")?;
                if !valid_user(&v) {
                    return Err(format!("--user: not a valid login name: {v:?}"));
                }
                t.user = v;
            }
            "--no-proxy" if inline.is_none() => t.no_proxy = true,
            "--probe" if inline.is_none() => t.probe = true,
            "--help" | "-h" => t.help = true,
            other => return Err(format!("unknown option {other} (see telepy-carrier tunnel --help)")),
        }
    }
    if t.help {
        return Ok(t);
    }
    if t.server.is_none() && t.ws.is_none() {
        return Err("give Telepy's SSH port (--server host:port), its web port (--ws URL), or both".into());
    }
    if let Some(s) = &t.server {
        if split_host_port(s).is_none() {
            return Err(format!("--server wants host:port, got {s:?}"));
        }
    }
    if let Some(u) = &t.ws {
        ws_endpoint(u).map_err(|e| format!("--ws: {e:#}"))?;
    }
    if !t.probe {
        if t.identity.is_none() {
            return Err("--identity is required (the tunnel's private key)".into());
        }
        if t.host_keys.is_empty() && t.known_hosts.is_empty() {
            return Err("the gateway's host key is required (--host-key or --known-hosts): the built-in client never connects without checking it".into());
        }
    }
    Ok(t)
}

fn is_key_type(t: &str) -> bool {
    t.starts_with("ssh-") || t.starts_with("ecdsa-sha2-") || t.starts_with("sk-")
}

/// known_hosts 形式（`[host] type base64 [comment]`）或單純 `type base64` 的每一行裡的公鑰；主機名稱不看（這個檔只屬於
/// 這條隧道），`#` 與 `@cert-authority` / `@revoked` 那種行略過。/ The public keys in known_hosts-style or bare
/// `type base64` lines; host names are ignored (the file belongs to this tunnel), comments and markers skipped.
pub fn parse_host_keys(text: &str) -> Vec<PublicKey> {
    let mut out: Vec<PublicKey> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
            continue;
        }
        let words: Vec<&str> = line.split_whitespace().collect();
        let Some(i) = words.iter().position(|w| is_key_type(w)) else { continue };
        let Some(b64) = words.get(i + 1) else { continue };
        if let Ok(k) = PublicKey::from_openssh(&format!("{} {b64}", words[i])) {
            if !out.iter().any(|o| o.key_data() == k.key_data()) {
                out.push(k);
            }
        }
    }
    out
}

/// `--host-key` 與 `--known-hosts` 給的所有金鑰。/ Every key from `--host-key` and `--known-hosts`.
pub fn host_keys(args: &TunnelArgs) -> Result<Vec<PublicKey>, String> {
    let mut text = String::new();
    for line in &args.host_keys {
        if parse_host_keys(line).is_empty() {
            return Err(format!("--host-key: not a public key line: {line:?}"));
        }
        text.push_str(line);
        text.push('\n');
    }
    for path in &args.known_hosts {
        let t = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if parse_host_keys(&t).is_empty() {
            return Err(format!("{} has no host key in it", path.display()));
        }
        text.push_str(&t);
        text.push('\n');
    }
    Ok(parse_host_keys(&text))
}

/// `type base64`（不帶註解）。/ `type base64`, no comment.
pub fn key_line(k: &PublicKey) -> String {
    let full = k.to_openssh().unwrap_or_default();
    full.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
}

pub fn fingerprint(k: &PublicKey) -> String {
    k.fingerprint(HashAlg::Sha256).to_string()
}

/// 讀私鑰：OpenSSH 格式、不能有 passphrase（服務沒有人能輸入）。/ Read the private key: OpenSSH format, no passphrase.
pub fn load_identity(path: &Path) -> Result<PrivateKey> {
    let text = std::fs::read_to_string(path).with_context(|| format!("cannot read the key {}", path.display()))?;
    if let Ok(k) = PrivateKey::from_openssh(text.trim()) {
        if k.is_encrypted() {
            bail!("{} is protected by a passphrase; a service cannot type it (`telepy-carrier keygen` makes a key without one)", path.display());
        }
        return Ok(k);
    }
    match russh::keys::decode_secret_key(&text, None) {
        Ok(k) => Ok(k),
        Err(russh::keys::Error::KeyIsEncrypted) => bail!("{} is protected by a passphrase; a service cannot type it (`telepy-carrier keygen` makes a key without one)", path.display()),
        Err(e) => bail!("cannot read the key {}: {e} (an OpenSSH-format private key is needed; Dropbear-format keys are not read)", path.display()),
    }
}

/// 新的 ed25519 金鑰（OpenSSH 格式，0600），旁邊寫 `.pub`；已經有檔案就不動它。回公鑰那一行。
/// A new ed25519 key (OpenSSH format, 0600) with `<file>.pub` next to it; never overwrites. Returns the public line.
pub fn keygen(path: &Path, comment: &str) -> Result<String> {
    use ring::rand::SecureRandom;
    let pub_path = PathBuf::from(format!("{}.pub", path.display()));
    if path.exists() {
        bail!("{} exists already; not overwriting it", path.display());
    }
    let mut seed = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut seed).map_err(|_| anyhow!("the system gave no randomness"))?;
    let pair = ssh_key::private::Ed25519Keypair::from_seed(&seed);
    let key = PrivateKey::new(ssh_key::private::KeypairData::Ed25519(pair), comment).map_err(|e| anyhow!("making the key: {e}"))?;
    let pem = key.to_openssh(LineEnding::LF).map_err(|e| anyhow!("writing the key: {e}"))?;
    let public = key.public_key().to_openssh().map_err(|e| anyhow!("writing the public key: {e}"))?;
    write_new(path, pem.as_bytes(), 0o600)?;
    std::fs::write(&pub_path, format!("{public}\n")).with_context(|| format!("cannot write {}", pub_path.display()))?;
    Ok(public)
}

fn write_new(path: &Path, data: &[u8], mode: u32) -> Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut f = o.open(path).with_context(|| format!("cannot create {}", path.display()))?;
    f.write_all(data).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(())
}

// ------------------------------------------------------------------ the SSH session

struct Client {
    known: Arc<Vec<PublicKey>>,
    /// false = `--probe` 沒給金鑰：只報告看到哪把。/ false = a probe without keys: only report what was seen.
    strict: bool,
    seen: Arc<Mutex<Option<PublicKey>>>,
    target: Arc<Forward>,
}

impl Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        // 憑證不收：只認給的那幾把金鑰。/ Certificates are not accepted: only the keys given.
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else { return Ok(false) };
        *self.seen.lock().unwrap() = Some(key.clone());
        Ok(!self.strict || self.known.iter().any(|k| k.key_data() == key.key_data()))
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        tokio::spawn(serve_channel(channel, self.target.clone()));
        Ok(())
    }
}

/// 一條 gateway 開過來的連線 → 裝置的 sshd（或 `--forward` 的目標）；任一邊結束就關另一邊。
/// One connection from the gateway → the device's sshd (the `--forward` target); either side ending closes the other.
async fn serve_channel(channel: Channel<Msg>, target: Arc<Forward>) {
    match tokio::time::timeout(TARGET_TIMEOUT, TcpStream::connect((target.host.as_str(), target.port))).await {
        Ok(Ok(mut tcp)) => {
            let _ = tcp.set_nodelay(true);
            // ChannelStream 被丟掉時會送 close。/ A ChannelStream sends the close when dropped.
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
        }
        other => {
            let why = match other {
                Ok(Err(e)) => e.to_string(),
                _ => "timed out".to_string(),
            };
            eprintln!("telepy-carrier: cannot reach {}:{} for a connection from Telepy: {why}", target.host, target.port);
            let _ = channel.close().await;
        }
    }
}

/// 只談給的金鑰種類，伺服器才會拿出我們認得的那把。/ Offer only the kinds of the keys given, so the server shows one we know.
fn config(keepalive: u64, known: &[PublicKey], strict: bool) -> Result<Arc<client::Config>> {
    let mut preferred = Preferred::default();
    if strict {
        let kinds: Vec<Algorithm> = Preferred::DEFAULT
            .key
            .iter()
            .filter(|a| known.iter().any(|k| same_kind(&k.algorithm(), a)))
            .cloned()
            .collect();
        if kinds.is_empty() {
            bail!("none of the gateway host keys given is of a kind this client checks (ed25519 or ecdsa)");
        }
        preferred.key = Cow::Owned(kinds);
    }
    let version: String = VERSION.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '.' }).collect();
    Ok(Arc::new(client::Config {
        client_id: russh::SshId::Standard(Cow::Owned(format!("SSH-2.0-TelepyCarrier_{version}"))),
        keepalive_interval: (keepalive > 0).then(|| Duration::from_secs(keepalive)),
        keepalive_max: 3,
        inactivity_timeout: None,
        nodelay: true,
        preferred,
        ..Default::default()
    }))
}

fn same_kind(key: &Algorithm, offered: &Algorithm) -> bool {
    match (key, offered) {
        (Algorithm::Rsa { .. }, Algorithm::Rsa { .. }) => true,
        (a, b) => a == b,
    }
}

/// 一個失敗：結束碼與一句話（`--probe` 另外印 `PROBE=`）。/ A failure: exit code, message, and the probe's word.
struct Fail {
    code: i32,
    probe: &'static str,
    message: String,
}

fn fail(code: i32, probe: &'static str, message: impl Into<String>) -> Fail {
    Fail { code, probe, message: message.into() }
}

fn way_word(way: &str) -> &'static str {
    if way == "ssh port" {
        "ssh"
    } else {
        "web"
    }
}

fn print_probe(result: &str, seen: Option<&PublicKey>, way: Option<&str>) {
    println!("PROBE={result}");
    if let Some(k) = seen {
        println!("HOST_KEY={}", key_line(k));
        println!("FINGERPRINT={}", fingerprint(k));
    }
    if let Some(w) = way {
        println!("WAY={}", way_word(w));
    }
}

/// 跑隧道（或 `--probe`），回結束碼。/ Run the tunnel (or the probe); returns the exit code.
pub async fn run(args: &TunnelArgs, note: &dyn Fn(&str)) -> i32 {
    let seen: Arc<Mutex<Option<PublicKey>>> = Arc::new(Mutex::new(None));
    let mut way: Option<&'static str> = None;
    let result = session(args, note, &seen, &mut way).await;
    let seen = seen.lock().unwrap().clone();
    match result {
        Ok(code) => code,
        Err(f) => {
            if args.probe {
                print_probe(f.probe, seen.as_ref(), way);
            }
            note(&f.message);
            f.code
        }
    }
}

async fn session(args: &TunnelArgs, note: &dyn Fn(&str), seen: &Arc<Mutex<Option<PublicKey>>>, way_out: &mut Option<&'static str>) -> Result<i32, Fail> {
    let known = host_keys(args).map_err(|e| fail(EXIT_USAGE, "other", e))?;
    if !args.probe && known.is_empty() {
        return Err(fail(EXIT_USAGE, "other", "no gateway host key given (--host-key or --known-hosts): refusing to connect without one"));
    }
    let strict = !known.is_empty();
    let key = match (&args.identity, args.probe) {
        (Some(p), false) => Some(Arc::new(load_identity(p).map_err(|e| fail(EXIT_FAILED, "other", format!("{e:#}")))?)),
        _ => None,
    };
    let route_host = match (&args.server, &args.ws) {
        (_, Some(u)) => ws_endpoint(u).map(|(h, _, _)| h).unwrap_or_default(),
        (Some(s), None) => split_host_port(s).map(|(h, _)| h).unwrap_or_default(),
        (None, None) => String::new(),
    };
    let proxy = proxy_choice(args.no_proxy, args.proxy.as_deref(), &route_host).map_err(|e| fail(EXIT_USAGE, "other", e))?;
    let cfg = config(args.keepalive, &known, strict).map_err(|e| fail(EXIT_USAGE, "other", format!("{e:#}")))?;

    // 1. 跟 ProxyCommand 模式同一套：SSH 的 port 先，不通走網頁 port。/ The same way in as the ProxyCommand mode.
    let link = connect_link(args.server.as_deref(), args.ws.as_deref(), proxy.as_ref(), note)
        .await
        .map_err(|e| fail(EXIT_UNREACHABLE, "unreachable", format!("cannot connect: {e:#}")))?;
    let way = link.way();
    *way_out = Some(way);
    // 自動模式走了網頁 port：之後 SSH 的 port 回來就換過去。/ Automatic on the web port: move once the SSH port is back.
    let on_web = matches!(link, Link::Web(_));

    // 2. SSH 握手，host key 一定要對。/ The SSH handshake; the host key must match.
    let handler = Client { known: Arc::new(known.clone()), strict, seen: seen.clone(), target: Arc::new(args.forward.clone()) };
    let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, client::connect_stream(cfg, link.into_io(), handler)).await;
    let mut handle = match handshake {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            let presented = seen.lock().unwrap().clone();
            if let Some(k) = presented.filter(|k| strict && !known.iter().any(|o| o.key_data() == k.key_data())) {
                let given: Vec<String> = known.iter().map(fingerprint).collect();
                return Err(fail(
                    EXIT_HOST_KEY,
                    "hostkey",
                    format!("REFUSED: the gateway presented the host key {} ({}), which is not one of the keys given ({}); not connecting", fingerprint(&k), k.algorithm(), given.join(", ")),
                ));
            }
            return Err(fail(EXIT_FAILED, "closed", format!("the SSH handshake with Telepy over the {way} failed: {e}")));
        }
        Err(_) => return Err(fail(EXIT_FAILED, "timeout", format!("the SSH handshake with Telepy over the {way} did not finish in {} s", HANDSHAKE_TIMEOUT.as_secs()))),
    };

    // --probe：握手完成就夠了；不給金鑰（none 認證會被拒，這正是預期的）。/ A probe stops after the handshake.
    if args.probe {
        let _ = tokio::time::timeout(Duration::from_secs(10), handle.authenticate_none(&args.user)).await;
        let presented = seen.lock().unwrap().clone();
        print_probe("ok", presented.as_ref(), Some(way));
        let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        return Ok(EXIT_OK);
    }

    // 3. 金鑰登入。/ Public-key login.
    let key = key.expect("checked above");
    let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
    match handle.authenticate_publickey(&args.user, PrivateKeyWithHashAlg::new(key.clone(), hash)).await {
        Ok(r) if r.success() => {}
        Ok(_) => {
            let fp = fingerprint(key.public_key());
            return Err(fail(EXIT_FAILED, "other", format!("Telepy refused the key {fp} for {}: is this device's tunnel registered with this key?", args.user)));
        }
        Err(e) => return Err(fail(EXIT_FAILED, "other", format!("logging in to Telepy failed: {e}"))),
    }

    // 4. 反向 forward（0 = gateway 依金鑰給這條隧道自己的號碼）。/ The reverse forward (0 = the tunnel's own number).
    let asked = args.forward.remote;
    let port = match handle.tcpip_forward("localhost", asked).await {
        Ok(p) if asked == 0 => p,
        Ok(_) => asked,
        Err(e) => return Err(fail(EXIT_FAILED, "other", format!("Telepy refused the remote forward ({e}); another connection of this tunnel may hold it"))),
    };
    let target = &args.forward;
    note(&format!("tunnel up over the {way}: Telepy's port {port} forwards to {}:{}", target.host, target.port));

    // 5. 等：連線斷了 = 1（服務管理器重啟）；SIGTERM / Ctrl-C = 乾淨地結束（0）。
    // Wait: a lost connection = 1 (the service manager restarts it); SIGTERM / Ctrl-C = a clean end (0).
    // SSH 的 port 回來（只在自動模式走網頁 port 時）= 好好斷線、回 1，服務管理器重啟後走 SSH 的 port。
    // The SSH port back (automatic on the web port only) = a clean disconnect and 1; the restart takes the SSH port.
    enum End {
        Lost(String),
        Stop,
        SshPortBack,
    }
    let back = async {
        if on_web {
            wait_ssh_port_back(args.server.as_deref(), args.ws.as_deref(), proxy.as_ref(), note).await
        } else {
            std::future::pending().await
        }
    };
    let end = tokio::select! {
        r = &mut handle => End::Lost(match r { Ok(()) => String::new(), Err(e) => format!(": {e}") }),
        _ = shutdown_signal() => End::Stop,
        _ = back => End::SshPortBack,
    };
    let leave = |why: &'static str| {
        let handle = &handle;
        async move {
            let _ = tokio::time::timeout(Duration::from_secs(3), handle.cancel_tcpip_forward("localhost", port)).await;
            let _ = tokio::time::timeout(Duration::from_secs(3), handle.disconnect(Disconnect::ByApplication, why, "en")).await;
        }
    };
    match end {
        End::Lost(why) => Err(fail(EXIT_FAILED, "other", format!("the connection to Telepy ended{why}"))),
        End::Stop => {
            leave("stopped").await;
            note("stopped");
            Ok(EXIT_OK)
        }
        End::SshPortBack => {
            leave("moving to the SSH port").await;
            Ok(EXIT_FAILED)
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) {
            (Ok(mut term), Ok(mut int)) => {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = int.recv() => {}
                }
            }
            _ => std::future::pending::<()>().await,
        }
    }
    #[cfg(not(unix))]
    {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// `telepy-carrier keygen [-C comment] <file>` 或 `keygen -y <file>`（印出既有私鑰的公鑰，像 `ssh-keygen -y`）。
/// `telepy-carrier keygen [-C comment] <file>`, or `keygen -y <file>` (print an existing key's public line, like
/// `ssh-keygen -y`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeygenArgs {
    pub file: PathBuf,
    pub comment: String,
    /// `-y`：只讀，不產生。/ `-y`: read only, never create.
    pub public_only: bool,
}

pub const KEYGEN_USAGE: &str = "usage: telepy-carrier keygen [-C COMMENT] FILE   (a new ed25519 key, OpenSSH format, 0600, and FILE.pub)\n       telepy-carrier keygen -y FILE              (print the public key of an existing private key)";

pub fn parse_keygen_args<I: IntoIterator<Item = String>>(args: I) -> Result<KeygenArgs, String> {
    let mut comment = "telepy-tunnel".to_string();
    let mut file = None;
    let mut public_only = false;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-C" | "--comment" => comment = it.next().ok_or("-C wants a comment")?,
            "-y" => public_only = true,
            "-h" | "--help" => return Err(KEYGEN_USAGE.into()),
            s if s.starts_with('-') => return Err(format!("unknown option {s}\n{KEYGEN_USAGE}")),
            _ if file.is_some() => return Err("only one file".into()),
            _ => file = Some(PathBuf::from(a)),
        }
    }
    if comment.chars().any(|c| c.is_control()) {
        return Err("the comment must be one line".into());
    }
    file.map(|file| KeygenArgs { file, comment, public_only }).ok_or_else(|| KEYGEN_USAGE.into())
}

/// 既有私鑰的公鑰那一行（帶私鑰裡的註解）。/ The public line of an existing private key (with its comment).
pub fn public_line(path: &Path) -> Result<String> {
    let key = load_identity(path)?;
    // 公鑰帶著私鑰裡的註解。/ The public key carries the private key's comment.
    key.public_key().to_openssh().map_err(|e| anyhow!("writing the public key: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Result<TunnelArgs, String> {
        parse_tunnel_args(v.iter().map(|s| s.to_string()))
    }

    const ED: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    #[test]
    fn forwards_parse_like_ssh_r() {
        assert_eq!(parse_forward("0:127.0.0.1:22"), Some(Forward { remote: 0, host: "127.0.0.1".into(), port: 22 }));
        assert_eq!(parse_forward("192.168.1.1:2222"), Some(Forward { remote: 0, host: "192.168.1.1".into(), port: 2222 }));
        assert_eq!(parse_forward("40001:localhost:22").unwrap().remote, 40001);
        assert_eq!(parse_forward("0:[::1]:22"), Some(Forward { remote: 0, host: "::1".into(), port: 22 }));
        assert_eq!(parse_forward("[::1]:22").unwrap().host, "::1");
        for bad in ["", "22", "0:host", "x:h:22", "0::22", "0:h;rm:22", "0:h:99999"] {
            assert_eq!(parse_forward(bad), None, "{bad}");
        }
    }

    #[test]
    fn tunnel_arguments_need_a_key_a_host_key_and_a_way() {
        let t = args(&["--identity", "/k", "--known-hosts=/kh", "--server", "h:24242", "--ws", "wss://h/ws/gateway/", "--forward", "0:192.168.1.1:22"]).unwrap();
        assert_eq!(t.identity.as_deref(), Some(Path::new("/k")));
        assert_eq!(t.known_hosts, vec![PathBuf::from("/kh")]);
        assert_eq!(t.server.as_deref(), Some("h:24242"));
        assert_eq!(t.forward.host, "192.168.1.1");
        assert_eq!((t.keepalive, t.user.as_str()), (30, "telepy"));
        assert!(args(&["--known-hosts", "/kh", "--server", "h:1"]).unwrap_err().contains("--identity"));
        assert!(args(&["--identity", "/k", "--server", "h:1"]).unwrap_err().contains("host key"));
        assert!(args(&["--identity", "/k", "--host-key", ED]).unwrap_err().contains("--server"));
        assert!(args(&["--identity", "/k", "--host-key", ED, "--server", "nohost"]).is_err());
        assert!(args(&["--identity", "/k", "--host-key", ED, "--ws", "https://x/"]).is_err());
        assert!(args(&["--identity", "/k", "--host-key", ED, "--server", "h:1", "--keepalive", "x"]).is_err());
        assert!(args(&["--identity", "/k", "--host-key", ED, "--server", "h:1", "--user", "-x"]).is_err());
        assert!(args(&["--bogus"]).is_err());
        // --probe 不必帶金鑰，也可以不給 host key（只回報看到哪把）。/ A probe needs no key and may omit host keys.
        let p = args(&["--probe", "--server", "h:1"]).unwrap();
        assert!(p.probe && p.identity.is_none());
        assert!(args(&["--help"]).unwrap().help);
        let w = args(&["--identity", "/k", "--host-key", ED, "--ws=wss://h/ws/gateway/", "--no-proxy", "--keepalive=0"]).unwrap();
        assert!(w.no_proxy && w.server.is_none() && w.keepalive == 0);
    }

    #[test]
    fn host_keys_come_from_known_hosts_or_bare_lines() {
        let text = format!("# comment\ntelepy-h-24242 {ED}\n@revoked * {ED}\n{ED} extra-comment\n[h]:24242 {ED}\nnot a key\n");
        let keys = parse_host_keys(&text);
        assert_eq!(keys.len(), 1, "the same key once");
        assert_eq!(key_line(&keys[0]), ED);
        assert!(fingerprint(&keys[0]).starts_with("SHA256:"));
        assert!(parse_host_keys("h ssh-ed25519 notbase64").is_empty());
    }

    #[test]
    fn keygen_writes_an_openssh_key_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("k");
        let public = keygen(&path, "telepy-tunnel@box").unwrap();
        assert!(public.starts_with("ssh-ed25519 ") && public.ends_with(" telepy-tunnel@box"), "{public}");
        let key = load_identity(&path).unwrap();
        assert_eq!(key_line(key.public_key()), public.rsplit_once(' ').unwrap().0);
        assert_eq!(std::fs::read_to_string(dir.path().join("k.pub")).unwrap().trim(), public);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(keygen(&path, "x").unwrap_err().to_string().contains("exists"), "never overwrites");
        assert_eq!(parse_keygen_args(["-C", "c", "/f"].map(String::from)).unwrap(), KeygenArgs { file: PathBuf::from("/f"), comment: "c".into(), public_only: false });
        assert!(parse_keygen_args(["-y", "/f"].map(String::from)).unwrap().public_only);
        assert!(parse_keygen_args(Vec::<String>::new()).is_err());
        assert_eq!(public_line(&path).unwrap(), public, "-y reads the public line back");
    }

    #[test]
    fn passphrase_keys_are_refused_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enc");
        // ssh-keygen 在就用它做一把有 passphrase 的。/ With ssh-keygen around, make a passphrase key with it.
        let made = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "secret", "-f"]).arg(&path).output();
        if made.map(|o| o.status.success()).unwrap_or(false) {
            assert!(load_identity(&path).unwrap_err().to_string().contains("passphrase"));
        }
        std::fs::write(&path, "garbage").unwrap();
        assert!(load_identity(&path).unwrap_err().to_string().contains("OpenSSH-format"));
    }
}
