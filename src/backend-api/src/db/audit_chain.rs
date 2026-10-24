//! 稽核紀錄的雜湊鏈：`telepy_gateway_event` / `telepy_sign_in_event` / `telepy_ai_audit_event` 每一列存
//! `prev_hash`（上一列的 hash）與 `hash = SHA-256(prev_hash, id, 欄位…)`，改一列、刪中間一列、調換順序都會斷鏈。
//! 修剪（列數上限、90 天保留）前先寫一筆 `prune` 錨點（被刪的最新一列的 id + hash），驗證從最新的 prune 錨點接著走。
//! 鏈頭每 10 分鐘（以及每次修剪後）附加到 DB 外的 `<log_root>/audit-anchors.log`（JSON lines）並記一筆 `checkpoint`
//! 錨點：就算有人改完內容再把整條鏈重算一遍，檔案裡的舊鏈頭也對不上。升級前的列 hash 為 NULL，鏈從第一筆有 hash 的列開始。
//!
//! Hash chain over the three audit tables. Every row stores `prev_hash` and `hash = SHA-256(prev_hash, id,
//! fields…)`, so editing, deleting or reordering rows breaks the chain. Pruning first writes a `prune` anchor
//! (id + hash of the newest deleted row); verification resumes from the newest one. The chain head is appended
//! every 10 minutes (and after each prune) to `<log_root>/audit-anchors.log` outside the database, so rewriting
//! the whole chain after an edit is still caught. Rows written before the upgrade keep NULL hashes.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::Db;
use crate::util::now_db;

/// 外部錨點檔名（放在 `log_root` 底下）。/ Anchors file name, under `log_root`.
pub const ANCHORS_FILE: &str = "audit-anchors.log";
/// 多久把鏈頭寫到外部錨點檔一次。/ How often the chain heads go to the anchors file.
pub const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(600);
/// 驗證時一次讀幾列。/ Rows per verification batch.
const VERIFY_BATCH: i64 = 5000;
const HASH_DOMAIN: &[u8] = b"telepy-audit-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Table {
    Gateway,
    SignIn,
    AiAudit,
}

pub const TABLES: [Table; 3] = [Table::Gateway, Table::SignIn, Table::AiAudit];

impl Table {
    pub fn name(self) -> &'static str {
        match self {
            Table::Gateway => "telepy_gateway_event",
            Table::SignIn => "telepy_sign_in_event",
            Table::AiAudit => "telepy_ai_audit_event",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        TABLES.into_iter().find(|t| t.name() == name)
    }

    /// 進 hash 的欄位（不含 id / prev_hash / hash），順序固定；v1 格式。之後新增的欄位不進 hash。
    /// Columns covered by the hash (v1 format), in this order. Columns added later are not covered.
    pub fn fields(self) -> &'static [&'static str] {
        match self {
            Table::Gateway => &["at", "event", "peer", "port", "tunnel_id", "message"],
            Table::SignIn => &["at", "user_id", "ok", "method", "second_factor", "ip", "user_agent", "reason"],
            Table::AiAudit => &[
                "at", "user_id", "grant_id", "client_name", "tool", "tunnel_id", "session_id", "target_username", "detail", "ok", "exit_code",
                "duration_ms", "bytes_out", "error", "ip",
            ],
        }
    }

    fn idx(self) -> usize {
        self as usize
    }

    /// `CAST(col AS TEXT), …`：寫入與驗證都讓 SQLite 自己把值轉成文字，兩邊一定一致。
    /// Both writing and verifying let SQLite render the values as text, so they always agree.
    fn select_fields(self) -> String {
        self.fields().iter().map(|c| format!("CAST(\"{c}\" AS TEXT)")).collect::<Vec<_>>().join(", ")
    }
}

/// 一個欄位值（寫入用）。/ A column value for [`append`].
#[derive(Debug, Clone)]
pub enum Field {
    Text(Option<String>),
    Int(Option<i64>),
    Bool(bool),
}

impl Field {
    pub fn text(s: impl Into<String>) -> Self {
        Field::Text(Some(s.into()))
    }
    pub fn opt_text(s: Option<&str>) -> Self {
        Field::Text(s.map(str::to_string))
    }
}

/// 長度前綴，免得 `"ab","c"` 與 `"a","bc"` 算出同一個 hash。/ Length-prefixed so field boundaries count.
fn put(h: &mut Sha256, v: Option<&str>) {
    match v {
        None => h.update([0u8]),
        Some(s) => {
            h.update([1u8]);
            h.update((s.len() as u64).to_be_bytes());
            h.update(s.as_bytes());
        }
    }
}

