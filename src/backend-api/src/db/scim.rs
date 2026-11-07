//! SCIM 帳號同步的紀錄：身分提供者管理哪些帳號（`telepy_scim_user`）與哪些使用者群組（`telepy_scim_group`）。
//! SCIM records: which accounts (`telepy_scim_user`) and user groups (`telepy_scim_group`) a provider manages.

use super::Db;
use crate::util::now_db;

const USER: &str = "telepy_scim_user";
const GROUP: &str = "telepy_scim_group";

/// 身分提供者管理的一個帳號（連同 auth_user 的資料）。/ An account a provider manages, with its auth_user fields.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ScimUserRow {
    pub user_id: i64,
    pub user_name: String,
    pub external_id: Option<String>,
    pub display_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub username: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub is_active: bool,
    pub is_superuser: bool,
}

const USER_COLS: &str = "s.user_id, s.user_name, s.external_id, s.display_name, s.created_at, s.updated_at, u.username, u.email, u.first_name, u.last_name, u.is_active, u.is_superuser";

pub async fn users(db: &Db, provider_id: i64) -> sqlx::Result<Vec<ScimUserRow>> {
    sqlx::query_as(&format!("SELECT {USER_COLS} FROM {USER} s JOIN auth_user u ON u.id = s.user_id WHERE s.provider_id = ? AND s.deleted = 0 ORDER BY s.user_id"))
        .bind(provider_id)
        .fetch_all(&db.read)
        .await
}

pub async fn user(db: &Db, provider_id: i64, user_id: i64) -> sqlx::Result<Option<ScimUserRow>> {
    sqlx::query_as(&format!("SELECT {USER_COLS} FROM {USER} s JOIN auth_user u ON u.id = s.user_id WHERE s.provider_id = ? AND s.user_id = ? AND s.deleted = 0"))
        .bind(provider_id)
        .bind(user_id)
        .fetch_optional(&db.read)
        .await
}

/// 這個帳號以前是這個提供者建的、後來 DELETE 掉（可以再接回來）。/ Provisioned here before and then deleted (may come back).
pub async fn was_deleted(db: &Db, provider_id: i64, user_id: i64) -> sqlx::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {USER} WHERE provider_id = ? AND user_id = ? AND deleted = 1")).bind(provider_id).bind(user_id).fetch_one(&db.read).await? > 0)
}

/// 新建或接回（deleted 清掉）。/ Record a managed account (or bring a deleted one back).
pub async fn upsert_user(db: &Db, provider_id: i64, user_id: i64, user_name: &str, external_id: Option<&str>, display_name: Option<&str>) -> sqlx::Result<()> {
    let now = now_db();
    sqlx::query(&format!(
        "INSERT INTO {USER} (provider_id, user_id, user_name, external_id, display_name, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?) \
         ON CONFLICT (provider_id, user_id) DO UPDATE SET user_name = excluded.user_name, external_id = excluded.external_id, display_name = excluded.display_name, deleted = 0, updated_at = excluded.updated_at"
    ))
    .bind(provider_id)
    .bind(user_id)
    .bind(user_name)
    .bind(external_id)
    .bind(display_name)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?;
    Ok(())
}

pub async fn mark_deleted(db: &Db, provider_id: i64, user_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {USER} SET deleted = 1, updated_at = ? WHERE provider_id = ? AND user_id = ?")).bind(now_db()).bind(provider_id).bind(user_id).execute(&db.write).await?;
    Ok(())
}

/// 名字與 email（auth_user）。/ Names and email on auth_user.
pub async fn set_profile(db: &Db, user_id: i64, first_name: &str, last_name: &str, email: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE auth_user SET first_name = ?, last_name = ?, email = ? WHERE id = ?").bind(first_name).bind(last_name).bind(email).bind(user_id).execute(&db.write).await?;
    Ok(())
}

