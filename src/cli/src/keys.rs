//! 這台電腦的 SSH 金鑰：ssh 實際會送哪幾把（`ssh -G` 的 IdentityFile + agent 裡的）、它們的 SHA256 指紋，以及
//! Telepy 的 ssh 檢查（`POST /api/reverse/server/{id}/ssh-check`）回答的每一關要怎麼說給人聽。
//! 為什麼要有：`telepy ssh` 把事情交給系統的 OpenSSH，金鑰不對時只剩一句 `Permission denied (publickey)`，看的人不知道
//! 是 Telepy 不認得這把金鑰、裝置的清單上沒有它、還是別的原因。這裡的純函式（指紋、`ssh -G` 解析、說明文字）都有單元測試；
//! 執行 `ssh -G` / `ssh-add -L` / `ssh-keygen` 的只有 [`offered`] 與 [`public_of`]。
//! This computer's SSH keys: which ones ssh really offers (`ssh -G`'s IdentityFile lines plus the agent's), their
//! SHA256 fingerprints, and how to put each answer of Telepy's ssh check into words. Why: `telepy ssh` hands over to
//! the system OpenSSH, and a key problem used to end in a bare `Permission denied (publickey)` that said nothing about
//! whether Telepy didn't know the key, the device's list lacked it, or something else. The pure parts (fingerprints,
//! parsing `ssh -G`, the wording) are unit-tested; only [`offered`] and [`public_of`] run ssh's tools.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine as _;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 一把這台電腦會送出的公鑰。/ One public key this computer offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalKey {
    /// `SHA256:…`（與 `ssh-keygen -lf` 相同）。/ As `ssh-keygen -lf` prints it.
    pub fingerprint: String,
    /// `<type> <base64> [comment]`，去掉頭尾空白。/ The public key line, trimmed.
    pub line: String,
    /// IdentityFile（agent 裡的 = None）。/ The IdentityFile (None for agent keys).
    pub path: Option<PathBuf>,
}

/// ssh 會送出的金鑰，加上讀不到公鑰的私鑰檔（有密碼又沒有 `.pub`：說不準它是不是登記過的那把）。
/// The keys ssh offers, plus private key files whose public half couldn't be read (passphrase, no `.pub`).
#[derive(Debug, Clone, Default)]
pub struct Offered {
    pub keys: Vec<LocalKey>,
    pub unreadable: Vec<PathBuf>,
}

impl Offered {
    pub fn fingerprints(&self) -> Vec<String> {
        self.keys.iter().map(|k| k.fingerprint.clone()).collect()
    }

    /// 送出的第一把有檔案的金鑰（要登記時預設用它）。/ The first offered key with a file (the default to register).
    pub fn first_file(&self) -> Option<&LocalKey> {
        self.keys.iter().find(|k| k.path.is_some())
    }

    pub fn find(&self, fingerprint: &str) -> Option<&LocalKey> {
        self.keys.iter().find(|k| k.fingerprint == fingerprint)
    }
}

/// 公鑰那一行的類型（第一欄），格式不對 = None。/ The key type (first field), None when the line isn't a public key.
pub fn key_type(line: &str) -> Option<&str> {
    let mut it = line.split_whitespace();
    let t = it.next()?;
    it.next()?;
    (t.starts_with("ssh-") || t.starts_with("ecdsa-sha2-") || t.starts_with("sk-")).then_some(t)
}

/// OpenSSH 的 SHA256 指紋：base64 那一欄解開、SHA-256、不補 `=` 的 base64。內容開頭必須是同一個類型名稱。
/// The OpenSSH SHA256 fingerprint: the base64 field decoded, hashed, re-encoded without padding. The blob must start
/// with the same type name.
pub fn fingerprint(line: &str) -> Option<String> {
    let t = key_type(line)?;
    let blob = base64::engine::general_purpose::STANDARD.decode(line.split_whitespace().nth(1)?).ok()?;
    let len = u32::from_be_bytes(blob.get(..4)?.try_into().ok()?) as usize;
    if blob.get(4..4 + len)? != t.as_bytes() {
        return None;
    }
    Some(format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(&blob))))
}

