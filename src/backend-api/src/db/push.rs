//! 推播訂閱（每台瀏覽器一筆，綁在開它的那個網頁登入上：登出、被登出、帳號停用 = 這台裝置不再收到推播）。
//! Push subscriptions (one per browser, bound to the web sign-in that made it: signing out, being signed out or a
//! disabled account = no more pushes to that device).

use super::Db;
use crate::util::now_db;

/// 每個人最多幾台裝置（多的話最久沒更新的先走）。/ Devices per person (the stalest goes first).
pub const MAX_PER_USER: i64 = 20;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Subscription {
    pub id: i64,
    pub user_id: i64,
    pub session_id: i64,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub lang: String,
    /// 這台裝置要看到指令內容。/ This device shows the command.
    pub details: bool,
    pub user_agent: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
}

const COLS: &str = "p.id, p.user_id, p.session_id, p.endpoint, p.p256dh, p.auth, p.lang, p.details, p.user_agent, p.created_at, p.updated_at, p.last_success_at, p.last_error, p.last_error_at";

/// 還有效的登入（沒撤銷、沒到期）。/ A live sign-in (not revoked, not expired).
const LIVE: &str = "JOIN telepy_web_session s ON s.id = p.session_id AND s.revoked_at IS NULL AND s.expires_at > ?";

pub struct New<'a> {
    pub user_id: i64,
    pub session_id: i64,
    pub endpoint: &'a str,
    pub p256dh: &'a str,
    pub auth: &'a str,
    pub lang: &'a str,
    pub details: bool,
    pub user_agent: &'a str,
}

/// 新增或更新（同一個網址 = 同一台瀏覽器；換人登入就換主人；同一個登入只留最新的一筆）。回傳 id。
/// Insert or update (the same URL = the same browser; another person signing in there takes it over; one row per
/// sign-in, the newest). Returns the id.
pub async fn upsert(db: &Db, n: &New<'_>) -> sqlx::Result<i64> {
    let now = now_db();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO telepy_push_subscription (user_id, session_id, endpoint, p256dh, auth, lang, details, user_agent, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh, \
         auth = excluded.auth, lang = excluded.lang, details = excluded.details, user_agent = excluded.user_agent, updated_at = excluded.updated_at, \
         created_at = CASE WHEN telepy_push_subscription.user_id = excluded.user_id THEN telepy_push_subscription.created_at ELSE excluded.created_at END, \
         last_error = NULL, last_error_at = NULL \
         RETURNING id",
    )
    .bind(n.user_id)
    .bind(n.session_id)
    .bind(n.endpoint)
    .bind(n.p256dh)
    .bind(n.auth)
    .bind(n.lang)
    .bind(n.details)
    .bind(n.user_agent)
    .bind(&now)
    .bind(&now)
    .fetch_one(&db.write)
    .await?;
    // 一個登入 = 一台瀏覽器 = 一筆：瀏覽器換了網址（重訂、換金鑰）就取代舊的。/ One sign-in = one browser = one row: a new URL replaces the old.
    sqlx::query("DELETE FROM telepy_push_subscription WHERE session_id = ? AND id != ?").bind(n.session_id).bind(id).execute(&db.write).await?;
    // 太多台：最久沒更新的走。/ Too many: the stalest go.
    sqlx::query(
        "DELETE FROM telepy_push_subscription WHERE user_id = ? AND id NOT IN \
         (SELECT id FROM telepy_push_subscription WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)",
    )
    .bind(n.user_id)
    .bind(n.user_id)
    .bind(MAX_PER_USER)
    .execute(&db.write)
    .await?;
    Ok(id)
}

/// 一個人還收得到的訂閱（登入還有效）。/ A person's subscriptions whose sign-in is still live.
pub async fn live_for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<Subscription>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_push_subscription p {LIVE} WHERE p.user_id = ? ORDER BY p.updated_at DESC, p.id DESC"))
        .bind(now_db())
        .bind(user_id)
        .fetch_all(&db.read)
        .await
}

/// 有活著的訂閱的人與他選的「離線多久才推」（沒有設定列 = 預設）。/ People with a live subscription, and their offline wait.
pub async fn status_listeners(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!(
        "SELECT DISTINCT p.user_id, COALESCE(us.push_status_delay, {}) FROM telepy_push_subscription p {LIVE} \
         LEFT JOIN user_management_usersettings us ON us.user_id = p.user_id",
        crate::push::DEFAULT_STATUS_DELAY
    ))
    .bind(now_db())
    .fetch_all(&db.read)
    .await
}

pub async fn get_live(db: &Db, id: i64) -> sqlx::Result<Option<Subscription>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_push_subscription p {LIVE} WHERE p.id = ?")).bind(now_db()).bind(id).fetch_optional(&db.read).await
}

pub async fn set_prefs(db: &Db, id: i64, details: Option<bool>, lang: Option<&str>) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_push_subscription SET details = COALESCE(?, details), lang = COALESCE(?, lang), updated_at = ? WHERE id = ?")
        .bind(details)
        .bind(lang)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn delete(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_push_subscription WHERE id = ?").bind(id).execute(&db.write).await?;
    Ok(())
}

/// 那個登入結束了：它的訂閱一起刪。/ That sign-in ended: its subscriptions go too.
pub async fn delete_for_session(db: &Db, session_id: i64) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM telepy_push_subscription WHERE session_id = ?").bind(session_id).execute(&db.write).await?.rows_affected())
}

/// 登入已經不在（撤銷、到期、被清掉）的訂閱。/ Subscriptions whose sign-in is gone (revoked, expired, purged).
pub async fn delete_orphans(db: &Db) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM telepy_push_subscription WHERE session_id NOT IN \
         (SELECT id FROM telepy_web_session WHERE revoked_at IS NULL AND expires_at > ?)",
    )
    .bind(now_db())
    .execute(&db.write)
    .await?
    .rows_affected())
}

pub async fn record_success(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_push_subscription SET last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?").bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}

pub async fn record_error(db: &Db, id: i64, error: &str) -> sqlx::Result<()> {
    let clipped: String = error.chars().take(300).collect();
    sqlx::query("UPDATE telepy_push_subscription SET last_error = ?, last_error_at = ? WHERE id = ?").bind(clipped).bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}
