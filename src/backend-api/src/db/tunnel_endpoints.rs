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
}

const E: &str = "telepy_tunnel_endpoint";
const T: &str = "authorized_keys_reverseserverauthorizedkeys";

/// forward 註冊好時：這個 port 的隧道現在從 `ip` 連進來（`at` = 連上的時間）。
pub async fn record_connected(db: &Db, port: u16, ip: &str, at: &str) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "INSERT INTO {E} (tunnel_id, ip, connected_at, last_seen_at) SELECT id, ?, ?, ? FROM {T} WHERE reverse_port = ? \
         ON CONFLICT(tunnel_id) DO UPDATE SET ip = excluded.ip, connected_at = excluded.connected_at, last_seen_at = excluded.last_seen_at"
    ))
    .bind(ip)
    .bind(at)
    .bind(at)
    .bind(port as i64)
    .execute(&db.write)
    .await?;
    Ok(())
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

/// 使用者看得到的隧道（owned ∪ shared）的最後已知來源，以 tunnel id 為鍵。
pub async fn visible_to(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, LastEndpoint>> {
    let rows: Vec<LastEndpoint> = sqlx::query_as(&format!(
        "SELECT tunnel_id, ip, connected_at, last_seen_at FROM {E} \
         WHERE tunnel_id IN (SELECT id FROM {T} WHERE user_id = ? UNION SELECT tunnel_id FROM tunnels_tunnelsharing WHERE shared_with_id = ?)"
    ))
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().map(|r| (r.tunnel_id, r)).collect())
}
