//! 網頁內遠端桌面（RDP / VNC）。
//!
//! ```text
//! 瀏覽器（guacamole-common-js）
//!   │ wss /ws/desktop/<session>/?ticket=…   單次票證、60 秒、綁使用者
//!   ▼
//! 後端 ws/desktop.rs  瀏覽器→guacd 只放行輸入類 opcode；guacd→瀏覽器透傳（依兩端的長度單位重編碼）
//!   │ TCP guacd:4822   Guacamole 握手在後端做完，帳密不經瀏覽器
//!   ▼
//! guacd 容器 ── 連回後端上這個 session 專屬的 rendezvous 埠
//!   ▼
//! 後端 bridge.rs ── russh direct-tcpip 通道（池裡那條裝置連線）→ 裝置自己的 127.0.0.1:3389 / 5900，
//!                   或裝置區網裡的另一台（經裝置 sshd，和區網掃描、`ssh -J` 同一個機制）
//! ```
//!
//! 權限：隧道 VIEW + 那一跳的裝置帳號在 `permissions::allowed_usernames` 裡（裝置分不出 Telepy 使用者，
//! 這份清單是唯一的邊界）；區網主機必須是該隧道底下的一列（目標釘死，不接受任意主機）。RDP / VNC 的帳密每次
//! 輸入、只在記憶體、握手後即丟。每個 session 在 gateway 事件表記 `desktop_open` / `desktop_close`（含秒數）。
//! In-browser remote desktop over guacd. Target = the device itself or one of its LAN hosts, always reached
//! through the device's sshd on the pooled connection; credentials live in memory until the handshake.

pub mod bridge;
pub mod display;
pub mod guac;
pub mod screens;
pub mod stats;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use russh::client::Msg;
use russh::ChannelStream;
use tokio::sync::Notify;

use crate::config::Config;
use crate::db::{self, Db};
use crate::permissions::{self, Permission};
use crate::ssh::pool::Lease;
use crate::state::AppState;
use crate::util::random_alnum;

/// 票證壽命：start 回來後瀏覽器要在這段時間內開 WS。/ The browser must open the WebSocket within this.
pub const TICKET_TTL: Duration = Duration::from_secs(60);
pub const REAP_INTERVAL: Duration = Duration::from_secs(10);
/// 對裝置開 direct-tcpip 通道的逾時（目標主機不通時 sshd 會等 TCP 逾時）。/ Channel open timeout.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
pub const GUACD_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
pub const RENDEZVOUS_TIMEOUT: Duration = Duration::from_secs(15);
pub const MIN_DIMENSION: u32 = 200;
pub const DEFAULT_MAX_RESOLUTION: u32 = 2560;
pub const DEFAULT_DPI: u32 = 96;

/// 把要求的畫面大小夾進站台上限 `max`：超過就**等比**縮到長邊 = `max`（只夾超過的那一邊會把 16:9 壓成別的比例），
/// 每邊至少 [`MIN_DIMENSION`]。握手的初始大小和瀏覽器之後送來的 `size` 都走這裡。
/// Clamp a requested size to the site ceiling `max`, scaling **both** sides down together (clamping only the long
/// side would change the aspect ratio), each at least [`MIN_DIMENSION`]. Used for the handshake and for later `size`s.
pub fn clamp_size(width: u32, height: u32, max: u32) -> (u32, u32) {
    let max = max.max(MIN_DIMENSION);
    let (w, h) = (width.max(1), height.max(1));
    let long = w.max(h);
    let (w, h) = if long > max {
        let f = max as f64 / long as f64;
        (((w as f64) * f).round() as u32, ((h as f64) * f).round() as u32)
    } else {
        (w, h)
    };
    (w.clamp(MIN_DIMENSION, max), h.clamp(MIN_DIMENSION, max))
}
/// 開聲音時握手給 guacd 的音訊格式：guacamole-common-js 的 RawAudioPlayer 會播的兩種原始 PCM。
/// 只有 RDP 有聲音（guacd 的 VNC 要另接 PulseAudio，裝置那邊不會有），所以 VNC 一律不給。
/// The audio formats offered in the handshake when sound is on: the raw PCM that guacamole-common-js's
/// RawAudioPlayer plays. Only RDP carries sound (guacd's VNC audio needs a PulseAudio server), so VNC never offers them.
pub const AUDIO_MIMETYPES: &[&str] = &["audio/L8", "audio/L16"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Protocol {
    Rdp,
    Vnc,
}

impl Protocol {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "rdp" => Some(Self::Rdp),
            "vnc" => Some(Self::Vnc),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rdp => "rdp",
            Self::Vnc => "vnc",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Rdp => "RDP",
            Self::Vnc => "VNC",
        }
    }
    pub fn default_port(self) -> u16 {
        match self {
            Self::Rdp => 3389,
            Self::Vnc => 5900,
        }
    }
}

