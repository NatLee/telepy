//! 在 SSH 連線上跑一個指令（exec channel、無 PTY）：逾時送 KILL 並關 channel，stdout / stderr 各自保留頭尾。
//! AI session（`ai/`）與區網探索（`lan/`）共用。
//! Run one command over an SSH connection (exec channel, no PTY) with a timeout and head/tail output capture.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use russh::client::{Handle, Msg};
use russh::{Channel, ChannelMsg, Sig};

use super::device::ClientHandler;

/// 收到 exit-status 後等 channel close 的時間。/ How long to wait for the close after the exit status.
const EXIT_GRACE: Duration = Duration::from_secs(2);

/// 保留開頭 1/4 與結尾 3/4 的輸出（log 的結尾通常最有用），中間丟掉並註明。
/// Keeps the first quarter and the last three quarters of a stream within the budget.
pub struct HeadTail {
    cap_head: usize,
    cap_tail: usize,
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    pub text: String,
    pub bytes: u64,
    pub truncated: bool,
}

impl HeadTail {
    pub fn new(budget: usize) -> Self {
        let cap_head = budget / 4;
        Self { cap_head, cap_tail: budget - cap_head, head: Vec::new(), tail: VecDeque::new(), total: 0 }
    }
    pub fn push(&mut self, mut data: &[u8]) {
        self.total += data.len() as u64;
        if self.head.len() < self.cap_head {
            let n = (self.cap_head - self.head.len()).min(data.len());
            self.head.extend_from_slice(&data[..n]);
            data = &data[n..];
        }
        self.tail.extend(data);
        while self.tail.len() > self.cap_tail {
            let excess = self.tail.len() - self.cap_tail;
            self.tail.drain(..excess);
        }
    }
    pub fn finish(self) -> Captured {
        let kept = (self.head.len() + self.tail.len()) as u64;
        let truncated = self.total > kept;
        let mut bytes = self.head;
        if truncated {
            bytes.extend_from_slice(format!("\n[… {} bytes omitted …]\n", self.total - kept).as_bytes());
        }
        bytes.extend(self.tail);
        Captured { text: String::from_utf8_lossy(&bytes).into_owned(), bytes: self.total, truncated }
    }
}

#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub duration: Duration,
    pub stdout: Captured,
    pub stderr: Captured,
}

/// 開一個 exec channel 跑指令。/ Open an exec channel and run the command.
pub async fn run(handle: &Handle<ClientHandler>, command: &str, timeout: Duration, max_output: usize) -> anyhow::Result<ExecResult> {
    let ch = handle.channel_open_session().await.context("open a channel (is the device still connected?)")?;
    run_on(ch, command, timeout, max_output).await
}

/// 在已經開好的 session channel 上跑指令（連線池的 `session_channel`）。/ Run on an already opened session channel.
pub async fn run_on(mut ch: Channel<Msg>, command: &str, timeout: Duration, max_output: usize) -> anyhow::Result<ExecResult> {
    let started = Instant::now();
    if let Err(e) = ch.exec(true, command.as_bytes()).await {
        let _ = ch.close().await;
        return Err(e).context("send the command");
    }
    let mut out = HeadTail::new(max_output);
    let mut err = HeadTail::new(max_output);
    let (mut exit_code, mut signal, mut timed_out) = (None, None, false);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            msg = ch.wait() => match msg {
                Some(ChannelMsg::Data { data }) => out.push(&data),
                Some(ChannelMsg::ExtendedData { data, ext: 1 }) => err.push(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status);
                    let grace = tokio::time::Instant::now() + EXIT_GRACE;
                    if grace < deadline.deadline() {
                        deadline.as_mut().reset(grace);
                    }
                }
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                    signal = Some(format!("{signal_name:?}"));
                    let grace = tokio::time::Instant::now() + EXIT_GRACE;
                    if grace < deadline.deadline() {
                        deadline.as_mut().reset(grace);
                    }
                }
                Some(ChannelMsg::Failure) => {
                    // 裝置拒絕 exec：把 channel 關掉，別留到 session 結束（會占掉裝置的 MaxSessions）。
                    // The device refused the exec request: close the channel instead of leaking it until the session ends.
                    let _ = ch.close().await;
                    bail!("the device refused to run the command");
                }
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            _ = &mut deadline => {
                if exit_code.is_none() && signal.is_none() {
                    timed_out = true;
                    let _ = ch.signal(Sig::KILL).await;
                }
                let _ = ch.close().await;
                break;
            }
        }
    }
    Ok(ExecResult { exit_code, signal, timed_out, duration: started.elapsed(), stdout: out.finish(), stderr: err.finish() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_tail_truncation() {
        let mut h = HeadTail::new(8);
        h.push(b"abc");
        assert_eq!(h.finish(), Captured { text: "abc".into(), bytes: 3, truncated: false });
        let mut h = HeadTail::new(8); // head 2, tail 6
        h.push(b"0123456789");
        h.push(b"ABCDEFGHIJ");
        let c = h.finish();
        assert!(c.truncated);
        assert_eq!(c.bytes, 20);
        assert_eq!(c.text, "01\n[… 12 bytes omitted …]\nEFGHIJ");
        let mut h = HeadTail::new(8);
        h.push(b"01234567");
        assert!(!h.finish().truncated, "exactly the budget is not truncated");
    }
}
