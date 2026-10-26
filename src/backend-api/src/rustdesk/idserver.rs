//! Telepy 當 RustDesk 的 ID＋中繼伺服器（不經 SSH）。
//!
//! ```text
//! 裝置的 RustDesk（allow-websocket）── wss /ws/id（或 IP 時的根路徑）── RegisterPk，保持連線 ──┐
//!                                  ── POST /api/devices/deploy、/api/heartbeat、/api/sysinfo     │
//! 瀏覽器（核心）── /ws/rustdesk/<session>/ ── PunchHoleRequest → 在裝置的連線上推 RequestRelay ──┘
//!                                         ── 收 RelayResponse（附伺服器簽過的裝置公鑰）
//! 裝置 ── /ws/relay：RequestRelay{uuid} ─┐
//! 瀏覽器 ── /ws/rustdesk/<session>/：RequestRelay ─┴→ 以 uuid 配對，WS ⇄ WS 逐則轉送（端對端加密）
//! ```
//!
//! 只有登記過（`telepy_rustdesk_device`）且 uuid、公鑰都對得上的裝置會被回 OK；其他一律回 `NOT_DEPLOYED`，
//! RustDesk 會停著等 `rustdesk --deploy --token …`。PoC 與量測見 `docs/rustdesk-id-server.md`。
//! Telepy as RustDesk's ID and relay server: enrolled devices register over WebSocket, the browser core asks
//! for one by RustDesk ID, Telepy pushes a relay request and pairs the two relay sockets by uuid.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::WebSocket;
use base64::Engine;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, Notify};

use super::codec;

/// 裝置回報的 keep-alive（秒）；裝置 1.5 倍時間收不到任何東西就重連。/ keep_alive told to devices.
pub const KEEP_ALIVE_SECS: u64 = 30;
/// 伺服器送空訊息當心跳的間隔。/ Server heartbeat interval.
pub const PING_INTERVAL: Duration = Duration::from_secs(10);
/// 沒登記的連線最多留這麼久（裝置之後會自己重連）。/ How long an unenrolled socket may idle.
pub const UNENROLLED_TTL: Duration = Duration::from_secs(300);
/// 同時最多幾條沒登記的連線。/ Cap on unenrolled sockets.
pub const MAX_UNENROLLED: usize = 256;
/// 中繼兩端要在這段時間內配對。/ Both relay sides must meet within this.
pub const RELAY_PAIR_TIMEOUT: Duration = Duration::from_secs(20);
/// 登記指令的壽命。/ Enrolment command lifetime.
pub const ENROLL_TTL: Duration = Duration::from_secs(30 * 60);
pub const ENROLL_MAX_OPEN_PER_USER: usize = 10;
pub const ENROLL_TOKEN_PREFIX: &str = "tpr_";

/// 簽裝置公鑰用的 ed25519 金鑰，由 SECRET_KEY 衍生（不必另存；換 SECRET_KEY 只影響瀏覽器端，Telepy 每次都會給新的公鑰）。
/// The ed25519 key that signs device keys, derived from SECRET_KEY. Devices never verify it over WebSocket.
pub struct ServerKey(SigningKey);

impl ServerKey {
    pub fn derive(secret_key: &str) -> Self {
        let seed: [u8; 32] = Sha256::digest(format!("telepy-rustdesk-server-key-v1:{secret_key}").as_bytes()).into();
        Self(SigningKey::from_bytes(&seed))
    }

    /// 給瀏覽器核心 `key` 選項的 base64 公鑰。/ The base64 public key for the core's `key` option.
    pub fn public_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.0.verifying_key().to_bytes())
    }

    /// NaCl 的 combined 形式：64 bytes 簽章＋原訊息。/ NaCl combined form: signature then message.
    pub fn sign_combined(&self, msg: &[u8]) -> Vec<u8> {
        let mut out = self.0.sign(msg).to_bytes().to_vec();
        out.extend_from_slice(msg);
        out
    }

    pub fn verifying_key(&self) -> ed25519_dalek::VerifyingKey {
        self.0.verifying_key()
    }
}

