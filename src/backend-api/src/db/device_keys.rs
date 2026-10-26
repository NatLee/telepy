//! 裝置金鑰清單（哪些使用者金鑰該裝到哪台裝置、只裝到哪些帳號）、Telepy 實際裝過的金鑰、各 OS 帳號的同步狀態，
//! 以及手動從 authorized_keys 移除的行（7 天內可還原）。
//! Device key lists (with an optional per-account restriction), the keys Telepy actually installed, per-account
//! sync status, and lines removed from authorized_keys by hand (restorable for 7 days).

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
    /// 只裝到這些帳號（username id 的 JSON 陣列）；NULL = 擁有者能用的每個帳號。/ Chosen accounts (JSON ids); NULL = every allowed one.
    pub accounts: Option<String>,
}

impl Entry {
    /// 選定的帳號 id；None = 全部。壞掉的 JSON 當成全部。/ The chosen username ids; None = all (bad JSON counts as all).
    pub fn account_ids(&self) -> Option<Vec<i64>> {
        parse_accounts(self.accounts.as_deref())
    }
}

/// `accounts` 欄位的 JSON → id 清單。/ The `accounts` column → ids.
pub fn parse_accounts(json: Option<&str>) -> Option<Vec<i64>> {
    let v: Vec<i64> = serde_json::from_str(json?).ok()?;
    Some(v)
}

/// 手動從某帳號的 authorized_keys 移除的一批行。/ One batch of lines removed from an account's authorized_keys by hand.
#[derive(Debug, Clone, FromRow)]
pub struct Removal {
    pub id: i64,
    pub tunnel_id: i64,
    pub username: String,
    /// 移掉的原始行（JSON 陣列）。/ The raw lines removed (JSON array).
    pub lines: String,
    /// 移掉幾把金鑰。/ Keys removed.
    pub keys: i64,
    pub removed_by_id: i64,
    pub removed_by: String,
    pub removed_at: String,
    pub restored_at: Option<String>,
}

impl Removal {
    pub fn raw_lines(&self) -> Vec<String> {
        serde_json::from_str(&self.lines).unwrap_or_default()
    }
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
     e.added_by_id, e.created_at, k.expires_at, e.accounts FROM telepy_device_key e \
     JOIN authorized_keys_userauthorizedkeys k ON k.id = e.user_key_id JOIN auth_user a ON a.id = e.user_id";

pub async fn entries_for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<Entry>> {
    sqlx::query_as(&format!("{ENTRY_SELECT} WHERE e.tunnel_id = ? ORDER BY e.id")).bind(tunnel_id).fetch_all(&db.read).await
}

pub async fn entries_for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<Entry>> {
    sqlx::query_as(&format!("{ENTRY_SELECT} WHERE e.user_id = ? ORDER BY e.id")).bind(user_id).fetch_all(&db.read).await
}

/// 加進清單；已存在回 false。`accounts` = 只裝到這些帳號（None = 全部）。/ Add to the list; false when it was already there.
pub async fn add_entry(db: &Db, tunnel_id: i64, user_key_id: i64, user_id: i64, added_by_id: i64, accounts: Option<&[i64]>) -> sqlx::Result<bool> {
    let r = sqlx::query("INSERT OR IGNORE INTO telepy_device_key (tunnel_id, user_key_id, user_id, added_by_id, created_at, accounts) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(tunnel_id)
        .bind(user_key_id)
        .bind(user_id)
        .bind(added_by_id)
        .bind(now_db())
        .bind(accounts.map(|a| serde_json::to_string(a).unwrap_or_default()))
        .execute(&db.write)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// 改這把金鑰只裝到哪些帳號（None = 全部）。回傳有沒有這一列。/ Change the chosen accounts (None = all); false when not listed.
pub async fn set_entry_accounts(db: &Db, tunnel_id: i64, user_key_id: i64, accounts: Option<&[i64]>) -> sqlx::Result<bool> {
    let r = sqlx::query("UPDATE telepy_device_key SET accounts = ? WHERE tunnel_id = ? AND user_key_id = ?")
        .bind(accounts.map(|a| serde_json::to_string(a).unwrap_or_default()))
        .bind(tunnel_id)
        .bind(user_key_id)
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

/// 記下一次手動移除（還原用）。回傳紀錄 id。/ Record a manual removal so it can be undone; returns the record id.
pub async fn removal_insert(db: &Db, tunnel_id: i64, username: &str, lines: &[String], keys: usize, removed_by_id: i64, removed_by: &str) -> sqlx::Result<i64> {
    let r = sqlx::query("INSERT INTO telepy_device_key_removal (tunnel_id, username, lines, keys, removed_by_id, removed_by, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(tunnel_id)
        .bind(username)
        .bind(serde_json::to_string(lines).unwrap_or_else(|_| "[]".into()))
        .bind(keys as i64)
        .bind(removed_by_id)
        .bind(removed_by)
        .bind(now_db())
        .execute(&db.write)
        .await?;
    Ok(r.last_insert_rowid())
}

const REMOVAL_SELECT: &str = "SELECT id, tunnel_id, username, lines, keys, removed_by_id, removed_by, removed_at, restored_at FROM telepy_device_key_removal";

pub async fn removal_by_id(db: &Db, tunnel_id: i64, id: i64) -> sqlx::Result<Option<Removal>> {
    sqlx::query_as(&format!("{REMOVAL_SELECT} WHERE tunnel_id = ? AND id = ?")).bind(tunnel_id).bind(id).fetch_optional(&db.read).await
}

/// 這台裝置最近的移除（新的在前）。/ Recent removals on this device, newest first.
pub async fn removals_for_tunnel(db: &Db, tunnel_id: i64, limit: i64) -> sqlx::Result<Vec<Removal>> {
    sqlx::query_as(&format!("{REMOVAL_SELECT} WHERE tunnel_id = ? ORDER BY id DESC LIMIT ?")).bind(tunnel_id).bind(limit).fetch_all(&db.read).await
}

/// 標記為已還原（compare-and-set：已還原的不再改）。回傳是否由這次標記。/ Mark restored (compare-and-set).
pub async fn removal_mark_restored(db: &Db, id: i64) -> sqlx::Result<bool> {
    let r = sqlx::query("UPDATE telepy_device_key_removal SET restored_at = ? WHERE id = ? AND restored_at IS NULL").bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(r.rows_affected() > 0)
}

/// 移除紀錄只留這麼久（之後就不能還原了）。/ Removal records (and the undo) are kept this long.
pub const REMOVAL_RETENTION_DAYS: i64 = 7;

/// 清掉過期的移除紀錄。/ Purge expired removal records.
pub async fn removals_purge(db: &Db) -> sqlx::Result<u64> {
    let cutoff = crate::util::db_time(chrono::Utc::now() - chrono::Duration::days(REMOVAL_RETENTION_DAYS));
    Ok(sqlx::query("DELETE FROM telepy_device_key_removal WHERE removed_at < ?").bind(cutoff).execute(&db.write).await?.rows_affected())
}

/// 隧道被刪除：四張表都清掉。/ Tunnel deleted: drop its rows from all four tables.
pub async fn delete_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    for table in ["telepy_device_key", "telepy_device_key_installed", "telepy_device_key_sync", "telepy_device_key_removal"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE tunnel_id = ?")).bind(tunnel_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
