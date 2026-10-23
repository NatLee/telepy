//! 遠端瀏覽器的 SOCKS 代理端到端（common::lab）：經 REST 開 session，對代理埠做真正的 SOCKS5 CONNECT，
//! 穿過裝置連到它區網裡的機器（裝置 sshd 的 direct-tcpip）。這是把 `ssh -D` 子程序換成行程內 SOCKS 之前的驗收測試。
//! Remote-browser SOCKS end to end: a real SOCKS5 CONNECT through the proxy to a machine behind the device.
mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use common::lab::Lab;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Default)]
struct KasmLog(Arc<Mutex<Vec<String>>>);

/// 假的 kasm session-manager：只記下 proxy URL。/ Fake kasm: records the proxy URL it was given.
async fn mock_kasm(log: KasmLog) -> String {
    async fn create(State(log): State<KasmLog>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
        if headers.get("x-internal-token").and_then(|v| v.to_str().ok()) != Some("internal-secret") {
            return (StatusCode::FORBIDDEN, Json(json!({"error": "forbidden"})));
        }
        log.0.lock().unwrap().push(body["proxy"].as_str().unwrap_or("").to_string());
        (StatusCode::CREATED, Json(json!({"session_id": "kasm-1", "ws_port": 1})))
    }
    async fn delete(Path(_id): Path<String>) -> Json<Value> {
        Json(json!({"status": "stopped"}))
    }
    let app = Router::new().route("/sessions", post(create)).route("/sessions/{id}", axum::routing::delete(delete)).with_state(log);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

/// 一個會先送 banner 再 echo 的 TCP 服務（當作區網裡的網站）。/ A banner-then-echo TCP service on the LAN.
async fn lan_service(banner: &'static str) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let _ = s.write_all(banner.as_bytes()).await;
                let mut buf = [0u8; 1024];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

/// SOCKS5 無認證 CONNECT 到 `host:port`，回已連通的 stream。/ A SOCKS5 no-auth CONNECT; returns the tunnelled stream.
async fn socks_connect(proxy_port: u16, host: &str, port: u16) -> anyhow::Result<TcpStream> {
    let mut s = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(("127.0.0.1", proxy_port))).await??;
    s.write_all(&[5, 1, 0]).await?;
    let mut rep = [0u8; 2];
    s.read_exact(&mut rep).await?;
    anyhow::ensure!(rep == [5, 0], "method selection {rep:?}");
    let mut req = vec![5, 1, 0, 3, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await?;
    anyhow::ensure!(head[1] == 0, "CONNECT failed with reply {}", head[1]);
    let addr_len = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await?;
            l[0] as usize
        }
        other => anyhow::bail!("address type {other}"),
    };
    let mut rest = vec![0u8; addr_len + 2];
    s.read_exact(&mut rest).await?;
    Ok(s)
}

async fn start_session(lab: &Lab, user: &common::lab::LabUser, device: &common::lab::Device, os_user: &str) -> (StatusCode, Value) {
    let r = lab.app.post(&format!("/api/reverse/server/{}/remote-browser/start", device.tunnel_id), Some(&user.token), json!({"username": os_user})).await;
    (r.status, r.json)
}

