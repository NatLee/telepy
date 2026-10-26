//! 登記在 Telepy（當 RustDesk 的 ID 伺服器）的 RustDesk 裝置（`telepy_rustdesk_device`）。一列 = 一台、一個擁有者；
//! `rustdesk_id` 全站唯一；`uuid`、`pk` 是登記（`--deploy`）時裝置送來的，之後註冊要對得上才放行。
//! RustDesk devices enrolled with Telepy's ID server: one row per device and owner; the RustDesk ID is unique,
//! and registrations must match the uuid and key sent at enrolment.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct RustDeskDevice {
    pub id: i64,
    pub user_id: i64,
    pub rustdesk_id: String,
    /// base64。
    pub uuid: String,
    /// base64（裝置的 ed25519 簽章公鑰）。/ base64 of the device's signing public key.
    pub pk: String,
    pub name: String,
    pub hostname: String,
    pub os: String,
    pub version: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
}

const COLS: &str = "id, user_id, rustdesk_id, uuid, pk, name, hostname, os, version, created_at, last_seen_at";

pub async fn all(db: &Db) -> sqlx::Result<Vec<RustDeskDevice>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_rustdesk_device ORDER BY name, id")).fetch_all(&db.read).await
}

pub async fn for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<RustDeskDevice>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_rustdesk_device WHERE user_id = ? ORDER BY name, id")).bind(user_id).fetch_all(&db.read).await
}

pub async fn by_id(db: &Db, id: i64) -> sqlx::Result<Option<RustDeskDevice>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_rustdesk_device WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn by_rustdesk_id(db: &Db, rustdesk_id: &str) -> sqlx::Result<Option<RustDeskDevice>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_rustdesk_device WHERE rustdesk_id = ?")).bind(rustdesk_id).fetch_optional(&db.read).await
}

/// 登記（新的一列），或同一個擁有者重新登記同一台（更新 uuid、公鑰）。回傳那一列與「是不是新的」。
/// Enrol a new device, or re-enrol the owner's existing one (new uuid / key). Returns the row and whether it is new.
pub async fn enrol(db: &Db, user_id: i64, rustdesk_id: &str, uuid: &str, pk: &str, name: &str) -> sqlx::Result<(RustDeskDevice, bool)> {
    if let Some(existing) = by_rustdesk_id(db, rustdesk_id).await? {
        sqlx::query("UPDATE telepy_rustdesk_device SET uuid = ?, pk = ? WHERE id = ?").bind(uuid).bind(pk).bind(existing.id).execute(&db.write).await?;
        let row = by_id(db, existing.id).await?.expect("row just updated");
        return Ok((row, false));
    }
    let id = sqlx::query(
        "INSERT INTO telepy_rustdesk_device (user_id, rustdesk_id, uuid, pk, name, hostname, os, version, created_at, last_seen_at) \
         VALUES (?, ?, ?, ?, ?, '', '', '', ?, NULL)",
    )
    .bind(user_id)
    .bind(rustdesk_id)
    .bind(uuid)
    .bind(pk)
    .bind(name)
    .bind(now_db())
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    Ok((by_id(db, id).await?.expect("row just inserted"), true))
}

