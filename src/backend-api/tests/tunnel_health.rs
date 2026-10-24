//! 隧道健康狀態：從沒連過 = never；forward 在、經由隧道讀得到 sshd = online；forward 在但連續探測失敗 =
//! degraded（並寫 degraded / recovered 事件）；斷線後 = offline，附最後連線時間。所有看得到隧道的人都拿得到。
//! Tunnel health on the list: never → online → degraded (forward up, nothing answers behind it) → recovered →
//! offline with last_seen_at; visible to every viewer, including status-only sharees.
mod common;

use std::process::Stdio;
use std::time::Duration;

use common::lab::{free_port, Lab, LabKey};
use serde_json::Value;
use telepy_server::db;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

/// 裝置的 `ssh -NR`，forward 到本機的 `target_port`（可以是沒人在聽的 port）。
/// The device's tunnel, forwarding to a local port that may have nothing listening.
fn tunnel_ssh(lab: &Lab, key: &LabKey, reverse_port: u16, target_port: u16) -> Child {
    Command::new("ssh")
        .args(["-F", "/dev/null", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
        .args(["-o", "ExitOnForwardFailure=yes", "-o", "LogLevel=ERROR", "-i"])
        .arg(&key.path)
        .args(["-p", &lab.gw_port.to_string(), "-R", &format!("*:{reverse_port}:127.0.0.1:{target_port}"), "telepy@127.0.0.1"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

async fn wait_for(what: &str, mut cond: impl AsyncFnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !cond().await {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn item(lab: &Lab, token: &str, tunnel_id: i64) -> Value {
    let r = lab.app.get("/api/reverse/server/dashboard", Some(token)).await;
    assert!(r.status.is_success(), "dashboard: {}", r.text);
    r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == tunnel_id).cloned().unwrap_or_else(|| panic!("tunnel {tunnel_id} not listed: {}", r.text))
}

async fn events(lab: &Lab, tunnel_id: i64) -> Vec<String> {
    db::tunnels::recent_gateway_events(&lab.app.state.db, tunnel_id, 50).await.unwrap().into_iter().map(|(_, e, _)| e).collect()
}

#[tokio::test]
async fn health_on_the_tunnel_list() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let carol = lab.user("carol").await; // status-only sharee: still sees health and last_seen_at
    let key = lab.keygen("dev-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "dev", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let dev = common::lab::Device { tunnel_id: t.id, name: "dev".into(), reverse_port: port, target: lab.machine("unused", &[], false).await, key };
    lab.share(&alice, &dev, &carol, "edit", &[]).await;

    // 建好還沒連過。/ Created, never connected.
    let it = item(&lab, &alice.token, t.id).await;
    assert_eq!(it["health"], "never", "{it}");
    assert!(it["last_seen_at"].is_null());

    // forward 到一個沒人在聽的 port：forward 在，但讀不到 banner。/ Forward to a port nobody listens on.
    let target = free_port();
    let mut ssh = tunnel_ssh(&lab, &dev.key, port, target);
    let status = lab.app.state.status.clone();
    wait_for("forward", async || status.listen_ports().is_some_and(|p| p.contains(&port))).await;
    assert_eq!(item(&lab, &alice.token, t.id).await["health"], "online", "no failed probe yet");
    lab.app.state.gateway.probe_latency().await;
    assert_eq!(item(&lab, &alice.token, t.id).await["health"], "online", "one failed probe is not enough");
    lab.app.state.gateway.probe_latency().await;
    let it = item(&lab, &alice.token, t.id).await;
    assert_eq!(it["health"], "degraded", "{it}");
    assert!(it["last_seen_at"].is_null(), "connected tunnels have no last_seen_at");
    assert_eq!(item(&lab, &carol.token, t.id).await["health"], "degraded");
    assert!(events(&lab, t.id).await.contains(&"degraded".to_string()));

    // 有東西開始回應：恢復。/ Something answers again: recovered.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", target)).await.unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            let _ = s.write_all(b"SSH-2.0-lab\r\n").await;
        }
    });
    lab.app.state.gateway.probe_latency().await;
    assert_eq!(item(&lab, &alice.token, t.id).await["health"], "online");
    assert!(events(&lab, t.id).await.contains(&"recovered".to_string()));

    // 斷線：offline + 最後連線時間（只看狀態的 sharee 也有，但沒有 IP）。/ Offline with last_seen_at.
    ssh.kill().await.unwrap();
    wait_for("forward released", async || !status.listen_ports().is_some_and(|p| p.contains(&port))).await;
    let mut it = Value::Null;
    wait_for("last seen recorded", async || {
        it = item(&lab, &carol.token, t.id).await;
        it["health"] == "offline" && it["last_seen_at"].is_string()
    })
    .await;
    assert!(it["last_seen_at"].as_str().unwrap().ends_with('Z'), "{it}");
    assert!(it["endpoint"].is_null(), "status-only sharees still get no IP");
}
