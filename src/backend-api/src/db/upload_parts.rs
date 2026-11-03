//! 分段上傳在裝置上的暫存檔帳本（`telepy_upload_part`，見 `crate::uploads`）：Telepy 只清自己記下的暫存檔。
//! The ledger of upload part files on devices (see `crate::uploads`): Telepy only ever cleans files it recorded.

use sqlx::FromRow;

use super::Db;

const P: &str = "telepy_upload_part";

#[derive(Debug, Clone, FromRow, PartialEq, Eq)]
pub struct PartRow {
    pub id: i64,
    pub tunnel_id: i64,
    /// 裝置上的 OS 帳號。/ The device's OS account.
    pub username: String,
    /// 上傳的人（Telepy 使用者）。/ Who uploads (Telepy user).
    pub user_id: i64,
    pub upload: String,
    pub target: String,
    pub part_path: String,
    pub total: i64,
    pub received: i64,
    /// 本機檔案的名字與修改時間（毫秒）：續傳時對得上才接著傳。/ The local file's name and mtime (ms), for resuming.
    pub local_name: Option<String>,
    pub local_modified: Option<i64>,
    /// 現在誰能寫（一次只有一個視窗）；NULL = 沒有（CLI、只有一段的檔案）。/ Who may write now; NULL = anyone with the id.
    pub lease: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const COLS: &str = "id, tunnel_id, username, user_id, upload, target, part_path, total, received, local_name, local_modified, lease, created_at, updated_at";

/// 一筆新的（或同一個暫存檔重新開始）。/ A new entry, or the same part file starting over.
pub struct NewPart<'a> {
    pub tunnel_id: i64,
    pub username: &'a str,
    pub user_id: i64,
    pub upload: &'a str,
    pub target: &'a str,
    pub part_path: &'a str,
    pub total: u64,
    pub local_name: Option<&'a str>,
    pub local_modified: Option<i64>,
    pub lease: Option<&'a str>,
    pub now: &'a str,
}

/// 記下（同一個暫存檔已經有了就重設成 0）；回傳那一筆的 id。/ Record it (the same part file restarts at 0); returns its id.
pub async fn start(db: &Db, p: NewPart<'_>) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!(
        "INSERT INTO {P} (tunnel_id, username, user_id, upload, target, part_path, total, received, local_name, local_modified, lease, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?) \
         ON CONFLICT (tunnel_id, username, part_path) DO UPDATE SET received = 0, total = excluded.total, updated_at = excluded.updated_at, \
         local_name = COALESCE(excluded.local_name, local_name), local_modified = COALESCE(excluded.local_modified, local_modified), \
         lease = COALESCE(excluded.lease, lease) RETURNING id"
    ))
    .bind(p.tunnel_id)
    .bind(p.username)
    .bind(p.user_id)
    .bind(p.upload)
    .bind(p.target)
    .bind(p.part_path)
    .bind(p.total as i64)
    .bind(p.local_name)
    .bind(p.local_modified)
    .bind(p.lease)
    .bind(p.now)
    .bind(p.now)
    .fetch_one(&db.write)
    .await
}

pub async fn by_part(db: &Db, tunnel_id: i64, username: &str, part_path: &str) -> sqlx::Result<Option<PartRow>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {P} WHERE tunnel_id = ? AND username = ? AND part_path = ?"))
        .bind(tunnel_id)
        .bind(username)
        .bind(part_path)
        .fetch_optional(&db.read)
        .await
}

/// 還在寫：記下收到多少、什麼時候。/ Still being written: how much, and when.
pub async fn touch(db: &Db, id: i64, received: u64, now: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {P} SET received = ?, updated_at = ? WHERE id = ?")).bind(received as i64).bind(now).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 換手：這個視窗接著寫。/ Hand the upload to this window.
pub async fn take_lease(db: &Db, id: i64, lease: &str, now: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {P} SET lease = ?, updated_at = ? WHERE id = ?")).bind(lease).bind(now).bind(id).execute(&db.write).await?;
    Ok(())
}

pub async fn remove(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {P} WHERE id = ?")).bind(id).execute(&db.write).await?;
    Ok(())
}

pub async fn remove_part(db: &Db, tunnel_id: i64, username: &str, part_path: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {P} WHERE tunnel_id = ? AND username = ? AND part_path = ?")).bind(tunnel_id).bind(username).bind(part_path).execute(&db.write).await?;
    Ok(())
}

/// 同一個人、同一個目標、同一個本機檔案（名字 + 大小 + 修改時間）的未完成上傳，新的在前。
/// Unfinished uploads of the same person, target and local file (name + size + mtime), newest first.
pub async fn resumable(db: &Db, tunnel_id: i64, username: &str, user_id: i64, target: &str, total: u64, local_name: &str, local_modified: i64) -> sqlx::Result<Vec<PartRow>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM {P} WHERE tunnel_id = ? AND username = ? AND user_id = ? AND target = ? AND total = ? AND local_name = ? AND local_modified = ? ORDER BY updated_at DESC"
    ))
    .bind(tunnel_id)
    .bind(username)
    .bind(user_id)
    .bind(target)
    .bind(total as i64)
    .bind(local_name)
    .bind(local_modified)
    .fetch_all(&db.read)
    .await
}

/// 某條隧道、某個帳號的全部（列清單用，呼叫端再挑資料夾）。/ Everything for a tunnel + account (the caller picks the folder).
pub async fn for_account(db: &Db, tunnel_id: i64, username: &str) -> sqlx::Result<Vec<(PartRow, Option<String>)>> {
    #[derive(FromRow)]
    struct WithName {
        #[sqlx(flatten)]
        row: PartRow,
        uploader: Option<String>,
    }
    let rows: Vec<WithName> = sqlx::query_as(&format!(
        "SELECT p.id, p.tunnel_id, p.username, p.user_id, p.upload, p.target, p.part_path, p.total, p.received, p.local_name, p.local_modified, p.lease, \
         p.created_at, p.updated_at, u.username AS uploader FROM {P} p LEFT JOIN auth_user u ON u.id = p.user_id \
         WHERE p.tunnel_id = ? AND p.username = ? ORDER BY p.updated_at DESC LIMIT 2000"
    ))
    .bind(tunnel_id)
    .bind(username)
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().map(|w| (w.row, w.uploader)).collect())
}

/// 最後動作早於 `before` 的（背景清理）。/ Entries idle since before `before` (the cleanup).
pub async fn idle_since(db: &Db, before: &str, limit: i64) -> sqlx::Result<Vec<PartRow>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {P} WHERE updated_at < ? ORDER BY updated_at LIMIT ?")).bind(before).bind(limit).fetch_all(&db.read).await
}
