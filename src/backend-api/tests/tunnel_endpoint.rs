//! 隧道列表的 `endpoint`（裝置的公網 IP）：連著時是 gateway 看到的來源、斷線後是最後一次的紀錄；
//! 只給能登入裝置的人看（owner / ADMIN / 有允許帳號的 sharee），只看狀態的 sharee 拿到 null。
//! The tunnel list's `endpoint`: the gateway's view of the device's source address while connected, the
//! last recorded one afterwards; hidden (null) from status-only sharees.
mod common;

use std::process::Stdio;
use std::time::Duration;

use common::lab::{free_port, Device, Lab, LabKey, Machine};
use serde_json::Value;
use telepy_server::db;
use tokio::process::{Child, Command};

/// 裝置的 `ssh -NR`（自己起，才能在測試中途斷線）。/ The device's tunnel, owned by the test so it can drop it.
fn tunnel_ssh(lab: &Lab, key: &LabKey, reverse_port: u16, target: &Machine) -> Child {
    Command::new("ssh")
        .args(["-F", "/dev/null", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
        .args(["-o", "ExitOnForwardFailure=yes", "-o", "LogLevel=ERROR", "-i"])
        .arg(&key.path)
        .args(["-p", &lab.gw_port.to_string(), "-R", &format!("*:{reverse_port}:127.0.0.1:{}", target.port), "telepy@127.0.0.1"])
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

async fn endpoint(lab: &Lab, token: &str, tunnel_id: i64) -> Value {
    let r = lab.app.get("/api/reverse/server/dashboard", Some(token)).await;
    assert!(r.status.is_success(), "dashboard: {}", r.text);
    let tunnels = r.json["tunnels"].as_array().unwrap();
    let t = tunnels.iter().find(|t| t["id"] == tunnel_id).unwrap_or_else(|| panic!("tunnel {tunnel_id} not listed: {}", r.text));
    t["endpoint"].clone()
}

#[tokio::test]
async fn device_ip_on_the_tunnel_list() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let bob = lab.user("bob").await; // VIEW + ubuntu: can log in → sees the IP
    let carol = lab.user("carol").await; // EDIT without accounts: status only
    let dave = lab.user("dave").await; // ADMIN: gets IP-change alerts
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let key = lab.keygen("box-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "box", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let dev = Device { tunnel_id: t.id, name: "box".into(), reverse_port: port, target: boxm.clone(), key };
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "edit", &[]).await;
    lab.share(&alice, &dev, &dave, "admin", &[]).await;

    // 從沒連過：沒有資料。/ Never connected.
    assert_eq!(endpoint(&lab, &alice.token, t.id).await, Value::Null);

    let mut ssh = tunnel_ssh(&lab, &dev.key, port, &boxm);
    let status = lab.app.state.status.clone();
    wait_for("forward", async || status.listen_ports().is_some_and(|p| p.contains(&port))).await;

    let e = endpoint(&lab, &alice.token, t.id).await;
    assert_eq!(e["ip"], "127.0.0.1", "{e}");
    assert_eq!(e["live"], true);
    assert!(e["connected_at"].as_str().unwrap().ends_with('Z'), "{e}");
    assert!(e["last_seen_at"].is_null());
    // 沒有 GeoIP 資料庫時只知道位址範圍；第一次連線不算換 IP。/ Scope only without GeoIP data; a first connect is no change.
    assert_eq!(e["geo"]["scope"], "loopback", "{e}");
    assert!(e["geo"]["country"].is_null());
    assert!(e["previous_ip"].is_null() && e["changed_at"].is_null(), "{e}");
    assert_eq!(endpoint(&lab, &bob.token, t.id).await["ip"], "127.0.0.1");
    assert_eq!(endpoint(&lab, &carol.token, t.id).await, Value::Null);
    // `/keys` 列表也帶；單筆 retrieve 不帶。/ The plain list carries it too.
    let r = lab.app.get("/api/reverse/server/keys", Some(&alice.token)).await;
    assert_eq!(r.json.as_array().unwrap().iter().find(|x| x["id"] == t.id).unwrap()["endpoint"]["ip"], "127.0.0.1");

    // 斷線：最後已知 IP + 最後看到的時間。/ Offline: last known IP and when it was last seen.
    ssh.kill().await.unwrap();
    wait_for("forward released", async || !status.listen_ports().is_some_and(|p| p.contains(&port))).await;
    let mut last = Value::Null;
    wait_for("release recorded", async || {
        last = endpoint(&lab, &alice.token, t.id).await;
        last["live"] == false && last["last_seen_at"].is_string()
    })
    .await;
    assert_eq!(last["ip"], "127.0.0.1", "{last}");
    assert!(last["last_seen_at"].as_str().unwrap() >= last["connected_at"].as_str().unwrap(), "{last}");
    assert_eq!(endpoint(&lab, &carol.token, t.id).await, Value::Null);

    // 從別的 IP 連回來：記下舊的、寫 `ip_changed`、通知擁有者與 ADMIN（VIEW 不收）。
    // Back from another address: the old one is kept, `ip_changed` is logged, owner and ADMIN are told (not VIEW).
    sqlx::query("UPDATE telepy_tunnel_endpoint SET ip = '198.51.100.20' WHERE tunnel_id = ?").bind(t.id).execute(&lab.app.state.db.write).await.unwrap();
    let mut alice_rx = lab.app.state.hub.subscribe_user(alice.id);
    let mut dave_rx = lab.app.state.hub.subscribe_user(dave.id);
    let mut bob_rx = lab.app.state.hub.subscribe_user(bob.id);
    let mut ssh = tunnel_ssh(&lab, &dev.key, port, &boxm);
    wait_for("forward again", async || status.listen_ports().is_some_and(|p| p.contains(&port))).await;
    let mut now = Value::Null;
    wait_for("change recorded", async || {
        now = endpoint(&lab, &alice.token, t.id).await;
        now["live"] == true && now["previous_ip"] == "198.51.100.20"
    })
    .await;
    assert_eq!(now["ip"], "127.0.0.1", "{now}");
    assert!(now["changed_at"].as_str().unwrap().ends_with('Z'), "{now}");
    for rx in [&mut alice_rx, &mut dave_rx] {
        let msg: Value = serde_json::from_str(&rx.try_recv().expect("ip change notification")).unwrap();
        assert_eq!(msg["message"]["action"], "TUNNEL-IP-CHANGED", "{msg}");
        assert_eq!(msg["message"]["tunnel_id"], t.id);
        assert_eq!(msg["message"]["ip"], "127.0.0.1");
        assert_eq!(msg["message"]["previous_ip"], "198.51.100.20");
    }
    assert!(bob_rx.try_recv().is_err(), "VIEW sharees are not alerted");
    let changes = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM telepy_gateway_event WHERE event = 'ip_changed' AND tunnel_id = ?").bind(t.id).fetch_one(&lab.app.state.db.read).await.unwrap()
    };
    assert_eq!(changes().await, 1);
    // 同一個 IP 再連一次不算換。/ Reconnecting from the same address is not a change.
    ssh.kill().await.unwrap();
    wait_for("released again", async || !status.listen_ports().is_some_and(|p| p.contains(&port))).await;
    let mut ssh = tunnel_ssh(&lab, &dev.key, port, &boxm);
    wait_for("forward third time", async || status.listen_ports().is_some_and(|p| p.contains(&port))).await;
    wait_for("endpoint live", async || endpoint(&lab, &alice.token, t.id).await["live"] == true).await;
    assert_eq!(changes().await, 1);
    ssh.kill().await.unwrap();

    // 刪隧道連同最後 IP 一起刪。/ Deleting the tunnel deletes its last IP.
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}", t.id), Some(&alice.token)).await;
    assert!(r.status.is_success(), "delete: {}", r.text);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_tunnel_endpoint WHERE tunnel_id = ?").bind(t.id).fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(left, 0);
}