/// `ssh -G` 的輸出裡跟金鑰有關的：IdentityFile（照順序）、IdentitiesOnly、IdentityAgent。
/// What `ssh -G` says about keys: the IdentityFile lines in order, IdentitiesOnly and IdentityAgent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SshG {
    pub identity_files: Vec<String>,
    pub identities_only: bool,
    pub identity_agent: Option<String>,
}

pub fn parse_ssh_g(text: &str) -> SshG {
    let mut g = SshG::default();
    for line in text.lines() {
        let Some((k, v)) = line.trim().split_once(' ') else { continue };
        match k.to_ascii_lowercase().as_str() {
            "identityfile" => g.identity_files.push(v.trim().to_string()),
            "identitiesonly" => g.identities_only = v.trim().eq_ignore_ascii_case("yes"),
            "identityagent" => g.identity_agent = Some(v.trim().to_string()),
            _ => {}
        }
    }
    g
}

/// `~` 與 `%d`（家目錄）、`%%`；其他 token 不認得就照原樣（找不到檔就略過）。家目錄是 `$HOME`；ssh 自己用帳號的家目錄，
/// 平常兩者相同（測試把 HOME 指到暫存目錄時不同，所以測試明寫 `-i`）。
/// Expand `~`, `%d` (home) and `%%`; other tokens stay as they are (the file then isn't found and is skipped). Home is
/// `$HOME`; ssh itself uses the account's home, normally the same place (tests point HOME elsewhere, hence their `-i`).
pub fn expand_path(raw: &str, home: &Path) -> PathBuf {
    let home_s = home.to_string_lossy();
    let s = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        format!("{home_s}/{rest}")
    } else if raw == "~" {
        home_s.to_string()
    } else {
        raw.to_string()
    };
    PathBuf::from(s.replace("%d", &home_s).replace("%%", "%"))
}

/// 給人看的路徑：家目錄寫成 `~`。/ A path for people: the home directory as `~`.
pub fn display_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", rest.to_string_lossy().replace('\\', "/")),
        _ => path.display().to_string(),
    }
}

/// `ssh-add -L` 的公鑰行（「沒有金鑰」的說明句子不算）。/ Public key lines from `ssh-add -L` (not its "no identities" text).
pub fn agent_lines(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|l| fingerprint(l).is_some()).map(str::to_string).collect()
}

/// 主機名稱 → 金鑰名稱的底：去掉網域與 `.local`，留英數 `.-_`，最多 40 個字。
/// A host name → the base of a key name: no domain / `.local`, letters, digits and `.-_` only, at most 40.
pub fn name_base(hostname: &str) -> String {
    let short = hostname.trim().split('.').next().unwrap_or("");
    let clean: String = short.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).take(40).collect();
    if clean.is_empty() {
        "telepy-cli".to_string()
    } else {
        clean
    }
}

/// 不跟已有的金鑰名稱撞（不分大小寫）：`base`、`base-2`、`base-3`…。/ A name none of the existing ones has (ignoring case).
pub fn unique_name(base: &str, taken: &[String]) -> String {
    let free = |n: &str| !taken.iter().any(|t| t.eq_ignore_ascii_case(n));
    if free(base) {
        return base.to_string();
    }
    (2..).map(|i| format!("{base}-{i}")).find(|n| free(n)).unwrap_or_default()
}

/// 網頁「新增金鑰」視窗的網址（公鑰、名稱先填好；`from=cli` 讓網頁說是誰要加的）。
/// The web's add-key dialog with the key and name filled in (`from=cli` lets the page say who asked).
pub fn add_url(server: &str, line: &str, name: &str) -> String {
    format!("{}/tunnels/keys?add={}&name={}&from=cli", server.trim_end_matches('/'), urlencoding::encode(line), urlencoding::encode(name))
}

