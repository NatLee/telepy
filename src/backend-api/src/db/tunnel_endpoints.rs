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
    /// 上一個公網 IP（最近一次換之前的）。/ The public address before the latest change.
    pub previous_ip: Option<String>,
    pub changed_at: Option<String>,
    /// 裝置真正的公網 IP：gateway 看到的（是公網位址時）或裝置經 `/api/whoami` 回報的。
    /// The device's real public IP: the gateway's peer when public, else what the device reported via /api/whoami.
    pub public_ip: Option<String>,
    /// gateway / device / lookup
    pub public_source: Option<String>,
    /// 裝置的內網網卡（JSON：`[{iface, ip, prefix}]`）。/ The device's LAN interfaces (JSON).
    pub lan: Option<String>,
    pub hostname: Option<String>,
    /// 最後一次登入裝置查位址的時間與錯誤。/ When the device was last asked for its addresses, and the error.
    pub probed_at: Option<String>,
    pub probe_error: Option<String>,
    /// 裝置的基本狀況（`device_facts::Facts` 的 JSON）與讀到的時間。/ Device facts (JSON) and when they were read.
    pub facts: Option<String>,
    pub facts_at: Option<String>,
    /// 最後一次怎麼連上 gateway：tcp（SSH port）或 websocket（網頁 port）；升級前的列為 NULL。
    /// How the device last reached the gateway: tcp (SSH port) or websocket (web port); NULL on older rows.
    pub transport: Option<String>,
}

/// 裝置的公網 IP 跟上次不同。/ The device's public address differs from last time.
#[derive(Debug, Clone, PartialEq)]
pub struct IpChange {
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub owner_id: i64,
    pub previous: String,
}

const E: &str = "telepy_tunnel_endpoint";
const T: &str = "authorized_keys_reverseserverauthorizedkeys";
const COLUMNS: &str = "tunnel_id, ip, connected_at, last_seen_at, previous_ip, changed_at, public_ip, public_source, lan, hostname, probed_at, probe_error, facts, facts_at, transport";

/// forward 註冊好時：這個 port 的隧道現在從 `ip`（gateway 看到的 TCP 來源）連進來，`at` = 連上的時間。
/// 公網 IP 與換 IP 的判斷在 [`update_public_ip`]（gateway 看到的可能是代理 / Docker 的內部位址）。
/// Record the connection (the gateway's TCP peer). Public-IP tracking and change detection live in
/// [`update_public_ip`], since the peer may be a proxy's or Docker's internal address.
pub async fn record_connected(db: &Db, port: u16, ip: &str, at: &str, transport: &str) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "INSERT INTO {E} (tunnel_id, ip, connected_at, last_seen_at, transport) SELECT id, ?, ?, ?, ? FROM {T} WHERE reverse_port = ? \
         ON CONFLICT(tunnel_id) DO UPDATE SET ip = excluded.ip, connected_at = excluded.connected_at, last_seen_at = excluded.last_seen_at, \
         transport = excluded.transport"
    ))
    .bind(ip)
    .bind(at)
    .bind(at)
    .bind(transport)
    .bind(port as i64)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 記下裝置的公網 IP（`source` = gateway / device / lookup）。跟上次不同時保留舊的（`previous_ip` / `changed_at`）並回傳，
/// 給 gateway 發警示；第一次不算換。SET 右邊讀到的都是更新前的值（SQLite 語意）。
/// Store the device's public IP; when it differs from the stored one, keep the old one and return the change.
pub async fn update_public_ip(db: &Db, tunnel_id: i64, ip: &str, source: &str, at: &str) -> sqlx::Result<Option<IpChange>> {
    let before: Option<(Option<String>, String, i64)> = sqlx::query_as(&format!(
        "SELECT e.public_ip, t.host_friendly_name, t.user_id FROM {E} e JOIN {T} t ON t.id = e.tunnel_id WHERE e.tunnel_id = ?"
    ))
    .bind(tunnel_id)
    .fetch_optional(&db.read)
    .await?;
    sqlx::query(&format!(
        "UPDATE {E} SET \
           previous_ip = CASE WHEN public_ip IS NOT NULL AND public_ip <> ? THEN public_ip ELSE previous_ip END, \
           changed_at = CASE WHEN public_ip IS NOT NULL AND public_ip <> ? THEN ? ELSE changed_at END, \
           public_ip = ?, public_source = ? WHERE tunnel_id = ?"
    ))
    .bind(ip)
    .bind(ip)
    .bind(at)
    .bind(ip)
    .bind(source)
    .bind(tunnel_id)
    .execute(&db.write)
    .await?;
    Ok(before.and_then(|(previous, tunnel_name, owner_id)| {
        previous.filter(|p| p != ip).map(|previous| IpChange { tunnel_id, tunnel_name, owner_id, previous })
    }))
}

/// 登入裝置查到的位址（hostname、內網網卡 JSON）、基本狀況（facts JSON）與錯誤；沒拿到的欄位保留舊值。
/// What the device reported (hostname, LAN JSON, facts JSON), or why asking failed; missing values keep the old ones.
pub async fn record_probe(db: &Db, tunnel_id: i64, hostname: Option<&str>, lan: Option<&str>, facts: Option<&str>, error: Option<&str>, at: &str) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "UPDATE {E} SET hostname = COALESCE(?, hostname), lan = COALESCE(?, lan), \
         facts_at = CASE WHEN ? IS NOT NULL THEN ? ELSE facts_at END, facts = COALESCE(?, facts), \
         probe_error = ?, probed_at = ? WHERE tunnel_id = ?"
    ))
        .bind(hostname)
        .bind(lan)
        .bind(facts)
        .bind(at)
        .bind(facts)
        .bind(error)
        .bind(at)
        .bind(tunnel_id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 該再問一次位址的隧道（還沒在這次連線問過，或上次問是 `stale_before` 之前）：(tunnel_id, reverse_port)。
/// Tunnels due for an address probe: never asked during the current connection, or asked before `stale_before`.
pub async fn probe_due(db: &Db, stale_before: &str) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!(
        "SELECT t.id, t.reverse_port FROM {E} e JOIN {T} t ON t.id = e.tunnel_id \
         WHERE e.probed_at IS NULL OR e.probed_at < e.connected_at OR e.probed_at < ?"
    ))
    .bind(stale_before)
    .fetch_all(&db.read)
    .await
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
        "SELECT {COLUMNS} FROM {E} \
         WHERE tunnel_id IN (SELECT id FROM {T} WHERE user_id = ? UNION SELECT tunnel_id FROM tunnels_tunnelsharing WHERE shared_with_id = ?)"
    ))
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().map(|r| (r.tunnel_id, r)).collect())
}

/// 一條隧道的最後紀錄（單筆 retrieve、立即重新整理、MCP 用）。/ One tunnel's row.
pub async fn of_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Option<LastEndpoint>> {
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM {E} WHERE tunnel_id = ?")).bind(tunnel_id).fetch_optional(&db.read).await
}
