//! 裝置上 `~/.ssh/authorized_keys` 的讀寫（以服務金鑰登入該 OS 帳號；連線向 `ssh::pool` 借）。
//! 有 SFTP 的裝置走 russh + SFTP，寫入一律「寫暫存檔 → `posix-rename@openssh.com` 原子取代」：檔案裡有服務金鑰，寫到一半斷線
//! 不能留下半個檔案，否則 Telepy 從此登不進這個帳號。伺服器不支援 posix-rename 時拒絕改寫既有檔案。
//! **沒有 sftp 子系統的裝置**（OpenWrt 的 Dropbear 沒裝 openssh-sftp-server、精簡的 sshd）改走 exec：`sh -c` 的 `cat` 讀、
//! 「暫存檔 + `mv -f`」寫（同一目錄下的 rename 一樣是原子的）；BusyBox 就夠（沒有 stat、沒有 GNU 選項）。root 在 OpenWrt 的
//! Dropbear 讀的是 `/etc/dropbear/authorized_keys`，跟一鍵加入腳本選的是同一個檔案。
//! Reads and atomically rewrites a device account's `authorized_keys` over SFTP — or, on a device without the sftp
//! subsystem (Dropbear without openssh-sftp-server, minimal sshd), over exec with `cat` and tmp file + `mv -f`
//! (BusyBox is enough). Root on OpenWrt + Dropbear uses `/etc/dropbear/authorized_keys`, the same file the join script picks.
//!
//! Windows 管理員（`platform`）的金鑰在共用的 `%ProgramData%\ssh\administrators_authorized_keys`：Win32-OpenSSH 要求
//! 那個檔案的 ACL 只有 Administrators 與 SYSTEM，而 SFTP 建的暫存檔會繼承目錄 ACL、擁有者是建立它的帳號，
//! rename 過去後 sshd 可能以 "Bad owner or permissions" 拒讀 —— 所以那個檔案**就地改寫**（open → write → 截短），
//! 檔案本身、擁有者與 ACL 都不變。代價是寫到一半斷線會留下混合內容；行是整行寫的，壞掉的最多是尾端一行。
//! A Windows administrator's keys live in the shared admin file, whose ACL must be exactly Administrators + SYSTEM;
//! a tmp-file + rename would hand it the tmp file's owner / inherited ACL, so that file is rewritten **in place**
//! (open → write → truncate), keeping identity, owner and ACL. A mid-write disconnect can leave mixed content there.

use std::time::Duration;

use anyhow::{bail, Context};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, Packet, StatusCode};

use crate::ssh::exec;
use crate::ssh::pool::Lease;
use crate::state::AppState;

// 讀 / 寫成功後記下內容（`DeviceKeys::record_snapshot`），裝置金鑰面板就能顯示「裝置上實際有什麼」。
// After every successful read / write the content is recorded so the panel can show what is on the device.

const POSIX_RENAME: &str = "posix-rename@openssh.com";
/// authorized_keys 再大也不該超過這個；超過就不碰。/ Refuse to handle absurdly large files.
const MAX_SIZE: u64 = 1024 * 1024;
const CHUNK: usize = 32 * 1024;
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);

/// 怎麼碰到檔案：SFTP（連線池的 channel），或每次開一個 exec channel 跑 `sh -c`。
/// How the file is reached: SFTP on a pooled channel, or one exec channel per operation.
enum Backend {
    Sftp { sftp: RawSftpSession, _lease: Lease, posix_rename: bool },
    Exec,
}

/// 欄位順序 = drop 順序：先關 SFTP channel，再歸還 lease。/ Drop the channel before returning the lease.
pub struct AuthorizedKeysFile {
    backend: Backend,
    state: AppState,
    reverse_port: i64,
    account: String,
    dir: String,
    path: String,
    /// None = 檔案不存在。
    mode: Option<u32>,
    /// Windows 管理員檔：就地改寫，不用暫存檔 + rename。/ The Windows admin file: rewritten in place.
    in_place: bool,
}

fn is_status(e: &SftpError, code: StatusCode) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == code)
}

fn ssh_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// exec 模式找檔案的腳本（POSIX / BusyBox）：印 `PATH=` 與 `EXISTS=`。root + OpenWrt + Dropbear → `/etc/dropbear/authorized_keys`。
/// The exec-mode locator script: prints `PATH=` and `EXISTS=`. Root on OpenWrt with Dropbear → `/etc/dropbear/authorized_keys`.
pub const LOCATE_SCRIPT: &str = r#"d=${HOME:-}; [ -n "$d" ] || d=$(cd ~ 2>/dev/null && pwd); p="$d/.ssh/authorized_keys"
if [ "$(id -u 2>/dev/null)" = 0 ] && [ -d /etc/dropbear ] && [ -f /etc/openwrt_release ]; then p=/etc/dropbear/authorized_keys; fi
printf 'PATH=%s\n' "$p"; if [ -f "$p" ]; then echo EXISTS=1; else echo EXISTS=0; fi"#;

