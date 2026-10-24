//! WebSocket 端點（取代 Channels consumers）。協定、關閉碼、訊息形狀與 tunnels/consumers.py 一致。
//! WebSocket endpoints replacing the Channels consumers; same protocols, close codes and payloads.

pub mod auth;
pub mod desktop;
pub mod filemanager;
pub mod gateway;
pub mod notifications;
pub mod remote_browser;
pub mod terminal;
pub mod tunnel_connection;

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::Value;
use tokio::time::Instant;

use crate::client_ip::ClientMeta;
use crate::config::Config;
use crate::state::AppState;

/// 上游 VNC frame 可能很大；terminal/file manager 用不到但統一放寬。
const MAX_MESSAGE_SIZE: usize = 64 * 1024 * 1024;
/// 一個 frame 送這麼久還沒送出去 = 對方不收了（TCP 緩衝滿、對方已消失）。/ A send stuck this long = peer gone.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// 關閉碼只是盡力告知，不值得等。/ The close frame is best effort.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ws/notifications/", get(notifications_upgrade))
        .route("/ws/terminal/", get(terminal_upgrade))
        .route("/ws/filemanager/", get(filemanager_upgrade))
        .route("/ws/tunnel_connection/{tunnel_id}/", get(tunnel_connection_upgrade))
        .route("/ws/remote-browser/{session_id}/", get(remote_browser_upgrade))
        .route("/ws/desktop/{session_id}/", get(desktop_upgrade))
        .route("/ws/gateway/", get(gateway_upgrade))
}

/// SSH over WebSocket：沒有 auth 訊息（SSH 自己認證），來源 IP 取自轉送標頭。/ SSH over WebSocket; SSH authenticates inside.
async fn gateway_upgrade(State(state): State<AppState>, meta: ClientMeta, ws: WebSocketUpgrade) -> Response {
    prepare(ws).on_upgrade(move |socket| gateway::handle(state, socket, meta))
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

/// 4009：有人從即時 session 頁結束了這個 session；關閉原因 = 是誰。/ 4009: ended from the live sessions page; the reason is who.
pub const CLOSE_ENDED: u16 = 4009;

/// 帶原因文字關閉（最多 120 bytes，WebSocket 上限 123）。/ Close with a reason text (at most 120 bytes; the limit is 123).
pub async fn close_with(socket: &mut WebSocket, code: u16, reason: &str) {
    let mut end = reason.len().min(120);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    let frame = Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from(reason[..end].to_string()) }));
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, socket.send(frame)).await;
}

/// 以自訂關閉碼關閉（對方已斷或卡住時靜默）。/ Close with an application close code; ignore a dead or stuck peer.
pub async fn close(socket: &mut WebSocket, code: u16) {
    let frame = Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from_static("") }));
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, socket.send(frame)).await;
}

/// 送一個 frame；對方斷了或 [`SEND_TIMEOUT`] 內送不出去 = false（呼叫端就結束連線）。
/// Send one frame; false when the peer is gone or does not take it within [`SEND_TIMEOUT`].
pub async fn send(socket: &mut WebSocket, msg: Message) -> bool {
    matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(msg)).await, Ok(Ok(())))
}

pub async fn send_json(socket: &mut WebSocket, value: &Value) -> bool {
    send(socket, Message::Text(Utf8Bytes::from(value.to_string()))).await
}

pub async fn send_text(socket: &mut WebSocket, text: String) -> bool {
    send(socket, Message::Text(Utf8Bytes::from(text))).await
}

/// 伺服器端心跳：瀏覽器睡眠、換網路、代理斷線時不會送 close，TCP 也可能一直不報錯，連線（和它的「使用中」）
/// 就永遠留著。所以每 `ws_ping_interval` 送一個 WebSocket Ping（瀏覽器自動回 Pong，背景分頁也照回），
/// 送出後 `ws_peer_timeout` 內什麼都沒收到就當對方已經不在，[`Heartbeat::recv`] 回 `None`。
/// Server-side heartbeat. A sleeping laptop, a network switch or a dropped proxy never sends a close frame and
/// TCP may stay silent, so without this the session (and its presence) lives forever. Pings every
/// `ws_ping_interval` (browsers answer with a Pong on their own, background tabs included); nothing received
/// within `ws_peer_timeout` of a ping = the client is gone and `recv` returns `None`.
pub struct Heartbeat {
    interval: Duration,
    timeout: Duration,
    next_ping: Instant,
    /// 最早一個還沒得到任何回應的 Ping 的送出時間。/ When the oldest unanswered ping went out.
    waiting: Option<Instant>,
}

impl Heartbeat {
    pub fn new(config: &Config) -> Self {
        Self::with(config.ws_ping_interval, config.ws_peer_timeout)
    }

    pub fn with(interval: Duration, timeout: Duration) -> Self {
        Self { interval, timeout, next_ping: Instant::now() + interval, waiting: None }
    }

    /// 取代 `socket.recv()`：收到任何 frame（含 Pong）都算對方還在。cancel-safe，可放進 `select!`。
    /// Drop-in for `socket.recv()`; any frame (Pong included) proves the client is alive. Cancel-safe.
    pub async fn recv(&mut self, socket: &mut WebSocket) -> Option<Result<Message, axum::Error>> {
        loop {
            let deadline = match self.waiting {
                Some(sent) => self.next_ping.min(sent + self.timeout),
                None => self.next_ping,
            };
            tokio::select! {
                // 先讀：處理完一個慢動作回來時，排隊中的 Pong 要先算進去，不能先判逾時。
                // Read first, so frames queued while the caller was busy count before the deadline does.
                biased;
                incoming = socket.recv() => {
                    if matches!(incoming, Some(Ok(_))) {
                        self.waiting = None;
                    }
                    return incoming;
                }
                _ = tokio::time::sleep_until(deadline) => {
                    let now = Instant::now();
                    if self.waiting.is_some_and(|sent| now >= sent + self.timeout) {
                        return None;
                    }
                    if now >= self.next_ping {
                        if !send(socket, Message::Ping(Bytes::new())).await {
                            return None;
                        }
                        self.waiting.get_or_insert(now);
                        self.next_ping = now + self.interval;
                    }
                }
            }
        }
    }
}

/// 裝置離線（gateway 沒有它的隧道）。gateway 沒啟用時（開發、自帶 sshd 的測試）交給連線去判斷。
/// The device is offline (no tunnel at the gateway); without a gateway the connection attempt decides.
pub fn device_offline(state: &AppState, reverse_port: i64) -> bool {
    state.config.gateway_enabled && !state.gateway.has_forward(u16::try_from(reverse_port).unwrap_or(0))
}

/// `{"type":"ping"}` → `{"type":"pong"}`（notifications / tunnel_connection / filemanager 的心跳）。
pub fn is_ping(text: &str) -> bool {
    serde_json::from_str::<Value>(text).ok().and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "ping")).unwrap_or(false)
}
