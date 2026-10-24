//! 全域共享狀態（axum `State`）。單一 process，所以所有「跨 worker」的東西都只是 Arc 裡的欄位。
//! Shared application state; everything that used Redis for cross-worker sharing is a plain field here.

use std::ops::Deref;
use std::sync::Arc;

use crate::ai::AiSessions;
use crate::auth::google::GoogleVerifier;
use crate::auth::Jwt;
use crate::config::Config;
use crate::db::Db;
use crate::desktop::Desktop;
use crate::device_keys::DeviceKeys;
use crate::gateway::Gateway;
use crate::geoip::GeoIp;
use crate::oui::Oui;
use crate::vault::Vault;
use crate::hub::Hub;
use crate::join::JoinTickets;
use crate::lan::scan::LanScans;
use crate::mfa::MfaStores;
use crate::monitor::StatusState;
use crate::presence::Presence;
use crate::remote_browser::RemoteBrowser;
use crate::ssh::host_keys::HostKeyPins;
use crate::ssh::pool::DevicePool;
use crate::tokens::TokenStores;

pub struct Inner {
    pub config: Config,
    pub db: Db,
    pub jwt: Jwt,
    pub hub: Arc<Hub>,
    pub tokens: TokenStores,
    pub google: GoogleVerifier,
    pub http: reqwest::Client,
    pub status: Arc<StatusState>,
    /// 誰正在用哪條隧道（記憶體）。/ Who is using which tunnel right now.
    pub presence: Arc<Presence>,
    /// 離線 GeoIP（沒有資料庫時只判斷位址範圍）。/ Offline GeoIP; scope only without databases.
    pub geoip: Arc<GeoIp>,
    /// 網卡廠商表（IEEE OUI）。/ NIC vendor table.
    pub oui: Arc<Oui>,
    /// 憑證庫的加解密（金鑰由 SECRET_KEY 衍生）。/ Credential vault cipher (key derived from SECRET_KEY).
    pub vault: Vault,
    pub gateway: Arc<Gateway>,
    pub remote_browser: Arc<RemoteBrowser>,
    /// 網頁內遠端桌面（RDP / VNC，經 guacd）的 session。/ In-browser remote desktop sessions (guacd).
    pub desktop: Arc<Desktop>,
    /// 依「隧道 + OS 帳號」共用的裝置 SSH 連線（SFTP / 檔案管理）。
    pub pool: Arc<DevicePool>,
    /// 裝置 host key 釘選的快取。/ Cache of the devices' pinned host keys.
    pub host_keys: HostKeyPins,
    /// 每條隧道自己的服務金鑰（解開後的私鑰快取）。/ Per-tunnel service keys (decrypted private keys, cached).
    pub tunnel_keys: crate::ssh::tunnel_keys::TunnelKeys,
    /// AI（MCP）開的 SSH session。/ SSH sessions opened by AI agents over MCP.
    pub ai: AiSessions,
    /// 兩步驟驗證的記憶體狀態。/ Two-factor in-memory state.
    pub mfa: MfaStores,
    /// 區網掃描的進度 / 最近結果（每條隧道一筆）。/ LAN scan status per tunnel.
    pub lan_scans: LanScans,
    /// 裝置金鑰清單的同步狀態（kick / 鎖 / 重試）。/ Device key list sync state.
    pub device_keys: DeviceKeys,
    /// 一行指令加入裝置的票（記憶體）。/ One-command device join tickets (in memory).
    pub join: JoinTickets,
    /// 敏感隧道的 step-up（跟 gateway 共用）。/ Step-up confirmations (shared with the gateway).
    pub step_up: Arc<crate::step_up::StepUps>,
    /// 指令規則快取與等待中的核准。/ Command rule cache and pending approvals.
    pub commands: crate::command_rules::CommandRules,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(config: Config, db: Db) -> Self {
        // 狀態由內建 gateway 事件驅動餵入（永不過期）。/ Fed by the in-process gateway; never stale.
        let status = Arc::new(StatusState::new(None));
        let presence = Arc::new(Presence::default());
        let gateway = Arc::new(Gateway::new(config.clone(), db.clone(), status.clone(), presence.clone(), Arc::new(Hub::new())));
        Self::with_gateway(config, db, gateway, status, presence)
    }

    /// 沿用一個已經在跑的 gateway（測試改設定時用）。/ Reuse a running gateway (tests that reconfigure).
    pub fn with_gateway(config: Config, db: Db, gateway: Arc<Gateway>, status: Arc<StatusState>, presence: Arc<Presence>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        let jwt = Jwt::new(&config.secret_key, config.access_token_lifetime, config.refresh_token_lifetime);
        let remote_browser = Arc::new(RemoteBrowser::new(&config, http.clone()));
        let desktop = Arc::new(Desktop::new(&config));
        // 通知 hub 跟 gateway 共用（gateway 會發 IP 變更警示）。/ The hub is shared with the gateway (IP-change alerts).
        let hub = gateway.hub();
        let step_up = gateway.step_ups();
        db.audit.set_anchors_file(config.log_root.join(crate::db::audit_chain::ANCHORS_FILE));
        Self(Arc::new(Inner {
            remote_browser,
            desktop,
            google: GoogleVerifier::new(http.clone()),
            jwt,
            hub,
            tokens: TokenStores::new(),
            http,
            status,
            geoip: Arc::new(GeoIp::load(&config.geoip_dir)),
            oui: Arc::new(Oui::load(&config.oui_dir)),
            vault: Vault::new(&config.secret_key),
            presence,
            gateway,
            pool: Arc::new(DevicePool::default()),
            host_keys: HostKeyPins::default(),
            tunnel_keys: Default::default(),
            ai: AiSessions::default(),
            mfa: MfaStores::new(&config.secret_key),
            lan_scans: LanScans::default(),
            device_keys: DeviceKeys::default(),
            join: JoinTickets::default(),
            step_up,
            commands: Default::default(),
            config,
            db,
        }))
    }
}
