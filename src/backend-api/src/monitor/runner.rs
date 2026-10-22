//! `update_ports --loop` 的常駐迴圈：每 5s 取最新取樣 → 去彈跳 → 偵測狀態翻轉 → 推播；延遲另走節流廣播。
//! 通知的 action / payload 與 Django management command 完全相同。
//! The resident port-monitor loop (debounce, transition detection, notifications) ported from update_ports.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use serde_json::json;

use super::ports::{transitions, Debouncer, LatencyThrottle};
use crate::db::{self, tunnels::Tunnel};
use crate::presence;
use crate::state::AppState;

/// presence 變動的推播頻率（只是讀一個 set，很便宜）。/ How often presence changes are pushed.
const PRESENCE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct Runner {
    debouncer: Debouncer,
    throttle: LatencyThrottle,
}

pub async fn run(state: AppState, interval: Duration) {
    let mut runner = Runner::default();
    tracing::info!(interval = ?interval, "port monitor started");
    tokio::spawn(run_presence(state.clone()));
    loop {
        if let Err(e) = cycle(&state, &mut runner).await {
            tracing::warn!(error = %e, "port monitor cycle error");
        }
        tokio::time::sleep(interval).await;
    }
}

async fn run_presence(state: AppState) {
    loop {
        if let Err(e) = dispatch_presence(&state).await {
            tracing::warn!(error = %e, "presence dispatch error");
        }
        tokio::time::sleep(PRESENCE_INTERVAL).await;
    }
}

/// 有人開 / 關終端機、檔案管理…之後，告訴看得到這條隧道的人現在幾個人在用（`UPDATE-TUNNEL-PRESENCE`）。
/// 只帶人數：誰、從哪裡只給 owner / ADMIN / 管理員，由前端重抓列表拿。
/// Tell everyone who can see a tunnel how many people use it now; the details come with the list.
pub async fn dispatch_presence(state: &AppState) -> sqlx::Result<()> {
    let dirty = state.presence.take_dirty();
    if dirty.is_empty() {
        return Ok(());
    }
    let by_tunnel = state.presence.by_tunnel();
    for tunnel_id in dirty {
        let Some(t) = db::tunnels::by_id(&state.db, tunnel_id).await? else { continue };
        let mut users = vec![t.user_id];
        users.extend(db::sharing::sharee_ids(&state.db, t.id).await?);
        let count = by_tunnel.get(&tunnel_id).map(|e| presence::distinct_users(e)).unwrap_or(0);
        state.hub.notify_users(users, &json!({ "action": "UPDATE-TUNNEL-PRESENCE", "tunnel_id": tunnel_id, "count": count }));
    }
    Ok(())
}

/// 每個隧道的「可見使用者」（owner + sharees）。/ Audience per tunnel.
async fn audiences(state: &AppState, tunnels: &[Tunnel]) -> sqlx::Result<HashMap<i64, Vec<i64>>> {
    let mut map: HashMap<i64, Vec<i64>> = tunnels.iter().map(|t| (t.id, vec![t.user_id])).collect();
    for (tunnel_id, user_id) in db::sharing::all_pairs(&state.db).await? {
        map.entry(tunnel_id).or_default().push(user_id);
    }
    Ok(map)
}

pub async fn cycle(state: &AppState, runner: &mut Runner) -> sqlx::Result<()> {
    // 取樣不可用：本輪 no-op，不發假的離線通知。/ Sample unavailable: skip without false offline events.
    let Some(raw) = state.status.ports_status(&state.db).await? else {
        return Ok(());
    };
    let tunnels = db::tunnels::all(&state.db).await?;
    let audience = audiences(state, &tunnels).await?;

    // 延遲廣播刻意放在「狀態沒變就早退」之前。/ Latency runs before the no-change early return.
    if let Some(latency) = state.status.latency() {
        if runner.throttle.should_broadcast(&latency) {
            let mut user_latency: HashMap<i64, BTreeMap<String, f64>> = HashMap::new();
            for t in &tunnels {
                let Some(rtt) = u16::try_from(t.reverse_port).ok().and_then(|p| latency.get(&p).copied()) else { continue };
                state.hub.tunnel_update(t.id, &json!({
                    "type": "latency_update",
                    "tunnel_id": t.id,
                    "reverse_port": t.reverse_port,
                    "rtt_ms": rtt,
                }));
                // key 必須是字串（Django 版的 msgpack 教訓；JSON 這裡本來就是字串）。
                for uid in audience.get(&t.id).into_iter().flatten() {
                    user_latency.entry(*uid).or_default().insert(t.reverse_port.to_string(), rtt);
                }
            }
            for (uid, lat) in user_latency {
                state.hub.notify_user(uid, &json!({
                    "action": "UPDATE-TUNNEL-LATENCY",
                    "latency": lat,
                    "details": "Tunnel latency updated",
                }));
            }
        }
    }

    let previous = state.status.committed_ports();
    let now = runner.debouncer.apply(&raw, &previous);
    if now == previous {
        return Ok(());
    }

    // 個人化狀態快照：只含該使用者看得到、且目前 online 的 port。
    let mut user_ports: HashMap<i64, BTreeSet<i64>> = HashMap::new();
    for t in &tunnels {
        if now.get(&t.reverse_port).copied().unwrap_or(false) {
            for uid in audience.get(&t.id).into_iter().flatten() {
                user_ports.entry(*uid).or_default().insert(t.reverse_port);
            }
        }
    }
    for (uid, ports) in user_ports {
        state.hub.notify_user(uid, &json!({
            "action": "UPDATE-TUNNEL-STATUS-DATA",
            "data": ports.iter().collect::<Vec<_>>(),
            "details": "Reverse server status have been updated",
        }));
    }

    let tr = transitions(&previous, &now);
    for (ports, connected) in [(&tr.connected, true), (&tr.disconnected, false)] {
        for port in ports {
            let affected: Vec<&Tunnel> = tunnels.iter().filter(|t| t.reverse_port == *port).collect();
            let mut users: Vec<i64> = affected.iter().flat_map(|t| audience.get(&t.id).cloned().unwrap_or_default()).collect();
            users.sort_unstable();
            users.dedup();
            let (verb, status) = if connected { ("connected", "connected") } else { ("disconnected", "disconnected") };
            if !users.is_empty() {
                state.hub.notify_users(users, &json!({
                    "action": "UPDATE-TUNNEL-STATUS",
                    "details": format!("Tunnel on port [{port}] has been {verb}"),
                    "port": port,
                    "status": status,
                }));
            }
            for t in affected {
                state.hub.tunnel_update(t.id, &json!({
                    "type": "connection_status",
                    "tunnel_id": t.id,
                    "reverse_port": port,
                    "is_connected": connected,
                    "host_friendly_name": t.host_friendly_name,
                }));
            }
        }
    }
    tracing::info!(connected = ?tr.connected, disconnected = ?tr.disconnected, "ports status updated");
    state.status.set_committed(now);
    Ok(())
}
