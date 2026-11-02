//! Tapi 在 CLI 裡：決定要不要畫（終端機、`TELEPY_NO_MASCOT`、`NO_COLOR`、`COLORTERM`）、把圖和文字並排，
//! 以及隱藏的 `telepy dig`（小幽靈 Tapi 從裝置沿著防火牆底下的隧道飄到 Telepy，說明反向隧道）。像素格來自伺服器的 `mascot.rs`。
//! Tapi in the CLI: whether to draw (terminal, `TELEPY_NO_MASCOT`, `NO_COLOR`, `COLORTERM`), art beside text, and
//! the hidden `telepy dig` (Tapi, a little ghost, floats from the device through a tunnel under the firewall to Telepy). Grids come from the server's `mascot.rs`.

use std::io::{IsTerminal, Write};
use std::time::Duration;

use crate::color::{self, Stream};
use crate::mascot::{self, Paint};

/// 純判斷：`tty` = 這條輸出是終端機；`egg` = `telepy dig`（彩蛋本身，不理 `TELEPY_NO_MASCOT`）；
/// `colour` = 這條輸出可以上色（`color::enabled`：`--color`、`NO_COLOR`、`TERM=dumb`、舊的 Windows 主控台…），不行就畫黑白的。
/// Pure decision: `tty` = the stream is a terminal; `egg` = `telepy dig` itself (ignores `TELEPY_NO_MASCOT`);
/// `colour` = the stream may get colour (`color::enabled`: `--color`, `NO_COLOR`, `TERM=dumb`, an old Windows console…), else Tapi is drawn in mono.
pub fn choose(tty: bool, egg: bool, colour: bool, env: impl Fn(&str) -> Option<String>) -> Option<Paint> {
    let set = |k: &str| env(k).is_some_and(|v| !v.is_empty());
    if !tty || (!egg && set("TELEPY_NO_MASCOT")) {
        return None;
    }
    if !colour {
        return Some(Paint::Mono);
    }
    match env("COLORTERM").map(|v| v.to_ascii_lowercase()).as_deref() {
        Some("truecolor") | Some("24bit") => Some(Paint::TrueColor),
        _ => Some(Paint::Ansi256),
    }
}

fn is_tty(stream: Stream) -> bool {
    match stream {
        Stream::Out => std::io::stdout().is_terminal(),
        Stream::Err => std::io::stderr().is_terminal(),
    }
}

/// 這條輸出要不要畫 Tapi、怎麼上色。/ Whether (and how) to draw Tapi on this stream.
pub fn paint_for(stream: Stream) -> Option<Paint> {
    choose(is_tty(stream), false, color::enabled(stream), |k| std::env::var(k).ok())
}

/// 寫到哪條輸出（量它的終端機寬度）。/ Which stream is written to (whose terminal width counts).
#[derive(Clone, Copy, Debug)]
pub enum Out {
    Stdout,
    Stderr,
}

/// 這條輸出的終端機有幾欄；不是終端機或量不到時是 `None`。/ The width of this stream's terminal; `None` when it is not one.
pub fn columns(out: Out) -> Option<usize> {
    let size = match out {
        Out::Stdout => terminal_size::terminal_size_of(std::io::stdout()),
        Out::Stderr => terminal_size::terminal_size_of(std::io::stderr()),
    };
    size.map(|(w, _)| usize::from(w.0)).filter(|&w| w > 0)
}

/// 圖和文字之間的空白。/ The gap between the art and the text.
const GAP: usize = 2;
/// 圖旁邊至少要留這麼寬給文字，不然文字改放到圖下面。/ The narrowest text column beside the art; narrower = text below it.
const MIN_TEXT: usize = 24;

