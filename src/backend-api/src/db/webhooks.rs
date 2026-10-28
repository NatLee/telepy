//! webhook 與送出紀錄。/ Webhooks and their deliveries.

use std::collections::HashMap;

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

/// 每個 webhook 留幾筆送出紀錄。/ Deliveries kept per webhook.
pub const DELIVERIES_KEPT: i64 = 50;

#[derive(Debug, Clone, FromRow)]
pub struct WebhookRow {
    pub id: i64,
    pub user_id: Option<i64>,
    pub scope: String,
    pub name: String,
    pub url: String,
    pub format: String,
    pub language: String,
    pub events: String,
    pub all_tunnels: bool,
    pub delay: i64,
    pub secret: String,
    pub enabled: bool,
    pub paused_reason: String,
    pub failures: i64,
    pub last_status: String,
    pub last_at: Option<String>,
    pub last_code: Option<i64>,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
    /// 自訂 header（密封的 JSON；空字串 = 沒有）。/ Custom headers (sealed JSON; empty = none).
    pub headers: String,
    /// 全站 webhook 的模式：`enforced` | `default`（個人的不看）。/ A site webhook's mode (personal ones ignore it).
    pub mode: String,
}

impl WebhookRow {
    pub fn is_site(&self) -> bool {
        self.scope == "site"
    }
    /// 全站、而且是強制的：沒人能退出。/ Site-wide and enforced: nobody may opt out.
    pub fn is_enforced(&self) -> bool {
        self.is_site() && self.mode == MODE_ENFORCED
    }
}

pub const MODE_ENFORCED: &str = "enforced";
pub const MODE_DEFAULT: &str = "default";

/// 可以改的欄位。/ The editable fields.
pub struct Fields<'a> {
    pub name: &'a str,
    pub url: &'a str,
    pub format: &'a str,
    pub language: &'a str,
    pub events: &'a str,
    pub all_tunnels: bool,
    pub delay: i64,
    pub enabled: bool,
    pub mode: &'a str,
}

const COLS: &str = "id, user_id, scope, name, url, format, language, events, all_tunnels, delay, secret, enabled, paused_reason, failures, \
    last_status, last_at, last_code, last_error, created_at, updated_at, headers, mode";

pub async fn create(db: &Db, user_id: Option<i64>, scope: &str, f: &Fields<'_>) -> sqlx::Result<WebhookRow> {
    let now = now_db();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO telepy_webhook (user_id, scope, name, url, format, language, events, all_tunnels, delay, enabled, mode, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(user_id)
    .bind(scope)
    .bind(f.name)
    .bind(f.url)
    .bind(f.format)
    .bind(f.language)
    .bind(f.events)
    .bind(f.all_tunnels)
    .bind(f.delay)
    .bind(f.enabled)
    .bind(f.mode)
    .bind(&now)
    .bind(&now)
    .fetch_one(&db.write)
    .await?;
    by_id(db, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// 改設定；重新啟用時清掉暫停原因與失敗次數。/ Update; re-enabling clears the pause and the failure count.
pub async fn update(db: &Db, id: i64, f: &Fields<'_>) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE telepy_webhook SET name = ?, url = ?, format = ?, language = ?, events = ?, all_tunnels = ?, delay = ?, \
            paused_reason = CASE WHEN ? = 1 THEN '' ELSE paused_reason END, \
            failures = CASE WHEN ? = 1 AND enabled = 0 THEN 0 ELSE failures END, \
            enabled = ?, mode = ?, updated_at = ? WHERE id = ?",
    )
    .bind(f.name)
    .bind(f.url)
    .bind(f.format)
    .bind(f.language)
    .bind(f.events)
    .bind(f.all_tunnels)
    .bind(f.delay)
    .bind(f.enabled)
    .bind(f.enabled)
    .bind(f.enabled)
    .bind(f.mode)
    .bind(now_db())
    .bind(id)
    .execute(&db.write)
    .await?;
    Ok(())
}

pub async fn by_id(db: &Db, id: i64) -> sqlx::Result<Option<WebhookRow>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_webhook WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<WebhookRow>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_webhook WHERE scope = 'user' AND user_id = ? ORDER BY id")).bind(user_id).fetch_all(&db.read).await
}

pub async fn site(db: &Db) -> sqlx::Result<Vec<WebhookRow>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_webhook WHERE scope = 'site' ORDER BY id")).fetch_all(&db.read).await
}

