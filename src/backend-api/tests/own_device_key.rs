//! 自己的電腦既是裝置、也用同一把金鑰連別的裝置（SSH lab）：筆電先用自己的金鑰加入成一條隧道，之後把同一把金鑰
//! 加成個人金鑰——同一個人可以，別人不行；gateway 給這把金鑰兩個身分：forward 照隧道的規則（`-R 0` 還是落在
//! 自己的號碼），招呼與 direct-tcpip 照人的規則；金鑰 JSON 用 `device_of` 說它也是哪條隧道的裝置金鑰。
//! 反過來（個人金鑰拿來建隧道）也一樣只限自己的。
//! Your own computer is a device and reaches other devices with the same key: the laptop joins as a tunnel with its
//! key, then the same key is added as a personal key — by the same person only. The gateway gives that key both
//! roles: forwards follow the tunnel's rule (`-R 0` still lands on its own number), the greeting and direct-tcpip
//! the person's; the key's JSON names the tunnel in `device_of`. The other way round (a personal key as a new
//! tunnel's key) is limited to your own keys as well.
mod common;

use axum::http::StatusCode;
use common::lab::{Hop, Lab, LabUser};
use serde_json::json;

fn host_key_opts() -> Vec<String> {
    ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"].map(String::from).to_vec()
}

#[tokio::test]
async fn your_own_device_key_can_also_be_your_personal_key() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let laptop_key = lab.keygen("alice-mac");
    let work = lab.machine("work", &[("ann", &[&lab.service, &laptop_key])], false).await;
    let laptop_sshd = lab.machine("mac", &[("alice", &[&lab.service])], false).await;
    let work_dev = lab.device(&alice, "work", &work).await;
    lab.username(&alice, &work_dev, "ann").await;

    // 1) 筆電用它自己的金鑰變成一條隧道（精靈的路：貼上裝置公鑰）。/ The laptop becomes a tunnel with its own key.
    let issue = app.get("/api/reverse/issue/token", Some(&alice.token)).await.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/{issue}"), Some(&alice.token), json!({"host_friendly_name": "mac", "key": laptop_key.public})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let mac_id = r.json["id"].as_i64().unwrap();
    let mac_port = u16::try_from(r.json["reverse_port"].as_i64().unwrap()).unwrap();
    let tunnel = lab.spawn_tunnel_requesting(&laptop_key, 0, mac_port, laptop_sshd.port, "mac", lab.gw_port, &host_key_opts()).await;

    // 2) 還只是裝置的金鑰：連不到別的裝置。/ Only a device key so far: it cannot reach another device.
    let as_mac = LabUser { id: alice.id, username: alice.username.clone(), token: alice.token.clone(), key: laptop_key.clone() };
    let r = lab.laptop_exec(&as_mac, &[(Hop::Tunnel(&work_dev), "ann")], "whereami").await;
    assert!(!r.ok, "a device key alone must not reach other devices: {r:?}");
    assert!(!work.any_login_with(&laptop_key));

    // 3) 別人不能把它加成個人金鑰。/ Nobody else may add it as their personal key.
    let r = app.post("/api/reverse/user/keys", Some(&bob.token), json!({"host_friendly_name": "not-mine", "key": laptop_key.public})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["key"][0].as_str().unwrap().contains("already used by a tunnel"), "{}", r.text);

    // 4) 擁有者可以，金鑰 JSON 說它也是 mac 的裝置金鑰。/ The owner may; the key says it is also mac's device key.
    let r = app.post("/api/reverse/user/keys", Some(&alice.token), json!({"host_friendly_name": "mac-key", "key": laptop_key.public})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["device_of"], json!([{ "id": mac_id, "name": "mac" }]), "{}", r.text);
    let list = app.get("/api/reverse/user/keys", Some(&alice.token)).await;
    let rows = list.json.as_array().unwrap();
    assert_eq!(rows.iter().find(|k| k["host_friendly_name"] == "mac-key").unwrap()["device_of"][0]["name"], "mac");
    assert_eq!(rows.iter().find(|k| k["host_friendly_name"] == "alice-laptop").unwrap()["device_of"], json!([]));

    // 5) 同一把金鑰現在以 alice 的身分連到 work；mac 的隧道還在。/ The same key now reaches work as alice; mac stays up.
    let r = lab.laptop_exec(&as_mac, &[(Hop::Tunnel(&work_dev), "ann")], "whereami").await;
    assert_eq!(r.stdout, "ann@work", "{r:?}");
    // 用名稱連（產生的 ssh config 的寫法）也一樣。/ By name too, as the generated ssh config does.
    let r = lab.ssh_with_config(&lab.laptop_config_named(&as_mac, &work_dev, "ann"), "hop0", "whereami").await;
    assert_eq!(r.stdout, "ann@work", "{r:?}");
    assert!(work.logged_in("ann", &laptop_key));
    assert!(app.state.status.listen_ports().unwrap_or_default().contains(&mac_port));
    let r = app.get("/api/reverse/user/keys", Some(&alice.token)).await;
    assert!(r.json.as_array().unwrap().iter().any(|k| k["host_friendly_name"] == "mac-key" && !k["last_used_at"].is_null()), "the personal role records its use: {}", r.text);

    // 6) 重新連上（現在兩個身分）：`-R 0` 還是落在 mac 自己的號碼。/ Reconnected with both roles: `-R 0` still lands on mac's number.
    drop(tunnel);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while app.state.status.listen_ports().unwrap_or_default().contains(&mac_port) {
        assert!(tokio::time::Instant::now() < deadline, "mac's forward was never released");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let _tunnel = lab.spawn_tunnel_requesting(&laptop_key, 0, mac_port, laptop_sshd.port, "mac", lab.gw_port, &host_key_opts()).await;
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={mac_id}"), Some(&alice.token)).await;
    let forwards = r.json.as_array().unwrap().iter().filter(|e| e["event"] == "forward" && e["port"].as_u64() == Some(u64::from(mac_port))).count();
    assert_eq!(forwards, 2, "{}", r.text);
    assert!(r.text.contains(&format!("(tunnel {mac_id}, user {})", alice.id)), "the disconnect names both roles: {}", r.text);

    // 7) 直接 ssh 進 gateway：拿到招呼（人的身分），看得到 work。/ Straight into the gateway: the person's greeting, listing work.
    let out = tokio::process::Command::new("ssh")
        .args(["-F", "/dev/null", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "LogLevel=ERROR", "-i"])
        .arg(&laptop_key.path)
        .args(["-p", &lab.gw_port.to_string(), "telepy@127.0.0.1", "hello"])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{text}");
    assert!(text.contains("work") && text.contains("alice"), "{text}");

    // 8) 個人金鑰被刪：又只剩裝置的身分。/ Personal key deleted: only the device role is left.
    let key_id = rows.iter().find(|k| k["host_friendly_name"] == "mac-key").unwrap()["id"].as_i64().unwrap();
    assert_eq!(app.delete(&format!("/api/reverse/user/keys/{key_id}"), Some(&alice.token)).await.status, StatusCode::NO_CONTENT);
    let before = work.login_count("ann", &laptop_key);
    let r = lab.laptop_exec(&as_mac, &[(Hop::Tunnel(&work_dev), "ann")], "whereami").await;
    assert!(!r.ok, "{r:?}");
    assert_eq!(work.login_count("ann", &laptop_key), before);
    assert!(app.state.status.listen_ports().unwrap_or_default().contains(&mac_port), "the tunnel never depended on the personal key");
}

