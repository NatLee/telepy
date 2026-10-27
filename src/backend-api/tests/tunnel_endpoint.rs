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

    // gateway 看到的是 loopback（不是公網）：不算裝置的公網 IP，也不會警示。/ A loopback peer is not a public IP.
    let changes = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM telepy_gateway_event WHERE event = 'ip_changed' AND tunnel_id = ?").bind(t.id).fetch_one(&lab.app.state.db.read).await.unwrap()
    };
    let mut ssh = tunnel_ssh(&lab, &dev.key, port, &boxm);
    wait_for("forward again", async || status.listen_ports().is_some_and(|p| p.contains(&port))).await;
    wait_for("endpoint live", async || endpoint(&lab, &alice.token, t.id).await["live"] == true).await;
    let now = endpoint(&lab, &alice.token, t.id).await;
    assert!(now["public_ip"].is_null(), "{now}");
    assert_eq!(changes().await, 0);

    // 裝置回報的公網 IP（device_info 做的事）：第一次不算換；換了就保留舊的、寫 `ip_changed`、通知擁有者與
    // ADMIN（VIEW 不收）；同一個再回報不算換。
    // Public IPs reported by the device: the first is no change; a different one keeps the old, logs and alerts.
    let at = telepy_server::util::now_db();
    let db_ = &lab.app.state.db;
    assert_eq!(db::tunnel_endpoints::update_public_ip(db_, t.id, "198.51.100.20", "device", &at).await.unwrap(), None);
    let mut alice_rx = lab.app.state.hub.subscribe_user(alice.id);
    let mut dave_rx = lab.app.state.hub.subscribe_user(dave.id);
    let mut bob_rx = lab.app.state.hub.subscribe_user(bob.id);
    let ch = db::tunnel_endpoints::update_public_ip(db_, t.id, "203.0.113.9", "device", &at).await.unwrap().expect("a change");
    assert_eq!(ch.previous, "198.51.100.20");
    lab.app.state.gateway.announce_ip_change(port, &ch, "203.0.113.9", None).await;
    for rx in [&mut alice_rx, &mut dave_rx] {
        let msg: Value = serde_json::from_str(&rx.try_recv().expect("ip change notification")).unwrap();
        assert_eq!(msg["message"]["action"], "TUNNEL-IP-CHANGED", "{msg}");
        assert_eq!(msg["message"]["tunnel_id"], t.id);
        assert_eq!(msg["message"]["ip"], "203.0.113.9");
        assert_eq!(msg["message"]["previous_ip"], "198.51.100.20");
    }
    assert!(bob_rx.try_recv().is_err(), "VIEW sharees are not alerted");
    assert_eq!(changes().await, 1);
    assert_eq!(db::tunnel_endpoints::update_public_ip(db_, t.id, "203.0.113.9", "device", &at).await.unwrap(), None);

    // 裝置回報的 hostname / 內網網卡，以及「這次連線已經問過」。/ Reported hostname / LAN, and "already asked".
    let lan = r#"[{"iface":"eth0","ip":"192.168.1.23","prefix":24}]"#;
    db::tunnel_endpoints::record_probe(db_, t.id, Some("box"), Some(lan), None, None, &telepy_server::util::now_db()).await.unwrap();
    let now = endpoint(&lab, &alice.token, t.id).await;
    assert_eq!(now["ip"], "127.0.0.1", "{now}");
    assert_eq!(now["public_ip"], "203.0.113.9");
    assert_eq!(now["public_source"], "device");
    assert_eq!(now["public_geo"]["scope"], "public");
    assert_eq!(now["previous_ip"], "198.51.100.20");
    assert!(now["changed_at"].as_str().unwrap().ends_with('Z'), "{now}");
    assert_eq!(now["hostname"], "box");
    assert_eq!(now["lan"][0]["ip"], "192.168.1.23");
    assert!(now["probed_at"].as_str().unwrap().ends_with('Z'));
    let due = db::tunnel_endpoints::probe_due(db_, "2000-01-01 00:00:00.000000").await.unwrap();
    assert!(!due.iter().any(|(id, _)| *id == t.id), "probed during this connection: {due:?}");
    // 只看狀態的 sharee 一樣拿不到。/ Status-only sharees still get nothing.
    assert_eq!(endpoint(&lab, &carol.token, t.id).await, Value::Null);
    ssh.kill().await.unwrap();

    // 刪隧道連同最後 IP 一起刪。/ Deleting the tunnel deletes its last IP.
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}", t.id), Some(&alice.token)).await;
    assert!(r.status.is_success(), "delete: {}", r.text);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_tunnel_endpoint WHERE tunnel_id = ?").bind(t.id).fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(left, 0);
}

