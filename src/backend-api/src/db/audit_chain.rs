//! 稽核紀錄的雜湊鏈：`telepy_gateway_event` / `telepy_sign_in_event` / `telepy_ai_audit_event` 每一列存
//! `prev_hash`（上一列的 hash）與 `hash = SHA-256(prev_hash, id, 欄位…)`，改一列、刪中間一列、調換順序都會斷鏈。
//! 修剪（列數上限、90 天保留）前先寫一筆 `prune` 錨點（被刪的最新一列的 id + hash），驗證從最新的 prune 錨點接著走。
//! 鏈頭每 10 分鐘（以及每次修剪後）附加到 DB 外的 `<log_root>/audit-anchors.log`（JSON lines）並記一筆 `checkpoint`
//! 錨點：就算有人改完內容再把整條鏈重算一遍，檔案裡的舊鏈頭也對不上。升級前的列 hash 為 NULL，鏈從第一筆有 hash 的列開始。
//! 重新封存（[`reseal`]，管理員知道原因之後）：把現在的列重算成一條完好的鏈，錨點檔附加一行 `reseal`（誰、為什麼），
//! 它之前的行不再比對；資料庫另記一筆 `telepy_audit_reseal`。兩邊都有的 reseal 行才算數。
//!
//! Hash chain over the three audit tables. Every row stores `prev_hash` and `hash = SHA-256(prev_hash, id,
//! fields…)`, so editing, deleting or reordering rows breaks the chain. Pruning first writes a `prune` anchor
//! (id + hash of the newest deleted row); verification resumes from the newest one. The chain head is appended
//! every 10 minutes (and after each prune) to `<log_root>/audit-anchors.log` outside the database, so rewriting
//! the whole chain after an edit is still caught. Rows written before the upgrade keep NULL hashes.
//! Re-sealing ([`reseal`], once an admin knows the cause) re-hashes the rows as they are into an intact chain and
//! appends a `reseal` line (who, why) to the anchors file; earlier lines are no longer compared. The database keeps
//! a `telepy_audit_reseal` row too, and only a reseal line that both sides know counts.

use std::collections::{BTreeMap, HashSet};
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
    /// 這個資料庫的鏈 id（第一次用時讀或建）。/ This database's chain id, read or created on first use.
    chain_id: RwLock<Option<String>>,
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

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
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

/// 外部錨點檔的一行。`db` = 寫這行的資料庫的鏈 id；沒有的是這個欄位出現前寫的（照樣比對）。
/// `reseal` = 這行是一次重新封存（id 對得上 `telepy_audit_reseal`）：它之前同一張表的行作廢；`by` / `note` 給讀檔的人看。
/// One line of the anchors file. `db` = the chain id of the database that wrote it; lines without one predate
/// the field and are still compared. `reseal` = this line re-seals the table (the id matches a
/// `telepy_audit_reseal` row): the table's earlier lines are set aside; `by` / `note` are for whoever reads the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointLine {
    pub at: String,
    pub table: String,
    pub row_id: i64,
    pub row_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reseal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 附加一行到錨點檔（資料夾不在就建）。/ Append one line to the anchors file, creating its folder.
async fn write_line(path: &std::path::Path, line: &CheckpointLine) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut f = tokio::fs::OpenOptions::new().create(true).append(true).open(path).await?;
    f.write_all(format!("{}\n", serde_json::to_string(line)?).as_bytes()).await?;
    f.flush().await?;
    Ok(())
}

/// 讀這個資料庫的鏈 id（唯讀；還沒有 = None）。/ This database's chain id, read only (None = not created yet).
pub async fn chain_id(db: &Db) -> sqlx::Result<Option<String>> {
    if let Some(id) = db.audit.chain_id.read().ok().and_then(|g| g.clone()) {
        return Ok(Some(id));
    }
    let id: Option<Option<String>> =
        sqlx::query_scalar("SELECT row_hash FROM telepy_audit_anchor WHERE kind = 'chain' ORDER BY id LIMIT 1").fetch_optional(&db.read).await?;
    let id = id.flatten();
    if let (Some(v), Ok(mut g)) = (&id, db.audit.chain_id.write()) {
        *g = Some(v.clone());
    }
    Ok(id)
}