/// 剪貼簿方向：both = 雙向、to_remote = 只能貼進遠端、off = 關閉。使用者自己選（個人設定 `desktop_clipboard`，
/// 連線時也可以帶），站台設定 `desktop_clipboard` 是上限：實際用的是兩者較窄的那個（`within`）。
/// Clipboard direction. Each user picks one (user setting, or per start); the site setting of the same name
/// is the ceiling, and the narrower of the two applies (`within`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Clipboard {
    Both,
    ToRemote,
    Off,
}

impl Clipboard {
    pub const VALUES: &'static [&'static str] = &["both", "to_remote", "off"];

    /// 放得越寬數字越大：off < to_remote < both。/ Wider = larger: off < to_remote < both.
    fn rank(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::ToRemote => 1,
            Self::Both => 2,
        }
    }

    /// 使用者的選擇套上站台上限。/ The user's choice capped by the site limit.
    pub fn within(self, limit: Self) -> Self {
        if self.rank() <= limit.rank() { self } else { limit }
    }

    /// 站台上限 + 這次要的（沒帶就用個人設定）→ 實際用的方向；壞值回欄位錯誤的訊息。
    /// The effective direction from the site limit, the requested value and the user's saved choice.
    pub fn effective(limit: &str, requested: Option<&str>, saved: &str) -> Result<Self, String> {
        let limit = Self::parse(limit).unwrap_or(Self::Both);
        let choice = match requested {
            Some(r) => Self::parse(r).ok_or_else(|| format!("Must be one of: {}.", Self::VALUES.join(", ")))?,
            None => Self::parse(saved).unwrap_or(Self::Both),
        };
        Ok(choice.within(limit))
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "both" => Some(Self::Both),
            "to_remote" => Some(Self::ToRemote),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Both => "both",
            Self::ToRemote => "to_remote",
            Self::Off => "off",
        }
    }
}

/// 畫質偏好（瀏覽器在 start 時選）：auto = guacd 自己的啟發式；speed = 少一點位元（16 位色、不平滑字型、
/// VNC 壓更多）給慢的隧道；sharp = 24 位色、只用無損壓縮。/ Quality preset chosen at start.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Quality {
    #[default]
    Auto,
    Speed,
    Sharp,
}

impl Quality {
    pub const VALUES: &'static [&'static str] = &["auto", "speed", "sharp"];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "auto" | "" => Some(Self::Auto),
            "speed" => Some(Self::Speed),
            "sharp" => Some(Self::Sharp),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Speed => "speed",
            Self::Sharp => "sharp",
        }
    }
}

/// 桌面所在的主機：裝置自己（`127.0.0.1`，從裝置看）或它區網裡的一台。/ Where the desktop lives.
#[derive(Debug, Clone)]
pub struct Target {
    pub host: String,
    pub port: u16,
    /// 給日誌看的名字：`device` 或區網主機的標籤 / 名稱 / 位址。/ Name for logs.
    pub label: String,
    pub lan_host_id: Option<i64>,
}

impl Target {
    pub fn device(port: u16) -> Self {
        Self { host: "127.0.0.1".into(), port, label: "device".into(), lan_host_id: None }
    }
}

/// RDP / VNC 的登入資料（只在記憶體，握手後即丟）。/ Desktop credentials; memory only, dropped after the handshake.
#[derive(Default, Clone)]
pub struct Credentials {
    pub login: String,
    pub password: String,
    pub domain: String,
}

