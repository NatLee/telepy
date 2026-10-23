//! 網頁內遠端桌面端到端：真的 gateway + 真的 OpenSSH 反向隧道 + 裝置 sshd（lab 的 Machine，接受 direct-tcpip），
//! 加一個假的 guacd（照 Guacamole 協定握手、連回後端的 rendezvous 埠）和一個 echo 服務當「桌面」。
//! 驗證：REST 開通道 → WS 票證（單次、`guacamole` 子協定）→ 後端做握手（帳密不經瀏覽器）→ guacd 回連 →
//! 經裝置 sshd 到目標 → 雙向中繼、opcode 白名單、presence、gateway 事件（含秒數），以及各種拒絕情況。
//! Remote desktop end to end with a fake guacd and an echo "desktop" behind the device.
mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use common::lab::{free_port, Device, Lab};
use telepy_server::desktop::guac::{encode, Instruction, Parser, Unit};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 假 guacd 看到的東西。/ What the fake guacd observed.
#[derive(Default)]
struct Seen {
    /// `connect` 的參數（名稱 → 值）。/ The `connect` arguments by name.
    connect: Vec<(String, String)>,
    /// `ready` 之後從後端收到的指令（opcode）。/ Opcodes received after `ready`.
    after_ready: Vec<String>,
}

const ARG_NAMES: [&str; 6] = ["VERSION_1_5_0", "hostname", "port", "username", "password", "disable-copy"];

struct Conn {
    s: TcpStream,
    p: Parser,
}

impl Conn {
    async fn next(&mut self) -> Option<Instruction> {
        let mut buf = [0u8; 8192];
        loop {
            if let Some(i) = self.p.next().unwrap() {
                return Some(i);
            }
            let n = self.s.read(&mut buf).await.ok()?;
            if n == 0 {
                return None;
            }
            self.p.push(&buf[..n]);
        }
    }
}

/// 一個照協定走的假 guacd：握手 → 連回 hostname:port → 寫 PING、讀回 echo → `ready` → 把 echo 用 `sync` 送給瀏覽器。
/// A protocol-following fake guacd that proves the bridge reaches the target.
async fn fake_guacd() -> (String, Arc<Mutex<Seen>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap().to_string();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let shared = seen.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            let seen = shared.clone();
            tokio::spawn(async move {
                let mut c = Conn { s, p: Parser::new(Unit::CodePoints) };
                let select = c.next().await.unwrap();
                assert_eq!(select.opcode(), "select");
                c.s.write_all(encode(&[&["args"][..], &ARG_NAMES[..]].concat(), Unit::CodePoints).as_bytes()).await.unwrap();
                let mut opcodes = Vec::new();
                let connect = loop {
                    let i = c.next().await.unwrap();
                    if i.opcode() == "connect" {
                        break i;
                    }
                    opcodes.push(i.opcode().to_string());
                };
                assert_eq!(opcodes, ["size", "audio", "video", "image"], "handshake order");
                let values: Vec<String> = connect.args().map(str::to_string).collect();
                let pairs: Vec<(String, String)> = ARG_NAMES.iter().map(|n| n.to_string()).zip(values).collect();
                let host = pairs.iter().find(|(n, _)| n == "hostname").unwrap().1.clone();
                let port: u16 = pairs.iter().find(|(n, _)| n == "port").unwrap().1.parse().unwrap();
                seen.lock().unwrap().connect = pairs;
                let mut bridge = TcpStream::connect((host.as_str(), port)).await.expect("rendezvous");
                bridge.write_all(b"PING").await.unwrap();
                let mut echo = [0u8; 4];
                bridge.read_exact(&mut echo).await.expect("echo through the device");
                c.s.write_all(encode(&["ready", "$fake-1"], Unit::CodePoints).as_bytes()).await.unwrap();
                c.s.write_all(encode(&["sync", std::str::from_utf8(&echo).unwrap()], Unit::CodePoints).as_bytes()).await.unwrap();
                while let Some(i) = c.next().await {
                    let op = i.opcode().to_string();
                    seen.lock().unwrap().after_ready.push(op.clone());
                    if op == "disconnect" {
                        break;
                    }
                }
                drop(bridge);
            });
        }
    });
    (addr, seen)
}

