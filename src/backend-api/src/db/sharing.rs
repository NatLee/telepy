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
    /// 分享到什麼時候（None = 一直有效）。/ When the share ends (None = never).
    pub expires_at: Option<String>,
    /// 核准的存取申請暫時提升了權限：原本的權限與到期時間。/ A temporary raise from an access request.
    pub base_permission: Option<String>,
    pub permission_until: Option<String>,
}

impl Sharing {
    /// 現在有效的權限：暫時提升過期了（回收前那 30 秒內）就算回原本的。
    /// The permission in force now: once a temporary raise has run out it counts as the original, even before the reaper reverts it.
    pub fn permission(&self) -> &str {
        match (&self.base_permission, &self.permission_until) {
            (Some(base), Some(until)) if until.as_str() <= now_db().as_str() => base,
            _ => &self.permission_type,
        }
    }
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
    pub expires_at: Option<String>,
    pub base_permission: Option<String>,
    pub permission_until: Option<String>,
}

const S: &str = "tunnels_tunnelsharing";
const S_COLS: &str = "id, tunnel_id, shared_by_id, shared_with_id, permission_type, shared_at, updated_at, expires_at, base_permission, permission_until";
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
        "SELECT s.id, s.tunnel_id, s.shared_with_id, s.permission_type, s.shared_at, a.username, a.email, s.expires_at, s.base_permission, s.permission_until \
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
    let mine: Vec<(i64, String)> = sqlx::query_as(&format!(
        "SELECT tunnel_id, CASE WHEN base_permission IS NOT NULL AND permission_until <= ? THEN base_permission ELSE permission_type END \
         FROM {S} WHERE shared_with_id = ?"
    ))
        .bind(now_db())
        .bind(user_id)
        .fetch_all(&db.read)
        .await?;
    let counts: Vec<(i64, i64)> = sqlx::query_as(&format!("SELECT tunnel_id, COUNT(*) FROM {S} GROUP BY tunnel_id")).fetch_all(&db.read).await?;
    Ok((mine.into_iter().collect(), counts.into_iter().collect()))
}

/// 一位分享對象：列表上「已分享給 N 人」hover 時列出來。/ One sharee, listed when hovering "Shared with N" on the tunnels list.
#[derive(Debug, Clone, FromRow)]
pub struct Sharee {
    pub tunnel_id: i64,
    pub id: i64,
    pub username: String,
    /// 現在有效的權限（同 [`Sharing::permission`]）。/ The permission in force now (as [`Sharing::permission`]).
    pub permission: String,
}

