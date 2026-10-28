//! 委派 token 的呼叫紀錄（`telepy_api_call`）：個人 API token / OAuth app 的 token 在 REST 上的每一個請求（讀取也算），
//! 以及個人 API token 的每一個 MCP tool call（OAuth app 的 MCP 已經在 AI 稽核裡，不重複記）。存路由樣板，不存 query string。
//! 不接雜湊鏈：寫入量大（每個讀取一列，批次寫）、而且使用者刪除時要刪掉他的列，鏈只能從頭剪。寫入動作另外有
//! `token_call` gateway 事件（在鏈上）。90 天 + 200k 列（`db::retention` / 寫入時修剪）。
//! The call log of delegated tokens: every REST request made with a personal API token or an OAuth app token (reads
//! included) and every MCP tool call made with a personal token (OAuth apps' MCP calls are in the AI audit already).
//! Route templates only, never query strings. Not hash-chained: it is high-volume (one row per read, batch-written)
//! and a deleted user's rows must go, while a chain can only be cut from its head; writes also get a chained
//! `token_call` gateway event. Kept 90 days and 200k rows.

use std::collections::HashMap;

use sqlx::{FromRow, QueryBuilder, Sqlite};

use super::Db;
use crate::util::db_time;

pub const RETENTION_ROWS: i64 = 200_000;
pub const MAX_ROUTE_CHARS: usize = 300;
pub const MAX_ERROR_CHARS: usize = 300;

const T: &str = "telepy_api_call";

/// 一筆要寫的呼叫。/ A call to write.
#[derive(Debug, Clone, Default)]
pub struct NewCall {
    pub at: String,
    pub user_id: i64,
    pub token_id: Option<i64>,
    pub grant_id: Option<i64>,
    pub client_name: String,
    /// `rest` | `mcp`
    pub kind: &'static str,
    pub method: String,
    pub route: String,
    pub tunnel_id: Option<i64>,
    pub status: i64,
    pub duration_ms: i64,
    pub ip: Option<String>,
    pub error: Option<String>,
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        s.chars().take(n).collect::<String>() + "…"
    } else {
        s.to_string()
    }
}

/// 一次寫一批（一個 transaction），順便把每把 token 的 `call_count` 加上去。回傳最大的 id。
/// Write a batch in one transaction and add to each token's `call_count`. Returns the largest id.
pub async fn insert_batch(db: &Db, calls: &[NewCall]) -> sqlx::Result<i64> {
    if calls.is_empty() {
        return Ok(0);
    }
    let mut tx = db.write.begin().await?;
    // SQLite 一個語句最多 32766 個參數；一批 ≤ 500 列 × 14 欄沒問題。/ Well under SQLite's parameter limit.
    for chunk in calls.chunks(500) {
        let mut q: QueryBuilder<Sqlite> =
            QueryBuilder::new(format!("INSERT INTO {T} (at, user_id, token_id, grant_id, client_name, kind, method, route, tunnel_id, status, duration_ms, ip, error) "));
        q.push_values(chunk, |mut b, c| {
            b.push_bind(&c.at)
                .push_bind(c.user_id)
                .push_bind(c.token_id)
                .push_bind(c.grant_id)
                .push_bind(clip(&c.client_name, 200))
                .push_bind(c.kind)
                .push_bind(clip(&c.method, 10))
                .push_bind(clip(&c.route, MAX_ROUTE_CHARS))
                .push_bind(c.tunnel_id)
                .push_bind(c.status)
                .push_bind(c.duration_ms)
                .push_bind(&c.ip)
                .push_bind(c.error.as_deref().map(|e| clip(e, MAX_ERROR_CHARS)));
        });
        q.build().execute(&mut *tx).await?;
    }
    let mut per_token: HashMap<i64, i64> = HashMap::new();
    for c in calls {
        if let Some(t) = c.token_id {
            *per_token.entry(t).or_default() += 1;
        }
    }
    for (id, n) in per_token {
        sqlx::query("UPDATE telepy_api_token SET call_count = call_count + ? WHERE id = ?").bind(n).bind(id).execute(&mut *tx).await?;
    }
    let max: i64 = sqlx::query_scalar(&format!("SELECT COALESCE(MAX(id), 0) FROM {T}")).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(max)
}

