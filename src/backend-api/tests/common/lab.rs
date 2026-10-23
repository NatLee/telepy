//! SSH 實驗室：把「裝置 → gateway → 後端 / 筆電」整套拓撲搭在本機，給整合測試重複使用。
//! - gateway：真的 `telepy_server::gateway`（127.0.0.1 隨機埠）
//! - 裝置的反向隧道：真的 OpenSSH 客戶端 `ssh -NR`（與裝置腳本相同）
//! - 裝置 / 內網機器上的 sshd：[`Machine`]（russh）。每個 OS 帳號各自的 authorized_keys（建立時給的金鑰，
//!   加上 [`Machine::account_home`] 之後 `<home>/<帳號>/.ssh/authorized_keys` 檔案裡的金鑰）、記錄每次登入
//!   （帳號 + 用了哪把金鑰），可選擇當跳板（direct-tcpip）。exec 支援 `whoami` / `hostname` / `whereami`
//!   （`user@machine`）；shell 先印 `login:user@machine` 再 echo；`sftp` 子系統轉給本機 sftp-server（有的話）。
//! - 後端兩條路（都只一跳到 gateway 的 loopback）：russh（SFTP / 檔案管理）與 OpenSSH（terminal / `ssh -D`）
//! - 筆電：真的 OpenSSH 客戶端。第一跳 `ProxyCommand ssh -W %h:%p telepy-ssh-server`（gateway + 裝置兩層），
//!   之後每一跳 ProxyJump 穿過前一台。
//! - 網頁終端機：真的 `/ws/terminal/`（Telepy 的權限）→ PTY → OpenSSH → 裝置。
//! 沒有 ssh / ssh-keygen 的環境 [`Lab::start`] 回 None，測試自行跳過。
//! Reusable SSH topology for integration tests: gateway, real OpenSSH tunnels and laptops, scriptable device sshd.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use russh::keys::{load_secret_key, PublicKey};
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId, ChannelMsg, ChannelOpenFailure, MethodKind, MethodSet};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use telepy_server::db;

use super::TestApp;

const RUN_TIMEOUT: Duration = Duration::from_secs(30);

pub fn have(bin: &str) -> bool {
    std::process::Command::new("which").arg(bin).output().map(|o| o.status.success()).unwrap_or(false)
}

pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

pub fn sftp_server_bin() -> Option<&'static str> {
    ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/lib/ssh/sftp-server"].into_iter().find(|p| Path::new(p).exists())
}

/// ssh-keygen 產生的 ed25519 金鑰對；`name` 也是 [`Login::key`] 裡的名字。
#[derive(Clone, Debug)]
pub struct LabKey {
    pub name: String,
    pub path: PathBuf,
    /// `type base64 comment`
    pub public: String,
}

impl LabKey {
    /// `type base64`（去掉註解）。
    pub fn bare(&self) -> String {
        self.public.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
    }
}

pub fn keygen(dir: &Path, name: &str) -> LabKey {
    let path = dir.join(name);
    let out = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", name, "-f"]).arg(&path).output().unwrap();
    assert!(out.status.success(), "ssh-keygen failed: {}", String::from_utf8_lossy(&out.stderr));
    let public = std::fs::read_to_string(format!("{}.pub", path.display())).unwrap().trim().to_string();
    LabKey { name: name.to_string(), path, public }
}

/// 一個程序的結果（stdout / stderr 已 trim）。
#[derive(Debug)]
pub struct Run {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

async fn run(cmd: &mut Command) -> Run {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let out = tokio::time::timeout(RUN_TIMEOUT, cmd.output()).await.expect("command timed out").expect("spawn");
    Run {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    }
}

// ------------------------------------------------------------------ device / LAN machine sshd

/// 一次成功登入：OS 帳號 + 金鑰名字（[`LabKey::name`]；從 authorized_keys 檔案認證的是空字串）+ `type base64`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Login {
    pub user: String,
    pub key: String,
    pub bare: String,
}

/// 一台有 sshd 的機器（裝置本身，或只有裝置連得到的內網機器）。
#[derive(Clone)]
pub struct Machine {
    pub name: String,
    pub port: u16,
    /// 當前目錄 = sftp-server 的 home。
    pub home: PathBuf,
    logins: Arc<Mutex<Vec<Login>>>,
}

