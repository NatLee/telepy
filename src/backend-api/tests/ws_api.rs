//! WebSocket 協定測試：以真正的 TCP 監聽 + tungstenite client 打 /ws/*。
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn serve(app: &common::TestApp) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("ws://{addr}")
}

async fn connect(base: &str, path: &str) -> Ws {
    let (ws, _) = connect_async(format!("{base}{path}")).await.unwrap();
    ws
}

async fn send_json(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

async fn next(ws: &mut Ws) -> Message {
    tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timeout waiting for frame").expect("stream ended").unwrap()
}

fn close_code(m: &Message) -> Option<u16> {
    match m {
        Message::Close(Some(f)) => Some(u16::from(f.code)),
        _ => None,
    }
}

async fn next_json(ws: &mut Ws) -> Value {
    match next(ws).await {
        Message::Text(t) => serde_json::from_str(&t).unwrap(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

#[tokio::test]
async fn notifications_auth_ping_and_fanout() {
    let app = common::spawn().await;
    let token = app.login("admin", "pw").await;
    let uid = app.get("/api/auth/user/profile", Some(&token)).await.json["id"].as_i64().unwrap();
    let base = serve(&app).await;

    // bad token → 4001
    let mut ws = connect(&base, "/ws/notifications/").await;
    send_json(&mut ws, json!({"type": "auth", "token": "nope"})).await;
    assert_eq!(close_code(&next(&mut ws).await), Some(4001));

    // not an auth frame → 4000
    let mut ws = connect(&base, "/ws/notifications/").await;
    send_json(&mut ws, json!({"type": "ping"})).await;
    assert_eq!(close_code(&next(&mut ws).await), Some(4000));

    // good token: ping/pong + hub fan-out
    let mut ws = connect(&base, "/ws/notifications/").await;
    send_json(&mut ws, json!({"type": "auth", "token": token})).await;
    send_json(&mut ws, json!({"type": "ping"})).await;
    assert_eq!(next_json(&mut ws).await, json!({"type": "pong"}));
    // subscription is registered synchronously after auth; give the server a tick to be safe
    tokio::time::sleep(Duration::from_millis(50)).await;
    app.state.hub.notify_user(uid, &json!({"action": "UPDATED-TUNNELS", "tunnel_id": 7}));
    assert_eq!(next_json(&mut ws).await, json!({"message": {"action": "UPDATED-TUNNELS", "tunnel_id": 7}}));
    ws.close(None).await.unwrap();
}

#[tokio::test]
async fn tunnel_connection_status_and_monitor_cycle() {
    let app = common::spawn().await;
    let token = app.login("admin", "pw").await;
    let r = app.get("/api/reverse/issue/token", Some(&token)).await;
    let t = r.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&token), json!({"host_friendly_name": "box", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4u5n7tS1kO6o4m3yQ0tYQd6v7Jc5Zq8Hh3n5Vt7Wk x"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let tunnel_id = r.json["id"].as_i64().unwrap();
    let port = r.json["reverse_port"].as_i64().unwrap();
    let base = serve(&app).await;

    // no access to a foreign tunnel id → 4004
    let mut ws = connect(&base, "/ws/tunnel_connection/999/").await;
    send_json(&mut ws, json!({"type": "auth", "token": token, "tunnel_id": "999"})).await;
    assert_eq!(close_code(&next(&mut ws).await), Some(4004));

    // initial status: offline, no rtt
    let mut tc = connect(&base, &format!("/ws/tunnel_connection/{tunnel_id}/")).await;
    send_json(&mut tc, json!({"type": "auth", "token": token, "tunnel_id": tunnel_id.to_string()})).await;
    let initial = next_json(&mut tc).await;
    assert_eq!(initial["type"], "connection_status");
    assert_eq!(initial["tunnel_id"], tunnel_id);
    assert_eq!(initial["is_connected"], false);
    assert_eq!(initial["rtt_ms"], Value::Null);
    assert_eq!(initial["host_friendly_name"], "box");

    let mut notif = connect(&base, "/ws/notifications/").await;
    send_json(&mut notif, json!({"type": "auth", "token": token})).await;
    send_json(&mut notif, json!({"type": "ping"})).await;
    assert_eq!(next_json(&mut notif).await, json!({"type": "pong"}));

    // feed a sample where the port is listening + a latency, run two monitor cycles (debounce)
    app.state.status.set_listen_ports([port as u16].into_iter().collect());
    app.state.status.set_latency([(port as u16, 87.3)].into_iter().collect());
    let mut runner = telepy_server::monitor::runner::Runner::default();
    telepy_server::monitor::runner::cycle(&app.state, &mut runner).await.unwrap();
    // cycle 1: latency broadcast only (status held by the debouncer)
    let m = next_json(&mut notif).await;
    assert_eq!(m["message"]["action"], "UPDATE-TUNNEL-LATENCY");
    assert_eq!(m["message"]["latency"][port.to_string()], 87.3);
    let m = next_json(&mut tc).await;
    assert_eq!(m["type"], "latency_update");
    assert_eq!(m["rtt_ms"], 87.3);
    // 第一輪：raw=true 與承認值 false 不同 → 保持 false（與 Django 相同，cache 會寫入 {port: False}）。
    assert_eq!(app.state.status.committed_ports().get(&port), Some(&false), "first differing sample must be held");

    telepy_server::monitor::runner::cycle(&app.state, &mut runner).await.unwrap();
    // cycle 2: status commits → STATUS-DATA snapshot + UPDATE-TUNNEL-STATUS + connection_status
    let m = next_json(&mut notif).await;
    assert_eq!(m["message"]["action"], "UPDATE-TUNNEL-STATUS-DATA");
    assert_eq!(m["message"]["data"], json!([port]));
    let m = next_json(&mut notif).await;
    assert_eq!(m["message"]["action"], "UPDATE-TUNNEL-STATUS");
    assert_eq!(m["message"]["port"], port);
    assert_eq!(m["message"]["status"], "connected");
    assert_eq!(m["message"]["details"], format!("Tunnel on port [{port}] has been connected"));
    let m = next_json(&mut tc).await;
    assert_eq!(m["type"], "connection_status");
    assert_eq!(m["is_connected"], true);
    assert_eq!(app.state.status.committed_ports().get(&port), Some(&true));

    // dashboard now reports the committed state via the raw sample
    let r = app.get("/api/reverse/server/dashboard", Some(&token)).await;
    assert_eq!(r.json["ports"][port.to_string()], true);
    assert_eq!(r.json["latency"][port.to_string()], 87.3);
}

#[tokio::test]
async fn terminal_pty_roundtrip_with_fake_ssh() {
    let mut app = common::spawn().await;
    // 假的 ssh：印出收到的參數，然後把 stdin 回聲（cat）。/ Fake ssh: echo argv, then cat stdin.
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fake-ssh");
    std::fs::write(&script, "#!/bin/sh\necho \"FAKE-SSH:$*\"\nexec cat\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    app.set_ssh_binary(script.to_str().unwrap()).await;

    let token = app.login("admin", "pw").await;
    let r = app.get("/api/reverse/issue/token", Some(&token)).await;
    let t = r.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&token), json!({"host_friendly_name": "box", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4u5n7tS1kO6o4m3yQ0tYQd6v7Jc5Zq8Hh3n5Vt7Wk x"})).await;
    let tunnel_id = r.json["id"].as_i64().unwrap();
    let base = serve(&app).await;

    // no usernames yet → 4006
    let mut ws = connect(&base, "/ws/terminal/").await;
    send_json(&mut ws, json!({"type": "auth", "token": token, "server_id": tunnel_id.to_string(), "username": "ubuntu"})).await;
    assert_eq!(close_code(&next(&mut ws).await), Some(4006));

    app.post("/api/reverse/server/usernames", Some(&token), json!({"reverse_server": tunnel_id, "username": "ubuntu"})).await;

    // wrong username → 4003
    let mut ws = connect(&base, "/ws/terminal/").await;
    send_json(&mut ws, json!({"type": "auth", "token": token, "server_id": tunnel_id.to_string(), "username": "nobody"})).await;
    assert_eq!(close_code(&next(&mut ws).await), Some(4003));

    // happy path
    let mut ws = connect(&base, "/ws/terminal/").await;
    send_json(&mut ws, json!({"type": "auth", "token": token, "server_id": tunnel_id.to_string(), "username": "ubuntu"})).await;
    let mut seen = String::new();
    while !seen.contains("FAKE-SSH:") {
        match next(&mut ws).await {
            Message::Text(t) => seen.push_str(&t),
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(seen.contains("ubuntu@reverse"), "{seen}");
    assert!(seen.contains("ControlMaster=auto"), "{seen}");

    send_json(&mut ws, json!({"action": "pty_resize", "payload": {"size": {"rows": 30, "cols": 100, "height": 600, "width": 900}}})).await;
    send_json(&mut ws, json!({"action": "ping"})).await;
    // pong arrives as a binary frame (PTY output may interleave; skip text)
    loop {
        match next(&mut ws).await {
            Message::Binary(b) => {
                assert_eq!(&b[..], b"pong");
                break;
            }
            Message::Text(_) => continue,
            other => panic!("unexpected {other:?}"),
        }
    }
    send_json(&mut ws, json!({"action": "pty_input", "payload": {"input": "hello-pty\n"}})).await;
    let mut seen = String::new();
    while !seen.contains("hello-pty") {
        match next(&mut ws).await {
            Message::Text(t) => seen.push_str(&t),
            Message::Binary(_) => {}
            other => panic!("unexpected {other:?}"),
        }
    }
    ws.close(None).await.unwrap();
}
