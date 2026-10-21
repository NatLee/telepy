//! `/ws/notifications/`：使用者通知群組（NotificationConsumer）。推播形狀 `{"message": {...}}`。

use axum::extract::ws::{Message, WebSocket};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use super::{auth, close, is_ping, send_json, send_text};
use crate::state::AppState;

pub async fn handle(state: AppState, mut socket: WebSocket) {
    let (user, _) = match auth::first_message(&state, &mut socket).await {
        Ok(v) => v,
        Err(0) => return,
        Err(code) => {
            close(&mut socket, code).await;
            return;
        }
    };
    tracing::info!(user = %user.username, "Notification user authenticated");
    let mut rx = state.hub.subscribe_user(user.id);
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
            event = rx.recv() => match event {
                Ok(text) => {
                    if !send_text(&mut socket, text.to_string()).await {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!(user_id = user.id, dropped = n, "notification socket lagged");
                }
                Err(RecvError::Closed) => break,
            },
        }
    }
}
