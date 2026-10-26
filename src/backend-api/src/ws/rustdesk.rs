//! 網頁內 RustDesk 的 WebSocket。
//!
//! **瀏覽器** `/ws/rustdesk/{session_id}/?ticket=…`：核心把設定的 id-server 網址當 proxy，hbbs 與 hbbr 都連同一條網址，
//! 所以這裡看**第一則訊息**決定角色：
//! - `punch_hole_request`（欄位 8）→ 當 hbbs。經隧道：回 `relay_response`（指向自己）；經 ID 伺服器：在裝置的註冊連線上
//!   推 `request_relay`，回 `relay_response`（附伺服器簽過的裝置公鑰，核心就做端對端加密）。
//! - `request_relay`（欄位 18）→ 當 hbbr。經隧道：之後 WebSocket binary ⇄ BytesCodec 框直通裝置的 Direct IP 埠；
//!   經 ID 伺服器：等裝置的中繼連線（同一個 uuid）到了，兩條 WS 逐則轉送。
//!
//! **裝置**（Telepy 當它的 RustDesk 伺服器時；公開端點，RustDesk 自己的協定）：
//! - `/ws/id`（網域）或根路徑 `/`（RustDesk 用 IP 時連 `ws://IP:埠/`）：`register_pk` → 註冊連線（登記過才回 OK，
//!   否則 `NOT_DEPLOYED`）；`relay_response` = 裝置收到中繼請求的回覆，不用處理。
//! - `/ws/relay`：`request_relay {uuid}` → 交給等著的瀏覽器。
//!
//! 內容一概不解析（帳密的雜湊交換、影像、輸入都在核心與裝置之間）。
//! 關閉碼：4404 session / 票證無效或過期、4403 無權限、4013 裝置斷線、4014 伺服器端結束（stop / 權限被收回）、
//! 4400 壞框（超長或第一則不是 rendezvous 訊息）、4009 從即時 session 頁被結束。
//! RustDesk WebSockets: the browser core's (both roles), and the device's when Telepy is its RustDesk server.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use base64::Engine;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};

use crate::client_ip::ClientMeta;
use crate::db;
use crate::desktop::fmt_duration;
use crate::desktop::stats::fmt_bytes;
use crate::presence::{Entry, Kind, PresenceGuard};
use crate::rustdesk::codec::{self, punch_failure, register_result, FrameError};
use crate::rustdesk::idserver::{Online, KEEP_ALIVE_SECS, PING_INTERVAL, RELAY_PAIR_TIMEOUT, UNENROLLED_TTL};
use crate::rustdesk::{Role, Session, Via};
use crate::state::AppState;

pub const CLOSE_NO_SESSION: u16 = 4404;
pub const CLOSE_FORBIDDEN: u16 = 4403;
pub const CLOSE_DEVICE_CLOSED: u16 = 4013;
pub const CLOSE_STOPPED: u16 = 4014;
pub const CLOSE_BAD_FRAME: u16 = 4400;
/// 第一則訊息要在這段時間內到。/ The first message must arrive within this.
const FIRST_MESSAGE_TIMEOUT: Duration = Duration::from_secs(10);
/// 在線裝置多久寫一次 last_seen。/ How often an online device's last_seen is written.
const TOUCH_EVERY: Duration = Duration::from_secs(60);

async fn close_with_code(socket: &mut WebSocket, code: u16) {
    let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from(code.to_string()) }))).await;
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
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

/// 從即時 session 頁被結束（沒有 presence 的 session 永遠不會）。/ Ended from the live sessions page.
async fn presence_ended(presence: &mut Option<PresenceGuard>) -> String {
    match presence.as_mut() {
        Some(p) => p.ended().await,
        None => std::future::pending().await,
    }
}

// ---- 瀏覽器 / the browser core -------------------------------------------------------------

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
    let allowed = match &session.via {
        Via::Tunnel { tunnel_id, hop_username, .. } => crate::desktop::allowed_for(&state.db, session.user_id, *tunnel_id, hop_username).await,
        Via::IdServer { device_id, .. } => crate::rustdesk::device_allowed(&state.db, session.user_id, *device_id).await,
    };
    if !allowed {
        state.rustdesk.remove(&session.id);
        close_with_code(&mut socket, CLOSE_FORBIDDEN).await;
        return;
    }

    match (role, &session.via) {
        (Role::Id, Via::Tunnel { .. }) => fake_hbbs(socket, &session).await,
        (Role::Id, Via::IdServer { .. }) => punch_via_id_server(&state, socket, &session, first, &meta).await,
        (Role::Relay, Via::Tunnel { .. }) => relay_via_tunnel(&state, socket, session, meta).await,
        (Role::Relay, Via::IdServer { .. }) => relay_via_id_server(&state, socket, session, meta).await,
    }
}

