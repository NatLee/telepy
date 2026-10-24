//! 網頁終端機錄影的索引（`telepy_terminal_recording`）；檔案本身在 `DATA_DIR/recordings`。
//! The index of web terminal recordings; the files live under `DATA_DIR/recordings`.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct Recording {
    pub id: i64,
    pub tunnel_id: i64,
    pub user_id: i64,
    pub username: String,
    pub os_user: String,
    pub lan_host: Option<String>,
    /// 相對 `DATA_DIR/recordings` 的路徑。/ Path relative to `DATA_DIR/recordings`.
    pub file: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: i64,
    pub bytes: i64,
    pub truncated: bool,
}

const R: &str = "telepy_terminal_recording";
const COLS: &str = "id, tunnel_id, user_id, username, os_user, lan_host, file, started_at, ended_at, duration_ms, bytes, truncated";

pub async fn create(db: &Db, tunnel_id: i64, user_id: i64, username: &str, os_user: &str, lan_host: Option<&str>, file: &str) -> sqlx::Result<i64> {
    Ok(sqlx::query(&format!("INSERT INTO {R} (tunnel_id, user_id, username, os_user, lan_host, file, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)"))
        .bind(tunnel_id)
        .bind(user_id)
        .bind(username)
        .bind(os_user)
        .bind(lan_host)
        .bind(file)
        .bind(now_db())
        .execute(&db.write)
        .await?
        .last_insert_rowid())
}

pub async fn finish(db: &Db, id: i64, duration_ms: i64, bytes: i64, truncated: bool) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {R} SET ended_at = ?, duration_ms = ?, bytes = ?, truncated = ? WHERE id = ?"))
        .bind(now_db())
        .bind(duration_ms)
        .bind(bytes)
        .bind(truncated)
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn get(db: &Db, id: i64) -> sqlx::Result<Option<Recording>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {R} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 看得到的錄影（新的在前）：`all` = 管理員；否則自己的，加上 `managed` 這些隧道上的。可以只看一條隧道。
/// Visible recordings, newest first: everything for admins, otherwise your own plus those on `managed` tunnels.
pub async fn visible(db: &Db, all: bool, user_id: i64, managed: &[i64], tunnel_id: Option<i64>, limit: i64) -> sqlx::Result<Vec<Recording>> {
    let managed = serde_json::to_string(managed).unwrap_or_else(|_| "[]".into());
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM {R} WHERE (? OR user_id = ? OR tunnel_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR tunnel_id = ?) \
         ORDER BY id DESC LIMIT ?"
    ))
    .bind(all)
    .bind(user_id)
    .bind(managed)
    .bind(tunnel_id)
    .bind(tunnel_id)
    .bind(limit)
    .fetch_all(&db.read)
    .await
}

/// 開始時間早於 `cutoff` 而且已經結束的（保留期過了）。/ Ended recordings that started before `cutoff`.
pub async fn ended_before(db: &Db, cutoff: &str) -> sqlx::Result<Vec<Recording>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {R} WHERE ended_at IS NOT NULL AND started_at < ? ORDER BY id")).bind(cutoff).fetch_all(&db.read).await
}

pub async fn for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<Recording>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {R} WHERE tunnel_id = ? ORDER BY id")).bind(tunnel_id).fetch_all(&db.read).await
}

pub async fn delete(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {R} WHERE id = ?")).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 沒收尾的（伺服器重啟時正在錄的）：標成結束，時間用檔案能算出的長度。/ Recordings left open by a restart.
pub async fn close_dangling(db: &Db) -> sqlx::Result<Vec<Recording>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {R} WHERE ended_at IS NULL")).fetch_all(&db.read).await
}