/// 圖在左、文字放在圖中間幾列的右邊。給了終端機寬度（`cols`）就先把文字折到剩下的寬度：終端機自己換行時，折下去的字
/// 會從下一列最左邊開始、把圖往下推，臉就被切開了。圖旁邊太窄時文字放到圖下面，連圖都放不下就只印文字。
/// Art on the left, the text beside its middle rows. With the terminal's width (`cols`) the text is wrapped to the
/// room left first: when the terminal wraps a line itself, the rest starts at column 0 of the next row and pushes the
/// art down through the face. Too little room beside the art puts the text below it; no room for the art = text only.
pub fn beside(art: &[String], text: &[&str], cols: Option<usize>) -> Vec<String> {
    let w = art.first().map(|l| visible_width(l)).unwrap_or(0);
    let Some(cols) = cols else {
        return place(art, w, &text.iter().map(|t| t.to_string()).collect::<Vec<_>>());
    };
    // 最後一欄不寫：有的終端機（舊的 Windows 主控台）寫滿就先換行，多出一列空白。
    // The last column stays empty: some terminals (the legacy Windows console) wrap as soon as it is written.
    let usable = cols.saturating_sub(1).max(1);
    if usable >= w + GAP + MIN_TEXT {
        return place(art, w, &wrap(text, usable - w - GAP));
    }
    let below = wrap(text, usable);
    if usable < w {
        return below;
    }
    art.iter().cloned().chain(below).collect()
}

fn place(art: &[String], w: usize, text: &[String]) -> Vec<String> {
    let rows = art.len().max(text.len());
    let start = (rows - text.len()) / 2;
    (0..rows)
        .map(|i| {
            let left = art.get(i).cloned().unwrap_or_else(|| " ".repeat(w));
            match i.checked_sub(start).and_then(|j| text.get(j)) {
                Some(t) => format!("{left}{}{t}", " ".repeat(GAP)),
                None => left,
            }
        })
        .collect()
}

/// 把每行文字在空白處折到 `width` 欄以內；比整行還長的字（網址）硬切。文字不含跳脫碼。
/// Wrap each line at spaces to at most `width` columns; a word longer than a whole line (a URL) is cut. Plain text only.
pub fn wrap(text: &[&str], width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut out = Vec::new();
    for line in text {
        let mut cur = String::new();
        let mut cur_w = 0;
        for word in line.split_whitespace() {
            let word_w = visible_width(word);
            if cur_w > 0 && cur_w + 1 + word_w <= width {
                cur.push(' ');
                cur.push_str(word);
                cur_w += 1 + word_w;
                continue;
            }
            if cur_w > 0 {
                out.push(std::mem::take(&mut cur));
                cur_w = 0;
            }
            for c in word.chars() {
                let c_w = char_width(c);
                if cur_w > 0 && cur_w + c_w > width {
                    out.push(std::mem::take(&mut cur));
                    cur_w = 0;
                }
                cur.push(c);
                cur_w += c_w;
            }
        }
        out.push(cur);
    }
    out
}

fn char_width(c: char) -> usize {
    unicode_width::UnicodeWidthChar::width(c).unwrap_or(0)
}

/// 去掉 ANSI 跳脫碼後的欄數（半格字元一欄、中日文兩欄）。/ Columns after stripping ANSI escapes (a half block is one, CJK two).
pub fn visible_width(s: &str) -> usize {
    strip_ansi(s).chars().map(char_width).sum()
}

pub fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------- telepy dig

/// 場景寬度（欄）。高度跟著圖的大小算（[`height`]）。/ Scene width in columns; the height follows the sprites ([`height`]).
pub const W: usize = 64;
const FPS: u64 = 12;

pub const EXPLAIN: [&str; 2] = ["The device dialled out to Telepy; you came back in the same way.", "That's a reverse tunnel: nothing on the device's network had to be opened."];

/// 場景的各列與各欄，全部從圖的大小算出來（換圖不用改這裡）。
/// Rows and columns of the scene, all derived from the sprite sizes (new art needs no change here).
#[derive(Clone, Copy, Debug)]
struct Layout {
    side_w: usize,
    sky_top: usize,
    ground: usize,
    under: usize,
    tunnel: usize,
    caption: usize,
    h: usize,
    wall_x: usize,
    device_x: usize,
    shaft_dev: usize,
    shaft_telepy: usize,
}

fn layout() -> Layout {
    let fronts = [mascot::IDLE, mascot::HAPPY, mascot::WAVE];
    let front_w = fronts.iter().map(|s| mascot::width(s)).max().unwrap_or(0);
    let front_h = fronts.iter().map(|s| mascot::rows(s)).max().unwrap_or(0);
    let side_w = mascot::width(mascot::SIDE_A).max(mascot::width(mascot::SIDE_B));
    let side_h = mascot::rows(mascot::SIDE_A).max(mascot::rows(mascot::SIDE_B));
    let sky_top = 1;
    let ground = sky_top + front_h;
    let under = ground + 1;
    let caption = under + side_h + 1;
    Layout {
        side_w,
        sky_top,
        ground,
        under,
        tunnel: under + side_h / 2,
        caption,
        h: caption + 1,
        wall_x: 1 + front_w + 4,
        device_x: W - 8,
        shaft_dev: W - 6,
        shaft_telepy: 1 + front_w / 2,
    }
}

