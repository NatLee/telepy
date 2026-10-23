//! 全域共享狀態（axum `State`）。單一 process，所以所有「跨 worker」的東西都只是 Arc 裡的欄位。
//! Shared application state; everything that used Redis for cross-worker sharing is a plain field here.

use std::ops::Deref;
use std::sync::Arc;

use crate::ai::AiSessions;
use crate::auth::google::GoogleVerifier;
use crate::auth::Jwt;
use crate::config::Config;
use crate::db::Db;
use crate::device_keys::DeviceKeys;
use crate::gateway::Gateway;
use crate::hub::Hub;
use crate::join::JoinTickets;
use crate::lan::scan::LanScans;
use crate::mfa::MfaStores;
use crate::monitor::StatusState;
use crate::presence::Presence;
use crate::remote_browser::RemoteBrowser;
use crate::ssh::pool::DevicePool;
use crate::tokens::TokenStores;

pub struct Inner {
    pub config: Config,
    pub db: Db,
    pub jwt: Jwt,
    pub hub: Hub,
    pub tokens: TokenStores,
    pub google: GoogleVerifier,
    pub http: reqwest::Client,
    pub status: Arc<StatusState>,
    /// 誰正在用哪條隧道（記憶體）。/ Who is using which tunnel right now.
    pub presence: Arc<Presence>,
    pub gateway: Arc<Gateway>,
    pub remote_browser: Arc<RemoteBrowser>,
    /// 依「隧道 + OS 帳號」共用的裝置 SSH 連線（SFTP / 檔案管理）。
    pub pool: Arc<DevicePool>,
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
        let gateway = Arc::new(Gateway::new(config.clone(), db.clone(), status.clone(), presence.clone()));
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
        Self(Arc::new(Inner {
            remote_browser,
            google: GoogleVerifier::new(http.clone()),
            jwt,
            hub: Hub::new(),
            tokens: TokenStores::new(),
            http,
            status,
            presence,
            gateway,
            pool: Arc::new(DevicePool::default()),
            ai: AiSessions::default(),
            mfa: MfaStores::new(&config.secret_key),
            lan_scans: LanScans::default(),
            device_keys: DeviceKeys::default(),
            join: JoinTickets::default(),
            config,
            db,
        }))
    }
}
