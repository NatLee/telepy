//! 分享（TunnelSharing）與允許的目標使用者名稱（TunnelSharingAllowedUsername）。

use std::collections::{HashMap, HashSet};

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct Sharing {
    pub id: i64,
    pub tunnel_id: i64,
    pub shared_by_id: i64,
    pub shared_with_id: i64,
    pub permission_type: String,
    pub shared_at: String,
    pub updated_at: String,
}

/// Sharing joined with the sharee's user row (for the shared-users list).
#[derive(Debug, Clone, FromRow)]
pub struct SharingWithUser {
    pub id: i64,
    pub tunnel_id: i64,
    pub shared_with_id: i64,
    pub permission_type: String,
    pub shared_at: String,
    pub username: String,
    pub email: String,
}

const S: &str = "tunnels_tunnelsharing";
const S_COLS: &str = "id, tunnel_id, shared_by_id, shared_with_id, permission_type, shared_at, updated_at";
const A: &str = "tunnels_tunnelsharingallowedusername";

pub async fn get(db: &Db, tunnel_id: i64, user_id: i64) -> sqlx::Result<Option<Sharing>> {
    sqlx::query_as(&format!("SELECT {S_COLS} FROM {S} WHERE tunnel_id = ? AND shared_with_id = ?"))
        .bind(tunnel_id)
        .bind(user_id)
        .fetch_optional(&db.read)
        .await
}

pub async fn for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<SharingWithUser>> {
    sqlx::query_as(&format!(
        "SELECT s.id, s.tunnel_id, s.shared_with_id, s.permission_type, s.shared_at, a.username, a.email \
         FROM {S} s JOIN auth_user a ON a.id = s.shared_with_id WHERE s.tunnel_id = ? ORDER BY s.id"
    ))
    .bind(tunnel_id)
    .fetch_all(&db.read)
    .await
}

pub async fn sharee_ids(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(&format!("SELECT shared_with_id FROM {S} WHERE tunnel_id = ? ORDER BY id")).bind(tunnel_id).fetch_all(&db.read).await
}

pub async fn user_has_any_share(db: &Db, user_id: i64) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {S} WHERE shared_with_id = ?")).bind(user_id).fetch_one(&db.read).await?;
    Ok(n > 0)
}

/// `tunnel_permission_context`：一次載入 {tunnel_id: my permission} 與 {tunnel_id: share count}。
pub async fn permission_context(db: &Db, user_id: i64) -> sqlx::Result<(HashMap<i64, String>, HashMap<i64, i64>)> {
    let mine: Vec<(i64, String)> = sqlx::query_as(&format!("SELECT tunnel_id, permission_type FROM {S} WHERE shared_with_id = ?"))
        .bind(user_id)
        .fetch_all(&db.read)
        .await?;
    let counts: Vec<(i64, i64)> = sqlx::query_as(&format!("SELECT tunnel_id, COUNT(*) FROM {S} GROUP BY tunnel_id")).fetch_all(&db.read).await?;
    Ok((mine.into_iter().collect(), counts.into_iter().collect()))
}

/// 所有分享關係 (tunnel_id, shared_with_id)，給廣播計算「誰看得到哪個 port」用。
pub async fn all_pairs(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT tunnel_id, shared_with_id FROM {S}")).fetch_all(&db.read).await
}

pub async fn create(db: &Db, tunnel_id: i64, shared_by: i64, shared_with: i64, permission: &str) -> sqlx::Result<Sharing> {
    let now = now_db();
    let id = sqlx::query(&format!("INSERT INTO {S} (shared_at, updated_at, shared_by_id, shared_with_id, tunnel_id, permission_type) VALUES (?, ?, ?, ?, ?, ?)"))
        .bind(&now)
        .bind(&now)
        .bind(shared_by)
        .bind(shared_with)
        .bind(tunnel_id)
        .bind(permission)
        .execute(&db.write)
        .await?
        .last_insert_rowid();
    sqlx::query_as(&format!("SELECT {S_COLS} FROM {S} WHERE id = ?")).bind(id).fetch_one(&db.read).await
}

pub async fn set_permission(db: &Db, id: i64, permission: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {S} SET permission_type = ?, updated_at = ? WHERE id = ?"))
        .bind(permission)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn delete(db: &Db, id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {A} WHERE tunnel_sharing_id = ?")).bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {S} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------- allowed usernames

pub async fn allowed_username_ids(db: &Db, sharing_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(&format!("SELECT reverse_server_username_id FROM {A} WHERE tunnel_sharing_id = ? ORDER BY id"))
        .bind(sharing_id)
        .fetch_all(&db.read)
        .await
}

/// 這條隧道的 ADMIN sharee（管理它的人；收安全通知用）。/ ADMIN sharees of a tunnel (they manage it).
pub async fn admin_sharee_ids(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(&format!("SELECT shared_with_id FROM {S} WHERE tunnel_id = ? AND permission_type = 'admin' ORDER BY id"))
        .bind(tunnel_id)
        .fetch_all(&db.read)
        .await
}

/// 這位 sharee 至少有一個「允許的目標帳號」的隧道（與 `permissions::allowed_usernames` 同語意：
/// 只算仍屬於該隧道的帳號）。一次查完，給列表用。/ Tunnels where this sharee may log in as at least one account.
pub async fn tunnels_with_allowed_usernames(db: &Db, user_id: i64) -> sqlx::Result<HashSet<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar(&format!(
        "SELECT DISTINCT s.tunnel_id FROM {S} s JOIN {A} a ON a.tunnel_sharing_id = s.id \
         JOIN authorized_keys_reverseserverusernames u ON u.id = a.reverse_server_username_id AND u.reverse_server_id = s.tunnel_id \
         WHERE s.shared_with_id = ?"
    ))
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    Ok(ids.into_iter().collect())
}

/// (username_id, username) for the shared-users listing.
pub async fn allowed_usernames(db: &Db, sharing_id: i64) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as(&format!(
        "SELECT u.id, u.username FROM {A} a JOIN authorized_keys_reverseserverusernames u ON u.id = a.reverse_server_username_id \
         WHERE a.tunnel_sharing_id = ? ORDER BY a.id"
    ))
    .bind(sharing_id)
    .fetch_all(&db.read)
    .await
}

/// 以 ids 取代整組（只接受屬於該隧道的 username id）。/ Replace the allow-list (validated against the tunnel).
pub async fn replace_allowed_usernames(db: &Db, sharing_id: i64, tunnel_id: i64, ids: &[i64]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {A} WHERE tunnel_sharing_id = ?")).bind(sharing_id).execute(&mut *tx).await?;
    for id in ids {
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO {A} (tunnel_sharing_id, reverse_server_username_id) \
             SELECT ?, id FROM authorized_keys_reverseserverusernames WHERE id = ? AND reverse_server_id = ?"
        ))
        .bind(sharing_id)
        .bind(id)
        .bind(tunnel_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn add_allowed_usernames(db: &Db, sharing_id: i64, tunnel_id: i64, ids: &[i64]) -> sqlx::Result<()> {
    for id in ids {
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO {A} (tunnel_sharing_id, reverse_server_username_id) \
             SELECT ?, id FROM authorized_keys_reverseserverusernames WHERE id = ? AND reverse_server_id = ?"
        ))
        .bind(sharing_id)
        .bind(id)
        .bind(tunnel_id)
        .execute(&db.write)
        .await?;
    }
    Ok(())
}
