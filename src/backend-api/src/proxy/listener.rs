//! 標準的 HTTP 代理入口（`PROXY_BIND`）：給只收「代理網址」的程式用——`curl -x`、瀏覽器、套件管理工具。講的是一般的
//! HTTP 代理協定：`CONNECT host:port`（之後原樣轉接，HTTPS 就是走這個）與 `GET http://host/path`（改成 origin-form
//! 轉給目標，一條連線一個請求）。認證在 `Proxy-Authorization`：
//! - `Basic`：**帳號 = 通道**（名稱或 id，可加 `@裝置帳號`）、**密碼 = token**（OAuth access token 或個人 API token，
//!   scope `proxy:use`）——所以代理網址寫成 `https://<通道>:<token>@proxy.example.com:8443` 就能用；
//! - `Bearer <token>` 加上 `Telepy-Tunnel: <通道>[@帳號]` 標頭（自己寫的程式）。
//! 沒帶 / 無效 = 407（帶 `Proxy-Authenticate`，瀏覽器會跳出帳密框）。之後跟 `/ws/proxy/` 完全同一套：`proxy::authorize`
//! 再 `ProxySession::open`，拒絕的狀態與 `{error, code}` 也一樣。
//!
//! TLS：`PROXY_TLS_CERT` + `PROXY_TLS_KEY` 都給時這裡自己做 TLS（HTTPS 代理）；否則是明文，前面要有東西做 TLS
//! （Traefik 的 TCP router、L4 負載平衡器）。CDN 不轉 `CONNECT`，所以這個入口要用一個不經 CDN 的名稱——跟 SSH 一樣。
//!
//! The standard HTTP proxy endpoint (`PROXY_BIND`), for programs that only take a proxy URL — `curl -x`, browsers,
//! package managers. It speaks the ordinary HTTP proxy protocol: `CONNECT host:port` (relayed as is afterwards; HTTPS
//! uses this) and `GET http://host/path` (sent on in origin-form, one request per connection). Authentication is in
//! `Proxy-Authorization`: `Basic` with **user = tunnel** (name or id, optionally `@device-account`) and **password =
//! token** (an OAuth access token or a personal API token with `proxy:use`), so a proxy URL written as
//! `https://<tunnel>:<token>@proxy.example.com:8443` just works; or `Bearer <token>` plus a `Telepy-Tunnel` header.
//! Missing or invalid = 407 with `Proxy-Authenticate` (browsers prompt). From there it is exactly `/ws/proxy/`'s path:
//! `proxy::authorize`, then `ProxySession::open`, with the same refusals.
//!
//! TLS: with both `PROXY_TLS_CERT` and `PROXY_TLS_KEY` this endpoint terminates TLS itself (an HTTPS proxy); otherwise
//! it is plain and something in front must do TLS (a Traefik TCP router, an L4 load balancer). A CDN does not pass
//! `CONNECT`, so this endpoint needs a name that doesn't go through one — like SSH.

use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpListener;

use super::request::{self, Wanted};
use super::ProxyError;
use crate::state::AppState;

/// 請求標頭最多讀這麼多、最多等這麼久。/ How much of a request head is read, and for how long.
pub const MAX_HEAD: usize = 32 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(20);
const REALM: &str = "Telepy device proxy: user = tunnel, password = token";

/// `Proxy-Authorization`（加 `Telepy-Tunnel`）→（通道那一段、token）。/ `Proxy-Authorization` (and `Telepy-Tunnel`) → (the tunnel part, the token).
pub fn credentials(head: &str) -> Option<(String, String)> {
    let value = request::header(head, "proxy-authorization")?;
    let (scheme, rest) = value.split_once(' ')?;
    let rest = rest.trim();
    if scheme.eq_ignore_ascii_case("basic") {
        let raw = base64::engine::general_purpose::STANDARD.decode(rest).ok()?;
        let text = String::from_utf8(raw).ok()?;
        let (user, pass) = text.split_once(':')?;
        return (!user.is_empty() && !pass.is_empty()).then(|| (user.to_string(), pass.to_string()));
    }
    if scheme.eq_ignore_ascii_case("bearer") {
        let tunnel = request::header(head, "telepy-tunnel")?;
        return (!tunnel.is_empty() && !rest.is_empty()).then(|| (tunnel.to_string(), rest.to_string()));
    }
    None
}

/// 帳號那一段可能的讀法，依序試：整段就是通道；`通道@裝置帳號`。/ How the user part may read, tried in order: all of it is the tunnel; `tunnel@account`.
pub fn tunnel_candidates(user: &str) -> Vec<(String, Option<String>)> {
    let mut out = vec![(user.to_string(), None)];
    if let Some((tunnel, account)) = user.rsplit_once('@') {
        if !tunnel.is_empty() && !account.is_empty() {
            out.push((tunnel.to_string(), Some(account.to_string())));
        }
    }
    out
}

