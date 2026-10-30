//! 「伺服器狀態」的確認（`telepy_health_ack`，每項檢查一筆；新的取代舊的）。規則在 `crate::doctor::apply_acks`。
//! Server health acknowledgements, one per check (a new one replaces the old). Rules in `crate::doctor::apply_acks`.

use super::Db;

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct AckRow {
    pub check_id: String,
    pub fingerprint: String,
    pub status: String,
    pub note: String,
    pub user_id: Option<i64>,
    pub username: String,
    /// RFC 3339 `…Z`
    pub at: String,
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<AckRow>> {
    sqlx::query_as("SELECT check_id, fingerprint, status, note, user_id, username, at FROM telepy_health_ack ORDER BY check_id").fetch_all(&db.read).await
}

/// 寫入或取代一項的確認。/ Insert or replace a check's acknowledgement.
pub async fn upsert(db: &Db, row: &AckRow) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO telepy_health_ack (check_id, fingerprint, status, note, user_id, username, at) VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (check_id) DO UPDATE SET fingerprint = excluded.fingerprint, status = excluded.status, note = excluded.note, \
         user_id = excluded.user_id, username = excluded.username, at = excluded.at",
    )
    .bind(&row.check_id)
    .bind(&row.fingerprint)
    .bind(&row.status)
    .bind(&row.note)
    .bind(row.user_id)
    .bind(&row.username)
    .bind(&row.at)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 刪掉一項的確認；回傳有沒有。/ Remove a check's acknowledgement; whether there was one.
pub async fn delete(db: &Db, check_id: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query("DELETE FROM telepy_health_ack WHERE check_id = ?").bind(check_id).execute(&db.write).await?.rows_affected() > 0)
}

/// 刪掉多項（問題已解決的）。/ Remove several (problems that are gone).
pub async fn delete_many(db: &Db, check_ids: &[String]) -> sqlx::Result<()> {
    for id in check_ids {
        delete(db, id).await?;
    }
    Ok(())
}
