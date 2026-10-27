//! 產生的 ssh config（`GET /tunnels/server/config/{id}`，跟網頁「SSH config」對話框同一份）的處理：
//! - `telepy ssh / scp / sftp`：改寫成一個獨立的檔（`~/.ssh/telepy/<alias>.conf`，用 `ssh -F` 讀），ProxyCommand 也指回
//!   這個檔，known_hosts 指到 `~/.ssh/telepy/known_hosts`——不碰使用者自己的 `~/.ssh/config`。
//! - `telepy config install`：跟對話框的安裝指令一樣，把區塊包在 `# >>> telepy <alias> >>>` / `# <<< telepy <alias> <<<`
//!   之間寫進 `~/.ssh/config`；再跑一次會換掉同名的完整區塊（沒有結尾標記的區塊原樣保留，絕不吞掉）。
//!
//! The generated ssh config (the same text as the web's SSH config dialog): rewritten into a standalone file for
//! `ssh -F` (`telepy ssh / scp / sftp`, never touching `~/.ssh/config`), or installed into `~/.ssh/config` between
//! the same markers the dialog's command uses (re-running replaces complete blocks; an unterminated one is kept).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stanza {
    pub alias: String,
    pub options: Vec<(String, String)>,
}

/// 後端的 config 文字 → Host 區塊（拿掉註解與空行，多餘空白收成一格）。/ Config text → Host stanzas.
pub fn parse_stanzas(text: &str) -> Vec<Stanza> {
    let mut out: Vec<Stanza> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(char::is_whitespace) else { continue };
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if key.eq_ignore_ascii_case("host") {
            out.push(Stanza { alias: value, options: Vec::new() });
        } else if let Some(last) = out.last_mut() {
            last.options.push((key.to_string(), value));
        }
    }
    out
}

pub fn stanza_text(s: &Stanza) -> String {
    let mut out = format!("Host {}\n", s.alias);
    for (k, v) in &s.options {
        out.push_str(&format!("    {k} {v}\n"));
    }
    out
}

fn open_marker(alias: &str) -> String {
    format!("# >>> telepy {alias} >>>")
}

fn close_marker(alias: &str) -> String {
    format!("# <<< telepy {alias} <<<")
}

pub fn marked_blocks(stanzas: &[Stanza]) -> String {
    stanzas.iter().map(|s| format!("{}\n{}{}\n", open_marker(&s.alias), stanza_text(s), close_marker(&s.alias))).collect()
}

/// 拿掉這些別名的完整標記區塊；沒有結尾標記的照抄回去。/ Drop complete marked blocks of these aliases.
pub fn strip_blocks(existing: &str, aliases: &[String]) -> String {
    let mut out = String::new();
    let mut buffered: Option<(String, String)> = None; // (alias, text so far)
    for line in existing.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if let Some((alias, buf)) = buffered.as_mut() {
            buf.push_str(line);
            if bare == close_marker(alias) {
                buffered = None;
            } else if bare.starts_with("# >>> telepy ") {
                // 前一個區塊沒有結尾：原樣保留，這一行重新判斷。/ The previous block never closed: keep it.
                let text = std::mem::take(buf);
                let keep = &text[..text.len() - line.len()];
                out.push_str(keep);
                buffered = None;
                if let Some(a) = aliases.iter().find(|a| bare == open_marker(a)) {
                    buffered = Some((a.clone(), line.to_string()));
                } else {
                    out.push_str(line);
                }
            }
            continue;
        }
        if let Some(a) = aliases.iter().find(|a| bare == open_marker(a)) {
            buffered = Some((a.clone(), line.to_string()));
        } else {
            out.push_str(line);
        }
    }
    if let Some((_, buf)) = buffered {
        out.push_str(&buf);
    }
    out
}

/// 安裝進 `~/.ssh/config`：舊的同名區塊拿掉、新的接在後面。/ Install into `~/.ssh/config`.
pub fn install(existing: &str, stanzas: &[Stanza]) -> String {
    let aliases: Vec<String> = stanzas.iter().map(|s| s.alias.clone()).collect();
    let mut out = strip_blocks(existing, &aliases);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&marked_blocks(stanzas));
    out
}

/// ssh config 裡的路徑：有空白就加引號，Windows 的反斜線換成斜線（OpenSSH 兩種都認）。/ A path inside ssh config.
pub fn config_path(p: &std::path::Path) -> String {
    let s = p.display().to_string().replace('\\', "/");
    if s.contains(' ') {
        format!("\"{s}\"")
    } else {
        s
    }
}

