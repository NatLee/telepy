//! Tab 補完。shell 每按一次 Tab 就執行 `TELEPY_COMPLETE=<shell> telepy -- <目前的字>`（clap_complete 的動態補完），
//! 所以指令、旗標之外，隧道名稱、`box@<帳號>`、標籤、群組與工具箱片段也補得出來。那些名字從本機的小快取來
//! （`<設定目錄>/completion.json`，0600；一般指令順手更新它），過期才花最多 2 秒問伺服器，問不到就用舊的——
//! 按 Tab 不該卡住，也不該在伺服器連不上時什麼都沒有。補完的程序從不換 OAuth token（`Api::get_quick`）。
//! `telepy completions <shell>` 印出要放進 shell 設定檔的那段；不給 shell 就說該加哪一行、加在哪。
//! Tab completion. On every Tab the shell runs `TELEPY_COMPLETE=<shell> telepy -- <words so far>` (clap_complete's
//! dynamic completion), so besides commands and flags it completes tunnel names, `box@<account>`, labels, groups and
//! toolbox snippets. Those names come from a small local cache (`<config dir>/completion.json`, 0600; ordinary commands
//! refresh it on the way); only when it is stale does completion ask the server, for at most 2 seconds, falling back to
//! the stale names — Tab should never hang, nor come up empty because the server is unreachable. Completion never
//! renews an OAuth token (`Api::get_quick`). `telepy completions <shell>` prints what goes into the shell's startup
//! file; without a shell it says which line to add where.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Result};
use clap_complete::engine::{CompletionCandidate, PathCompleter, ValueCompleter};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{api::Api, color, creds, target};

/// shell 呼叫補完時設的環境變數（不用 clap 預設的 `COMPLETE`，免得跟別的工具撞名）。
/// The variable the shell sets when it asks for completions (not clap's default `COMPLETE`, which other tools use too).
pub const VAR: &str = "TELEPY_COMPLETE";

/// 每個 shell：設定檔、要加的那一行。/ Per shell: its startup file and the line to add.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Setup {
    pub shell: &'static str,
    pub file: &'static str,
    pub line: &'static str,
}

