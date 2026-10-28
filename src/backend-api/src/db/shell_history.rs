//! 每條隧道的「指令不寫進 shell 歷史檔」個人覆寫（`telepy_shell_history_pref`）：一列 = (user, tunnel)，
//! 沒有列 = 跟隨個人預設（`user_management_usersettings.shell_history`）。
//! The per-tunnel personal override of the shell history choice; no row = the personal default.

use super::Db;
use crate::util::now_db;

const T: &str = "telepy_shell_history_pref";

/// 這個人在這條隧道上的覆寫（`keep` / `skip`），沒有就 None。/ The override, if any.
pub async fn get(db: &Db, user_id: i64, tunnel_id: i64) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(&format!("SELECT mode FROM {T} WHERE user_id = ? AND tunnel_id = ?"))
        .bind(user_id)
        .bind(tunnel_id)
        .fetch_optional(&db.read)
        .await
}

pub async fn set(db: &Db, user_id: i64, tunnel_id: i64, mode: &str) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "INSERT INTO {T} (user_id, tunnel_id, mode, updated_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT(user_id, tunnel_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at"
    ))
    .bind(user_id)
    .bind(tunnel_id)
    .bind(mode)
    .bind(now_db())
    .execute(&db.write)
    .await?;
    Ok(())
}

pub async fn delete(db: &Db, user_id: i64, tunnel_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {T} WHERE user_id = ? AND tunnel_id = ?"))
        .bind(user_id)
        .bind(tunnel_id)
        .execute(&db.write)
        .await?;
    Ok(())
}
