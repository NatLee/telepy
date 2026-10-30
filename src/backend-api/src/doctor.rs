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

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Info => "info",
            Status::Warn => "warn",
            Status::Fail => "fail",
        }
    }

    /// 只有 ⚠ / ✗ 能被確認。/ Only warnings and failures can be acknowledged.
    pub fn is_problem(self) -> bool {
        matches!(self, Status::Warn | Status::Fail)
    }
}

/// 管理員對一個結果的確認（顯示用）。/ An admin's acknowledgement of a result, as shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Ack {
    pub by: String,
    /// RFC 3339 `…Z`
    pub at: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    /// 穩定的機器 id，前端用來分組與翻譯。/ Stable machine id the frontend groups and translates by.
    pub id: &'static str,
    pub name: &'static str,
    pub status: Status,
    pub detail: String,
    /// 結果的指紋：問題一變就變，沒變就一樣（確認只對同一個指紋有效）。
    /// Changes whenever the problem changes and stays put while it doesn't (an acknowledgement holds for one fingerprint).
    pub fingerprint: String,
    /// 對現在這個結果的確認。/ An acknowledgement of this exact result.
    pub ack: Option<Ack>,
    /// 之前的確認，但結果已經變了。/ An earlier acknowledgement of a result that has changed since.
    pub stale_ack: Option<Ack>,
}

fn check(id: &'static str, name: &'static str, status: Status, detail: impl Into<String>) -> Check {
    let detail = detail.into();
    let fingerprint = fingerprint(&[id, status.as_str(), &detail]);
    Check { id, name, status, detail, fingerprint, ack: None, stale_ack: None }
}

impl Check {
    /// 換掉預設指紋（detail 裡有會一直變的數字時）；一定帶上 id 與狀態。
    /// Replace the default fingerprint (when the detail holds numbers that keep changing); id and status always count.
    fn fp(mut self, parts: &[&str]) -> Self {
        let mut all = vec![self.id, self.status.as_str()];
        all.extend_from_slice(parts);
        self.fingerprint = fingerprint(&all);
        self
    }
}

/// 純函式：SHA-256(長度前綴的各部分) 的前 16 個 hex 字元。/ First 16 hex characters of SHA-256 over length-prefixed parts.
pub fn fingerprint(parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_be_bytes());
        h.update(p.as_bytes());
    }
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// 存著的一筆確認（`telepy_health_ack`）。/ A stored acknowledgement.
pub use crate::db::health_acks::AckRow;