/// start 時就先接好的東西：池的 lease + 到目標的 direct-tcpip 通道（所以裝置離線 / 目標不通在 REST 就報錯）。
/// Opened at start time, so an offline device or an unreachable target fails the REST call.
pub struct Prepared {
    pub lease: Lease,
    pub channel: ChannelStream<Msg>,
}

/// WS 認領 session 時一次拿走的東西。/ What the WebSocket takes over when it redeems the ticket.
pub struct Handoff {
    pub credentials: Credentials,
    pub prepared: Prepared,
}

#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    #[error("the device is offline (its reverse tunnel is not connected)")]
    Offline,
    #[error("the device refused the service key for this account")]
    Auth,
    /// 裝置出示的 host key 和釘選的不同。/ The device presented a host key that is not the pinned one.
    #[error("{0}")]
    HostKeyChanged(String),
    /// 這台機器屬於別的帳號的隧道。/ The machine belongs to another account's tunnel.
    #[error("{0}")]
    DeviceClaimed(String),
    #[error("the device could not reach {0}")]
    Unreachable(String),
    /// 裝置的 sshd 不允許轉發（`AllowTcpForwarding no`，例如 Alpine 的預設）。/ The device's sshd forbids forwarding.
    #[error("the device's SSH server does not allow port forwarding (AllowTcpForwarding)")]
    ForwardingDisabled,
    #[error("{0}")]
    Other(String),
}

impl PrepareError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Offline => "device_offline",
            Self::Auth => "device_auth",
            Self::HostKeyChanged(_) => "host_key_changed",
            Self::DeviceClaimed(_) => "device_claimed",
            Self::Unreachable(_) => "target_unreachable",
            Self::ForwardingDisabled => "forwarding_disabled",
            Self::Other(_) => "device_unreachable",
        }
    }
}

/// 借池裡的連線並對目標開 direct-tcpip 通道。/ Lease a pooled device connection and open the channel to the target.
pub async fn prepare(state: &AppState, reverse_port: i64, hop_username: &str, target: &Target) -> Result<Prepared, PrepareError> {
    let lease = state.pool.acquire(state, reverse_port, hop_username).await.map_err(|e| {
        let m = format!("{e:#}");
        if m.contains(crate::ssh::host_keys::CHANGED) {
            PrepareError::HostKeyChanged(m)
        } else if m.contains(crate::ssh::host_keys::CLAIMED) {
            PrepareError::DeviceClaimed(m)
        } else if m.contains("device offline") {
            PrepareError::Offline
        } else if m.contains("device auth") || m.contains("authentication failed") {
            PrepareError::Auth
        } else {
            PrepareError::Other(m)
        }
    })?;
    let open = lease.device().channel_open_direct_tcpip(target.host.clone(), target.port as u32, "127.0.0.1", 0);
    let channel = match tokio::time::timeout(OPEN_TIMEOUT, open).await {
        Ok(Ok(c)) => c,
        Ok(Err(russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited))) => return Err(PrepareError::ForwardingDisabled),
        Ok(Err(e)) => return Err(PrepareError::Unreachable(format!("{}:{} ({e})", target.host, target.port))),
        Err(_) => return Err(PrepareError::Unreachable(format!("{}:{} (timed out)", target.host, target.port))),
    };
    Ok(Prepared { lease, channel: channel.into_stream() })
}

pub struct Session {
    pub id: String,
    pub user_id: i64,
    pub user_name: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub reverse_port: i64,
    /// 那一跳用的裝置帳號。/ The device account used for the hop.
    pub hop_username: String,
    pub protocol: Protocol,
    pub target: Target,
    pub clipboard: Clipboard,
    pub quality: Quality,
    /// 遠端的聲音（只有 RDP；預設關，因為吃頻寬）。/ The remote's sound (RDP only; off by default because it costs bandwidth).
    pub audio: bool,
    /// 遠端解析度跟著瀏覽器的框走（瀏覽器送 `size`）。RDP 預設開（display-update）；VNC 預設關（只有虛擬桌面
    /// 像 TigerVNC / KasmVNC 會接受，實體螢幕被改解析度不是使用者要的）。關著時中繼把瀏覽器的 `size` 丟掉。
    /// The remote resolution follows the browser's frame (the browser sends `size`). On by default for RDP
    /// (display-update), off for VNC (only virtual desktops accept it; resizing a physical screen is not wanted).
    /// While off the relay drops the browser's `size`.
    pub resize: bool,
    pub saved_label: Option<String>,
    /// 開這個 session 的網頁登入（撤銷時連線以 4010 結束）。/ The web sign-in that opened it (revoked = 4010).
    pub web_session: Option<i64>,
    pub created: Instant,
    ticket: Mutex<Option<(String, Instant)>>,
    handoff: Mutex<Option<Handoff>>,
    /// 最後一次鍵盤 / 滑鼠 / 剪貼簿輸入。/ Last keyboard, mouse or clipboard input.
    last_input: Mutex<Instant>,
    pub connected: AtomicBool,
    /// 伺服器端要求結束（REST stop、閒置、權限被收回）。/ Server-side stop (REST stop, idle, revoked).
    pub stop: Notify,
    stop_reason: Mutex<Option<&'static str>>,
}

