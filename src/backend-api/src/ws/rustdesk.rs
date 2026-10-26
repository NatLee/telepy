//! `/ws/rustdesk/{session_id}/?ticket=…`：瀏覽器裡的 RustDesk 核心 ↔ 裝置 Direct IP 埠的中繼。
//!
//! 核心把設定的 id-server 網址當 proxy，hbbs 與 hbbr 都連同一條網址，所以這裡看**第一則訊息**決定角色：
//! - `punch_hole_request`（欄位 8）→ 當 hbbs：回 `relay_response`（uuid + 指向自己），然後陪著直到核心關掉它
//! - `request_relay`（欄位 18）→ 當 hbbr：吃掉它，之後 WebSocket binary ⇄ BytesCodec 框直通裝置
//!
//! 內容一概不解析（帳密的雜湊交換、影像、輸入都在核心與裝置之間）。
//! 關閉碼：4404 session / 票證無效或過期、4403 無權限、4013 裝置斷線、4014 伺服器端結束（stop / 權限被收回）、
//! 4400 壞框（超長或第一則不是 rendezvous 訊息）、4009 從即時 session 頁被結束。
//! The browser's RustDesk core ↔ the device's Direct IP port; the first message picks the hbbs or hbbr role.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::client_ip::ClientMeta;
use crate::desktop::fmt_duration;
use crate::desktop::stats::fmt_bytes;
use crate::presence::{Entry, Kind};
use crate::rustdesk::codec::{self, FrameError};
use crate::rustdesk::Role;
use crate::state::AppState;

pub const CLOSE_NO_SESSION: u16 = 4404;
pub const CLOSE_FORBIDDEN: u16 = 4403;
pub const CLOSE_DEVICE_CLOSED: u16 = 4013;
pub const CLOSE_STOPPED: u16 = 4014;
pub const CLOSE_BAD_FRAME: u16 = 4400;
/// 第一則訊息要在這段時間內到。/ The first message must arrive within this.
const FIRST_MESSAGE_TIMEOUT: Duration = Duration::from_secs(10);

async fn close_with_code(socket: &mut WebSocket, code: u16) {
    let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from(code.to_string()) }))).await;
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// 下一則 binary 訊息（略過 ping / pong / text）；None = 關閉或錯誤。/ The next binary message, or None on close.
async fn next_binary(socket: &mut WebSocket) -> Option<Vec<u8>> {
    loop {
        match socket.recv().await {
            Some(Ok(Message::Binary(b))) => return Some(b.to_vec()),
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
            Some(Ok(_)) => {}
        }
    }
}

