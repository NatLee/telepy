//! 這個帳號的 authorized_keys 是哪個檔——問伺服器、看證據、必要時登入試一次，不靠「哪個發行版、哪款機器」猜。
//!
//! 1. 候選檔：伺服器自己說的（OpenSSH 的 `sshd -T` 的 AuthorizedKeysFile，root 才問得到），再加上已知會被讀的位置
//!    （[`KNOWN_FILES`]：`~/.ssh/authorized_keys`、`~/.ssh/authorized_keys2`、`/etc/dropbear/authorized_keys`）。
//!    已知位置只是候選名單，不是規則：哪一個算數由下面決定。
//! 2. 證據：Telepy 剛用它的服務金鑰登入成功，所以**放著那把金鑰的檔案**就是伺服器在讀的。只有一個 = 就是它。
//! 3. 好幾個都有（例如有人手動多放了一份，或舊版 Telepy 在 SFTP 模式把金鑰寫進伺服器不讀的 `~/.ssh`）：在每個候選檔
//!    暫時放一把臨時金鑰、經隧道用它登入一次，能登入的就是伺服器讀的檔（臨時那行立刻拿掉）。這會短暫寫檔，所以只在
//!    寫入路徑（呼叫者已拿著這台裝置的鎖）做；唯讀路徑先用第一個候選、不記住。
//! 4. 都沒有（Telepy 不是靠檔案裡的金鑰登入的，例如 AuthorizedKeysCommand）：伺服器說的第一個，否則 `~/.ssh/authorized_keys`。
//!
//! Which file holds this account's authorized keys — asked of the server, decided by evidence, tested by a login when
//! needed; never guessed from the distribution or the model.
//! 1. Candidates: what the server says (OpenSSH's `sshd -T` AuthorizedKeysFile, answered for root), then locations
//!    known to be read ([`KNOWN_FILES`]). Known locations are only candidates, not rules.
//! 2. Evidence: Telepy just logged in with its service key, so the file holding that key is the one the server reads.
//! 3. Several hold it: a throwaway key goes into each candidate in turn and logs in through the tunnel; the one that
//!    works is the file the server reads (the line is removed at once). This writes briefly, so only on the write
//!    path (the caller holds the device's lock); the read path takes the first holder and does not remember it.
//! 4. None holds it: the server's first file, else `~/.ssh/authorized_keys`.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use russh::keys::{Algorithm, PrivateKey};

use crate::ssh::exec;
use crate::state::AppState;
use crate::tunnel_service::sh_quote;

/// 已知會被讀的位置（`~` = 帳號的家目錄）。只是候選。/ Locations known to be read (`~` = the account's home). Candidates only.
pub const KNOWN_FILES: &[&str] = &["~/.ssh/authorized_keys", "~/.ssh/authorized_keys2", "/etc/dropbear/authorized_keys"];
/// 臨時金鑰那行的註解前綴（找殘留用）。/ The throwaway line's comment prefix (to find leftovers).
pub const PROBE_MARK: &str = "telepy-locate-";
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: usize = 64 * 1024;

/// 一個候選檔。/ One candidate file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub path: String,
    pub exists: bool,
    /// 放著 Telepy 的服務金鑰。/ Holds one of Telepy's service keys.
    pub holds: bool,
    /// 伺服器自己說的（`sshd -T`）。/ Named by the server itself.
    pub from_server: bool,
}

/// 決定。/ The decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    /// 證據唯一。/ The evidence points at one file.
    Held(String),
    /// 好幾個檔都有 Telepy 的金鑰：要登入試。/ Several hold Telepy's key: a login decides.
    Ambiguous(Vec<String>),
    /// 沒有證據：伺服器說的第一個，否則預設。/ No evidence: the server's first file, else the default.
    Fallback(String),
}

