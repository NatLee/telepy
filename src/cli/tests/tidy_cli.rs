//! `telepy config tidy` 端到端：不登入就能跑；沒有終端機、沒給 --yes 時只列出不寫；--check 只回報、能更短就結束碼 1；
//! --yes 先備份成 `<檔名>.bak` 再寫、權限不變；寫完再跑一次就沒事可做。
//! `telepy config tidy` end to end: runs without signing in; without a terminal or --yes it only reports; --check
//! exits 1 when the file could be shorter; --yes backs up to `<file>.bak` first and keeps the permissions; a second
//! run has nothing left to do.

use std::process::{Command, Output, Stdio};

const CONFIG: &str = "Host web1\n    HostName web1.example.com\n    User deploy\n    User deploy\n\nHost web2\n    HostName web2.example.com\n    User deploy\n\nHost db\n    HostName 10.0.0.5\n    User deploy\n";

fn telepy(home: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_telepy"))
        .args(args)
        .env("HOME", home)
        .env("TELEPY_CONFIG_DIR", home.join("config"))
        .env("TELEPY_NO_KEYRING", "1")
        .env("TELEPY_NO_UPDATE_CHECK", "1")
        .env("NO_COLOR", "1")
        .env_remove("TELEPY_URL")
        .env_remove("TELEPY_TOKEN")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn tidy_reports_checks_and_writes_with_a_backup() {
    let tmp = tempfile::tempdir().unwrap();
    let ssh = tmp.path().join(".ssh");
    std::fs::create_dir_all(&ssh).unwrap();
    let cfg = ssh.join("config");
    std::fs::write(&cfg, CONFIG).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cfg, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    // 沒有終端機、沒給 --yes：只列出，不寫。/ No terminal, no --yes: report only.
    let out = telepy(tmp.path(), &["config", "tidy"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout}{}", String::from_utf8_lossy(&out.stderr));
    assert!(stdout.contains("12 -> 6 lines") && stdout.contains("Checked 3 names"), "{stdout}");
    assert!(stdout.contains("line 4: User is set again in the same block (Host web1)"), "{stdout}");
    assert!(stdout.contains("+    HostName %h.example.com"), "{stdout}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("Run again with --yes"));
    assert_eq!(std::fs::read_to_string(&cfg).unwrap(), CONFIG, "not written");

    // --check：能更短 → 1。/ --check: could be shorter → 1.
    assert_eq!(telepy(tmp.path(), &["config", "tidy", "--check"]).status.code(), Some(1));

    // --yes：先備份再寫。/ --yes: back up, then write.
    let out = telepy(tmp.path(), &["config", "tidy", "--yes"]);
    assert!(out.status.success());
    assert_eq!(std::fs::read_to_string(ssh.join("config.bak")).unwrap(), CONFIG);
    let written = std::fs::read_to_string(&cfg).unwrap();
    assert_eq!(written, "Host db\n    HostName 10.0.0.5\n\nHost web1 web2 db\n    HostName %h.example.com\n    User deploy\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&cfg).unwrap().permissions().mode() & 0o777, 0o600, "permissions kept");
    }

    // 再跑一次：沒事可做，--check 通過。/ Again: nothing to do, --check passes.
    let out = telepy(tmp.path(), &["config", "tidy", "--check"]);
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stdout));
    assert!(String::from_utf8_lossy(&out.stdout).contains("nothing to simplify"));

    // 不存在的檔：說清楚。/ A missing file is reported plainly.
    let out = telepy(tmp.path(), &["config", "tidy", "--file", tmp.path().join("nope").to_str().unwrap()]);
    assert!(!out.status.success() && String::from_utf8_lossy(&out.stderr).contains("reading"), "{}", String::from_utf8_lossy(&out.stderr));
}
