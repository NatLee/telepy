//! 指令規則（`telepy_command_rule`：`scope` site = 全站、user = 某人的個人規則；`all_tunnels` 或
//! `telepy_command_rule_target` 列出的隧道）與每次擋下 / 送核准的紀錄（`telepy_command_event`）。
//! Command rules (`telepy_command_rule`: `scope` site = site-wide, user = someone's personal rule; for every tunnel
//! or the ones in `telepy_command_rule_target`) and the record of every block and approval request
//! (`telepy_command_event`).

use std::collections::HashMap;

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

const R: &str = "telepy_command_rule";
const RT: &str = "telepy_command_rule_target";
const O: &str = "telepy_command_rule_override";
const OT: &str = "telepy_command_rule_override_target";
const E: &str = "telepy_command_event";
/// 紀錄最多留幾列（等待中的不刪）。/ Row cap for the event log (pending rows are kept).
pub const MAX_EVENTS: i64 = 20_000;

#[derive(Debug, Clone, FromRow)]
pub struct RuleRow {
    pub id: i64,
    /// site / user（舊的列在 data migration 前是 NULL）。/ site / user (NULL on pre-upgrade rows until migrated).
    pub scope: Option<String>,
    /// 個人規則的主人。/ The owner of a personal rule.
    pub user_id: Option<i64>,
    /// 主人的帳號名稱（JOIN 來的）。/ The owner's username (joined).
    pub owner_name: Option<String>,
    /// 套用所有隧道（個人規則：自己管的 / 自己能用的全部）；否則只有 `telepy_command_rule_target` 那幾條。
    /// Every tunnel (personal: all the owner manages / can use); otherwise only the listed ones.
    pub all_tunnels: bool,
    /// enforced（誰都不能覆寫）/ default（可以覆寫）；只對全站規則有意義。/ enforced / default; site rules only.
    pub mode: String,
    /// 「要核准」等多久（秒）；None = 網站設定。/ How long an approval waits (seconds); None = the site setting.
    pub approval_timeout: Option<i64>,
    /// block / approve / warn / allow
    pub action: String,
    /// command / regex
    pub kind: String,
    pub pattern: String,
    /// everyone / sharees / me（me 只有個人規則）。/ everyone / sharees / me (personal rules only).
    pub who: String,
    /// all / terminal / agents
    pub via: String,
    pub note: String,
    pub enabled: bool,
    /// 「要核准」規則指定的核准人（JSON 陣列）；NULL / 空 = owner + ADMIN sharee。
    /// The approvers an "approve" rule names (JSON array); NULL / empty = the owner + ADMIN sharees.
    pub approver_ids: Option<String>,
    pub created_by_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

impl RuleRow {
    /// 全站規則嗎（舊的列：沒有隧道 = 全站）。/ Whether this is a site-wide rule (pre-upgrade rows: no tunnel).
    pub fn is_site(&self) -> bool {
        self.scope.as_deref() == Some("site")
    }
}

const R_SELECT: &str = "SELECT r.id, r.scope, r.user_id, u.username AS owner_name, r.all_tunnels, r.mode, r.approval_timeout, r.action, r.kind, r.pattern, r.who, r.via, \
     r.note, r.enabled, r.approver_ids, r.created_by_id, r.created_at, r.updated_at FROM telepy_command_rule r LEFT JOIN auth_user u ON u.id = r.user_id";

pub struct NewRule<'a> {
    /// site / user
    pub scope: &'a str,
    /// 個人規則的主人。/ The owner of a personal rule.
    pub user_id: Option<i64>,
    pub all_tunnels: bool,
    pub mode: &'a str,
    pub approval_timeout: Option<i64>,
    pub action: &'a str,
    pub kind: &'a str,
    pub pattern: &'a str,
    pub who: &'a str,
    pub via: &'a str,
    pub note: &'a str,
    pub enabled: bool,
    /// JSON 陣列；None = 預設核准人。/ A JSON array; None = the default approvers.
    pub approver_ids: Option<&'a str>,
}

