//! 檔案管理的對象：裝置上的一個 OS 帳號（連線池），或經裝置登入的一台區網主機（`lan::files`）。
//! URL 的帳號位置是 `~<代號>` 時就是後者；兩種都給同樣的 SFTP / 大量傳輸 / session channel，所以操作的程式碼不分。
//! What the file manager works on: an OS account on the device (the pool) or a LAN host logged in to through it
//! (`lan::files`, when the account segment is `~<id>`). Both hand out the same SFTP, bulk SFTP and session channels.

use std::ops::Deref;
use std::sync::Arc;

use russh::client::Msg;
use russh::Channel;
use russh_sftp::client::SftpSession;

use crate::lan::files::{LanBulkSftp, LanFiles, LanSftp};
use crate::ssh::pool::{Lease, PooledSftp, TransferSftp};
use crate::state::AppState;

#[derive(Clone)]
pub enum Target {
    Device { reverse_port: i64, username: String },
    Lan(Arc<LanFiles>),
}

/// 共用的 SFTP。/ The shared SFTP channel.
pub enum Shared {
    Device(PooledSftp),
    Lan(LanSftp),
}

impl Deref for Shared {
    type Target = SftpSession;
    fn deref(&self) -> &SftpSession {
        match self {
            Self::Device(s) => s,
            Self::Lan(s) => s,
        }
    }
}

impl Shared {
    pub fn healthy(&self) -> bool {
        match self {
            Self::Device(s) => s.healthy(),
            Self::Lan(s) => s.0.healthy(),
        }
    }

    /// 換一條（區網主機的斷了就是斷了，要重新登入）。/ Renew it (a broken LAN host connection needs a new login).
    pub async fn renew(&mut self, state: &AppState) -> anyhow::Result<()> {
        match self {
            Self::Device(s) => s.renew(state).await,
            Self::Lan(_) => anyhow::bail!("the connection to the LAN host ended; open its files again"),
        }
    }
}

/// 大量傳輸用的 SFTP。/ SFTP for a bulk transfer.
pub enum Bulk {
    Device(TransferSftp),
    Lan(LanBulkSftp),
}

impl Deref for Bulk {
    type Target = SftpSession;
    fn deref(&self) -> &SftpSession {
        match self {
            Self::Device(s) => s,
            Self::Lan(s) => s,
        }
    }
}

/// session channel 用完前要留著的東西。/ What keeps a session channel's connection alive.
pub enum Keep {
    Lease(Lease),
    Lan(Arc<LanFiles>),
}

impl Target {
    /// 這個人的這個目標：`~<代號>` = 他開的區網檔案 session（別人的 / 關掉的 = None），其他 = 裝置帳號。
    /// The target: `~<id>` = this person's LAN file session (someone else's or a closed one = None), else the account.
    pub fn of(state: &AppState, user_id: i64, reverse_port: i64, username: &str) -> Option<Self> {
        if crate::lan::files::is_session_id(username) {
            return state.lan_files.get(username, user_id).map(Self::Lan);
        }
        Some(Self::Device { reverse_port, username: username.to_string() })
    }

    pub fn lan(&self) -> Option<&Arc<LanFiles>> {
        match self {
            Self::Lan(f) => Some(f),
            Self::Device { .. } => None,
        }
    }

    /// 登入的帳號（區網主機 = 那台主機上的登入）。/ The login (on a LAN host, the host's).
    pub fn login(&self) -> &str {
        match self {
            Self::Device { username, .. } => username,
            Self::Lan(f) => &f.login,
        }
    }

    /// 日誌裡怎麼叫它：`alice` 或 `pi@192.168.1.20`。/ How the log names it.
    pub fn label(&self) -> String {
        match self {
            Self::Device { username, .. } => username.clone(),
            Self::Lan(f) => format!("{}@{}", f.login, f.address),
        }
    }

    pub async fn sftp(&self, state: &AppState) -> anyhow::Result<Shared> {
        match self {
            Self::Device { reverse_port, username } => Ok(Shared::Device(state.pool.sftp(state, *reverse_port, username).await?)),
            Self::Lan(f) => {
                if !f.healthy() {
                    anyhow::bail!("the connection to the LAN host ended; open its files again");
                }
                Ok(Shared::Lan(LanSftp(f.clone())))
            }
        }
    }

    pub async fn bulk(&self, state: &AppState) -> anyhow::Result<Bulk> {
        match self {
            Self::Device { reverse_port, username } => Ok(Bulk::Device(state.pool.bulk_sftp(state, *reverse_port, username).await?)),
            Self::Lan(f) => Ok(Bulk::Lan(crate::lan::files::bulk(f.clone()).await?)),
        }
    }

    pub async fn session_channel(&self, state: &AppState) -> anyhow::Result<(Keep, Channel<Msg>)> {
        match self {
            Self::Device { reverse_port, username } => {
                let (lease, ch) = state.pool.session_channel(state, *reverse_port, username).await?;
                Ok((Keep::Lease(lease), ch))
            }
            Self::Lan(f) => Ok((Keep::Lan(f.clone()), f.session_channel().await?)),
        }
    }
}
