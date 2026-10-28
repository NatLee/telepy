//! 輸出接到已經關掉的管線（`telepy doctor | head -1` 讀完就走）：安靜結束（被 SIGPIPE 結束，跟其他命令列工具一樣），
//! 不是 Rust 的 `failed printing to stdout: Broken pipe` panic。管線的讀端在 telepy 啟動前就關掉，所以第一次寫就一定失敗。
//! Output into a pipe that is already closed (`telepy doctor | head -1` leaving early): telepy ends quietly (by
//! SIGPIPE, like other command-line tools) instead of Rust's `failed printing to stdout: Broken pipe` panic. The
//! read end is closed before telepy starts, so its very first write fails.
#![cfg(unix)]

use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};

#[test]
fn a_closed_pipe_ends_telepy_quietly() {
    let tmp = tempfile::tempdir().unwrap();
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    let out = Command::new(env!("CARGO_BIN_EXE_telepy"))
        .arg("doctor")
        .env("HOME", tmp.path())
        .env("TELEPY_CONFIG_DIR", tmp.path().join("config"))
        .env("TELEPY_SSH_DIR", tmp.path().join("ssh"))
        .env("TELEPY_NO_KEYRING", "1")
        .env_remove("TELEPY_URL")
        .env_remove("TELEPY_TOKEN")
        .stdout(Stdio::from(writer))
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!stderr.contains("panicked") && !stderr.contains("Broken pipe"), "no panic, nothing printed: {stderr}");
    assert_eq!(out.status.signal(), Some(libc::SIGPIPE), "ended by SIGPIPE like other tools: {:?}", out.status);
}