/// 「桌面」：把收到的 bytes 原樣送回。/ The "desktop": echoes what it gets.
async fn echo_service() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

async fn open_ws(lab: &Lab, start: &Value) -> Result<Ws, String> {
    let url = format!("{}{}?ticket={}&width=1024&height=768", lab.ws_base().await, start["ws_path"].as_str().unwrap(), start["ticket"].as_str().unwrap());
    let mut req = url.into_client_request().unwrap();
    req.headers_mut().insert("Sec-WebSocket-Protocol", "guacamole".parse().unwrap());
    let (ws, resp) = connect_async(req).await.map_err(|e| e.to_string())?;
    assert_eq!(resp.headers().get("sec-websocket-protocol").and_then(|v| v.to_str().ok()), Some("guacamole"));
    Ok(ws)
}

/// 下一個文字 frame，或關閉碼。/ The next text frame, or the close code.
async fn recv(ws: &mut Ws) -> Result<String, u16> {
    loop {
        match tokio::time::timeout(Duration::from_secs(15), ws.next()).await.expect("no frame from the desktop socket") {
            Some(Ok(Message::Text(t))) => return Ok(t.to_string()),
            Some(Ok(Message::Close(Some(f)))) => return Err(u16::from(f.code)),
            Some(Ok(Message::Close(None))) | None => return Err(1000),
            Some(Ok(_)) => continue,
            Some(Err(e)) => panic!("desktop socket error: {e}"),
        }
    }
}

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<Value> {
    let r = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await;
    r.json.as_array().cloned().unwrap_or_default()
}

