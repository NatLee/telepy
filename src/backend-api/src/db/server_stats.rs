//! 伺服器狀態頁的統計（`GET /api/site/health/stats`）：便宜的計數與 24 小時分桶，全部走 read pool。
//! Counts and 24-hour buckets for the server stats endpoint; every query uses the read pool.
//!
//! 分桶：`(unixepoch(at) − start) / 3600`，只看 `start ≤ at < end`（`at` 有索引，字串比較即時間比較）。
//! Buckets are `(unix(at) − start) / 3600` over `start ≤ at < end` (`at` is indexed; strings compare as times).

use std::collections::HashSet;

use super::Db;

/// 一列分桶結果：(桶號, 全部, 其中「有問題」的)。/ One bucket row: (index, all, the flagged part).
pub type BucketRow = (i64, i64, i64);

fn bucket_expr() -> &'static str {
    "(CAST(strftime('%s', at) AS INTEGER) - ?) / 3600"
}

/// 閘道事件：每小時的數量與其中 `problems` 種類的數量。/ Gateway events per hour, and those of the given kinds.
pub async fn gateway_buckets(db: &Db, start: &str, end: &str, start_unix: i64, problems: &[&str]) -> sqlx::Result<Vec<BucketRow>> {
    // 種類是程式內的常數（只有小寫字母與底線），直接組進 SQL。/ Kinds are code constants ([a-z_]), inlined.
    let list = problems.iter().filter(|k| k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')).map(|k| format!("'{k}'")).collect::<Vec<_>>().join(",");
    let list = if list.is_empty() { "''".to_string() } else { list };
    sqlx::query_as(&format!(
        "SELECT {b} AS bucket, COUNT(*), COALESCE(SUM(event IN ({list})), 0) FROM telepy_gateway_event \
         WHERE at >= ? AND at < ? GROUP BY bucket",
        b = bucket_expr()
    ))
    .bind(start_unix)
    .bind(start)
    .bind(end)
    .fetch_all(&db.read)
    .await
}

/// 登入嘗試：每小時的數量與失敗的數量。/ Sign-in attempts per hour, and the failed ones.
pub async fn sign_in_buckets(db: &Db, start: &str, end: &str, start_unix: i64) -> sqlx::Result<Vec<BucketRow>> {
    sqlx::query_as(&format!(
        "SELECT {b} AS bucket, COUNT(*), COALESCE(SUM(ok = 0), 0) FROM telepy_sign_in_event \
         WHERE at >= ? AND at < ? GROUP BY bucket",
        b = bucket_expr()
    ))
    .bind(start_unix)
    .bind(start)
    .bind(end)
    .fetch_all(&db.read)
    .await
}

/// 委派 token 的 API 呼叫：每小時的數量與錯誤（狀態 ≥ 400 或有 error）。/ API calls per hour, and the errors.
pub async fn api_call_buckets(db: &Db, start: &str, end: &str, start_unix: i64) -> sqlx::Result<Vec<BucketRow>> {
    sqlx::query_as(&format!(
        "SELECT {b} AS bucket, COUNT(*), COALESCE(SUM(status >= 400 OR error IS NOT NULL), 0) FROM telepy_api_call \
         WHERE at >= ? AND at < ? GROUP BY bucket",
        b = bucket_expr()
    ))
    .bind(start_unix)
    .bind(start)
    .bind(end)
    .fetch_all(&db.read)
    .await
}

/// 帳號：(全部, 啟用中, 啟用中的管理員, `since` 之後成功登入過的不同帳號)。
/// Accounts: (all, active, active superusers, distinct accounts with a successful sign-in since `since`).
pub async fn users(db: &Db, since: &str) -> sqlx::Result<(i64, i64, i64, i64)> {
    let (total, active, admins): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(is_active), 0), COALESCE(SUM(is_active AND is_superuser), 0) FROM auth_user",
    )
    .fetch_one(&db.read)
    .await?;
    let signed_in: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT user_id) FROM telepy_sign_in_event WHERE ok = 1 AND at >= ?")
        .bind(since)
        .fetch_one(&db.read)
        .await?;
    Ok((total, active, admins, signed_in))
}

/// 曾經連上過的隧道（與列表的 `health` 同一個來源：endpoint 表 ∪ forward / disconnect 事件）。
/// Tunnels that ever connected (the list's `health` source: the endpoint table ∪ forward / disconnect events).
pub async fn ever_connected(db: &Db) -> sqlx::Result<HashSet<i64>> {
    let rows: Vec<i64> = sqlx::query_scalar(
        "SELECT tunnel_id FROM telepy_tunnel_endpoint \
         UNION SELECT tunnel_id FROM telepy_gateway_event WHERE event IN ('forward', 'disconnect') AND tunnel_id IS NOT NULL",
    )
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().collect())
}

/// 每條隧道的 (id, reverse_port)。/ Every tunnel's (id, reverse_port).
pub async fn tunnel_ports(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as("SELECT id, reverse_port FROM authorized_keys_reverseserverauthorizedkeys").fetch_all(&db.read).await
}

/// Webhook：(全部, 啟用中, 暫停中, `since` 之後有失敗送出（不含測試）的不同 webhook)。
/// Webhooks: (all, enabled, paused, distinct webhooks with a failed non-test delivery since `since`).
pub async fn webhooks(db: &Db, since: &str) -> sqlx::Result<(i64, i64, i64, i64)> {
    let (total, enabled, paused): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(enabled), 0), COALESCE(SUM(paused_reason <> ''), 0) FROM telepy_webhook",
    )
    .fetch_one(&db.read)
    .await?;
    let failing: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT webhook_id) FROM telepy_webhook_delivery WHERE status = 'failed' AND test = 0 AND at >= ?",
    )
    .bind(since)
    .fetch_one(&db.read)
    .await?;
    Ok((total, enabled, paused, failing))
}