/// 每一格的行數。/ Lines per frame.
pub fn height() -> usize {
    layout().h
}

#[derive(Clone)]
struct Grid {
    cells: Vec<Vec<Option<String>>>,
}

impl Grid {
    fn new(h: usize) -> Self {
        Grid { cells: vec![vec![None; W]; h] }
    }

    fn put(&mut self, y: usize, x: usize, text: &str, style: Option<&str>, paint: Paint) {
        for (i, c) in text.chars().enumerate() {
            if let Some(cell) = self.cells.get_mut(y).and_then(|r| r.get_mut(x + i)) {
                *cell = Some(match style {
                    Some(sgr) if paint != Paint::Mono => format!("{sgr}{c}"),
                    _ => c.to_string(),
                });
            }
        }
    }

    fn sprite<S: AsRef<str>>(&mut self, y: usize, x: usize, sprite: &[S], paint: Paint) {
        for (dy, row) in mascot::cells(sprite, paint).into_iter().enumerate() {
            for (dx, cell) in row.into_iter().enumerate() {
                if let (Some(c), Some(slot)) = (cell, self.cells.get_mut(y + dy).and_then(|r| r.get_mut(x + dx))) {
                    *slot = Some(c);
                }
            }
        }
    }

    fn lines(&self, paint: Paint) -> Vec<String> {
        let mono = paint == Paint::Mono;
        self.cells
            .iter()
            .map(|row| {
                let mut line = String::new();
                for cell in row {
                    if !mono {
                        line.push_str("\x1b[0m");
                    }
                    line.push_str(cell.as_deref().unwrap_or(" "));
                }
                if !mono {
                    line.push_str("\x1b[0m");
                }
                line
            })
            .collect()
    }
}

const GROUND_STYLE: &str = "\x1b[38;5;244m";
const WALL_STYLE: &str = "\x1b[38;5;160m";
const TUNNEL_STYLE: &str = "\x1b[38;5;172m";
const PACKET_STYLE: &str = "\x1b[1;38;5;220m";

/// 不動的背景：標籤、防火牆、裝置、地面、裝置下的豎井。/ The still background: labels, firewall, device, ground, the device's shaft.
fn backdrop(l: &Layout, paint: Paint, caption: &str) -> Grid {
    let mut g = Grid::new(l.h);
    g.put(0, 1, "you · Telepy", None, paint);
    g.put(0, l.device_x, "device", None, paint);
    let wall_top = l.ground.saturating_sub(5).max(l.sky_top + 1);
    g.put(wall_top - 1, l.wall_x - 3, "firewall", Some(WALL_STYLE), paint);
    for y in wall_top..l.ground {
        g.put(y, l.wall_x, "▓▓", Some(WALL_STYLE), paint);
    }
    g.put(l.ground - 3, l.device_x, "┌────┐", None, paint);
    g.put(l.ground - 2, l.device_x, "│ ▪▪ │", None, paint);
    g.put(l.ground - 1, l.device_x, "└────┘", None, paint);
    g.put(l.ground, 0, &"─".repeat(W), Some(GROUND_STYLE), paint);
    for y in l.under..l.tunnel {
        g.put(y, l.shaft_dev, "║", Some(TUNNEL_STYLE), paint);
    }
    g.put(l.tunnel, l.shaft_dev, "╝", Some(TUNNEL_STYLE), paint);
    g.put(l.caption, 1, caption, None, paint);
    g
}

