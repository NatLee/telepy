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
//! - 斷線保留（`crate::terminal_detach`）：auth 之後先送 binary `{type:"shell", id, resumed, offset, reset, detach:{secs,by}, size}`；
//!   socket 沒送 `{action:"end"}` 就斷了 → shell 照保留時間留著（0 = 立刻結束）；auth 帶 `resume: <id>`（+ 看過的
//!   `offset`）接回並補送輸出。4015 = shell 已經不在、4016 = 在別的視窗接回去了。
//!
//! Web terminal: a PTY channel on the shared device connection; the LAN hop is OpenSSH over a pool bridge. A shell
//! outlives a dropped socket for the grace time and is resumed with `resume: <id>` (see `crate::terminal_detach`).

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::recording::Recorder;
use super::{auth, close, close_with, device_offline, send, send_text, Heartbeat, CLOSE_ENDED};
use crate::client_ip::ClientMeta;
use crate::command_rules::{self, terminal::TerminalGuard, Action, Outcome, Requester, Source};
use crate::db::{self, users::User};
use crate::permissions::{self, Permission};
use crate::presence::{Entry, Kind, PresenceGuard};
use crate::session_audit::{ConsoleKind, ConsoleSession};
use crate::ssh::process::{lan_terminal_args, prepare_lan_auth, spawn_in_pty, valid_login, LanAuth, LanAuthFiles, PtyChild};
use crate::ssh::terminal::{Output, PtySession, WindowSize};
use crate::state::AppState;
use crate::terminal_detach::{self, Backlog, Refusal, ShellKey, Takeover};
use crate::terminal_watch::{self as watching, Change, Cmd as WatchCmd, Frame, Joined, Watchers};
use crate::util::{db_time, now_db};

/// 指令規則停住的那個 Enter。/ The Enter that a command rule holds.
enum Hold {
    /// 剛按下：等回顯到齊再讀畫面；這段時間打的字排在 `rest`。/ Just pressed: wait for the echo, then read the screen.
    Settle { rest: String, enter_at: std::time::Instant },
    /// 等 owner / ADMIN 核准；只認 Ctrl+C（撤回）。/ Waiting for approval; only Ctrl+C (withdraw) counts.
    Pending { rest: String, id: i64, rx: watch::Receiver<Outcome> },
}

enum HoldEvent {
    Read,
    Decided(Outcome),
}

/// 停住的 Enter 什麼時候有下一步。/ When the held Enter has its next step.
async fn hold_event(hold: &mut Option<Hold>, guard: &TerminalGuard) -> HoldEvent {
    match hold {
        Some(Hold::Settle { enter_at, .. }) => {
            tokio::time::sleep_until(tokio::time::Instant::from_std(guard.read_at(*enter_at))).await;
            HoldEvent::Read
        }
        Some(Hold::Pending { rx, .. }) => loop {
            let now = rx.borrow().clone();
            if now != Outcome::Pending {
                return HoldEvent::Decided(now);
            }
            if rx.changed().await.is_err() {
                return HoldEvent::Decided(Outcome::Cancelled { reason: "the request is gone".into() });
            }
        },
        None => std::future::pending().await,
    }
}

/// 送出瀏覽器的輸入；碰到要決定的 Enter 就停下來（沒有規則、沒打東西的 Enter 直接送）。
/// Send browser input; stop at an Enter that needs a decision (Enter with no rules or nothing typed goes straight out).
async fn feed(state: &AppState, guard: &mut TerminalGuard, pty: &Pty, tunnel_id: i64, user_id: i64, mut input: String) -> Option<Hold> {
    loop {
        let split = guard.split(&input, std::time::Instant::now());
        if !split.send.is_empty() {
            pty_write(pty, split.send.as_bytes()).await;
        }
        let rest = split.enter?;
        if !guard.tracker.started() || !command_rules::may_apply(state, tunnel_id, user_id).await {
            pty_write(pty, b"\r").await;
            guard.reset();
            input = rest;
            continue;
        }
        return Some(Hold::Settle { rest, enter_at: std::time::Instant::now() });
    }
}

async fn pty_write(pty: &Pty, bytes: &[u8]) {
    let r = match pty {
        Pty::Channel(s) => s.write(bytes).await,
        Pty::Process(p) => p.write_nonblocking(bytes).map(|_| ()).map_err(Into::into),
    };
    if let Err(e) = r {
        tracing::warn!(error = %e, "Terminal input failed");
    }
}

/// 指令規則的通知走 binary frame（text frame 都會寫進 xterm）。/ Command notices go out as binary frames.
async fn notice(socket: &mut WebSocket, v: Value) {
    let _ = send(socket, Message::Binary(Bytes::from(v.to_string()))).await;
}

fn outcome_notice(id: i64, o: &Outcome) -> Value {
    let (by, reason) = match o {
        Outcome::Approved { by } => (Some(by.as_str()), None),
        Outcome::Denied { by, reason } => (Some(by.as_str()), Some(reason.as_str())),
        Outcome::Cancelled { reason } => (None, Some(reason.as_str())),
        _ => (None, None),
    };
    json!({ "type": "command", "state": o.status(), "request_id": id, "by": by, "reason": reason })
}

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

