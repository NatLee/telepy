//! `/ws/remote-browser/{session_id}/`：把 kasm-browser 的 KasmVNC websocket 透明中繼到前端（RemoteBrowserConsumer）。
//! 握手順序（VNC 是 server 先說話，不能漏 greeting）：auth → 後端連上游、回 `{"type":"ready"}` → 前端把同一條
//! WS 交給 KasmVNC client、回 `{"type":"begin"}` → 後端才開始 pump 上游→前端。前端→上游不需等 begin。
//! 關閉碼：4404 session 不存在、4403 無權限、4011 上游連不上、4013 上游關閉。斷線即收整個 session。

use std::time::Duration;

use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message as UpMsg;
use tokio_tungstenite::{connect_async_with_config, MaybeTlsStream, WebSocketStream};

use super::{auth, close, send_json};
use crate::client_ip::ClientMeta;
use crate::db;
use crate::permissions::{self, Permission};
use crate::state::AppState;

type Upstream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const PATH_CANDIDATES: [&str; 4] = ["/websockify", "/", "/api/vnc", "/websocket"];

fn candidates(state: &AppState, ws_port: u16) -> Vec<String> {
    let cfg = &state.config;
    let mut paths = vec![cfg.kasm_ws_path.clone()];
    paths.extend(PATH_CANDIDATES.iter().filter(|p| **p != cfg.kasm_ws_path).map(|p| p.to_string()));
    let mut schemes = vec![cfg.kasm_ws_scheme.clone()];
    if cfg.kasm_ws_scheme != "ws" {
        schemes.push("ws".to_string());
    }
    let mut out = Vec::new();
    for s in &schemes {
        for p in &paths {
            out.push(format!("{s}://{}:{ws_port}{p}", cfg.kasm_host));
        }
    }
    out
}

async fn connect_one(state: &AppState, url: &str) -> anyhow::Result<Upstream> {
    let mut req = url.into_client_request()?;
    let headers = req.headers_mut();
    // KasmVNC 要求 legacy 的 Sec-WebSocket-Origin（缺了回 404 "failed websocket checks"）。
    headers.insert("Sec-WebSocket-Origin", format!("http://{}", state.config.kasm_host).parse()?);
    if !state.config.kasm_ws_subprotocol.is_empty() {
        headers.insert("Sec-WebSocket-Protocol", state.config.kasm_ws_subprotocol.parse()?);
    }
    if !state.config.kasm_ws_user.is_empty() {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", state.config.kasm_ws_user, state.config.kasm_ws_password));
        headers.insert("Authorization", format!("Basic {token}").parse()?);
    }
    let cfg = WebSocketConfig::default().max_message_size(None).max_frame_size(None);
    let (ws, _) = tokio::time::timeout(Duration::from_secs(8), connect_async_with_config(req, Some(cfg), false)).await??;
    Ok(ws)
}

async fn connect_upstream(state: &AppState, ws_port: u16) -> anyhow::Result<(Upstream, String)> {
    let mut last = None;
    for url in candidates(state, ws_port) {
        match connect_one(state, &url).await {
            Ok(ws) => return Ok((ws, url)),
            Err(e) => {
                tracing::debug!(url, error = %e, "remote-browser(vnc): upstream candidate failed");
                last = Some(e);
            }
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("no upstream websocket candidate connected")))
}

pub async fn handle(state: AppState, mut socket: WebSocket, session_id: String, meta: ClientMeta) {
    let (user, _) = match auth::first_message(&state, &mut socket).await {
        Ok(v) => v,
        Err(0) => return,
        Err(code) => {
            close(&mut socket, code).await;
            return;
        }
    };
    let Some(session) = state.remote_browser.get(&session_id) else {
        tracing::warn!(session_id, "remote-browser(vnc): unknown session");
        close(&mut socket, 4404).await;
        return;
    };
    let Some(ws_port) = session.ws_port else {
        close(&mut socket, 4404).await;
        return;
    };
    let allowed = match db::tunnels::by_id(&state.db, session.server_id).await {
        Ok(Some(t)) => permissions::check_access(&state.db, user.id, &t, Permission::View).await.unwrap_or(false),
        _ => false,
    };
    if !allowed {
        tracing::warn!(user = %user.username, server_id = session.server_id, "remote-browser(vnc): access denied");
        close(&mut socket, 4403).await;
        return;
    }
    let (mut upstream, url) = match connect_upstream(&state, ws_port).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(session_id, ws_port, error = %e, "remote-browser(vnc): cannot connect upstream ws");
            close(&mut socket, 4011).await;
            return;
        }
    };
    if !send_json(&mut socket, &json!({"type": "ready"})).await {
        let _ = upstream.close(None).await;
        return;
    }
    tracing::info!(session_id, url, "remote-browser(vnc): bridged session");
    let _presence = state.presence.join(crate::presence::Entry::new(session.server_id, user.id, &user.username, crate::presence::Kind::Browser, meta.ip));

    // VNC WS 連著 = session 在用：每 20s 續命（伺服器端計時，不受瀏覽器背景分頁節流影響）。
    let keepalive = {
        let state = state.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(20)).await;
                state.remote_browser.ping(&state.db, &sid).await;
            }
        })
    };

    let mut begun = false;
    let mut close_code: Option<u16> = None;
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if !begun && serde_json::from_str::<serde_json::Value>(&t).ok().and_then(|v| v.get("type").and_then(|x| x.as_str()).map(|x| x == "begin")).unwrap_or(false) {
                        begun = true;
                    }
                }
                Some(Ok(Message::Binary(b))) => {
                    if upstream.send(UpMsg::Binary(b)).await.is_err() {
                        close_code = Some(4013);
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            up = upstream.next(), if begun => match up {
                Some(Ok(UpMsg::Binary(b))) => {
                    if socket.send(Message::Binary(b)).await.is_err() { break; }
                }
                Some(Ok(UpMsg::Text(t))) => {
                    if socket.send(Message::Text(Utf8Bytes::from(t.to_string()))).await.is_err() { break; }
                }
                Some(Ok(UpMsg::Ping(_))) | Some(Ok(UpMsg::Pong(_))) | Some(Ok(UpMsg::Frame(_))) => {}
                Some(Ok(UpMsg::Close(_))) | None | Some(Err(_)) => {
                    close_code = Some(4013);
                    break;
                }
            },
        }
    }
    keepalive.abort();
    if let Some(code) = close_code {
        close(&mut socket, code).await;
    }
    let _ = upstream.close(None).await;
    // WS 一斷即結束整個 session（收 ssh + kasm）；idle reaper 當後備。
    state.remote_browser.stop(&state.db, &session_id).await;
}
