//! OpenSSH 客戶端子程序：只剩區網主機那一跳（最後一跳要能在 PTY 裡問密碼 / 鍵盤互動）。裝置本身的終端機、
//! 檔案管理、遠端瀏覽器都改走連線池（russh），不再 spawn ssh。
//! 終止語意不變：只殺直屬子程序（SIGTERM → SIGKILL），絕不 killpg。
//! The OpenSSH client is only used for the LAN host hop now (password / keyboard-interactive prompts in a PTY).

use std::io;
use std::path::{Path, PathBuf};
use std::os::fd::{AsRawFd, OwnedFd};
use std::process::Stdio;
use std::time::Duration;

use nix::fcntl::{fcntl, FcntlArg, OFlag};
use nix::pty::openpty;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use tokio::io::unix::AsyncFd;
use tokio::process::{Child, Command};

/// 區網機器的登入帳號：英數與 `._-`，1–64 字、不以 `-` 開頭。/ A safe login name for a LAN host.
pub fn valid_login(s: &str) -> bool {
    (1..=64).contains(&s.len()) && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// 經裝置跳到它區網裡的機器（#20）的最後一跳：連 `ssh::bridge` 開在 `127.0.0.1:<local_port>` 的一次性入口
/// （第一跳由連線池那條裝置連線的 direct-tcpip 負責）。允許密碼 / 鍵盤互動登入，提示直接出現在網頁終端機裡；
/// `HostKeyAlias` 用區網主機的位址。/ The final hop to a LAN host, dialing the bridge's loopback entry point.
pub fn lan_terminal_args(lan_user: &str, lan_host: &str, local_port: u16) -> Vec<String> {
    let mut v: Vec<String> = [
        "-o", "GSSAPIAuthentication=no",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "Compression=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    v.extend(["-o".into(), format!("HostKeyAlias={lan_host}"), "-l".into(), lan_user.to_string(), "-p".into(), local_port.to_string(), "127.0.0.1".into()]);
    v
}

/// 區網那一跳怎麼登入。/ How the LAN hop authenticates.
#[derive(Debug, Clone, Default)]
pub enum LanAuth {
    /// Telepy 自己的金鑰：這條隧道的服務金鑰（OpenSSH 格式的私鑰）加上共用的服務金鑰檔；都不行就在終端機裡問密碼。
    /// Telepy's own keys: the tunnel's service key (OpenSSH private key text) plus the shared identity file; else a prompt.
    #[default]
    Telepy,
    /// 不出示金鑰，直接在終端機裡問密碼。/ Offer no key; ask for the password in the terminal.
    Prompt,
    /// 憑證庫的登入：私鑰和 / 或密碼（密碼由 askpass 交給 OpenSSH，不進 PTY）。/ A saved login: key and / or password (via askpass).
    Credential { private_key: String, password: String },
}

/// 區網那一跳的金鑰 / 密碼檔（0600 的暫存目錄，session 結束就刪）與對應的 ssh 參數和環境變數。
/// The hop's key / password files (a 0600 temp dir, removed when the session ends) plus the ssh args and env.
pub struct LanAuthFiles {
    _dir: tempfile::TempDir,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
}

/// 準備區網那一跳的認證：把要用的私鑰寫成 0600 的檔、密碼交給一個小 askpass 腳本（`SSH_ASKPASS_REQUIRE=force`，
/// OpenSSH 向它要密碼，密碼不經過 PTY 也不在命令列上）。沒有金鑰就關掉公鑰認證，提示會出現在終端機裡。
/// Prepares the hop's authentication: keys as 0600 files, the password behind a tiny askpass script
/// (`SSH_ASKPASS_REQUIRE=force`: OpenSSH asks it, so the password never crosses the PTY or the command line).
/// Without a key, public-key auth is turned off and the prompt shows in the terminal.
pub fn prepare_lan_auth(auth: &LanAuth, tunnel_key: Option<&str>, shared_identity: Option<&Path>) -> io::Result<LanAuthFiles> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let dir = tempfile::Builder::new().prefix("telepy-lan-").tempdir()?;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
    let write = |name: &str, content: &str, mode: u32| -> io::Result<PathBuf> {
        let path = dir.path().join(name);
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(&path)?;
        use std::io::Write;
        f.write_all(content.as_bytes())?;
        if !content.ends_with('\n') {
            f.write_all(b"\n")?;
        }
        Ok(path)
    };
    let mut args: Vec<String> = Vec::new();
    let mut envs: Vec<(String, String)> = Vec::new();
    let mut keys: Vec<PathBuf> = Vec::new();
    let mut password: Option<String> = None;
    match auth {
        LanAuth::Telepy => {
            if let Some(pem) = tunnel_key {
                keys.push(write("tunnel_key", pem, 0o600)?);
            }
            if let Some(p) = shared_identity.filter(|p| p.is_file()) {
                keys.push(p.to_path_buf());
            }
        }
        LanAuth::Prompt => {}
        LanAuth::Credential { private_key, password: pw } => {
            if !private_key.is_empty() {
                keys.push(write("key", private_key, 0o600)?);
            }
            if !pw.is_empty() {
                password = Some(pw.clone());
            }
        }
    }
    if keys.is_empty() {
        args.extend(["-o".into(), "PubkeyAuthentication=no".into()]);
    } else {
        args.extend(["-o".into(), "IdentitiesOnly=yes".into()]);
        for k in &keys {
            args.extend(["-i".into(), k.to_string_lossy().into_owned()]);
        }
    }
    args.extend(["-o".into(), "PreferredAuthentications=publickey,keyboard-interactive,password".into()]);
    if let Some(pw) = password {
        let pw_file = write("pw", &pw, 0o600)?;
        let script = format!("#!/bin/sh\ncat {}\n", shq(&pw_file.to_string_lossy()));
        let askpass = write("askpass", &script, 0o700)?;
        envs.push(("SSH_ASKPASS".into(), askpass.to_string_lossy().into_owned()));
        envs.push(("SSH_ASKPASS_REQUIRE".into(), "force".into()));
        envs.push(("DISPLAY".into(), "telepy:0".into()));
        // 密碼錯了就是錯了，不要連問三次。/ A wrong password is wrong; do not ask three times.
        args.extend(["-o".into(), "NumberOfPasswordPrompts=1".into()]);
    }
    Ok(LanAuthFiles { _dir: dir, args, envs })
}

/// 給 sh 的單引號。/ Single-quote for sh.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 在 PTY 裡跑的子程序（terminal）。master 為非阻塞 + AsyncFd。
pub struct PtyChild {
    pub child: Child,
    pub master: AsyncFd<OwnedFd>,
}

/// openpty → 子程序以 slave 當 stdin/stdout/stderr 並成為 session leader / 控制終端。
/// 走 tokio `Command`（fork 後只呼叫 async-signal-safe 的 setsid/ioctl），不自己 forkpty。
pub fn spawn_in_pty(program: &str, args: &[String], envs: &[(String, String)]) -> io::Result<PtyChild> {
    let pty = openpty(None, None).map_err(io::Error::from)?;
    let master = pty.master;
    let slave = pty.slave;

    let flags = fcntl(master.as_raw_fd(), FcntlArg::F_GETFL).map_err(io::Error::from)?;
    let flags = OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK;
    fcntl(master.as_raw_fd(), FcntlArg::F_SETFL(flags)).map_err(io::Error::from)?;

    let slave_file: std::fs::File = slave.into();
    let mut cmd = Command::new(program);
    cmd.args(args)
        .envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .env("TERM", "xterm")
        .stdin(Stdio::from(slave_file.try_clone()?))
        .stdout(Stdio::from(slave_file.try_clone()?))
        .stderr(Stdio::from(slave_file));
    // SAFETY: 只呼叫 async-signal-safe 的 setsid / ioctl。
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    // SAFETY: `master` 是我們剛建立、唯一持有的 fd；關閉前會先 deregister（drop AsyncFd）。
    let master = unsafe { AsyncFd::register(master) }.map_err(|e| io::Error::other(format!("{e:?}")))?;
    Ok(PtyChild { child, master })
}

impl PtyChild {
    /// 讀 master；EOF（含 Linux 在 slave 關閉後的 EIO）回 Ok(0)。
    pub async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut guard = self.master.readable().await?;
            let res = guard.try_io(|inner| {
                let n = unsafe { libc::read(inner.as_raw_fd(), buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
                if n < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(n as usize)
                }
            });
            match res {
                Ok(Ok(n)) => return Ok(n),
                Ok(Err(e)) if e.raw_os_error() == Some(libc::EIO) => return Ok(0),
                Ok(Err(e)) => return Err(e),
                Err(_would_block) => continue,
            }
        }
    }

    /// 非阻塞寫入：緩衝區滿就丟棄剩餘並回傳已寫入長度（與 Django 版相同，絕不阻塞 event loop）。
    pub fn write_nonblocking(&self, mut data: &[u8]) -> io::Result<usize> {
        let mut written = 0;
        while !data.is_empty() {
            let n = unsafe { libc::write(self.master.as_raw_fd(), data.as_ptr() as *const libc::c_void, data.len()) };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::WouldBlock {
                    tracing::warn!("PTY buffer full; dropping remaining terminal input");
                    return Ok(written);
                }
                return Err(e);
            }
            written += n as usize;
            data = &data[n as usize..];
        }
        Ok(written)
    }

    /// `TIOCSWINSZ`
    pub fn resize(&self, rows: u16, cols: u16, width: u16, height: u16) -> io::Result<()> {
        let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: width, ws_ypixel: height };
        let r = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws as *const libc::winsize) };
        if r == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// 只對直屬子程序送 SIGTERM，輪詢最多 ~0.5s 後 SIGKILL。絕不 killpg（會殺到 ControlMaster 的 proxy）。
    pub async fn terminate(&mut self) {
        terminate_child(&mut self.child, Duration::from_millis(500)).await;
    }
}

