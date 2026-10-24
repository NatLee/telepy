//! 裝置上 `~/.ssh/authorized_keys` 的讀寫（russh + SFTP，以服務金鑰登入該 OS 帳號；連線向 `ssh::pool` 借）。
//! 寫入一律「寫暫存檔 → `posix-rename@openssh.com` 原子取代」：檔案裡有服務金鑰，寫到一半斷線
//! 不能留下半個檔案，否則 Telepy 從此登不進這個帳號。伺服器不支援 posix-rename 時拒絕改寫既有檔案。
//! Reads and atomically rewrites a device account's `authorized_keys` over SFTP.

use anyhow::{bail, Context};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, Packet, StatusCode};

use crate::ssh::pool::Lease;
use crate::state::AppState;

/// 讀 / 寫成功後記下內容（`DeviceKeys::record_snapshot`），裝置金鑰面板就能顯示「裝置上實際有什麼」。
/// After every successful read / write the content is recorded so the panel can show what is on the device.

const POSIX_RENAME: &str = "posix-rename@openssh.com";
/// authorized_keys 再大也不該超過這個；超過就不碰。/ Refuse to handle absurdly large files.
const MAX_SIZE: u64 = 1024 * 1024;
const CHUNK: usize = 32 * 1024;

/// 欄位順序 = drop 順序：先關 SFTP channel，再歸還 lease。/ Drop the channel before returning the lease.
pub struct AuthorizedKeysFile {
    sftp: RawSftpSession,
    _lease: Lease,
    state: AppState,
    reverse_port: i64,
    account: String,
    posix_rename: bool,
    dir: String,
    path: String,
    /// None = 檔案不存在。
    mode: Option<u32>,
}

fn is_status(e: &SftpError, code: StatusCode) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == code)
}

fn ssh_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s.as_bytes());
}

impl AuthorizedKeysFile {
    /// 以服務金鑰登入 `username`，找出 `~/.ssh`（`for_write` 時不存在就建立，0700），記下 `authorized_keys` 的實際路徑與權限。
    /// 稽核只讀，不建目錄。/ Read-only callers (the audit) never create `~/.ssh`.
    pub async fn open(state: &AppState, username: &str, reverse_port: i64, for_write: bool) -> anyhow::Result<Self> {
        let lease = state.pool.acquire(state, reverse_port, username).await?;
        let channel = lease.device().channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = RawSftpSession::new(channel.into_stream());
        sftp.set_timeout(20);
        let version = sftp.init().await.context("sftp init")?;
        let posix_rename = version.extensions.get(POSIX_RENAME).is_some_and(|v| v == "1");

        let home = sftp.realpath(".").await.context("resolve home directory")?.files.first().map(|f| f.filename.clone()).context("resolve home directory")?;
        let ssh_dir = format!("{}/.ssh", home.trim_end_matches('/'));
        match sftp.stat(ssh_dir.as_str()).await {
            Ok(a) if a.attrs.is_dir() => {}
            Ok(_) => bail!("{ssh_dir} exists but is not a directory"),
            Err(e) if is_status(&e, StatusCode::NoSuchFile) && for_write => {
                let attrs = FileAttributes { permissions: Some(0o700), ..FileAttributes::empty() };
                sftp.mkdir(ssh_dir.as_str(), attrs).await.with_context(|| format!("create {ssh_dir}"))?;
            }
            Err(e) if is_status(&e, StatusCode::NoSuchFile) => {
                let path = format!("{ssh_dir}/authorized_keys");
                return Ok(Self { sftp, _lease: lease, state: state.clone(), reverse_port, account: username.to_string(), posix_rename, dir: ssh_dir, path, mode: None });
            }
            Err(e) => return Err(e).with_context(|| format!("stat {ssh_dir}")),
        }
        let link = format!("{ssh_dir}/authorized_keys");
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
        Ok(Self { sftp, _lease: lease, state: state.clone(), reverse_port, account: username.to_string(), posix_rename, dir, path, mode })
    }

    pub fn exists(&self) -> bool {
        self.mode.is_some()
    }

    pub async fn read(&self) -> anyhow::Result<String> {
        if self.mode.is_none() {
            self.state.device_keys.record_snapshot(self.reverse_port, &self.account, None);
            return Ok(String::new());
        }
        let handle = self.sftp.open(self.path.as_str(), OpenFlags::READ, FileAttributes::empty()).await.with_context(|| format!("open {}", self.path))?.handle;
        let mut buf = Vec::new();
        let result = async {
            loop {
                match self.sftp.read(handle.as_str(), buf.len() as u64, CHUNK as u32).await {
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
        let _ = self.sftp.close(handle.as_str()).await;
        result?;
        let text = String::from_utf8_lossy(&buf).into_owned();
        self.state.device_keys.record_snapshot(self.reverse_port, &self.account, Some(text.clone()));
        Ok(text)
    }

    /// 原子取代整個檔案（保留原本的權限；新檔 0600）。
    pub async fn write(&self, content: &str) -> anyhow::Result<()> {
        if self.mode.is_some() && !self.posix_rename {
            bail!("the device's SFTP server does not support {POSIX_RENAME}, so authorized_keys cannot be replaced safely");
        }
        let tmp = format!("{}/.authorized_keys.telepy-{:016x}", self.dir, rand::random::<u64>());
        let mode = self.mode.unwrap_or(0o600);
        let attrs = FileAttributes { permissions: Some(mode), ..FileAttributes::empty() };
        let handle = self
            .sftp
            .open(tmp.as_str(), OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, attrs)
            .await
            .with_context(|| format!("create {tmp}"))?
            .handle;
        let written = async {
            for (i, chunk) in content.as_bytes().chunks(CHUNK).enumerate() {
                self.sftp.write(handle.as_str(), (i * CHUNK) as u64, chunk.to_vec()).await.context("write authorized_keys")?;
            }
            anyhow::Ok(())
        }
        .await;
        let closed = self.sftp.close(handle.as_str()).await;
        let renamed = match (written, closed) {
            (Err(e), _) => Err(e),
            (_, Err(e)) => Err(anyhow::Error::from(e).context("close authorized_keys")),
            _ => self.replace(&tmp).await,
        };
        match &renamed {
            Ok(()) => self.state.device_keys.record_snapshot(self.reverse_port, &self.account, Some(content.to_string())),
            Err(_) => {
                let _ = self.sftp.remove(tmp.as_str()).await;
            }
        }
        renamed
    }

    async fn replace(&self, tmp: &str) -> anyhow::Result<()> {
        // 權限：umask 可能吃掉 open 時給的 mode，補一次。/ umask may have masked the requested mode.
        let attrs = FileAttributes { permissions: Some(self.mode.unwrap_or(0o600)), ..FileAttributes::empty() };
        let _ = self.sftp.setstat(tmp, attrs).await;
        if self.posix_rename {
            let mut data = Vec::new();
            ssh_string(&mut data, tmp);
            ssh_string(&mut data, &self.path);
            match self.sftp.extended(POSIX_RENAME, data).await.context("posix-rename authorized_keys")? {
                Packet::Status(s) if s.status_code == StatusCode::Ok => Ok(()),
                Packet::Status(s) => bail!("posix-rename authorized_keys: {}: {}", s.status_code, s.error_message),
                _ => bail!("posix-rename authorized_keys: unexpected reply"),
            }
        } else {
            // 只有在目標不存在時才會走到這裡（見 write）。/ Only reached when the target does not exist.
            self.sftp.rename(tmp, self.path.as_str()).await.context("rename authorized_keys")?;
            Ok(())
        }
    }
}