/// 經隧道的 hbbs 角色：回 relay_response（指向自己），核心接著會開第二條 WS。這條留著直到核心關掉。
/// Tunnel path, hbbs role: answer, then idle until the core closes this socket (it does right after the handshake).
async fn fake_hbbs(mut socket: WebSocket, session: &Session) {
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
}

/// 經 ID 伺服器的 hbbs 角色：每個 punch 都向裝置要一條新的中繼，回瀏覽器 relay_response（附簽過的裝置公鑰）。
/// ID-server path, hbbs role: each punch asks the device for a fresh relay and answers with the signed device key.
async fn punch_via_id_server(state: &AppState, mut socket: WebSocket, session: &Session, first: Vec<u8>, meta: &ClientMeta) {
    let Via::IdServer { rustdesk_id, .. } = &session.via else { return };
    let mut msg = Some(first);
    while let Some(m) = msg.take() {
        if codec::top_field(&m) == Some(codec::PUNCH_HOLE_REQUEST) {
            let (uuid, rx, addr) = state.rustdesk_ids.new_relay(meta.ip.as_deref());
            let pushed = state.rustdesk_ids.route(rustdesk_id).filter(|(_, relay_url)| state.rustdesk_ids.push(rustdesk_id, codec::request_relay(&uuid, &addr, relay_url, true)));
            let reply = match pushed {
                Some((pk, _)) => {
                    session.set_relay_rx(rx);
                    let signed = state.rustdesk_ids.key.sign_combined(&codec::id_pk(rustdesk_id, &pk));
                    tracing::info!(session = %session.id, rustdesk_id = %rustdesk_id, relay = %short(&uuid), "rustdesk: asked the device for a relay");
                    codec::relay_response_with_pk(&uuid, &format!("/ws/rustdesk/{}/", session.id), &signed)
                }
                None => {
                    tracing::info!(session = %session.id, rustdesk_id = %rustdesk_id, "rustdesk: device is offline");
                    codec::punch_hole_failure(punch_failure::OFFLINE, "")
                }
            };
            if socket.send(Message::Binary(reply.into())).await.is_err() {
                return;
            }
        }
        msg = next_binary(&mut socket).await;
    }
}

/// 經隧道的 hbbr 角色：接管 start 時開好的通道，WS 訊息 ⇄ BytesCodec 框。/ Tunnel path, hbbr role.
async fn relay_via_tunnel(state: &AppState, mut socket: WebSocket, session: Arc<Session>, meta: ClientMeta) {
    let Some(prepared) = session.take_handoff() else {
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    let tunnel_id = session.tunnel_id();
    let _lease = prepared.lease;
    let mut channel = prepared.channel;
    session.connected.store(true, Ordering::SeqCst);
    let connected_at = Instant::now();
    let mut presence = tunnel_id.map(|t| state.presence.join(Entry::new(t, session.user_id, &session.user_name, Kind::RustDesk, meta.ip.clone())));
    let opened = session.describe();
    tracing::info!(session = %session.id, "rustdesk: {opened}");
    state.gateway.event("rustdesk_open", None, None, tunnel_id, format!("{opened} (session {})", short(&session.id))).await;

    let mut buf = vec![0u8; 64 * 1024];
    let mut pending: Vec<u8> = Vec::with_capacity(256 * 1024);
    let mut to_browser: u64 = 0;
    let mut to_device: u64 = 0;
    let mut close_code: Option<u16> = None;
    let mut ended_by: Option<String> = None;
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
            by = presence_ended(&mut presence) => {
                ended_by = Some(by);
                break "ended";
            }
            _ = session.stop.notified() => {
                close_code = Some(CLOSE_STOPPED);
                break session.stop_reason().unwrap_or("stopped");
            }
        }
    };
    finish(state, &mut socket, &session, &opened, connected_at, reason, to_browser, to_device, ended_by, close_code).await;
    drop(presence);
    let _ = tokio::time::timeout(Duration::from_secs(2), channel.shutdown()).await;
    state.rustdesk.remove(&session.id);
}

