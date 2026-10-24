//! SSH over WebSocket（SSH lab）：裝置的 `ssh -NR` 不連 24242，而是經一座 TCP→WebSocket 的橋連到 `/ws/gateway/`，
//! 裡面的 SSH 一模一樣（金鑰、forward、後端登入、筆電的 direct-tcpip），連線資訊記成 websocket。
//! 有 python3 的話也用真的裝置端小程式（`/api/join/telepy-ws.py`）當 ProxyCommand 跑一次。
//! SSH over WebSocket on the lab: the device dials /ws/gateway/ through a TCP→WebSocket bridge; the SSH inside is the
//! same (keys, forward, backend login, laptop direct-tcpip) and the connection is recorded as websocket. With python3
//! present the real device-side carrier is exercised as a ProxyCommand too.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use common::lab::{Hop, Lab};

/// 本機 TCP port → `/ws/gateway/` 的橋（每條 TCP 連線一條 WebSocket）。/ A local TCP port bridged to /ws/gateway/.
async fn ws_bridge(ws_base: String) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut tcp, _)) = listener.accept().await else { break };
            let url = format!("{ws_base}/ws/gateway/");
            tokio::spawn(async move {
                let (ws, _) = tokio_tungstenite::connect_async(&url).await.expect("websocket upgrade");
                let (mut tx, mut rx) = ws.split();
                let (mut rd, mut wr) = tcp.split();
                let up = async {
                    let mut buf = vec![0u8; 16 * 1024];
                    loop {
                        let n = rd.read(&mut buf).await?;
                        if n == 0 {
                            let _ = tx.send(Message::Close(None)).await;
                            break;
                        }
                        tx.send(Message::Binary(buf[..n].to_vec().into())).await.map_err(std::io::Error::other)?;
                    }
                    std::io::Result::Ok(())
                };
                let down = async {
                    while let Some(Ok(msg)) = rx.next().await {
                        match msg {
                            Message::Binary(b) => wr.write_all(&b).await?,
                            Message::Close(_) => break,
                            _ => {}
                        }
                    }
                    let _ = wr.shutdown().await;
                    std::io::Result::Ok(())
                };
                let _ = tokio::join!(up, down);
            });
        }
    });
    port
}

async fn wait_forward(lab: &Lab, port: u16) -> bool {
    for _ in 0..200 {
        if lab.app.state.status.listen_ports().is_some_and(|p| p.contains(&port)) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test]
async fn a_device_can_dial_the_gateway_through_the_websocket() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bridge = ws_bridge(lab.ws_base().await).await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service, &alice.key])], false).await;
    let dev = lab.device_via_port(&alice, "box", &boxm, bridge, &[]).await;
    lab.username(&alice, &dev, "ubuntu").await;

    // 同一套 SSH：後端登入、筆電 direct-tcpip 都照常。/ The same SSH: backend login and laptop direct-tcpip work.
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.laptop_exec(&alice, &[(Hop::Tunnel(&dev), "ubuntu")], "whereami").await;
    assert_eq!(r.stdout, "ubuntu@box", "{r:?}");

    // 連線資訊知道它走的是 WebSocket；事件也寫明。/ The endpoint says websocket; so does the accepted event.
    let r = app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    let item = r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == dev.tunnel_id).unwrap();
    assert_eq!((item["endpoint"]["live"].as_bool(), item["endpoint"]["transport"].as_str()), (Some(true), Some("websocket")), "{item}");
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={}", dev.tunnel_id), Some(&alice.token)).await;
    let accepted = r.json.as_array().unwrap().iter().find(|e| e["event"] == "accepted").unwrap();
    assert!(accepted["message"].as_str().unwrap().ends_with("(over websocket)"), "{}", accepted["message"]);

    // 一鍵加入：票可以選 websocket，指令多 --via-web，註冊回答帶 WS_URL。/ Join: the ticket carries the transport.
    let r = app.post("/api/reverse/join", Some(&alice.token), json!({"transport": "websocket"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["transport"], "websocket");
    assert!(r.json["command"].as_str().unwrap().ends_with(" --via-web"), "{}", r.json["command"]);
    assert!(r.json["command_no_sudo"].as_str().unwrap().ends_with(" --via-web"));
    let r = app.post("/api/reverse/join", Some(&alice.token), json!({"transport": "carrier-pigeon"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = app.get("/api/join/telepy-ws.py", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text.starts_with("#!/usr/bin/env python3"), "{}", &r.text[..40]);

    // 精靈腳本與 ssh config 的 websocket 版本。/ The wizard scripts and the ssh config in their websocket form.
    let r = app.get(&format!("/tunnels/server/script/autossh/{}/22?transport=websocket", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let script = r.json["script"].as_str().unwrap();
    assert!(script.contains("/api/join/telepy-ws.py") && script.contains("-o \"ProxyCommand=python3 $WS_CLIENT ws"), "{script}");
    let r = app.get(&format!("/tunnels/server/script/powershell/{}/22?transport=websocket", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = app.get(&format!("/tunnels/server/config/{}?transport=websocket", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["transport"], "websocket");
    assert!(r.json["ws_url"].as_str().unwrap().ends_with("/ws/gateway/"), "{}", r.text);
    assert!(r.json["config"].as_str().unwrap().contains("ProxyCommand python3 ~/.ssh/telepy-ws.py ws"), "{}", r.json["config"]);
    let r = app.get(&format!("/tunnels/server/config/{}", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.json["transport"], "ssh");
    assert!(!r.json["config"].as_str().unwrap().contains("telepy-ws.py"));
}

/// 真的裝置端小程式：python3 當 ProxyCommand，把 ssh 包進 /ws/gateway/。/ The real carrier as a ProxyCommand.
#[tokio::test]
async fn the_python_carrier_works_as_a_proxy_command() {
    let Some(lab) = Lab::start().await else { return };
    if !common::lab::have("python3") {
        eprintln!("skipping: no python3");
        return;
    }
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let script = lab.app.get("/api/join/telepy-ws.py", None).await.text;
    let path = lab.dir.path().join("telepy-ws.py");
    std::fs::write(&path, script).unwrap();
    let url = format!("{}/ws/gateway/", lab.ws_base().await);
    let proxy = ["-o".to_string(), format!("ProxyCommand=python3 {} {url}", path.display())];
    // gw_port 無所謂：ProxyCommand 接管了連線。/ The port is moot: the ProxyCommand owns the connection.
    let dev = lab.device_via_port(&alice, "box", &boxm, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await);
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    let item = r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == dev.tunnel_id).unwrap();
    assert_eq!(item["endpoint"]["transport"], "websocket", "{item}");
}