/// 一個網頁終端機 shell。它比 socket 活得久（斷線保留，見 `crate::terminal_detach`），所以 PTY、指令規則的狀態、
/// 錄影、稽核、「使用中」與輸出緩衝都放在這裡；socket 只是暫時接著它。
/// One web terminal shell. It can outlive its socket (see `crate::terminal_detach`), so the PTY, the command-rule
/// state, the recording, the audit, the presence entry and the output backlog live here; a socket only borrows it.
pub struct Shell {
    id: String,
    user_id: i64,
    pty: Pty,
    /// 區網那一跳的金鑰 / 密碼檔（暫存目錄），shell 結束才刪。/ The LAN hop's key / password temp files, removed when the shell ends.
    _lan_auth: Option<LanAuthFiles>,
    guard: TerminalGuard,
    hold: Option<Hold>,
    decoder: Utf8Decoder,
    recorder: Option<Recorder>,
    audit: ConsoleSession,
    presence: PresenceGuard,
    requester: Requester,
    tunnel_name: Option<String>,
    backlog: Backlog,
    /// 斷線期間出的指令規則結果，接回時補送。/ Command-rule outcomes from while detached, sent on reattach.
    stash: Vec<Value>,
    /// 還在等核准的那則通知（重新整理後的頁面也要看到提示列）。/ The pending notice, re-sent on reattach.
    pending_notice: Option<Value>,
    size: WindowSize,
    /// 有人要接回這個 shell。/ Someone wants to resume this shell.
    takeover: mpsc::Receiver<Takeover<Shell>>,
    /// 誰在看、誰能打字（`crate::terminal_watch`）。/ Who watches and who may type.
    watchers: Watchers,
    /// 給看的人的即時輸出與事件。/ Live output and events for watchers.
    watch_out: broadcast::Sender<Frame>,
    /// 看的人那邊來的要求。/ Requests from watchers' sockets.
    watch_cmds: mpsc::Receiver<WatchCmd>,
    /// 看的人在打字時，指令規則把那一行算在他頭上。/ While a watcher types, command rules attribute the line to them.
    controller: Option<Requester>,
    port: Option<u16>,
}

/// 要給被看的人那條 socket 的東西。/ Something for the watched user's socket.
enum ToOwner {
    /// 終端機裡的一行提示（已經進緩衝）。/ A notice line in the terminal (already in the backlog).
    Text(String),
    /// binary JSON（`watchers` 狀態）。/ A binary JSON frame (the `watchers` state).
    Frame(Value),
}

/// socket 為什麼不接著 shell 了。/ Why a socket let go of its shell.
enum Exit {
    /// 明確結束（關分頁、shell 結束、被結束、登出）；附註寫進稽核。/ An explicit end; the note goes into the audit.
    End(Option<String>),
    /// 斷線（沒說要結束）：照保留時間留著。/ Dropped without an end: keep it for the grace time.
    Detach,
    /// 別的 socket 接回去了。/ Another socket resumed it.
    TakenOver(Takeover<Shell>),
}

const RECORDED_LINE: &str = "\x1b[90m[Telepy] This session is recorded.\x1b[0m\r\n";

impl Shell {
    /// PTY 讀到一塊：畫面模型、錄影、緩衝；回傳要給瀏覽器的文字。/ A PTY chunk: screen model, recording, backlog.
    async fn output(&mut self, bytes: &[u8]) -> String {
        self.guard.output(bytes, std::time::Instant::now());
        let text = self.decoder.decode(bytes);
        if !text.is_empty() {
            if let Some(r) = self.recorder.as_mut() {
                r.output(&text).await;
            }
            self.backlog.push(&text);
            if self.watch_out.receiver_count() > 0 {
                let _ = self.watch_out.send(Frame::Output(Arc::from(text.as_str())));
            }
        }
        text
    }

    /// 給看的人一個事件（指令規則的通知對他們只是看看，不能核准）。/ An event for watchers (command notices are read-only).
    fn fan_out(&self, v: &Value) {
        if self.watch_out.receiver_count() == 0 {
            return;
        }
        let mut v = v.clone();
        if v.get("can_decide").is_some() {
            v["can_decide"] = Value::Bool(false);
        }
        let _ = self.watch_out.send(Frame::Event(Arc::new(v)));
    }

    /// 這一行算誰打的：有看的人在打字就是他。/ Who the line belongs to: the typing watcher, if any.
    fn line_requester(&self) -> Requester {
        self.controller.clone().unwrap_or_else(|| self.requester.clone())
    }

    /// 在終端機裡插一行提示（全螢幕程式裡不插，免得弄亂畫面）：進緩衝、錄影、給看的人；回傳要送給被看的人的文字。
    /// Insert a notice line (not inside a full-screen program): into the backlog, the recording and the watchers;
    /// returns the text for the watched user's socket.
    async fn announce(&mut self, text: &str) -> Option<String> {
        let redraw = self.guard.tracker.redraw_cursor_row()?;
        let line = format!("{}{redraw}", watching::notice_line(text));
        if let Some(r) = self.recorder.as_mut() {
            r.output(&line).await;
        }
        self.backlog.push(&line);
        if self.watch_out.receiver_count() > 0 {
            let _ = self.watch_out.send(Frame::Output(Arc::from(line.as_str())));
        }
        Some(line)
    }

    /// 看的人那邊來的要求。`detached` = 現在沒有 socket 接著（斷線保留中）。
    /// A request from a watcher's socket; `detached` = no socket holds the shell right now.
    async fn on_watch(&mut self, state: &AppState, cmd: WatchCmd, detached: bool) -> Vec<ToOwner> {
        match cmd {
            WatchCmd::Join { watcher, reply } => {
                let (wid, name) = (watcher.id, watcher.username.clone());
                // 滿了：不回覆，那一端當作 shell 不收。/ Full: no reply; that side treats it as refused.
                let Some(fresh) = self.watchers.join(watcher) else { return Vec::new() };
                // 先訂閱再拿畫面：同一刻，不漏不重複。/ Subscribe, then take the screen: one instant, no gap.
                let rx = self.watch_out.subscribe();
                let (rows, cols) = self.guard.tracker.size();
                let joined = Joined {
                    screen: self.guard.tracker.screen_formatted(),
                    cols: u32::from(cols),
                    rows: u32::from(rows),
                    detached,
                    watchers: self.watchers.json(),
                    pending: self.pending_notice.clone(),
                    rx,
                };
                if reply.send(joined).is_err() {
                    // 那一端剛好走了。/ That side just left.
                    if fresh {
                        self.watchers.leave(wid);
                    }
                    return Vec::new();
                }
                if !fresh {
                    return Vec::new();
                }
                let mut out = Vec::new();
                if let Some(t) = self.announce(&watching::watching_text(&name)).await {
                    out.push(ToOwner::Text(t));
                }
                out.extend(self.watchers_changed());
                out
            }
            WatchCmd::Leave { id } => {
                let Some((w, had)) = self.watchers.leave(id) else { return Vec::new() };
                let mut out = Vec::new();
                if had {
                    self.controller = None;
                    self.audit_change(state, &Change::Revoked { who: w.username.clone(), by_owner: false }).await;
                }
                if let Some(t) = self.announce(&watching::stopped_text(&w.username)).await {
                    out.push(ToOwner::Text(t));
                }
                out.extend(self.watchers_changed());
                out
            }
            WatchCmd::Control { id, want, force } => match self.watchers.control(id, want, force) {
                Some(change) => self.apply_change(state, change).await,
                None => Vec::new(),
            },
            WatchCmd::Input { id, text } => {
                if self.watchers.has_control(id) {
                    self.input(state, &text).await;
                }
                Vec::new()
            }
        }
    }