/// 列數上限：留最新的 `RETENTION_ROWS` 列。/ Keep the newest `RETENTION_ROWS` rows.
pub async fn trim(db: &Db, max_id: i64) -> sqlx::Result<u64> {
    if max_id <= RETENTION_ROWS {
        return Ok(0);
    }
    Ok(sqlx::query(&format!("DELETE FROM {T} WHERE id <= ?")).bind(max_id - RETENTION_ROWS).execute(&db.write).await?.rows_affected())
}

/// 90 天保留 + 使用者已刪除的列。/ 90-day retention, plus rows of deleted users.
pub async fn purge(db: &Db, before: &str) -> sqlx::Result<u64> {
    let mut n = sqlx::query(&format!("DELETE FROM {T} WHERE at < ?")).bind(before).execute(&db.write).await?.rows_affected();
    n += sqlx::query(&format!("DELETE FROM {T} WHERE user_id NOT IN (SELECT id FROM auth_user)")).execute(&db.write).await?.rows_affected();
    Ok(n)
}

/// 一列 + 使用者、token、隧道名稱。/ A row with the user, token and tunnel names.
#[derive(Debug, Clone, FromRow)]
pub struct Call {
    pub id: i64,
    pub at: String,
    pub user_id: i64,
    pub username: Option<String>,
    pub token_id: Option<i64>,
    pub token_name: Option<String>,
    pub token_prefix: Option<String>,
    pub grant_id: Option<i64>,
    pub client_name: String,
    pub kind: String,
    pub method: String,
    pub route: String,
    pub tunnel_id: Option<i64>,
    pub tunnel_name: Option<String>,
    pub status: i64,
    pub duration_ms: i64,
    pub ip: Option<String>,
    pub error: Option<String>,
}

/// 狀態篩選。/ Status filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusFilter {
    /// < 400
    Ok,
    /// 400–499
    Client,
    /// ≥ 500
    Server,
    /// ≥ 400
    Error,
}

impl StatusFilter {
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "ok" | "2xx" => Self::Ok,
            "4xx" => Self::Client,
            "5xx" => Self::Server,
            "error" => Self::Error,
            _ => return None,
        })
    }
    fn sql(self) -> &'static str {
        match self {
            Self::Ok => " AND c.status < 400",
            Self::Client => " AND c.status >= 400 AND c.status < 500",
            Self::Server => " AND c.status >= 500",
            Self::Error => " AND c.status >= 400",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub user_id: Option<i64>,
    pub token_id: Option<i64>,
    pub grant_id: Option<i64>,
    pub status: Option<StatusFilter>,
    pub method: Option<String>,
    /// 只要 id 比這個小的（往前翻頁）。/ Only rows older than this id (paging back).
    pub before: Option<i64>,
    pub limit: i64,
}

pub async fn list(db: &Db, f: &Filter) -> sqlx::Result<Vec<Call>> {
    let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(format!(
        "SELECT c.id, c.at, c.user_id, u.username, c.token_id, k.name AS token_name, k.prefix AS token_prefix, c.grant_id, c.client_name, c.kind, \
                c.method, c.route, c.tunnel_id, t.host_friendly_name AS tunnel_name, c.status, c.duration_ms, c.ip, c.error \
         FROM {T} c LEFT JOIN auth_user u ON u.id = c.user_id LEFT JOIN telepy_api_token k ON k.id = c.token_id \
         LEFT JOIN authorized_keys_reverseserverauthorizedkeys t ON t.id = c.tunnel_id WHERE 1 = 1"
    ));
    if let Some(u) = f.user_id {
        q.push(" AND c.user_id = ").push_bind(u);
    }
    if let Some(t) = f.token_id {
        q.push(" AND c.token_id = ").push_bind(t);
    }
    if let Some(g) = f.grant_id {
        q.push(" AND c.grant_id = ").push_bind(g);
    }
    if let Some(s) = f.status {
        q.push(s.sql());
    }
    if let Some(m) = &f.method {
        q.push(" AND c.method = ").push_bind(m.to_ascii_uppercase());
    }
    if let Some(b) = f.before {
        q.push(" AND c.id < ").push_bind(b);
    }
    q.push(" ORDER BY c.id DESC LIMIT ").push_bind(f.limit);
    q.build_query_as::<Call>().fetch_all(&db.read).await
}

