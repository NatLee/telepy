//! 顏色：什麼時候上色、上哪幾種。
//! 判斷（純函式 [`decide`]）：`--color always|never` 最大；`auto` 時 `NO_COLOR` → 不上色、`CLICOLOR_FORCE` → 上色、
//! `CLICOLOR=0` → 不上色，其餘只有終端機才上色，而且 `TERM` 不是 `dumb`（Unix 上沒有 `TERM` 也不上），Windows 的主控台要
//! 打得開 ANSI 模式（Windows 10 起；更舊的主控台就是純文字）。只用 16 個基本色加粗體 / 淡色：老終端機也看得懂，
//! 而且顏色跟著使用者自己的配色走。裝置那邊印出來的東西（`exec` 的輸出）原樣轉過去，從不經過這裡。
//! Colour: when, and which. The decision (pure [`decide`]): `--color always|never` wins; with `auto`, `NO_COLOR` = none,
//! `CLICOLOR_FORCE` = colour, `CLICOLOR=0` = none, otherwise only a terminal whose `TERM` isn't `dumb` (no `TERM` on
//! Unix = none) and, on Windows, a console that accepts ANSI (Windows 10 on; older consoles get plain text). Only the 16
//! basic colours plus bold / dim: old terminals understand them, and they follow the user's own palette. What a device
//! prints (`exec` output) is passed through untouched and never goes through here.

use std::io::IsTerminal;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

use anstyle::{AnsiColor, Style};

// `--color` 的三個值；`///` 會變成 `--help` 的說明，所以只寫英文。
// The values of `--color`; `///` becomes `--help` text, so English only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum When {
    /// Only on a terminal that shows colour
    #[default]
    Auto,
    /// Even into a pipe or a file (for `less -R`)
    Always,
    /// Plain text
    Never,
}

impl When {
    /// clap 自己的說明 / 錯誤訊息用同一個選擇。/ The same choice for clap's own help and errors.
    pub fn clap(self) -> clap::ColorChoice {
        match self {
            When::Auto => clap::ColorChoice::Auto,
            When::Always => clap::ColorChoice::Always,
            When::Never => clap::ColorChoice::Never,
        }
    }
}

static WHEN: AtomicU8 = AtomicU8::new(0);

/// 程式一開始設一次（`main` 先從參數挑出 `--color`）。/ Set once at start (`main` picks `--color` out of the arguments).
pub fn set(when: When) {
    WHEN.store(when as u8, Ordering::Relaxed);
}

pub fn when() -> When {
    match WHEN.load(Ordering::Relaxed) {
        1 => When::Always,
        2 => When::Never,
        _ => When::Auto,
    }
}

/// 在 clap 解析之前就先看 `--color`（說明與錯誤訊息也要照它）；`--` 之後是別人的參數。最後一個算數。
/// Read `--color` before clap parses (its help and errors follow it too); after `--` the words belong to someone else. The last one wins.
pub fn when_from_args<S: AsRef<std::ffi::OsStr>>(args: &[S]) -> When {
    let mut when = When::Auto;
    let mut it = args.iter().skip(1).map(|a| a.as_ref().to_string_lossy());
    let parse = |v: &str| match v {
        "always" => Some(When::Always),
        "never" => Some(When::Never),
        "auto" => Some(When::Auto),
        _ => None,
    };
    while let Some(a) = it.next() {
        if a == "--" {
            break;
        }
        if let Some(v) = a.strip_prefix("--color=") {
            when = parse(v).unwrap_or(when);
        } else if a == "--color" {
            if let Some(v) = it.next() {
                when = parse(&v).unwrap_or(when);
            }
        }
    }
    when
}

/// 純判斷。`tty` = 這條輸出是終端機；`ansi` = 終端機吃得下 ANSI 碼（Windows 的主控台要先打開；其他平台一律是）。
/// Pure decision. `tty` = the stream is a terminal; `ansi` = it accepts ANSI codes (a Windows console has to switch
/// them on; everywhere else they always are).
pub fn decide(when: When, tty: bool, ansi: bool, windows: bool, env: impl Fn(&str) -> Option<String>) -> bool {
    let set = |k: &str| env(k).is_some_and(|v| !v.is_empty());
    match when {
        When::Always => true,
        When::Never => false,
        When::Auto => {
            if set("NO_COLOR") {
                return false;
            }
            if env("CLICOLOR_FORCE").is_some_and(|v| !v.is_empty() && v != "0") {
                return true;
            }
            let clicolor = env("CLICOLOR");
            if clicolor.as_deref() == Some("0") {
                return false;
            }
            if !tty || !ansi {
                return false;
            }
            match env("TERM").as_deref() {
                Some("dumb") => false,
                // Windows 通常沒有 TERM；Unix 沒有 TERM 是很怪的環境（cron、某些服務），除非另外說可以。
                // Windows usually has no TERM; on Unix a missing TERM is an odd place (cron, some services) unless told otherwise.
                None => windows || clicolor.is_some() || set("CI"),
                Some(_) => true,
            }
        }
    }
}

