//! gateway 前面有 L4 代理（PROXY protocol）：列出的代理送來的 header 決定裝置的來源 IP；
//! 沒送 header 就拒絕（記 `refused_proxy`）；只連上就斷（健康檢查）不記事件。
//! The gateway behind an L4 proxy: a listed proxy's header sets the device's source IP; no header is
//! refused (logged as `refused_proxy`); a bare connect-and-close (health check) is not logged.
mod common;

use std::process::Stdio;
use std::time::Duration;

use common::lab::{free_port, Lab};
use serde_json::Value;
use telepy_server::db;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;

/// 最小的 L4 代理：每條連線先送 v1 header（假裝來源是 203.0.113.50），之後原樣轉送。
/// A minimal L4 proxy that prepends a v1 header claiming the client is 203.0.113.50.
async fn start_proxy(gw_port: u16) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut client, from)) = listener.accept().await {
            tokio::spawn(async move {
                let mut upstream = TcpStream::connect(("127.0.0.1", gw_port)).await.unwrap();
                let header = format!("PROXY TCP4 203.0.113.50 127.0.0.1 {} {gw_port}\r\n", from.port());
                upstream.write_all(header.as_bytes()).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    port
}

async fn events(lab: &Lab, kind: &str) -> Vec<(Option<String>, String)> {
    sqlx::query_as("SELECT peer, message FROM telepy_gateway_event WHERE event = ? ORDER BY id").bind(kind).fetch_all(&lab.app.state.db.read).await.unwrap()
}

#[tokio::test]
async fn proxied_devices_get_the_address_from_the_header() {
    let Some(lab) = Lab::start_with(|c| c.gateway_proxy_protocol_from = "127.0.0.1".into()).await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let key = lab.keygen("box-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "box", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();

    let ssh = |gw: u16| {
        Command::new("ssh")
            .args(["-F", "/dev/null", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
            .args(["-o", "ExitOnForwardFailure=yes", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "-i"])
            .arg(&key.path)
            .args(["-p", &gw.to_string(), "-R", &format!("*:{port}:127.0.0.1:{}", boxm.port), "telepy@127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };

    // 直接連（沒有 header）：被拒絕並記事件。/ Direct, without a header: refused and logged.
    let mut direct = ssh(lab.gw_port);
    let status = tokio::time::timeout(Duration::from_secs(20), direct.wait()).await.expect("direct ssh should fail fast").unwrap();
    assert!(!status.success());
    let refused = events(&lab, "refused_proxy").await;
    assert_eq!(refused.len(), 1, "{refused:?}");
    assert!(refused[0].1.contains("no PROXY protocol header"), "{refused:?}");

    // 只連上就斷（代理的健康檢查）：不記事件。/ A bare connect-and-close is not logged.
    drop(TcpStream::connect(("127.0.0.1", lab.gw_port)).await.unwrap());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(events(&lab, "refused_proxy").await.len(), 1);

    // 經過代理：來源是 header 裡的位址。/ Through the proxy: the source comes from the header.
    let proxy = start_proxy(lab.gw_port).await;
    let _tunnel = ssh(proxy);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !lab.app.state.status.listen_ports().is_some_and(|p| p.contains(&port)) {
        assert!(tokio::time::Instant::now() < deadline, "forward never registered through the proxy");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    let e: Value = r.json["tunnels"].as_array().unwrap().iter().find(|x| x["id"] == t.id).unwrap()["endpoint"].clone();
    assert_eq!(e["ip"], "203.0.113.50", "{e}");
    assert_eq!(e["geo"]["scope"], "public");
    let accepted = events(&lab, "accepted").await;
    assert!(accepted.iter().any(|(peer, msg)| peer.as_deref().is_some_and(|p| p.starts_with("203.0.113.50:")) && msg.contains("from 203.0.113.50")), "{accepted:?}");
}
