//! `telepy-carrier vpn-agent`：`telepy vpn --carrier` 時在裝置上、經 SSH 的 stdin / stdout 幫忙做 SSH 的 TCP 轉送
//! 做不到的事——送 UDP、ping、用裝置自己的方式查名稱。只活在那一條 SSH 連線裡：不寫檔、不需要 root、stdin 一關就結束。
//! 能做的只是登入的帳號本來就能做的事（跟 `ssh -D` 一樣）。
//!
//! 協定（兩端都是這個模組）：agent 先寫一行 `TELEPY-AGENT 1\n`，之後是一筆筆 frame：`[u32 長度][u8 種類][內容]`，
//! 長度 = 種類 + 內容的位元組數，大端序。
//!
//! `telepy-carrier vpn-agent`: on the device, over the SSH session's stdin / stdout, it does for `telepy vpn --carrier`
//! what SSH's TCP forwarding can't — send UDP, ping, look names up the device's own way. It lives only inside that SSH
//! session: no files, no root, it ends when stdin closes. It can only do what the logged-in account could anyway (like
//! `ssh -D`).
//!
//! Protocol (both ends use this module): the agent first writes the line `TELEPY-AGENT 1\n`, then frames:
//! `[u32 length][u8 kind][body]`, length = kind + body bytes, big-endian.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

/// agent 開頭寫的那一行。/ The line the agent starts with.
pub const HELLO_LINE: &str = "TELEPY-AGENT 1";
/// 找不到可用的 carrier 時，裝置上的小腳本寫的那一行。/ The line the device-side script writes when no usable carrier is found.
pub const NONE_LINE: &str = "TELEPY-AGENT-NONE";
/// 一筆 frame 最多多大（UDP 封包最大 64 KiB）。/ The largest frame (a UDP datagram is at most 64 KiB).
pub const MAX_FRAME: usize = 70_000;
/// UDP 流多久沒動靜就關。/ A UDP flow quiet this long is closed.
pub const UDP_IDLE: Duration = Duration::from_secs(120);
/// 等 ping 回覆多久。/ How long a ping waits for its reply.
pub const PING_WAIT: Duration = Duration::from_secs(3);

/// ping 的結果。/ A ping's outcome.
pub const PONG_OK: u8 = 0;
pub const PONG_TIMEOUT: u8 = 1;
/// 這個帳號在裝置上不能 ping（Linux 的 net.ipv4.ping_group_range）。/ This account may not ping there.
pub const PONG_NOT_ALLOWED: u8 = 2;
pub const PONG_FAILED: u8 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// agent → telepy：版本、能不能 ping。/ agent → telepy: version, whether it may ping.
    Hello { version: String, ping: bool },
    /// telepy → agent：從這個流送一個 UDP 封包。/ telepy → agent: send a UDP datagram on this flow.
    UdpOut { flow: u32, to: SocketAddrV4, data: Vec<u8> },
    /// agent → telepy：這個流收到一個 UDP 封包。/ agent → telepy: this flow received a datagram.
    UdpIn { flow: u32, from: SocketAddrV4, data: Vec<u8> },
    /// 流結束（任一方）。/ A flow ended (either side).
    Close { flow: u32 },
    Ping { id: u32, to: Ipv4Addr, seq: u16, data: Vec<u8> },
    Pong { id: u32, status: u8 },
    Resolve { id: u32, name: String },
    Resolved { id: u32, ips: Vec<Ipv4Addr> },
}

const K_HELLO: u8 = 1;
const K_UDP_OUT: u8 = 2;
const K_UDP_IN: u8 = 3;
const K_CLOSE: u8 = 4;
const K_PING: u8 = 5;
const K_PONG: u8 = 6;
const K_RESOLVE: u8 = 7;
const K_RESOLVED: u8 = 8;

fn put_addr(out: &mut Vec<u8>, a: &SocketAddrV4) {
    out.extend_from_slice(&a.ip().octets());
    out.extend_from_slice(&a.port().to_be_bytes());
}

