//! 個人 API token（`tpt_…`）：一列一把；祕密只存 SHA-256，建立時給一次。scope、隧道限制、到期時間（必填，≤ 1 年）。
//! Personal API tokens (`tpt_…`): one row each; only the SHA-256 of the secret is stored and the secret is shown
//! once. Scopes, an optional tunnel restriction and a required expiry (at most a year).

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct ApiToken {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    /// 祕密的開頭（`tpt_` + 6 字元），列表上辨識用。/ The start of the secret, to recognise it in lists.
    pub prefix: String,
    pub token_hash: String,
    /// 空白分隔。/ Space-separated.
    pub scope: String,
    /// JSON 陣列；NULL = 使用者看得到的全部隧道。/ JSON array; NULL = every tunnel the user can see.
    pub tunnel_ids: Option<String>,
    pub expires_at: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub last_used_ip: Option<String>,
    pub revoked_at: Option<String>,
}

impl ApiToken {
    pub fn tunnel_id_list(&self) -> Option<Vec<i64>> {
        self.tunnel_ids.as_deref().map(|s| serde_json::from_str(s).unwrap_or_default())
    }
    pub fn scopes(&self) -> Vec<String> {
        self.scope.split_whitespace().map(str::to_string).collect()
    }
    /// 未撤銷且未過期。/ Not revoked and not expired.
    pub fn is_active(&self, now: &str) -> bool {
        self.revoked_at.is_none() && self.expires_at.as_str() > now
    }
}

const T: &str = "telepy_api_token";
const COLS: &str = "id, user_id, name, prefix, token_hash, scope, tunnel_ids, expires_at, created_at, last_used_at, last_used_ip, revoked_at";

pub struct NewToken<'a> {
    pub user_id: i64,
    pub name: &'a str,
    pub prefix: &'a str,
    pub token_hash: &'a str,
    pub scope: &'a str,
    pub tunnel_ids: Option<&'a [i64]>,
    pub expires_at: &'a str,
}

pub async fn create(db: &Db, new: NewToken<'_>) -> sqlx::Result<ApiToken> {
    let tunnels = new.tunnel_ids.map(|ids| serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string()));
    let id = sqlx::query(&format!("INSERT INTO {T} (user_id, name, prefix, token_hash, scope, tunnel_ids, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"))
        .bind(new.user_id)
        .bind(new.name)
        .bind(new.prefix)
        .bind(new.token_hash)
        .bind(new.scope)
        .bind(tunnels)
        .bind(new.expires_at)
        .bind(now_db())
        .execute(&db.write)
        .await?
        .last_insert_rowid();
    Ok(by_id(db, id).await?.expect("token just inserted"))
}

pub async fn by_id(db: &Db, id: i64) -> sqlx::Result<Option<ApiToken>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn by_hash(db: &Db, hash: &str) -> sqlx::Result<Option<ApiToken>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE token_hash = ?")).bind(hash).fetch_optional(&db.read).await
}

/// 使用者的 token：還有效的 + 最近 30 天內撤銷 / 到期的（列表上看得到發生了什麼），新的在前。
/// A user's tokens: live ones plus those revoked / expired in the last 30 days, newest first.
pub async fn for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<ApiToken>> {
    let since = crate::util::db_time(chrono::Utc::now() - chrono::Duration::days(30));
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM {T} WHERE user_id = ? AND (revoked_at IS NULL OR revoked_at > ?) AND expires_at > ? ORDER BY id DESC"
    ))
    .bind(user_id)
    .bind(&since)
    .bind(&since)
    .fetch_all(&db.read)
    .await
}

pub async fn active_count(db: &Db, user_id: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {T} WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?"))
        .bind(user_id)
        .bind(now_db())
        .fetch_one(&db.read)
        .await
}

pub async fn touch(db: &Db, id: i64, ip: Option<&str>) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET last_used_at = ?, last_used_ip = COALESCE(?, last_used_ip) WHERE id = ?"))
        .bind(now_db())
        .bind(ip)
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 撤銷；已撤銷的不動。回是否真的改了。/ Revoke; returns whether it changed anything.
pub async fn revoke(db: &Db, id: i64) -> sqlx::Result<bool> {
    let n = sqlx::query(&format!("UPDATE {T} SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")).bind(now_db()).bind(id).execute(&db.write).await?.rows_affected();
    Ok(n == 1)
}

/// 隧道刪除：從每把 token 的隧道清單拿掉（限制不會因此變成「全部」）。/ A deleted tunnel leaves every token's list.
pub async fn detach_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<usize> {
    let rows: Vec<ApiToken> = sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE tunnel_ids IS NOT NULL")).fetch_all(&db.read).await?;
    let mut n = 0;
    for t in rows {
        let ids = t.tunnel_id_list().unwrap_or_default();
        if ids.contains(&tunnel_id) {
            let rest: Vec<i64> = ids.into_iter().filter(|i| *i != tunnel_id).collect();
            sqlx::query(&format!("UPDATE {T} SET tunnel_ids = ? WHERE id = ?")).bind(serde_json::to_string(&rest).unwrap_or_else(|_| "[]".into())).bind(t.id).execute(&db.write).await?;
            n += 1;
        }
    }
    Ok(n)
}

/// 例行清理：撤銷 / 過期超過 30 天的、使用者已刪除的。/ Housekeeping: long-dead tokens and tokens of deleted users.
pub async fn cleanup(db: &Db) -> sqlx::Result<u64> {
    let before = crate::util::db_time(chrono::Utc::now() - chrono::Duration::days(30));
    let mut n = sqlx::query(&format!("DELETE FROM {T} WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?"))
        .bind(&before)
        .bind(&before)
        .execute(&db.write)
        .await?
        .rows_affected();
    n += sqlx::query(&format!("DELETE FROM {T} WHERE user_id NOT IN (SELECT id FROM auth_user)")).execute(&db.write).await?.rows_affected();
    Ok(n)
}
