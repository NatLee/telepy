//! 網頁終端機的輸入分段（純邏輯）：把瀏覽器送來的按鍵切在「要決定的 Enter」前面；Enter 之前的照送，Enter 與後面的先留著。
//! 括號貼上（`ESC[200~ … ESC[201~`）裡的換行是貼上的內容，不是 Enter；全螢幕程式（vim、less）裡的 Enter 不檢查。
//! Input splitting for the web terminal (pure): cut the browser's keystrokes before an Enter that needs a decision;
//! what comes before goes out as is, the Enter and the rest wait. Newlines inside a bracketed paste are pasted text,
//! not Enter; Enter inside a full-screen program (vim, less) is not checked.

use std::time::{Duration, Instant};

use super::line::LineTracker;

/// 最後一個按鍵送出後，等回顯最多這麼久。/ How long to wait for the echo of the last key at most.
pub const ECHO_WAIT: Duration = Duration::from_millis(600);
/// 回顯開始到了之後，再安靜這麼久才讀畫面（後面的字可能還在路上）。/ Quiet time after echo starts arriving.
pub const ECHO_QUIET: Duration = Duration::from_millis(40);

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

#[derive(Default)]
pub struct TerminalGuard {
    pub tracker: LineTracker,
    in_paste: bool,
    last_key: Option<Instant>,
    last_output: Option<Instant>,
}

/// 切一段輸入的結果。/ The result of splitting some input.
#[derive(Debug, PartialEq, Eq)]
pub struct Split {
    /// 現在就送出去的。/ To send now.
    pub send: String,
    /// 有 Enter 要決定：Enter 後面剩下的輸入。/ An Enter to decide on: the input after it.
    pub enter: Option<String>,
}

impl TerminalGuard {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self { tracker: LineTracker::new(rows, cols), ..Self::default() }
    }

    /// 裝置的輸出。/ Output from the device.
    pub fn output(&mut self, bytes: &[u8], now: Instant) {
        self.tracker.output(bytes);
        self.last_output = Some(now);
    }

    /// 切在第一個要決定的 Enter 前面。/ Split before the first Enter that needs a decision.
    pub fn split(&mut self, input: &str, now: Instant) -> Split {
        let mut send = String::new();
        let mut i = 0;
        while i < input.len() {
            let rest = &input[i..];
            if rest.starts_with(PASTE_START) {
                self.in_paste = true;
            } else if rest.starts_with(PASTE_END) {
                self.in_paste = false;
            }
            let c = rest.chars().next().expect("non-empty");
            if (c == '\r' || c == '\n') && !self.in_paste && !self.tracker.full_screen() {
                let mut after = &rest[1..];
                // `\r\n` 算一個 Enter。/ `\r\n` is one Enter.
                if c == '\r' {
                    after = after.strip_prefix('\n').unwrap_or(after);
                }
                self.sent(&send, now);
                return Split { send, enter: Some(after.to_string()) };
            }
            if c == '\x03' {
                // Ctrl+C：這一行放棄了。/ Ctrl+C abandons the line.
                self.tracker.reset();
            } else {
                self.tracker.typing();
            }
            send.push(c);
            i += c.len_utf8();
        }
        self.sent(&send, now);
        Split { send, enter: None }
    }

    fn sent(&mut self, s: &str, now: Instant) {
        if !s.is_empty() {
            self.last_key = Some(now);
        }
    }

    /// 什麼時候讀畫面：回顯到了而且安靜了 [`ECHO_QUIET`]，或從現在起最多 [`ECHO_WAIT`]。
    /// When to read the screen: once the echo arrived and stayed quiet for [`ECHO_QUIET`], or [`ECHO_WAIT`] from now at most.
    pub fn read_at(&self, enter_at: Instant) -> Instant {
        let deadline = enter_at + ECHO_WAIT;
        match (self.last_key, self.last_output) {
            // 最後一個鍵之後有輸出：安靜一下就讀。/ Output after the last key: read after a quiet moment.
            (Some(k), Some(o)) if o >= k => (o + ECHO_QUIET).min(deadline),
            (None, _) => enter_at,
            _ => deadline,
        }
    }

    /// 這一行送出去或取消了。/ The line went out or was abandoned.
    pub fn reset(&mut self) {
        self.tracker.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_at_enter_and_keeps_the_rest() {
        let mut g = TerminalGuard::new(24, 80);
        let now = Instant::now();
        assert_eq!(g.split("ls -la", now), Split { send: "ls -la".into(), enter: None });
        assert!(g.tracker.started());
        assert_eq!(g.split("\rpwd\r", now), Split { send: "".into(), enter: Some("pwd\r".into()) });
        assert_eq!(g.split("a\r\nb", now), Split { send: "a".into(), enter: Some("b".into()) });
    }

    #[test]
    fn bracketed_paste_newlines_are_text() {
        let mut g = TerminalGuard::new(24, 80);
        let now = Instant::now();
        let s = g.split("\x1b[200~echo a\recho b\x1b[201~\r", now);
        assert_eq!(s, Split { send: "\x1b[200~echo a\recho b\x1b[201~".into(), enter: Some(String::new()) });
    }

    #[test]
    fn full_screen_enter_is_not_checked() {
        let mut g = TerminalGuard::new(24, 80);
        let now = Instant::now();
        g.output(b"\x1b[?1049h", now);
        assert_eq!(g.split(":wq\r", now), Split { send: ":wq\r".into(), enter: None });
    }

    #[test]
    fn ctrl_c_abandons_the_line() {
        let mut g = TerminalGuard::new(24, 80);
        let now = Instant::now();
        g.output(b"$ ", now);
        g.split("rm", now);
        assert!(g.tracker.started());
        g.split("\x03", now);
        assert!(!g.tracker.started());
    }

    #[test]
    fn waits_for_the_echo_before_reading() {
        let mut g = TerminalGuard::new(24, 80);
        let t0 = Instant::now();
        // 沒打字：馬上讀。/ Nothing typed: read at once.
        assert_eq!(g.read_at(t0), t0);
        g.split("reboot", t0);
        // 回顯還沒到：最多等 ECHO_WAIT。/ No echo yet: wait up to ECHO_WAIT.
        assert_eq!(g.read_at(t0), t0 + ECHO_WAIT);
        let t1 = t0 + Duration::from_millis(80);
        g.output(b"reboot", t1);
        assert_eq!(g.read_at(t1), t1 + ECHO_QUIET);
    }
}
