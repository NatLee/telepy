//! gateway 看到的來源位址（啟動以來，只在記憶體）：每個位址連了幾次、其中幾次開頭是 PROXY protocol header。
//! 用途是回答管理員「PROXY protocol 來源要填什麼」：前面的 L4 代理會以同一個（通常是內網）位址出現，而且它的連線
//! 開頭是 header。沒列在來源裡的位址送來的 header **只被認出來、從不被讀或採信**（[`FirstRead`] 只看第一段資料，
//! 不改任何行為）——不然任何人都能自稱別的 IP。russh 不接受客戶端在 SSH banner 前送別的東西，所以這種連線在握手
//! 就失敗：代理後面的裝置全都連不上。這正是要提醒的事（`proxy_unlisted` 事件，每個位址每小時最多一次）。
//! What the gateway sees connecting (since start, memory only): connections per address and how many began
//! with a PROXY protocol header. It answers "what goes into PROXY protocol sources": the L4 proxy in front shows
//! up as one (usually private) address whose connections start with a header. A header from an unlisted address
//! is **only recognised, never read or trusted** ([`FirstRead`] looks at the first chunk and changes nothing) —
//! anyone could claim any address otherwise. russh accepts nothing before a client's SSH banner, so such
//! connections fail at the handshake and no device behind that proxy gets in: that is what the `proxy_unlisted`
//! event (at most hourly per address) points out.

use std::collections::HashMap;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Mutex;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// 最多記幾個位址（網路上的掃描器很多；滿了丟最久沒出現的）。/ Addresses kept at most (scanners abound; the stalest go).
pub const MAX_PEERS: usize = 512;
/// 同一個位址的 `proxy_unlisted` 事件最少隔多久。/ The minimum gap between `proxy_unlisted` events per address.
pub const UNLISTED_EVENT_EVERY: Duration = Duration::from_secs(3600);

const V2_SIGNATURE: &[u8; 12] = b"\r\n\r\n\0\r\nQUIT\n";

/// 連線的第一段資料是不是 PROXY protocol header（v1 `PROXY `、v2 的 12 byte 簽章）。太短就當不是：漏認無害。
/// Whether a connection's first chunk is a PROXY protocol header (v1 `PROXY `, v2's 12-byte signature). Too short
/// counts as no: missing one is harmless.
pub fn looks_like_proxy_header(first: &[u8]) -> bool {
    first.starts_with(b"PROXY ") || first.starts_with(V2_SIGNATURE)
}

/// 一個位址的統計。/ One address's counts.
#[derive(Debug, Clone, PartialEq)]
pub struct PeerSeen {
    pub connections: u64,
    pub proxy_headers: u64,
    pub first_at: DateTime<Utc>,
    pub last_at: DateTime<Utc>,
    pub last_header_at: Option<DateTime<Utc>>,
    /// 最後一次連線時是不是 PROXY protocol 來源。/ Whether it was a listed source on its last connection.
    pub listed: bool,
}

#[derive(Debug)]
struct Entry {
    seen: PeerSeen,
    last_event: Option<Instant>,
    touched: Instant,
}

#[derive(Debug, Default)]
pub struct PeerStats {
    map: Mutex<HashMap<IpAddr, Entry>>,
}

impl PeerStats {
    /// 記一條送了資料的連線。回傳 true = 這是沒列出的位址送來的 header，而且該寫 `proxy_unlisted` 事件了。
    /// Record a connection that sent data. True = a header from an unlisted address, and an event is due.
    pub fn record(&self, ip: IpAddr, header: bool, listed: bool) -> bool {
        self.record_at(ip.to_canonical(), header, listed, Utc::now(), Instant::now())
    }

    fn record_at(&self, ip: IpAddr, header: bool, listed: bool, now: DateTime<Utc>, mono: Instant) -> bool {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if !map.contains_key(&ip) && map.len() >= MAX_PEERS {
            if let Some(stalest) = map.iter().min_by_key(|(_, e)| e.touched).map(|(ip, _)| *ip) {
                map.remove(&stalest);
            }
        }
        let entry = map.entry(ip).or_insert_with(|| Entry {
            seen: PeerSeen { connections: 0, proxy_headers: 0, first_at: now, last_at: now, last_header_at: None, listed },
            last_event: None,
            touched: mono,
        });
        entry.seen.connections += 1;
        entry.seen.last_at = now;
        entry.seen.listed = listed;
        entry.touched = mono;
        if header {
            entry.seen.proxy_headers += 1;
            entry.seen.last_header_at = Some(now);
        }
        let due = header && !listed && entry.last_event.is_none_or(|t| mono.saturating_duration_since(t) >= UNLISTED_EVENT_EVERY);
        if due {
            entry.last_event = Some(mono);
        }
        due
    }

    /// 目前記著的位址，送過 header 的在前，再依連線數。/ The addresses kept: header senders first, then by connections.
    pub fn snapshot(&self) -> Vec<(IpAddr, PeerSeen)> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<(IpAddr, PeerSeen)> = map.iter().map(|(ip, e)| (*ip, e.seen.clone())).collect();
        out.sort_by(|a, b| (b.1.proxy_headers > 0).cmp(&(a.1.proxy_headers > 0)).then(b.1.connections.cmp(&a.1.connections)).then(a.0.cmp(&b.0)));
        out
    }
}

