//! Tapi：Telepy 的吉祥物，一隻兩耳夾著青綠十字髮夾的柿子色小幽靈（沒有腳、裙擺是波浪，眼睛是一筆線條，嘴巴是 ω）。
//! 像素格是唯一的來源：gateway 的 ssh 招呼與 `telepy` CLI（`#[path]` 引入這個檔）用半格字元畫在終端機裡，
//! 網頁的 `src/frontend/src/lib/mascot.ts` 是同一份格子（`mascot.test.ts` 會讀這個檔比對，改一邊就要改另一邊）。
//! Tapi, Telepy's mascot: a little persimmon-coloured ghost with teal cross clips on its ears (no feet, a wavy hem, line eyes, an
//! ω mouth). The pixel grids below are the single source: the gateway's ssh greeting and the `telepy` CLI (which
//! includes this file with `#[path]`) draw them with half blocks; the web's `lib/mascot.ts` holds the same grids and
//! its test reads this file to keep them equal.

pub const NAME: &str = "Tapi";

/// 正面、瞇眼 ω 嘴（預設）。/ Front view, content eyes and an ω mouth (the default).
pub const IDLE: &[&str] = &[
    "..........................",
    "..........................",
    "..........................",
    "......DDD........DDD......",
    "...DDDDFDDDDDDDDDDFDDDD...",
    "...DODFFFDOOOOOODFFFDOD...",
    "...DODDFDDOOOOOODDFDDOD...",
    "...DOODDDOOOOOOOODDDOOD...",
    "....DOOOOOOOOOOOOOOOOD....",
    "....DOOOOOOOOOOOOOOOOD....",
    "...DOHOOOOOOOOOOOOOOOOD...",
    "...DHOOOEEEOOOOEEEOOOOD...",
    "..DOHOOEOOOOOOOOOOEOOOOD..",
    "..DOOPOPOOOEOEOEOOPOPOOD..",
    "..DOOPOPOOOOEOEOOOPOPOSD..",
    ".DOOOOOOOOOOOOOOOOOOSSSSD.",
    ".DOOOOOOOOOOOOOOOOSSSSSSD.",
    ".DOOOOOOOOOOOOOOSSSSSSSSD.",
    ".DOOOOOOOOOOOOSSSSSSSSSSD.",
    ".DOOOODDOOOSDDSSSSDDSSSSD.",
    "..DOOD..DSSD..DSSD..DSSD..",
    "...DD....DD....DD....DD...",
];
/// 開心大笑。/ Laughing.
pub const HAPPY: &[&str] = &[
    "..........................",
    "..........................",
    "..........................",
    "......DDD........DDD......",
    "...DDDDFDDDDDDDDDDFDDDD...",
    "...DODFFFDOOOOOODFFFDOD...",
    "...DODDFDDOOOOOODDFDDOD...",
    "...DOODDDOOOOOOOODDDOOD...",
    "....DOOOOOOOOOOOOOOOOD....",
    "....DOOOOOOOOOOOOOOOOD....",
    "...DOHOEEOOOOOOOOEEOOOD...",
    "...DHOEOOEOOOOOOEOOEOOD...",
    "..DOHOOOOOOOOOOOOOOOOOOD..",
    "..DOOPOPOOOEEEEOOOPOPOOD..",
    "..DOOPOPOOOETTEOOOPOPOSD..",
    ".DOOOOOOOOOOEEOOOOOOSSSSD.",
    ".DOOOOOOOOOOOOOOOOSSSSSSD.",
    ".DOOOOOOOOOOOOOOSSSSSSSSD.",
    ".DOOOOOOOOOOOOSSSSSSSSSSD.",
    ".DOOOODDOOOSDDSSSSDDSSSSD.",
    "..DOOD..DSSD..DSSD..DSSD..",
    "...DD....DD....DD....DD...",
];
/// 伸出小手打招呼。/ Waving a little hand.
pub const WAVE: &[&str] = &[
    "..........................",
    "..........................",
    "..........................",
    "......DDD........DDD......",
    "...DDDDFDDDDDDDDDDFDDDD...",
    "...DODFFFDOOOOOODFFFDOD...",
    "...DODDFDDOOOOOODDFDDOD...",
    "...DOODDDOOOOOOOODDDOODDD.",
    "....DOOOOOOOOOOOOOOOODDOOD",
    "....DOOOOOOOOOOOOOOOODDOOD",
    "...DOHOEEOOOOOOOOEEOOOOOSD",
    "...DHOEOOEOOOOOOEOOEOOOOD.",
    "..DOHOOOOOOOOOOOOOOOOOOD..",
    "..DOOPOPOOOEEEEOOOPOPOOD..",
    "..DOOPOPOOOETTEOOOPOPOSD..",
    ".DOOOOOOOOOOEEOOOOOOSSSSD.",
    ".DOOOOOOOOOOOOOOOOSSSSSSD.",
    ".DOOOOOOOOOOOOOOSSSSSSSSD.",
    ".DOOOOOOOOOOOOSSSSSSSSSSD.",
    ".DOOOODDOOOSDDSSSSDDSSSSD.",
    "..DOOD..DSSD..DSSD..DSSD..",
    "...DD....DD....DD....DD...",
];
/// 嚇一跳：圓圓的空心眼、小 o 嘴（404 用）。/ Startled: round hollow eyes, a small o mouth (the 404 page).
pub const SURPRISED: &[&str] = &[
    "..........................",
    "..........................",
    "..........................",
    "......DDD........DDD......",
    "...DDDDFDDDDDDDDDDFDDDD...",
    "...DODFFFDOOOOOODFFFDOD...",
    "...DODDFDDOOOOOODDFDDOD...",
    "...DOODDDOOOOOOOODDDOOD...",
    "....DOOOOOOOOOOOOOOOOD....",
    "....DOOOOOOOOOOOOOOOOD....",
    "...DOHOOEOOOOOOOOEOOOOD...",
    "...DHOOEOEOOOOOOEOEOOOD...",
    "..DOHOOOEOOOOOOOOEOOOOOD..",
    "..DOOPOPOOOOEEOOOOPOPOOD..",
    "..DOOPOPOOOOEEOOOOPOPOSD..",
    ".DOOOOOOOOOOOOOOOOOOSSSSD.",
    ".DOOOOOOOOOOOOOOOOSSSSSSD.",
    ".DOOOOOOOOOOOOOOSSSSSSSSD.",
    ".DOOOOOOOOOOOOSSSSSSSSSSD.",
    ".DOOOODDOOOSDDSSSSDDSSSSD.",
    "..DOOD..DSSD..DSSD..DSSD..",
    "...DD....DD....DD....DD...",
];
/// 迷你版、朝左飄的兩格（裙擺波浪交替）；朝右用 `mirrored`。/ Mini, floating left (the hem ripples); `mirrored` faces right.
pub const SIDE_A: &[&str] = &[
    "............",
    ".D........D.",
    ".DD.DDDD.DD.",
    ".DFDOOOODFD.",
    "DOOOOOOOOOOD",
    "DHEEOOEEOOOD",
    "DPOOEOOPOSSD",
    "DOOOOOOOSSSD",
    "DOOOOOOSSSSD",
    "DDOODDSSDDSD",
    "D.DD..DD..DD",
    "............",
];
pub const SIDE_B: &[&str] = &[
    "............",
    ".D........D.",
    ".DD.DDDD.DD.",
    ".DFDOOOODFD.",
    "DOOOOOOOOOOD",
    "DHEEOOEEOOOD",
    "DPOOEOOPOSSD",
    "DOOOOOOOSSSD",
    "DOOOOOOSSSSD",
    "DODDOODDSSDD",
    "DD..DD..DD.D",
    "............",
];

