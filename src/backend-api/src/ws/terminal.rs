//! `/ws/terminal/`：網頁終端機（TerminalConsumer）。
//! - 第一則訊息 `{type:"auth", token, server_id, username[, lan_host_id, lan_username]}`；帶 `lan_host_id` 時
//!   經裝置（`username` 是裝置上的帳號）跳到它區網裡的那台機器（#20），`lan_username` 預設為主機記錄的帳號。關閉碼沿用：
//!   4000 缺欄位、4004 無存取權/隧道不存在、4002 無 reverse_port、4006 無目標使用者、4003 username 不允許、4005 ssh 起不來。
//! - 之後：`{action:"pty_input", payload:{input}}`、`{action:"pty_resize", payload:{size:{rows,cols,height,width}}}`、
//!   `{action:"ping"}` → **binary** `pong`（前端把所有 text frame 寫進 xterm，pong 必須是 binary）。
//! - PTY 輸出以 text frame 送出，增量 UTF-8 解碼避免多位元組字元被切半。
//! - 裝置本身：連線池借一條裝置連線、開一條 PTY channel（`ssh::terminal`）；一個分頁一條 channel，同一台同一帳號
//!   的分頁、檔案管理、遠端瀏覽器共用連線。裝置離線直接 4005。
//! - 區網主機：池子那條連線上的 direct-tcpip（`ssh::bridge`）接 OpenSSH 客戶端當最後一跳（密碼 / 鍵盤互動提示
//!   要出現在 PTY 裡）。
//! Web terminal: a PTY channel on the shared device connection; the LAN hop is OpenSSH over a pool bridge.

use std::time::Instant;

use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use serde_json::Value;

use super::{auth, close, send, send_text, Heartbeat};
use crate::client_ip::ClientMeta;
use crate::db;
use crate::permissions::{self, Permission};
use crate::presence::{Entry, Kind};
use crate::session_audit::{ConsoleKind, ConsoleSession};
use crate::ssh::process::{lan_terminal_args, spawn_in_pty, valid_login, PtyChild};
use crate::ssh::terminal::{Output, PtySession, WindowSize};
use crate::state::AppState;

/// 兩種後端：裝置本身（池子裡的 PTY channel）或區網主機（OpenSSH 子程序）。
enum Pty {
    Channel(PtySession),
    Process(PtyChild),
}

fn window_size(v: &Value) -> Option<WindowSize> {
    let size = v.pointer("/payload/size")?.as_object()?;
    let g = |k: &str| size.get(k).and_then(|v| v.as_u64()).map(|v| v.min(u64::from(u16::MAX)) as u32);
    Some(WindowSize { rows: g("rows")?, cols: g("cols")?, height: g("height")?, width: g("width")? })
}

/// 裝置離線（gateway 沒有它的隧道）。gateway 沒啟用時（開發、自帶 sshd 的測試）交給連線去判斷。
fn device_offline(state: &AppState, reverse_port: i64) -> bool {
    state.config.gateway_enabled && !state.gateway.has_forward(u16::try_from(reverse_port).unwrap_or(0))
}

/// 增量 UTF-8 解碼器：未完成的尾端位元組留到下一塊；非法位元組換成 U+FFFD（Python `'replace'`）。
#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        let mut buf = std::mem::take(&mut self.pending);
        loop {
            match std::str::from_utf8(&buf) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&buf[..valid]) });
                    match e.error_len() {
                        None => {
                            // 不完整的多位元組序列：留待下一塊。/ Incomplete sequence: keep for the next chunk.
                            self.pending = buf[valid..].to_vec();
                            break;
                        }
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            buf = buf[valid + bad..].to_vec();
                        }
                    }
                }
            }
        }
        out
    }
}

/// `_resolve_terminal_access`：一次完成所有前置檢查，回 reverse_port 或關閉碼。
pub async fn resolve_access(state: &AppState, user_id: i64, server_id: &str, username: &str, step_up: Option<&str>) -> Result<i64, u16> {
    let Ok(id) = server_id.parse::<i64>() else { return Err(4004) };
    let tunnel = match db::tunnels::by_id(&state.db, id).await {
        Ok(Some(t)) => t,
        _ => return Err(4004),
    };
    if !permissions::check_access(&state.db, user_id, &tunnel, Permission::View).await.unwrap_or(false) {
        return Err(4004);
    }
    // 敏感隧道：auth 訊息要帶有效的 step-up token。/ Sensitive tunnel: the auth message needs a valid step-up token.
    if !crate::step_up::allows(tunnel.require_step_up, &state.step_up, user_id, step_up) {
        return Err(crate::step_up::CLOSE_CODE);
    }
    if tunnel.reverse_port <= 0 {
        return Err(4002);
    }
    if !db::tunnels::usernames_exist_for_tunnel(&state.db, tunnel.id).await.unwrap_or(false) {
        return Err(4006);
    }
    let allowed = permissions::allowed_usernames(&state.db, user_id, &tunnel).await.unwrap_or_default();
    if !allowed.iter().any(|u| u.username == username) {
        return Err(4003);
    }
    Ok(tunnel.reverse_port)
}