/// 一把 token 的呼叫摘要。/ A token's call summary.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    pub calls_24h: i64,
    pub calls_7d: i64,
    pub errors_7d: i64,
    pub last_call_at: Option<String>,
    pub last_status: Option<i64>,
}

/// 這些 token 的摘要（一個查詢）。/ Summaries for these tokens in one query.
pub async fn summaries(db: &Db, token_ids: &[i64]) -> sqlx::Result<HashMap<i64, Summary>> {
    summaries_by(db, "token_id", token_ids).await
}

/// 這些 OAuth grant（`telepy` CLI 的瀏覽器登入）的摘要，跟 token 的一樣。/ The same summaries for OAuth grants (CLI sign-ins).
pub async fn grant_summaries(db: &Db, grant_ids: &[i64]) -> sqlx::Result<HashMap<i64, Summary>> {
    summaries_by(db, "grant_id", grant_ids).await
}

/// `column` 只會是 `token_id` / `grant_id`（程式內的常數，不是使用者輸入）。/ `column` is a constant, never user input.
async fn summaries_by(db: &Db, column: &'static str, ids: &[i64]) -> sqlx::Result<HashMap<i64, Summary>> {
    debug_assert!(matches!(column, "token_id" | "grant_id"));
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let now = chrono::Utc::now();
    let day = db_time(now - chrono::Duration::days(1));
    let week = db_time(now - chrono::Duration::days(7));
    let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(format!("SELECT {column}, SUM(CASE WHEN at >= "));
    q.push_bind(day.clone())
        .push(" THEN 1 ELSE 0 END), COUNT(*), SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) FROM telepy_api_call WHERE at >= ")
        .push_bind(week)
        .push(format!(" AND {column} IN ("));
    let mut sep = q.separated(", ");
    for id in ids {
        sep.push_bind(*id);
    }
    q.push(format!(") GROUP BY {column}"));
    let rows: Vec<(i64, i64, i64, i64)> = q.build_query_as().fetch_all(&db.read).await?;
    let mut out: HashMap<i64, Summary> = rows.into_iter().map(|(id, d, w, e)| (id, Summary { calls_24h: d, calls_7d: w, errors_7d: e, ..Default::default() })).collect();
    // 最後一次（不限 7 天）：每個的最大 id。/ The latest call of each (any age).
    let mut q: QueryBuilder<Sqlite> = QueryBuilder::new(format!("SELECT c.{column}, c.at, c.status FROM telepy_api_call c JOIN (SELECT {column}, MAX(id) AS id FROM telepy_api_call WHERE {column} IN ("));
    let mut sep = q.separated(", ");
    for id in ids {
        sep.push_bind(*id);
    }
    q.push(format!(") GROUP BY {column}) m ON m.id = c.id"));
    let last: Vec<(i64, String, i64)> = q.build_query_as().fetch_all(&db.read).await?;
    for (id, at, status) in last {
        let s = out.entry(id).or_default();
        s.last_call_at = Some(at);
        s.last_status = Some(status);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("db.sqlite3")).await.unwrap();
        super::super::schema::ensure_schema(&db.write).await.unwrap();
        (dir, db)
    }

    fn call(user: i64, token: Option<i64>, status: i64, at: &str) -> NewCall {
        NewCall { at: at.into(), user_id: user, token_id: token, client_name: "API token \"ci\"".into(), kind: "rest", method: "GET".into(), route: "/api/reverse/server/dashboard".into(), status, duration_ms: 3, ..Default::default() }
    }

    #[tokio::test]
    async fn batches_filters_summaries_and_retention() {
        let (_d, db) = db().await;
        sqlx::query("INSERT INTO auth_user (id, password, is_superuser, username, last_name, email, is_staff, is_active, date_joined, first_name) VALUES (1, '', 0, 'a', '', '', 0, 1, '2026-01-01 00:00:00', '')").execute(&db.write).await.unwrap();
        let now = crate::util::now_db();
        let old = db_time(chrono::Utc::now() - chrono::Duration::days(3));
        let ancient = db_time(chrono::Utc::now() - chrono::Duration::days(100));
        let max = insert_batch(&db, &[call(1, Some(5), 200, &now), call(1, Some(5), 404, &old), call(1, None, 500, &now), call(1, Some(5), 200, &ancient), call(2, Some(9), 200, &now)]).await.unwrap();
        assert_eq!(max, 5);
        let all = list(&db, &Filter { limit: 100, ..Default::default() }).await.unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].id, 5, "newest first");
        let mine = list(&db, &Filter { user_id: Some(1), status: Some(StatusFilter::Error), limit: 100, ..Default::default() }).await.unwrap();
        assert_eq!(mine.iter().map(|c| c.status).collect::<Vec<_>>(), vec![500, 404]);
        let page = list(&db, &Filter { user_id: Some(1), before: Some(3), limit: 1, ..Default::default() }).await.unwrap();
        assert_eq!(page.iter().map(|c| c.id).collect::<Vec<_>>(), vec![2]);
        assert_eq!(list(&db, &Filter { status: Some(StatusFilter::Client), limit: 9, ..Default::default() }).await.unwrap().len(), 1);
        assert_eq!(list(&db, &Filter { method: Some("post".into()), limit: 9, ..Default::default() }).await.unwrap().len(), 0);

        let s = summaries(&db, &[5, 9, 77]).await.unwrap();
        assert_eq!((s[&5].calls_24h, s[&5].calls_7d, s[&5].errors_7d), (1, 2, 1));
        assert_eq!(s[&5].last_status, Some(200), "the latest row (id 4) is the 100-day-old one");
        assert!(!s.contains_key(&77));

        // 90 天 + 已刪除的使用者（user 2 不存在）。/ 90 days and deleted users.
        let cutoff = db_time(chrono::Utc::now() - chrono::Duration::days(90));
        assert_eq!(purge(&db, &cutoff).await.unwrap(), 2);
        assert_eq!(list(&db, &Filter { limit: 100, ..Default::default() }).await.unwrap().len(), 3);
        assert_eq!(trim(&db, 10).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn grants_get_the_same_summaries_as_tokens() {
        let (_d, db) = db().await;
        let now = crate::util::now_db();
        let old = db_time(chrono::Utc::now() - chrono::Duration::days(3));
        let cli = |grant: i64, status: i64, at: &str| NewCall { grant_id: Some(grant), client_name: "telepy CLI (mac)".into(), ..call(1, None, status, at) };
        insert_batch(&db, &[cli(7, 200, &old), cli(7, 403, &now), cli(8, 200, &old), call(1, Some(7), 200, &now)]).await.unwrap();
        let s = grant_summaries(&db, &[7, 8, 9]).await.unwrap();
        assert_eq!((s[&7].calls_24h, s[&7].calls_7d, s[&7].errors_7d, s[&7].last_status), (1, 2, 1, Some(403)), "token 7's call is not grant 7's");
        assert_eq!((s[&8].calls_24h, s[&8].calls_7d), (0, 1));
        assert!(!s.contains_key(&9));
    }
}
