//! SSH 實驗室：把「裝置 → gateway → 後端 / 筆電」整套拓撲搭在本機，給整合測試重複使用。
//! - gateway：真的 `telepy_server::gateway`（127.0.0.1 隨機埠）
//! - 裝置的反向隧道：真的 OpenSSH 客戶端 `ssh -NR`（與裝置腳本相同）
//! - 裝置 / 內網機器上的 sshd：[`Machine`]（russh）。每個 OS 帳號各自的 authorized_keys（建立時給的金鑰，
//!   加上 [`Machine::account_home`] 之後 `<home>/<帳號>/.ssh/authorized_keys` 檔案裡的金鑰）、記錄每次登入
//!   （帳號 + 用了哪把金鑰），可選擇當跳板（direct-tcpip）。exec 支援 `whoami` / `hostname` / `whereami`
//!   （`user@machine`）；shell 先印 `login:user@machine` 再 echo；`sftp` 子系統轉給本機 sftp-server（有的話）。
//! - 後端：russh 在行程內經 gateway 開通道。連線池（SFTP / 檔案管理 / 終端機 / SOCKS）見 `backend_sftp`，
//!   自己的一條連線（AI session、區網掃描）見 `backend_exec`
//! - 筆電：真的 OpenSSH 客戶端。第一跳 `ProxyCommand ssh -W %h:%p telepy-ssh-server`（gateway + 裝置兩層），
//!   之後每一跳 ProxyJump 穿過前一台。
//! - 網頁終端機：真的 `/ws/terminal/`（Telepy 的權限）→ 池子連線上的 PTY channel → 裝置；區網主機那一跳由
//!   OpenSSH（下面的包裝程式）連 `ssh::bridge` 的一次性入口。檔案管理：`filemanager`。
//!
//! 沒有 ssh / ssh-keygen 的環境 [`Lab::start`] 回 None，測試自行跳過。
//! Reusable SSH topology for integration tests: gateway, real OpenSSH tunnels and laptops, scriptable device sshd.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
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

/// 名稱變成檔名：英數與 `._-` 以外換成 `-`。/ A name as a file name: other characters become `-`.
fn file_safe(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' }).collect()
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
    /// 這台 sshd 的 host key（`type base64`）：Telepy 用它辨認機器。/ The sshd's host key (`type base64`).
    pub host_key: String,
    logins: Arc<Mutex<Vec<Login>>>,
    ptys: Arc<Mutex<Vec<PtyState>>>,
    resizes: Arc<Mutex<Vec<(u32, u32)>>>,
    resolves: Arc<Mutex<Vec<String>>>,
    commands: Arc<Mutex<Vec<String>>>,
    sftp_starts: Arc<AtomicUsize>,
    open_sessions: Arc<AtomicUsize>,
}

impl Machine {
    /// echo_shell：真的跑了的指令（按 Enter 送到 shell 的行）。/ echo_shell: lines that reached the shell with Enter.
    pub fn commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }
    pub fn logins(&self) -> Vec<Login> {
        self.logins.lock().unwrap().clone()
    }
    pub fn logged_in(&self, user: &str, key: &LabKey) -> bool {
        self.logins().iter().any(|l| l.user == user && (l.key == key.name || l.bare == key.bare()))
    }
    /// 用這把公鑰（`type base64`）登入過 `user`。/ A login as `user` with this bare public key happened.
    pub fn logged_in_bare(&self, user: &str, bare: &str) -> bool {
        self.logins().iter().any(|l| l.user == user && l.bare == bare)
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
    /// pretend_windows：共用的管理員金鑰檔 `<home>/ProgramData/ssh/administrators_authorized_keys`。
    /// pretend_windows: the shared admin key file.
    pub fn admin_authorized_keys_path(&self) -> PathBuf {
        self.home.join("ProgramData/ssh/administrators_authorized_keys")
    }
    pub fn admin_authorized_keys(&self) -> String {
        std::fs::read_to_string(self.admin_authorized_keys_path()).unwrap_or_default()
    }
    /// 收到過的 pty-req（term + 初始大小）。/ PTY requests seen so far.
    pub fn ptys(&self) -> Vec<PtyState> {
        self.ptys.lock().unwrap().clone()
    }
    /// 收到過的 window-change。/ Window changes seen so far.
    pub fn resizes(&self) -> Vec<(u32, u32)> {
        self.resizes.lock().unwrap().clone()
    }
    /// pretend_darwin：後端請裝置解析過的名稱。/ Names resolved on the (fake) macOS device.
    pub fn resolves(&self) -> Vec<String> {
        self.resolves.lock().unwrap().clone()
    }
    /// 啟動過幾次 sftp 子系統（= 開過幾條 sftp channel）。/ How many sftp subsystems were started.
    pub fn sftp_starts(&self) -> usize {
        self.sftp_starts.load(Ordering::SeqCst)
    }
    /// 所有連線上現在開著幾條 session channel（裝置那端看到的）。/ Session channels open right now, all connections.
    pub fn open_sessions(&self) -> usize {
        self.open_sessions.load(Ordering::SeqCst)
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
    /// 沒有 `sftp` 子系統（像沒裝 sftp-server 的裝置）；exec 認不得的指令交給本機 `sh -c`，在機器的 home 跑。
    /// No sftp subsystem; unknown exec commands run under the local `sh -c` in the machine's home.
    pub shell_without_sftp: bool,
    /// 假裝是 macOS：`uname -s` 回 `Darwin`、`dscacheutil -q host -a name X` 在本機解析 X；
    /// 而且像 Apple 的 sshd-session 一樣，**名稱**的 direct-tcpip 讓整條連線斷掉（IP 才正常）。
    /// Pretend to be macOS, including the sshd-session crash on hostname direct-tcpip targets.
    pub pretend_darwin: bool,
    /// 像真的 tty 的 shell：印 `$ ` 提示字元、打字就回顯（退格、Ctrl+C 也照做），Enter 才「執行」：印 `ran:<指令>`
    /// 並記在 [`Machine::commands`]。指令規則要讀畫面上的那一行，所以需要回顯。
    /// A tty-like shell: a `$ ` prompt, keystrokes echoed (backspace and Ctrl+C too), and Enter "runs" the line:
    /// prints `ran:<line>` and records it in [`Machine::commands`]. Command rules read the echoed line.
    /// `later` answers 0.8 s late (a command still running when the browser drops).
    pub echo_shell: bool,
    /// 假裝是 Windows：`uname -s` 失敗（9009），`Get-LocalGroupMember` 的 PowerShell 探測印出 `<home>/ProgramData`
    /// 與 `windows_admins`；像 Win32-OpenSSH 一樣，`windows_admins` 裡的帳號**只看**共用的
    /// `<home>/ProgramData/ssh/administrators_authorized_keys`，不看自己的 `~/.ssh/authorized_keys`。
    /// Pretend to be Windows: `uname` fails, the PowerShell probe answers with `<home>/ProgramData` and
    /// `windows_admins`, and those accounts trust only the shared admin file (never their own).
    pub pretend_windows: bool,
    pub windows_admins: &'static [&'static str],
    /// 帳號的登入 shell（例如 `/bin/bash`）：exec 的 `$SHELL` 是它；要了 PTY 的 shell 請求在 PTY 裡跑**真的**這個
    /// shell（互動模式，HOME = 帳號的 `<home>/<user>`，bash 讀那裡的 `.bashrc`、zsh 讀那裡的 `.zshrc`，不讀系統的
    /// rc），所以歷史檔也寫在那裡。/ The account's login shell: exec sees it as `$SHELL`, and a shell request with a PTY
    /// runs the real thing, interactive, with HOME (and its rc file and history file) in the account's scratch home.
    pub login_shell: Option<&'static str>,
}