/// `telepy dig` 的每一格（純函式）：Tapi 從裝置下面飄過去（裙擺兩格交替）→ 在 Telepy 這邊冒出來揮手 → 封包沿同一條
/// 隧道跑回裝置。每格 [`height`] 行、每行 [`W`] 欄。
/// Every frame of `telepy dig` (pure): Tapi floats from under the device (the hem ripples) → pops up waving on
/// Telepy's side → a packet runs back along the same tunnel. [`height`] lines of [`W`] columns each.
pub fn frames(paint: Paint) -> Vec<Vec<String>> {
    let l = layout();
    let mut out = Vec::new();
    // 飄：從裝置下面往左，後面留下隧道。/ Float leftwards from under the device, the tunnel behind.
    let mut x = l.shaft_dev.saturating_sub(l.side_w);
    let mut step = 0;
    loop {
        let mut g = backdrop(&l, paint, "Tapi floats out from the device, under the firewall...");
        for tx in x + l.side_w..l.shaft_dev {
            g.put(l.tunnel, tx, "═", Some(TUNNEL_STYLE), paint);
        }
        g.sprite(l.under, x, if step % 2 == 0 { mascot::SIDE_A } else { mascot::SIDE_B }, paint);
        out.push(g.lines(paint));
        if x <= 2 {
            break;
        }
        x = x.saturating_sub(2).max(2);
        step += 1;
    }
    // 打通後的隧道（Telepy 這邊也有豎井）。/ The finished tunnel, with a shaft on Telepy's side too.
    let tunnel = |caption: &str| {
        let mut g = backdrop(&l, paint, caption);
        for y in l.under..l.tunnel {
            g.put(y, l.shaft_telepy, "║", Some(TUNNEL_STYLE), paint);
        }
        g.put(l.tunnel, l.shaft_telepy, "╚", Some(TUNNEL_STYLE), paint);
        for tx in l.shaft_telepy + 1..l.shaft_dev {
            g.put(l.tunnel, tx, "═", Some(TUNNEL_STYLE), paint);
        }
        g
    };
    // 冒出來、揮手。/ Pop up and wave.
    for i in 0..5 {
        let mut g = tunnel("...and pops up at Telepy. The tunnel is open.");
        g.sprite(l.sky_top, 1, if i % 2 == 0 { mascot::WAVE } else { mascot::IDLE }, paint);
        out.push(g.lines(paint));
    }
    // 封包從 Telepy 沿同一條隧道回到裝置。/ A packet runs from Telepy back along the same tunnel to the device.
    let mut px = l.shaft_telepy + 1;
    while px < l.shaft_dev {
        let mut g = tunnel("You come back in through the same tunnel.");
        g.sprite(l.sky_top, 1, mascot::WAVE, paint);
        g.put(l.tunnel, px, "▶", Some(PACKET_STYLE), paint);
        out.push(g.lines(paint));
        px += 4;
    }
    for _ in 0..6 {
        let mut g = tunnel("You come back in through the same tunnel.");
        g.sprite(l.sky_top, 1, mascot::HAPPY, paint);
        g.put(l.under, l.shaft_dev, "▲", Some(PACKET_STYLE), paint);
        out.push(g.lines(paint));
    }
    out
}

/// 終端機放不下整個場景時不播動畫：折行後往上移 [`height`] 列會移錯地方，畫面全亂。
/// No animation when the terminal is narrower than the scene: wrapped lines make the [`height`]-row move-up land in the wrong place.
pub fn animates(cols: Option<usize>) -> bool {
    cols.is_none_or(|c| c > W)
}