/// 一列的 hash：SHA-256(版本, prev_hash, id, 欄位數, 每個欄位)，小寫 hex。/ Row hash, lowercase hex.
pub fn row_hash(prev_hash: Option<&str>, id: i64, fields: &[Option<&str>]) -> String {
    let mut h = Sha256::new();
    h.update(HASH_DOMAIN);
    put(&mut h, prev_hash);
    h.update(id.to_be_bytes());
    h.update((fields.len() as u64).to_be_bytes());
    for f in fields {
        put(&mut h, *f);
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for b in h.finalize() {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 15) as usize] as char);
    }
    out
}

#[derive(Debug, Clone, Default)]
struct Head {
    hash: Option<String>,
}

/// 每張表一把鎖 + 記憶體裡的鏈頭（第一次用時從 DB 讀）。/ One lock per table plus the cached chain head.
#[derive(Default)]
pub struct AuditChains {
    heads: [Mutex<Option<Head>>; 3],
    anchors_file: RwLock<Option<PathBuf>>,
}

impl AuditChains {
    pub fn set_anchors_file(&self, path: PathBuf) {
        if let Ok(mut g) = self.anchors_file.write() {
            *g = Some(path);
        }
    }
    pub fn anchors_file(&self) -> Option<PathBuf> {
        self.anchors_file.read().ok().and_then(|g| g.clone())
    }
}

async fn load_head(conn: &mut SqliteConnection, table: Table) -> sqlx::Result<Head> {
    let last: Option<Option<String>> = sqlx::query_scalar(&format!("SELECT hash FROM {} ORDER BY id DESC LIMIT 1", table.name())).fetch_optional(&mut *conn).await?;
    if let Some(hash) = last {
        return Ok(Head { hash });
    }
    // 表被修剪到空了：下一列接在最後一個 prune 錨點後面。/ Emptied by pruning: continue from the prune anchor.
    let anchor: Option<Option<String>> =
        sqlx::query_scalar("SELECT row_hash FROM telepy_audit_anchor WHERE table_name = ? AND kind = 'prune' ORDER BY id DESC LIMIT 1")
            .bind(table.name())
            .fetch_optional(&mut *conn)
            .await?;
    Ok(Head { hash: anchor.flatten() })
}

/// 寫入一列並接上鏈（同一個 transaction 裡算好 prev_hash / hash）。回傳新列 id。
/// Insert one row and chain it (prev_hash / hash stored in the same transaction). Returns the new id.
pub async fn append(db: &Db, table: Table, values: &[(&str, Field)]) -> sqlx::Result<i64> {
    let mut guard = db.audit.heads[table.idx()].lock().await;
    let mut tx = db.write.begin().await?;
    if guard.is_none() {
        *guard = Some(load_head(&mut tx, table).await?);
    }
    let prev = guard.as_ref().and_then(|h| h.hash.clone());
    let cols = values.iter().map(|(c, _)| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let marks = vec!["?"; values.len()].join(", ");
    let sql = format!("INSERT INTO {} ({cols}) VALUES ({marks})", table.name());
    let mut q = sqlx::query(&sql);
    for (_, v) in values {
        q = match v {
            Field::Text(s) => q.bind(s.clone()),
            Field::Int(i) => q.bind(*i),
            Field::Bool(b) => q.bind(*b),
        };
    }
    let id = q.execute(&mut *tx).await?.last_insert_rowid();
    let row = sqlx::query(&format!("SELECT {} FROM {} WHERE id = ?", table.select_fields(), table.name())).bind(id).fetch_one(&mut *tx).await?;
    let texts: Vec<Option<String>> = (0..table.fields().len()).map(|i| row.try_get::<Option<String>, _>(i)).collect::<Result<_, _>>()?;
    let refs: Vec<Option<&str>> = texts.iter().map(|s| s.as_deref()).collect();
    let hash = row_hash(prev.as_deref(), id, &refs);
    sqlx::query(&format!("UPDATE {} SET prev_hash = ?, hash = ? WHERE id = ?", table.name()))
        .bind(&prev)
        .bind(&hash)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    *guard = Some(Head { hash: Some(hash) });
    Ok(id)
}

/// 刪掉 id ≤ `max_id` 的列；先在同一個 transaction 寫 prune 錨點（被刪的最新一列）。之後寫一次外部 checkpoint。
/// Delete rows with id ≤ `max_id`, writing a prune anchor for the newest deleted row in the same transaction;
/// then checkpoint the head to the anchors file. Returns how many rows went.
pub async fn prune_through(db: &Db, table: Table, max_id: i64) -> sqlx::Result<u64> {
    let deleted = {
        let _guard = db.audit.heads[table.idx()].lock().await;
        let mut tx = db.write.begin().await?;
        let newest: Option<(i64, Option<String>)> = sqlx::query_as(&format!("SELECT id, hash FROM {} WHERE id <= ? ORDER BY id DESC LIMIT 1", table.name()))
            .bind(max_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some((row_id, row_hash)) = newest else { return Ok(0) };
        insert_anchor(&mut tx, table, "prune", row_id, row_hash.as_deref()).await?;
        let n = sqlx::query(&format!("DELETE FROM {} WHERE id <= ?", table.name())).bind(row_id).execute(&mut *tx).await?.rows_affected();
        tx.commit().await?;
        n
    };
    if let Err(e) = checkpoint(db, table).await {
        tracing::warn!(table = table.name(), error = %e, "audit chain: checkpoint after prune failed");
    }
    Ok(deleted)
}

async fn insert_anchor(conn: &mut SqliteConnection, table: Table, kind: &str, row_id: i64, row_hash: Option<&str>) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO telepy_audit_anchor (at, table_name, kind, row_id, row_hash) VALUES (?, ?, ?, ?, ?)")
        .bind(now_db())
        .bind(table.name())
        .bind(kind)
        .bind(row_id)
        .bind(row_hash)
        .execute(conn)
        .await?;
    Ok(())
}

/// 外部錨點檔的一行。/ One line of the anchors file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointLine {
    pub at: String,
    pub table: String,
    pub row_id: i64,
    pub row_hash: String,
}