#[tokio::test]
async fn a_personal_key_may_become_only_its_owners_device_key() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;

    // bob 不能拿 alice 的個人金鑰建隧道（換個註解也不行）。/ Bob cannot use alice's personal key, under any comment.
    let issue = app.get("/api/reverse/issue/token", Some(&bob.token)).await.json["token"].as_str().unwrap().to_string();
    let renamed = format!("{} borrowed", alice.key.bare());
    let r = app.post(&format!("/api/reverse/create/key/{issue}"), Some(&bob.token), json!({"host_friendly_name": "borrowed", "key": renamed})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["error"].as_str().unwrap().starts_with("This is another user's personal key"), "{}", r.text);

    // alice 可以：那台就是她的筆電；之後她的個人金鑰也標出這條隧道。/ Alice may; her key then names the tunnel.
    let issue = app.get("/api/reverse/issue/token", Some(&alice.token)).await.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{issue}"), Some(&alice.token), json!({"host_friendly_name": "laptop", "key": alice.key.public})).await;
    assert_eq!((r.status, r.json["key_personal"]["name"].as_str()), (StatusCode::OK, Some("alice-laptop")), "{}", r.text);
    let r = app.post(&format!("/api/reverse/create/key/{issue}"), Some(&alice.token), json!({"host_friendly_name": "laptop", "key": alice.key.public})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let tunnel_id = r.json["id"].as_i64().unwrap();
    let r = app.get("/api/reverse/user/keys", Some(&alice.token)).await;
    assert_eq!(r.json[0]["device_of"], json!([{ "id": tunnel_id, "name": "laptop" }]), "{}", r.text);
    // 別人的個人金鑰不會出現在 bob 的金鑰上。/ Bob's own key names nothing.
    let r = app.get("/api/reverse/user/keys", Some(&bob.token)).await;
    assert_eq!(r.json[0]["device_of"], json!([]), "{}", r.text);
}
