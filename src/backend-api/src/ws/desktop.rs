//! `/ws/desktop/{session_id}/?ticket=…&width=&height=&dpi=`：瀏覽器（guacamole-common-js）↔ guacd 的中繼。
//!
//! 流程：認領票證（單次）→ 重驗權限 → 開 rendezvous 埠、連 guacd → 在後端做完 Guacamole 握手（guacd 連回
//! rendezvous，那條接到裝置通道）→ 回瀏覽器 `0.,<uuid>;`（tunnel 開啟）→ 雙向中繼。瀏覽器→guacd 只放行
//! [`ALLOWED_OPCODES`]；guacd→瀏覽器透傳（含 `error`，瀏覽器自己顯示），並記下 guacd 的錯誤給日誌。
//! 關閉碼：4404 session / 票證無效或過期、4403 無權限、4011 guacd 連不上或握手失敗、4013 guacd 斷線、
//! 4014 伺服器端結束（閒置 / stop / 權限被收回）、4400 瀏覽器送了壞指令。
//! 串流統計（`desktop/stats.rs`）：每秒給瀏覽器 `telepy-ping` + `telepy-stats`（畫面往返、網路往返、隧道延遲、
//! fps、流量、落後幾幀）；瀏覽器回的 `telepy-pong` 在這裡結算、不轉給 guacd。
//! Browser ↔ guacd relay for the in-browser remote desktop; see `desktop/mod.rs` for the design.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::client_ip::ClientMeta;
use crate::db;
use crate::desktop::guac::{self, Guacd, Parser, Size, Unit};
use crate::desktop::stats::Stats;
use crate::desktop::{self, bridge, fmt_duration};
use crate::presence::{Entry, Kind};
use crate::state::AppState;

pub const CLOSE_NO_SESSION: u16 = 4404;
pub const CLOSE_FORBIDDEN: u16 = 4403;
pub const CLOSE_GUACD_UNAVAILABLE: u16 = 4011;
pub const CLOSE_GUACD_CLOSED: u16 = 4013;
pub const CLOSE_STOPPED: u16 = 4014;
pub const CLOSE_BAD_FRAME: u16 = 4400;

/// 瀏覽器可以送給 guacd 的指令：輸入、畫面大小、同步、剪貼簿串流、斷線，以及 `ack`（回覆 guacd 開的串流，
/// 例如聲音）。其餘（`argv`、`put`、`pipe`、`audio` = 麥克風、`file`…）一律丟掉。反方向（guacd → 瀏覽器）全部透傳，
/// 所以 guacd 的 `audio` / `blob` / `end`（遠端的聲音）照樣到瀏覽器，由 guacamole-common-js 播放。
/// Opcodes the browser may send; everything else is dropped (`audio` from the browser would be a microphone).
/// guacd → browser passes through untouched, so guacd's `audio` / `blob` / `end` (the remote's sound) reach the player.
pub const ALLOWED_OPCODES: &[&str] = &["key", "mouse", "touch", "size", "sync", "nop", "disconnect", "clipboard", "blob", "end", "ack"];
/// 算「使用者有在用」的指令（閒置計時）。/ Opcodes that count as user activity.
const INPUT_OPCODES: &[&str] = &["key", "mouse", "touch", "clipboard"];

pub fn is_allowed(opcode: &str) -> bool {
    ALLOWED_OPCODES.contains(&opcode)
}

/// 瀏覽器要的畫面大小，夾在 [MIN_DIMENSION, max] 之間。/ Requested size, clamped.
pub fn parse_size(query: &HashMap<String, String>, max: u32) -> Size {
    let dim = |key: &str, default: u32| query.get(key).and_then(|v| v.trim().parse::<u32>().ok()).unwrap_or(default).clamp(desktop::MIN_DIMENSION, max.max(desktop::MIN_DIMENSION));
    let dpi = query.get("dpi").and_then(|v| v.trim().parse::<u32>().ok()).unwrap_or(desktop::DEFAULT_DPI).clamp(72, 288);
    Size { width: dim("width", 1280), height: dim("height", 720), dpi }
}

/// 關閉並把代碼也放進 reason：guacamole-common-js 的 WebSocketTunnel 只看 reason（`parseInt(reason)` 當狀態碼），
/// 自訂的 4xxx 關閉碼本身會被它翻成籠統的 SERVER_ERROR。
/// Close with the code repeated as the reason: the Guacamole tunnel reads `parseInt(reason)` as the status and
/// would otherwise turn our 4xxx codes into a generic SERVER_ERROR.
async fn close_with_code(socket: &mut WebSocket, code: u16) {
    let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from(code.to_string()) }))).await;
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