/// 這台裝置的金鑰面板（網頁）。/ The device's key panel in the web.
pub fn device_url(server: &str, tunnel_id: i64) -> String {
    format!("{}/tunnels/keys/devices?device={tunnel_id}", server.trim_end_matches('/'))
}

/// 隧道頁，順便請網頁確認身分（step-up）。/ The tunnel page, asking the web to confirm it's you (step-up).
pub fn step_up_url(server: &str, tunnel_id: i64) -> String {
    format!("{}/tunnels/{tunnel_id}?stepUp=1", server.trim_end_matches('/'))
}

/// 說明的語氣：擋住了 / 可能會擋 / 等一下。/ The tone of an explanation: blocked / may be refused / waiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Bad,
    Warn,
}

/// 一個問題的說明：第一行是發生什麼事，之後是細節與怎麼修。/ One problem in words: what happens, then details and the fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Explained {
    pub tone: Tone,
    pub lines: Vec<String>,
}

/// 說明要用到的事。/ What the wording needs.
pub struct Ctx<'a> {
    pub server: &'a str,
    pub tunnel: &'a str,
    pub tunnel_id: i64,
    pub account: &'a str,
    pub home: &'a Path,
}

fn key_label(k: &Value) -> String {
    format!("\"{}\" ({})", k["name"].as_str().unwrap_or("?"), k["fingerprint"].as_str().unwrap_or("?"))
}

/// 這台電腦送出的金鑰，一行一把（最多 4 把，其餘算數量）。/ The offered keys, one per line (4 at most, then a count).
fn offered_lines(offered: &Offered, home: &Path) -> Vec<String> {
    let mut out: Vec<String> = offered
        .keys
        .iter()
        .take(4)
        .map(|k| match &k.path {
            Some(p) => format!("    {}  {}", display_path(p, home), k.fingerprint),
            None => format!("    (ssh agent)  {}", k.fingerprint),
        })
        .collect();
    if offered.keys.len() > 4 {
        out.push(format!("    … and {} more", offered.keys.len() - 4));
    }
    out
}

