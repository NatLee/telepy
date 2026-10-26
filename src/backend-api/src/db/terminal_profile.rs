//! 使用者對單一隧道的終端機外觀覆寫：字型 / 字級 / 配色 / 粗體畫法 / 連字，NULL 欄位 = 跟隨個人預設
//! （user_management_usersettings 的 terminal_*）。一列 = (user, tunnel)；全部跟隨預設時不存列。
//! Per-user terminal appearance override for one tunnel: font / size / colour scheme / bold style /
//! ligatures; a NULL field inherits the personal default (terminal_* in user_management_usersettings).
//! One row per (user, tunnel); no row when everything inherits.

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
    /// 配色 id（內建或 `custom-…`）。/ Colour-scheme id (built-in or `custom-…`).
    pub scheme: Option<String>,
    /// 粗體的畫法：face / bright / both。/ How bold text is drawn: face / bright / both.
    pub bold: Option<String>,
    pub ligatures: Option<bool>,
    pub updated_at: String,
}

/// 覆寫的欄位（PUT 整列）。/ The override's fields (a PUT replaces the whole row).
#[derive(Debug, Clone, Default)]
pub struct ProfileFields {
    pub font: Option<String>,
    pub font_size: Option<i64>,
    pub scheme: Option<String>,
    pub bold: Option<String>,
    pub ligatures: Option<bool>,
}

impl ProfileFields {
    /// 全部跟隨預設 = 沒有覆寫。/ Everything inherits = no override at all.
    pub fn is_empty(&self) -> bool {
        self.font.is_none() && self.font_size.is_none() && self.scheme.is_none() && self.bold.is_none() && self.ligatures.is_none()
    }
}

const T: &str = "telepy_terminal_profile";
const COLS: &str = "id, user_id, tunnel_id, font, font_size, scheme, bold, ligatures, updated_at";

pub async fn get(db: &Db, user_id: i64, tunnel_id: i64) -> sqlx::Result<Option<TerminalProfile>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE user_id = ? AND tunnel_id = ?"))
        .bind(user_id)
        .bind(tunnel_id)
        .fetch_optional(&db.read)
        .await
}

/// 整列覆寫（PUT 語意）：每個欄位都以傳入值為準。/ Whole-row upsert (PUT semantics).
pub async fn upsert(db: &Db, user_id: i64, tunnel_id: i64, f: &ProfileFields) -> sqlx::Result<TerminalProfile> {
    sqlx::query(&format!(
        "INSERT INTO {T} (user_id, tunnel_id, font, font_size, scheme, bold, ligatures, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(user_id, tunnel_id) DO UPDATE SET font = excluded.font, font_size = excluded.font_size, \
         scheme = excluded.scheme, bold = excluded.bold, ligatures = excluded.ligatures, updated_at = excluded.updated_at"
    ))
    .bind(user_id)
    .bind(tunnel_id)
    .bind(f.font.as_deref())
    .bind(f.font_size)
    .bind(f.scheme.as_deref())
    .bind(f.bold.as_deref())
    .bind(f.ligatures)
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
