//! `GET /ws/proxy/?tunnel=<id|name>&host=<host>&port=<port>[&account=<device account>]`：一條 WebSocket = 一條經裝置的
//! TCP 連線（見 `crate::proxy`）。認證在升級之前：`Authorization: Bearer <OAuth access token | 個人 API token>`，scope
//! `proxy:use`。所有檢查與「裝置真的連上目標」都在升級前做完，所以失敗是一般的 HTTP 狀態加 `{error, code}`
//! （401 沒有 / 無效的 token、403、404、429、502），成功才回 101；之後二進位 frame 就是那條 TCP 的資料，任一邊關閉即結束。
//! 走的是網頁的 port，所以只放行網頁 port 的網路與 CDN 都過得去（跟 SSH over WebSocket 同一個道理）。
//!
//! One WebSocket = one TCP connection through the device (see `crate::proxy`). Authentication comes before the upgrade:
//! `Authorization: Bearer <OAuth access token | personal API token>` with scope `proxy:use`. Every check, and the
//! device actually reaching the target, happens before the upgrade, so a failure is a plain HTTP status with
//! `{error, code}` (401, 403, 404, 429, 502) and only success answers 101; from then on binary frames are that TCP
//! connection's bytes and either side closing ends it. It rides the web port, so networks and CDNs that only carry web
//! ports let it through (the same idea as SSH over WebSocket).

use std::collections::HashMap;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::auth::mcp;
use crate::client_ip::ClientMeta;
use crate::proxy::{self, ProxyError};
use crate::state::AppState;

fn refuse(e: &ProxyError) -> Response {
    (e.status, Json(e.json())).into_response()
}

/// `Authorization: Bearer …` 裡的 token。/ The token of an `Authorization: Bearer …` header.
pub fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = v.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty()).then(|| token.trim().to_string())
}

/// token → 呼叫者；失敗 = 401（沒帶 / 無效）。/ Token → caller; a failure is a 401.
pub async fn principal(state: &AppState, token: Option<String>, ip: Option<String>) -> Result<mcp::McpPrincipal, ProxyError> {
    let Some(token) = token else {
        return Err(ProxyError::new(StatusCode::UNAUTHORIZED, "token_required", "Send an OAuth access token or a personal API token with the proxy:use permission."));
    };
    let mut p = mcp::resolve_delegated(state, &token).await.map_err(|_| ProxyError::new(StatusCode::UNAUTHORIZED, "token_invalid", "The token is invalid, expired or revoked."))?;
    p.ip = ip;
    Ok(p)
}

pub async fn upgrade(State(state): State<AppState>, Query(q): Query<HashMap<String, String>>, meta: ClientMeta, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let p = match principal(&state, bearer(&headers), meta.ip.clone()).await {
        Ok(p) => p,
        Err(e) => return refuse(&e),
    };
    let get = |k: &str| q.get(k).map(String::as_str).filter(|v| !v.is_empty());
    let (Some(tunnel), Some(host), Some(port)) = (get("tunnel"), get("host"), get("port").and_then(|p| p.parse::<u16>().ok())) else {
        return refuse(&ProxyError::new(StatusCode::BAD_REQUEST, "bad_request", "Give tunnel, host and port: /ws/proxy/?tunnel=<id or name>&host=<host>&port=<port>"));
    };
    let (session, max) = match proxy::authorize(&state, &p, tunnel, get("account")).await {
        Ok(s) => s,
        Err(e) => return refuse(&e),
    };
    let conn = match session.open(&state, host, port, max).await {
        Ok(c) => c,
        Err(e) => return refuse(&e),
    };
    super::prepare(ws).on_upgrade(move |socket| conn.relay(super::gateway::WsStream::new(socket)))
}