/// 色票（`.` = 透明）：D 外框、O/S/H 身體 / 陰影 / 光澤、E 眼睛與嘴、P 腮紅、T 張開的嘴、F 十字髮夾。
/// Palette (`.` = transparent): outline, body / shade / gloss, eyes and mouth, blush, open mouth, the cross clips.
pub const PALETTE: &[(char, [u8; 3])] = &[
    ('D', [0x4a, 0x20, 0x26]),
    ('O', [0xf2, 0x8a, 0x38]),
    ('S', [0xdc, 0x6a, 0x24]),
    ('H', [0xff, 0xd9, 0xb0]),
    ('E', [0x4a, 0x20, 0x26]),
    ('P', [0xff, 0x9a, 0x9a]),
    ('T', [0xe9, 0x67, 0x7a]),
    ('F', [0x8d, 0xe6, 0xcf]),
];

/// 怎麼上色：無色（剪影，墨鏡與眼睛挖空）、256 色（每個終端機都支援）、24-bit。
/// How to paint: no colour (a silhouette with the glasses and eyes cut out), 256 colours (every terminal), 24-bit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Paint {
    Mono,
    Ansi256,
    TrueColor,
}

pub fn color_of(c: char) -> Option<[u8; 3]> {
    PALETTE.iter().find(|(k, _)| *k == c).map(|(_, rgb)| *rgb)
}

