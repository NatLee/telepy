//! `telepy proxy <tunnel>[@account]`：在這台電腦的 127.0.0.1 開一個代理（同一個 port 同時講 HTTP 代理與 SOCKS5），每條
//! 連線都變成一條到 Telepy `/ws/proxy/` 的 WebSocket，由裝置的 sshd 連到目標——所以瀏覽器、curl、資料庫工具設了這個
//! 代理就像在裝置上連出去一樣（看得到裝置的區網與 localhost，網站看到的是裝置的位址）。不需要 SSH 金鑰、不需要管理員
//! 權限、不在裝置上跑任何東西；只走網頁的 port。認證用 CLI 登入的 token（scope `proxy:use`）。
//! 這個檔的上半是純函式（讀請求、改寫、SOCKS5 握手、訊息），有單元測試；下半是轉接。
//!
//! `telepy proxy <tunnel>[@account]`: a proxy on this computer's 127.0.0.1 (one port speaks both HTTP proxy and SOCKS5).
//! Every connection becomes one WebSocket to Telepy's `/ws/proxy/`, and the device's sshd connects to the target — so a
//! browser, curl or a database tool pointed at it connects as if from the device (its LAN and localhost are reachable,
//! sites see its address). No SSH key, no admin rights, nothing run on the device; only the web port. It authenticates
//! with the CLI's sign-in token (scope `proxy:use`). The top half of this file is pure and unit-tested (reading and
//! rewriting requests, the SOCKS5 handshake, messages); the bottom half relays.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use telepy_carrier::{connect_ws_bearer, relay_ws_io, ws_endpoint, Proxy, Refused};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::api::Api;

/// 請求標頭最多讀這麼多。/ How much of a request head is read at most.
pub const MAX_HEAD: usize = 32 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

pub use crate::proxy_request::{host_port, parse_request, Wanted};

/// SOCKS5 的請求（`VER CMD RSV ATYP ADDR PORT`）→ 目標；`Err(回覆碼)`：7 = 不支援的指令、8 = 不支援的位址型別、
/// 1 = 看不懂。回傳 (host, port, 用掉幾個位元組)；資料還不夠 = `Ok(None)`。
/// A SOCKS5 request → the target; `Err(reply code)`: 7 = command not supported, 8 = address type not supported, 1 =
/// malformed. Returns (host, port, bytes used); `Ok(None)` while more bytes are needed.
pub fn socks5_request(buf: &[u8]) -> std::result::Result<Option<(String, u16, usize)>, u8> {
    if buf.len() < 4 {
        return Ok(None);
    }
    if buf[0] != 5 {
        return Err(1);
    }
    if buf[1] != 1 {
        return Err(7);
    }
    let (host, used) = match buf[3] {
        1 => {
            if buf.len() < 10 {
                return Ok(None);
            }
            (std::net::Ipv4Addr::new(buf[4], buf[5], buf[6], buf[7]).to_string(), 8)
        }
        3 => {
            let Some(len) = buf.get(4).map(|l| usize::from(*l)) else { return Ok(None) };
            if buf.len() < 5 + len + 2 {
                return Ok(None);
            }
            (String::from_utf8_lossy(&buf[5..5 + len]).into_owned(), 5 + len)
        }
        4 => {
            if buf.len() < 22 {
                return Ok(None);
            }
            let mut a = [0u8; 16];
            a.copy_from_slice(&buf[4..20]);
            (std::net::Ipv6Addr::from(a).to_string(), 20)
        }
        _ => return Err(8),
    };
    let port = u16::from_be_bytes([buf[used], buf[used + 1]]);
    if host.is_empty() || port == 0 {
        return Err(1);
    }
    Ok(Some((host, port, used + 2)))
}

/// SOCKS5 的回覆（綁定位址填 0）。/ A SOCKS5 reply with a zero bind address.
pub fn socks5_reply(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}