struct MachineState {
    name: String,
    accounts: HashMap<String, Vec<LabKey>>,
    opts: MachineOpts,
    home: PathBuf,
    logins: Arc<Mutex<Vec<Login>>>,
    /// 每次 pty-req 的 term + 初始大小。/ Every pty request seen.
    ptys: Arc<Mutex<Vec<PtyState>>>,
    /// 每次 window-change 的 (cols, rows)。/ Every window change seen.
    resizes: Arc<Mutex<Vec<(u32, u32)>>>,
    /// pretend_darwin 時被要求解析過的名稱。/ Names the backend asked the (fake) macOS device to resolve.
    resolves: Arc<Mutex<Vec<String>>>,
    /// echo_shell 真的「執行」了的指令。/ Lines the echo shell actually ran.
    commands: Arc<Mutex<Vec<String>>>,
    sftp_starts: Arc<AtomicUsize>,
    open_sessions: Arc<AtomicUsize>,
}

/// 一個 session channel 的 PTY 狀態（term + 視窗大小），`tty` 指令與 shell 的 `tty` 行會印出來。
#[derive(Clone, Debug, Default)]
pub struct PtyState {
    pub term: String,
    pub cols: u32,
    pub rows: u32,
}

struct SshdHandler {
    m: Arc<MachineState>,
    user: Option<String>,
    channels: HashMap<ChannelId, Channel<Msg>>,
    /// 這條連線上開著的 session channel。
    sessions: HashSet<ChannelId>,
    /// 每個 channel 要到的 PTY；shell 啟動後共用同一份（window_change 會改它）。
    ptys: HashMap<ChannelId, Arc<Mutex<PtyState>>>,
}

/// 連線斷了：它的 session channel 也跟著沒了。/ A dropped connection takes its session channels with it.
impl Drop for SshdHandler {
    fn drop(&mut self) {
        self.m.open_sessions.fetch_sub(self.sessions.len(), Ordering::SeqCst);
    }
}

impl SshdHandler {
    /// (金鑰名字, `type base64`)：建立時給的金鑰，或帳號家目錄 `.ssh/authorized_keys` 裡的。
    fn key_for(&self, user: &str, key: &PublicKey) -> Option<(String, String)> {
        let offered = key.to_openssh().ok()?.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
        if let Some(k) = self.m.accounts.get(user).and_then(|keys| keys.iter().find(|k| k.bare() == offered)) {
            return Some((k.name.clone(), offered));
        }
        // Windows 管理員：只有共用的管理員檔算數。/ A Windows administrator: only the shared admin file counts.
        let file = if self.m.opts.pretend_windows && self.m.opts.windows_admins.contains(&user) {
            self.m.home.join("ProgramData/ssh/administrators_authorized_keys")
        } else {
            self.m.home.join(user).join(".ssh/authorized_keys")
        };
        file_trusts(&file, &offered).then(|| (String::new(), offered))
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
        self.m.open_sessions.fetch_add(1, Ordering::SeqCst);
        self.channels.insert(id, channel);
        Ok(())
    }