#[tokio::test]
async fn socks_proxy_reaches_a_lan_service_through_the_device() {
    let Some(mut lab) = Lab::start().await else { return };
    let kasm = KasmLog::default();
    let kasm_base = mock_kasm(kasm.clone()).await;
    lab.reconfigure(|c| {
        c.kasm_api = kasm_base;
        c.kasm_host = "127.0.0.1".into();
        c.hostname = "127.0.0.1".into();
        c.remote_browser_gc = false;
    });
    let alice = lab.user("alice").await;
    let web = lan_service("HTTP/1.0 200 lan-web\r\n\r\n").await;
    // 裝置允許 direct-tcpip（= AllowTcpForwarding yes），不然 SOCKS 一個 CONNECT 都過不去。
    let edge = lab.machine("edge", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "edge", &edge).await;
    lab.username(&alice, &dev, "ubuntu").await;
    lab.app.post("/api/site/settings", Some(&lab.admin_token), json!({"remote_browser_ssh_timeout": 10, "remote_browser_ssh_attempts": 1})).await;

    let (status, body) = start_session(&lab, &alice, &dev, "ubuntu").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sid = body["session_id"].as_str().unwrap().to_string();
    let proxy_url = kasm.0.lock().unwrap().last().cloned().unwrap();
    let proxy_port: u16 = proxy_url.rsplit(':').next().unwrap().parse().unwrap();
    assert!(proxy_url.starts_with("socks5://127.0.0.1:"), "{proxy_url}");

    // 真的 SOCKS5 CONNECT → 裝置 → 區網服務。/ Real CONNECT through the device to the LAN service.
    let mut s = socks_connect(proxy_port, "127.0.0.1", web).await.expect("CONNECT through the device");
    let mut banner = [0u8; 24];
    s.read_exact(&mut banner).await.unwrap();
    assert_eq!(&banner, b"HTTP/1.0 200 lan-web\r\n\r\n");
    s.write_all(b"ping").await.unwrap();
    let mut back = [0u8; 4];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut back)).await.unwrap().unwrap();
    assert_eq!(&back, b"ping");
    assert!(edge.logged_in("ubuntu", &lab.service));

    // 幾個同時的 CONNECT（瀏覽器會平行開很多條）。/ Several concurrent CONNECTs, like a browser does.
    let all = futures::future::join_all((0..6).map(|_| socks_connect(proxy_port, "127.0.0.1", web))).await;
    assert!(all.iter().all(|r| r.is_ok()), "{:?}", all.iter().map(|r| r.as_ref().err().map(|e| e.to_string())).collect::<Vec<_>>());
    // 連不到的目標：CONNECT 失敗，代理本身還活著。/ An unreachable target fails the CONNECT; the proxy stays up.
    assert!(socks_connect(proxy_port, "127.0.0.1", 1).await.is_err());
    assert!(socks_connect(proxy_port, "127.0.0.1", web).await.is_ok());

    // ping 說還活著；stop 之後代理埠關閉。/ ping keeps it; stop closes the proxy.
    let r = lab.app.post(&format!("/api/reverse/server/remote-browser/{sid}/ping"), Some(&alice.token), json!({})).await;
    assert_eq!(r.json["status"], "ok", "{}", r.text);
    let r = lab.app.post(&format!("/api/reverse/server/remote-browser/{sid}/stop"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(TcpStream::connect(("127.0.0.1", proxy_port)).await.is_err(), "proxy port must be closed after stop");
}

/// 裝置離線：start 回 device_offline（不是卡到逾時後的模糊錯誤）。
#[tokio::test]
async fn socks_start_on_an_offline_device_reports_device_offline() {
    let Some(mut lab) = Lab::start().await else { return };
    let kasm_base = mock_kasm(KasmLog::default()).await;
    lab.reconfigure(|c| {
        c.kasm_api = kasm_base;
        c.hostname = "127.0.0.1".into();
        c.remote_browser_gc = false;
    });
    let alice = lab.user("alice").await;
    let edge = lab.machine("edge", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "edge", &edge).await;
    lab.username(&alice, &dev, "ubuntu").await;
    lab.app.post("/api/site/settings", Some(&lab.admin_token), json!({"remote_browser_ssh_timeout": 3, "remote_browser_ssh_attempts": 1})).await;
    lab.disconnect_device(&dev).await;
    let started = std::time::Instant::now();
    let (status, body) = start_session(&lab, &alice, &dev, "ubuntu").await;
    assert_ne!(status, StatusCode::OK);
    assert_eq!(body["code"], "device_offline", "{body}");
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
}

/// macOS 裝置：Apple 的 sshd-session 對**名稱**的 direct-tcpip 會 crash、整條連線斷掉（lab 的 pretend_darwin
/// 照做）。Chromium 一律送名稱，所以 SOCKS 先在裝置上解析成 IP；同一條共用連線上的終端機分頁必須活著。
/// macOS devices: hostname CONNECTs are resolved on the device first, so the shared connection (and the
/// terminal tab on it) survives what would otherwise crash Apple's sshd-session.
#[tokio::test]
async fn socks_on_a_macos_device_resolves_names_and_keeps_the_connection() {
    let Some(mut lab) = Lab::start().await else { return };
    let kasm = KasmLog::default();
    let kasm_base = mock_kasm(kasm.clone()).await;
    lab.reconfigure(|c| {
        c.kasm_api = kasm_base;
        c.kasm_host = "127.0.0.1".into();
        c.hostname = "127.0.0.1".into();
        c.remote_browser_gc = false;
    });
    let alice = lab.user("alice").await;
    let web = lan_service("HTTP/1.0 200 mac-web\r\n\r\n").await;
    let mac = lab.machine_with("mac", &[("ubuntu", &[&lab.service])], common::lab::MachineOpts { allow_jump: true, pretend_darwin: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "mac", &mac).await;
    lab.username(&alice, &dev, "ubuntu").await;

    // 終端機分頁開在同一條共用連線上。/ A terminal tab on the same shared connection.
    let mut tab = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    tab.expect("login:ubuntu@mac").await;

    let (status, body) = start_session(&lab, &alice, &dev, "ubuntu").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let proxy_url = kasm.0.lock().unwrap().last().cloned().unwrap();
    let proxy_port: u16 = proxy_url.rsplit(':').next().unwrap().parse().unwrap();

    // 用名稱 CONNECT（瀏覽器的做法）。/ CONNECT by name, like a browser.
    for _ in 0..2 {
        let mut s = socks_connect(proxy_port, "localhost", web).await.expect("CONNECT by name through a macOS device");
        let mut banner = [0u8; 23];
        s.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"HTTP/1.0 200 mac-web\r\n\r");
    }
    assert_eq!(mac.resolves(), vec!["localhost".to_string()], "resolved on the device once, then cached");
    // 名稱解析不到 → CONNECT 失敗，但連線還在。/ An unknown name fails the CONNECT only.
    assert!(socks_connect(proxy_port, "no-such-host.invalid", web).await.is_err());

    // 分頁還活著：同一條連線沒被帶走。/ The tab survived: the shared connection is intact.
    tab.input("still-here\r").await;
    tab.expect("still-here").await;
    assert_eq!(mac.login_count("ubuntu", &lab.service), 1, "one connection the whole time: {:?}", mac.logins());
}
