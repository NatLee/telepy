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
    pub label: Option<String>,
    /// 連這台機器時預設的帳號。/ Default login user on this machine.
    pub username: Option<String>,
    pub ssh_port: i64,
    /// `scan` | `manual`
    pub source: String,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl LanHost {
    pub fn open_port_list(&self) -> Vec<u16> {
        serde_json::from_str(&self.open_ports).unwrap_or_default()
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
}

const T: &str = "telepy_lan_host";
const COLS: &str = "id, tunnel_id, address, hostname, mac, open_ports, ssh_banner, label, username, ssh_port, source, first_seen, last_seen, created_at, updated_at";

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
    sqlx::query(&format!("DELETE FROM {T} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    tx.commit().await
}

/// 合併一次掃描的結果：新的插入（source = scan），已知的更新「看到的」欄位（名稱 / MAC / port / banner / last_seen），
/// 不動標籤、帳號、SSH port 與 source。回傳 (新增, 更新) 筆數。
/// Merge a scan: insert new hosts, refresh what was observed on known ones; returns (inserted, updated).
pub async fn upsert_scanned(db: &Db, tunnel_id: i64, hosts: &[Found]) -> sqlx::Result<(usize, usize)> {
    let now = now_db();
    let mut tx = db.write.begin().await?;
    let (mut inserted, mut updated) = (0, 0);
    for h in hosts {
        let ports = serde_json::to_string(&h.open_ports).unwrap_or_else(|_| "[]".into());
        let existing: Option<i64> = sqlx::query_scalar(&format!("SELECT id FROM {T} WHERE tunnel_id = ? AND address = ?"))
            .bind(tunnel_id)
            .bind(&h.address)
            .fetch_optional(&mut *tx)
            .await?;
        match existing {
            Some(id) => {
                sqlx::query(&format!(
                    "UPDATE {T} SET hostname = COALESCE(?, hostname), mac = COALESCE(?, mac), open_ports = ?, ssh_banner = COALESCE(?, ssh_banner), \
                     first_seen = COALESCE(first_seen, ?), last_seen = ?, updated_at = ? WHERE id = ?"
                ))
                .bind(&h.hostname)
                .bind(&h.mac)
                .bind(&ports)
                .bind(&h.ssh_banner)
                .bind(&now)
                .bind(&now)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
                updated += 1;
            }
            None => {
                sqlx::query(&format!(
                    "INSERT INTO {T} (tunnel_id, address, hostname, mac, open_ports, ssh_banner, ssh_port, source, first_seen, last_seen, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, 22, 'scan', ?, ?, ?, ?)"
                ))
                .bind(tunnel_id)
                .bind(&h.address)
                .bind(&h.hostname)
                .bind(&h.mac)
                .bind(&ports)
                .bind(&h.ssh_banner)
                .bind(&now)
                .bind(&now)
                .bind(&now)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
                inserted += 1;
            }
        }
    }
    tx.commit().await?;
    Ok((inserted, updated))
}
