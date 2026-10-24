//! 指令規則（`telepy_command_rule`；`tunnel_id` NULL = 全站）與每次擋下 / 送核准的紀錄（`telepy_command_event`）。
//! Command rules (`telepy_command_rule`; NULL `tunnel_id` = site-wide) and the record of every block and approval
//! request (`telepy_command_event`).

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

const R: &str = "telepy_command_rule";
const E: &str = "telepy_command_event";
/// 紀錄最多留幾列（等待中的不刪）。/ Row cap for the event log (pending rows are kept).
pub const MAX_EVENTS: i64 = 20_000;

#[derive(Debug, Clone, FromRow)]
pub struct RuleRow {
    pub id: i64,
    pub tunnel_id: Option<i64>,
    /// block / approve
    pub action: String,
    /// command / regex
    pub kind: String,
    pub pattern: String,
    /// everyone / sharees
    pub who: String,
    /// all / terminal / agents
    pub via: String,
    pub note: String,
    pub enabled: bool,
    pub created_by_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

const R_COLS: &str = "id, tunnel_id, action, kind, pattern, who, via, note, enabled, created_by_id, created_at, updated_at";

pub struct NewRule<'a> {
    pub tunnel_id: Option<i64>,
    pub action: &'a str,
    pub kind: &'a str,
    pub pattern: &'a str,
    pub who: &'a str,
    pub via: &'a str,
    pub note: &'a str,
    pub enabled: bool,
}

