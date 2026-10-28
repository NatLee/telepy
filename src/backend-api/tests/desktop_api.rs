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
    /// 握手時 `audio` 指令帶的格式（空 = 不要聲音）。/ The formats in the handshake's `audio` instruction.
    audio: Vec<String>,
    /// 握手的 `size`（寬、高、dpi）。/ The handshake's `size` (width, height, dpi).
    handshake_size: Vec<String>,
    /// `ready` 之後收到的每個 `size` 的參數。/ The arguments of every `size` after `ready`.
    sizes: Vec<Vec<String>>,
}

const ARG_NAMES: [&str; 12] = ["VERSION_1_5_0", "hostname", "port", "username", "password", "disable-copy", "disable-paste", "disable-audio", "width", "height", "resize-method", "disable-display-resize"];

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
                let mut audio: Vec<String> = Vec::new();
                let connect = loop {
                    let i = c.next().await.unwrap();
                    if i.opcode() == "connect" {
                        break i;
                    }
                    if i.opcode() == "audio" {
                        audio = i.args().map(str::to_string).collect();
                    }
                    if i.opcode() == "size" {
                        seen.lock().unwrap().handshake_size = i.args().map(str::to_string).collect();
                    }
                    opcodes.push(i.opcode().to_string());
                };
                seen.lock().unwrap().audio = audio.clone();
                assert_eq!(opcodes, ["size", "audio", "video", "image"], "handshake order");
                let values: Vec<String> = connect.args().map(str::to_string).collect();
                let pairs: Vec<(String, String)> = ARG_NAMES.iter().map(|n| n.to_string()).zip(values).collect();
                let host = pairs.iter().find(|(n, _)| n == "hostname").unwrap().1.clone();
                let port: u16 = pairs.iter().find(|(n, _)| n == "port").unwrap().1.parse().unwrap();
                // 登入名 `silent` = 扮演不轉送聲音的 RDP 伺服器（Windows 原則關掉、xrdp 沒裝聲音模組）。
                // Login `silent` plays an RDP server that does not redirect sound.
                let silent = pairs.iter().any(|(n, v)| n == "username" && v == "silent");
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
                // 有要聲音：開一個 L16 音訊串流、送一塊、結束（RDP 的 rdpsnd 經 guacd 就是這樣到瀏覽器）。
                // Sound asked for: one L16 audio stream, one blob, end (how rdpsnd reaches the browser through guacd).
                if !audio.is_empty() && !silent {
                    let mut out = encode(&["audio", "1", "audio/L16;rate=44100,channels=2"], Unit::CodePoints);
                    out.push_str(&encode(&["blob", "1", "AAAAAA=="], Unit::CodePoints));
                    out.push_str(&encode(&["end", "1"], Unit::CodePoints));
                    c.s.write_all(out.as_bytes()).await.unwrap();
                }
                while let Some(i) = c.next().await {
                    let op = i.opcode().to_string();
                    if op == "size" {
                        seen.lock().unwrap().sizes.push(i.args().map(str::to_string).collect());
                    }
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
    open_ws_sized(lab, start, 1024, 768).await
}

