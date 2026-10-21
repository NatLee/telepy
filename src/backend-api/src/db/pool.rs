//! SQLite 連線池：一個「寫入」池（max 1 連線，寫入在 process 內序列化，避免 SQLITE_BUSY）
//! 加一個「讀取」池。WAL + busy_timeout 與 Django 版 settings 相同。
//! Two pools: a single-connection writer (serialises writes in-process) and a reader pool.

use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};

#[derive(Clone)]
pub struct Db {
    pub read: SqlitePool,
    pub write: SqlitePool,
}

impl Db {
    pub async fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(20))
            .foreign_keys(false); // Django 建的表沒有 ON DELETE CASCADE；串聯刪除由程式負責。
        let write = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts.clone())
            .await?;
        let read = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(opts.read_only(false))
            .await?;
        Ok(Self { read, write })
    }

    /// 測試用：記憶體資料庫（讀寫同一條連線才看得到同一份資料）。
    #[cfg(test)]
    pub async fn open_memory() -> anyhow::Result<Self> {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .journal_mode(SqliteJournalMode::Memory);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await?;
        Ok(Self { read: pool.clone(), write: pool })
    }
}