/// 鏈 id：沒有就產生一個隨機的存起來（`telepy_audit_anchor` 的 `chain` 列；兩邊同時建時取最早那列，所以冪等）。
/// 換掉或還原資料庫後，錨點檔裡舊資料庫寫的行就認得出來、不再拿來比。
/// The chain id, created once (a `chain` row in `telepy_audit_anchor`; concurrent creators both read the
/// earliest row back, so it is idempotent). Lets verification tell lines written by a previous database apart.
pub async fn ensure_chain_id(db: &Db) -> sqlx::Result<String> {
    if let Some(id) = chain_id(db).await? {
        return Ok(id);
    }
    let new: String = {
        use rand::RngCore;
        let mut b = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    };
    sqlx::query("INSERT INTO telepy_audit_anchor (at, table_name, kind, row_id, row_hash) VALUES (?, '', 'chain', 0, ?)")
        .bind(now_db())
        .bind(&new)
        .execute(&db.write)
        .await?;
    let id: Option<String> =
        sqlx::query_scalar("SELECT row_hash FROM telepy_audit_anchor WHERE kind = 'chain' ORDER BY id LIMIT 1").fetch_one(&db.write).await?;
    let id = id.unwrap_or(new);
    if let Ok(mut g) = db.audit.chain_id.write() {
        *g = Some(id.clone());
    }
    Ok(id)
}

/// 把這張表目前的鏈頭附加到外部錨點檔並記一筆 checkpoint 錨點。表是空的或鏈頭沒有 hash（舊列）就略過。
/// Append the table's current head to the anchors file and record a checkpoint anchor. Skipped when the
/// table is empty or its head predates the chain.
pub async fn checkpoint(db: &Db, table: Table) -> anyhow::Result<Option<CheckpointLine>> {
    // 先拿鏈 id（寫入池只有一條連線，不能在下面拿著連線時再要一條）。
    // Chain id first: the write pool has one connection, held below.
    let chain = ensure_chain_id(db).await?;
    let _guard = db.audit.heads[table.idx()].lock().await;
    let mut conn = db.write.acquire().await?;
    let head: Option<(i64, Option<String>)> = sqlx::query_as(&format!("SELECT id, hash FROM {} ORDER BY id DESC LIMIT 1", table.name())).fetch_optional(&mut *conn).await?;
    let Some((row_id, Some(row_hash))) = head else { return Ok(None) };
    let line = CheckpointLine { at: now_rfc3339(), table: table.name().to_string(), row_id, row_hash, db: Some(chain), reseal: None, by: None, note: None };
    if let Some(path) = db.audit.anchors_file() {
        write_line(&path, &line).await?;
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
    /// 鏈本身最早的問題（列 id + hash_mismatch / link_mismatch / missing_hash）。/ The chain's own first issue.
    pub chain_broken_at: Option<i64>,
    pub chain_reason: Option<String>,
    /// 鏈本身有問題的列數。/ How many rows break the chain.
    pub chain_issues: u64,
    /// 與外部錨點最早的不符（checkpoint_mismatch / checkpoint_missing）。/ The first mismatch with the anchors file.
    pub checkpoint_broken_at: Option<i64>,
    pub checkpoint_reason: Option<String>,
    /// 錨點檔裡別的資料庫寫的行（沒比對）。/ Anchors-file lines written by another database (not compared).
    pub checkpoints_foreign: u64,
    /// 被重新封存作廢的行（沒比對）。/ Lines set aside by a re-seal (not compared).
    pub checkpoints_retired: u64,
    /// 這張表最近一次重新封存。/ The table's latest re-seal.
    pub last_reseal: Option<ResealRecord>,
}

impl TableReport {
    /// 決定「是不是同一個問題」的欄位（不含會隨時間長大的計數，如 checked）。
    /// The parts that say whether it is the same problem (not counts that grow on their own, like `checked`).
    pub fn issue_key(&self) -> String {
        let o = |v: Option<i64>| v.map(|v| v.to_string()).unwrap_or_default();
        format!(
            "{}|{}|{}|{}|{}|{}|{}",
            self.table,
            o(self.chain_broken_at),
            self.chain_reason.as_deref().unwrap_or(""),
            self.chain_issues,
            o(self.checkpoint_broken_at),
            self.checkpoint_reason.as_deref().unwrap_or(""),
            self.checkpoints_mismatched
        )
    }
}

/// 驗證結果的指紋：每張有問題的表的問題組成；之後同一張表再有列被改、更多 checkpoint 對不上或尾端被刪都會變。
/// 16 個 hex 字元。/ Fingerprint of a verification result over every failing table's issues: a later edit in
/// the same table, more mismatching checkpoints or a truncated tail all change it. 16 hex characters.
pub fn fingerprint(report: &Report) -> String {
    let parts: Vec<String> = report.tables.iter().filter(|t| !t.ok).map(TableReport::issue_key).collect();
    let mut h = Sha256::new();
    h.update(b"telepy-audit-issues-v1");
    for p in &parts {
        put(&mut h, Some(p));
    }
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub ok: bool,
    pub tables: Vec<TableReport>,
}

/// 驗證三張表（外部錨點檔讀自 `db.audit`）。/ Verify all three tables against the chain and the anchors file.
pub async fn verify(db: &Db) -> anyhow::Result<Report> {
    let lines = read_checkpoints(db).await?;
    let ours = chain_id(db).await?;
    // 表不在（還沒升級的舊資料庫，doctor 直接開的）= 沒有重新封存過。/ No table yet (an older database) = never re-sealed.
    let reseals = list_reseals(db).await.unwrap_or_default();
    let mut tables = Vec::new();
    for t in TABLES {
        let (cps, foreign) = lines_of(&lines, t, ours.as_deref());
        let (retired, active) = split_retired(&cps, &confirmed(&reseals, t));
        let mut r = verify_table(db, t, active).await?;
        r.checkpoints_foreign = foreign;
        r.checkpoints_retired = retired;
        r.last_reseal = reseals.iter().rev().find(|x| x.table == t.name()).cloned();
        tables.push(r);
    }
    Ok(Report { ok: tables.iter().all(|t| t.ok), tables })
}

/// 一張表在錨點檔裡屬於這個資料庫的行（檔案順序；沒有 `db` 的舊行算），以及別的資料庫寫的行數。
/// The table's lines that belong to this database (file order; legacy lines without `db` count), and how many
/// another database wrote.
fn lines_of<'a>(lines: &'a [CheckpointLine], table: Table, ours: Option<&str>) -> (Vec<&'a CheckpointLine>, u64) {
    let (mine, foreign): (Vec<&CheckpointLine>, Vec<&CheckpointLine>) =
        lines.iter().filter(|l| l.table == table.name()).partition(|l| l.db.is_none() || l.db.as_deref() == ours);
    (mine, foreign.len() as u64)
}

