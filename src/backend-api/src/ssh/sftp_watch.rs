//! 共用 SFTP channel 的健康狀態。連線池讓同一台、同一個 OS 帳號的檔案管理與 SFTP REST 共用一條 sftp channel，
//! 而裝置的 sftp-server 一次只處理一個請求：它卡住（例如卡在掛掉的網路磁碟上）時，所有人會一起卡住。
//! 所以包住 channel 的 stream，數送出的請求與收到的回覆（SFTP v3 每個請求剛好一個回覆，INIT 對 VERSION），
//! 記下最後一次收到東西的時間：channel 關了，或有請求在等卻超過 [`STUCK_AFTER`] 什麼都沒收到，
//! 就算壞掉，連線池改開一條新的。
//! Health of a shared SFTP channel: the device's sftp-server answers one request at a time, so one hung
//! request would stall everyone sharing the channel. Count requests and replies on the stream (one reply per
//! request in SFTP v3) and note when anything last arrived; a closed channel, or requests waiting with no
//! progress for [`STUCK_AFTER`], marks it broken and the pool opens a new one.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// 有請求在等、卻這麼久沒收到任何東西 = 卡住（比 russh-sftp 每個請求 10 秒的逾時長）。
/// Requests waiting with nothing received for this long = stuck (longer than russh-sftp's 10 s request timeout).
pub const STUCK_AFTER: Duration = Duration::from_secs(15);

/// SFTP 封包切割（`u32` 長度 + 內容），只數完整的封包。/ Splits the stream into `u32`-length-prefixed packets.
#[derive(Debug, Default)]
pub struct Framer {
    header: [u8; 4],
    have: usize,
    remaining: u64,
}

impl Framer {
    /// 吃進一段位元組，回傳這段裡結束了幾個封包。/ Feed bytes; returns how many packets they completed.
    pub fn feed(&mut self, mut data: &[u8]) -> u64 {
        let mut done = 0;
        while !data.is_empty() {
            if self.remaining > 0 {
                let n = usize::try_from(self.remaining).unwrap_or(usize::MAX).min(data.len());
                self.remaining -= n as u64;
                data = &data[n..];
                if self.remaining == 0 {
                    done += 1;
                }
                continue;
            }
            let n = (4 - self.have).min(data.len());
            self.header[self.have..self.have + n].copy_from_slice(&data[..n]);
            self.have += n;
            data = &data[n..];
            if self.have == 4 {
                self.have = 0;
                self.remaining = u64::from(u32::from_be_bytes(self.header));
                if self.remaining == 0 {
                    done += 1;
                }
            }
        }
        done
    }
}

#[derive(Debug, Default)]
struct State {
    out: Framer,
    inbound: Framer,
    sent: u64,
    received: u64,
    /// 從什麼時候開始等、而且之後什麼都沒收到；沒有請求在等時是 None。/ Waiting with no progress since.
    waiting_since: Option<Instant>,
    closed: bool,
}

/// 一條 sftp channel 的觀察結果。/ What we saw on one sftp channel.
#[derive(Debug, Default)]
pub struct Watch(Mutex<State>);

impl Watch {
    fn on_write(&self, data: &[u8], now: Instant) {
        let mut s = self.0.lock().unwrap();
        let done = s.out.feed(data);
        if done > 0 {
            if s.sent <= s.received {
                s.waiting_since = Some(now);
            }
            s.sent += done;
        }
    }

    /// 收到東西 = 對方還活著：重新計時（還有請求在等的話）。/ Anything received resets the clock.
    fn on_read(&self, data: &[u8], now: Instant) {
        let mut s = self.0.lock().unwrap();
        let done = s.inbound.feed(data);
        s.received += done;
        s.waiting_since = (s.sent > s.received).then_some(now);
    }

    fn on_closed(&self) {
        self.0.lock().unwrap().closed = true;
    }

    /// 還能用：沒關，也沒有卡住的請求。/ Usable: not closed and not stuck.
    pub fn healthy_at(&self, now: Instant) -> bool {
        let s = self.0.lock().unwrap();
        !s.closed && !s.waiting_since.is_some_and(|t| now.saturating_duration_since(t) >= STUCK_AFTER)
    }

    pub fn healthy(&self) -> bool {
        self.healthy_at(Instant::now())
    }
}

/// 包住 channel stream、把讀寫餵給 [`Watch`]。/ A stream wrapper that feeds reads and writes to a [`Watch`].
pub struct Watched<S> {
    inner: S,
    watch: Arc<Watch>,
}

impl<S> Watched<S> {
    pub fn new(inner: S) -> (Self, Arc<Watch>) {
        let watch = Arc::new(Watch::default());
        (Self { inner, watch: watch.clone() }, watch)
    }
}