/// 純函式：把存著的確認對到檢查上；回傳「已經沒問題」的檢查 id（它們的確認該刪）。
/// 指紋相同且仍是 ⚠ / ✗ = `ack`；指紋不同 = `stale_ack`；變成 ✓ / i = 不顯示、回傳要刪。
/// Match stored acknowledgements to checks. Same fingerprint and still a problem = `ack`; a different fingerprint
/// = `stale_ack`; now ok / info = neither, and the id is returned so the caller can delete it.
pub fn apply_acks(checks: &mut [Check], stored: &[AckRow]) -> Vec<String> {
    let mut resolved = Vec::new();
    for c in checks.iter_mut() {
        c.ack = None;
        c.stale_ack = None;
        let Some(a) = stored.iter().find(|a| a.check_id == c.id) else { continue };
        if !c.status.is_problem() {
            resolved.push(a.check_id.clone());
            continue;
        }
        let shown = Ack { by: a.username.clone(), at: a.at.clone(), note: a.note.clone() };
        if a.fingerprint == c.fingerprint {
            c.ack = Some(shown);
        } else {
            c.stale_ack = Some(shown);
        }
    }
    resolved
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

/// 跑全部檢查（CLI 用：自己開資料庫，沒有檔案就不開，免得建出一個空的）。
/// Run every check, opening the database itself (the CLI; a missing file is not created).
pub async fn run(config: &Config) -> Vec<Check> {
    let db = if !config.db_path.exists() {
        Err(format!("{} does not exist; start the backend once (it creates and reconciles the schema)", config.db_path.display()))
    } else {
        Db::open(&config.db_path).await.map_err(|e| format!("cannot open {}: {e}", config.db_path.display()))
    };
    // 自己開的資料庫才設錨點檔；run_with 不動呼叫端的 Db。/ Only a Db we opened gets the anchors file; run_with leaves the caller's Db alone.
    if let Ok(db) = &db {
        db.audit.set_anchors_file(config.log_root.join(db::audit_chain::ANCHORS_FILE));
    }
    run_with(config, db).await
}

/// 跑全部檢查，資料庫由呼叫端給（管理區的「伺服器狀態」頁用後端自己開著的那個）；`Err` = 開不了的原因。
/// Run every check on a database the caller opened (the admin "Server health" page passes the backend's own);
/// `Err` = why it could not be opened.
pub async fn run_with(config: &Config, db: Result<Db, String>) -> Vec<Check> {
    let mut out = Vec::new();
    // 網站設定裡的伺服器設定（環境變數有設的照樣優先），報告的是生效的值。/ Report the values in effect.
    if let Ok(db) = &db {
        let _ = config.live.load(db).await;
    }

    out.push(if config.secret_key_is_default {
        check("secret_key", "SECRET_KEY", Status::Warn, "not set: the legacy default signs every login token. Set a long random SECRET_KEY in .env (existing sessions and TOTP secrets will need to be renewed).")
    } else {
        check("secret_key", "SECRET_KEY", Status::Ok, "set")
    });
    out.push(match config.public_base() {
        Some(u) => check("public_url", "PUBLIC_URL", Status::Ok, format!("{u} ({})", source_label(config, "server_public_url"))),
        None => check("public_url", "PUBLIC_URL", Status::Info, "not set: links and the OAuth issuer come from the request's X-Forwarded-* headers"),
    });
    out.push(if config.internal_api_token.is_empty() {
        check("internal_api_token", "INTERNAL_API_TOKEN", Status::Warn, "empty: the remote browser's session manager accepts calls without a token")
    } else {
        check("internal_api_token", "INTERNAL_API_TOKEN", Status::Ok, "set")
    });

    for (id, name, dir) in [("data_dir", "data directory", &config.data_dir), ("log_dir", "log directory", &config.log_root)] {
        out.push(match writable(dir) {
            Ok(()) => check(id, name, Status::Ok, format!("{} is writable", dir.display())),
            Err(e) => check(id, name, Status::Fail, format!("{} is not writable: {e}", dir.display())),
        });
    }

    // 資料庫：核心表都在才算好。/ Database: every key table must exist.
    let db = {
        match db {
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
                    out.push(check("database", "database", Status::Ok, format!("{} ({users} users, {tunnels} tunnels)", config.db_path.display())).fp(&[]));
                    if users == 0 {
                        out.push(check("accounts", "accounts", Status::Info, "no account yet: the first sign-up becomes the administrator (or run ./telepy.sh create-superuser)"));
                    }
                } else {
                    let list = missing.join(", ");
                    out.push(check("database", "database", Status::Warn, format!("tables missing: {list}. Restart the backend or run ./telepy.sh migration")).fp(&[&list]));
                }
                Some(db)
            }
            Err(why) => {
                out.push(check("database", "database", Status::Fail, why));
                None
            }
        }
    };

    // 每條隧道自己的服務金鑰：都解得開才對（SECRET_KEY 換過會解不開，後端退回共用金鑰）。
    // Per-tunnel service keys must all decrypt (a changed SECRET_KEY breaks them; the backend falls back to the shared key).
    if let Some(db) = &db {
        let vault = crate::vault::Vault::new(&config.secret_key);
        match db::tunnel_keys::all_public_keys(db).await {
            Ok(keys) if keys.is_empty() => out.push(check("tunnel_keys", "tunnel keys", Status::Ok, "no tunnel has its own service key yet (created on first use)")),
            Ok(keys) => {
                let mut broken = 0;
                for (id, _) in &keys {
                    let ok = db::tunnel_keys::get(db, *id).await.ok().flatten().is_some_and(|r| vault.open(&crate::ssh::tunnel_keys::aad(*id), &r.private_key).is_some());
                    if !ok {
                        broken += 1;
                    }
                }
                out.push(if broken == 0 {
                    check("tunnel_keys", "tunnel keys", Status::Ok, format!("{} tunnel service keys, all readable", keys.len()))
                } else {
                    check("tunnel_keys", "tunnel keys", Status::Warn, format!("{broken} of {} tunnel service keys cannot be decrypted (SECRET_KEY changed?); those tunnels fall back to the shared key", keys.len()))
                        .fp(&[&broken.to_string()])
                });
            }
            Err(e) => out.push(check("tunnel_keys", "tunnel keys", Status::Fail, format!("cannot read tunnel service keys: {e}"))),
        }
    }
    // 服務金鑰：私鑰讀得到、公鑰存在、DB 裡登記的是同一把。/ Service key: private key loads, matches the DB.
    out.push(match crate::ssh::device::load_identity(&config.ssh_identity).await {
        Err(e) => check("service_key", "service key", Status::Fail, format!("{}: {e:#}. Run ./telepy.sh keygen", config.ssh_identity.display())),
        Ok(_) => {
            let file = std::fs::read_to_string(&config.web_service_pubkey_path).map(|s| s.split_whitespace().take(2).collect::<Vec<_>>().join(" ")).unwrap_or_default();
            let seeded = match &db {
                Some(db) => db::keys::first_service_key(db).await.ok().flatten().map(|k| k.split_whitespace().take(2).collect::<Vec<_>>().join(" ")),
                None => None,
            };
            match (file.is_empty(), seeded) {
                (true, _) => check("service_key", "service key", Status::Warn, format!("{} is missing; devices are given this public key to trust", config.web_service_pubkey_path.display())),
                (false, Some(s)) if s != file => check("service_key", "service key", Status::Warn, "the database holds a different web-service key than the key file; restart the backend to reseed it"),
                (false, None) if db.is_some() => check("service_key", "service key", Status::Warn, "not seeded in the database yet; restart the backend"),
                _ => check("service_key", "service key", Status::Ok, format!("{}", config.ssh_identity.display())),
            }
        }
    });
    if config.keep_shared_key() {
        out.push(check("shared_key", "shared key", Status::Info, format!("kept on devices after tunnels move to their own keys ({})", source_label(config, "server_keep_shared_service_key"))));
    }

    // gateway host keys。/ Gateway host keys.
    out.push(match (&config.gateway_host_keys_dir, config.gateway_enabled) {
        (_, false) => check("gateway", "SSH gateway", Status::Warn, "disabled: no host-key directory, so devices cannot connect. Run ./telepy.sh keygen"),
        (None, true) => check("gateway", "SSH gateway", Status::Fail, "enabled without a host-key directory"),
        (Some(dir), true) => {
            let keys = crate::gateway::load_host_keys(dir);
            if keys.is_empty() {
                check("gateway", "SSH gateway", Status::Fail, format!("no host key could be loaded from {}. Run ./telepy.sh keygen", dir.display()))
            } else {
                let algs: Vec<String> = keys.iter().map(|k| k.algorithm().as_str().to_string()).collect();
                check("gateway", "SSH gateway", Status::Ok, format!("{} host key(s): {}", keys.len(), algs.join(", ")))
            }
        }
    });

    // 相依服務。/ Companion services.
    out.push(match tcp_reachable(&config.guacd_addr, Duration::from_secs(3)).await {
        Ok(()) => check("guacd", "guacd (remote desktop)", Status::Ok, config.guacd_addr.clone()),
        // 指紋不含系統錯誤字（逾時 / 拒絕連線會來回變），連不到同一個位址就是同一個問題。
        // The OS error text (timed out / refused flips back and forth) stays out of the fingerprint: same address, same problem.
        Err(e) => check("guacd", "guacd (remote desktop)", Status::Warn, format!("cannot reach {}: {e}. Remote desktop will not work; start the guacd service", config.guacd_addr)).fp(&["unreachable", &config.guacd_addr]),
    });
    let health = format!("{}/healthz", config.kasm_api.trim_end_matches('/'));
    let http = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().expect("reqwest client");
    out.push(match http.get(&health).send().await {
        Ok(r) if r.status().is_success() => check("kasm", "kasm-browser (remote browser)", Status::Ok, config.kasm_api.clone()),
        Ok(r) => check("kasm", "kasm-browser (remote browser)", Status::Warn, format!("{health} answered {}", r.status())),
        Err(e) => check("kasm", "kasm-browser (remote browser)", Status::Warn, format!("cannot reach {health}: {e}. The remote browser will not work")).fp(&["unreachable", &health]),
    });
    out.push(if crate::geoip::GeoIp::load(&config.geoip_dir).enabled() {
        check("geoip", "GeoIP", Status::Ok, format!("{}", config.geoip_dir.display()))
    } else {
        check("geoip", "GeoIP", Status::Info, "not installed (optional): IPs show without country / network. Run ./telepy.sh geoip")
    });

    let oui = crate::oui::Oui::load(&config.oui_dir);
    out.push(if oui.enabled() {
        check("oui", "OUI vendors", Status::Ok, format!("{} vendors from {}", oui.len(), config.oui_dir.display()))
    } else {
        check("oui", "OUI vendors", Status::Info, "not installed (optional): LAN hosts show no NIC vendor. Run ./telepy.sh oui")
    });

    // 最近登入記到的來源 IP：全是內部位址 = 前面的代理把真實位址弄丟了（或層數設錯）。
    // Recent sign-in addresses: all internal = a proxy in front loses the real address (or the hop count is off).
    if let Some(db) = &db {
        let since = crate::util::db_time(chrono::Utc::now() - chrono::Duration::days(30));
        let ips: Vec<String> = sqlx::query_scalar("SELECT ip FROM telepy_sign_in_event WHERE ip IS NOT NULL AND at >= ? ORDER BY id DESC LIMIT 50")
            .bind(since)
            .fetch_all(&db.read)
            .await
            .unwrap_or_default();
        let header = config.client_ip_header_name();
        let mut setting = format!("client_ip_hops={} ({})", config.client_ip_hops().setting(), source_label(config, "client_ip_hops"));
        if let Some(h) = &header {
            setting = format!("client_ip_header={h} ({}), {setting}", source_label(config, "client_ip_header"));
        }
        let cf = config.client_ip_cloudflare();
        if cf != crate::server_settings::Cloudflare::Auto {
            setting.push_str(&format!(", client_ip_cloudflare={}", cf.as_str()));
        }
        let (status, detail, key) = client_addresses(&ips, config.client_ip_hops(), header.as_deref(), &setting);
        out.push(check("client_addresses", "client addresses", status, detail).fp(&[&key]));
    }

    // 審計鏈。/ Audit chain.
    if let Some(db) = &db {
        out.push(audit_log_check(db).await.0);
    }
    // 確認（只讀；表不在的舊資料庫 = 沒有）。/ Acknowledgements (read only; an older database without the table = none).
    if let Some(db) = &db {
        let stored = db::health_acks::list(db).await.unwrap_or_default();
        apply_acks(&mut out, &stored);
    }
    out
}