pub fn encode(f: &Frame) -> Vec<u8> {
    let mut b = Vec::new();
    match f {
        Frame::Hello { version, ping } => {
            b.push(K_HELLO);
            b.push(u8::from(*ping));
            b.extend_from_slice(version.as_bytes());
        }
        Frame::UdpOut { flow, to, data } => {
            b.push(K_UDP_OUT);
            b.extend_from_slice(&flow.to_be_bytes());
            put_addr(&mut b, to);
            b.extend_from_slice(data);
        }
        Frame::UdpIn { flow, from, data } => {
            b.push(K_UDP_IN);
            b.extend_from_slice(&flow.to_be_bytes());
            put_addr(&mut b, from);
            b.extend_from_slice(data);
        }
        Frame::Close { flow } => {
            b.push(K_CLOSE);
            b.extend_from_slice(&flow.to_be_bytes());
        }
        Frame::Ping { id, to, seq, data } => {
            b.push(K_PING);
            b.extend_from_slice(&id.to_be_bytes());
            b.extend_from_slice(&to.octets());
            b.extend_from_slice(&seq.to_be_bytes());
            b.extend_from_slice(data);
        }
        Frame::Pong { id, status } => {
            b.push(K_PONG);
            b.extend_from_slice(&id.to_be_bytes());
            b.push(*status);
        }
        Frame::Resolve { id, name } => {
            b.push(K_RESOLVE);
            b.extend_from_slice(&id.to_be_bytes());
            b.extend_from_slice(name.as_bytes());
        }
        Frame::Resolved { id, ips } => {
            b.push(K_RESOLVED);
            b.extend_from_slice(&id.to_be_bytes());
            for ip in ips.iter().take(32) {
                b.extend_from_slice(&ip.octets());
            }
        }
    }
    let mut out = (b.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&b);
    out
}

fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

fn addr_at(b: &[u8], i: usize) -> Option<SocketAddrV4> {
    let ip = Ipv4Addr::new(*b.get(i)?, *b.get(i + 1)?, *b.get(i + 2)?, *b.get(i + 3)?);
    Some(SocketAddrV4::new(ip, u16::from_be_bytes([*b.get(i + 4)?, *b.get(i + 5)?])))
}

/// 從緩衝區讀一筆 frame：`Ok(None)` = 還不夠；`Err` = 壞掉的資料（連線該斷）。
/// Read one frame from the buffer: `Ok(None)` = not enough yet; `Err` = broken data (the connection should end).
pub fn decode(buf: &[u8]) -> Result<Option<(Frame, usize)>, String> {
    let Some(len) = u32_at(buf, 0) else { return Ok(None) };
    let len = len as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(format!("frame of {len} bytes"));
    }
    if buf.len() < 4 + len {
        return Ok(None);
    }
    let b = &buf[4..4 + len];
    let bad = || format!("short frame of kind {}", b[0]);
    let f = match b[0] {
        K_HELLO => Frame::Hello { ping: *b.get(1).ok_or_else(bad)? != 0, version: String::from_utf8_lossy(b.get(2..).unwrap_or_default()).into_owned() },
        K_UDP_OUT | K_UDP_IN => {
            let flow = u32_at(b, 1).ok_or_else(bad)?;
            let a = addr_at(b, 5).ok_or_else(bad)?;
            let data = b[11..].to_vec();
            if b[0] == K_UDP_OUT {
                Frame::UdpOut { flow, to: a, data }
            } else {
                Frame::UdpIn { flow, from: a, data }
            }
        }
        K_CLOSE => Frame::Close { flow: u32_at(b, 1).ok_or_else(bad)? },
        K_PING => {
            let id = u32_at(b, 1).ok_or_else(bad)?;
            let to = addr_at(b, 5).ok_or_else(bad)?;
            Frame::Ping { id, to: *to.ip(), seq: to.port(), data: b[11..].to_vec() }
        }
        K_PONG => Frame::Pong { id: u32_at(b, 1).ok_or_else(bad)?, status: *b.get(5).ok_or_else(bad)? },
        K_RESOLVE => Frame::Resolve { id: u32_at(b, 1).ok_or_else(bad)?, name: String::from_utf8_lossy(b.get(5..).ok_or_else(bad)?).into_owned() },
        K_RESOLVED => {
            let id = u32_at(b, 1).ok_or_else(bad)?;
            let ips = b.get(5..).ok_or_else(bad)?.as_chunks::<4>().0.iter().map(|c| Ipv4Addr::from(*c)).collect();
            Frame::Resolved { id, ips }
        }
        k => return Err(format!("unknown frame kind {k}")),
    };
    Ok(Some((f, 4 + len)))
}

/// 名稱看起來像不像主機名稱（只讓這種去查）。/ Whether a name looks like a host name (only those are looked up).
pub fn plausible_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 253 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// ICMP echo request（給 ICMP datagram socket；識別碼由核心填）。/ An ICMP echo request (for an ICMP datagram socket).
pub fn echo_request(seq: u16, data: &[u8]) -> Vec<u8> {
    let mut m = vec![8u8, 0, 0, 0, 0, 0];
    m.extend_from_slice(&seq.to_be_bytes());
    m.extend_from_slice(data);
    let c = checksum(&m);
    m[2..4].copy_from_slice(&c.to_be_bytes());
    m
}

