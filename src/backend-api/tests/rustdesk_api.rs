//! 網頁內 RustDesk 的中繼，在 SSH lab 上端到端：假的 RustDesk 裝置（講 BytesCodec 框的 TCP 服務）在裝置後面，
//! 瀏覽器端用兩條 WS 模擬核心的連線流程（hbbs 角色 → relay 角色），訊息要原樣穿過並重新分框。
//! The in-browser RustDesk relay end to end: a fake RustDesk device behind the lab device, two WebSockets
//! playing the core's hbbs-then-relay flow, frames re-framed both ways.

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

use common::lab::{free_port, Lab};
use telepy_server::rustdesk::codec::{decode_frame, encode_frame, file_action_message, file_op, file_reply, file_reply_message, login_request, peer_message, rendezvous_with_id, top_field, FileOp, FileReply, MSG_AUDIO_FRAME, MSG_FILE_ACTION, MSG_FILE_RESPONSE, PUNCH_HOLE_REQUEST, RELAY_RESPONSE, REQUEST_RELAY};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 假 RustDesk 裝置：一連上就送一則「hash」風格的框，之後每收到一則框就回 `echo:` + 原文。
/// A fake RustDesk device: greets with one frame, then echoes every frame with an `echo:` prefix.
async fn fake_rustdesk_device() -> (u16, Arc<Mutex<Vec<Vec<u8>>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let received = Arc::new(Mutex::new(Vec::new()));
    let seen = received.clone();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                s.write_all(&encode_frame(b"\x4a\x05\x0a\x03abc")).await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let n = match s.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&chunk[..n]);
                    while let Ok(Some((payload, used))) = decode_frame(&buf) {
                        let payload = payload.to_vec();
                        buf.drain(..used);
                        seen.lock().unwrap().push(payload.clone());
                        let reply = device_reply(&payload);
                        if s.write_all(&encode_frame(&reply)).await.is_err() {
                            return;
                        }
                    }
                }
            });
        }
    });
    (port, received)
}

/// 假裝置的回答：檔案動作照 RustDesk 的樣子回 done / error（路徑含 `denied` = 沒權限；遞迴列出回一個 dir），
/// 其他訊息回 `echo:` + 原文。/ The fake device's answer: file actions get done / error like RustDesk, the rest an echo.
fn device_reply(payload: &[u8]) -> Vec<u8> {
    match file_op(payload) {
        Some(FileOp::AllFiles { .. }) => peer_message(MSG_FILE_RESPONSE, &peer_message(1, b"dir")),
        Some(FileOp::RemoveFile { id, path } | FileOp::RemoveDir { id, path, .. } | FileOp::Rename { id, path, .. } | FileOp::Create { id, path }) => {
            if path.contains("denied") {
                file_reply_message(&FileReply::Error { id, error: "Permission denied (os error 13)".into() })
            } else {
                file_reply_message(&FileReply::Done { id })
            }
        }
        _ => {
            let mut reply = b"echo:".to_vec();
            reply.extend_from_slice(payload);
            reply
        }
    }
}

async fn open_ws(lab: &Lab, start: &Value) -> Ws {
    let url = format!("{}{}?ticket={}", lab.ws_base().await, start["ws_path"].as_str().unwrap(), start["ticket"].as_str().unwrap());
    let req = url.into_client_request().unwrap();
    let (ws, _) = connect_async(req).await.expect("rustdesk socket");
    ws
}