/// 把這張表目前的鏈頭附加到外部錨點檔並記一筆 checkpoint 錨點。表是空的或鏈頭沒有 hash（舊列）就略過。
/// Append the table's current head to the anchors file and record a checkpoint anchor. Skipped when the
/// table is empty or its head predates the chain.
pub async fn checkpoint(db: &Db, table: Table) -> anyhow::Result<Option<CheckpointLine>> {
    let _guard = db.audit.heads[table.idx()].lock().await;
    let mut conn = db.write.acquire().await?;
    let head: Option<(i64, Option<String>)> = sqlx::query_as(&format!("SELECT id, hash FROM {} ORDER BY id DESC LIMIT 1", table.name())).fetch_optional(&mut *conn).await?;
    let Some((row_id, Some(row_hash))) = head else { return Ok(None) };
    let line = CheckpointLine { at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true), table: table.name().to_string(), row_id, row_hash };
    if let Some(path) = db.audit.anchors_file() {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut f = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await?;
        f.write_all(format!("{}\n", serde_json::to_string(&line)?).as_bytes()).await?;
        f.flush().await?;
    }
    insert_anchor(&mut conn, table, "checkpoint", line.row_id, Some(&line.row_hash)).await?;
    Ok(Some(line))
}

pub async fn checkpoint_all(db: &Db) {
    for t in TABLES {
        if let Err(e) = checkpoint(db, t).await {
            tracing::warn!(table = t.name(), error = %e, "audit chain: checkpoint failed");
        }
    }
}

/// 背景：開機時與之後每 [`CHECKPOINT_INTERVAL`] 寫一次 checkpoint。/ Checkpoint at start and every interval.
pub async fn run(db: Db) {
    loop {
        checkpoint_all(&db).await;
        tokio::time::sleep(CHECKPOINT_INTERVAL).await;
    }
}

/// 讀外部錨點檔（不存在 = 沒有 checkpoint；壞掉的行略過）。/ Read the anchors file; missing = none.
pub async fn read_checkpoints(db: &Db) -> std::io::Result<Vec<CheckpointLine>> {
    let Some(path) = db.audit.anchors_file() else { return Ok(Vec::new()) };
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(text.lines().filter_map(|l| serde_json::from_str(l.trim()).ok()).collect())
}