impl Machine {
    pub fn logins(&self) -> Vec<Login> {
        self.logins.lock().unwrap().clone()
    }
    pub fn logged_in(&self, user: &str, key: &LabKey) -> bool {
        self.logins().iter().any(|l| l.user == user && (l.key == key.name || l.bare == key.bare()))
    }
    pub fn any_login_with(&self, key: &LabKey) -> bool {
        self.logins().iter().any(|l| l.key == key.name || l.bare == key.bare())
    }
    /// 幾次以 `user` + `key` 登入（= 幾條 SSH 連線 / 握手）。
    pub fn login_count(&self, user: &str, key: &LabKey) -> usize {
        self.logins().iter().filter(|l| l.user == user && l.key == key.name).count()
    }
    /// 讓帳號有自己的家目錄 `<home>/<user>`：SFTP 從這裡開始，`.ssh/authorized_keys` 檔案裡的金鑰也算數。
    pub fn account_home(&self, user: &str) -> PathBuf {
        let dir = self.home.join(user);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    /// 帳號的 authorized_keys 檔案內容（沒有就空字串）。
    pub fn authorized_keys(&self, user: &str) -> String {
        std::fs::read_to_string(self.home.join(user).join(".ssh/authorized_keys")).unwrap_or_default()
    }
}

/// 檔案裡有沒有這把金鑰（忽略 options 與註解，只比 `type base64`）。
fn file_trusts(path: &Path, offered: &str) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else { return false };
    content.lines().any(|l| {
        let words: Vec<&str> = l.split_whitespace().collect();
        words.windows(2).any(|w| format!("{} {}", w[0], w[1]) == offered)
    })
}

/// 機器的行為選項。
#[derive(Clone, Copy, Default)]
pub struct MachineOpts {
    /// 可以當 ProxyJump 的跳板（接受 direct-tcpip）。
    pub allow_jump: bool,
    /// 每條連線同時最多幾個 session channel（= sshd 的 MaxSessions）；None = 不限。
    pub max_sessions: Option<usize>,
    /// exec 用真的 `/bin/sh -c` 跑（HOME / TMPDIR / 工作目錄 = 帳號的 `<home>/<user>`，不會碰到開發者的家目錄）。
    /// Run exec requests with a real `/bin/sh -c`, HOME / TMPDIR / cwd pointed at the account's scratch home.
    pub shell: bool,
}

struct MachineState {
    name: String,
    accounts: HashMap<String, Vec<LabKey>>,
    opts: MachineOpts,
    home: PathBuf,
    logins: Arc<Mutex<Vec<Login>>>,
}

struct SshdHandler {
    m: Arc<MachineState>,
    user: Option<String>,
    channels: HashMap<ChannelId, Channel<Msg>>,
    /// 這條連線上開著的 session channel。
    sessions: HashSet<ChannelId>,
}

impl SshdHandler {
    /// (金鑰名字, `type base64`)：建立時給的金鑰，或帳號家目錄 `.ssh/authorized_keys` 裡的。
    fn key_for(&self, user: &str, key: &PublicKey) -> Option<(String, String)> {
        let offered = key.to_openssh().ok()?.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
        if let Some(k) = self.m.accounts.get(user).and_then(|keys| keys.iter().find(|k| k.bare() == offered)) {
            return Some((k.name.clone(), offered));
        }
        file_trusts(&self.m.home.join(user).join(".ssh/authorized_keys"), &offered).then(|| (String::new(), offered))
    }
}

impl server::Handler for SshdHandler {
    type Error = anyhow::Error;

