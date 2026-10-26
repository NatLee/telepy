//! 從終端機畫面讀出「按下 Enter 時要跑的那一行」：裝置的輸出全部餵進一個 vt100 畫面，使用者開始打字的那一刻記下游標位置
//! （= 提示字元結束的地方），按 Enter 時讀從那裡到游標所在邏輯行結尾的文字。補完（Tab）、歷史（↑ / Ctrl+R）、貼上都是 shell
//! 自己畫到畫面上的，所以讀畫面比重組鍵盤輸入可靠；而且只讀得到畫面上看得到的字——沒有回顯的密碼永遠不會被讀到。
//! Read "the line Enter is about to run" from the terminal screen: every byte of device output goes through a vt100
//! screen; the cursor position is noted when the person starts typing (= where the prompt ends), and on Enter the
//! text from there to the end of the cursor's logical line is read. Completion, history and paste are drawn by the
//! shell itself, so reading the screen beats rebuilding keystrokes — and only echoed text is ever read, so a
//! password typed at a no-echo prompt never is.

use std::num::NonZeroU16;

use vt100::{Callbacks, Color, Parser, Screen};

/// 數畫面往上捲了幾行（起點的列跟著位移）。/ Counts rows scrolled off the top (the anchor row moves with them).
#[derive(Default)]
struct Scrolls(u64);

impl Callbacks for Scrolls {
    fn on_scroll(&mut self, _: vt100::capture::RowContents<'_>, alternate_screen: bool) {
        if !alternate_screen {
            self.0 += 1;
        }
    }
}

/// 使用者開始打字的地方。/ Where the person started typing.
#[derive(Debug, Clone)]
struct Anchor {
    scrolls: u64,
    row: u16,
    col: u16,
    /// 那一列游標前面的字（= 提示字元）。/ The row's text before the cursor (= the prompt).
    prompt: String,
}

pub struct LineTracker {
    parser: Parser<Scrolls>,
    anchor: Option<Anchor>,
}

fn nz(v: u16, default: u16) -> NonZeroU16 {
    NonZeroU16::new(v).or(NonZeroU16::new(default)).expect("non-zero default")
}

impl Default for LineTracker {
    fn default() -> Self {
        Self::new(24, 80)
    }
}

impl LineTracker {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self { parser: Parser::new_with_callbacks(nz(rows, 24), nz(cols, 80), 0, Scrolls::default()), anchor: None }
    }

    /// 裝置的輸出。/ Output from the device.
    pub fn output(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.set_size(nz(rows, 24), nz(cols, 80));
        if let Some(a) = self.anchor.as_mut() {
            a.col = a.col.min(cols.saturating_sub(1));
        }
    }

    /// 全螢幕程式（vim、less、top…）裡的 Enter 不是 shell 指令。/ Enter inside a full-screen program is not a command.
    pub fn full_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    /// 使用者按了 Enter 以外的鍵：還沒有起點就記下來。/ A key other than Enter: note the start if there is none yet.
    pub fn typing(&mut self) {
        if self.anchor.is_some() || self.full_screen() {
            return;
        }
        let screen = self.parser.screen();
        let (row, col) = screen.cursor_position();
        let prompt = screen.contents_between(row, 0, row, col);
        self.anchor = Some(Anchor { scrolls: self.parser.callbacks().0, row, col, prompt });
    }

    /// 這一行送出去了（或取消了）。/ The line was sent (or abandoned).
    pub fn reset(&mut self) {
        self.anchor = None;
    }

    pub fn started(&self) -> bool {
        self.anchor.is_some()
    }

    /// 現在畫面上的文字（每列一行，尾端空白去掉；MCP 的 `shell_read` 給 agent 看 TUI 用）。
    /// The screen as text, one line per row with trailing blanks trimmed (what MCP's `shell_read` shows an agent).
    pub fn screen_text(&self) -> String {
        let screen = self.parser.screen();
        let rows = screen.size().0.get();
        let mut lines: Vec<String> = (0..rows).map(|r| screen.contents_between(r, 0, r, screen.size().1.get()).trim_end().to_string()).collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }

    /// 游標位置 (row, col)。/ The cursor position.
    pub fn cursor(&self) -> (u16, u16) {
        self.parser.screen().cursor_position()
    }

    /// 畫面大小 (rows, cols)。/ The screen size.
    pub fn size(&self) -> (u16, u16) {
        let (r, c) = self.parser.screen().size();
        (r.get(), c.get())
    }

    /// 這次 Enter 可能在跑的指令（幾種讀法，任何一種符合規則就算）；第一個是給人看的那一行。空 = 沒打東西。
    /// Readings of what this Enter runs (a rule matching any of them counts); the first is the one shown to people.
    /// Empty = nothing was typed.
    pub fn candidates(&self) -> Vec<String> {
        let Some(a) = &self.anchor else { return Vec::new() };
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let (rows, cols) = (rows.get(), cols.get());
        let (crow, ccol) = screen.cursor_position();
        let shifted = self.parser.callbacks().0.saturating_sub(a.scrolls);
        // 起點捲出畫面了：從游標那個邏輯行的開頭讀。/ The start scrolled away: read from the start of the cursor's line.
        let (arow, acol, mut unknown) = if shifted > u64::from(a.row) {
            (logical_start(screen, crow), 0, true)
        } else {
            (a.row - shifted as u16, a.col, false)
        };
        // 輸入可能折到游標下面幾列（游標移回前面改字時）。/ Input may wrap past the cursor row.
        let mut end = crow;
        while end + 1 < rows && screen.row_wrapped(end) {
            end += 1;
        }
        // 起點在游標下面（清過畫面）：同上。/ The start is below the cursor (screen cleared): same.
        let (arow, acol) = if arow > crow {
            unknown = true;
            (logical_start(screen, crow), 0)
        } else {
            (arow, acol)
        };
        let text = if suggestion_after(screen, crow, ccol, end, cols) {
            screen.contents_between(arow, acol, crow, ccol)
        } else {
            screen.contents_between(arow, acol, end, cols)
        };
        readings(&text, a.prompt.trim_end(), unknown)
    }
}