/// 十字髮夾可以選的顏色（找到 Tapi 後在「關於 Telepy」選；跟著帳號走）。第一個 = 預設（PALETTE 的 F）。
/// The clip colours to choose from (unlocked by finding Tapi; stored on the account). The first is the default.
pub const CLIP_COLORS: &[(&str, [u8; 3])] = &[
    ("teal", [0x8d, 0xe6, 0xcf]),
    ("sakura", [0xff, 0xb3, 0xc7]),
    ("lemon", [0xff, 0xe2, 0x7a]),
    ("grape", [0xc9, 0xa7, 0xff]),
    ("sky", [0x9f, 0xd3, 0xff]),
    ("cream", [0xff, 0xf3, 0xdc]),
];

/// 「每天換一個」：看完片尾名單解鎖。/ "A new one every day", unlocked by watching the credits to the end.
pub const DAILY: &str = "daily";

pub fn clip_color(name: &str) -> Option<[u8; 3]> {
    CLIP_COLORS.iter().find(|(n, _)| *n == name).map(|(_, rgb)| *rgb)
}

/// 存的選擇 → 這一天的顏色名字：顏色名照用、`daily` 依 UTC 日期輪流（網頁 lib/mascot.ts 同一條規則），其他 = 預設。
/// The stored choice → today's colour name: a name as is, `daily` rotates by the UTC day (same rule as the web's
/// lib/mascot.ts), anything else = the default.
pub fn clip_name(choice: &str, unix_day: i64) -> &'static str {
    if choice == DAILY {
        return CLIP_COLORS[unix_day.rem_euclid(CLIP_COLORS.len() as i64) as usize].0;
    }
    CLIP_COLORS.iter().find(|(n, _)| *n == choice).map(|(n, _)| *n).unwrap_or(CLIP_COLORS[0].0)
}

/// 今天是第幾天（UTC，1970-01-01 = 0）。/ Today's day number (UTC, 1970-01-01 = 0).
pub fn unix_day() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| (d.as_secs() / 86_400) as i64).unwrap_or(0)
}

/// 把十字髮夾（F）換成這個顏色。/ Recolour the clips (F) with this colour.
fn color_with(c: char, clip: Option<[u8; 3]>) -> Option<[u8; 3]> {
    match (c, clip) {
        ('F', Some(rgb)) => Some(rgb),
        _ => color_of(c),
    }
}