    async fn auth_publickey_offered(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        Ok(if self.key_for(user, key).is_some() { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let Some((name, bare)) = self.key_for(user, key) else { return Ok(Auth::reject()) };
        self.m.logins.lock().unwrap().push(Login { user: user.to_string(), key: name, bare });
        self.user = Some(user.to_string());
        Ok(Auth::Accept)
    }

    async fn channel_open_session(&mut self, channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        if self.m.opts.max_sessions.is_some_and(|max| self.sessions.len() >= max) {
            reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        }
        let id = channel.id();
        reply.accept().await;
        self.sessions.insert(id);
        self.channels.insert(id, channel);
        Ok(())
    }

    async fn channel_close(&mut self, channel: ChannelId, _session: &mut Session) -> Result<(), Self::Error> {
        self.sessions.remove(&channel);
        self.channels.remove(&channel);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(&mut self, channel: ChannelId, _term: &str, _c: u32, _r: u32, _pw: u32, _ph: u32, _modes: &[(russh::Pty, u32)], session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let Some(ch) = self.channels.remove(&channel) else { return Ok(()) };
        let banner = format!("login:{}@{}\r\n", self.user.clone().unwrap_or_default(), self.m.name);
        tokio::spawn(async move {
            let _ = ch.data_bytes(banner.into_bytes()).await;
            let mut s = ch.into_stream();
            let mut buf = [0u8; 4096];
            while let Ok(n) = s.read(&mut buf).await {
                if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
        });
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let cmd = String::from_utf8_lossy(data).trim().to_string();
        let user = self.user.clone().unwrap_or_default();
        if self.m.opts.shell {
            let home = self.m.home.join(&user);
            let tmp = home.join("tmp");
            std::fs::create_dir_all(&tmp)?;
            let Some(ch) = self.channels.remove(&channel) else { return Ok(()) };
            tokio::spawn(async move {
                let out = Command::new("/bin/sh")
                    .arg("-c")
                    .arg(&cmd)
                    .current_dir(&home)
                    .env("HOME", &home)
                    .env("TMPDIR", &tmp)
                    .env("USER", &user)
                    .env("LOGNAME", &user)
                    .stdin(Stdio::null())
                    .output()
                    .await;
                let (stdout, stderr, code) = match out {
                    Ok(o) => (o.stdout, o.stderr, o.status.code().unwrap_or(1) as u32),
                    Err(e) => (Vec::new(), e.to_string().into_bytes(), 127),
                };
                if !stdout.is_empty() {
                    let _ = ch.data_bytes(stdout).await;
                }
                if !stderr.is_empty() {
                    let _ = ch.extended_data_bytes(1, stderr).await;
                }
                let _ = ch.exit_status(code).await;
                let _ = ch.eof().await;
                let _ = ch.close().await;
            });
            return Ok(());
        }
        let (out, err, code) = match cmd.as_str() {
            "whoami" => (format!("{user}\n"), String::new(), 0),
            "hostname" => (format!("{}\n", self.m.name), String::new(), 0),
            "whereami" => (format!("{user}@{}\n", self.m.name), String::new(), 0),
            c if c.strip_prefix("sleep ").and_then(|n| n.parse::<u64>().ok()).is_some() => (String::new(), String::new(), 0),
            _ => (String::new(), format!("{cmd}: command not found\n"), 127),
        };
        // `sleep N`：讓 session 開著一陣子（測 presence 這類「連線期間」的狀態）。/ Keeps the session open for N seconds.
        let delay = cmd.strip_prefix("sleep ").and_then(|n| n.parse::<u64>().ok()).map(Duration::from_secs);
        let Some(ch) = self.channels.remove(&channel) else { return Ok(()) };
        tokio::spawn(async move {
            if let Some(d) = delay {
                tokio::time::sleep(d).await;
            }
            if !out.is_empty() {
                let _ = ch.data_bytes(out.into_bytes()).await;
            }
            if !err.is_empty() {
                let _ = ch.extended_data_bytes(1, err.into_bytes()).await;
            }
            let _ = ch.exit_status(code).await;
            let _ = ch.eof().await;
            let _ = ch.close().await;
        });
        Ok(())
    }

    async fn subsystem_request(&mut self, channel: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
        let bin = if name == "sftp" { sftp_server_bin() } else { None };
        let (Some(bin), Some(ch)) = (bin, self.channels.remove(&channel)) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        session.channel_success(channel)?;
        // 帳號有自己的家目錄就從那裡開始（authorized_keys 測試用）。/ Per-account home when it exists.
        let own = self.m.home.join(self.user.clone().unwrap_or_default());
        let home = if self.user.is_some() && own.is_dir() { own } else { self.m.home.clone() };
        tokio::spawn(async move {
            let Ok(mut child) = Command::new(bin).current_dir(&home).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn() else {
                return;
            };
            let (mut stdin, mut stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
            let (mut r, mut w) = tokio::io::split(ch.into_stream());
            let to_child = async move {
                let _ = tokio::io::copy(&mut r, &mut stdin).await;
                drop(stdin); // EOF → sftp-server exits
            };
            let from_child = async move {
                let _ = tokio::io::copy(&mut stdout, &mut w).await;
                let _ = w.shutdown().await;
            };
            tokio::join!(to_child, from_child);
            let _ = child.wait().await;
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.m.opts.allow_jump {
            reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        }
        let Ok(mut tcp) = TcpStream::connect((host_to_connect.to_string(), port_to_connect as u16)).await else {
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            let mut s = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut s).await;
        });
        Ok(())
    }
}

/// 起一台 sshd：`accounts` = OS 帳號 → 信任的金鑰。
pub async fn start_machine(dir: &Path, name: &str, accounts: &[(&str, &[&LabKey])], opts: MachineOpts) -> Machine {
    let host_key = keygen(dir, &format!("{name}-hostkey"));
    let mut methods = MethodSet::empty();
    methods.push(MethodKind::PublicKey);
    let config = Arc::new(server::Config {
        keys: vec![load_secret_key(&host_key.path, None).unwrap()],
        methods,
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let home = dir.join(format!("{name}-home"));
    std::fs::create_dir_all(&home).unwrap();
    let logins = Arc::new(Mutex::new(Vec::new()));
    let state = Arc::new(MachineState {
        name: name.to_string(),
        accounts: accounts.iter().map(|(u, keys)| (u.to_string(), keys.iter().map(|k| (*k).clone()).collect())).collect(),
        opts,
        home: home.clone(),
        logins: logins.clone(),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (config, m) = (config.clone(), state.clone());
            tokio::spawn(async move {
                let handler = SshdHandler { m, user: None, channels: HashMap::new(), sessions: HashSet::new() };
                if let Ok(session) = server::run_stream(config, stream, handler).await {
                    let _ = session.await;
                }
            });
        }
    });
    Machine { name: name.to_string(), port, home, logins }
}

// ------------------------------------------------------------------ lab

/// Telepy 使用者：已登入（token）並註冊了一把個人金鑰（筆電用）。
pub struct LabUser {
    pub id: i64,
    pub username: String,
    pub token: String,
    pub key: LabKey,
}

/// 一條隧道：裝置用自己的隧道金鑰 `ssh -NR` 連 gateway，forward 到 `target` 的 sshd。
/// `target` 通常是裝置自己；也可以是裝置內網的另一台（`-R *:port:lan-host:22`）。
pub struct Device {
    pub tunnel_id: i64,
    pub name: String,
    pub reverse_port: u16,
    pub target: Machine,
    /// 裝置自己的隧道金鑰（`reconnect_device` 用它重連）。
    pub key: LabKey,
}

/// 筆電的一跳：第一跳必須是 [`Hop::Tunnel`]（經 gateway），之後是 [`Hop::Direct`]（ProxyJump 穿過前一跳）。
pub enum Hop<'a> {
    Tunnel(&'a Device),
    Direct(&'a Machine),
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 網頁終端機（`/ws/terminal/`）的一條連線。
pub struct Terminal {
    ws: Ws,
    /// 到目前為止收到的 PTY 輸出。
    pub seen: String,
}

impl Terminal {
    pub async fn input(&mut self, text: &str) {
        let msg = json!({"action": "pty_input", "payload": {"input": text}});
        self.ws.send(Message::Text(msg.to_string().into())).await.unwrap();
    }

    /// 讀 PTY 輸出直到出現 `needle`（10 秒逾時）。
    pub async fn expect(&mut self, needle: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !self.seen.contains(needle) {
            let frame = tokio::time::timeout_at(deadline, self.ws.next()).await;
            match frame {
                Ok(Some(Ok(Message::Text(t)))) => self.seen.push_str(&t),
                Ok(Some(Ok(Message::Binary(_)))) => {}
                Ok(other) => panic!("terminal ended before {needle:?}: {other:?}; output so far: {:?}", self.seen),
                Err(_) => panic!("timed out waiting for {needle:?}; output so far: {:?}", self.seen),
            }
        }
    }
}

pub struct Lab {
    pub app: TestApp,
    pub dir: tempfile::TempDir,
    pub gw_port: u16,
    /// 後端的服務金鑰（`ssh_identity` 與 OpenSSH 包裝程式都用它）。
    pub service: LabKey,
    pub admin_token: String,
    /// tunnel id → 裝置那端的 `ssh -NR`。
    tunnels: Mutex<HashMap<i64, Child>>,
    ws_base: tokio::sync::OnceCell<String>,
}

impl Lab {
    /// 起 gateway + 後端；沒有 ssh / ssh-keygen 就回 None（呼叫端 `return`）。
    pub async fn start() -> Option<Lab> {
        if !have("ssh") || !have("ssh-keygen") {
            eprintln!("skipping: ssh / ssh-keygen not available");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        keygen(dir.path(), "ssh_host_ed25519_key");
        let service = keygen(dir.path(), "service");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gw_port = listener.local_addr().unwrap().port();

        // 後端的 OpenSSH（terminal / ssh -D）：不讀開發者的 ~/.ssh、只用服務金鑰。命令列「先出現的值優先」，
        // 所以這裡的 ControlPath / ControlPersist 會蓋過 terminal_args，多工 socket 不會殘留。
        let wrapper = dir.path().join("backend-ssh");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nexec ssh -F /dev/null -i '{}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR -o ControlPath=/tmp/tl-%C -o ControlPersist=no \"$@\"\n",
                service.path.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut app = super::spawn().await;
        let mut config = app.state.config.clone();
        config.gateway_enabled = true;
        config.gateway_host_keys_dir = Some(dir.path().to_path_buf());
        config.gateway_login_grace = Duration::from_secs(30);
        config.ssh_identity = service.path.clone();
        config.ssh_binary = wrapper.display().to_string();
        config.server_domain = Some("127.0.0.1".to_string());
        config.reverse_server_ssh_port = gw_port.to_string();
        config.ssh_logs_path = dir.path().join("ssh-gateway.log");
        app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
        app.router = telepy_server::app::build(app.state.clone());
        telepy_server::gateway::start(app.state.gateway.clone(), listener).unwrap();
        db::keys::service_key_upsert(&app.state.db, "web-service", &service.public, "lab").await.unwrap();

        let lab = Lab { app, dir, gw_port, service, admin_token: String::new(), tunnels: Mutex::new(HashMap::new()), ws_base: tokio::sync::OnceCell::new() };
        // 第一位使用者是 superuser（站台管理員，不參與隧道）。
        let admin_token = lab.account("admin").await.1;
        Some(Lab { admin_token, ..lab })
    }

    pub fn keygen(&self, name: &str) -> LabKey {
        keygen(self.dir.path(), name)
    }

    /// 直接在 DB 建帳號並簽 access token（不走註冊 / 登入：debug build 的 pbkdf2 一百萬次要好幾秒）。
    async fn account(&self, name: &str) -> (i64, String) {
        let u = db::users::create(&self.app.state.db, db::users::NewUser { username: name, password_hash: "!", email: "", first_name: "", last_name: "" }).await.unwrap();
        (u.id, self.app.state.jwt.access(u.id))
    }

    /// 一位 Telepy 使用者（已有 token），並登記他筆電的個人金鑰。
    pub async fn user(&self, name: &str) -> LabUser {
        let (id, token) = self.account(name).await;
        let key = self.keygen(name);
        let r = self.app.post("/api/reverse/user/keys", Some(&token), json!({"host_friendly_name": format!("{name}-laptop"), "key": key.public})).await;
        assert!(r.status.is_success(), "user key: {}", r.text);
        LabUser { id, username: name.to_string(), token, key }
    }

    pub async fn machine(&self, name: &str, accounts: &[(&str, &[&LabKey])], allow_jump: bool) -> Machine {
        self.machine_with(name, accounts, MachineOpts { allow_jump, ..Default::default() }).await
    }

    pub async fn machine_with(&self, name: &str, accounts: &[(&str, &[&LabKey])], opts: MachineOpts) -> Machine {
        start_machine(self.dir.path(), name, accounts, opts).await
    }

    /// 建隧道（owner 的）並讓「裝置」用真的 `ssh -NR` 連上 gateway，等到 forward 註冊好才回來。
    pub async fn device(&self, owner: &LabUser, name: &str, target: &Machine) -> Device {
        let key = self.keygen(&format!("{name}-tunnel"));
        let reverse_port = free_port();
        let t = db::tunnels::create(
            &self.app.state.db,
            db::tunnels::NewTunnel { user_id: owner.id, host_friendly_name: name, key: &key.public, reverse_port: reverse_port as i64, description: None, default_username_id: None },
        )
        .await
        .unwrap();
        let ssh = self.spawn_tunnel(&key, reverse_port, target.port, name).await;
        self.tunnels.lock().unwrap().insert(t.id, ssh);
        Device { tunnel_id: t.id, name: name.to_string(), reverse_port, target: target.clone(), key }
    }

    /// 裝置斷線再連回來（同一把金鑰、同一個 port），等到新的 forward 註冊好。
    pub async fn reconnect_device(&self, device: &Device) {
        let old = self.tunnels.lock().unwrap().remove(&device.tunnel_id);
        if let Some(mut c) = old {
            let _ = c.kill().await;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while self.app.state.status.listen_ports().map(|p| p.contains(&device.reverse_port)).unwrap_or(false) {
            assert!(tokio::time::Instant::now() < deadline, "device {}: forward never released", device.name);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let ssh = self.spawn_tunnel(&device.key, device.reverse_port, device.target.port, &device.name).await;
        self.tunnels.lock().unwrap().insert(device.tunnel_id, ssh);
    }

    /// 一行指令加入的裝置：用 join 腳本的選項（釘住 gateway host key）把隧道連上來。`host_keys` 是 `type base64` 行。
    /// A device that joined with the install script: connect with its options (pinned gateway host keys).
    pub async fn connect_joined(&self, tunnel_id: i64, key: &LabKey, reverse_port: u16, target: &Machine, host_keys: &[String]) {
        let alias = format!("telepy-127.0.0.1-{}", self.gw_port);
        let known = self.dir.path().join(format!("known-{tunnel_id}"));
        std::fs::write(&known, host_keys.iter().map(|k| format!("{alias} {k}\n")).collect::<String>()).unwrap();
        let pin = ["-o".to_string(), "StrictHostKeyChecking=yes".into(), "-o".into(), format!("UserKnownHostsFile={}", known.display()), "-o".into(), format!("HostKeyAlias={alias}")];
        let ssh = self.spawn_tunnel_with(key, reverse_port, target.port, &format!("joined-{tunnel_id}"), &pin).await;
        self.tunnels.lock().unwrap().insert(tunnel_id, ssh);
    }

    /// 裝置那端的 `ssh -NR`（與裝置腳本相同的選項），回傳時 forward 已註冊。
    async fn spawn_tunnel(&self, key: &LabKey, reverse_port: u16, target_port: u16, name: &str) -> Child {
        let no_pin = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"].map(String::from);
        self.spawn_tunnel_with(key, reverse_port, target_port, name, &no_pin).await
    }

    async fn spawn_tunnel_with(&self, key: &LabKey, reverse_port: u16, target_port: u16, name: &str, host_key_opts: &[String]) -> Child {
        let mut ssh = Command::new("ssh")
            .args(["-F", "/dev/null", "-N"])
            .args(host_key_opts)
            .args(["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
            .args(["-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=5", "-o", "LogLevel=ERROR", "-i"])
            .arg(&key.path)
            .args(["-p", &self.gw_port.to_string(), "-R", &format!("*:{reverse_port}:127.0.0.1:{target_port}"), "telepy@127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !self.app.state.status.listen_ports().map(|p| p.contains(&reverse_port)).unwrap_or(false) {
            if tokio::time::Instant::now() > deadline {
                let mut err = String::new();
                if let Some(mut e) = ssh.stderr.take() {
                    let _ = tokio::time::timeout(Duration::from_secs(1), e.read_to_string(&mut err)).await;
                }
                panic!("device {name}: forward never registered; ssh stderr: {err}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        ssh
    }

    /// 以 `as_user` 的身分在隧道上新增目標 OS 帳號；回傳 API 回應（成功時 `json["id"]` 是 username id）。
    pub async fn add_username(&self, as_user: &LabUser, device: &Device, os_user: &str) -> super::Resp {
        self.app.post("/api/reverse/server/usernames", Some(&as_user.token), json!({"reverse_server": device.tunnel_id, "username": os_user})).await
    }

    /// `add_username` 並斷言成功，回 username id。
    pub async fn username(&self, as_user: &LabUser, device: &Device, os_user: &str) -> i64 {
        let r = self.add_username(as_user, device, os_user).await;
        assert!(r.status.is_success(), "add username {os_user}: {}", r.text);
        r.json["id"].as_i64().unwrap()
    }

    /// 分享隧道（`permission` = view / edit / admin），`allowed` = 允許的 username id。
    pub async fn share(&self, owner: &LabUser, device: &Device, with: &LabUser, permission: &str, allowed: &[i64]) {
        let r = self
            .app
            .post(&format!("/tunnels/share/{}", device.tunnel_id), Some(&owner.token), json!({"shared_with_user_id": with.id, "permission_type": permission, "allowed_target_username_ids": allowed}))
            .await;
        assert!(r.status.is_success(), "share: {}", r.text);
    }

    // -------------------------------------------------------------- paths to a device

    /// 後端 russh 新連線（AI session 的路；行程內經 gateway 的通道）：服務金鑰登入裝置，exec `cmd` 回 stdout。
    pub async fn backend_exec(&self, device: &Device, os_user: &str, cmd: &str) -> anyhow::Result<String> {
        let conn = telepy_server::ssh::device::connect(&self.app.state, os_user, device.reverse_port as i64).await?;
        let mut ch = conn.device.channel_open_session().await?;
        ch.exec(true, cmd).await?;
        let (mut out, mut status) = (Vec::new(), None);
        while let Some(msg) = tokio::time::timeout(RUN_TIMEOUT, ch.wait()).await? {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        let out = String::from_utf8_lossy(&out).trim().to_string();
        anyhow::ensure!(status == Some(0), "exit status {status:?}: {out}");
        Ok(out)
    }

    /// 後端連線池借一條 SFTP channel（檔案管理 / SFTP REST 的路）。
    pub async fn backend_sftp(&self, device: &Device, os_user: &str) -> anyhow::Result<telepy_server::ssh::pool::PooledSftp> {
        self.app.state.pool.sftp(&self.app.state, device.reverse_port as i64, os_user).await
    }

    /// 後端 OpenSSH（terminal / `ssh -D` 的路）：同一支包裝程式、一跳到 loopback。
    pub async fn backend_ssh(&self, device: &Device, os_user: &str, cmd: &str) -> Run {
        run(Command::new(&self.app.state.config.ssh_binary).args(["-p", &device.reverse_port.to_string(), &format!("{os_user}@127.0.0.1"), cmd])).await
    }

    /// 筆電的 ssh config：`telepy-ssh-server`（gateway）+ 每一跳一個 `hopN`，最後一跳是目的地。
    pub fn laptop_config(&self, user: &LabUser, hops: &[(Hop<'_>, &str)]) -> PathBuf {
        let path = self.dir.path().join(format!("{}-laptop-{}.conf", user.username, next_id()));
        let mut cfg = format!("Host telepy-ssh-server\n    HostName 127.0.0.1\n    Port {}\n    User telepy\n\n", self.gw_port);
        for (i, (hop, os_user)) in hops.iter().enumerate() {
            match (i, hop) {
                (0, Hop::Tunnel(d)) => {
                    cfg += &format!("Host hop0\n    HostName localhost\n    Port {}\n    User {os_user}\n    ProxyCommand ssh -F {} -W %h:%p telepy-ssh-server\n\n", d.reverse_port, path.display());
                }
                (i, Hop::Direct(m)) if i > 0 => {
                    cfg += &format!("Host hop{i}\n    HostName 127.0.0.1\n    Port {}\n    User {os_user}\n    ProxyJump hop{}\n\n", m.port, i - 1);
                }
                _ => panic!("the first hop must be a Tunnel and the rest Direct"),
            }
        }
        cfg += &laptop_defaults(&user.key);
        std::fs::write(&path, cfg).unwrap();
        path
    }

    /// 筆電經 gateway（必要時再 ProxyJump）跑 `cmd`。
    pub async fn laptop_exec(&self, user: &LabUser, hops: &[(Hop<'_>, &str)], cmd: &str) -> Run {
        let cfg = self.laptop_config(user, hops);
        run(Command::new("ssh").arg("-F").arg(&cfg).arg(format!("hop{}", hops.len() - 1)).arg(cmd)).await
    }

    /// API 產生的 `~/.ssh/config`（`/tunnels/server/config/{id}?username_id=`）原樣存檔；只把 ProxyCommand 的 ssh
    /// 指到同一個檔（真筆電上它讀 ~/.ssh/config）並補上金鑰預設值。回 (檔案, Host 別名)。
    pub async fn generated_ssh_config(&self, user: &LabUser, device: &Device, os_user: &str) -> (PathBuf, String) {
        let r = self.app.get(&format!("/tunnels/server/config/{}", device.tunnel_id), Some(&user.token)).await;
        assert!(r.status.is_success(), "config: {}", r.text);
        let id = r.json["usernames"].as_array().unwrap().iter().find(|u| u["username"] == os_user).unwrap_or_else(|| panic!("{os_user} not allowed for {}", user.username))["id"].as_i64().unwrap();
        let r = self.app.get(&format!("/tunnels/server/config/{}?username_id={id}", device.tunnel_id), Some(&user.token)).await;
        let generated = r.json["config"].as_str().unwrap().to_string();
        let alias = generated.lines().filter_map(|l| l.trim().strip_prefix("Host ")).map(str::trim).filter(|h| *h != "telepy-ssh-server").last().unwrap().to_string();
        let path = self.dir.path().join(format!("{}-{}-generated.conf", user.username, device.name));
        let patched = generated.replace("ProxyCommand ssh -W", &format!("ProxyCommand ssh -F {} -W", path.display()));
        std::fs::write(&path, format!("{patched}\n{}", laptop_defaults(&user.key))).unwrap();
        (path, alias)
    }

    pub async fn ssh_with_config(&self, config: &Path, host: &str, cmd: &str) -> Run {
        run(Command::new("ssh").arg("-F").arg(config).arg(host).arg(cmd)).await
    }

    /// 網頁終端機：Telepy 拒絕（權限 / 帳號不允許）時回關閉碼；否則回已開始的終端機。
    pub async fn terminal(&self, user: &LabUser, device: &Device, os_user: &str) -> Result<Terminal, u16> {
        self.terminal_with(user, device, os_user, json!({})).await
    }

    /// 同上，auth 訊息多帶 `extra` 的欄位（例如 `lan_host_id`）。/ Same, with extra auth-message fields.
    pub async fn terminal_with(&self, user: &LabUser, device: &Device, os_user: &str, extra: Value) -> Result<Terminal, u16> {
        let base = self
            .ws_base
            .get_or_init(|| async {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let router = self.app.router.clone();
                // 與正式環境一樣帶 ConnectInfo（來源 IP）。/ Serve with ConnectInfo like production.
                tokio::spawn(async move { axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap() });
                format!("ws://{addr}")
            })
            .await;
        let (mut ws, _) = connect_async(format!("{base}/ws/terminal/")).await.unwrap();
        let mut auth = json!({"type": "auth", "token": user.token, "server_id": device.tunnel_id.to_string(), "username": os_user});
        if let (Some(a), Some(e)) = (auth.as_object_mut(), extra.as_object()) {
            a.extend(e.clone());
        }
        ws.send(Message::Text(auth.to_string().into())).await.unwrap();
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("no terminal frame") {
            Some(Ok(Message::Close(Some(f)))) => Err(u16::from(f.code)),
            Some(Ok(Message::Text(t))) => Ok(Terminal { ws, seen: t.to_string() }),
            Some(Ok(_)) => Ok(Terminal { ws, seen: String::new() }),
            other => panic!("terminal socket ended: {other:?}"),
        }
    }
}

fn laptop_defaults(key: &LabKey) -> String {
    format!(
        "Host *\n    IdentityFile {}\n    IdentitiesOnly yes\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n    BatchMode yes\n    LogLevel ERROR\n    ConnectTimeout 10\n",
        key.path.display()
    )
}

fn next_id() -> usize {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}