/// Telepy 的拒絕 → SOCKS5 回覆碼。/ Telepy's refusal as a SOCKS5 reply code.
pub fn socks5_code(status: u16) -> u8 {
    match status {
        401 | 403 | 404 | 429 => 2, // connection not allowed by ruleset
        502 => 5,                   // connection refused
        _ => 1,
    }
}

/// `/ws/proxy/` 的網址：伺服器的 http(s) 換成 ws(s)。/ The `/ws/proxy/` URL: the server's http(s) as ws(s).
pub fn ws_url(server: &str, tunnel: &str, account: Option<&str>, host: &str, port: u16) -> String {
    let base = server.trim_end_matches('/');
    let base = match base.strip_prefix("https://") {
        Some(rest) => format!("wss://{rest}"),
        None => format!("ws://{}", base.trim_start_matches("http://")),
    };
    let enc = |s: &str| urlencoding::encode(s).into_owned();
    let mut url = format!("{base}/ws/proxy/?tunnel={}&host={}&port={port}", enc(tunnel), enc(host));
    if let Some(a) = account {
        url.push_str(&format!("&account={}", enc(a)));
    }
    url
}

/// 拒絕的內容：`{error, code}` 的那兩個字串（不是 JSON 就整段當訊息）。/ A refusal's `{error, code}` (the raw text when it isn't JSON).
pub fn refusal_parts(r: &Refused) -> (String, String) {
    match serde_json::from_str::<serde_json::Value>(&r.body) {
        Ok(v) => (v["error"].as_str().unwrap_or("refused").to_string(), v["code"].as_str().unwrap_or("").to_string()),
        Err(_) => (if r.body.trim().is_empty() { format!("HTTP {}", r.status) } else { r.body.trim().to_string() }, String::new()),
    }
}

/// 第一次遇到某種拒絕時在終端機多說一句怎麼辦（之後同一種不再說）。/ What to add in the terminal the first time a kind of refusal shows up.
pub fn advice(code: &str, server: &str) -> Option<String> {
    match code {
        "token_scope" => Some(format!("This sign-in lacks the proxy permission. Sign in again: telepy login {server}   (an API token needs proxy:use ticked when it is created)")),
        "proxy_disabled" => Some("An administrator has to turn it on: Site settings → Features → Device proxy.".into()),
        "feature_disabled" => Some("The device proxy is turned off for your account. Ask an administrator.".into()),
        "step_up_refused" => Some("This tunnel asks for a fresh verification before every session; the proxy can't give one. Use the web or ssh for it.".into()),
        "token_invalid" | "token_required" => Some(format!("Sign in again: telepy login {server}")),
        _ => None,
    }
}

/// 給 HTTP 客戶端的錯誤回應。/ The error response for an HTTP client.
pub fn http_error(status: u16, message: &str) -> Vec<u8> {
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        502 => "Bad Gateway",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let body = format!("telepy proxy: {message}\n");
    format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}

/// 啟動時印的那幾行。/ The lines printed at start.
pub fn banner(tunnel: &str, account: Option<&str>, port: u16) -> Vec<String> {
    let who = account.map(|a| format!(" as {a}")).unwrap_or_default();
    let url = format!("http://127.0.0.1:{port}");
    vec![
        format!("Proxy through {tunnel}{who} is on {url} (HTTP proxy and SOCKS5 on the same port). Ctrl-C stops it."),
        format!("  curl -x {url} https://ifconfig.me          # shows the device's address"),
        format!("  export HTTPS_PROXY={url} HTTP_PROXY={url}  # for programs that read the environment"),
        "  Connections leave from the device: its localhost and its network are reachable, and nothing runs on it.".to_string(),
    ]
}

/// 找一個能帶 `--proxy-server` 開的瀏覽器（Chromium 系）。/ A browser that takes `--proxy-server` (the Chromium family).
pub fn browser_candidates() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        for app in ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"] {
            out.push(format!("/Applications/{app}.app/Contents/MacOS/{app}").into());
        }
    } else if cfg!(windows) {
        for base in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Some(dir) = std::env::var_os(base) {
                let dir = std::path::PathBuf::from(dir);
                out.push(dir.join("Google/Chrome/Application/chrome.exe"));
                out.push(dir.join("Microsoft/Edge/Application/msedge.exe"));
            }
        }
    } else {
        for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"] {
            if let Some(paths) = std::env::var_os("PATH") {
                out.extend(std::env::split_paths(&paths).map(|d| d.join(name)));
            }
        }
    }
    out
}