    /// 被看的人回應「想打字」：允許 / 拒絕。/ The watched user answers a request to type.
    async fn answer(&mut self, state: &AppState, id: u64, allow: bool) -> Vec<ToOwner> {
        match self.watchers.answer(id, allow) {
            Some(change) => self.apply_change(state, change).await,
            None => Vec::new(),
        }
    }

    /// 被看的人收回控制權。/ The watched user takes control back.
    async fn revoke(&mut self, state: &AppState) -> Vec<ToOwner> {
        match self.watchers.revoke() {
            Some(change) => self.apply_change(state, change).await,
            None => Vec::new(),
        }
    }

    /// 控制權變了：指令規則的歸屬、提示、稽核、狀態。/ Control changed: rule attribution, notice, audit, state.
    async fn apply_change(&mut self, state: &AppState, change: Change) -> Vec<ToOwner> {
        self.controller = self.watchers.controller().map(|w| Requester { user_id: w.user_id, username: w.username.clone(), ..self.requester.clone() });
        let mut out = Vec::new();
        if let Some(t) = self.announce(&watching::change_text(&change)).await {
            out.push(ToOwner::Text(t));
        }
        self.audit_change(state, &change).await;
        out.extend(self.watchers_changed());
        out
    }

    async fn audit_change(&self, state: &AppState, change: &Change) {
        if let Some((kind, msg)) = watching::change_event(change, &self.requester.username, &self.id) {
            state.gateway.event(kind, None, self.port, Some(self.requester.tunnel_id), msg).await;
        }
    }

    /// 誰在看的狀態給大家（被看的人與看的人）。/ The watchers state for everyone.
    fn watchers_changed(&self) -> Vec<ToOwner> {
        let v = self.watchers.json();
        self.fan_out(&v);
        vec![ToOwner::Frame(v)]
    }

    async fn resize(&mut self, size: WindowSize) {
        self.size = size;
        self.fan_out(&json!({ "type": "resize", "cols": size.cols, "rows": size.rows }));
        self.guard.tracker.resize(size.rows.min(u32::from(u16::MAX)) as u16, size.cols.min(u32::from(u16::MAX)) as u16);
        if let Some(r) = self.recorder.as_mut() {
            r.resize(size.cols, size.rows).await;
        }
        let r = match &self.pty {
            Pty::Channel(s) => s.resize(size).await,
            Pty::Process(p) => p.resize(size.rows as u16, size.cols as u16, size.width as u16, size.height as u16).map_err(Into::into),
        };
        if let Err(e) = r {
            tracing::warn!(error = %e, "Terminal resize failed");
        }
    }

    /// 瀏覽器打的字（等核准時只認 Ctrl+C）。/ Browser input (only Ctrl+C counts while waiting for approval).
    async fn input(&mut self, state: &AppState, input: &str) {
        let ctrl_c = input.contains('\x03');
        match &mut self.hold {
            // 等核准：只認 Ctrl+C（撤回），其他按鍵丟掉。/ Waiting for approval: only Ctrl+C (withdraw) counts.
            Some(Hold::Pending { id, .. }) => {
                if ctrl_c {
                    command_rules::cancel(state, *id, "withdrawn in the terminal").await;
                }
            }
            // 正在讀畫面：其他按鍵排在後面。/ Reading the screen: other keys queue up.
            Some(Hold::Settle { rest, .. }) if !ctrl_c => rest.push_str(input),
            // Ctrl+C：不送這次的 Enter。/ Ctrl+C: drop the held Enter.
            Some(Hold::Settle { .. }) => {
                self.hold = None;
                self.guard.reset();
                pty_write(&self.pty, b"\x03").await;
            }
            None => {
                let typist = self.line_requester().user_id;
                self.hold = feed(state, &mut self.guard, &self.pty, self.requester.tunnel_id, typist, input.to_string()).await
            }
        }
    }

