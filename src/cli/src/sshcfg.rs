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

/// 完整的標記區塊：(別名, 內容行)。沒有結尾標記的不算。/ Complete marked blocks: (alias, body lines); unterminated ones are skipped.
fn marked(existing: &str) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    let mut cur: Option<(String, Vec<String>)> = None;
    for raw in existing.lines() {
        let line = raw.trim_end_matches('\r');
        if let Some(alias) = line.strip_prefix("# >>> telepy ").and_then(|r| r.strip_suffix(" >>>")) {
            cur = Some((alias.to_string(), Vec::new()));
            continue;
        }
        if let Some((alias, body)) = cur.as_mut() {
            if line == close_marker(alias) {
                out.push(cur.take().unwrap());
            } else {
                body.push(line.to_string());
            }
        }
    }
    out
}

/// 區塊經哪個伺服器別名跳過去（`ProxyCommand … <別名>` 的最後一個字，或 `ProxyJump`）。/ The server alias a block jumps through.
fn jump_target(body: &[String]) -> Option<String> {
    body.iter().find_map(|l| {
        let mut w = l.split_whitespace();
        match w.next() {
            Some(k) if k.eq_ignore_ascii_case("ProxyCommand") => l.split_whitespace().last().map(str::to_string),
            Some(k) if k.eq_ignore_ascii_case("ProxyJump") => w.next().map(str::to_string),
            _ => None,
        }
    })
}

/// 要寫的別名裡，已被別台 Telepy 用掉的：同名的完整標記區塊跳到別的伺服器別名（跳舊版共用別名時，看那個共用伺服器區塊的
/// `HostKeyAlias` 是不是這台；沒有那個區塊就當成這台的）。這些不覆蓋，留給使用者改前綴。網頁的安裝指令照同一條規則。
/// Aliases about to be written that another Telepy server already uses: a complete marked block of that name jumps
/// through a different server alias (for the old shared alias, the shared server block's `HostKeyAlias` decides; no
/// such block = ours). Those are never overwritten — the user sets a prefix instead. The web's commands do the same.
pub fn foreign_aliases(existing: &str, aliases: &[String], me: &str, legacy: &str) -> Vec<String> {
    let blocks = marked(existing);
    let legacy_key = blocks.iter().find(|(a, _)| a == legacy).and_then(|(_, body)| {
        body.iter().find_map(|l| {
            let mut w = l.split_whitespace();
            w.next().filter(|k| k.eq_ignore_ascii_case("HostKeyAlias")).and_then(|_| w.next()).map(str::to_string)
        })
    });
    aliases
        .iter()
        .filter(|a| a.as_str() != me && a.as_str() != legacy)
        .filter(|a| {
            blocks.iter().filter(|(b, _)| b == *a).any(|(_, body)| match jump_target(body) {
                None => false,
                Some(j) if j == me => false,
                Some(j) if j == legacy => legacy_key.as_deref().is_some_and(|k| k != me),
                Some(_) => true,
            })
        })
        .cloned()
        .collect()
}

/// 標記區塊之外手寫的同名 `Host`（ssh 用先出現的那個，所以新的可能被蓋掉）。/ Hand-written `Host` lines outside
/// Telepy's blocks with one of these names (ssh uses whichever comes first).
pub fn shadowed_aliases(existing: &str, aliases: &[String]) -> Vec<String> {
    let mut inside: Option<String> = None;
    let mut out: Vec<String> = Vec::new();
    for raw in existing.lines() {
        let line = raw.trim_end_matches('\r');
        if let Some(a) = line.strip_prefix("# >>> telepy ").and_then(|r| r.strip_suffix(" >>>")) {
            inside = Some(a.to_string());
            continue;
        }
        if inside.as_deref().is_some_and(|a| line == close_marker(a)) {
            inside = None;
            continue;
        }
        if inside.is_some() {
            continue;
        }
        let mut w = line.split_whitespace();
        if w.next().is_some_and(|k| k.eq_ignore_ascii_case("Host")) {
            for h in w {
                if aliases.iter().any(|a| a == h) && !out.iter().any(|o| o == h) {
                    out.push(h.to_string());
                }
            }
        }
    }
    out
}

/// 安裝的結果：新檔、沒寫的（別台 Telepy 的同名區塊）、被手寫 Host 蓋住的。/ The install result.
#[derive(Debug, PartialEq, Eq)]
pub struct Installed {
    pub text: String,
    pub kept: Vec<String>,
    pub shadowed: Vec<String>,
}

