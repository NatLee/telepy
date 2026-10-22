//! 全域共享狀態（axum `State`）。單一 process，所以所有「跨 worker」的東西都只是 Arc 裡的欄位。
//! Shared application state; everything that used Redis for cross-worker sharing is a plain field here.

use std::ops::Deref;
use std::sync::Arc;

use crate::ai::AiSessions;
use crate::auth::google::GoogleVerifier;
use crate::auth::Jwt;
use crate::config::Config;
use crate::db::Db;
use crate::gateway::Gateway;
use crate::hub::Hub;
use crate::mfa::MfaStores;
use crate::monitor::StatusState;
use crate::remote_browser::RemoteBrowser;
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
    pub gateway: Arc<Gateway>,
    pub remote_browser: Arc<RemoteBrowser>,
    /// AI（MCP）開的 SSH session。/ SSH sessions opened by AI agents over MCP.
    pub ai: AiSessions,
    /// 兩步驟驗證的記憶體狀態。/ Two-factor in-memory state.
    pub mfa: MfaStores,
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
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        let jwt = Jwt::new(&config.secret_key, config.access_token_lifetime, config.refresh_token_lifetime);
        let remote_browser = Arc::new(RemoteBrowser::new(&config, http.clone()));
        // 狀態由內建 gateway 事件驅動餵入（永不過期）。/ Fed by the in-process gateway; never stale.
        let status = Arc::new(StatusState::new(None));
        let gateway = Arc::new(Gateway::new(config.clone(), db.clone(), status.clone()));
        Self(Arc::new(Inner {
            remote_browser,
            google: GoogleVerifier::new(http.clone()),
            jwt,
            hub: Hub::new(),
            tokens: TokenStores::new(),
            http,
            status,
            gateway,
            ai: AiSessions::default(),
            mfa: MfaStores::new(&config.secret_key),
            config,
            db,
        }))
    }
}