    async fn channel_close(&mut self, channel: ChannelId, _session: &mut Session) -> Result<(), Self::Error> {
        if self.sessions.remove(&channel) {
            self.m.open_sessions.fetch_sub(1, Ordering::SeqCst);
        }
        self.channels.remove(&channel);
        self.ptys.remove(&channel);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(&mut self, channel: ChannelId, term: &str, cols: u32, rows: u32, _pw: u32, _ph: u32, _modes: &[(russh::Pty, u32)], session: &mut Session) -> Result<(), Self::Error> {
        self.ptys.insert(channel, Arc::new(Mutex::new(PtyState { term: term.to_string(), cols, rows })));
        self.m.ptys.lock().unwrap().push(PtyState { term: term.to_string(), cols, rows });
        session.channel_success(channel)?;
        Ok(())
    }

    async fn window_change_request(&mut self, channel: ChannelId, cols: u32, rows: u32, _pw: u32, _ph: u32, session: &mut Session) -> Result<(), Self::Error> {
        if let Some(p) = self.ptys.get(&channel) {
            let mut p = p.lock().unwrap();
            p.cols = cols;
            p.rows = rows;
            self.m.resizes.lock().unwrap().push((cols, rows));
        }
        session.channel_success(channel)?;
        Ok(())
    }

    /// shell：先印 `login:user@machine`，之後逐行處理：`tty` 印 `tty:<term> <cols>x<rows>`、`exit` 結束
    /// （exit-status 0 + 關 channel），其餘原樣 echo。沒有 PTY 的 shell 也一樣跑。
    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let Some(ch) = self.channels.remove(&channel) else { return Ok(()) };
        let pty = self.ptys.get(&channel).cloned();
        let banner = format!("login:{}@{}\r\n", self.user.clone().unwrap_or_default(), self.m.name);
        if let (Some(login), Some(pty)) = (self.m.opts.login_shell, pty.as_ref()) {
            let user = self.user.clone().unwrap_or_default();
            let home = self.m.home.join(&user);
            std::fs::create_dir_all(&home)?;
            let h = home.to_string_lossy().into_owned();
            let args: Vec<String> = match login.rsplit('/').next().unwrap_or_default() {
                "bash" => vec!["--noprofile".into(), "--rcfile".into(), format!("{h}/.bashrc"), "-i".into()],
                // -d：不讀 /etc/zshrc 這類系統 rc（macOS 那份會蓋掉 HISTFILE），只讀 ZDOTDIR 的 .zshrc。/ No global rc files.
                "zsh" => vec!["-d".into(), "-i".into()],
                _ => vec!["-i".into()],
            };
            let envs: Vec<(String, String)> = vec![
                ("HOME".into(), h.clone()),
                ("ZDOTDIR".into(), h.clone()),
                ("USER".into(), user.clone()),
                ("LOGNAME".into(), user),
                ("SHELL".into(), login.into()),
            ];
            let (cols, rows) = {
                let p = pty.lock().unwrap();
                (p.cols, p.rows)
            };
            let child = telepy_server::ssh::process::spawn_in_pty(login, &args, &envs)?;
            let _ = child.resize(rows as u16, cols as u16, 0, 0);
            tokio::spawn(async move {
                let mut child = child;
                let (mut r, mut w) = tokio::io::split(ch.into_stream());
                let (mut a, mut b) = ([0u8; 4096], [0u8; 4096]);
                loop {
                    tokio::select! {
                        n = child.read(&mut a) => match n {
                            Ok(n) if n > 0 => {
                                if w.write_all(&a[..n]).await.is_err() {
                                    break;
                                }
                            }
                            _ => break,
                        },
                        n = r.read(&mut b) => match n {
                            Ok(n) if n > 0 => {
                                let _ = child.write_nonblocking(&b[..n]);
                            }
                            _ => break,
                        },
                    }
                }
                child.terminate().await;
                let _ = w.shutdown().await;
            });
            return Ok(());
        }
        if self.m.opts.echo_shell {
            let commands = self.m.commands.clone();
            tokio::spawn(async move {
                let _ = ch.data_bytes(format!("{banner}$ ").into_bytes()).await;
                let mut s = ch.into_stream();
                let mut buf = [0u8; 4096];
                let mut line = String::new();
                'echo: while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let mut out = String::new();
                    // `later`：過一下才回（模擬還在跑的指令，斷線保留的測試用）。/ `later` answers after a pause (a running command).
                    let mut pause = false;
                    for c in String::from_utf8_lossy(&buf[..n]).chars() {
                        match c {
                            '\r' | '\n' => {
                                let cmd = std::mem::take(&mut line).trim().to_string();
                                pause |= cmd == "later";
                                out.push_str("\r\n");
                                if cmd == "exit" {
                                    let _ = s.write_all(out.as_bytes()).await;
                                    break 'echo;
                                }
                                if !cmd.is_empty() {
                                    out.push_str(&format!("ran:{cmd}\r\n"));
                                    commands.lock().unwrap().push(cmd);
                                }
                                out.push_str("$ ");
                            }
                            '\x03' => {
                                line.clear();
                                out.push_str("^C\r\n$ ");
                            }
                            '\x7f' | '\x08' => {
                                if line.pop().is_some() {
                                    out.push_str("\x08 \x08");
                                }
                            }
                            c if !c.is_control() => {
                                line.push(c);
                                out.push(c);
                            }
                            _ => {}
                        }
                    }
                    if pause {
                        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    }
                    if s.write_all(out.as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
            return Ok(());
        }
        tokio::spawn(async move {
            let _ = ch.data_bytes(banner.into_bytes()).await;
            let mut s = ch.into_stream();
            let mut buf = [0u8; 4096];
            let mut line = Vec::new();
            'outer: while let Ok(n) = s.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                for &b in &buf[..n] {
                    if b == b'\n' || b == b'\r' {
                        let cmd = String::from_utf8_lossy(&line).trim().to_string();
                        line.clear();
                        let reply = match cmd.as_str() {
                            "" => continue,
                            "exit" => break 'outer,
                            "tty" => match &pty {
                                Some(p) => {
                                    let p = p.lock().unwrap();
                                    format!("tty:{} {}x{}\r\n", p.term, p.cols, p.rows)
                                }
                                None => "tty:none\r\n".to_string(),
                            },
                            other => format!("{other}\r\n"),
                        };
                        if s.write_all(reply.as_bytes()).await.is_err() {
                            break 'outer;
                        }
                    } else {
                        line.push(b);
                    }
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
            let login_shell = self.m.opts.login_shell;
            let home = self.m.home.join(&user);
            let tmp = home.join("tmp");
            std::fs::create_dir_all(&tmp)?;
            let Some(ch) = self.channels.remove(&channel) else { return Ok(()) };
            tokio::spawn(async move {
                let mut sh = Command::new("/bin/sh");
                if let Some(login) = login_shell {
                    sh.env("SHELL", login);
                }
                // `<home>/bin` 排在 PATH 最前面：測試在那裡放假的 crontab / ssh，不會碰到開發者的。
                // `<home>/bin` goes first in PATH, so tests can stub crontab / ssh there instead of touching the developer's.
                let path = format!("{}:{}", home.join("bin").display(), std::env::var("PATH").unwrap_or_default());
                let out = sh
                    .arg("-c")
                    .arg(&cmd)
                    .current_dir(&home)
                    .env("PATH", path)
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
            "uname -s" if self.m.opts.pretend_darwin => ("Darwin\n".to_string(), String::new(), 0),
            "uname -s" if self.m.opts.pretend_windows => (String::new(), "'uname' is not recognized as an internal or external command\r\n".to_string(), 9009),
            c if self.m.opts.pretend_windows && c.contains("Get-LocalGroupMember") => {
                let members: String = self.m.opts.windows_admins.iter().map(|a| format!("{}\\{a}\r\n", self.m.name.to_uppercase())).collect();
                (format!("{}\r\n---telepy---\r\n{members}", self.m.home.join("ProgramData").display()), String::new(), 0)
            }
            c if self.m.opts.pretend_darwin && c.contains("dscacheutil -q host -a name ") => {
                let name = c.rsplit("dscacheutil -q host -a name ").next().unwrap_or_default().trim_matches('\'').to_string();
                self.m.resolves.lock().unwrap().push(name.clone());
                use std::net::ToSocketAddrs;
                let ip = (name.as_str(), 0).to_socket_addrs().ok().and_then(|mut a| a.find(|a| a.is_ipv4())).map(|a| a.ip().to_string());
                match ip {
                    Some(ip) => (format!("name: {name}\nip_address: {ip}\n"), String::new(), 0),
                    None => (String::new(), String::new(), 0),
                }
            }
            _ if self.m.opts.shell_without_sftp => {
                let o = std::process::Command::new("sh").arg("-c").arg(&cmd).current_dir(&self.m.home).env("HOME", &self.m.home).output().unwrap();
                (String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned(), o.status.code().unwrap_or(1) as u32)
            }
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
        let bin = if name == "sftp" && !self.m.opts.shell_without_sftp { sftp_server_bin() } else { None };
        let (Some(bin), Some(ch)) = (bin, self.channels.remove(&channel)) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        session.channel_success(channel)?;
        self.m.sftp_starts.fetch_add(1, Ordering::SeqCst);
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
        if self.m.opts.pretend_darwin && host_to_connect.parse::<std::net::IpAddr>().is_err() {
            // Apple sshd-session：getaddrinfo 在 fork 後的 privsep 子行程裡 abort → 整條連線斷。
            anyhow::bail!("sshd-session crashed resolving {host_to_connect}");
        }
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
    if opts.pretend_windows {
        std::fs::create_dir_all(dir.join(format!("{name}-home")).join("ProgramData/ssh")).unwrap();
    }
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
    let ptys = Arc::new(Mutex::new(Vec::new()));
    let resizes = Arc::new(Mutex::new(Vec::new()));
    let resolves = Arc::new(Mutex::new(Vec::new()));
    let commands = Arc::new(Mutex::new(Vec::new()));
    let (sftp_starts, open_sessions) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let state = Arc::new(MachineState {
        name: name.to_string(),
        accounts: accounts.iter().map(|(u, keys)| (u.to_string(), keys.iter().map(|k| (*k).clone()).collect())).collect(),
        opts,
        home: home.clone(),
        logins: logins.clone(),
        ptys: ptys.clone(),
        resizes: resizes.clone(),
        resolves: resolves.clone(),
        commands: commands.clone(),
        sftp_starts: sftp_starts.clone(),
        open_sessions: open_sessions.clone(),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (config, m) = (config.clone(), state.clone());
            tokio::spawn(async move {
                let handler = SshdHandler { m, user: None, channels: HashMap::new(), sessions: HashSet::new(), ptys: HashMap::new() };
                if let Ok(session) = server::run_stream(config, stream, handler).await {
                    let _ = session.await;
                }
            });
        }
    });
    Machine { name: name.to_string(), port, home, host_key: host_key.bare(), logins, ptys, resizes, resolves, commands, sftp_starts, open_sessions }
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
    /// 收到的指令規則通知（binary JSON frame）。/ Command-rule notices received (binary JSON frames).
    pub notices: Vec<Value>,
    /// 最近一個 `{type:"shell"}` frame（shell 代號、保留時間、補送起點）。/ The latest shell frame.
    pub shell: Option<Value>,
    /// 看過的輸出位置（UTF-16 單位，跟瀏覽器一樣算）：接回時帶 `offset`。/ Output position seen (UTF-16 units), for `offset`.
    pub offset: u64,
}

impl Terminal {
    pub async fn input(&mut self, text: &str) {
        let msg = json!({"action": "pty_input", "payload": {"input": text}});
        self.ws.send(Message::Text(msg.to_string().into())).await.unwrap();
    }

    /// 前端的 `pty_resize`。/ The front end's resize message.
    pub async fn resize(&mut self, cols: u32, rows: u32) {
        let msg = json!({"action": "pty_resize", "payload": {"size": {"rows": rows, "cols": cols, "height": rows * 16, "width": cols * 8}}});
        self.ws.send(Message::Text(msg.to_string().into())).await.unwrap();
    }

    /// 像瀏覽器關分頁：送 Close、丟掉 socket。/ Close the tab the way a browser does.
    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }

    /// 等伺服器端關閉這條連線，回關閉碼（1000 = shell 正常結束）；10 秒沒關就 panic。
    pub async fn wait_closed(&mut self) -> Option<u16> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(Message::Close(f)))) => return f.map(|f| u16::from(f.code)),
                Ok(Some(Ok(Message::Text(t)))) => self.text(&t),
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) => return None,
                Err(_) => panic!("terminal was not closed by the server; output so far: {:?}", self.seen),
            }
        }
    }