async fn wait_for<F: Fn() -> bool>(what: &str, f: F) {
    for _ in 0..100 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn desktop_session_through_the_device() {
    let (guacd, seen) = fake_guacd().await;
    let Some(lab) = Lab::start_with(|c| {
        c.guacd_addr = guacd.clone();
        c.desktop_callback_host = "127.0.0.1".into();
    })
    .await
    else {
        return;
    };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let desktop = echo_service().await;
    let id = dev.tunnel_id;

    let r = app.post(&format!("/api/reverse/server/{id}/desktop/start"), Some(&alice.token), json!({"protocol": "vnc", "username": "ubuntu", "port": desktop, "password": "s3cret"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let start = r.json.clone();
    assert_eq!(start["target"]["host"], "127.0.0.1");
    assert_eq!(start["target"]["port"], desktop);
    assert_eq!(start["clipboard"], "both");
    assert!(start.get("password").is_none(), "the password is never echoed");
    let sid = start["session_id"].as_str().unwrap().to_string();

    let mut ws = open_ws(&lab, &start).await.unwrap();
    // 第一個指令 = tunnel UUID（空 opcode）；接著是 guacd 經裝置讀回的 echo。
    // First the tunnel UUID (empty opcode), then the echo guacd read through the device.
    assert_eq!(recv(&mut ws).await.unwrap(), encode(&["", &sid], Unit::Utf16));
    assert_eq!(recv(&mut ws).await.unwrap(), "4.sync,4.PING;");

    // 握手由後端做：guacd 連回 rendezvous，帳密在 connect 裡、不經瀏覽器。
    // The backend did the handshake: rendezvous address and the password are in `connect`.
    {
        let s = seen.lock().unwrap();
        let get = |n: &str| s.connect.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("hostname"), "127.0.0.1");
        assert_ne!(get("port"), "0");
        assert_eq!(get("password"), "s3cret");
        assert_eq!(get("username"), "");
        assert_eq!(get("VERSION_1_5_0"), "VERSION_1_5_0");
    }

    // 白名單：put / argv 被丟掉，key / size 轉給 guacd。/ Allowlist: put/argv dropped, key/size forwarded.
    ws.send(Message::Text("3.put,1.0,10.text/plain;4.argv,1.1,10.text/plain,8.password;3.key,5.65307,1.1;4.size,4.1024,3.768;".into())).await.unwrap();
    wait_for("key and size at guacd", || {
        let s = seen.lock().unwrap();
        s.after_ready.contains(&"key".to_string()) && s.after_ready.contains(&"size".to_string())
    })
    .await;
    assert!(!seen.lock().unwrap().after_ready.iter().any(|o| o == "put" || o == "argv"), "{:?}", seen.lock().unwrap().after_ready);

    // 票證只能用一次。/ The ticket is single use.
    let mut again = open_ws(&lab, &start).await.unwrap();
    assert_eq!(recv(&mut again).await.err(), Some(4404));

    // presence + 開始事件。/ Presence and the open event.
    let present = app.state.presence.for_tunnel(id);
    assert!(present.iter().any(|e| e.kind.as_str() == "desktop" && e.username == "alice"), "{present:?}");
    let ev = events(&lab, &alice.token, id).await;
    assert!(ev.iter().any(|e| e["event"] == "desktop_open" && e["message"].as_str().unwrap().contains("Remote desktop (VNC) by alice to device:")), "{ev:?}");

    // 別人不能停；自己可以（連線中 → 伺服器送 disconnect、關閉碼 4014）。
    // Others can't stop it; the owner can (connected → disconnect + close 4014).
    let bob = lab.user("bob").await;
    assert_eq!(app.post(&format!("/api/reverse/server/desktop/{sid}/stop"), Some(&bob.token), json!({})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.post(&format!("/api/reverse/server/desktop/{sid}/stop"), Some(&alice.token), json!({})).await.status, StatusCode::OK);
    loop {
        match recv(&mut ws).await {
            Ok(t) if t == "10.disconnect;" => continue,
            Ok(other) => panic!("unexpected frame {other}"),
            Err(code) => {
                assert_eq!(code, 4014);
                break;
            }
        }
    }
    wait_for("desktop_close event", || app.state.desktop.get(&sid).is_none()).await;
    let ev = events(&lab, &alice.token, id).await;
    let close = ev.iter().find(|e| e["event"] == "desktop_close").expect("close event");
    let msg = close["message"].as_str().unwrap();
    assert!(msg.contains("closed after") && msg.contains("(stopped,"), "{msg}");
    wait_for("presence cleared", || app.state.presence.for_tunnel(id).iter().all(|e| e.kind.as_str() != "desktop")).await;
}

#[tokio::test]
async fn desktop_refusals() {
    let (guacd, _seen) = fake_guacd().await;
    let Some(lab) = Lab::start_with(|c| {
        c.guacd_addr = guacd.clone();
        c.desktop_callback_host = "127.0.0.1".into();
    })
    .await
    else {
        return;
    };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service]), ("admin", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "pc", &pc).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.username(&alice, &dev, "admin").await;
    let desktop = echo_service().await;
    let id = dev.tunnel_id;
    let start = |token: String, body: Value| async move { app.post(&format!("/api/reverse/server/{id}/desktop/start"), Some(&token), body).await };

    // 沒權限 / 不允許的帳號。/ No access, or an account outside the allow-list.
    let r = start(bob.token.clone(), json!({"protocol": "rdp", "username": "ubuntu", "port": desktop})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    lab.share(&alice, &dev, &carol, "view", &[ubuntu]).await;
    let r = start(carol.token.clone(), json!({"protocol": "rdp", "username": "admin", "port": desktop})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = start(carol.token.clone(), json!({"protocol": "rdp", "username": "ubuntu", "port": desktop})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.post(&format!("/api/reverse/server/desktop/{}/stop", r.json["session_id"].as_str().unwrap()), Some(&carol.token), json!({})).await.status, StatusCode::OK);

    // 欄位驗證。/ Field validation.
    for body in [json!({"username": "ubuntu"}), json!({"protocol": "ssh", "username": "ubuntu"}), json!({"protocol": "rdp", "username": "ubuntu", "port": 0})] {
        let r = start(alice.token.clone(), body.clone()).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body} → {}", r.text);
    }

    // 目標沒在聽 → 502 target_unreachable。/ Nothing listening → 502.
    let r = start(alice.token.clone(), json!({"protocol": "rdp", "username": "ubuntu", "port": free_port()})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("target_unreachable")), "{}", r.text);

    // 別條隧道的區網主機 → 404。/ A LAN host of another tunnel → 404.
    let other = lab.device(&bob, "other", &pc).await;
    let r = app.post(&format!("/api/reverse/server/{}/lan/hosts", other.tunnel_id), Some(&bob.token), json!({"address": "127.0.0.1"})).await;
    let foreign = r.json["id"].as_i64().unwrap();
    let r = start(alice.token.clone(), json!({"protocol": "rdp", "username": "ubuntu", "lan_host_id": foreign, "port": desktop})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    // 自己這條的區網主機可以。/ This tunnel's own LAN host works.
    let r = app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "localhost", "label": "nas"})).await;
    let mine = r.json["id"].as_i64().unwrap();
    let r = start(alice.token.clone(), json!({"protocol": "rdp", "username": "ubuntu", "lan_host_id": mine, "port": desktop})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["target"]["host"].as_str(), r.json["target"]["label"].as_str()), (Some("localhost"), Some("nas")));
    let unclaimed = r.json.clone();

    // 上限：一個還沒認領的 session 也算。/ The cap counts unclaimed sessions too.
    sqlx::query("UPDATE site_settings_sitesettings SET desktop_max_sessions = 1 WHERE id = 1").execute(&app.state.db.write).await.unwrap();
    let r = start(alice.token.clone(), json!({"protocol": "rdp", "username": "ubuntu", "port": desktop})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("desktop_busy")), "{}", r.text);
    // 停掉沒認領的 → 它的票證失效。/ Stopping an unclaimed session voids its ticket.
    assert_eq!(app.post(&format!("/api/reverse/server/desktop/{}/stop", unclaimed["session_id"].as_str().unwrap()), Some(&alice.token), json!({})).await.status, StatusCode::OK);
    let mut ws = open_ws(&lab, &unclaimed).await.unwrap();
    assert_eq!(recv(&mut ws).await.err(), Some(4404));

    // 站台關閉 → 503 desktop_disabled。/ Switched off → 503.
    sqlx::query("UPDATE site_settings_sitesettings SET desktop_enabled = 0 WHERE id = 1").execute(&app.state.db.write).await.unwrap();
    let r = start(alice.token.clone(), json!({"protocol": "rdp", "username": "ubuntu", "port": desktop})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("desktop_disabled")), "{}", r.text);
    sqlx::query("UPDATE site_settings_sitesettings SET desktop_enabled = 1, desktop_max_sessions = 4 WHERE id = 1").execute(&app.state.db.write).await.unwrap();

    // 裝置離線（隧道存在但沒有 forward）→ 502 device_offline。/ No tunnel up → 502 device_offline.
    let key = lab.keygen("ghost-tunnel");
    let ghost = telepy_server::db::tunnels::create(
        &app.state.db,
        telepy_server::db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "ghost", key: &key.public, reverse_port: free_port() as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let ghost_dev = Device { tunnel_id: ghost.id, name: "ghost".into(), reverse_port: ghost.reverse_port as u16, target: pc.clone(), key };
    lab.username(&alice, &ghost_dev, "ubuntu").await;
    let r = app.post(&format!("/api/reverse/server/{}/desktop/start", ghost.id), Some(&alice.token), json!({"protocol": "vnc", "username": "ubuntu"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("device_offline")), "{}", r.text);

    // 站台設定的值域。/ Site-setting validation.
    for (k, v) in [("desktop_clipboard", json!("sideways")), ("desktop_max_resolution", json!(100)), ("desktop_session_idle_timeout", json!(-1))] {
        let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({ k: v })).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{k}={v} → {}", r.text);
    }
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"desktop_clipboard": "to_remote"})).await;
    assert_eq!(r.json["values"]["desktop_clipboard"], "to_remote", "{}", r.text);
}