/// 一台在線的裝置（它的註冊連線）。/ A registered device's live rendezvous socket.
pub struct Online {
    pub conn: u64,
    pub device_id: i64,
    pub user_id: i64,
    pub pk: Vec<u8>,
    /// 推給它的中繼網址：由它自己連進來的位址推出（PUBLIC_URL 優先）。/ The relay URL, from the address the device used.
    pub relay_url: String,
    pub tx: mpsc::UnboundedSender<Vec<u8>>,
    pub since: DateTime<Utc>,
    pub kick: Arc<Notify>,
}

/// 登記指令的進度。/ Enrolment progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnrollPhase {
    /// 等裝置跑 `--deploy`。/ Waiting for `--deploy`.
    Waiting,
    /// 登記了，等它連上。/ Enrolled; waiting for it to register.
    Enrolled,
    /// 連上了。/ Registered and online.
    Online,
}

#[derive(Debug, Clone, Serialize)]
pub struct Enrolment {
    /// 公開 id（不是 token）。/ Public id, not the secret.
    pub id: String,
    #[serde(skip)]
    pub token_hash: String,
    #[serde(skip)]
    pub user_id: i64,
    pub name: Option<String>,
    pub phase: EnrollPhase,
    pub device_id: Option<i64>,
    pub rustdesk_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    #[serde(skip)]
    pub deadline: Instant,
    /// 正在被 `--deploy` 使用（避免同一張被兩台同時用）。/ Being used by a deploy request.
    #[serde(skip)]
    pub claimed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClaimError {
    Invalid,
    Used,
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub struct IdServer {
    pub key: ServerKey,
    online: DashMap<String, Online>,
    relays: Mutex<HashMap<String, (Instant, oneshot::Sender<WebSocket>)>>,
    enrolments: Mutex<HashMap<String, Enrolment>>,
    next_conn: AtomicU64,
    next_port: AtomicU16,
    unenrolled: AtomicU64,
}

impl IdServer {
    pub fn new(secret_key: &str) -> Self {
        Self {
            key: ServerKey::derive(secret_key),
            online: DashMap::new(),
            relays: Mutex::new(HashMap::new()),
            enrolments: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            next_port: AtomicU16::new(40000),
            unenrolled: AtomicU64::new(0),
        }
    }

    pub fn next_conn(&self) -> u64 {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }

    // ---- 在線的裝置 / online devices ---------------------------------------------------------

    /// 登記一條註冊連線；同一個 RustDesk ID 原本的連線會被踢掉。/ Register a socket, kicking the previous one.
    pub fn set_online(&self, rustdesk_id: &str, online: Online) {
        if let Some(old) = self.online.insert(rustdesk_id.to_string(), online) {
            old.kick.notify_one();
        }
    }

    /// 這條連線結束：只有它還是目前那條才移除。/ Remove only if this socket is still the current one.
    pub fn set_offline(&self, rustdesk_id: &str, conn: u64) -> bool {
        self.online.remove_if(rustdesk_id, |_, o| o.conn == conn).is_some()
    }

    pub fn is_online(&self, rustdesk_id: &str) -> bool {
        self.online.contains_key(rustdesk_id)
    }

    pub fn online_since(&self, rustdesk_id: &str) -> Option<DateTime<Utc>> {
        self.online.get(rustdesk_id).map(|o| o.since)
    }

    /// 刪除裝置時踢掉它的連線。/ Kick a device's socket (it was removed).
    pub fn kick(&self, rustdesk_id: &str) {
        if let Some((_, o)) = self.online.remove(rustdesk_id) {
            o.kick.notify_one();
        }
    }

    /// 在線裝置的 (公鑰, 中繼網址)。/ An online device's key and relay URL.
    pub fn route(&self, rustdesk_id: &str) -> Option<(Vec<u8>, String)> {
        self.online.get(rustdesk_id).map(|o| (o.pk.clone(), o.relay_url.clone()))
    }

    /// 推一則訊息給在線的裝置。/ Push a message to an online device.
    pub fn push(&self, rustdesk_id: &str, msg: Vec<u8>) -> bool {
        self.online.get(rustdesk_id).map(|o| o.tx.send(msg).is_ok()).unwrap_or(false)
    }

    /// 沒登記的連線計數（上限保護）。/ Count unenrolled sockets for the cap.
    pub fn try_unenrolled(&self) -> bool {
        let n = self.unenrolled.fetch_add(1, Ordering::SeqCst);
        if n as usize >= MAX_UNENROLLED {
            self.unenrolled.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        true
    }

    pub fn release_unenrolled(&self) {
        self.unenrolled.fetch_sub(1, Ordering::SeqCst);
    }

    // ---- 中繼配對 / relay pairing ----------------------------------------------------------

    /// 給瀏覽器的一次中繼：(uuid, 收裝置 socket 的那端)、以及這次的 socket_addr。
    /// A new relay for the browser: its uuid, the receiver of the device's socket, and a fresh socket_addr.
    pub fn new_relay(&self, browser_ip: Option<&str>) -> (String, oneshot::Receiver<WebSocket>, Vec<u8>) {
        let uuid = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let mut map = self.relays.lock().unwrap();
        map.retain(|_, (at, _)| at.elapsed() < RELAY_PAIR_TIMEOUT * 2);
        map.insert(uuid.clone(), (Instant::now(), tx));
        drop(map);
        let ip = browser_ip.and_then(|s| s.parse::<IpAddr>().ok()).and_then(|ip| match ip {
            IpAddr::V4(v4) => Some(v4.octets()),
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(|v| v.octets()),
        });
        let port = self.next_port.fetch_add(1, Ordering::Relaxed).max(1);
        (uuid, rx, codec::mangle_v4(ip.unwrap_or([127, 0, 0, 1]), port))
    }

    /// 裝置的中繼連線到了：交給等著的瀏覽器。找不到 uuid 就把 socket 還回去。
    /// The device's relay socket arrived: hand it to the waiting browser, or give it back.
    pub fn deliver_relay(&self, uuid: &str, socket: WebSocket) -> Result<(), Box<WebSocket>> {
        let tx = self.relays.lock().unwrap().remove(uuid).map(|(_, tx)| tx);
        match tx {
            Some(tx) => tx.send(socket).map_err(Box::new),
            None => Err(Box::new(socket)),
        }
    }

    // ---- 登記指令 / enrolment commands -------------------------------------------------------

    fn sweep(map: &mut HashMap<String, Enrolment>) {
        let now = Instant::now();
        map.retain(|_, e| e.deadline > now);
    }

    /// 發一張登記指令；回傳 (token 原文, 票)。超過每人上限回 None。/ Mint a command; None when the user has too many.
    pub fn mint_enrolment(&self, user_id: i64, name: Option<String>) -> Option<(String, Enrolment)> {
        let mut map = self.enrolments.lock().unwrap();
        Self::sweep(&mut map);
        if map.values().filter(|e| e.user_id == user_id && e.phase == EnrollPhase::Waiting).count() >= ENROLL_MAX_OPEN_PER_USER {
            return None;
        }
        let token = format!("{ENROLL_TOKEN_PREFIX}{}", crate::util::random_alnum(40));
        let now = Utc::now();
        let e = Enrolment {
            id: crate::util::random_alnum(12),
            token_hash: hash_token(&token),
            user_id,
            name,
            phase: EnrollPhase::Waiting,
            device_id: None,
            rustdesk_id: None,
            created_at: now,
            expires_at: now + chrono::Duration::from_std(ENROLL_TTL).unwrap(),
            deadline: Instant::now() + ENROLL_TTL,
            claimed: false,
        };
        map.insert(e.token_hash.clone(), e.clone());
        Some((token, e))
    }

    /// `--deploy` 用這張票（原子；同一張只能成功一次）。失敗時呼叫 [`Self::release_enrolment`]。
    /// Claim a waiting command for a deploy request (atomic). Put it back with [`Self::release_enrolment`] on failure.
    pub fn claim_enrolment(&self, token: &str) -> Result<Enrolment, ClaimError> {
        let mut map = self.enrolments.lock().unwrap();
        Self::sweep(&mut map);
        let e = map.get_mut(&hash_token(token)).ok_or(ClaimError::Invalid)?;
        if e.phase != EnrollPhase::Waiting || e.claimed {
            return Err(ClaimError::Used);
        }
        e.claimed = true;
        Ok(e.clone())
    }

    pub fn release_enrolment(&self, token_hash: &str) {
        if let Some(e) = self.enrolments.lock().unwrap().get_mut(token_hash) {
            e.claimed = false;
        }
    }

    pub fn mark_enrolled(&self, token_hash: &str, device_id: i64, rustdesk_id: &str) -> Option<Enrolment> {
        let mut map = self.enrolments.lock().unwrap();
        let e = map.get_mut(token_hash)?;
        e.phase = EnrollPhase::Enrolled;
        e.device_id = Some(device_id);
        e.rustdesk_id = Some(rustdesk_id.to_string());
        Some(e.clone())
    }

    /// 裝置連上了：把等著它的登記指令標成 online。/ The device registered: mark its enrolments online.
    pub fn mark_online(&self, device_id: i64) -> Vec<Enrolment> {
        let mut map = self.enrolments.lock().unwrap();
        let mut out = Vec::new();
        for e in map.values_mut() {
            if e.device_id == Some(device_id) && e.phase == EnrollPhase::Enrolled {
                e.phase = EnrollPhase::Online;
                out.push(e.clone());
            }
        }
        out
    }

    pub fn enrolment(&self, user_id: i64, id: &str) -> Option<Enrolment> {
        let mut map = self.enrolments.lock().unwrap();
        Self::sweep(&mut map);
        map.values().find(|e| e.user_id == user_id && e.id == id).cloned()
    }

    /// 取消還沒用過的指令。/ Cancel an unused command.
    pub fn revoke_enrolment(&self, user_id: i64, id: &str) -> bool {
        let mut map = self.enrolments.lock().unwrap();
        let before = map.len();
        map.retain(|_, e| !(e.user_id == user_id && e.id == id && e.phase == EnrollPhase::Waiting && !e.claimed));
        map.len() != before
    }
}

/// RustDesk ID 的格式（RustDesk 自己的：字母或數字開頭，字母、數字、`-`、`_`，6–16 個字）。
/// RustDesk ID format: 6–16 letters, digits, `-` or `_`.
pub fn valid_rustdesk_id(id: &str) -> bool {
    (6..=16).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
}

/// 裝置端要設的 RustDesk 選項（從 Telepy 對外的網址推出來）。/ The RustDesk options a device needs, from Telepy's base URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceSettings {
    /// `custom-rendezvous-server`：網域（裝置連 `ws(s)://網域/ws/id`，埠固定 443 / 80）或 `IP:埠−2`（裝置連 `ws://IP:埠/`）。
    pub rendezvous: String,
    /// `api-server`：`https` 開頭時 RustDesk 才用 wss。/ RustDesk uses wss only when this starts with https.
    pub api_server: String,
    /// 推給裝置的中繼網址（原樣使用）。/ The relay URL pushed to devices (used verbatim).
    pub relay_url: String,
    /// 這個位址 RustDesk 連不到時的原因代碼。/ Why RustDesk cannot use this address, if it cannot.
    pub problem: Option<&'static str>,
}

/// `base` = Telepy 對外的網址（`PUBLIC_URL` 或轉送標頭推出的）。RustDesk 1.5 的 WebSocket 位址規則：網域 → 不帶埠的
/// `ws(s)://網域/ws/id`；IP → `ws://IP:<設定的埠+2>`（根路徑、永遠不加密）。
/// From Telepy's base URL. RustDesk 1.5 builds `ws(s)://domain/ws/id` without a port for a hostname, and
/// `ws://IP:<port+2>/` (root path, never TLS) for an IP address.
pub fn device_settings(base: &str) -> DeviceSettings {
    let Ok(url) = url::Url::parse(base) else {
        return DeviceSettings { rendezvous: String::new(), api_server: base.to_string(), relay_url: String::new(), problem: Some("bad_url") };
    };
    let https = url.scheme() == "https";
    let port = url.port_or_known_default().unwrap_or(if https { 443 } else { 80 });
    let default_port = if https { 443 } else { 80 };
    let host = url.host_str().unwrap_or("localhost").to_string();
    let authority = if url.port().is_some() { format!("{host}:{port}") } else { host.clone() };
    let api_server = format!("{}://{authority}", url.scheme());
    let relay_url = format!("{}://{authority}/ws/relay", if https { "wss" } else { "ws" });
    match url.host() {
        Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_)) => {
            let problem = if https {
                Some("ip_https")
            } else if port < 3 {
                Some("bad_port")
            } else {
                None
            };
            DeviceSettings { rendezvous: format!("{host}:{}", port.saturating_sub(2)), api_server, relay_url, problem }
        }
        _ => {
            let problem = if host == "localhost" {
                Some("localhost")
            } else if port != default_port {
                Some("hostname_port")
            } else {
                None
            };
            DeviceSettings { rendezvous: host, api_server, relay_url, problem }
        }
    }
}

