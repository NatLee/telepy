//! 連線期間打的指令不寫進裝置的 shell 歷史檔（網頁終端機與 MCP agent 的互動 shell）。
//!
//! 背景的探測（裝置資訊、區網掃描、平台偵測…）都是 exec channel 上的 `sh -c` / `powershell -NonInteractive`，
//! 非互動 shell 本來就不記歷史；會進歷史檔的只有打進互動 PTY shell 的東西 —— 網頁終端機（含工具箱送出的指令）與
//! agent 的 `shell_*`。設定（個人預設 `user_management_usersettings.shell_history` + 每條隧道的個人覆寫
//! `telepy_shell_history_pref`）要不寫時：
//! 1. 先用一個 exec 問登入 shell（`echo $SHELL $PSHOME`，網頁終端機的結果在連線池裡快取）；
//! 2. shell 開好、提示字元出現（輸出安靜下來）後，替使用者打一行開頭有空白的設定：sh 家族
//!    `HISTFILE=/dev/null`（zsh 用 `unset HISTFILE` —— zsh 以 root 身分會把 `/dev/null.new` rename 蓋掉 /dev/null），
//!    fish `set -g fish_history ''`，最後印出這次獨有的標記；
//! 3. 看到標記才算成功，從打字到標記後安靜下來的輸出（回顯那一行、第二個提示字元）都丟掉，畫面上就像什麼都沒發生；
//!    沒看到標記（`HISTFILE` 是 readonly —— 管理員要留歷史就不繞過、不支援的 shell、啟動腳本在等輸入）就把輸出
//!    原樣送出，提示行說沒關成。
//!
//! Keeps the commands of a Telepy shell out of the device's shell history file. Background probes run over exec
//! channels (non-interactive, never recorded); only interactive PTY shells — the web terminal (Toolbox runs
//! included) and agent shells — write history. When the setting says so: ask the login shell with one exec, wait
//! for the prompt, type one leading-space setup line that ends by printing a unique marker, and only once the
//! marker shows up drop the echo and the second prompt. No marker (a readonly `HISTFILE`, an unsupported shell, a
//! startup script reading input) = the output goes out unchanged and the notice says it did not work.

use std::time::Duration;

use russh::client::Msg;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use tokio::time::Instant;

use crate::state::AppState;

/// 問登入 shell：sh 家族 / fish 印路徑，PowerShell 印 `$PSHOME`（`$SHELL` 沒定義），cmd.exe 原樣印出這串字。
/// Asks for the login shell: POSIX shells and fish print its path, PowerShell its `$PSHOME`, cmd.exe the text itself.
pub const PROBE: &str = "echo $SHELL $PSHOME";
const CMD_ECHO: &str = "$SHELL $PSHOME";

/// 標記的前綴；設定那行把它跟 nonce 分開印，回顯裡永遠有空白隔開，只有真的執行了才會連在一起。
/// The marker prefix; the setup line prints it and the nonce as two words, so only a real run joins them.
const MARKER_PREFIX: &str = "telepy-history-off-";

/// 等標記時最多留多少輸出（超過就當失敗，原樣送出）。/ The most output held while waiting for the marker.
const HELD_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// 照常寫進歷史檔（預設）。/ Saved as usual (the default).
    Keep,
    /// 這次連線打的指令不寫進歷史檔。/ This connection's commands stay out of the history file.
    Skip,
}

impl Mode {
    pub const VALUES: [&'static str; 2] = ["keep", "skip"];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "keep" => Some(Self::Keep),
            "skip" => Some(Self::Skip),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keep => "keep",
            Self::Skip => "skip",
        }
    }
}

/// 誰決定的：個人預設或這條隧道的覆寫。/ Which layer decided: the personal default or this tunnel's override.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Default,
    Tunnel,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Tunnel => "tunnel",
        }
    }
}

/// 隧道的覆寫優先，沒有就用個人預設。/ The tunnel's override wins; otherwise the personal default.
pub fn effective(default: Mode, tunnel: Option<Mode>) -> (Mode, Source) {
    match tunnel {
        Some(m) => (m, Source::Tunnel),
        None => (default, Source::Default),
    }
}