/// 從 ICMP datagram socket 收到的東西裡找 echo reply 的序號（macOS 會連 IP 標頭一起給）。
/// The echo reply's sequence number in what an ICMP datagram socket returned (macOS includes the IP header).
pub fn echo_reply_seq(got: &[u8]) -> Option<u16> {
    let m = if got.first().is_some_and(|b| b >> 4 == 4) { got.get(usize::from(got[0] & 0x0f) * 4..)? } else { got };
    (m.first() == Some(&0) && m.len() >= 8).then(|| u16::from_be_bytes([m[6], m[7]]))
}

fn checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = data.chunks(2).map(|c| u32::from(u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))).sum();
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

/// 開一個 ICMP datagram socket（不用 root；Linux 看 net.ipv4.ping_group_range，macOS 都行）。
/// Open an ICMP datagram socket (no root; Linux checks net.ipv4.ping_group_range, macOS allows it).
#[cfg(unix)]
fn icmp_socket() -> std::io::Result<UdpSocket> {
    use std::os::fd::FromRawFd;
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, libc::IPPROTO_ICMP) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let std_sock = unsafe { std::net::UdpSocket::from_raw_fd(fd) };
    std_sock.set_nonblocking(true)?;
    UdpSocket::from_std(std_sock)
}

#[cfg(not(unix))]
fn icmp_socket() -> std::io::Result<UdpSocket> {
    Err(std::io::Error::other("ping isn't available here"))
}

async fn ping_once(to: Ipv4Addr, seq: u16, data: &[u8]) -> u8 {
    let sock = match icmp_socket() {
        Ok(s) => s,
        Err(e) if matches!(e.raw_os_error(), Some(code) if code == libc_eacces() || code == libc_eperm()) => return PONG_NOT_ALLOWED,
        Err(_) => return PONG_FAILED,
    };
    if sock.send_to(&echo_request(seq, data), SocketAddr::from((to, 0))).await.is_err() {
        return PONG_FAILED;
    }
    let mut buf = vec![0u8; 2048];
    let wait = async {
        loop {
            match sock.recv_from(&mut buf).await {
                Ok((n, _)) if echo_reply_seq(&buf[..n]) == Some(seq) => return PONG_OK,
                Ok(_) => continue,
                Err(_) => return PONG_FAILED,
            }
        }
    };
    tokio::time::timeout(PING_WAIT, wait).await.unwrap_or(PONG_TIMEOUT)
}

#[cfg(unix)]
fn libc_eacces() -> i32 {
    libc::EACCES
}
#[cfg(unix)]
fn libc_eperm() -> i32 {
    libc::EPERM
}
#[cfg(not(unix))]
fn libc_eacces() -> i32 {
    -1
}
#[cfg(not(unix))]
fn libc_eperm() -> i32 {
    -1
}

/// 在 stdin / stdout 上跑 agent，直到 stdin 關掉。/ Run the agent over stdin / stdout until stdin closes.
pub async fn serve<R, W>(input: R, mut output: W, version: &str) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::channel::<Frame>(256);
    output.write_all(format!("{HELLO_LINE}\n").as_bytes()).await?;
    let can_ping = icmp_socket().is_ok();
    output.write_all(&encode(&Frame::Hello { version: version.to_string(), ping: can_ping })).await?;
    output.flush().await?;
    let writer = tokio::spawn(async move {
        while let Some(f) = rx.recv().await {
            if output.write_all(&encode(&f)).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });
    let flows: Arc<Mutex<HashMap<u32, Arc<UdpSocket>>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut input = BufReader::new(input);
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 65536];
    loop {
        let n = input.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        loop {
            match decode(&buf) {
                Ok(Some((f, used))) => {
                    buf.drain(..used);
                    handle(f, &tx, &flows).await;
                }
                Ok(None) => break,
                Err(e) => return Err(std::io::Error::other(e)),
            }
        }
    }
    writer.abort();
    Ok(())
}

