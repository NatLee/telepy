//! 純文字表格（`telepy ls` / `sessions` / `recordings ls`）：欄寬照內容（以字元寬算，CJK 兩格），最後一欄不補空白。
//! 上色時欄寬照樣用原字算，顏色碼只包在字外面，所以有沒有顏色欄位都對得齊。
//! Plain-text tables: column widths follow the content (CJK counts as two cells); the last column is not padded.
//! With colour the widths still come from the plain text and the codes only wrap it, so columns line up either way.

use anstyle::Style;

use crate::color;

/// 一個字元在終端機佔幾格（夠用的近似：東亞寬字元 = 2）。/ Terminal cells of one char (East Asian wide = 2).
fn cell_width(c: char) -> usize {
    let u = c as u32;
    let wide = (0x1100..=0x115F).contains(&u)
        || (0x2E80..=0xA4CF).contains(&u)
        || (0xAC00..=0xD7A3).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
        || (0xFE30..=0xFE4F).contains(&u)
        || (0xFF00..=0xFF60).contains(&u)
        || (0xFFE0..=0xFFE6).contains(&u)
        || (0x1F300..=0x1FAFF).contains(&u)
        || (0x20000..=0x3FFFD).contains(&u);
    if wide {
        2
    } else {
        1
    }
}

pub fn width(s: &str) -> usize {
    s.chars().map(cell_width).sum()
}

pub fn render(headers: &[&str], rows: &[Vec<String>]) -> String {
    render_styled(headers, rows, false, |_, _| color::PLAIN)
}

/// 同 [`render`]，`color` 為真時標題粗體、每格照 `style(欄, 字)` 上色。/ Like [`render`]; with `color`, bold headers and each cell styled by `style(column, text)`.
pub fn render_styled(headers: &[&str], rows: &[Vec<String>], color: bool, style: impl Fn(usize, &str) -> Style) -> String {
    let cols = headers.len();
    let mut w: Vec<usize> = headers.iter().map(|h| width(h)).collect();
    for r in rows {
        for (i, c) in r.iter().enumerate().take(cols) {
            w[i] = w[i].max(width(c));
        }
    }
    let line = |cells: Vec<&str>, pick: &dyn Fn(usize, &str) -> Style| {
        let mut out = String::new();
        for (i, c) in cells.iter().enumerate() {
            out.push_str(&color::paint(color, pick(i, c), c));
            if i + 1 < cells.len() {
                out.push_str(&" ".repeat(w[i] - width(c) + 2));
            }
        }
        out.trim_end().to_string()
    };
    let mut out = line(headers.to_vec(), &|_, _| color::BOLD);
    out.push('\n');
    for r in rows {
        let cells: Vec<&str> = (0..cols).map(|i| r.get(i).map(String::as_str).unwrap_or("")).collect();
        out.push_str(&line(cells, &style));
        out.push('\n');
    }
    out
}

/// 毫秒的往返時間 → `12 ms` / `1.2 s`；沒有 → `-`。/ A round trip for display.
pub fn ms(v: Option<f64>) -> String {
    match v {
        None => "-".into(),
        Some(x) if x >= 1000.0 => format!("{:.1} s", x / 1000.0),
        Some(x) => format!("{} ms", x.round() as i64),
    }
}

/// ISO 時間 → 「多久以前」（`5m ago`、`3h ago`、`2d ago`）。/ ISO time → a short "ago".
pub fn ago(iso: Option<&str>, now: i64) -> String {
    let Some(iso) = iso else { return "-".into() };
    let Some(t) = parse_iso(iso) else { return iso.to_string() };
    let s = (now - t).max(0);
    match s {
        0..=59 => format!("{s}s ago"),
        60..=3599 => format!("{}m ago", s / 60),
        3600..=86_399 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86_400),
    }
}

/// `2026-10-27T01:02:03(.xxx)(Z|+08:00)` → Unix 秒（不用 chrono 的小解析）。/ A tiny RFC 3339 parser.
pub fn parse_iso(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (time, offset) = match rest.find(['Z', '+', '-']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "Z"),
    };
    let time = time.split('.').next()?;
    let mut t = time.split(':').map(|x| x.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next().flatten().unwrap_or(0));
    let off = if offset == "Z" || offset.is_empty() {
        0
    } else {
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let mut o = offset[1..].split(':').map(|x| x.parse::<i64>().ok());
        sign * (o.next()?? * 3600 + o.next().flatten().unwrap_or(0) * 60)
    };
    // 公曆日 → 天數（Howard Hinnant 的 days_from_civil）。/ Civil date → days since the epoch.
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss - off)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_line_up_with_wide_characters() {
        let out = render(&["NAME", "HEALTH", "LABELS"], &[vec!["box".into(), "online".into(), "env=prod".into()], vec!["樹莓派".into(), "offline".into(), "".into()]]);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "NAME    HEALTH   LABELS");
        assert_eq!(lines[1], "box     online   env=prod");
        assert_eq!(lines[2], "樹莓派  offline", "trailing blanks trimmed; CJK is two cells wide");
    }

    #[test]
    fn colour_wraps_the_cells_and_keeps_the_columns() {
        let rows = [vec!["box".to_string(), "online".to_string(), "".to_string()], vec!["樹莓派".to_string(), "offline".to_string(), "x".to_string()]];
        let style = |col: usize, text: &str| if col == 1 { color::health(text) } else { color::PLAIN };
        assert_eq!(render_styled(&["NAME", "HEALTH", "L"], &rows, false, style), render(&["NAME", "HEALTH", "L"], &rows), "no colour = the plain table");
        let out = render_styled(&["NAME", "HEALTH", "L"], &rows, true, style);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "\x1b[1mNAME\x1b[0m    \x1b[1mHEALTH\x1b[0m   \x1b[1mL\x1b[0m");
        assert_eq!(lines[1], "box     \x1b[32monline\x1b[0m", "an empty last cell is still trimmed");
        assert_eq!(lines[2], "樹莓派  \x1b[2moffline\x1b[0m  x");
    }

    #[test]
    fn times_and_round_trips() {
        assert_eq!(ms(None), "-");
        assert_eq!(ms(Some(12.4)), "12 ms");
        assert_eq!(ms(Some(1530.0)), "1.5 s");
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2026-10-27T08:00:00+08:00"), parse_iso("2026-10-27T00:00:00.123456Z"));
        let now = parse_iso("2026-10-27T12:00:00Z").unwrap();
        assert_eq!(ago(Some("2026-10-27T11:55:00Z"), now), "5m ago");
        assert_eq!(ago(Some("2026-10-25T12:00:00Z"), now), "2d ago");
        assert_eq!(ago(None, now), "-");
    }
}