/// 找候選檔的腳本（POSIX / BusyBox）：每個候選一行 `CAND <server|known> <exists> <holds> <path>`。
/// `blobs` 是 Telepy 服務金鑰的 base64（只有 base64 字元）。
/// The locator script: one `CAND <server|known> <exists> <holds> <path>` line per candidate. `blobs` are the base64
/// parts of Telepy's service keys.
pub fn script(blobs: &[String]) -> String {
    let blobs: Vec<String> = blobs.iter().filter(|b| !b.is_empty() && b.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))).map(|b| format!("'{b}'")).collect();
    let blobs = if blobs.is_empty() { "''".to_string() } else { blobs.join(" ") };
    let known: Vec<String> = KNOWN_FILES.iter().map(|f| match f.strip_prefix("~/") {
        Some(rest) => format!("check known \"$d/{rest}\""),
        None => format!("check known '{f}'"),
    }).collect();
    format!(
        r#"d=${{HOME:-}}; [ -n "$d" ] || d=$(cd ~ 2>/dev/null && pwd); u=$(id -un 2>/dev/null || whoami 2>/dev/null)
check() {{ e=0; h=0; if [ -f "$2" ]; then e=1; for b in {blobs}; do [ -n "$b" ] && grep -qF "$b" "$2" 2>/dev/null && h=1; done; fi; printf 'CAND %s %s %s %s\n' "$1" "$e" "$h" "$2"; }}
a=""; for s in sshd /usr/sbin/sshd; do a=$("$s" -T -C "user=$u,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '$1 == "authorizedkeysfile" {{ for (i = 2; i <= NF; i++) print $i; exit }}'); [ -n "$a" ] && break; done
for f in $a; do f=$(printf '%s' "$f" | sed "s|%h|$d|g; s|%u|$u|g; s|%%|%|g"); case "$f" in /*) ;; *) f="$d/$f" ;; esac; check server "$f"; done
{}
"#,
        known.join("\n")
    )
}

/// 腳本輸出 → 候選檔（同一個路徑只留第一次出現的；只收絕對路徑）。/ The script's output → candidates (first
/// occurrence of a path wins; absolute paths only).
pub fn parse(out: &str) -> Vec<Candidate> {
    let mut seen: Vec<Candidate> = vec![];
    for line in out.lines() {
        let mut w = line.trim_end().splitn(5, ' ');
        let (Some("CAND"), Some(src), Some(e), Some(h), Some(path)) = (w.next(), w.next(), w.next(), w.next(), w.next()) else { continue };
        if !path.starts_with('/') || seen.iter().any(|c| c.path == path) {
            continue;
        }
        seen.push(Candidate { path: path.to_string(), exists: e == "1", holds: h == "1", from_server: src == "server" });
    }
    seen
}

/// 證據 → 決定（純函式）。沒有任何候選 = None。/ Evidence → decision (pure). No candidate at all = None.
pub fn choose(cands: &[Candidate]) -> Option<Choice> {
    let holders: Vec<String> = cands.iter().filter(|c| c.holds).map(|c| c.path.clone()).collect();
    match holders.len() {
        1 => holders.into_iter().next().map(Choice::Held),
        0 => cands.iter().find(|c| c.from_server).or_else(|| cands.first()).map(|c| Choice::Fallback(c.path.clone())),
        _ => Some(Choice::Ambiguous(holders)),
    }
}

/// 在 `path` 尾端加一行（檔案最後沒換行就先補）。/ Append one line to `path` (adding the missing final newline first).
pub fn append_command(path: &str, line: &str) -> String {
    let (f, l) = (sh_quote(path), sh_quote(line));
    format!("f={f}; [ -f \"$f\" ] || exit 1; [ -z \"$(tail -c 1 \"$f\")\" ] || echo >> \"$f\"; printf '%s\\n' {l} >> \"$f\"")
}

/// 拿掉含 `mark` 的行，原地改寫（`cat >`：權限、擁有者、inode 都不變）。暫存檔要剛好少那幾行才寫回，否則什麼都不動。
/// Remove the lines containing `mark` in place (`cat >` keeps mode, owner and inode). The temp copy is written back only
/// when it is exactly those lines shorter; otherwise nothing changes.
pub fn remove_command(path: &str, mark: &str) -> String {
    let (f, m) = (sh_quote(path), sh_quote(mark));
    format!(
        "f={f}; m={m}; [ -f \"$f\" ] || exit 0; n=$(grep -cF \"$m\" \"$f\"); [ \"$n\" -gt 0 ] || exit 0; t=\"$f.telepy-locate\"; \
         grep -vF \"$m\" \"$f\" > \"$t\"; if [ \"$(wc -l < \"$t\")\" -eq \"$(( $(wc -l < \"$f\") - n ))\" ] && ! grep -qF \"$m\" \"$t\"; then cat \"$t\" > \"$f\"; rm -f \"$t\"; else rm -f \"$t\"; exit 1; fi"
    )
}

/// 在裝置上跑一道指令（向連線池借 channel）。/ Run one command on the device (a channel from the pool).
async fn run(state: &AppState, reverse_port: i64, username: &str, command: &str) -> anyhow::Result<(Option<u32>, String)> {
    let (_lease, channel) = state.pool.session_channel(state, reverse_port, username).await?;
    let r = exec::run_on(channel, command, EXEC_TIMEOUT, OUTPUT_LIMIT).await?;
    if r.timed_out {
        anyhow::bail!("the device did not answer in time");
    }
    Ok((r.exit_code, r.stdout.text))
}

/// 找出候選檔與證據。/ The candidates and their evidence.
pub async fn candidates(state: &AppState, tunnel_id: i64, reverse_port: i64, username: &str) -> anyhow::Result<Vec<Candidate>> {
    let blobs: Vec<String> = super::service_bares(state, tunnel_id).await?.iter().filter_map(|b| b.split_whitespace().nth(1).map(str::to_string)).collect();
    let (code, out) = run(state, reverse_port, username, &format!("sh -c {}", sh_quote(&script(&blobs)))).await?;
    let cands = parse(&out);
    if cands.is_empty() {
        anyhow::bail!("could not list the authorized_keys candidates (exit {code:?})");
    }
    Ok(cands)
}

/// 好幾個檔都有 Telepy 的金鑰：依序在每個檔暫時放一把臨時金鑰登入看看，回傳伺服器讀的那個（都不行 = None）。
/// 呼叫者必須拿著這台裝置的鎖（會短暫寫檔）。/ Several files hold Telepy's key: try a throwaway key in each, in order,
/// and return the one the server reads (None if none works). The caller must hold the device's lock (it writes briefly).
pub async fn probe(state: &AppState, reverse_port: i64, username: &str, holders: &[String]) -> anyhow::Result<Option<String>> {
    let key = Arc::new(PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).map_err(|e| anyhow::anyhow!("generate a throwaway key: {e}"))?);
    let mark = format!("{PROBE_MARK}{}", crate::util::random_alnum(10).to_ascii_lowercase());
    let public = key.public_key().to_openssh().context("encode the throwaway key")?;
    let line = format!("{} {mark}", public.split_whitespace().take(2).collect::<Vec<_>>().join(" "));
    for path in holders {
        // 先清掉以前沒清完的臨時行。/ Leftovers of an earlier, interrupted run first.
        let _ = run(state, reverse_port, username, &remove_command(path, PROBE_MARK)).await;
        let (code, _) = run(state, reverse_port, username, &append_command(path, &line)).await?;
        if code != Some(0) {
            continue;
        }
        let accepted = crate::ssh::device::accepts_key(state, username, reverse_port, &key).await;
        let (removed, _) = run(state, reverse_port, username, &remove_command(path, &mark)).await?;
        if removed != Some(0) {
            anyhow::bail!("could not remove the throwaway key from {path}; remove the line ending in {mark} by hand");
        }
        if accepted? {
            return Ok(Some(path.clone()));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(path: &str, exists: bool, holds: bool, from_server: bool) -> Candidate {
        Candidate { path: path.into(), exists, holds, from_server }
    }

    #[test]
    fn the_evidence_decides_not_the_distribution() {
        // 只有一個檔放著 Telepy 的金鑰：就是它（路由器的 /etc/dropbear 也一樣，沒有發行版判斷）。
        // One file holds Telepy's key: that one (a router's /etc/dropbear too, no distribution check).
        let one = [c("/root/.ssh/authorized_keys", false, false, false), c("/etc/dropbear/authorized_keys", true, true, false)];
        assert_eq!(choose(&one), Some(Choice::Held("/etc/dropbear/authorized_keys".into())));
        // 兩個都有（GL-MT3000 的實際情形）：要登入試。/ Both hold it (the real GL-MT3000): a login decides.
        let two = [c("/root/.ssh/authorized_keys", true, true, false), c("/etc/dropbear/authorized_keys", true, true, false)];
        assert_eq!(choose(&two), Some(Choice::Ambiguous(vec!["/root/.ssh/authorized_keys".into(), "/etc/dropbear/authorized_keys".into()])));
        // 沒有證據：伺服器說的優先，否則第一個已知位置。/ No evidence: the server's file first, else the first known one.
        let server = [c("/etc/ssh/keys/alice", false, false, true), c("/home/alice/.ssh/authorized_keys", true, false, false)];
        assert_eq!(choose(&server), Some(Choice::Fallback("/etc/ssh/keys/alice".into())));
        assert_eq!(choose(&server[1..]), Some(Choice::Fallback("/home/alice/.ssh/authorized_keys".into())));
        assert_eq!(choose(&[]), None);
    }

    #[test]
    fn the_scripts_output_is_read_strictly() {
        let out = "CAND server 1 0 /home/a/.ssh/authorized_keys\nCAND known 1 0 /home/a/.ssh/authorized_keys\nCAND known 0 0 /home/a/.ssh/authorized_keys2\nCAND known 1 1 /etc/dropbear/authorized_keys\nCAND known 1 1 relative/x\nnoise\n";
        assert_eq!(
            parse(out),
            vec![c("/home/a/.ssh/authorized_keys", true, false, true), c("/home/a/.ssh/authorized_keys2", false, false, false), c("/etc/dropbear/authorized_keys", true, true, false)]
        );
        let s = script(&["AAAAC3Nz+/=".into(), "bad'quote".into()]);
        assert!(s.contains("for b in 'AAAAC3Nz+/='; do") && !s.contains("bad"), "only base64 is passed: {s}");
        assert!(s.contains("check known \"$d/.ssh/authorized_keys\"") && s.contains("check known '/etc/dropbear/authorized_keys'"), "{s}");
    }

    /// 真的 `sh` 跑腳本、加一行、拿掉那一行：權限與其他內容都不變，比對不上就不動。/ The real `sh`: list, append, remove.
    #[test]
    fn the_shell_parts_work_on_a_real_file() {
        let dir = std::env::temp_dir().join(format!("telepy-locate-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".ssh")).unwrap();
        let f = dir.join(".ssh/authorized_keys");
        std::fs::write(&f, "ssh-ed25519 AAAAOWN owner\nssh-ed25519 AAAATELEPY telepy-tunnel-1").unwrap(); // 最後沒換行 / no final newline
        let sh = |cmd: &str| std::process::Command::new("sh").arg("-c").arg(cmd).env("HOME", &dir).output().unwrap();
        let out = String::from_utf8(sh(&script(&["AAAATELEPY".into()])).stdout).unwrap();
        let found = parse(&out);
        assert!(found.iter().any(|c| c.path == f.to_string_lossy() && c.exists && c.holds), "{out}");
        let path = f.to_string_lossy().to_string();
        assert!(sh(&append_command(&path, "ssh-ed25519 AAAAPROBE telepy-locate-abc")).status.success());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "ssh-ed25519 AAAAOWN owner\nssh-ed25519 AAAATELEPY telepy-tunnel-1\nssh-ed25519 AAAAPROBE telepy-locate-abc\n");
        assert!(sh(&remove_command(&path, "telepy-locate-abc")).status.success());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "ssh-ed25519 AAAAOWN owner\nssh-ed25519 AAAATELEPY telepy-tunnel-1\n");
        // 沒有那一行 = 什麼都不做。/ No such line = nothing happens.
        assert!(sh(&remove_command(&path, "telepy-locate-zzz")).status.success());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "ssh-ed25519 AAAAOWN owner\nssh-ed25519 AAAATELEPY telepy-tunnel-1\n");
        assert!(!dir.join(".ssh/authorized_keys.telepy-locate").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
