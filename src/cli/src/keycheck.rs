//! `telepy ssh / scp / sftp / forward` 交給 OpenSSH 之前的金鑰檢查，與 `telepy keys add / check`。
//! 問 Telepy（`POST /api/reverse/server/{id}/ssh-check`）這台電腦送出的金鑰在每一關會怎樣，被擋就說是哪一關、為什麼、
//! 怎麼修；在終端機上順便問要不要現在修：
//! - Telepy 不認得這把金鑰 → 開瀏覽器到網頁的「新增金鑰」（公鑰已經填好，在網頁按下去；token 永遠不能登記金鑰），等它出現；
//!   這台電腦沒有金鑰就先用 `ssh-keygen` 做一把。
//! - 金鑰不在裝置的清單上 → 放上去（只到這個帳號，跟網頁「加我的金鑰」一樣），等 Telepy 裝好。
//! - 敏感通道（step-up）→ 開通道頁請你確認，等它確認。
//!
//! 沒有終端機時只說明；確定會失敗的就不交給 OpenSSH（免得多一句看不懂的錯誤），不確定的照樣連。伺服器太舊（沒有這個端點）
//! 就安靜跳過，跟以前一樣。
//!
//! The key check before `telepy ssh / scp / sftp / forward` hand over to OpenSSH, plus `telepy keys add / check`.
//! Telepy is asked what happens to the offered keys at each hop; a refusal is explained (which hop, why, the fix), and
//! in a terminal it offers to fix it now: register the key in the browser (the web's add dialog, prefilled; tokens can
//! never register keys), create one with `ssh-keygen` first when there is none, put the key on the device's list
//! (only this account) and wait for it to be installed, or confirm a step-up in the web. Without a terminal it only
//! explains; certain failures stop before OpenSSH, uncertain ones connect anyway. An older server (no endpoint) is
//! skipped quietly, as before.

use std::io::{IsTerminal, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use reqwest::Method;
use serde_json::{json, Value};

use crate::api::{Api, HttpError};
use crate::keys::{self, Ctx, Explained, Offered, Tone};
use crate::{color, creds, prefs};

/// 被擋下、說明已經印過：不再印 `telepy: …`，結束碼 1。/ Stopped with the explanation already printed: exit 1, no extra line.
#[derive(Debug)]
pub struct Stopped;

impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stopped")
    }
}

impl std::error::Error for Stopped {}

/// 要檢查的那一條：隧道與帳號。/ What is checked: the tunnel and the account.
pub struct Target<'a> {
    pub tunnel_id: i64,
    pub tunnel: &'a str,
    pub account: &'a str,
}

/// 能不能在終端機上問（標準輸入與標準錯誤都是終端機）。/ Whether we may ask (stdin and stderr are terminals).
pub fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

