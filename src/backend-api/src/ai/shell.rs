//! MCP agent 的互動 shell：AI session 那條裝置連線上的一條 PTY channel（`xterm-256color`），給 TUI 程式與會問問題的指令用。
//! agent 用 `shell_send` 送按鍵（含 Ctrl+C 之類的控制字元）、`shell_read` 讀新的輸出 **與** 現在整個畫面（vt100 模型，
//! 和網頁終端機的指令規則共用 `LineTracker`），所以 agent 看得到 top、vim、選單。
//! 指令規則一樣管：按 Enter 時讀畫面上提示字元後面那一行（跟網頁終端機完全同一套 `TerminalGuard`），擋下就改送 Ctrl+C，
//! 要核准就像 `ssh_exec` 一樣等（最多 [`crate::command_rules::AGENT_WAIT`]），還在等時那一行留在提示上，核准後 agent 再送一次
//! Enter 就跑（10 分鐘內沿用那次核准）。
//! 輸出由一個背景工作持續讀（agent 沒在讀也要餵畫面模型與錄影），沒讀走的最多留 [`BUFFER_CAP`]，超過丟最舊的。
//! An MCP agent's interactive shell: one PTY channel on the AI session's device connection. `shell_send` writes raw
//! keystrokes, `shell_read` returns new output plus the current screen (a vt100 model shared with the web terminal's
//! command rules). Command rules gate Enter exactly like the web terminal: blocked → Ctrl+C, approval → wait like
//! `ssh_exec`; a line still waiting stays on the prompt and a later Enter re-reads it. A background task keeps
//! reading output (screen model + recording) whether or not the agent reads; unread output is capped.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use russh::client::{Handle, Msg};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use tokio::sync::{Notify, OwnedSemaphorePermit};

use crate::command_rules::{self, terminal::TerminalGuard, Action, AgentApproval, Requester, Rule};
use crate::recording::Recorder;
use crate::ssh::device::ClientHandler;
use crate::state::AppState;
use crate::ws::terminal::Utf8Decoder;

/// 每個 AI session 最多幾個 shell。/ Shells per AI session.
pub const MAX_SHELLS_PER_SESSION: usize = 2;
/// 沒讀走的輸出最多留多少 bytes（超過丟掉最舊的）。/ Unread output kept at most (oldest dropped beyond it).
pub const BUFFER_CAP: usize = 256 * 1024;
/// `shell_read` 預設 / 最多等新輸出多久。/ Default / maximum wait for new output in `shell_read`.
pub const DEFAULT_READ_WAIT: Duration = Duration::from_millis(1500);
pub const MAX_READ_WAIT: Duration = Duration::from_millis(10_000);
/// 一次 `shell_read` 預設 / 最多回多少 bytes。/ Default / maximum bytes one `shell_read` returns.
pub const DEFAULT_MAX_READ: usize = 64 * 1024;
pub const MAX_READ: usize = 1024 * 1024;
/// 一次 `shell_send` 最多送多少。/ The most one `shell_send` may write.
pub const MAX_INPUT: usize = 64 * 1024;
/// 稽核裡留的輸入字元數（像 `ssh_exec` 存指令那樣）。/ Characters of the input kept in the audit row.
pub const AUDIT_INPUT_CHARS: usize = 200;
pub const MIN_COLS: u32 = 20;
pub const MAX_COLS: u32 = 500;
pub const MIN_ROWS: u32 = 5;
pub const MAX_ROWS: u32 = 200;

struct State {
    guard: TerminalGuard,
    /// 還沒被 `shell_read` 拿走的輸出。/ Output not yet taken by `shell_read`.
    buffer: Vec<u8>,
    /// 因為超過 [`BUFFER_CAP`] 丟掉的 bytes（下次讀時回報並歸零）。/ Bytes dropped past the cap (reported on the next read).
    dropped: u64,
    /// shell 結束了（exit status）。/ The shell ended (its exit status).
    exited: Option<Option<u32>>,
    last_used: Instant,
    cols: u32,
    rows: u32,
}

pub struct AiShell {
    pub id: String,
    pub session_id: String,
    pub tunnel_id: i64,
    pub created: Instant,
    /// 這個 shell 有錄影。/ This shell is being recorded.
    pub recorded: bool,
    tx: ChannelWriteHalf<Msg>,
    state: Mutex<State>,
    /// 有新輸出或 shell 結束時喚醒等著讀的人。/ Wakes readers on new output or exit.
    changed: Notify,
    /// 送輸入（含等核准）一次一個。/ Sends (approval waits included) one at a time.
    send_lock: tokio::sync::Mutex<()>,
    recorder: tokio::sync::Mutex<Option<Recorder>>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
    /// session 的 channel 配額（跟 exec 共用）。/ A slot of the session's channel cap (shared with exec).
    _slot: OwnedSemaphorePermit,
}