async fn handle(f: Frame, tx: &mpsc::Sender<Frame>, flows: &Arc<Mutex<HashMap<u32, Arc<UdpSocket>>>>) {
    match f {
        Frame::UdpOut { flow, to, data } => {
            let existing = flows.lock().ok().and_then(|m| m.get(&flow).cloned());
            let sock = match existing {
                Some(s) => s,
                None => {
                    let Ok(s) = UdpSocket::bind("0.0.0.0:0").await else {
                        let _ = tx.send(Frame::Close { flow }).await;
                        return;
                    };
                    let s = Arc::new(s);
                    if let Ok(mut m) = flows.lock() {
                        m.insert(flow, s.clone());
                    }
                    let (s2, tx2, flows2) = (s.clone(), tx.clone(), flows.clone());
                    tokio::spawn(async move {
                        let mut b = vec![0u8; 65536];
                        while let Ok(Ok((n, SocketAddr::V4(from)))) = tokio::time::timeout(UDP_IDLE, s2.recv_from(&mut b)).await {
                            if tx2.send(Frame::UdpIn { flow, from, data: b[..n].to_vec() }).await.is_err() {
                                break;
                            }
                        }
                        if let Ok(mut m) = flows2.lock() {
                            m.remove(&flow);
                        }
                        let _ = tx2.send(Frame::Close { flow }).await;
                    });
                    s
                }
            };
            let _ = sock.send_to(&data, to).await;
        }
        Frame::Close { flow } => {
            if let Ok(mut m) = flows.lock() {
                m.remove(&flow);
            }
        }
        Frame::Ping { id, to, seq, data } => {
            let tx = tx.clone();
            tokio::spawn(async move {
                let status = ping_once(to, seq, &data).await;
                let _ = tx.send(Frame::Pong { id, status }).await;
            });
        }
        Frame::Resolve { id, name } => {
            let tx = tx.clone();
            tokio::spawn(async move {
                let ips = if plausible_name(&name) {
                    tokio::task::spawn_blocking(move || {
                        use std::net::ToSocketAddrs;
                        (name.as_str(), 0).to_socket_addrs().map(|it| it.filter_map(|a| if let SocketAddr::V4(v) = a { Some(*v.ip()) } else { None }).collect::<Vec<_>>()).unwrap_or_default()
                    })
                    .await
                    .unwrap_or_default()
                } else {
                    Vec::new()
                };
                let mut seen = std::collections::HashSet::new();
                let ips = ips.into_iter().filter(|ip| seen.insert(*ip)).collect();
                let _ = tx.send(Frame::Resolved { id, ips }).await;
            });
        }
        // 這些只會從 agent 送出。/ Only the agent sends these.
        Frame::Hello { .. } | Frame::UdpIn { .. } | Frame::Pong { .. } | Frame::Resolved { .. } => {}
    }
}

/// 讀 agent 的開頭：`Ok(true)` = agent 在，`Ok(false)` = 裝置上沒有能用的 carrier。
/// Read the agent's opening: `Ok(true)` = the agent is there, `Ok(false)` = no usable carrier on the device.
pub async fn read_opening<R: AsyncRead + Unpin>(r: &mut BufReader<R>) -> std::io::Result<bool> {
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line).await? == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        match line.trim_end() {
            HELLO_LINE => return Ok(true),
            NONE_LINE => return Ok(false),
            // 登入時的訊息（motd、shell 的雜訊）略過。/ Skip login noise (motd, shell chatter).
            _ if line.len() > 4096 => return Err(std::io::ErrorKind::InvalidData.into()),
            _ => continue,
        }
    }
}