/// 某人在某條隧道上現在的選擇（讀不到 = 照常寫）。/ A person's choice on a tunnel right now (unreadable = keep).
pub async fn effective_for(state: &AppState, user_id: i64, tunnel_id: i64) -> (Mode, Source) {
    let default = crate::db::users::settings_for(&state.db, user_id).await.ok().flatten().and_then(|s| Mode::parse(&s.shell_history)).unwrap_or(Mode::Keep);
    let tunnel = crate::db::shell_history::get(&state.db, user_id, tunnel_id).await.ok().flatten().and_then(|m| Mode::parse(&m));
    effective(default, tunnel)
}

/// 登入 shell 是哪一種。/ What kind of login shell the account has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginShell {
    /// bash / zsh / sh / dash：同一行設定。/ One setup line for all of them.
    Posix(String),
    Fish,
    /// Windows 預設的 cmd.exe：本來就沒有歷史檔。/ Windows' default cmd.exe keeps no history file.
    Cmd,
    PowerShell,
    /// 其他（ksh、tcsh、busybox ash…）：不支援，不打任何東西。/ Anything else: unsupported, nothing is typed.
    Other(String),
    /// 問不到（exec 被拒、逾時、看不懂的輸出）。/ The probe failed or its output made no sense.
    Unknown,
}

impl LoginShell {
    /// 給提示行與稽核看的名字。/ A name for the notice and the audit line.
    pub fn label(&self) -> String {
        match self {
            Self::Posix(n) | Self::Other(n) => n.clone(),
            Self::Fish => "fish".into(),
            Self::Cmd => "cmd.exe".into(),
            Self::PowerShell => "PowerShell".into(),
            Self::Unknown => "an unknown shell".into(),
        }
    }
}

/// [`PROBE`] 的輸出 → 登入 shell。登入 shell 可能先印別的東西，所以逐行找第一個看得懂的。
/// The probe's output → the login shell; the first line that makes sense wins.
pub fn parse_probe(out: &str) -> LoginShell {
    for line in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if line == CMD_ECHO {
            return LoginShell::Cmd;
        }
        let lower = line.to_ascii_lowercase();
        let drive = line.as_bytes().get(1..3) == Some(b":\\".as_slice()) && line.as_bytes()[0].is_ascii_alphabetic();
        if lower.contains("powershell") || drive {
            return LoginShell::PowerShell;
        }
        if let Some(path) = line.split_whitespace().next().filter(|w| w.starts_with('/')) {
            let name = path.rsplit('/').next().unwrap_or_default().trim_start_matches('-');
            return match name {
                "" => LoginShell::Unknown,
                "bash" | "zsh" | "sh" | "dash" => LoginShell::Posix(name.to_string()),
                "fish" => LoginShell::Fish,
                other => LoginShell::Other(other.to_string()),
            };
        }
    }
    LoginShell::Unknown
}

/// 要打的那一行與要等的標記。/ The line to type and the marker to wait for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// 開頭有空白（多數設定下這行本身也不進歷史），不含 Enter。/ Starts with a space; without the Enter.
    pub line: String,
    pub marker: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prepared {
    Type(Plan),
    /// cmd.exe：不用打，本來就不存。/ cmd.exe: nothing to type, nothing is saved anyway.
    NothingSaved,
    /// 不支援的 shell（或問不到）：不打任何東西。/ Unsupported (or unknown): nothing is typed.
    Unsupported(String),
}

/// 依登入 shell 決定要打什麼。sh 家族那行自己判斷是不是 zsh：`$SHELL` 說 bash、`.bashrc` 卻 `exec zsh` 也安全。
/// What to type for a login shell. The POSIX line checks for zsh itself, so a bash that `exec`s zsh is still safe.
pub fn plan(shell: &LoginShell, nonce: &str) -> Prepared {
    let marker = format!("{MARKER_PREFIX}{nonce}");
    let print = format!("printf '%s%s\\n' {MARKER_PREFIX} {nonce}");
    match shell {
        LoginShell::Posix(_) => Prepared::Type(Plan {
            line: format!(" if [ -n \"$ZSH_VERSION\" ]; then unset HISTFILE; else HISTFILE=/dev/null; fi && {print}"),
            marker,
        }),
        LoginShell::Fish => Prepared::Type(Plan { line: format!(" set -g fish_history ''; and {print}"), marker }),
        LoginShell::Cmd => Prepared::NothingSaved,
        other => Prepared::Unsupported(other.label()),
    }
}

