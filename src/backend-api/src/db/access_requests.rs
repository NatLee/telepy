//! 存取申請（`telepy_access_request`）與核准後的暫時授權（分享列的 `base_permission` / `permission_until`、
//! 允許帳號列的 `expires_at`）。
//! Access requests and the temporary grants an approval creates (sharing `base_permission` / `permission_until`,
//! allow-list `expires_at`).

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct AccessRequest {
    pub id: i64,
    pub tunnel_id: i64,
    pub requester_id: i64,
    /// JSON 陣列的 username id。/ Username ids as a JSON array.
    pub username_ids: String,
    pub permission: Option<String>,
    pub duration_secs: i64,
    pub reason: String,
    /// pending / approved / denied / cancelled
    pub status: String,
    pub created_at: String,
    pub decided_by_id: Option<i64>,
    pub decided_at: Option<String>,
    pub ends_at: Option<String>,
}

impl AccessRequest {
    pub fn usernames(&self) -> Vec<i64> {
        serde_json::from_str(&self.username_ids).unwrap_or_default()
    }
}

const R: &str = "telepy_access_request";
const COLS: &str = "id, tunnel_id, requester_id, username_ids, permission, duration_secs, reason, status, created_at, decided_by_id, decided_at, ends_at";
const S: &str = "tunnels_tunnelsharing";
const A: &str = "tunnels_tunnelsharingallowedusername";

pub async fn create(db: &Db, tunnel_id: i64, requester_id: i64, username_ids: &[i64], permission: Option<&str>, duration_secs: i64, reason: &str) -> sqlx::Result<AccessRequest> {
    let id = sqlx::query(&format!(
        "INSERT INTO {R} (tunnel_id, requester_id, username_ids, permission, duration_secs, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
    ))
    .bind(tunnel_id)
    .bind(requester_id)
    .bind(serde_json::to_string(username_ids).unwrap_or_else(|_| "[]".into()))
    .bind(permission)
    .bind(duration_secs)
    .bind(reason)
    .bind(now_db())
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    get(db, id).await?.ok_or(sqlx::Error::RowNotFound)
}

pub async fn get(db: &Db, id: i64) -> sqlx::Result<Option<AccessRequest>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {R} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 這個人在這條隧道上還在等的申請。/ This user's pending request on this tunnel.
pub async fn pending_of(db: &Db, tunnel_id: i64, requester_id: i64) -> sqlx::Result<Option<AccessRequest>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {R} WHERE tunnel_id = ? AND requester_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"))
        .bind(tunnel_id)
        .bind(requester_id)
        .fetch_optional(&db.read)
        .await
}

/// 一條隧道的申請：還在等的全部，加上最近 `recent` 筆已決定的。/ Pending ones plus the latest `recent` decided ones.
pub async fn for_tunnel(db: &Db, tunnel_id: i64, recent: i64) -> sqlx::Result<Vec<AccessRequest>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM {R} WHERE tunnel_id = ? AND (status = 'pending' OR id IN \
         (SELECT id FROM {R} WHERE tunnel_id = ? AND status != 'pending' ORDER BY id DESC LIMIT ?)) ORDER BY id DESC"
    ))
    .bind(tunnel_id)
    .bind(tunnel_id)
    .bind(recent)
    .fetch_all(&db.read)
    .await
}

/// 某人在某隧道上最近的申請（自己看狀態用）。/ A requester's latest requests on a tunnel.
pub async fn of_requester(db: &Db, tunnel_id: i64, requester_id: i64, limit: i64) -> sqlx::Result<Vec<AccessRequest>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {R} WHERE tunnel_id = ? AND requester_id = ? ORDER BY id DESC LIMIT ?"))
        .bind(tunnel_id)
        .bind(requester_id)
        .bind(limit)
        .fetch_all(&db.read)
        .await
}

/// {tunnel_id: 等待中的申請數}。/ Pending request counts per tunnel.
pub async fn pending_counts(db: &Db) -> sqlx::Result<std::collections::HashMap<i64, i64>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(&format!("SELECT tunnel_id, COUNT(*) FROM {R} WHERE status = 'pending' GROUP BY tunnel_id"))
        .fetch_all(&db.read)
        .await?;
    Ok(rows.into_iter().collect())
}

/// 只在還是 pending 時改狀態（兩個人同時按也只有一個成功）。/ Decide only while pending (compare-and-set).
pub async fn decide(db: &Db, id: i64, status: &str, by: Option<i64>, ends_at: Option<&str>) -> sqlx::Result<bool> {
    let n = sqlx::query(&format!("UPDATE {R} SET status = ?, decided_by_id = ?, decided_at = ?, ends_at = ? WHERE id = ? AND status = 'pending'"))
        .bind(status)
        .bind(by)
        .bind(now_db())
        .bind(ends_at)
        .bind(id)
        .execute(&db.write)
        .await?
        .rows_affected();
    Ok(n == 1)
}

