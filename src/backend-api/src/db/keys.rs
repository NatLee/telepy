//! 使用者金鑰（UserAuthorizedKeys）與服務金鑰（ServiceAuthorizedKeys）。

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct UserKey {
    pub id: i64,
    pub user_id: i64,
    pub host_friendly_name: String,
    pub key: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 最近一次在 gateway 認證成功的時間與來源 IP。/ Last successful gateway login with this key.
    pub last_used_at: Option<String>,
    pub last_used_ip: Option<String>,
    /// 到期時間（DB 格式，UTC）；None = 不到期。/ Expiry (DB format, UTC); None = never.
    pub expires_at: Option<String>,
}

impl UserKey {
    /// 現在是否已經到期。/ Whether it has expired by now.
    pub fn expired(&self) -> bool {
        is_expired(self.expires_at.as_deref())
    }
}

/// DB 格式的時間字串可以直接比大小。/ DB-format times compare lexicographically.
pub fn is_expired(expires_at: Option<&str>) -> bool {
    expires_at.is_some_and(|e| e <= now_db().as_str())
}

#[derive(Debug, Clone, FromRow)]
pub struct ServiceKey {
    pub id: i64,
    pub service: String,
    pub key: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const UK: &str = "authorized_keys_userauthorizedkeys";
const UK_COLS: &str = "id, user_id, host_friendly_name, key, description, created_at, updated_at, last_used_at, last_used_ip, expires_at";
const SK: &str = "authorized_keys_serviceauthorizedkeys";
const SK_COLS: &str = "id, service, key, description, created_at, updated_at";

pub async fn user_keys(db: &Db, user_id: i64) -> sqlx::Result<Vec<UserKey>> {
    sqlx::query_as(&format!("SELECT {UK_COLS} FROM {UK} WHERE user_id = ? ORDER BY id")).bind(user_id).fetch_all(&db.read).await
}

pub async fn user_key_by_id(db: &Db, user_id: i64, id: i64) -> sqlx::Result<Option<UserKey>> {
    sqlx::query_as(&format!("SELECT {UK_COLS} FROM {UK} WHERE user_id = ? AND id = ?"))
        .bind(user_id)
        .bind(id)
        .fetch_optional(&db.read)
        .await
}

pub async fn user_key_strings(db: &Db, user_id: i64) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(&format!("SELECT key FROM {UK} WHERE user_id = ?")).bind(user_id).fetch_all(&db.read).await
}

/// 沒到期的使用者金鑰的擁有者（gateway 認證用）。/ Owner of a user key that has not expired (gateway auth).
pub async fn user_key_owner_by_prefix(db: &Db, like: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar(&format!("SELECT user_id FROM {UK} WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) ORDER BY id LIMIT 1"))
        .bind(like)
        .bind(now_db())
        .fetch_optional(&db.read)
        .await
}

/// 已到期的那把（名稱與到期時間），gateway 拒絕時寫進事件。/ The expired key, for the gateway's refusal event.
pub async fn expired_user_key_by_prefix(db: &Db, like: &str) -> sqlx::Result<Option<(String, String)>> {
    sqlx::query_as(&format!("SELECT host_friendly_name, expires_at FROM {UK} WHERE key LIKE ? ESCAPE '\\' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY id LIMIT 1"))
        .bind(like)
        .bind(now_db())
        .fetch_optional(&db.read)
        .await
}