/// 下一則 binary，或關閉碼。/ The next binary message, or the close code.
async fn recv(ws: &mut Ws) -> Result<Vec<u8>, u16> {
    loop {
        match tokio::time::timeout(Duration::from_secs(15), ws.next()).await.expect("no frame from the rustdesk socket") {
            Some(Ok(Message::Binary(b))) => return Ok(b.to_vec()),
            Some(Ok(Message::Close(Some(f)))) => return Err(u16::from(f.code)),
            Some(Ok(Message::Close(None))) | None => return Err(1000),
            Some(Ok(_)) => continue,
            Some(Err(e)) => panic!("rustdesk socket error: {e}"),
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
async fn rustdesk_session_is_bridged_through_the_device() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let (rd_port, received) = fake_rustdesk_device().await;
    let id = dev.tunnel_id;

    let r = app.post(&format!("/api/reverse/server/{id}/rustdesk/start"), Some(&alice.token), json!({"username": "ubuntu", "port": rd_port})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let start = r.json.clone();
    assert_eq!(start["target"]["port"], rd_port);
    assert_eq!(start["username"], "ubuntu");
    // 剪貼簿方向由瀏覽器裡的核心套用：預設 = 個人設定（both），上限 = 站台設定。
    // The browser's core applies the clipboard direction: the user's setting (both) under the site's limit.
    assert_eq!((start["clipboard"].as_str(), start["clipboard_limit"].as_str()), (Some("both"), Some("both")));
    assert!(start["ws_path"].as_str().unwrap().starts_with("/ws/rustdesk/"));
    let sid = start["session_id"].as_str().unwrap().to_string();

    // 角色一：假 hbbs。/ Role one: the fake hbbs.
    let mut id_ws = open_ws(&lab, &start).await;
    id_ws.send(Message::Binary(rendezvous_with_id(PUNCH_HOLE_REQUEST, "telepy").into())).await.unwrap();
    let reply = recv(&mut id_ws).await.unwrap();
    assert_eq!(top_field(&reply), Some(RELAY_RESPONSE));
    assert!(String::from_utf8_lossy(&reply).contains(&format!("/ws/rustdesk/{sid}/")), "relay_response points back at the session");

    // 角色二：relay → 第一則吃掉，之後是裝置的框。/ Role two: the relay; the device's greeting comes through.
    let mut relay = open_ws(&lab, &start).await;
    relay.send(Message::Binary(rendezvous_with_id(REQUEST_RELAY, "telepy").into())).await.unwrap();
    assert_eq!(recv(&mut relay).await.unwrap(), b"\x4a\x05\x0a\x03abc".to_vec(), "the device's first frame arrives re-framed as one message");
    // 瀏覽器 → 裝置 → 回音；大訊息也要原樣（2 bytes 與 3 bytes 的前綴）。/ Browser → device → echo, large messages included.
    for payload in [b"hello".to_vec(), vec![7u8; 5000], vec![9u8; 70_000]] {
        relay.send(Message::Binary(payload.clone().into())).await.unwrap();
        let echoed = recv(&mut relay).await.unwrap();
        assert_eq!(&echoed[..5], b"echo:");
        assert_eq!(&echoed[5..], &payload[..]);
    }
    assert_eq!(received.lock().unwrap().len(), 3);
    assert!(received.lock().unwrap().iter().all(|m| top_field(m) != Some(REQUEST_RELAY)), "request_relay never reaches the device");

    // 票證的角色各一次：第三條連線（再當 relay）被拒。/ Each role once: a third socket is refused.
    let mut again = open_ws(&lab, &start).await;
    again.send(Message::Binary(rendezvous_with_id(REQUEST_RELAY, "telepy").into())).await.unwrap();
    assert_eq!(recv(&mut again).await.err(), Some(4404));
    // 第一則不是 rendezvous 訊息 → 4400。/ A first message that is not a rendezvous request: 4400.
    let r2 = app.post(&format!("/api/reverse/server/{id}/rustdesk/start"), Some(&alice.token), json!({"username": "ubuntu", "port": rd_port})).await;
    assert_eq!(r2.status, StatusCode::OK, "{}", r2.text);
    let mut bad = open_ws(&lab, &r2.json).await;
    bad.send(Message::Binary(vec![0xFF, 0xFF, 0xFF].into())).await.unwrap();
    assert_eq!(recv(&mut bad).await.err(), Some(4400));

    // presence + 開始事件。/ Presence and the open event.
    let present = app.state.presence.for_tunnel(id);
    assert!(present.iter().any(|e| e.kind.as_str() == "rustdesk" && e.username == "alice"), "{present:?}");
    let ev = events(&lab, &alice.token, id).await;
    assert!(ev.iter().any(|e| e["event"] == "rustdesk_open" && e["message"].as_str().unwrap().contains("RustDesk in the browser by alice to device:")), "{ev:?}");

    // 別人不能停；自己可以 → 4014 + 結束事件含流量。/ Others can't stop it; the owner can.
    let bob = lab.user("bob").await;
    assert_eq!(app.post(&format!("/api/reverse/server/rustdesk/{sid}/stop"), Some(&bob.token), json!({})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.post(&format!("/api/reverse/server/rustdesk/{sid}/stop"), Some(&alice.token), json!({})).await.status, StatusCode::OK);
    assert_eq!(recv(&mut relay).await.err(), Some(4014));
    wait_for("session removed", || app.state.rustdesk.get(&sid).is_none()).await;
    let ev = events(&lab, &alice.token, id).await;
    let close = ev.iter().find(|e| e["event"] == "rustdesk_close" && e["message"].as_str().unwrap_or("").contains(&sid[..8])).expect("close event");
    let msg = close["message"].as_str().unwrap();
    assert!(msg.contains("closed after") && msg.contains("(stopped,") && msg.contains("to the browser") && msg.contains("to the device"), "{msg}");
    wait_for("presence cleared", || app.state.presence.for_tunnel(id).iter().all(|e| e.kind.as_str() != "rustdesk")).await;
}

#[tokio::test]
async fn rustdesk_refusals() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    let start = |token: String, body: Value| async move { app.post(&format!("/api/reverse/server/{id}/rustdesk/start"), Some(&token), body).await };

    // 沒分享給 bob → 403；不在允許清單的帳號 → 403。/ Not shared with bob; account not allowed.
    assert_eq!(start(bob.token.clone(), json!({"username": "ubuntu"})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(start(alice.token.clone(), json!({"username": "root"})).await.status, StatusCode::FORBIDDEN);
    // 目標沒開 → 502 target_unreachable。/ A closed port: 502.
    let closed = free_port();
    let r = start(alice.token.clone(), json!({"username": "ubuntu", "port": closed})).await;
    assert_eq!(r.status, StatusCode::BAD_GATEWAY, "{}", r.text);
    assert_eq!(r.json["code"], "target_unreachable");
    // 預設埠 21118。/ The default port.
    let r = start(alice.token.clone(), json!({"username": "ubuntu", "port": "x"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    // 沒有票證 / 假票證 → 4404。/ No or wrong ticket: 4404.
    let (rd_port, _) = fake_rustdesk_device().await;
    let r = start(alice.token.clone(), json!({"username": "ubuntu", "port": rd_port})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let mut forged = r.json.clone();
    forged["ticket"] = json!("not-the-ticket");
    let mut ws = open_ws(&lab, &forged).await;
    ws.send(Message::Binary(rendezvous_with_id(PUNCH_HOLE_REQUEST, "telepy").into())).await.unwrap();
    assert_eq!(recv(&mut ws).await.err(), Some(4404));
    // 停掉還沒認領的 session → 直接移除。/ Stopping an unclaimed session drops it.
    let sid = r.json["session_id"].as_str().unwrap();
    assert_eq!(app.post(&format!("/api/reverse/server/rustdesk/{sid}/stop"), Some(&alice.token), json!({})).await.status, StatusCode::OK);
    assert!(app.state.rustdesk.get(sid).is_none());
    assert_eq!(app.post(&format!("/api/reverse/server/rustdesk/{sid}/stop"), Some(&alice.token), json!({})).await.status, StatusCode::NOT_FOUND);
}

/// 憑證庫的 RustDesk 密碼：start 帶 `credential_id` 就把密碼解開放進回應（瀏覽器裡的核心要用），綁錯目標或協定就拒絕。
/// A saved RustDesk password comes back unsealed from the start (the browser's core needs it); a wrong target is refused.
#[tokio::test]
async fn rustdesk_start_with_a_saved_password() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let (rd_port, _) = fake_rustdesk_device().await;
    let id = dev.tunnel_id;

    let r = app.post("/api/credentials", Some(&alice.token), json!({"label": "office box", "protocol": "rustdesk", "tunnel_id": id, "password": "rd-secret", "port": rd_port})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let saved = r.json["id"].as_i64().unwrap();
    let r = app.post("/api/credentials", Some(&alice.token), json!({"label": "vnc", "protocol": "vnc", "tunnel_id": id, "password": "v"})).await;
    let vnc = r.json["id"].as_i64().unwrap();

    let r = app.post(&format!("/api/reverse/server/{id}/rustdesk/start"), Some(&alice.token), json!({"username": "ubuntu", "port": rd_port, "credential_id": saved})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["password"], "rd-secret", "the saved password is handed to the browser");
    let sid = r.json["session_id"].as_str().unwrap().to_string();
    assert!(app.state.rustdesk.get(&sid).unwrap().describe().contains("with saved login 'office box'"));
    let r = app.get("/api/credentials", Some(&alice.token)).await;
    assert!(r.json.as_array().unwrap().iter().any(|c| c["id"] == saved && !c["last_used_at"].is_null()), "{}", r.text);

    // 沒帶 credential_id 就沒有 password 欄位。/ Without credential_id there is no password field.
    let r = app.post(&format!("/api/reverse/server/{id}/rustdesk/start"), Some(&alice.token), json!({"username": "ubuntu", "port": rd_port})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json.get("password").is_none());
    // 別的協定 / 不存在的那筆 → credential_id 欄位錯誤。/ Another protocol or an unknown row: field error.
    for cid in [vnc, 999_999] {
        let r = app.post(&format!("/api/reverse/server/{id}/rustdesk/start"), Some(&alice.token), json!({"username": "ubuntu", "port": rd_port, "credential_id": cid})).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
        assert!(r.json["credential_id"][0].is_string(), "{}", r.text);
    }
}

/// 走一遍核心的兩個角色（hbbs → relay），回 relay 那條（已收掉裝置的第一則框）。/ Play both roles; returns the relay socket.
async fn connect_core(lab: &Lab, start: &Value) -> Ws {
    let mut id_ws = open_ws(lab, start).await;
    id_ws.send(Message::Binary(rendezvous_with_id(PUNCH_HOLE_REQUEST, "telepy").into())).await.unwrap();
    assert_eq!(top_field(&recv(&mut id_ws).await.unwrap()), Some(RELAY_RESPONSE));
    let mut relay = open_ws(lab, start).await;
    relay.send(Message::Binary(rendezvous_with_id(REQUEST_RELAY, "telepy").into())).await.unwrap();
    assert_eq!(recv(&mut relay).await.unwrap(), b"\x4a\x05\x0a\x03abc".to_vec());
    relay
}

/// 送一則、等裝置回音。/ Send one message and wait for the device's echo.
async fn round_trip(relay: &mut Ws, msg: Vec<u8>) {
    relay.send(Message::Binary(msg.clone().into())).await.unwrap();
    let echoed = recv(relay).await.expect("echo");
    assert_eq!(&echoed[5..], &msg[..]);
}

/// 「檔案」面板：畫面 session 連上後開一個傳檔子 session；中繼只准它登入成傳檔、畫面那條只准遙控；
/// 檔案、聲音訊息原樣穿過；子 session 不佔名額、不算 presence，畫面那條結束就跟著結束；站台關掉就不能開。
/// The Files panel's child session: the relay admits only a file-transfer login on it and only remote control on
/// the screen session; file and audio messages pass; it takes no slot or presence and ends with its parent.
#[tokio::test]
async fn rustdesk_files_session_and_login_guard() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let (rd_port, received) = fake_rustdesk_device().await;
    let id = dev.tunnel_id;
    let start = || async { app.post(&format!("/api/reverse/server/{id}/rustdesk/start"), Some(&alice.token), json!({"username": "ubuntu", "port": rd_port})).await };

    let r = start().await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["file_transfer"], true, "the site allows file transfer by default");
    let screen = r.json.clone();
    let sid = screen["session_id"].as_str().unwrap().to_string();
    // 還沒連上 → 409 not_connected。/ Not connected yet.
    let r = app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&alice.token), json!({})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::CONFLICT, Some("not_connected")), "{}", r.text);

    let mut relay = connect_core(&lab, &screen).await;
    round_trip(&mut relay, Vec::new()).await;
    round_trip(&mut relay, login_request(None)).await;
    // 裝置 → 瀏覽器的聲音（audio_frame）照樣到。/ The device's sound reaches the browser.
    round_trip(&mut relay, peer_message(MSG_AUDIO_FRAME, b"opus-bytes")).await;

    // 別人不能開它的檔案 session；不存在的 → 404。/ Someone else can't; an unknown session is a 404.
    assert_eq!(app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&bob.token), json!({})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.post("/api/reverse/server/rustdesk/nope/files", Some(&alice.token), json!({})).await.status, StatusCode::NOT_FOUND);

    let r = app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["parent"], sid.as_str());
    assert_eq!(r.json["target"]["port"], rd_port);
    let files = r.json.clone();
    let fid = files["session_id"].as_str().unwrap().to_string();
    assert_eq!(app.state.rustdesk.count(), 1, "a files session takes no slot");
    let mut frelay = connect_core(&lab, &files).await;
    round_trip(&mut frelay, login_request(Some(7))).await;
    round_trip(&mut frelay, peer_message(MSG_FILE_ACTION, b"read_dir /home")).await;
    assert!(received.lock().unwrap().iter().any(|m| top_field(m) == Some(MSG_FILE_ACTION)));
    let present = app.state.presence.for_tunnel(id);
    assert_eq!(present.iter().filter(|e| e.kind.as_str() == "rustdesk").count(), 1, "{present:?}");
    let ev = events(&lab, &alice.token, id).await;
    assert!(ev.iter().any(|e| e["event"] == "rustdesk_open" && e["message"].as_str().unwrap().contains("RustDesk file transfer by alice")), "{ev:?}");

    // 最多兩個：第二個可以和第一個並存，第三個收掉最舊的（4014）。/ Two may overlap; a third ends the oldest.
    let r = app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    round_trip(&mut frelay, peer_message(MSG_FILE_ACTION, b"still mine")).await;
    let unused = r.json["session_id"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(recv(&mut frelay).await.err(), Some(4014));
    assert!(app.state.rustdesk.get(&unused).is_some(), "the newer unclaimed one stays");
    wait_for("old files session removed", || app.state.rustdesk.get(&fid).is_none()).await;
    // 新的那條登入成遙控 → 4403，結束事件寫原因。/ The new one logging in as remote control is refused.
    let files2 = r.json.clone();
    let fid2 = files2["session_id"].as_str().unwrap().to_string();
    let mut frelay2 = connect_core(&lab, &files2).await;
    frelay2.send(Message::Binary(login_request(None).into())).await.unwrap();
    assert_eq!(recv(&mut frelay2).await.err(), Some(4403));
    wait_for("refused files session removed", || app.state.rustdesk.get(&fid2).is_none()).await;
    let ev = events(&lab, &alice.token, id).await;
    assert!(ev.iter().any(|e| e["event"] == "rustdesk_close" && e["message"].as_str().unwrap_or("").contains("refused: a remote control login on a file transfer session")), "{ev:?}");

    // 畫面那條結束 → 它的檔案 session 也結束。/ The screen session ending ends its files session.
    let r = app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&alice.token), json!({})).await;
    let files3 = r.json.clone();
    let mut frelay3 = connect_core(&lab, &files3).await;
    round_trip(&mut frelay3, login_request(Some(7))).await;
    assert_eq!(app.post(&format!("/api/reverse/server/rustdesk/{sid}/stop"), Some(&alice.token), json!({})).await.status, StatusCode::OK);
    assert_eq!(recv(&mut relay).await.err(), Some(4014));
    assert_eq!(recv(&mut frelay3).await.err(), Some(4014));

    // 畫面 session 登入成傳檔 → 4403（改過的前端不能繞過站台設定）。/ A file-transfer login on a screen session.
    let r = start().await;
    let mut sneaky = connect_core(&lab, &r.json).await;
    sneaky.send(Message::Binary(login_request(Some(7)).into())).await.unwrap();
    assert_eq!(recv(&mut sneaky).await.err(), Some(4403));

    // 站台關掉傳檔 → start 回 false、files 503；已開的檔案 session 被收掉。/ The site switch.
    let r = start().await;
    let screen = r.json.clone();
    let sid = screen["session_id"].as_str().unwrap().to_string();
    let mut relay = connect_core(&lab, &screen).await;
    round_trip(&mut relay, login_request(None)).await;
    let r = app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&alice.token), json!({})).await;
    let mut frelay4 = connect_core(&lab, &r.json).await;
    round_trip(&mut frelay4, login_request(Some(7))).await;
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"desktop_file_transfer": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(start().await.json["file_transfer"], false);
    let r = app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&alice.token), json!({})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("file_transfer_disabled")), "{}", r.text);
    assert_eq!(app.state.rustdesk.end_all_files(), 1);
    assert_eq!(recv(&mut frelay4).await.err(), Some(4014));
    // 畫面那條不受影響。/ The screen session carries on.
    round_trip(&mut relay, peer_message(MSG_AUDIO_FRAME, b"still here")).await;
}

