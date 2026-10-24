//! `telepy-server doctor`：在後端容器裡檢查設定與相依服務，列出 ✓ / ! / ✗，有 ✗ 時以非零結束。
//! 只讀：不改 schema、不寫任何資料（審計鏈驗證用讀取 transaction）。主機端的 `telepy.sh doctor` 先檢查
//! .env、容器與對外埠，再呼叫這個。
//! Read-only health check of the backend's configuration and dependencies, for `telepy.sh doctor`.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::config::Config;
use crate::db::{self, Db};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    /// 選用的功能沒開，或只是提示。/ Optional feature off, or a note.
    Info,
    /// 能跑，但某些功能不能用或不安全。/ Runs, but something is unavailable or unsafe.
    Warn,
    /// 核心功能壞了。/ A core function is broken.
    Fail,
}

impl Status {
    fn symbol(self) -> &'static str {
        match self {
            Status::Ok => "✓",
            Status::Info => "i",
            Status::Warn => "!",
            Status::Fail => "✗",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: &'static str,
    pub status: Status,
    pub detail: String,
}

fn check(name: &'static str, status: Status, detail: impl Into<String>) -> Check {
    Check { name, status, detail: detail.into() }
}

/// 核心表（缺了代表 schema 沒補齊）。/ Tables whose absence means the schema was never reconciled.
const KEY_TABLES: &[&str] = &["auth_user", "site_settings_sitesettings", "telepy_gateway_event", "telepy_device_host_key", "telepy_audit_anchor", "telepy_lan_host"];

fn writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let probe = dir.join(format!(".doctor-{}", std::process::id()));
    std::fs::write(&probe, b"ok").map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

async fn tcp_reachable(addr: &str, timeout: Duration) -> Result<(), String> {
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("timed out".into()),
    }
}

