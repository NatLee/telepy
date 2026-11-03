//! 隧道背後的區網主機（跳板機表，#20）：掃描找到的與手動加的都在這裡。掃描以 upsert 合併，
//! 不覆蓋使用者給的標籤 / 帳號 / SSH port。
//! LAN hosts behind a tunnel (the jump-host table): scanned and manual entries; scans upsert without
//! overwriting the user's label, username or SSH port.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct LanHost {
    pub id: i64,
    pub tunnel_id: i64,
    /// IPv4 位址或主機名稱。/ IPv4 address or hostname.
    pub address: String,
    pub hostname: Option<String>,
    pub mac: Option<String>,
    /// JSON 陣列（最後一次掃描開著的 port）。/ JSON array of the ports open at the last scan.
    pub open_ports: String,
    pub ssh_banner: Option<String>,
    /// JSON 陣列（`lan::fingerprint::Service`，最後一次掃描認出來的）。/ JSON array of what the last scan recognised.
    pub services: String,
    pub label: Option<String>,
    /// 連這台機器時預設的帳號。/ Default login user on this machine.
    pub username: Option<String>,
    pub ssh_port: i64,
    /// `scan` | `manual`
    pub source: String,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    /// 最後一次有掃描探過它（整網段或「檢查這台」）。/ When a scan (full or a check) last covered it.
    pub checked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl LanHost {
    pub fn open_port_list(&self) -> Vec<u16> {
        serde_json::from_str(&self.open_ports).unwrap_or_default()
    }
    pub fn service_list(&self) -> Vec<crate::lan::fingerprint::Service> {
        serde_json::from_str(&self.services).unwrap_or_default()
    }
}

/// 掃描找到的一台主機。/ One host found by a scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub address: String,
    pub hostname: Option<String>,
    pub mac: Option<String>,
    pub open_ports: Vec<u16>,
    pub ssh_banner: Option<String>,
    pub services: Vec<crate::lan::fingerprint::Service>,
    /// 裝置自己（位址 `localhost`，source = `self`）。/ The device itself (address `localhost`, source `self`).
    pub own: bool,
}

/// 一條隧道最近一次掃描的整體結果。/ A tunnel's last scan as a whole.
#[derive(Debug, Clone, Default, FromRow)]
pub struct LanMeta {
    pub tunnel_id: i64,
    /// JSON 陣列（CIDR）。/ JSON array of CIDRs.
    pub networks: String,
    pub gateway: Option<String>,
    pub scanned_at: Option<String>,
    /// JSON（`lan::device_self::Changes`）。/ JSON of what changed.
    pub changes: Option<String>,
}

impl LanMeta {
    pub fn network_list(&self) -> Vec<String> {
        serde_json::from_str(&self.networks).unwrap_or_default()
    }
}

pub async fn meta(db: &Db, tunnel_id: i64) -> sqlx::Result<Option<LanMeta>> {
    sqlx::query_as("SELECT tunnel_id, networks, gateway, scanned_at, changes FROM telepy_lan_meta WHERE tunnel_id = ?").bind(tunnel_id).fetch_optional(&db.read).await
}

pub async fn save_meta(db: &Db, m: &LanMeta) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO telepy_lan_meta (tunnel_id, networks, gateway, scanned_at, changes) VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(tunnel_id) DO UPDATE SET networks = excluded.networks, gateway = excluded.gateway, scanned_at = excluded.scanned_at, changes = excluded.changes",
    )
    .bind(m.tunnel_id)
    .bind(&m.networks)
    .bind(&m.gateway)
    .bind(&m.scanned_at)
    .bind(&m.changes)
    .execute(&db.write)
    .await?;
    Ok(())
}

const T: &str = "telepy_lan_host";
const COLS: &str = "id, tunnel_id, address, hostname, mac, open_ports, ssh_banner, services, label, username, ssh_port, source, first_seen, last_seen, checked_at, created_at, updated_at";

pub async fn hosts_for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<LanHost>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE tunnel_id = ? ORDER BY id")).bind(tunnel_id).fetch_all(&db.read).await
}

pub async fn host_by_id(db: &Db, id: i64) -> sqlx::Result<Option<LanHost>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn create_manual(db: &Db, tunnel_id: i64, address: &str, label: Option<&str>, username: Option<&str>, ssh_port: i64) -> sqlx::Result<LanHost> {
    let now = now_db();
    let id = sqlx::query(&format!(
        "INSERT INTO {T} (tunnel_id, address, open_ports, label, username, ssh_port, source, created_at, updated_at) VALUES (?, ?, '[]', ?, ?, ?, 'manual', ?, ?)"
    ))
    .bind(tunnel_id)
    .bind(address)
    .bind(label)
    .bind(username)
    .bind(ssh_port)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    Ok(host_by_id(db, id).await?.expect("host just inserted"))
}

