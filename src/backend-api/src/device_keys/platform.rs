//! 裝置是不是 Windows、哪些帳號是本機 Administrators：Windows 的 OpenSSH 對管理員**不看** `~/.ssh/authorized_keys`，
//! 只讀 `%ProgramData%\ssh\administrators_authorized_keys`（所有管理員共用一個檔案），所以 Telepy 得知道把金鑰寫去哪。
//! 每台裝置探測一次（`uname -s` 失敗 → 跑一段 PowerShell 印 `$env:ProgramData` 與 Administrators 的成員），
//! 結果快取 `TTL`；「立即同步」會重新探測。解析是純函式。
//! Is the device Windows, and which accounts are local Administrators? Win32-OpenSSH ignores an administrator's
//! `~/.ssh/authorized_keys` and reads `%ProgramData%\ssh\administrators_authorized_keys` (shared by every admin)
//! instead, so Telepy must know where a key goes. Probed once per device (`uname -s` fails → one PowerShell
//! command prints `$env:ProgramData` and the group's members), cached for `TTL`; "sync now" re-probes. Pure parsers.
//!
//! 真 Windows 的注意事項 / Caveats on a real Windows box:
//! - 需要 PowerShell 5.1+ 的 `Microsoft.PowerShell.LocalAccounts`（Windows 10 / Server 2016 起都有）；
//!   探測失敗就當成不是 Windows（金鑰寫到 `~/.ssh/authorized_keys`，非管理員帳號照常可用），錯誤顯示在面板。
//! - 群組用 SID `S-1-5-32-544` 查，不受語系影響；網域帳號以 `DOMAIN\name` 回來，只比對最後一段。
//! - 這個檔案的 ACL 必須只有 Administrators 與 SYSTEM，所以它**就地改寫**而不是「暫存檔 + rename」（見 `remote.rs`）。

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use crate::ssh::exec;
use crate::state::AppState;

/// 探測結果的快取時間。/ How long a probe result is trusted.
pub const TTL: Duration = Duration::from_secs(3600);
/// 探測失敗（channel 開不起來、逾時）多久後再試。/ Retry a failed probe after this long.
pub const RETRY: Duration = Duration::from_secs(300);
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: usize = 64 * 1024;
/// 管理員金鑰檔的目錄與檔名（相對 `%ProgramData%`）。/ The admin key file under `%ProgramData%`.
pub const ADMIN_FILE: &str = "ssh/administrators_authorized_keys";
/// 面板上顯示的檔名。/ The file names shown in the panel.
pub const USER_FILE_LABEL: &str = "~/.ssh/authorized_keys";
pub const ADMIN_FILE_LABEL: &str = "%ProgramData%\\ssh\\administrators_authorized_keys";

const MARK: &str = "---telepy---";

/// 在 Windows 上跑的探測指令：第一行 `%ProgramData%`，分隔行之後每行一個 Administrators 成員。
/// The probe command on Windows: `%ProgramData%` first, then one Administrators member per line after the marker.
pub fn probe_command() -> String {
    format!("powershell -NoProfile -NonInteractive -Command \"$env:ProgramData; '{MARK}'; Get-LocalGroupMember -SID S-1-5-32-544 | ForEach-Object {{ $_.Name }}\"")
}

/// 一台裝置的平台資訊。/ What we know about a device's platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Platform {
    pub windows: bool,
    /// `%ProgramData%` 的 SFTP 路徑（例如 `/C:/ProgramData`）。/ `%ProgramData%` as an SFTP path (e.g. `/C:/ProgramData`).
    pub program_data: Option<String>,
    /// 本機 Administrators 的成員（小寫，不含網域）。/ Local Administrators (lower-cased, domain stripped).
    pub admins: BTreeSet<String>,
    /// 探測失敗的原因（當成不是 Windows）。/ Why the probe failed (treated as not Windows).
    pub error: Option<String>,
}

impl Platform {
    pub fn not_windows() -> Self {
        Self { windows: false, program_data: None, admins: BTreeSet::new(), error: None }
    }

    /// 這個帳號是 Windows 管理員（金鑰要寫到共用的管理員檔）。/ The account is a Windows administrator.
    pub fn is_admin(&self, account: &str) -> bool {
        self.windows && self.admins.contains(&short_name(account))
    }