/// 假的「Telepy 前面的代理 + 公網 IP 查詢服務」：`/api/whoami` 回 Docker bridge 位址（代理把來源換掉了），
/// `/ip` 回真正的公網 IP，`/junk` 回錯誤頁。/ A fake proxy whose whoami answers a Docker bridge address, plus a lookup.
async fn fake_upstream() -> u16 {
    use axum::routing::get;
    let app = axum::Router::new()
        .route("/api/whoami", get(|| async { "172.19.0.1\n" }))
        .route("/ip", get(|| async { "114.34.69.11\n" }))
        .route("/junk", get(|| async { "<html>rate limited</html>" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

/// Telepy 的 `/api/whoami` 看到的不是公網位址時（前面的代理 / Docker 換掉了來源，或裝置跟 Telepy 在同一個 NAT 後面），
/// 裝置改問站台設定的查詢網址；留空就不問。裝置是真的 `/bin/sh` + `curl`。
/// When Telepy's whoami only sees an internal address, the device asks the site's lookup URL (blank = never).
#[tokio::test]
async fn device_asks_the_lookup_when_whoami_sees_an_internal_address() {
    let upstream = fake_upstream().await;
    let Some(lab) = Lab::start_with(|c| c.public_url = Some(format!("http://127.0.0.1:{upstream}"))).await else { return };
    let alice = lab.user("alice").await;
    let opts = common::lab::MachineOpts { shell: true, ..Default::default() };
    let boxm = lab.machine_with("box", &[("pi", &[&lab.service])], opts).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "pi").await;
    let state = &lab.app.state;
    let tunnel = db::tunnels::by_id(&state.db, dev.tunnel_id).await.unwrap().unwrap();
    wait_for("endpoint row", async || endpoint(&lab, &alice.token, dev.tunnel_id).await.is_object()).await;

    // 預設是 ipify；測試裡改成本機的假服務，不連外。/ Defaults to ipify; the test points it at the local fake.
    let settings = "/api/site/settings";
    let r = lab.app.get(settings, Some(&lab.admin_token)).await;
    assert_eq!(r.json["values"]["device_ip_lookup_url"], "https://api.ipify.org", "{}", r.text);
    assert_eq!(r.json["meta"]["device_ip_lookup_url"]["type"], "url");
    // 網址會放進裝置上的 shell 指令：引號、$()、cmd.exe 的 %VAR% 都不收。/ Shell-unsafe URLs are refused.
    for bad in ["https://x.example/$(id)", "https://x.example/'; reboot", "https://x.example/%PATH%"] {
        let r = lab.app.post(settings, Some(&lab.admin_token), serde_json::json!({"device_ip_lookup_url": bad})).await;
        assert_eq!(r.status, 400, "{bad}: {}", r.text);
        assert!(r.json["device_ip_lookup_url"][0].as_str().unwrap().contains("Use only"), "{}", r.text);
    }

    let set = async |url: &str| {
        let r = lab.app.post(settings, Some(&lab.admin_token), serde_json::json!({"device_ip_lookup_url": url})).await;
        assert!(r.status.is_success(), "{url}: {}", r.text);
    };

    // 留空：whoami 只看到 172.19.0.1，不算公網，也不問第三方。/ Blank: no public IP, no third party asked.
    set("").await;
    let info = telepy_server::device_info::probe(state, &tunnel, true).await.expect("probe");
    assert!(!info.lan.is_empty() || info.hostname.is_some(), "the real shell answered: {info:?}");
    assert_eq!(info.whoami_saw, Some("172.19.0.1".parse().unwrap()));
    assert_eq!((info.public_ip, info.public_source), (None, None));

    // 查詢服務回錯誤頁：一樣不知道。/ A junk answer: still unknown.
    set(&format!("http://127.0.0.1:{upstream}/junk")).await;
    assert_eq!(telepy_server::device_info::probe(state, &tunnel, true).await.unwrap().public_ip, None);

    // 設了查詢網址：裝置問它，拿到真正的公網 IP。/ With a lookup URL the device gets its real public IP.
    set(&format!("http://127.0.0.1:{upstream}/ip")).await;
    let info = telepy_server::device_info::probe(state, &tunnel, true).await.unwrap();
    assert_eq!(info.public_ip, Some("114.34.69.11".parse().unwrap()), "{info:?}");
    assert_eq!(info.public_source, Some(telepy_server::device_info::SOURCE_LOOKUP));
    // gateway 已經看到公網來源時整段都不問。/ Nothing is asked when the gateway already sees a public peer.
    let info = telepy_server::device_info::probe(state, &tunnel, false).await.unwrap();
    assert_eq!((info.public_ip, info.whoami_saw), (None, None));

    // 存進 endpoint：列表上是外網 IP + 來源 lookup，內網網卡也在。/ Stored: the list shows it with source "lookup".
    telepy_server::device_info::probe_and_store(state, dev.tunnel_id, dev.reverse_port, false).await;
    let e = endpoint(&lab, &alice.token, dev.tunnel_id).await;
    assert_eq!(e["ip"], "127.0.0.1", "the gateway still sees loopback: {e}");
    assert_eq!(e["public_ip"], "114.34.69.11", "{e}");
    assert_eq!(e["public_source"], "lookup");
    assert_eq!(e["public_geo"]["scope"], "public");
    assert!(e["probe_error"].is_null(), "{e}");
    assert!(e["probed_at"].is_string(), "{e}");
    // 同一個腳本也讀了裝置的基本狀況。/ The same script read the device facts.
    assert!(e["facts"]["kernel"].is_string(), "{e}");
    assert!(e["facts_at"].is_string(), "{e}");
}

/// 裝置的基本狀況：跟位址同一個唯讀腳本（真的 `/bin/sh`），存在 endpoint 上、單筆 retrieve 也帶；「立即重新整理」
/// 只給 owner / ADMIN、每分鐘一次、離線是 409；新的警示每條隧道每種 24 小時只發一次（Logs + 通知 owner / ADMIN）。
/// Device facts come from the same read-only script (a real `/bin/sh`), are stored on the endpoint and served by the
/// single retrieve; "Refresh now" is owner / ADMIN only, once a minute, 409 when offline; alerts are de-duplicated.
#[tokio::test]
async fn device_facts_and_refresh_now() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let bob = lab.user("bob").await; // VIEW + pi: sees the facts, cannot refresh
    let carol = lab.user("carol").await; // EDIT without accounts: no facts
    let opts = common::lab::MachineOpts { shell: true, ..Default::default() };
    let boxm = lab.machine_with("box", &[("pi", &[&lab.service])], opts).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let pi = lab.username(&alice, &dev, "pi").await;
    lab.share(&alice, &dev, &bob, "view", &[pi]).await;
    lab.share(&alice, &dev, &carol, "edit", &[]).await;
    let state = &lab.app.state;
    wait_for("endpoint row", async || endpoint(&lab, &alice.token, dev.tunnel_id).await.is_object()).await;
    let path = format!("/api/reverse/server/{}/probe", dev.tunnel_id);

    // VIEW / EDIT 不能叫裝置跑腳本。/ VIEW and EDIT sharees cannot make the device run the script.
    for u in [&bob, &carol] {
        let r = lab.app.post(&path, Some(&u.token), serde_json::json!({})).await;
        assert_eq!(r.status, 403, "{}", r.text);
    }

    let mut bob_rx = state.hub.subscribe_user(bob.id);
    let r = lab.app.post(&path, Some(&alice.token), serde_json::json!({})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    let facts = &r.json["facts"];
    assert!(r.json["probe_error"].is_null(), "{}", r.text);
    assert!(facts["kernel"].is_string() && facts["os"].is_string(), "uname answered: {facts}");
    assert!(facts["disk_total_kb"].as_u64().unwrap_or(0) > 0, "df answered: {facts}");
    assert!(facts["warnings"].is_array(), "{facts}");
    assert!(r.json["facts_at"].as_str().unwrap().ends_with('Z'), "{}", r.text);
    let mut got = false;
    while let Ok(m) = bob_rx.try_recv() {
        got |= m.contains("DEVICE-FACTS-UPDATED");
    }
    assert!(got, "the tunnel audience is told to refetch");

    // 每分鐘一次。/ Once a minute.
    let r = lab.app.post(&path, Some(&alice.token), serde_json::json!({})).await;
    assert_eq!(r.status, 429, "{}", r.text);
    assert_eq!(r.json["code"], "too_soon");
    assert!(r.json["retry_after"].as_u64().unwrap() >= 1);

    // 列表與單筆 retrieve 都帶，看得到的人同 `endpoint`。/ List and retrieve carry them for the same viewers.
    assert_eq!(endpoint(&lab, &bob.token, dev.tunnel_id).await["facts"]["kernel"], facts["kernel"]);
    let single = |token: String| {
        let path = format!("/api/reverse/server/keys/{}", dev.tunnel_id);
        let app = &lab.app;
        async move { app.get(&path, Some(&token)).await.json }
    };
    assert_eq!(single(alice.token.clone()).await["endpoint"]["facts"]["os"], facts["os"]);
    assert!(single(carol.token.clone()).await["endpoint"].is_null());

    // 警示：Logs 一筆、owner 收到通知、VIEW 不收；24 小時內同一種不再發。用另一條還沒讀過的隧道（上面真的讀過的
    // 那台可能真的磁碟快滿，已經發過）。/ Alerts on a second, never-read tunnel (the real machine above may really be short on disk).
    let key2 = lab.keygen("box2-tunnel");
    let port2 = free_port();
    let t2 = db::tunnels::create(
        &state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "box2", key: &key2.public, reverse_port: port2 as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let dev2 = Device { tunnel_id: t2.id, name: "box2".into(), reverse_port: port2, target: boxm.clone(), key: key2 };
    let pi2 = lab.username(&alice, &dev2, "pi").await;
    lab.share(&alice, &dev2, &bob, "view", &[pi2]).await;
    let tunnel = db::tunnels::by_id(&state.db, dev2.tunnel_id).await.unwrap().unwrap();
    let low = telepy_server::device_facts::parse_facts("disk_total_kb=10000000\ndisk_avail_kb=100000\nreboot=1\n");
    assert_eq!(low.warnings.len(), 2);
    let mut alice_rx = state.hub.subscribe_user(alice.id);
    let mut bob_rx = state.hub.subscribe_user(bob.id);
    let warned = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM telepy_gateway_event WHERE event = 'device_warning' AND tunnel_id = ?").bind(dev2.tunnel_id).fetch_one(&state.db.read).await.unwrap()
    };
    telepy_server::device_info::announce(state, &tunnel, dev2.reverse_port, &low).await;
    assert_eq!(warned().await, 2);
    let mut seen = Vec::new();
    while let Ok(m) = alice_rx.try_recv() {
        seen.push(m);
    }
    assert!(seen.iter().any(|m| m.contains("DEVICE-WARNING") && m.contains("\"disk\"") && m.contains("\"reboot\"")), "{seen:?}");
    while let Ok(m) = bob_rx.try_recv() {
        assert!(!m.contains("DEVICE-WARNING"), "VIEW sharees get no alert: {m}");
    }
    telepy_server::device_info::announce(state, &tunnel, dev2.reverse_port, &low).await;
    assert_eq!(warned().await, 2, "once per kind per 24 h");

    // 離線：409。/ Offline: 409.
    lab.disconnect_device(&dev).await;
    let status = state.status.clone();
    wait_for("forward released", async || !status.listen_ports().is_some_and(|p| p.contains(&dev.reverse_port))).await;
    let r = lab.app.post(&path, Some(&alice.token), serde_json::json!({})).await;
    assert_eq!(r.status, 409, "{}", r.text);
    assert_eq!(r.json["code"], "device_offline");
}
