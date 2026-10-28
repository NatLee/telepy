//! 隧道名稱的規則：名稱會變成 ssh 的主機名稱（產生的 ssh config 是 `HostName <名稱>`，經 `ProxyCommand ssh -W %h:%p`
//! 到閘道），所以照 OpenSSH 的規矩：
//! - OpenSSH 9.6 起，命令列上的主機名稱不能以 `-` 開頭，也不能含 `'` `` ` `` `"` `$` `\` `;` `&` `<` `>` `|` `(` `)` `{` `}`、
//!   空白與控制字元（`ssh.c` `valid_hostname`，CVE-2023-51385）；
//! - ssh_config 裡空白分隔好幾個 `Host` 樣式，`*` `?` `!` `,` 是樣式符號，`%` 在 `HostName` 會被當成 `%h` 這類記號展開，
//!   `#` 是註解；
//! - Telepy 自己的寫法：`<隧道>@<帳號>`、`<隧道>:<路徑>`、`-W <名稱>:<port>`。
//! 所以只收英數與 `.` `_` `-`，字母或數字開頭，最多 63 個字（DNS 標籤的長度）。大小寫可以用來顯示，但 ssh 連線時主機名稱
//! 一律轉成小寫（`ssh.c` `lowercase(host)`），所以名稱**不分大小寫**唯一。前端 `lib/tunnelName.ts` 是同一份規則。
//!
//! Tunnel name rules. The name becomes an ssh host name (the generated config's `HostName <name>`, through
//! `ProxyCommand ssh -W %h:%p` to the gateway), so it follows OpenSSH: since 9.6 a command-line host name may not start
//! with `-` nor contain shell metacharacters, whitespace or control characters (`valid_hostname`, CVE-2023-51385);
//! in ssh_config whitespace separates `Host` patterns, `* ? ! ,` are pattern syntax, `%` is a token in `HostName`, `#`
//! a comment; and Telepy's own `<tunnel>@<account>` / `<tunnel>:<path>` / `-W <name>:<port>`. Hence ASCII letters,
//! digits, `.`, `_`, `-`, starting with a letter or digit, at most 63 characters (a DNS label). Case may be used for
//! display, but ssh lowercases the host name when it connects, so names are unique ignoring case. The frontend's
//! `lib/tunnelName.ts` mirrors this.

/// 最長 63 個字（DNS 標籤的長度）。/ At most 63 characters (a DNS label).
pub const MAX_LEN: usize = 63;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameProblem {
    Empty,
    TooLong,
    /// 不是字母或數字開頭（`-` 開頭會被 ssh 當成選項）。/ Doesn't start with a letter or digit.
    FirstChar,
    /// 有英數與 `. _ -` 以外的字（空白、`@`、`:`、`%`、中文…）。/ A character other than ASCII letters, digits, `. _ -`.
    Chars,
}

impl NameProblem {
    pub fn code(self) -> &'static str {
        match self {
            NameProblem::Empty => "name_empty",
            NameProblem::TooLong => "name_too_long",
            NameProblem::FirstChar => "name_first_char",
            NameProblem::Chars => "name_chars",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            NameProblem::Empty => "This field is required.",
            NameProblem::TooLong => "Use at most 63 characters: the name becomes an SSH host name.",
            NameProblem::FirstChar => "Start with a letter or a digit: the name becomes an SSH host name.",
            NameProblem::Chars => "Use only letters, digits, '.', '_' and '-' (no spaces): the name becomes an SSH host name.",
        }
    }
}

fn allowed(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// 名稱哪裡不行；`None` = 可以用。/ What is wrong with a name; `None` = fine.
pub fn problem(name: &str) -> Option<NameProblem> {
    let Some(first) = name.chars().next() else { return Some(NameProblem::Empty) };
    if !name.chars().all(allowed) {
        return Some(NameProblem::Chars);
    }
    if !first.is_ascii_alphanumeric() {
        return Some(NameProblem::FirstChar);
    }
    if name.len() > MAX_LEN {
        return Some(NameProblem::TooLong);
    }
    None
}

/// 能不能直接當 ssh 的 `HostName`（舊的名稱可能不行：產生的 config 改用 `localhost:<號碼>`）。
/// Whether the name can be an ssh `HostName` as is (older names may not; the config then uses `localhost:<number>`).
pub fn ssh_safe(name: &str) -> bool {
    problem(name).is_none()
}

/// 把任意字串改成合規的名稱：不合的字（連續的算一個）換成 `-`，頭尾的 `- . _` 拿掉，截到 63 字；什麼都不剩 = `device`。
/// 一鍵加入用它把裝置的主機名稱變成隧道名稱，網頁用同一個規則提供「改成 …」。
/// Turn any string into a valid name: runs of other characters become `-`, leading / trailing `- . _` go, cut to 63;
/// nothing left = `device`. The join uses it on the device's hostname; the web offers the same suggestion.
pub fn suggest(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        if allowed(c) {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    let cut: String = trimmed.chars().take(MAX_LEN).collect();
    let cut = cut.trim_end_matches(|c: char| !c.is_ascii_alphanumeric()).to_string();
    if cut.is_empty() {
        "device".to_string()
    } else {
        cut
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_openssh_host_names() {
        for ok in ["box", "MyBox", "pi-4", "nas_01", "web.prod", "3d-printer", "a", &"x".repeat(63)] {
            assert_eq!(problem(ok), None, "{ok}");
            assert!(ssh_safe(ok));
        }
        assert_eq!(problem(""), Some(NameProblem::Empty));
        assert_eq!(problem(&"x".repeat(64)), Some(NameProblem::TooLong));
        for first in ["-box", ".box", "_box"] {
            assert_eq!(problem(first), Some(NameProblem::FirstChar), "{first}");
        }
        // 空白、ssh_config 的樣式符號與記號、shell 字元、Telepy 自己的分隔、非 ASCII。
        // Whitespace, ssh_config pattern / token syntax, shell characters, Telepy's separators, non-ASCII.
        for bad in ["My Box", "a\tb", "box*", "box?", "!box", "a,b", "100%", "a#b", "a$b", "a;b", "a|b", "a'b", "a\"b", "a`b", "a(b)", "a{b}", "a<b>", "a&b", "a\\b", "pi@box", "box:22", "a/b", "客廳NAS", "café"] {
            assert_eq!(problem(bad), Some(NameProblem::Chars), "{bad}");
            assert!(!ssh_safe(bad), "{bad}");
        }
        let codes: Vec<_> = [NameProblem::Empty, NameProblem::TooLong, NameProblem::FirstChar, NameProblem::Chars].iter().map(|p| p.code()).collect();
        assert_eq!(codes, ["name_empty", "name_too_long", "name_first_char", "name_chars"]);
    }

    #[test]
    fn suggestions_are_always_valid() {
        assert_eq!(suggest("My Box!"), "My-Box");
        assert_eq!(suggest("  Nat's MacBook Pro  "), "Nat-s-MacBook-Pro");
        assert_eq!(suggest("--box--"), "box");
        assert_eq!(suggest("客廳 NAS"), "NAS");
        assert_eq!(suggest("客廳"), "device");
        assert_eq!(suggest("a   b"), "a-b");
        assert_eq!(suggest(&format!("{}-tail", "x".repeat(62))), "x".repeat(62));
        for raw in ["My Box!", "  ", "-", "x".repeat(200).as_str(), "a.b_c-d", "%%%", "我的 Mac (2)"] {
            assert_eq!(problem(&suggest(raw)), None, "{raw:?} → {:?}", suggest(raw));
        }
    }
}