    /// 這個帳號的 authorized_keys 在哪：(SFTP 路徑；None = 帳號自己的 `~/.ssh`, 顯示用檔名, 是不是管理員檔)。
    /// Where the account's keys live: (SFTP path; None = its own `~/.ssh`, display label, admin file?).
    pub fn file_for(&self, account: &str) -> (Option<String>, &'static str, bool) {
        match (&self.program_data, self.is_admin(account)) {
            (Some(pd), true) => (Some(format!("{pd}/{ADMIN_FILE}")), ADMIN_FILE_LABEL, true),
            _ => (None, USER_FILE_LABEL, false),
        }
    }
}

/// 帳號名的最後一段、小寫（`DESKTOP\\Nat` → `nat`）。/ The last segment, lower-cased.
pub fn short_name(name: &str) -> String {
    name.rsplit(['\\', '/']).next().unwrap_or(name).trim().to_ascii_lowercase()
}

/// 探測輸出 → (`%ProgramData%` 原文, 成員)。沒有分隔行或沒有 ProgramData 就是 None。
/// Probe output → (`%ProgramData%` as printed, members). None without the marker or the path.
pub fn parse_probe(out: &str) -> Option<(String, BTreeSet<String>)> {
    let mut lines = out.lines().map(str::trim);
    let mut program_data = None;
    for l in lines.by_ref() {
        if l == MARK {
            break;
        }
        if !l.is_empty() && program_data.is_none() {
            program_data = Some(l.to_string());
        }
    }
    if !out.contains(MARK) {
        return None;
    }
    let admins = lines.filter(|l| !l.is_empty()).map(short_name).collect();
    Some((program_data?, admins))
}

/// `C:\ProgramData` → `/C:/ProgramData`（Win32-OpenSSH 的 sftp-server 路徑）；已是 POSIX 路徑就原樣（去掉結尾的 `/`）。
/// Windows path → the SFTP form; a POSIX path (the lab) is kept.
pub fn sftp_path(program_data: &str) -> String {
    let p = program_data.trim();
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let rest = p[2..].replace('\\', "/");
        format!("/{}:{}", p[..1].to_ascii_uppercase(), rest.trim_end_matches('/'))
    } else {
        p.trim_end_matches('/').to_string()
    }
}

/// 探測一台裝置（用 `username` 登入，連線向池借）。/ Probe one device, logged in as `username`.
pub async fn probe(state: &AppState, reverse_port: i64, username: &str) -> Platform {
    let run = |cmd: String| async move {
        let (_lease, ch) = state.pool.session_channel(state, reverse_port, username).await?;
        let r = exec::run_on(ch, &cmd, EXEC_TIMEOUT, OUTPUT_LIMIT).await?;
        anyhow::Ok((r.exit_code, r.stdout.text))
    };
    probe_with(run).await
}

/// `probe` 的本體（可注入 exec）。/ `probe` over an injectable exec.
pub async fn probe_with<F, Fut>(run: F) -> Platform
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<(Option<u32>, String)>>,
{
    // uname 跑得起來（exit 0）就不是 Windows；跑不起來（cmd.exe 的 9009、PowerShell 的 1）才問 PowerShell。
    // A working `uname` means not Windows; only a failing one (9009 under cmd.exe, 1 under PowerShell) asks PowerShell.
    match run("uname -s".to_string()).await {
        Ok((Some(0), _)) => return Platform::not_windows(),
        Ok(_) => {}
        Err(e) => return Platform { error: Some(format!("{e:#}")), ..Platform::not_windows() },
    }
    match run(probe_command()).await {
        Ok((Some(0), out)) => match parse_probe(&out) {
            Some((pd, admins)) => Platform { windows: true, program_data: Some(sftp_path(&pd)), admins, error: None },
            None => Platform::not_windows(),
        },
        Ok((code, _)) => Platform { error: Some(format!("the device has neither uname nor PowerShell's local-accounts module (exit {code:?})")), ..Platform::not_windows() },
        Err(e) => Platform { error: Some(format!("{e:#}")), ..Platform::not_windows() },
    }
}

/// 快取的一筆。/ One cache entry.
#[derive(Debug, Clone)]
pub struct Cached {
    pub platform: Platform,
    pub at: Instant,
}

