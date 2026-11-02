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
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use common::lab::{Hop, Lab};

/// 本機 TCP port → `/ws/gateway/` 的橋（每條 TCP 連線一條 WebSocket）；`proto` 像 TLS 代理一樣帶 `X-Forwarded-Proto`
/// （`https` = 裝置那頭是 wss）。/ A local TCP port bridged to /ws/gateway/; `proto` = the TLS proxy's forwarded proto.
async fn ws_bridge(ws_base: String, proto: Option<&'static str>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut tcp, _)) = listener.accept().await else { break };
            let url = format!("{ws_base}/ws/gateway/");
            tokio::spawn(async move {
                let mut req = url.as_str().into_client_request().unwrap();
                if let Some(p) = proto {
                    req.headers_mut().insert("x-forwarded-proto", p.parse().unwrap());
                }
                let (ws, _) = tokio_tungstenite::connect_async(req).await.expect("websocket upgrade");
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

/// 單筆 retrieve 的 `way_in`。/ The single retrieve's `way_in`.
async fn way_in(app: &common::TestApp, token: &str, id: i64) -> serde_json::Value {
    app.get(&format!("/api/reverse/server/keys/{id}"), Some(token)).await.json["way_in"].clone()
}

/// 發一次性腳本網址，再像裝置一樣（不帶登入）把它拿走。/ Mint a one-time script URL and take it like a device would.
async fn take_one_time_script(app: &common::TestApp, token: &str, body: serde_json::Value) {
    let r = app.post("/tunnels/server/script/one-time/token", Some(token), body).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.get(&format!("/tunnels/server/script/one-time/{}", r.json["token"].as_str().unwrap()), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
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
    let bridge = ws_bridge(lab.ws_base().await, Some("https")).await;
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
    // 卡片的「SSH over WSS」：手動接上的隧道，第一次連線就是它加進來的方式；代理說 https = wss。
    // The badge: a tunnel connected by hand is set up the way it first came in; the proxy said https = wss.
    assert_eq!(item["way_in"], json!({"setup": "websocket", "last": "websocket", "live": true, "tls": true}), "{item}");
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={}", dev.tunnel_id), Some(&alice.token)).await;
    let accepted = r.json.as_array().unwrap().iter().find(|e| e["event"] == "accepted").unwrap();
    assert!(accepted["message"].as_str().unwrap().ends_with("(over websocket)"), "{}", accepted["message"]);

    // 斷線後仍記得是走 WebSocket（離線的卡片也標 HTTP）。/ After a disconnect the last transport is kept.
    lab.disconnect_device(&dev).await;
    let mut last = serde_json::Value::Null;
    for _ in 0..100 {
        let r = app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
        last = r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == dev.tunnel_id).unwrap()["endpoint"].clone();
        if last["live"] == false {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!((last["live"].as_bool(), last["transport"].as_str()), (Some(false), Some("websocket")), "{last}");
    assert_eq!(way_in(app, &alice.token, dev.tunnel_id).await, json!({"setup": "websocket", "last": "websocket", "live": false, "tls": true}));

    // 裝置拿走 SSH port 版的一次性腳本 = 重新設定成 SSH port；最後一次還是 WSS，兩個不同（卡片多一個 ⇄）。
    // The device takes the SSH-port one-time script = set up for the SSH port again; it last came in over WSS.
    take_one_time_script(app, &alice.token, json!({"server_id": dev.tunnel_id, "ssh_port": 22, "script_type": "ssh"})).await;
    assert_eq!(way_in(app, &alice.token, dev.tunnel_id).await, json!({"setup": "ssh", "last": "websocket", "live": false, "tls": true}));
    take_one_time_script(app, &alice.token, json!({"server_id": dev.tunnel_id, "ssh_port": 22, "script_type": "autossh", "transport": "websocket"})).await;
    assert_eq!(way_in(app, &alice.token, dev.tunnel_id).await["setup"], "websocket");

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
    // 先抓預編的 telepy-carrier，沒有再 python3；ssh 經包裝腳本。/ The prebuilt carrier first, python3 second; ssh goes through the wrapper.
    assert!(script.contains("/api/join/carrier/") && script.contains("/api/join/telepy-ws.py") && script.contains("-o \"ProxyCommand=$WS_SH\""), "{script}");
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

/// 一個最小的 HTTP CONNECT 代理：數每一次 CONNECT，再把兩邊接起來。/ A minimal CONNECT proxy that counts requests.
async fn connect_proxy(count: std::sync::Arc<std::sync::atomic::AtomicUsize>) -> u16 {
    use std::sync::atomic::Ordering;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut client, _)) = listener.accept().await else { break };
            let count = count.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    let n = client.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let target = head.lines().next().and_then(|l| l.strip_prefix("CONNECT ")).and_then(|r| r.split_whitespace().next()).unwrap_or("").to_string();
                count.fetch_add(1, Ordering::SeqCst);
                match tokio::net::TcpStream::connect(&target).await {
                    Ok(mut up) => {
                        client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut up).await;
                    }
                    Err(_) => {
                        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                    }
                }
            });
        }
    });
    port
}

