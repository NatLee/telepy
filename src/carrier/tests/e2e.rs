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

// ------------------------------------------------------------------ the built-in SSH client (`telepy-carrier tunnel`)

/// 只建隧道列（裝置那端由測試自己跑 `telepy-carrier tunnel`）。/ Only the tunnel row; the test runs the device side itself.
async fn tunnel_row(lab: &Lab, owner: &common::lab::LabUser, name: &str, target: &common::lab::Machine) -> common::lab::Device {
    let key = lab.keygen(&format!("{name}-tunnel"));
    let reverse_port = common::lab::free_port();
    let t = telepy_server::db::tunnels::create(
        &lab.app.state.db,
        telepy_server::db::tunnels::NewTunnel { user_id: owner.id, host_friendly_name: name, key: &key.public, reverse_port: reverse_port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    telepy_server::ssh::tunnel_keys::ensure(&lab.app.state, t.id).await.unwrap();
    common::lab::Device { tunnel_id: t.id, name: name.to_string(), reverse_port, target: target.clone(), key }
}

fn listening(lab: &Lab, port: u16) -> bool {
    lab.app.state.status.listen_ports().map(|p| p.contains(&port)).unwrap_or(false)
}

async fn wait_released(lab: &Lab, port: u16) -> bool {
    for _ in 0..150 {
        if !listening(lab, port) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// `telepy-carrier tunnel …` 在背景跑（stderr 留著看）。/ Run `telepy-carrier tunnel …` in the background.
fn spawn_tunnel(tmp: &std::path::Path, args: &[String]) -> tokio::process::Child {
    tokio::process::Command::new(BIN)
        .arg("tunnel")
        .args(args)
        .env("TMPDIR", tmp)
        .env_remove("HTTPS_PROXY")
        .env_remove("https_proxy")
        .env_remove("ALL_PROXY")
        .env_remove("all_proxy")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

async fn stderr_of(child: &mut tokio::process::Child) -> String {
    let mut s = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = tokio::time::timeout(Duration::from_secs(2), e.read_to_string(&mut s)).await;
    }
    s
}

async fn probe(args: &[&str]) -> (Option<i32>, String) {
    let out = tokio::process::Command::new(BIN).args(["tunnel", "--probe", "--no-proxy"]).args(args).output().await.unwrap();
    (out.status.code(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

#[tokio::test]
async fn the_built_in_client_runs_the_tunnel_without_any_ssh_on_the_device() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let url = format!("{}/ws/gateway/", lab.ws_base().await);
    let tmp = lab.dir.path().join("builtin-tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    let host_keys = lab.app.state.gateway.host_public_keys();
    assert!(!host_keys.is_empty());
    let known = lab.dir.path().join("builtin.known_hosts");
    std::fs::write(&known, host_keys.iter().map(|k| format!("telepy-127.0.0.1-{} {k}\n", lab.gw_port)).collect::<String>()).unwrap();
    let known_s = known.display().to_string();
    let server = format!("127.0.0.1:{}", lab.gw_port);

    // (d) --probe：沒有金鑰也能看 gateway 的 host key，握手完成 = ok。/ A probe needs no key; a finished handshake = ok.
    let (code, text) = probe(&["--server", &server, "--known-hosts", &known_s]).await;
    assert_eq!(code, Some(0), "{text}");
    assert!(text.contains("PROBE=ok") && text.contains("FINGERPRINT=SHA256:") && text.contains("WAY=ssh"), "{text}");
    let (code, text) = probe(&["--server", &server]).await;
    assert_eq!(code, Some(0), "{text}");
    assert!(text.contains("HOST_KEY=ssh-"), "without host keys the probe reports what it saw: {text}");
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (code, text) = probe(&["--server", &format!("127.0.0.1:{closed}")]).await;
    assert_eq!(code, Some(4), "nothing reachable: {text}");
    assert!(text.contains("PROBE=unreachable"), "{text}");
    let (code, text) = probe(&["--ws", &url, "--known-hosts", &known_s]).await;
    assert_eq!(code, Some(0), "{text}");
    assert!(text.contains("WAY=web"), "{text}");

    // (a) SSH 的 port：forward 記在隧道自己的號碼下，後端經它登入裝置。/ The SSH port: the tunnel's own number, the backend logs in.
    let a = lab.machine("bi-a", &[("ubuntu", &[&lab.service])], false).await;
    let dev = tunnel_row(&lab, &alice, "bi-a", &a).await;
    let mut child = spawn_tunnel(&tmp, &["--identity".into(), dev.key.path.display().to_string(), "--known-hosts".into(), known_s.clone(), "--server".into(), server.clone(), "--forward".into(), format!("0:127.0.0.1:{}", a.port)]);
    if !wait_forward(&lab, dev.reverse_port).await {
        let _ = child.start_kill();
        panic!("built-in client, SSH port: no forward; stderr: {}", stderr_of(&mut child).await);
    }
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "tcp", "{}", r.text);

    // (e) SIGTERM：乾淨地結束（0），gateway 看到 forward 釋放。/ SIGTERM: a clean exit (0), the forward is released.
    let pid = child.id().unwrap();
    assert!(std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status().unwrap().success());
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await.expect("exits after SIGTERM").unwrap();
    assert_eq!(status.code(), Some(0), "SIGTERM = exit 0; stderr: {}", stderr_of(&mut child).await);
    assert!(wait_released(&lab, dev.reverse_port).await, "the gateway released the forward");

    // (b) SSH 的 port 不通：走網頁 port 的 WebSocket。/ The SSH port blocked: the web port's WebSocket.
    let b = lab.machine("bi-b", &[("ubuntu", &[&lab.service])], false).await;
    let dev = tunnel_row(&lab, &alice, "bi-b", &b).await;
    let mut child = spawn_tunnel(
        &tmp,
        &["--identity".into(), dev.key.path.display().to_string(), "--host-key".into(), host_keys[0].clone(), "--server".into(), format!("127.0.0.1:{closed}"), "--ws".into(), url.clone(), "--forward".into(), format!("127.0.0.1:{}", b.port), "--keepalive".into(), "5".into()],
    );
    if !wait_forward(&lab, dev.reverse_port).await {
        let _ = child.start_kill();
        panic!("built-in client, web port: no forward; stderr: {}", stderr_of(&mut child).await);
    }
    lab.username(&alice, &dev, "ubuntu").await;
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    assert_eq!(transport_of(&r, dev.tunnel_id), "websocket", "{}", r.text);
    let _ = child.start_kill();
    let _ = child.wait().await;
    assert!(wait_released(&lab, dev.reverse_port).await, "killing the client releases the forward");

    // (c) 錯的 host key：拒絕連線（3），什麼都沒登記。/ A wrong host key: refused (3), nothing registered.
    let other = lab.keygen("not-the-gateway");
    let c = lab.machine("bi-c", &[("ubuntu", &[&lab.service])], false).await;
    let dev = tunnel_row(&lab, &alice, "bi-c", &c).await;
    let mut child = spawn_tunnel(&tmp, &["--identity".into(), dev.key.path.display().to_string(), "--host-key".into(), other.public.clone(), "--server".into(), server.clone(), "--forward".into(), format!("0:127.0.0.1:{}", c.port)]);
    let status = tokio::time::timeout(Duration::from_secs(20), child.wait()).await.expect("a wrong host key ends it").unwrap();
    let err = stderr_of(&mut child).await;
    assert_eq!(status.code(), Some(3), "{err}");
    assert!(err.contains("REFUSED") && err.contains("SHA256:"), "{err}");
    assert!(!listening(&lab, dev.reverse_port), "nothing was registered");
    let (code, text) = probe(&["--server", &server, "--host-key", &other.public]).await;
    assert_eq!(code, Some(3), "{text}");
    assert!(text.contains("PROBE=hostkey"), "{text}");

    // 沒登記的金鑰：登入被拒（1）。/ An unregistered key: the login is refused (1).
    let stranger = lab.keygen("stranger");
    let mut child = spawn_tunnel(&tmp, &["--identity".into(), stranger.path.display().to_string(), "--known-hosts".into(), known_s.clone(), "--server".into(), server.clone()]);
    let status = tokio::time::timeout(Duration::from_secs(20), child.wait()).await.expect("a refused key ends it").unwrap();
    let err = stderr_of(&mut child).await;
    assert_eq!(status.code(), Some(1), "{err}");
    assert!(err.contains("refused the key"), "{err}");

    // keygen 做的金鑰 OpenSSH 讀得懂。/ A key from `keygen` is one OpenSSH reads.
    let made = lab.dir.path().join("made_ed25519");
    let out = std::process::Command::new(BIN).args(["keygen", "-C", "telepy-tunnel@lab"]).arg(&made).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let public = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(public.starts_with("ssh-ed25519 ") && public.ends_with("telepy-tunnel@lab"), "{public}");
    let out = std::process::Command::new("ssh-keygen").args(["-y", "-f"]).arg(&made).output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).starts_with(public.rsplit_once(' ').unwrap().0), "OpenSSH reads the key");
}