async fn open_ws_sized(lab: &Lab, start: &Value, width: u32, height: u32) -> Result<Ws, String> {
    let url = format!("{}{}?ticket={}&width={width}&height={height}", lab.ws_base().await, start["ws_path"].as_str().unwrap(), start["ticket"].as_str().unwrap());
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

    // 白名單：put / argv 被丟掉，key 轉給 guacd；VNC 預設不改遠端解析度，所以 size 也停在中繼（guacd 拿到
    // disable-display-resize）。/ Allowlist: put/argv dropped, key forwarded; a VNC session keeps the server's size
    // by default, so size stops at the relay too (and guacd got disable-display-resize).
    ws.send(Message::Text("3.put,1.0,10.text/plain;4.argv,1.1,10.text/plain,8.password;4.size,4.1024,3.768;3.key,5.65307,1.1;".into())).await.unwrap();
    wait_for("key at guacd", || seen.lock().unwrap().after_ready.contains(&"key".to_string())).await;
    assert!(!seen.lock().unwrap().after_ready.iter().any(|o| o == "put" || o == "argv" || o == "size"), "{:?}", seen.lock().unwrap().after_ready);
    assert_eq!(start["resize"], false);
    assert!(seen.lock().unwrap().connect.iter().any(|(k, v)| k == "disable-display-resize" && v == "true"));

    // 票證只能用一次。/ The ticket is single use.
    let mut again = open_ws(&lab, &start).await.unwrap();
    assert_eq!(recv(&mut again).await.err(), Some(4404));

    // presence + 開始事件。/ Presence and the open event.
    let present = app.state.presence.for_tunnel(id);
    assert!(present.iter().any(|e| e.kind.as_str() == "desktop" && e.username == "alice"), "{present:?}");
    let ev = events(&lab, &alice.token, id).await;
    assert!(ev.iter().any(|e| e["event"] == "desktop_open" && e["message"].as_str().unwrap().contains("Remote desktop (VNC) by alice to device:")), "{ev:?}");

    // 埠探測（RustDesk 這類不經 guacd 的桌面）：開著的埠 → reachable，關著的 → 502 target_unreachable；同一道門。
    // Port probe: an open port is reachable, a closed one answers 502; the gate is the same as start.
    let r = app.get(&format!("/api/reverse/server/{id}/desktop/probe?port={desktop}&username=ubuntu"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["reachable"], true);
    assert_eq!(r.json["target"]["port"], desktop);
    assert_eq!(r.json["username"], "ubuntu");
    let closed = free_port();
    let r = app.get(&format!("/api/reverse/server/{id}/desktop/probe?port={closed}"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::BAD_GATEWAY, "{}", r.text);
    assert_eq!(r.json["code"], "target_unreachable");
    assert_eq!(app.get(&format!("/api/reverse/server/{id}/desktop/probe?port={desktop}"), None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get(&format!("/api/reverse/server/{id}/desktop/probe?port=0"), Some(&alice.token)).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.get(&format!("/api/reverse/server/{id}/desktop/probe?port={desktop}&lan_host_id=999999"), Some(&alice.token)).await.status, StatusCode::NOT_FOUND);

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

/// 剪貼簿：每個人自己選方向（個人設定，或這次連線帶的值），站台設定是上限；guacd 拿到對應的 disable-copy / disable-paste。
/// Clipboard: each user's own direction (saved, or sent with the start) under the site's limit, enforced through guacd.
#[tokio::test]
async fn desktop_clipboard_is_the_users_choice_within_the_site_limit() {
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
    let start = |body: Value| {
        let token = alice.token.clone();
        async move { app.post(&format!("/api/reverse/server/{id}/desktop/start"), Some(&token), body).await }
    };
    // 開 WS 讓 guacd 握手，回 guacd 拿到的兩個剪貼簿參數。/ Open the socket and return guacd's two clipboard arguments.
    let guacd_clipboard = |start: Value| {
        let lab = &lab;
        let seen = seen.clone();
        async move {
            seen.lock().unwrap().connect.clear();
            let mut ws = open_ws(lab, &start).await.unwrap();
            assert!(recv(&mut ws).await.is_ok());
            wait_for("connect at guacd", || !seen.lock().unwrap().connect.is_empty()).await;
            let s = seen.lock().unwrap();
            let get = |n: &str| s.connect.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap_or_default();
            (get("disable-copy"), get("disable-paste"))
        }
    };

    // 個人設定：預設 both，上限跟著回來；壞值 400。/ The user setting: both by default, the limit alongside; bad values are 400s.
    let r = app.get("/api/user/settings", Some(&alice.token)).await;
    assert_eq!((r.json["desktop_clipboard"].as_str(), r.json["desktop_clipboard_limit"].as_str()), (Some("both"), Some("both")), "{}", r.text);
    for bad in [json!("sideways"), json!(1)] {
        let r = app.post("/api/user/settings", Some(&alice.token), json!({"desktop_clipboard": bad})).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad} → {}", r.text);
        assert!(r.json["desktop_clipboard"].is_array(), "{}", r.text);
    }
    let r = app.post("/api/user/settings", Some(&alice.token), json!({"desktop_clipboard": "off"})).await;
    assert_eq!((r.status, r.json["desktop_clipboard"].as_str()), (StatusCode::OK, Some("off")), "{}", r.text);

    // 沒帶 clipboard = 用個人設定（off）：兩個方向都關。/ No clipboard in the start = the saved choice (off).
    let r = start(json!({"protocol": "vnc", "username": "ubuntu", "port": desktop})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["clipboard"].as_str(), r.json["clipboard_limit"].as_str()), (Some("off"), Some("both")));
    assert_eq!(guacd_clipboard(r.json.clone()).await, ("true".into(), "true".into()));

    // 這次帶的值優先於個人設定。/ The value sent with the start wins over the saved one.
    let r = start(json!({"protocol": "vnc", "username": "ubuntu", "port": desktop, "clipboard": "both"})).await;
    assert_eq!(r.json["clipboard"], "both", "{}", r.text);
    assert_eq!(guacd_clipboard(r.json.clone()).await, (String::new(), String::new()));

    // 站台上限 to_remote：要 both 只拿到 to_remote，複製出來的方向由 guacd 關掉。
    // A to_remote site limit: asking for both gets to_remote, and guacd blocks copying out.
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"desktop_clipboard": "to_remote"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/user/settings", Some(&alice.token)).await.json["desktop_clipboard_limit"], "to_remote");
    let r = start(json!({"protocol": "vnc", "username": "ubuntu", "port": desktop, "clipboard": "both"})).await;
    assert_eq!((r.json["clipboard"].as_str(), r.json["clipboard_limit"].as_str()), (Some("to_remote"), Some("to_remote")), "{}", r.text);
    assert_eq!(guacd_clipboard(r.json.clone()).await, ("true".into(), String::new()));

    // 壞的 clipboard → 欄位錯誤，不開通道。/ A bad clipboard value is a field error.
    for bad in [json!("sideways"), json!(true)] {
        let r = start(json!({"protocol": "vnc", "username": "ubuntu", "port": desktop, "clipboard": bad})).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad} → {}", r.text);
        assert!(r.json["clipboard"].is_array(), "{}", r.text);
    }
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

/// RDP 的聲音：開了 → 握手給 audio/L8 + audio/L16、不帶 disable-audio，guacd 的音訊串流（audio / blob / end）
/// 原樣到瀏覽器，瀏覽器的 ack 回到 guacd，但瀏覽器自己送的 audio（麥克風）被擋。沒開 → disable-audio、握手不給格式；
/// VNC 帶 audio 也當沒開。
/// RDP sound: offered in the handshake when asked, the audio stream reaches the browser, the browser's ack reaches
/// guacd and a browser `audio` (a microphone) is dropped. Off = `disable-audio`; VNC never has sound.
#[tokio::test]
async fn desktop_rdp_sound_is_offered_and_relayed() {
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
    let token = alice.token.clone();
    let start = |body: Value| {
        let token = token.clone();
        async move { app.post(&format!("/api/reverse/server/{id}/desktop/start"), Some(&token), body).await }
    };

    let r = start(json!({"protocol": "rdp", "username": "ubuntu", "port": desktop, "login": "a", "password": "b", "audio": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["audio"], true);
    let mut ws = open_ws(&lab, &r.json).await.unwrap();
    let mut got = String::new();
    while !got.contains("3.end,1.1;") {
        got.push_str(&recv(&mut ws).await.expect("the audio stream"));
    }
    assert!(got.contains("5.audio,1.1,31.audio/L16;rate=44100,channels=2;") && got.contains("4.blob,1.1,8.AAAAAA==;"), "{got}");
    {
        let s = seen.lock().unwrap();
        assert_eq!(s.audio, ["audio/L8", "audio/L16"]);
        assert_eq!(s.connect.iter().find(|(k, _)| k == "disable-audio").map(|(_, v)| v.as_str()), Some(""), "sound on = no disable-audio");
    }
    // 瀏覽器回 ack（接受串流）→ 到 guacd；瀏覽器送 audio（麥克風）→ 擋下。/ The ack passes, a microphone stream does not.
    ws.send(Message::Text("3.ack,1.1,2.OK,1.0;5.audio,1.2,9.audio/L16;4.blob,1.2,4.AAAA;3.key,5.65307,1.1;".into())).await.unwrap();
    wait_for("ack and key at guacd", || {
        let s = seen.lock().unwrap();
        s.after_ready.contains(&"ack".to_string()) && s.after_ready.contains(&"key".to_string())
    })
    .await;
    assert!(!seen.lock().unwrap().after_ready.iter().any(|o| o == "audio"), "{:?}", seen.lock().unwrap().after_ready);
    let ev = events(&lab, &alice.token, id).await;
    assert!(ev.iter().any(|e| e["event"] == "desktop_open" && e["message"].as_str().unwrap().contains("Remote desktop (RDP, sound) by alice")), "{ev:?}");
    drop(ws);
    // 結束那句帶聲音的量（中繼數 guacd 聲音串流上的 blob）。/ The close line carries the sound byte count.
    let closed = |needle: &'static str| {
        let lab = &lab;
        let token = alice.token.clone();
        async move {
            for _ in 0..50 {
                let ev = events(lab, &token, id).await;
                if let Some(m) = ev.iter().filter(|e| e["event"] == "desktop_close").filter_map(|e| e["message"].as_str()).find(|m| m.contains(needle)) {
                    return m.to_string();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("no desktop_close containing {needle:?}: {:?}", events(lab, &token, id).await);
        }
    };
    let m = closed(", sound 8 B").await;
    assert!(!m.contains("no sound channel"), "{m}");

    // 要了聲音、RDP 伺服器卻沒開聲音通道：日誌講清楚。/ Sound asked for but the server opened no sound channel.
    let r = start(json!({"protocol": "rdp", "username": "ubuntu", "port": desktop, "login": "silent", "password": "b", "audio": true})).await;
    assert_eq!(r.json["audio"], true);
    let mut ws = open_ws(&lab, &r.json).await.unwrap();
    assert!(recv(&mut ws).await.is_ok());
    wait_for("the silent server's handshake", || seen.lock().unwrap().connect.iter().any(|(k, v)| k == "username" && v == "silent")).await;
    drop(ws);
    closed("no sound channel from the RDP server").await;

    // 沒開聲音（預設）→ disable-audio、握手不給格式。/ Sound off (the default): disable-audio, no formats.
    let r = start(json!({"protocol": "rdp", "username": "ubuntu", "port": desktop, "login": "a", "password": "b"})).await;
    assert_eq!(r.json["audio"], false);
    let mut ws = open_ws(&lab, &r.json).await.unwrap();
    assert!(recv(&mut ws).await.is_ok());
    wait_for("the second handshake", || seen.lock().unwrap().connect.iter().any(|(k, v)| k == "disable-audio" && v == "true")).await;
    assert!(seen.lock().unwrap().audio.is_empty());
    drop(ws);

    // VNC 沒有聲音：帶 true 也回 false；型別錯 → 400。/ VNC never has sound; a non-boolean is a field error.
    let r = start(json!({"protocol": "vnc", "username": "ubuntu", "port": desktop, "audio": true})).await;
    assert_eq!(r.json["audio"], false, "{}", r.text);
    let r = start(json!({"protocol": "rdp", "username": "ubuntu", "port": desktop, "audio": "loud"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.json["audio"][0].is_string(), "{}", r.text);
}

/// 失去權限（允許帳號被拿掉）：連線中的桌面馬上以 4009 結束（原因 = 存取變了），`desktop_close` 說為什麼。
/// Losing access (the hop account removed): a connected desktop ends at once with 4009, and `desktop_close` says why.
#[tokio::test]
async fn desktop_ends_when_access_is_lost() {
    let (guacd, _seen) = fake_guacd().await;
    let Some(mut lab) = Lab::start().await else { return };
    lab.reconfigure(|c| {
        c.guacd_addr = guacd.clone();
        c.desktop_callback_host = "127.0.0.1".into();
    });
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "pc", &pc).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let desktop = echo_service().await;
    let id = dev.tunnel_id;

    let r = app.post(&format!("/api/reverse/server/{id}/desktop/start"), Some(&bob.token), json!({"protocol": "vnc", "username": "ubuntu", "port": desktop, "password": "x"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let mut ws = open_ws(&lab, &r.json).await.unwrap();
    assert!(recv(&mut ws).await.is_ok(), "the tunnel UUID");
    wait_for("desktop presence", || app.state.presence.for_tunnel(id).iter().any(|e| e.kind.as_str() == "desktop")).await;
    let started = std::time::Instant::now();
    let r = app.patch(&format!("/tunnels/share/{id}/{}/allowed-usernames", bob.id), Some(&alice.token), json!({"allowed_target_username_ids": []})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let reason = loop {
        match tokio::time::timeout(Duration::from_secs(15), ws.next()).await.expect("the desktop socket stayed open") {
            Some(Ok(Message::Close(Some(f)))) => break (u16::from(f.code), f.reason.to_string()),
            Some(Ok(_)) => continue,
            other => panic!("unexpected {other:?}"),
        }
    };
    assert_eq!(reason, (4009, telepy_server::access_recheck::ENDED_BY.to_string()));
    assert!(started.elapsed() < Duration::from_secs(5), "ended right after the change, not by a later sweep");
    wait_for("presence cleared", || app.state.presence.for_tunnel(id).iter().all(|e| e.kind.as_str() != "desktop")).await;
    let mut found = None;
    for _ in 0..50 {
        found = events(&lab, &alice.token, id).await.into_iter().find(|e| e["event"] == "desktop_close");
        if found.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let msg = found.expect("desktop_close")["message"].as_str().unwrap().to_string();
    assert!(msg.contains("(ended,") && msg.contains("the login account is no longer allowed"), "{msg}");
}

/// 解析度：RDP 預設跟著瀏覽器的框（resize-method display-update），站台上限等比夾住握手的大小與之後的每個
/// `size`；固定解析度的 RDP 不帶 resize-method、`size` 停在中繼；VNC 要求跟著時不帶 disable-display-resize。
/// Resolution: RDP follows the frame by default, the site ceiling scales the handshake and every later `size`
/// keeping the shape; a fixed RDP size drops `size` at the relay; a VNC session asked to follow omits disable-display-resize.
#[tokio::test]
async fn desktop_resolution_follows_the_window_within_the_site_limit() {
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
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"desktop_max_resolution": 1600})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let token = alice.token.clone();
    let start = |body: Value| {
        let token = token.clone();
        async move { app.post(&format!("/api/reverse/server/{id}/desktop/start"), Some(&token), body).await }
    };
    let get = |n: &str| seen.lock().unwrap().connect.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());

    // RDP、跟著視窗（預設）：2880×1800 的框（HiDPI）→ 等比夾成 1600×1000。/ RDP following the window (the default).
    let r = start(json!({"protocol": "rdp", "username": "ubuntu", "port": desktop, "login": "a", "password": "b"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["resize"], true);
    assert_eq!(r.json["max_resolution"], 1600);
    let mut ws = open_ws_sized(&lab, &r.json, 2880, 1800).await.unwrap();
    recv(&mut ws).await.unwrap();
    wait_for("the RDP handshake", || get("resize-method").is_some()).await;
    assert_eq!(get("resize-method").as_deref(), Some("display-update"));
    assert_eq!((get("width").as_deref(), get("height").as_deref()), (Some("1600"), Some("1000")));
    assert_eq!(seen.lock().unwrap().handshake_size[..2], ["1600".to_string(), "1000".to_string()]);
    // 視窗變大：瀏覽器送 3840×2160，guacd 拿到 1600×900；變小的 1280×720 原樣過。
    // The window grows: 3840×2160 reaches guacd as 1600×900; a smaller 1280×720 passes unchanged.
    ws.send(Message::Text("4.size,4.3840,4.2160;4.size,4.1280,3.720;".into())).await.unwrap();
    wait_for("both sizes at guacd", || seen.lock().unwrap().sizes.len() >= 2).await;
    assert_eq!(seen.lock().unwrap().sizes[..2], [vec!["1600".to_string(), "900".to_string()], vec!["1280".to_string(), "720".to_string()]]);
    drop(ws);
    wait_for("the session to end", || app.state.desktop.count() == 0).await;
    seen.lock().unwrap().sizes.clear();
    seen.lock().unwrap().connect.clear();

    // RDP、固定解析度：不帶 resize-method，`size` 停在中繼。/ A fixed RDP size: no resize-method, `size` dropped.
    let r = start(json!({"protocol": "rdp", "username": "ubuntu", "port": desktop, "login": "a", "password": "b", "resize": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["resize"], false);
    let mut ws = open_ws_sized(&lab, &r.json, 1280, 720).await.unwrap();
    recv(&mut ws).await.unwrap();
    wait_for("the fixed handshake", || get("width").is_some()).await;
    assert_eq!(get("resize-method").as_deref(), Some(""), "guacd sees no resize method");
    assert_eq!((get("width").as_deref(), get("height").as_deref()), (Some("1280"), Some("720")));
    ws.send(Message::Text("4.size,4.1920,4.1080;3.key,5.65307,1.1;".into())).await.unwrap();
    wait_for("key at guacd", || seen.lock().unwrap().after_ready.iter().filter(|o| *o == "key").count() >= 1).await;
    assert!(seen.lock().unwrap().sizes.is_empty(), "{:?}", seen.lock().unwrap().sizes);
    let ev = events(&lab, &alice.token, id).await;
    assert!(ev.iter().any(|e| e["event"] == "desktop_open" && e["message"].as_str().unwrap().contains("(RDP, fixed size)")), "{ev:?}");
    drop(ws);
    wait_for("the session to end", || app.state.desktop.count() == 0).await;
    seen.lock().unwrap().connect.clear();

    // VNC、要求跟著視窗：guacd 不帶 disable-display-resize，`size` 夾過後轉送。/ VNC asked to follow the window.
    let r = start(json!({"protocol": "vnc", "username": "ubuntu", "port": desktop, "password": "b", "resize": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["resize"], true);
    let mut ws = open_ws_sized(&lab, &r.json, 1024, 768).await.unwrap();
    recv(&mut ws).await.unwrap();
    wait_for("the VNC handshake", || get("disable-display-resize").is_some()).await;
    assert_eq!(get("disable-display-resize").as_deref(), Some(""));
    ws.send(Message::Text("4.size,4.2400,4.1200;".into())).await.unwrap();
    wait_for("the VNC size at guacd", || !seen.lock().unwrap().sizes.is_empty()).await;
    assert_eq!(seen.lock().unwrap().sizes[0], ["1600".to_string(), "800".to_string()]);

    // 壞的值：400。/ A bad value is a field error.
    let r = start(json!({"protocol": "rdp", "username": "ubuntu", "port": desktop, "resize": "yes"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
}