/// 裝置上要跑的指令：Linux 與 macOS 共用一條（要 root），Windows 一條（要系統管理員）。
/// The commands to run on the device: one for Linux and macOS (root), one for Windows (Administrator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceCommands {
    pub unix: String,
    pub windows: String,
}

/// macOS 的 RustDesk 不在 PATH 上。/ RustDesk on macOS is not on the PATH.
const MAC_APP_BINARY: &str = "/Applications/RustDesk.app/Contents/MacOS/RustDesk";
const NOT_FOUND: &str = "RustDesk was not found. Install RustDesk 1.5 or later (on macOS, into Applications), open it once, then run this command again.";
const NOT_TAKEN: &str = "RustDesk did not accept the settings. Open RustDesk and let it finish its setup (on macOS: allow Accessibility and Screen Recording, and install its background service when asked), then run this command again.";
const NOT_SYNCED: &str = "The RustDesk background service did not pick up the settings. Open RustDesk (on macOS, install its service when asked), then run this command again.";

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 只有需要時才加引號（主機、網址、權杖通常不需要），指令比較好讀。/ Quote only when needed, so the command reads well.
fn sh_word(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._:/@%+=,-".contains(c)) {
        s.to_string()
    } else {
        shell_quote(s)
    }
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Linux / macOS：一條 `sudo sh -c '…'`。
/// - 找 RustDesk：PATH 上的 `rustdesk`，否則 macOS 的 app（不在 PATH 上；以前 Linux 指令在 Mac 上是 command not found）。
/// - 設好三個選項後讀回 `api-server`：沒裝好、服務沒在跑時 RustDesk 只印一行或什麼都不做，讀回不對就停下來說原因。
/// - `--deploy` 讀的是**執行它的行程**的設定檔（sudo 下是 `$HOME` 那份；macOS 的 RustDesk 服務以使用者身分跑，
///   0.3 秒一次把設定同步給 root），`--option` 卻是經 IPC 寫進使用者的服務。所以等那份檔案裡出現 Telepy 的
///   api-server 才 deploy —— 否則 deploy 會帶著權杖送到 RustDesk 自己的 API 伺服器。
///
/// Linux / macOS: one `sudo sh -c '…'` that finds RustDesk (the PATH, else the macOS app, which is not on the PATH),
/// sets the options, reads `api-server` back (RustDesk prints one line or nothing when it is not installed or its
/// service is not running), and waits until the config file `--deploy` reads (the one under `$HOME`; on macOS the
/// service runs as the user and syncs to root every 0.3 s) holds Telepy's API server, so the token never goes to
/// RustDesk's own API server.
pub fn device_commands(settings: &DeviceSettings, token: &str) -> DeviceCommands {
    let api = sh_word(&settings.api_server);
    let unix = [
        format!("RD=$(command -v rustdesk 2>/dev/null); [ -n \"$RD\" ] || RD={MAC_APP_BINARY}"),
        format!("if [ ! -x \"$RD\" ]; then echo \"{NOT_FOUND}\"; exit 1; fi"),
        format!("\"$RD\" --option custom-rendezvous-server {}", sh_word(&settings.rendezvous)),
        format!("\"$RD\" --option api-server {api}"),
        "\"$RD\" --option allow-websocket Y".to_string(),
        format!("if [ \"$(\"$RD\" --option api-server)\" != {api} ]; then echo \"{NOT_TAKEN}\"; exit 1; fi"),
        "if [ \"$(uname -s)\" = Darwin ]; then CFG=\"$HOME/Library/Preferences/com.carriez.RustDesk/RustDesk2.toml\"; else CFG=\"${XDG_CONFIG_HOME:-$HOME/.config}/rustdesk/RustDesk2.toml\"; fi".to_string(),
        format!("n=0; while ! grep -qF {api} \"$CFG\" 2>/dev/null; do n=$((n+1)); if [ \"$n\" -gt 15 ]; then echo \"{NOT_SYNCED}\"; exit 1; fi; sleep 1; done"),
        format!("\"$RD\" --deploy --token {}", sh_word(token)),
    ]
    .join("; ");
    let unix = format!("sudo sh -c {}", shell_quote(&unix));
    let windows = [
        "$rd = Join-Path $env:ProgramFiles 'RustDesk\\rustdesk.exe'".to_string(),
        format!("& $rd --option custom-rendezvous-server {} | Out-Null", ps_quote(&settings.rendezvous)),
        format!("& $rd --option api-server {} | Out-Null", ps_quote(&settings.api_server)),
        "& $rd --option allow-websocket Y | Out-Null".to_string(),
        format!("& $rd --deploy --token {token} | Write-Output"),
    ]
    .join("\n");
    DeviceCommands { unix, windows }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[test]
    fn server_key_is_stable_and_signs_in_nacl_form() {
        let a = ServerKey::derive("secret");
        let b = ServerKey::derive("secret");
        assert_eq!(a.public_b64(), b.public_b64(), "derived from SECRET_KEY, so it survives restarts");
        assert_ne!(a.public_b64(), ServerKey::derive("other").public_b64());
        let msg = codec::id_pk("113668456", &[7u8; 32]);
        let signed = a.sign_combined(&msg);
        assert_eq!(signed.len(), 64 + msg.len());
        assert_eq!(&signed[64..], &msg[..]);
        let sig = ed25519_dalek::Signature::from_bytes(signed[..64].try_into().unwrap());
        assert!(a.verifying_key().verify(&msg, &sig).is_ok());
    }

    #[test]
    fn rustdesk_ids() {
        assert!(valid_rustdesk_id("113668456"));
        assert!(valid_rustdesk_id("nat-office-01"));
        assert!(!valid_rustdesk_id("12345"), "too short");
        assert!(!valid_rustdesk_id("a".repeat(17).as_str()));
        assert!(!valid_rustdesk_id("bad id!"));
        assert!(!valid_rustdesk_id("-leading"));
    }

    #[test]
    fn settings_follow_rustdesks_address_rules() {
        let s = device_settings("https://telepy.example.com");
        assert_eq!(s.rendezvous, "telepy.example.com");
        assert_eq!(s.api_server, "https://telepy.example.com");
        assert_eq!(s.relay_url, "wss://telepy.example.com/ws/relay");
        assert_eq!(s.problem, None);

        let s = device_settings("http://192.168.1.10:8787");
        assert_eq!(s.rendezvous, "192.168.1.10:8785", "the device adds 2 and dials the root path");
        assert_eq!(s.api_server, "http://192.168.1.10:8787");
        assert_eq!(s.relay_url, "ws://192.168.1.10:8787/ws/relay");
        assert_eq!(s.problem, None);

        assert_eq!(device_settings("https://telepy.example.com:8443").problem, Some("hostname_port"));
        assert_eq!(device_settings("http://telepy.lan").problem, None, "plain http on port 80 works");
        assert_eq!(device_settings("https://10.0.0.5").problem, Some("ip_https"), "RustDesk never uses TLS for an IP");
        assert_eq!(device_settings("http://localhost:3000").problem, Some("localhost"));
    }

    #[test]
    fn commands_quote_and_carry_the_token() {
        let s = device_settings("https://telepy.example.com");
        let c = device_commands(&s, "tpr_abc");
        assert!(c.unix.starts_with("sudo sh -c 'RD=$(command -v rustdesk 2>/dev/null); [ -n \"$RD\" ] || RD=/Applications/RustDesk.app/Contents/MacOS/RustDesk; "), "{}", c.unix);
        assert!(c.unix.contains("\"$RD\" --option custom-rendezvous-server telepy.example.com; \"$RD\" --option api-server https://telepy.example.com; \"$RD\" --option allow-websocket Y; "));
        assert!(c.unix.contains("!= https://telepy.example.com ]"), "reads the setting back");
        assert!(c.unix.contains("grep -qF https://telepy.example.com \"$CFG\""), "waits for the config --deploy reads");
        assert!(c.unix.ends_with("\"$RD\" --deploy --token tpr_abc'"), "deploy comes last: {}", c.unix);
        assert!(!c.unix[12..c.unix.len() - 1].contains('\''), "one single-quoted script");
        assert_eq!(sh_word("a b"), "'a b'", "anything unusual is still quoted");
        assert_eq!(sh_word("it's"), "'it'\\''s'");
        assert!(c.windows.contains("--option api-server 'https://telepy.example.com'"));
        assert!(c.windows.contains("--deploy --token tpr_abc"));
    }

    #[test]
    fn enrolment_tokens_are_single_use() {
        let ids = IdServer::new("s");
        let (token, e) = ids.mint_enrolment(1, Some("pc".into())).unwrap();
        assert!(token.starts_with(ENROLL_TOKEN_PREFIX));
        assert_eq!(ids.claim_enrolment("tpr_nope").unwrap_err(), ClaimError::Invalid);
        let claimed = ids.claim_enrolment(&token).unwrap();
        assert_eq!(claimed.id, e.id);
        assert_eq!(ids.claim_enrolment(&token).unwrap_err(), ClaimError::Used, "in use");
        ids.release_enrolment(&claimed.token_hash);
        let claimed = ids.claim_enrolment(&token).unwrap();
        ids.mark_enrolled(&claimed.token_hash, 9, "113668456");
        assert_eq!(ids.claim_enrolment(&token).unwrap_err(), ClaimError::Used, "used up");
        assert_eq!(ids.enrolment(1, &e.id).unwrap().phase, EnrollPhase::Enrolled);
        assert!(ids.enrolment(2, &e.id).is_none(), "someone else's");
        assert_eq!(ids.mark_online(9).len(), 1);
        assert_eq!(ids.enrolment(1, &e.id).unwrap().phase, EnrollPhase::Online);
        assert!(!ids.revoke_enrolment(1, &e.id), "a used command cannot be cancelled");
        let (_, e2) = ids.mint_enrolment(1, None).unwrap();
        assert!(ids.revoke_enrolment(1, &e2.id));
        for _ in 0..ENROLL_MAX_OPEN_PER_USER {
            ids.mint_enrolment(3, None).unwrap();
        }
        assert!(ids.mint_enrolment(3, None).is_none(), "per-user cap");
    }
}
