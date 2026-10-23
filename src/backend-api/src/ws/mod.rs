//! WebSocket 端點（取代 Channels consumers）。協定、關閉碼、訊息形狀與 tunnels/consumers.py 一致。
//! WebSocket endpoints replacing the Channels consumers; same protocols, close codes and payloads.

pub mod auth;
pub mod desktop;
pub mod filemanager;
pub mod notifications;
pub mod remote_browser;
pub mod terminal;
pub mod tunnel_connection;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::Value;

use crate::client_ip::ClientMeta;
use crate::state::AppState;

/// 上游 VNC frame 可能很大；terminal/file manager 用不到但統一放寬。
const MAX_MESSAGE_SIZE: usize = 64 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ws/notifications/", get(notifications_upgrade))
        .route("/ws/terminal/", get(terminal_upgrade))
        .route("/ws/filemanager/", get(filemanager_upgrade))
        .route("/ws/tunnel_connection/{tunnel_id}/", get(tunnel_connection_upgrade))
        .route("/ws/remote-browser/{session_id}/", get(remote_browser_upgrade))
        .route("/ws/desktop/{session_id}/", get(desktop_upgrade))
}

async fn remote_browser_upgrade(State(state): State<AppState>, Path(session_id): Path<String>, meta: ClientMeta, ws: WebSocketUpgrade) -> Response {
    prepare(ws).on_upgrade(move |socket| remote_browser::handle(state, socket, session_id, meta))
}

/// 遠端桌面：票證在 query（guacamole-common-js 的 WebSocketTunnel 不能送自訂的第一則訊息），而且它要求
/// 伺服器回應 `guacamole` 子協定，不回的話瀏覽器會自己把連線關掉。
/// Remote desktop: the ticket rides in the query (the Guacamole tunnel cannot send a custom first frame) and
/// the `guacamole` subprotocol must be echoed or the browser drops the socket.
async fn desktop_upgrade(State(state): State<AppState>, Path(session_id): Path<String>, Query(query): Query<HashMap<String, String>>, meta: ClientMeta, ws: WebSocketUpgrade) -> Response {
    prepare(ws).protocols(["guacamole"]).on_upgrade(move |socket| desktop::handle(state, socket, session_id, query, meta))
}

fn prepare(ws: WebSocketUpgrade) -> WebSocketUpgrade {
    ws.max_message_size(MAX_MESSAGE_SIZE).max_frame_size(MAX_MESSAGE_SIZE)
}

async fn notifications_upgrade(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    prepare(ws).on_upgrade(move |socket| notifications::handle(state, socket))
}

async fn terminal_upgrade(State(state): State<AppState>, meta: ClientMeta, ws: WebSocketUpgrade) -> Response {
    prepare(ws).on_upgrade(move |socket| terminal::handle(state, socket, meta))
}

async fn filemanager_upgrade(State(state): State<AppState>, meta: ClientMeta, ws: WebSocketUpgrade) -> Response {
    prepare(ws).on_upgrade(move |socket| filemanager::handle(state, socket, meta))
}

async fn tunnel_connection_upgrade(State(state): State<AppState>, Path(tunnel_id): Path<String>, ws: WebSocketUpgrade) -> Response {
    prepare(ws).on_upgrade(move |socket| tunnel_connection::handle(state, socket, tunnel_id))
}

/// 以自訂關閉碼關閉（對方已斷時靜默）。/ Close with an application close code; ignore a dead peer.
pub async fn close(socket: &mut WebSocket, code: u16) {
    let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from_static("") }))).await;
}

pub async fn send_json(socket: &mut WebSocket, value: &Value) -> bool {
    socket.send(Message::Text(Utf8Bytes::from(value.to_string()))).await.is_ok()
}

pub async fn send_text(socket: &mut WebSocket, text: String) -> bool {
    socket.send(Message::Text(Utf8Bytes::from(text))).await.is_ok()
}

/// `{"type":"ping"}` → `{"type":"pong"}`（notifications / tunnel_connection / filemanager 的心跳）。
pub fn is_ping(text: &str) -> bool {
    serde_json::from_str::<Value>(text).ok().and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "ping")).unwrap_or(false)
}
