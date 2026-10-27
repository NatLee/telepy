//! Remote browser 端到端：SSH lab 上真的裝置（行程內 SOCKS 經池子連線）+ 假的 kasm session-manager（axum）+
//! 假的 KasmVNC websocket（echo），走 REST start/ping/stop 與 /ws/remote-browser 中繼。
mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message as AxMsg, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::connect_async;

#[derive(Clone, Default)]
struct KasmLog(Arc<Mutex<Vec<String>>>);

async fn mock_kasm(log: KasmLog, ws_port: u16) -> String {
    async fn create(State((log, port)): State<(KasmLog, u16)>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
        if headers.get("x-internal-token").and_then(|v| v.to_str().ok()) != Some("internal-secret") {
            return (StatusCode::FORBIDDEN, Json(json!({"error": "forbidden"})));
        }
        log.0.lock().unwrap().push(format!("create proxy={}", body["proxy"].as_str().unwrap_or("")));
        (StatusCode::CREATED, Json(json!({"session_id": "kasm-1", "ws_port": port})))
    }
    async fn delete(State((log, _)): State<(KasmLog, u16)>, Path(id): Path<String>) -> Json<Value> {
        log.0.lock().unwrap().push(format!("delete {id}"));
        Json(json!({"status": "stopped"}))
    }
    let app = Router::new().route("/sessions", post(create)).route("/sessions/{id}", axum::routing::delete(delete)).with_state((log, ws_port));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

/// 假 KasmVNC：連上就先送 greeting（server 先說話），之後 echo。
async fn mock_vnc_ws() -> u16 {
    async fn upgrade(ws: WebSocketUpgrade, headers: HeaderMap) -> Response {
        assert!(headers.get("sec-websocket-origin").is_some(), "Sec-WebSocket-Origin must be sent");
        assert!(headers.get("authorization").map(|v| v.to_str().unwrap().starts_with("Basic ")).unwrap_or(false));
        ws.protocols(["binary"]).on_upgrade(|mut socket: WebSocket| async move {
            let _ = socket.send(AxMsg::Binary(bytes::Bytes::from_static(b"RFB 003.008\n"))).await;
            while let Some(Ok(m)) = socket.recv().await {
                match m {
                    AxMsg::Binary(b) => {
                        if socket.send(AxMsg::Binary(b)).await.is_err() {
                            break;
                        }
                    }
                    AxMsg::Close(_) => break,
                    _ => {}
                }
            }
        })
    }
    let app = Router::new().route("/websockify", get(upgrade));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

async fn setup(app: &mut common::TestApp, kasm_base: &str) -> (String, i64) {
    let mut config = app.state.config.clone();
    config.kasm_api = kasm_base.to_string();
    config.kasm_host = "127.0.0.1".to_string();
    config.hostname = "127.0.0.1".to_string();
    config.remote_browser_gc = false;
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    let token = app.login("admin", "pw").await;
    let r = app.get("/api/reverse/issue/token", Some(&token)).await;
    let t = r.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&token), json!({"host_friendly_name": "box", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4u5n7tS1kO6o4m3yQ0tYQd6v7Jc5Zq8Hh3n5Vt7Wk x"})).await;
    let tunnel_id = r.json["id"].as_i64().unwrap();
    app.post("/api/reverse/server/usernames", Some(&token), json!({"reverse_server": tunnel_id, "username": "ubuntu"})).await;
    // 快一點失敗：ssh 逾時 2s、只試一次。/ Fast failure for the offline case.
    app.post("/api/site/settings", Some(&token), json!({"remote_browser_ssh_timeout": 2, "remote_browser_ssh_attempts": 1})).await;
    (token, tunnel_id)
}

#[tokio::test]
async fn start_relay_and_stop() {
    let Some(mut lab) = common::lab::Lab::start().await else { return };
    let log = KasmLog::default();
    let vnc_port = mock_vnc_ws().await;
    let kasm = mock_kasm(log.clone(), vnc_port).await;
    lab.reconfigure(|c| {
        c.kasm_api = kasm;
        c.kasm_host = "127.0.0.1".to_string();
        c.hostname = "127.0.0.1".to_string();
        c.remote_browser_gc = false;
    });
    let alice = lab.user("alice").await;
    let edge = lab.machine("edge", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "edge", &edge).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let (app, token, tunnel_id) = (&lab.app, alice.token.clone(), dev.tunnel_id);

    // no access for a foreign tunnel → 404
    let r = app.post("/api/reverse/server/999/remote-browser/start", Some(&token), json!({})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.json["error"], "Tunnel not found");
    let r = app.post(&format!("/api/reverse/server/{tunnel_id}/remote-browser/start"), Some(&token), json!({"username": "nobody"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json["error"], "Username not authorized");

    // start (default username resolution)
    let r = app.post(&format!("/api/reverse/server/{tunnel_id}/remote-browser/start"), Some(&token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let sid = r.json["session_id"].as_str().unwrap().to_string();
    assert_eq!(r.json["ws_path"], format!("/ws/remote-browser/{sid}/"));
    assert!(log.0.lock().unwrap()[0].starts_with("create proxy=socks5://127.0.0.1:"), "{:?}", log.0.lock().unwrap());

    // ping ok
    let r = app.post(&format!("/api/reverse/server/remote-browser/{sid}/ping"), Some(&token), json!({})).await;
    assert_eq!(r.json, json!({"status": "ok"}));
    // persisted for restart cleanup
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_remote_browser_session").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(rows, 1);

    // relay: auth → ready → begin → greeting → echo
    let base = lab.ws_base().await;
    let (mut ws, _) = connect_async(format!("{base}/ws/remote-browser/{sid}/")).await.unwrap();
    ws.send(Message::Text(json!({"type": "auth", "token": token}).to_string().into())).await.unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(ready, Message::Text(json!({"type": "ready"}).to_string().into()));
    ws.send(Message::Text(json!({"type": "begin"}).to_string().into())).await.unwrap();
    let greeting = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(greeting, Message::Binary(bytes::Bytes::from_static(b"RFB 003.008\n")));
    ws.send(Message::Binary(bytes::Bytes::from_static(b"client-bytes"))).await.unwrap();
    let echo = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(echo, Message::Binary(bytes::Bytes::from_static(b"client-bytes")));

    // unknown session → 4404
    let (mut bad, _) = connect_async(format!("{base}/ws/remote-browser/nope/")).await.unwrap();
    bad.send(Message::Text(json!({"type": "auth", "token": token}).to_string().into())).await.unwrap();
    match tokio::time::timeout(Duration::from_secs(5), bad.next()).await.unwrap().unwrap().unwrap() {
        Message::Close(Some(f)) => assert_eq!(u16::from(f.code), 4404),
        other => panic!("unexpected {other:?}"),
    }

    // closing the client socket tears the session down (kasm DELETE, record removed)
    ws.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(log.0.lock().unwrap().iter().any(|l| l == "delete kasm-1"), "{:?}", log.0.lock().unwrap());
    let r = app.post(&format!("/api/reverse/server/remote-browser/{sid}/stop"), Some(&token), json!({})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.json["error"], "Session not found");
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_remote_browser_session").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn offline_device_reports_device_offline() {
    // 沒有裝置連上（沒有 gateway、也沒有 sshd）。/ No device behind the tunnel.
    let mut app = common::spawn().await;
    let log = KasmLog::default();
    let kasm = mock_kasm(log.clone(), 1).await;
    let (token, tunnel_id) = setup(&mut app, &kasm).await;
    let r = app.post(&format!("/api/reverse/server/{tunnel_id}/remote-browser/start"), Some(&token), json!({"username": "ubuntu"})).await;
    assert_eq!(r.status, StatusCode::INTERNAL_SERVER_ERROR, "{}", r.text);
    assert_eq!(r.json["code"], "device_offline");
    assert!(r.json["error"].as_str().unwrap().contains("is the device online?"));
    assert!(log.0.lock().unwrap().is_empty(), "kasm must not be called when the proxy never came up");
    let r = app.post(&format!("/api/reverse/server/remote-browser/whatever/ping"), Some(&token), json!({})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

/// 失去權限（允許帳號被拿掉）：開著的遠端瀏覽器以 4009 結束（原因 = 存取變了），session 收掉，`browser_close` 說為什麼。
/// Losing access (the account removed): an open remote browser ends with 4009, the session is torn down, and
/// `browser_close` says why.
#[tokio::test]
async fn remote_browser_ends_when_access_is_lost() {
    let Some(mut lab) = common::lab::Lab::start().await else { return };
    let log = KasmLog::default();
    let vnc_port = mock_vnc_ws().await;
    let kasm = mock_kasm(log.clone(), vnc_port).await;
    lab.reconfigure(|c| {
        c.kasm_api = kasm;
        c.kasm_host = "127.0.0.1".to_string();
        c.hostname = "127.0.0.1".to_string();
        c.remote_browser_gc = false;
    });
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let edge = lab.machine("edge", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "edge", &edge).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let (app, id) = (&lab.app, dev.tunnel_id);

    let r = app.post(&format!("/api/reverse/server/{id}/remote-browser/start"), Some(&bob.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let sid = r.json["session_id"].as_str().unwrap().to_string();
    let base = lab.ws_base().await;
    let (mut ws, _) = connect_async(format!("{base}/ws/remote-browser/{sid}/")).await.unwrap();
    ws.send(Message::Text(json!({"type": "auth", "token": bob.token}).to_string().into())).await.unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(ready, Message::Text(json!({"type": "ready"}).to_string().into()));
    for _ in 0..50 {
        if app.state.presence.for_tunnel(id).iter().any(|e| e.kind.as_str() == "browser") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let r = app.patch(&format!("/tunnels/share/{id}/{}/allowed-usernames", bob.id), Some(&alice.token), json!({"allowed_target_username_ids": []})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let closed = loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("the browser socket stayed open") {
            Some(Ok(Message::Close(Some(f)))) => break (u16::from(f.code), f.reason.to_string()),
            Some(Ok(_)) => continue,
            other => panic!("unexpected {other:?}"),
        }
    };
    assert_eq!(closed, (4009, telepy_server::access_recheck::ENDED_BY.to_string()));
    let mut msg = None;
    for _ in 0..50 {
        let ev = app.get(&format!("/api/log/ssh/events?tunnel_id={id}"), Some(&alice.token)).await;
        msg = ev.json.as_array().unwrap().iter().find(|e| e["event"] == "browser_close").and_then(|e| e["message"].as_str().map(str::to_string));
        if msg.is_some() && log.0.lock().unwrap().iter().any(|l| l == "delete kasm-1") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let msg = msg.expect("browser_close");
    assert!(msg.contains("the login account is no longer allowed"), "{msg}");
    assert!(log.0.lock().unwrap().iter().any(|l| l == "delete kasm-1"), "the kasm session is stopped: {:?}", log.0.lock().unwrap());
}