/// 開瀏覽器的參數：代理、專用的設定資料夾（不動你平常的那一個）、不跑第一次啟動的畫面。
/// The browser's arguments: the proxy, its own profile folder (your everyday one is untouched), no first-run screens.
pub fn browser_args(port: u16, profile: &std::path::Path, url: Option<&str>) -> Vec<String> {
    let mut out = vec![format!("--proxy-server=http://127.0.0.1:{port}"), format!("--user-data-dir={}", profile.display()), "--no-first-run".to_string(), "--no-default-browser-check".to_string()];
    out.extend(url.map(str::to_string));
    out
}

// ---------------------------------------------------------------- relaying

struct Ctx {
    api: Arc<Api>,
    tunnel: String,
    account: Option<String>,
    said: std::sync::Mutex<Vec<String>>,
}

impl Ctx {
    /// 同一種拒絕只在終端機說一次。/ Say a kind of refusal once in the terminal.
    fn note(&self, code: &str, message: &str) {
        let key = if code.is_empty() { message.to_string() } else { code.to_string() };
        let Ok(mut said) = self.said.lock() else { return };
        // 目標連不上是日常（關著的 port），不洗版。/ An unreachable target is everyday (a closed port): no noise.
        if code == "connect_failed" || code == "resolve_failed" || said.contains(&key) {
            return;
        }
        said.push(key);
        eprintln!("telepy proxy: {message}");
        if let Some(a) = advice(code, &self.api.server) {
            eprintln!("  {a}");
        }
    }
}

/// 連到 Telepy：成功回 WebSocket，被拒回（狀態、訊息、代碼）。/ Dial Telepy: the socket, or (status, message, code) when refused.
async fn dial(ctx: &Ctx, host: &str, port: u16) -> std::result::Result<telepy_carrier::Ws, (u16, String, String)> {
    let api = ctx.api.clone();
    // 換新 OAuth token 是阻塞的 HTTP。/ Renewing an OAuth token is blocking HTTP.
    let bearer = match tokio::task::spawn_blocking(move || api.bearer_now()).await {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => return Err((401, format!("{e:#}"), "token_invalid".into())),
        Err(_) => return Err((500, "internal error".into(), String::new())),
    };
    let url = ws_url(&ctx.api.server, &ctx.tunnel, ctx.account.as_deref(), host, port);
    let ws_host = ws_endpoint(&url).map(|(h, _, _)| h).unwrap_or_default();
    let via = Proxy::from_env(&ws_host);
    match connect_ws_bearer(&url, &bearer, via.as_ref(), CONNECT_TIMEOUT).await {
        Ok(Ok(ws)) => Ok(ws),
        Ok(Err(r)) => {
            let (message, code) = refusal_parts(&r);
            Err((r.status, message, code))
        }
        Err(e) => Err((504, format!("Telepy can't be reached: {e:#}"), String::new())),
    }
}