/// 經 ID 伺服器的 hbbr 角色：等裝置的中繼連線，兩條 WS 逐則轉送（內容是端對端加密的）。
/// ID-server path, hbbr role: wait for the device's relay socket and pipe messages both ways (end-to-end encrypted).
async fn relay_via_id_server(state: &AppState, mut socket: WebSocket, session: Arc<Session>, meta: ClientMeta) {
    let Some(rx) = session.take_relay_rx() else {
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    let mut device = match tokio::time::timeout(RELAY_PAIR_TIMEOUT, rx).await {
        Ok(Ok(d)) => d,
        _ => {
            tracing::warn!(session = %session.id, "rustdesk: the device never opened its relay");
            close_with_code(&mut socket, CLOSE_DEVICE_CLOSED).await;
            state.rustdesk.remove(&session.id);
            return;
        }
    };
    session.connected.store(true, Ordering::SeqCst);
    let connected_at = Instant::now();
    let opened = session.describe();
    let from = meta.ip.as_deref().map(|ip| format!(" from {ip}")).unwrap_or_default();
    tracing::info!(session = %session.id, "rustdesk: {opened}");
    state.gateway.event("rustdesk_open", None, None, None, format!("{opened}{from} (session {})", short(&session.id))).await;
    // 沒有隧道：presence 用隧道 0 加上裝置；擁有者在即時 session 頁看得到、能結束。連線紀錄給裝置頁。
    // No tunnel: presence on tunnel 0 with the device, so its owner sees and can end it; history for the device page.
    let Via::IdServer { device_id, device_name, owner_id, .. } = &session.via else { return };
    let device_ref = crate::presence::DeviceRef { id: *device_id, name: device_name.clone(), owner_id: *owner_id };
    let mut presence = Some(state.presence.join(Entry { device: Some(device_ref), ..Entry::new(0, session.user_id, &session.user_name, Kind::RustDesk, meta.ip.clone()) }));
    let history = crate::db::rustdesk_devices::open_session(&state.db, *device_id, session.user_id, &session.user_name, meta.ip.as_deref()).await.ok();
    let (device_id, owner_id) = (*device_id, *owner_id);
    devices_updated(state, owner_id, device_id);
    let mut ended_by: Option<String> = None;

    let mut to_browser: u64 = 0;
    let mut to_device: u64 = 0;
    let mut close_code: Option<u16> = None;
    let reason: &str = loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(b))) => {
                    to_device += b.len() as u64;
                    if device.send(Message::Binary(b)).await.is_err() {
                        close_code = Some(CLOSE_DEVICE_CLOSED);
                        break "device";
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "user",
                Some(Ok(_)) => {}
            },
            incoming = device.recv() => match incoming {
                Some(Ok(Message::Binary(b))) => {
                    to_browser += b.len() as u64;
                    if socket.send(Message::Binary(b)).await.is_err() {
                        break "user";
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    close_code = Some(CLOSE_DEVICE_CLOSED);
                    break "device";
                }
                Some(Ok(_)) => {}
            },
            by = presence_ended(&mut presence) => {
                ended_by = Some(by);
                break "ended";
            }
            _ = session.stop.notified() => {
                close_code = Some(CLOSE_STOPPED);
                break session.stop_reason().unwrap_or("stopped");
            }
        }
    };
    if let Some(id) = history {
        let _ = crate::db::rustdesk_devices::close_session(&state.db, id, to_browser, to_device, reason).await;
    }
    finish(state, &mut socket, &session, &opened, connected_at, reason, to_browser, to_device, ended_by, close_code).await;
    drop(presence);
    let _ = tokio::time::timeout(Duration::from_secs(2), device.send(Message::Close(None))).await;
    state.rustdesk.remove(&session.id);
    devices_updated(state, owner_id, device_id);
}

/// 擁有者的裝置頁（使用中、最後使用）與即時 session 頁跟著更新。/ Refresh the owner's device page and live sessions.
fn devices_updated(state: &AppState, owner_id: i64, device_id: i64) {
    state.hub.notify_user(owner_id, &serde_json::json!({ "action": "RUSTDESK-DEVICES-UPDATED", "device_id": device_id, "details": "RustDesk device in use changed" }));
}

/// 收尾：寫 close 事件、用對的關閉碼關掉瀏覽器那條。/ Write the close event and close the browser's socket.
#[allow(clippy::too_many_arguments)]
async fn finish(state: &AppState, socket: &mut WebSocket, session: &Session, opened: &str, connected_at: Instant, reason: &str, to_browser: u64, to_device: u64, ended_by: Option<String>, close_code: Option<u16>) {
    let message = format!("{opened} closed after {} ({reason}, session {}; {} to the browser, {} to the device)", fmt_duration(connected_at.elapsed()), short(&session.id), fmt_bytes(to_browser), fmt_bytes(to_device));
    tracing::info!(session = %session.id, "rustdesk: {message}");
    state.gateway.event("rustdesk_close", None, None, session.tunnel_id(), message).await;
    match (ended_by, close_code) {
        (Some(by), _) => super::close_with(socket, super::CLOSE_ENDED, &by).await,
        (None, Some(code)) => close_with_code(socket, code).await,
        (None, None) => {
            let _ = socket.send(Message::Close(None)).await;
        }
    }
}