/// 資料庫裡有紀錄的重新封存 id（這張表的）。/ The table's re-seal ids the database knows.
fn confirmed(reseals: &[ResealRecord], table: Table) -> HashSet<&str> {
    reseals.iter().filter(|r| r.table == table.name()).map(|r| r.reseal_id.as_str()).collect()
}

/// 純函式：最後一個資料庫也有紀錄的 reseal 行之前的行作廢；回傳（作廢幾行, 還要比對的行，從那個 reseal 行起）。
/// 只在檔案裡、資料庫沒有的 reseal 行不算（寫檔之後資料庫那步失敗的，或別人自己加的）。
/// Pure: lines before the last reseal line the database also knows are set aside; returns (how many, the lines
/// still compared, starting with that reseal line). A reseal line only the file knows does not count (the database
/// step failed after the file was written, or someone added it by hand).
pub fn split_retired<'l, 'a>(lines: &'l [&'a CheckpointLine], confirmed: &HashSet<&str>) -> (u64, &'l [&'a CheckpointLine]) {
    match lines.iter().rposition(|l| l.reseal.as_deref().is_some_and(|id| confirmed.contains(id))) {
        Some(i) => (i as u64, &lines[i..]),
        None => (0, lines),
    }
}

/// 一次重新封存的一張表（`telepy_audit_reseal` 的一列；同一次的幾張表共用 `reseal_id`）。
/// One table of one re-seal (a `telepy_audit_reseal` row; the tables of one re-seal share `reseal_id`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, sqlx::FromRow)]
pub struct ResealRecord {
    pub reseal_id: String,
    /// RFC 3339 `…Z`
    pub at: String,
    #[sqlx(rename = "table_name")]
    pub table: String,
    /// 封存後的鏈頭（0 = 表裡沒有有 hash 的列）。/ The head afterwards (0 = no hashed rows).
    pub row_id: i64,
    /// 重算了幾列、從哪一列起。/ Rows re-hashed, and the first one.
    pub rehashed: i64,
    pub from_row: Option<i64>,
    /// 作廢的錨點檔行數。/ Anchors-file lines set aside.
    pub retired: i64,
    /// 封存前的問題（`doctor` 的說法）。/ The problem it covered, as the doctor put it.
    pub problem: String,
    pub user_id: Option<i64>,
    pub username: String,
    pub note: String,
}