/// `telepy dig`：終端機裡播動畫（原地重畫，不藏游標），否則印靜態的 Tapi 和說明。
/// `telepy dig`: animate in place in a terminal (the cursor stays visible), else print a still Tapi and the text.
pub fn dig() -> std::io::Result<()> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let cols = columns(Out::Stdout);
    let paint = choose(is_tty(Stream::Out), true, color::enabled(Stream::Out), |k| std::env::var(k).ok());
    // 動畫靠游標控制碼：終端機不吃 ANSI（`TERM=dumb`、舊的 Windows 主控台）就印靜態的。
    // The animation moves the cursor with escape codes: a terminal without ANSI gets the still picture.
    let Some(paint) = paint.filter(|_| animates(cols) && color::escapes(Stream::Out)) else {
        for line in beside(&mascot::render(mascot::WAVE, paint.unwrap_or(Paint::Mono)), &EXPLAIN, cols) {
            writeln!(out, "{line}")?;
        }
        return Ok(());
    };
    let h = height();
    for (i, frame) in frames(paint).iter().enumerate() {
        if i > 0 {
            write!(out, "\x1b[{h}A")?;
        }
        for line in frame {
            write!(out, "\r\x1b[2K{line}\n")?;
        }
        out.flush()?;
        std::thread::sleep(Duration::from_millis(1000 / FPS));
    }
    for line in EXPLAIN {
        writeln!(out, "{line}")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn painting_follows_the_terminal_and_the_environment() {
        assert_eq!(choose(false, false, true, env(&[])), None);
        assert_eq!(choose(false, true, true, env(&[])), None);
        assert_eq!(choose(true, false, true, env(&[])), Some(Paint::Ansi256));
        assert_eq!(choose(true, false, true, env(&[("TELEPY_NO_MASCOT", "1")])), None);
        assert_eq!(choose(true, false, true, env(&[("TELEPY_NO_MASCOT", "")])), Some(Paint::Ansi256));
        assert_eq!(choose(true, true, true, env(&[("TELEPY_NO_MASCOT", "1")])), Some(Paint::Ansi256), "dig is the egg itself");
        assert_eq!(choose(true, false, false, env(&[("COLORTERM", "truecolor")])), Some(Paint::Mono), "no colour on this stream");
        assert_eq!(choose(true, false, true, env(&[("COLORTERM", "truecolor")])), Some(Paint::TrueColor));
        assert_eq!(choose(true, false, true, env(&[("COLORTERM", "24bit")])), Some(Paint::TrueColor));
    }

    #[test]
    fn text_sits_beside_the_middle_rows() {
        let art = mascot::render(mascot::WAVE, Paint::Mono);
        let lines = beside(&art, &["Signed in"], None);
        assert_eq!(lines.len(), art.len());
        let mid = (art.len() - 1) / 2;
        assert!(lines[mid].ends_with("  Signed in") && lines[mid].starts_with(&art[mid]), "{lines:?}");
        assert_eq!(lines[0], art[0]);
        // 文字比圖長時，多出來的行前面補空白。/ Text longer than the art is padded on the left.
        let many: Vec<String> = (0..art.len() + 2).map(|i| format!("l{i}")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        let lines = beside(&art, &refs, None);
        assert_eq!(lines.len(), art.len() + 2);
        assert!(lines.iter().all(|l| visible_width(l) >= mascot::width(mascot::WAVE)));
    }

    const LOGIN: &str = "Signed in to https://telepy.example.com as alice (credentials in the system keyring).";

    /// 終端機的樣子：每列不超過 `cols`、超過就照終端機的方式折（看折完後圖還在不在原位）。
    /// What a terminal shows: rows of at most `cols`, longer lines wrapped the way a terminal does.
    fn on_screen(lines: &[String], cols: usize) -> Vec<String> {
        let mut rows = Vec::new();
        for line in lines {
            let plain: Vec<char> = strip_ansi(line).chars().collect();
            for chunk in plain.chunks(cols) {
                rows.push(chunk.iter().collect());
            }
        }
        rows
    }

    #[test]
    fn long_text_is_wrapped_beside_the_art_so_the_face_stays_whole() {
        let art = mascot::render(mascot::WAVE, Paint::Mono);
        let w = mascot::width(mascot::WAVE);
        for cols in [80, 100, 60] {
            let lines = beside(&art, &[LOGIN], Some(cols));
            assert!(lines.iter().all(|l| visible_width(l) < cols), "{cols}: {lines:#?}");
            // 每一列的左邊就是圖的那一列（沒有被折下來的字插進去）。/ Every row starts with its own art row.
            let screen = on_screen(&lines, cols);
            assert_eq!(screen.len(), art.len(), "{cols}: {screen:#?}");
            for (row, a) in screen.iter().zip(&art) {
                assert!(row.starts_with(a.as_str()), "{cols}: {screen:#?}");
            }
            // 字一個都沒少、順序不變。/ No word lost, same order.
            let text: Vec<String> = lines.iter().map(|l| strip_ansi(l).chars().skip(w).collect::<String>().trim().to_string()).filter(|t| !t.is_empty()).collect();
            assert_eq!(text.join(" "), LOGIN, "{cols}");
        }
        // 夠寬就跟以前一樣一行。/ Wide enough: one line, as before.
        assert_eq!(beside(&art, &[LOGIN], Some(200)), beside(&art, &[LOGIN], None));
    }

    #[test]
    fn narrow_terminals_put_the_text_below_or_drop_the_art() {
        let art = mascot::render(mascot::HAPPY, Paint::Ansi256);
        let w = mascot::width(mascot::HAPPY);
        // 圖旁邊放不下：圖完整、文字在下面。/ No room beside: the whole art, the text under it.
        let cols = w + GAP + MIN_TEXT;
        let lines = beside(&art, &[LOGIN], Some(cols));
        assert_eq!(&lines[..art.len()], &art[..]);
        assert_eq!(lines[art.len()..].join(" "), LOGIN);
        assert!(lines.iter().all(|l| visible_width(l) < cols), "{lines:#?}");
        // 連圖都放不下：只有文字。/ Not even the art fits: text only.
        let lines = beside(&art, &[LOGIN], Some(w));
        assert!(lines.iter().all(|l| !l.contains('\x1b') && visible_width(l) < w), "{lines:#?}");
        // 網址比一列還長，被切開。/ The URL is longer than a row, so it is cut.
        assert_eq!(lines.concat().replace(' ', ""), LOGIN.replace(' ', ""));
    }

    #[test]
    fn wrapping_cuts_only_words_longer_than_a_line_and_counts_wide_characters() {
        assert_eq!(wrap(&["one two three"], 7), ["one two", "three"]);
        assert_eq!(wrap(&["see https://telepy.example.com/x"], 10), ["see", "https://te", "lepy.examp", "le.com/x"]);
        assert_eq!(wrap(&["", "a"], 5), ["", "a"]);
        // 中日文一字兩欄。/ CJK takes two columns a character.
        assert_eq!(visible_width("登入成功"), 8);
        assert_eq!(wrap(&["已登入 Telepy 伺服器"], 12), ["已登入", "Telepy", "伺服器"]);
        assert_eq!(wrap(&["一二三四五六七"], 6), ["一二三", "四五六", "七"]);
    }

    #[test]
    fn dig_animates_only_when_the_scene_fits() {
        assert!(animates(None));
        assert!(animates(Some(W + 1)));
        assert!(!animates(Some(W)));
        assert!(!animates(Some(40)));
    }

    #[test]
    fn strip_and_width() {
        assert_eq!(strip_ansi("\x1b[0m\x1b[38;5;172m▀\x1b[0m x"), "▀ x");
        assert_eq!(visible_width("\x1b[1;38;5;220m▶\x1b[0m"), 1);
    }

    #[test]
    fn frames_are_all_the_same_shape() {
        let h = height();
        assert!(W <= 64);
        for paint in [Paint::Mono, Paint::Ansi256, Paint::TrueColor] {
            let f = frames(paint);
            assert!(f.len() >= 36 && f.len() <= 54, "≈ 3–4.5 s at 12 fps: {}", f.len());
            for frame in &f {
                assert_eq!(frame.len(), h);
                for line in frame {
                    assert_eq!(visible_width(line), W, "{line:?}");
                    assert_eq!(paint == Paint::Mono, !line.contains('\x1b'), "{line:?}");
                }
            }
        }
    }

    #[test]
    fn tapi_floats_left_and_ends_up_on_telepys_side() {
        let l = layout();
        let f = frames(Paint::Mono);
        let ink = |line: &str, from: usize, to: usize| line.chars().skip(from).take(to - from).any(|c| matches!(c, '█' | '▀' | '▄'));
        let under = l.under..l.caption;
        let sky = l.sky_top..l.ground;
        // 第一格：Tapi 在地下、裝置那邊。/ First frame: underground, on the device's side.
        assert!(under.clone().any(|y| ink(&f[0][y], l.wall_x, W)));
        assert!(!sky.clone().any(|y| ink(&f[0][y], 0, l.wall_x)));
        // 最後一格：地面上、Telepy 這邊（防火牆左邊），地下沒有 Tapi。/ Last frame: above ground left of the wall, nothing underground.
        let last = f.last().unwrap();
        assert!(sky.clone().any(|y| ink(&last[y], 0, l.wall_x)), "{last:#?}");
        assert!(!under.clone().any(|y| ink(&last[y], 0, W)), "{last:#?}");
        assert!(last[l.tunnel].contains("═══"));
        // 圖不會蓋到防火牆。/ The art never covers the wall.
        assert!(mascot::width(mascot::WAVE) + 1 < l.wall_x);
    }
}
