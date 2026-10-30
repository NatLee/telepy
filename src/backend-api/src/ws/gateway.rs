//! SSH over WebSocket：`GET /ws/gateway/` 載的是和 24242 一模一樣的 SSH session（同一組 host key、同樣的金鑰驗證、
//! 同樣的 forward 規則），只是換一條線 —— 給只放行網頁 port 的網路（公司內網、飯店、4G 路由器）用。
//! 沒有 auth 第一則訊息：認證在裡面的 SSH 做。來源 IP 取自 `ClientMeta`（X-Forwarded-For，信任的代理層數見
//! `TRUSTED_PROXY_HOPS`），事件 / endpoint 的 port 是 0（代理後面看不到）。二進位 frame ↔ bytes 的轉接在 [`WsStream`]。
//! SSH over WebSocket: the same SSH session port 24242 carries, on a WebSocket, for networks that only allow the
//! web port out. No auth frame — SSH authenticates inside. The client IP comes from the forwarded headers.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::task::{ready, Context, Poll};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket};
use futures::{Sink, SinkExt, Stream};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::client_ip::ClientMeta;
use crate::gateway::{self, Transport};
use crate::state::AppState;

/// 最前面那個代理說的協定：https（Traefik 對 WebSocket 會寫成 wss）= 裝置那頭有 TLS。只影響標籤（WSS / WS），
/// 所以客戶端自己帶的值也無妨。
/// The protocol the outermost proxy reports: https (Traefik writes wss for WebSockets) = TLS on the device's side.
/// It only labels the connection (WSS / WS), so a client-supplied value does no harm.
pub fn forwarded_tls(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "https" | "wss"))
        .unwrap_or(false)
}

pub async fn handle(state: AppState, mut socket: WebSocket, meta: ClientMeta, tls: bool) {
    let ip = meta.ip.as_deref().and_then(|s| s.parse::<IpAddr>().ok()).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let peer = SocketAddr::new(ip, 0);
    if state.gateway.at_capacity() {
        tracing::warn!(%peer, "gateway: connection limit reached; dropping websocket");
        let _ = socket.close().await;
        return;
    }
    gateway::serve(state.gateway.clone(), WsStream::new(socket), peer, Transport::WebSocket { tls }).await;
}

/// 把 WebSocket 當成位元組串流：收到的二進位（或文字）frame 是讀入的資料，寫出的資料一律是二進位 frame。
/// Ping / Pong 由 axum 處理，Close = EOF。/ A WebSocket as a byte stream: frames in, binary frames out, Close = EOF.
pub struct WsStream {
    ws: WebSocket,
    pending: Bytes,
    eof: bool,
}

impl WsStream {
    pub fn new(ws: WebSocket) -> Self {
        Self { ws, pending: Bytes::new(), eof: false }
    }
}

fn io_err(e: axum::Error) -> io::Error {
    io::Error::other(e)
}

impl AsyncRead for WsStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, out: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if !this.pending.is_empty() {
                let n = out.remaining().min(this.pending.len());
                out.put_slice(&this.pending.split_to(n));
                return Poll::Ready(Ok(()));
            }
            if this.eof {
                return Poll::Ready(Ok(()));
            }
            match ready!(Pin::new(&mut this.ws).poll_next(cx)) {
                None | Some(Ok(Message::Close(_))) => {
                    this.eof = true;
                    return Poll::Ready(Ok(()));
                }
                Some(Err(e)) => return Poll::Ready(Err(io_err(e))),
                Some(Ok(Message::Binary(b))) => this.pending = b,
                Some(Ok(Message::Text(t))) => this.pending = Bytes::copy_from_slice(t.as_bytes()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            }
        }
    }
}

impl AsyncWrite for WsStream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        ready!(Pin::new(&mut this.ws).poll_ready(cx)).map_err(io_err)?;
        Pin::new(&mut this.ws).start_send(Message::Binary(Bytes::copy_from_slice(data))).map_err(io_err)?;
        Poll::Ready(Ok(data.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().ws).poll_flush(cx).map_err(io_err)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().ws).poll_close(cx).map_err(io_err)
    }
}

#[cfg(test)]
mod tests {
    use super::forwarded_tls;
    use axum::http::HeaderMap;

    fn with(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-proto", v.parse().unwrap());
        h
    }

    #[test]
    fn the_outermost_proxys_protocol_decides() {
        assert!(forwarded_tls(&with("https")));
        assert!(forwarded_tls(&with("wss")));
        assert!(forwarded_tls(&with("HTTPS, http")));
        assert!(!forwarded_tls(&with("http, https")));
        assert!(!forwarded_tls(&with("ws")));
        assert!(!forwarded_tls(&HeaderMap::new()));
    }
}
