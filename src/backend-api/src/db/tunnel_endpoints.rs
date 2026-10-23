//! 每條隧道最後一次是從哪個公網 IP 連上 gateway 的：一條隧道一列、每次覆寫，隧道刪除時一起刪。
//! 不從 `telepy_gateway_event` 推：那張表有列數上限，常斷線的裝置會把別條隧道的舊紀錄擠掉。
//! Last known public IP of each tunnel's device: one row per tunnel, overwritten on every connect and
//! deleted with the tunnel. Not derived from the capped event log, where a flapping device can push
//! other tunnels' rows out.

use std::collections::HashMap;

use sqlx::FromRow;

use super::Db;

#[derive(Debug, Clone, FromRow)]
pub struct LastEndpoint {
    pub tunnel_id: i64,
    pub ip: String,
    pub connected_at: String,
    pub last_seen_at: String,
    /// 上一次的 IP（最近一次換 IP 之前的）。/ The address before the latest change.
    pub previous_ip: Option<String>,
    pub changed_at: Option<String>,
}

/// 這次連線的 IP 跟上次不同。/ The device connected from a different address than last time.
#[derive(Debug, Clone, PartialEq)]
pub struct IpChange {
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub owner_id: i64,
    pub previous: String,
}

const E: &str = "telepy_tunnel_endpoint";
const T: &str = "authorized_keys_reverseserverauthorizedkeys";

/// forward 註冊好時：這個 port 的隧道現在從 `ip` 連進來（`at` = 連上的時間）。IP 跟上次不同時記下舊的
/// （`previous_ip` / `changed_at`）並回傳，給 gateway 發警示。第一次連線不算換。
/// Record the connection; when the address differs from last time, keep the old one and return the change.
pub async fn record_connected(db: &Db, port: u16, ip: &str, at: &str) -> sqlx::Result<Option<IpChange>> {
    let before: Option<(i64, String, String, i64)> = sqlx::query_as(&format!(
        "SELECT e.tunnel_id, e.ip, t.host_friendly_name, t.user_id FROM {E} e JOIN {T} t ON t.id = e.tunnel_id WHERE t.reverse_port = ?"
    ))
    .bind(port as i64)
    .fetch_optional(&db.read)
    .await?;
    // SET 右邊讀到的都是更新前的值（SQLite 語意），所以順序不影響。/ RHS values are the pre-update row in SQLite.
    sqlx::query(&format!(
        "INSERT INTO {E} (tunnel_id, ip, connected_at, last_seen_at) SELECT id, ?, ?, ? FROM {T} WHERE reverse_port = ? \
         ON CONFLICT(tunnel_id) DO UPDATE SET \
           previous_ip = CASE WHEN ip <> excluded.ip THEN ip ELSE previous_ip END, \
           changed_at = CASE WHEN ip <> excluded.ip THEN excluded.connected_at ELSE changed_at END, \
           ip = excluded.ip, connected_at = excluded.connected_at, last_seen_at = excluded.last_seen_at"
    ))
    .bind(ip)
    .bind(at)
    .bind(at)
    .bind(port as i64)
    .execute(&db.write)
    .await?;
    Ok(before
        .filter(|(_, previous, ..)| previous != ip)
        .map(|(tunnel_id, previous, tunnel_name, owner_id)| IpChange { tunnel_id, tunnel_name, owner_id, previous }))
}

/// forward 釋放時：最後一次看到它的時間。/ When the forward went away.
pub async fn record_released(db: &Db, port: u16, at: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {E} SET last_seen_at = ? WHERE tunnel_id IN (SELECT id FROM {T} WHERE reverse_port = ?)"))
        .bind(at)
        .bind(port as i64)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 看得到的隧道最後一次有連線活動的時間（DB 格式）：endpoint 表的 last_seen_at，加上 gateway 的 forward /
/// disconnect 事件（endpoint 表是 #121 才有的，更早連過的隧道只在事件裡）。有值 = 曾經連上過。
/// 只有時間、沒有 IP，所以給所有看得到隧道的人。
/// Last connection activity per visible tunnel: the endpoint row plus forward / disconnect events (the endpoint
/// table is newer than some tunnels). Present = the tunnel has connected at least once. Time only, no IP.
pub async fn last_seen_visible_to(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, String>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(&format!(
        "SELECT tunnel_id, MAX(at) FROM ( \
           SELECT tunnel_id, last_seen_at AS at FROM {E} \
           UNION ALL \
           SELECT tunnel_id, at FROM telepy_gateway_event WHERE event IN ('forward', 'disconnect') AND tunnel_id IS NOT NULL \
         ) WHERE tunnel_id IN (SELECT id FROM {T} WHERE user_id = ? UNION SELECT tunnel_id FROM tunnels_tunnelsharing WHERE shared_with_id = ?) \
         GROUP BY tunnel_id"
    ))
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().collect())
}

/// 使用者看得到的隧道（owned ∪ shared）的最後已知來源，以 tunnel id 為鍵。
pub async fn visible_to(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, LastEndpoint>> {
    let rows: Vec<LastEndpoint> = sqlx::query_as(&format!(
        "SELECT tunnel_id, ip, connected_at, last_seen_at, previous_ip, changed_at FROM {E} \
         WHERE tunnel_id IN (SELECT id FROM {T} WHERE user_id = ? UNION SELECT tunnel_id FROM tunnels_tunnelsharing WHERE shared_with_id = ?)"
    ))
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().map(|r| (r.tunnel_id, r)).collect())
}
