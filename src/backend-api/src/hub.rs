//! Process 內的通知匯流排，取代 channels_redis 的 channel layer。
//! - `user_{id}_notifications` 群組 → `users` map（NotificationConsumer）
//! - `tunnel_connection_{id}` 群組 → `tunnels` map（TunnelConnectionConsumer）
//! 單一 process，所以不需要跨 worker 的 Redis；sender 留在 map 裡，沒有 receiver 時 send 只是 no-op。
//! In-process broadcast hub replacing the Redis channel layer (single process = no fan-out across workers).

use std::sync::Arc;

use dashmap::DashMap;
use serde_json::{json, Value};
use tokio::sync::broadcast;

const CAPACITY: usize = 256;

pub type Msg = Arc<str>;

#[derive(Default)]
pub struct Hub {
    users: DashMap<i64, broadcast::Sender<Msg>>,
    tunnels: DashMap<i64, broadcast::Sender<Msg>>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    fn sender(map: &DashMap<i64, broadcast::Sender<Msg>>, key: i64) -> broadcast::Sender<Msg> {
        map.entry(key).or_insert_with(|| broadcast::channel(CAPACITY).0).clone()
    }

    pub fn subscribe_user(&self, user_id: i64) -> broadcast::Receiver<Msg> {
        Self::sender(&self.users, user_id).subscribe()
    }

    pub fn subscribe_tunnel(&self, tunnel_id: i64) -> broadcast::Receiver<Msg> {
        Self::sender(&self.tunnels, tunnel_id).subscribe()
    }

    /// `send_notification_to_user`：NotificationConsumer 收到後包成 `{"message": ...}` 送前端。
    pub fn notify_user(&self, user_id: i64, message: &Value) {
        let text: Msg = Arc::from(json!({ "message": message }).to_string());
        if let Some(tx) = self.users.get(&user_id) {
            let _ = tx.send(text);
        }
        tracing::debug!(user_id, action = ?message.get("action"), "notification dispatched");
    }

    pub fn notify_users(&self, user_ids: impl IntoIterator<Item = i64>, message: &Value) {
        let mut seen = std::collections::HashSet::new();
        for id in user_ids {
            if seen.insert(id) {
                self.notify_user(id, message);
            }
        }
    }

    /// `send_tunnel_connection_update`：TunnelConnectionConsumer 原樣轉送 message。
    pub fn tunnel_update(&self, tunnel_id: i64, message: &Value) {
        if let Some(tx) = self.tunnels.get(&tunnel_id) {
            let _ = tx.send(Arc::from(message.to_string()));
        }
    }

    /// 清掉沒人訂閱的 sender（偶爾由 reaper 呼叫；map 大小本來就 ≤ 使用者/隧道數，不急）。
    pub fn gc(&self) {
        self.users.retain(|_, tx| tx.receiver_count() > 0);
        self.tunnels.retain(|_, tx| tx.receiver_count() > 0);
    }
}
