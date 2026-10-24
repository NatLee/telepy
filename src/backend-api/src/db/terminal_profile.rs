//! 使用者對單一隧道的終端機外觀覆寫：字型 / 字級 / 配色，NULL 欄位 = 跟隨個人預設
//! （user_management_usersettings 的 terminal_*）。一列 = (user, tunnel)；全部跟隨預設時不存列。
//! Per-user terminal appearance override for one tunnel: font / size / colour scheme; a NULL field
//! inherits the personal default (terminal_* in user_management_usersettings). One row per
//! (user, tunnel); no row when everything inherits.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct TerminalProfile {
    pub id: i64,
    pub user_id: i64,
    pub tunnel_id: i64,
    /// 字型 id（前端 lib/terminalAppearance.ts 的清單）。/ Font id from the frontend's list.
    pub font: Option<String>,
    pub font_size: Option<i64>,
    /// 配色 id。/ Colour-scheme id.
    pub scheme: Option<String>,
    pub updated_at: String,
}

const T: &str = "telepy_terminal_profile";
const COLS: &str = "id, user_id, tunnel_id, font, font_size, scheme, updated_at";

pub async fn get(db: &Db, user_id: i64, tunnel_id: i64) -> sqlx::Result<Option<TerminalProfile>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE user_id = ? AND tunnel_id = ?"))
        .bind(user_id)
        .bind(tunnel_id)
        .fetch_optional(&db.read)
        .await
}

/// 整列覆寫（PUT 語意）：三個欄位都以傳入值為準。/ Whole-row upsert (PUT semantics).
pub async fn upsert(
    db: &Db,
    user_id: i64,
    tunnel_id: i64,
    font: Option<&str>,
    font_size: Option<i64>,
    scheme: Option<&str>,
) -> sqlx::Result<TerminalProfile> {
    sqlx::query(&format!(
        "INSERT INTO {T} (user_id, tunnel_id, font, font_size, scheme, updated_at) VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(user_id, tunnel_id) DO UPDATE SET font = excluded.font, font_size = excluded.font_size, \
         scheme = excluded.scheme, updated_at = excluded.updated_at"
    ))
    .bind(user_id)
    .bind(tunnel_id)
    .bind(font)
    .bind(font_size)
    .bind(scheme)
    .bind(now_db())
    .execute(&db.write)
    .await?;
    Ok(get(db, user_id, tunnel_id).await?.expect("profile just upserted"))
}

/// 回傳是否真的刪了一列。/ Returns whether a row was removed.
pub async fn delete(db: &Db, user_id: i64, tunnel_id: i64) -> sqlx::Result<bool> {
    let r = sqlx::query(&format!("DELETE FROM {T} WHERE user_id = ? AND tunnel_id = ?"))
        .bind(user_id)
        .bind(tunnel_id)
        .execute(&db.write)
        .await?;
    Ok(r.rows_affected() > 0)
}