/// 最接近的 xterm 256 色（6×6×6 色塊或灰階）。/ The nearest xterm-256 colour (colour cube or grey ramp).
pub fn ansi256([r, g, b]: [u8; 3]) -> u8 {
    const LEVELS: [i32; 6] = [0, 95, 135, 175, 215, 255];
    let nearest = |v: u8| (0..6).min_by_key(|&i| (LEVELS[i] - v as i32).abs()).unwrap_or(0);
    let (ri, gi, bi) = (nearest(r), nearest(g), nearest(b));
    let cube = [LEVELS[ri], LEVELS[gi], LEVELS[bi]];
    let avg = (r as i32 + g as i32 + b as i32) / 3;
    let grey_i = ((avg - 8).max(0) / 10).min(23);
    let grey = 8 + grey_i * 10;
    let dist = |c: [i32; 3]| (c[0] - r as i32).pow(2) + (c[1] - g as i32).pow(2) + (c[2] - b as i32).pow(2);
    if dist([grey, grey, grey]) < dist(cube) {
        232 + grey_i as u8
    } else {
        16 + 36 * ri as u8 + 6 * gi as u8 + bi as u8
    }
}

/// 左右翻轉（側面朝右）。/ Flip horizontally (side view facing right).
pub fn mirrored(sprite: &[&str]) -> Vec<String> {
    sprite.iter().map(|row| row.chars().rev().collect()).collect()
}

/// 寬（終端機的欄數）。/ Width in terminal columns.
pub fn width<S: AsRef<str>>(sprite: &[S]) -> usize {
    sprite.iter().map(|r| r.as_ref().chars().count()).max().unwrap_or(0)
}

/// 高（終端機的列數；兩個像素一列）。/ Height in terminal rows (two pixels per row).
pub fn rows<S: AsRef<str>>(sprite: &[S]) -> usize {
    sprite.len().div_ceil(2)
}

fn sgr(paint: Paint, rgb: [u8; 3], background: bool) -> String {
    let base = if background { 48 } else { 38 };
    match paint {
        Paint::TrueColor => format!("\x1b[{base};2;{};{};{}m", rgb[0], rgb[1], rgb[2]),
        Paint::Ansi256 => format!("\x1b[{base};5;{}m", ansi256(rgb)),
        Paint::Mono => String::new(),
    }
}

/// 無色模式下哪些像素算「墨」：眼睛與嘴巴挖空，臉才看得出來。/ Ink in mono mode: the eyes and mouth are holes.
fn ink(c: char) -> bool {
    !matches!(c, '.' | 'E' | 'T') && color_of(c).is_some()
}

/// 每一格（一個終端機欄位）的內容：顏色碼 + 半格字元（不含重設）；全透明的格是 `None`（動畫拿來疊在背景上）。
/// Each terminal cell: colour codes + the half block (no reset); a fully transparent cell is `None` (so an
/// animation can lay the sprite over a background).
pub fn cells<S: AsRef<str>>(sprite: &[S], paint: Paint) -> Vec<Vec<Option<String>>> {
    cells_with(sprite, paint, None)
}

/// 同 [`cells`]，十字髮夾用 `clip` 的顏色。/ Like [`cells`], with the clips in `clip`'s colour.
pub fn cells_with<S: AsRef<str>>(sprite: &[S], paint: Paint, clip: Option<[u8; 3]>) -> Vec<Vec<Option<String>>> {
    let w = width(sprite);
    let pixel = |y: usize, x: usize| -> char { sprite.get(y).and_then(|r| r.as_ref().chars().nth(x)).unwrap_or('.') };
    (0..rows(sprite))
        .map(|row| {
            (0..w)
                .map(|x| {
                    let (top, bottom) = (pixel(row * 2, x), pixel(row * 2 + 1, x));
                    if paint == Paint::Mono {
                        return match (ink(top), ink(bottom)) {
                            (true, true) => Some("█".to_string()),
                            (true, false) => Some("▀".to_string()),
                            (false, true) => Some("▄".to_string()),
                            (false, false) => None,
                        };
                    }
                    match (color_with(top, clip), color_with(bottom, clip)) {
                        (None, None) => None,
                        (Some(t), None) => Some(format!("{}▀", sgr(paint, t, false))),
                        (None, Some(b)) => Some(format!("{}▄", sgr(paint, b, false))),
                        (Some(t), Some(b)) if t == b => Some(format!("{}█", sgr(paint, t, false))),
                        (Some(t), Some(b)) => Some(format!("{}{}▀", sgr(paint, t, false), sgr(paint, b, true))),
                    }
                })
                .collect()
        })
        .collect()
}