/// 每一段等多久。/ How long each phase waits.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// 第一個輸出後安靜這麼久 = 提示字元出來了。/ Quiet this long after output = the prompt is up.
    pub prompt_quiet: Duration,
    /// 等提示字元最多這麼久（一直有輸出、或什麼都沒印）。/ The longest wait for the prompt.
    pub prompt_max: Duration,
    /// 打完那行後等標記最多這麼久。/ The longest wait for the marker.
    pub marker_max: Duration,
    /// 標記之後安靜這麼久 = 第二個提示字元印完了。/ Quiet this long after the marker = the second prompt is out.
    pub after_quiet: Duration,
    pub after_max: Duration,
}

pub const TIMING: Timing = Timing {
    prompt_quiet: Duration::from_millis(300),
    prompt_max: Duration::from_secs(6),
    marker_max: Duration::from_secs(4),
    after_quiet: Duration::from_millis(150),
    after_max: Duration::from_secs(1),
};

/// 讀到的一件事。/ One read.
pub enum Read {
    Data(Vec<u8>),
    /// shell 結束了（exit status，沒有就 None）。/ The shell ended.
    Ended(Option<u32>),
}

/// 設定步驟需要的讀寫；`read` 要能被取消（逾時就丟掉它）。/ What the setup needs; `read` must be cancel-safe.
#[allow(async_fn_in_trait)]
pub trait Io {
    async fn read(&mut self) -> Read;
    async fn write(&mut self, data: &[u8]) -> anyhow::Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupResult {
    /// 看到標記：這個 shell 的指令不會寫進歷史檔。/ The marker came back: history is off in this shell.
    Applied,
    /// 等不到安靜的提示字元，什麼都沒打。/ No quiet prompt; nothing was typed.
    NoPrompt,
    /// 打了，但標記沒回來（readonly、shell 不對、被別的程式讀走）。/ Typed, but the marker never came back.
    NoMarker,
    /// 送不出去。/ The line could not be sent.
    WriteFailed,
    /// 設定途中 shell 結束了。/ The shell ended meanwhile.
    Ended(Option<u32>),
}

/// 設定的結果：`shown` = 要照常交給畫面的輸出（提示字元之前的、失敗時的回顯）。/ `shown` = output to pass on as usual.
pub struct Outcome {
    pub shown: Vec<u8>,
    pub result: SetupResult,
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

/// 等提示字元 → 打那一行 → 等標記 → 丟掉回顯與第二個提示字元。/ Wait for the prompt, type, wait for the marker, drop the echo.
pub async fn run<I: Io>(io: &mut I, plan: &Plan, t: &Timing) -> Outcome {
    let start = Instant::now();
    let mut shown = Vec::new();
    let mut last: Option<Instant> = None;
    // 1. 提示字元：有輸出之後安靜下來。/ The prompt: output, then quiet.
    loop {
        let give_up = start + t.prompt_max;
        let deadline = last.map_or(give_up, |l| (l + t.prompt_quiet).min(give_up));
        match tokio::time::timeout_at(deadline, io.read()).await {
            Ok(Read::Data(d)) => {
                shown.extend_from_slice(&d);
                last = Some(Instant::now());
            }
            Ok(Read::Ended(code)) => return Outcome { shown, result: SetupResult::Ended(code) },
            Err(_) => match last {
                Some(l) if Instant::now() >= l + t.prompt_quiet => break,
                _ => return Outcome { shown, result: SetupResult::NoPrompt },
            },
        }
    }
    // 2. 打那一行。/ Type the line.
    let mut line = plan.line.clone().into_bytes();
    line.push(b'\r');
    if io.write(&line).await.is_err() {
        return Outcome { shown, result: SetupResult::WriteFailed };
    }
    // 3. 等標記；沒等到就把留著的原樣送出。/ Wait for the marker; without it, pass the held output on.
    let typed = Instant::now();
    let mut held = Vec::new();
    loop {
        match tokio::time::timeout_at(typed + t.marker_max, io.read()).await {
            Ok(Read::Data(d)) => {
                held.extend_from_slice(&d);
                if contains(&held, plan.marker.as_bytes()) {
                    break;
                }
                if held.len() > HELD_CAP {
                    shown.extend(held);
                    return Outcome { shown, result: SetupResult::NoMarker };
                }
            }
            Ok(Read::Ended(code)) => {
                shown.extend(held);
                return Outcome { shown, result: SetupResult::Ended(code) };
            }
            Err(_) => {
                shown.extend(held);
                return Outcome { shown, result: SetupResult::NoMarker };
            }
        }
    }
    // 4. 標記之後的第二個提示字元也丟掉（畫面停在第一個提示字元，游標位置一樣）。
    // Drop the second prompt too: the screen stays on the first one, with the cursor where the shell expects it.
    let found = Instant::now();
    let mut last = found;
    loop {
        let deadline = (last + t.after_quiet).min(found + t.after_max);
        match tokio::time::timeout_at(deadline, io.read()).await {
            Ok(Read::Data(_)) => last = Instant::now(),
            Ok(Read::Ended(code)) => return Outcome { shown, result: SetupResult::Ended(code) },
            Err(_) => return Outcome { shown, result: SetupResult::Applied },
        }
    }
}

/// russh 的 PTY channel（網頁終端機與 agent shell 共用）。/ A russh PTY channel (web terminal and agent shells).
pub struct ChannelIo<'a> {
    pub rx: &'a mut ChannelReadHalf,
    pub tx: &'a ChannelWriteHalf<Msg>,
    exit: Option<u32>,
}

impl<'a> ChannelIo<'a> {
    pub fn new(rx: &'a mut ChannelReadHalf, tx: &'a ChannelWriteHalf<Msg>) -> Self {
        Self { rx, tx, exit: None }
    }
}

impl Io for ChannelIo<'_> {
    async fn read(&mut self) -> Read {
        loop {
            match self.rx.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => return Read::Data(data.to_vec()),
                Some(ChannelMsg::ExitStatus { exit_status }) => self.exit = Some(exit_status),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => return Read::Ended(self.exit),
                Some(_) => {}
            }
        }
    }

    async fn write(&mut self, data: &[u8]) -> anyhow::Result<()> {
        self.tx.data_bytes(data.to_vec()).await.map_err(Into::into)
    }
}

