//! 功能權限：群組、成員、各功能的允許 / 拒絕（`crate::features` 解析）。跟隧道分享無關。
//! Feature permissions: groups, members and per-feature allow / deny rows (resolved by `crate::features`).
//! Unrelated to tunnel sharing.

use super::Db;

const GROUP: &str = "telepy_user_group";
const MEMBER: &str = "telepy_user_group_member";
const GRANT: &str = "telepy_feature_grant";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Group {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub created_at: String,
}

/// 一列允許 / 拒絕：`subject_kind` = user | group | everyone（everyone 的 subject_id = 0）。
/// One allow / deny row; `subject_kind` = user | group | everyone (subject_id 0 for everyone).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GrantRow {
    pub subject_kind: String,
    pub subject_id: i64,
    pub feature: String,
    pub allowed: bool,
}

pub async fn groups(db: &Db) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT id, name, description, created_at FROM {GROUP} ORDER BY name COLLATE NOCASE, id")).fetch_all(&db.read).await
}

pub async fn group(db: &Db, id: i64) -> sqlx::Result<Option<Group>> {
    sqlx::query_as(&format!("SELECT id, name, description, created_at FROM {GROUP} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 名稱是否已被別的群組用了（不分大小寫）。/ Whether another group already has this name (case-insensitive).
pub async fn name_taken(db: &Db, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(&format!("SELECT id FROM {GROUP} WHERE lower(name) = lower(?) AND id != ? LIMIT 1"))
        .bind(name)
        .bind(except.unwrap_or(0))
        .fetch_optional(&db.read)
        .await?;
    Ok(row.is_some())
}

pub async fn create_group(db: &Db, name: &str, description: &str) -> sqlx::Result<i64> {
    let res = sqlx::query(&format!("INSERT INTO {GROUP} (name, description, created_at) VALUES (?, ?, ?)"))
        .bind(name)
        .bind(description)
        .bind(crate::util::now_db())
        .execute(&db.write)
        .await?;
    Ok(res.last_insert_rowid())
}

pub async fn update_group(db: &Db, id: i64, name: Option<&str>, description: Option<&str>) -> sqlx::Result<()> {
    if let Some(n) = name {
        sqlx::query(&format!("UPDATE {GROUP} SET name = ? WHERE id = ?")).bind(n).bind(id).execute(&db.write).await?;
    }
    if let Some(d) = description {
        sqlx::query(&format!("UPDATE {GROUP} SET description = ? WHERE id = ?")).bind(d).bind(id).execute(&db.write).await?;
    }
    Ok(())
}

/// 刪群組連同成員與它的允許 / 拒絕。/ Deletes a group with its members and grants.
pub async fn delete_group(db: &Db, id: i64) -> sqlx::Result<bool> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {MEMBER} WHERE group_id = ?")).bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {GRANT} WHERE subject_kind = 'group' AND subject_id = ?")).bind(id).execute(&mut *tx).await?;
    let res = sqlx::query(&format!("DELETE FROM {GROUP} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(res.rows_affected() > 0)
}

/// (group_id, user_id) 全部。/ Every membership.
pub async fn memberships(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT group_id, user_id FROM {MEMBER} ORDER BY group_id, user_id")).fetch_all(&db.read).await
}

/// 換掉群組的成員名單。/ Replaces a group's member list.
pub async fn set_members(db: &Db, group_id: i64, users: &[i64]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {MEMBER} WHERE group_id = ?")).bind(group_id).execute(&mut *tx).await?;
    for uid in users {
        sqlx::query(&format!("INSERT OR IGNORE INTO {MEMBER} (group_id, user_id) VALUES (?, ?)")).bind(group_id).bind(uid).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn grants(db: &Db) -> sqlx::Result<Vec<GrantRow>> {
    sqlx::query_as(&format!("SELECT subject_kind, subject_id, feature, allowed FROM {GRANT}")).fetch_all(&db.read).await
}

/// `allowed` = None 刪掉那一列（回到「沿用」）。/ `allowed` = None removes the row (back to "inherit").
pub async fn set_grant(db: &Db, subject_kind: &str, subject_id: i64, feature: &str, allowed: Option<bool>) -> sqlx::Result<()> {
    match allowed {
        None => {
            sqlx::query(&format!("DELETE FROM {GRANT} WHERE subject_kind = ? AND subject_id = ? AND feature = ?"))
                .bind(subject_kind)
                .bind(subject_id)
                .bind(feature)
                .execute(&db.write)
                .await?;
        }
        Some(a) => {
            sqlx::query(&format!(
                "INSERT INTO {GRANT} (subject_kind, subject_id, feature, allowed, updated_at) VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT (subject_kind, subject_id, feature) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at"
            ))
            .bind(subject_kind)
            .bind(subject_id)
            .bind(feature)
            .bind(a)
            .bind(crate::util::now_db())
            .execute(&db.write)
            .await?;
        }
    }
    Ok(())
}
