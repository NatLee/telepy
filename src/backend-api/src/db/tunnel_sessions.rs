//! 隧道的連線紀錄：每次 forward 一列（來源 IP、連上 / 斷線時間），給詳細資訊的「連線紀錄」與 24 小時 / 7 天
//! 在線率。forward 註冊時開一列、釋放時關掉；後端重啟時把還開著的關掉（gateway 重啟等於全部斷線）。
//! 每條隧道留最近 [`KEEP_PER_TUNNEL`] 列，帶 IP 所以也跟著 90 天保留期（`db::retention`）。
//! Connection history per tunnel: one row per forward (source IP, connected / disconnected). Opened when a forward
//! registers, closed when it goes away; rows still open at startup are closed (a restart drops every forward).
//! The newest [`KEEP_PER_TUNNEL`] rows per tunnel are kept, and they carry IPs, so the 90-day retention applies.

use sqlx::FromRow;

use super::Db;
use crate::util::parse_db_datetime;

const S: &str = "telepy_tunnel_session";
const T: &str = "authorized_keys_reverseserverauthorizedkeys";
pub const KEEP_PER_TUNNEL: i64 = 500;

#[derive(Debug, Clone, FromRow)]
pub struct SessionRow {
    pub ip: String,
    pub connected_at: String,
    pub disconnected_at: Option<String>,
}

/// forward 註冊好：先把這條隧道還開著的關掉（新的 forward 代表舊的已經結束），再開一列。
/// A forward registered: close whatever is still open for the tunnel, then open a row.
pub async fn open(db: &Db, port: u16, ip: &str, at: &str) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("UPDATE {S} SET disconnected_at = ? WHERE disconnected_at IS NULL AND tunnel_id IN (SELECT id FROM {T} WHERE reverse_port = ?)"))
        .bind(at)
        .bind(port as i64)
        .execute(&mut *tx)
        .await?;
    sqlx::query(&format!("INSERT INTO {S} (tunnel_id, ip, connected_at) SELECT id, ?, ? FROM {T} WHERE reverse_port = ?"))
        .bind(ip)
        .bind(at)
        .bind(port as i64)
        .execute(&mut *tx)
        .await?;
    sqlx::query(&format!(
        "DELETE FROM {S} WHERE tunnel_id IN (SELECT id FROM {T} WHERE reverse_port = ?) \
         AND id NOT IN (SELECT s.id FROM {S} s JOIN {T} t ON t.id = s.tunnel_id WHERE t.reverse_port = ? ORDER BY s.id DESC LIMIT {KEEP_PER_TUNNEL})"
    ))
    .bind(port as i64)
    .bind(port as i64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// forward 釋放。/ The forward went away.
pub async fn close(db: &Db, port: u16, at: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {S} SET disconnected_at = ? WHERE disconnected_at IS NULL AND tunnel_id IN (SELECT id FROM {T} WHERE reverse_port = ?)"))
        .bind(at)
        .bind(port as i64)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 啟動時：還開著的都關掉（用它們最後一次被看到的時間：endpoint 表的 last_seen_at，沒有就用連上的時間）。
/// At startup, close rows left open, at the tunnel's last-seen time (or their own start when unknown).
pub async fn close_orphans(db: &Db) -> sqlx::Result<u64> {
    let n = sqlx::query(&format!(
        "UPDATE {S} SET disconnected_at = COALESCE( \
           (SELECT MAX(e.last_seen_at, {S}.connected_at) FROM telepy_tunnel_endpoint e WHERE e.tunnel_id = {S}.tunnel_id), \
           connected_at) \
         WHERE disconnected_at IS NULL"
    ))
    .execute(&db.write)
    .await?
    .rows_affected();
    Ok(n)
}

/// 和 `[since, now]` 有重疊的連線（舊到新）。/ Sessions overlapping `[since, now]`, oldest first.
pub async fn overlapping(db: &Db, tunnel_id: i64, since: &str) -> sqlx::Result<Vec<SessionRow>> {
    sqlx::query_as(&format!(
        "SELECT ip, connected_at, disconnected_at FROM {S} WHERE tunnel_id = ? AND (disconnected_at IS NULL OR disconnected_at >= ?) ORDER BY connected_at"
    ))
    .bind(tunnel_id)
    .bind(since)
    .fetch_all(&db.read)
    .await
}

/// 最近幾次連線（新到舊）。/ The latest sessions, newest first.
pub async fn recent(db: &Db, tunnel_id: i64, limit: i64) -> sqlx::Result<Vec<SessionRow>> {
    sqlx::query_as(&format!("SELECT ip, connected_at, disconnected_at FROM {S} WHERE tunnel_id = ? ORDER BY connected_at DESC LIMIT ?"))
        .bind(tunnel_id)
        .bind(limit)
        .fetch_all(&db.read)
        .await
}

/// 第一筆紀錄的時間（從這時候起才有資料）。/ When the history begins.
pub async fn first_seen(db: &Db, tunnel_id: i64) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(&format!("SELECT MIN(connected_at) FROM {S} WHERE tunnel_id = ?")).bind(tunnel_id).fetch_one(&db.read).await
}

pub async fn delete_for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {S} WHERE tunnel_id = ?")).bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}

/// 在線率摘要：24 小時 / 7 天，以及最近 24 小時每小時一格。資料從第一筆紀錄開始算（之前沒有資料，不算離線）。
/// Uptime summary: 24 h, 7 days and the last 24 hours hour by hour, counted from the first recorded session.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub tracked_since: Option<String>,
    pub h24: Option<f64>,
    pub d7: Option<f64>,
    pub hourly: Vec<Option<f64>>,
}