/// 一個問題 → 說明。`check` = 伺服器的回答。不認得的問題（較新的伺服器）= None。
/// One problem → its explanation; `check` is the server's answer. An unknown problem (a newer server) = None.
pub fn explain(problem: &str, check: &Value, offered: &Offered, c: &Ctx) -> Option<Explained> {
    let dev_key = &check["device"]["key"];
    let (t, a) = (c.tunnel, c.account);
    let e = |tone, lines: Vec<String>| Some(Explained { tone, lines });
    match problem {
        "keys_off" => e(Tone::Bad, vec![
            "Personal SSH keys are turned off for your account, so Telepy's gateway refuses every key you offer.".into(),
            "  Ask a Telepy admin to turn them back on (Admin → Users & access → Feature access).".into(),
        ]),
        "no_key" if offered.keys.is_empty() && offered.unreadable.is_empty() => e(Tone::Bad, vec![
            "This computer has no SSH key, and Telepy only lets ssh in with a key you registered.".into(),
            "  Fix: telepy keys add   (creates ~/.ssh/id_ed25519 with ssh-keygen, then adds it in your browser)".into(),
        ]),
        "no_key" => {
            let mut lines = vec!["Telepy doesn't know any SSH key this computer offers, so its gateway will refuse ssh (\"Permission denied (publickey)\").".to_string()];
            if !offered.keys.is_empty() {
                lines.push("  This computer offers:".into());
                lines.extend(offered_lines(offered, c.home));
            }
            for p in &offered.unreadable {
                lines.push(format!("  Couldn't read the public half of {} (no .pub next to it); if that one is registered, run with --no-check.", display_path(p, c.home)));
            }
            let registered = check["registered"].as_i64().unwrap_or(0);
            lines.push(if registered == 0 { "  You haven't added any key to Telepy yet.".into() } else { format!("  The {registered} key(s) you added to Telepy belong to other computers.") });
            lines.push(match offered.first_file().and_then(|k| k.path.as_ref()) {
                Some(p) => format!("  Fix: telepy keys add   (adds {}.pub in your browser)", display_path(p, c.home)),
                None => "  Fix: telepy keys add".into(),
            });
            e(Tone::Bad, lines)
        }
        "key_expired" => {
            let k = check["matched"].as_array().and_then(|m| m.iter().find(|k| k["expired"] == true)).cloned().unwrap_or(Value::Null);
            let when = k["expires_at"].as_str().map(|s| s.get(..10).unwrap_or(s).to_string()).unwrap_or_default();
            e(Tone::Bad, vec![
                format!("Your key {} expired on {when}; Telepy's gateway refuses expired keys.", key_label(&k)),
                format!("  Renew it on the Keys page: {}/tunnels/keys", c.server.trim_end_matches('/')),
            ])
        }
        "no_access" => e(Tone::Bad, vec![
            format!("You may not use any account on {t}, so Telepy won't open a path to it."),
            format!("  Ask its owner to allow an account (the web app's Request access on {}/tunnels/{}).", c.server.trim_end_matches('/'), c.tunnel_id),
        ]),
        "account_not_allowed" => e(Tone::Bad, vec![format!("'{a}' is not an account you may use on {t}.")]),
        "step_up" => e(Tone::Bad, vec![
            format!("{t} asks you to confirm it's you in the Telepy web app first (step-up); until then the gateway refuses ssh."),
            format!("  Confirm at {}, then run this again within 15 minutes.", step_up_url(c.server, c.tunnel_id)),
        ]),
        "offline" => e(Tone::Bad, vec![
            format!("{t} is offline right now, so there is nothing to connect to (telepy status {t})."),
            "  Run with --no-check to try anyway.".into(),
        ]),
        "not_on_device" => e(Tone::Bad, vec![
            format!("{t} won't let your key {} in as {a}: it isn't on {t}'s key list for {a}, and that account's authorized_keys doesn't have it.", key_label(dev_key)),
            format!("  Fix: telepy keys check {t}@{a} --yes   (puts it on the list; Telepy installs it within seconds)"),
        ]),
        "not_listed" => e(Tone::Warn, vec![
            format!("Telepy hasn't put your key {} on {t} for {a} (it isn't on the device's key list).", key_label(dev_key)),
            format!("  Unless it was added there another way, {t} will refuse it. Fix: telepy keys check {t}@{a} --yes"),
        ]),
        "pending" => e(Tone::Warn, vec![format!("Your key {} is on {t}'s key list but not installed for {a} yet.", key_label(dev_key))]),
        "sync_error" => e(Tone::Warn, vec![
            format!("Telepy couldn't install your key {} for {a} on {t}: {}", key_label(dev_key), check["device"]["error"].as_str().unwrap_or("unknown error")),
            format!("  ssh will probably be refused; see {}", device_url(c.server, c.tunnel_id)),
        ]),
        _ => None,
    }
}

/// 檢查的答案能不能確定 ssh 會失敗（這時就不交給 OpenSSH，免得多一句看不懂的錯誤）。
/// `not_listed` 不確定（可能用別的方式加過）；`no_key` 在有讀不到的私鑰時也不確定。
/// Whether the answer means ssh will certainly fail (then OpenSSH isn't started for another cryptic error).
/// `not_listed` is uncertain (it may have been added another way); so is `no_key` when a private key couldn't be read.
pub fn certain(problem: &str, offered: &Offered) -> bool {
    match problem {
        "no_key" => offered.unreadable.is_empty(),
        "keys_off" | "key_expired" | "no_access" | "account_not_allowed" | "step_up" | "offline" | "not_on_device" => true,
        _ => false,
    }
}

// ---------------------------------------------------------------- running ssh's tools