/// 「檔案」面板的刪除 / 改名：動作原樣穿過中繼到裝置，裝置回答後 tunnel 的 Logs 各寫一筆
/// （刪資料夾 = 列出 + 每個檔案 + 資料夾那步，合成一筆）；畫面 session 上的檔案動作被拒（4403）。
/// Deletions and renames from the Files panel pass through and are written to the tunnel's Logs once the device
/// answers (a folder delete is one event); a file action on the screen session is refused.
#[tokio::test]
async fn rustdesk_file_operations_are_relayed_and_audited() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let (rd_port, received) = fake_rustdesk_device().await;
    let id = dev.tunnel_id;

    let r = app.post(&format!("/api/reverse/server/{id}/rustdesk/start"), Some(&alice.token), json!({"username": "ubuntu", "port": rd_port})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let screen = r.json.clone();
    let sid = screen["session_id"].as_str().unwrap().to_string();
    let mut relay = connect_core(&lab, &screen).await;
    round_trip(&mut relay, login_request(None)).await;
    let r = app.post(&format!("/api/reverse/server/rustdesk/{sid}/files"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let files = r.json.clone();
    let fid = files["session_id"].as_str().unwrap().to_string();
    let mut frelay = connect_core(&lab, &files).await;
    round_trip(&mut frelay, login_request(Some(7))).await;

    // 送一個動作、收裝置的回答。/ Send one action, read the device's answer.
    async fn act(ws: &mut Ws, op: FileOp) -> Option<FileReply> {
        ws.send(Message::Binary(file_action_message(&op).into())).await.unwrap();
        file_reply(&recv(ws).await.expect("an answer"))
    }
    // 刪資料夾：列出 → 兩個檔案 → 資料夾。/ A folder delete: listing, two files, the folder.
    assert_eq!(act(&mut frelay, FileOp::AllFiles { id: 4, path: "/home/ubuntu/photos".into() }).await, Some(FileReply::Other));
    for f in ["a.jpg", "b.jpg"] {
        assert_eq!(act(&mut frelay, FileOp::RemoveFile { id: 4, path: format!("/home/ubuntu/photos/{f}") }).await, Some(FileReply::Done { id: 4 }));
    }
    assert_eq!(act(&mut frelay, FileOp::RemoveDir { id: 4, path: "/home/ubuntu/photos".into(), recursive: true }).await, Some(FileReply::Done { id: 4 }));
    // 改名（也可以是搬移）、建資料夾、沒權限的刪除。/ A rename (or move), a new folder, a refused delete.
    assert_eq!(act(&mut frelay, FileOp::Rename { id: 5, path: "/home/ubuntu/notes.txt".into(), new_name: "../shared/notes.txt".into() }).await, Some(FileReply::Done { id: 5 }));
    assert_eq!(act(&mut frelay, FileOp::Create { id: 6, path: "/home/ubuntu/new".into() }).await, Some(FileReply::Done { id: 6 }));
    assert!(matches!(act(&mut frelay, FileOp::RemoveFile { id: 7, path: "/root/denied.txt".into() }).await, Some(FileReply::Error { id: 7, .. })));
    // 每個動作都原樣到了裝置。/ Every action reached the device unchanged.
    let seen: Vec<FileOp> = received.lock().unwrap().iter().filter_map(|m| file_op(m)).collect();
    assert_eq!(seen.len(), 7, "{seen:?}");

    let short = &fid[..8];
    let ev = events(&lab, &alice.token, id).await;
    let of = |kind: &str| ev.iter().filter(|e| e["event"] == kind).map(|e| e["message"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>();
    let deletes = of("rustdesk_file_delete");
    assert_eq!(deletes, vec![
        format!("RustDesk deleted folder /home/ubuntu/photos (2 files) by alice (session {short})"),
        format!("RustDesk could not delete file /root/denied.txt: Permission denied (os error 13) by alice (session {short})"),
    ], "{ev:?}");
    assert_eq!(of("rustdesk_file_rename"), vec![format!("RustDesk renamed /home/ubuntu/notes.txt to ../shared/notes.txt by alice (session {short})")]);
    assert!(ev.iter().all(|e| !e["message"].as_str().unwrap_or("").contains("/home/ubuntu/new")), "creating a folder is not an audit event");

    // 畫面 session 上送檔案動作 → 4403。/ A file action on the screen session is refused.
    relay.send(Message::Binary(file_action_message(&FileOp::RemoveFile { id: 1, path: "/etc/hosts".into() }).into())).await.unwrap();
    assert_eq!(recv(&mut relay).await.err(), Some(4403));
    wait_for("screen session removed", || app.state.rustdesk.get(&sid).is_none()).await;
    let ev = events(&lab, &alice.token, id).await;
    assert!(ev.iter().any(|e| e["event"] == "rustdesk_close" && e["message"].as_str().unwrap_or("").contains("refused: a file transfer message on a remote control session")), "{ev:?}");
    assert!(!received.lock().unwrap().iter().any(|m| file_op(m) == Some(FileOp::RemoveFile { id: 1, path: "/etc/hosts".into() })), "the refused action never reached the device");
}
