//! Django signals / view 內的通知呼叫，集中成幾個 helper。
//! Notification helpers mirroring the Django signals and in-view `send_notification_to_*` calls.

use serde_json::json;

use crate::db::{self, tunnels::Tunnel};
use crate::state::AppState;

/// owner + 所有被分享者。/ Owner plus every sharee.
pub async fn tunnel_audience(state: &AppState, tunnel: &Tunnel) -> sqlx::Result<Vec<i64>> {
    let mut ids = vec![tunnel.user_id];
    ids.extend(db::sharing::sharee_ids(&state.db, tunnel.id).await?);
    Ok(ids)
}

/// `notify_reverse_server_authorized_keys_changed`（post_save / post_delete signal）。
pub async fn tunnel_updated(state: &AppState, tunnel: &Tunnel) -> sqlx::Result<()> {
    let audience = tunnel_audience(state, tunnel).await?;
    state.hub.notify_users(
        audience,
        &json!({
            "action": "UPDATED-TUNNELS",
            "details": format!("Tunnel '{}' has been updated", tunnel.host_friendly_name),
            "tunnel_id": tunnel.id,
        }),
    );
    Ok(())
}

/// `_notify_tunnel_users(tunnel, action, details)`
pub async fn tunnel_users(state: &AppState, tunnel: &Tunnel, action: &str, details: &str) -> sqlx::Result<()> {
    let audience = tunnel_audience(state, tunnel).await?;
    state.hub.notify_users(audience, &json!({ "action": action, "details": details, "tunnel_id": tunnel.id }));
    Ok(())
}