pub async fn handle(state: AppState, mut socket: WebSocket, session_id: String, query: HashMap<String, String>, meta: ClientMeta) {
    let Some(ticket) = query.get("ticket").filter(|t| !t.is_empty()) else {
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    let Some(session) = state.desktop.redeem(&session_id, ticket) else {
        tracing::warn!(session = %session_id, "desktop: unknown session or invalid/expired ticket");
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    // 開它的網頁登入已經被撤銷了（拿到票證之後才登出）。/ The sign-in that opened it was revoked meanwhile.
    let Some(mut signout) = super::auth::SessionWatch::for_session(&state, session.web_session) else {
        close_with_code(&mut socket, super::auth::CLOSE_SIGNED_OUT).await;
        state.desktop.remove(&session.id);
        return;
    };
    if !desktop::still_allowed(&state.db, &session).await {
        tracing::warn!(session = %session_id, user = %session.user_name, "desktop: access no longer allowed");
        state.desktop.remove(&session_id);
        close_with_code(&mut socket, CLOSE_FORBIDDEN).await;
        return;
    }
    let Some(handoff) = session.take_handoff() else {
        state.desktop.remove(&session_id);
        close_with_code(&mut socket, CLOSE_NO_SESSION).await;
        return;
    };
    let max_res = db::settings::get_solo(&state.db).await.map(|s| s.desktop_max_resolution).unwrap_or(desktop::DEFAULT_MAX_RESOLUTION as i64).clamp(desktop::MIN_DIMENSION as i64, 16384) as u32;
    let size = parse_size(&query, max_res);

    // rendezvous + guacd：guacd 會在 `connect` 時連回 rendezvous；那條接到裝置通道。
    // guacd dials the rendezvous during `connect`; that socket is bridged into the device channel.
    let rendezvous = match bridge::Rendezvous::bind().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "desktop: cannot bind the rendezvous port");
            state.desktop.remove(&session_id);
            close_with_code(&mut socket, CLOSE_GUACD_UNAVAILABLE).await;
            return;
        }
    };
    let callback_port = rendezvous.port;
    let expected = bridge::resolve(&state.desktop.guacd_addr).await;
    let mut guacd = match Guacd::connect(&state.desktop.guacd_addr, desktop::GUACD_CONNECT_TIMEOUT).await {
        Ok(g) => g,
        Err(e) => {
            tracing::error!(addr = %state.desktop.guacd_addr, error = %e, "desktop: cannot connect to guacd");
            state.desktop.remove(&session_id);
            close_with_code(&mut socket, CLOSE_GUACD_UNAVAILABLE).await;
            return;
        }
    };
    let desktop::Handoff { credentials, prepared } = handoff;
    let bridge_slot: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let accept = {
        let slot = bridge_slot.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            match rendezvous.accept(&expected, desktop::RENDEZVOUS_TIMEOUT).await {
                Ok(tcp) => {
                    let handle = bridge::spawn_bridge(tcp, prepared.channel, prepared.lease);
                    *slot.lock().unwrap() = Some(handle);
                }
                Err(e) => tracing::warn!(session = %sid, error = %e, "desktop: guacd never connected back"),
            }
        })
    };
    let abort_bridge = |accept: &tokio::task::JoinHandle<()>| {
        accept.abort();
        if let Some(b) = bridge_slot.lock().unwrap().take() {
            b.abort();
        }
    };
    let params = desktop::guacd_params(session.protocol, &credentials, session.clipboard, session.quality, session.audio, &state.desktop.callback_host, callback_port, size);
    drop(credentials);
    let audio: &[&str] = if session.audio { desktop::AUDIO_MIMETYPES } else { &[] };
    let connection_id = match guacd.handshake(session.protocol.as_str(), size, audio, &params, desktop::HANDSHAKE_TIMEOUT).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(session = %session_id, error = %e, "desktop: guacd handshake failed");
            abort_bridge(&accept);
            state.desktop.remove(&session_id);
            close_with_code(&mut socket, CLOSE_GUACD_UNAVAILABLE).await;
            return;
        }
    };
    drop(params);
    session.connected.store(true, Ordering::SeqCst);
    session.touch();
    let connected_at = Instant::now();
    // guacamole-common-js：第一個指令是 opcode 為空的「tunnel UUID」，收到才把 tunnel 標成 OPEN。
    // The client marks its tunnel OPEN on the first instruction, the empty-opcode tunnel UUID.
    if socket.send(Message::Text(Utf8Bytes::from(guac::encode(&["", &session.id], Unit::Utf16)))).await.is_err() {
        abort_bridge(&accept);
        state.desktop.remove(&session_id);
        return;
    }
    let mut presence = state.presence.join(Entry::new(session.tunnel_id, session.user_id, &session.user_name, Kind::Desktop, meta.ip));
    let mut ended_by: Option<String> = None;
    let mut signed_out: Option<String> = None;
    let opened = session.describe();
    tracing::info!(session = %session_id, connection = %connection_id, "desktop: {opened}");
    state.gateway.event("desktop_open", None, None, Some(session.tunnel_id), format!("{opened} (session {})", short(&session_id))).await;
    crate::session_audit::webhook_started(&state, session.tunnel_id, session.user_id, &session.user_name, "desktop", Some(&session.hop_username)).await;

    let (stream, mut from_guacd) = guacd.into_parts();
    let (mut rx, mut tx) = stream.into_split();
    let mut from_browser = Parser::new(Unit::Utf16);
    let mut buf = vec![0u8; 64 * 1024];
    let mut last_error: Option<String> = None;
    let mut close_code: Option<u16> = None;
    let mut stats = Stats::new(Instant::now());
    let mut stats_tick = tokio::time::interval(desktop::stats::INTERVAL);
    stats_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let reverse_port = u16::try_from(session.reverse_port).ok();
    // guacd 常把 `ready` 和第一批畫面指令放在同一個封包：握手時已讀進解析器的部分要先送出，
    // 否則它們會一直躺在緩衝區裡，直到 guacd 再送下一批。
    // guacd often sends `ready` and the first drawing instructions in one packet; forward what the handshake
    // already buffered, or it sits in the parser until guacd sends more.
    let (pending, pending_err) = from_guacd.drain();
    for i in pending.iter().filter(|i| i.opcode() == "error") {
        last_error = Some(format!("{} ({})", i.element(1).unwrap_or(""), i.element(2).unwrap_or("")));
    }
    if !pending.is_empty() {
        let now = Instant::now();
        let out: String = pending.iter().map(|i| { stats.sent(i, now); i.wire(Unit::Utf16) }).collect();
        stats.add_down(out.len());
        if socket.send(Message::Text(Utf8Bytes::from(out))).await.is_err() {
            abort_bridge(&accept);
            state.desktop.remove(&session_id);
            return;
        }
    }
    if pending_err.is_some() {
        close_code = Some(CLOSE_GUACD_CLOSED);
    }
    let reason: &str = if close_code.is_some() { "guacd" } else { loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    stats.add_up(t.len());
                    from_browser.push(t.as_bytes());
                    let (list, err) = from_browser.drain();
                    let mut out = String::new();
                    let mut disconnect = false;
                    let now = Instant::now();
                    for i in list {
                        // sync 回音結算那一幀的往返；telepy-pong 是我們自己的 ping，不轉給 guacd。
                        // A sync echo settles its frame; a pong answers our own ping and stops here.
                        if stats.received(&i, now) {
                            continue;
                        }
                        let op = i.opcode();
                        if !is_allowed(op) {
                            tracing::debug!(session = %session_id, opcode = op, "desktop: dropped a browser instruction");
                            continue;
                        }
                        if INPUT_OPCODES.contains(&op) {
                            session.touch();
                        }
                        disconnect |= op == "disconnect";
                        out.push_str(&i.wire(Unit::CodePoints));
                    }
                    if !out.is_empty() && tx.write_all(out.as_bytes()).await.is_err() {
                        close_code = Some(CLOSE_GUACD_CLOSED);
                        break "guacd";
                    }
                    if let Some(e) = err {
                        tracing::warn!(session = %session_id, error = %e, "desktop: malformed instruction from the browser");
                        close_code = Some(CLOSE_BAD_FRAME);
                        break "protocol";
                    }
                    if disconnect {
                        break "user";
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "user",
                Some(Ok(_)) => {}
            },
            read = rx.read(&mut buf) => match read {
                Ok(0) | Err(_) => {
                    close_code = Some(CLOSE_GUACD_CLOSED);
                    break "guacd";
                }
                Ok(n) => {
                    from_guacd.push(&buf[..n]);
                    let (list, err) = from_guacd.drain();
                    let mut out = String::new();
                    let mut disconnect = false;
                    let now = Instant::now();
                    for i in list {
                        match i.opcode() {
                            "error" => last_error = Some(format!("{} ({})", i.element(1).unwrap_or(""), i.element(2).unwrap_or(""))),
                            "disconnect" => disconnect = true,
                            _ => {}
                        }
                        stats.sent(&i, now);
                        out.push_str(&i.wire(Unit::Utf16));
                    }
                    stats.add_down(out.len());
                    if !out.is_empty() && socket.send(Message::Text(Utf8Bytes::from(out))).await.is_err() {
                        break "user";
                    }
                    if let Some(e) = err {
                        tracing::warn!(session = %session_id, error = %e, "desktop: malformed instruction from guacd");
                        close_code = Some(CLOSE_GUACD_CLOSED);
                        break "guacd";
                    }
                    if disconnect {
                        close_code = Some(CLOSE_GUACD_CLOSED);
                        break "guacd";
                    }
                }
            },
            // 每秒：一個 ping（網路往返）+ 這一秒的統計；隧道延遲取 monitor 最近量到的。
            // Every second: a ping for the network round trip and this second's stats, with the monitor's latency.
            _ = stats_tick.tick() => {
                let now = Instant::now();
                let tunnel_ms = reverse_port.and_then(|p| state.status.latency().and_then(|m| m.get(&p).copied()));
                let mut out = stats.ping(now);
                out.push_str(&stats.tick(now, tunnel_ms));
                if socket.send(Message::Text(Utf8Bytes::from(out))).await.is_err() {
                    break "user";
                }
            }
            // 有人從即時 session 頁結束了它。/ Someone ended it from the live sessions page.
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
                // 不先送 `disconnect` 指令：瀏覽器會把它當成正常結束，看不到 4014 的原因。
                // No `disconnect` instruction first: the browser would treat it as a normal end and miss the 4014.
                close_code = Some(CLOSE_STOPPED);
                break session.stop_reason().unwrap_or("stopped");
            }
        }
    } };
    let duration = connected_at.elapsed();
    let mut message = format!("{opened} closed after {} ({reason}, session {}; {})", fmt_duration(duration), short(&session_id), stats.summary());
    if let Some(e) = &last_error {
        message.push_str(&format!("; guacd: {e}"));
    }
    tracing::info!(session = %session_id, "desktop: {message}");
    state.gateway.event("desktop_close", None, None, Some(session.tunnel_id), message).await;
    match (ended_by, close_code) {
        (Some(by), _) => super::close_with(&mut socket, super::CLOSE_ENDED, &by).await,
        (None, _) if signed_out.is_some() => super::close_with(&mut socket, super::auth::CLOSE_SIGNED_OUT, signed_out.as_deref().unwrap_or_default()).await,
        (None, Some(code)) => close_with_code(&mut socket, code).await,
        (None, None) => {
            let _ = socket.send(Message::Close(None)).await;
        }
    }
    drop(presence);
    let _ = tokio::time::timeout(Duration::from_secs(2), tx.shutdown()).await;
    abort_bridge(&accept);
    state.desktop.remove(&session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_input_and_display_opcodes_pass() {
        for ok in ["key", "mouse", "size", "clipboard", "blob", "end", "disconnect"] {
            assert!(is_allowed(ok), "{ok}");
        }
        // `audio` from the browser = a microphone stream: never forwarded. / 瀏覽器送的 audio 是麥克風：不轉。
        for bad in ["put", "argv", "pipe", "audio", "file", "connect", "select", ""] {
            assert!(!is_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn size_is_clamped() {
        let q = |w: &str, h: &str| HashMap::from([("width".to_string(), w.to_string()), ("height".to_string(), h.to_string())]);
        let s = parse_size(&q("99999", "10"), 2560);
        assert_eq!((s.width, s.height, s.dpi), (2560, desktop::MIN_DIMENSION, 96));
        let s = parse_size(&HashMap::new(), 2560);
        assert_eq!((s.width, s.height), (1280, 720));
        let s = parse_size(&q("1920", "1080"), 1600);
        assert_eq!((s.width, s.height), (1600, 1080));
    }
}