/// 公司內網只能經 HTTP 代理出去：python3 小程式對 SSH 的 port 與網頁 port 都先送 CONNECT（`--proxy`，或 HTTPS_PROXY / NO_PROXY）。
/// Networks that only let traffic out through an HTTP proxy: the python3 carrier sends CONNECT for both the SSH port
/// and the web port (`--proxy`, or HTTPS_PROXY with NO_PROXY honoured).
#[tokio::test]
async fn the_python_carrier_goes_through_a_connect_proxy() {
    use std::sync::atomic::Ordering;
    let Some(lab) = Lab::start().await else { return };
    if !common::lab::have("python3") {
        eprintln!("skipping: no python3");
        return;
    }
    let alice = lab.user("alice").await;
    let script = lab.app.get("/api/join/telepy-ws.py", None).await.text;
    assert!(script.contains("--proxy") && script.contains("def proxy_from_env"), "the served script has proxy support");
    let path = lab.dir.path().join("telepy-ws-proxy.py");
    std::fs::write(&path, script).unwrap();
    let url = format!("{}/ws/gateway/", lab.ws_base().await);
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let pport = connect_proxy(count.clone()).await;
    let transport_of = |r: &common::Resp, id: i64| r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap()["endpoint"]["transport"].clone();

    // --proxy，自動：CONNECT 到關掉的 SSH port 失敗 → 經代理走網頁 port。/ --proxy, automatic: the SSH port fails through the proxy, the web port works.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let a = lab.machine("px-a", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand=python3 {} --proxy http://127.0.0.1:{pport} --tcp 127.0.0.1:{closed} {url}", path.display())];
    let dev = lab.device_via_port(&alice, "px-a", &a, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "through the proxy");
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "websocket", "{}", r.text);
    assert!(count.load(Ordering::SeqCst) >= 2, "CONNECT for the SSH port and for the web port: {}", count.load(Ordering::SeqCst));

    // HTTPS_PROXY 環境變數 + NO_PROXY 列到的主機不走代理。/ HTTPS_PROXY from the environment; NO_PROXY keeps it out.
    let before = count.load(Ordering::SeqCst);
    let b = lab.machine("px-b", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand=env HTTPS_PROXY=http://127.0.0.1:{pport} NO_PROXY=127.0.0.1 python3 {} {url}", path.display())];
    let dev = lab.device_via_port(&alice, "px-b", &b, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "NO_PROXY");
    assert_eq!(count.load(Ordering::SeqCst), before, "NO_PROXY: no CONNECT");
    let c = lab.machine("px-c", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand=env HTTPS_PROXY=http://127.0.0.1:{pport} NO_PROXY= python3 {} {url}", path.display())];
    let dev = lab.device_via_port(&alice, "px-c", &c, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "HTTPS_PROXY");
    assert!(count.load(Ordering::SeqCst) > before, "HTTPS_PROXY was honoured");
}

/// 伺服器重啟的那幾秒，SSH 的 port 還沒開、網頁 port 已經通（容器的 port 轉發比容器之間的網路慢），裝置就走了網頁
/// port。python3 版的小程式也一樣：SSH 的 port 回來就結束網頁 port 的連線、忘掉「網頁 port 走得通」，下一次走 SSH 的 port。
/// For a few seconds after a server restart the SSH port is still closed while the web port works (container port
/// publishing lags behind the containers' own network), so a device takes the web port. The python3 carrier, too, ends
/// that connection once the SSH port answers and forgets the web port; the next connection takes the SSH port.
#[tokio::test]
async fn the_python_carrier_returns_to_the_ssh_port_once_it_answers_again() {
    let Some(lab) = Lab::start().await else { return };
    if !common::lab::have("python3") {
        eprintln!("skipping: no python3");
        return;
    }
    let alice = lab.user("alice").await;
    let script = lab.app.get("/api/join/telepy-ws.py", None).await.text;
    let path = lab.dir.path().join("telepy-ws.py");
    std::fs::write(&path, script).unwrap();
    let url = format!("{}/ws/gateway/", lab.ws_base().await);
    let tmp = lab.dir.path().join("back-tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    let remembered = || std::fs::read_dir(&tmp).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with("telepy-ws-"));
    let transport_of = |r: &common::Resp, id: i64| r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap()["endpoint"]["transport"].clone();

    let port = common::lab::free_port();
    let m = lab.machine("back-py", &[("ubuntu", &[&lab.service])], false).await;
    let opts = ["-o".to_string(), format!("ProxyCommand=env TMPDIR={} TELEPY_SSH_PORT_RETRY=1,1,1,1,1,1,1,1,1,1 python3 {} --tcp 127.0.0.1:{port} {url}", tmp.display(), path.display())];
    let dev = lab.device_via_port(&alice, "back-py", &m, 1, &opts).await;
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "websocket", "the SSH port was closed: {}", r.text);
    assert!(remembered());

    // SSH 的 port 開了（轉到 gateway）。/ The SSH port opens (a relay to the gateway).
    let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    let gw = lab.gw_port;
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            tokio::spawn(async move {
                if let Ok(mut up) = tokio::net::TcpStream::connect(("127.0.0.1", gw)).await {
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut up).await;
                }
            });
        }
    });
    let mut released = false;
    for _ in 0..300 {
        if !lab.app.state.status.listen_ports().is_some_and(|p| p.contains(&dev.reverse_port)) {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(released, "the carrier left the web port once the SSH port answered");
    assert!(!remembered(), "and forgot that the web port worked");

    // 服務重啟 ssh：這次走 SSH 的 port。/ The service starts ssh again: the SSH port this time.
    let again: Vec<String> = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"].map(String::from).into_iter().chain(opts.iter().cloned()).collect();
    let _ssh = lab.spawn_tunnel_to(&dev.key, dev.reverse_port, m.port, "back-py", 1, &again).await;
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "tcp", "{}", r.text);
}