/// `eval "$(…)"` 而不是 `source <(…)`：macOS 內建的 bash 3.2 讀不到 `source <(…)`（什麼都不做也不報錯）。
/// `eval "$(…)"` rather than `source <(…)`: the bash 3.2 macOS ships silently does nothing with `source <(…)`.
pub const SETUP: [Setup; 5] = [
    Setup { shell: "bash", file: "~/.bashrc (macOS: ~/.bash_profile)", line: r#"eval "$(telepy completions bash)""# },
    Setup { shell: "zsh", file: "~/.zshrc", line: r#"eval "$(telepy completions zsh)""# },
    Setup { shell: "fish", file: "~/.config/fish/config.fish", line: "telepy completions fish | source" },
    Setup { shell: "powershell", file: "$PROFILE", line: "telepy completions powershell | Out-String | Invoke-Expression" },
    Setup { shell: "elvish", file: "~/.config/elvish/rc.elv", line: "eval (telepy completions elvish | slurp)" },
];

/// zsh 的 `compdef` 要先有補完系統；設定檔沒開（沒有 oh-my-zsh 之類）就幫忙開，`-i` 不為不安全的目錄停下來問。
/// zsh's `compdef` needs the completion system; when the startup file never loaded it (no oh-my-zsh or the like),
/// load it, `-i` so it never stops to ask about insecure directories.
const ZSH_PRELUDE: &str = "(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -i }\n";

/// zsh 會在 `pi:` 後面補一個空白（bash、fish 看到結尾是冒號就不補），所以把「裝置那一邊」當成資料夾那樣處理：
/// 冒號當後綴、不加空白，接著就能打路徑。clap 的腳本改了的話測試會說。
/// zsh would add a blank after `pi:` (bash and fish leave it out after a colon), so the device side of cp / scp is
/// treated like a folder: the colon becomes the suffix with no blank, ready for the path. A test notices when clap's script changes.
const ZSH_PATCHES: [(&str, &str); 3] = [
    ("        local -a other=()\n", "        local -a other=()\n        local -a remotes=()\n"),
    (
        "            else\n                other+=(\"$completion\")\n",
        "            elif [[ \"$value\" == *\\\\ ]]; then\n                remotes+=(\"${completion/\\\\:/}\")\n            else\n                other+=(\"$completion\")\n",
    ),
    ("        [[ -n $other ]] && _describe -V 'values' other\n", "        [[ -n $other ]] && _describe -V 'values' other\n        [[ -n $remotes ]] && _describe -V 'values' remotes -S ':'\n"),
];

/// 套上 [`ZSH_PATCHES`]；有一處對不上就原樣返回（補完照常，只是冒號後面多一個空白）。
/// Apply [`ZSH_PATCHES`]; when one doesn't match the script is returned as is (completion works, with a blank after the colon).
pub fn patch_zsh(script: &str) -> String {
    if ZSH_PATCHES.iter().any(|(from, _)| !script.contains(from)) {
        return script.to_string();
    }
    ZSH_PATCHES.iter().fold(script.to_string(), |s, (from, to)| s.replacen(from, to, 1))
}

/// 從 `$SHELL`（Windows 上沒有它就當 PowerShell）猜目前的 shell。/ Guess the shell from `$SHELL` (Windows without it = PowerShell).
pub fn detect_shell(windows: bool, env: impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    let from_shell = env("SHELL").and_then(|s| {
        let name = s.rsplit(['/', '\\']).next().unwrap_or("").trim_end_matches(".exe").to_ascii_lowercase();
        match name.as_str() {
            "bash" => Some("bash"),
            "zsh" => Some("zsh"),
            "fish" => Some("fish"),
            "elvish" => Some("elvish"),
            "pwsh" | "powershell" => Some("powershell"),
            _ => None,
        }
    });
    from_shell.or(if windows { Some("powershell") } else { None })
}

/// `telepy completions`（沒給 shell）印的說明。/ What `telepy completions` without a shell prints.
pub fn setup_text(shell: Option<&str>, code: impl Fn(&str) -> String) -> String {
    let mut out = String::new();
    let mine = shell.and_then(|s| SETUP.iter().find(|x| x.shell == s));
    if let Some(s) = mine {
        out.push_str(&format!("Tab completion for {}: add this line to {} and open a new terminal.\n\n  {}\n\n", s.shell, s.file, code(s.line)));
        out.push_str("Other shells:\n");
    } else {
        out.push_str("Tab completion: add the line for your shell to its startup file and open a new terminal.\n\n");
    }
    let w = SETUP.iter().map(|s| s.file.len()).max().unwrap_or(0);
    for s in SETUP.iter().filter(|s| Some(s.shell) != shell) {
        out.push_str(&format!("  {:<11} {:<w$}  {}\n", s.shell, s.file, code(s.line)));
    }
    out.push_str("\nTab then completes commands and flags, and also your tunnel names, accounts (box@<Tab>), labels, groups and snippets.\n");
    out.push_str("Plain sh, dash and BusyBox ash have no programmable completion, so there is nothing to add there.\n");
    out
}

/// `telepy completions [shell]`。
pub fn run(shell: Option<&str>) -> Result<i32> {
    let Some(shell) = shell else {
        let found = detect_shell(cfg!(windows), |k| std::env::var(k).ok());
        print!("{}", setup_text(found, |l| color::out(color::CODE, l)));
        return Ok(0);
    };
    let shells = clap_complete::env::Shells::builtins();
    let completer = shells.completer(shell).ok_or_else(|| anyhow!("unknown shell {shell}"))?;
    let mut buf = Vec::new();
    if shell == "zsh" {
        buf.extend_from_slice(ZSH_PRELUDE.as_bytes());
    }
    completer.write_registration(VAR, "telepy", "telepy", &completer_path(), &mut buf)?;
    if shell == "zsh" {
        buf = patch_zsh(&String::from_utf8_lossy(&buf)).into_bytes();
    }
    std::io::stdout().write_all(&buf)?;
    Ok(0)
}

/// 補完時 shell 要叫的程式：照怎麼叫我們的（在 PATH 上就是 `telepy`，升級後照樣找得到；給路徑的就換成絕對路徑）。
/// What the shell calls when completing: how we were called (`telepy` from PATH keeps working after an update; a path
/// becomes absolute).
fn completer_path() -> String {
    let arg0 = PathBuf::from(std::env::args_os().next().unwrap_or_else(|| "telepy".into()));
    let path = if arg0.components().count() > 1 { std::env::current_dir().map(|d| d.join(&arg0)).unwrap_or(arg0) } else { arg0 };
    path.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------- the cache

/// 隧道清單在快取裡多久算新。/ How long the cached tunnel list counts as fresh.
const TUNNELS_FRESH: i64 = 30;
/// 帳號、群組、片段很少變。/ Accounts, groups and snippets rarely change.
const OTHERS_FRESH: i64 = 300;
/// 問伺服器最多等多久（之後就用舊的）。/ The longest a Tab waits for the server (then the stale names do).
const ASK_FOR: Duration = Duration::from_secs(2);
/// 問不到之後隔多久再問：伺服器連不上時不讓每個 Tab 都等兩秒。/ After a failed ask, wait this long before asking again, so an unreachable server doesn't cost every Tab two seconds.
const RETRY_AFTER: i64 = 30;

/// 問不到時的時間戳：舊的名字再用 [`RETRY_AFTER`] 秒。/ The stamp after a failed ask: the old names count as fresh for [`RETRY_AFTER`] more seconds.
fn failed_at(ttl: i64) -> i64 {
    now() - ttl + RETRY_AFTER
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Tunnel {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub health: String,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stamped {
    at: i64,
    names: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Cache {
    server: String,
    #[serde(default)]
    tunnels_at: i64,
    #[serde(default)]
    tunnels: Vec<Tunnel>,
    #[serde(default)]
    accounts: BTreeMap<i64, Stamped>,
    #[serde(default)]
    groups: Option<Stamped>,
    #[serde(default)]
    snippets: Option<Stamped>,
}

fn path() -> PathBuf {
    creds::config_dir().join("completion.json")
}

fn now() -> i64 {
    crate::now()
}

/// 這台伺服器的快取（換了伺服器就從空的開始）。/ This server's cache (another server starts empty).
fn load(server: &str) -> Cache {
    let cache: Cache = std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if cache.server == server {
        cache
    } else {
        Cache { server: server.to_string(), ..Default::default() }
    }
}

fn save(cache: &Cache) {
    if let Ok(s) = serde_json::to_string(cache) {
        let _ = creds::write_private(&path(), &s);
    }
}

/// 登出就忘掉（名字留在本機也沒用了）。/ Forgotten on sign-out.
pub fn forget() {
    let _ = std::fs::remove_file(path());
}

/// 後端的隧道 JSON → 快取裡的樣子。/ The backend's tunnel JSON → the cached shape.
pub fn tunnels_from(list: &[Value]) -> Vec<Tunnel> {
    list.iter()
        .filter_map(|t| {
            Some(Tunnel {
                id: t["id"].as_i64()?,
                name: t["host_friendly_name"].as_str()?.to_string(),
                health: t["health"].as_str().unwrap_or("").to_string(),
                labels: t["labels"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
            })
        })
        .collect()
}

/// 一般指令拿到隧道清單時順手記下（盡力而為）。/ Ordinary commands note the tunnel list on the way (best effort).
pub fn remember_tunnels(server: &str, list: &[Value]) {
    let mut c = load(server);
    c.tunnels = tunnels_from(list);
    c.tunnels_at = now();
    let ids: Vec<i64> = c.tunnels.iter().map(|t| t.id).collect();
    c.accounts.retain(|id, _| ids.contains(id));
    save(&c);
}

/// `ls` / `status` 查到的帳號也記下。/ Accounts that `ls` / `status` looked up, noted too.
pub fn remember_accounts(server: &str, found: &[(i64, Vec<String>)]) {
    let mut c = load(server);
    for (id, names) in found {
        c.accounts.insert(*id, Stamped { at: now(), names: names.clone() });
    }
    save(&c);
}

/// 現在登入的伺服器（`TELEPY_URL` 或 `telepy login` 存的；只讀設定檔，不碰金鑰圈）。
/// The server in use (`TELEPY_URL` or the stored one; reads the config file only, never the keyring).
fn current_server() -> Option<String> {
    std::env::var("TELEPY_URL").ok().filter(|s| !s.is_empty()).map(|s| creds::normalize_server(&s)).or_else(|| creds::load_profile().map(|p| p.server))
}

/// 快取過期才開 API（才讀金鑰圈）。`TELEPY_URL` 跟存的登入不是同一台時開不了：寧可沒有，也不把別台的名字記到這台。
/// Opens the API (and reads the keyring) only when the cache is stale. With `TELEPY_URL` naming another server than the
/// stored sign-in it fails: no names rather than the other server's names under this one.
fn api() -> Option<Api> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    Api::open(env("TELEPY_URL").as_deref(), env("TELEPY_TOKEN").as_deref()).ok()
}

fn fresh(at: i64, ttl: i64) -> bool {
    now() - at < ttl
}

fn tunnels() -> (Option<String>, Vec<Tunnel>) {
    let Some(server) = current_server() else { return (None, Vec::new()) };
    let mut c = load(&server);
    if !fresh(c.tunnels_at, TUNNELS_FRESH) {
        match api().and_then(|a| a.get_quick("/api/reverse/server/dashboard", ASK_FOR).ok()) {
            Some(v) => {
                c.tunnels = tunnels_from(v["tunnels"].as_array().map(Vec::as_slice).unwrap_or_default());
                c.tunnels_at = now();
            }
            None => c.tunnels_at = failed_at(TUNNELS_FRESH),
        }
        save(&c);
    }
    (Some(server), c.tunnels)
}

fn accounts(server: &str, id: i64) -> Vec<String> {
    let mut c = load(server);
    if let Some(s) = c.accounts.get(&id).filter(|s| fresh(s.at, OTHERS_FRESH)) {
        return s.names.clone();
    }
    let names = match api().and_then(|a| a.get_quick(&format!("/api/reverse/server/{id}/usernames"), ASK_FOR).ok()) {
        Some(v) => Stamped { at: now(), names: v["usernames"].as_array().map(|a| a.iter().filter_map(|u| u["username"].as_str().map(str::to_string)).collect()).unwrap_or_default() },
        None => Stamped { at: failed_at(OTHERS_FRESH), names: c.accounts.get(&id).map(|s| s.names.clone()).unwrap_or_default() },
    };
    c.accounts.insert(id, names.clone());
    save(&c);
    names.names
}

/// 群組或片段的名字（快取 5 分鐘）。/ Group or snippet names, cached for 5 minutes.
fn names(pick: fn(&mut Cache) -> &mut Option<Stamped>, path: &str, list: &str) -> Vec<String> {
    let Some(server) = current_server() else { return Vec::new() };
    let mut c = load(&server);
    if let Some(s) = pick(&mut c).as_ref().filter(|s| fresh(s.at, OTHERS_FRESH)) {
        return s.names.clone();
    }
    let names = match api().and_then(|a| a.get_quick(path, ASK_FOR).ok()) {
        Some(v) => Stamped { at: now(), names: v[list].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str().map(str::to_string)).collect()).unwrap_or_default() },
        None => Stamped { at: failed_at(OTHERS_FRESH), names: pick(&mut c).as_ref().map(|s| s.names.clone()).unwrap_or_default() },
    };
    *pick(&mut c) = Some(names.clone());
    save(&c);
    names.names
}

// ---------------------------------------------------------------- picking candidates (pure)

/// 一個候選：值與一行說明。/ A candidate: the value and a one-line help.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cand {
    pub value: String,
    pub help: Option<String>,
}

/// 以 `prefix` 開頭的；一個都沒有時不分大小寫再找一次（隧道名稱本來就不分大小寫）。
/// Those starting with `prefix`; when none do, again ignoring case (tunnel names are unique ignoring case anyway).
pub fn starting_with<'a>(items: &'a [String], prefix: &str) -> Vec<&'a str> {
    let exact: Vec<&str> = items.iter().map(String::as_str).filter(|n| n.starts_with(prefix)).collect();
    if !exact.is_empty() {
        return exact;
    }
    let lower = prefix.to_lowercase();
    items.iter().map(String::as_str).filter(|n| n.to_lowercase().starts_with(&lower)).collect()
}

fn tunnel_cands(tunnels: &[Tunnel], prefix: &str, before: &str) -> Vec<Cand> {
    let names: Vec<String> = tunnels.iter().map(|t| t.name.clone()).collect();
    starting_with(&names, prefix)
        .into_iter()
        .map(|n| {
            let t = tunnels.iter().find(|t| t.name == n);
            Cand { value: format!("{before}{n}"), help: t.map(|t| t.health.clone()).filter(|h| !h.is_empty()) }
        })
        .collect()
}

/// `<tunnel>[@account]`：`box@` 之後補 box 上的帳號；`root@` 而 root 不是隧道 = ssh 的 `account@tunnel` 寫法，補隧道。
/// `<tunnel>[@account]`: after `box@` the accounts on box; `root@` where root is no tunnel = ssh's `account@tunnel`, so tunnels.
pub fn targets(word: &str, tunnels: &[Tunnel], with_account: bool, accounts_of: impl Fn(i64) -> Vec<String>) -> Vec<Cand> {
    if with_account {
        if let Some((left, right)) = word.split_once('@') {
            return match tunnels.iter().find(|t| t.name.eq_ignore_ascii_case(left)) {
                Some(t) => starting_with(&accounts_of(t.id), right).into_iter().map(|a| Cand { value: format!("{left}@{a}"), help: None }).collect(),
                None => tunnel_cands(tunnels, right, &format!("{left}@")),
            };
        }
    }
    tunnel_cands(tunnels, word, "")
}

/// cp / scp 的一邊：本機路徑或 `<tunnel>[@account]:`（裝置上的路徑不補，那要連過去才知道）。
/// One side of cp / scp: a local path or `<tunnel>[@account]:` (paths on the device aren't completed; that needs a connection).
pub fn remotes(word: &str, tunnels: &[Tunnel], accounts_of: impl Fn(i64) -> Vec<String>) -> Vec<Cand> {
    if target::parse_remote(word).is_some() || word.starts_with(['.', '/', '~']) {
        return Vec::new();
    }
    targets(word, tunnels, true, accounts_of).into_iter().map(|c| Cand { value: format!("{}:", c.value), help: c.help.or(Some("device".into())) }).collect()
}

/// 每條隧道的標籤，去重排序。/ Every tunnel's labels, de-duplicated and sorted.
pub fn labels_of(tunnels: &[Tunnel]) -> Vec<String> {
    let mut all: Vec<String> = tunnels.iter().flat_map(|t| t.labels.iter().cloned()).collect();
    all.sort();
    all.dedup();
    all
}

/// bash 不會幫值加跳脫：有空白的名字（群組、片段）先跳脫好。其他 shell 自己會。
/// bash doesn't escape values: names with blanks (groups, snippets) are escaped first. Other shells do it themselves.
pub fn for_shell(value: &str, bash: bool) -> String {
    if !bash {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_whitespace() || "\\'\"$`!&;|<>()*?[]{}#~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------- what the shell calls

fn bash() -> bool {
    // 只有 bash 的補完腳本會帶這個。/ Only the bash completion script passes this.
    std::env::var_os("_CLAP_COMPLETE_COMP_TYPE").is_some()
}

fn out(cands: Vec<Cand>) -> Vec<CompletionCandidate> {
    let bash = bash();
    cands.into_iter().map(|c| CompletionCandidate::new(for_shell(&c.value, bash)).help(c.help.map(Into::into))).collect()
}

fn word(current: &OsStr) -> String {
    current.to_string_lossy().into_owned()
}

fn with_accounts(current: &OsStr, with_account: bool) -> Vec<CompletionCandidate> {
    let (server, list) = tunnels();
    let Some(server) = server else { return Vec::new() };
    out(targets(&word(current), &list, with_account, |id| accounts(&server, id)))
}

/// 隧道名稱。/ Tunnel names.
pub fn tunnel(current: &OsStr) -> Vec<CompletionCandidate> {
    with_accounts(current, false)
}

/// `<tunnel>[@account]`。
pub fn target(current: &OsStr) -> Vec<CompletionCandidate> {
    with_accounts(current, true)
}

/// cp / scp：本機路徑加上 `<tunnel>:`。/ cp / scp: local paths plus `<tunnel>:`.
pub fn remote_or_path(current: &OsStr) -> Vec<CompletionCandidate> {
    let mut found = PathCompleter::any().complete(current);
    let (server, list) = tunnels();
    if let Some(server) = server {
        found.extend(out(remotes(&word(current), &list, |id| accounts(&server, id))));
    }
    found
}

/// `--label`。
pub fn label(current: &OsStr) -> Vec<CompletionCandidate> {
    let all = labels_of(&tunnels().1);
    out(starting_with(&all, &word(current)).into_iter().map(|l| Cand { value: l.to_string(), help: None }).collect())
}

/// `--group`：自己的隧道群組。/ Your tunnel groups.
pub fn group(current: &OsStr) -> Vec<CompletionCandidate> {
    let all = names(|c| &mut c.groups, "/api/reverse/tunnel-groups", "groups");
    out(starting_with(&all, &word(current)).into_iter().map(|g| Cand { value: g.to_string(), help: None }).collect())
}

/// `run <snippet>`：工具箱片段。/ Toolbox snippets.
pub fn snippet(current: &OsStr) -> Vec<CompletionCandidate> {
    let all = names(|c| &mut c.snippets, "/api/snippets", "snippets");
    out(starting_with(&all, &word(current)).into_iter().map(|s| Cand { value: s.to_string(), help: None }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: i64, name: &str, health: &str, labels: &[&str]) -> Tunnel {
        Tunnel { id, name: name.into(), health: health.into(), labels: labels.iter().map(|s| s.to_string()).collect() }
    }

    fn values(c: Vec<Cand>) -> Vec<String> {
        c.into_iter().map(|c| c.value).collect()
    }

    fn list() -> Vec<Tunnel> {
        vec![t(1, "box", "online", &["env=prod"]), t(2, "Bastion", "offline", &["env=prod", "edge"]), t(3, "pi", "never", &[])]
    }

    fn accounts(id: i64) -> Vec<String> {
        match id {
            1 => vec!["root".into(), "pi".into()],
            _ => vec![],
        }
    }

    #[test]
    fn tunnel_names_with_their_health() {
        let l = list();
        assert_eq!(targets("b", &l, true, accounts), vec![Cand { value: "box".into(), help: Some("online".into()) }]);
        assert_eq!(values(targets("", &l, true, accounts)), ["box", "Bastion", "pi"]);
        assert_eq!(values(targets("ba", &l, true, accounts)), ["Bastion"], "case only matters when something matches exactly");
        assert_eq!(values(targets("B", &l, true, accounts)), ["Bastion"]);
    }

    #[test]
    fn accounts_after_the_at() {
        let l = list();
        assert_eq!(values(targets("box@", &l, true, accounts)), ["box@root", "box@pi"]);
        assert_eq!(values(targets("box@r", &l, true, accounts)), ["box@root"]);
        assert_eq!(values(targets("BOX@p", &l, true, accounts)), ["BOX@pi"], "what was typed stays");
        // `root@` 不是隧道：ssh 的 account@tunnel 寫法。/ `root@` is no tunnel: ssh's account@tunnel.
        assert_eq!(values(targets("root@b", &l, true, accounts)), ["root@box"]);
        assert_eq!(values(targets("root@B", &l, true, accounts)), ["root@Bastion"]);
        assert_eq!(values(targets("box@", &l, false, accounts)), Vec::<String>::new(), "status takes a name only");
    }

    #[test]
    fn copy_sides_end_with_a_colon() {
        let l = list();
        assert_eq!(values(remotes("p", &l, accounts)), ["pi:"]);
        assert_eq!(values(remotes("box@r", &l, accounts)), ["box@root:"]);
        assert!(remotes("box:/etc", &l, accounts).is_empty(), "no paths on the device");
        assert!(remotes("./b", &l, accounts).is_empty());
        assert!(remotes("~/b", &l, accounts).is_empty());
    }

    #[test]
    fn labels_once_each() {
        assert_eq!(labels_of(&list()), ["edge", "env=prod"]);
    }

    #[test]
    fn bash_gets_escaped_values() {
        assert_eq!(for_shell("Home lab", true), "Home\\ lab");
        assert_eq!(for_shell("Home lab", false), "Home lab");
        assert_eq!(for_shell("box@root", true), "box@root");
        assert_eq!(for_shell("a$b", true), "a\\$b");
    }

    #[test]
    fn the_shell_is_guessed_from_shell() {
        let env = |v: &'static str| move |k: &str| (k == "SHELL").then(|| v.to_string());
        assert_eq!(detect_shell(false, env("/bin/zsh")), Some("zsh"));
        assert_eq!(detect_shell(false, env("/usr/local/bin/bash")), Some("bash"));
        assert_eq!(detect_shell(false, env("/opt/homebrew/bin/fish")), Some("fish"));
        assert_eq!(detect_shell(false, env("/usr/bin/pwsh")), Some("powershell"));
        assert_eq!(detect_shell(false, env("/bin/sh")), None);
        assert_eq!(detect_shell(true, |_| None), Some("powershell"));
        assert_eq!(detect_shell(false, |_| None), None);
    }

    #[test]
    fn the_setup_text_puts_your_shell_first() {
        let text = setup_text(Some("zsh"), str::to_string);
        assert!(text.starts_with("Tab completion for zsh: add this line to ~/.zshrc"), "{text}");
        assert!(text.contains("\n  eval \"$(telepy completions zsh)\"\n"), "{text}");
        assert_eq!(text.matches("telepy completions zsh").count(), 1, "zsh is not listed again");
        assert!(text.contains("telepy completions fish | source"));
        let any = setup_text(None, str::to_string);
        assert!(SETUP.iter().all(|s| any.contains(s.line)), "{any}");
    }

    #[test]
    fn the_zsh_script_still_takes_the_colon_patch() {
        let mut buf = Vec::new();
        clap_complete::env::Shells::builtins().completer("zsh").unwrap().write_registration(VAR, "telepy", "telepy", "telepy", &mut buf).unwrap();
        let script = String::from_utf8(buf).unwrap();
        let patched = patch_zsh(&script);
        assert_ne!(patched, script, "clap's zsh script changed: update ZSH_PATCHES");
        assert!(patched.contains("_describe -V 'values' remotes -S ':'"));
        assert!(patched.contains(r#"remotes+=("${completion/\\:/}")"#), "{patched}");
    }

    #[test]
    fn every_setup_shell_is_one_clap_knows() {
        for s in SETUP {
            assert!(clap_complete::env::Shells::builtins().completer(s.shell).is_some(), "{}", s.shell);
        }
    }
}