/// 全部重新封存紀錄，舊的在前。/ Every re-seal record, oldest first.
pub async fn list_reseals(db: &Db) -> sqlx::Result<Vec<ResealRecord>> {
    sqlx::query_as(
        "SELECT reseal_id, at, table_name, row_id, rehashed, from_row, retired, problem, user_id, username, note FROM telepy_audit_reseal ORDER BY id",
    )
    .fetch_all(&db.read)
    .await
}

/// 重新封存要做的事（一張表）。/ What re-sealing one table would do.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ResealPlan {
    pub table: String,
    /// 要重算的列數、第一列。/ Rows to re-hash and the first one.
    pub rehash: u64,
    pub from_row: Option<i64>,
    /// 會作廢的錨點檔行數。/ Anchors-file lines that would be set aside.
    pub retire: u64,
}

/// 重算的走法：從最新的 prune 錨點起依 id 算每列該有的 prev_hash / hash（鏈開始前沒有 hash 的舊列不動，與驗證一樣）；
/// `write` 時把不同的列改掉。回傳不同的列數、第一列、之後的鏈頭（最後一列有 hash 的）。
/// The re-hash walk: from the newest prune anchor, compute each row's prev_hash / hash in id order (rows from before
/// the chain keep NULL, as in verification); with `write`, store the ones that differ. Returns how many differ, the
/// first one and the head afterwards (the last hashed row).
struct Rehash {
    rows: u64,
    from_row: Option<i64>,
    head: Option<(i64, String)>,
}

async fn rehash(conn: &mut SqliteConnection, table: Table, write: bool) -> sqlx::Result<Rehash> {
    let anchor: Option<(i64, Option<String>)> =
        sqlx::query_as("SELECT row_id, row_hash FROM telepy_audit_anchor WHERE table_name = ? AND kind = 'prune' ORDER BY id DESC LIMIT 1")
            .bind(table.name())
            .fetch_optional(&mut *conn)
            .await?;
    let mut cursor = anchor.as_ref().map(|a| a.0).unwrap_or(0);
    let mut expected_prev: Option<String> = anchor.and_then(|a| a.1);
    let mut out = Rehash { rows: 0, from_row: None, head: None };
    let mut started = false;
    let n_fields = table.fields().len();
    let sql = format!("SELECT id, prev_hash, hash, {} FROM {} WHERE id > ? ORDER BY id LIMIT ?", table.select_fields(), table.name());
    let update = format!("UPDATE {} SET prev_hash = ?, hash = ? WHERE id = ?", table.name());
    loop {
        let rows = sqlx::query(&sql).bind(cursor).bind(VERIFY_BATCH).fetch_all(&mut *conn).await?;
        if rows.is_empty() {
            break;
        }
        let mut changes: Vec<(Option<String>, String, i64)> = Vec::new();
        for row in &rows {
            let id: i64 = row.try_get(0)?;
            let prev: Option<String> = row.try_get(1)?;
            let hash: Option<String> = row.try_get(2)?;
            cursor = id;
            if hash.is_none() && !started {
                expected_prev = None;
                continue;
            }
            started = true;
            let mut texts: Vec<Option<String>> = Vec::with_capacity(n_fields);
            for i in 0..n_fields {
                texts.push(row.try_get(3 + i)?);
            }
            let refs: Vec<Option<&str>> = texts.iter().map(|s| s.as_deref()).collect();
            let new = row_hash(expected_prev.as_deref(), id, &refs);
            if prev != expected_prev || hash.as_deref() != Some(new.as_str()) {
                out.rows += 1;
                out.from_row.get_or_insert(id);
                if write {
                    changes.push((expected_prev.clone(), new.clone(), id));
                }
            }
            expected_prev = Some(new.clone());
            out.head = Some((id, new));
        }
        for (prev, hash, id) in changes {
            sqlx::query(&update).bind(prev).bind(hash).bind(id).execute(&mut *conn).await?;
        }
    }
    Ok(out)
}

/// 試算重新封存（不寫入）：每張表要重算幾列、會作廢幾行錨點檔。/ Dry run: rows to re-hash and lines to set aside per table.
pub async fn reseal_plan(db: &Db, tables: &[Table]) -> anyhow::Result<Vec<ResealPlan>> {
    let lines = read_checkpoints(db).await?;
    let ours = chain_id(db).await?;
    let reseals = list_reseals(db).await?;
    let mut out = Vec::new();
    for &t in tables {
        let (cps, _) = lines_of(&lines, t, ours.as_deref());
        let (_, active) = split_retired(&cps, &confirmed(&reseals, t));
        let mut tx = db.read.begin().await?;
        let walk = rehash(&mut tx, t, false).await?;
        tx.commit().await?;
        out.push(ResealPlan { table: t.name().to_string(), rehash: walk.rows, from_row: walk.from_row, retire: active.len() as u64 });
    }
    Ok(out)
}