/// russh-sftp 的 runtime 結束（`close()`、對方斷線）時丟掉 stream，不一定先讀到 EOF：丟掉也算關了。
/// The russh-sftp runtime drops the stream when it ends, not always after an EOF: dropping counts as closed.
impl<S> Drop for Watched<S> {
    fn drop(&mut self) {
        self.watch.on_closed();
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Watched<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let (before, had_room) = (buf.filled().len(), buf.remaining() > 0);
        let polled = Pin::new(&mut this.inner).poll_read(cx, buf);
        match &polled {
            Poll::Ready(Ok(())) if had_room && buf.filled().len() == before => this.watch.on_closed(),
            Poll::Ready(Ok(())) => this.watch.on_read(&buf.filled()[before..], Instant::now()),
            Poll::Ready(Err(_)) => this.watch.on_closed(),
            Poll::Pending => {}
        }
        polled
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Watched<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_write(cx, buf);
        match &polled {
            Poll::Ready(Ok(n)) => this.watch.on_write(&buf[..*n], Instant::now()),
            Poll::Ready(Err(_)) => this.watch.on_closed(),
            Poll::Pending => {}
        }
        polled
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        this.watch.on_closed();
        Pin::new(&mut this.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(body: &[u8]) -> Vec<u8> {
        let mut p = (body.len() as u32).to_be_bytes().to_vec();
        p.extend_from_slice(body);
        p
    }

    #[test]
    fn framer_counts_whole_packets_across_splits() {
        let mut f = Framer::default();
        let mut stream = packet(b"hello");
        stream.extend(packet(b""));
        stream.extend(packet(&[7; 300]));
        // 一個位元組一個位元組餵：照樣是 3 個 / Byte by byte still makes three.
        let total: u64 = stream.iter().map(|b| f.feed(std::slice::from_ref(b))).sum();
        assert_eq!(total, 3);
        // 一次全部、或從封包中間切開 / All at once, or cut in the middle of a header and a body.
        let mut f = Framer::default();
        assert_eq!(f.feed(&stream), 3);
        let mut f = Framer::default();
        assert_eq!(f.feed(&stream[..2]), 0);
        assert_eq!(f.feed(&stream[2..12]), 1, "the zero-length packet's header is one byte short");
        assert_eq!(f.feed(&stream[12..13]), 1);
        assert_eq!(f.feed(&stream[13..]), 1);
    }

    #[test]
    fn idle_and_answered_channels_are_healthy() {
        let w = Watch::default();
        let t0 = Instant::now();
        assert!(w.healthy_at(t0 + Duration::from_secs(3600)), "nothing asked yet");
        w.on_write(&packet(b"req"), t0);
        w.on_read(&packet(b"reply"), t0 + Duration::from_secs(1));
        assert!(w.healthy_at(t0 + Duration::from_secs(3600)), "every request answered");
    }

    #[test]
    fn a_request_without_any_reply_marks_the_channel_stuck() {
        let w = Watch::default();
        let t0 = Instant::now();
        w.on_write(&packet(b"req"), t0);
        assert!(w.healthy_at(t0 + STUCK_AFTER - Duration::from_millis(1)));
        assert!(!w.healthy_at(t0 + STUCK_AFTER));
    }

    #[test]
    fn progress_resets_the_clock() {
        let w = Watch::default();
        let t0 = Instant::now();
        w.on_write(&packet(b"a"), t0);
        w.on_write(&packet(b"b"), t0 + Duration::from_secs(10));
        // 第一個的回覆在 12 秒到，第二個還在等：從 12 秒重新算。/ The first reply at 12 s restarts the wait.
        w.on_read(&packet(b"ra"), t0 + Duration::from_secs(12));
        assert!(w.healthy_at(t0 + Duration::from_secs(26)));
        assert!(!w.healthy_at(t0 + Duration::from_secs(27)));
        // 大回覆的一部分也算進展 / Part of a large reply counts as progress too.
        let big = packet(&[0; 100]);
        w.on_read(&big[..50], t0 + Duration::from_secs(27));
        assert!(w.healthy_at(t0 + Duration::from_secs(40)));
        w.on_read(&big[50..], t0 + Duration::from_secs(41));
        assert!(w.healthy_at(t0 + Duration::from_secs(3600)), "both answered");
    }

    #[test]
    fn a_new_request_after_a_quiet_period_starts_a_fresh_wait() {
        let w = Watch::default();
        let t0 = Instant::now();
        w.on_write(&packet(b"a"), t0);
        w.on_read(&packet(b"ra"), t0);
        let later = t0 + Duration::from_secs(600);
        w.on_write(&packet(b"b"), later);
        assert!(w.healthy_at(later + Duration::from_secs(1)), "not stuck just because the last reply is old");
    }

    #[test]
    fn closed_is_never_healthy() {
        let w = Watch::default();
        w.on_closed();
        assert!(!w.healthy());
    }

    #[tokio::test]
    async fn the_wrapper_sees_both_directions_and_eof() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (client, mut server) = tokio::io::duplex(1024);
        let (mut watched, watch) = Watched::new(client);
        watched.write_all(&packet(b"req")).await.unwrap();
        let mut got = [0u8; 7];
        server.read_exact(&mut got).await.unwrap();
        server.write_all(&packet(b"reply")).await.unwrap();
        let mut reply = [0u8; 9];
        watched.read_exact(&mut reply).await.unwrap();
        assert!(watch.healthy());
        drop(server);
        let mut rest = Vec::new();
        watched.read_to_end(&mut rest).await.unwrap();
        assert!(!watch.healthy(), "EOF = closed");
    }
}