/// 問是 / 否（Enter = 是）。沒有終端機 = None。/ Ask yes / no (Enter = yes); None without a terminal.
pub fn ask(question: &str) -> Option<bool> {
    if !interactive() {
        return None;
    }
    eprint!("{question} [Y/n] ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).ok()?;
    Some(matches!(line.trim().to_ascii_lowercase().as_str(), "" | "y" | "yes"))
}

fn say(x: &Explained) {
    let mark = match x.tone {
        Tone::Bad => color::err(color::BAD, "✗"),
        Tone::Warn => color::err(color::WARN, "!"),
    };
    for (i, line) in x.lines.iter().enumerate() {
        if i == 0 {
            eprintln!("{mark} {line}");
        } else {
            eprintln!("{line}");
        }
    }
}

fn good(line: &str) {
    eprintln!("{} {line}", color::err(color::GOOD, "✓"));
}

fn waiting(line: &str) {
    eprintln!("{} {line}", color::err(color::DIM, "…"));
}

fn check(api: &Api, t: &Target, offered: &Offered) -> Result<Value> {
    api.json_timeout(Method::POST, &format!("/api/reverse/server/{}/ssh-check", t.tunnel_id), Some(&json!({ "account": t.account, "fingerprints": offered.fingerprints() })), Some(Duration::from_secs(15)))
}

fn problems(v: &Value) -> Vec<String> {
    v["problems"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// 每 `every` 問一次，直到 `done` 或逾時；回最後的答案（逾時 = None）。/ Ask every `every` until `done` or the deadline.
fn wait_check(api: &Api, t: &Target, offered: &Offered, limit: Duration, done: impl Fn(&Value) -> bool) -> Result<Option<Value>> {
    let start = Instant::now();
    while start.elapsed() < limit {
        std::thread::sleep(Duration::from_millis(1500));
        let v = check(api, t, offered)?;
        if done(&v) {
            return Ok(Some(v));
        }
    }
    Ok(None)
}

fn open(url: &str) {
    if std::env::var_os("TELEPY_NO_BROWSER").is_some() || !crate::oauth::open_browser(url) {
        eprintln!("  Open this in your browser: {url}");
    }
}

fn declined_key(t: &Target, fp: &str) -> String {
    format!("{}:{}:{fp}", t.tunnel_id, t.account)
}

/// `telepy ssh` 之前：Telepy 知道的部分都沒問題 = Ok；確定會失敗又沒修好 = [`Stopped`]（說明已印）。
/// Before `telepy ssh`: Ok when nothing Telepy knows of is in the way; [`Stopped`] (explained) on a certain failure.
pub fn before_ssh(api: &Api, t: &Target, config: &Path, alias: &str, extra: &[String]) -> Result<()> {
    if std::env::var_os("TELEPY_NO_KEY_CHECK").is_some() {
        return Ok(());
    }
    let home = creds::home_dir();
    let offered = keys::offered(config, alias, extra, &home);
    // 伺服器太舊、token 不能用這個端點、網路一時不通：照以前直接交給 OpenSSH。/ Older server etc.: hand over as before.
    let Ok(mut v) = check(api, t, &offered) else { return Ok(()) };
    let mut said: Vec<String> = Vec::new();
    for _round in 0..5 {
        if v["ready"] == true {
            return Ok(());
        }
        let probs = problems(&v);
        let ctx = Ctx { server: &api.server, tunnel: t.tunnel, tunnel_id: t.tunnel_id, account: t.account, home: &home };
        for p in &probs {
            if !said.contains(p) {
                if let Some(x) = keys::explain(p, &v, &offered, &ctx) {
                    say(&x);
                }
                said.push(p.clone());
            }
        }
        let Some(first) = probs.first().cloned() else { return Ok(()) };
        let fixed = match first.as_str() {
            "no_key" => offer_register(api, &offered)?,
            "step_up" => offer_step_up(api, t, &offered)?,
            "not_on_device" | "not_listed" => match offer_place(api, t, &offered, &v, false)? {
                Placed::Yes => true,
                // 不確定、使用者說不用：照樣連（下次不再問這台）。/ Uncertain and declined: connect anyway (not asked again).
                Placed::Declined if first == "not_listed" => return Ok(()),
                Placed::Declined | Placed::No => false,
                Placed::Skip => return Ok(()),
            },
            "pending" => {
                waiting(&format!("Waiting for Telepy to install it on {} (up to 30 s)…", t.tunnel));
                match wait_check(api, t, &offered, Duration::from_secs(30), |v| problems(v).iter().all(|p| p != "pending"))? {
                    Some(next) => {
                        v = next;
                        continue;
                    }
                    None => {
                        eprintln!("{} Still not installed; trying anyway.", color::err(color::WARN, "!"));
                        return Ok(());
                    }
                }
            }
            _ => false,
        };
        if !fixed {
            if probs.iter().any(|p| keys::certain(p, &offered)) {
                return Err(Stopped.into());
            }
            return Ok(());
        }
        v = check(api, t, &offered)?;
        if v["ready"] == true {
            good("Ready; connecting.");
            return Ok(());
        }
    }
    Ok(())
}

/// Telepy 不認得送出的金鑰：問要不要現在登記（沒有就先做一把）。/ Offer to register a key (creating one first).
fn offer_register(api: &Api, offered: &Offered) -> Result<bool> {
    let home = creds::home_dir();
    let question = match offered.first_file().and_then(|k| k.path.as_ref()) {
        Some(p) => format!("Add {}.pub to Telepy now? It opens {} in your browser.", keys::display_path(p, &home), api.server),
        None if offered.keys.is_empty() => "Create a key with ssh-keygen and add it to Telepy now?".to_string(),
        None => return Ok(false),
    };
    if ask(&question) != Some(true) {
        return Ok(false);
    }
    register(api, offered, None, None).map(|_| true)
}

/// 敏感隧道：開隧道頁請網頁確認，等確認。/ Step-up: open the tunnel page and wait for the confirmation.
fn offer_step_up(api: &Api, t: &Target, offered: &Offered) -> Result<bool> {
    if ask("Open it in your browser and wait here for the confirmation?") != Some(true) {
        return Ok(false);
    }
    open(&keys::step_up_url(&api.server, t.tunnel_id));
    waiting("Waiting for you to confirm in the browser (Ctrl+C to stop)…");
    match wait_check(api, t, offered, Duration::from_secs(600), |v| v["step_up"]["confirmed"] == true || v["step_up"]["required"] == false)? {
        Some(_) => {
            good("Confirmed for 15 minutes.");
            Ok(true)
        }
        None => Ok(false),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Placed {
    Yes,
    No,
    /// 使用者說不用（記下來，不再問這台）。/ Declined (remembered; not asked again for this device).
    Declined,
    /// 之前說過不用：不問也不擋。/ Declined before: neither asked nor blocked.
    Skip,
}

/// 金鑰不在裝置的清單上：放上去（只到這個帳號），等 Telepy 裝好。`yes` = 不問（`keys check --yes`）。
/// The key isn't on the device's list: put it there (this account only) and wait for the install. `yes` = don't ask.
fn offer_place(api: &Api, t: &Target, offered: &Offered, v: &Value, yes: bool) -> Result<Placed> {
    let key = &v["device"]["key"];
    let (Some(key_id), Some(accounts)) = (key["id"].as_i64(), v["device"]["place_accounts"].as_array()) else { return Ok(Placed::No) };
    let fp = key["fingerprint"].as_str().unwrap_or_default();
    let name = key["name"].as_str().unwrap_or("?");
    let uncertain = problems(v).iter().any(|p| p == "not_listed");
    if !yes {
        if uncertain && prefs::declined(&api.server, &declined_key(t, fp)) {
            return Ok(Placed::Skip);
        }
        let q = if uncertain {
            format!("Put \"{name}\" on {}'s key list for {} now? (n = try anyway; won't ask again for this device)", t.tunnel, t.account)
        } else {
            format!("Put \"{name}\" on {}'s key list for {} now? Telepy installs it within seconds.", t.tunnel, t.account)
        };
        match ask(&q) {
            Some(true) => {}
            Some(false) => {
                if uncertain {
                    let _ = prefs::decline(&api.server, &declined_key(t, fp));
                }
                return Ok(Placed::Declined);
            }
            None => return Ok(Placed::No),
        }
    }
    let body = json!({ "user_key_ids": [key_id], "accounts": accounts });
    match api.json(Method::POST, &format!("/api/reverse/server/{}/device-keys", t.tunnel_id), Some(&body)) {
        Ok(_) => {}
        // 這次的登入不能改金鑰清單（沒有 ssh:exec）：到網頁放。/ This sign-in can't change key lists: do it in the web.
        Err(e) if e.downcast_ref::<HttpError>().is_some_and(|h| h.status == 403) => {
            eprintln!("  Your sign-in can't change key lists here ({}).", e.downcast_ref::<HttpError>().and_then(|h| h.body["code"].as_str()).unwrap_or("forbidden"));
            eprintln!("  Tick \"{name}\" for {} on {}'s key panel in the browser instead.", t.account, t.tunnel);
            open(&keys::device_url(&api.server, t.tunnel_id));
            waiting("Waiting for the key to reach the device (Ctrl+C to stop)…");
            return Ok(match wait_check(api, t, offered, Duration::from_secs(600), installed)? {
                Some(_) => {
                    good(&format!("\"{name}\" is installed on {} for {}.", t.tunnel, t.account));
                    Placed::Yes
                }
                None => Placed::No,
            });
        }
        Err(e) => return Err(e),
    }
    if v["tunnel"]["online"] == false {
        eprintln!("  On the list; {} is offline, so Telepy installs it once the device is back.", t.tunnel);
        return Ok(Placed::No);
    }
    waiting(&format!("On the list; waiting for Telepy to install it on {} for {}…", t.tunnel, t.account));
    match wait_check(api, t, offered, Duration::from_secs(45), |v| installed(v) || problems(v).iter().any(|p| p == "sync_error"))? {
        Some(next) if installed(&next) => {
            good(&format!("\"{name}\" is installed on {} for {}.", t.tunnel, t.account));
            Ok(Placed::Yes)
        }
        Some(next) => {
            let home = creds::home_dir();
            let ctx = Ctx { server: &api.server, tunnel: t.tunnel, tunnel_id: t.tunnel_id, account: t.account, home: &home };
            if let Some(x) = keys::explain("sync_error", &next, offered, &ctx) {
                say(&x);
            }
            Ok(Placed::No)
        }
        None => {
            eprintln!("{} Not installed yet; Telepy keeps trying in the background.", color::err(color::WARN, "!"));
            Ok(Placed::No)
        }
    }
}

fn installed(v: &Value) -> bool {
    matches!(v["device"]["state"].as_str(), Some("installed" | "added_by_hand"))
}

/// 你在 Telepy 的金鑰（`GET /api/reverse/user/keys`）。/ Your keys in Telepy.
pub fn my_keys(api: &Api) -> Result<Vec<Value>> {
    Ok(api.get("/api/reverse/user/keys")?.as_array().cloned().unwrap_or_default())
}

/// 用 `ssh-keygen` 做一把 `~/.ssh/id_ed25519`（ssh-keygen 自己問密碼）。/ Create `~/.ssh/id_ed25519` (ssh-keygen asks for the passphrase).
fn create_key() -> Result<std::path::PathBuf> {
    let home = creds::home_dir();
    let dir = home.join(".ssh");
    let path = dir.join("id_ed25519");
    if path.exists() {
        bail!("{} already exists but its public half couldn't be read; add it with `telepy keys add {}.pub`.", path.display(), path.display());
    }
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let comment = format!("{}@{}", std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default(), keys::name_base(&keys::hostname()));
    let status = std::process::Command::new("ssh-keygen").args(["-t", "ed25519", "-C", &comment, "-f"]).arg(&path).status().map_err(|e| anyhow!("cannot run ssh-keygen ({e}); is OpenSSH installed?"))?;
    if !status.success() || !path.exists() {
        bail!("ssh-keygen didn't create {}", path.display());
    }
    good(&format!("Created {} (keep the private half on this computer).", keys::display_path(&path, &home)));
    Ok(path)
}

/// 登記一把金鑰：網頁的「新增金鑰」視窗先填好，使用者在網頁按下去；然後等它出現在 `GET /api/reverse/user/keys`。
/// 回登記好的那一列。`file` = 指定的檔案（否則 ssh 送出的第一把有檔案的、再不然做一把）。
/// Register a key: the web's add dialog is prefilled and the person confirms it there; then wait until it shows up in
/// `GET /api/reverse/user/keys`. Returns that row. `file` = a given file (else the first offered key with a file, else a
/// new one).
pub fn register(api: &Api, offered: &Offered, file: Option<&Path>, name: Option<&str>) -> Result<Value> {
    let home = creds::home_dir();
    let (line, shown) = match file {
        Some(f) => (keys::public_of(f).ok_or_else(|| anyhow!("{} is not an SSH public key (or a private key whose public half can be read)", f.display()))?, f.display().to_string()),
        None => match offered.first_file() {
            Some(k) => (k.line.clone(), format!("{}.pub", keys::display_path(k.path.as_deref().unwrap_or(Path::new("?")), &home))),
            None => {
                let p = create_key()?;
                (keys::public_of(&p).ok_or_else(|| anyhow!("can't read {}.pub", p.display()))?, format!("{}.pub", keys::display_path(&p, &home)))
            }
        },
    };
    let fp = keys::fingerprint(&line).ok_or_else(|| anyhow!("not an SSH public key"))?;
    let mine = my_keys(api)?;
    if let Some(k) = mine.iter().find(|k| k["fingerprint"].as_str() == Some(fp.as_str())) {
        good(&format!("{shown} is already in Telepy as \"{}\".", k["host_friendly_name"].as_str().unwrap_or("?")));
        return Ok(k.clone());
    }
    let taken: Vec<String> = mine.iter().filter_map(|k| k["host_friendly_name"].as_str().map(str::to_string)).collect();
    let name = name.map(str::to_string).unwrap_or_else(|| keys::unique_name(&keys::name_base(&keys::hostname()), &taken));
    let url = keys::add_url(&api.server, &line, &name);
    eprintln!("Adding {shown} to Telepy as \"{name}\". Confirm it in the browser;");
    eprintln!("the fingerprint there should read {}.", color::err(color::BOLD, &fp));
    open(&url);
    waiting("Waiting for you to add it (Ctrl+C to stop)…");
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(900) {
        std::thread::sleep(Duration::from_secs(2));
        if let Some(k) = my_keys(api)?.into_iter().find(|k| k["fingerprint"].as_str() == Some(fp.as_str())) {
            good(&format!("Added \"{}\" to Telepy.", k["host_friendly_name"].as_str().unwrap_or(&name)));
            return Ok(k);
        }
    }
    bail!("the key didn't show up in Telepy within 15 minutes; run `telepy keys add` again when you're ready")
}

/// `telepy keys check <target>`：每一關一行，能修的照 `yes` / 問了再修。回結束碼（0 = 進得去）。
/// `telepy keys check <target>`: one line per hop; fixes what it can (with `yes`, or after asking). Exit 0 = gets in.
pub fn report(api: &Api, t: &Target, config: &Path, alias: &str, yes: bool, as_json: bool) -> Result<i32> {
    let home = creds::home_dir();
    let offered = keys::offered(config, alias, &[], &home);
    let mut v = check(api, t, &offered)?;
    if as_json {
        let local: Vec<Value> = offered.keys.iter().map(|k| json!({ "fingerprint": k.fingerprint, "path": k.path, "agent": k.path.is_none() })).collect();
        println!("{}", serde_json::to_string_pretty(&json!({ "offered": local, "unreadable": offered.unreadable, "check": v }))?);
        return Ok(if v["ready"] == true { 0 } else { 1 });
    }
    print_hops(&v, &offered, t, &home);
    // 能修的：放上清單（`--yes` 或問了說好）、登記 / step-up（只在終端機上問）。/ What can be fixed.
    let probs = problems(&v);
    let fixed = match probs.first().map(String::as_str) {
        Some("not_on_device" | "not_listed") if yes || interactive() => matches!(offer_place(api, t, &offered, &v, yes)?, Placed::Yes),
        Some("no_key") if interactive() => offer_register(api, &offered)?,
        Some("step_up") if interactive() => offer_step_up(api, t, &offered)?,
        _ => false,
    };
    if fixed {
        v = check(api, t, &keys::offered(config, alias, &[], &home))?;
        println!();
        print_hops(&v, &offered, t, &home);
    } else if !probs.is_empty() {
        let ctx = Ctx { server: &api.server, tunnel: t.tunnel, tunnel_id: t.tunnel_id, account: t.account, home: &home };
        println!();
        for p in &probs {
            if let Some(x) = keys::explain(p, &v, &offered, &ctx) {
                say(&x);
            }
        }
    }
    Ok(if v["ready"] == true { 0 } else { 1 })
}

/// 照路徑一關一行：這台電腦 → Telepy → 裝置 → 帳號。/ One line per hop along the path.
fn print_hops(v: &Value, offered: &Offered, t: &Target, home: &Path) {
    let probs = problems(v);
    let has = |p: &str| probs.iter().any(|x| x == p);
    let row = |mark: Option<bool>, label: &str, text: String| {
        let m = match mark {
            Some(true) => color::out(color::GOOD, "✓"),
            Some(false) => color::out(color::BAD, "✗"),
            None => color::out(color::WARN, "!"),
        };
        println!("{m} {label:<16} {text}");
    };
    let offered_text = match offered.keys.len() {
        0 => "no SSH key found".to_string(),
        n => format!("offers {n} key(s): {}", offered.keys.iter().map(|k| k.path.as_ref().map(|p| keys::display_path(p, home)).unwrap_or_else(|| "ssh agent".into())).collect::<Vec<_>>().join(", ")),
    };
    row(Some(!offered.keys.is_empty()), "this computer", offered_text);
    match v["gateway"].as_str() {
        Some("ok") => {
            let k = v["matched"].as_array().and_then(|m| m.iter().find(|k| k["expired"] != true)).cloned().unwrap_or(Value::Null);
            row(Some(true), "Telepy", format!("knows your key \"{}\"", k["name"].as_str().unwrap_or("?")));
        }
        Some("expired") => row(Some(false), "Telepy", "your key has expired".into()),
        Some("keys_off") => row(Some(false), "Telepy", "personal SSH keys are turned off for you".into()),
        _ => row(Some(false), "Telepy", "doesn't know any key this computer offers".into()),
    }
    if has("step_up") {
        row(Some(false), "Telepy", "wants you to confirm it's you in the web first (step-up)".into());
    }
    row(Some(!has("offline")), t.tunnel, (if has("offline") { "offline" } else { "online" }).into());
    let label = format!("{}@{}", t.account, t.tunnel);
    if has("no_access") {
        return row(Some(false), &label, "you may use no account on this device".into());
    }
    if has("account_not_allowed") {
        return row(Some(false), &label, "not an account you may use".into());
    }
    match v["device"]["state"].as_str() {
        Some("installed") => row(Some(true), &label, "your key is installed".into()),
        Some("added_by_hand") => row(Some(true), &label, "your key is in authorized_keys (added another way)".into()),
        Some("pending") => row(None, &label, "on the key list, not installed yet".into()),
        Some("error") => row(Some(false), &label, format!("installing it failed: {}", v["device"]["error"].as_str().unwrap_or("?"))),
        Some("not_on_device") => row(Some(false), &label, "your key isn't in authorized_keys".into()),
        Some("not_listed") => row(None, &label, "not on the key list (refused unless added another way)".into()),
        _ => println!("{} {label:<16} can't tell until Telepy knows your key", color::out(color::DIM, "·")),
    }
}