/// 一張表的驗證結果。`reason`：hash_mismatch（內容被改）、link_mismatch（前一列不見或順序被換）、
/// missing_hash（鏈開始後出現沒有 hash 的列）、checkpoint_mismatch（與外部錨點不符：整條鏈被重算過）、
/// checkpoint_missing（外部錨點記的列不見了：尾端被刪）。
/// Verification result for one table; `reason` is one of the codes above.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TableReport {
    pub table: String,
    pub ok: bool,
    pub checked: u64,
    pub first_id: Option<i64>,
    pub last_id: Option<i64>,
    pub unhashed_before: u64,
    pub broken_at: Option<i64>,
    pub reason: Option<String>,
    pub checkpoints_checked: u64,
    pub checkpoints_mismatched: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub ok: bool,
    pub tables: Vec<TableReport>,
}

/// 驗證三張表（外部錨點檔讀自 `db.audit`）。/ Verify all three tables against the chain and the anchors file.
pub async fn verify(db: &Db) -> anyhow::Result<Report> {
    let lines = read_checkpoints(db).await?;
    let mut tables = Vec::new();
    for t in TABLES {
        let cps: Vec<&CheckpointLine> = lines.iter().filter(|l| l.table == t.name()).collect();
        tables.push(verify_table(db, t, &cps).await?);
    }
    Ok(Report { ok: tables.iter().all(|t| t.ok), tables })
}