// ---- 裝置（Telepy 當它的 RustDesk 伺服器）/ devices, with Telepy as their RustDesk server -------

/// `/ws/id` 與根路徑：裝置的 rendezvous 連線。`base` = 裝置連進來的 Telepy 位址（推中繼網址用）。
/// A device's rendezvous socket; `base` is the Telepy address the device used (for the relay URL).
pub async fn device_rendezvous(state: AppState, mut socket: WebSocket, meta: ClientMeta, base: String) {
    let Ok(Some(first)) = tokio::time::timeout(FIRST_MESSAGE_TIMEOUT, next_binary(&mut socket)).await else {
        return;
    };
    match codec::top_field(&first) {
        Some(codec::REGISTER_PK) => registration(state, socket, first, meta, base).await,
        // 裝置收到中繼請求後的回報；配對靠 uuid，這裡不用處理。/ The device's ack of a relay request; nothing to do.
        Some(codec::RELAY_RESPONSE) => {}
        // 原生 RustDesk app 想經 Telepy 連別台：不支援（只能從 Telepy 網頁連）。/ Native apps cannot connect through Telepy.
        Some(codec::PUNCH_HOLE_REQUEST) => {
            let reply = codec::punch_hole_failure(punch_failure::ID_NOT_EXIST, "Connect to this device from Telepy's web page.");
            let _ = socket.send(Message::Binary(reply.into())).await;
        }
        other => tracing::debug!(field = ?other, ip = ?meta.ip, "rustdesk server: unexpected first message"),
    }
}

/// 註冊結果：OK 時帶那一列。/ The answer to a registration, with the row when accepted.
async fn check_registration(state: &AppState, reg: &codec::RegisterPk) -> (u64, Option<db::rustdesk_devices::RustDeskDevice>) {
    if !reg.old_id.is_empty() {
        return (register_result::NOT_SUPPORT, None);
    }
    let enabled = db::settings::get_solo(&state.db).await.map(|s| s.desktop_rustdesk_server).unwrap_or(false);
    if !enabled {
        return (register_result::NOT_DEPLOYED, None);
    }
    match db::rustdesk_devices::by_rustdesk_id(&state.db, &reg.id).await {
        Ok(Some(row)) if row.uuid == b64(&reg.uuid) && row.pk == b64(&reg.pk) && !reg.pk.is_empty() => (register_result::OK, Some(row)),
        _ => (register_result::NOT_DEPLOYED, None),
    }
}

fn notify_owner(state: &AppState, user_id: i64, device_id: i64, online: bool) {
    state.hub.notify_user(user_id, &json!({ "action": "RUSTDESK-DEVICES-UPDATED", "device_id": device_id, "online": online, "details": if online { "RustDesk device online" } else { "RustDesk device offline" } }));
}

/// 沒登記的連線名額（Drop 時歸還）。/ An unenrolled-socket slot, returned on drop.
struct UnenrolledSlot<'a>(Option<&'a crate::rustdesk::idserver::IdServer>);

impl UnenrolledSlot<'_> {
    fn release(&mut self) {
        if let Some(ids) = self.0.take() {
            ids.release_unenrolled();
        }
    }
}

impl Drop for UnenrolledSlot<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

