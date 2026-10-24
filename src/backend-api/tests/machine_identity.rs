//! 機器身分（SSH lab）：釘選的 host key 就是「這台機器」。別的帳號把自己的隧道指到你的機器時，後端拒絕連線、
//! 兩邊都留事件、擁有者收到通知，而且他不能用「先指到自己的機器再改指過來 → 確認新金鑰」繞過；自己的第二條隧道
//! 照常，詳細資訊列出同一台上的其他隧道；原來的隧道刪掉後機器就沒有主人了。
//! Machine identity on the SSH lab: another account's tunnel pointed at your machine is refused (events on both
//! tunnels, a notification to the owner, no bypass through "accept the new key"); your own second tunnel works and
//! lists its sibling; deleting the owning tunnels frees the machine.
mod common;

use axum::http::StatusCode;
use serde_json::Value;

use common::lab::{Device, Lab};

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<String> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().map(|a| a.iter().map(|e| e["event"].as_str().unwrap_or("").to_string()).collect()).unwrap_or_default()
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<std::sync::Arc<str>>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        out.push(serde_json::from_str::<Value>(&msg).unwrap()["message"].clone());
    }
    out
}

#[tokio::test]
async fn another_account_cannot_reach_your_machine_through_its_own_tunnel() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    // Alice 的機器：root 放了 Telepy 的服務金鑰。/ Alice's machine trusts the service key as root.
    let machine = lab.machine("alice-pc", &[("root", &[&lab.service])], false).await;
    let bobs_own = lab.machine("bob-pc", &[("root", &[&lab.service])], false).await;
    let a = lab.device(&alice, "alice-box", &machine).await;
    lab.username(&alice, &a, "root").await;
    assert_eq!(lab.backend_exec(&a, "root", "whoami").await.unwrap(), "root");
    let logins_before = machine.login_count("root", &lab.service);

    // Bob 用自己的隧道金鑰把自己的隧道指到同一台 sshd，帳號清單隨他填。/ Bob points his own tunnel at the same sshd.
    let mut alice_rx = app.state.hub.subscribe_user(alice.id);
    let b = lab.device(&bob, "bob-box", &machine).await;
    lab.username(&bob, &b, "root").await;
    let err = format!("{:#}", lab.backend_exec(&b, "root", "whoami").await.unwrap_err());
    assert!(err.contains("device managed by another account"), "{err}");
    assert_eq!(machine.login_count("root", &lab.service), logins_before, "the service key never logged in through Bob's tunnel");
    assert_eq!(lab.terminal(&bob, &b, "root").await.err(), Some(4005), "the web terminal is refused too");
    assert!(lab.backend_exec(&b, "root", "whoami").await.is_err(), "retries stay refused");

    // 兩邊的紀錄：Bob 的隧道知道為什麼連不上，Alice 的隧道知道誰試過；Alice 收到通知（事件只寫一次）。
    // Both tunnels get an event (once), Alice a notification.
    let bob_events = events(&lab, &bob.token, b.tunnel_id).await;
    assert_eq!(bob_events.iter().filter(|e| *e == "claim_refused").count(), 1, "{bob_events:?}");
    assert!(!bob_events.contains(&"host_key_pinned".to_string()));
    let alice_events = events(&lab, &alice.token, a.tunnel_id).await;
    assert_eq!(alice_events.iter().filter(|e| *e == "claim_attempt").count(), 1, "{alice_events:?}");
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={}", a.tunnel_id), Some(&alice.token)).await;
    let attempt = r.json.as_array().unwrap().iter().find(|e| e["event"] == "claim_attempt").unwrap();
    assert!(attempt["message"].as_str().unwrap().contains("'bob-box' of bob"), "{}", attempt["message"]);
    let notices = drain(&mut alice_rx);
    let claim = notices.iter().find(|m| m["action"] == "DEVICE-CLAIM-ATTEMPT").expect("alice is told");
    assert_eq!((claim["tunnel_id"].as_i64(), claim["by"].as_str(), claim["by_tunnel"].as_str()), (Some(a.tunnel_id), Some("bob"), Some("bob-box")));

    // Bob 的隧道列表與詳細資訊說明原因；他的機器身分區沒有任何釘選（沒有東西可以「確認」）。
    // Bob's list and details explain it; nothing is pinned on his side (nothing to "accept").
    let r = app.get("/api/reverse/server/dashboard", Some(&bob.token)).await;
    let mine = r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == b.tunnel_id).unwrap();
    assert_eq!((mine["device_claimed"].as_bool(), mine["host_key_changed"].as_bool()), (Some(true), Some(false)), "{mine}");
    let r = app.get(&format!("/api/reverse/server/{}/host-key", b.tunnel_id), Some(&bob.token)).await;
    assert_eq!(r.json["pinned"].as_array().unwrap().len(), 0);
    assert!(r.json["refused_claim"]["fingerprint"].as_str().unwrap().starts_with("SHA256:"), "{}", r.text);
    assert_eq!(r.json["same_machine"].as_array().unwrap().len(), 0);
    let r = app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    let hers = r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == a.tunnel_id).unwrap();
    assert_eq!(hers["device_claimed"].as_bool(), Some(false), "the owner's tunnel is fine");

    // 繞法 1：Bob 先指到自己的機器（釘選）、再改指到 Alice 的 → 金鑰不符被記下來，但「確認新金鑰」被擋。
    // Bypass 1: pin Bob's own machine first, then repoint at Alice's → mismatch recorded, but accepting it is refused.
    let own = Device { tunnel_id: b.tunnel_id, name: b.name.clone(), reverse_port: b.reverse_port, target: bobs_own.clone(), key: b.key.clone() };
    lab.reconnect_device(&own).await;
    assert_eq!(lab.backend_exec(&own, "root", "whoami").await.unwrap(), "root");
    let r = app.get(&format!("/api/reverse/server/{}/host-key", b.tunnel_id), Some(&bob.token)).await;
    assert!(r.json["refused_claim"].is_null(), "pinning his own machine clears the refused claim: {}", r.text);
    lab.reconnect_device(&b).await;
    let err = format!("{:#}", lab.backend_exec(&b, "root", "whoami").await.unwrap_err());
    assert!(err.contains("device host key changed"), "{err}");
    let r = app.get(&format!("/api/reverse/server/{}/host-key", b.tunnel_id), Some(&bob.token)).await;
    let fp = r.json["rejected"][0]["fingerprint"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/server/{}/host-key/accept", b.tunnel_id), Some(&bob.token), serde_json::json!({"fingerprint": fp})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::CONFLICT, Some("device_claimed")), "{}", r.text);
    assert!(lab.backend_exec(&b, "root", "whoami").await.is_err());
    assert_eq!(machine.login_count("root", &lab.service), logins_before);

    // 繞法 2：忘掉釘選再連 → 回到第一次使用的判斷，一樣被拒。/ Bypass 2: forget, then reconnect → first use again, refused.
    assert_eq!(app.delete(&format!("/api/reverse/server/{}/host-key", b.tunnel_id), Some(&bob.token)).await.status, StatusCode::OK);
    let err = format!("{:#}", lab.backend_exec(&b, "root", "whoami").await.unwrap_err());
    assert!(err.contains("device managed by another account"), "{err}");

    // Alice 自己的第二條隧道指到同一台：照常，而且兩邊的詳細資訊都列出對方。
    // Alice's own second tunnel on the same machine works, and each lists the other.
    let a2 = lab.device(&alice, "alice-box-2", &machine).await;
    lab.username(&alice, &a2, "root").await;
    assert_eq!(lab.backend_exec(&a2, "root", "whoami").await.unwrap(), "root");
    let r = app.get(&format!("/api/reverse/server/{}/host-key", a2.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.json["same_machine"], serde_json::json!([{"id": a.tunnel_id, "name": "alice-box"}]), "{}", r.text);
    let r = app.get(&format!("/api/reverse/server/{}/host-key", a.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.json["same_machine"], serde_json::json!([{"id": a2.tunnel_id, "name": "alice-box-2"}]), "{}", r.text);
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={}", a2.tunnel_id), Some(&alice.token)).await;
    let pinned = r.json.as_array().unwrap().iter().find(|e| e["event"] == "host_key_pinned").unwrap();
    assert!(pinned["message"].as_str().unwrap().contains("the same machine as 'alice-box'"), "{}", pinned["message"]);

    // Alice 刪掉兩條隧道 → 機器沒有主人了，Bob 的連線第一次使用就釘選。/ Alice deletes hers → the machine is free; Bob pins it.
    for id in [a.tunnel_id, a2.tunnel_id] {
        let r = app.delete(&format!("/api/reverse/server/keys/{id}?remove_device_keys=false"), Some(&alice.token)).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    }
    assert_eq!(lab.backend_exec(&b, "root", "whoami").await.unwrap(), "root");
    let r = app.get(&format!("/api/reverse/server/{}/host-key", b.tunnel_id), Some(&bob.token)).await;
    assert_eq!((r.json["pinned"].as_array().unwrap().len(), r.json["refused_claim"].is_null()), (1, true), "{}", r.text);
}