impl Session {
    pub fn touch(&self) {
        *self.last_input.lock().unwrap() = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        self.last_input.lock().unwrap().elapsed()
    }

    pub fn take_handoff(&self) -> Option<Handoff> {
        self.handoff.lock().unwrap().take()
    }

    pub fn ticket_expired(&self) -> bool {
        self.ticket.lock().unwrap().as_ref().map(|(_, exp)| *exp <= Instant::now()).unwrap_or(false)
    }

    pub fn request_stop(&self, reason: &'static str) {
        let mut r = self.stop_reason.lock().unwrap();
        if r.is_none() {
            *r = Some(reason);
        }
        self.stop.notify_one();
    }

    pub fn stop_reason(&self) -> Option<&'static str> {
        *self.stop_reason.lock().unwrap()
    }

    /// 日誌用的一句話：`Remote desktop (RDP) by alice to 192.168.1.50:3389 through ubuntu@office-pi`。
    /// One-line description for the logs.
    pub fn describe(&self) -> String {
        let to = if self.target.lan_host_id.is_some() { format!("{}:{}", self.target.host, self.target.port) } else { format!("device:{}", self.target.port) };
        let saved = self.saved_label.as_deref().map(|l| format!(" with saved login '{l}'")).unwrap_or_default();
        let sound = if self.audio { ", sound" } else { "" };
        // 和預設不同時才寫：RDP 固定解析度 / VNC 跟著視窗改。/ Only when it differs from the protocol's default.
        let size = match (self.protocol, self.resize) {
            (Protocol::Rdp, false) => ", fixed size",
            (Protocol::Vnc, true) => ", resizes with the window",
            _ => "",
        };
        format!("Remote desktop ({}{sound}{size}) by {} to {} through {}@{}{saved}", self.protocol.label(), self.user_name, to, self.hop_username, self.tunnel_name)
    }
}

pub struct NewSession {
    pub user_id: i64,
    pub user_name: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub reverse_port: i64,
    pub hop_username: String,
    pub protocol: Protocol,
    pub target: Target,
    pub clipboard: Clipboard,
    pub quality: Quality,
    pub audio: bool,
    pub resize: bool,
    pub credentials: Credentials,
    pub prepared: Prepared,
    /// 用了憑證庫的哪一筆（日誌用）。/ The saved login used, for the logs.
    pub saved_label: Option<String>,
    /// 開這個 session 的網頁登入（撤銷時連線以 4010 結束）。/ The web sign-in that opened it (revoked = 4010).
    pub web_session: Option<i64>,
}

pub struct Desktop {
    sessions: DashMap<String, Arc<Session>>,
    /// guacd 的 `host:port`。/ guacd's address.
    pub guacd_addr: String,
    /// guacd 連回來時用的主機名稱（後端在 compose 內網的名字）。/ The host name guacd dials back to.
    pub callback_host: String,
}