/// ssh 連 `alias` 時會送的金鑰（照 `-F config` 與額外的選項）。找不到 ssh 就是空的。
/// The keys ssh offers when connecting to `alias` with `-F config` and the extra options; empty without ssh.
pub fn offered(config: &Path, alias: &str, extra: &[String], home: &Path) -> Offered {
    let out = Command::new("ssh").arg("-G").arg("-F").arg(config).args(extra).arg(alias).stdin(Stdio::null()).stderr(Stdio::null()).output();
    let Some(out) = out.ok().filter(|o| o.status.success()) else { return Offered::default() };
    let g = parse_ssh_g(&String::from_utf8_lossy(&out.stdout));
    let mut result = Offered::default();
    let push = |k: LocalKey, keys: &mut Vec<LocalKey>| {
        if !keys.iter().any(|x| x.fingerprint == k.fingerprint) {
            keys.push(k);
        }
    };
    // 檔案。/ The identity files.
    let mut files = Vec::new();
    for raw in &g.identity_files {
        let path = expand_path(raw, home);
        if !path.is_file() {
            continue;
        }
        match public_of(&path) {
            Some(line) => files.push(LocalKey { fingerprint: fingerprint(&line).unwrap_or_default(), line, path: Some(path) }),
            None => result.unreadable.push(path),
        }
    }
    // agent：ssh 先送 agent 裡的；IdentitiesOnly 時只送跟檔案相同的那幾把（那就已經在檔案裡了）。
    // The agent: ssh offers its keys first; with IdentitiesOnly only those matching a file (already listed).
    let agent_sock = match g.identity_agent.as_deref() {
        Some(a) if a.eq_ignore_ascii_case("none") => None,
        Some(a) if a != "SSH_AUTH_SOCK" && !a.starts_with('$') => Some(expand_path(a, home).to_string_lossy().to_string()),
        _ => std::env::var("SSH_AUTH_SOCK").ok().filter(|s| !s.is_empty()),
    };
    if !g.identities_only && (agent_sock.is_some() || cfg!(windows)) {
        let mut cmd = Command::new("ssh-add");
        cmd.arg("-L").stdin(Stdio::null()).stderr(Stdio::null());
        if let Some(sock) = &agent_sock {
            cmd.env("SSH_AUTH_SOCK", sock);
        }
        if let Ok(o) = cmd.output() {
            for line in agent_lines(&String::from_utf8_lossy(&o.stdout)) {
                let fp = fingerprint(&line).unwrap_or_default();
                // 有檔案的那把就記檔案（要登記時才找得到 .pub）。/ Keep the file for a key that has one.
                let k = files.iter().find(|f| f.fingerprint == fp).cloned().unwrap_or(LocalKey { fingerprint: fp, line, path: None });
                push(k, &mut result.keys);
            }
        }
    }
    for k in files {
        push(k, &mut result.keys);
    }
    result
}

/// 沒有特定主機時 ssh 會送的金鑰（預設的 IdentityFile + agent）：給 `keys ls`、`keys add`、`doctor`。
/// What ssh offers with no particular host (the default identity files + the agent), for `keys ls/add` and `doctor`.
pub fn offered_by_default(scratch: &Path, home: &Path) -> Offered {
    let empty = scratch.join("empty.conf");
    if !empty.exists() {
        let _ = std::fs::create_dir_all(scratch);
        let _ = std::fs::write(&empty, "");
    }
    offered(&empty, "telepy-keys", &[], home)
}

/// 一把私鑰（或公鑰檔）的公鑰行：先看旁邊的 `.pub`，再試 `ssh-keygen -y`（不問密碼；有密碼的就讀不到）。
/// The public line of a key file: its `.pub` first, then `ssh-keygen -y` without a passphrase prompt.
pub fn public_of(path: &Path) -> Option<String> {
    let text = |p: &Path| std::fs::read_to_string(p).ok().map(|t| t.trim().to_string()).filter(|l| fingerprint(l).is_some());
    if path.extension().is_some_and(|e| e == "pub") {
        return text(path);
    }
    let mut pubfile = path.as_os_str().to_owned();
    pubfile.push(".pub");
    if let Some(l) = text(Path::new(&pubfile)) {
        return Some(l);
    }
    let out = Command::new("ssh-keygen").args(["-y", "-P", ""]).arg("-f").arg(path).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && fingerprint(&line).is_some()).then_some(line)
}

