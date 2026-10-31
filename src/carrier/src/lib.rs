//! `telepy-carrier`：裝置端 ssh 的 ProxyCommand。把 stdin / stdout 接到 Telepy：先試 SSH 的 port（看到 gateway 的 `SSH-`
//! banner 才算），連不上就把位元組包進 `/ws/gateway/` 的 WebSocket 二進位 frame（只放行網頁 port 的網路）。裡面的 SSH
//! 一模一樣：同一組金鑰、同一個 host key 檢查，沒有多信任任何東西。走網頁 port 成功會記 30 分鐘（暫存目錄的小檔），
//! 之後再先試 SSH 的 port。
//!
//! 這是 `templates/telepy_ws.py` 的 Rust 版：靜態 binary，裝置不需要 python3，也不會碰裝置主人的 Python 環境；
//! 多了 HTTP CONNECT 代理（`HTTPS_PROXY` / `--proxy`，公司內網只能經代理出去時）與內建的根憑證（沒裝 ca-certificates 的
//! 路由器也能驗 TLS）。`telepy` CLI 的 `_carrier` 用同一組函式（它的順序相反：先網頁 port，退回 SSH 的 port 要同意）。
//!
//! `telepy-carrier`: the device's ssh ProxyCommand. stdin / stdout become a connection to Telepy: the SSH port first
//! (counted only once the gateway's `SSH-` banner arrives), else the bytes ride binary WebSocket frames to
//! `/ws/gateway/` (networks that only let the web port out). The SSH inside is unchanged — same keys, same host-key
//! check, nothing extra trusted. A working web port is remembered for 30 minutes, then the SSH port is tried first again.
//!
//! The Rust twin of `templates/telepy_ws.py`: a static binary, so the device needs no python3 and its owner's Python
//! setup is never touched; plus an HTTP CONNECT proxy (`HTTPS_PROXY` / `--proxy`) and built-in root certificates.
//! The `telepy` CLI's `_carrier` shares these functions (with the opposite order: web port first, consent to fall back).

use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context as _, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

/// 版本：發行版由 CI 帶 `TELEPY_VERSION`（Telepy 發行的 tag 去掉 `v`）。/ The version: release builds carry `TELEPY_VERSION`.
pub const VERSION: &str = match option_env!("TELEPY_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
/// 接受 PROXY protocol 的 gateway 會等 5 秒才先說話。/ A gateway that accepts PROXY protocol headers waits 5 s before it speaks.
pub const BANNER_TIMEOUT: Duration = Duration::from_secs(8);
pub const WS_TIMEOUT: Duration = Duration::from_secs(20);
/// 走通的網頁 port 記多久。/ How long a working web port is preferred.
pub const REMEMBER: Duration = Duration::from_secs(1800);

// ------------------------------------------------------------------ HTTP CONNECT proxy

/// 一個 HTTP 代理（`http://[user:pass@]host:port`）。/ An HTTP proxy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proxy {
    pub host: String,
    pub port: u16,
    pub auth: Option<(String, String)>,
}