/// 誰、為什麼重新封存。/ Who re-seals, and why.
pub struct ResealBy<'a> {
    pub user_id: Option<i64>,
    pub username: &'a str,
    pub note: &'a str,
}

/// 重新封存幾張表（呼叫端給每張表封存前的問題）：把現在的列重算成完好的鏈、錨點檔附加一行 `reseal`（之前的行作廢）、
/// 記一筆 `telepy_audit_reseal`。每張表在自己的鎖與 transaction 裡做：先重算，再寫錨點檔，最後 commit——寫檔失敗就整張表
/// 不動；commit 失敗留下的那行資料庫不認得，不算數。改的是證據的基準，不是證據本身：原來的列內容不會回來。
/// Re-seal tables (the caller passes each table's problem): re-hash the rows as they are into an intact chain,
/// append a `reseal` line to the anchors file (earlier lines are set aside) and record a `telepy_audit_reseal` row.
/// Each table under its own lock and transaction: re-hash, write the file line, then commit — a failed file write
/// leaves the table untouched, and a line left by a failed commit is unknown to the database, so it does not count.
/// It changes the baseline, not the evidence: edited rows do not come back.
pub async fn reseal(db: &Db, targets: &[(Table, String)], by: &ResealBy<'_>) -> anyhow::Result<Vec<ResealRecord>> {
    // 鏈 id、錨點檔、舊紀錄先讀（寫入池只有一條連線）。/ Chain id, file and records first (the write pool has one connection).
    let chain = ensure_chain_id(db).await?;
    let lines = read_checkpoints(db).await?;
    let reseals = list_reseals(db).await?;
    let reseal_id: String = {
        use rand::RngCore;
        let mut b = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    };
    let mut out = Vec::new();
    for (table, problem) in targets {
        let table = *table;
        let (cps, _) = lines_of(&lines, table, Some(&chain));
        let (_, active) = split_retired(&cps, &confirmed(&reseals, table));
        let retired = active.len() as i64;
        let mut guard = db.audit.heads[table.idx()].lock().await;
        let mut tx = db.write.begin().await?;
        let walk = rehash(&mut tx, table, true).await?;
        let (row_id, row_hash) = walk.head.clone().unwrap_or((0, String::new()));
        let at = now_rfc3339();
        let line = CheckpointLine {
            at: at.clone(),
            table: table.name().to_string(),
            row_id,
            row_hash: row_hash.clone(),
            db: Some(chain.clone()),
            reseal: Some(reseal_id.clone()),
            by: Some(by.username.to_string()),
            note: Some(by.note.to_string()),
        };
        if let Some(path) = db.audit.anchors_file() {
            write_line(&path, &line).await?;
        }
        let record = ResealRecord {
            reseal_id: reseal_id.clone(),
            at,
            table: table.name().to_string(),
            row_id,
            rehashed: walk.rows as i64,
            from_row: walk.from_row,
            retired,
            problem: problem.clone(),
            user_id: by.user_id,
            username: by.username.to_string(),
            note: by.note.to_string(),
        };
        sqlx::query(
            "INSERT INTO telepy_audit_reseal (reseal_id, at, table_name, row_id, row_hash, rehashed, from_row, retired, problem, user_id, username, note) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.reseal_id)
        .bind(&record.at)
        .bind(&record.table)
        .bind(record.row_id)
        .bind((!row_hash.is_empty()).then_some(&row_hash))
        .bind(record.rehashed)
        .bind(record.from_row)
        .bind(record.retired)
        .bind(&record.problem)
        .bind(record.user_id)
        .bind(&record.username)
        .bind(&record.note)
        .execute(&mut *tx)
        .await?;
        let head = load_head(&mut tx, table).await?;
        tx.commit().await?;
        *guard = Some(head);
        out.push(record);
    }
    Ok(out)
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
        chain_broken_at: None,
        chain_reason: None,
        chain_issues: 0,
        checkpoint_broken_at: None,
        checkpoint_reason: None,
        checkpoints_foreign: 0,
        checkpoints_retired: 0,
        last_reseal: None,
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
                    r.chain_issues += 1;
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
            let link_bad = prev != expected_prev;
            if link_bad {
                chain_issue.get_or_insert((id, "link_mismatch"));
            }
            let mut texts: Vec<Option<String>> = Vec::with_capacity(n_fields);
            for i in 0..n_fields {
                texts.push(row.try_get(3 + i)?);
            }
            let refs: Vec<Option<&str>> = texts.iter().map(|s| s.as_deref()).collect();
            let hash_bad = row_hash(prev.as_deref(), id, &refs) != hash;
            if hash_bad {
                chain_issue.get_or_insert((id, "hash_mismatch"));
            }
            if link_bad || hash_bad {
                r.chain_issues += 1;
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
    r.chain_broken_at = chain_issue.map(|c| c.0);
    r.chain_reason = chain_issue.map(|c| c.1.to_string());
    r.checkpoint_broken_at = cp_issue.map(|c| c.0);
    r.checkpoint_reason = cp_issue.map(|c| c.1.to_string());
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

    async fn append_line(db: &Db, line: &CheckpointLine) {
        let path = db.audit.anchors_file().unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap()).await.unwrap();
        let mut f = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await.unwrap();
        f.write_all(format!("{}\n", serde_json::to_string(line).unwrap()).as_bytes()).await.unwrap();
    }

    fn line(row_id: i64, row_hash: &str, db: Option<&str>) -> CheckpointLine {
        CheckpointLine {
            at: "2026-10-30T00:00:00Z".into(),
            table: Table::Gateway.name().into(),
            row_id,
            row_hash: row_hash.into(),
            db: db.map(str::to_string),
            reseal: None,
            by: None,
            note: None,
        }
    }

    fn by() -> ResealBy<'static> {
        ResealBy { user_id: Some(1), username: "admin", note: "restored from the 28 Oct backup" }
    }

    async fn problem_of(db: &Db) -> Vec<(Table, String)> {
        verify(db).await.unwrap().tables.iter().filter(|t| !t.ok).map(|t| (Table::from_name(&t.table).unwrap(), format!("{:?}", t.reason))).collect()
    }

    /// 改過一列：重新封存後鏈完好、計數對；之後再改任何一列（舊的或新的）照樣抓得到。
    /// An edited row: after a re-seal the chain is intact with the right counts, and any later edit is caught again.
    #[tokio::test]
    async fn reseal_rebuilds_the_chain_and_later_edits_still_show() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        checkpoint(&db, Table::Gateway).await.unwrap();
        exec(&db, "UPDATE telepy_gateway_event SET message = 'edited' WHERE id = 4").await;
        assert!(!verify(&db).await.unwrap().ok);
        let plan = reseal_plan(&db, &[Table::Gateway]).await.unwrap();
        // 第 4 列起每一列都要重算（鏈是串起來的）；那一行 checkpoint 作廢。/ Row 4 onwards (the chain links them); the one line goes.
        assert_eq!(plan, vec![ResealPlan { table: Table::Gateway.name().into(), rehash: 7, from_row: Some(4), retire: 1 }]);
        let targets = problem_of(&db).await;
        let done = reseal(&db, &targets, &by()).await.unwrap();
        assert_eq!((done.len(), done[0].rehashed, done[0].from_row, done[0].retired, done[0].row_id), (1, 7, Some(4), 1, 10));
        assert_eq!(done[0].username, "admin");
        let r = report(&db, Table::Gateway).await;
        assert!(r.ok, "{r:?}");
        // reseal 行本身也是新的 checkpoint；之前那行不再比。/ The reseal line is the new checkpoint; the older one is set aside.
        assert_eq!((r.checkpoints_checked, r.checkpoints_mismatched, r.checkpoints_retired), (1, 0, 1), "{r:?}");
        assert_eq!(r.last_reseal.as_ref().map(|x| x.note.as_str()), Some("restored from the 28 Oct backup"));
        // 錨點檔多了一行 reseal（誰、為什麼）。/ The anchors file gained a reseal line saying who and why.
        let lines = read_checkpoints(&db).await.unwrap();
        let last = lines.last().unwrap();
        assert_eq!((last.reseal.as_deref(), last.by.as_deref(), last.row_id), (Some(done[0].reseal_id.as_str()), Some("admin"), 10));
        // 記憶體裡的鏈頭跟著換：接著寫的列接得上。/ The cached head follows: new rows link on.
        gw(&db, "after").await;
        checkpoint(&db, Table::Gateway).await.unwrap();
        assert!(report(&db, Table::Gateway).await.ok);
        // 封存前的列再被改：抓得到。/ Editing a row from before the re-seal is caught.
        exec(&db, "UPDATE telepy_gateway_event SET message = 'again' WHERE id = 2").await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.chain_broken_at), (false, Some(2)), "{r:?}");
        // 沒問題的表不重算。/ Nothing to do on an intact table.
        let plan = reseal_plan(&db, &[Table::SignIn]).await.unwrap();
        assert_eq!((plan[0].rehash, plan[0].from_row), (0, None));
    }

    /// 換掉 / 還原過的資料庫：舊的錨點行（沒有 `db`）對不上，鏈本身沒事——重新封存不必重算任何一列，只把舊行作廢。
    /// A replaced database: legacy anchors lines don't match, the chain itself is fine — re-sealing re-hashes nothing
    /// and only sets the old lines aside.
    #[tokio::test]
    async fn reseal_of_a_replaced_database_only_sets_old_lines_aside() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        append_line(&db, &line(6, &"0".repeat(64), None)).await;
        append_line(&db, &line(40, &"1".repeat(64), None)).await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.checkpoint_reason.as_deref(), r.chain_issues), (false, Some("checkpoint_mismatch"), 0), "{r:?}");
        let done = reseal(&db, &problem_of(&db).await, &by()).await.unwrap();
        assert_eq!((done[0].rehashed, done[0].from_row, done[0].retired), (0, None, 2));
        let r = report(&db, Table::Gateway).await;
        assert!(r.ok, "{r:?}");
        assert_eq!(r.checkpoints_retired, 2);
        // 鏈 hash 一列都沒動。/ Not a single row hash changed.
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_gateway_event WHERE prev_hash IS NULL").fetch_one(&db.read).await.unwrap();
        assert_eq!(n, 1);
    }

    /// 只在檔案裡、資料庫沒有的 reseal 行不算數（別人自己加的、或資料庫那步失敗）。
    /// A reseal line the database doesn't know is ignored (added by hand, or the database step failed).
    #[tokio::test]
    async fn a_reseal_line_without_a_database_record_counts_for_nothing() {
        let (_d, db) = db().await;
        for i in 0..5 {
            gw(&db, &format!("m{i}")).await;
        }
        append_line(&db, &line(3, &"0".repeat(64), None)).await;
        let mut forged = line(5, "x", None);
        forged.reseal = Some("feedfeedfeedfeed".into());
        append_line(&db, &forged).await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.checkpoints_retired, r.checkpoint_broken_at), (false, 0, Some(3)), "{r:?}");
    }

    #[test]
    fn split_retired_keeps_lines_from_the_last_known_reseal() {
        let a = line(1, "a", None);
        let mut r1 = line(2, "b", Some("db"));
        r1.reseal = Some("r1".into());
        let c = line(3, "c", Some("db"));
        let mut r2 = line(4, "d", Some("db"));
        r2.reseal = Some("r2".into());
        let e = line(5, "e", Some("db"));
        let all = [&a, &r1, &c, &r2, &e];
        let none = HashSet::new();
        assert_eq!(split_retired(&all, &none).0, 0);
        let (n, rest) = split_retired(&all, &HashSet::from(["r1"]));
        assert_eq!((n, rest.len(), rest[0].row_id), (1, 4, 2));
        let (n, rest) = split_retired(&all, &HashSet::from(["r1", "r2"]));
        assert_eq!((n, rest.len(), rest[0].row_id), (3, 2, 4));
        // 只認得 r2：一樣從 r2 起。/ Only r2 known: still from r2.
        assert_eq!(split_retired(&all, &HashSet::from(["r2"])).0, 3);
    }

    /// 另一個資料庫寫的行略過、計數；沒有 `db` 的舊行照樣比對。/ Another database's lines are skipped and counted; legacy ones are compared.
    #[tokio::test]
    async fn foreign_checkpoints_are_skipped_and_legacy_ones_compared() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        let cp = checkpoint(&db, Table::Gateway).await.unwrap().unwrap();
        assert_eq!(cp.db.as_deref(), Some(ensure_chain_id(&db).await.unwrap().as_str()));
        append_line(&db, &line(5, &"0".repeat(64), Some("someotherdatabase"))).await;
        let r = report(&db, Table::Gateway).await;
        assert!(r.ok, "{r:?}");
        assert_eq!((r.checkpoints_checked, r.checkpoints_foreign), (1, 1));
        append_line(&db, &line(6, &"0".repeat(64), None)).await;
        let r = report(&db, Table::Gateway).await;
        assert_eq!((r.ok, r.broken_at, r.reason.as_deref(), r.checkpoints_foreign), (false, Some(6), Some("checkpoint_mismatch"), 1), "{r:?}");
        assert_eq!((r.checkpoint_broken_at, r.chain_broken_at, r.chain_issues), (Some(6), None, 0));
        // 鏈 id 只建一次。/ The chain id is created once.
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_audit_anchor WHERE kind = 'chain'").fetch_one(&db.read).await.unwrap();
        assert_eq!(n, 1);
    }

    /// 已知的 checkpoint 不符（舊資料庫的行）被確認後，同一張表後面再有列被改，指紋要變。
    /// After a known checkpoint mismatch, editing a later row of the same table changes the fingerprint.
    #[tokio::test]
    async fn fingerprint_changes_when_a_later_row_is_edited() {
        let (_d, db) = db().await;
        for i in 0..10 {
            gw(&db, &format!("m{i}")).await;
        }
        append_line(&db, &line(3, &"0".repeat(64), None)).await;
        let rep1 = verify(&db).await.unwrap();
        assert!(!rep1.ok);
        let fp1 = fingerprint(&rep1);
        assert_eq!(fp1.len(), 16);
        // 沒變就一樣（新的列、新的 checkpoint 都不算）。/ Stable while nothing changes (new rows and matching checkpoints don't count).
        gw(&db, "later").await;
        checkpoint(&db, Table::Gateway).await.unwrap();
        assert_eq!(fingerprint(&verify(&db).await.unwrap()), fp1);
        exec(&db, "UPDATE telepy_gateway_event SET message = 'forged' WHERE id = 8").await;
        let rep2 = verify(&db).await.unwrap();
        let g = &rep2.tables[0];
        assert_eq!((g.broken_at, g.chain_broken_at, g.chain_reason.as_deref()), (Some(3), Some(8), Some("hash_mismatch")), "{g:?}");
        assert_ne!(fingerprint(&rep2), fp1);
        // 尾端被刪也會變。/ So does a truncated tail.
        let fp2 = fingerprint(&rep2);
        exec(&db, "DELETE FROM telepy_gateway_event WHERE id >= 11").await;
        assert_ne!(fingerprint(&verify(&db).await.unwrap()), fp2);
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

    /// 直接批次寫入 n 列完好的鏈（省掉 n 個 transaction）。/ Bulk-insert an intact chain of n rows.
    async fn bulk(db: &Db, n: i64) {
        let mut tx = db.write.begin().await.unwrap();
        let mut prev: Option<String> = None;
        let at = now_db();
        for id in 1..=n {
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
    }

    /// 100k 列要在幾秒內驗完。/ 100k rows verify in seconds.
    #[tokio::test]
    async fn verifies_100k_rows_quickly() {
        let (_d, db) = db().await;
        bulk(&db, 100_000).await;
        let t0 = std::time::Instant::now();
        let r = report(&db, Table::Gateway).await;
        let took = t0.elapsed();
        assert!(r.ok, "{r:?}");
        assert_eq!(r.checked, 100_000);
        assert!(took < Duration::from_secs(10), "verify took {took:?}");
        eprintln!("verified 100k rows in {took:?}");
    }

    /// 100k 列、第 2 列被改：重新封存要重算幾乎每一列，也要在合理時間內做完。
    /// 100k rows with row 2 edited: re-sealing rewrites almost every row and still finishes in reasonable time.
    #[tokio::test]
    async fn reseals_100k_rows_quickly() {
        let (_d, db) = db().await;
        bulk(&db, 100_000).await;
        exec(&db, "UPDATE telepy_gateway_event SET message = 'edited' WHERE id = 2").await;
        let t0 = std::time::Instant::now();
        let done = reseal(&db, &problem_of(&db).await, &by()).await.unwrap();
        let took = t0.elapsed();
        assert_eq!((done[0].rehashed, done[0].from_row), (99_999, Some(2)));
        // 單跑約 5 秒（debug）；上限放寬給滿載的機器（和其他測試一起跑），只抓得到失控的慢。
        // About 5 s alone on a debug build; the bound leaves room for a loaded machine and only catches a runaway.
        assert!(took < Duration::from_secs(60), "re-seal took {took:?}");
        eprintln!("re-sealed 100k rows in {took:?}");
        assert!(report(&db, Table::Gateway).await.ok);
    }
}
