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
const UK_COLS: &str = "id, user_id, host_friendly_name, key, description, created_at, updated_at";
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

pub async fn user_key_owner_by_prefix(db: &Db, like: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar(&format!("SELECT user_id FROM {UK} WHERE key LIKE ? ESCAPE '\\' ORDER BY id LIMIT 1"))
        .bind(like)
        .fetch_optional(&db.read)
        .await
}

pub async fn user_key_create(db: &Db, user_id: i64, name: &str, key: &str, description: Option<&str>) -> sqlx::Result<UserKey> {
    let now = now_db();
    let id = sqlx::query(&format!("INSERT INTO {UK} (key, description, created_at, updated_at, user_id, host_friendly_name) VALUES (?, ?, ?, ?, ?, ?)"))
        .bind(key)
        .bind(description)
        .bind(&now)
        .bind(&now)
        .bind(user_id)
        .bind(name)
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

pub async fn service_key_strings(db: &Db) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(&format!("SELECT key FROM {SK}")).fetch_all(&db.read).await
}

pub async fn service_key_matches_prefix(db: &Db, like: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {SK} WHERE key LIKE ? ESCAPE '\\'"))
        .bind(like)
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
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