/// `LOCATE_SCRIPT` 的輸出 → (path, exists)。/ Parse the locator's output.
pub fn parse_locate(out: &str) -> Option<(String, bool)> {
    let mut path = None;
    let mut exists = false;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("PATH=") {
            if p.starts_with('/') {
                path = Some(p.to_string());
            }
        } else if line.trim() == "EXISTS=1" {
            exists = true;
        }
    }
    path.map(|p| (p, exists))
}

/// exec 模式的寫入：先建目錄（0700）、分段把內容寫到暫存檔（`exec::upload_commands`，Dropbear 一道指令 ≤ 9000 bytes），
/// 最後 `chmod 600` + `mv -f` 原子取代。回傳要依序執行的指令。/ The exec-mode write: directory (0700), the content in pieces
/// into a tmp file (Dropbear caps a command at 9000 bytes), then `chmod 600` + `mv -f`. The commands to run in order.
pub fn write_commands(path: &str, tmp: &str, content: &str) -> anyhow::Result<Vec<String>> {
    if content.len() as u64 > MAX_SIZE {
        bail!("authorized_keys is larger than {MAX_SIZE} bytes");
    }
    let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("/");
    let q = crate::tunnel_service::sh_quote;
    let body = if content.is_empty() || content.ends_with('\n') { content.to_string() } else { format!("{content}\n") };
    let mut cmds = vec![format!("umask 077; mkdir -p {d} && chmod 700 {d} 2>/dev/null; true", d = q(dir))];
    cmds.extend(exec::upload_commands(tmp, &body));
    cmds.push(format!("chmod 600 {t} && mv -f {t} {p} || {{ rm -f {t}; exit 1; }}", t = q(tmp), p = q(path)));
    Ok(cmds)
}

impl AuthorizedKeysFile {
    /// 以服務金鑰登入 `username`，找出 `~/.ssh`（`for_write` 時不存在就建立，0700），記下 `authorized_keys` 的實際路徑與權限。
    /// Windows 管理員帳號改用 `%ProgramData%\ssh\administrators_authorized_keys`（平台探測一次，快取）。
    /// 稽核只讀，不建目錄。/ Read-only callers (the audit) never create `~/.ssh`.
    pub async fn open(state: &AppState, username: &str, reverse_port: i64, for_write: bool) -> anyhow::Result<Self> {
        let platform = state.device_keys.platform(state, reverse_port, username).await;
        let (admin_file, _, _) = platform.file_for(username);
        let (lease, channel) = state.pool.session_channel(state, reverse_port, username).await?;
        let channel = match crate::ssh::device::open_sftp(channel).await {
            Ok(c) => c,
            Err(e) if e.to_string().contains("no sftp subsystem") => {
                drop(lease);
                if admin_file.is_some() {
                    bail!("the device has no sftp subsystem, and a Windows administrator's key file needs SFTP");
                }
                return Self::open_exec(state, username, reverse_port).await;
            }
            Err(e) => return Err(e),
        };
        let sftp = RawSftpSession::new(channel.into_stream());
        sftp.set_timeout(20);
        let version = match sftp.init().await {
            Ok(v) => v,
            Err(e) => {
                // Dropbear 接受 sftp 子系統的要求後才去找 sftp-server（OpenWrt 沒裝 openssh-sftp-server）：channel 立刻關掉，
                // init 失敗。/ Dropbear accepts the subsystem request and only then fails to start sftp-server: init fails.
                drop(sftp);
                drop(lease);
                if admin_file.is_some() {
                    bail!("sftp init: {e} (a Windows administrator's key file needs SFTP)");
                }
                tracing::debug!(port = reverse_port, account = username, error = %e, "device keys: no working sftp, using exec");
                return Self::open_exec(state, username, reverse_port).await;
            }
        };
        let posix_rename = version.extensions.get(POSIX_RENAME).is_some_and(|v| v == "1");

        let (ssh_dir, in_place) = match admin_file {
            Some(path) => (path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default(), true),
            None => {
                let home = sftp.realpath(".").await.context("resolve home directory")?.files.first().map(|f| f.filename.clone()).context("resolve home directory")?;
                (format!("{}/.ssh", home.trim_end_matches('/')), false)
            }
        };
        let file_name = if in_place { "administrators_authorized_keys" } else { "authorized_keys" };
        let backend = Backend::Sftp { sftp, _lease: lease, posix_rename };
        let Backend::Sftp { sftp, .. } = &backend else { unreachable!() };
        match sftp.stat(ssh_dir.as_str()).await {
            Ok(a) if a.attrs.is_dir() => {}
            Ok(_) => bail!("{ssh_dir} exists but is not a directory"),
            Err(e) if is_status(&e, StatusCode::NoSuchFile) && for_write => {
                let attrs = FileAttributes { permissions: Some(0o700), ..FileAttributes::empty() };
                sftp.mkdir(ssh_dir.as_str(), attrs).await.with_context(|| format!("create {ssh_dir}"))?;
            }
            Err(e) if is_status(&e, StatusCode::NoSuchFile) => {
                let path = format!("{ssh_dir}/{file_name}");
                return Ok(Self { backend, state: state.clone(), reverse_port, account: username.to_string(), dir: ssh_dir, path, mode: None, in_place });
            }
            Err(e) => return Err(e).with_context(|| format!("stat {ssh_dir}")),
        }
        let link = format!("{ssh_dir}/{file_name}");
        // 符號連結：改它指向的檔案，不要把連結換成一般檔案。/ Follow a symlinked authorized_keys.
        let (path, mode) = match sftp.stat(link.as_str()).await {
            Ok(a) => {
                if a.attrs.size.unwrap_or(0) > MAX_SIZE {
                    bail!("{link} is larger than {MAX_SIZE} bytes");
                }
                let real = sftp.realpath(link.as_str()).await.ok().and_then(|n| n.files.first().map(|f| f.filename.clone())).unwrap_or(link.clone());
                (real, Some(a.attrs.permissions.unwrap_or(0o600) & 0o7777))
            }
            Err(e) if is_status(&e, StatusCode::NoSuchFile) => (link, None),
            Err(e) => return Err(e).with_context(|| format!("stat {link}")),
        };
        let dir = path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or(ssh_dir);
        Ok(Self { backend, state: state.clone(), reverse_port, account: username.to_string(), dir, path, mode, in_place })
    }