/// 一次 `shell_read` 的結果。/ What one `shell_read` returns.
#[derive(Debug, Clone)]
pub struct ReadResult {
    pub output: Vec<u8>,
    pub dropped: u64,
    pub screen: String,
    pub cursor: (u16, u16),
    pub size: (u32, u32),
    /// 還有沒讀完的（這次超過 max_bytes）。/ More is waiting (this read hit max_bytes).
    pub more: bool,
    pub exited: Option<Option<u32>>,
}

/// `shell_send` 碰到指令規則時的結果。/ How a `shell_send` ended when a command rule stepped in.
#[derive(Debug)]
pub enum Hold {
    /// 全部送出去了。/ Everything went out.
    Sent,
    /// 擋下：那一行改送了 Ctrl+C。/ Blocked: Ctrl+C went out instead of the Enter.
    Blocked { rule: Rule, command: String },
    /// 要核准，但沒通過。/ Needed approval and did not get it.
    Denied { rule: Rule, command: String, id: i64, message: String },
    /// 還在等核准：那一行留在提示上。/ Still waiting: the line stays on the prompt.
    Waiting { rule: Rule, command: String, id: i64 },
    /// 申請送不出去。/ The request could not be filed.
    Error { rule: Rule, command: String, message: String },
}

/// 送出去的結果。/ The result of one send.
#[derive(Debug)]
pub struct SendResult {
    /// 真的寫進 PTY 的 bytes。/ Bytes actually written to the PTY.
    pub sent: usize,
    /// 規則停下來之後沒送出的輸入（bytes）。/ Input left unsent after a rule stepped in.
    pub unsent: usize,
    pub hold: Hold,
}

pub fn clamp_size(cols: Option<u32>, rows: Option<u32>) -> (u32, u32) {
    (cols.unwrap_or(120).clamp(MIN_COLS, MAX_COLS), rows.unwrap_or(40).clamp(MIN_ROWS, MAX_ROWS))
}

/// 稽核用：輸入的前幾個字元，控制字元寫成 `^C` / `\r` 這類看得懂的樣子。/ For the audit row: the first characters, control chars made visible.
pub fn describe_input(input: &str) -> String {
    let mut out = String::new();
    for c in input.chars().take(AUDIT_INPUT_CHARS) {
        match c {
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\x1b' => out.push_str("\\e"),
            c if (c as u32) < 0x20 => out.push_str(&format!("^{}", ((c as u8) + 0x40) as char)),
            '\x7f' => out.push_str("^?"),
            c => out.push(c),
        }
    }
    if input.chars().count() > AUDIT_INPUT_CHARS {
        out.push('…');
    }
    out
}

impl AiShell {
    /// 在 session 的連線上開 PTY + shell。/ Open a PTY shell channel on the session's connection.
    #[allow(clippy::too_many_arguments)]
    pub async fn open(device: &Handle<ClientHandler>, session_id: &str, tunnel_id: i64, cols: u32, rows: u32, slot: OwnedSemaphorePermit, recorder: Option<Recorder>) -> anyhow::Result<Arc<Self>> {
        let channel = device.channel_open_session().await.context("open a channel (is the device still connected?)")?;
        if let Err(e) = channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await {
            let _ = channel.close().await;
            return Err(e).context("request a pty");
        }
        if let Err(e) = channel.request_shell(true).await {
            let _ = channel.close().await;
            return Err(e).context("request a shell");
        }
        let (rx, tx) = channel.split();
        let shell = Arc::new(Self {
            id: format!("sh_{}", crate::util::random_alnum(12).to_lowercase()),
            session_id: session_id.to_string(),
            tunnel_id,
            created: Instant::now(),
            recorded: recorder.is_some(),
            tx,
            state: Mutex::new(State {
                guard: TerminalGuard::new(rows.min(u32::from(u16::MAX)) as u16, cols.min(u32::from(u16::MAX)) as u16),
                buffer: Vec::new(),
                dropped: 0,
                exited: None,
                last_used: Instant::now(),
                cols,
                rows,
            }),
            changed: Notify::new(),
            send_lock: tokio::sync::Mutex::new(()),
            recorder: tokio::sync::Mutex::new(recorder),
            reader: Mutex::new(None),
            bytes_in: AtomicU64::new(0),
            bytes_out: AtomicU64::new(0),
            _slot: slot,
        });
        let task = tokio::spawn(read_loop(shell.clone(), rx));
        *shell.reader.lock().unwrap() = Some(task);
        Ok(shell)
    }

