//! 編好的 `telepy-carrier` 對真的伺服器（同一個 SSH lab）：只走網頁 port、自動（SSH 的 port 開著就直連、關著就改走網頁
//! port 並記下來）、經 HTTP CONNECT 代理（`--proxy`、`HTTPS_PROXY`、`NO_PROXY`）。裡面的 SSH 一模一樣：後端照樣登入裝置。
//! The built `telepy-carrier` against the real server on the SSH lab: web port only, automatic (the SSH port when it
//! answers, the web port when it is blocked — remembered), and through an HTTP CONNECT proxy (`--proxy`, `HTTPS_PROXY`,
//! `NO_PROXY`). The SSH inside is the same: the backend logs in to the device as usual.
#[path = "../../backend-api/tests/common/mod.rs"]
#[allow(unused_imports, clippy::all)]
mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::lab::Lab;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const BIN: &str = env!("CARGO_BIN_EXE_telepy-carrier");

async fn wait_forward(lab: &Lab, port: u16) -> bool {
    for _ in 0..200 {
        if lab.app.state.status.listen_ports().map(|p| p.contains(&port)).unwrap_or(false) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// 一個最小的 HTTP CONNECT 代理：數每一次 CONNECT，再把兩邊接起來。/ A minimal CONNECT proxy that counts requests.
async fn connect_proxy(count: Arc<AtomicUsize>) -> u16 {
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
                let first = head.lines().next().unwrap_or("").to_string();
                let target = first.strip_prefix("CONNECT ").and_then(|r| r.split_whitespace().next()).unwrap_or("").to_string();
                count.fetch_add(1, Ordering::SeqCst);
                match TcpStream::connect(&target).await {
                    Ok(mut upstream) => {
                        client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
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

fn transport_of(r: &common::Resp, id: i64) -> serde_json::Value {
    r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap()["endpoint"]["transport"].clone()
}

#[tokio::test]
async fn the_carrier_connects_devices_directly_through_the_web_port_and_through_a_proxy() {
    let Some(lab) = Lab::start().await else { return };
    let out = std::process::Command::new(BIN).arg("--version").output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("telepy-carrier "), "{out:?}");
    assert!(std::process::Command::new(BIN).output().map(|o| o.status.code() == Some(2)).unwrap_or(false), "no URL = usage error");

    let alice = lab.user("alice").await;
    let url = format!("{}/ws/gateway/", lab.ws_base().await);
    let tmp = lab.dir.path().join("carrier-tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    let env_prefix = format!("env TMPDIR={} NO_PROXY= HTTPS_PROXY= https_proxy= ALL_PROXY=", tmp.display());

    // 只走網頁 port。/ The web port only.
    let a = lab.machine("car-a", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand={env_prefix} {BIN} {url}")];
    let dev = lab.device_via_port(&alice, "car-a", &a, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "web port only");
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "websocket", "{}", r.text);

    // 自動，SSH 的 port 開著：直連。/ Automatic with the SSH port answering: direct.
    let b = lab.machine("car-b", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand={env_prefix} {BIN} --tcp 127.0.0.1:{} {url}", lab.gw_port)];
    let dev = lab.device_via_port(&alice, "car-b", &b, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "automatic, SSH port open");
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "tcp", "{}", r.text);

    // 自動，SSH 的 port 不通：改走網頁 port，並記下來。/ Automatic with the SSH port blocked: the web port, remembered.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let c = lab.machine("car-c", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand={env_prefix} {BIN} --tcp 127.0.0.1:{closed} {url}")];
    let dev = lab.device_via_port(&alice, "car-c", &c, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "automatic, SSH port blocked");
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "websocket", "{}", r.text);
    let remembered = std::fs::read_dir(&tmp).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with("telepy-ws-"));
    assert!(remembered, "a working web port is remembered in TMPDIR");

    // 經 HTTP CONNECT 代理：--proxy 旗標。/ Through a CONNECT proxy with --proxy.
    let count = Arc::new(AtomicUsize::new(0));
    let pport = connect_proxy(count.clone()).await;
    let d = lab.machine("car-d", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand={env_prefix} {BIN} --proxy http://127.0.0.1:{pport} {url}")];
    let dev = lab.device_via_port(&alice, "car-d", &d, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "through the proxy");
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    assert!(count.load(Ordering::SeqCst) >= 1, "the connection went through the proxy");

    // HTTPS_PROXY 環境變數，SSH 的 port 也經代理（CONNECT 到關掉的 port 失敗 → 網頁 port）。/ HTTPS_PROXY from the environment.
    let before = count.load(Ordering::SeqCst);
    let e = lab.machine("car-e", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand=env TMPDIR={} NO_PROXY= HTTPS_PROXY=http://127.0.0.1:{pport} {BIN} --tcp 127.0.0.1:{closed} {url}", tmp.display())];
    let dev = lab.device_via_port(&alice, "car-e", &e, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "HTTPS_PROXY");
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    assert!(count.load(Ordering::SeqCst) > before, "HTTPS_PROXY was honoured");

    // NO_PROXY 列到的主機不走代理。/ NO_PROXY keeps the proxy out of it.
    let before = count.load(Ordering::SeqCst);
    let f = lab.machine("car-f", &[("ubuntu", &[&lab.service])], false).await;
    let proxy = ["-o".to_string(), format!("ProxyCommand=env TMPDIR={} HTTPS_PROXY=http://127.0.0.1:{pport} NO_PROXY=127.0.0.1 {BIN} {url}", tmp.display())];
    let dev = lab.device_via_port(&alice, "car-f", &f, 1, &proxy).await;
    assert!(wait_forward(&lab, dev.reverse_port).await, "NO_PROXY");
    assert_eq!(count.load(Ordering::SeqCst), before, "NO_PROXY: no CONNECT was made");
}
