//! 「連線後第一則訊息帶 JWT」認證（FirstMessageAuthConsumer）。
//! JWT 只在 WS payload 內，不進 URL / subprotocol / header。逾時或無效以對應關閉碼關閉：
//!   4000 第一則不是 auth 訊息或缺 token、4001 token 無效/過期/逾時未認證、
//!   4007 管理員要求兩步驟、這個帳號還沒設好（只有 notifications 不受限）。
//! First-message JWT auth shared by every WebSocket endpoint; same close codes as the Django base class.

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use serde_json::Value;

use crate::auth::extractor::user_from_access_token;
use crate::db::users::User;
use crate::state::AppState;

pub const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// 帳號還沒設好管理員要求的第二因素。/ The account has not enrolled the second factor the admin requires.
pub const CLOSE_MFA_ENROLLMENT_REQUIRED: u16 = 4007;

/// 回 `Err(code)` 時呼叫端以該碼關閉；`Err(0)` 代表對方已斷，直接返回即可。
/// 還沒設好必要第二因素的帳號以 4007 拒絕。/ Accounts that still have to enroll are refused with 4007.
pub async fn first_message(state: &AppState, socket: &mut WebSocket) -> Result<(User, Value), u16> {
    let (user, data) = first_message_any(state, socket).await?;
    match crate::api::mfa::enrollment_missing(state, user.id).await {
        Ok(missing) if missing.is_empty() => Ok((user, data)),
        Ok(_) => Err(CLOSE_MFA_ENROLLMENT_REQUIRED),
        Err(e) => {
            tracing::warn!(error = %e, "websocket: cannot check required second factors");
            Err(CLOSE_MFA_ENROLLMENT_REQUIRED)
        }
    }
}

/// 同 `first_message`，但不檢查必要的第二因素（notifications 用：設定畫面也要收得到通知）。
/// Like `first_message` without the enrollment check (the notifications socket).
pub async fn first_message_any(state: &AppState, socket: &mut WebSocket) -> Result<(User, Value), u16> {
    let frame = match tokio::time::timeout(WS_AUTH_TIMEOUT, socket.recv()).await {
        Err(_elapsed) => {
            tracing::warn!("websocket: no auth within timeout, closing");
            return Err(4001);
        }
        Ok(None) | Ok(Some(Err(_))) => return Err(0),
        Ok(Some(Ok(m))) => m,
    };
    let text = match frame {
        Message::Text(t) => t.to_string(),
        Message::Close(_) => return Err(0),
        _ => return Err(4000),
    };
    let data: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Err(4000),
    };
    if !data.is_object() || data.get("type").and_then(|t| t.as_str()) != Some("auth") {
        return Err(4000);
    }
    let token = match data.get("token").and_then(|t| t.as_str()) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => return Err(4000),
    };
    match user_from_access_token(state, &token).await {
        Ok(user) => Ok((user, data)),
        Err(_) => {
            tracing::warn!("websocket: invalid token");
            Err(4001)
        }
    }
}

/// auth 訊息裡的 `server_id` / `tunnel_id`（數字或字串皆可）。
pub fn id_field(msg: &Value, key: &str) -> Option<String> {
    match msg.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}