/// 審計鏈這一項（伺服器狀態頁的重新封存也用它拿指紋與驗證結果；驗證失敗 = 沒有結果）。
/// The audit-log check, also used by the Server health page's re-seal for the fingerprint and the report (None
/// when verification itself failed).
pub async fn audit_log_check(db: &Db) -> (Check, Option<db::audit_chain::Report>) {
    match db::audit_chain::verify(db).await {
        Ok(r) if r.ok => {
            let rows: u64 = r.tables.iter().map(|t| t.checked).sum();
            let foreign: u64 = r.tables.iter().map(|t| t.checkpoints_foreign).sum();
            let mut extra = if foreign > 0 { format!("; {foreign} checkpoints from another database skipped") } else { String::new() };
            // 最近一次重新封存（時間是 RFC 3339，同一格式可直接比大小）。/ The latest re-seal (RFC 3339 sorts as text).
            if let Some(last) = r.tables.iter().filter_map(|t| t.last_reseal.as_ref()).max_by(|a, b| a.at.cmp(&b.at)) {
                extra.push_str(&format!("; re-sealed {} by {}", last.at.get(..10).unwrap_or(&last.at), last.username));
            }
            (check("audit_log", "audit log", Status::Ok, format!("hash chain intact ({rows} rows checked{extra})")), Some(r))
        }
        Ok(r) => {
            let failing: Vec<&db::audit_chain::TableReport> = r.tables.iter().filter(|t| !t.ok).collect();
            // 鏈本身的問題與外部錨點的問題分開列：只列最早的一個時，後來的竄改會躲在舊的錨點不符後面。
            // Chain and checkpoint problems are listed separately: naming only the earliest one let a later edit hide
            // behind an old checkpoint mismatch.
            let broken: Vec<String> = failing.iter().map(|t| audit_problem(t)).collect();
            let mut detail = format!("changed after it was written: {}", broken.join("; "));
            let foreign: u64 = r.tables.iter().map(|t| t.checkpoints_foreign).sum();
            if foreign > 0 {
                detail.push_str(&format!(". {foreign} checkpoints from another database skipped"));
            }
            if failing.iter().any(|t| matches!(t.reason.as_deref(), Some("checkpoint_mismatch" | "checkpoint_missing"))) {
                detail.push_str(". If this database was restored or replaced, older lines in audit-anchors.log belong to the previous one.");
            }
            detail.push_str(" Once the cause is known, an admin can re-seal the chain on the Server health page.");
            let fp = db::audit_chain::fingerprint(&r);
            (check("audit_log", "audit log", Status::Fail, detail).fp(&[&fp]), Some(r))
        }
        Err(e) => (check("audit_log", "audit log", Status::Warn, format!("cannot verify: {e:#}")), None),
    }
}