/// 給代理客戶端的回應（401 → 407 並請它帶帳密）。/ The response for a proxy client (401 becomes 407 asking for credentials).
pub fn response(e: &ProxyError) -> Vec<u8> {
    let status = if e.status == StatusCode::UNAUTHORIZED { StatusCode::PROXY_AUTHENTICATION_REQUIRED } else { e.status };
    let body = e.json().to_string();
    let mut out = format!("HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", status.as_u16(), status.canonical_reason().unwrap_or("Error"), body.len());
    if status == StatusCode::PROXY_AUTHENTICATION_REQUIRED {
        out.push_str(&format!("Proxy-Authenticate: Basic realm=\"{REALM}\"\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(&body);
    out.into_bytes()
}

/// 先吐出已經讀進來的位元組，再讀底下的串流。/ Yields bytes already read before reading the stream underneath.
struct Prefixed<S> {
    prefix: Vec<u8>,
    at: usize,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.at < self.prefix.len() {
            let n = (self.prefix.len() - self.at).min(buf.remaining());
            let at = self.at;
            buf.put_slice(&self.prefix[at..at + n]);
            self.at += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, data)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// 一條代理客戶端的連線，從讀請求到轉接結束。/ One proxy client connection, from reading the request to the end of the relay.
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(state: AppState, mut client: S, ip: Option<IpAddr>) -> std::io::Result<()> {
    let mut buf = vec![0u8; 4096];
    let mut have = 0usize;
    let end = loop {
        if let Some(i) = buf[..have].windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if have >= MAX_HEAD {
            return client.write_all(&response(&ProxyError::new(StatusCode::BAD_REQUEST, "bad_request", "The request head is too large."))).await;
        }
        if have == buf.len() {
            buf.resize((buf.len() * 2).min(MAX_HEAD), 0);
        }
        match tokio::time::timeout(HEAD_TIMEOUT, client.read(&mut buf[have..])).await {
            Ok(Ok(0)) | Err(_) => return Ok(()),
            Ok(Ok(n)) => have += n,
            Ok(Err(e)) => return Err(e),
        }
    };
    let wanted: Wanted = match request::parse_request(&buf[..end]) {
        Ok(w) => w,
        Err(e) => return client.write_all(&response(&ProxyError::new(StatusCode::BAD_REQUEST, "bad_request", format!("Not a proxy request: {e}.")))).await,
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let Some((user, token)) = credentials(&head) else {
        let e = ProxyError::new(StatusCode::UNAUTHORIZED, "token_required", "Proxy authentication: the user is the tunnel (name or id, optionally @device-account) and the password is a token with the proxy:use permission.");
        return client.write_all(&response(&e)).await;
    };
    let principal = match crate::ws::proxy::principal(&state, Some(token), ip.map(|i| i.to_string())).await {
        Ok(p) => p,
        Err(e) => return client.write_all(&response(&e)).await,
    };
    // 帳號那一段：整段當通道試一次，不行再拆成 通道@帳號。/ The user part: all of it as the tunnel first, then tunnel@account.
    let mut session = Err(ProxyError::new(StatusCode::NOT_FOUND, "tunnel_not_found", "No such tunnel."));
    for (tunnel, account) in tunnel_candidates(&user) {
        session = super::authorize(&state, &principal, &tunnel, account.as_deref()).await;
        if !matches!(&session, Err(e) if e.code == "tunnel_not_found") {
            break;
        }
    }
    let (session, max) = match session {
        Ok(s) => s,
        Err(e) => return client.write_all(&response(&e)).await,
    };
    let conn = match session.open(&state, &wanted.host, wanted.port, max).await {
        Ok(c) => c,
        Err(e) => return client.write_all(&response(&e)).await,
    };
    // 已經讀進來、屬於目標的位元組：改寫過的請求（一般 HTTP）加上標頭後面多讀到的。
    // Bytes already read that belong to the target: the rewritten request (plain HTTP) and anything read past the head.
    let mut first = wanted.head.clone().unwrap_or_default();
    first.extend_from_slice(&buf[end..have]);
    if wanted.head.is_none() {
        client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await?;
    }
    conn.relay(Prefixed { prefix: first, at: 0, inner: client }).await;
    Ok(())
}

/// `PROXY_TLS_CERT` / `PROXY_TLS_KEY` 的 TLS 設定（兩個都有才有）。/ The TLS setup from `PROXY_TLS_CERT` / `PROXY_TLS_KEY` (only with both).
pub fn tls_acceptor(cert: Option<&str>, key: Option<&str>) -> anyhow::Result<Option<tokio_rustls::TlsAcceptor>> {
    use anyhow::Context as _;
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let (Some(cert), Some(key)) = (cert, key) else { return Ok(None) };
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert).with_context(|| format!("reading PROXY_TLS_CERT {cert}"))?.collect::<Result<_, _>>().with_context(|| format!("parsing PROXY_TLS_CERT {cert}"))?;
    if certs.is_empty() {
        anyhow::bail!("PROXY_TLS_CERT {cert} holds no certificate");
    }
    let key = PrivateKeyDer::from_pem_file(key).with_context(|| format!("reading PROXY_TLS_KEY {key}"))?;
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .context("tls versions")?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("the certificate and key don't fit together")?;
    Ok(Some(tokio_rustls::TlsAcceptor::from(Arc::new(config))))
}

/// 在 `listener` 上接代理客戶端，直到程式結束。/ Accepts proxy clients on `listener` for as long as the process runs.
pub async fn accept_loop(state: AppState, listener: TcpListener, tls: Option<tokio_rustls::TlsAcceptor>) {
    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        };
        let _ = stream.set_nodelay(true);
        let (state, tls) = (state.clone(), tls.clone());
        tokio::spawn(async move {
            let ip = Some(peer.ip());
            let result = match tls {
                Some(acceptor) => match tokio::time::timeout(HEAD_TIMEOUT, acceptor.accept(stream)).await {
                    Ok(Ok(s)) => serve(state, s, ip).await,
                    _ => Ok(()),
                },
                None => serve(state, stream, ip).await,
            };
            if let Err(e) = result {
                tracing::debug!(error = %e, %peer, "proxy endpoint: connection ended with an error");
            }
        });
    }
}

/// `PROXY_BIND` 有設就開代理入口（沒設 = 什麼都不做）。/ Starts the proxy endpoint when `PROXY_BIND` is set (nothing otherwise).
pub async fn run(state: AppState) {
    let Some(bind) = state.config.proxy_bind.clone() else { return };
    let tls = match tls_acceptor(state.config.proxy_tls_cert.as_deref(), state.config.proxy_tls_key.as_deref()) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "proxy endpoint: TLS setup failed; not listening");
            return;
        }
    };
    match TcpListener::bind(&bind).await {
        Ok(listener) => {
            tracing::info!(%bind, tls = tls.is_some(), "proxy endpoint listening");
            accept_loop(state, listener, tls).await;
        }
        Err(e) => tracing::error!(%bind, error = %e, "proxy endpoint: cannot listen"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_come_from_basic_or_bearer() {
        let basic = base64::engine::general_purpose::STANDARD.encode("hd-dev@ubuntu:tpt_secret:with:colons");
        let head = format!("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic {basic}\r\n\r\n");
        assert_eq!(credentials(&head), Some(("hd-dev@ubuntu".into(), "tpt_secret:with:colons".into())), "the password may hold colons");
        let head = "GET http://x/ HTTP/1.1\r\nproxy-authorization: bearer tok123\r\nTelepy-Tunnel: 7\r\n\r\n";
        assert_eq!(credentials(head), Some(("7".into(), "tok123".into())));
        assert_eq!(credentials("GET http://x/ HTTP/1.1\r\nProxy-Authorization: Bearer tok123\r\n\r\n"), None, "a bearer token needs the tunnel header");
        assert_eq!(credentials("GET http://x/ HTTP/1.1\r\nAuthorization: Basic abc\r\n\r\n"), None, "Authorization is the destination's, not ours");
        assert_eq!(credentials("GET http://x/ HTTP/1.1\r\nProxy-Authorization: Basic !!!\r\n\r\n"), None);
        let empty = base64::engine::general_purpose::STANDARD.encode("box:");
        assert_eq!(credentials(&format!("GET http://x/ HTTP/1.1\r\nProxy-Authorization: Basic {empty}\r\n\r\n")), None);
    }

    #[test]
    fn the_user_part_reads_as_a_tunnel_then_as_tunnel_at_account() {
        assert_eq!(tunnel_candidates("hd-dev"), [("hd-dev".to_string(), None)]);
        assert_eq!(tunnel_candidates("hd-dev@ubuntu"), [("hd-dev@ubuntu".to_string(), None), ("hd-dev".to_string(), Some("ubuntu".to_string()))]);
        assert_eq!(tunnel_candidates("@x").len(), 1);
    }

    #[test]
    fn refusals_are_proxy_responses() {
        let r = String::from_utf8(response(&ProxyError::new(StatusCode::UNAUTHORIZED, "token_invalid", "The token is invalid."))).unwrap();
        assert!(r.starts_with("HTTP/1.1 407 Proxy Authentication Required\r\n"), "{r}");
        assert!(r.contains("Proxy-Authenticate: Basic realm=\"Telepy device proxy"), "{r}");
        assert!(r.ends_with(r#"{"code":"token_invalid","error":"The token is invalid."}"#), "{r}");
        let r = String::from_utf8(response(&ProxyError::new(StatusCode::BAD_GATEWAY, "connect_failed", "x"))).unwrap();
        assert!(r.starts_with("HTTP/1.1 502 Bad Gateway\r\n") && !r.contains("Proxy-Authenticate"), "{r}");
        let len: usize = r.split("Content-Length: ").nth(1).unwrap().split("\r\n").next().unwrap().parse().unwrap();
        assert_eq!(len, r.split("\r\n\r\n").nth(1).unwrap().len());
    }
}
