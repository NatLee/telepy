//! 連線紀錄與在線率：forward 開一列、斷線關掉、重連再開一列；IP 只給能登入裝置的人；重啟時關掉還開著的；
//! 刪隧道一起刪。
//! Connection history and uptime: a row per forward, closed on release; IPs only for people who can log in;
//! rows left open are closed at startup; deleting the tunnel removes them.
mod common;

use std::process::Stdio;
use std::time::Duration;

use common::lab::{free_port, Device, Lab, LabKey};
use serde_json::Value;
use telepy_server::db;
use tokio::process::{Child, Command};

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

async fn history(lab: &Lab, token: &str, id: i64) -> Value {
    let r = lab.app.get(&format!("/api/reverse/server/{id}/connections"), Some(token)).await;
    assert!(r.status.is_success(), "connections: {}", r.text);
    r.json
}

#[tokio::test]
async fn connection_history_and_uptime() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let carol = lab.user("carol").await; // status-only sharee
    let mallory = lab.user("mallory").await;
    let key = lab.keygen("dev-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "dev", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let sshd = lab.machine("dev", &[], false).await;
    let dev = Device { tunnel_id: t.id, name: "dev".into(), reverse_port: port, target: sshd.clone(), key };
    lab.share(&alice, &dev, &carol, "edit", &[]).await;
    assert_eq!(lab.app.get(&format!("/api/reverse/server/{}/connections", t.id), Some(&mallory.token)).await.status.as_u16(), 404);

    // 沒有資料。/ No history yet.
    let h = history(&lab, &alice.token, t.id).await;
    assert!(h["tracked_since"].is_null() && h["uptime"]["h24"].is_null(), "{h}");
    assert_eq!(h["hourly"].as_array().unwrap().len(), 24);
    assert!(h["sessions"].as_array().unwrap().is_empty());

    // 連上：一列、還開著；IP 只給 owner。/ Connected: one open row; the IP only for the owner.
    let status = lab.app.state.status.clone();
    let mut ssh = tunnel_ssh(&lab, &dev.key, port, sshd.port);
    wait_for("forward", async || status.listen_ports().is_some_and(|p| p.contains(&port))).await;
    let mut h = Value::Null;
    wait_for("session recorded", async || {
        h = history(&lab, &alice.token, t.id).await;
        h["sessions"].as_array().unwrap().len() == 1
    })
    .await;
    let s = &h["sessions"][0];
    assert_eq!(s["ip"], "127.0.0.1", "{h}");
    assert!(s["disconnected_at"].is_null() && s["connected_at"].as_str().unwrap().ends_with('Z'));
    assert!(h["tracked_since"].is_string());
    // 在線率以秒計：等它累積超過一秒。/ Uptime is in whole seconds: let a couple accumulate.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let h = history(&lab, &alice.token, t.id).await;
    let up = h["uptime"]["h24"].as_f64().unwrap_or_else(|| panic!("{h}"));
    assert!(up > 0.9, "connected the whole time it has been tracked: {up}");
    assert!(history(&lab, &carol.token, t.id).await["sessions"][0]["ip"].is_null(), "status-only sharees get no IP");

    // 斷線：關掉；再連：第二列。/ Disconnect closes it; reconnecting opens a second row.
    ssh.kill().await.unwrap();
    wait_for("closed", async || history(&lab, &alice.token, t.id).await["sessions"][0]["disconnected_at"].is_string()).await;
    let _ssh = tunnel_ssh(&lab, &dev.key, port, sshd.port);
    wait_for("second session", async || history(&lab, &alice.token, t.id).await["sessions"].as_array().unwrap().len() == 2).await;
    let h = history(&lab, &alice.token, t.id).await;
    assert!(h["sessions"][0]["disconnected_at"].is_null(), "newest first, and it is open: {h}");
    assert!(h["sessions"][1]["seconds"].as_i64().unwrap() >= 0);
    // gateway 看到的是內部位址（這裡是 loopback）：裝置回報的公網 IP 記在開著的那一列，舊的那列不動；看不到 IP 的人也看不到它。
    // The peer is internal (loopback here): the device-reported public IP goes on the open row only, and people who
    // get no IP get none of it either.
    assert_eq!(h["sessions"][0]["geo"]["scope"], "loopback", "{h}");
    assert!(h["sessions"][0]["public_ip"].is_null());
    db::tunnel_sessions::set_public_ip(&lab.app.state.db, t.id, "203.0.113.7", "device").await.unwrap();
    let h = history(&lab, &alice.token, t.id).await;
    let (open, closed) = (&h["sessions"][0], &h["sessions"][1]);
    assert_eq!((open["ip"].as_str(), open["public_ip"].as_str(), open["public_source"].as_str()), (Some("127.0.0.1"), Some("203.0.113.7"), Some("device")), "{h}");
    assert_eq!(open["public_geo"]["scope"], "public");
    assert!(closed["public_ip"].is_null(), "an earlier connection keeps what it had: {h}");
    let c = history(&lab, &carol.token, t.id).await;
    assert!(c["sessions"][0]["public_ip"].is_null() && c["sessions"][0]["geo"].is_null(), "{c}");

    // 重啟：還開著的關掉。/ Startup closes rows left open.
    assert_eq!(db::tunnel_sessions::close_orphans(&lab.app.state.db).await.unwrap(), 1);
    assert!(history(&lab, &alice.token, t.id).await["sessions"][0]["disconnected_at"].is_string());

    // 刪隧道：紀錄一起刪。/ Deleting the tunnel removes its history.
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}", t.id), Some(&alice.token)).await;
    assert!(r.status.is_success(), "{}", r.text);
    assert!(db::tunnel_sessions::recent(&lab.app.state.db, t.id, 10).await.unwrap().is_empty());
}