/// 跑全部檢查。/ Run every check.
pub async fn run(config: &Config) -> Vec<Check> {
    let mut out = Vec::new();

    out.push(if config.secret_key_is_default {
        check("SECRET_KEY", Status::Warn, "not set: the legacy default signs every login token. Set a long random SECRET_KEY in .env (existing sessions and TOTP secrets will need to be renewed).")
    } else {
        check("SECRET_KEY", Status::Ok, "set")
    });
    out.push(match &config.public_url {
        Some(u) => check("PUBLIC_URL", Status::Ok, u.clone()),
        None => check("PUBLIC_URL", Status::Info, "not set: links and the OAuth issuer come from the request's X-Forwarded-* headers"),
    });
    out.push(if config.internal_api_token.is_empty() {
        check("INTERNAL_API_TOKEN", Status::Warn, "empty: the remote browser's session manager accepts calls without a token")
    } else {
        check("INTERNAL_API_TOKEN", Status::Ok, "set")
    });

    for (name, dir) in [("data directory", &config.data_dir), ("log directory", &config.log_root)] {
        out.push(match writable(dir) {
            Ok(()) => check(name, Status::Ok, format!("{} is writable", dir.display())),
            Err(e) => check(name, Status::Fail, format!("{} is not writable: {e}", dir.display())),
        });
    }

    // 資料庫（沒有檔案就不開，免得建出一個空的）。/ Database (not created when missing).
    let db = if !config.db_path.exists() {
        out.push(check("database", Status::Fail, format!("{} does not exist; start the backend once (it creates and reconciles the schema)", config.db_path.display())));
        None
    } else {
        match Db::open(&config.db_path).await {
            Ok(db) => {
                let mut missing = Vec::new();
                for t in KEY_TABLES {
                    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?").bind(t).fetch_one(&db.read).await.unwrap_or(0);
                    if n == 0 {
                        missing.push(*t);
                    }
                }
                if missing.is_empty() {
                    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_user").fetch_one(&db.read).await.unwrap_or(0);
                    let tunnels: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM authorized_keys_reverseserverauthorizedkeys").fetch_one(&db.read).await.unwrap_or(0);
                    out.push(check("database", Status::Ok, format!("{} ({users} users, {tunnels} tunnels)", config.db_path.display())));
                    if users == 0 {
                        out.push(check("accounts", Status::Info, "no account yet: the first sign-up becomes the administrator (or run ./telepy.sh create-superuser)"));
                    }
                } else {
                    out.push(check("database", Status::Warn, format!("tables missing: {}. Restart the backend or run ./telepy.sh migration", missing.join(", "))));
                }
                Some(db)
            }
            Err(e) => {
                out.push(check("database", Status::Fail, format!("cannot open {}: {e}", config.db_path.display())));
                None
            }
        }
    };

    // 每條隧道自己的服務金鑰：都解得開才對（SECRET_KEY 換過會解不開，後端退回共用金鑰）。
    // Per-tunnel service keys must all decrypt (a changed SECRET_KEY breaks them; the backend falls back to the shared key).
    if let Some(db) = &db {
        let vault = crate::vault::Vault::new(&config.secret_key);
        match db::tunnel_keys::all_public_keys(db).await {
            Ok(keys) if keys.is_empty() => out.push(check("tunnel keys", Status::Ok, "no tunnel has its own service key yet (created on first use)")),
            Ok(keys) => {
                let mut broken = 0;
                for (id, _) in &keys {
                    let ok = db::tunnel_keys::get(db, *id).await.ok().flatten().is_some_and(|r| vault.open(&crate::ssh::tunnel_keys::aad(*id), &r.private_key).is_some());
                    if !ok {
                        broken += 1;
                    }
                }
                out.push(if broken == 0 {
                    check("tunnel keys", Status::Ok, format!("{} tunnel service keys, all readable", keys.len()))
                } else {
                    check("tunnel keys", Status::Warn, format!("{broken} of {} tunnel service keys cannot be decrypted (SECRET_KEY changed?); those tunnels fall back to the shared key", keys.len()))
                });
            }
            Err(e) => out.push(check("tunnel keys", Status::Fail, format!("cannot read tunnel service keys: {e}"))),
        }
    }
    // 服務金鑰：私鑰讀得到、公鑰存在、DB 裡登記的是同一把。/ Service key: private key loads, matches the DB.
    out.push(match crate::ssh::device::load_identity(&config.ssh_identity).await {
        Err(e) => check("service key", Status::Fail, format!("{}: {e:#}. Run ./telepy.sh keygen", config.ssh_identity.display())),
        Ok(_) => {
            let file = std::fs::read_to_string(&config.web_service_pubkey_path).map(|s| s.split_whitespace().take(2).collect::<Vec<_>>().join(" ")).unwrap_or_default();
            let seeded = match &db {
                Some(db) => db::keys::first_service_key(db).await.ok().flatten().map(|k| k.split_whitespace().take(2).collect::<Vec<_>>().join(" ")),
                None => None,
            };
            match (file.is_empty(), seeded) {
                (true, _) => check("service key", Status::Warn, format!("{} is missing; devices are given this public key to trust", config.web_service_pubkey_path.display())),
                (false, Some(s)) if s != file => check("service key", Status::Warn, "the database holds a different web-service key than the key file; restart the backend to reseed it"),
                (false, None) if db.is_some() => check("service key", Status::Warn, "not seeded in the database yet; restart the backend"),
                _ => check("service key", Status::Ok, format!("{}", config.ssh_identity.display())),
            }
        }
    });

    // gateway host keys。/ Gateway host keys.
    out.push(match (&config.gateway_host_keys_dir, config.gateway_enabled) {
        (_, false) => check("SSH gateway", Status::Warn, "disabled: no host-key directory, so devices cannot connect. Run ./telepy.sh keygen"),
        (None, true) => check("SSH gateway", Status::Fail, "enabled without a host-key directory"),
        (Some(dir), true) => {
            let keys = crate::gateway::load_host_keys(dir);
            if keys.is_empty() {
                check("SSH gateway", Status::Fail, format!("no host key could be loaded from {}. Run ./telepy.sh keygen", dir.display()))
            } else {
                let algs: Vec<String> = keys.iter().map(|k| k.algorithm().as_str().to_string()).collect();
                check("SSH gateway", Status::Ok, format!("{} host key(s): {}", keys.len(), algs.join(", ")))
            }
        }
    });

    // 相依服務。/ Companion services.
    out.push(match tcp_reachable(&config.guacd_addr, Duration::from_secs(3)).await {
        Ok(()) => check("guacd (remote desktop)", Status::Ok, config.guacd_addr.clone()),
        Err(e) => check("guacd (remote desktop)", Status::Warn, format!("cannot reach {}: {e}. Remote desktop will not work; start the guacd service", config.guacd_addr)),
    });
    let health = format!("{}/healthz", config.kasm_api.trim_end_matches('/'));
    let http = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().expect("reqwest client");
    out.push(match http.get(&health).send().await {
        Ok(r) if r.status().is_success() => check("kasm-browser (remote browser)", Status::Ok, config.kasm_api.clone()),
        Ok(r) => check("kasm-browser (remote browser)", Status::Warn, format!("{health} answered {}", r.status())),
        Err(e) => check("kasm-browser (remote browser)", Status::Warn, format!("cannot reach {health}: {e}. The remote browser will not work")),
    });
    out.push(if crate::geoip::GeoIp::load(&config.geoip_dir).enabled() {
        check("GeoIP", Status::Ok, format!("{}", config.geoip_dir.display()))
    } else {
        check("GeoIP", Status::Info, "not installed (optional): IPs show without country / network. Run ./telepy.sh geoip")
    });

    let oui = crate::oui::Oui::load(&config.oui_dir);
    out.push(if oui.enabled() {
        check("OUI vendors", Status::Ok, format!("{} vendors from {}", oui.len(), config.oui_dir.display()))
    } else {
        check("OUI vendors", Status::Info, "not installed (optional): LAN hosts show no NIC vendor. Run ./telepy.sh oui")
    });

    // 審計鏈。/ Audit chain.
    if let Some(db) = &db {
        db.audit.set_anchors_file(config.log_root.join(db::audit_chain::ANCHORS_FILE));
        out.push(match db::audit_chain::verify(db).await {
            Ok(r) if r.ok => {
                let rows: u64 = r.tables.iter().map(|t| t.checked).sum();
                check("audit log", Status::Ok, format!("hash chain intact ({rows} rows checked)"))
            }
            Ok(r) => {
                let broken: Vec<String> = r
                    .tables
                    .iter()
                    .filter(|t| !t.ok)
                    .map(|t| format!("{} at row {} ({})", t.table, t.broken_at.map(|b| b.to_string()).unwrap_or_else(|| "?".into()), t.reason.clone().unwrap_or_default()))
                    .collect();
                check("audit log", Status::Fail, format!("changed after it was written: {}", broken.join("; ")))
            }
            Err(e) => check("audit log", Status::Warn, format!("cannot verify: {e:#}")),
        });
    }
    out
}