/// 這台電腦的名稱（`hostname`）。/ This computer's name.
pub fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| Command::new("hostname").stdin(Stdio::null()).stderr(Stdio::null()).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // `ssh-keygen -lf` 對這把的答案。/ What `ssh-keygen -lf` says for this key.
    const ED: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP9okCJLGxc8/j1w3aE8G8wpr4HPc58yJqSSkyHATPgP alice@laptop";
    const ED_FP: &str = "SHA256:XrAviYRuym9sxS6l8fdPR+9txtD69RctrPT1vHi+5YY";

    #[test]
    fn fingerprints_match_ssh_keygen() {
        assert_eq!(fingerprint(ED).as_deref(), Some(ED_FP));
        assert_eq!(fingerprint(&format!("  {ED}  ")).as_deref(), Some(ED_FP), "surrounding blanks");
        assert_eq!(fingerprint("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP9okCJLGxc8/j1w3aE8G8wpr4HPc58yJqSSkyHATPgP").as_deref(), Some(ED_FP), "no comment");
        // 類型對不上內容、不是 base64、不是公鑰。/ Type doesn't match the blob, not base64, not a key.
        assert_eq!(fingerprint("ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIP9okCJLGxc8/j1w3aE8G8wpr4HPc58yJqSSkyHATPgP"), None);
        assert_eq!(fingerprint("ssh-ed25519 !!!"), None);
        assert_eq!(fingerprint("-----BEGIN OPENSSH PRIVATE KEY-----"), None);
        assert_eq!(fingerprint(""), None);
        assert_eq!(key_type(ED), Some("ssh-ed25519"));
        assert_eq!(key_type("ssh-ed25519"), None);
    }

    #[test]
    fn reads_ssh_g() {
        let g = parse_ssh_g("user pi\nidentitiesonly no\nidentityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ed25519\nidentityagent none\n");
        assert_eq!(g.identity_files, ["~/.ssh/id_rsa", "~/.ssh/id_ed25519"]);
        assert!(!g.identities_only);
        assert_eq!(g.identity_agent.as_deref(), Some("none"));
        assert!(parse_ssh_g("IdentitiesOnly yes").identities_only);
        assert!(parse_ssh_g("").identity_files.is_empty());
    }

    #[test]
    fn paths() {
        let home = Path::new("/home/al");
        assert_eq!(expand_path("~/.ssh/id_rsa", home), PathBuf::from("/home/al/.ssh/id_rsa"));
        assert_eq!(expand_path("%d/.ssh/k", home), PathBuf::from("/home/al/.ssh/k"));
        assert_eq!(expand_path("/etc/k%%1", home), PathBuf::from("/etc/k%1"));
        assert_eq!(display_path(Path::new("/home/al/.ssh/id_rsa"), home), "~/.ssh/id_rsa");
        assert_eq!(display_path(Path::new("/opt/k"), home), "/opt/k");
    }

    #[test]
    fn agent_output() {
        assert!(agent_lines("The agent has no identities.\n").is_empty());
        assert_eq!(agent_lines(&format!("{ED}\nnot a key\n")), [ED]);
    }

    #[test]
    fn names() {
        assert_eq!(name_base("Alices-MacBook-Pro.local"), "Alices-MacBook-Pro");
        assert_eq!(name_base("box.example.com"), "box");
        assert_eq!(name_base("??"), "telepy-cli");
        assert_eq!(name_base(&"x".repeat(80)).len(), 40);
        let taken = vec!["laptop".to_string(), "Laptop-2".to_string()];
        assert_eq!(unique_name("laptop", &taken), "laptop-3");
        assert_eq!(unique_name("desk", &taken), "desk");
    }

    #[test]
    fn urls() {
        let u = add_url("https://t.example/", ED, "my laptop");
        assert!(u.starts_with("https://t.example/tunnels/keys?add=ssh-ed25519%20AAAA"), "{u}");
        assert!(u.ends_with("&name=my%20laptop&from=cli"), "{u}");
        assert!(!u.contains('+') || u.contains("%2B"), "a + in base64 must be escaped: {u}");
        assert_eq!(device_url("https://t.example", 4), "https://t.example/tunnels/keys/devices?device=4");
        assert_eq!(step_up_url("https://t.example", 4), "https://t.example/tunnels/4?stepUp=1");
    }

    fn ctx(home: &Path) -> Ctx<'_> {
        Ctx { server: "https://t.example", tunnel: "box", tunnel_id: 4, account: "pi", home }
    }

    #[test]
    fn the_wording_names_the_hop_and_the_fix() {
        let home = Path::new("/home/al");
        let key = LocalKey { fingerprint: ED_FP.into(), line: ED.into(), path: Some(home.join(".ssh/id_ed25519")) };
        let offered = Offered { keys: vec![key], unreadable: vec![] };
        let none = Offered::default();
        let check = json!({"registered": 0, "matched": [], "device": {"key": null}});
        let x = explain("no_key", &check, &offered, &ctx(home)).unwrap();
        assert_eq!(x.tone, Tone::Bad);
        let text = x.lines.join("\n");
        assert!(text.contains("Permission denied (publickey)") && text.contains(ED_FP) && text.contains("~/.ssh/id_ed25519"), "{text}");
        assert!(text.contains("haven't added any key") && text.contains("telepy keys add   (adds ~/.ssh/id_ed25519.pub"), "{text}");
        let other = explain("no_key", &json!({"registered": 2}), &offered, &ctx(home)).unwrap().lines.join("\n");
        assert!(other.contains("The 2 key(s) you added to Telepy belong to other computers"), "{other}");
        let bare = explain("no_key", &check, &none, &ctx(home)).unwrap().lines.join("\n");
        assert!(bare.contains("has no SSH key") && bare.contains("ssh-keygen"), "{bare}");
        let locked = Offered { keys: vec![], unreadable: vec![home.join(".ssh/id_rsa")] };
        let l = explain("no_key", &check, &locked, &ctx(home)).unwrap().lines.join("\n");
        assert!(l.contains("~/.ssh/id_rsa") && l.contains("--no-check"), "{l}");

        let dev = json!({"device": {"key": {"name": "laptop", "fingerprint": ED_FP}, "error": "permission denied"}});
        let n = explain("not_on_device", &dev, &offered, &ctx(home)).unwrap();
        assert!(n.lines[0].contains("box won't let your key \"laptop\"") && n.lines[1].contains("telepy keys check box@pi --yes"), "{n:?}");
        assert_eq!(explain("not_listed", &dev, &offered, &ctx(home)).unwrap().tone, Tone::Warn);
        assert!(explain("sync_error", &dev, &offered, &ctx(home)).unwrap().lines[0].ends_with(": permission denied"));
        let exp = json!({"matched": [{"name": "old", "fingerprint": ED_FP, "expired": true, "expires_at": "2026-10-01T23:59:59+08:00"}]});
        assert!(explain("key_expired", &exp, &offered, &ctx(home)).unwrap().lines[0].contains("\"old\" (SHA256:") );
        assert!(explain("key_expired", &exp, &offered, &ctx(home)).unwrap().lines[0].contains("on 2026-10-01"));
        assert!(explain("step_up", &dev, &offered, &ctx(home)).unwrap().lines[1].contains("/tunnels/4?stepUp=1"));
        assert_eq!(explain("something_new", &dev, &offered, &ctx(home)), None);
    }

    #[test]
    fn which_answers_are_certain() {
        let offered = Offered::default();
        assert!(certain("no_key", &offered) && certain("not_on_device", &offered) && certain("offline", &offered));
        assert!(!certain("not_listed", &offered) && !certain("pending", &offered) && !certain("sync_error", &offered));
        let locked = Offered { keys: vec![], unreadable: vec![PathBuf::from("/k")] };
        assert!(!certain("no_key", &locked), "a key we couldn't read may be the registered one");
    }
}