/// 一張表的問題，人看的：鏈本身（某列被改、順序被換）與外部錨點（不符 / 不見了）各一句。
/// One table's problem in words: the chain itself and the external checkpoints, one clause each.
pub fn audit_problem(t: &db::audit_chain::TableReport) -> String {
    let mut parts = Vec::new();
    if let (Some(id), Some(reason)) = (t.chain_broken_at, t.chain_reason.as_deref()) {
        let more = if t.chain_issues > 1 { format!(", {} rows in all", t.chain_issues) } else { String::new() };
        parts.push(format!("row {id} ({reason}{more})"));
    }
    if let (Some(id), Some(reason)) = (t.checkpoint_broken_at, t.checkpoint_reason.as_deref()) {
        let more = if t.checkpoints_mismatched > 1 { format!(", {} checkpoints", t.checkpoints_mismatched) } else { String::new() };
        parts.push(format!("checkpoint at row {id} ({reason}{more})"));
    }
    if parts.is_empty() {
        parts.push(format!("row {} ({})", t.broken_at.map(|b| b.to_string()).unwrap_or_else(|| "?".into()), t.reason.clone().unwrap_or_default()));
    }
    format!("{}: {}", t.table, parts.join(", "))
}

/// 純函式：最近登入的來源 IP 有幾個是公網位址。第三個值 = 指紋用（設定 + 排序後的內部位址，不含會變的筆數）。
/// How many recent sign-in addresses are public. The third value feeds the fingerprint: the setting plus the
/// sorted internal addresses, never the counts (they change with every sign-in).
/// 一個設定由誰決定，給人看的：環境變數名稱 / `site setting` / `default`。/ Who decides a value, for people.
fn source_label(config: &Config, key: &str) -> String {
    use crate::server_settings::Source;
    match config.effective(key).1 {
        Source::Env => crate::server_settings::env_var(key).unwrap_or("env").to_string(),
        Source::Setting => "site setting".into(),
        Source::Default => "default".into(),
    }
}