    /// 像開著但沒在打字的分頁：持續讀（自動回伺服器的 Ping）`d` 這麼久，什麼都不送；途中被關掉就 panic。
    /// An open tab nobody types in: keep reading (answering the server's pings) for `d`, sending nothing.
    pub async fn idle(&mut self, d: Duration) {
        let deadline = tokio::time::Instant::now() + d;
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Err(_) => return,
                Ok(Some(Ok(Message::Text(t)))) => self.text(&t),
                Ok(Some(Ok(Message::Close(_)))) | Ok(Some(Err(_))) | Ok(None) => panic!("an idle but live terminal was closed by the server"),
                Ok(Some(Ok(_))) => {}
            }
        }
    }

    /// `{action:"ping"}` → 伺服器回 **binary** `pong`（前端把 text frame 全寫進 xterm）。中間的 PTY 輸出照收。
    pub async fn ping(&mut self) -> bool {
        self.ws.send(Message::Text(json!({"action": "ping"}).to_string().into())).await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(Message::Binary(b)))) => return &b[..] == b"pong",
                Ok(Some(Ok(Message::Text(t)))) => self.text(&t),
                Ok(Some(Ok(_))) => {}
                _ => return false,
            }
        }
    }

    /// 收一則 binary frame：pong、shell frame，其餘是指令規則通知。/ A binary frame: a pong, the shell frame, or a command notice.
    fn binary(&mut self, b: &[u8]) {
        if b != b"pong" {
            if let Ok(v) = serde_json::from_slice::<Value>(b) {
                if v["type"] == "shell" {
                    self.offset = v["offset"].as_u64().unwrap_or(0);
                    self.shell = Some(v);
                } else {
                    self.notices.push(v);
                }
            }
        }
    }

    /// 一則 PTY 輸出。/ One PTY output frame.
    fn text(&mut self, t: &str) {
        self.seen.push_str(t);
        self.offset += t.encode_utf16().count() as u64;
    }

    /// 這個 shell 的代號（auth 之後第一個 frame）。/ This shell's id (the first frame after auth).
    pub fn shell_id(&self) -> String {
        self.shell.as_ref().and_then(|s| s["id"].as_str()).expect("no shell frame").to_string()
    }

    /// 保留時間與決定它的那一層。/ The grace time and the layer that decided it.
    pub fn detach(&self) -> (u64, String) {
        let d = &self.shell.as_ref().expect("no shell frame")["detach"];
        (d["secs"].as_u64().unwrap(), d["by"].as_str().unwrap().to_string())
    }

    /// 明確結束（關分頁）：送 `{action:"end"}`，伺服器立刻收掉 shell。/ An explicit end, the way closing a tab does.
    pub async fn end(mut self) {
        let _ = self.ws.send(Message::Text(json!({"action": "end"}).to_string().into())).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), async { while let Some(Ok(m)) = self.ws.next().await { if matches!(m, Message::Close(_)) { break; } } }).await;
    }

    /// 像網路斷掉：不送 Close，直接丟掉 TCP 連線。/ Like a dropped network: no close frame, the TCP connection just goes.
    pub fn drop_connection(self) {
        drop(self);
    }

    /// 等一則 `state` 的指令規則通知（10 秒逾時），取走並回傳它。/ Wait for a command notice with this `state` and take it.
    pub async fn expect_notice(&mut self, state: &str) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(i) = self.notices.iter().position(|n| n["state"] == state) {
                return self.notices.remove(i);
            }
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => self.text(&t),
                Ok(Some(Ok(Message::Binary(b)))) => self.binary(&b),
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
                Ok(other) => panic!("terminal ended before a {state:?} notice: {other:?}; output so far: {:?}", self.seen),
                Err(_) => panic!("timed out waiting for a {state:?} notice; notices {:?}; output so far: {:?}", self.notices, self.seen),
            }
        }
    }

    /// 送一則 JSON（看別人終端機的 `control`、被看的人的 `watch_answer` …）。/ Send one JSON message.
    pub async fn send_json(&mut self, v: Value) {
        self.ws.send(Message::Text(v.to_string().into())).await.unwrap();
    }

    /// 等一則符合條件的 binary JSON frame（10 秒逾時），取走並回傳它。/ Wait for a binary JSON frame that matches, and take it.
    pub async fn expect_frame(&mut self, what: &str, ok: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(i) = self.notices.iter().position(&ok) {
                return self.notices.remove(i);
            }
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => self.text(&t),
                Ok(Some(Ok(Message::Binary(b)))) => self.binary(&b),
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
                Ok(other) => panic!("socket ended before {what}: {other:?}; frames {:?}", self.notices),
                Err(_) => panic!("timed out waiting for {what}; frames {:?}; output so far: {:?}", self.notices, self.seen),
            }
        }
    }

    /// 等伺服器關閉，回 (關閉碼, 原因)。/ Wait for the server to close; returns (code, reason).
    pub async fn wait_closed_reason(&mut self) -> Option<(u16, String)> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(Message::Close(f)))) => return f.map(|f| (u16::from(f.code), f.reason.to_string())),
                Ok(Some(Ok(Message::Text(t)))) => self.text(&t),
                Ok(Some(Ok(Message::Binary(b)))) => self.binary(&b),
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) => return None,
                Err(_) => panic!("socket was not closed by the server; output so far: {:?}", self.seen),
            }
        }
    }

    /// 讀 PTY 輸出直到出現 `needle`（10 秒逾時）。
    pub async fn expect(&mut self, needle: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !self.seen.contains(needle) {
            let frame = tokio::time::timeout_at(deadline, self.ws.next()).await;
            match frame {
                Ok(Some(Ok(Message::Text(t)))) => self.text(&t),
                Ok(Some(Ok(Message::Binary(b)))) => self.binary(&b),
                // 伺服器心跳的 Ping（tungstenite 讀的時候自動回 Pong）。/ Server heartbeat pings, answered on read.
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
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
        Self::start_with(|_| {}).await
    }

    /// 同 [`Lab::start`]，但 gateway 啟動前可以先改設定（例如 PROXY protocol）。/ Same, with a config hook before the gateway starts.
    pub async fn start_with(customize: impl FnOnce(&mut telepy_server::config::Config)) -> Option<Lab> {
        if !have("ssh") || !have("ssh-keygen") {
            eprintln!("skipping: ssh / ssh-keygen not available");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        keygen(dir.path(), "ssh_host_ed25519_key");
        let service = keygen(dir.path(), "service");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gw_port = listener.local_addr().unwrap().port();

        // 後端的 OpenSSH（只剩區網主機那一跳）：不讀開發者的 ~/.ssh、只用服務金鑰。
        // The backend's OpenSSH client (only the LAN hop now): no developer ~/.ssh, only the service key.
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
        customize(&mut config);
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

    /// 改設定並重建 state / router（gateway 與 DB 保留）。在開任何 WebSocket 之前呼叫。
    /// Change config and rebuild state + router (the gateway and DB stay). Call before opening any WebSocket.
    pub fn reconfigure(&mut self, f: impl FnOnce(&mut telepy_server::config::Config)) {
        assert!(self.ws_base.get().is_none(), "reconfigure before the first WebSocket");
        let mut config = self.app.state.config.clone();
        f(&mut config);
        let gateway = self.app.state.gateway.clone();
        let status = self.app.state.status.clone();
        let presence = self.app.state.presence.clone();
        let db = self.app.state.db.clone();
        self.app.state = telepy_server::state::AppState::with_gateway(config, db, gateway, status, presence);
        self.app.router = telepy_server::app::build(self.app.state.clone());
    }

    /// 直接在 DB 建帳號並簽 access token（不走註冊 / 登入：debug build 的 pbkdf2 一百萬次要好幾秒）。
    async fn account(&self, name: &str) -> (i64, String) {
        let u = db::users::create(&self.app.state.db, db::users::NewUser { username: name, password_hash: "!", email: "", first_name: "", last_name: "" }).await.unwrap();
        (u.id, self.app.state.jwt.access(u.id, std::time::Duration::from_secs(3600)))
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
        let key = self.keygen(&format!("{name}-tunnel-{}", next_id())); // 流水號：macOS 不分大小寫（MyBox / mybox）。/ Counter: macOS ignores case.
        let reverse_port = free_port();
        let t = db::tunnels::create(
            &self.app.state.db,
            db::tunnels::NewTunnel { user_id: owner.id, host_friendly_name: name, key: &key.public, reverse_port: reverse_port as i64, description: None, default_username_id: None },
        )
        .await
        .unwrap();
        // 和正式的建立一樣：隧道自己的服務金鑰馬上產生。/ Like the real create: the tunnel's own service key exists at once.
        telepy_server::ssh::tunnel_keys::ensure(&self.app.state, t.id).await.unwrap();
        let ssh = self.spawn_tunnel(&key, reverse_port, target.port, name).await;
        self.tunnels.lock().unwrap().insert(t.id, ssh);
        Device { tunnel_id: t.id, name: name.to_string(), reverse_port, target: target.clone(), key }
    }

    /// 建隧道，但裝置的 `ssh -NR` 連到 `gw_port`（例如 WebSocket 橋）而不是 gateway 的 listener。
    /// Create a tunnel whose device dials `gw_port` (e.g. a WebSocket bridge) instead of the gateway listener.
    pub async fn device_via_port(&self, owner: &LabUser, name: &str, target: &Machine, gw_port: u16, extra_opts: &[String]) -> Device {
        let key = self.keygen(&format!("{name}-tunnel-{}", next_id())); // 流水號：macOS 不分大小寫（MyBox / mybox）。/ Counter: macOS ignores case.
        let reverse_port = free_port();
        let t = db::tunnels::create(
            &self.app.state.db,
            db::tunnels::NewTunnel { user_id: owner.id, host_friendly_name: name, key: &key.public, reverse_port: reverse_port as i64, description: None, default_username_id: None },
        )
        .await
        .unwrap();
        telepy_server::ssh::tunnel_keys::ensure(&self.app.state, t.id).await.unwrap();
        let mut opts: Vec<String> = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"].map(String::from).to_vec();
        opts.extend(extra_opts.iter().cloned());
        let ssh = self.spawn_tunnel_to(&key, reverse_port, target.port, name, gw_port, &opts).await;
        self.tunnels.lock().unwrap().insert(t.id, ssh);
        Device { tunnel_id: t.id, name: name.to_string(), reverse_port, target: target.clone(), key }
    }

    /// 建隧道，但裝置的 `-R` 要求別的號碼（0 = 讓伺服器挑）。/ A tunnel whose device asks for another number (0 = server picks).
    pub async fn device_requesting(&self, owner: &LabUser, name: &str, target: &Machine, requested: u16) -> Device {
        let key = self.keygen(&format!("{name}-tunnel-{}", next_id())); // 流水號：macOS 不分大小寫（MyBox / mybox）。/ Counter: macOS ignores case.
        let reverse_port = free_port();
        let t = db::tunnels::create(
            &self.app.state.db,
            db::tunnels::NewTunnel { user_id: owner.id, host_friendly_name: name, key: &key.public, reverse_port: reverse_port as i64, description: None, default_username_id: None },
        )
        .await
        .unwrap();
        telepy_server::ssh::tunnel_keys::ensure(&self.app.state, t.id).await.unwrap();
        let no_pin = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"].map(String::from);
        let ssh = self.spawn_tunnel_requesting(&key, requested, reverse_port, target.port, name, self.gw_port, &no_pin).await;
        self.tunnels.lock().unwrap().insert(t.id, ssh);
        Device { tunnel_id: t.id, name: name.to_string(), reverse_port, target: target.clone(), key }
    }

    /// 筆電的 ssh config，裝置區塊用隧道名稱（新的產生形式）而不是 `localhost:<號碼>`。
    /// A laptop config whose device stanza names the tunnel (the generated form) instead of `localhost:<number>`.
    pub fn laptop_config_named(&self, user: &LabUser, device: &Device, os_user: &str) -> PathBuf {
        let path = self.dir.path().join(format!("{}-named-{}.conf", user.username, next_id()));
        let cfg = format!(
            "Host telepy-ssh-server\n    HostName 127.0.0.1\n    Port {}\n    User telepy\n\nHost hop0\n    HostName {}\n    Port 22\n    User {os_user}\n    ProxyCommand ssh -F {} -W %h:%p telepy-ssh-server\n\n{}",
            self.gw_port,
            device.name,
            path.display(),
            laptop_defaults(&user.key)
        );
        std::fs::write(&path, cfg).unwrap();
        path
    }

    /// 這條隧道自己的服務公鑰（`type base64 comment`）。/ The tunnel's own service public key.
    pub async fn tunnel_service_key(&self, device: &Device) -> String {
        telepy_server::ssh::tunnel_keys::ensure(&self.app.state, device.tunnel_id).await.unwrap()
    }

    /// 像裝置上的 `authorized_keys` 已經有這條隧道的服務金鑰（精靈 / 一鍵加入做的事）。
    /// As if the device's authorized_keys already held the tunnel's own key (what the wizard / join do).
    pub async fn trust_tunnel_key(&self, device: &Device, account: &str) {
        let line = self.tunnel_service_key(device).await;
        let dir = device.target.account_home(account).join(".ssh");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("authorized_keys");
        let mut content = std::fs::read_to_string(&path).unwrap_or_default();
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&line);
        content.push('\n');
        std::fs::write(&path, content).unwrap();
    }

    /// 裝置斷線（殺掉它的 `ssh -NR`），等到 forward 釋放。/ Drop the device's tunnel and wait for the release.
    pub async fn disconnect_device(&self, device: &Device) {
        let old = self.tunnels.lock().unwrap().remove(&device.tunnel_id);
        if let Some(mut c) = old {
            let _ = c.kill().await;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while self.app.state.status.listen_ports().map(|p| p.contains(&device.reverse_port)).unwrap_or(false) {
            assert!(tokio::time::Instant::now() < deadline, "device {}: forward never released", device.name);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 裝置斷線再連回來（同一把金鑰、同一個 port），等到新的 forward 註冊好。
    pub async fn reconnect_device(&self, device: &Device) {
        self.disconnect_device(device).await;
        let ssh = self.spawn_tunnel(&device.key, device.reverse_port, device.target.port, &device.name).await;
        self.tunnels.lock().unwrap().insert(device.tunnel_id, ssh);
    }

    /// 在隧道的區網主機表手動加一台（#20），回 host id。/ Add a LAN host behind the device; returns its id.
    pub async fn lan_host(&self, as_user: &LabUser, device: &Device, address: &str, ssh_port: u16, username: Option<&str>) -> i64 {
        let r = self
            .app
            .post(&format!("/api/reverse/server/{}/lan/hosts", device.tunnel_id), Some(&as_user.token), json!({"address": address, "ssh_port": ssh_port, "username": username}))
            .await;
        assert!(r.status.is_success(), "lan host: {}", r.text);
        r.json["id"].as_i64().unwrap()
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
        self.spawn_tunnel_to(key, reverse_port, target_port, name, self.gw_port, host_key_opts).await
    }

    /// 同上，但連到指定的 port（例如一個把 TCP 轉進 /ws/gateway/ 的橋）。/ Same, dialling a given port (e.g. a WebSocket bridge).
    pub async fn spawn_tunnel_to(&self, key: &LabKey, reverse_port: u16, target_port: u16, name: &str, gw_port: u16, host_key_opts: &[String]) -> Child {
        self.spawn_tunnel_requesting(key, reverse_port, reverse_port, target_port, name, gw_port, host_key_opts).await
    }

    /// 裝置在 `-R` 要求 `requested`（可以是 0 或別的號碼）、連到 `gw_port`；gateway 以金鑰認隧道，forward 記在 `expected` 下。
    /// The device asks for `requested` in `-R` (0 or any number) on `gw_port`; the gateway identifies the tunnel by key
    /// and registers the forward under `expected`.
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_tunnel_requesting(&self, key: &LabKey, requested: u16, expected: u16, target_port: u16, name: &str, gw_port: u16, host_key_opts: &[String]) -> Child {
        let reverse_port = expected;
        let mut ssh = Command::new("ssh")
            .args(["-F", "/dev/null", "-N"])
            .args(host_key_opts)
            .args(["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
            .args(["-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=5", "-o", "LogLevel=ERROR", "-i"])
            .arg(&key.path)
            .args(["-p", &gw_port.to_string(), "-R", &format!("*:{requested}:127.0.0.1:{target_port}"), "telepy@127.0.0.1"])
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
        let server_alias = r.json["server"]["alias"].as_str().unwrap().to_string();
        let alias = generated.lines().filter_map(|l| l.trim().strip_prefix("Host ")).map(str::trim).filter(|h| *h != server_alias).next_back().unwrap().to_string();
        let path = self.write_ssh_config(user, &device.name, &generated, r.json["known_hosts"].as_str().unwrap_or_default());
        (path, alias)
    }

    /// 把 API 給的 config 存進 lab 目錄（`<user>-<name>-generated.conf`）：ProxyCommand 的 ssh 指到同一個檔、
    /// known_hosts 存在旁邊（`<user>-<name>-known_hosts`，絕不碰開發者的 ~/.ssh），再補上金鑰預設值。
    /// Save a config the API produced into the lab dir: ProxyCommand's ssh reads the same file, the known_hosts sits
    /// next to it (never the developer's ~/.ssh), plus the key defaults.
    pub fn write_ssh_config(&self, user: &LabUser, name: &str, generated: &str, known_hosts: &str) -> PathBuf {
        // 檔名只留安全字元：舊名稱可能有空白，而 `ProxyCommand ssh -F <路徑>` 不能有空白。
        // Safe characters only: an older name may hold spaces, and `ProxyCommand ssh -F <path>` can't.
        let name = file_safe(name);
        let path = self.dir.path().join(format!("{}-{name}-generated.conf", user.username));
        let known = self.dir.path().join(format!("{}-{name}-known_hosts", user.username));
        std::fs::write(&known, known_hosts).unwrap();
        let patched = generated
            .replace("ProxyCommand ssh -W", &format!("ProxyCommand ssh -F {} -W", path.display()))
            .replace("UserKnownHostsFile ~/.ssh/telepy_known_hosts", &format!("UserKnownHostsFile {}", known.display()));
        std::fs::write(&path, format!("{patched}\n{}", laptop_defaults(&user.key))).unwrap();
        path
    }

    /// `generated_ssh_config` 存下的 known_hosts 檔。/ The known_hosts file `generated_ssh_config` wrote.
    pub fn generated_known_hosts(&self, user: &LabUser, device: &Device) -> PathBuf {
        self.dir.path().join(format!("{}-{}-known_hosts", user.username, file_safe(&device.name)))
    }

    pub async fn ssh_with_config(&self, config: &Path, host: &str, cmd: &str) -> Run {
        run(Command::new("ssh").arg("-F").arg(config).arg(host).arg(cmd)).await
    }

    /// 真的 HTTP listener（WebSocket 測試用），第一次呼叫時起；與正式環境一樣帶 ConnectInfo（來源 IP）。
    pub async fn ws_base(&self) -> String {
        self.ws_base
            .get_or_init(|| async {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let router = self.app.router.clone();
                tokio::spawn(async move { axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap() });
                format!("ws://{addr}")
            })
            .await
            .clone()
    }

    /// 檔案管理（`/ws/filemanager/`）：送 auth，再送一個 action，回第一個 JSON 回應（Telepy 拒絕時回關閉碼）。
    pub async fn filemanager(&self, user: &LabUser, device: &Device, os_user: &str, action: Value) -> Result<Value, u16> {
        self.filemanager_with(user, device, os_user, json!({}), action).await
    }

    /// 同上，auth 訊息多帶 `extra` 的欄位（例如 `step_up`）。/ Same, with extra auth-message fields.
    pub async fn filemanager_with(&self, user: &LabUser, device: &Device, os_user: &str, extra: Value, action: Value) -> Result<Value, u16> {
        let base = self.ws_base().await;
        let (mut ws, _) = connect_async(format!("{base}/ws/filemanager/")).await.unwrap();
        let mut auth = json!({"type": "auth", "token": user.token, "server_id": device.tunnel_id.to_string(), "username": os_user});
        if let (Some(a), Some(e)) = (auth.as_object_mut(), extra.as_object()) {
            a.extend(e.clone());
        }
        ws.send(Message::Text(auth.to_string().into())).await.unwrap();
        ws.send(Message::Text(action.to_string().into())).await.unwrap();
        loop {
            match tokio::time::timeout(Duration::from_secs(15), ws.next()).await.expect("no file manager frame") {
                Some(Ok(Message::Close(Some(f)))) => return Err(u16::from(f.code)),
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v.get("type").is_none() {
                        return Ok(v);
                    }
                }
                Some(Ok(_)) => {}
                other => panic!("file manager socket ended: {other:?}"),
            }
        }
    }

    /// 網頁終端機：Telepy 拒絕（權限 / 帳號不允許）時回關閉碼；否則回已開始的終端機。
    pub async fn terminal(&self, user: &LabUser, device: &Device, os_user: &str) -> Result<Terminal, u16> {
        self.terminal_with(user, device, os_user, json!({})).await
    }

    /// 同上，auth 訊息多帶 `extra` 的欄位（例如 `lan_host_id`）。/ Same, with extra auth-message fields.
    pub async fn terminal_with(&self, user: &LabUser, device: &Device, os_user: &str, extra: Value) -> Result<Terminal, u16> {
        let base = self.ws_base().await;
        let (mut ws, _) = connect_async(format!("{base}/ws/terminal/")).await.unwrap();
        let mut auth = json!({"type": "auth", "token": user.token, "server_id": device.tunnel_id.to_string(), "username": os_user});
        if let (Some(a), Some(e)) = (auth.as_object_mut(), extra.as_object()) {
            a.extend(e.clone());
        }
        ws.send(Message::Text(auth.to_string().into())).await.unwrap();
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("no terminal frame") {
            Some(Ok(Message::Close(Some(f)))) => Err(u16::from(f.code)),
            Some(Ok(Message::Text(t))) => {
                let mut term = Terminal { ws, seen: String::new(), notices: Vec::new(), shell: None, offset: 0 };
                term.text(&t);
                Ok(term)
            }
            Some(Ok(Message::Binary(b))) => {
                let mut term = Terminal { ws, seen: String::new(), notices: Vec::new(), shell: None, offset: 0 };
                term.binary(&b);
                Ok(term)
            }
            Some(Ok(_)) => Ok(Terminal { ws, seen: String::new(), notices: Vec::new(), shell: None, offset: 0 }),
            other => panic!("terminal socket ended: {other:?}"),
        }
    }
}

impl Lab {
    /// 看別人的網頁終端機（`/ws/terminal-watch/{shell}/`）；第一個 frame 是 `{type:"watch"}`（放在 `notices`）。
    /// Watch someone's web terminal; the first frame (`{type:"watch"}`) lands in `notices`.
    pub async fn watch(&self, user: &LabUser, shell_id: &str) -> Result<Terminal, u16> {
        let base = self.ws_base().await;
        let (mut ws, _) = connect_async(format!("{base}/ws/terminal-watch/{shell_id}/")).await.unwrap();
        ws.send(Message::Text(json!({"type": "auth", "token": user.token}).to_string().into())).await.unwrap();
        let mut term = Terminal { ws, seen: String::new(), notices: Vec::new(), shell: None, offset: 0 };
        loop {
            match tokio::time::timeout(Duration::from_secs(10), term.ws.next()).await.expect("no watch frame") {
                Some(Ok(Message::Close(Some(f)))) => return Err(u16::from(f.code)),
                Some(Ok(Message::Binary(b))) => {
                    term.binary(&b);
                    return Ok(term);
                }
                Some(Ok(Message::Text(t))) => term.text(&t),
                Some(Ok(_)) => {}
                other => panic!("watch socket ended: {other:?}"),
            }
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
