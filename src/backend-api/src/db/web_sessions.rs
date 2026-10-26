//! 網頁登入 session（`telepy_web_session`）：每次登入一列，refresh token 的 `sid` 指到它。列上記著目前有效的
//! refresh token `jti`、上一個 `jti`（換發後短暫寬限，給同時續期的分頁 / 遺失的回應）、到期時間（每次續期往後推）、
//! 以及登出 / 重複使用時的撤銷。到期或撤銷超過一天的列由 `db::retention` 清掉。
//! Web sign-in sessions: one row per login, referenced by the refresh token's `sid`. The row holds the current
//! refresh `jti`, the previous one (a short grace after rotation for concurrent tabs / lost responses), the
//! sliding expiry and the revocation (logout / reuse). Rows expired or revoked for over a day are purged.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct WebSession {
    pub id: i64,
    pub user_id: i64,
    pub jti: String,
    pub prev_jti: Option<String>,
    pub rotated_at: String,
    pub created_at: String,
    pub last_used_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub revoked_reason: Option<String>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    /// 第一關（password / google / passkey）；升級前的列沒有。/ First factor; NULL on rows from before the upgrade.
    pub method: Option<String>,
    /// 第二關（totp / recovery_code / passkey）。/ Second factor, when there was one.
    pub second_factor: Option<String>,
}

const COLS: &str = "id, user_id, jti, prev_jti, rotated_at, created_at, last_used_at, expires_at, revoked_at, revoked_reason, ip, user_agent, method, second_factor";

/// 登入方式（寫進 session 列）。/ How the session signed in (stored on the row).
#[derive(Debug, Clone, Copy, Default)]
pub struct SignInMethod<'a> {
    pub method: Option<&'a str>,
    pub second_factor: Option<&'a str>,
}

/// 開一個 session（登入）。/ Start a session (login).
pub async fn create(db: &Db, user_id: i64, jti: &str, expires_at: &str, ip: Option<&str>, user_agent: Option<&str>, how: SignInMethod<'_>) -> sqlx::Result<i64> {
    let now = now_db();
    let id = sqlx::query(
        "INSERT INTO telepy_web_session (user_id, jti, prev_jti, rotated_at, created_at, last_used_at, expires_at, revoked_at, revoked_reason, ip, user_agent, method, second_factor) \
         VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(jti)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .bind(expires_at)
    .bind(ip)
    .bind(user_agent.map(|u| u.chars().take(256).collect::<String>()))
    .bind(how.method)
    .bind(how.second_factor)
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    Ok(id)
}

pub async fn by_id(db: &Db, id: i64) -> sqlx::Result<Option<WebSession>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_web_session WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 換發：只有列上的 `jti` 仍是 `old_jti` 才成立（compare-and-set），回傳是否換到。到期時間往後推、記下這次的 IP。
/// Rotate: succeeds only while the row's `jti` is still `old_jti` (compare-and-set). Slides the expiry and notes the IP.
pub async fn rotate(db: &Db, id: i64, old_jti: &str, new_jti: &str, expires_at: &str, ip: Option<&str>, user_agent: Option<&str>) -> sqlx::Result<bool> {
    let now = now_db();
    let n = sqlx::query(
        "UPDATE telepy_web_session SET jti = ?, prev_jti = ?, rotated_at = ?, last_used_at = ?, expires_at = ?, ip = ?, user_agent = ? \
         WHERE id = ? AND jti = ? AND revoked_at IS NULL",
    )
    .bind(new_jti)
    .bind(old_jti)
    .bind(&now)
    .bind(&now)
    .bind(expires_at)
    .bind(ip)
    .bind(user_agent.map(|u| u.chars().take(256).collect::<String>()))
    .bind(id)
    .bind(old_jti)
    .execute(&db.write)
    .await?
    .rows_affected();
    Ok(n > 0)
}

/// 撤銷（登出 / 重複使用）；已撤銷的不動。/ Revoke (logout / reuse); an already revoked row is left as is.
pub async fn revoke(db: &Db, id: i64, reason: &str) -> sqlx::Result<bool> {
    let n = sqlx::query("UPDATE telepy_web_session SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now_db())
        .bind(reason)
        .bind(id)
        .execute(&db.write)
        .await?
        .rows_affected();
    Ok(n > 0)
}

/// 使用者還有效的 session（沒撤銷、沒到期），最近用過的在前。/ A user's live sessions, most recently used first.
pub async fn active_for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<WebSession>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM telepy_web_session WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC, id DESC LIMIT 200"
    ))
    .bind(user_id)
    .bind(now_db())
    .fetch_all(&db.read)
    .await
}

/// 撤銷使用者所有還有效的 session（`except` 那個除外），回傳撤銷了哪些。
/// Revoke every live session of a user except `except`; returns the revoked ids.
pub async fn revoke_for_user(db: &Db, user_id: i64, except: Option<i64>, reason: &str) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "UPDATE telepy_web_session SET revoked_at = ?, revoked_reason = ? \
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND id != ? RETURNING id",
    )
    .bind(now_db())
    .bind(reason)
    .bind(user_id)
    .bind(now_db())
    .bind(except.unwrap_or(0))
    .fetch_all(&db.write)
    .await
}

/// 記下「最後使用」（REST 請求，呼叫端節流）。/ Note the last use (REST requests; the caller throttles).
pub async fn touch(db: &Db, id: i64, ip: Option<&str>) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_web_session SET last_used_at = ?, ip = COALESCE(?, ip) WHERE id = ? AND revoked_at IS NULL")
        .bind(now_db())
        .bind(ip)
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 清掉到期或撤銷都超過 `cutoff` 的列。/ Delete rows expired or revoked before `cutoff`.
pub async fn purge(db: &Db, cutoff: &str) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM telepy_web_session WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
        .bind(cutoff)
        .bind(cutoff)
        .execute(&db.write)
        .await?
        .rows_affected())
}