type OnFirst = Box<dyn FnOnce(&[u8]) + Send>;

/// 把連線的第一段資料交給 `on_first` 看一次，其餘原樣轉手（不多讀、不改內容）。
/// Hands a connection's first chunk to `on_first` once and passes everything through untouched.
pub struct FirstRead<S> {
    inner: S,
    on_first: Option<OnFirst>,
}

impl<S> FirstRead<S> {
    pub fn new(inner: S, on_first: OnFirst) -> Self {
        Self { inner, on_first: Some(on_first) }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for FirstRead<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(polled, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            if let Some(f) = self.on_first.take() {
                f(&buf.filled()[before..]);
            }
        }
        polled
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for FirstRead<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, data)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
    fn poll_write_vectored(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[std::io::IoSlice<'_>]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn recognises_both_header_versions_and_nothing_else() {
        assert!(looks_like_proxy_header(b"PROXY TCP4 203.0.113.5 10.0.0.1 5555 22\r\n"));
        assert!(looks_like_proxy_header(b"PROXY UNKNOWN\r\n"));
        assert!(looks_like_proxy_header(b"\r\n\r\n\0\r\nQUIT\n\x21\x11\x00\x0c"));
        assert!(!looks_like_proxy_header(b"SSH-2.0-OpenSSH_9.6\r\n"));
        assert!(!looks_like_proxy_header(b"POST / HTTP/1.1\r\n"));
        assert!(!looks_like_proxy_header(b"PROX"), "too short to tell");
        assert!(!looks_like_proxy_header(b"\r\n\r\n"), "a partial v2 signature is not enough");
        assert!(!looks_like_proxy_header(b""));
    }

    #[test]
    fn counts_and_rate_limits_the_unlisted_event() {
        let stats = PeerStats::default();
        let t0 = Instant::now();
        let now = Utc::now();
        assert!(stats.record_at(ip("10.0.0.5"), true, false, now, t0), "first header from an unlisted address");
        assert!(!stats.record_at(ip("10.0.0.5"), true, false, now, t0 + Duration::from_secs(60)), "not again within the hour");
        assert!(stats.record_at(ip("10.0.0.5"), true, false, now, t0 + UNLISTED_EVENT_EVERY + Duration::from_secs(61)));
        assert!(!stats.record_at(ip("10.0.0.6"), true, true, now, t0), "a listed source is read, nothing to warn about");
        assert!(!stats.record_at(ip("10.0.0.7"), false, false, now, t0), "no header, no event");
        let snap = stats.snapshot();
        assert_eq!(snap[0].0, ip("10.0.0.5"));
        assert_eq!((snap[0].1.connections, snap[0].1.proxy_headers, snap[0].1.listed), (3, 3, false));
        assert_eq!(snap.last().unwrap().0, ip("10.0.0.7"), "addresses without headers come last");
    }

    #[test]
    fn mapped_v4_is_the_same_address() {
        let stats = PeerStats::default();
        stats.record(ip("::ffff:10.0.0.5"), false, false);
        stats.record(ip("10.0.0.5"), false, false);
        assert_eq!(stats.snapshot().len(), 1);
    }

    #[test]
    fn drops_the_stalest_when_full() {
        let stats = PeerStats::default();
        let t0 = Instant::now();
        let now = Utc::now();
        for i in 0..MAX_PEERS {
            let a = IpAddr::from([10, 1, (i / 256) as u8, (i % 256) as u8]);
            stats.record_at(a, false, false, now, t0 + Duration::from_millis(i as u64 + 1));
        }
        stats.record_at(ip("192.0.2.1"), false, false, now, t0 + Duration::from_secs(3600));
        let snap = stats.snapshot();
        assert_eq!(snap.len(), MAX_PEERS);
        assert!(!snap.iter().any(|(a, _)| *a == IpAddr::from([10, 1, 0, 0])), "the stalest went");
        assert!(snap.iter().any(|(a, _)| *a == ip("192.0.2.1")));
    }

    #[tokio::test]
    async fn first_read_sees_the_first_chunk_once_and_changes_nothing() {
        let (mut client, server) = tokio::io::duplex(64);
        let seen = std::sync::Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let s2 = seen.clone();
        let mut wrapped = FirstRead::new(server, Box::new(move |b: &[u8]| s2.lock().unwrap().push(b.to_vec())));
        client.write_all(b"PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n").await.unwrap();
        let mut buf = [0u8; 64];
        let n = wrapped.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n");
        client.write_all(b"SSH-2.0-x\r\n").await.unwrap();
        let n = wrapped.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"SSH-2.0-x\r\n");
        wrapped.write_all(b"pong").await.unwrap();
        let mut back = [0u8; 4];
        client.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"pong");
        assert_eq!(seen.lock().unwrap().as_slice(), &[b"PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\n".to_vec()]);
    }
}