/// 分享結束時，他在這條隧道上還在等的申請一併取消。/ Cancel pending requests when the share ends.
pub async fn cancel_pending_of(db: &Db, tunnel_id: i64, requester_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {R} SET status = 'cancelled', decided_at = ? WHERE tunnel_id = ? AND requester_id = ? AND status = 'pending'"))
        .bind(now_db())
        .bind(tunnel_id)
        .bind(requester_id)
        .execute(&db.write)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------- temporary grants

/// 暫時加帳號：新的帶期限；已經是暫時的就延到比較晚的那個；永久的不動。回傳新加或延長的 id。
/// Temporarily allow accounts: new rows carry the end, temporary ones are extended to the later end, permanent ones
/// stay as they are. Returns the ids added or extended.
pub async fn grant_usernames(db: &Db, sharing_id: i64, tunnel_id: i64, ids: &[i64], until: &str) -> sqlx::Result<Vec<i64>> {
    let mut granted = Vec::new();
    for id in ids {
        let n = sqlx::query(&format!(
            "INSERT INTO {A} (tunnel_sharing_id, reverse_server_username_id, expires_at) \
             SELECT ?, id, ? FROM authorized_keys_reverseserverusernames WHERE id = ? AND reverse_server_id = ? \
             ON CONFLICT (tunnel_sharing_id, reverse_server_username_id) DO UPDATE SET expires_at = excluded.expires_at \
             WHERE expires_at IS NOT NULL AND expires_at < excluded.expires_at"
        ))
        .bind(sharing_id)
        .bind(until)
        .bind(id)
        .bind(tunnel_id)
        .execute(&db.write)
        .await?
        .rows_affected();
        if n == 1 {
            granted.push(*id);
        }
    }
    Ok(granted)
}

/// 暫時提升權限：記住原本的（已經在提升中就保留最初的），到 `until` 為止。
/// Temporarily raise the permission, remembering the original one (kept when already raised), until `until`.
pub async fn raise_permission(db: &Db, sharing_id: i64, permission: &str, until: &str) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "UPDATE {S} SET base_permission = COALESCE(base_permission, permission_type), permission_type = ?, permission_until = ?, updated_at = ? WHERE id = ?"
    ))
    .bind(permission)
    .bind(until)
    .bind(now_db())
    .bind(sharing_id)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 到期的暫時帳號：(sharing_id, tunnel_id, shared_with_id, username_id)。/ Temporary accounts past their end.
pub async fn expired_usernames(db: &Db) -> sqlx::Result<Vec<(i64, i64, i64, i64)>> {
    sqlx::query_as(&format!(
        "SELECT a.tunnel_sharing_id, s.tunnel_id, s.shared_with_id, a.reverse_server_username_id FROM {A} a \
         JOIN {S} s ON s.id = a.tunnel_sharing_id WHERE a.expires_at IS NOT NULL AND a.expires_at <= ? ORDER BY a.id"
    ))
    .bind(now_db())
    .fetch_all(&db.read)
    .await
}

pub async fn remove_username(db: &Db, sharing_id: i64, username_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {A} WHERE tunnel_sharing_id = ? AND reverse_server_username_id = ? AND expires_at IS NOT NULL"))
        .bind(sharing_id)
        .bind(username_id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 提升期滿的分享：(sharing_id, tunnel_id, shared_with_id, base_permission)。/ Raised permissions past their end.
pub async fn expired_raises(db: &Db) -> sqlx::Result<Vec<(i64, i64, i64, String)>> {
    sqlx::query_as(&format!(
        "SELECT id, tunnel_id, shared_with_id, base_permission FROM {S} \
         WHERE permission_until IS NOT NULL AND permission_until <= ? AND base_permission IS NOT NULL ORDER BY id"
    ))
    .bind(now_db())
    .fetch_all(&db.read)
    .await
}

/// 回到原本的權限。/ Back to the original permission.
pub async fn revert_raise(db: &Db, sharing_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "UPDATE {S} SET permission_type = base_permission, base_permission = NULL, permission_until = NULL, updated_at = ? \
         WHERE id = ? AND base_permission IS NOT NULL"
    ))
    .bind(now_db())
    .bind(sharing_id)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 分享列上的暫時權限：(base_permission, permission_until)。/ The temporary raise on a share, if any.
pub async fn raise_of(db: &Db, sharing_id: i64) -> sqlx::Result<Option<(String, String)>> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(&format!("SELECT base_permission, permission_until FROM {S} WHERE id = ?"))
        .bind(sharing_id)
        .fetch_optional(&db.read)
        .await?;
    Ok(row.and_then(|(b, u)| b.zip(u)))
}

/// 允許帳號各自的期限（只列暫時的）：{username_id: expires_at}。/ Ends of temporary accounts on a share.
pub async fn username_ends(db: &Db, sharing_id: i64) -> sqlx::Result<std::collections::HashMap<i64, String>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(&format!("SELECT reverse_server_username_id, expires_at FROM {A} WHERE tunnel_sharing_id = ? AND expires_at IS NOT NULL"))
        .bind(sharing_id)
        .fetch_all(&db.read)
        .await?;
    Ok(rows.into_iter().collect())
}