/// 會送的 webhook：開著的，而且個人的擁有者帳號還能用。/ Webhooks that deliver: enabled, and a personal one's owner is active.
pub async fn active(db: &Db) -> sqlx::Result<Vec<WebhookRow>> {
    let cols = COLS.split(", ").map(|c| format!("w.{c}")).collect::<Vec<_>>().join(", ");
    sqlx::query_as(&format!(
        "SELECT {cols} FROM telepy_webhook w LEFT JOIN auth_user u ON u.id = w.user_id \
         WHERE w.enabled = 1 AND (w.scope = 'site' OR u.is_active = 1) ORDER BY w.id"
    ))
    .fetch_all(&db.read)
    .await
}

pub async fn count_for_user(db: &Db, user_id: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM telepy_webhook WHERE scope = 'user' AND user_id = ?").bind(user_id).fetch_one(&db.read).await
}

pub async fn delete(db: &Db, id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM telepy_webhook_tunnel WHERE webhook_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_webhook_delivery WHERE webhook_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_webhook_optout WHERE webhook_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_webhook WHERE id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await
}

/// 每個 webhook 限定的隧道（只有 all_tunnels = 0 的才有）。/ The tunnels each limited webhook covers.
pub async fn tunnel_map(db: &Db) -> sqlx::Result<HashMap<i64, Vec<i64>>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as("SELECT webhook_id, tunnel_id FROM telepy_webhook_tunnel ORDER BY tunnel_id").fetch_all(&db.read).await?;
    let mut map: HashMap<i64, Vec<i64>> = HashMap::new();
    for (w, t) in rows {
        map.entry(w).or_default().push(t);
    }
    Ok(map)
}

pub async fn tunnels_of(db: &Db, webhook_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar("SELECT tunnel_id FROM telepy_webhook_tunnel WHERE webhook_id = ? ORDER BY tunnel_id").bind(webhook_id).fetch_all(&db.read).await
}

pub async fn set_tunnels(db: &Db, webhook_id: i64, tunnel_ids: &[i64]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM telepy_webhook_tunnel WHERE webhook_id = ?").bind(webhook_id).execute(&mut *tx).await?;
    for t in tunnel_ids {
        sqlx::query("INSERT OR IGNORE INTO telepy_webhook_tunnel (webhook_id, tunnel_id) VALUES (?, ?)").bind(webhook_id).bind(t).execute(&mut *tx).await?;
    }
    tx.commit().await
}

/// 隧道刪了：從每個 webhook 的限定清單拿掉。/ A deleted tunnel leaves every webhook's list.
pub async fn forget_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_webhook_tunnel WHERE tunnel_id = ?").bind(tunnel_id).execute(&db.write).await?;
    sqlx::query("DELETE FROM telepy_webhook_optout WHERE tunnel_id = ?").bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}

/// 一筆退出：哪條隧道、誰退的、什麼時候。/ One opt-out: which tunnel, who, when.
#[derive(Debug, Clone, FromRow)]
pub struct OptOut {
    pub webhook_id: i64,
    pub user_id: i64,
    pub tunnel_id: i64,
    pub created_at: String,
}

/// 每個 webhook 的退出（依隧道排序）。/ Every webhook's opt-outs, by tunnel.
pub async fn optout_map(db: &Db) -> sqlx::Result<HashMap<i64, Vec<OptOut>>> {
    let rows: Vec<OptOut> = sqlx::query_as("SELECT webhook_id, user_id, tunnel_id, created_at FROM telepy_webhook_optout ORDER BY tunnel_id, user_id").fetch_all(&db.read).await?;
    let mut map: HashMap<i64, Vec<OptOut>> = HashMap::new();
    for r in rows {
        map.entry(r.webhook_id).or_default().push(r);
    }
    Ok(map)
}

