//! 區網主機的檔案管理：經裝置開一條 direct-tcpip（裝置的 sshd 去連那台主機的 SSH），在上面用 russh 登入那台主機、開
//! SFTP。一次登入 = 一個「區網檔案 session」（`~<代號>`，屬於開它的人、綁這條隧道與這個裝置帳號），檔案管理的 REST 與
//! WebSocket 把它放在原本帳號的位置（`/api/sftp/<op>/<隧道>/~<代號>`；合法的帳號名稱不會有 `~`），所以每個操作都照
//! 原樣跑在那台主機上——複製的 `cp -R`、存檔的 posix-rename 也是開在那台主機的連線上，不會碰到裝置。
//! 登入那台主機：Telepy 的金鑰（這條隧道的服務金鑰、再來是共用的）、憑證庫的 ssh 登入（金鑰和 / 或密碼）或當下輸入的
//! 密碼（只拿來登入，不存）；密碼也會試 keyboard-interactive。那台主機的 host key 跟區網終端機那一跳一樣不鎖定，但記下
//! 指紋給人看。閒置 `IDLE` 就關；每個人最多 `MAX_PER_USER` 個（最舊的先關）。
//! The LAN host file manager: a direct-tcpip channel from the device (its sshd dials the host's SSH), russh logs in
//! to the host over it and opens SFTP. One login = one "LAN file session" (`~<token>`, owned by whoever opened it, bound
//! to this tunnel and device account); the file manager's REST and WebSocket put it where the account goes
//! (`/api/sftp/<op>/<tunnel>/~<token>`; valid account names never contain `~`), so every operation runs unchanged on
//! that host — copy's `cp -R` and the save's posix-rename open their channels on the host's connection, never the
//! device. Logins: Telepy's keys (the tunnel's service key, then the shared one), a saved ssh login (key and / or
//! password) or a password typed now (used to log in, never stored); passwords also try keyboard-interactive. Like the
//! LAN terminal's hop, the host key isn't pinned, but its fingerprint is kept and shown. Idle sessions close after
//! `IDLE`; at most `MAX_PER_USER` per person (the oldest closes).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use dashmap::DashMap;
use russh::client::{self, Handle, Handler, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::Channel;
use russh_sftp::client::SftpSession;

use crate::db::lan::LanHost;
use crate::db::tunnels::Tunnel;
use crate::ssh::device::{open_sftp, start_sftp_watched};
use crate::ssh::pool::Lease;
use crate::ssh::sftp_watch::Watch;
use crate::state::AppState;

/// 閒置這麼久就關。/ Idle sessions close after this long.
pub const IDLE: Duration = Duration::from_secs(10 * 60);
pub const MAX_PER_USER: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
/// 區網檔案 session 的代號開頭（放在 URL 的帳號位置）。/ The session id's prefix (it goes where the account goes).
pub const PREFIX: char = '~';

/// 那台主機不收這個登入（API 回 `lan_files_login`，網頁改問密碼）。/ The host refused the login.
#[derive(Debug)]
pub struct LoginRefused(pub String);

impl std::fmt::Display for LoginRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LoginRefused {}

/// 那台主機沒有 SFTP（`sftp-server`）。/ The host has no SFTP subsystem.
#[derive(Debug)]
pub struct NoSftp;

impl std::fmt::Display for NoSftp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the LAN host has no SFTP (its sshd has no sftp subsystem)")
    }
}

impl std::error::Error for NoSftp {}

/// 怎麼登入那台主機。/ How to log in to the host.
pub enum HostLogin {
    Telepy,
    Password(String),
    Credential { private_key: String, password: String },
}

/// 記下那台主機出示的 host key 指紋（不鎖定，跟區網終端機那一跳一樣）。/ Records the host's key fingerprint (not pinned).
struct Seen {
    fingerprint: Arc<Mutex<String>>,
}