impl Desktop {
    pub fn new(config: &Config) -> Self {
        Self { sessions: DashMap::new(), guacd_addr: config.guacd_addr.clone(), callback_host: config.desktop_callback_host.clone() }
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.get(id).map(|s| s.clone())
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    /// 建 session 並發票證。/ Create a session and mint its one-time ticket.
    pub fn create(&self, new: NewSession) -> (Arc<Session>, String) {
        let ticket = random_alnum(48);
        let now = Instant::now();
        let session = Arc::new(Session {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: new.user_id,
            user_name: new.user_name,
            tunnel_id: new.tunnel_id,
            tunnel_name: new.tunnel_name,
            reverse_port: new.reverse_port,
            hop_username: new.hop_username,
            protocol: new.protocol,
            target: new.target,
            clipboard: new.clipboard,
            quality: new.quality,
            audio: new.audio,
            resize: new.resize,
            saved_label: new.saved_label,
            web_session: new.web_session,
            created: now,
            ticket: Mutex::new(Some((ticket.clone(), now + TICKET_TTL))),
            handoff: Mutex::new(Some(Handoff { credentials: new.credentials, prepared: new.prepared })),
            last_input: Mutex::new(now),
            connected: AtomicBool::new(false),
            stop: Notify::new(),
            stop_reason: Mutex::new(None),
        });
        self.sessions.insert(session.id.clone(), session.clone());
        (session, ticket)
    }

    /// 用票證認領：比對後立刻作廢（單次）；過期 / 不符 → None（過期的 session 一併移除）。
    /// Redeem the ticket: compare-and-take (single use); expired or wrong → None.
    pub fn redeem(&self, id: &str, ticket: &str) -> Option<Arc<Session>> {
        let session = self.get(id)?;
        let mut slot = session.ticket.lock().unwrap();
        match slot.as_ref() {
            Some((t, exp)) if *exp > Instant::now() && constant_eq(t, ticket) => {
                *slot = None;
                drop(slot);
                Some(session)
            }
            Some((_, exp)) if *exp <= Instant::now() => {
                drop(slot);
                self.sessions.remove(id);
                None
            }
            _ => None,
        }
    }

    pub fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.remove(id).map(|(_, s)| s)
    }

    /// REST stop：連線中 → 請中繼結束（它收尾時移除）；還沒連 → 直接移除。回「原本是否存在」；別人的 session → Err。
    /// REST stop: a connected session is asked to end, an unclaimed one is dropped. Someone else's → Err.
    pub fn stop(&self, id: &str, by_user: i64, is_admin: bool) -> Result<bool, ()> {
        let Some(session) = self.get(id) else { return Ok(false) };
        if session.user_id != by_user && !is_admin {
            return Err(());
        }
        if session.connected.load(Ordering::SeqCst) {
            session.request_stop("stopped");
        } else {
            self.sessions.remove(id);
        }
        Ok(true)
    }

    /// 沒認領的過期票證 → 移除（通道與 lease 隨之關閉）；連線中閒置超過 `idle`（0 = 不限）→ 請中繼結束。
    /// Drop unclaimed sessions whose ticket expired; ask idle connected sessions (`idle` 0 = never) to end.
    pub fn reap(&self, idle: Duration) -> usize {
        let mut n = 0;
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            let Some(s) = self.get(&id) else { continue };
            if !s.connected.load(Ordering::SeqCst) {
                if s.ticket_expired() || s.created.elapsed() > TICKET_TTL * 2 {
                    tracing::info!(session = %id, "desktop: ticket expired before the browser connected; dropping the session");
                    self.sessions.remove(&id);
                    n += 1;
                }
            } else if !idle.is_zero() && s.idle_for() > idle {
                tracing::info!(session = %id, idle = ?s.idle_for(), "desktop: idle session; closing");
                s.request_stop("idle");
                n += 1;
            }
        }
        n
    }

    pub async fn run_reaper(self: Arc<Self>, db: Db) {
        loop {
            tokio::time::sleep(REAP_INTERVAL).await;
            let idle = db::settings::get_solo(&db).await.map(|s| s.desktop_session_idle_timeout).unwrap_or(0).max(0) as u64;
            self.reap(Duration::from_secs(idle));
        }
    }
}

/// 使用者仍可用這條隧道的這個裝置帳號（VIEW + 允許清單）。/ The user still has VIEW and the hop account.
pub async fn still_allowed(db: &Db, session: &Session) -> bool {
    allowed_for(db, session.user_id, session.tunnel_id, &session.hop_username).await
}

