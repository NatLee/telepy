//! 帶來源 IP（個資）的紀錄只留 90 天：gateway 事件、登入紀錄、AI 稽核。每小時清一次；列數上限仍由各表寫入時處理。
//! Rows that carry source IPs are kept for 90 days: gateway events, sign-ins, AI audit. Purged hourly;
//! the per-table row caps stay with the inserts.

use std::time::Duration;

use super::Db;
use crate::util::db_time;

pub const IP_RETENTION_DAYS: i64 = 90;
const TABLES: [&str; 3] = ["telepy_gateway_event", "telepy_sign_in_event", "telepy_ai_audit_event"];
const INTERVAL: Duration = Duration::from_secs(3600);

/// 刪掉超過保留期的列，回傳刪了幾列。/ Delete expired rows; returns how many went.
pub async fn purge(db: &Db) -> sqlx::Result<u64> {
    let cutoff = db_time(chrono::Utc::now() - chrono::Duration::days(IP_RETENTION_DAYS));
    let mut deleted = 0;
    for t in TABLES {
        deleted += sqlx::query(&format!("DELETE FROM {t} WHERE at < ?")).bind(&cutoff).execute(&db.write).await?.rows_affected();
    }
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
            sqlx::query("INSERT INTO telepy_gateway_event (at, event, message) VALUES (?, 'accepted', 'x')").bind(at).execute(&db.write).await.unwrap();
            sqlx::query("INSERT INTO telepy_sign_in_event (at, user_id, ok, method) VALUES (?, 1, 1, 'password')").bind(at).execute(&db.write).await.unwrap();
            sqlx::query("INSERT INTO telepy_ai_audit_event (at, user_id, client_name, tool, ok) VALUES (?, 1, 'app', 'list_tunnels', 1)").bind(at).execute(&db.write).await.unwrap();
        }
        assert_eq!(purge(&db).await.unwrap(), 3);
        for t in TABLES {
            let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(&db.read).await.unwrap();
            assert_eq!(n, 1, "{t}");
        }
        assert_eq!(purge(&db).await.unwrap(), 0);
    }
}
