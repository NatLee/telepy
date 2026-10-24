//! OAuth 2.1 的 client（RFC 7591 動態註冊）與 grant（一次使用者同意 = 一列；refresh token 只存雜湊、每次換發都輪替）。
//! OAuth clients (dynamic registration) and grants (one row per consent; the refresh token is stored hashed
//! and rotated on every use).

use sqlx::FromRow;

use super::Db;
use crate::util::{db_time, now_db};

#[derive(Debug, Clone, FromRow)]
pub struct Client {
    pub client_id: String,
    pub client_secret_hash: Option<String>,
    pub client_name: String,
    /// JSON 陣列。/ JSON array of strings.
    pub redirect_uris: String,
    pub token_endpoint_auth_method: String,
    pub client_uri: Option<String>,
    pub logo_uri: Option<String>,
    pub created_at: String,
}

impl Client {
    pub fn redirect_uri_list(&self) -> Vec<String> {
        serde_json::from_str(&self.redirect_uris).unwrap_or_default()
    }
    pub fn is_public(&self) -> bool {
        self.token_endpoint_auth_method == "none"
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct Grant {
    pub id: i64,
    pub user_id: i64,
    pub client_id: String,
    pub scope: String,
    /// JSON 陣列；NULL = 使用者看得到的全部隧道。/ JSON array; NULL = every tunnel the user can see.
    pub tunnel_ids: Option<String>,
    pub resource: String,
    pub refresh_token_hash: Option<String>,
    pub refresh_expires_at: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
}

impl Grant {
    pub fn tunnel_id_list(&self) -> Option<Vec<i64>> {
        self.tunnel_ids.as_deref().map(|s| serde_json::from_str(s).unwrap_or_default())
    }
    /// 未撤銷且 refresh token 未過期。/ Not revoked and the refresh token has not expired.
    pub fn is_active(&self, now: &str) -> bool {
        self.revoked_at.is_none() && self.refresh_expires_at.as_deref().map(|e| e > now).unwrap_or(false)
    }
}

/// Grant + client 的顯示欄位（Connected apps 列表）。/ Grant joined with its client's display fields.
#[derive(Debug, Clone, FromRow)]
pub struct GrantWithClient {
    pub id: i64,
    pub user_id: i64,
    pub client_id: String,
    pub scope: String,
    pub tunnel_ids: Option<String>,
    pub refresh_expires_at: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub client_name: String,
    pub client_uri: Option<String>,
}

const C: &str = "telepy_oauth_client";
const C_COLS: &str = "client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, client_uri, logo_uri, created_at";
const G: &str = "telepy_oauth_grant";
const G_COLS: &str = "id, user_id, client_id, scope, tunnel_ids, resource, refresh_token_hash, refresh_expires_at, created_at, last_used_at, revoked_at";

pub struct NewClient<'a> {
    pub client_id: &'a str,
    pub client_secret_hash: Option<&'a str>,
    pub client_name: &'a str,
    pub redirect_uris: &'a [String],
    pub token_endpoint_auth_method: &'a str,
    pub client_uri: Option<&'a str>,
    pub logo_uri: Option<&'a str>,
}

pub async fn client_count(db: &Db) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {C}")).fetch_one(&db.read).await
}

