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

/// 把 `content` 分段寫到裝置的 `path`（POSIX sh；`printf '%s'`，第一段 `>` 其餘 `>>`，`umask 077`），回傳要依序執行的指令，
/// 每道都在 [`MAX_COMMAND`] 以內。給不是「腳本」的檔案用（authorized_keys）；腳本用 [`script_commands`]。
/// The commands that write `content` to `path` in pieces (first `>`, then `>>`, under `umask 077`), each within
/// [`MAX_COMMAND`]. For files that are not scripts (authorized_keys); scripts use [`script_commands`].
pub fn upload_commands(path: &str, content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut piece = String::new();
    let mut first = true;
    let flush = |piece: &mut String, first: &mut bool, out: &mut Vec<String>| {
        out.push(format!("umask 077; printf '%s' {} {} {}", sh_quote(piece), if *first { ">" } else { ">>" }, sh_quote(path)));
        *first = false;
        piece.clear();
    };
    for ch in content.chars() {
        piece.push(ch);
        if piece.len() + piece.matches('\'').count() * 3 >= MAX_COMMAND - 200 {
            flush(&mut piece, &mut first, &mut out);
        }
    }
    if !piece.is_empty() || first {
        flush(&mut piece, &mut first, &mut out);
    }
    out
}

/// 開一個 exec channel 跑指令。/ Open an exec channel and run the command.
pub async fn run(handle: &Handle<ClientHandler>, command: &str, timeout: Duration, max_output: usize) -> anyhow::Result<ExecResult> {
    let ch = handle.channel_open_session().await.context("open a channel (is the device still connected?)")?;
    run_on(ch, command, timeout, max_output).await
}

/// 一個 exec 指令最多送這麼長（dropbear 的 `MAX_CMD_LEN` 是 9000，OpenWrt 路由器常用它；留餘量給引號）。
/// The longest exec command sent at once: dropbear (common on OpenWrt routers) refuses commands over 9000 bytes.
pub const MAX_COMMAND: usize = 6000;

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 把 POSIX 腳本拆成幾個夠短的 exec：先分段寫進暫存檔，最後一個跑它並刪掉（短的照舊一個 `sh -c`）。純函式，好測。
/// Split a POSIX script into exec commands short enough for any sshd: append it in pieces to a temp file, then run
/// and delete it with the last one (a short script stays one `sh -c`). Pure, for tests.
pub fn script_commands(script: &str, tag: &str) -> Vec<String> {
    let whole = format!("sh -c {}", sh_quote(script));
    if whole.len() <= MAX_COMMAND {
        return vec![whole];
    }
    let path = format!("\"${{TMPDIR:-/tmp}}/telepy-script-{tag}.sh\"");
    let mut out = vec![format!("umask 077 && : > {path}")];
    let mut piece = String::new();
    for ch in script.chars() {
        piece.push(ch);
        // 引號會讓 ' 變四個字：估長時算進去。/ Quoting turns ' into four characters: count it.
        if piece.len() + piece.matches('\'').count() * 3 >= MAX_COMMAND - 200 {
            out.push(format!("printf '%s' {} >> {path}", sh_quote(&piece)));
            piece.clear();
        }
    }
    if !piece.is_empty() {
        out.push(format!("printf '%s' {} >> {path}", sh_quote(&piece)));
    }
    out.push(format!("sh {path}; s=$?; rm -f {path}; exit $s"));
    out
}

/// 跑一個 POSIX 腳本（長的分段送，見 [`script_commands`]）。前面寫檔的那幾段失敗就直接回報。
/// Run a POSIX script, in pieces when long (see [`script_commands`]); a failed write step is reported as such.
pub async fn run_script(handle: &Handle<ClientHandler>, script: &str, timeout: Duration, max_output: usize) -> anyhow::Result<ExecResult> {
    let tag = crate::util::random_alnum(12).to_ascii_lowercase();
    let commands = script_commands(script, &tag);
    let last = commands.len() - 1;
    for (i, cmd) in commands.iter().enumerate() {
        let r = run(handle, cmd, if i == last { timeout } else { Duration::from_secs(20) }, max_output).await?;
        if i == last {
            return Ok(r);
        }
        if r.exit_code != Some(0) {
            bail!("could not write the script to the device's temp folder (step {} of {}): {}", i + 1, last, r.stderr.text.trim());
        }
    }
    unreachable!("script_commands always ends with the run step")
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
    fn file_uploads_are_chunked_under_dropbears_command_limit() {
        let content = format!("ssh-ed25519 AAAA it's\n{}", "k".repeat(MAX_COMMAND * 2));
        let cmds = upload_commands("/etc/dropbear/.tmp", &content);
        assert!(cmds.len() >= 3, "{}", cmds.len());
        assert!(cmds[0].starts_with("umask 077; printf '%s' 'ssh-ed25519 AAAA it'\\''s\n") && cmds[0].ends_with("> '/etc/dropbear/.tmp'"), "{}", cmds[0]);
        assert!(cmds[1].contains(">> '/etc/dropbear/.tmp'"));
        assert!(cmds.iter().all(|c| c.len() <= MAX_COMMAND), "every command fits Dropbear's MAX_CMD_LEN");
        let joined: String = cmds.iter().map(|c| {
            let q = c.strip_prefix("umask 077; printf '%s' ").unwrap().rsplit_once(" >").unwrap().0.trim_end_matches('>');
            q.trim()[1..q.trim().len() - 1].replace("'\\''", "'")
        }).collect();
        assert_eq!(joined, content, "the pieces, unquoted and joined, are the file");
        assert_eq!(upload_commands("/tmp/x", "").len(), 1, "an empty file is still created");
    }

    #[test]
    fn long_scripts_are_sent_in_pieces_short_enough_for_dropbear() {
        assert_eq!(script_commands("echo hi", "t"), vec!["sh -c 'echo hi'".to_string()]);
        let script: String = (0..3000).map(|i| format!("echo 'line {i}'\n")).collect();
        let cmds = script_commands(&script, "abc");
        assert!(cmds.len() > 3, "{}", cmds.len());
        assert!(cmds.iter().all(|c| c.len() <= MAX_COMMAND), "{:?}", cmds.iter().map(|c| c.len()).max());
        assert_eq!(cmds[0], "umask 077 && : > \"${TMPDIR:-/tmp}/telepy-script-abc.sh\"");
        assert_eq!(cmds.last().unwrap(), "sh \"${TMPDIR:-/tmp}/telepy-script-abc.sh\"; s=$?; rm -f \"${TMPDIR:-/tmp}/telepy-script-abc.sh\"; exit $s");
        // 每段解開引號後接起來 = 原腳本。/ The pieces, unquoted and joined, are the script.
        let joined: String = cmds[1..cmds.len() - 1]
            .iter()
            .map(|c| {
                let q = c.strip_prefix("printf '%s' ").unwrap().rsplit_once(" >> ").unwrap().0;
                q[1..q.len() - 1].replace("'\\''", "'")
            })
            .collect();
        assert_eq!(joined, script);
    }

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