pub async fn handle(state: AppState, mut socket: WebSocket, meta: ClientMeta) {
    let (user, msg) = match auth::first_message(&state, &mut socket).await {
        Ok(v) => v,
        Err(0) => return,
        Err(code) => {
            close(&mut socket, code).await;
            return;
        }
    };
    let (Some(server_id), Some(username)) = (auth::id_field(&msg, "server_id"), msg.get("username").and_then(|u| u.as_str()).map(str::to_string)) else {
        tracing::error!("Terminal auth message missing server_id/username");
        close(&mut socket, 4000).await;
        return;
    };
    tracing::info!(user = %user.username, "Terminal user authenticated");
    let reverse_port = match resolve_access(&state, user.id, &server_id, &username, msg.get("step_up").and_then(|v| v.as_str())).await {
        Ok(p) => p,
        Err(code) => {
            tracing::error!(user = %user.username, server_id, code, "Terminal access denied");
            close(&mut socket, code).await;
            return;
        }
    };

    // 區網終端機的稽核說明（連上之後才記開始）。/ The LAN terminal's audit line, recorded once it is open.
    let mut lan_audit: Option<String> = None;
    // 區網主機（經裝置跳過去）：主機要屬於這條隧道，帳號要是安全字元。/ A LAN host behind the device.
    let mut pty = match auth::id_field(&msg, "lan_host_id") {
        None => {
            if device_offline(&state, reverse_port) {
                tracing::warn!(user = %user.username, server_id, "Terminal refused: device offline");
                close(&mut socket, 4005).await;
                return;
            }
            let opened = async {
                let (lease, channel) = state.pool.session_channel(&state, reverse_port, &username).await?;
                PtySession::open(lease, channel, WindowSize::default()).await
            };
            match opened.await {
                Ok(s) => Pty::Channel(s),
                Err(e) => {
                    tracing::error!(error = format!("{e:#}"), "Error starting SSH connection");
                    close(&mut socket, 4005).await;
                    return;
                }
            }
        }
        Some(raw) => {
            let tunnel_id: i64 = server_id.parse().unwrap_or(0);
            let host = match raw.parse::<i64>() {
                Ok(hid) => db::lan::host_by_id(&state.db, hid).await.ok().flatten().filter(|h| h.tunnel_id == tunnel_id),
                Err(_) => None,
            };
            let Some(host) = host else {
                tracing::error!(user = %user.username, server_id, lan_host = %raw, "LAN host not found for this tunnel");
                close(&mut socket, 4004).await;
                return;
            };
            let login = msg.get("lan_username").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).or(host.username.clone());
            let Some(login) = login.filter(|l| valid_login(l)) else {
                tracing::error!(user = %user.username, lan_host = host.id, "LAN terminal without a valid login name");
                close(&mut socket, 4003).await;
                return;
            };
            lan_audit = Some(format!("Web terminal by {} to {}@{}:{} through {}@device", user.username, login, host.address, host.ssh_port, username));
            if device_offline(&state, reverse_port) {
                close(&mut socket, 4005).await;
                return;
            }
            // 第一跳：池子那條裝置連線上、由裝置 sshd 開往區網主機的 direct-tcpip；OpenSSH 連本機一次性入口。
            let lan_port = u16::try_from(host.ssh_port).unwrap_or(22);
            let entry = async {
                let lease = state.pool.acquire(&state, reverse_port, &username).await?;
                crate::ssh::bridge::one_shot(lease, host.address.clone(), lan_port).await
            };
            let local_port = match entry.await {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!(error = format!("{e:#}"), "Error reaching the device for the LAN hop");
                    close(&mut socket, 4005).await;
                    return;
                }
            };
            match spawn_in_pty(&state.config.ssh_binary, &lan_terminal_args(&login, &host.address, local_port)) {
                Ok(p) => Pty::Process(p),
                Err(e) => {
                    tracing::error!(error = %e, "Error starting SSH connection");
                    close(&mut socket, 4005).await;
                    return;
                }
            }
        }
    };
    tracing::info!(%username, reverse_port, "SSH connection started");
    let started = Instant::now();
    // 連線期間算「在用這條隧道」。/ Counts as using the tunnel while connected.
    let tunnel_id: i64 = server_id.parse().unwrap_or(0);
    let presence = state.presence.join(Entry::new(tunnel_id, user.id, &user.username, Kind::Terminal, meta.ip));
    let audit = match lan_audit {
        Some(what) => ConsoleSession::open(&state, ConsoleKind::LanTerminal, tunnel_id, what).await,
        None => ConsoleSession::open_for(&state, ConsoleKind::Terminal, tunnel_id, &user.username, Some(&username)).await,
    };
    let mut heartbeat = Heartbeat::new(&state.config);

    let mut decoder = Utf8Decoder::default();
    let mut buf = vec![0u8; 8192];
    let mut close_code: Option<u16> = None;
    loop {
        tokio::select! {
            incoming = heartbeat.recv(&mut socket) => match incoming {
                Some(Ok(Message::Text(t))) => {
                    let Ok(data) = serde_json::from_str::<Value>(&t) else {
                        tracing::warn!("Terminal received malformed JSON; ignoring frame");
                        continue;
                    };
                    match data.get("action").and_then(|a| a.as_str()) {
                        Some("ping") => {
                            if !send(&mut socket, Message::Binary(Bytes::from_static(b"pong"))).await {
                                break;
                            }
                        }
                        Some("pty_input") => {
                            if let Some(input) = data.pointer("/payload/input").and_then(|i| i.as_str()) {
                                let r = match &pty {
                                    Pty::Channel(s) => s.write(input.as_bytes()).await,
                                    Pty::Process(p) => p.write_nonblocking(input.as_bytes()).map(|_| ()).map_err(Into::into),
                                };
                                if let Err(e) = r {
                                    tracing::warn!(error = %e, "Terminal input failed");
                                }
                            }
                        }
                        Some("pty_resize") => {
                            if let Some(size) = window_size(&data) {
                                let r = match &pty {
                                    Pty::Channel(s) => s.resize(size).await,
                                    Pty::Process(p) => p.resize(size.rows as u16, size.cols as u16, size.width as u16, size.height as u16).map_err(Into::into),
                                };
                                if let Err(e) = r {
                                    tracing::warn!(error = %e, "Terminal resize failed");
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    close_code = frame.map(|f| f.code);
                    break;
                }
                None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            read = read_pty(&mut pty, &mut buf) => match read {
                Ok(0) => {
                    // shell 已結束 → 正常關閉。/ EOF: the shell exited; close normally.
                    send(&mut socket, Message::Close(None)).await;
                    close_code = Some(1000);
                    break;
                }
                Ok(n) => {
                    let text = decoder.decode(&buf[..n]);
                    if !text.is_empty() && !send_text(&mut socket, text).await {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "PTY read failed");
                    send(&mut socket, Message::Close(None)).await;
                    break;
                }
            },
        }
    }

    // 人已經走了：先移出「使用中」，收 channel / 程序再慢也不影響。/ Leave presence before the (possibly slow) teardown.
    drop(presence);
    tracing::info!(code = ?close_code, lived = started.elapsed().as_secs_f64(), "Terminal session closed");
    audit.close(&state).await;
    match &mut pty {
        Pty::Channel(s) => s.close().await,
        Pty::Process(p) => p.terminate().await,
    }
}

/// 兩種後端統一成「讀進 buf，0 = 結束」。channel 的資料可能比 buf 大，多的留到下次。
async fn read_pty(pty: &mut Pty, buf: &mut [u8]) -> std::io::Result<usize> {
    match pty {
        Pty::Process(p) => p.read(buf).await,
        Pty::Channel(s) => match s.next().await {
            Some(Output::Data(d)) => {
                let n = d.len().min(buf.len());
                buf[..n].copy_from_slice(&d[..n]);
                if n < d.len() {
                    s.unread(d[n..].to_vec());
                }
                Ok(n)
            }
            Some(Output::Exit(_)) | None => Ok(0),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incremental_utf8() {
        let mut d = Utf8Decoder::default();
        let s = "中文字".as_bytes();
        let a = d.decode(&s[..4]); // 1 full char + 1 byte of the next
        assert_eq!(a, "中");
        let b = d.decode(&s[4..]);
        assert_eq!(b, "文字");
        let c = d.decode(&[0xff, b'x']);
        assert_eq!(c, "\u{FFFD}x");
    }
}
