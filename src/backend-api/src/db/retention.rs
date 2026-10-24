//! 帶來源 IP（個資）的紀錄只留 90 天：gateway 事件、登入紀錄、AI 稽核。每小時清一次；列數上限仍由各表寫入時處理。
//! Rows that carry source IPs are kept for 90 days: gateway events, sign-ins, AI audit. Purged hourly;
//! the per-table row caps stay with the inserts.

use std::time::Duration;

use super::audit_chain;
use super::Db;
use crate::util::db_time;

pub const IP_RETENTION_DAYS: i64 = 90;
const INTERVAL: Duration = Duration::from_secs(3600);

/// 刪掉超過保留期的列，回傳刪了幾列。刪的是「最後一筆過期列」以前的整段（雜湊鏈只能從頭剪），
/// 經 `audit_chain::prune_through` 先寫 prune 錨點。錨點本身也只留 90 天（各表最新的 prune 錨點除外）。
/// Delete expired rows; returns how many went. Removes the prefix up to the newest expired row through
/// `audit_chain::prune_through` (prune anchor first). Anchors older than 90 days go too, except each
/// table's newest prune anchor, which verification starts from.
pub async fn purge(db: &Db) -> sqlx::Result<u64> {
    let cutoff = db_time(chrono::Utc::now() - chrono::Duration::days(IP_RETENTION_DAYS));
    let mut deleted = 0;
    for t in audit_chain::TABLES {
        let cut: Option<i64> = sqlx::query_scalar(&format!("SELECT MAX(id) FROM {} WHERE at < ?", t.name())).bind(&cutoff).fetch_one(&db.read).await?;
        if let Some(cut) = cut {
            deleted += audit_chain::prune_through(db, t, cut).await?;
        }
    }
    sqlx::query("DELETE FROM telepy_audit_anchor WHERE at < ? AND id NOT IN (SELECT MAX(id) FROM telepy_audit_anchor WHERE kind = 'prune' GROUP BY table_name)")
        .bind(&cutoff)
        .execute(&db.write)
        .await?;
    Ok(deleted)
}

pub async fn run(db: Db) {
    loop {
        match purge(&db).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(rows = n, "retention: purged rows older than {IP_RETENTION_DAYS} days"),
            Err(e) => tracing::warn!(error = %e, "retention: purge failed"),
        }
        tokio::time::sleep(INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn purges_only_expired_rows_of_ip_tables() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("db.sqlite3")).await.unwrap();
        super::super::schema::ensure_schema(&db.write).await.unwrap();
        let old = db_time(chrono::Utc::now() - chrono::Duration::days(IP_RETENTION_DAYS + 1));
        let recent = db_time(chrono::Utc::now() - chrono::Duration::days(IP_RETENTION_DAYS - 1));
        for at in [&old, &recent] {
            use audit_chain::{append, Field, Table};
            let at = Field::text(at.as_str());
            append(&db, Table::Gateway, &[("at", at.clone()), ("event", Field::text("accepted")), ("message", Field::text("x"))]).await.unwrap();
            append(&db, Table::SignIn, &[("at", at.clone()), ("user_id", Field::Int(Some(1))), ("ok", Field::Bool(true)), ("method", Field::text("password"))]).await.unwrap();
            append(&db, Table::AiAudit, &[("at", at), ("user_id", Field::Int(Some(1))), ("client_name", Field::text("app")), ("tool", Field::text("list_tunnels")), ("ok", Field::Bool(true))])
                .await
                .unwrap();
        }
        assert_eq!(purge(&db).await.unwrap(), 3);
        assert!(audit_chain::verify(&db).await.unwrap().ok);
        for t in audit_chain::TABLES.map(|t| t.name()) {
            let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(&db.read).await.unwrap();
            assert_eq!(n, 1, "{t}");
        }
        assert_eq!(purge(&db).await.unwrap(), 0);
    }
}
