//! 裝置 SSH host key 釘選端到端（SSH lab）：第一次連線記下 → 隧道被指到另一台 sshd（冒充）時拒絕 →
//! VIEW 分享者不能改、擁有者確認後改信任 → 忘掉後重新記。
//! Device host-key pinning end to end: pin on first use, refuse an impostor sshd, owner review, forget.
mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::lab::{Device, Lab};

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<Value> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().cloned().unwrap_or_default()
}

#[tokio::test]
async fn host_key_is_pinned_and_a_changed_key_is_refused_until_the_owner_accepts_it() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let carol = lab.user("carol").await;
    let real = lab.machine("real", &[("ubuntu", &[&lab.service])], false).await;
    let impostor = lab.machine("impostor", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &real).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &carol, "view", &[ubuntu]).await;
    let id = dev.tunnel_id;
    let url = format!("/api/reverse/server/{id}/host-key");

    // 還沒連過：沒有釘選。第一次連線就記下。/ Nothing pinned before the first connection; it pins then.
    let r = app.get(&url, Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["pinned"].as_array().unwrap().len(), 0);
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap().trim(), "ubuntu");
    let r = app.get(&url, Some(&carol.token)).await;
    assert_eq!(r.json["can_manage"], false, "a VIEW sharee may look but not manage");
    let pinned = r.json["pinned"].as_array().unwrap().clone();
    assert_eq!(pinned.len(), 1, "{}", r.text);
    assert_eq!(pinned[0]["source"], "first_use");
    assert!(pinned[0]["fingerprint"].as_str().unwrap().starts_with("SHA256:"));
    let first_fp = pinned[0]["fingerprint"].as_str().unwrap().to_string();
    // 同一台再連：沿用，不重複記。/ Same device again: trusted, nothing new recorded.
    if let Err(e) = lab.backend_exec(&dev, "ubuntu", "whoami").await { panic!("second connection: {e:#}") }
    assert_eq!(app.get(&url, Some(&alice.token)).await.json["pinned"].as_array().unwrap().len(), 1);
    assert!(events(&lab, &alice.token, id).await.iter().any(|e| e["event"] == "host_key_pinned"));

    // 拿到隧道金鑰的人把隧道指到自己的 sshd：拒絕連線。/ The tunnel now points at an impostor sshd: refused.
    let fake = Device { tunnel_id: dev.tunnel_id, name: dev.name.clone(), reverse_port: dev.reverse_port, target: impostor.clone(), key: dev.key.clone() };
    lab.reconnect_device(&fake).await;
    let err = lab.backend_exec(&fake, "ubuntu", "whoami").await.unwrap_err();
    assert!(format!("{err:#}").contains("device host key changed"), "{err:#}");
    assert!(impostor.logins().is_empty(), "the impostor never sees the service-key login");
    let r = app.get(&url, Some(&alice.token)).await;
    let rejected = r.json["rejected"].as_array().unwrap().clone();
    assert_eq!(rejected.len(), 1, "{}", r.text);
    let new_fp = rejected[0]["fingerprint"].as_str().unwrap().to_string();
    assert_ne!(new_fp, first_fp);
    // 再試一次：次數累加，事件只寫一次。/ Retrying bumps the counter; the event is written once.
    assert!(lab.backend_exec(&fake, "ubuntu", "whoami").await.is_err());
    assert_eq!(app.get(&url, Some(&alice.token)).await.json["rejected"][0]["attempts"], 2);
    let ev = events(&lab, &alice.token, id).await;
    assert_eq!(ev.iter().filter(|e| e["event"] == "host_key_mismatch").count(), 1, "{ev:?}");
    // 列表標出來。/ The tunnel list flags it.
    let dash = app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
    let item = dash.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap().clone();
    assert_eq!(item["host_key_changed"], true);

    // 只有擁有者 / ADMIN 能改信任。/ Only the owner or an ADMIN sharee may trust it.
    let r = app.post(&format!("{url}/accept"), Some(&carol.token), json!({"fingerprint": new_fp})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = app.post(&format!("{url}/accept"), Some(&alice.token), json!({"fingerprint": "SHA256:nope"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let r = app.post(&format!("{url}/accept"), Some(&alice.token), json!({"fingerprint": new_fp})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["pinned"][0]["fingerprint"], new_fp.as_str());
    assert_eq!(r.json["pinned"][0]["source"], "accepted");
    assert_eq!(r.json["rejected"].as_array().unwrap().len(), 0);
    assert_eq!(lab.backend_exec(&fake, "ubuntu", "whoami").await.unwrap().trim(), "ubuntu");
    // 舊的那台現在反而不被信任。/ The old device is now the one refused.
    lab.reconnect_device(&dev).await;
    assert!(lab.backend_exec(&dev, "ubuntu", "whoami").await.is_err());

    // 忘掉：下一次連線重新第一次使用。/ Forget: the next connection pins again.
    assert_eq!(app.delete(&url, Some(&carol.token)).await.status, StatusCode::FORBIDDEN);
    let r = app.delete(&url, Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(lab.backend_exec(&dev, "ubuntu", "whoami").await.is_ok());
    let r = app.get(&url, Some(&alice.token)).await;
    assert_eq!(r.json["pinned"][0]["fingerprint"], first_fp.as_str());
    let kinds: Vec<String> = events(&lab, &alice.token, id).await.iter().map(|e| e["event"].as_str().unwrap_or("").to_string()).collect();
    for k in ["host_key_pinned", "host_key_mismatch", "host_key_accepted", "host_key_forgotten"] {
        assert!(kinds.iter().any(|x| x == k), "{k} missing in {kinds:?}");
    }

    // 看不到的人 404。/ Strangers get 404.
    let mallory = lab.user("mallory").await;
    assert_eq!(app.get(&url, Some(&mallory.token)).await.status, StatusCode::NOT_FOUND);
}