/// 換掉某人對某個 webhook 的退出清單。回傳 (新加的, 拿掉的) 隧道。
/// Replace one person's opt-outs for one webhook. Returns the tunnels (added, removed).
pub async fn set_optouts(db: &Db, webhook_id: i64, user_id: i64, tunnel_ids: &[i64]) -> sqlx::Result<(Vec<i64>, Vec<i64>)> {
    let mut tx = db.write.begin().await?;
    let before: Vec<i64> = sqlx::query_scalar("SELECT tunnel_id FROM telepy_webhook_optout WHERE webhook_id = ? AND user_id = ?")
        .bind(webhook_id)
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;
    let removed: Vec<i64> = before.iter().copied().filter(|t| !tunnel_ids.contains(t)).collect();
    let added: Vec<i64> = tunnel_ids.iter().copied().filter(|t| !before.contains(t)).collect();
    for t in &removed {
        sqlx::query("DELETE FROM telepy_webhook_optout WHERE webhook_id = ? AND user_id = ? AND tunnel_id = ?").bind(webhook_id).bind(user_id).bind(t).execute(&mut *tx).await?;
    }
    let now = now_db();
    for t in &added {
        sqlx::query("INSERT OR IGNORE INTO telepy_webhook_optout (webhook_id, user_id, tunnel_id, created_at) VALUES (?, ?, ?, ?)")
            .bind(webhook_id)
            .bind(user_id)
            .bind(t)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok((added, removed))
}

/// 每條隧道現在的管理者（owner + 現在有效權限是 ADMIN 的分享對象）。/ Every tunnel's managers now (owner + ADMIN sharees in force).
pub async fn all_managers(db: &Db) -> sqlx::Result<HashMap<i64, Vec<i64>>> {
    let mut map: HashMap<i64, Vec<i64>> = HashMap::new();
    let owners: Vec<(i64, i64)> = sqlx::query_as("SELECT id, user_id FROM authorized_keys_reverseserverauthorizedkeys").fetch_all(&db.read).await?;
    for (t, u) in owners {
        map.entry(t).or_default().push(u);
    }
    let admins: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT tunnel_id, shared_with_id FROM tunnels_tunnelsharing WHERE \
         (CASE WHEN base_permission IS NOT NULL AND permission_until <= ? THEN base_permission ELSE permission_type END) = 'admin'",
    )
    .bind(now_db())
    .fetch_all(&db.read)
    .await?;
    for (t, u) in admins {
        map.entry(t).or_default().push(u);
    }
    Ok(map)
}