/// 有沒有 ✗。/ Whether anything failed.
pub fn failed(checks: &[Check]) -> bool {
    checks.iter().any(|c| c.status == Status::Fail)
}

/// 人看的文字。/ Human-readable report.
pub fn render(checks: &[Check]) -> String {
    let width = checks.iter().map(|c| c.name.chars().count()).max().unwrap_or(0);
    let mut s = String::new();
    for c in checks {
        s.push_str(&format!("  {} {:<width$}  {}\n", c.status.symbol(), c.name, c.detail, width = width));
    }
    let count = |st: Status| checks.iter().filter(|c| c.status == st).count();
    s.push_str(&format!("\n{} ok, {} warning(s), {} failure(s)\n", count(Status::Ok), count(Status::Warn), count(Status::Fail)));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_and_summary() {
        let checks = vec![check("a", Status::Ok, "fine"), check("longer name", Status::Warn, "hmm"), check("b", Status::Info, "note")];
        let s = render(&checks);
        assert!(s.contains("  ✓ a            fine\n"), "{s}");
        assert!(s.contains("  ! longer name  hmm\n"), "{s}");
        assert!(s.ends_with("1 ok, 1 warning(s), 0 failure(s)\n"), "{s}");
        assert!(!failed(&checks));
        assert!(failed(&[check("x", Status::Fail, "")]));
    }

    #[test]
    fn writable_probe_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        writable(dir.path()).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