/// 寫到哪條輸出。/ Which stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Out,
    Err,
}

/// Windows 的主控台打開 ANSI 模式（只試一次）；其他平台本來就吃。/ Switch a Windows console to ANSI once; elsewhere it always is.
fn ansi_ok(tty: bool) -> bool {
    if !cfg!(windows) || !tty {
        return true;
    }
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| anstyle_query::windows::enable_ansi_colors().unwrap_or(true))
}

/// 這條輸出要不要上色（照 `--color` 與環境）。/ Whether this stream gets colour (per `--color` and the environment).
pub fn enabled(stream: Stream) -> bool {
    let tty = match stream {
        Stream::Out => std::io::stdout().is_terminal(),
        Stream::Err => std::io::stderr().is_terminal(),
    };
    decide(when(), tty, ansi_ok(tty), cfg!(windows), |k| std::env::var(k).ok())
}

/// 這條輸出吃不吃 ANSI 控制碼（游標移動之類），不管使用者要不要顏色（`NO_COLOR` 只關顏色）。
/// Whether this stream takes ANSI control codes (cursor movement and the like), whatever the colour preference (`NO_COLOR` only turns off colour).
pub fn escapes(stream: Stream) -> bool {
    let tty = match stream {
        Stream::Out => std::io::stdout().is_terminal(),
        Stream::Err => std::io::stderr().is_terminal(),
    };
    let preference = |k: &str| matches!(k, "NO_COLOR" | "CLICOLOR" | "CLICOLOR_FORCE");
    decide(When::Auto, tty, ansi_ok(tty), cfg!(windows), |k| if preference(k) { None } else { std::env::var(k).ok() })
}

/// 上色（`on` 為假就是原字）。空字串不包，表格行尾才修得掉空白。
/// Paint (`on` false = the text as is). Empty text is left bare so table lines can still trim their ends.
pub fn paint(on: bool, style: Style, text: &str) -> String {
    if !on || text.is_empty() || style == Style::new() {
        return text.to_string();
    }
    format!("{style}{text}{style:#}")
}

/// 給標準輸出的字上色。/ Paint text for stdout.
pub fn out(style: Style, text: &str) -> String {
    paint(enabled(Stream::Out), style, text)
}

/// 給標準錯誤的字上色。/ Paint text for stderr.
pub fn err(style: Style, text: &str) -> String {
    paint(enabled(Stream::Err), style, text)
}

pub const PLAIN: Style = Style::new();
pub const BOLD: Style = Style::new().bold();
/// 次要的字：淡色而不是灰色（Solarized Dark 之類的配色裡「亮黑」跟背景同色）。
/// Secondary text: dimmed rather than grey ("bright black" is the background colour in Solarized Dark and friends).
pub const DIM: Style = Style::new().dimmed();
pub const GOOD: Style = AnsiColor::Green.on_default();
pub const WARN: Style = AnsiColor::Yellow.on_default();
pub const BAD: Style = AnsiColor::Red.on_default();
pub const ERROR: Style = AnsiColor::Red.on_default().bold();
pub const CODE: Style = AnsiColor::Cyan.on_default();

/// 隧道健康狀態跟網頁一樣：上線綠、降級黃、離線 / 沒連過淡色。/ Tunnel health like the web: online green, degraded yellow, offline / never dim.
pub fn health(h: &str) -> Style {
    match h {
        "online" => GOOD,
        "degraded" => WARN,
        "offline" | "never" => DIM,
        _ => PLAIN,
    }
}

/// HTTP 狀態碼：2xx 綠、4xx 黃、5xx 與連不上紅。/ HTTP status: 2xx green, 4xx yellow, 5xx and no answer red.
pub fn status_code(code: &str) -> Style {
    match code.as_bytes().first() {
        Some(b'2') | Some(b'3') => GOOD,
        Some(b'4') => WARN,
        Some(b'5') => BAD,
        _ => DIM,
    }
}