/// 一條隧道現在的管理者：owner + 現在有效權限是 ADMIN 的分享對象（暫時升級過期了就不算）。
/// A tunnel's managers now: the owner plus sharees whose permission in force is ADMIN (an ended raise doesn't count).
pub async fn tunnel_managers(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<i64>> {
    let owner: Option<i64> = sqlx::query_scalar("SELECT user_id FROM authorized_keys_reverseserverauthorizedkeys WHERE id = ?").bind(tunnel_id).fetch_optional(&db.read).await?;
    let mut ids: Vec<i64> = sqlx::query_scalar(
        "SELECT shared_with_id FROM tunnels_tunnelsharing WHERE tunnel_id = ? AND \
         (CASE WHEN base_permission IS NOT NULL AND permission_until <= ? THEN base_permission ELSE permission_type END) = 'admin'",
    )
    .bind(tunnel_id)
    .bind(now_db())
    .fetch_all(&db.read)
    .await?;
    ids.extend(owner);
    Ok(ids)
}

pub async fn set_headers(db: &Db, id: i64, sealed: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_webhook SET headers = ? WHERE id = ?").bind(sealed).bind(id).execute(&db.write).await?;
    Ok(())
}

pub async fn set_secret(db: &Db, id: i64, sealed: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_webhook SET secret = ? WHERE id = ?").bind(sealed).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 送完一則：記下結果。`count` = 這次算不算進連續失敗（測試送出不算）。回傳現在的連續失敗次數。
/// Record a delivery's outcome; `count` decides whether it counts toward consecutive failures (tests don't).
/// Returns the consecutive failures now.
pub async fn record_result(db: &Db, id: i64, ok: bool, code: Option<i64>, error: &str, count: bool) -> sqlx::Result<i64> {
    let failures: Option<i64> = sqlx::query_scalar(
        "UPDATE telepy_webhook SET last_status = ?, last_at = ?, last_code = ?, last_error = ?, \
            failures = CASE WHEN ? = 1 THEN 0 WHEN ? = 1 THEN failures + 1 ELSE failures END \
         WHERE id = ? RETURNING failures",
    )
    .bind(if ok { "ok" } else { "failed" })
    .bind(now_db())
    .bind(code)
    .bind(error)
    .bind(ok)
    .bind(count)
    .bind(id)
    .fetch_optional(&db.write)
    .await?;
    Ok(failures.unwrap_or(0))
}

/// 一直失敗：暫停（關掉並記原因）。回傳是不是這次才關的。/ Pause after repeated failures; true when this call paused it.
pub async fn pause(db: &Db, id: i64, reason: &str) -> sqlx::Result<bool> {
    let n = sqlx::query("UPDATE telepy_webhook SET enabled = 0, paused_reason = ?, updated_at = ? WHERE id = ? AND enabled = 1")
        .bind(reason)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?
        .rows_affected();
    Ok(n > 0)
}

#[derive(Debug, Clone, FromRow)]
pub struct DeliveryRow {
    pub id: i64,
    pub webhook_id: i64,
    pub event: String,
    pub message_id: String,
    pub at: String,
    pub status: String,
    pub http_status: Option<i64>,
    pub error: String,
    pub attempts: i64,
    pub duration_ms: i64,
    pub test: bool,
    pub body: String,
    /// 重送用的事件（種類、隧道、欄位、連結）；測試送出沒有。/ The event, for re-sending; empty for test sends.
    pub event_json: String,
    /// 重送的話，原本那一筆。/ For a re-send, the original delivery.
    pub redelivered_from: Option<i64>,
}

pub struct NewDelivery<'a> {
    pub webhook_id: i64,
    pub event: &'a str,
    pub message_id: &'a str,
    pub status: &'a str,
    pub http_status: Option<i64>,
    pub error: &'a str,
    pub attempts: i64,
    pub duration_ms: i64,
    pub test: bool,
    pub body: &'a str,
    pub event_json: &'a str,
    pub redelivered_from: Option<i64>,
}

/// 記一筆送出（送之前就記成 `sending`，送完再補結果），只留每個 webhook 最新的 [`DELIVERIES_KEPT`] 筆。回傳 id。
/// Record a delivery (as `sending` before it goes out, finished afterwards), keeping the latest per webhook.
pub async fn insert_delivery(db: &Db, d: &NewDelivery<'_>) -> sqlx::Result<i64> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO telepy_webhook_delivery (webhook_id, event, message_id, at, status, http_status, error, attempts, duration_ms, test, body, event_json, redelivered_from) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(d.webhook_id)
    .bind(d.event)
    .bind(d.message_id)
    .bind(now_db())
    .bind(d.status)
    .bind(d.http_status)
    .bind(d.error)
    .bind(d.attempts)
    .bind(d.duration_ms)
    .bind(d.test)
    .bind(d.body)
    .bind(d.event_json)
    .bind(d.redelivered_from)
    .fetch_one(&db.write)
    .await?;
    sqlx::query(
        "DELETE FROM telepy_webhook_delivery WHERE webhook_id = ? AND id NOT IN \
         (SELECT id FROM telepy_webhook_delivery WHERE webhook_id = ? ORDER BY id DESC LIMIT ?)",
    )
    .bind(d.webhook_id)
    .bind(d.webhook_id)
    .bind(DELIVERIES_KEPT)
    .execute(&db.write)
    .await?;
    Ok(id)
}

/// 送完了：補上結果。/ A delivery finished: fill in the outcome.
#[allow(clippy::too_many_arguments)]
pub async fn finish_delivery(db: &Db, id: i64, status: &str, http_status: Option<i64>, error: &str, attempts: i64, duration_ms: i64, body: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_webhook_delivery SET status = ?, http_status = ?, error = ?, attempts = ?, duration_ms = ?, body = ? WHERE id = ?")
        .bind(status)
        .bind(http_status)
        .bind(error)
        .bind(attempts)
        .bind(duration_ms)
        .bind(body)
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 啟動時：上次沒送完的（重試還在等就重啟了）記成失敗，之後可以重送。
/// At startup: deliveries the last run didn't finish (restarted while retrying) become failed and can be re-sent.
pub async fn fail_unfinished(db: &Db) -> sqlx::Result<u64> {
    Ok(sqlx::query("UPDATE telepy_webhook_delivery SET status = 'failed', error = 'Telepy restarted before this was delivered.' WHERE status = 'sending'")
        .execute(&db.write)
        .await?
        .rows_affected())
}

const D_COLS: &str = "id, webhook_id, event, message_id, at, status, http_status, error, attempts, duration_ms, test, body, event_json, redelivered_from";

pub async fn deliveries(db: &Db, webhook_id: i64) -> sqlx::Result<Vec<DeliveryRow>> {
    sqlx::query_as(&format!("SELECT {D_COLS} FROM telepy_webhook_delivery WHERE webhook_id = ? ORDER BY id DESC LIMIT ?"))
        .bind(webhook_id)
        .bind(DELIVERIES_KEPT)
        .fetch_all(&db.read)
        .await
}

pub async fn delivery(db: &Db, webhook_id: i64, id: i64) -> sqlx::Result<Option<DeliveryRow>> {
    sqlx::query_as(&format!("SELECT {D_COLS} FROM telepy_webhook_delivery WHERE webhook_id = ? AND id = ?")).bind(webhook_id).bind(id).fetch_optional(&db.read).await
}

/// 有到期時間的個人金鑰：(id, 擁有者, 名稱, 公鑰, 到期)。/ Personal keys with an expiry: (id, owner, name, key, expires_at).
pub async fn expiring_keys(db: &Db) -> sqlx::Result<Vec<(i64, i64, String, String, String)>> {
    sqlx::query_as(
        "SELECT k.id, k.user_id, k.host_friendly_name, k.key, k.expires_at FROM authorized_keys_userauthorizedkeys k \
         JOIN auth_user u ON u.id = k.user_id WHERE k.expires_at IS NOT NULL AND u.is_active = 1 ORDER BY k.id",
    )
    .fetch_all(&db.read)
    .await
}

/// 這把金鑰在這個到期時間的這個階段通知過了嗎（續期 = 到期時間變了 = 重新算）。
/// Whether this stage was already sent for this key at this expiry (a renewal changes the expiry and re-arms it).
pub async fn expiry_notice_sent(db: &Db, key_id: i64, stage: &str, expires_at: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_key_expiry_notice WHERE key_id = ? AND stage = ? AND expires_at = ?")
        .bind(key_id)
        .bind(stage)
        .bind(expires_at)
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
}

pub async fn mark_expiry_notice(db: &Db, key_id: i64, stage: &str, expires_at: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO telepy_key_expiry_notice (key_id, stage, expires_at, sent_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (key_id, stage) DO UPDATE SET expires_at = excluded.expires_at, sent_at = excluded.sent_at",
    )
    .bind(key_id)
    .bind(stage)
    .bind(expires_at)
    .bind(now_db())
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 刪掉的金鑰不必再記。/ Forget notices of deleted keys.
pub async fn prune_expiry_notices(db: &Db) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_key_expiry_notice WHERE key_id NOT IN (SELECT id FROM authorized_keys_userauthorizedkeys)").execute(&db.write).await?;
    Ok(())
}
