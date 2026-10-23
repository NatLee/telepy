//! 網頁終端機的 SSH 端：在連線池借來的裝置連線上開一條 session channel（pty-req + shell），取代
//! 「openpty + OpenSSH 子程序 + ControlMaster」。一個分頁 = 一條 channel；關分頁 = 關 channel，連線留給別人用。
//! 以前 killpg 會殺到 ControlMaster、連帶踢掉所有分頁的那整類問題，從此不存在。
//! The web terminal's SSH side: one PTY session channel per tab on a shared device connection.

use anyhow::Context;
use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};

use super::pool::Lease;

/// 一個開著的 PTY shell。欄位順序 = drop 順序：先關 channel，再還 lease。
pub struct PtySession {
    rx: ChannelReadHalf,
    tx: ChannelWriteHalf<Msg>,
    /// 呼叫端沒讀完的資料，下次 `next` 先回它。/ Bytes the caller could not take yet.
    pending: Vec<u8>,
    _lease: Lease,
}

/// 前端送來的視窗大小。/ The front end's window size.
#[derive(Debug, Clone, Copy)]
pub struct WindowSize {
    pub cols: u32,
    pub rows: u32,
    pub width: u32,
    pub height: u32,
}

impl Default for WindowSize {
    fn default() -> Self {
        Self { cols: 80, rows: 24, width: 640, height: 384 }
    }
}

/// 從 PTY 讀到的一件事。/ One event from the PTY.
pub enum Output {
    /// stdout / stderr 的資料（PTY 下兩者合流）。
    Data(Vec<u8>),
    /// shell 結束：exit status（沒有就 None）。
    Exit(Option<u32>),
}

impl PtySession {
    /// 在 `channel`（lease 那條連線上剛開的 session channel）要 pty（TERM=xterm）→ shell。
    pub async fn open(lease: Lease, channel: Channel<Msg>, size: WindowSize) -> anyhow::Result<Self> {
        channel.request_pty(true, "xterm", size.cols, size.rows, size.width, size.height, &[]).await.context("request a pty")?;
        channel.request_shell(true).await.context("request a shell")?;
        let (rx, tx) = channel.split();
        Ok(Self { rx, tx, pending: Vec::new(), _lease: lease })
    }

    /// 把沒用完的資料放回去。/ Push unconsumed bytes back.
    pub fn unread(&mut self, data: Vec<u8>) {
        self.pending = data;
    }

    /// 等下一件事；channel 關閉回 None。/ Next event; None once the channel is closed.
    pub async fn next(&mut self) -> Option<Output> {
        if !self.pending.is_empty() {
            return Some(Output::Data(std::mem::take(&mut self.pending)));
        }
        let mut exit = None;
        loop {
            match self.rx.wait().await? {
                ChannelMsg::Data { data } => return Some(Output::Data(data.to_vec())),
                ChannelMsg::ExtendedData { data, .. } => return Some(Output::Data(data.to_vec())),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => return Some(Output::Exit(exit)),
                _ => {}
            }
        }
    }

    pub async fn write(&self, data: &[u8]) -> anyhow::Result<()> {
        self.tx.data_bytes(data.to_vec()).await.context("write to the pty")
    }

    pub async fn resize(&self, size: WindowSize) -> anyhow::Result<()> {
        self.tx.window_change(size.cols, size.rows, size.width, size.height).await.context("window-change")
    }

    /// 關 channel（裝置端收到 close 會結束 shell）。/ Close the channel; the device ends the shell.
    pub async fn close(&self) {
        let _ = self.tx.eof().await;
        let _ = self.tx.close().await;
    }
}