/// 一次跑很多台時，每台的 `名稱 | ` 前綴輪流用這幾色（沒有紅：紅色留給錯誤）。
/// The `name | ` prefixes of a run on many devices take these in turn (no red: red means an error).
pub const PREFIXES: [Style; 6] = [
    AnsiColor::Cyan.on_default(),
    AnsiColor::Magenta.on_default(),
    AnsiColor::Blue.on_default(),
    AnsiColor::Green.on_default(),
    AnsiColor::Yellow.on_default(),
    AnsiColor::BrightCyan.on_default(),
];

/// `--help` 的樣式（只在 clap 判斷可以上色時出現）。/ The `--help` styles (shown only when clap decides colour is fine).
pub fn styles() -> clap::builder::Styles {
    clap::builder::Styles::styled()
        .header(AnsiColor::Yellow.on_default().bold())
        .usage(AnsiColor::Yellow.on_default().bold())
        .literal(AnsiColor::Cyan.on_default().bold())
        .placeholder(AnsiColor::Cyan.on_default())
        .error(ERROR)
        .valid(GOOD)
        .invalid(WARN)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn auto_follows_the_terminal_and_the_environment() {
        let term = &[("TERM", "xterm-256color")];
        assert!(decide(When::Auto, true, true, false, env(term)));
        assert!(!decide(When::Auto, false, true, false, env(term)), "a pipe gets plain text");
        assert!(!decide(When::Auto, true, true, false, env(&[("TERM", "dumb")])));
        assert!(!decide(When::Auto, true, true, false, env(&[])), "no TERM on Unix: an odd place, no colour");
        assert!(decide(When::Auto, true, true, true, env(&[])), "Windows has no TERM");
        assert!(!decide(When::Auto, true, false, true, env(&[])), "a Windows console without ANSI gets plain text");
        assert!(!decide(When::Auto, true, true, false, env(&[("TERM", "xterm"), ("NO_COLOR", "1")])));
        assert!(decide(When::Auto, true, true, false, env(&[("TERM", "xterm"), ("NO_COLOR", "")])), "an empty NO_COLOR is not set");
        assert!(!decide(When::Auto, true, true, false, env(&[("TERM", "xterm"), ("CLICOLOR", "0")])));
        assert!(decide(When::Auto, false, true, false, env(&[("CLICOLOR_FORCE", "1")])), "forced even into a pipe");
        assert!(!decide(When::Auto, false, true, false, env(&[("CLICOLOR_FORCE", "0")])));
        assert!(!decide(When::Auto, true, true, false, env(&[("CLICOLOR_FORCE", "1"), ("NO_COLOR", "1")])), "NO_COLOR beats CLICOLOR_FORCE");
        assert!(decide(When::Auto, true, true, false, env(&[("CI", "true")])));
    }

    #[test]
    fn the_flag_beats_the_environment() {
        assert!(decide(When::Always, false, false, false, env(&[("NO_COLOR", "1")])));
        assert!(!decide(When::Never, true, true, false, env(&[("TERM", "xterm"), ("CLICOLOR_FORCE", "1")])));
    }

    #[test]
    fn the_flag_is_found_before_parsing() {
        assert_eq!(when_from_args(&["telepy", "ls"]), When::Auto);
        assert_eq!(when_from_args(&["telepy", "--color=never", "ls"]), When::Never);
        assert_eq!(when_from_args(&["telepy", "ls", "--color", "always"]), When::Always);
        assert_eq!(when_from_args(&["telepy", "--color", "always", "ls", "--color=never"]), When::Never, "the last one wins");
        assert_eq!(when_from_args(&["telepy", "exec", "box", "--", "ls", "--color=always"]), When::Auto, "after -- it belongs to the device");
        assert_eq!(when_from_args(&["telepy", "--color=rainbow"]), When::Auto, "clap reports the bad value");
    }

    #[test]
    fn painting() {
        assert_eq!(paint(false, GOOD, "online"), "online");
        assert_eq!(paint(true, GOOD, "online"), "\x1b[32monline\x1b[0m");
        assert_eq!(paint(true, GOOD, ""), "", "empty stays bare");
        assert_eq!(paint(true, PLAIN, "x"), "x");
        assert_eq!(health("online"), GOOD);
        assert_eq!(health("never"), DIM);
        assert_eq!(status_code("204"), GOOD);
        assert_eq!(status_code("404"), WARN);
        assert_eq!(status_code("502"), BAD);
        assert_eq!(status_code("-"), DIM);
    }
}