impl Handler for Seen {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        *self.fingerprint.lock().unwrap() = crate::ssh::host_keys::key_info(key).fingerprint;
        Ok(true)
    }
}

pub struct LanFiles {
    pub id: String,
    pub user_id: i64,
    pub tunnel_id: i64,
    pub reverse_port: i64,
    /// 經過的裝置帳號。/ The device account it goes through.
    pub account: String,
    pub host_id: i64,
    pub address: String,
    pub ssh_port: u16,
    pub login: String,
    /// 怎麼登入的（給事件紀錄）。/ How it logged in (for the events).
    pub auth_note: String,
    pub fingerprint: String,
    /// 開它的人（事件用）。/ Who opened it (for the events).
    pub by: String,
    /// 誰開的：`web`（網頁 / CLI 的 REST）或 MCP 的那個憑證；agent 只重用自己開的。
    /// Opened by: `web` (the web / CLI REST) or an MCP credential; an agent only reuses its own.
    pub opener: String,
    pub opened: Instant,
    handle: Handle<Seen>,
    shared: SftpSession,
    watch: Arc<Watch>,
    last_used: Mutex<Instant>,
    _lease: Lease,
}

impl LanFiles {
    fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        self.last_used.lock().unwrap().elapsed()
    }

    /// 一條新的 session channel（exec、raw sftp），開在那台主機的連線上。/ A fresh session channel on the host's connection.
    pub async fn session_channel(&self) -> anyhow::Result<Channel<client::Msg>> {
        self.touch();
        Ok(self.handle.channel_open_session().await?)
    }

    /// 大量傳輸用的 SFTP：自己的 channel，請求時限跟裝置那邊一樣長。/ SFTP for a bulk transfer: its own channel.
    pub async fn bulk_sftp(&self) -> anyhow::Result<SftpSession> {
        let ch = open_sftp(self.session_channel().await?).await.context("the LAN host has no sftp subsystem")?;
        let cfg = russh_sftp::client::Config { request_timeout_secs: crate::ssh::pool::BULK_REQUEST_TIMEOUT, ..Default::default() };
        SftpSession::new_with_config(ch.into_stream(), cfg).await.context("start SFTP on the LAN host")
    }

    pub fn closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// 共用那條 SFTP 還能用（沒關、沒卡住）。/ The shared SFTP channel still works.
    pub fn healthy(&self) -> bool {
        !self.closed() && self.watch.healthy()
    }

    pub async fn close(&self) {
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "closed", "en").await;
    }
}

/// 借來的共用 SFTP（drop 什麼都不做，session 留著）。/ A handle on the session's shared SFTP channel.
#[derive(Clone)]
pub struct LanSftp(pub Arc<LanFiles>);

impl LanFiles {
    /// 共用那條 SFTP（MCP 工具直接用）。/ The shared SFTP channel (the MCP tool uses it directly).
    pub fn shared(&self) -> &SftpSession {
        self.touch();
        &self.shared
    }
}

impl std::ops::Deref for LanSftp {
    type Target = SftpSession;
    fn deref(&self) -> &SftpSession {
        self.0.touch();
        &self.0.shared
    }
}

/// 自己一條 channel 的 SFTP，session 活到它用完。/ An own-channel SFTP that keeps its session alive.
pub struct LanBulkSftp {
    pub sftp: SftpSession,
    _files: Arc<LanFiles>,
}

impl std::ops::Deref for LanBulkSftp {
    type Target = SftpSession;
    fn deref(&self) -> &SftpSession {
        &self.sftp
    }
}

pub async fn bulk(files: Arc<LanFiles>) -> anyhow::Result<LanBulkSftp> {
    let sftp = files.bulk_sftp().await?;
    Ok(LanBulkSftp { sftp, _files: files })
}

#[derive(Default)]
pub struct LanFileSessions {
    map: DashMap<String, Arc<LanFiles>>,
}