/// gateway 用這把金鑰登入成功。`like` 是 `"<type> <base64>"` 的 LIKE 前綴。
pub async fn touch_last_used(db: &Db, like: &str, ip: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {UK} SET last_used_at = ?, last_used_ip = ? WHERE key LIKE ? ESCAPE '\\'"))
        .bind(now_db())
        .bind(ip)
        .bind(like)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn user_key_by_any_id(db: &Db, id: i64) -> sqlx::Result<Option<UserKey>> {
    sqlx::query_as(&format!("SELECT {UK_COLS} FROM {UK} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 有沒有別的使用者金鑰（排除 `except_id`）用同一把公鑰（比對 `"<type> <base64>"`，不看 comment）。
pub async fn user_key_bare_taken(db: &Db, like: &str, except_id: Option<i64>) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {UK} WHERE key LIKE ? ESCAPE '\\' AND id != ?"))
        .bind(like)
        .bind(except_id.unwrap_or(-1))
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
}

/// 金鑰名稱（全站唯一）已被用掉？/ Is this key name (unique site-wide) already used?
pub async fn user_key_name_taken(db: &Db, name: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {UK} WHERE host_friendly_name = ?")).bind(name).fetch_one(&db.read).await?;
    Ok(n > 0)
}

/// 所有使用者金鑰連同擁有者帳號（稽核比對用）：(key id, key, 金鑰名, user id, username)。
pub async fn all_with_owner(db: &Db) -> sqlx::Result<Vec<(i64, String, String, i64, String)>> {
    sqlx::query_as(&format!("SELECT k.id, k.key, k.host_friendly_name, k.user_id, a.username FROM {UK} k JOIN auth_user a ON a.id = k.user_id"))
        .fetch_all(&db.read)
        .await
}

pub async fn user_key_create(db: &Db, user_id: i64, name: &str, key: &str, description: Option<&str>, expires_at: Option<&str>) -> sqlx::Result<UserKey> {
    let now = now_db();
    let id = sqlx::query(&format!("INSERT INTO {UK} (key, description, created_at, updated_at, user_id, host_friendly_name, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"))
        .bind(key)
        .bind(description)
        .bind(&now)
        .bind(&now)
        .bind(user_id)
        .bind(name)
        .bind(expires_at)
        .execute(&db.write)
        .await?
        .last_insert_rowid();
    Ok(sqlx::query_as(&format!("SELECT {UK_COLS} FROM {UK} WHERE id = ?")).bind(id).fetch_one(&db.read).await?)
}

pub async fn user_key_update(
    db: &Db,
    id: i64,
    name: Option<&str>,
    key: Option<&str>,
    description: Option<Option<&str>>,
    expires_at: Option<Option<&str>>,
) -> sqlx::Result<UserKey> {
    let mut tx = db.write.begin().await?;
    if let Some(v) = name {
        sqlx::query(&format!("UPDATE {UK} SET host_friendly_name = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = key {
        sqlx::query(&format!("UPDATE {UK} SET key = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = description {
        sqlx::query(&format!("UPDATE {UK} SET description = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = expires_at {
        sqlx::query(&format!("UPDATE {UK} SET expires_at = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    sqlx::query(&format!("UPDATE {UK} SET updated_at = ? WHERE id = ?")).bind(now_db()).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(sqlx::query_as(&format!("SELECT {UK_COLS} FROM {UK} WHERE id = ?")).bind(id).fetch_one(&db.read).await?)
}

pub async fn user_key_delete(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {UK} WHERE id = ?")).bind(id).execute(&db.write).await?;
    Ok(())
}

// ---------------------------------------------------------------- service keys

pub async fn service_keys(db: &Db) -> sqlx::Result<Vec<ServiceKey>> {
    sqlx::query_as(&format!("SELECT {SK_COLS} FROM {SK} ORDER BY id")).fetch_all(&db.read).await
}

pub async fn first_service_key(db: &Db) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(&format!("SELECT key FROM {SK} ORDER BY id LIMIT 1")).fetch_optional(&db.read).await
}

/// `ServiceAuthorizedKeys.objects.update_or_create(service=..., defaults={key, description})`
pub async fn service_key_upsert(db: &Db, service: &str, key: &str, description: &str) -> sqlx::Result<bool> {
    let now = now_db();
    let existing: Option<i64> = sqlx::query_scalar(&format!("SELECT id FROM {SK} WHERE service = ?")).bind(service).fetch_optional(&db.read).await?;
    match existing {
        Some(id) => {
            sqlx::query(&format!("UPDATE {SK} SET key = ?, description = ?, updated_at = ? WHERE id = ?"))
                .bind(key)
                .bind(description)
                .bind(&now)
                .bind(id)
                .execute(&db.write)
                .await?;
            Ok(false)
        }
        None => {
            sqlx::query(&format!("INSERT INTO {SK} (service, key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"))
                .bind(service)
                .bind(key)
                .bind(description)
                .bind(&now)
                .bind(&now)
                .execute(&db.write)
                .await?;
            Ok(true)
        }
    }
}