/// `ssh -F` 用的獨立檔：ProxyCommand 改成讀同一個檔，known_hosts 指到 `known_hosts`；`identity` 給兩跳都用。
/// The standalone file for `ssh -F`: ProxyCommand reads the same file, known_hosts points at ours; `identity` is used by both hops.
pub fn standalone(stanzas: &[Stanza], self_path: &str, known_hosts: &str, identity: Option<&str>) -> String {
    let mut out = String::from("# Written by the telepy CLI; rewritten on every `telepy ssh`.\n");
    for s in stanzas {
        let mut s = s.clone();
        for (k, v) in s.options.iter_mut() {
            if k.eq_ignore_ascii_case("ProxyCommand") && v.starts_with("ssh ") && !v.contains(" -F ") {
                *v = format!("ssh -F {self_path} {}", &v[4..]);
            }
            if k.eq_ignore_ascii_case("UserKnownHostsFile") {
                *v = known_hosts.to_string();
            }
        }
        out.push_str(&stanza_text(&s));
    }
    if let Some(id) = identity {
        out.push_str(&format!("Host *\n    IdentityFile {id}\n    IdentitiesOnly yes\n"));
    }
    out
}

/// 裝置那一段的別名（不是 `telepy-ssh-server` 的那個）。/ The device stanza's alias.
pub fn device_alias(stanzas: &[Stanza]) -> Option<&str> {
    stanzas.iter().rev().map(|s| s.alias.as_str()).find(|a| *a != "telepy-ssh-server")
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENERATED: &str = "# ========================================\n# Reverse Server Configuration\n# ========================================\nHost telepy-ssh-server\n    HostName t.example\n    Port  24242\n    Compression yes\n    StrictHostKeyChecking yes\n    UserKnownHostsFile ~/.ssh/telepy_known_hosts\n    HostKeyAlias telepy-t.example-24242\n    User telepy\n    \n\n# ========================================\n# Endpoint Configuration\n# ========================================\nHost box\n    HostName box\n    Port 22 \n    Compression yes\n    StrictHostKeyChecking no\n    User pi\n    ProxyCommand ssh -W %h:%p telepy-ssh-server\n";

    #[test]
    fn parses_the_generated_config() {
        let s = parse_stanzas(GENERATED);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].alias, "telepy-ssh-server");
        assert!(s[0].options.contains(&("Port".into(), "24242".into())));
        assert_eq!(device_alias(&s), Some("box"));
        assert!(s[1].options.contains(&("ProxyCommand".into(), "ssh -W %h:%p telepy-ssh-server".into())));
    }

    #[test]
    fn standalone_points_both_hops_at_itself() {
        let s = parse_stanzas(GENERATED);
        let out = standalone(&s, "/home/a/.ssh/telepy/box.conf", "/home/a/.ssh/telepy/known_hosts", Some("/k/id"));
        assert!(out.contains("ProxyCommand ssh -F /home/a/.ssh/telepy/box.conf -W %h:%p telepy-ssh-server"), "{out}");
        assert!(out.contains("UserKnownHostsFile /home/a/.ssh/telepy/known_hosts"));
        assert!(out.ends_with("Host *\n    IdentityFile /k/id\n    IdentitiesOnly yes\n"));
        assert_eq!(config_path(std::path::Path::new("C:\\Users\\A B\\x")), "\"C:/Users/A B/x\"");
    }

    #[test]
    fn install_replaces_its_own_blocks_only() {
        let s = parse_stanzas(GENERATED);
        let mine = "Host work\n    User me\n";
        let once = install(mine, &s);
        assert!(once.starts_with(mine));
        assert_eq!(once.matches("# >>> telepy box >>>").count(), 1);
        let twice = install(&once, &s);
        assert_eq!(once, twice, "re-running replaces instead of duplicating");
        // 沒有結尾標記的區塊不能被吞掉。/ An unterminated block is never swallowed.
        let broken = format!("{mine}# >>> telepy box >>>\nHost box\n    User old\n");
        let fixed = install(&broken, &s);
        assert!(fixed.contains("User old"), "{fixed}");
        assert_eq!(fixed.matches("# <<< telepy box <<<").count(), 1);
        // 別的別名的區塊不動。/ Other aliases' blocks stay.
        let other = "# >>> telepy nas >>>\nHost nas\n# <<< telepy nas <<<\n";
        assert!(install(other, &s).starts_with(other));
    }
}