/// `described` = 給人看的設定（含來源）；指紋鍵只看生效的值，寫法跟以前一樣，確認過的結果才不會因為改成在網站設定裡設就失效。
/// `described` = the settings for people (with their source); the fingerprint key holds only the values in effect,
/// written as before, so an acknowledgement survives moving a value from .env to the site setting.
fn client_addresses(ips: &[String], hops: crate::client_ip::Hops, header: Option<&str>, described: &str) -> (Status, String, String) {
    let hops = hops.setting();
    let key_setting = match header {
        Some(h) => format!("CLIENT_IP_HEADER={h}, TRUSTED_PROXY_HOPS={hops}"),
        None => format!("TRUSTED_PROXY_HOPS={hops}"),
    };
    let setting = described.to_string();
    let parsed: Vec<std::net::IpAddr> = ips.iter().filter_map(|ip| ip.parse().ok()).collect();
    if parsed.is_empty() {
        return (Status::Info, format!("no sign-ins with an address in the last 30 days ({setting})"), key_setting);
    }
    // 全是本機（loopback）= 在伺服器上自己登入／本機開發，看不出位址路徑。/ All loopback = signing in on the server itself, so the address path can't be judged.
    if parsed.iter().all(|ip| crate::geoip::scope(*ip) == crate::geoip::Scope::Loopback) {
        return (Status::Info, format!("the last {} sign-ins were all from this machine (loopback), so the address path can't be judged from them ({setting}). If people sign in from elsewhere too, a proxy on this machine is replacing their address: check \"How Telepy sees your address\" from another computer", parsed.len()), key_setting);
    }
    let internal: Vec<&std::net::IpAddr> = parsed.iter().filter(|ip| crate::geoip::scope(**ip) != crate::geoip::Scope::Public).collect();
    if internal.len() < parsed.len() {
        return (Status::Ok, format!("{} of the last {} sign-ins came from public addresses ({setting})", parsed.len() - internal.len(), parsed.len()), key_setting);
    }
    let mut distinct: Vec<String> = internal.iter().map(|ip| ip.to_string()).collect();
    distinct.sort();
    distinct.dedup();
    let key = format!("{key_setting}|{}", distinct.join(","));
    (
        Status::Warn,
        format!(
            "all of the last {} sign-ins came from internal addresses ({}; {setting}): a proxy in front of Telepy replaces the visitor's address. \"How Telepy sees your address\" on Admin → Server health shows each hop and what to change",
            parsed.len(),
            distinct.into_iter().take(3).collect::<Vec<_>>().join(", ")
        ),
        key,
    )
}