pub async fn touch(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_rustdesk_device SET last_seen_at = ? WHERE id = ?").bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 裝置自己回報的系統資訊（`/api/sysinfo`）。/ What the device reports about itself.
pub async fn set_sysinfo(db: &Db, id: i64, hostname: &str, os: &str, version: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_rustdesk_device SET hostname = ?, os = ?, version = ?, last_seen_at = ? WHERE id = ?")
        .bind(hostname)
        .bind(os)
        .bind(version)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn rename(db: &Db, id: i64, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_rustdesk_device SET name = ? WHERE id = ?").bind(name).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 刪掉裝置，連同它的連線紀錄與綁在它上面的憑證。/ Delete a device with its session history and saved logins.
pub async fn delete(db: &Db, id: i64) -> sqlx::Result<bool> {
    let mut tx = db.write.begin().await?;
    let gone = sqlx::query("DELETE FROM telepy_rustdesk_device WHERE id = ?").bind(id).execute(&mut *tx).await?.rows_affected() > 0;
    sqlx::query("DELETE FROM telepy_rustdesk_session WHERE device_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_credential WHERE rustdesk_device_id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(gone)
}

// ---- 連線紀錄 / session history ------------------------------------------------------------

/// 每台最多留幾筆。/ Rows kept per device.
pub const SESSIONS_PER_DEVICE: i64 = 200;

#[derive(Debug, Clone, FromRow)]
pub struct DeviceSession {
    pub id: i64,
    pub device_id: i64,
    pub user_id: i64,
    pub username: String,
    pub ip: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub to_browser: i64,
    pub to_device: i64,
    pub reason: String,
}

const SESSION_COLS: &str = "id, device_id, user_id, username, ip, started_at, ended_at, to_browser, to_device, reason";

/// 開一筆（連上時）；超過上限就刪最舊的。/ Open a row when a session connects; trim to the cap.
pub async fn open_session(db: &Db, device_id: i64, user_id: i64, username: &str, ip: Option<&str>) -> sqlx::Result<i64> {
    let id = sqlx::query("INSERT INTO telepy_rustdesk_session (device_id, user_id, username, ip, started_at) VALUES (?, ?, ?, ?, ?)")
        .bind(device_id)
        .bind(user_id)
        .bind(username)
        .bind(ip)
        .bind(now_db())
        .execute(&db.write)
        .await?
        .last_insert_rowid();
    sqlx::query("DELETE FROM telepy_rustdesk_session WHERE device_id = ? AND id NOT IN (SELECT id FROM telepy_rustdesk_session WHERE device_id = ? ORDER BY id DESC LIMIT ?)")
        .bind(device_id)
        .bind(device_id)
        .bind(SESSIONS_PER_DEVICE)
        .execute(&db.write)
        .await?;
    Ok(id)
}

pub async fn close_session(db: &Db, id: i64, to_browser: u64, to_device: u64, reason: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_rustdesk_session SET ended_at = ?, to_browser = ?, to_device = ?, reason = ? WHERE id = ? AND ended_at IS NULL")
        .bind(now_db())
        .bind(i64::try_from(to_browser).unwrap_or(i64::MAX))
        .bind(i64::try_from(to_device).unwrap_or(i64::MAX))
        .bind(reason)
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 最近的連線（新的在前）。/ Recent sessions, newest first.
pub async fn recent_sessions(db: &Db, device_id: i64, limit: i64) -> sqlx::Result<Vec<DeviceSession>> {
    sqlx::query_as(&format!("SELECT {SESSION_COLS} FROM telepy_rustdesk_session WHERE device_id = ? ORDER BY id DESC LIMIT ?")).bind(device_id).bind(limit).fetch_all(&db.read).await
}

/// 每台最後一次被連（誰、何時）。/ Each device's latest session: who and when.
pub async fn last_sessions(db: &Db) -> sqlx::Result<std::collections::HashMap<i64, (String, String)>> {
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT s.device_id, s.username, s.started_at FROM telepy_rustdesk_session s \
         JOIN (SELECT device_id, MAX(id) AS id FROM telepy_rustdesk_session GROUP BY device_id) m ON m.id = s.id",
    )
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().map(|(d, u, at)| (d, (u, at))).collect())
}

/// 重啟前沒收尾的：結束時間記成開始時間、原因 restart。/ Rows a restart left open.
pub async fn close_orphans(db: &Db) -> sqlx::Result<u64> {
    Ok(sqlx::query("UPDATE telepy_rustdesk_session SET ended_at = started_at, reason = 'restart' WHERE ended_at IS NULL").execute(&db.write).await?.rows_affected())
}
