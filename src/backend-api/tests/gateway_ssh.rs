//! 內建 SSH gateway 的端到端測試：用真正的 OpenSSH 客戶端建立 `-R` 反向隧道到本機 echo server，
//! 再從 gateway 的 loopback listener 與 russh direct-tcpip 兩條路穿過去。沒有 ssh/ssh-keygen 就跳過。
mod common;

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;

use telepy_server::db;
use telepy_server::gateway;

fn have(bin: &str) -> bool {
    std::process::Command::new("which").arg(bin).output().map(|o| o.status.success()).unwrap_or(false)
}

fn keygen(dir: &std::path::Path, name: &str) -> (std::path::PathBuf, String) {
    let path = dir.join(name);
    let out = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&path).output().unwrap();
    assert!(out.status.success(), "ssh-keygen failed: {}", String::from_utf8_lossy(&out.stderr));
    let pubkey = std::fs::read_to_string(path.with_extension("pub")).unwrap().trim().to_string();
    (path, pubkey)
}

async fn echo_server() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            tokio::spawn(async move {
                // 先送一個 banner（模擬 sshd），再 echo。/ Banner first (like sshd), then echo.
                let _ = s.write_all(b"SSH-2.0-echo\r\n").await;
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

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    f()
}

#[tokio::test]
async fn reverse_tunnel_through_real_openssh_client() {
    if !have("ssh") || !have("ssh-keygen") {
        eprintln!("skipping: ssh / ssh-keygen not available");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    keygen(dir.path(), "ssh_host_ed25519_key");
    let (device_key, device_pub) = keygen(dir.path(), "device_key");
    let (user_key, user_pub) = keygen(dir.path(), "user_key");
    let (_stranger_key, _) = keygen(dir.path(), "stranger_key");

    // gateway-enabled app
    let mut app = common::spawn().await;
    let mut config = app.state.config.clone();
    config.gateway_enabled = true;
    config.gateway_host_keys_dir = Some(dir.path().to_path_buf());
    config.gateway_login_grace = Duration::from_secs(30);
    config.ssh_target_host = "127.0.0.1".to_string();
    config.ssh_logs_path = dir.path().join("ssh-gateway.log");
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    let token = app.login("admin", "pw").await;
    let uid = app.get("/api/auth/user/profile", Some(&token)).await.json["id"].as_i64().unwrap();

    // tunnel owned by admin with the device key; user key for admin
    let reverse_port = free_port() as i64;
    let tunnel = db::tunnels::create(
        &app.state.db,
        db::tunnels::NewTunnel { user_id: uid, host_friendly_name: "box", key: &device_pub, reverse_port, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    app.post("/api/reverse/user/keys", Some(&token), json!({"host_friendly_name": "laptop", "key": user_pub})).await;

    let gw = app.state.gateway.clone();
    assert_eq!(gw.host_keys_loaded, 1);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gw_port = listener.local_addr().unwrap().port();
    let _accept = gateway::start(gw.clone(), listener).unwrap();
    assert!(app.state.status.listen_ports().is_some(), "gateway publishes an (empty) live port set immediately");

    let echo_port = echo_server().await;

    // real OpenSSH client: ssh -NR *:<reverse_port>:127.0.0.1:<echo> telepy@gateway
    let mut ssh = Command::new("ssh")
        .args([
            "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=5", "-o", "LogLevel=ERROR",
            "-i", device_key.to_str().unwrap(), "-p", &gw_port.to_string(),
            "-R", &format!("*:{reverse_port}:127.0.0.1:{echo_port}"), "telepy@127.0.0.1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let registered = wait_until(Duration::from_secs(15), || app.state.status.listen_ports().map(|p| p.contains(&(reverse_port as u16))).unwrap_or(false)).await;
    if !registered {
        let mut err = String::new();
        if let Some(mut e) = ssh.stderr.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), e.read_to_string(&mut err)).await;
        }
        panic!("forward never registered; ssh stderr: {err}");
    }
    assert_eq!(gw.active_ports(), vec![reverse_port as u16]);

    // 1) loopback listener → forwarded-tcpip → ssh client → echo server
    let mut tcp = TcpStream::connect(("127.0.0.1", reverse_port as u16)).await.unwrap();
    let mut banner = [0u8; 14];
    tokio::time::timeout(Duration::from_secs(5), tcp.read_exact(&mut banner)).await.unwrap().unwrap();
    assert_eq!(&banner, b"SSH-2.0-echo\r\n");
    tcp.write_all(b"ping-through-tunnel").await.unwrap();
    let mut back = [0u8; 19];
    tokio::time::timeout(Duration::from_secs(5), tcp.read_exact(&mut back)).await.unwrap().unwrap();
    assert_eq!(&back, b"ping-through-tunnel");
    drop(tcp);

    // 2) latency probe reads the banner through a fresh forwarded channel
    let lat = gw.probe_latency().await;
    assert!(lat.contains_key(&(reverse_port as u16)), "{lat:?}");
    assert!(app.state.status.latency().unwrap().get(&(reverse_port as u16)).unwrap() < &4000.0);

    // 3) monitor cycle sees the port online (two cycles for the debounce)
    let mut runner = telepy_server::monitor::runner::Runner::default();
    telepy_server::monitor::runner::cycle(&app.state, &mut runner).await.unwrap();
    telepy_server::monitor::runner::cycle(&app.state, &mut runner).await.unwrap();
    assert_eq!(app.state.status.committed_ports().get(&reverse_port), Some(&true));
    let r = app.get("/api/reverse/server/dashboard", Some(&token)).await;
    assert_eq!(r.json["ports"][reverse_port.to_string()], true);

    // 4) direct-tcpip with the user's key (what the generated ssh config's ProxyCommand does)
    {
        let key = Arc::new(russh::keys::load_secret_key(&user_key, None).unwrap());
        let cfg = Arc::new(russh::client::Config::default());
        let mut h = russh::client::connect(cfg.clone(), ("127.0.0.1", gw_port), telepy_server::ssh::device::ClientHandler).await.unwrap();
        let ok = h.authenticate_publickey("telepy", russh::keys::PrivateKeyWithHashAlg::new(key, None)).await.unwrap();
        assert!(ok.success(), "user key must authenticate");
        let ch = h.channel_open_direct_tcpip("localhost", reverse_port as u32, "127.0.0.1", 0).await.unwrap();
        let mut s = ch.into_stream();
        let mut banner = [0u8; 14];
        tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut banner)).await.unwrap().unwrap();
        assert_eq!(&banner, b"SSH-2.0-echo\r\n");
        s.write_all(b"direct").await.unwrap();
        let mut back = [0u8; 6];
        tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut back)).await.unwrap().unwrap();
        assert_eq!(&back, b"direct");
        // a port nobody forwards is refused
        assert!(h.channel_open_direct_tcpip("localhost", 1, "127.0.0.1", 0).await.is_err());
        // session channels (shell) are refused
        assert!(h.channel_open_session().await.is_err());
    }

    // 5) unknown key is rejected; wrong user is rejected
    {
        let key = Arc::new(russh::keys::load_secret_key(dir.path().join("stranger_key"), None).unwrap());
        let cfg = Arc::new(russh::client::Config::default());
        let mut h = russh::client::connect(cfg, ("127.0.0.1", gw_port), telepy_server::ssh::device::ClientHandler).await.unwrap();
        let res = h.authenticate_publickey("telepy", russh::keys::PrivateKeyWithHashAlg::new(key, None)).await.unwrap();
        assert!(!res.success());
    }

    // 6) killing the client releases the forward and the port goes offline
    ssh.kill().await.unwrap();
    let released = wait_until(Duration::from_secs(15), || app.state.status.listen_ports().map(|p| !p.contains(&(reverse_port as u16))).unwrap_or(false)).await;
    assert!(released, "forward must be released when the client disconnects");
    assert!(TcpStream::connect(("127.0.0.1", reverse_port as u16)).await.is_err(), "loopback listener must be closed");

    // 7) sshd-style log lines for the Logs page
    tokio::time::sleep(Duration::from_millis(300)).await;
    let log = std::fs::read_to_string(dir.path().join("ssh-gateway.log")).unwrap();
    assert!(log.contains("Accepted publickey for telepy from 127.0.0.1"), "{log}");
    assert!(log.contains(&format!("Remote forward registered on port {reverse_port}")), "{log}");
    assert!(log.contains("Disconnected from user telepy"), "{log}");
    let r = app.get("/api/log/ssh", Some(&token)).await;
    assert!(r.json.as_str().unwrap().contains("Accepted publickey"));
    let _ = tunnel;
}