pub async fn handle(state: AppState, mut socket: WebSocket, session_id: String, query: HashMap<String, String>, meta: ClientMeta) {
    let Some(ticket) = query.get("ticket").filter(|t| !t.is_empty()) else {
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    // 先確認 session 與票證還有效，再讀第一則訊息決定角色（角色各只能認領一次）。
    // Check the session and ticket first, then read the first message to pick the role.
    let Some(session) = state.rustdesk.get(&session_id).filter(|s| !s.ticket_expired()) else {
        tracing::warn!(session = %session_id, "rustdesk: unknown session or expired ticket");
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    // 開它的網頁登入已經被撤銷了（拿到票證之後才登出）。/ The sign-in that opened it was revoked meanwhile.
    let Some(mut signout) = super::auth::SessionWatch::for_session(&state, session.web_session) else {
        close_with_code(&mut socket, super::auth::CLOSE_SIGNED_OUT).await;
        state.rustdesk.remove(&session.id);
        return;
    };
    let first = match tokio::time::timeout(FIRST_MESSAGE_TIMEOUT, next_binary(&mut socket)).await {
        Ok(Some(m)) => m,
        _ => {
            close_with_code(&mut socket, CLOSE_BAD_FRAME).await;
            return;
        }
    };
    let role = match codec::top_field(&first) {
        Some(codec::PUNCH_HOLE_REQUEST) => Role::Id,
        Some(codec::REQUEST_RELAY) => Role::Relay,
        other => {
            tracing::warn!(session = %session_id, field = ?other, "rustdesk: first message is not a rendezvous request");
            close_with_code(&mut socket, CLOSE_BAD_FRAME).await;
            return;
        }
    };
    let Some(session) = state.rustdesk.redeem(&session.id, ticket, role) else {
        tracing::warn!(session = %session_id, ?role, "rustdesk: invalid ticket or role already used");
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    if !crate::desktop::allowed_for(&state.db, session.user_id, session.tunnel_id, &session.hop_username).await {
        state.rustdesk.remove(&session.id);
        close_with_code(&mut socket, CLOSE_FORBIDDEN).await;
        return;
    }

    if role == Role::Id {
        // 假 hbbs：回 relay_response，核心接著會開第二條 WS。這條留著直到核心關掉（它在握手後就關）。
        // Fake hbbs: answer, then idle until the core closes this socket (it does right after the handshake).
        let reply = codec::relay_response(&uuid::Uuid::new_v4().simple().to_string(), &format!("/ws/rustdesk/{}/", session.id));
        if socket.send(Message::Binary(reply.into())).await.is_err() {
            return;
        }
        while let Some(msg) = socket.recv().await {
            match msg {
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(Message::Binary(b)) => {
                    // 再來一個 punch 也回同樣的東西（核心重試時）。/ Answer retries the same way.
                    if codec::top_field(&b) == Some(codec::PUNCH_HOLE_REQUEST) {
                        let reply = codec::relay_response(&uuid::Uuid::new_v4().simple().to_string(), &format!("/ws/rustdesk/{}/", session.id));
                        if socket.send(Message::Binary(reply.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Ok(_) => {}
            }
        }
        return;
    }

    // 假 hbbr：接管 start 時開好的通道。/ Fake hbbr: take over the channel opened at start.
    let Some(prepared) = session.take_handoff() else {
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    let _lease = prepared.lease;
    let mut channel = prepared.channel;
    session.connected.store(true, Ordering::SeqCst);
    let connected_at = Instant::now();
    let mut presence = state.presence.join(Entry::new(session.tunnel_id, session.user_id, &session.user_name, Kind::RustDesk, meta.ip));
    let opened = session.describe();
    tracing::info!(session = %session.id, "rustdesk: {opened}");
    state.gateway.event("rustdesk_open", None, None, Some(session.tunnel_id), format!("{opened} (session {})", short(&session.id))).await;
    crate::session_audit::webhook_started(&state, session.tunnel_id, session.user_id, &session.user_name, "rustdesk", None).await;

    let mut buf = vec![0u8; 64 * 1024];
    let mut pending: Vec<u8> = Vec::with_capacity(256 * 1024);
    let mut to_browser: u64 = 0;
    let mut to_device: u64 = 0;
    let mut close_code: Option<u16> = None;
    let mut ended_by: Option<String> = None;
    let mut signed_out: Option<String> = None;
    let reason: &str = loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(b))) => {
                    if b.len() > codec::MAX_FRAME {
                        close_code = Some(CLOSE_BAD_FRAME);
                        break "protocol";
                    }
                    to_device += b.len() as u64;
                    if channel.write_all(&codec::encode_frame(&b)).await.is_err() {
                        close_code = Some(CLOSE_DEVICE_CLOSED);
                        break "device";
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "user",
                Some(Ok(_)) => {}
            },
            read = channel.read(&mut buf) => match read {
                Ok(0) | Err(_) => {
                    close_code = Some(CLOSE_DEVICE_CLOSED);
                    break "device";
                }
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let mut consumed = 0;
                    let mut bad = false;
                    let mut out: Vec<Vec<u8>> = Vec::new();
                    loop {
                        match codec::decode_frame(&pending[consumed..]) {
                            Ok(Some((payload, used))) => {
                                out.push(payload.to_vec());
                                consumed += used;
                            }
                            Ok(None) => break,
                            Err(FrameError::TooLong(len)) => {
                                tracing::warn!(session = %session.id, len, "rustdesk: oversized frame from the device");
                                bad = true;
                                break;
                            }
                        }
                    }
                    pending.drain(..consumed);
                    let mut send_failed = false;
                    for m in out {
                        to_browser += m.len() as u64;
                        if socket.send(Message::Binary(m.into())).await.is_err() {
                            send_failed = true;
                            break;
                        }
                    }
                    if send_failed {
                        break "user";
                    }
                    if bad {
                        close_code = Some(CLOSE_DEVICE_CLOSED);
                        break "device";
                    }
                }
            },
            by = presence.ended() => {
                ended_by = Some(by);
                break "ended";
            }
            // 開它的那個網頁登入被撤銷了。/ The sign-in that opened it was revoked.
            why = signout.ended() => {
                signed_out = Some(why);
                break "signed out";
            }
            _ = session.stop.notified() => {
                close_code = Some(CLOSE_STOPPED);
                break session.stop_reason().unwrap_or("stopped");
            }
        }
    };
    let message = format!("{opened} closed after {} ({reason}, session {}; {} to the browser, {} to the device)", fmt_duration(connected_at.elapsed()), short(&session.id), fmt_bytes(to_browser), fmt_bytes(to_device));
    tracing::info!(session = %session.id, "rustdesk: {message}");
    state.gateway.event("rustdesk_close", None, None, Some(session.tunnel_id), message).await;
    match (ended_by, close_code) {
        (Some(by), _) => super::close_with(&mut socket, super::CLOSE_ENDED, &by).await,
        (None, _) if signed_out.is_some() => super::close_with(&mut socket, super::auth::CLOSE_SIGNED_OUT, signed_out.as_deref().unwrap_or_default()).await,
        (None, Some(code)) => close_with_code(&mut socket, code).await,
        (None, None) => {
            let _ = socket.send(Message::Close(None)).await;
        }
    }
    drop(presence);
    let _ = tokio::time::timeout(Duration::from_secs(2), channel.shutdown()).await;
    state.rustdesk.remove(&session.id);
}