pub async fn summary(db: &Db, tunnel_id: i64) -> sqlx::Result<Summary> {
    let now = chrono::Utc::now();
    let since = crate::util::db_time(now - chrono::Duration::days(7));
    let rows = overlapping(db, tunnel_id, &since).await?;
    let first = first_seen(db, tunnel_id).await?;
    let now = now.timestamp();
    let Some(start) = first.as_deref().and_then(unix) else {
        return Ok(Summary { tracked_since: None, h24: None, d7: None, hourly: vec![None; 24] });
    };
    let sp = spans(&rows, now);
    Ok(Summary {
        tracked_since: first,
        h24: uptime(&sp, start, now - 86_400, now),
        d7: uptime(&sp, start, now - 7 * 86_400, now),
        hourly: buckets(&sp, start, now, 24, 3_600),
    })
}

// ---------------------------------------------------------------- pure: uptime

/// DB 時間 → Unix 秒。/ DB time → Unix seconds.
pub fn unix(s: &str) -> Option<i64> {
    parse_db_datetime(s).map(|d| d.and_utc().timestamp())
}

/// 連線紀錄 → `(start, end)` 秒區間；還開著的到 `now`。/ Rows → `(start, end)` spans; open rows end at `now`.
pub fn spans(rows: &[SessionRow], now: i64) -> Vec<(i64, i64)> {
    rows.iter()
        .filter_map(|r| {
            let start = unix(&r.connected_at)?;
            let end = r.disconnected_at.as_deref().and_then(unix).unwrap_or(now);
            (end > start).then_some((start, end))
        })
        .collect()
}

/// `[from, to)` 裡有幾秒被這些區間蓋到（重疊的只算一次）。/ Seconds of `[from, to)` covered, overlaps counted once.
pub fn covered(spans: &[(i64, i64)], from: i64, to: i64) -> i64 {
    let mut clipped: Vec<(i64, i64)> = spans.iter().map(|&(s, e)| (s.max(from), e.min(to))).filter(|(s, e)| e > s).collect();
    clipped.sort_unstable();
    let (mut total, mut cur): (i64, Option<(i64, i64)>) = (0, None);
    for (s, e) in clipped {
        cur = match cur {
            Some((cs, ce)) if s <= ce => Some((cs, ce.max(e))),
            Some((cs, ce)) => {
                total += ce - cs;
                Some((s, e))
            }
            None => Some((s, e)),
        };
    }
    total + cur.map(|(s, e)| e - s).unwrap_or(0)
}

/// 在線率：`[from, to)` 裡 `start` 之後的部分（之前沒有資料，不算離線）。沒有可算的時間就 None。
/// Uptime over `[from, to)`, counting only from `start` (before it there is no data, not downtime).
pub fn uptime(spans: &[(i64, i64)], start: i64, from: i64, to: i64) -> Option<f64> {
    let from = from.max(start);
    (to > from).then(|| covered(spans, from, to) as f64 / (to - from) as f64)
}

/// `[to - n*size, to)` 切成 n 格，每格的在線率；`start` 之前的格子是 None。
/// Uptime per bucket over the last `n * size` seconds; buckets entirely before `start` are None.
pub fn buckets(spans: &[(i64, i64)], start: i64, to: i64, n: usize, size: i64) -> Vec<Option<f64>> {
    (0..n as i64)
        .map(|i| {
            let from = to - (n as i64 - i) * size;
            uptime(spans, start, from, from + size)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_merges_overlaps_and_clips() {
        assert_eq!(covered(&[(0, 10), (5, 20), (30, 40)], 0, 100), 30);
        assert_eq!(covered(&[(0, 10), (5, 20)], 8, 15), 7);
        assert_eq!(covered(&[], 0, 100), 0);
        assert_eq!(covered(&[(50, 60)], 0, 40), 0);
    }

    #[test]
    fn uptime_ignores_time_before_the_history_starts() {
        // history starts at 50; up 50..75 → half of 50..100
        assert_eq!(uptime(&[(50, 75)], 50, 0, 100), Some(0.5));
        assert_eq!(uptime(&[(0, 100)], 0, 0, 100), Some(1.0));
        assert_eq!(uptime(&[], 200, 0, 100), None, "no data in the window");
    }

    #[test]
    fn buckets_mark_the_time_before_data_as_unknown() {
        // data starts at 150, up until 250; the bucket that straddles the start counts only 150..200
        let b = buckets(&[(150, 250)], 150, 400, 4, 100);
        assert_eq!(b, vec![None, Some(1.0), Some(0.5), Some(0.0)]);
    }

    #[test]
    fn open_rows_run_until_now() {
        let rows = vec![
            SessionRow { ip: "a".into(), connected_at: "1970-01-01 00:00:10".into(), disconnected_at: Some("1970-01-01 00:00:20".into()) },
            SessionRow { ip: "b".into(), connected_at: "1970-01-01 00:00:30".into(), disconnected_at: None },
        ];
        assert_eq!(spans(&rows, 50), vec![(10, 20), (30, 50)]);
    }
}