/// 我看得到的隧道（owned ∪ shared）各自分享給誰，一次查完；順序同分享視窗（分享的先後）。
/// 誰能看由呼叫端決定（owner / ADMIN，同分享管理）。
/// Sharees of every tunnel the user can see, in one query, ordered like the share dialog; the caller decides who may see them.
pub async fn sharees_of_visible(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, Vec<Sharee>>> {
    let rows: Vec<Sharee> = sqlx::query_as(&format!(
        "SELECT s.tunnel_id, s.shared_with_id AS id, a.username, \
         CASE WHEN s.base_permission IS NOT NULL AND s.permission_until <= ? THEN s.base_permission ELSE s.permission_type END AS permission \
         FROM {S} s JOIN auth_user a ON a.id = s.shared_with_id \
         WHERE s.tunnel_id IN (SELECT id FROM authorized_keys_reverseserverauthorizedkeys WHERE user_id = ? UNION SELECT tunnel_id FROM {S} WHERE shared_with_id = ?) \
         ORDER BY s.tunnel_id, s.id"
    ))
    .bind(now_db())
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    let mut map: HashMap<i64, Vec<Sharee>> = HashMap::new();
    for r in rows {
        map.entry(r.tunnel_id).or_default().push(r);
    }
    Ok(map)
}

/// 所有分享關係 (tunnel_id, shared_with_id)，給廣播計算「誰看得到哪個 port」用。
pub async fn all_pairs(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT tunnel_id, shared_with_id FROM {S}")).fetch_all(&db.read).await
}

pub async fn create(db: &Db, tunnel_id: i64, shared_by: i64, shared_with: i64, permission: &str, expires_at: Option<&str>) -> sqlx::Result<Sharing> {
    let now = now_db();
    let id = sqlx::query(&format!("INSERT INTO {S} (shared_at, updated_at, shared_by_id, shared_with_id, tunnel_id, permission_type, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"))
        .bind(&now)
        .bind(&now)
        .bind(shared_by)
        .bind(shared_with)
        .bind(tunnel_id)
        .bind(permission)
        .bind(expires_at)
        .execute(&db.write)
        .await?
        .last_insert_rowid();
    sqlx::query_as(&format!("SELECT {S_COLS} FROM {S} WHERE id = ?")).bind(id).fetch_one(&db.read).await
}

/// 手動設定權限；暫時提升（存取申請）就此結束。/ Set the permission by hand; any temporary raise ends here.
pub async fn set_permission(db: &Db, id: i64, permission: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {S} SET permission_type = ?, base_permission = NULL, permission_until = NULL, updated_at = ? WHERE id = ?"))
        .bind(permission)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn set_expiry(db: &Db, id: i64, expires_at: Option<&str>) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {S} SET expires_at = ?, updated_at = ? WHERE id = ?")).bind(expires_at).bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 已經到期、還沒收掉的分享。/ Shares past their end that haven't been removed yet.
pub async fn expired(db: &Db) -> sqlx::Result<Vec<Sharing>> {
    sqlx::query_as(&format!("SELECT {S_COLS} FROM {S} WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY id")).bind(now_db()).fetch_all(&db.read).await
}

/// 我被分享的隧道各自到什麼時候（只列有期限的）。/ When each share I hold ends (timed ones only).
pub async fn my_expiries(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, String>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(&format!("SELECT tunnel_id, expires_at FROM {S} WHERE shared_with_id = ? AND expires_at IS NOT NULL"))
        .bind(user_id)
        .fetch_all(&db.read)
        .await?;
    Ok(rows.into_iter().collect())
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
    sqlx::query_scalar(&format!("SELECT reverse_server_username_id FROM {A} a WHERE tunnel_sharing_id = ? AND (a.expires_at IS NULL OR a.expires_at > ?) ORDER BY id"))
        .bind(sharing_id)
        .bind(now_db())
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
         WHERE s.shared_with_id = ? AND (a.expires_at IS NULL OR a.expires_at > ?)"
    ))
    .bind(user_id)
    .bind(now_db())
    .fetch_all(&db.read)
    .await?;
    Ok(ids.into_iter().collect())
}

/// (username_id, username) for the shared-users listing.
pub async fn allowed_usernames(db: &Db, sharing_id: i64) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as(&format!(
        "SELECT u.id, u.username FROM {A} a JOIN authorized_keys_reverseserverusernames u ON u.id = a.reverse_server_username_id \
         WHERE a.tunnel_sharing_id = ? AND (a.expires_at IS NULL OR a.expires_at > ?) ORDER BY a.id"
    ))
    .bind(sharing_id)
    .bind(now_db())
    .fetch_all(&db.read)
    .await
}

/// 以 ids 取代整組（只接受屬於該隧道的 username id）。留下來的暫時帳號保留原本的期限——改清單不會讓它變成永久的。
/// Replace the allow-list (validated against the tunnel). Temporary accounts that stay keep their end, so editing
/// the list never makes one permanent.
pub async fn replace_allowed_usernames(db: &Db, sharing_id: i64, tunnel_id: i64, ids: &[i64]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    let ends: HashMap<i64, String> = sqlx::query_as::<_, (i64, String)>(&format!(
        "SELECT reverse_server_username_id, expires_at FROM {A} WHERE tunnel_sharing_id = ? AND expires_at IS NOT NULL"
    ))
    .bind(sharing_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();
    sqlx::query(&format!("DELETE FROM {A} WHERE tunnel_sharing_id = ?")).bind(sharing_id).execute(&mut *tx).await?;
    for id in ids {
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO {A} (tunnel_sharing_id, reverse_server_username_id, expires_at) \
             SELECT ?, id, ? FROM authorized_keys_reverseserverusernames WHERE id = ? AND reverse_server_id = ?"
        ))
        .bind(sharing_id)
        .bind(ends.get(id))
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