    /// 沒有 SFTP：用 exec 找到檔案（路徑規則見 [`LOCATE_SCRIPT`]）。/ No SFTP: locate the file over exec.
    async fn open_exec(state: &AppState, username: &str, reverse_port: i64) -> anyhow::Result<Self> {
        let out = Self::exec_in(state, reverse_port, username, &format!("sh -c {}", crate::tunnel_service::sh_quote(LOCATE_SCRIPT))).await.context("locate authorized_keys over exec (no sftp subsystem)")?;
        let (path, exists) = parse_locate(&out).context("locate authorized_keys over exec: unexpected answer")?;
        let dir = path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_else(|| "/".into());
        Ok(Self { backend: Backend::Exec, state: state.clone(), reverse_port, account: username.to_string(), dir, path, mode: exists.then_some(0o600), in_place: false })
    }

    /// 開一個 exec channel 跑指令；非 0 結束就報錯（帶 stderr）。/ Run one command on a fresh exec channel.
    async fn exec_in(state: &AppState, reverse_port: i64, username: &str, command: &str) -> anyhow::Result<String> {
        let (_lease, channel) = state.pool.session_channel(state, reverse_port, username).await?;
        let r = exec::run_on(channel, command, EXEC_TIMEOUT, MAX_SIZE as usize + 4096).await?;
        if r.timed_out {
            bail!("the device did not answer in time");
        }
        if r.exit_code != Some(0) {
            bail!("{}", r.stderr.text.trim().lines().last().unwrap_or("the command failed on the device"));
        }
        Ok(r.stdout.text)
    }

    pub fn exists(&self) -> bool {
        self.mode.is_some()
    }

    /// 走 exec（裝置沒有 SFTP）。/ Reached over exec (the device has no SFTP).
    pub fn via_exec(&self) -> bool {
        matches!(self.backend, Backend::Exec)
    }