async fn serve(ctx: Arc<Ctx>, mut client: TcpStream) -> Result<()> {
    let _ = client.set_nodelay(true);
    let mut buf = vec![0u8; 4096];
    let mut have = 0usize;
    // 第一個位元組決定協定：0x05 = SOCKS5，其他 = HTTP。/ The first byte picks the protocol: 0x05 = SOCKS5, else HTTP.
    let n = client.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    have += n;
    if buf[0] == 5 {
        return serve_socks(ctx, client, buf, have).await;
    }
    let end = loop {
        if let Some(i) = buf[..have].windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if have >= MAX_HEAD {
            client.write_all(&http_error(400, "the request head is too large")).await?;
            return Ok(());
        }
        if have == buf.len() {
            buf.resize((buf.len() * 2).min(MAX_HEAD), 0);
        }
        let n = client.read(&mut buf[have..]).await?;
        if n == 0 {
            return Ok(());
        }
        have += n;
    };
    let wanted = match parse_request(&buf[..end]) {
        Ok(w) => w,
        Err(e) => {
            client.write_all(&http_error(400, &e)).await?;
            return Ok(());
        }
    };
    let ws = match dial(&ctx, &wanted.host, wanted.port).await {
        Ok(ws) => ws,
        Err((status, message, code)) => {
            ctx.note(&code, &message);
            client.write_all(&http_error(status, &message)).await?;
            return Ok(());
        }
    };
    // 已經讀進來、屬於目標的位元組：改寫過的請求（一般 HTTP）加上標頭後面多讀到的。
    // Bytes already read that belong to the target: the rewritten request (plain HTTP) plus anything read past the head.
    let mut first = wanted.head.clone().unwrap_or_default();
    first.extend_from_slice(&buf[end..have]);
    if wanted.head.is_none() {
        client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await?;
    }
    let (read, write) = client.into_split();
    relay_ws_io(ws, std::io::Cursor::new(first).chain(read), write).await;
    Ok(())
}

async fn serve_socks(ctx: Arc<Ctx>, mut client: TcpStream, mut buf: Vec<u8>, mut have: usize) -> Result<()> {
    // 方法協商：VER NMETHODS METHODS…；只接受「不用認證」（只聽 127.0.0.1）。/ Method selection; "no authentication" only (loopback).
    loop {
        if have >= 2 && have >= 2 + usize::from(buf[1]) {
            break;
        }
        let n = client.read(&mut buf[have..]).await?;
        if n == 0 {
            return Ok(());
        }
        have += n;
    }
    let methods = 2 + usize::from(buf[1]);
    if !buf[2..methods].contains(&0) {
        client.write_all(&[5, 0xff]).await?;
        return Ok(());
    }
    client.write_all(&[5, 0]).await?;
    buf.copy_within(methods..have, 0);
    have -= methods;
    let (host, port, used) = loop {
        match socks5_request(&buf[..have]) {
            Ok(Some(r)) => break r,
            Ok(None) => {}
            Err(code) => {
                client.write_all(&socks5_reply(code)).await?;
                return Ok(());
            }
        }
        if have == buf.len() {
            bail!("SOCKS request too long");
        }
        let n = client.read(&mut buf[have..]).await?;
        if n == 0 {
            return Ok(());
        }
        have += n;
    };
    let ws = match dial(&ctx, &host, port).await {
        Ok(ws) => ws,
        Err((status, message, code)) => {
            ctx.note(&code, &message);
            client.write_all(&socks5_reply(socks5_code(status))).await?;
            return Ok(());
        }
    };
    client.write_all(&socks5_reply(0)).await?;
    let first = buf[used..have].to_vec();
    let (read, write) = client.into_split();
    relay_ws_io(ws, std::io::Cursor::new(first).chain(read), write).await;
    Ok(())
}