impl LanFileSessions {
    /// 這個人的這個 session（別人的、關掉的 = None）。/ This person's session (someone else's or a closed one = None).
    pub fn get(&self, id: &str, user_id: i64) -> Option<Arc<LanFiles>> {
        let s = self.map.get(id)?.clone();
        if s.user_id != user_id || s.closed() {
            return None;
        }
        s.touch();
        Some(s)
    }

    /// 放進來；這個人已經有 `MAX_PER_USER` 個時回傳要關掉的（最久沒用的）。/ Add it; returns the ones to close.
    fn insert(&self, s: Arc<LanFiles>) -> Vec<Arc<LanFiles>> {
        let mut mine: Vec<Arc<LanFiles>> = self.map.iter().filter(|e| e.user_id == s.user_id).map(|e| e.value().clone()).collect();
        mine.sort_by_key(|x| std::cmp::Reverse(x.idle_for()));
        let mut evicted = Vec::new();
        while mine.len() >= MAX_PER_USER {
            let old = mine.remove(0);
            self.map.remove(&old.id);
            evicted.push(old);
        }
        self.map.insert(s.id.clone(), s);
        evicted
    }

    pub fn all(&self) -> Vec<Arc<LanFiles>> {
        self.map.iter().map(|e| e.value().clone()).collect()
    }

    /// 拿掉閒置或斷掉的，回傳它們（呼叫端 `finish`）。/ Take out idle or broken sessions (the caller finishes them).
    fn take_idle(&self, idle: Duration) -> Vec<Arc<LanFiles>> {
        let gone: Vec<String> = self.map.iter().filter(|e| e.closed() || e.idle_for() >= idle).map(|e| e.key().clone()).collect();
        gone.iter().filter_map(|id| self.map.remove(id).map(|(_, s)| s)).collect()
    }

    /// 這個開啟者已經開著、能用的同一個目標（主機、登入、裝置帳號）。/ An open, healthy session of this opener to the same target.
    pub fn find(&self, user_id: i64, opener: &str, host_id: i64, login: &str, account: &str) -> Option<Arc<LanFiles>> {
        let s = self.map.iter().find(|e| e.user_id == user_id && e.opener == opener && e.host_id == host_id && e.login == login && e.account == account && e.healthy())?.value().clone();
        s.touch();
        Some(s)
    }

    fn take(&self, id: &str) -> Option<Arc<LanFiles>> {
        self.map.remove(id).map(|(_, s)| s)
    }
}

/// 檔案管理 URL 帳號位置上的值是不是區網檔案 session。/ Whether the account segment is a LAN file session id.
pub fn is_session_id(s: &str) -> bool {
    s.starts_with(PREFIX)
}

async fn try_key(handle: &mut Handle<Seen>, user: &str, key: Arc<PrivateKey>) -> anyhow::Result<bool> {
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    Ok(handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(key, hash)).await?.success())
}

/// 密碼：先 password，不收就 keyboard-interactive（每個提示都回這個密碼，最多三輪）。
/// A password: `password` first, then keyboard-interactive (the password for every prompt, at most three rounds).
async fn try_password(handle: &mut Handle<Seen>, user: &str, password: &str) -> anyhow::Result<bool> {
    if handle.authenticate_password(user, password).await?.success() {
        return Ok(true);
    }
    let mut r = handle.authenticate_keyboard_interactive_start(user, None).await?;
    for _ in 0..3 {
        match r {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                r = handle.authenticate_keyboard_interactive_respond(prompts.iter().map(|_| password.to_string()).collect()).await?;
            }
        }
    }
    Ok(false)
}