/// 往上找到這個邏輯行（折行）的第一列。/ The first row of the logical (wrapped) line.
fn logical_start(screen: &Screen, mut row: u16) -> u16 {
    while row > 0 && screen.row_wrapped(row - 1) {
        row -= 1;
    }
    row
}

/// 灰色 / 淡色的字：zsh-autosuggestions、fish 在游標後面畫的建議（不是使用者打的）。
/// Grey or dim text: the suggestion zsh-autosuggestions / fish draw after the cursor (not typed).
fn greyish(c: &vt100::Cell) -> bool {
    c.dim()
        || match c.fgcolor() {
            Color::Idx(i) => i == 8 || i == 59 || i == 102 || (238..=246).contains(&i),
            Color::Rgb(r, g, b) => r == g && g == b && (60..=170).contains(&r),
            Color::Default => false,
        }
}

/// 游標後面的字全是灰的 = 自動建議，不算進指令。/ Everything after the cursor is grey = an autosuggestion.
fn suggestion_after(screen: &Screen, crow: u16, ccol: u16, end: u16, cols: u16) -> bool {
    let mut any = false;
    for row in crow..=end {
        let from = if row == crow { ccol } else { 0 };
        for col in from..cols {
            let Some(cell) = screen.cell(row, col) else { continue };
            if cell.contents().trim().is_empty() {
                continue;
            }
            if !greyish(cell) {
                return false;
            }
            any = true;
        }
    }
    any
}

const PROMPT_ENDS: &[&str] = &["$ ", "# ", "% ", "> ", "❯ ", "➜ ", "» ", "λ "];

/// 去掉看起來像提示字元的開頭（`user@host:~$ `、`PS C:\> `…）。/ Drop a prompt-looking prefix.
fn strip_generic_prompt(line: &str) -> Option<&str> {
    let head: usize = line.char_indices().nth(120).map(|(i, _)| i).unwrap_or(line.len());
    PROMPT_ENDS.iter().filter_map(|p| line[..head].find(p).map(|i| i + p.len())).min().map(|i| &line[i..])
}