/// 安裝，但不覆蓋別台 Telepy 的同名裝置（見 [`foreign_aliases`]），並清掉安全可清的舊共用伺服器區塊。
/// Install without overwriting another Telepy server's devices of the same name ([`foreign_aliases`]), then drop the
/// old shared server block when that is safe ([`prune_legacy`]).
pub fn install_checked(existing: &str, stanzas: &[Stanza], me: &str, legacy: &str) -> Installed {
    let aliases: Vec<String> = stanzas.iter().map(|s| s.alias.clone()).collect();
    let kept = foreign_aliases(existing, &aliases, me, legacy);
    let write: Vec<Stanza> = stanzas.iter().filter(|s| !kept.contains(&s.alias)).cloned().collect();
    let shadowed = shadowed_aliases(existing, &write.iter().map(|s| s.alias.clone()).collect::<Vec<_>>());
    Installed { text: prune_legacy(&install(existing, &write), legacy, me), kept, shadowed }
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

/// 舊版每台 Telepy 共用的伺服器區塊別名（回應沒帶 `server.legacy_alias` 時用）。/ The old shared server alias.
pub const LEGACY_SERVER_ALIAS: &str = "telepy-ssh-server";

/// 回應裡伺服器區塊的別名（`server.alias`；舊版伺服器沒給就是共用的那個）。/ The server stanza's alias from a response.
pub fn server_alias(cfg: &serde_json::Value) -> &str {
    cfg["server"]["alias"].as_str().filter(|a| !a.is_empty()).unwrap_or(LEGACY_SERVER_ALIAS)
}

/// 裝置那一段的別名（不是伺服器區塊的那個）。/ The device stanza's alias (not the server stanza's).
pub fn device_alias<'a>(stanzas: &'a [Stanza], server_alias: &str) -> Option<&'a str> {
    stanzas.iter().rev().map(|s| s.alias.as_str()).find(|a| *a != server_alias)
}

/// known_hosts 合併：拿掉 `new` 裡出現的別名的舊行（換金鑰時不留舊的），別的伺服器的行原樣，再接上新的。
/// Merge known_hosts: drop the old lines of the aliases in `new` (a rotated key leaves nothing behind), keep every
/// other server's lines, append the new ones.
pub fn merge_known_hosts(existing: &str, new: &[String]) -> String {
    let aliases: Vec<&str> = new.iter().filter_map(|l| l.split_whitespace().next()).collect();
    let mut lines: Vec<String> = existing.lines().filter(|l| l.split_whitespace().next().is_some_and(|a| !aliases.contains(&a))).map(str::to_string).collect();
    lines.extend(new.iter().cloned());
    lines.join("\n") + "\n"
}