    fn touch(&self) {
        self.state.lock().unwrap().last_used = Instant::now();
    }
    pub fn idle_for(&self) -> Duration {
        self.state.lock().unwrap().last_used.elapsed()
    }
    pub fn exited(&self) -> Option<Option<u32>> {
        self.state.lock().unwrap().exited
    }
    pub fn size(&self) -> (u32, u32) {
        let s = self.state.lock().unwrap();
        (s.cols, s.rows)
    }
    pub fn bytes_in(&self) -> u64 {
        self.bytes_in.load(Ordering::SeqCst)
    }
    pub fn bytes_out(&self) -> u64 {
        self.bytes_out.load(Ordering::SeqCst)
    }

    async fn write(&self, bytes: &[u8]) -> anyhow::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.tx.data_bytes(bytes.to_vec()).await.context("write to the shell (is it still open?)")?;
        self.bytes_in.fetch_add(bytes.len() as u64, Ordering::SeqCst);
        Ok(())
    }

    /// 送輸入；碰到要決定的 Enter 就照指令規則處理。/ Send input, deciding every Enter through the command rules.
    pub async fn send(&self, state: &AppState, requester: &Requester, input: &str) -> anyhow::Result<SendResult> {
        let _lock = self.send_lock.lock().await;
        self.touch();
        let mut sent = 0usize;
        let mut input = input.to_string();
        loop {
            let split = self.state.lock().unwrap().guard.split(&input, Instant::now());
            self.write(split.send.as_bytes()).await?;
            sent += split.send.len();
            let Some(rest) = split.enter else { return Ok(SendResult { sent, unsent: 0, hold: Hold::Sent }) };
            let started = self.state.lock().unwrap().guard.tracker.started();
            if !started || command_rules::rules_for(state, self.tunnel_id).await.is_empty() {
                self.write(b"\r").await?;
                sent += 1;
                self.state.lock().unwrap().guard.reset();
                input = rest;
                continue;
            }
            // 等回顯到齊再讀畫面上那一行（跟網頁終端機一樣）。/ Wait for the echo, then read the line (as the web terminal does).
            let enter_at = Instant::now();
            loop {
                let at = self.state.lock().unwrap().guard.read_at(enter_at);
                if at <= Instant::now() {
                    break;
                }
                tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
            }
            let lines = self.state.lock().unwrap().guard.tracker.candidates();
            let command = lines.first().cloned().unwrap_or_default();
            let Some(rule) = command_rules::check(state, requester, &lines).await else {
                self.write(b"\r").await?;
                sent += 1;
                self.state.lock().unwrap().guard.reset();
                input = rest;
                continue;
            };
            let abandon = |s: &Self| s.state.lock().unwrap().guard.reset();
            match rule.action {
                Action::Allow => {
                    self.write(b"\r").await?;
                    sent += 1;
                    abandon(self);
                    input = rest;
                }
                Action::Block => {
                    self.write(b"\x03").await?;
                    sent += 1;
                    abandon(self);
                    command_rules::record_block(state, requester, &command, &rule).await;
                    return Ok(SendResult { sent, unsent: rest.len(), hold: Hold::Blocked { rule, command } });
                }
                Action::Approve => match command_rules::agent_approval(state, requester, &command, &rule).await {
                    Ok(AgentApproval::Approved { .. }) => {
                        self.write(b"\r").await?;
                        sent += 1;
                        abandon(self);
                        input = rest;
                    }
                    Ok(AgentApproval::Denied { id, message }) => {
                        self.write(b"\x03").await?;
                        sent += 1;
                        abandon(self);
                        return Ok(SendResult { sent, unsent: rest.len(), hold: Hold::Denied { rule, command, id, message } });
                    }
                    // 那一行留在提示上；核准後 agent 再送一次 Enter。/ The line stays; the agent sends Enter again once approved.
                    Ok(AgentApproval::Waiting { id }) => return Ok(SendResult { sent, unsent: rest.len(), hold: Hold::Waiting { rule, command, id } }),
                    Err(e) => {
                        self.write(b"\x03").await?;
                        sent += 1;
                        abandon(self);
                        return Ok(SendResult { sent, unsent: rest.len(), hold: Hold::Error { rule, command, message: format!("{e:#}") } });
                    }
                },
            }
        }
    }

    /// 讀新輸出：沒有就等最多 `wait`；回輸出、畫面與游標。/ Read new output, waiting up to `wait` for some; returns the screen too.
    pub async fn read(&self, wait: Duration, max_bytes: usize) -> ReadResult {
        self.touch();
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            // 先登記再檢查，免得漏掉中間到的通知。/ Register before checking so a notification in between is not missed.
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let s = self.state.lock().unwrap();
                if !s.buffer.is_empty() || s.exited.is_some() {
                    break;
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                break;
            }
        }
        let mut s = self.state.lock().unwrap();
        let take = s.buffer.len().min(max_bytes);
        let output: Vec<u8> = s.buffer.drain(..take).collect();
        let more = !s.buffer.is_empty();
        let dropped = std::mem::take(&mut s.dropped);
        ReadResult { output, dropped, screen: s.guard.tracker.screen_text(), cursor: s.guard.tracker.cursor(), size: (s.cols, s.rows), more, exited: s.exited }
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> anyhow::Result<()> {
        self.touch();
        self.tx.window_change(cols, rows, 0, 0).await.context("window-change")?;
        {
            let mut s = self.state.lock().unwrap();
            s.cols = cols;
            s.rows = rows;
            s.guard.tracker.resize(rows.min(u32::from(u16::MAX)) as u16, cols.min(u32::from(u16::MAX)) as u16);
        }
        if let Some(r) = self.recorder.lock().await.as_mut() {
            r.resize(cols, rows).await;
        }
        Ok(())
    }

    /// 關 channel、停讀、收錄影。/ Close the channel, stop reading, finish the recording.
    pub async fn close(&self, state: &AppState) {
        let _ = self.tx.eof().await;
        let _ = self.tx.close().await;
        if let Some(task) = self.reader.lock().unwrap().take() {
            task.abort();
        }
        if let Some(r) = self.recorder.lock().await.take() {
            r.finish(state).await;
        }
    }
}

