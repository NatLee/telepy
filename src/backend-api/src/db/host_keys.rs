//! 裝置 SSH host key 的釘選紀錄（`telepy_device_host_key`）。每條隧道：`pinned` = 信任的金鑰（第一次連線時記下，
//! 或擁有者確認過的），`rejected` = 之後出現、與釘選不符的金鑰（連線被拒，等擁有者確認）。邏輯在 `ssh::host_keys`。
//! Pinned and rejected SSH host keys of each tunnel's device; the logic lives in `ssh::host_keys`.

use std::collections::HashSet;

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

pub const PINNED: &str = "pinned";
pub const REJECTED: &str = "rejected";

#[derive(Debug, Clone, FromRow)]
pub struct HostKeyRow {
    pub id: i64,
    pub tunnel_id: i64,
    pub status: String,
    pub key_type: String,
    pub fingerprint: String,
    /// `type base64`（沒有註解）。/ `type base64`, no comment.
    pub public_key: String,
    /// `first_use` | `accepted`
    pub source: String,
    /// 被拒絕的次數（rejected 才有意義）。/ How many connections presented it (rejected keys).
    pub attempts: i64,
    pub first_seen: String,
    pub last_seen: String,
}

const COLS: &str = "id, tunnel_id, status, key_type, fingerprint, public_key, source, attempts, first_seen, last_seen";

pub async fn for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<HostKeyRow>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_device_host_key WHERE tunnel_id = ? ORDER BY id"))
        .bind(tunnel_id)
        .fetch_all(&db.read)
        .await
}

/// 釘選的金鑰（`type base64`）。/ The pinned key lines.
pub async fn pinned_lines(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT public_key FROM telepy_device_host_key WHERE tunnel_id = ? AND status = 'pinned' ORDER BY id")
        .bind(tunnel_id)
        .fetch_all(&db.read)
        .await
}

/// 第一次見到：記成釘選（已經有同一把就不動）。/ First use: pin it (no-op when the same key is already there).
pub async fn pin(db: &Db, tunnel_id: i64, key_type: &str, fingerprint: &str, line: &str, source: &str) -> sqlx::Result<()> {
    let now = now_db();
    sqlx::query(
        "INSERT INTO telepy_device_host_key (tunnel_id, status, key_type, fingerprint, public_key, source, attempts, first_seen, last_seen) \
         VALUES (?, 'pinned', ?, ?, ?, ?, 0, ?, ?) ON CONFLICT (tunnel_id, public_key) DO NOTHING",
    )
    .bind(tunnel_id)
    .bind(key_type)
    .bind(fingerprint)
    .bind(line)
    .bind(source)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 記下一把被拒絕的金鑰（同一把再出現就累加次數）。回傳累計次數（1 = 第一次見到）。
/// Record a rejected key (repeat sightings bump the counter). Returns the count, 1 = first sighting.
pub async fn reject(db: &Db, tunnel_id: i64, key_type: &str, fingerprint: &str, line: &str) -> sqlx::Result<i64> {
    let now = now_db();
    sqlx::query_scalar(
        "INSERT INTO telepy_device_host_key (tunnel_id, status, key_type, fingerprint, public_key, source, attempts, first_seen, last_seen) \
         VALUES (?, 'rejected', ?, ?, ?, 'first_use', 1, ?, ?) \
         ON CONFLICT (tunnel_id, public_key) DO UPDATE SET attempts = attempts + 1, last_seen = excluded.last_seen \
         RETURNING attempts",
    )
    .bind(tunnel_id)
    .bind(key_type)
    .bind(fingerprint)
    .bind(line)
    .bind(&now)
    .bind(&now)
    .fetch_one(&db.write)
    .await
}

/// 擁有者確認：被拒絕的那把（依 fingerprint）變成唯一的釘選金鑰，其餘全部清掉。回傳是否找到。
/// Owner confirmation: the rejected key with this fingerprint becomes the only pinned key. Returns whether it existed.
pub async fn accept(db: &Db, tunnel_id: i64, fingerprint: &str) -> sqlx::Result<Option<HostKeyRow>> {
    let mut tx = db.write.begin().await?;
    let row: Option<HostKeyRow> = sqlx::query_as(&format!("SELECT {COLS} FROM telepy_device_host_key WHERE tunnel_id = ? AND status = 'rejected' AND fingerprint = ?"))
        .bind(tunnel_id)
        .bind(fingerprint)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else { return Ok(None) };
    sqlx::query("DELETE FROM telepy_device_host_key WHERE tunnel_id = ? AND id <> ?").bind(tunnel_id).bind(row.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE telepy_device_host_key SET status = 'pinned', source = 'accepted', attempts = 0, first_seen = ?, last_seen = ? WHERE id = ?")
        .bind(now_db())
        .bind(now_db())
        .bind(row.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(row))
}

/// 全部忘掉（下一次連線重新第一次使用）。回傳刪了幾列。/ Forget everything; the next connection pins again.
pub async fn forget(db: &Db, tunnel_id: i64) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM telepy_device_host_key WHERE tunnel_id = ?").bind(tunnel_id).execute(&db.write).await?.rows_affected())
}

/// 有待確認（被拒絕）金鑰的隧道（列表用，一次查完）。/ Tunnels with a rejected key waiting for review.
pub async fn tunnels_with_rejected(db: &Db) -> sqlx::Result<HashSet<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar("SELECT DISTINCT tunnel_id FROM telepy_device_host_key WHERE status = 'rejected'").fetch_all(&db.read).await?;
    Ok(ids.into_iter().collect())
}