pub async fn client_create(db: &Db, new: NewClient<'_>) -> sqlx::Result<Client> {
    let uris = serde_json::to_string(new.redirect_uris).unwrap_or_else(|_| "[]".to_string());
    sqlx::query(&format!(
        "INSERT INTO {C} (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, client_uri, logo_uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(new.client_id)
    .bind(new.client_secret_hash)
    .bind(new.client_name)
    .bind(&uris)
    .bind(new.token_endpoint_auth_method)
    .bind(new.client_uri)
    .bind(new.logo_uri)
    .bind(now_db())
    .execute(&db.write)
    .await?;
    Ok(client_by_id(db, new.client_id).await?.expect("client just inserted"))
}

pub async fn client_by_id(db: &Db, client_id: &str) -> sqlx::Result<Option<Client>> {
    sqlx::query_as(&format!("SELECT {C_COLS} FROM {C} WHERE client_id = ?")).bind(client_id).fetch_optional(&db.read).await
}

pub struct NewGrant<'a> {
    pub user_id: i64,
    pub client_id: &'a str,
    pub scope: &'a str,
    pub tunnel_ids: Option<&'a [i64]>,
    pub resource: &'a str,
    pub refresh_token_hash: &'a str,
    pub refresh_expires_at: &'a str,
}

pub async fn grant_create(db: &Db, new: NewGrant<'_>) -> sqlx::Result<Grant> {
    let tunnels = new.tunnel_ids.map(|ids| serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string()));
    let now = now_db();
    let id = sqlx::query(&format!(
        "INSERT INTO {G} (user_id, client_id, scope, tunnel_ids, resource, refresh_token_hash, refresh_expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(new.user_id)
    .bind(new.client_id)
    .bind(new.scope)
    .bind(tunnels)
    .bind(new.resource)
    .bind(new.refresh_token_hash)
    .bind(new.refresh_expires_at)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    Ok(grant_by_id(db, id).await?.expect("grant just inserted"))
}

pub async fn grant_by_id(db: &Db, id: i64) -> sqlx::Result<Option<Grant>> {
    sqlx::query_as(&format!("SELECT {G_COLS} FROM {G} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn grant_by_refresh_hash(db: &Db, hash: &str) -> sqlx::Result<Option<Grant>> {
    sqlx::query_as(&format!("SELECT {G_COLS} FROM {G} WHERE refresh_token_hash = ?")).bind(hash).fetch_optional(&db.read).await
}

/// 輪替 refresh token：只有在舊雜湊仍是目前值時才更新（並行的兩次 refresh 只會有一個成功）。
/// Rotate the refresh token; a compare-and-swap so two concurrent refreshes cannot both succeed.
pub async fn grant_rotate_refresh(db: &Db, id: i64, old_hash: &str, new_hash: &str, expires_at: &str) -> sqlx::Result<bool> {
    let n = sqlx::query(&format!(
        "UPDATE {G} SET refresh_token_hash = ?, refresh_expires_at = ?, last_used_at = ? WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL"
    ))
    .bind(new_hash)
    .bind(expires_at)
    .bind(now_db())
    .bind(id)
    .bind(old_hash)
    .execute(&db.write)
    .await?
    .rows_affected();
    Ok(n == 1)
}

pub async fn grant_touch(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {G} SET last_used_at = ? WHERE id = ?")).bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 撤銷：標記時間並丟掉 refresh token 雜湊（之後的 refresh / access 都失效）。
pub async fn grant_revoke(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {G} SET revoked_at = ?, refresh_token_hash = NULL WHERE id = ? AND revoked_at IS NULL"))
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 使用者目前有效的 grant（Connected apps）。/ The user's active grants, newest first.
pub async fn active_grants_for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<GrantWithClient>> {
    sqlx::query_as(&format!(
        "SELECT g.id, g.user_id, g.client_id, g.scope, g.tunnel_ids, g.refresh_expires_at, g.created_at, g.last_used_at, \
                c.client_name, c.client_uri \
         FROM {G} g JOIN {C} c ON c.client_id = g.client_id \
         WHERE g.user_id = ? AND g.revoked_at IS NULL AND g.refresh_expires_at > ? ORDER BY g.id DESC"
    ))
    .bind(user_id)
    .bind(now_db())
    .fetch_all(&db.read)
    .await
}

/// 有效 grant 的摘要（刪隧道前的檢查：誰的哪個 app、限制在哪些隧道）。
/// Active grants with their app and user names (the tunnel delete check).
#[derive(Debug, Clone, FromRow)]
pub struct GrantOverview {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub client_name: String,
    pub tunnel_ids: Option<String>,
}

impl GrantOverview {
    pub fn tunnel_id_list(&self) -> Option<Vec<i64>> {
        self.tunnel_ids.as_deref().map(|s| serde_json::from_str(s).unwrap_or_default())
    }
}

pub async fn active_grant_overview(db: &Db) -> sqlx::Result<Vec<GrantOverview>> {
    sqlx::query_as(&format!(
        "SELECT g.id, g.user_id, u.username, c.client_name, g.tunnel_ids \
         FROM {G} g JOIN {C} c ON c.client_id = g.client_id JOIN auth_user u ON u.id = g.user_id \
         WHERE g.revoked_at IS NULL AND g.refresh_expires_at > ? ORDER BY g.id"
    ))
    .bind(now_db())
    .fetch_all(&db.read)
    .await
}

/// 限制清單裡有這條隧道的 grant（含已撤銷 / 過期的）。/ Grants whose restriction list names the tunnel.
pub async fn grants_naming_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<Grant>> {
    let rows: Vec<Grant> = sqlx::query_as(&format!("SELECT {G_COLS} FROM {G} WHERE tunnel_ids IS NOT NULL")).fetch_all(&db.read).await?;
    Ok(rows.into_iter().filter(|g| g.tunnel_id_list().is_some_and(|ids| ids.contains(&tunnel_id))).collect())
}

pub async fn grant_set_tunnels(db: &Db, id: i64, tunnel_ids: &[i64]) -> sqlx::Result<()> {
    let raw = serde_json::to_string(tunnel_ids).unwrap_or_else(|_| "[]".to_string());
    sqlx::query(&format!("UPDATE {G} SET tunnel_ids = ? WHERE id = ?")).bind(raw).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 例行清理：從沒換到 token 的 client、撤銷/過期很久的 grant、使用者已刪除的 grant。回刪除列數。
/// Housekeeping: never-used clients, long-dead grants, grants of deleted users.
pub async fn cleanup(db: &Db) -> sqlx::Result<u64> {
    let now = chrono::Utc::now();
    let unused_before = db_time(now - chrono::Duration::from_std(crate::oauth::UNUSED_CLIENT_TTL).unwrap_or_default());
    let dead_before = db_time(now - chrono::Duration::from_std(crate::oauth::DEAD_GRANT_TTL).unwrap_or_default());
    let mut n = 0;
    n += sqlx::query(&format!("DELETE FROM {G} WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (refresh_expires_at < ?)"))
        .bind(&dead_before)
        .bind(&dead_before)
        .execute(&db.write)
        .await?
        .rows_affected();
    n += sqlx::query(&format!("DELETE FROM {G} WHERE user_id NOT IN (SELECT id FROM auth_user)")).execute(&db.write).await?.rows_affected();
    n += sqlx::query(&format!("DELETE FROM {C} WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM {G})"))
        .bind(&unused_before)
        .execute(&db.write)
        .await?
        .rows_affected();
    Ok(n)
}