pub struct HostPatch<'a> {
    pub label: Option<Option<&'a str>>,
    pub username: Option<Option<&'a str>>,
    pub ssh_port: Option<i64>,
}

pub async fn update(db: &Db, id: i64, p: HostPatch<'_>) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    if let Some(v) = p.label {
        sqlx::query(&format!("UPDATE {T} SET label = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.username {
        sqlx::query(&format!("UPDATE {T} SET username = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.ssh_port {
        sqlx::query(&format!("UPDATE {T} SET ssh_port = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    sqlx::query(&format!("UPDATE {T} SET updated_at = ? WHERE id = ?")).bind(now_db()).bind(id).execute(&mut *tx).await?;
    tx.commit().await
}

pub async fn delete(db: &Db, id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    // 存給這台主機的登入一起刪。/ Saved logins for this host go too.
    sqlx::query("DELETE FROM telepy_credential WHERE lan_host_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_lan_watch WHERE host_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {T} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    tx.commit().await
}

/// 合併一次掃描的結果：新的插入（source = scan），已知的更新「看到的」欄位（名稱 / MAC / port / banner / 服務 / last_seen），
/// 不動標籤、帳號、SSH port 與 source。回傳 (新增, 更新) 筆數。
/// Merge a scan: insert new hosts, refresh what was observed on known ones; returns (inserted, updated).
/// `now` = 這次掃描的時間，同一個值也寫進 `telepy_lan_meta.scanned_at`，所以「上次掃描沒看到」= `last_seen < scanned_at`。
/// `now` = this scan's time; the same value goes into `telepy_lan_meta.scanned_at`, so "not seen in the last scan" is
/// exactly `last_seen < scanned_at`.
pub async fn upsert_scanned(db: &Db, tunnel_id: i64, hosts: &[Found], now: &str) -> sqlx::Result<(usize, usize)> {
    let mut tx = db.write.begin().await?;
    let (mut inserted, mut updated) = (0, 0);
    for h in hosts {
        let ports = serde_json::to_string(&h.open_ports).unwrap_or_else(|_| "[]".into());
        let services = serde_json::to_string(&h.services).unwrap_or_else(|_| "[]".into());
        let existing: Option<i64> = sqlx::query_scalar(&format!("SELECT id FROM {T} WHERE tunnel_id = ? AND address = ?"))
            .bind(tunnel_id)
            .bind(&h.address)
            .fetch_optional(&mut *tx)
            .await?;
        match existing {
            Some(id) => {
                sqlx::query(&format!(
                    "UPDATE {T} SET hostname = COALESCE(?, hostname), mac = COALESCE(?, mac), open_ports = ?, ssh_banner = COALESCE(?, ssh_banner), services = ?, \
                     first_seen = COALESCE(first_seen, ?), last_seen = ?, updated_at = ? WHERE id = ?"
                ))
                .bind(&h.hostname)
                .bind(&h.mac)
                .bind(&ports)
                .bind(&h.ssh_banner)
                .bind(&services)
                .bind(now)
                .bind(now)
                .bind(now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
                updated += 1;
            }
            None => {
                sqlx::query(&format!(
                    "INSERT INTO {T} (tunnel_id, address, hostname, mac, open_ports, ssh_banner, services, ssh_port, source, first_seen, last_seen, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, 22, ?, ?, ?, ?, ?)"
                ))
                .bind(tunnel_id)
                .bind(&h.address)
                .bind(&h.hostname)
                .bind(&h.mac)
                .bind(&ports)
                .bind(&h.ssh_banner)
                .bind(&services)
                .bind(if h.own { "self" } else { "scan" })
                .bind(now)
                .bind(now)
                .bind(now)
                .bind(now)
                .execute(&mut *tx)
                .await?;
                // 裝置自己不算「新主機」。/ The device itself isn't a "new host".
                if !h.own {
                    inserted += 1;
                }
            }
        }
    }
    tx.commit().await?;
    Ok((inserted, updated))
}

/// 這些主機被這次掃描探過了（找到或沒找到都算）。/ These hosts were covered by this scan, found or not.
pub async fn mark_checked(db: &Db, ids: &[i64], at: &str) -> sqlx::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut tx = db.write.begin().await?;
    for id in ids {
        sqlx::query(&format!("UPDATE {T} SET checked_at = ? WHERE id = ?")).bind(at).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await
}

// ── 定時重掃 / Scheduled rescans ───────────────────────────────────────────

#[derive(Debug, Clone, FromRow)]
pub struct LanSchedule {
    pub tunnel_id: i64,
    /// 設定的人；掃描用他的身分與權限跑。/ Who set it; scans run as them.
    pub user_id: i64,
    pub every_secs: i64,
    pub username: Option<String>,
    /// JSON 陣列（CIDR）；null = 裝置自己的網段。/ JSON array of CIDRs; null = the device's own networks.
    pub subnets: Option<String>,
    /// JSON 陣列；null = 預設 port。/ JSON array; null = the default ports.
    pub ports: Option<String>,
    pub identify: bool,
    pub next_at: String,
    pub last_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl LanSchedule {
    pub fn subnet_list(&self) -> Option<Vec<String>> {
        self.subnets.as_deref().and_then(|s| serde_json::from_str(s).ok())
    }
    pub fn port_list(&self) -> Option<Vec<i64>> {
        self.ports.as_deref().and_then(|s| serde_json::from_str(s).ok())
    }
}

const SCHED: &str = "tunnel_id, user_id, every_secs, username, subnets, ports, identify, next_at, last_at, last_error, created_at, updated_at";

pub async fn schedule(db: &Db, tunnel_id: i64) -> sqlx::Result<Option<LanSchedule>> {
    sqlx::query_as(&format!("SELECT {SCHED} FROM telepy_lan_schedule WHERE tunnel_id = ?")).bind(tunnel_id).fetch_optional(&db.read).await
}

/// 到期的（`next_at` ≤ now）。/ The ones that are due.
pub async fn due_schedules(db: &Db, now: &str) -> sqlx::Result<Vec<LanSchedule>> {
    sqlx::query_as(&format!("SELECT {SCHED} FROM telepy_lan_schedule WHERE next_at <= ? ORDER BY next_at")).bind(now).fetch_all(&db.read).await
}

/// 新增或整組換掉（`last_at` / `last_error` 留著）。/ Insert or replace the settings (last run kept).
pub async fn save_schedule(db: &Db, s: &LanSchedule) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO telepy_lan_schedule (tunnel_id, user_id, every_secs, username, subnets, ports, identify, next_at, last_at, last_error, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?) \
         ON CONFLICT(tunnel_id) DO UPDATE SET user_id = excluded.user_id, every_secs = excluded.every_secs, username = excluded.username, subnets = excluded.subnets, \
         ports = excluded.ports, identify = excluded.identify, next_at = excluded.next_at, updated_at = excluded.updated_at",
    )
    .bind(s.tunnel_id)
    .bind(s.user_id)
    .bind(s.every_secs)
    .bind(&s.username)
    .bind(&s.subnets)
    .bind(&s.ports)
    .bind(s.identify)
    .bind(&s.next_at)
    .bind(&s.created_at)
    .bind(&s.updated_at)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 跑完一次：下次時間、結果。/ After a run: the next time and how it went.
pub async fn schedule_ran(db: &Db, tunnel_id: i64, at: &str, next_at: &str, error: Option<&str>) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_lan_schedule SET last_at = ?, next_at = ?, last_error = ? WHERE tunnel_id = ?").bind(at).bind(next_at).bind(error).bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}

/// 只把下次往後挪（裝置離線、有別的掃描在跑）。/ Only move the next run (device offline, another scan running).
pub async fn postpone_schedule(db: &Db, tunnel_id: i64, next_at: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_lan_schedule SET next_at = ? WHERE tunnel_id = ?").bind(next_at).bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}

pub async fn delete_schedule(db: &Db, tunnel_id: i64) -> sqlx::Result<bool> {
    Ok(sqlx::query("DELETE FROM telepy_lan_schedule WHERE tunnel_id = ?").bind(tunnel_id).execute(&db.write).await?.rows_affected() > 0)
}

// ── 注意的主機 / Watched hosts ─────────────────────────────────────────────

pub async fn set_watch(db: &Db, user_id: i64, host_id: i64, on: bool) -> sqlx::Result<()> {
    if on {
        sqlx::query("INSERT OR IGNORE INTO telepy_lan_watch (user_id, host_id, created_at) VALUES (?, ?, ?)").bind(user_id).bind(host_id).bind(now_db()).execute(&db.write).await?;
    } else {
        sqlx::query("DELETE FROM telepy_lan_watch WHERE user_id = ? AND host_id = ?").bind(user_id).bind(host_id).execute(&db.write).await?;
    }
    Ok(())
}

/// 這個人在注意的主機（某條隧道的）。/ The hosts of a tunnel this person watches.
pub async fn watched_by(db: &Db, user_id: i64, tunnel_id: i64) -> sqlx::Result<std::collections::HashSet<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(&format!("SELECT w.host_id FROM telepy_lan_watch w JOIN {T} h ON h.id = w.host_id WHERE w.user_id = ? AND h.tunnel_id = ?"))
        .bind(user_id)
        .bind(tunnel_id)
        .fetch_all(&db.read)
        .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// 一條隧道上每台被注意的主機 → 注意它的人。/ Each watched host of a tunnel → who watches it.
pub async fn watchers(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT w.host_id, w.user_id FROM telepy_lan_watch w JOIN {T} h ON h.id = w.host_id WHERE h.tunnel_id = ? ORDER BY w.host_id, w.user_id"))
        .bind(tunnel_id)
        .fetch_all(&db.read)
        .await
}