/// 背景讀：餵畫面模型、錄影與緩衝區。/ The reader task: screen model, recording and the buffer.
async fn read_loop(shell: Arc<AiShell>, mut rx: ChannelReadHalf) {
    let mut decoder = Utf8Decoder::default();
    let mut exit = None;
    loop {
        let msg = rx.wait().await;
        let data = match msg {
            Some(ChannelMsg::Data { data }) => data.to_vec(),
            Some(ChannelMsg::ExtendedData { data, .. }) => data.to_vec(),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit = Some(exit_status);
                continue;
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                shell.state.lock().unwrap().exited = Some(exit);
                shell.changed.notify_waiters();
                return;
            }
            Some(_) => continue,
        };
        shell.bytes_out.fetch_add(data.len() as u64, Ordering::SeqCst);
        {
            let mut s = shell.state.lock().unwrap();
            s.guard.output(&data, Instant::now());
            s.buffer.extend_from_slice(&data);
            if s.buffer.len() > BUFFER_CAP {
                let excess = s.buffer.len() - BUFFER_CAP;
                s.buffer.drain(..excess);
                s.dropped += excess as u64;
            }
        }
        if shell.recorded {
            let text = decoder.decode(&data);
            if !text.is_empty() {
                if let Some(r) = shell.recorder.lock().await.as_mut() {
                    r.output(&text).await;
                }
            }
        }
        shell.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_are_clamped() {
        assert_eq!(clamp_size(None, None), (120, 40));
        assert_eq!(clamp_size(Some(1), Some(9999)), (MIN_COLS, MAX_ROWS));
        assert_eq!(clamp_size(Some(80), Some(24)), (80, 24));
    }

    #[test]
    fn audit_input_is_short_and_readable() {
        assert_eq!(describe_input("ls -la\r"), "ls -la\\r");
        assert_eq!(describe_input("\x03"), "^C");
        assert_eq!(describe_input("\x1b[A\t\x7f"), "\\e[A\\t^?");
        let long = "x".repeat(AUDIT_INPUT_CHARS + 5);
        let d = describe_input(&long);
        assert_eq!(d.chars().count(), AUDIT_INPUT_CHARS + 1);
        assert!(d.ends_with('…'));
    }
}
