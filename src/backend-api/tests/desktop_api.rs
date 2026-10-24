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
                // 一個真的幀結尾（數字時間戳、合併了 2 個邏輯幀），另一個封包，給串流統計量。
                // A real frame end (numeric timestamp, two logical frames merged) in its own packet, for the stats.
                tokio::time::sleep(Duration::from_millis(50)).await;
                c.s.write_all(encode(&["sync", "1000", "2"], Unit::CodePoints).as_bytes()).await.unwrap();
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

/// 下一個文字 frame（任何一種），或關閉碼。/ The next text frame of any kind, or the close code.
async fn recv_any(ws: &mut Ws) -> Result<String, u16> {
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

/// 每秒的統計 frame：`telepy-ping` + `telepy-stats` 在同一個訊息裡。/ The relay's own once-a-second frame.
fn is_stats_frame(t: &str) -> bool {
    t.starts_with("11.telepy-ping,")
}

/// 下一個來自 guacd 的 frame（跳過中繼自己的統計）。/ The next frame from guacd, skipping the relay's stats.
async fn recv(ws: &mut Ws) -> Result<String, u16> {
    loop {
        let t = recv_any(ws).await?;
        if !is_stats_frame(&t) {
            return Ok(t);
        }
    }
}

/// 下一個統計 frame → (ping 編號, stats JSON)。/ The next stats frame as (ping number, stats JSON).
async fn recv_stats(ws: &mut Ws) -> (u64, Value) {
    loop {
        let t = recv_any(ws).await.expect("socket closed before a stats frame");
        if !is_stats_frame(&t) {
            continue;
        }
        let mut p = Parser::new(Unit::Utf16);
        p.push(t.as_bytes());
        let (list, err) = p.drain();
        assert!(err.is_none(), "{err:?}");
        let ping = list.iter().find(|i| i.opcode() == "telepy-ping").and_then(|i| i.element(1)).and_then(|n| n.parse::<u64>().ok()).expect("ping number");
        let stats = list.iter().find(|i| i.opcode() == "telepy-stats").and_then(|i| i.element(1)).expect("stats element");
        return (ping, serde_json::from_str(stats).expect("stats JSON"));
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
    let Some(mut lab) = Lab::start().await else { return };
    lab.reconfigure(|c| {
        c.guacd_addr = guacd.clone();
        c.desktop_callback_host = "127.0.0.1".into();
    });
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
    assert_eq!(recv(&mut ws).await.unwrap(), "4.sync,4.1000,1.2;");

    // 串流統計：回 sync 的回音與 pong，下一份統計就有畫面往返與網路往返；pong 不會到 guacd。
    // Stream stats: after the sync echo and a pong, the next stats carry both round trips; pongs stop at the relay.
    let (ping, first) = recv_stats(&mut ws).await;
    assert!(first["ms"].as_u64().is_some() && first["behind"].as_u64().is_some(), "{first}");
    ws.send(Message::Text(format!("4.sync,4.1000;11.telepy-pong,{}.{ping};", ping.to_string().len()).into())).await.unwrap();
    let mut measured = None;
    for _ in 0..5 {
        let (_, s) = recv_stats(&mut ws).await;
        if s["frame_ms"].is_number() && s["net_ms"].is_number() {
            measured = Some(s);
            break;
        }
    }
    let s = measured.expect("a stats frame with both round trips");
    assert!(s["frame_ms"].as_u64().unwrap() < 10_000 && s["net_ms"].as_u64().unwrap() < 10_000, "{s}");
    assert_eq!(s["behind"], 0, "{s}");
    wait_for("the sync echo at guacd", || seen.lock().unwrap().after_ready.contains(&"sync".to_string())).await;
    assert!(!seen.lock().unwrap().after_ready.iter().any(|o| o == "telepy-pong"), "{:?}", seen.lock().unwrap().after_ready);

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

    // 憑證庫：用存好的登入開桌面，guacd 拿到的是存的密碼；綁定不同的桌面就拒絕。
    // Vault: a saved login reaches guacd; a login saved for another desktop is refused.
    let r = app.post("/api/credentials", Some(&alice.token), json!({"label": "pc vnc", "protocol": "vnc", "tunnel_id": id, "password": "from-the-vault"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let cred = r.json["id"].as_i64().unwrap();
    let r = app.post(&format!("/api/reverse/server/{id}/desktop/start"), Some(&alice.token), json!({"protocol": "rdp", "username": "ubuntu", "port": desktop, "credential_id": cred})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "an RDP start cannot use a VNC login: {}", r.text);
    let r = app.post(&format!("/api/reverse/server/{id}/desktop/start"), Some(&alice.token), json!({"protocol": "vnc", "username": "ubuntu", "port": desktop, "credential_id": cred})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let mut ws2 = open_ws(&lab, &r.json).await.unwrap();
    assert!(recv(&mut ws2).await.is_ok());
    wait_for("the vault password at guacd", || seen.lock().unwrap().connect.iter().any(|(k, v)| k == "password" && v == "from-the-vault")).await;
    let mut found = false;
    for _ in 0..50 {
        let ev = events(&lab, &alice.token, id).await;
        if ev.iter().any(|e| e["event"] == "desktop_open" && e["message"].as_str().unwrap_or("").contains("with saved login 'pc vnc'")) {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(found, "the open event names the saved login");
    drop(ws2);

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
    let close = ev.iter().find(|e| e["event"] == "desktop_close" && e["message"].as_str().unwrap_or("").contains(&sid[..8])).expect("close event");
    let msg = close["message"].as_str().unwrap();
    assert!(msg.contains("closed after") && msg.contains("(stopped,") && msg.contains("to the browser") && msg.contains("frame latency avg"), "{msg}");
    wait_for("presence cleared", || app.state.presence.for_tunnel(id).iter().all(|e| e.kind.as_str() != "desktop")).await;
}

#[tokio::test]
async fn desktop_screens_are_asked_over_the_device_connection() {
    let (guacd, _seen) = fake_guacd().await;
    let Some(mut lab) = Lab::start().await else { return };
    lab.reconfigure(|c| c.guacd_addr = guacd.clone());
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    // 假 macOS：`uname -s` 回 Darwin，`system_profiler` 不存在 → os 知道、清單空。
    // Pretend macOS: uname answers Darwin, system_profiler is missing: the OS is known, the list empty.
    let mac = lab.machine_with("mac", &[("nat", &[&lab.service])], common::lab::MachineOpts { pretend_darwin: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "mac", &mac).await;
    lab.username(&alice, &dev, "nat").await;
    let id = dev.tunnel_id;

    let r = app.get(&format!("/api/reverse/server/{id}/desktop/screens?username=nat"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["os"], "darwin");
    assert!(r.json["source"].is_null());
    assert_eq!(r.json["screens"].as_array().map(Vec::len), Some(0));
    assert_eq!(r.json["username"], "nat");

    // 沒有 uname 也沒有 PowerShell 的裝置：unknown。/ Neither uname nor PowerShell: unknown.
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], false).await;
    let dev2 = lab.device(&alice, "pc", &pc).await;
    lab.username(&alice, &dev2, "ubuntu").await;
    let r = app.get(&format!("/api/reverse/server/{}/desktop/screens", dev2.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["os"], "unknown");
    assert_eq!(r.json["screens"].as_array().map(Vec::len), Some(0));

    // 和 start 同一道門：沒有分享給 bob → 403；不在允許清單的帳號 → 403。/ Same gate as start.
    assert_eq!(app.get(&format!("/api/reverse/server/{id}/desktop/screens?username=nat"), Some(&bob.token)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get(&format!("/api/reverse/server/{id}/desktop/screens?username=root"), Some(&alice.token)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get("/api/reverse/server/999999/desktop/screens", Some(&alice.token)).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn desktop_refusals() {
    let (guacd, _seen) = fake_guacd().await;
    let Some(mut lab) = Lab::start().await else { return };
    lab.reconfigure(|c| {
        c.guacd_addr = guacd.clone();
        c.desktop_callback_host = "127.0.0.1".into();
    });
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

    // 裝置的 sshd 不允許轉發 → 502 forwarding_disabled。/ The device's sshd forbids forwarding → 502.
    let locked = lab.machine("locked", &[("ubuntu", &[&lab.service])], false).await;
    let locked_dev = lab.device(&alice, "locked", &locked).await;
    lab.username(&alice, &locked_dev, "ubuntu").await;
    let r = app.post(&format!("/api/reverse/server/{}/desktop/start", locked_dev.tunnel_id), Some(&alice.token), json!({"protocol": "rdp", "username": "ubuntu", "port": desktop})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("forwarding_disabled")), "{}", r.text);

    // 別條隧道的區網主機 → 404。/ A LAN host of another tunnel → 404.
    let other_pc = lab.machine("other-pc", &[("ubuntu", &[&lab.service])], true).await;
    let other = lab.device(&bob, "other", &other_pc).await;
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
