//! 分享給使用者群組（`telepy_group_share` + 允許的帳號），以及成員各自那筆「經由群組」的分享列
//! （`tunnels_tunnelsharing.group_share_id`）。哪些列該有由 `crate::group_shares` 決定。
//! Tunnels shared with user groups and the share row each member gets from one; `crate::group_shares` decides which
//! rows should exist.

use std::collections::{BTreeSet, HashMap};

use sqlx::FromRow;

use super::sharing::Sharing;
use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct GroupShare {
    pub id: i64,
    pub tunnel_id: i64,
    pub group_id: i64,
    pub shared_by_id: Option<i64>,
    pub permission_type: String,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const G: &str = "telepy_group_share";
const GU: &str = "telepy_group_share_username";
const G_COLS: &str = "id, tunnel_id, group_id, shared_by_id, permission_type, expires_at, created_at, updated_at";
const S: &str = "tunnels_tunnelsharing";
const S_COLS: &str = "id, tunnel_id, shared_by_id, shared_with_id, permission_type, shared_at, updated_at, expires_at, base_permission, permission_until, group_share_id";
const A: &str = "tunnels_tunnelsharingallowedusername";
const U: &str = "authorized_keys_reverseserverusernames";

pub async fn for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<GroupShare>> {
    sqlx::query_as(&format!("SELECT {G_COLS} FROM {G} WHERE tunnel_id = ? ORDER BY id")).bind(tunnel_id).fetch_all(&db.read).await
}

pub async fn get(db: &Db, id: i64) -> sqlx::Result<Option<GroupShare>> {
    sqlx::query_as(&format!("SELECT {G_COLS} FROM {G} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn by_tunnel_group(db: &Db, tunnel_id: i64, group_id: i64) -> sqlx::Result<Option<GroupShare>> {
    sqlx::query_as(&format!("SELECT {G_COLS} FROM {G} WHERE tunnel_id = ? AND group_id = ?"))
        .bind(tunnel_id)
        .bind(group_id)
        .fetch_optional(&db.read)
        .await
}

/// 還沒到期的群組分享。/ Group shares that have not ended.
pub async fn live(db: &Db) -> sqlx::Result<Vec<GroupShare>> {
    sqlx::query_as(&format!("SELECT {G_COLS} FROM {G} WHERE expires_at IS NULL OR expires_at > ? ORDER BY id")).bind(now_db()).fetch_all(&db.read).await
}

/// 到期了、還沒收掉的。/ Past their end, not removed yet.
pub async fn expired(db: &Db) -> sqlx::Result<Vec<GroupShare>> {
    sqlx::query_as(&format!("SELECT {G_COLS} FROM {G} WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY id")).bind(now_db()).fetch_all(&db.read).await
}

pub async fn create(db: &Db, tunnel_id: i64, group_id: i64, shared_by: i64, permission: &str, expires_at: Option<&str>) -> sqlx::Result<i64> {
    let now = now_db();
    Ok(sqlx::query(&format!(
        "INSERT INTO {G} (tunnel_id, group_id, shared_by_id, permission_type, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(tunnel_id)
    .bind(group_id)
    .bind(shared_by)
    .bind(permission)
    .bind(expires_at)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?
    .last_insert_rowid())
}

/// 改權限及 / 或期限（None = 不改；期限 Some(None) = 一直有效）。/ Change the permission and / or the end.
pub async fn update(db: &Db, id: i64, permission: Option<&str>, expires_at: Option<Option<&str>>) -> sqlx::Result<()> {
    if let Some(p) = permission {
        sqlx::query(&format!("UPDATE {G} SET permission_type = ?, updated_at = ? WHERE id = ?")).bind(p).bind(now_db()).bind(id).execute(&db.write).await?;
    }
    if let Some(e) = expires_at {
        sqlx::query(&format!("UPDATE {G} SET expires_at = ?, updated_at = ? WHERE id = ?")).bind(e).bind(now_db()).bind(id).execute(&db.write).await?;
    }
    Ok(())
}

pub async fn delete(db: &Db, id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {GU} WHERE group_share_id = ?")).bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {G} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// 群組被刪：它的群組分享一起走（成員的分享列由下一次比對收掉）。/ A deleted group's shares go too.
pub async fn forget_group(db: &Db, group_id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {GU} WHERE group_share_id IN (SELECT id FROM {G} WHERE group_id = ?)")).bind(group_id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {G} WHERE group_id = ?")).bind(group_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// 群組分享允許的帳號（只算還屬於這條通道的）。/ A group share's accounts (only those still on the tunnel).
pub async fn username_ids(db: &Db, id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(&format!(
        "SELECT gu.username_id FROM {GU} gu JOIN {G} g ON g.id = gu.group_share_id JOIN {U} u ON u.id = gu.username_id AND u.reverse_server_id = g.tunnel_id \
         WHERE gu.group_share_id = ? ORDER BY gu.username_id"
    ))
    .bind(id)
    .fetch_all(&db.read)
    .await
}

/// 每個群組分享允許的帳號，一次查完。/ Every group share's accounts at once.
pub async fn all_username_ids(db: &Db) -> sqlx::Result<HashMap<i64, BTreeSet<i64>>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(&format!(
        "SELECT gu.group_share_id, gu.username_id FROM {GU} gu JOIN {G} g ON g.id = gu.group_share_id \
         JOIN {U} u ON u.id = gu.username_id AND u.reverse_server_id = g.tunnel_id"
    ))
    .fetch_all(&db.read)
    .await?;
    let mut out: HashMap<i64, BTreeSet<i64>> = HashMap::new();
    for (g, u) in rows {
        out.entry(g).or_default().insert(u);
    }
    Ok(out)
}

/// 整組取代（只收這條通道的帳號）。/ Replace the accounts (only this tunnel's are kept).
pub async fn set_usernames(db: &Db, id: i64, tunnel_id: i64, ids: &[i64]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {GU} WHERE group_share_id = ?")).bind(id).execute(&mut *tx).await?;
    for u in ids {
        sqlx::query(&format!("INSERT OR IGNORE INTO {GU} (group_share_id, username_id) SELECT ?, id FROM {U} WHERE id = ? AND reverse_server_id = ?"))
            .bind(id)
            .bind(u)
            .bind(tunnel_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 群組分享相關的分享列：經由群組建的，加上有群組分享的通道上的所有列（直接分享優先，要看得到）。
/// The share rows that matter: every group-made row, plus every row on a tunnel that has a group share.
pub async fn rows(db: &Db) -> sqlx::Result<Vec<Sharing>> {
    sqlx::query_as(&format!("SELECT {S_COLS} FROM {S} WHERE group_share_id IS NOT NULL OR tunnel_id IN (SELECT tunnel_id FROM {G}) ORDER BY id"))
        .fetch_all(&db.read)
        .await
}

/// 經由群組建的列各自的永久帳號（暫時的不算：那是存取申請給的）。/ Permanent accounts of each group-made row.
pub async fn permanent_accounts(db: &Db) -> sqlx::Result<HashMap<i64, BTreeSet<i64>>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(&format!(
        "SELECT a.tunnel_sharing_id, a.reverse_server_username_id FROM {A} a JOIN {S} s ON s.id = a.tunnel_sharing_id \
         WHERE s.group_share_id IS NOT NULL AND a.expires_at IS NULL"
    ))
    .fetch_all(&db.read)
    .await?;
    let mut out: HashMap<i64, BTreeSet<i64>> = HashMap::new();
    for (s, u) in rows {
        out.entry(s).or_default().insert(u);
    }
    Ok(out)
}

pub async fn create_row(db: &Db, tunnel_id: i64, shared_by: i64, user_id: i64, permission: &str, expires_at: Option<&str>, group_share_id: i64) -> sqlx::Result<i64> {
    let now = now_db();
    Ok(sqlx::query(&format!(
        "INSERT INTO {S} (shared_at, updated_at, shared_by_id, shared_with_id, tunnel_id, permission_type, expires_at, group_share_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(&now)
    .bind(&now)
    .bind(shared_by)
    .bind(user_id)
    .bind(tunnel_id)
    .bind(permission)
    .bind(expires_at)
    .bind(group_share_id)
    .execute(&db.write)
    .await?
    .last_insert_rowid())
}

/// 把成員那筆列對齊群組分享。暫時提升（存取申請）還在時改的是它結束後回去的權限。
/// Bring a member's row in line; while a temporary raise runs, the permission it returns to is what changes.
pub async fn update_row(db: &Db, id: i64, permission: &str, raised: bool, expires_at: Option<&str>, group_share_id: i64) -> sqlx::Result<()> {
    let col = if raised { "base_permission" } else { "permission_type" };
    sqlx::query(&format!("UPDATE {S} SET {col} = ?, expires_at = ?, group_share_id = ?, updated_at = ? WHERE id = ?"))
        .bind(permission)
        .bind(expires_at)
        .bind(group_share_id)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 永久帳號換成 `ids`；存取申請給的暫時帳號不動（同一個帳號群組也給了，就變永久）。
/// Set the permanent accounts to `ids`; temporary ones from access requests stay (one the group now gives turns permanent).
pub async fn set_permanent_accounts(db: &Db, sharing_id: i64, tunnel_id: i64, ids: &BTreeSet<i64>) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    let current: Vec<i64> = sqlx::query_scalar(&format!("SELECT reverse_server_username_id FROM {A} WHERE tunnel_sharing_id = ? AND expires_at IS NULL"))
        .bind(sharing_id)
        .fetch_all(&mut *tx)
        .await?;
    for u in current.iter().filter(|u| !ids.contains(u)) {
        sqlx::query(&format!("DELETE FROM {A} WHERE tunnel_sharing_id = ? AND reverse_server_username_id = ? AND expires_at IS NULL"))
            .bind(sharing_id)
            .bind(u)
            .execute(&mut *tx)
            .await?;
    }
    for u in ids {
        sqlx::query(&format!("UPDATE {A} SET expires_at = NULL WHERE tunnel_sharing_id = ? AND reverse_server_username_id = ?"))
            .bind(sharing_id)
            .bind(u)
            .execute(&mut *tx)
            .await?;
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO {A} (tunnel_sharing_id, reverse_server_username_id) SELECT ?, id FROM {U} WHERE id = ? AND reverse_server_id = ?"
        ))
        .bind(sharing_id)
        .bind(u)
        .bind(tunnel_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 這筆列從此是直接分享（主人單獨設定了這個人）。/ The row becomes a direct share (the person was set on their own).
pub async fn make_direct(db: &Db, sharing_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {S} SET group_share_id = NULL, updated_at = ? WHERE id = ?")).bind(now_db()).bind(sharing_id).execute(&db.write).await?;
    Ok(())
}

/// 群組名稱與成員數（分享對話框用）。/ Group names and member counts (for the share dialog).
pub async fn groups_with_counts(db: &Db) -> sqlx::Result<Vec<(i64, String, i64)>> {
    sqlx::query_as(
        "SELECT g.id, g.name, (SELECT COUNT(*) FROM telepy_user_group_member m WHERE m.group_id = g.id) FROM telepy_user_group g ORDER BY g.name COLLATE NOCASE",
    )
    .fetch_all(&db.read)
    .await
}

/// 群組成員的使用者名稱。/ A group's members by name.
pub async fn member_names(db: &Db, group_id: i64) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as(
        "SELECT u.id, u.username FROM telepy_user_group_member m JOIN auth_user u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.username COLLATE NOCASE",
    )
    .bind(group_id)
    .fetch_all(&db.read)
    .await
}

/// 這個群組的群組分享 id（刪群組前記下名稱用）。/ A group's share ids (kept before deleting the group, for wording).
pub async fn ids_of_group(db: &Db, group_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(&format!("SELECT id FROM {G} WHERE group_id = ?")).bind(group_id).fetch_all(&db.read).await
}

/// 我經由群組拿到的通道 → 群組名稱。/ Tunnels I hold through a group → the group's name.
pub async fn my_groups(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, String>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(&format!(
        "SELECT s.tunnel_id, g.name FROM {S} s JOIN {G} gs ON gs.id = s.group_share_id JOIN telepy_user_group g ON g.id = gs.group_id WHERE s.shared_with_id = ?"
    ))
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().collect())
}

/// 這條通道上每筆經由群組的分享列 → (群組分享 id, 群組 id, 群組名稱)。/ Each group-made row on a tunnel → its group.
pub async fn row_groups(db: &Db, tunnel_id: i64) -> sqlx::Result<HashMap<i64, (i64, i64, String)>> {
    let rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!(
        "SELECT s.id, gs.id, g.id, g.name FROM {S} s JOIN {G} gs ON gs.id = s.group_share_id JOIN telepy_user_group g ON g.id = gs.group_id WHERE s.tunnel_id = ?"
    ))
    .bind(tunnel_id)
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().map(|(s, gs, g, n)| (s, (gs, g, n))).collect())
}

/// 這條通道上、這個人所屬群組的群組分享（還沒到期的）→ 群組名稱。/ Live group shares on a tunnel covering this person.
pub async fn covering(db: &Db, tunnel_id: i64, user_id: i64) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(&format!(
        "SELECT g.name FROM {G} gs JOIN telepy_user_group g ON g.id = gs.group_id JOIN telepy_user_group_member m ON m.group_id = gs.group_id \
         WHERE gs.tunnel_id = ? AND m.user_id = ? AND (gs.expires_at IS NULL OR gs.expires_at > ?) ORDER BY g.name COLLATE NOCASE"
    ))
    .bind(tunnel_id)
    .bind(user_id)
    .bind(now_db())
    .fetch_all(&db.read)
    .await
}

/// 群組分享允許的帳號（id, 名稱）。/ A group share's accounts (id, name).
pub async fn usernames(db: &Db, id: i64) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as(&format!(
        "SELECT u.id, u.username FROM {GU} gu JOIN {G} g ON g.id = gu.group_share_id JOIN {U} u ON u.id = gu.username_id AND u.reverse_server_id = g.tunnel_id \
         WHERE gu.group_share_id = ? ORDER BY u.username"
    ))
    .bind(id)
    .fetch_all(&db.read)
    .await
}