/// 同上，給沒有 `Session` 的呼叫者（網頁內 RustDesk 的 session）。/ The same check for other session kinds.
pub async fn allowed_for(db: &Db, user_id: i64, tunnel_id: i64, hop_username: &str) -> bool {
    let Ok(Some(tunnel)) = db::tunnels::by_id(db, tunnel_id).await else { return false };
    if !permissions::check_access(db, user_id, &tunnel, Permission::View).await.unwrap_or(false) {
        return false;
    }
    permissions::allowed_usernames(db, user_id, &tunnel).await.map(|list| list.iter().any(|u| u.username == hop_username)).unwrap_or(false)
}

fn constant_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// guacd 的連線參數。`hostname` / `port` 指向後端的 rendezvous（guacd 連回來），真正的目標在通道另一端。
/// 參數名依 guacd 的 `args` 清單查表，用不到的自然留空。畫質預設：speed 少位元（慢隧道用）、sharp 無損。
/// guacd connection parameters; `hostname`/`port` point at the rendezvous, the real target sits behind the channel.
/// 聲音關著時 RDP 帶 `disable-audio`：guacd 不載入 rdpsnd，遠端也就不送聲音（不只是瀏覽器不播）。
/// With sound off RDP gets `disable-audio`, so guacd never loads rdpsnd and the remote sends no audio at all.
#[allow(clippy::too_many_arguments)]
/// `resize`：RDP 才帶 `resize-method=display-update`（不帶 = guacd 不理瀏覽器的 `size`）；VNC 沒開時帶
/// `disable-display-resize`（guacd 1.6 預設會用 SetDesktopSize 要伺服器改大小，連線時就送一次）。
/// `resize`: RDP gets `resize-method=display-update` only then (without it guacd ignores `size`); VNC gets
/// `disable-display-resize` unless it is on (guacd 1.6 otherwise asks the server for the browser's size via SetDesktopSize).
pub fn guacd_params(protocol: Protocol, creds: &Credentials, clipboard: Clipboard, quality: Quality, audio: bool, resize: bool, callback_host: &str, callback_port: u16, size: guac::Size) -> HashMap<String, String> {
    let mut p: HashMap<String, String> = HashMap::new();
    p.insert("hostname".into(), callback_host.to_string());
    p.insert("port".into(), callback_port.to_string());
    match quality {
        Quality::Auto => {}
        Quality::Speed => {
            p.insert("color-depth".into(), "16".into());
        }
        Quality::Sharp => {
            p.insert("color-depth".into(), "24".into());
            p.insert("force-lossless".into(), "true".into());
        }
    }
    match clipboard {
        Clipboard::Both => {}
        Clipboard::ToRemote => {
            p.insert("disable-copy".into(), "true".into());
        }
        Clipboard::Off => {
            p.insert("disable-copy".into(), "true".into());
            p.insert("disable-paste".into(), "true".into());
        }
    }
    match protocol {
        Protocol::Rdp => {
            p.insert("username".into(), creds.login.clone());
            p.insert("password".into(), creds.password.clone());
            if !creds.domain.is_empty() {
                p.insert("domain".into(), creds.domain.clone());
            }
            p.insert("security".into(), "any".into());
            p.insert("ignore-cert".into(), "true".into());
            p.insert("width".into(), size.width.to_string());
            p.insert("height".into(), size.height.to_string());
            p.insert("dpi".into(), size.dpi.to_string());
            if resize {
                p.insert("resize-method".into(), "display-update".into());
            }
            p.insert("client-name".into(), "Telepy".into());
            // speed：鋸齒字型的位元少得多（平滑字型讓每一塊圖都更難壓）。/ Smoothed text compresses badly.
            if quality != Quality::Speed {
                p.insert("enable-font-smoothing".into(), "true".into());
            }
            if !audio {
                p.insert("disable-audio".into(), "true".into());
            }
        }
        Protocol::Vnc => {
            if !creds.login.is_empty() {
                p.insert("username".into(), creds.login.clone());
            }
            p.insert("password".into(), creds.password.clone());
            if !resize {
                p.insert("disable-display-resize".into(), "true".into());
            }
            match quality {
                Quality::Speed => {
                    p.insert("compress-level".into(), "6".into());
                    p.insert("quality-level".into(), "5".into());
                }
                Quality::Sharp => {
                    p.insert("quality-level".into(), "9".into());
                }
                Quality::Auto => {}
            }
        }
    }
    p
}

