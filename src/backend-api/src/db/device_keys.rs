//! 裝置金鑰清單（哪些使用者金鑰該裝到哪台裝置）、Telepy 實際裝過的金鑰、各 OS 帳號的同步狀態。
//! Device key lists, the keys Telepy actually installed, and per-account sync status.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

/// 清單的一列，連同金鑰本身與擁有者名稱。
#[derive(Debug, Clone, FromRow)]
pub struct Entry {
    pub tunnel_id: i64,
    pub user_key_id: i64,
    pub user_id: i64,
    pub owner_username: String,
    pub name: String,
    pub key: String,
    pub added_by_id: i64,
    pub created_at: String,
    /// 金鑰的到期時間：到期的不再裝到裝置上（已裝的會被移除）。/ Key expiry: expired keys leave the device.
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct Installed {
    pub tunnel_id: i64,
    pub username: String,
    pub key_bare: String,
    pub fingerprint: String,
    pub user_key_id: Option<i64>,
    pub user_id: Option<i64>,
    pub installed_at: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct SyncStatus {
    pub username: String,
    pub ok: bool,
    pub error: Option<String>,
    pub synced_at: String,
}

const ENTRY_SELECT: &str = "SELECT e.tunnel_id, e.user_key_id, e.user_id, a.username AS owner_username, k.host_friendly_name AS name, k.key, \
     e.added_by_id, e.created_at, k.expires_at FROM telepy_device_key e \
     JOIN authorized_keys_userauthorizedkeys k ON k.id = e.user_key_id JOIN auth_user a ON a.id = e.user_id";

pub async fn entries_for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<Entry>> {
    sqlx::query_as(&format!("{ENTRY_SELECT} WHERE e.tunnel_id = ? ORDER BY e.id")).bind(tunnel_id).fetch_all(&db.read).await
}

pub async fn entries_for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<Entry>> {
    sqlx::query_as(&format!("{ENTRY_SELECT} WHERE e.user_id = ? ORDER BY e.id")).bind(user_id).fetch_all(&db.read).await
}

/// 加進清單；已存在回 false。/ Add to the list; false when it was already there.
pub async fn add_entry(db: &Db, tunnel_id: i64, user_key_id: i64, user_id: i64, added_by_id: i64) -> sqlx::Result<bool> {
    let r = sqlx::query("INSERT OR IGNORE INTO telepy_device_key (tunnel_id, user_key_id, user_id, added_by_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(tunnel_id)
        .bind(user_key_id)
        .bind(user_id)
        .bind(added_by_id)
        .bind(now_db())
        .execute(&db.write)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn delete_entry(db: &Db, tunnel_id: i64, user_key_id: i64) -> sqlx::Result<bool> {
    let r = sqlx::query("DELETE FROM telepy_device_key WHERE tunnel_id = ? AND user_key_id = ?").bind(tunnel_id).bind(user_key_id).execute(&db.write).await?;
    Ok(r.rows_affected() > 0)
}

/// 分享被撤銷：這位使用者在這台裝置清單上的金鑰全部移除。
pub async fn delete_entries_of_user(db: &Db, tunnel_id: i64, user_id: i64) -> sqlx::Result<u64> {
    let r = sqlx::query("DELETE FROM telepy_device_key WHERE tunnel_id = ? AND user_id = ?").bind(tunnel_id).bind(user_id).execute(&db.write).await?;
    Ok(r.rows_affected())
}

/// 金鑰被刪除：從每台裝置的清單移除（已裝上的由同步移除）。
pub async fn delete_entries_for_key(db: &Db, user_key_id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_device_key WHERE user_key_id = ?").bind(user_key_id).execute(&db.write).await?;
    Ok(())
}

/// 用到這把金鑰的隧道（在清單上或已裝上）。
pub async fn tunnels_with_key(db: &Db, user_key_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "SELECT tunnel_id FROM telepy_device_key WHERE user_key_id = ? UNION SELECT tunnel_id FROM telepy_device_key_installed WHERE user_key_id = ?",
    )
    .bind(user_key_id)
    .bind(user_key_id)
    .fetch_all(&db.read)
    .await
}

/// 有清單或有已裝金鑰的隧道（同步迴圈要看的範圍）。
pub async fn tunnels_with_state(db: &Db) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar("SELECT tunnel_id FROM telepy_device_key UNION SELECT tunnel_id FROM telepy_device_key_installed").fetch_all(&db.read).await
}

pub async fn installed_for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<Installed>> {
    sqlx::query_as(
        "SELECT tunnel_id, username, key_bare, fingerprint, user_key_id, user_id, installed_at FROM telepy_device_key_installed WHERE tunnel_id = ? ORDER BY id",
    )
    .bind(tunnel_id)
    .fetch_all(&db.read)
    .await
}

pub async fn installed_insert(db: &Db, tunnel_id: i64, username: &str, key_bare: &str, fingerprint: &str, user_key_id: Option<i64>, user_id: Option<i64>) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO telepy_device_key_installed (tunnel_id, username, key_bare, fingerprint, user_key_id, user_id, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(tunnel_id)
    .bind(username)
    .bind(key_bare)
    .bind(fingerprint)
    .bind(user_key_id)
    .bind(user_id)
    .bind(now_db())
    .execute(&db.write)
    .await?;
    Ok(())
}

pub async fn installed_delete(db: &Db, tunnel_id: i64, username: &str, key_bare: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_device_key_installed WHERE tunnel_id = ? AND username = ? AND key_bare = ?")
        .bind(tunnel_id)
        .bind(username)
        .bind(key_bare)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn sync_set(db: &Db, tunnel_id: i64, username: &str, error: Option<&str>) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO telepy_device_key_sync (tunnel_id, username, ok, error, synced_at) VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT (tunnel_id, username) DO UPDATE SET ok = excluded.ok, error = excluded.error, synced_at = excluded.synced_at",
    )
    .bind(tunnel_id)
    .bind(username)
    .bind(error.is_none())
    .bind(error)
    .bind(now_db())
    .execute(&db.write)
    .await?;
    Ok(())
}

pub async fn sync_for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<SyncStatus>> {
    sqlx::query_as("SELECT username, ok, error, synced_at FROM telepy_device_key_sync WHERE tunnel_id = ? ORDER BY username")
        .bind(tunnel_id)
        .fetch_all(&db.read)
        .await
}

pub async fn sync_delete(db: &Db, tunnel_id: i64, username: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_device_key_sync WHERE tunnel_id = ? AND username = ?").bind(tunnel_id).bind(username).execute(&db.write).await?;
    Ok(())
}

/// 隧道被刪除：三張表都清掉。/ Tunnel deleted: drop its rows from all three tables.
pub async fn delete_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    for table in ["telepy_device_key", "telepy_device_key_installed", "telepy_device_key_sync"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE tunnel_id = ?")).bind(tunnel_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
