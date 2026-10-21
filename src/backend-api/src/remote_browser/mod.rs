//! Remote browser（KasmVNC）session 服務（authorized_keys/remote_browser_service.py）。
//! 單一 process → session 與 `ssh -D` 的 child handle 同在記憶體；另存一張小表供重啟後回收 kasm 側孤兒。
//! Remote-browser session service: SOCKS proxy via `ssh -D`, kasm session-manager, in-memory store + reaper.

pub mod kasm;

use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db::{self, Db};
use crate::ssh::process::terminate_child;
use crate::util::now_db;
use kasm::KasmClient;

/// 硬化的 `ssh -D` 選項（見 remote_browser_service.py 的血淚註解）：BatchMode、ExitOnForwardFailure、
/// ConnectTimeout、ServerAlive、**ControlMaster=no**（避免背景 master 讓 poll() 誤判）。
const SSH_HARDEN_OPTS: [&str; 14] = [
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
];

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
    pub proxy_port: u16,
    pub ws_port: Option<u16>,
    pub kasm_session_id: Option<String>,
    ssh: Mutex<Option<Child>>,
    last_seen: std::sync::Mutex<Instant>,
}

pub struct RemoteBrowser {
    sessions: DashMap<String, Arc<Session>>,
    kasm: KasmClient,
}

pub fn socks_args(config: &Config, proxy_port: u16, reverse_port: i64, username: &str) -> Vec<String> {
    let mut v: Vec<String> = vec!["-N".into()];
    v.extend(SSH_HARDEN_OPTS.iter().map(|s| s.to_string()));
    v.extend(["-D".to_string(), format!("0.0.0.0:{proxy_port}"), "-p".to_string(), reverse_port.to_string(), format!("{username}@{}", config.ssh_target_host)]);
    v
}

fn free_port() -> std::io::Result<u16> {
    let l = std::net::TcpListener::bind(("0.0.0.0", 0))?;
    Ok(l.local_addr()?.port())
}

/// 等 SOCKS 埠開始 listen；ssh 一死即刻失敗（不空等）。
async fn wait_for_port(port: u16, timeout: Duration, child: &mut Child) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return false;
        }
        if tokio::time::timeout(Duration::from_millis(500), tokio::net::TcpStream::connect(("127.0.0.1", port))).await.map(|r| r.is_ok()).unwrap_or(false) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

/// 探測 SOCKS 代理是否還活著（埠沒在聽 = ssh 已死）。
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

    async fn spawn_proxy(config: &Config, proxy_port: u16, reverse_port: i64, username: &str) -> std::io::Result<Child> {
        Command::new(&config.ssh_binary)
            .args(socks_args(config, proxy_port, reverse_port, username))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    }

    async fn drain_stderr(child: &mut Child) -> String {
        let Some(mut stderr) = child.stderr.take() else { return String::new() };
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(1), stderr.read_to_end(&mut buf)).await;
        String::from_utf8_lossy(&buf).trim().to_string()
    }

    /// `start_remote_browser`：ssh -D（含重試）→ kasm session → 記錄。回 `{"session_id","ws_path"}`。
    pub async fn start(&self, config: &Config, db: &Db, username: &str, reverse_port: i64, server_id: i64) -> Result<Value, StartError> {
        let settings = db::settings::get_solo(db).await.map_err(|e| StartError::Other(e.to_string()))?;
        let max = settings.remote_browser_max_sessions;
        if max > 0 && self.count() as i64 >= max {
            return Err(StartError::Other(
                "The Proxy Browser has reached its maximum concurrent user limit. Please wait for someone to disconnect and try again.".into(),
            ));
        }
        let ssh_timeout = Duration::from_secs(settings.remote_browser_ssh_timeout.max(1) as u64);
        let attempts = settings.remote_browser_ssh_attempts.max(1);
        let mut proxy: Option<(Child, u16)> = None;
        for attempt in 1..=attempts {
            let port = free_port().map_err(|e| StartError::Other(e.to_string()))?;
            tracing::info!(server_id, port, attempt, attempts, "Starting SSH proxy for target");
            let mut child = Self::spawn_proxy(config, port, reverse_port, username).await.map_err(|e| StartError::Other(format!("cannot spawn ssh: {e}")))?;
            if wait_for_port(port, ssh_timeout, &mut child).await {
                proxy = Some((child, port));
                break;
            }
            terminate_child(&mut child, Duration::from_secs(3)).await;
            let err = Self::drain_stderr(&mut child).await;
            tracing::warn!(server_id, attempt, attempts, timeout = ?ssh_timeout, stderr = %err.chars().rev().take(500).collect::<String>().chars().rev().collect::<String>(), "SSH proxy attempt did not bind a SOCKS listener");
        }
        let Some((child, proxy_port)) = proxy else {
            return Err(StartError::Coded {
                message: format!("Failed to start SSH proxy for target {server_id} after {attempts} attempts (no SOCKS listener within {}s each — is the device online?).", ssh_timeout.as_secs()),
                code: "device_offline",
            });
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(Session {
            id: session_id.clone(),
            server_id,
            proxy_port,
            ws_port: None,
            kasm_session_id: None,
            ssh: Mutex::new(Some(child)),
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
            proxy_port,
            ws_port: Some(ws_port),
            kasm_session_id: Some(kasm_id.clone()),
            ssh: Mutex::new(session.ssh.lock().await.take()),
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

    /// `stop_remote_browser`：收 kasm session、殺 ssh、刪記錄。回「原本是否存在」。
    pub async fn stop(&self, db: &Db, id: &str) -> bool {
        let Some((_, session)) = self.sessions.remove(id) else {
            let _ = sqlx::query("DELETE FROM telepy_remote_browser_session WHERE session_id = ?").bind(id).execute(&db.write).await;
            return false;
        };
        if let Some(kid) = &session.kasm_session_id {
            self.kasm.stop_session(kid).await;
        }
        if let Some(mut child) = session.ssh.lock().await.take() {
            terminate_child(&mut child, Duration::from_secs(5)).await;
        }
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

    /// 每 10s：ssh 已死、或超過 idle_timeout+30s 沒有心跳 → 回收。
    pub async fn reap(&self, db: &Db) {
        let idle = db::settings::get_solo(db).await.map(|s| s.remote_browser_session_idle_timeout).unwrap_or(60).max(0) as u64 + 30;
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            let Some(session) = self.get(&id) else { continue };
            let dead = {
                let mut guard = session.ssh.lock().await;
                match guard.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    None => true,
                }
            };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socks_argv() {
        let cfg = Config::from_env();
        let args = socks_args(&cfg, 40000, 12345, "ubuntu");
        assert_eq!(args[0], "-N");
        assert!(args.contains(&"ControlMaster=no".to_string()));
        assert!(args.contains(&"0.0.0.0:40000".to_string()));
        assert_eq!(args.last().unwrap(), &format!("ubuntu@{}", cfg.ssh_target_host));
    }
}