/// 一次設定（含探測）的結論，給提示行、稽核與 agent 看。/ What came of it, for the notice, the audit and agents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    /// 這個 shell 的指令不會寫進歷史檔（cmd.exe 本來就不寫）。/ Kept out (cmd.exe never saves anyway).
    Off { shell: String },
    /// 不支援這種 shell，什麼都沒打。/ Unsupported shell; nothing typed.
    Unsupported { shell: String },
    /// 試了沒成功（沒提示字元、標記沒回來、shell 不明）。/ Tried and failed.
    Failed { shell: String },
}

impl Applied {
    pub fn from_setup(shell: &LoginShell, result: SetupResult) -> Self {
        let shell = shell.label();
        match result {
            SetupResult::Applied => Self::Off { shell },
            _ => Self::Failed { shell },
        }
    }

    /// 終端機裡的灰色提示行（跟「這段會錄影」同一種）。/ The grey notice line in the terminal.
    pub fn notice(&self) -> String {
        let text = match self {
            Self::Off { .. } => "[Telepy] Commands in this shell stay out of its history file.".to_string(),
            Self::Unsupported { shell } => format!("[Telepy] Can't keep commands out of the history in {shell}; they may be saved."),
            Self::Failed { .. } => "[Telepy] Couldn't turn off this shell's history; commands may be saved.".to_string(),
        };
        format!("\x1b[90m{text}\x1b[0m\r\n")
    }

    /// 稽核那一句括號裡的說明。/ The note in parentheses on the audit line.
    pub fn audit_note(&self) -> String {
        match self {
            Self::Off { shell } => format!("shell history off, {shell}"),
            Self::Unsupported { shell } => format!("shell history kept: {shell} is not supported"),
            Self::Failed { shell } => format!("shell history could not be turned off, {shell}"),
        }
    }

    /// agent 工具回傳的 `history`。/ The `history` field of an agent's tool result.
    pub fn status(&self) -> &'static str {
        match self {
            Self::Off { .. } => "off",
            Self::Unsupported { .. } => "unsupported",
            Self::Failed { .. } => "failed",
        }
    }
}