/// 裝置的註冊連線：回 `register_pk`、送心跳、把推給它的訊息（中繼請求）送出去。
/// The registration socket: answer `register_pk`, send heartbeats and pushed messages (relay requests).
async fn registration(state: AppState, mut socket: WebSocket, first: Vec<u8>, meta: ClientMeta, base: String) {
    let ids = state.rustdesk_ids.clone();
    let relay_url = crate::rustdesk::idserver::device_settings(&base).relay_url;
    if !ids.try_unenrolled() {
        tracing::warn!(ip = ?meta.ip, "rustdesk server: too many unenrolled sockets; refusing");
        return;
    }
    let mut slot = UnenrolledSlot(Some(&ids));
    let conn = ids.next_conn();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let kick = Arc::new(Notify::new());
    let started = Instant::now();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    // 目前在線的身分：(RustDesk ID, 那一列)。/ The identity this socket is online as.
    let mut online: Option<(String, db::rustdesk_devices::RustDeskDevice)> = None;
    let mut last_touch = Instant::now();
    let mut msg = Some(first);
    loop {
        if let Some(reg) = msg.take().and_then(|m| codec::parse_register_pk(&m)) {
            let (result, row) = check_registration(&state, &reg).await;
            if !reg.old_id.is_empty() {
                // `--set-id` 開的單次連線：回「不支援」就結束。/ The one-off socket of an ID change: refuse and end.
                let _ = socket.send(Message::Binary(codec::register_pk_response(result, KEEP_ALIVE_SECS).into())).await;
                break;
            }
            // 先登記在線再回 OK：裝置知道自己註冊好了時，Telepy 已經能把連線推給它。
            // Go online before answering OK, so the device is routable as soon as it knows it is registered.
            let refused_while_online = row.is_none() && online.is_some();
            match row {
                Some(row) if online.as_ref().map(|(id, _)| id != &row.rustdesk_id).unwrap_or(true) => {
                    if let Some((old_id, _)) = online.take() {
                        ids.set_offline(&old_id, conn);
                    }
                    slot.release();
                    ids.set_online(&row.rustdesk_id, Online { conn, device_id: row.id, user_id: row.user_id, pk: reg.pk.clone(), relay_url: relay_url.clone(), tx: tx.clone(), since: chrono::Utc::now(), kick: kick.clone() });
                    let _ = db::rustdesk_devices::touch(&state.db, row.id).await;
                    last_touch = Instant::now();
                    notify_owner(&state, row.user_id, row.id, true);
                    for e in ids.mark_online(row.id) {
                        state.hub.notify_user(e.user_id, &json!({ "action": "RUSTDESK-DEVICES-UPDATED", "device_id": row.id, "enroll_id": e.id, "online": true, "details": "RustDesk device online" }));
                    }
                    tracing::info!(rustdesk_id = %row.rustdesk_id, device = row.id, ip = ?meta.ip, "rustdesk server: device online");
                }
                Some(_) => {}
                None => tracing::debug!(rustdesk_id = %reg.id, result, ip = ?meta.ip, "rustdesk server: registration refused"),
            }
            if socket.send(Message::Binary(codec::register_pk_response(result, KEEP_ALIVE_SECS).into())).await.is_err() || refused_while_online {
                // 送不出去，或已在線的裝置換了金鑰 / 被刪了：下線。/ Send failed, or an online device no longer matches.
                break;
            }
        }
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(b))) => {
                    if !b.is_empty() {
                        msg = Some(b.to_vec());
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            Some(out) = rx.recv() => {
                if socket.send(Message::Binary(out.into())).await.is_err() {
                    break;
                }
            }
            _ = ping.tick() => {
                if socket.send(Message::Binary(Vec::new().into())).await.is_err() {
                    break;
                }
                match &online {
                    None if started.elapsed() > UNENROLLED_TTL => break,
                    Some((_, row)) if last_touch.elapsed() > TOUCH_EVERY => {
                        let _ = db::rustdesk_devices::touch(&state.db, row.id).await;
                        last_touch = Instant::now();
                    }
                    _ => {}
                }
            }
            _ = kick.notified() => break,
        }
    }
    if let Some((rid, row)) = online {
        if ids.set_offline(&rid, conn) {
            let _ = db::rustdesk_devices::touch(&state.db, row.id).await;
            notify_owner(&state, row.user_id, row.id, false);
            tracing::info!(rustdesk_id = %rid, device = row.id, "rustdesk server: device offline");
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Close(None))).await;
}

/// `/ws/relay`：裝置的中繼連線，交給等著同一個 uuid 的瀏覽器。/ A device's relay socket, handed to the waiting browser.
pub async fn device_relay(state: AppState, mut socket: WebSocket, meta: ClientMeta) {
    let Ok(Some(first)) = tokio::time::timeout(FIRST_MESSAGE_TIMEOUT, next_binary(&mut socket)).await else {
        return;
    };
    let Some(uuid) = codec::parse_request_relay_uuid(&first) else {
        close_with_code(&mut socket, CLOSE_BAD_FRAME).await;
        return;
    };
    if let Err(mut socket) = state.rustdesk_ids.deliver_relay(&uuid, socket) {
        tracing::warn!(relay = %short(&uuid), ip = ?meta.ip, "rustdesk server: relay for an unknown or expired request");
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
    }
}