/// 自動：小程式先連 SSH 的 port（拿到 gateway 的 banner 才算），連不上（關掉的 port、只轉網頁的代理）才走 WebSocket；
/// 每次連線都重新判斷。一鍵加入的指令多 `--auto`，腳本與筆電的 ssh config 帶 `--tcp <SSH 主機>:<port>`。
/// Automatic: the carrier dials the SSH port first (it must see the gateway's banner) and takes the WebSocket only
/// when that fails (a closed port, a proxy that only carries web ports), on every connection. The join command gets
/// `--auto`; scripts and the laptop config carry `--tcp <ssh host>:<port>`.
#[tokio::test]
async fn the_automatic_carrier_takes_the_ssh_port_first_and_the_web_port_when_it_is_blocked() {
    let Some(lab) = Lab::start().await else { return };
    if !common::lab::have("python3") {
        eprintln!("skipping: no python3");
        return;
    }
    let alice = lab.user("alice").await;
    let script = lab.app.get("/api/join/telepy-ws.py", None).await.text;
    let path = lab.dir.path().join("telepy-ws.py");
    std::fs::write(&path, script).unwrap();
    let url = format!("{}/ws/gateway/", lab.ws_base().await);
    let transport_of = |r: &common::Resp, id: i64| r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap()["endpoint"]["transport"].clone();

    // SSH 的 port 開著：直接連。/ The SSH port answers: direct.
    let a = lab.machine("auto-a", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand=python3 {} --tcp 127.0.0.1:{} {url}", path.display(), lab.gw_port)];
    let dev = lab.device_via_port(&alice, "auto-a", &a, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await);
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "tcp", "{}", r.text);

    // SSH 的 port 不通（這裡是一個沒人聽的 port）：改走網頁的 port。/ The SSH port is blocked: the web port.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let b = lab.machine("auto-b", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand=python3 {} --tcp 127.0.0.1:{closed} {url}", path.display())];
    let dev = lab.device_via_port(&alice, "auto-b", &b, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await);
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "websocket", "{}", r.text);

    // API：票、腳本、筆電設定。/ The API: ticket, scripts, laptop config.
    let app = &lab.app;
    let r = app.post("/api/reverse/join", Some(&alice.token), json!({"transport": "auto"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["transport"], "auto");
    assert!(r.json["command"].as_str().unwrap().ends_with(" --auto"), "{}", r.json["command"]);
    let r = app.get(&format!("/tunnels/server/script/autossh/{}/22?transport=auto", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let s = r.json["script"].as_str().unwrap();
    assert!(s.contains(&format!("--tcp telepy.test:{} ws", lab.app.state.config.reverse_server_ssh_port)) || s.contains("--tcp "), "{s}");
    let r = app.get(&format!("/tunnels/server/script/powershell/{}/22?transport=auto", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "automatic = the SSH port where the carrier can't run: {}", r.text);
    // 裝置拿走自動版的一次性腳本 = 設定成自動。/ Taking the automatic one-time script = set up as automatic.
    take_one_time_script(app, &alice.token, json!({"server_id": dev.tunnel_id, "ssh_port": 22, "script_type": "autossh", "transport": "auto"})).await;
    assert_eq!(way_in(app, &alice.token, dev.tunnel_id).await["setup"], "auto");
    let r = app.get(&format!("/tunnels/server/config/{}?transport=auto", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.json["transport"], "auto");
    assert!(r.json["config"].as_str().unwrap().contains("ProxyCommand python3 ~/.ssh/telepy-ws.py --tcp "), "{}", r.json["config"]);
}
