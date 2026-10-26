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
}

impl WebhookRow {
    pub fn is_site(&self) -> bool {
        self.scope == "site"
    }
}

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
}

const COLS: &str = "id, user_id, scope, name, url, format, language, events, all_tunnels, delay, secret, enabled, paused_reason, failures, \
    last_status, last_at, last_code, last_error, created_at, updated_at";

pub async fn create(db: &Db, user_id: Option<i64>, scope: &str, f: &Fields<'_>) -> sqlx::Result<WebhookRow> {
    let now = now_db();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO telepy_webhook (user_id, scope, name, url, format, language, events, all_tunnels, delay, enabled, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
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
            enabled = ?, updated_at = ? WHERE id = ?",
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
}

/// 記一筆送出，只留每個 webhook 最新的 [`DELIVERIES_KEPT`] 筆。/ Record a delivery, keeping the latest per webhook.
pub async fn insert_delivery(db: &Db, d: &NewDelivery<'_>) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO telepy_webhook_delivery (webhook_id, event, message_id, at, status, http_status, error, attempts, duration_ms, test, body) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .execute(&db.write)
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
    Ok(())
}

pub async fn deliveries(db: &Db, webhook_id: i64) -> sqlx::Result<Vec<DeliveryRow>> {
    sqlx::query_as(
        "SELECT id, webhook_id, event, message_id, at, status, http_status, error, attempts, duration_ms, test, body \
         FROM telepy_webhook_delivery WHERE webhook_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(webhook_id)
    .bind(DELIVERIES_KEPT)
    .fetch_all(&db.read)
    .await
}