    pub async fn read(&self) -> anyhow::Result<String> {
        if self.mode.is_none() {
            self.state.device_keys.record_snapshot_at(self.reverse_port, &self.account, None, self.reported_path());
            return Ok(String::new());
        }
        let text = match &self.backend {
            Backend::Exec => {
                let out = Self::exec_in(&self.state, self.reverse_port, &self.account, &format!("cat {}", crate::tunnel_service::sh_quote(&self.path))).await.context("read authorized_keys")?;
                if out.len() as u64 > MAX_SIZE {
                    bail!("authorized_keys is larger than {MAX_SIZE} bytes");
                }
                out
            }
            Backend::Sftp { sftp, .. } => {
                let handle = sftp.open(self.path.as_str(), OpenFlags::READ, FileAttributes::empty()).await.with_context(|| format!("open {}", self.path))?.handle;
                let mut buf = Vec::new();
                let result = async {
                    loop {
                        match sftp.read(handle.as_str(), buf.len() as u64, CHUNK as u32).await {
                            Ok(d) if d.data.is_empty() => break,
                            Ok(d) => buf.extend_from_slice(&d.data),
                            Err(e) if is_status(&e, StatusCode::Eof) => break,
                            Err(e) => return Err(anyhow::Error::from(e).context("read authorized_keys")),
                        }
                        if buf.len() as u64 > MAX_SIZE {
                            bail!("authorized_keys is larger than {MAX_SIZE} bytes");
                        }
                    }
                    Ok(())
                }
                .await;
                let _ = sftp.close(handle.as_str()).await;
                result?;
                String::from_utf8_lossy(&buf).into_owned()
            }
        };
        self.state.device_keys.record_snapshot_at(self.reverse_port, &self.account, Some(text.clone()), self.reported_path());
        Ok(text)
    }

    /// 面板上顯示的路徑：只有 exec 模式回報實際路徑（可能是 `/etc/dropbear/authorized_keys`）；SFTP 模式維持平台的標籤
    /// （`~/.ssh/authorized_keys`），不把每台裝置的絕對家目錄攤出來。/ The path shown in the panel: only exec mode reports the
    /// real one (it may be `/etc/dropbear/authorized_keys`); SFTP mode keeps the platform label.
    fn reported_path(&self) -> Option<String> {
        self.via_exec().then(|| self.path.clone())
    }

    /// 原子取代整個檔案（保留原本的權限；新檔 0600）。Windows 管理員檔則就地改寫（見模組說明）。
    pub async fn write(&self, content: &str) -> anyhow::Result<()> {
        if self.in_place {
            return self.write_in_place(content).await;
        }
        let tmp = format!("{}/.authorized_keys.telepy-{:016x}", self.dir, rand::random::<u64>());
        let (sftp, posix_rename) = match &self.backend {
            Backend::Exec => {
                for cmd in write_commands(&self.path, &tmp, content)? {
                    if let Err(e) = Self::exec_in(&self.state, self.reverse_port, &self.account, &format!("sh -c {}", crate::tunnel_service::sh_quote(&cmd))).await {
                        let _ = Self::exec_in(&self.state, self.reverse_port, &self.account, &format!("rm -f {}", crate::tunnel_service::sh_quote(&tmp))).await;
                        return Err(e.context("write authorized_keys over exec"));
                    }
                }
                self.state.device_keys.record_snapshot_at(self.reverse_port, &self.account, Some(content.to_string()), Some(self.path.clone()));
                return Ok(());
            }
            Backend::Sftp { sftp, posix_rename, .. } => (sftp, *posix_rename),
        };
        if self.mode.is_some() && !posix_rename {
            bail!("the device's SFTP server does not support {POSIX_RENAME}, so authorized_keys cannot be replaced safely");
        }
        let mode = self.mode.unwrap_or(0o600);
        let attrs = FileAttributes { permissions: Some(mode), ..FileAttributes::empty() };
        let handle = sftp.open(tmp.as_str(), OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, attrs).await.with_context(|| format!("create {tmp}"))?.handle;
        let written = async {
            for (i, chunk) in content.as_bytes().chunks(CHUNK).enumerate() {
                sftp.write(handle.as_str(), (i * CHUNK) as u64, chunk.to_vec()).await.context("write authorized_keys")?;
            }
            anyhow::Ok(())
        }
        .await;
        let closed = sftp.close(handle.as_str()).await;
        let renamed = match (written, closed) {
            (Err(e), _) => Err(e),
            (_, Err(e)) => Err(anyhow::Error::from(e).context("close authorized_keys")),
            _ => self.replace(sftp, posix_rename, &tmp).await,
        };
        match &renamed {
            Ok(()) => self.state.device_keys.record_snapshot_at(self.reverse_port, &self.account, Some(content.to_string()), self.reported_path()),
            Err(_) => {
                let _ = sftp.remove(tmp.as_str()).await;
            }
        }
        renamed
    }