/// 舊版的共用伺服器區塊：第一個寫著 `HostKeyAlias <me>` 的完整 `legacy` 標記區塊，只有在檔案裡其他非註解行都不再用
/// `legacy` 這個名字（ProxyCommand / ProxyJump / Host …）時才拿掉——它一定是這台的，也沒有裝置區塊還指著它。網頁的
/// 安裝指令（sh / PowerShell）照同一條規則。
/// The old shared server block: the first complete `legacy` block that says `HostKeyAlias <me>` is removed only when
/// no other non-comment line in the file names `legacy` (ProxyCommand / ProxyJump / Host …) — so it is provably this
/// server's and no device block still jumps through it. The web's install commands follow the same rule.
pub fn prune_legacy(text: &str, legacy: &str, me: &str) -> String {
    if legacy.is_empty() || legacy == me {
        return text.to_string();
    }
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let bare = |l: &str| l.trim_end_matches(['\n', '\r']).to_string();
    let mut block: Option<(usize, usize)> = None;
    let mut i = 0;
    while i < lines.len() && block.is_none() {
        if bare(lines[i]) == open_marker(legacy) {
            let mut j = i + 1;
            while j < lines.len() {
                let b = bare(lines[j]);
                if b == close_marker(legacy) {
                    let mine = lines[i + 1..j].iter().any(|l| {
                        let mut w = l.split_whitespace();
                        w.next().is_some_and(|k| k.eq_ignore_ascii_case("HostKeyAlias")) && w.next() == Some(me)
                    });
                    if mine {
                        block = Some((i, j));
                    }
                    break;
                }
                if b.starts_with("# >>> telepy ") {
                    break;
                }
                j += 1;
            }
        }
        i += 1;
    }
    let Some((start, end)) = block else { return text.to_string() };
    let used = lines.iter().enumerate().filter(|(k, _)| *k < start || *k > end).any(|(_, l)| {
        let t = l.trim();
        !t.starts_with('#') && t.split(|c: char| c.is_whitespace() || c == ',').any(|w| w == legacy)
    });
    if used {
        return text.to_string();
    }
    lines[..start].concat() + &lines[end + 1..].concat()
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
        assert_eq!(device_alias(&s, "telepy-ssh-server"), Some("box"));
        assert_eq!(server_alias(&serde_json::json!({"server": {"alias": "telepy-t.example-24242"}})), "telepy-t.example-24242");
        assert_eq!(server_alias(&serde_json::json!({})), "telepy-ssh-server");
        assert!(s[1].options.contains(&("ProxyCommand".into(), "ssh -W %h:%p telepy-ssh-server".into())));
    }

    #[test]
    fn known_hosts_merge_replaces_only_this_servers_lines() {
        let old = "telepy-a-1 ssh-ed25519 OLD\ntelepy-b-2 ssh-ed25519 B\n";
        assert_eq!(merge_known_hosts(old, &["telepy-a-1 ssh-ed25519 NEW".into()]), "telepy-b-2 ssh-ed25519 B\ntelepy-a-1 ssh-ed25519 NEW\n");
        assert_eq!(merge_known_hosts("", &["telepy-a-1 k".into()]), "telepy-a-1 k\n");
    }

    #[test]
    fn the_legacy_block_goes_only_when_it_is_ours_and_unused() {
        let legacy = "# >>> telepy telepy-ssh-server >>>\nHost telepy-ssh-server\n    HostName t\n    HostKeyAlias telepy-t-1\n# <<< telepy telepy-ssh-server <<<\n";
        let new_dev = "# >>> telepy box >>>\nHost box\n    ProxyCommand ssh -W %h:%p telepy-t-1\n# <<< telepy box <<<\n";
        let old_dev = "# >>> telepy cam >>>\nHost cam\n    ProxyCommand ssh -W %h:%p telepy-ssh-server\n# <<< telepy cam <<<\n";
        // 沒人用了 → 拿掉 / Nothing uses it → removed
        assert_eq!(prune_legacy(&format!("Host x\n{legacy}{new_dev}"), "telepy-ssh-server", "telepy-t-1"), format!("Host x\n{new_dev}"));
        // 還有舊的裝置區塊跳它 → 留著 / An old device block still jumps through it → kept
        let text = format!("{legacy}{old_dev}{new_dev}");
        assert_eq!(prune_legacy(&text, "telepy-ssh-server", "telepy-t-1"), text);
        // 別台伺服器的（HostKeyAlias 不同）→ 留著 / Another server's (different HostKeyAlias) → kept
        assert_eq!(prune_legacy(&format!("{legacy}{new_dev}"), "telepy-ssh-server", "telepy-other-9"), format!("{legacy}{new_dev}"));
        // 沒有結尾標記 → 留著；註解裡提到不算 / Unterminated → kept; a mention in a comment does not count
        let open = "# >>> telepy telepy-ssh-server >>>\nHost telepy-ssh-server\n    HostKeyAlias telepy-t-1\n";
        assert_eq!(prune_legacy(&format!("{open}{new_dev}"), "telepy-ssh-server", "telepy-t-1"), format!("{open}{new_dev}"));
        assert_eq!(prune_legacy(&format!("# was telepy-ssh-server\n{legacy}"), "telepy-ssh-server", "telepy-t-1"), "# was telepy-ssh-server\n");
        // 舊版伺服器（別名還是共用的）→ 不動 / An old server (alias still the shared one) → untouched
        assert_eq!(prune_legacy(legacy, "telepy-ssh-server", "telepy-ssh-server"), legacy);
    }

    #[test]
    fn another_servers_device_of_the_same_name_is_kept() {
        let me = "telepy-a-1";
        let dev = |alias: &str, via: &str| Stanza { alias: alias.into(), options: vec![("ProxyCommand".into(), format!("ssh -W %h:%p {via}"))] };
        let server = Stanza { alias: me.into(), options: vec![("HostKeyAlias".into(), me.into())] };
        let other = marked_blocks(&[dev("pi", "telepy-b-2"), dev("cam", me)]);
        let out = install_checked(&other, &[server.clone(), dev("pi", me), dev("cam", me), dev("nas", me)], me, "telepy-ssh-server");
        assert_eq!(out.kept, ["pi"], "the other server's pi stays");
        assert!(out.text.contains("ssh -W %h:%p telepy-b-2") && out.text.matches("Host pi\n").count() == 1, "{}", out.text);
        assert_eq!(out.text.matches("Host cam\n").count(), 1, "our own cam is replaced, not duplicated");
        assert!(out.text.contains("Host nas\n"));
        // 舊版共用別名：共用伺服器區塊是別台的 → 別台的；是這台的或沒有 → 這台的。/ The old shared alias.
        let legacy_srv = |key: &str| format!("# >>> telepy telepy-ssh-server >>>\nHost telepy-ssh-server\n    HostKeyAlias {key}\n# <<< telepy telepy-ssh-server <<<\n");
        let old_pi = marked_blocks(&[dev("pi", "telepy-ssh-server")]);
        assert_eq!(foreign_aliases(&(legacy_srv("telepy-b-2") + &old_pi), &["pi".into()], me, "telepy-ssh-server"), ["pi"]);
        assert!(foreign_aliases(&(legacy_srv(me) + &old_pi), &["pi".into()], me, "telepy-ssh-server").is_empty());
        assert!(foreign_aliases(&old_pi, &["pi".into()], me, "telepy-ssh-server").is_empty());
        // 手寫的同名 Host → 提醒（不擋）/ A hand-written Host of the same name → a warning only
        let out = install_checked("Host nas nas.local\n    User me\n", &[server, dev("nas", me)], me, "telepy-ssh-server");
        assert_eq!((out.kept.len(), out.shadowed.as_slice()), (0, ["nas".to_string()].as_slice()));
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