/// 用半格字元畫成終端機的列（上像素 = 前景 ▀、下像素 = 背景）；每列一樣寬、結尾重設顏色。
/// Draw with half blocks (top pixel = ▀ foreground, bottom pixel = background); every line has the same width and
/// ends with a colour reset. Mono output has no escape codes at all.
pub fn render<S: AsRef<str>>(sprite: &[S], paint: Paint) -> Vec<String> {
    render_with(sprite, paint, None)
}

/// 同 [`render`]，十字髮夾用 `clip` 的顏色。/ Like [`render`], with the clips in `clip`'s colour.
pub fn render_with<S: AsRef<str>>(sprite: &[S], paint: Paint, clip: Option<[u8; 3]>) -> Vec<String> {
    let mono = paint == Paint::Mono;
    cells_with(sprite, paint, clip)
        .into_iter()
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

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: &[&[&str]] = &[IDLE, HAPPY, WAVE, SURPRISED, SIDE_A, SIDE_B];

    #[test]
    fn sprites_are_rectangular_and_use_the_palette() {
        for s in ALL {
            let w = s[0].chars().count();
            for row in *s {
                assert_eq!(row.chars().count(), w, "{row}");
                assert!(row.chars().all(|c| c == '.' || color_of(c).is_some()), "{row}");
            }
        }
        assert_eq!(width(IDLE), 26);
        assert_eq!(rows(IDLE), 11);
        assert_eq!((width(SIDE_A), rows(SIDE_A)), (12, 6));
    }

    #[test]
    fn mono_has_no_escapes_and_cuts_out_the_eyes() {
        let lines = render(IDLE, Paint::Mono);
        assert_eq!(lines.len(), 11);
        assert!(lines.iter().all(|l| !l.contains('\x1b') && l.chars().count() == 26));
        // 第 6 列（像素 10–11）是挖空的眼睛。/ Row 6 (pixels 10–11) has the eyes cut out.
        assert_eq!(lines[5], "   █████▀▀▀████▀▀▀█████   ");
    }

    #[test]
    fn colour_lines_reset_at_the_end() {
        for paint in [Paint::Ansi256, Paint::TrueColor] {
            for l in render(WAVE, paint) {
                assert!(l.ends_with("\x1b[0m"));
            }
        }
    }

    #[test]
    fn nearest_256_colours() {
        assert_eq!(ansi256([0, 0, 0]), 16);
        assert_eq!(ansi256([255, 255, 255]), 231);
        assert_eq!(ansi256([0xe3, 0x77, 0x0e]), 172); // orange (215,135,0)
        assert_eq!(ansi256([0x80, 0x80, 0x80]), 244);
    }

    #[test]
    fn clip_colours_and_the_daily_rotation() {
        assert_eq!(clip_name("grape", 0), "grape");
        assert_eq!(clip_name("", 5), "teal");
        assert_eq!(clip_name("nope", 5), "teal");
        // 每天換一個：連續六天各不相同，第七天回到第一個。/ Six days in a row differ, the seventh wraps.
        let week: Vec<_> = (0..7).map(|d| clip_name(DAILY, 20_000 + d)).collect();
        assert_eq!(week[0], week[6]);
        assert_eq!(week[..6].iter().collect::<std::collections::HashSet<_>>().len(), 6);
        assert_eq!(color_of('F'), clip_color("teal"));
        let pink = render_with(IDLE, Paint::TrueColor, clip_color("sakura")).concat();
        assert!(pink.contains("255;179;199") && !pink.contains("141;230;207"));
    }

    #[test]
    fn mirror_flips_rows() {
        let m = mirrored(SIDE_A);
        assert_eq!(m[5], "DOOOEEOOEEHD");
        assert_eq!(width(&m), width(SIDE_A));
    }
}