pub use crate::util::fmt_duration;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_and_clipboard_parse() {
        assert_eq!(Protocol::parse(" RDP "), Some(Protocol::Rdp));
        assert_eq!(Protocol::parse("ssh"), None);
        assert_eq!(Protocol::Vnc.default_port(), 5900);
        assert_eq!(Clipboard::parse("to_remote"), Some(Clipboard::ToRemote));
        assert_eq!(Clipboard::parse("yes"), None);
        for v in Clipboard::VALUES {
            assert_eq!(Clipboard::parse(v).unwrap().as_str(), *v);
        }
    }

    #[test]
    fn the_site_limit_caps_the_users_clipboard_choice() {
        use Clipboard::*;
        assert_eq!(Both.within(Both), Both);
        assert_eq!(Both.within(ToRemote), ToRemote);
        assert_eq!(Both.within(Off), Off);
        assert_eq!(ToRemote.within(Both), ToRemote);
        assert_eq!(ToRemote.within(Off), Off);
        assert_eq!(Off.within(Both), Off);
        // 這次有帶就用它，沒帶用個人設定；壞的個人設定 / 上限當 both。/ Requested wins over saved; bad stored values read as both.
        assert_eq!(Clipboard::effective("both", Some("off"), "both"), Ok(Off));
        assert_eq!(Clipboard::effective("to_remote", Some("both"), "off"), Ok(ToRemote));
        assert_eq!(Clipboard::effective("both", None, "to_remote"), Ok(ToRemote));
        assert_eq!(Clipboard::effective("junk", None, "junk"), Ok(Both));
        assert!(Clipboard::effective("both", Some("yes"), "both").is_err());
    }

    #[test]
    fn rdp_params_point_guacd_at_the_rendezvous_and_apply_the_clipboard_policy() {
        let creds = Credentials { login: "alice".into(), password: "pw".into(), domain: "CORP".into() };
        let size = guac::Size { width: 1280, height: 720, dpi: 96 };
        let p = guacd_params(Protocol::Rdp, &creds, Clipboard::ToRemote, Quality::Auto, false, true, "backend", 40123, size);
        assert_eq!(p["hostname"], "backend");
        assert_eq!(p["port"], "40123");
        assert_eq!(p["domain"], "CORP");
        assert_eq!(p["security"], "any");
        assert_eq!(p["resize-method"], "display-update");
        assert_eq!(p["disable-copy"], "true");
        assert_eq!(p["enable-font-smoothing"], "true");
        assert!(!p.contains_key("disable-paste"));
        assert!(!p.contains_key("color-depth"), "auto leaves the depth to guacd");
        let p = guacd_params(Protocol::Vnc, &Credentials { password: "secret".into(), ..Default::default() }, Clipboard::Off, Quality::Auto, false, false, "backend", 1, size);
        assert_eq!(p["password"], "secret");
        assert!(!p.contains_key("username"));
        assert_eq!(p["disable-paste"], "true");
    }

    #[test]
    fn resizing_follows_the_choice_per_protocol() {
        let creds = Credentials::default();
        let size = guac::Size { width: 1280, height: 720, dpi: 96 };
        let p = guacd_params(Protocol::Rdp, &creds, Clipboard::Both, Quality::Auto, false, false, "backend", 1, size);
        assert!(!p.contains_key("resize-method"), "a fixed RDP size never asks for display-update");
        assert_eq!((p["width"].as_str(), p["height"].as_str()), ("1280", "720"));
        let p = guacd_params(Protocol::Vnc, &creds, Clipboard::Both, Quality::Auto, false, false, "backend", 1, size);
        assert_eq!(p["disable-display-resize"], "true", "VNC keeps the server's size unless asked");
        let p = guacd_params(Protocol::Vnc, &creds, Clipboard::Both, Quality::Auto, false, true, "backend", 1, size);
        assert!(!p.contains_key("disable-display-resize"));
        assert!(!p.contains_key("resize-method"), "resize-method is an RDP parameter");
    }

    #[test]
    fn sizes_shrink_to_the_ceiling_keeping_their_shape() {
        assert_eq!(clamp_size(1920, 1080, 2560), (1920, 1080));
        // 長邊夾到上限、短邊等比。/ The long side hits the ceiling, the short one follows.
        assert_eq!(clamp_size(3840, 2160, 2560), (2560, 1440));
        assert_eq!(clamp_size(2880, 1800, 2560), (2560, 1600));
        assert_eq!(clamp_size(1000, 5000, 2000), (400, 2000));
        // 每邊至少 MIN_DIMENSION；太窄的比例會被撐開。/ At least MIN_DIMENSION per side.
        assert_eq!(clamp_size(10, 10, 2560), (MIN_DIMENSION, MIN_DIMENSION));
        assert_eq!(clamp_size(10000, 100, 2560), (2560, MIN_DIMENSION));
        assert_eq!(clamp_size(0, 0, 0), (MIN_DIMENSION, MIN_DIMENSION));
    }

    #[test]
    fn sound_is_rdp_only_and_off_unless_asked() {
        let creds = Credentials::default();
        let size = guac::Size { width: 1280, height: 720, dpi: 96 };
        let p = guacd_params(Protocol::Rdp, &creds, Clipboard::Both, Quality::Auto, false, true, "backend", 1, size);
        assert_eq!(p["disable-audio"], "true", "sound off = guacd never loads rdpsnd");
        let p = guacd_params(Protocol::Rdp, &creds, Clipboard::Both, Quality::Auto, true, true, "backend", 1, size);
        assert!(!p.contains_key("disable-audio"));
        // VNC：guacd 的聲音要 PulseAudio，這裡不碰。/ VNC: guacd's audio needs PulseAudio; untouched.
        let p = guacd_params(Protocol::Vnc, &creds, Clipboard::Both, Quality::Auto, true, false, "backend", 1, size);
        assert!(!p.contains_key("disable-audio") && !p.contains_key("enable-audio"));
    }

    #[test]
    fn quality_presets_change_depth_and_compression() {
        let creds = Credentials::default();
        let size = guac::Size { width: 1280, height: 720, dpi: 96 };
        let p = guacd_params(Protocol::Rdp, &creds, Clipboard::Both, Quality::Speed, false, true, "backend", 1, size);
        assert_eq!(p["color-depth"], "16");
        assert!(!p.contains_key("enable-font-smoothing"));
        assert!(!p.contains_key("force-lossless"));
        let p = guacd_params(Protocol::Rdp, &creds, Clipboard::Both, Quality::Sharp, false, true, "backend", 1, size);
        assert_eq!(p["color-depth"], "24");
        assert_eq!(p["force-lossless"], "true");
        assert_eq!(p["enable-font-smoothing"], "true");
        let p = guacd_params(Protocol::Vnc, &creds, Clipboard::Both, Quality::Speed, false, false, "backend", 1, size);
        assert_eq!((p["color-depth"].as_str(), p["compress-level"].as_str(), p["quality-level"].as_str()), ("16", "6", "5"));
        let p = guacd_params(Protocol::Vnc, &creds, Clipboard::Both, Quality::Sharp, false, false, "backend", 1, size);
        assert_eq!((p["color-depth"].as_str(), p["quality-level"].as_str(), p["force-lossless"].as_str()), ("24", "9", "true"));
        assert_eq!(Quality::parse(""), Some(Quality::Auto));
        assert_eq!(Quality::parse("sharp"), Some(Quality::Sharp));
        assert_eq!(Quality::parse("ultra"), None);
        for v in Quality::VALUES {
            assert_eq!(Quality::parse(v).unwrap().as_str(), *v);
        }
    }

    #[test]
    fn durations() {
        assert_eq!(fmt_duration(Duration::from_secs(12)), "12s");
        assert_eq!(fmt_duration(Duration::from_secs(92)), "1m32s");
        assert_eq!(fmt_duration(Duration::from_secs(7500)), "2h05m");
    }

    #[test]
    fn constant_time_compare() {
        assert!(constant_eq("abc", "abc"));
        assert!(!constant_eq("abc", "abd"));
        assert!(!constant_eq("abc", "ab"));
    }
}