    /// 停住的 Enter 有下一步了；回傳要給瀏覽器的通知。/ The held Enter's next step; returns the notices for the browser.
    async fn hold_step(&mut self, state: &AppState, ev: HoldEvent) -> Vec<Value> {
        let tunnel_id = self.requester.tunnel_id;
        match ev {
            // 回顯到齊：讀畫面上那一行，比對規則。/ The echo is in: read the line and match the rules.
            HoldEvent::Read => {
                let Some(Hold::Settle { rest, .. }) = self.hold.take() else { return Vec::new() };
                let lines = self.guard.tracker.candidates();
                let shown = lines.first().cloned().unwrap_or_default();
                let requester = self.line_requester();
                match command_rules::check(state, &requester, &lines).await {
                    None => {
                        pty_write(&self.pty, b"\r").await;
                        self.guard.reset();
                        self.hold = feed(state, &mut self.guard, &self.pty, tunnel_id, requester.user_id, rest).await;
                        Vec::new()
                    }
                    // 提醒：照樣送出 Enter，瀏覽器顯示一行提示。/ A reminder: the Enter goes out, the browser shows a note.
                    Some(rule) if rule.action == Action::Warn => {
                        pty_write(&self.pty, b"\r").await;
                        self.guard.reset();
                        self.hold = feed(state, &mut self.guard, &self.pty, tunnel_id, requester.user_id, rest).await;
                        vec![json!({ "type": "command", "state": "warned", "command": shown, "rule": command_rules::matched_json(&rule) })]
                    }
                    Some(rule) if rule.action == Action::Block => {
                        pty_write(&self.pty, b"\x03").await;
                        self.guard.reset();
                        command_rules::record_block(state, &requester, &shown, &rule).await;
                        vec![json!({ "type": "command", "state": "blocked", "command": shown, "rule": command_rules::matched_json(&rule) })]
                    }
                    Some(rule) => match command_rules::request(state, &requester, &shown, &rule).await {
                        Ok((row, rx)) => {
                            let can_decide = command_rules::decides(state, self.user_id, &row).await;
                            let n = json!({
                                "type": "command",
                                "state": "pending",
                                "command": shown,
                                "rule": command_rules::matched_json(&rule),
                                "request": command_rules::event_json(&row, self.tunnel_name.as_deref()),
                                "can_decide": can_decide,
                            });
                            self.pending_notice = Some(n.clone());
                            self.hold = Some(Hold::Pending { rest, id: row.id, rx });
                            vec![n]
                        }
                        Err(e) => {
                            tracing::warn!(error = format!("{e:#}"), "command rules: could not file an approval request");
                            pty_write(&self.pty, b"\x03").await;
                            self.guard.reset();
                            vec![json!({ "type": "command", "state": "error", "command": shown, "rule": command_rules::matched_json(&rule) })]
                        }
                    },
                }
            }
            // 有結果了：核准就送出 Enter，其他都取消這一行。/ Decided: approved sends the Enter, anything else cancels the line.
            HoldEvent::Decided(outcome) => {
                let Some(Hold::Pending { rest, id, .. }) = self.hold.take() else { return Vec::new() };
                self.pending_notice = None;
                let approved = matches!(outcome, Outcome::Approved { .. }) && command_rules::mark_used(state, id).await;
                self.guard.reset();
                if approved {
                    pty_write(&self.pty, b"\r").await;
                    let typist = self.line_requester().user_id;
                    self.hold = feed(state, &mut self.guard, &self.pty, tunnel_id, typist, rest).await;
                } else {
                    pty_write(&self.pty, b"\x03").await;
                }
                vec![outcome_notice(id, &outcome)]
            }
        }
    }
}