/// SIGTERM → 等 grace → SIGKILL；回收 zombie。
pub async fn terminate_child(child: &mut Child, grace: Duration) {
    if let Some(pid) = child.id() {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    if tokio::time::timeout(grace, child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_hop_arguments() {
        let args = lan_terminal_args("admin", "192.168.1.20", 40123);
        assert_eq!(&args[args.len() - 5..], &["-l", "admin", "-p", "40123", "127.0.0.1"]);
        assert!(args.windows(2).any(|w| w == ["-o", "HostKeyAlias=192.168.1.20"]), "{args:?}");
        assert!(!args.iter().any(|a| a.contains("ProxyCommand")), "the first hop is the pool bridge now");
        assert!(valid_login("admin") && valid_login("svc.backup_01"));
        assert!(!valid_login("-oProxyCommand=x") && !valid_login("a b") && !valid_login("a;b") && !valid_login(""));
    }

    /// 三種登入方式各自給 OpenSSH 什麼：金鑰檔（0600、IdentitiesOnly）、不出示金鑰、askpass 交密碼。
    /// What each login choice hands OpenSSH: 0600 key files with IdentitiesOnly, no key at all, the password via askpass.
    #[test]
    fn lan_hop_auth_files() {
        use std::os::unix::fs::PermissionsExt;
        let shared = tempfile::NamedTempFile::new().unwrap();
        let pref = "PreferredAuthentications=publickey,keyboard-interactive,password".to_string();

        let f = prepare_lan_auth(&LanAuth::Telepy, Some("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----"), Some(shared.path())).unwrap();
        let keys: Vec<&String> = f.args.windows(2).filter(|w| w[0] == "-i").map(|w| &w[1]).collect();
        assert_eq!(keys.len(), 2, "{:?}", f.args);
        assert!(keys[0].ends_with("/tunnel_key") && keys[1] == &shared.path().to_string_lossy());
        assert_eq!(std::fs::metadata(keys[0]).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(f.args.contains(&"IdentitiesOnly=yes".to_string()) && f.args.contains(&pref));
        assert!(f.envs.is_empty());
        // 沒有隧道金鑰、共用金鑰檔也不存在 → 跟 prompt 一樣。/ No tunnel key and no shared file → like prompt.
        let f = prepare_lan_auth(&LanAuth::Telepy, None, Some(std::path::Path::new("/nonexistent/id"))).unwrap();
        assert!(f.args.contains(&"PubkeyAuthentication=no".to_string()) && !f.args.contains(&"-i".to_string()));

        let f = prepare_lan_auth(&LanAuth::Prompt, Some("k"), Some(shared.path())).unwrap();
        assert!(f.args.contains(&"PubkeyAuthentication=no".to_string()) && !f.args.contains(&"-i".to_string()));

        let auth = LanAuth::Credential { private_key: "KEY".into(), password: "it's s3cret".into() };
        let f = prepare_lan_auth(&auth, Some("tunnel"), Some(shared.path())).unwrap();
        let keys: Vec<&String> = f.args.windows(2).filter(|w| w[0] == "-i").map(|w| &w[1]).collect();
        assert_eq!(keys.len(), 1, "a saved login never adds Telepy's keys: {:?}", f.args);
        assert!(keys[0].ends_with("/key"));
        assert!(f.args.contains(&"NumberOfPasswordPrompts=1".to_string()));
        let env: std::collections::HashMap<_, _> = f.envs.iter().cloned().collect();
        assert_eq!(env.get("SSH_ASKPASS_REQUIRE").map(String::as_str), Some("force"));
        let askpass = env.get("SSH_ASKPASS").unwrap();
        assert_eq!(std::fs::metadata(askpass).unwrap().permissions().mode() & 0o777, 0o700);
        let out = std::process::Command::new(askpass).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end(), "it's s3cret");
        let dir = std::path::Path::new(askpass).parent().unwrap().to_path_buf();
        drop(f);
        assert!(!dir.exists(), "the temp dir goes with the session");
    }

    #[tokio::test]
    async fn pty_roundtrip_with_cat() {
        let mut p = spawn_in_pty("cat", &[], &[]).unwrap();
        p.resize(24, 80, 720, 480).unwrap();
        p.write_nonblocking(b"hello\n").unwrap();
        let mut buf = [0u8; 256];
        let mut out = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&out).contains("hello") && tokio::time::Instant::now() < deadline {
            let n = tokio::time::timeout(Duration::from_secs(2), p.read(&mut buf)).await.unwrap().unwrap();
            out.extend_from_slice(&buf[..n]);
        }
        assert!(String::from_utf8_lossy(&out).contains("hello"));
        p.terminate().await;
        assert!(p.child.try_wait().unwrap().is_some(), "child must be reaped");
    }
}