/// 新增規則與它的隧道清單（同一個 transaction）。/ Add a rule and its tunnel list (one transaction).
pub async fn create_rule(db: &Db, r: &NewRule<'_>, tunnel_ids: &[i64], by: i64) -> sqlx::Result<RuleRow> {
    let now = now_db();
    let mut tx = db.write.begin().await?;
    let id = sqlx::query(&format!(
        "INSERT INTO {R} (tunnel_id, scope, user_id, all_tunnels, mode, approval_timeout, action, kind, pattern, who, via, note, enabled, approver_ids, created_by_id, created_at, updated_at) \
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(r.scope)
    .bind(r.user_id)
    .bind(r.all_tunnels)
    .bind(r.mode)
    .bind(r.approval_timeout)
    .bind(r.action)
    .bind(r.kind)
    .bind(r.pattern)
    .bind(r.who)
    .bind(r.via)
    .bind(r.note)
    .bind(r.enabled)
    .bind(r.approver_ids)
    .bind(by)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    for t in tunnel_ids {
        sqlx::query(&format!("INSERT OR IGNORE INTO {RT} (rule_id, tunnel_id) VALUES (?, ?)")).bind(id).bind(t).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    rule(db, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// 整列換掉（範圍與主人不變），隧道清單一起換。/ Replace a rule's fields (scope and owner stay) and its tunnel list.
pub async fn update_rule(db: &Db, id: i64, r: &NewRule<'_>, tunnel_ids: &[i64]) -> sqlx::Result<Option<RuleRow>> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!(
        "UPDATE {R} SET all_tunnels = ?, mode = ?, approval_timeout = ?, action = ?, kind = ?, pattern = ?, who = ?, via = ?, note = ?, enabled = ?, approver_ids = ?, updated_at = ? WHERE id = ?"
    ))
    .bind(r.all_tunnels)
    .bind(r.mode)
    .bind(r.approval_timeout)
    .bind(r.action)
    .bind(r.kind)
    .bind(r.pattern)
    .bind(r.who)
    .bind(r.via)
    .bind(r.note)
    .bind(r.enabled)
    .bind(r.approver_ids)
    .bind(now_db())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!("DELETE FROM {RT} WHERE rule_id = ?")).bind(id).execute(&mut *tx).await?;
    for t in tunnel_ids {
        sqlx::query(&format!("INSERT OR IGNORE INTO {RT} (rule_id, tunnel_id) VALUES (?, ?)")).bind(id).bind(t).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    rule(db, id).await
}

pub async fn delete_rule(db: &Db, id: i64) -> sqlx::Result<bool> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {RT} WHERE rule_id = ?")).bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {OT} WHERE override_id IN (SELECT id FROM {O} WHERE rule_id = ?)")).bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {O} WHERE rule_id = ?")).bind(id).execute(&mut *tx).await?;
    let gone = sqlx::query(&format!("DELETE FROM {R} WHERE id = ?")).bind(id).execute(&mut *tx).await?.rows_affected() > 0;
    tx.commit().await?;
    Ok(gone)
}