/// 開好 PTY 之後做一次：依登入 shell 打設定、丟掉回顯。回傳 (要照常交出去的輸出, 結論, shell 是否已結束)。
/// Run once a PTY is open: type the setup for the login shell and drop its echo.
pub async fn keep_out(rx: &mut ChannelReadHalf, tx: &ChannelWriteHalf<Msg>, shell: &LoginShell) -> (Outcome, Applied) {
    let nonce = crate::util::random_alnum(12).to_lowercase();
    match plan(shell, &nonce) {
        Prepared::Type(p) => {
            let mut io = ChannelIo::new(rx, tx);
            let out = run(&mut io, &p, &TIMING).await;
            let applied = Applied::from_setup(shell, out.result);
            (out, applied)
        }
        Prepared::NothingSaved => (Outcome { shown: Vec::new(), result: SetupResult::Applied }, Applied::Off { shell: shell.label() }),
        Prepared::Unsupported(name) if *shell == LoginShell::Unknown => (Outcome { shown: Vec::new(), result: SetupResult::NoPrompt }, Applied::Failed { shell: name }),
        Prepared::Unsupported(name) => (Outcome { shown: Vec::new(), result: SetupResult::NoPrompt }, Applied::Unsupported { shell: name }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[test]
    fn modes_and_layers() {
        assert_eq!(Mode::parse("skip"), Some(Mode::Skip));
        assert_eq!(Mode::parse(" keep "), Some(Mode::Keep));
        assert_eq!(Mode::parse("off"), None);
        assert_eq!(effective(Mode::Keep, None), (Mode::Keep, Source::Default));
        assert_eq!(effective(Mode::Keep, Some(Mode::Skip)), (Mode::Skip, Source::Tunnel));
        assert_eq!(effective(Mode::Skip, Some(Mode::Keep)), (Mode::Keep, Source::Tunnel));
    }

    #[test]
    fn probe_output() {
        assert_eq!(parse_probe("/bin/bash\n"), LoginShell::Posix("bash".into()));
        assert_eq!(parse_probe("/usr/bin/zsh \n"), LoginShell::Posix("zsh".into()));
        assert_eq!(parse_probe("Welcome!\n/bin/sh\n"), LoginShell::Posix("sh".into()));
        assert_eq!(parse_probe("/opt/homebrew/bin/fish\n"), LoginShell::Fish);
        assert_eq!(parse_probe("/bin/ksh\n"), LoginShell::Other("ksh".into()));
        assert_eq!(parse_probe("-/bin/bash\n"), LoginShell::Unknown, "a path must start the line");
        assert_eq!(parse_probe("$SHELL $PSHOME\r\n"), LoginShell::Cmd);
        assert_eq!(parse_probe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\r\n"), LoginShell::PowerShell);
        assert_eq!(parse_probe("C:\\Program Files\\PowerShell\\7\r\n"), LoginShell::PowerShell);
        assert_eq!(parse_probe(""), LoginShell::Unknown);
        assert_eq!(parse_probe("PSHOME: Undefined variable.\n"), LoginShell::Unknown);
    }

    #[test]
    fn plans() {
        let Prepared::Type(p) = plan(&LoginShell::Posix("bash".into()), "abc") else { panic!() };
        assert!(p.line.starts_with(' '), "a leading space keeps the line itself out where the shell allows it");
        assert!(p.line.contains("unset HISTFILE") && p.line.contains("HISTFILE=/dev/null"));
        assert!(p.line.contains("telepy-history-off- abc"), "the echo never joins the marker");
        assert!(!p.line.contains(&p.marker));
        assert_eq!(p.marker, "telepy-history-off-abc");
        let Prepared::Type(f) = plan(&LoginShell::Fish, "abc") else { panic!() };
        assert!(f.line.contains("fish_history ''") && !f.line.contains(&f.marker));
        assert_eq!(plan(&LoginShell::Cmd, "abc"), Prepared::NothingSaved);
        assert_eq!(plan(&LoginShell::Other("ksh".into()), "abc"), Prepared::Unsupported("ksh".into()));
        assert_eq!(plan(&LoginShell::PowerShell, "abc"), Prepared::Unsupported("PowerShell".into()));
    }

    /// 假的 shell：腳本化的輸出，記下打了什麼。/ A scripted shell that records what was typed.
    struct Fake {
        rx: mpsc::UnboundedReceiver<Read>,
        typed: mpsc::UnboundedSender<Vec<u8>>,
    }

    impl Io for Fake {
        async fn read(&mut self) -> Read {
            self.rx.recv().await.unwrap_or(Read::Ended(None))
        }
        async fn write(&mut self, data: &[u8]) -> anyhow::Result<()> {
            self.typed.send(data.to_vec())?;
            Ok(())
        }
    }

    const FAST: Timing = Timing {
        prompt_quiet: Duration::from_millis(40),
        prompt_max: Duration::from_millis(600),
        marker_max: Duration::from_millis(300),
        after_quiet: Duration::from_millis(40),
        after_max: Duration::from_millis(300),
    };

    fn fake() -> (Fake, mpsc::UnboundedSender<Read>, mpsc::UnboundedReceiver<Vec<u8>>) {
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let (typed_tx, typed_rx) = mpsc::unbounded_channel();
        (Fake { rx: out_rx, typed: typed_tx }, out_tx, typed_rx)
    }

    fn the_plan() -> Plan {
        let Prepared::Type(p) = plan(&LoginShell::Posix("bash".into()), "n0nce") else { panic!() };
        p
    }

    #[tokio::test]
    async fn the_echo_and_the_second_prompt_are_dropped() {
        let (mut io, out, mut typed) = fake();
        let p = the_plan();
        let marker = p.marker.clone();
        let line = p.line.clone();
        let shell = tokio::spawn(async move {
            out.send(Read::Data(b"Last login: today\r\n$ ".to_vec())).unwrap();
            let got = typed.recv().await.unwrap();
            assert_eq!(got, format!("{line}\r").into_bytes(), "the line ends with Enter");
            out.send(Read::Data(format!("{line}\r\n").into_bytes())).unwrap();
            out.send(Read::Data(format!("{marker}\r\n$ ").into_bytes())).unwrap();
            out
        });
        let o = run(&mut io, &p, &FAST).await;
        assert_eq!(o.result, SetupResult::Applied);
        assert_eq!(o.shown, b"Last login: today\r\n$ ", "only what came before the setup is shown");
        drop(shell.await.unwrap());
    }

    #[tokio::test]
    async fn without_the_marker_everything_is_shown() {
        let (mut io, out, mut typed) = fake();
        let p = the_plan();
        let feeder = tokio::spawn(async move {
            out.send(Read::Data(b"$ ".to_vec())).unwrap();
            typed.recv().await.unwrap();
            out.send(Read::Data(b" HISTFILE=/dev/null\r\nbash: HISTFILE: readonly variable\r\n$ ".to_vec())).unwrap();
            out
        });
        let o = run(&mut io, &p, &FAST).await;
        assert_eq!(o.result, SetupResult::NoMarker);
        assert!(String::from_utf8_lossy(&o.shown).contains("readonly variable"), "the error is not hidden");
        drop(feeder.await.unwrap());
    }

    #[tokio::test]
    async fn no_prompt_means_nothing_is_typed() {
        let (mut io, out, mut typed) = fake();
        let o = run(&mut io, &the_plan(), &FAST).await;
        assert_eq!(o.result, SetupResult::NoPrompt, "nothing printed at all");
        assert!(typed.try_recv().is_err(), "nothing was typed");
        drop(out);
    }

    #[tokio::test]
    async fn a_shell_that_exits_is_reported() {
        let (mut io, out, _typed) = fake();
        out.send(Read::Data(b"This account is currently not available.\r\n".to_vec())).unwrap();
        out.send(Read::Ended(Some(1))).unwrap();
        let o = run(&mut io, &the_plan(), &FAST).await;
        assert_eq!(o.result, SetupResult::Ended(Some(1)));
        assert_eq!(o.shown, b"This account is currently not available.\r\n");
    }

    #[test]
    fn notices_and_notes() {
        let off = Applied::from_setup(&LoginShell::Posix("zsh".into()), SetupResult::Applied);
        assert_eq!(off, Applied::Off { shell: "zsh".into() });
        assert!(off.notice().contains("stay out of its history"));
        assert_eq!(off.audit_note(), "shell history off, zsh");
        assert_eq!(off.status(), "off");
        let failed = Applied::from_setup(&LoginShell::Fish, SetupResult::NoMarker);
        assert_eq!(failed.status(), "failed");
        assert!(Applied::Unsupported { shell: "ksh".into() }.notice().contains("in ksh"));
    }
}