/// 有沒有沒被確認的 ✗。/ Whether anything failed that nobody acknowledged.
pub fn failed(checks: &[Check]) -> bool {
    checks.iter().any(|c| c.status == Status::Fail && c.ack.is_none())
}

/// 人看的文字。/ Human-readable report.
pub fn render(checks: &[Check]) -> String {
    let width = checks.iter().map(|c| c.name.chars().count()).max().unwrap_or(0);
    let mut s = String::new();
    for c in checks {
        let ack = match &c.ack {
            Some(a) => format!(" (acknowledged by {} {}: {})", a.by, a.at.get(..10).unwrap_or(&a.at), a.note),
            None => String::new(),
        };
        s.push_str(&format!("  {} {:<width$}  {}{ack}\n", c.status.symbol(), c.name, c.detail, width = width));
    }
    let count = |st: Status| checks.iter().filter(|c| c.status == st).count();
    let acked = checks.iter().filter(|c| c.ack.is_some()).count();
    let acked = if acked > 0 { format!(", {acked} acknowledged") } else { String::new() };
    s.push_str(&format!("\n{} ok, {} note(s), {} warning(s), {} failure(s){acked}\n", count(Status::Ok), count(Status::Info), count(Status::Warn), count(Status::Fail)));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_addresses_warn_when_every_sign_in_is_internal() {
        use crate::client_ip::Hops;
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let ca = |ips: &[String], h: Hops, hd: Option<&str>| client_addresses(ips, h, hd, &format!("client_ip_hops={} (TRUSTED_PROXY_HOPS)", h.setting()));
        assert_eq!(ca(&v(&[]), Hops::Fixed(2), None).0, Status::Info);
        // 指紋鍵不含筆數：多一筆同樣的內部位址不變，換一個位址就變。/ The key ignores counts but not the addresses.
        let k = |a: &[&str]| ca(&v(a), Hops::Fixed(2), None).2;
        assert_eq!(k(&["172.19.0.1"]), k(&["172.19.0.1", "172.19.0.1"]));
        assert_ne!(k(&["172.19.0.1"]), k(&["172.19.0.1", "10.0.0.2"]));
        assert_ne!(k(&["172.19.0.1"]), ca(&v(&["172.19.0.1"]), Hops::Fixed(1), None).2);
        assert_eq!(ca(&v(&["172.19.0.1", "198.51.100.7"]), Hops::Fixed(2), None).0, Status::Ok);
        let (s, d, _) = ca(&v(&["172.19.0.1", "172.19.0.1"]), Hops::Fixed(2), None);
        assert_eq!(s, Status::Warn);
        assert!(d.contains("172.19.0.1;") && d.contains("client_ip_hops=2 (TRUSTED_PROXY_HOPS)") && d.contains("Server health"), "{d}");
        let (s, d, _) = ca(&v(&["127.0.0.1", "::1"]), Hops::Auto, None);
        assert_eq!(s, Status::Info);
        assert!(d.contains("loopback"), "{d}");
        assert_eq!(ca(&v(&["127.0.0.1", "192.168.1.5"]), Hops::Auto, None).0, Status::Warn);
        assert_eq!(ca(&v(&["192.168.1.5"]), Hops::Auto, None).0, Status::Warn);
        // 指紋鍵的寫法跟以前一樣（不管值來自 .env 還是網站設定）。/ The key is written as before, wherever the value comes from.
        let (_, _, key) = ca(&v(&["10.0.0.9"]), Hops::Auto, Some("CF-Connecting-IP"));
        assert!(key.starts_with("CLIENT_IP_HEADER=CF-Connecting-IP, TRUSTED_PROXY_HOPS=auto|"), "{key}");
    }

    #[test]
    fn render_and_summary() {
        let checks = vec![check("a", "a", Status::Ok, "fine"), check("longer_name", "longer name", Status::Warn, "hmm"), check("b", "b", Status::Info, "note")];
        let s = render(&checks);
        assert!(s.contains("  ✓ a            fine\n"), "{s}");
        assert!(s.contains("  ! longer name  hmm\n"), "{s}");
        assert!(s.ends_with("1 ok, 1 note(s), 1 warning(s), 0 failure(s)\n"), "{s}");
        assert!(!failed(&checks));
        assert!(failed(&[check("x", "x", Status::Fail, "")]));
    }

    #[test]
    fn audit_problem_names_both_the_chain_and_the_checkpoints() {
        let t = db::audit_chain::TableReport {
            table: "telepy_gateway_event".into(),
            ok: false,
            checked: 12,
            first_id: Some(1),
            last_id: Some(12),
            unhashed_before: 0,
            broken_at: Some(1),
            reason: Some("checkpoint_mismatch".into()),
            checkpoints_checked: 3,
            checkpoints_mismatched: 2,
            chain_broken_at: Some(4),
            chain_reason: Some("hash_mismatch".into()),
            chain_issues: 1,
            checkpoint_broken_at: Some(1),
            checkpoint_reason: Some("checkpoint_mismatch".into()),
            checkpoints_foreign: 0,
            checkpoints_retired: 0,
            last_reseal: None,
        };
        assert_eq!(audit_problem(&t), "telepy_gateway_event: row 4 (hash_mismatch), checkpoint at row 1 (checkpoint_mismatch, 2 checkpoints)");
        let only_cp = db::audit_chain::TableReport { chain_broken_at: None, chain_reason: None, chain_issues: 0, checkpoints_mismatched: 1, ..t.clone() };
        assert_eq!(audit_problem(&only_cp), "telepy_gateway_event: checkpoint at row 1 (checkpoint_mismatch)");
        let older = db::audit_chain::TableReport { chain_broken_at: None, chain_reason: None, checkpoint_broken_at: None, checkpoint_reason: None, ..t };
        assert_eq!(audit_problem(&older), "telepy_gateway_event: row 1 (checkpoint_mismatch)");
    }

    #[test]
    fn fingerprint_is_stable_and_bounded() {
        let a = fingerprint(&["ab", "c"]);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, fingerprint(&["ab", "c"]));
        assert_ne!(a, fingerprint(&["a", "bc"]));
        // 預設 = id|狀態|detail；狀態一變指紋就變。/ Default covers id, status and detail.
        assert_ne!(check("x", "x", Status::Warn, "d").fingerprint, check("x", "x", Status::Fail, "d").fingerprint);
        assert_ne!(check("x", "x", Status::Warn, "d").fingerprint, check("x", "x", Status::Warn, "e").fingerprint);
        // 覆寫：detail 裡的數字不算，狀態照算。/ An override ignores the detail but still counts the status.
        assert_eq!(check("t", "t", Status::Warn, "1 of 3").fp(&["1"]).fingerprint, check("t", "t", Status::Warn, "1 of 9").fp(&["1"]).fingerprint);
        assert_ne!(check("t", "t", Status::Warn, "1").fp(&["1"]).fingerprint, check("t", "t", Status::Fail, "1").fp(&["1"]).fingerprint);
    }

    fn row(id: &str, fp: &str) -> AckRow {
        AckRow { check_id: id.into(), fingerprint: fp.into(), status: "warn".into(), note: "known".into(), user_id: Some(1), username: "admin".into(), at: "2026-10-30T01:02:03Z".into() }
    }

    #[test]
    fn acks_match_by_fingerprint_and_resolved_ones_go() {
        let mut checks = vec![check("a", "a", Status::Warn, "x"), check("b", "b", Status::Fail, "y"), check("c", "c", Status::Ok, "fine"), check("d", "d", Status::Warn, "z")];
        let stored = vec![row("a", &checks[0].fingerprint.clone()), row("b", "0000000000000000"), row("c", "whatever")];
        let resolved = apply_acks(&mut checks, &stored);
        assert_eq!(resolved, vec!["c".to_string()]);
        assert_eq!(checks[0].ack.as_ref().map(|a| a.by.as_str()), Some("admin"));
        assert!(checks[0].stale_ack.is_none());
        assert!(checks[1].ack.is_none() && checks[1].stale_ack.is_some());
        assert!(checks[2].ack.is_none() && checks[2].stale_ack.is_none());
        assert!(checks[3].ack.is_none() && checks[3].stale_ack.is_none());
        // 確認過的 ✗ 不算失敗；沒確認的才算。/ An acknowledged failure no longer fails the run.
        assert!(failed(&checks));
        checks[1].ack = checks[1].stale_ack.take();
        assert!(!failed(&checks));
        let s = render(&checks);
        assert!(s.contains("x (acknowledged by admin 2026-10-30: known)"), "{s}");
        assert!(s.ends_with("1 ok, 0 note(s), 2 warning(s), 1 failure(s), 2 acknowledged\n"), "{s}");
    }

    #[test]
    fn writable_probe_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        writable(dir.path()).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
