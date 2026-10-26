//! 使用者自訂的終端機配色（`telepy_terminal_scheme`）：每人最多 `MAX_PER_USER` 個，只有本人看得到。
//! `scheme_id` 是 API 上的 id（`custom-<8 hex>`，全站唯一），terminal_scheme / 每條隧道的覆寫用它指向配色；
//! `colors` 是驗證過的 JSON（見 api/terminal_schemes.rs），原樣存、原樣回。
//! User-defined terminal colour schemes: at most `MAX_PER_USER` each, visible to their owner only.
//! `scheme_id` is the API id (`custom-<8 hex>`, unique site-wide) that terminal_scheme and per-tunnel
//! overrides point at; `colors` is the validated JSON (api/terminal_schemes.rs), stored and returned as is.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

pub const MAX_PER_USER: i64 = 20;

#[derive(Debug, Clone, FromRow)]
pub struct TerminalScheme {
    pub id: i64,
    pub user_id: i64,
    pub scheme_id: String,
    pub name: String,
    pub colors: String,
    pub created_at: String,
    pub updated_at: String,
}

const T: &str = "telepy_terminal_scheme";
const COLS: &str = "id, user_id, scheme_id, name, colors, created_at, updated_at";

pub async fn list_for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<TerminalScheme>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE user_id = ? ORDER BY created_at, id"))
        .bind(user_id)
        .fetch_all(&db.read)
        .await
}

/// 只找本人的：別人的 id 看起來像不存在。/ The owner's only: someone else's id looks like it does not exist.
pub async fn get(db: &Db, user_id: i64, scheme_id: &str) -> sqlx::Result<Option<TerminalScheme>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE user_id = ? AND scheme_id = ?"))
        .bind(user_id)
        .bind(scheme_id)
        .fetch_optional(&db.read)
        .await
}

pub async fn count_for_user(db: &Db, user_id: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {T} WHERE user_id = ?")).bind(user_id).fetch_one(&db.read).await
}

/// 存一個新配色；`scheme_id` 由呼叫端產生（撞到 UNIQUE 時回 Err，呼叫端換一個再試）。
/// Insert a scheme; the caller generates `scheme_id` (a UNIQUE clash is an Err — pick another and retry).
pub async fn insert(db: &Db, user_id: i64, scheme_id: &str, name: &str, colors: &str) -> sqlx::Result<TerminalScheme> {
    let now = now_db();
    sqlx::query(&format!("INSERT INTO {T} (user_id, scheme_id, name, colors, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"))
        .bind(user_id)
        .bind(scheme_id)
        .bind(name)
        .bind(colors)
        .bind(&now)
        .bind(&now)
        .execute(&db.write)
        .await?;
    Ok(get(db, user_id, scheme_id).await?.expect("scheme just inserted"))
}

/// None = 不動該欄位。/ None leaves the field alone.
pub async fn update(db: &Db, user_id: i64, scheme_id: &str, name: Option<&str>, colors: Option<&str>) -> sqlx::Result<Option<TerminalScheme>> {
    let r = sqlx::query(&format!(
        "UPDATE {T} SET name = COALESCE(?, name), colors = COALESCE(?, colors), updated_at = ? WHERE user_id = ? AND scheme_id = ?"
    ))
    .bind(name)
    .bind(colors)
    .bind(now_db())
    .bind(user_id)
    .bind(scheme_id)
    .execute(&db.write)
    .await?;
    if r.rows_affected() == 0 {
        return Ok(None);
    }
    get(db, user_id, scheme_id).await
}

/// 回傳是否真的刪了一列。/ Returns whether a row was removed.
pub async fn delete(db: &Db, user_id: i64, scheme_id: &str) -> sqlx::Result<bool> {
    let r = sqlx::query(&format!("DELETE FROM {T} WHERE user_id = ? AND scheme_id = ?"))
        .bind(user_id)
        .bind(scheme_id)
        .execute(&db.write)
        .await?;
    Ok(r.rows_affected() > 0)
}