async fn authenticate(state: &AppState, handle: &mut Handle<Seen>, tunnel_id: i64, login: &str, how: &HostLogin) -> anyhow::Result<bool> {
    match how {
        HostLogin::Telepy => {
            if let Some(key) = crate::ssh::tunnel_keys::private(state, tunnel_id).await {
                if try_key(handle, login, key).await? {
                    return Ok(true);
                }
            }
            if let Ok(shared) = crate::ssh::device::load_identity(&state.config.ssh_identity).await {
                if try_key(handle, login, shared).await? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        HostLogin::Password(pw) => try_password(handle, login, pw).await,
        HostLogin::Credential { private_key, password } => {
            if !private_key.is_empty() {
                let key = russh::keys::decode_secret_key(private_key, None).context("the saved private key can't be read")?;
                if try_key(handle, login, Arc::new(key)).await? {
                    return Ok(true);
                }
            }
            if !password.is_empty() {
                return try_password(handle, login, password).await;
            }
            Ok(false)
        }
    }
}

/// 打開一個區網檔案 session。呼叫端已檢查權限（VIEW、帳號、功能、step-up）。
/// Open a LAN file session; the caller has checked access (VIEW, account, features, step-up).
#[allow(clippy::too_many_arguments)]
pub async fn open(state: &AppState, user: &crate::db::users::User, t: &Tunnel, account: &str, host: &LanHost, login: &str, how: HostLogin, auth_note: String, opener: &str) -> anyhow::Result<Arc<LanFiles>> {
    let run = async {
        let port = u16::try_from(host.ssh_port).context("invalid SSH port")?;
        let lease = state.pool.acquire(state, t.reverse_port, account).await.with_context(|| format!("cannot log in to the device as {account}"))?;
        // 名稱先在裝置上解析（macOS 的 sshd 不能收名稱）。/ Names resolve on the device first (macOS sshd can't take a name).
        let target = crate::ssh::resolve::Resolver::default().target(state, &lease, &host.address).await.context("cannot resolve the LAN host on the device")?;
        let channel = lease.device().channel_open_direct_tcpip(target.as_str(), u32::from(port), "127.0.0.1", 0).await.with_context(|| format!("the device could not reach {}:{port}", host.address))?;
        let fingerprint = Arc::new(Mutex::new(String::new()));
        let config = Arc::new(client::Config { keepalive_interval: Some(Duration::from_secs(15)), keepalive_max: 3, ..Default::default() });
        let mut handle = client::connect_stream(config, channel.into_stream(), Seen { fingerprint: fingerprint.clone() }).await.context("ssh handshake with the LAN host")?;
        // 登入途中斷線（太多次嘗試、sshd 不讓這個帳號登入）也算拒絕：握手已經通了，是那台不收。
        // A disconnect during the login (too many tries, an sshd that won't take this account) is a refusal too.
        match authenticate(state, &mut handle, t.id, login, &how).await {
            Ok(true) => {}
            Ok(false) => return Err(anyhow::Error::new(LoginRefused(format!("{}:{port} refused the login as {login} ({auth_note})", host.address)))),
            Err(e) => return Err(anyhow::Error::new(LoginRefused(format!("{}:{port} ended the login as {login} ({auth_note}): {e}", host.address)))),
        }
        let ch = handle.channel_open_session().await.with_context(|| format!("{}:{port} closed the connection right after the login as {login}", host.address))?;
        let (shared, watch) = start_sftp_watched(ch).await.map_err(|_| anyhow::Error::new(NoSftp))?;
        let fingerprint = fingerprint.lock().unwrap().clone();
        anyhow::Ok(LanFiles {
            id: format!("{PREFIX}{}", crate::util::uuid_hex()),
            user_id: user.id,
            tunnel_id: t.id,
            reverse_port: t.reverse_port,
            account: account.to_string(),
            host_id: host.id,
            address: host.address.clone(),
            ssh_port: port,
            login: login.to_string(),
            auth_note,
            fingerprint,
            by: user.username.clone(),
            opener: opener.to_string(),
            opened: Instant::now(),
            handle,
            shared,
            watch,
            last_used: Mutex::new(Instant::now()),
            _lease: lease,
        })
    };
    let files = Arc::new(tokio::time::timeout(CONNECT_TIMEOUT, run).await.map_err(|_| anyhow::anyhow!("timed out connecting to the LAN host"))??);
    for old in state.lan_files.insert(files.clone()) {
        let state = state.clone();
        tokio::spawn(async move { finish(&state, &old, "replaced by a newer one").await });
    }
    Ok(files)
}

/// 關掉一個 session：先把它沒傳完的暫存檔從那台主機刪掉（帳本裡記的，只刪一般檔案），再斷線、記事件。
/// Close a session: first remove its unfinished part files from the host (recorded ones, regular files only), then
/// disconnect and write the event.
pub async fn finish(state: &AppState, s: &LanFiles, why: &str) {
    use crate::db::upload_parts;
    if let Ok(rows) = upload_parts::for_account(&state.db, s.tunnel_id, &s.id).await {
        for (row, _) in rows {
            if !s.closed() {
                if let Ok(m) = s.shared.symlink_metadata(row.part_path.as_str()).await {
                    if !m.is_dir() && !m.is_symlink() {
                        let _ = s.shared.remove_file(row.part_path.as_str()).await;
                    }
                }
            }
            let _ = upload_parts::remove(&state.db, row.id).await;
        }
    }
    s.close().await;
    let msg = format!(
        "{} closed the files of {}@{} (port {}, through {}) after {} ({why})",
        s.by,
        s.login,
        s.address,
        s.ssh_port,
        s.account,
        crate::util::fmt_duration(s.opened.elapsed())
    );
    state.gateway.event("lan_files_close", None, u16::try_from(s.reverse_port).ok(), Some(s.tunnel_id), msg).await;
}

/// 開它的人自己關。/ Closed by the person who opened it.
pub async fn close_by_owner(state: &AppState, id: &str, user_id: i64) -> bool {
    let Some(s) = state.lan_files.get(id, user_id) else { return false };
    let Some(s) = state.lan_files.take(&s.id) else { return false };
    finish(state, &s, "closed").await;
    true
}

/// 每 30 秒：關掉閒置的，以及開它的人已經不能用的（看不到隧道、帳號不在允許清單、帳號停用、功能關了）。
/// Every 30 s: close idle sessions and those whose person may no longer use them.
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(30));
    loop {
        tick.tick().await;
        reap_once(&state).await;
    }
}

