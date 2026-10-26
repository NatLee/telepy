//! Remote browser（KasmVNC）session 服務（authorized_keys/remote_browser_service.py）。
//! SOCKS 代理在行程內（`ssh::socks`：連線池那條裝置連線上的 direct-tcpip channel），不再 spawn `ssh -D`。
//! 單一 process → session 與代理同在記憶體；另存一張小表供重啟後回收 kasm 側孤兒。
//! Remote-browser session service: in-process SOCKS over the shared device connection, kasm session-manager.

pub mod kasm;

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db::{self, Db};
use crate::ssh::socks::SocksProxy;
use crate::state::AppState;
use crate::util::now_db;
use kasm::KasmClient;

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// 帶 code 的失敗（前端對應 i18n，例如 device_offline）。
    #[error("{message}")]
    Coded { message: String, code: &'static str },
    #[error("{0}")]
    Other(String),
}

pub struct Session {
    pub id: String,
    pub server_id: i64,
    /// 這個 session 用的裝置帳號。/ The device account this session uses.
    pub username: String,
    pub proxy_port: u16,
    pub ws_port: Option<u16>,
    pub kasm_session_id: Option<String>,
    proxy: Mutex<Option<SocksProxy>>,
    last_seen: std::sync::Mutex<Instant>,
}

pub struct RemoteBrowser {
    sessions: DashMap<String, Arc<Session>>,
    kasm: KasmClient,
}

/// 探測 SOCKS 代理是否還活著（埠沒在聽 = 已收掉）。
pub async fn proxy_alive(port: u16) -> bool {
    tokio::time::timeout(Duration::from_millis(500), tokio::net::TcpStream::connect(("127.0.0.1", port))).await.map(|r| r.is_ok()).unwrap_or(false)
}

impl RemoteBrowser {
    pub fn new(config: &Config, http: reqwest::Client) -> Self {
        Self { sessions: DashMap::new(), kasm: KasmClient::new(http, &config.kasm_api, &config.internal_api_token) }
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.get(id).map(|s| s.clone())
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }

    /// `start_remote_browser`：借一條裝置連線、開行程內 SOCKS（含重試）→ kasm session → 記錄。
    /// 回 `{"session_id","ws_path"}`。
    pub async fn start(&self, state: &AppState, username: &str, reverse_port: i64, server_id: i64) -> Result<Value, StartError> {
        let (config, db) = (&state.config, &state.db);
        let settings = db::settings::get_solo(db).await.map_err(|e| StartError::Other(e.to_string()))?;
        let max = settings.remote_browser_max_sessions;
        if max > 0 && self.count() as i64 >= max {
            return Err(StartError::Other(
                "The Proxy Browser has reached its maximum concurrent user limit. Please wait for someone to disconnect and try again.".into(),
            ));
        }
        let ssh_timeout = Duration::from_secs(settings.remote_browser_ssh_timeout.max(1) as u64);
        let attempts = settings.remote_browser_ssh_attempts.max(1);
        let mut proxy: Option<SocksProxy> = None;
        for attempt in 1..=attempts {
            if config.gateway_enabled && !state.gateway.has_forward(u16::try_from(reverse_port).unwrap_or(0)) {
                tracing::warn!(server_id, attempt, attempts, "SSH proxy: device offline (no tunnel)");
                break;
            }
            tracing::info!(server_id, attempt, attempts, "Starting SSH proxy for target");
            let opened = tokio::time::timeout(ssh_timeout, async {
                let lease = state.pool.acquire(state, reverse_port, username).await?;
                SocksProxy::start(state.clone(), lease, "0.0.0.0:0").await
            })
            .await;
            match opened {
                Ok(Ok(p)) => {
                    proxy = Some(p);
                    break;
                }
                Ok(Err(e)) => tracing::warn!(server_id, attempt, attempts, error = format!("{e:#}"), "SSH proxy attempt failed"),
                Err(_) => tracing::warn!(server_id, attempt, attempts, timeout = ?ssh_timeout, "SSH proxy attempt timed out"),
            }
        }
        let Some(proxy) = proxy else {
            return Err(StartError::Coded {
                message: format!("Failed to start SSH proxy for target {server_id} after {attempts} attempts (no SOCKS listener within {}s each — is the device online?).", ssh_timeout.as_secs()),
                code: "device_offline",
            });
        };
        let proxy_port = proxy.port;

        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(Session {
            id: session_id.clone(),
            server_id,
            username: username.to_string(),
            proxy_port,
            ws_port: None,
            kasm_session_id: None,
            proxy: Mutex::new(Some(proxy)),
            last_seen: std::sync::Mutex::new(Instant::now()),
        });
        self.sessions.insert(session_id.clone(), session.clone());

        let proxy_url = format!("socks5://{}:{proxy_port}", config.hostname);
        let geometry = if settings.remote_browser_geometry.is_empty() { "1280x720".to_string() } else { settings.remote_browser_geometry.clone() };
        let homepage = (!settings.remote_browser_homepage.is_empty()).then_some(settings.remote_browser_homepage.as_str());
        let lang = (!settings.remote_browser_language.is_empty()).then_some(settings.remote_browser_language.as_str());
        let kasm_timeout = Duration::from_secs(settings.remote_browser_kasm_create_timeout.max(1) as u64);
        let (kasm_id, ws_port) = match self.kasm.create_session(&proxy_url, &geometry, lang, homepage, kasm_timeout).await {
            Ok(v) => v,
            Err(e) => {
                self.stop(db, &session_id).await;
                return Err(StartError::Other(format!("Failed to create VNC browser session: {e}")));
            }
        };
        let session = Arc::new(Session {
            id: session_id.clone(),
            server_id,
            username: username.to_string(),
            proxy_port,
            ws_port: Some(ws_port),
            kasm_session_id: Some(kasm_id.clone()),
            proxy: Mutex::new(session.proxy.lock().await.take()),
            last_seen: std::sync::Mutex::new(Instant::now()),
        });
        self.sessions.insert(session_id.clone(), session);
        let _ = sqlx::query("INSERT OR REPLACE INTO telepy_remote_browser_session (session_id, server_id, kasm_session_id, ws_port, proxy_port, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&session_id)
            .bind(server_id)
            .bind(&kasm_id)
            .bind(ws_port as i64)
            .bind(proxy_port as i64)
            .bind(now_db())
            .execute(&db.write)
            .await;
        tracing::info!(session_id, ws_port, "Remote browser session ready");
        Ok(json!({ "session_id": session_id, "ws_path": format!("/ws/remote-browser/{session_id}/") }))
    }

    /// agent 的動作：經 session-manager 的 CDP 端點（見 `kasm::KasmClient::cdp`）；順便續命。
    /// An agent action through the session-manager's CDP endpoint; also keeps the session alive.
    pub async fn cdp(&self, id: &str, action: Value, timeout: Duration) -> Result<Value, String> {
        let Some(session) = self.get(id) else { return Err("the browser session is gone".into()) };
        let Some(kid) = session.kasm_session_id.as_deref() else { return Err("the browser session is not ready".into()) };
        *session.last_seen.lock().unwrap() = Instant::now();
        self.kasm.cdp(kid, action, timeout).await.map_err(|e| e.0)
    }

    /// `ping_remote_browser`：先做健康檢查（SOCKS 死 → 就地回收、回 false），再續命。
    pub async fn ping(&self, db: &Db, id: &str) -> bool {
        let Some(session) = self.get(id) else { return false };
        if !proxy_alive(session.proxy_port).await {
            tracing::info!(id, port = session.proxy_port, "ping: session proxy is dead — reaping");
            self.stop(db, id).await;
            return false;
        }
        *session.last_seen.lock().unwrap() = Instant::now();
        true
    }

    /// `stop_remote_browser`：收 kasm session、關代理（還 lease）、刪記錄。回「原本是否存在」。
    pub async fn stop(&self, db: &Db, id: &str) -> bool {
        let Some((_, session)) = self.sessions.remove(id) else {
            let _ = sqlx::query("DELETE FROM telepy_remote_browser_session WHERE session_id = ?").bind(id).execute(&db.write).await;
            return false;
        };
        if let Some(kid) = &session.kasm_session_id {
            self.kasm.stop_session(kid).await;
        }
        drop(session.proxy.lock().await.take());
        let _ = sqlx::query("DELETE FROM telepy_remote_browser_session WHERE session_id = ?").bind(id).execute(&db.write).await;
        true
    }

    /// 後端重啟：上一輪的 ssh 已隨 process 消失，kasm 側的 session 是孤兒 → 全部收掉。
    pub async fn cleanup_orphans(&self, db: &Db) {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as("SELECT session_id, kasm_session_id FROM telepy_remote_browser_session")
            .fetch_all(&db.read)
            .await
            .unwrap_or_default();
        for (sid, kid) in rows {
            tracing::info!(session_id = sid, "reaper: stopping orphaned remote-browser session from a previous run");
            if let Some(k) = kid {
                self.kasm.stop_session(&k).await;
            }
            let _ = sqlx::query("DELETE FROM telepy_remote_browser_session WHERE session_id = ?").bind(&sid).execute(&db.write).await;
        }
    }

    /// 每 10s：裝置連線已斷、或超過 idle_timeout+30s 沒有心跳 → 回收。
    pub async fn reap(&self, db: &Db) {
        let idle = db::settings::get_solo(db).await.map(|s| s.remote_browser_session_idle_timeout).unwrap_or(60).max(0) as u64 + 30;
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            let Some(session) = self.get(&id) else { continue };
            let dead = session.proxy.lock().await.as_ref().map(|p| !p.alive()).unwrap_or(true);
            let idle_for = session.last_seen.lock().unwrap().elapsed();
            if dead || idle_for > Duration::from_secs(idle) {
                tracing::info!(id, dead, idle = ?idle_for, "reaper: stopping remote-browser session");
                self.stop(db, &id).await;
            }
        }
    }

    pub async fn run_reaper(self: Arc<Self>, db: Db) {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            self.reap(&db).await;
        }
    }
}
