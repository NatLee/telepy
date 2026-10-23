//! OpenSSH 客戶端子程序：只剩區網主機那一跳（最後一跳要能在 PTY 裡問密碼 / 鍵盤互動）。裝置本身的終端機、
//! 檔案管理、遠端瀏覽器都改走連線池（russh），不再 spawn ssh。
//! 終止語意不變：只殺直屬子程序（SIGTERM → SIGKILL），絕不 killpg。
//! The OpenSSH client is only used for the LAN host hop now (password / keyboard-interactive prompts in a PTY).

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
        "-o", "PreferredAuthentications=publickey,keyboard-interactive,password",
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
    use super::*;

    #[test]
    fn lan_hop_arguments() {
        let args = lan_terminal_args("admin", "192.168.1.20", 40123);
        assert_eq!(&args[args.len() - 5..], &["-l", "admin", "-p", "40123", "127.0.0.1"]);
        assert!(args.windows(2).any(|w| w == ["-o", "HostKeyAlias=192.168.1.20"]), "{args:?}");
        assert!(args.contains(&"PreferredAuthentications=publickey,keyboard-interactive,password".to_string()));
        assert!(!args.iter().any(|a| a.contains("ProxyCommand")), "the first hop is the pool bridge now");
        assert!(valid_login("admin") && valid_login("svc.backup_01"));
        assert!(!valid_login("-oProxyCommand=x") && !valid_login("a b") && !valid_login("a;b") && !valid_login(""));
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
