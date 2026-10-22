//! OpenSSH 客戶端子程序。保留 Django 版的所有連線參數與終止語意：
//! - terminal：ControlMaster=auto 多工重用、只殺「直屬子程序」（絕不 killpg，見 docs 與 consumers.py 註解）
//! - file manager：一條 `ssh … cat` 當 ControlMaster，之後每個指令走同一個 ControlPath
//! OpenSSH client subprocesses with the same options and teardown rules as the Django consumers.

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::process::Stdio;
use std::time::Duration;

use nix::fcntl::{fcntl, FcntlArg, OFlag};
use nix::pty::openpty;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use tokio::io::unix::AsyncFd;
use tokio::process::{Child, Command};

use crate::config::Config;

/// `user@host -p port`
#[derive(Debug, Clone)]
pub struct SshTarget {
    pub user: String,
    pub host: String,
    pub port: i64,
}

impl SshTarget {
    pub fn new(config: &Config, username: &str, reverse_port: i64) -> Self {
        Self { user: username.to_string(), host: config.ssh_target_host.clone(), port: reverse_port }
    }
    pub fn userhost(&self) -> String {
        format!("{}@{}", self.user, self.host)
    }
}

/// TerminalConsumer 的 ssh 參數：關 GSSAPI、只用公鑰、壓縮、ControlMaster 多工（省掉重複 handshake）。
pub fn terminal_args(t: &SshTarget) -> Vec<String> {
    [
        "-o", "GSSAPIAuthentication=no",
        "-o", "PreferredAuthentications=publickey",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "Compression=yes",
        "-o", "ControlMaster=auto",
        "-o", "ControlPersist=600",
        "-o", "ControlPath=/tmp/ssh_term_%r@%h:%p",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([t.userhost(), "-p".to_string(), t.port.to_string()])
    .collect()
}

/// 單引號跳脫一個 shell 參數（`ProxyCommand` 會交給 `/bin/sh -c`）。/ Single-quote one shell word.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 區網機器的登入帳號：英數與 `._-`，1–64 字、不以 `-` 開頭。/ A safe login name for a LAN host.
pub fn valid_login(s: &str) -> bool {
    (1..=64).contains(&s.len()) && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// 經裝置跳到它區網裡的機器（#20）：第一跳是平常的裝置連線（服務金鑰、`-W` 由裝置 sshd 轉送），
/// 最後一跳允許密碼 / 鍵盤互動登入，提示直接出現在網頁終端機裡。
/// Through the device to a machine on its LAN: the device hop is the usual key login and forwards with
/// `-W`; the final hop also allows password / keyboard-interactive prompts, shown in the web terminal.
pub fn lan_terminal_args(ssh_binary: &str, device: &SshTarget, lan_user: &str, lan_host: &str, lan_port: i64) -> Vec<String> {
    let proxy = format!(
        "{} -o GSSAPIAuthentication=no -o BatchMode=yes -o PreferredAuthentications=publickey -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -W %h:%p -p {} {}",
        shell_quote(ssh_binary),
        device.port,
        shell_quote(&device.userhost())
    );
    [
        "-o", "GSSAPIAuthentication=no",
        "-o", "PreferredAuthentications=publickey,keyboard-interactive,password",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "Compression=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([format!("ProxyCommand={proxy}"), "-l".into(), lan_user.to_string(), "-p".into(), lan_port.to_string(), lan_host.to_string()])
    .collect()
}

const FM_COMMON: [&str; 6] = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"];

/// FileManagerConsumer 的常駐連線：`ssh … cat`（ControlMaster=yes）。
pub fn filemanager_master_args(t: &SshTarget) -> Vec<String> {
    let mut v: Vec<String> = vec!["-p".into(), t.port.to_string(), "-o".into(), "ControlMaster=yes".into(), "-o".into(), "ControlPath=/tmp/ssh_fm_%r@%h:%p".into(), "-o".into(), "ControlPersist=600".into()];
    v.extend(FM_COMMON.iter().map(|s| s.to_string()));
    v.push(t.userhost());
    v.push("cat".into());
    v
}

/// FileManagerConsumer 的單次指令（重用 master 的 ControlPath）。
pub fn filemanager_exec_args(t: &SshTarget, command: &str) -> Vec<String> {
    let mut v: Vec<String> = vec!["-p".into(), t.port.to_string(), "-o".into(), "ControlPath=/tmp/ssh_fm_%r@%h:%p".into()];
    v.extend(FM_COMMON.iter().map(|s| s.to_string()));
    v.push(t.userhost());
    v.push(command.to_string());
    v
}

/// 在 PTY 裡跑的子程序（terminal）。master 為非阻塞 + AsyncFd。
pub struct PtyChild {
    pub child: Child,
    pub master: AsyncFd<OwnedFd>,
}

/// openpty → 子程序以 slave 當 stdin/stdout/stderr 並成為 session leader / 控制終端。
/// 走 tokio `Command`（fork 後只呼叫 async-signal-safe 的 setsid/ioctl），不自己 forkpty。
pub fn spawn_in_pty(program: &str, args: &[String]) -> io::Result<PtyChild> {
    let pty = openpty(None, None).map_err(io::Error::from)?;
    let master = pty.master;
    let slave = pty.slave;

    let flags = fcntl(master.as_raw_fd(), FcntlArg::F_GETFL).map_err(io::Error::from)?;
    let flags = OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK;
    fcntl(master.as_raw_fd(), FcntlArg::F_SETFL(flags)).map_err(io::Error::from)?;

    let slave_file: std::fs::File = slave.into();
    let mut cmd = Command::new(program);
    cmd.args(args)
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

    #[test]
    fn lan_hop_arguments_are_quoted() {
        let device = SshTarget { user: "o'brien".into(), host: "127.0.0.1".into(), port: 40001 };
        let args = lan_terminal_args("/usr/bin/ssh", &device, "admin", "192.168.1.20", 2222);
        let proxy = args.iter().find(|a| a.starts_with("ProxyCommand=")).unwrap();
        assert!(proxy.contains("-W %h:%p -p 40001 'o'\\''brien@127.0.0.1'"), "{proxy}");
        assert!(proxy.starts_with("ProxyCommand='/usr/bin/ssh' "), "{proxy}");
        assert_eq!(&args[args.len() - 5..], &["-l", "admin", "-p", "2222", "192.168.1.20"]);
        assert!(args.contains(&"PreferredAuthentications=publickey,keyboard-interactive,password".to_string()));
        assert!(valid_login("admin") && valid_login("svc.backup_01"));
        assert!(!valid_login("-oProxyCommand=x") && !valid_login("a b") && !valid_login("a;b") && !valid_login(""));
    }
    use super::*;

    #[test]
    fn terminal_argv_matches_django() {
        let t = SshTarget { user: "ubuntu".into(), host: "127.0.0.1".into(), port: 12345 };
        let args = terminal_args(&t);
        assert_eq!(args.last().unwrap(), "12345");
        assert!(args.contains(&"ControlPath=/tmp/ssh_term_%r@%h:%p".to_string()));
        assert!(args.contains(&"ubuntu@127.0.0.1".to_string()));
        assert!(!args.iter().any(|a| a.contains(' ')), "no shell quoting needed: {args:?}");
        let fm = filemanager_exec_args(&t, "ls -la ~/");
        assert_eq!(fm.last().unwrap(), "ls -la ~/");
        assert!(filemanager_master_args(&t).ends_with(&["ubuntu@127.0.0.1".to_string(), "cat".to_string()]));
    }

    #[tokio::test]
    async fn pty_roundtrip_with_cat() {
        let mut p = spawn_in_pty("cat", &[]).unwrap();
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
