//! `/ws/tunnel_connection/{id}/`：建立精靈/終端機頁的單一隧道即時狀態（TunnelConnectionConsumer）。
//! 連上即送一次 `connection_status`，之後轉送 hub 的 `connection_status` / `latency_update`。

use axum::extract::ws::{Message, WebSocket};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use super::{auth, close, is_ping, send_json, send_text};
use crate::db;
use crate::state::AppState;

pub async fn handle(state: AppState, mut socket: WebSocket, route_tunnel_id: String) {
    let (user, msg, mut signout) = match auth::first_message(&state, &mut socket).await {
        Ok(v) => v,
        Err(0) => return,
        Err(code) => {
            close(&mut socket, code).await;
            return;
        }
    };
    let tunnel_id = auth::id_field(&msg, "tunnel_id").unwrap_or(route_tunnel_id);
    let Ok(tunnel_id) = tunnel_id.parse::<i64>() else {
        close(&mut socket, 4000).await;
        return;
    };
    tracing::info!(user = %user.username, tunnel_id, "[TunnelConnection] User authenticated");

    // owner 或任何分享（不看等級）。/ Owner or any sharing record.
    let tunnel = match db::tunnels::by_id(&state.db, tunnel_id).await {
        Ok(Some(t)) => t,
        _ => {
            close(&mut socket, 4004).await;
            return;
        }
    };
    let allowed = tunnel.user_id == user.id
        || matches!(db::sharing::get(&state.db, tunnel.id, user.id).await, Ok(Some(_)));
    if !allowed {
        tracing::warn!(user = %user.username, tunnel_id, "[TunnelConnection] no access");
        close(&mut socket, 4004).await;
        return;
    }

    let mut rx = state.hub.subscribe_tunnel(tunnel.id);

    // 首屏狀態：已承認的 online/offline + 最新 RTT。/ Initial status from the committed map.
    let committed = state.status.committed_ports();
    let latency = state.status.latency().unwrap_or_default();
    let rtt = u16::try_from(tunnel.reverse_port).ok().and_then(|p| latency.get(&p).copied());
    let initial = json!({
        "type": "connection_status",
        "tunnel_id": tunnel.id,
        "reverse_port": tunnel.reverse_port,
        "is_connected": committed.get(&tunnel.reverse_port).copied().unwrap_or(false),
        "host_friendly_name": tunnel.host_friendly_name,
        "rtt_ms": rtt,
    });
    if !send_json(&mut socket, &initial).await {
        return;
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if is_ping(&t) && !send_json(&mut socket, &json!({"type": "pong"})).await {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            // 這個瀏覽器的登入被撤銷了（別的裝置、管理員）。/ This browser's sign-in was revoked.
            reason = signout.ended() => {
                super::close_with(&mut socket, auth::CLOSE_SIGNED_OUT, &reason).await;
                break;
            }
            event = rx.recv() => match event {
                Ok(text) => {
                    if !send_text(&mut socket, text.to_string()).await {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => break,
            },
        }
    }
}