impl Proxy {
    /// `http://host:3128`、`host:3128`、`http://user:pass@host`（沒有 port = 80）。socks:// 不支援 → None。
    /// Parse a proxy URL; no port = 80; a socks:// proxy is not supported (None).
    pub fn parse(s: &str) -> Option<Proxy> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        let with_scheme = if s.contains("://") { s.to_string() } else { format!("http://{s}") };
        let u = url::Url::parse(&with_scheme).ok()?;
        if u.scheme() != "http" && u.scheme() != "https" {
            return None;
        }
        let host = u.host_str()?.trim_matches(['[', ']']).to_string();
        let port = u.port().unwrap_or(80);
        let auth = if u.username().is_empty() {
            None
        } else {
            let dec = |p: &str| url::form_urlencoded::parse(format!("x={p}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default();
            Some((dec(u.username()), dec(u.password().unwrap_or(""))))
        };
        Some(Proxy { host, port, auth })
    }

    /// 環境變數：`HTTPS_PROXY` / `https_proxy` → `ALL_PROXY` / `all_proxy`；`NO_PROXY` / `no_proxy` 列到的主機不走代理。
    /// From the environment, honouring NO_PROXY for `target_host`.
    pub fn from_env(target_host: &str) -> Option<Proxy> {
        let get = |names: &[&str]| names.iter().find_map(|n| std::env::var(n).ok()).filter(|v| !v.trim().is_empty());
        let no = get(&["NO_PROXY", "no_proxy"]).unwrap_or_default();
        if no_proxy_matches(&no, target_host) {
            return None;
        }
        get(&["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]).and_then(|v| Proxy::parse(&v))
    }
}

/// `NO_PROXY` 的規則（curl 的）：`*` = 全部；`.example.com` / `example.com` = 這個網域與其子網域；IP 要完全一樣。
/// curl's NO_PROXY rule: `*` = everything; a name matches itself and its subdomains; an IP must match exactly.
pub fn no_proxy_matches(list: &str, host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    list.split([',', ' ']).map(str::trim).filter(|e| !e.is_empty()).any(|e| {
        let e = e.trim_start_matches('.').to_ascii_lowercase();
        let e = e.rsplit_once(':').filter(|(_, p)| p.bytes().all(|b| b.is_ascii_digit())).map_or(e.as_str(), |(h, _)| h).to_string();
        e == "*" || host == e || host.ends_with(&format!(".{e}"))
    })
}

/// 經代理：送 `CONNECT host:port`，回 2xx 才算。回 (連線, 標頭後多讀到的位元組)。
/// Through the proxy: `CONNECT host:port`, success on 2xx. Returns the stream and any bytes read past the headers.
pub async fn http_connect(mut stream: TcpStream, proxy: &Proxy, host: &str, port: u16) -> Result<(TcpStream, Vec<u8>)> {
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nUser-Agent: telepy-carrier/{VERSION}\r\nProxy-Connection: Keep-Alive\r\n");
    if let Some((u, p)) = &proxy.auth {
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", base64::engine::general_purpose::STANDARD.encode(format!("{u}:{p}"))));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.context("writing CONNECT to the proxy")?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        let n = stream.read(&mut chunk).await.context("reading the proxy's answer")?;
        if n == 0 {
            bail!("the proxy closed the connection before answering CONNECT");
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 64 * 1024 {
            bail!("the proxy's answer to CONNECT is too large");
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let status = connect_status(&head).ok_or_else(|| anyhow!("the proxy answered CONNECT with something that is not HTTP: {}", head.lines().next().unwrap_or("")))?;
    if !(200..300).contains(&status) {
        bail!("the proxy refused CONNECT {target}: {}", head.lines().next().unwrap_or(""));
    }
    Ok((stream, buf[end..].to_vec()))
}

/// `HTTP/1.1 200 Connection established` → 200。/ The status code of a CONNECT answer.
pub fn connect_status(head: &str) -> Option<u16> {
    let first = head.lines().next()?;
    let mut it = first.split_whitespace();
    let proto = it.next()?;
    if !proto.starts_with("HTTP/") {
        return None;
    }
    it.next()?.parse().ok()
}

/// 直連或經代理的 TCP 連線。/ A TCP connection, direct or through the proxy.
pub async fn tcp_connect(host: &str, port: u16, proxy: Option<&Proxy>, timeout: Duration) -> Result<(TcpStream, Vec<u8>)> {
    let fut = async {
        match proxy {
            None => {
                let s = TcpStream::connect((host, port)).await.with_context(|| format!("cannot connect to {host}:{port}"))?;
                let _ = s.set_nodelay(true);
                Ok((s, Vec::new()))
            }
            Some(p) => {
                let s = TcpStream::connect((p.host.as_str(), p.port)).await.with_context(|| format!("cannot connect to the proxy {}:{}", p.host, p.port))?;
                let _ = s.set_nodelay(true);
                http_connect(s, p, host, port).await
            }
        }
    };
    tokio::time::timeout(timeout, fut).await.map_err(|_| anyhow!("connecting to {host}:{port} timed out"))?
}

// ------------------------------------------------------------------ a stream with bytes already read

/// 代理回 CONNECT 時多讀到的位元組要先吐出來。/ A stream that first yields bytes already read past the proxy's headers.
pub struct Prefixed<S> {
    inner: S,
    pending: Vec<u8>,
    at: usize,
}

impl<S> Prefixed<S> {
    pub fn new(inner: S, pending: Vec<u8>) -> Self {
        Self { inner, pending, at: 0 }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.at < this.pending.len() {
            let n = buf.remaining().min(this.pending.len() - this.at);
            buf.put_slice(&this.pending[this.at..this.at + n]);
            this.at += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, data)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

pub type Ws = WebSocketStream<MaybeTlsStream<Prefixed<TcpStream>>>;

// ------------------------------------------------------------------ TLS

/// 根憑證 = 系統的（私有 CA）+ webpki 內建的（沒裝 ca-certificates 的機器）。/ System roots plus webpki's.
pub fn tls_config() -> Result<Arc<rustls::ClientConfig>> {
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for c in native.certs {
        let _ = roots.add(c);
    }
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .context("tls versions")?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

/// 網址的主機與 port（`wss://` 443、`ws://` 80）。/ The URL's host and port.
pub fn ws_endpoint(url: &str) -> Result<(String, u16, bool)> {
    let u = url::Url::parse(url).with_context(|| format!("the URL must look like wss://host/ws/gateway/, got {url}"))?;
    let tls = match u.scheme() {
        "wss" => true,
        "ws" => false,
        other => bail!("the URL must be ws:// or wss://, got {other}://"),
    };
    let host = u.host_str().ok_or_else(|| anyhow!("the URL has no host: {url}"))?.trim_matches(['[', ']']).to_string();
    let port = u.port().unwrap_or(if tls { 443 } else { 80 });
    Ok((host, port, tls))
}

/// 連上 `/ws/gateway/`（直連或經代理）。/ Open the gateway WebSocket, directly or through the proxy.
pub async fn connect_ws(url: &str, proxy: Option<&Proxy>, timeout: Duration) -> Result<Ws> {
    let (host, port, tls) = ws_endpoint(url)?;
    let fut = async {
        let (tcp, pending) = tcp_connect(&host, port, proxy, timeout).await?;
        let stream = Prefixed::new(tcp, pending);
        let mut req = url.into_client_request().context("websocket request")?;
        req.headers_mut().insert("User-Agent", format!("telepy-carrier/{VERSION}").parse().unwrap());
        let connector = if tls { Some(Connector::Rustls(tls_config()?)) } else { None };
        let (ws, _) = tokio_tungstenite::client_async_tls_with_config(req, stream, None, connector).await.context("the server did not accept the WebSocket")?;
        Ok::<Ws, anyhow::Error>(ws)
    };
    tokio::time::timeout(timeout, fut).await.map_err(|_| anyhow!("the web port {host}:{port} did not answer in time"))?
}

// ------------------------------------------------------------------ the SSH port

/// 連 SSH 的 port，看到 `SSH-` banner 才算成功（關掉的 port、只轉網頁的代理都算失敗）。回 (連線, 已讀到的位元組)。
/// Connect to the SSH port; success only once the server's SSH banner arrived (a closed port or a web-only proxy fails).
pub async fn connect_ssh_port(host: &str, port: u16, proxy: Option<&Proxy>) -> Result<(TcpStream, Vec<u8>)> {
    let (mut stream, mut seen) = tcp_connect(host, port, proxy, CONNECT_TIMEOUT).await?;
    let fut = async {
        let mut chunk = [0u8; 4096];
        loop {
            if has_banner(&seen) {
                return Ok(());
            }
            if seen.len() > 8192 {
                bail!("no SSH banner on {host}:{port}");
            }
            let n = stream.read(&mut chunk).await.context("reading the SSH banner")?;
            if n == 0 {
                bail!("{host}:{port} closed before an SSH banner");
            }
            seen.extend_from_slice(&chunk[..n]);
        }
    };
    tokio::time::timeout(BANNER_TIMEOUT, fut).await.map_err(|_| anyhow!("no SSH banner from {host}:{port} in time"))??;
    Ok((stream, seen))
}

/// RFC 4253 容許 banner 前有別的行；任何一行以 `SSH-` 開頭就是。/ RFC 4253 allows lines before the banner.
pub fn has_banner(seen: &[u8]) -> bool {
    seen.split(|b| *b == b'\n').any(|l| l.starts_with(b"SSH-"))
}

// ------------------------------------------------------------------ relays

/// stdin ↔ WebSocket 二進位 frame；Ping 回 Pong，Close = 結束。/ stdin ↔ binary frames; Ping → Pong, Close = done.
pub async fn relay_ws<S>(ws: WebSocketStream<S>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(64);
    // 只有一個地方寫：stdin 的資料、Pong 與最後的 Close 都排進同一條。/ One writer: data, pongs and the final close.
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let close = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || close {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let up = {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut stdin = tokio::io::stdin();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match stdin.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = tx.send(Message::Close(None)).await;
        })
    };
    let mut stdout = tokio::io::stdout();
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Binary(b)) => {
                if stdout.write_all(&b).await.is_err() || stdout.flush().await.is_err() {
                    break;
                }
            }
            Ok(Message::Text(t)) => {
                if stdout.write_all(t.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                    break;
                }
            }
            Ok(Message::Ping(p)) => {
                let _ = tx.send(Message::Pong(p)).await;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    up.abort();
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
}

/// stdin / stdout ↔ TCP，原封不動；`pending` = 已經讀到的 banner，先吐給 ssh。/ stdin / stdout ↔ TCP, the banner first.
pub async fn relay_tcp(mut tcp: TcpStream, pending: &[u8]) {
    let mut stdout = tokio::io::stdout();
    if !pending.is_empty() && (stdout.write_all(pending).await.is_err() || stdout.flush().await.is_err()) {
        return;
    }
    let mut local = tokio::io::join(tokio::io::stdin(), stdout);
    let _ = tokio::io::copy_bidirectional(&mut local, &mut tcp).await;
}

// ------------------------------------------------------------------ remembering the web port

/// 走通網頁 port 的記憶：暫存目錄裡一個小檔（內容 = 時間戳），每個 (SSH 位址, 網址, 使用者) 一個。
/// The memory that the web port worked: a small file in the temp dir, one per (SSH address, URL, user).
pub struct Memory {
    pub path: PathBuf,
}

impl Memory {
    pub fn for_route(tcp: &str, url: &str) -> Memory {
        Memory { path: memory_path(&std::env::temp_dir(), tcp, url, uid()) }
    }
    pub fn remembers_ws(&self) -> bool {
        remembers_ws_at(&self.path, now_secs())
    }
    pub fn remember(&self, ws: bool) {
        if ws {
            let _ = std::fs::write(&self.path, format!("{} websocket\n", now_secs()));
        } else if self.path.exists() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub fn memory_path(temp: &Path, tcp: &str, url: &str, uid: &str) -> PathBuf {
    use sha2::Digest;
    let tag = hex(&sha2::Sha256::digest(format!("{tcp} {url}").as_bytes()))[..12].to_string();
    temp.join(format!("telepy-ws-{tag}-{uid}"))
}

/// 檔案裡的時間戳在 REMEMBER 之內。/ The stamp in the file is within REMEMBER.
pub fn remembers_ws_at(path: &Path, now: u64) -> bool {
    std::fs::read_to_string(path).ok().and_then(|s| s.split_whitespace().next()?.parse::<u64>().ok()).is_some_and(|t| now.saturating_sub(t) < REMEMBER.as_secs())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn uid() -> &'static str {
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions.
        let u = unsafe { libc::getuid() };
        Box::leak(u.to_string().into_boxed_str())
    }
    #[cfg(not(unix))]
    {
        "u"
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ------------------------------------------------------------------ the device's policy

/// 裝置端：有 `tcp` = 自動（SSH 的 port 先，記得網頁 port 走通就反過來），沒有 = 只走網頁 port。連上後把連線接到
/// stdin / stdout，結束時回 0；兩邊都連不上回 255。`note` 收 stderr 的訊息（服務的 log 會看到走了哪條）。
/// The device policy: with `tcp` = automatic (the SSH port first, reversed while the web port is remembered), without =
/// the web port only. Relays until the connection ends (0); 255 when nothing could be reached.
pub async fn run_device(tcp: Option<&str>, url: &str, proxy: Option<&Proxy>, note: &dyn Fn(&str)) -> i32 {
    let Some(tcp) = tcp else {
        return match connect_ws(url, proxy, WS_TIMEOUT).await {
            Ok(ws) => {
                note(&format!("connected through the web port ({url}){}", via(proxy)));
                relay_ws(ws).await;
                0
            }
            Err(e) => {
                note(&format!("cannot connect: {e:#}"));
                255
            }
        };
    };
    let Some((host, port)) = split_host_port(tcp) else {
        note(&format!("--tcp wants host:port, got {tcp:?}"));
        return 255;
    };
    let memory = Memory::for_route(tcp, url);
    let order: [bool; 2] = if memory.remembers_ws() { [true, false] } else { [false, true] };
    let mut errors: Vec<String> = Vec::new();
    for ws_first in order {
        if ws_first {
            match connect_ws(url, proxy, WS_TIMEOUT).await {
                Ok(ws) => {
                    memory.remember(true);
                    let why = errors.first().map(|e| format!("; the SSH port {host}:{port}: {e}")).unwrap_or_default();
                    note(&format!("connected through the web port ({url}){}{why}", via(proxy)));
                    relay_ws(ws).await;
                    return 0;
                }
                Err(e) => errors.push(format!("{e:#}")),
            }
        } else {
            match connect_ssh_port(&host, port, proxy).await {
                Ok((stream, seen)) => {
                    memory.remember(false);
                    note(&format!("connected on the SSH port {host}:{port}{}", via(proxy)));
                    relay_tcp(stream, &seen).await;
                    return 0;
                }
                Err(e) => errors.push(format!("{e:#}")),
            }
        }
    }
    note(&format!("cannot connect: the SSH port {host}:{port} and the web port both failed ({})", errors.join("; ")));
    255
}

fn via(proxy: Option<&Proxy>) -> String {
    proxy.map(|p| format!(" via the proxy {}:{}", p.host, p.port)).unwrap_or_default()
}

/// `host:port`、`[v6]:port`。/ Split `host:port`.
pub fn split_host_port(s: &str) -> Option<(String, u16)> {
    let (h, p) = s.rsplit_once(':')?;
    let port: u16 = p.parse().ok()?;
    let h = h.trim_matches(['[', ']']);
    (!h.is_empty()).then(|| (h.to_string(), port))
}

// ------------------------------------------------------------------ the command line

/// `telepy-carrier [--tcp host:port] [--proxy URL | --no-proxy] <ws url>`。/ The binary's arguments.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cli {
    pub url: Option<String>,
    pub tcp: Option<String>,
    pub proxy: Option<String>,
    pub no_proxy: bool,
    pub version: bool,
    pub help: bool,
}

pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<Cli, String> {
    let mut cli = Cli::default();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--tcp" => cli.tcp = Some(it.next().ok_or("--tcp wants host:port")?),
            "--proxy" => cli.proxy = Some(it.next().ok_or("--proxy wants a URL")?),
            "--no-proxy" => cli.no_proxy = true,
            "--version" | "-V" => cli.version = true,
            "--help" | "-h" => cli.help = true,
            s if s.starts_with('-') => return Err(format!("unknown option {s}")),
            _ => {
                if cli.url.is_some() {
                    return Err("only one URL".into());
                }
                cli.url = Some(a);
            }
        }
    }
    if !cli.version && !cli.help && cli.url.is_none() {
        return Err("usage: telepy-carrier [--tcp host:port] [--proxy http://host:port | --no-proxy] wss://host/ws/gateway/".into());
    }
    Ok(cli)
}

pub const USAGE: &str = "telepy-carrier: carries a device's SSH connection to Telepy (ssh ProxyCommand)\n\n\
usage: telepy-carrier [--tcp host:port] [--proxy http://[user:pass@]host:port | --no-proxy] wss://host/ws/gateway/\n\n\
  --tcp host:port   try Telepy's SSH port first (success = its SSH banner), the web port only when that fails;\n\
                    a working web port is remembered for 30 minutes, then the SSH port is tried first again\n\
  --proxy URL       go through this HTTP proxy (CONNECT); without it HTTPS_PROXY / ALL_PROXY and NO_PROXY apply\n\
  --no-proxy        ignore the proxy variables\n\
  --version         print the version\n\n\
Everything ssh writes to stdin goes to Telepy; everything that comes back goes to stdout. The SSH inside is unchanged:\n\
the same keys, the same host-key check. Which way it took is written to stderr.\n";

/// 要用哪個代理：`--no-proxy` 一律不；`--proxy` 指定；否則看環境變數（對網址的主機套 NO_PROXY）。
/// Which proxy to use: none with `--no-proxy`, `--proxy` when given, else the environment (NO_PROXY against the URL's host).
pub fn choose_proxy(cli: &Cli, url_host: &str) -> Result<Option<Proxy>, String> {
    if cli.no_proxy {
        return Ok(None);
    }
    match &cli.proxy {
        Some(p) => Proxy::parse(p).map(Some).ok_or_else(|| format!("--proxy: not an http proxy URL: {p}")),
        None => Ok(Proxy::from_env(url_host)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_urls_parse_with_defaults_and_auth() {
        assert_eq!(Proxy::parse("http://proxy.corp:3128"), Some(Proxy { host: "proxy.corp".into(), port: 3128, auth: None }));
        assert_eq!(Proxy::parse("proxy.corp:8080").unwrap().port, 8080);
        assert_eq!(Proxy::parse("http://proxy.corp").unwrap().port, 80);
        let p = Proxy::parse("http://al%40ice:s%3Acret@10.0.0.9:3128").unwrap();
        assert_eq!(p.auth, Some(("al@ice".into(), "s:cret".into())));
        assert_eq!(Proxy::parse("socks5://h:1080"), None);
        assert_eq!(Proxy::parse(""), None);
    }

    #[test]
    fn no_proxy_follows_curls_rule() {
        assert!(no_proxy_matches("*", "anything"));
        assert!(no_proxy_matches("localhost,.corp.example", "telepy.corp.example"));
        assert!(no_proxy_matches("corp.example", "corp.example"));
        assert!(no_proxy_matches("corp.example", "a.corp.example"));
        assert!(!no_proxy_matches("corp.example", "notcorp.example"));
        assert!(no_proxy_matches("127.0.0.1, 10.0.0.0", "127.0.0.1"));
        assert!(no_proxy_matches("telepy.example:443", "telepy.example"));
        assert!(!no_proxy_matches("", "x"));
    }

    #[test]
    fn connect_answers_are_read_by_status() {
        assert_eq!(connect_status("HTTP/1.1 200 Connection established\r\nProxy-Agent: x\r\n\r\n"), Some(200));
        assert_eq!(connect_status("HTTP/1.0 407 Proxy Authentication Required\r\n\r\n"), Some(407));
        assert_eq!(connect_status("SSH-2.0-OpenSSH\r\n"), None);
    }

    #[test]
    fn banners_may_follow_other_lines() {
        assert!(has_banner(b"SSH-2.0-russh\r\n"));
        assert!(has_banner(b"welcome\nSSH-2.0-x\r\n"));
        assert!(!has_banner(b"HTTP/1.1 400 Bad Request\r\n"));
        assert!(!has_banner(b"SSH"));
    }

    #[test]
    fn memory_is_per_route_and_expires() {
        let dir = tempfile::tempdir().unwrap();
        let a = memory_path(dir.path(), "h:24242", "wss://h/ws/gateway/", "501");
        let b = memory_path(dir.path(), "h:24242", "wss://other/ws/gateway/", "501");
        assert_ne!(a, b);
        assert!(a.file_name().unwrap().to_str().unwrap().starts_with("telepy-ws-"));
        std::fs::write(&a, "1000 websocket\n").unwrap();
        assert!(remembers_ws_at(&a, 1000 + 1799));
        assert!(!remembers_ws_at(&a, 1000 + 1800));
        assert!(!remembers_ws_at(&b, 1000));
        std::fs::write(&a, "garbage").unwrap();
        assert!(!remembers_ws_at(&a, 1000));
    }

    #[test]
    fn arguments() {
        let c = parse_args(["--tcp", "ssh.example:24242", "wss://telepy.example/ws/gateway/"].map(String::from)).unwrap();
        assert_eq!(c.tcp.as_deref(), Some("ssh.example:24242"));
        assert_eq!(c.url.as_deref(), Some("wss://telepy.example/ws/gateway/"));
        assert!(parse_args(["--version"].map(String::from)).unwrap().version);
        assert!(parse_args(Vec::<String>::new()).is_err());
        assert!(parse_args(["--bogus", "wss://x/"].map(String::from)).is_err());
        assert!(parse_args(["wss://x/", "wss://y/"].map(String::from)).is_err());
        let c = parse_args(["--proxy", "http://p:3128", "--no-proxy", "ws://x/"].map(String::from)).unwrap();
        assert!(choose_proxy(&c, "x").unwrap().is_none(), "--no-proxy wins");
        let c = parse_args(["--proxy", "socks5://p:1080", "ws://x/"].map(String::from)).unwrap();
        assert!(choose_proxy(&c, "x").is_err());
        assert_eq!(split_host_port("[::1]:22"), Some(("::1".into(), 22)));
        assert_eq!(split_host_port("h:x"), None);
        assert_eq!(ws_endpoint("wss://telepy.example/ws/gateway/").unwrap(), ("telepy.example".into(), 443, true));
        assert_eq!(ws_endpoint("ws://127.0.0.1:8787/ws/gateway/").unwrap(), ("127.0.0.1".into(), 8787, false));
        assert!(ws_endpoint("https://x/").is_err());
    }
}