impl Cached {
    pub fn fresh(&self, now: Instant) -> bool {
        let ttl = if self.platform.error.is_some() { RETRY } else { TTL };
        now.duration_since(self.at) < ttl
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn parses_program_data_and_members() {
        let out = format!("C:\\ProgramData\r\n{MARK}\r\nDESKTOP-1\\Administrator\r\nDESKTOP-1\\Nat\r\nCORP\\ops team\r\n");
        let (pd, admins) = parse_probe(&out).unwrap();
        assert_eq!(pd, "C:\\ProgramData");
        assert_eq!(admins, BTreeSet::from(["administrator".to_string(), "nat".to_string(), "ops team".to_string()]));
        assert!(parse_probe("no marker here").is_none());
        assert!(parse_probe(&format!("{MARK}\nAdmin\n")).is_none(), "ProgramData is required");
    }

    #[test]
    fn windows_paths_become_sftp_paths() {
        assert_eq!(sftp_path("C:\\ProgramData"), "/C:/ProgramData");
        assert_eq!(sftp_path("d:\\Data\\"), "/D:/Data");
        assert_eq!(sftp_path("/tmp/lab/ProgramData/"), "/tmp/lab/ProgramData");
    }

    #[test]
    fn admin_file_only_for_windows_admins() {
        let mut p = Platform { windows: true, program_data: Some("/C:/ProgramData".into()), admins: BTreeSet::from(["nat".to_string()]), error: None };
        assert!(p.is_admin("NAT") && p.is_admin("desktop\\nat") && !p.is_admin("guest"));
        assert_eq!(p.file_for("nat"), (Some("/C:/ProgramData/ssh/administrators_authorized_keys".into()), ADMIN_FILE_LABEL, true));
        assert_eq!(p.file_for("guest"), (None, USER_FILE_LABEL, false));
        p.windows = false;
        assert!(!p.is_admin("nat"));
    }

    struct Fake {
        answers: Mutex<Vec<(Option<u32>, String)>>,
        commands: Mutex<Vec<String>>,
    }

    impl Fake {
        async fn run(&self, cmd: String) -> anyhow::Result<(Option<u32>, String)> {
            self.commands.lock().unwrap().push(cmd);
            let mut a = self.answers.lock().unwrap();
            if a.is_empty() {
                anyhow::bail!("no channel");
            }
            Ok(a.remove(0))
        }
    }

    #[tokio::test]
    async fn probe_stops_at_a_working_uname() {
        let f = Fake { answers: Mutex::new(vec![(Some(0), "Linux\n".into())]), commands: Mutex::new(vec![]) };
        let p = probe_with(|c| f.run(c)).await;
        assert_eq!(p, Platform::not_windows());
        assert_eq!(f.commands.lock().unwrap().as_slice(), ["uname -s"]);
    }

    #[tokio::test]
    async fn probe_asks_powershell_when_uname_fails() {
        let out = format!("C:\\ProgramData\n{MARK}\nBOX\\Administrator\nBOX\\nat\n");
        let f = Fake { answers: Mutex::new(vec![(Some(9009), String::new()), (Some(0), out)]), commands: Mutex::new(vec![]) };
        let p = probe_with(|c| f.run(c)).await;
        assert!(p.windows && p.is_admin("nat") && !p.is_admin("bob"));
        assert_eq!(p.program_data.as_deref(), Some("/C:/ProgramData"));
        assert_eq!(f.commands.lock().unwrap().len(), 2);
        // 兩個都失敗：不是 Windows，但記下原因。/ Both failing: not Windows, with the reason kept.
        let f = Fake { answers: Mutex::new(vec![(Some(127), String::new()), (Some(127), String::new())]), commands: Mutex::new(vec![]) };
        let p = probe_with(|c| f.run(c)).await;
        assert!(!p.windows && p.error.is_some());
        // 連 channel 都開不起來：記錯誤、短時間後重試。/ No channel at all: error, retried sooner.
        let f = Fake { answers: Mutex::new(vec![]), commands: Mutex::new(vec![]) };
        let p = probe_with(|c| f.run(c)).await;
        assert!(p.error.is_some());
        let c = Cached { platform: p, at: Instant::now() - RETRY };
        assert!(!c.fresh(Instant::now()));
    }
}