pub async fn handle(state: AppState, mut socket: WebSocket, meta: ClientMeta) {
    let (user, msg, mut signout) = match auth::first_message(&state, &mut socket).await {
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
    // 功能權限先、隧道權限後；區網主機的終端機另外要「區網探索」。/ Feature gate first; a LAN-host terminal also needs `network`.
    let mut needed = vec![crate::features::Feature::Terminal];
    if auth::id_field(&msg, "lan_host_id").is_some() {
        needed.push(crate::features::Feature::Network);
    }
    for f in needed {
        if let Err(code) = auth::require_feature(&state, &user, f).await {
            tracing::warn!(user = %user.username, feature = f.id(), "Terminal refused: feature turned off");
            close_with(&mut socket, code, f.id()).await;
            return;
        }
    }
    let reverse_port = match resolve_access(&state, user.id, &server_id, &username, msg.get("step_up").and_then(|v| v.as_str())).await {
        Ok(p) => p,
        Err(code) => {
            tracing::error!(user = %user.username, server_id, code, "Terminal access denied");
            close(&mut socket, code).await;
            return;
        }
    };
    let tunnel_id: i64 = server_id.parse().unwrap_or(0);
    let lan_raw = auth::id_field(&msg, "lan_host_id");

    // 接回斷線保留的 shell，或開一個新的。/ Resume a kept shell, or open a new one.
    let resume = msg.get("resume").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    let resumed = resume.is_some();
    let mut shell = match resume {
        Some(id) => match take_over(&state, &id, user.id, tunnel_id, &username, lan_raw.as_deref()).await {
            Ok(s) => {
                tracing::info!(user = %user.username, shell = %id, "Terminal shell resumed");
                s
            }
            Err(code) => {
                let reason = if code == terminal_detach::CLOSE_SHELL_GONE { "shell_gone" } else { "" };
                close_with(&mut socket, code, reason).await;
                return;
            }
        },
        None => match open_shell(&state, &user, &meta, &msg, tunnel_id, reverse_port, &username, lan_raw.as_deref()).await {
            Ok(s) => s,
            Err(code) => {
                close(&mut socket, code).await;
                return;
            }
        },
    };

    // 先告訴瀏覽器這個 shell 的代號與保留時間，再補輸出（新的 shell 只有「這段會錄影」那行）。
    // Tell the browser the shell id and its grace first, then the replay (a new shell only has the "recorded" line).
    let (grace, decided_by) = terminal_detach::grace_for(&state, user.id, tunnel_id).await;
    let seen = if resumed { msg.get("offset").and_then(Value::as_u64) } else { Some(0) };
    let replay = shell.backlog.replay(seen);
    notice(
        &mut socket,
        json!({
            "type": "shell",
            "id": shell.id,
            "resumed": resumed,
            "offset": replay.offset,
            "reset": replay.reset,
            "detach": { "secs": grace, "by": decided_by.as_str() },
            "size": { "cols": shell.size.cols, "rows": shell.size.rows },
        }),
    )
    .await;
    if !replay.text.is_empty() {
        let _ = send_text(&mut socket, replay.text).await;
    }
    for n in std::mem::take(&mut shell.stash) {
        notice(&mut socket, n).await;
    }
    if resumed {
        if let Some(n) = shell.pending_notice.clone() {
            notice(&mut socket, n).await;
        }
    }
    // 有人在看（或在等你回應想打字）：接回時也要知道。/ Someone is watching (or waiting to type): tell the resumed page.
    if !shell.watchers.is_empty() {
        notice(&mut socket, shell.watchers.json()).await;
    }

    let exit = attached(&state, &mut socket, &mut shell, &mut signout).await;
    match exit {
        Exit::End(note) => finish(&state, shell, note).await,
        Exit::TakenOver(tx) => {
            close_with(&mut socket, terminal_detach::CLOSE_TAKEN_OVER, "resumed in another window").await;
            // 接手的那一方剛好也斷了：當作斷線。/ The taker vanished meanwhile: treat it as a drop.
            if let Err(back) = tx.send(shell) {
                detach(state, back, signout).await;
            }
        }
        Exit::Detach => detach(state, shell, signout).await,
    }
}

/// socket 斷了：保留時間 0 就收掉，否則交給 [`keep`]。/ The socket dropped: end at 0 grace, else hand it to [`keep`].
async fn detach(state: AppState, shell: Box<Shell>, signout: auth::SessionWatch) {
    // 現在的設定為準（使用者或管理員可能剛改過）。/ The settings as of now (they may have just changed).
    let (grace, by) = terminal_detach::grace_for(&state, shell.user_id, shell.requester.tunnel_id).await;
    if grace == 0 {
        finish(&state, shell, None).await;
        return;
    }
    tracing::info!(shell = %shell.id, grace, by = by.as_str(), "Terminal detached; keeping the shell");
    tokio::spawn(keep(state, shell, grace, signout));
}

/// 斷線保留：shell 照跑（輸出照錄、照進緩衝），直到有人接回、時間到、被結束或登出。
/// Detached: the shell keeps running (recorded, buffered) until someone resumes it, time is up, it is ended or signed out.
async fn keep(state: AppState, mut shell: Box<Shell>, grace: u64, mut signout: auth::SessionWatch) {
    let ends = chrono::Utc::now() + chrono::Duration::seconds(grace as i64);
    let marker = (now_db(), db_time(ends));
    shell.presence.set_detached(Some(marker.clone()));
    state.shells.set_detached(&shell.id, true);
    shell.fan_out(&json!({ "type": "detached", "detached": true }));
    // 一個人留太多：最舊的先結束。/ Too many for one person: the oldest go first.
    for pid in state.shells.over_limit(shell.user_id, terminal_detach::MAX_DETACHED_PER_USER) {
        state.presence.end(pid, "Telepy (too many detached shells)");
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(grace);
    let mut buf = vec![0u8; 8192];
    loop {
        tokio::select! {
            Some(tx) = shell.takeover.recv() => {
                shell.presence.set_detached(None);
                state.shells.set_detached(&shell.id, false);
                shell.fan_out(&json!({ "type": "detached", "detached": false }));
                match tx.send(shell) {
                    Ok(()) => return,
                    // 要接回的 socket 剛好又斷了：繼續留著。/ The resuming socket vanished: keep holding it.
                    Err(back) => {
                        shell = back;
                        shell.presence.set_detached(Some(marker.clone()));
                        state.shells.set_detached(&shell.id, true);
                        shell.fan_out(&json!({ "type": "detached", "detached": true }));
                    }
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                tracing::info!(shell = %shell.id, grace, "Detached terminal expired");
                finish(&state, shell, Some(format!("ended after {grace} s detached"))).await;
                return;
            }
            // 即時 session 頁、功能被關掉、權限被拿掉（`terminal_detach::recheck`）都走這裡。
            // The live sessions page, a feature turned off, access removed (`access_recheck::recheck`) all land here.
            by = shell.presence.ended() => {
                let note = match shell.presence.why() {
                    Some(why) => format!("ended by {by} while detached: {why}"),
                    None => format!("ended by {by} while detached"),
                };
                finish(&state, shell, Some(note)).await;
                return;
            }
            _ = signout.ended() => {
                finish(&state, shell, Some("signed out while detached".into())).await;
                return;
            }
            ev = hold_event(&mut shell.hold, &shell.guard) => {
                // 等核准的通知由 pending_notice 帶；其他結果接回時補送。/ Pending is carried by pending_notice; outcomes are stashed.
                for n in shell.hold_step(&state, ev).await {
                    shell.fan_out(&n);
                    if n["state"] != "pending" {
                        shell.stash.push(n);
                    }
                }
            }
            // 看的人：提示已經進緩衝，狀態接回時再送。/ Watchers: notices are in the backlog, the state is sent on reattach.
            Some(cmd) = shell.watch_cmds.recv() => {
                let _ = shell.on_watch(&state, cmd, true).await;
            }
            read = read_pty(&mut shell.pty, &mut buf) => match read {
                Ok(n) if n > 0 => {
                    let _ = shell.output(&buf[..n]).await;
                }
                Ok(_) => {
                    finish(&state, shell, Some("the shell exited while detached".into())).await;
                    return;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "PTY read failed while detached");
                    finish(&state, shell, Some("the shell exited while detached".into())).await;
                    return;
                }
            },
        }
    }
}

/// 接著一個 socket 跑，直到它放手。/ Run the shell on one socket until it lets go.
async fn attached(state: &AppState, socket: &mut WebSocket, shell: &mut Shell, signout: &mut auth::SessionWatch) -> Exit {
    let mut heartbeat = Heartbeat::new(&state.config);
    let mut buf = vec![0u8; 8192];
    loop {
        tokio::select! {
            incoming = heartbeat.recv(socket) => match incoming {
                Some(Ok(Message::Text(t))) => {
                    let Ok(data) = serde_json::from_str::<Value>(&t) else {
                        tracing::warn!("Terminal received malformed JSON; ignoring frame");
                        continue;
                    };
                    match data.get("action").and_then(|a| a.as_str()) {
                        Some("ping") => {
                            if !send(socket, Message::Binary(Bytes::from_static(b"pong"))).await {
                                return Exit::Detach;
                            }
                        }
                        Some("pty_input") => {
                            if let Some(input) = data.pointer("/payload/input").and_then(|i| i.as_str()) {
                                shell.input(state, input).await;
                            }
                        }
                        // 終端機上方提示列的「撤回」。/ The banner's withdraw button.
                        Some("command_cancel") => {
                            if let Some(Hold::Pending { id, .. }) = &shell.hold {
                                command_rules::cancel(state, *id, "withdrawn in the terminal").await;
                            }
                        }
                        Some("pty_resize") => {
                            if let Some(size) = window_size(&data) {
                                shell.resize(size).await;
                            }
                        }
                        // 回應看的人「想打字」：`{action:"watch_answer", watcher, allow}`。/ Answer a watcher's request to type.
                        Some("watch_answer") => {
                            if let Some(id) = data.get("watcher").and_then(Value::as_u64) {
                                let allow = data.get("allow").and_then(Value::as_bool).unwrap_or(false);
                                let out = shell.answer(state, id, allow).await;
                                if !to_owner(socket, out).await {
                                    return Exit::Detach;
                                }
                            }
                        }
                        // 收回控制權。/ Take control back.
                        Some("watch_revoke") => {
                            let out = shell.revoke(state).await;
                            if !to_owner(socket, out).await {
                                return Exit::Detach;
                            }
                        }
                        // 關分頁 / 換帳號：明確結束，不保留。/ Closing the tab / switching account: an explicit end, never kept.
                        Some("end") => {
                            send(socket, Message::Close(None)).await;
                            return Exit::End(None);
                        }
                        _ => {}
                    }
                }
                // 沒說 end 的關閉（重新整理、離開頁面、網路斷）= 斷線。/ A close without `end` (reload, navigation, network) = a drop.
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Exit::Detach,
                Some(Ok(_)) => {}
            },
            ev = hold_event(&mut shell.hold, &shell.guard) => {
                for n in shell.hold_step(state, ev).await {
                    shell.fan_out(&n);
                    notice(socket, n).await;
                }
            }
            Some(cmd) = shell.watch_cmds.recv() => {
                let out = shell.on_watch(state, cmd, false).await;
                if !to_owner(socket, out).await {
                    return Exit::Detach;
                }
            }
            // 有人從即時 session 頁結束了它。/ Someone ended it from the live sessions page.
            by = shell.presence.ended() => {
                close_with(socket, CLOSE_ENDED, &by).await;
                return Exit::End(Some(match shell.presence.why() {
                    Some(why) => format!("ended by {by}: {why}"),
                    None => format!("ended by {by}"),
                }));
            }
            // 這個瀏覽器的登入被撤銷了：shell 跟著結束，不保留。/ This browser's sign-in was revoked: the shell ends too.
            reason = signout.ended() => {
                close_with(socket, auth::CLOSE_SIGNED_OUT, &reason).await;
                return Exit::End(Some("signed out".into()));
            }
            Some(tx) = shell.takeover.recv() => return Exit::TakenOver(tx),
            read = read_pty(&mut shell.pty, &mut buf) => match read {
                Ok(0) => {
                    // shell 已結束 → 正常關閉。/ EOF: the shell exited; close normally.
                    send(socket, Message::Close(None)).await;
                    return Exit::End(None);
                }
                Ok(n) => {
                    let text = shell.output(&buf[..n]).await;
                    if !text.is_empty() && !send_text(socket, text).await {
                        return Exit::Detach;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "PTY read failed");
                    send(socket, Message::Close(None)).await;
                    return Exit::End(None);
                }
            },
        }
    }
}

/// 把提示行與狀態送給被看的人；socket 斷了回 false。/ Send notices and state to the watched user; false when gone.
async fn to_owner(socket: &mut WebSocket, out: Vec<ToOwner>) -> bool {
    for m in out {
        let ok = match m {
            ToOwner::Text(t) => send_text(socket, t).await,
            ToOwner::Frame(v) => send(socket, Message::Binary(Bytes::from(v.to_string()))).await,
        };
        if !ok {
            return false;
        }
    }
    true
}

/// 收掉 shell：撤回等核准的指令、離開「使用中」、記結束、收錄影、關 channel / 程序。
/// End the shell: withdraw a pending command, leave presence, audit, finish the recording, close the PTY.
async fn finish(state: &AppState, shell: Box<Shell>, note: Option<String>) {
    // 看的人：shell 結束了。/ Watchers: the shell is over.
    shell.fan_out(&json!({ "type": "ended", "note": note }));
    let Shell { id, hold, presence, audit, recorder, mut pty, .. } = *shell;
    // 還在等核准的指令跟著取消。/ A command still waiting for approval is withdrawn.
    if let Some(Hold::Pending { id, .. }) = &hold {
        command_rules::cancel(state, *id, "the terminal was closed").await;
    }
    state.shells.remove(&id);
    // 人已經走了：先移出「使用中」，收 channel / 程序再慢也不影響。/ Leave presence before the (possibly slow) teardown.
    drop(presence);
    tracing::info!(shell = %id, note = ?note, "Terminal session closed");
    audit.close_with(state, note.as_deref()).await;
    if let Some(r) = recorder {
        r.finish(state).await;
    }
    match &mut pty {
        Pty::Channel(s) => s.close().await,
        Pty::Process(p) => p.terminate().await,
    }
}

/// 從持有者手上接過 shell（連著的 socket 或斷線保留的工作）。/ Take the shell over from whoever holds it.
async fn take_over(state: &AppState, id: &str, user_id: i64, tunnel_id: i64, account: &str, lan_host: Option<&str>) -> Result<Box<Shell>, u16> {
    let gone = terminal_detach::CLOSE_SHELL_GONE;
    let tx = state.shells.claim(id, user_id, tunnel_id, account, lan_host).map_err(|r| match r {
        Refusal::Gone => gone,
        Refusal::NotYours => 4004,
    })?;
    let (otx, orx) = oneshot::channel();
    tx.send(otx).await.map_err(|_| gone)?;
    match tokio::time::timeout(Duration::from_secs(10), orx).await {
        Ok(Ok(shell)) => Ok(shell),
        _ => Err(gone),
    }
}

/// 開一個新的 shell（裝置本身或經裝置的區網主機）並登記。/ Open a new shell (the device or a LAN host behind it) and register it.
#[allow(clippy::too_many_arguments)]
async fn open_shell(state: &AppState, user: &User, meta: &ClientMeta, msg: &Value, tunnel_id: i64, reverse_port: i64, username: &str, lan_raw: Option<&str>) -> Result<Box<Shell>, u16> {
    // 區網終端機的稽核說明（連上之後才記開始）。/ The LAN terminal's audit line, recorded once it is open.
    let mut lan_audit: Option<String> = None;
    // 錄影用的區網主機標示（`login@address`）。/ The LAN host label for the recording.
    let mut lan_label: Option<String> = None;
    // 區網那一跳的金鑰 / 密碼檔：shell 結束才刪。/ The hop's key / password files, kept until the shell ends.
    let mut lan_auth_files: Option<LanAuthFiles> = None;
    // 「指令不寫進歷史檔」的結果（只有裝置本身的 shell；區網主機那一跳不知道對面是什麼 shell）。
    // What came of "keep commands out of the history" (device shells only; the LAN hop's shell is unknown).
    let mut history: Option<crate::shell_history::Applied> = None;
    // 區網主機（經裝置跳過去）：主機要屬於這條隧道，帳號要是安全字元。/ A LAN host behind the device.
    let pty = match lan_raw {
        None => {
            if device_offline(state, reverse_port) {
                tracing::warn!(user = %user.username, tunnel_id, "Terminal refused: device offline");
                return Err(4005);
            }
            // 不寫歷史檔：先用 exec 問登入 shell（PTY 開了之後就不能讓探測跟 shell 搶輸出）。
            // Keeping history out: ask for the login shell first, with an exec (before the PTY exists).
            let login_shell = match crate::shell_history::effective_for(state, user.id, tunnel_id).await.0 {
                crate::shell_history::Mode::Skip => Some(state.pool.login_shell(state, reverse_port, username).await),
                crate::shell_history::Mode::Keep => None,
            };
            let opened = async {
                let (lease, channel) = state.pool.session_channel(state, reverse_port, username).await?;
                PtySession::open(lease, channel, WindowSize::default()).await
            };
            match opened.await {
                Ok(mut s) => {
                    if let Some(shell) = &login_shell {
                        let applied = s.keep_history_out(shell).await;
                        tracing::info!(user = %user.username, tunnel_id, %username, result = applied.status(), shell = %shell.label(), "Terminal shell history");
                        history = Some(applied);
                    }
                    Pty::Channel(s)
                }
                Err(e) => {
                    tracing::error!(error = format!("{e:#}"), "Error starting SSH connection");
                    return Err(4005);
                }
            }
        }
        Some(raw) => {
            let host = match raw.parse::<i64>() {
                Ok(hid) => db::lan::host_by_id(&state.db, hid).await.ok().flatten().filter(|h| h.tunnel_id == tunnel_id),
                Err(_) => None,
            };
            let Some(host) = host else {
                tracing::error!(user = %user.username, tunnel_id, lan_host = %raw, "LAN host not found for this tunnel");
                return Err(4004);
            };
            let login = msg.get("lan_username").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).or(host.username.clone());
            let Some(login) = login.filter(|l| valid_login(l)) else {
                tracing::error!(user = %user.username, lan_host = host.id, "LAN terminal without a valid login name");
                return Err(4003);
            };
            // 怎麼登入那台機器：Telepy 的金鑰（預設）、直接問密碼、或憑證庫的 ssh 登入（要是自己的、綁這台主機的；不行 = 4010）。
            // How to log in there: Telepy's keys (default), a password prompt, or a saved ssh login (own, bound to this host; else 4010).
            let (lan_auth, auth_note) = match msg.get("lan_auth").and_then(|v| v.as_str()).unwrap_or("telepy") {
                "prompt" => (LanAuth::Prompt, "password prompt".to_string()),
                "credential" => {
                    let cid = auth::id_field(msg, "lan_credential_id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                    match crate::api::credentials::unseal_for(state, user.id, cid, tunnel_id, Some(host.id), "ssh").await {
                        Ok((row, plain)) => {
                            let secret = crate::api::credentials::SshSecret::parse(&plain);
                            (LanAuth::Credential { private_key: secret.private_key, password: secret.password }, format!("saved login '{}'", row.label))
                        }
                        Err(e) => {
                            tracing::warn!(user = %user.username, lan_host = host.id, credential = cid, error = ?e, "LAN terminal: saved login unusable");
                            return Err(4010);
                        }
                    }
                }
                _ => (LanAuth::Telepy, "Telepy's key".to_string()),
            };
            lan_audit = Some(format!("Web terminal by {} to {}@{}:{} through {}@device with {}", user.username, login, host.address, host.ssh_port, username, auth_note));
            // 區網主機那一跳的 shell 不知道是什麼：不打任何東西，但要說清楚這裡不算。/ The hop's shell is unknown: say it isn't covered.
            if crate::shell_history::effective_for(state, user.id, tunnel_id).await.0 == crate::shell_history::Mode::Skip {
                history = Some(crate::shell_history::Applied::Unsupported { shell: "a LAN host's shell".into() });
            }
            lan_label = Some(format!("{login}@{}", host.address));
            if device_offline(state, reverse_port) {
                return Err(4005);
            }
            // 第一跳：池子那條裝置連線上、由裝置 sshd 開往區網主機的 direct-tcpip；OpenSSH 連本機一次性入口。
            let lan_port = u16::try_from(host.ssh_port).unwrap_or(22);
            let entry = async {
                let lease = state.pool.acquire(state, reverse_port, username).await?;
                crate::ssh::bridge::one_shot(state.clone(), lease, host.address.clone(), lan_port).await
            };
            let local_port = match entry.await {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!(error = format!("{e:#}"), "Error reaching the device for the LAN hop");
                    return Err(4005);
                }
            };
            // 這條隧道自己的服務金鑰（OpenSSH 格式）給 Telepy 模式用。/ The tunnel's own key (OpenSSH text) for the Telepy mode.
            let tunnel_key = match lan_auth {
                LanAuth::Telepy => crate::ssh::tunnel_keys::private(state, tunnel_id).await.and_then(|k| k.to_openssh(russh::keys::ssh_key::LineEnding::LF).ok()).map(|z| z.to_string()),
                _ => None,
            };
            let files = match prepare_lan_auth(&lan_auth, tunnel_key.as_deref(), Some(state.config.ssh_identity.as_path())) {
                Ok(f) => f,
                Err(e) => {
                    tracing::error!(error = %e, "Error preparing the LAN hop's credentials");
                    return Err(4005);
                }
            };
            let mut args = lan_terminal_args(&login, &host.address, local_port);
            // 認證參數放在目的地（最後一個參數）前面。/ Auth options go before the destination (the last argument).
            let dest = args.pop().unwrap_or_default();
            args.extend(files.args.iter().cloned());
            args.push(dest);
            let spawned = spawn_in_pty(&state.config.ssh_binary, &args, &files.envs);
            lan_auth_files = Some(files);
            match spawned {
                Ok(p) => Pty::Process(p),
                Err(e) => {
                    tracing::error!(error = %e, "Error starting SSH connection");
                    return Err(4005);
                }
            }
        }
    };
    tracing::info!(%username, reverse_port, "SSH connection started");
    // 連線期間算「在用這條隧道」。/ Counts as using the tunnel while connected.
    let presence = state.presence.join(Entry::new(tunnel_id, user.id, &user.username, Kind::Terminal, meta.ip.clone()).as_account(username));
    let tunnel_row = db::tunnels::by_id(&state.db, tunnel_id).await.ok().flatten();
    let audit = match lan_audit {
        Some(what) => {
            let what = match &history {
                Some(h) => format!("{what} ({})", h.audit_note()),
                None => what,
            };
            ConsoleSession::open(state, ConsoleKind::LanTerminal, tunnel_id, what).await
        }
        None => {
            let name = tunnel_row.as_ref().map(|t| t.host_friendly_name.clone()).unwrap_or_else(|| format!("#{tunnel_id}"));
            let mut what = crate::session_audit::describe(ConsoleKind::Terminal, &user.username, Some(username), &name);
            if let Some(h) = &history {
                what = format!("{what} ({})", h.audit_note());
            }
            ConsoleSession::open(state, ConsoleKind::Terminal, tunnel_id, what).await
        }
    };
    let session_kind = if lan_label.is_some() { "lan_terminal" } else { "terminal" };
    crate::session_audit::webhook_started(state, tunnel_id, user.id, &user.username, session_kind, Some(lan_label.as_deref().unwrap_or(username))).await;

    // 這條隧道要錄影：先告訴使用者（緩衝裡的第一行），再開始錄（只錄輸出與視窗大小，不錄鍵盤）。
    // Recorded tunnel: tell the user first (the backlog's first line), then record (output and resizes only, never keystrokes).
    let mut backlog = Backlog::default();
    let recorder = match tunnel_row.as_ref().filter(|t| t.record_sessions) {
        Some(t) => {
            backlog.push(RECORDED_LINE);
            let title = format!("{} on {} as {}", user.username, t.host_friendly_name, lan_label.as_deref().unwrap_or(username));
            Recorder::start(state, t.id, user.id, &user.username, username, lan_label.as_deref(), &title).await
        }
        None => None,
    };
    // 歷史檔的結果也是一行提示（在 shell 的輸出之前）。/ The history result is a notice line too, before the shell's output.
    if let Some(h) = &history {
        backlog.push(&h.notice());
    }
    let requester = Requester {
        tunnel_id,
        user_id: user.id,
        username: user.username.clone(),
        source: Source::Terminal,
        account: username.to_string(),
        lan_host: lan_label,
        client: None,
        grant_id: None,
        token_id: None,
        session_ref: Some(presence.id().to_string()),
    };
    let id = crate::util::random_alnum(24);
    let (watch_tx, watch_cmds) = mpsc::channel(32);
    let takeover = state.shells.register(&id, ShellKey { user_id: user.id, tunnel_id, account: username, lan_host: lan_raw, presence_id: presence.id(), watch: Some(watch_tx) });
    Ok(Box::new(Shell {
        id,
        user_id: user.id,
        pty,
        _lan_auth: lan_auth_files,
        // 指令規則：輸出餵進畫面模型，Enter 先比對規則。/ Command rules: output feeds a screen model, Enter is checked first.
        guard: TerminalGuard::new(24, 80),
        hold: None,
        decoder: Utf8Decoder::default(),
        recorder,
        audit,
        presence,
        requester,
        tunnel_name: tunnel_row.map(|t| t.host_friendly_name),
        backlog,
        stash: Vec::new(),
        pending_notice: None,
        size: WindowSize::default(),
        takeover,
        watchers: Watchers::default(),
        watch_out: broadcast::channel(watching::QUEUE).0,
        watch_cmds,
        controller: None,
        port: u16::try_from(reverse_port).ok(),
    }))
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