/// 從畫面上那段字整理出幾種讀法。/ Turn the screen text into candidate readings.
fn readings(text: &str, prompt: &str, start_unknown: bool) -> Vec<String> {
    let mut lines: Vec<&str> = text.split('\n').map(str::trim_end).collect();
    // 提示字元又在後面出現（Tab 列出選項後重畫、打字快過新提示）：從最後那次開始算。
    // The prompt shows up again further down (redrawn after a completion list, typed ahead): start from the last one.
    let mut prompt_found = false;
    if !prompt.is_empty() {
        if let Some(k) = lines.iter().rposition(|l| l.starts_with(prompt)) {
            if k > 0 || start_unknown {
                let rest = &lines[k][prompt.len()..];
                let mut tail = vec![rest];
                tail.extend_from_slice(&lines[k + 1..]);
                lines = tail;
                prompt_found = true;
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        let s = s.trim();
        if !s.is_empty() && !out.iter().any(|o| o == s) {
            out.push(s.to_string());
        }
    };
    let shown = lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
    push(&shown);
    for (i, line) in lines.iter().enumerate() {
        push(line);
        // bash 的 Ctrl+R：`(reverse-i-search)`rm': rm -rf x`。/ bash's reverse search line.
        if line.contains("-search)") {
            if let Some(i) = line.find("': ") {
                push(&line[i + 3..]);
            }
        }
        if (i > 0 || start_unknown) && !prompt_found {
            if let Some(rest) = strip_generic_prompt(line) {
                push(rest);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> LineTracker {
        LineTracker::new(24, 80)
    }

    /// 像 shell 那樣：先印提示字元，打字時 echo。/ Like a shell: print a prompt, echo keystrokes.
    fn type_line(t: &mut LineTracker, echo: &str) {
        t.typing();
        t.output(echo.as_bytes());
    }

    #[test]
    fn reads_what_was_typed_after_the_prompt() {
        let mut t = tracker();
        t.output(b"login banner\r\nnat@box:~$ ");
        type_line(&mut t, "rm -rf /tmp/x");
        assert_eq!(t.candidates()[0], "rm -rf /tmp/x");
        assert!(!t.candidates().iter().any(|c| c.contains("nat@box")));
        t.reset();
        assert!(t.candidates().is_empty());
    }

    #[test]
    fn nothing_typed_means_nothing_to_check() {
        let mut t = tracker();
        t.output(b"nat@box:~$ ");
        assert!(t.candidates().is_empty());
        t.typing();
        assert!(t.candidates().is_empty(), "{:?}", t.candidates());
    }

    #[test]
    fn line_editing_is_seen_as_the_shell_draws_it() {
        let mut t = tracker();
        t.output(b"$ ");
        // 打 `ls`，退格兩次，再打 `reboot`（readline 用 BS + 空白 + BS 擦掉字）。/ Typed, erased, retyped.
        type_line(&mut t, "ls");
        t.output(b"\x08 \x08\x08 \x08reboot");
        assert_eq!(t.candidates()[0], "reboot");
        // ↑ 叫出歷史：bash 擦到提示字元後再畫整行。/ History recall: erase to the prompt and draw the old line.
        t.output(b"\r\x1b[K$ sudo shutdown -h now");
        assert_eq!(t.candidates()[0], "sudo shutdown -h now");
    }

    #[test]
    fn long_lines_wrap_and_scroll() {
        let mut t = LineTracker::new(3, 20);
        t.output(b"a\r\nb\r\n$ ");
        let cmd = "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa && reboot";
        type_line(&mut t, cmd);
        assert_eq!(t.candidates()[0], cmd);
    }

    #[test]
    fn cursor_moved_left_still_reads_the_whole_line() {
        let mut t = tracker();
        t.output(b"$ ");
        type_line(&mut t, "rm x -rf");
        // 游標移回 `x` 前面。/ Cursor moved back before `x`.
        t.output(b"\x1b[5D");
        assert_eq!(t.candidates()[0], "rm x -rf");
    }

    #[test]
    fn grey_autosuggestions_after_the_cursor_are_ignored() {
        let mut t = tracker();
        t.output(b"% ");
        type_line(&mut t, "rm");
        // zsh-autosuggestions：灰字建議，游標退回建議前面。/ A grey suggestion, cursor back before it.
        t.output(b"\x1b[38;5;8m -rf /tmp/old\x1b[39m\x1b[12D");
        assert_eq!(t.candidates(), vec!["rm".to_string()]);
    }

    #[test]
    fn completion_lists_and_a_redrawn_prompt_start_over() {
        let mut t = tracker();
        t.output(b"nat@box:~$ ");
        type_line(&mut t, "sudo re");
        // bash Tab Tab：列出選項，再重畫提示字元和輸入。/ Completion list, then the prompt and input redrawn.
        t.output(b"\r\nreboot   readlink   rename\r\nnat@box:~$ sudo re");
        t.output(b"name a b");
        let c = t.candidates();
        assert_eq!(c[0], "sudo rename a b");
        assert!(!c.iter().any(|l| l.starts_with("reboot")), "{c:?}");
    }

    #[test]
    fn bash_reverse_search_reads_the_found_line() {
        let mut t = tracker();
        t.output(b"$ ");
        t.typing();
        t.output(b"\r\x1b[K(reverse-i-search)`reb': sudo reboot");
        assert!(t.candidates().iter().any(|c| c == "sudo reboot"), "{:?}", t.candidates());
    }

    #[test]
    fn typing_before_the_prompt_arrives_still_finds_the_command() {
        let mut t = tracker();
        t.output(b"$ sleep 1\r\n");
        // 指令還在跑就先打字：起點落在輸出中間。/ Typed ahead while a command runs.
        t.typing();
        t.output(b"done\r\n$ reboot");
        assert!(t.candidates().iter().any(|c| c == "reboot"), "{:?}", t.candidates());
    }

    #[test]
    fn full_screen_programs_are_skipped() {
        let mut t = tracker();
        t.output(b"$ vim x\r\n\x1b[?1049h");
        assert!(t.full_screen());
        t.typing();
        assert!(!t.started());
        t.output(b"\x1b[?1049l");
        assert!(!t.full_screen());
    }

    #[test]
    fn screen_text_and_cursor() {
        let mut t = LineTracker::new(4, 10);
        t.output(b"hello\r\nworld   \r\n$ ");
        assert_eq!(t.screen_text(), "hello\nworld\n$");
        assert_eq!(t.cursor(), (2, 2));
        assert_eq!(t.size(), (4, 10));
    }

    #[test]
    fn password_prompts_read_nothing() {
        let mut t = tracker();
        t.output(b"[sudo] password for nat: ");
        // 密碼不回顯，畫面上什麼都沒有。/ No echo: nothing on screen.
        t.typing();
        assert!(t.candidates().is_empty());
    }

    #[test]
    fn multi_line_paste_reads_every_line() {
        let mut t = tracker();
        t.output(b"$ ");
        type_line(&mut t, "echo one\r\necho two && reboot");
        let c = t.candidates();
        assert_eq!(c[0], "echo one\necho two && reboot");
        assert!(c.iter().any(|l| l == "echo two && reboot"));
    }
}