pub async fn create_rule(db: &Db, r: &NewRule<'_>, by: i64) -> sqlx::Result<RuleRow> {
    let now = now_db();
    let id = sqlx::query(&format!(
        "INSERT INTO {R} (tunnel_id, action, kind, pattern, who, via, note, enabled, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(r.tunnel_id)
    .bind(r.action)
    .bind(r.kind)
    .bind(r.pattern)
    .bind(r.who)
    .bind(r.via)
    .bind(r.note)
    .bind(r.enabled)
    .bind(by)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    rule(db, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// 整列換掉（tunnel_id 不變）。/ Replace a rule's fields (its tunnel stays).
pub async fn update_rule(db: &Db, id: i64, r: &NewRule<'_>) -> sqlx::Result<Option<RuleRow>> {
    sqlx::query(&format!("UPDATE {R} SET action = ?, kind = ?, pattern = ?, who = ?, via = ?, note = ?, enabled = ?, updated_at = ? WHERE id = ?"))
        .bind(r.action)
        .bind(r.kind)
        .bind(r.pattern)
        .bind(r.who)
        .bind(r.via)
        .bind(r.note)
        .bind(r.enabled)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    rule(db, id).await
}

pub async fn delete_rule(db: &Db, id: i64) -> sqlx::Result<bool> {
    Ok(sqlx::query(&format!("DELETE FROM {R} WHERE id = ?")).bind(id).execute(&db.write).await?.rows_affected() > 0)
}

pub async fn rule(db: &Db, id: i64) -> sqlx::Result<Option<RuleRow>> {
    sqlx::query_as(&format!("SELECT {R_COLS} FROM {R} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 全站規則（tunnel_id IS NULL）或一條隧道的規則，舊的在前。/ Site-wide rules or one tunnel's, oldest first.
pub async fn rules_for(db: &Db, tunnel_id: Option<i64>) -> sqlx::Result<Vec<RuleRow>> {
    match tunnel_id {
        None => sqlx::query_as(&format!("SELECT {R_COLS} FROM {R} WHERE tunnel_id IS NULL ORDER BY id")).fetch_all(&db.read).await,
        Some(t) => sqlx::query_as(&format!("SELECT {R_COLS} FROM {R} WHERE tunnel_id = ? ORDER BY id")).bind(t).fetch_all(&db.read).await,
    }
}

/// 每條隧道有幾條規則（列表的小標籤用）。/ Rule counts per tunnel.
pub async fn counts_by_tunnel(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT tunnel_id, COUNT(*) FROM {R} WHERE tunnel_id IS NOT NULL AND enabled = 1 GROUP BY tunnel_id")).fetch_all(&db.read).await
}

// ---------------------------------------------------------------- events

#[derive(Debug, Clone, FromRow)]
pub struct EventRow {
    pub id: i64,
    pub tunnel_id: i64,
    pub user_id: i64,
    pub username: String,
    /// terminal / agent
    pub source: String,
    /// agent 的 app 名稱。/ The agent's app name.
    pub client: Option<String>,
    pub grant_id: Option<i64>,
    /// 終端機 = presence id；agent = AI session id。/ Terminal: presence id; agent: AI session id.
    pub session_ref: Option<String>,
    pub account: String,
    pub lan_host: Option<String>,
    pub command: String,
    pub rule_id: Option<i64>,
    pub rule_pattern: String,
    pub rule_kind: String,
    /// site / tunnel
    pub rule_scope: String,
    pub rule_note: String,
    /// blocked / pending / approved / denied / cancelled / expired
    pub status: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub decided_by_id: Option<i64>,
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
    pub reason: String,
    pub used_at: Option<String>,
}

const E_COLS: &str = "id, tunnel_id, user_id, username, source, client, grant_id, session_ref, account, lan_host, command, rule_id, rule_pattern, rule_kind, rule_scope, rule_note, status, created_at, expires_at, decided_by_id, decided_by, decided_at, reason, used_at";

pub struct NewEvent<'a> {
    pub tunnel_id: i64,
    pub user_id: i64,
    pub username: &'a str,
    pub source: &'a str,
    pub client: Option<&'a str>,
    pub grant_id: Option<i64>,
    pub session_ref: Option<&'a str>,
    pub account: &'a str,
    pub lan_host: Option<&'a str>,
    pub command: &'a str,
    pub rule_id: i64,
    pub rule_pattern: &'a str,
    pub rule_kind: &'a str,
    pub rule_scope: &'a str,
    pub rule_note: &'a str,
    pub status: &'a str,
    pub expires_at: Option<&'a str>,
}

pub async fn create_event(db: &Db, e: &NewEvent<'_>) -> sqlx::Result<EventRow> {
    let id = sqlx::query(&format!(
        "INSERT INTO {E} (tunnel_id, user_id, username, source, client, grant_id, session_ref, account, lan_host, command, rule_id, rule_pattern, rule_kind, rule_scope, rule_note, status, created_at, expires_at, reason) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')"
    ))
    .bind(e.tunnel_id)
    .bind(e.user_id)
    .bind(e.username)
    .bind(e.source)
    .bind(e.client)
    .bind(e.grant_id)
    .bind(e.session_ref)
    .bind(e.account)
    .bind(e.lan_host)
    .bind(e.command)
    .bind(e.rule_id)
    .bind(e.rule_pattern)
    .bind(e.rule_kind)
    .bind(e.rule_scope)
    .bind(e.rule_note)
    .bind(e.status)
    .bind(now_db())
    .bind(e.expires_at)
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    // 上限：刪掉最舊的已結束紀錄。/ Cap: drop the oldest finished rows.
    sqlx::query(&format!(
        "DELETE FROM {E} WHERE status != 'pending' AND id <= (SELECT id FROM {E} ORDER BY id DESC LIMIT 1 OFFSET ?)"
    ))
    .bind(MAX_EVENTS)
    .execute(&db.write)
    .await?;
    event(db, id).await?.ok_or(sqlx::Error::RowNotFound)
}

pub async fn event(db: &Db, id: i64) -> sqlx::Result<Option<EventRow>> {
    sqlx::query_as(&format!("SELECT {E_COLS} FROM {E} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 決定一筆等待中的申請（compare-and-set：已經不是 pending 就回 false）。
/// Decide a pending request (compare-and-set: false when it is no longer pending).
pub async fn decide(db: &Db, id: i64, status: &str, by: Option<(i64, &str)>, reason: &str) -> sqlx::Result<bool> {
    let used = if status == "approved" { None } else { Some(now_db()) };
    Ok(sqlx::query(&format!(
        "UPDATE {E} SET status = ?, decided_by_id = ?, decided_by = ?, decided_at = ?, reason = ?, used_at = ? WHERE id = ? AND status = 'pending'"
    ))
    .bind(status)
    .bind(by.map(|b| b.0))
    .bind(by.map(|b| b.1))
    .bind(now_db())
    .bind(reason)
    .bind(used)
    .bind(id)
    .execute(&db.write)
    .await?
    .rows_affected()
        > 0)
}

/// 核准用掉了（終端機送出 Enter / agent 跑了指令）；只有第一次會成功。/ Mark an approval used; only the first call wins.
pub async fn mark_used(db: &Db, id: i64) -> sqlx::Result<bool> {
    Ok(sqlx::query(&format!("UPDATE {E} SET used_at = ? WHERE id = ? AND status = 'approved' AND used_at IS NULL"))
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?
        .rows_affected()
        > 0)
}

/// agent 再呼叫同一個指令：找同一個 app、同一條隧道與帳號還在等或剛核准（`since` 之後）還沒用掉的那筆。
/// An agent repeating a command: the pending, or approved-since-`since` and unused, request of the same app,
/// tunnel and account.
pub async fn reusable_agent_request(db: &Db, user_id: i64, grant_id: i64, tunnel_id: i64, account: &str, command: &str, since: &str) -> sqlx::Result<Option<EventRow>> {
    sqlx::query_as(&format!(
        "SELECT {E_COLS} FROM {E} WHERE user_id = ? AND grant_id = ? AND tunnel_id = ? AND account = ? AND command = ? AND source = 'agent' \
         AND (status = 'pending' OR (status = 'approved' AND used_at IS NULL AND decided_at >= ?)) ORDER BY id DESC LIMIT 1"
    ))
    .bind(user_id)
    .bind(grant_id)
    .bind(tunnel_id)
    .bind(account)
    .bind(command)
    .bind(since)
    .fetch_optional(&db.read)
    .await
}

/// 等待中而已過期的（給 reaper）。/ Pending requests past their expiry (for the reaper).
pub async fn due_pending(db: &Db, now: &str) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(&format!("SELECT id FROM {E} WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")).bind(now).fetch_all(&db.read).await
}

/// 重開機時還在等的：沒有人會等它了。/ Pending at startup: nobody is waiting on them any more.
pub async fn cancel_orphans(db: &Db) -> sqlx::Result<u64> {
    Ok(sqlx::query(&format!("UPDATE {E} SET status = 'cancelled', reason = 'server restarted', decided_at = ?, used_at = ? WHERE status = 'pending'"))
        .bind(now_db())
        .bind(now_db())
        .execute(&db.write)
        .await?
        .rows_affected())
}

/// 清單：可以看的隧道（`tunnel_ids`）裡全部的，或我自己的（`own_user`），新的在前。
/// The list: everything on tunnels in `tunnel_ids` plus the caller's own rows, newest first.
pub async fn list(db: &Db, tunnel_ids: &[i64], own_user: i64, only_tunnel: Option<i64>, pending_only: bool, limit: i64) -> sqlx::Result<Vec<EventRow>> {
    let ids = if tunnel_ids.is_empty() { "NULL".to_string() } else { tunnel_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",") };
    let mut sql = format!("SELECT {E_COLS} FROM {E} WHERE (tunnel_id IN ({ids}) OR user_id = ?)");
    if only_tunnel.is_some() {
        sql.push_str(" AND tunnel_id = ?");
    }
    if pending_only {
        sql.push_str(" AND status = 'pending'");
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");
    let mut q = sqlx::query_as(&sql).bind(own_user);
    if let Some(t) = only_tunnel {
        q = q.bind(t);
    }
    q.bind(limit).fetch_all(&db.read).await
}