/// 開代理並一直跑到 Ctrl-C。`ready` = 開始聽之後呼叫一次（印說明、開瀏覽器）。
/// Runs the proxy until Ctrl-C. `ready` is called once after it listens (prints the banner, opens the browser).
pub fn run(api: Api, tunnel: String, account: Option<String>, port: u16, ready: impl FnOnce(u16) + Send + 'static) -> Result<i32> {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
    rt.block_on(async move {
        let listener = TcpListener::bind(("127.0.0.1", port)).await.with_context(|| format!("port {port} on this computer is taken; pick another with --port"))?;
        let port = listener.local_addr()?.port();
        let ctx = Arc::new(Ctx { api: Arc::new(api), tunnel, account, said: Default::default() });
        // 先試一條不存在的目標前，確認 token 與通道沒問題：連裝置自己的一個幾乎一定關著的 port 太吵，改成直接讓第一條真的連線說話。
        // No probe connection here: the first real connection reports any problem (once), which is quieter than a made-up one.
        ready(port);
        let stop = Arc::new(AtomicBool::new(false));
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((client, _)) = accepted else { continue };
                    let ctx = ctx.clone();
                    tokio::spawn(async move {
                        let _ = serve(ctx, client).await;
                    });
                }
                _ = tokio::signal::ctrl_c() => {
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
        Ok::<i32, anyhow::Error>(0)
    })
    .map_err(|e| anyhow!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socks5_requests_are_read_piece_by_piece() {
        let mut req = vec![5, 1, 0, 3, 11];
        req.extend_from_slice(b"example.com");
        req.extend_from_slice(&443u16.to_be_bytes());
        for cut in 0..req.len() {
            assert_eq!(socks5_request(&req[..cut]), Ok(None), "needs more at {cut}");
        }
        assert_eq!(socks5_request(&req), Ok(Some(("example.com".into(), 443, req.len()))));
        let mut more = req.clone();
        more.extend_from_slice(b"GET /");
        assert_eq!(socks5_request(&more).unwrap().unwrap().2, req.len(), "bytes after the request belong to the target");
        assert_eq!(socks5_request(&[5, 1, 0, 1, 10, 0, 0, 5, 0x1f, 0x90]), Ok(Some(("10.0.0.5".into(), 8080, 10))));
        assert_eq!(socks5_request(&[5, 2, 0, 1, 10, 0, 0, 5, 0, 80]), Err(7), "BIND is not supported");
        assert_eq!(socks5_request(&[5, 1, 0, 9, 0, 0, 0, 0, 0, 0]), Err(8));
        assert_eq!(socks5_request(&[4, 1, 0, 1]), Err(1));
        assert_eq!((socks5_code(403), socks5_code(502), socks5_code(504)), (2, 5, 1));
        assert_eq!(socks5_reply(0)[..2], [5, 0]);
    }

    #[test]
    fn urls_refusals_and_advice() {
        assert_eq!(ws_url("https://telepy.example.com/", "my box", Some("ubuntu"), "nas.lan", 5000), "wss://telepy.example.com/ws/proxy/?tunnel=my%20box&host=nas.lan&port=5000&account=ubuntu");
        assert_eq!(ws_url("http://localhost:8787", "7", None, "::1", 22), "ws://localhost:8787/ws/proxy/?tunnel=7&host=%3A%3A1&port=22");
        let r = Refused { status: 403, body: r#"{"error":"This credential lacks the proxy:use permission.","code":"token_scope"}"#.into() };
        assert_eq!(refusal_parts(&r), ("This credential lacks the proxy:use permission.".into(), "token_scope".into()));
        assert_eq!(refusal_parts(&Refused { status: 502, body: String::new() }).0, "HTTP 502");
        assert!(advice("token_scope", "https://t.example").unwrap().contains("telepy login https://t.example "));
        assert!(advice("connect_failed", "x").is_none());
        let e = String::from_utf8(http_error(502, "the device could not connect")).unwrap();
        assert!(e.starts_with("HTTP/1.1 502 Bad Gateway\r\n") && e.ends_with("telepy proxy: the device could not connect\n"), "{e}");
        assert!(e.contains(&format!("Content-Length: {}", "telepy proxy: the device could not connect\n".len())));
    }

    #[test]
    fn the_banner_and_the_browser() {
        let b = banner("hd-dev", Some("ubuntu"), 8118);
        assert!(b[0].contains("Proxy through hd-dev as ubuntu is on http://127.0.0.1:8118"));
        assert!(b[1].contains("curl -x http://127.0.0.1:8118 https://ifconfig.me"));
        let args = browser_args(8118, std::path::Path::new("/tmp/p"), Some("http://localhost:3000/"));
        assert_eq!(args, ["--proxy-server=http://127.0.0.1:8118", "--user-data-dir=/tmp/p", "--no-first-run", "--no-default-browser-check", "http://localhost:3000/"]);
        assert!(!browser_candidates().is_empty() || cfg!(not(any(target_os = "macos", windows))));
    }
}