/// 依 id 順序分批走一張表（一個讀 transaction，快照一致），重算每列 hash、檢查 prev_hash 連結與外部 checkpoint。
/// Walk one table in id order in batches inside one read transaction (consistent snapshot).
pub async fn verify_table(db: &Db, table: Table, checkpoints: &[&CheckpointLine]) -> sqlx::Result<TableReport> {
    let mut tx = db.read.begin().await?;
    let anchor: Option<(i64, Option<String>)> =
        sqlx::query_as("SELECT row_id, row_hash FROM telepy_audit_anchor WHERE table_name = ? AND kind = 'prune' ORDER BY id DESC LIMIT 1")
            .bind(table.name())
            .fetch_optional(&mut *tx)
            .await?;
    let start = anchor.as_ref().map(|a| a.0).unwrap_or(0);
    let mut expected_prev: Option<String> = anchor.and_then(|a| a.1);
    // row_id → 外部錨點記的 hash（同一列可能被記多次）。/ Checkpointed hashes per row id.
    let mut wanted: BTreeMap<i64, Vec<&str>> = BTreeMap::new();
    for c in checkpoints.iter().filter(|c| c.row_id > start) {
        wanted.entry(c.row_id).or_default().push(&c.row_hash);
    }

    let mut r = TableReport {
        table: table.name().to_string(),
        ok: true,
        checked: 0,
        first_id: None,
        last_id: None,
        unhashed_before: 0,
        broken_at: None,
        reason: None,
        checkpoints_checked: 0,
        checkpoints_mismatched: 0,
    };
    let mut chain_issue: Option<(i64, &'static str)> = None;
    let mut cp_issue: Option<(i64, &'static str)> = None;
    let mut started = false;
    let mut cursor = start;
    let n_fields = table.fields().len();
    let sql = format!("SELECT id, prev_hash, hash, {} FROM {} WHERE id > ? ORDER BY id LIMIT ?", table.select_fields(), table.name());
    loop {
        let rows = sqlx::query(&sql).bind(cursor).bind(VERIFY_BATCH).fetch_all(&mut *tx).await?;
        if rows.is_empty() {
            break;
        }
        for row in &rows {
            let id: i64 = row.try_get(0)?;
            let prev: Option<String> = row.try_get(1)?;
            let hash: Option<String> = row.try_get(2)?;
            cursor = id;
            let Some(hash) = hash else {
                if started {
                    chain_issue.get_or_insert((id, "missing_hash"));
                } else {
                    r.unhashed_before += 1;
                }
                expected_prev = None;
                continue;
            };
            started = true;
            r.checked += 1;
            r.first_id.get_or_insert(id);
            r.last_id = Some(id);
            if prev != expected_prev {
                chain_issue.get_or_insert((id, "link_mismatch"));
            }
            let mut texts: Vec<Option<String>> = Vec::with_capacity(n_fields);
            for i in 0..n_fields {
                texts.push(row.try_get(3 + i)?);
            }
            let refs: Vec<Option<&str>> = texts.iter().map(|s| s.as_deref()).collect();
            if row_hash(prev.as_deref(), id, &refs) != hash {
                chain_issue.get_or_insert((id, "hash_mismatch"));
            }
            if let Some(hs) = wanted.remove(&id) {
                for h in hs {
                    r.checkpoints_checked += 1;
                    if h != hash {
                        r.checkpoints_mismatched += 1;
                        cp_issue.get_or_insert((id, "checkpoint_mismatch"));
                    }
                }
            }
            expected_prev = Some(hash);
        }
    }
    tx.commit().await?;
    // 剩下的 checkpoint：記的列已經不在了（不是被修剪掉的，那些 id ≤ start 已排除）。
    // Leftover checkpoints point at rows that are gone (pruned ones were excluded above).
    for (id, hs) in wanted {
        r.checkpoints_checked += hs.len() as u64;
        r.checkpoints_mismatched += hs.len() as u64;
        // 尾端被刪時鏈本身看不出來，只有外部錨點知道。/ A truncated tail is only visible through the anchors.
        if cp_issue.is_none_or(|c| id < c.0) {
            cp_issue = Some((id, "checkpoint_missing"));
        }
    }
    let first = match (chain_issue, cp_issue) {
        (Some(a), Some(b)) => Some(if b.0 < a.0 { b } else { a }),
        (a, b) => a.or(b),
    };
    if let Some((id, reason)) = first {
        r.ok = false;
        r.broken_at = Some(id);
        r.reason = Some(reason.to_string());
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_length_prefixed_and_binds_everything() {
        let a = row_hash(None, 1, &[Some("ab"), Some("c")]);
        assert_eq!(a.len(), 64);
        assert_ne!(a, row_hash(None, 1, &[Some("a"), Some("bc")]));
        assert_ne!(a, row_hash(None, 2, &[Some("ab"), Some("c")]));
        assert_ne!(a, row_hash(Some(""), 1, &[Some("ab"), Some("c")]));
        assert_ne!(row_hash(None, 1, &[None]), row_hash(None, 1, &[Some("")]));
        assert_ne!(row_hash(None, 1, &[Some("x"), None]), row_hash(None, 1, &[None, Some("x")]));
        assert_eq!(a, row_hash(None, 1, &[Some("ab"), Some("c")]));
    }

    async fn db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("db.sqlite3")).await.unwrap();
        super::super::schema::ensure_schema(&db.write).await.unwrap();
        db.audit.set_anchors_file(dir.path().join("logs").join(ANCHORS_FILE));
        (dir, db)
    }

    async fn gw(db: &Db, msg: &str) -> i64 {
        gw_at(db, &now_db(), msg).await
    }

    async fn gw_at(db: &Db, at: &str, msg: &str) -> i64 {
        append(db, Table::Gateway, &[("at", Field::text(at)), ("event", Field::text("accepted")), ("port", Field::Int(Some(22))), ("message", Field::text(msg))]).await.unwrap()
    }

    async fn report(db: &Db, t: Table) -> TableReport {
        verify(db).await.unwrap().tables.into_iter().find(|r| r.table == t.name()).unwrap()
    }

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sql).execute(&db.write).await.unwrap();
    }

    #[tokio::test]
    async fn intact_chain_verifies() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        append(&db, Table::SignIn, &[("at", Field::text(now_db())), ("user_id", Field::Int(Some(1))), ("ok", Field::Bool(true)), ("method", Field::text("password"))]).await.unwrap();
        checkpoint_all(&db).await;
        let rep = verify(&db).await.unwrap();
        assert!(rep.ok, "{rep:?}");
        let g = &rep.tables[0];
        assert_eq!((g.checked, g.first_id, g.last_id, g.checkpoints_checked), (10, Some(1), Some(10), 1));
        assert_eq!(rep.tables[1].checked, 1);
        assert_eq!(rep.tables[2].checked, 0);
    }

    #[tokio::test]
    async fn edited_message_is_caught() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        exec(&db, "UPDATE telepy_gateway_event SET message = 'nothing to see' WHERE id = 5").await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.broken_at, r.reason.as_deref()), (false, Some(5), Some("hash_mismatch")), "{r:?}");
    }

    #[tokio::test]
    async fn deleted_middle_row_is_caught() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        exec(&db, "DELETE FROM telepy_gateway_event WHERE id = 5").await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.broken_at, r.reason.as_deref()), (false, Some(6), Some("link_mismatch")), "{r:?}");
    }

    #[tokio::test]
    async fn deleted_first_rows_are_caught() {
        let (_d, db) = db().await;
        for i in 0..5 {
            gw(&db, &format!("m{i}")).await;
        }
        exec(&db, "DELETE FROM telepy_gateway_event WHERE id <= 2").await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.broken_at, r.reason.as_deref()), (false, Some(3), Some("link_mismatch")), "{r:?}");
    }

    #[tokio::test]
    async fn reordered_rows_are_caught() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        // 對調第 5、6 列的 id（連同 hash）。/ Swap the ids of rows 5 and 6, hashes included.
        exec(&db, "UPDATE telepy_gateway_event SET id = -5 WHERE id = 5").await;
        exec(&db, "UPDATE telepy_gateway_event SET id = 5 WHERE id = 6").await;
        exec(&db, "UPDATE telepy_gateway_event SET id = 6 WHERE id = -5").await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.broken_at), (false, Some(5)), "{r:?}");
    }

    /// 改完再把整條鏈重算：鏈本身一致，只有外部錨點檔抓得到。/ A fully recomputed chain is caught by the anchors file.
    #[tokio::test]
    async fn recomputed_chain_is_caught_by_anchors_file() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        let cp = checkpoint(&db, Table::Gateway).await.unwrap().unwrap();
        assert_eq!(cp.row_id, 10);
        for i in 10..12 {
            gw(&db, &format!("m{i}")).await;
        }
        exec(&db, "UPDATE telepy_gateway_event SET message = 'forged' WHERE id = 5").await;
        let mut prev: Option<String> = sqlx::query_scalar("SELECT hash FROM telepy_gateway_event WHERE id = 4").fetch_one(&db.read).await.unwrap();
        for id in 5..=12i64 {
            let row = sqlx::query(&format!("SELECT {} FROM telepy_gateway_event WHERE id = ?", Table::Gateway.select_fields())).bind(id).fetch_one(&db.read).await.unwrap();
            let texts: Vec<Option<String>> = (0..6).map(|i| row.try_get(i).unwrap()).collect();
            let refs: Vec<Option<&str>> = texts.iter().map(|s| s.as_deref()).collect();
            let h = row_hash(prev.as_deref(), id, &refs);
            sqlx::query("UPDATE telepy_gateway_event SET prev_hash = ?, hash = ? WHERE id = ?").bind(&prev).bind(&h).bind(id).execute(&db.write).await.unwrap();
            prev = Some(h);
        }
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.broken_at, r.reason.as_deref()), (false, Some(10), Some("checkpoint_mismatch")), "{r:?}");
        assert_eq!((r.checkpoints_checked, r.checkpoints_mismatched), (1, 1));
    }

    #[tokio::test]
    async fn truncated_tail_is_caught_by_anchors_file() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        checkpoint(&db, Table::Gateway).await.unwrap();
        exec(&db, "DELETE FROM telepy_gateway_event WHERE id >= 8").await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.broken_at, r.reason.as_deref()), (false, Some(10), Some("checkpoint_missing")), "{r:?}");
    }

    #[tokio::test]
    async fn pruning_by_row_cap_keeps_the_chain_valid() {
        let (_d, db) = db().await;
        for i in 0..20 {
            gw(&db, &format!("m{i}")).await;
        }
        checkpoint(&db, Table::Gateway).await.unwrap();
        assert_eq!(prune_through(&db, Table::Gateway, 7).await.unwrap(), 7);
        assert_eq!(prune_through(&db, Table::Gateway, 12).await.unwrap(), 5);
        gw(&db, "after").await;
        let r = report(&db, Table::Gateway).await;
        assert!(r.ok, "{r:?}");
        assert_eq!((r.first_id, r.last_id, r.checked), (Some(13), Some(21), 9));
        // 在修剪點之後刪一列還是會被抓到。/ Deleting the first remaining row is still caught.
        exec(&db, "DELETE FROM telepy_gateway_event WHERE id = 13").await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.broken_at), (false, Some(14)), "{r:?}");
    }

    #[tokio::test]
    async fn pruning_everything_then_appending_stays_valid() {
        let (_d, db) = db().await;
        for i in 0..5 {
            gw(&db, &format!("m{i}")).await;
        }
        prune_through(&db, Table::Gateway, 100).await.unwrap();
        // 換一個 Db（模擬重開機：鏈頭要從 prune 錨點讀回來）。/ Fresh state as after a restart.
        let db2 = Db { read: db.read.clone(), write: db.write.clone(), audit: Default::default() };
        db2.audit.set_anchors_file(db.audit.anchors_file().unwrap());
        gw(&db2, "next").await;
        let r = report(&db2, Table::Gateway).await;
        assert!(r.ok, "{r:?}");
        assert_eq!(r.first_id, Some(6));
    }

    #[tokio::test]
    async fn pruning_by_retention_keeps_the_chain_valid() {
        let (_d, db) = db().await;
        let old = crate::util::db_time(chrono::Utc::now() - chrono::Duration::days(super::super::retention::IP_RETENTION_DAYS + 1));
        for i in 0..5 {
            gw_at(&db, &old, &format!("old{i}")).await;
        }
        for i in 0..5 {
            gw(&db, &format!("new{i}")).await;
        }
        assert_eq!(super::super::retention::purge(&db).await.unwrap(), 5);
        let r = report(&db, Table::Gateway).await;
        assert!(r.ok, "{r:?}");
        assert_eq!((r.first_id, r.checked, r.checkpoints_checked), (Some(6), 5, 1));
    }

    #[tokio::test]
    async fn legacy_rows_count_as_unhashed() {
        let (_d, db) = db().await;
        for _ in 0..3 {
            exec(&db, "INSERT INTO telepy_gateway_event (at, event, message) VALUES ('2026-01-01 00:00:00.000000', 'accepted', 'legacy')").await;
        }
        for i in 0..4 {
            gw(&db, &format!("m{i}")).await;
        }
        let r = report(&db, Table::Gateway).await;
        assert!(r.ok, "{r:?}");
        assert_eq!((r.unhashed_before, r.checked, r.first_id), (3, 4, Some(4)));
        // 鏈開始之後的 NULL hash 是斷鏈。/ A NULL hash after the chain started is a break.
        exec(&db, "UPDATE telepy_gateway_event SET hash = NULL WHERE id = 6").await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.broken_at, r.reason.as_deref()), (Some(6), Some("missing_hash")), "{r:?}");
    }

    #[tokio::test]
    async fn concurrent_appends_form_one_chain() {
        let (_d, db) = db().await;
        let mut tasks = Vec::new();
        for i in 0..64 {
            let db = db.clone();
            tasks.push(tokio::spawn(async move {
                if i % 2 == 0 {
                    gw(&db, &format!("t{i}")).await;
                } else {
                    append(&db, Table::AiAudit, &[("at", Field::text(now_db())), ("user_id", Field::Int(Some(1))), ("client_name", Field::text("app")), ("tool", Field::text("list_tunnels")), ("ok", Field::Bool(true))]).await.unwrap();
                }
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        let rep = verify(&db).await.unwrap();
        assert!(rep.ok, "{rep:?}");
        assert_eq!(rep.tables[0].checked, 32);
        assert_eq!(rep.tables[2].checked, 32);
    }

    /// 100k 列要在幾秒內驗完（直接批次寫入，省掉 100k 個 transaction）。/ 100k rows verify in seconds.
    #[tokio::test]
    async fn verifies_100k_rows_quickly() {
        let (_d, db) = db().await;
        let mut tx = db.write.begin().await.unwrap();
        let mut prev: Option<String> = None;
        let at = now_db();
        for id in 1..=100_000i64 {
            let msg = format!("Accepted publickey for telepy from 203.0.113.7 port {id} ssh2: ED25519 SHA256:abcdefghijklmnopqrstuvwxyz");
            let h = row_hash(prev.as_deref(), id, &[Some(&at), Some("accepted"), Some("203.0.113.7:5000"), Some("40001"), Some("3"), Some(&msg)]);
            sqlx::query("INSERT INTO telepy_gateway_event (id, at, event, peer, port, tunnel_id, message, prev_hash, hash) VALUES (?, ?, 'accepted', '203.0.113.7:5000', 40001, 3, ?, ?, ?)")
                .bind(id)
                .bind(&at)
                .bind(&msg)
                .bind(&prev)
                .bind(&h)
                .execute(&mut *tx)
                .await
                .unwrap();
            prev = Some(h);
        }
        tx.commit().await.unwrap();
        let t0 = std::time::Instant::now();
        let r = report(&db, Table::Gateway).await;
        let took = t0.elapsed();
        assert!(r.ok, "{r:?}");
        assert_eq!(r.checked, 100_000);
        assert!(took < Duration::from_secs(10), "verify took {took:?}");
        eprintln!("verified 100k rows in {took:?}");
    }
}