    /// 就地改寫：開檔（不截短）→ 從頭寫新內容 → 截短到新長度。擁有者與 ACL 不變。
    /// In place: open without truncating, write from offset 0, then truncate to the new length. Owner and ACL stay.
    async fn write_in_place(&self, content: &str) -> anyhow::Result<()> {
        let Backend::Sftp { sftp, .. } = &self.backend else { bail!("the Windows administrator key file needs SFTP") };
        let handle = sftp.open(self.path.as_str(), OpenFlags::WRITE | OpenFlags::CREATE, FileAttributes::empty()).await.with_context(|| format!("open {} for writing", self.path))?.handle;
        let written = async {
            for (i, chunk) in content.as_bytes().chunks(CHUNK).enumerate() {
                sftp.write(handle.as_str(), (i * CHUNK) as u64, chunk.to_vec()).await.context("write administrators_authorized_keys")?;
            }
            let attrs = FileAttributes { size: Some(content.len() as u64), ..FileAttributes::empty() };
            sftp.fsetstat(handle.as_str(), attrs).await.context("truncate administrators_authorized_keys")?;
            anyhow::Ok(())
        }
        .await;
        let closed = sftp.close(handle.as_str()).await;
        written?;
        closed.context("close administrators_authorized_keys")?;
        self.state.device_keys.record_snapshot(self.reverse_port, &self.account, Some(content.to_string()));
        Ok(())
    }

    async fn replace(&self, sftp: &RawSftpSession, posix_rename: bool, tmp: &str) -> anyhow::Result<()> {
        // 權限：umask 可能吃掉 open 時給的 mode，補一次。/ umask may have masked the requested mode.
        let attrs = FileAttributes { permissions: Some(self.mode.unwrap_or(0o600)), ..FileAttributes::empty() };
        let _ = sftp.setstat(tmp, attrs).await;
        if posix_rename {
            let mut data = Vec::new();
            ssh_string(&mut data, tmp);
            ssh_string(&mut data, &self.path);
            match sftp.extended(POSIX_RENAME, data).await.context("posix-rename authorized_keys")? {
                Packet::Status(s) if s.status_code == StatusCode::Ok => Ok(()),
                Packet::Status(s) => bail!("posix-rename authorized_keys: {}: {}", s.status_code, s.error_message),
                _ => bail!("posix-rename authorized_keys: unexpected reply"),
            }
        } else {
            // 只有在目標不存在時才會走到這裡（見 write）。/ Only reached when the target does not exist.
            sftp.rename(tmp, self.path.as_str()).await.context("rename authorized_keys")?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_output_is_parsed() {
        assert_eq!(parse_locate("PATH=/root/.ssh/authorized_keys\nEXISTS=0\n"), Some(("/root/.ssh/authorized_keys".into(), false)));
        assert_eq!(parse_locate("PATH=/etc/dropbear/authorized_keys\nEXISTS=1\n"), Some(("/etc/dropbear/authorized_keys".into(), true)));
        assert_eq!(parse_locate("PATH=relative\nEXISTS=1\n"), None, "a relative path is refused");
        assert_eq!(parse_locate("garbage"), None);
        assert!(!LOCATE_SCRIPT.contains("stat "), "BusyBox on OpenWrt has no stat");
    }

    #[test]
    fn write_commands_are_atomic_quoted_and_chunked() {
        let c = write_commands("/root/.ssh/authorized_keys", "/root/.ssh/.tmp", "ssh-ed25519 AAAA a\nssh-ed25519 BBBB b").unwrap();
        assert_eq!(c.len(), 3, "{c:?}");
        assert_eq!(c[0], "umask 077; mkdir -p '/root/.ssh' && chmod 700 '/root/.ssh' 2>/dev/null; true");
        assert_eq!(c[1], "umask 077; printf '%s' 'ssh-ed25519 AAAA a\nssh-ed25519 BBBB b\n' > '/root/.ssh/.tmp'", "a final newline is added");
        assert_eq!(c[2], "chmod 600 '/root/.ssh/.tmp' && mv -f '/root/.ssh/.tmp' '/root/.ssh/authorized_keys' || { rm -f '/root/.ssh/.tmp'; exit 1; }");
        // 長檔案分成好幾段（Dropbear 的 9000 bytes 上限）。/ A long file goes in several pieces.
        let long = "ssh-ed25519 AAAA k\n".repeat(1200);
        let c = write_commands("/a/k", "/a/t", &long).unwrap();
        assert!(c.len() > 4 && c.iter().all(|x| x.len() <= exec::MAX_COMMAND), "{} commands", c.len());
        assert!(write_commands("/a/k", "/a/t", &"k".repeat(MAX_SIZE as usize + 1)).is_err());
        let it = write_commands("/it's/k", "/it's/t", "").unwrap();
        assert!(it[0].contains("'/it'\\''s'"), "{}", it[0]);
    }
}