pub async fn rule(db: &Db, id: i64) -> sqlx::Result<Option<RuleRow>> {
    sqlx::query_as(&format!("{R_SELECT} WHERE r.id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 全站規則，舊的在前。/ The site-wide rules, oldest first.
pub async fn site_rules(db: &Db) -> sqlx::Result<Vec<RuleRow>> {
    sqlx::query_as(&format!("{R_SELECT} WHERE r.scope = 'site' ORDER BY r.id")).fetch_all(&db.read).await
}

/// 一個人的個人規則，舊的在前。/ One person's personal rules, oldest first.
pub async fn user_rules(db: &Db, user_id: i64) -> sqlx::Result<Vec<RuleRow>> {
    sqlx::query_as(&format!("{R_SELECT} WHERE r.scope = 'user' AND r.user_id = ? ORDER BY r.id")).bind(user_id).fetch_all(&db.read).await
}

/// 可能套用到這條隧道的規則：全站在前，再來每個人的個人規則（`all_tunnels` 或清單裡有它）。個人規則的主人是不是還管這條
/// 隧道、「只有我」管的是誰，評估時才看（`matcher::Ctx`）。
/// The rules that may apply to a tunnel: site-wide first, then everyone's personal rules (every tunnel, or listed).
/// Whether a personal rule's owner still manages the tunnel, and whose commands a "me" rule covers, is decided at
/// evaluation time (`matcher::Ctx`).
pub async fn rules_targeting(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<RuleRow>> {
    sqlx::query_as(&format!(
        "{R_SELECT} WHERE r.scope IN ('site', 'user') AND (r.all_tunnels = 1 OR r.id IN (SELECT rule_id FROM {RT} WHERE tunnel_id = ?)) \
         ORDER BY CASE r.scope WHEN 'site' THEN 0 ELSE 1 END, r.id"
    ))
    .bind(tunnel_id)
    .fetch_all(&db.read)
    .await
}

/// 每條規則限定的隧道（只有 `all_tunnels` = 0 的才有）。/ The tunnels each limited rule covers.
pub async fn tunnel_map(db: &Db, rule_ids: &[i64]) -> sqlx::Result<HashMap<i64, Vec<i64>>> {
    let mut out: HashMap<i64, Vec<i64>> = HashMap::new();
    if rule_ids.is_empty() {
        return Ok(out);
    }
    let ids = rule_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let rows: Vec<(i64, i64)> = sqlx::query_as(&format!("SELECT rule_id, tunnel_id FROM {RT} WHERE rule_id IN ({ids}) ORDER BY tunnel_id")).fetch_all(&db.read).await?;
    for (rule, tunnel) in rows {
        out.entry(rule).or_default().push(tunnel);
    }
    Ok(out)
}

/// 隧道刪了：只套用它一條的規則一起刪，其他規則的清單拿掉它。回傳刪掉幾條規則。
/// A deleted tunnel: rules limited to it alone go, other rules' lists drop it. Returns the rules deleted.
pub async fn forget_tunnel(tx: &mut sqlx::SqliteConnection, tunnel_id: i64) -> sqlx::Result<u64> {
    let gone = sqlx::query(&format!(
        "DELETE FROM {R} WHERE all_tunnels = 0 AND id IN (SELECT rule_id FROM {RT} WHERE tunnel_id = ?) \
         AND NOT EXISTS (SELECT 1 FROM {RT} x WHERE x.rule_id = {R}.id AND x.tunnel_id <> ?)"
    ))
    .bind(tunnel_id)
    .bind(tunnel_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query(&format!("DELETE FROM {RT} WHERE tunnel_id = ?")).bind(tunnel_id).execute(&mut *tx).await?;
    // 覆寫：只列這條隧道的刪掉，其他的清單拿掉它；規則不在了的覆寫也收掉。/ Overrides: the same, plus those of deleted rules.
    sqlx::query(&format!(
        "DELETE FROM {O} WHERE all_tunnels = 0 AND id IN (SELECT override_id FROM {OT} WHERE tunnel_id = ?) \
         AND NOT EXISTS (SELECT 1 FROM {OT} x WHERE x.override_id = {O}.id AND x.tunnel_id <> ?)"
    ))
    .bind(tunnel_id)
    .bind(tunnel_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!("DELETE FROM {OT} WHERE tunnel_id = ? OR override_id NOT IN (SELECT id FROM {O})")).bind(tunnel_id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {O} WHERE rule_id NOT IN (SELECT id FROM {R})")).execute(&mut *tx).await?;
    // 還沒轉換的舊隧道規則。/ Pre-upgrade tunnel rules not converted yet.
    sqlx::query(&format!("DELETE FROM {R} WHERE scope IS NULL AND tunnel_id = ?")).bind(tunnel_id).execute(&mut *tx).await?;
    Ok(gone)
}

// ---------------------------------------------------------------- overrides

/// 某人對一條規則的覆寫。/ Someone's override of a rule.
#[derive(Debug, Clone, FromRow)]
pub struct OverrideRow {
    pub id: i64,
    pub rule_id: i64,
    pub user_id: i64,
    pub username: Option<String>,
    /// off / mute
    pub kind: String,
    pub all_tunnels: bool,
    pub created_at: String,
}

const O_SELECT: &str = "SELECT o.id, o.rule_id, o.user_id, u.username, o.kind, o.all_tunnels, o.created_at FROM telepy_command_rule_override o LEFT JOIN auth_user u ON u.id = o.user_id";

/// 設定（取代）我對這條規則的一種覆寫。/ Set (replace) my override of one kind on a rule.
pub async fn set_override(db: &Db, rule_id: i64, user_id: i64, kind: &str, all_tunnels: bool, tunnel_ids: &[i64]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    let old: Option<i64> = sqlx::query_scalar(&format!("SELECT id FROM {O} WHERE rule_id = ? AND user_id = ? AND kind = ?")).bind(rule_id).bind(user_id).bind(kind).fetch_optional(&mut *tx).await?;
    let id = match old {
        Some(id) => {
            sqlx::query(&format!("UPDATE {O} SET all_tunnels = ? WHERE id = ?")).bind(all_tunnels).bind(id).execute(&mut *tx).await?;
            sqlx::query(&format!("DELETE FROM {OT} WHERE override_id = ?")).bind(id).execute(&mut *tx).await?;
            id
        }
        None => sqlx::query(&format!("INSERT INTO {O} (rule_id, user_id, kind, all_tunnels, created_at) VALUES (?, ?, ?, ?, ?)"))
            .bind(rule_id)
            .bind(user_id)
            .bind(kind)
            .bind(all_tunnels)
            .bind(now_db())
            .execute(&mut *tx)
            .await?
            .last_insert_rowid(),
    };
    for t in tunnel_ids {
        sqlx::query(&format!("INSERT OR IGNORE INTO {OT} (override_id, tunnel_id) VALUES (?, ?)")).bind(id).bind(t).execute(&mut *tx).await?;
    }
    tx.commit().await
}

/// 拿掉我的覆寫；回傳原本有沒有。/ Remove my override; whether there was one.
pub async fn clear_override(db: &Db, rule_id: i64, user_id: i64, kind: &str) -> sqlx::Result<bool> {
    let mut tx = db.write.begin().await?;
    let old: Option<i64> = sqlx::query_scalar(&format!("SELECT id FROM {O} WHERE rule_id = ? AND user_id = ? AND kind = ?")).bind(rule_id).bind(user_id).bind(kind).fetch_optional(&mut *tx).await?;
    if let Some(id) = old {
        sqlx::query(&format!("DELETE FROM {OT} WHERE override_id = ?")).bind(id).execute(&mut *tx).await?;
        sqlx::query(&format!("DELETE FROM {O} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(old.is_some())
}

/// 這些規則的覆寫（含限定的隧道）。/ The overrides of these rules, with their tunnels.
pub async fn overrides_for(db: &Db, rule_ids: &[i64]) -> sqlx::Result<Vec<(OverrideRow, Vec<i64>)>> {
    if rule_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = rule_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let rows: Vec<OverrideRow> = sqlx::query_as(&format!("{O_SELECT} WHERE o.rule_id IN ({ids}) ORDER BY o.id")).fetch_all(&db.read).await?;
    let oids = rows.iter().map(|o| o.id.to_string()).collect::<Vec<_>>().join(",");
    let mut targets: HashMap<i64, Vec<i64>> = HashMap::new();
    if !oids.is_empty() {
        let pairs: Vec<(i64, i64)> = sqlx::query_as(&format!("SELECT override_id, tunnel_id FROM {OT} WHERE override_id IN ({oids}) ORDER BY tunnel_id")).fetch_all(&db.read).await?;
        for (o, t) in pairs {
            targets.entry(o).or_default().push(t);
        }
    }
    Ok(rows.into_iter().map(|o| {
        let t = targets.remove(&o.id).unwrap_or_default();
        (o, t)
    }).collect())
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
    /// site / personal / self（「只有我」的個人規則）/ tunnel（升級前的隧道規則）。
    /// site / personal / self (an "only me" personal rule) / tunnel (a pre-upgrade tunnel rule).
    pub rule_scope: String,
    pub rule_note: String,
    /// 這筆申請的核准人快照（JSON 陣列）；NULL = 當時的 owner + ADMIN。/ Who could decide (JSON array); NULL = owner + ADMIN at the time.
    pub approver_ids: Option<String>,
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

const E_COLS: &str = "id, tunnel_id, user_id, username, source, client, grant_id, session_ref, account, lan_host, command, rule_id, rule_pattern, rule_kind, rule_scope, rule_note, approver_ids, status, created_at, expires_at, decided_by_id, decided_by, decided_at, reason, used_at";

pub struct NewEvent<'a> {
    pub tunnel_id: i64,
    pub user_id: i64,
    pub username: &'a str,
    pub source: &'a str,
    pub client: Option<&'a str>,
    pub grant_id: Option<i64>,
    /// 個人 API token（agent 用 token 時）。/ The personal API token, when the agent used one.
    pub token_id: Option<i64>,
    pub session_ref: Option<&'a str>,
    pub account: &'a str,
    pub lan_host: Option<&'a str>,
    pub command: &'a str,
    pub rule_id: i64,
    pub rule_pattern: &'a str,
    pub rule_kind: &'a str,
    pub rule_scope: &'a str,
    pub rule_note: &'a str,
    pub approver_ids: Option<&'a str>,
    pub status: &'a str,
    pub expires_at: Option<&'a str>,
}

pub async fn create_event(db: &Db, e: &NewEvent<'_>) -> sqlx::Result<EventRow> {
    let id = sqlx::query(&format!(
        "INSERT INTO {E} (tunnel_id, user_id, username, source, client, grant_id, token_id, session_ref, account, lan_host, command, rule_id, rule_pattern, rule_kind, rule_scope, rule_note, approver_ids, status, created_at, expires_at, reason) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')"
    ))
    .bind(e.tunnel_id)
    .bind(e.user_id)
    .bind(e.username)
    .bind(e.source)
    .bind(e.client)
    .bind(e.grant_id)
    .bind(e.token_id)
    .bind(e.session_ref)
    .bind(e.account)
    .bind(e.lan_host)
    .bind(e.command)
    .bind(e.rule_id)
    .bind(e.rule_pattern)
    .bind(e.rule_kind)
    .bind(e.rule_scope)
    .bind(e.rule_note)
    .bind(e.approver_ids)
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
#[allow(clippy::too_many_arguments)]
pub async fn reusable_agent_request(db: &Db, user_id: i64, grant_id: Option<i64>, token_id: Option<i64>, tunnel_id: i64, account: &str, command: &str, since: &str) -> sqlx::Result<Option<EventRow>> {
    sqlx::query_as(&format!(
        "SELECT {E_COLS} FROM {E} WHERE user_id = ? AND grant_id IS ? AND token_id IS ? AND tunnel_id = ? AND account = ? AND command = ? AND source = 'agent' \
         AND (status = 'pending' OR (status = 'approved' AND used_at IS NULL AND decided_at >= ?)) ORDER BY id DESC LIMIT 1"
    ))
    .bind(user_id)
    .bind(grant_id)
    .bind(token_id)
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

/// 清單：可以看的隧道（`tunnel_ids`）裡全部的（別人「只管自己」規則的除外）、我自己的（`own_user`），加上規則點名我核准的
/// （`approver_ids` 快照裡有我），新的在前。
/// The list: everything on tunnels in `tunnel_ids` (except other people's "only me" rules), the caller's own rows,
/// plus requests whose approver snapshot names the caller, newest first.
pub async fn list(db: &Db, tunnel_ids: &[i64], own_user: i64, only_tunnel: Option<i64>, pending_only: bool, limit: i64) -> sqlx::Result<Vec<EventRow>> {
    let ids = if tunnel_ids.is_empty() { "NULL".to_string() } else { tunnel_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",") };
    let mut sql = format!(
        "SELECT {E_COLS} FROM {E} WHERE ((tunnel_id IN ({ids}) AND rule_scope <> 'self') OR user_id = ? \
         OR (approver_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each({E}.approver_ids) WHERE value = ?)))"
    );
    if only_tunnel.is_some() {
        sql.push_str(" AND tunnel_id = ?");
    }
    if pending_only {
        sql.push_str(" AND status = 'pending'");
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");
    let mut q = sqlx::query_as(&sql).bind(own_user).bind(own_user);
    if let Some(t) = only_tunnel {
        q = q.bind(t);
    }
    q.bind(limit).fetch_all(&db.read).await
}