/// 單一登入第一次登入時找預先建好的帳號：email（不分大小寫）或使用者名稱相同。/ For a first SSO sign-in: by email or username.
pub async fn provisioned_for(db: &Db, provider_id: i64, email: Option<&str>, username: Option<&str>) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar(&format!(
        "SELECT s.user_id FROM {USER} s JOIN auth_user u ON u.id = s.user_id WHERE s.provider_id = ? AND s.deleted = 0 AND ((? IS NOT NULL AND lower(u.email) = lower(?)) OR (? IS NOT NULL AND u.username = ?)) ORDER BY s.user_id LIMIT 1"
    ))
    .bind(provider_id)
    .bind(email)
    .bind(email)
    .bind(username)
    .bind(username)
    .fetch_optional(&db.read)
    .await
}

/// 每個帳號是哪個身分提供者在管理（使用者清單用）。/ Which provider manages each account (for the user list).
pub async fn managers(db: &Db) -> sqlx::Result<std::collections::HashMap<i64, String>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(&format!("SELECT s.user_id, p.name FROM {USER} s JOIN telepy_oidc_provider p ON p.id = s.provider_id WHERE s.deleted = 0")).fetch_all(&db.read).await?;
    Ok(rows.into_iter().collect())
}

/// (帳號數, 群組數)。/ (accounts, groups) a provider manages.
pub async fn counts(db: &Db) -> sqlx::Result<std::collections::HashMap<i64, (i64, i64)>> {
    let mut out: std::collections::HashMap<i64, (i64, i64)> = std::collections::HashMap::new();
    let users: Vec<(i64, i64)> = sqlx::query_as(&format!("SELECT provider_id, COUNT(*) FROM {USER} WHERE deleted = 0 GROUP BY provider_id")).fetch_all(&db.read).await?;
    for (p, n) in users {
        out.entry(p).or_default().0 = n;
    }
    let groups: Vec<(i64, i64)> = sqlx::query_as(&format!("SELECT provider_id, COUNT(*) FROM {GROUP} GROUP BY provider_id")).fetch_all(&db.read).await?;
    for (p, n) in groups {
        out.entry(p).or_default().1 = n;
    }
    Ok(out)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ScimGroupRow {
    pub group_id: i64,
    pub external_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub name: String,
}

const GROUP_COLS: &str = "s.group_id, s.external_id, s.created_at, s.updated_at, g.name";

pub async fn groups(db: &Db, provider_id: i64) -> sqlx::Result<Vec<ScimGroupRow>> {
    sqlx::query_as(&format!("SELECT {GROUP_COLS} FROM {GROUP} s JOIN telepy_user_group g ON g.id = s.group_id WHERE s.provider_id = ? ORDER BY s.group_id")).bind(provider_id).fetch_all(&db.read).await
}

pub async fn group(db: &Db, provider_id: i64, group_id: i64) -> sqlx::Result<Option<ScimGroupRow>> {
    sqlx::query_as(&format!("SELECT {GROUP_COLS} FROM {GROUP} s JOIN telepy_user_group g ON g.id = s.group_id WHERE s.provider_id = ? AND s.group_id = ?"))
        .bind(provider_id)
        .bind(group_id)
        .fetch_optional(&db.read)
        .await
}

pub async fn insert_group(db: &Db, provider_id: i64, group_id: i64, external_id: Option<&str>) -> sqlx::Result<()> {
    let now = now_db();
    sqlx::query(&format!("INSERT INTO {GROUP} (provider_id, group_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"))
        .bind(provider_id)
        .bind(group_id)
        .bind(external_id)
        .bind(&now)
        .bind(&now)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn touch_group(db: &Db, provider_id: i64, group_id: i64, external_id: Option<&str>) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {GROUP} SET external_id = ?, updated_at = ? WHERE provider_id = ? AND group_id = ?")).bind(external_id).bind(now_db()).bind(provider_id).bind(group_id).execute(&db.write).await?;
    Ok(())
}

/// 使用者群組刪掉了（任何地方）：紀錄一起走。/ A user group was deleted (anywhere): its record goes.
pub async fn forget_group(db: &Db, group_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {GROUP} WHERE group_id = ?")).bind(group_id).execute(&db.write).await?;
    Ok(())
}

/// 群組成員（全部）。/ A group's members (all of them).
pub async fn members(db: &Db, group_id: i64) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as("SELECT m.user_id, u.username FROM telepy_user_group_member m JOIN auth_user u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.user_id").bind(group_id).fetch_all(&db.read).await
}