/// 在裝置上找可用的 carrier 並啟動 agent 的指令（只讀、不寫）：`~/.ssh/telepy-*-ws.bin` 中 `--help` 提到 vpn-agent 的那個。
/// The device-side command that finds a usable carrier and starts the agent (reads only): the `~/.ssh/telepy-*-ws.bin`
/// whose `--help` mentions vpn-agent.
pub fn remote_command() -> String {
    format!(
        "exec sh -c 'for f in \"$HOME\"/.ssh/telepy-*-ws.bin; do if [ -x \"$f\" ] && \"$f\" --help 2>/dev/null | grep -q vpn-agent; then exec \"$f\" vpn-agent; fi; done; echo {NONE_LINE}; exit 3'"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_frame_round_trips_and_partial_input_waits() {
        let frames = vec![
            Frame::Hello { version: "2.18.0".into(), ping: true },
            Frame::UdpOut { flow: 7, to: "10.77.0.10:123".parse().unwrap(), data: vec![1, 2, 3] },
            Frame::UdpIn { flow: 7, from: "10.77.0.10:123".parse().unwrap(), data: vec![] },
            Frame::Close { flow: 9 },
            Frame::Ping { id: 1, to: Ipv4Addr::new(10, 77, 0, 10), seq: 513, data: b"abc".to_vec() },
            Frame::Pong { id: 1, status: PONG_NOT_ALLOWED },
            Frame::Resolve { id: 2, name: "nas.corp.lan".into() },
            Frame::Resolved { id: 2, ips: vec![Ipv4Addr::new(10, 77, 0, 10), Ipv4Addr::new(10, 77, 0, 11)] },
        ];
        let mut stream = Vec::new();
        for f in &frames {
            stream.extend(encode(f));
        }
        let mut got = Vec::new();
        let mut at = 0;
        while let Some((f, used)) = decode(&stream[at..]).unwrap() {
            got.push(f);
            at += used;
        }
        assert_eq!(got, frames);
        assert_eq!(decode(&stream[..3]).unwrap(), None, "a length prefix cut short waits");
        assert_eq!(decode(&encode(&frames[1])[..8]).unwrap(), None, "a body cut short waits");
        assert!(decode(&[0, 0, 0, 0]).is_err());
        assert!(decode(&[0, 0, 0, 1, 99]).is_err(), "unknown kind");
        assert!(decode(&[0, 0, 0, 2, K_PONG, 1]).is_err(), "too short for its kind");
    }

    #[test]
    fn echo_requests_and_replies() {
        let r = echo_request(513, b"hi");
        assert_eq!((r[0], r[6], r[7]), (8, 2, 1));
        assert_eq!(checksum(&r), 0);
        let mut reply = r.clone();
        reply[0] = 0;
        assert_eq!(echo_reply_seq(&reply), Some(513));
        let with_ip = [&[0x45u8; 1][..], &[0u8; 19][..], &reply[..]].concat();
        assert_eq!(echo_reply_seq(&with_ip), Some(513), "macOS hands the IP header too");
        assert_eq!(echo_reply_seq(&r), None, "a request isn't a reply");
        assert!(plausible_name("nas.corp.lan") && !plausible_name("a b") && !plausible_name(""));
    }

    #[test]
    fn the_device_command_only_reads_and_execs() {
        let c = remote_command();
        assert!(c.starts_with("exec sh -c '") && c.contains("vpn-agent") && c.contains(NONE_LINE));
        assert_eq!(c.matches('>').count(), 1, "the only redirection is the help's stderr to /dev/null");
    }

    #[tokio::test]
    async fn the_agent_answers_udp_and_names_over_its_pipes() {
        // 本機的 UDP 回聲伺服器。/ A local UDP echo server.
        let echo = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = match echo.local_addr().unwrap() {
            SocketAddr::V4(a) => a,
            _ => unreachable!(),
        };
        tokio::spawn(async move {
            let mut b = [0u8; 1500];
            while let Ok((n, from)) = echo.recv_from(&mut b).await {
                let _ = echo.send_to(&b[..n], from).await;
            }
        });
        let (mut ours, theirs) = tokio::io::duplex(1 << 16);
        let (their_in, their_out) = tokio::io::split(theirs);
        tokio::spawn(serve(their_in, their_out, "test"));
        let (read_half, mut write_half) = tokio::io::split(&mut ours);
        let mut r = BufReader::new(read_half);
        assert!(read_opening(&mut r).await.unwrap());
        write_half.write_all(&encode(&Frame::UdpOut { flow: 1, to: echo_addr, data: b"hello".to_vec() })).await.unwrap();
        write_half.write_all(&encode(&Frame::Resolve { id: 5, name: "localhost".into() })).await.unwrap();
        let mut buf = Vec::new();
        let mut seen = Vec::new();
        let mut chunk = [0u8; 4096];
        while seen.len() < 3 {
            let n = tokio::time::timeout(Duration::from_secs(5), r.read(&mut chunk)).await.unwrap().unwrap();
            buf.extend_from_slice(&chunk[..n]);
            while let Some((f, used)) = decode(&buf).unwrap() {
                buf.drain(..used);
                seen.push(f);
            }
        }
        assert!(matches!(&seen[0], Frame::Hello { version, .. } if version == "test"));
        assert!(seen.contains(&Frame::UdpIn { flow: 1, from: echo_addr, data: b"hello".to_vec() }), "{seen:?}");
        assert!(seen.iter().any(|f| matches!(f, Frame::Resolved { id: 5, ips } if ips.contains(&Ipv4Addr::LOCALHOST))), "{seen:?}");
    }
}
