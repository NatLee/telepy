//! AI（MCP）工具呼叫的稽核紀錄：每一次 tool call 一列（誰、哪個 app、哪個隧道、跑了什麼、結果）。
//! 與 `telepy_gateway_event` 一樣有列數上限；帶 app 的來源 IP，所以也只留 90 天（`db::retention`）。
//! Audit trail of MCP tool calls, capped like the gateway events; kept 90 days (`db::retention`).

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

/// 最多保留的列數。/ Row cap.
pub const RETENTION_ROWS: i64 = 100_000;
/// `detail`（指令 / 路徑 / 原因）最多存多少字元。/ Max characters stored in `detail`.
pub const MAX_DETAIL_CHARS: usize = 2000;

#[derive(Debug, Clone, Default)]
pub struct NewEvent<'a> {
    pub user_id: i64,
    pub grant_id: Option<i64>,
    pub client_name: &'a str,
    pub tool: &'a str,
    pub tunnel_id: Option<i64>,
    pub session_id: Option<&'a str>,
    pub target_username: Option<&'a str>,
    pub detail: Option<&'a str>,
    pub ok: bool,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bytes_out: Option<i64>,
    pub error: Option<&'a str>,
    /// MCP 請求的來源 IP（AI app 的出口，不一定是使用者本人）。/ The MCP client's address.
    pub ip: Option<&'a str>,
}

/// 事件 + 使用者名稱 + 隧道名稱（隧道刪掉後為 NULL）。/ Event joined with user and tunnel names.
#[derive(Debug, Clone, FromRow)]
pub struct Event {
    pub id: i64,
    pub at: String,
    pub user_id: i64,
    pub username: Option<String>,
    pub grant_id: Option<i64>,
    pub client_name: String,
    pub tool: String,
    pub tunnel_id: Option<i64>,
    pub tunnel_name: Option<String>,
    pub session_id: Option<String>,
    pub target_username: Option<String>,
    pub detail: Option<String>,
    pub ok: bool,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bytes_out: Option<i64>,
    pub error: Option<String>,
    pub ip: Option<String>,
}

const T: &str = "telepy_ai_audit_event";

fn clip(s: Option<&str>) -> Option<String> {
    s.map(|s| if s.chars().count() > MAX_DETAIL_CHARS { s.chars().take(MAX_DETAIL_CHARS).collect::<String>() + "…" } else { s.to_string() })
}

pub async fn insert(db: &Db, e: NewEvent<'_>) -> sqlx::Result<i64> {
    let id = sqlx::query(&format!(
        "INSERT INTO {T} (at, user_id, grant_id, client_name, tool, tunnel_id, session_id, target_username, detail, ok, exit_code, duration_ms, bytes_out, error, ip) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(now_db())
    .bind(e.user_id)
    .bind(e.grant_id)
    .bind(e.client_name)
    .bind(e.tool)
    .bind(e.tunnel_id)
    .bind(e.session_id)
    .bind(e.target_username)
    .bind(clip(e.detail))
    .bind(e.ok)
    .bind(e.exit_code)
    .bind(e.duration_ms)
    .bind(e.bytes_out)
    .bind(clip(e.error))
    .bind(e.ip)
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    // 偶爾修剪（每 1000 列一次），不必每筆都算。/ Trim occasionally rather than on every insert.
    if id % 1000 == 0 {
        sqlx::query(&format!("DELETE FROM {T} WHERE id <= ?")).bind(id - RETENTION_ROWS).execute(&db.write).await?;
    }
    Ok(id)
}

#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// None = 全部（管理員）；Some(uid) = 該使用者自己的 ∪ 他擁有的隧道上的。/ None = everything (admins).
    pub visible_to: Option<i64>,
    pub user_id: Option<i64>,
    pub tunnel_id: Option<i64>,
    pub limit: i64,
}

pub async fn list(db: &Db, f: &Filter) -> sqlx::Result<Vec<Event>> {
    let mut sql = format!(
        "SELECT e.id, e.at, e.user_id, u.username, e.grant_id, e.client_name, e.tool, e.tunnel_id, t.host_friendly_name AS tunnel_name, \
                e.session_id, e.target_username, e.detail, e.ok, e.exit_code, e.duration_ms, e.bytes_out, e.error, e.ip \
         FROM {T} e LEFT JOIN auth_user u ON u.id = e.user_id \
         LEFT JOIN authorized_keys_reverseserverauthorizedkeys t ON t.id = e.tunnel_id WHERE 1 = 1"
    );
    if f.visible_to.is_some() {
        sql.push_str(" AND (e.user_id = ? OR e.tunnel_id IN (SELECT id FROM authorized_keys_reverseserverauthorizedkeys WHERE user_id = ?))");
    }
    if f.user_id.is_some() {
        sql.push_str(" AND e.user_id = ?");
    }
    if f.tunnel_id.is_some() {
        sql.push_str(" AND e.tunnel_id = ?");
    }
    sql.push_str(" ORDER BY e.id DESC LIMIT ?");
    let mut q = sqlx::query_as::<_, Event>(&sql);
    if let Some(v) = f.visible_to {
        q = q.bind(v).bind(v);
    }
    if let Some(u) = f.user_id {
        q = q.bind(u);
    }
    if let Some(t) = f.tunnel_id {
        q = q.bind(t);
    }
    q.bind(f.limit).fetch_all(&db.read).await
}