pub async fn reap_once(state: &AppState) {
    for s in state.lan_files.take_idle(IDLE) {
        let why = if s.closed() { "the connection ended" } else { "idle" };
        finish(state, &s, why).await;
    }
    for s in state.lan_files.all() {
        if let Some(why) = lost(state, &s).await {
            if let Some(s) = state.lan_files.take(&s.id) {
                finish(state, &s, why).await;
            }
        }
    }
}

/// 開它的人還能用嗎；不能 = 為什麼。/ Whether its person may still use it; if not, why.
async fn lost(state: &AppState, s: &LanFiles) -> Option<&'static str> {
    use crate::features::Feature;
    use crate::permissions::{self, Permission};
    let user = match crate::db::users::by_id(&state.db, s.user_id).await {
        Ok(Some(u)) if u.is_active => u,
        Ok(_) => return Some("the account is disabled"),
        Err(_) => return None,
    };
    for f in [Feature::Files, Feature::Network] {
        if !state.features.allowed(&user, f).await.unwrap_or(true) {
            return Some("a feature was turned off");
        }
    }
    let t = match crate::db::tunnels::by_id(&state.db, s.tunnel_id).await {
        Ok(Some(t)) => t,
        Ok(None) => return Some("the tunnel was deleted"),
        Err(_) => return None,
    };
    if !permissions::check_access(&state.db, user.id, &t, Permission::View).await.unwrap_or(true) {
        return Some("access to the tunnel was removed");
    }
    match permissions::allowed_usernames(&state.db, user.id, &t).await {
        Ok(a) if !a.iter().any(|u| u.username == s.account) => Some("the device account is no longer allowed"),
        _ => None,
    }
}
