//! 通道的身分只歸 owner / ADMIN：裝置金鑰、服務金鑰、連線腳本只給他們看；換裝置金鑰或號碼也只有他們能做，
//! 有第二因素時要再驗證，換了會寫進紀錄並斷開現在的連線。EDIT 照樣能改名稱 / 描述，送回原值不算改。
//! A tunnel's identity belongs to owner / ADMIN: only they see the device key, the service key and the connection
//! scripts, and only they may change the device key or the number — with a re-authentication when they have a
//! factor, an event on the tunnel and the live connection dropped. EDIT still edits name / description; sending
//! the current value back is not a change.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::lab::{Lab, LabUser};
use serde_json::{json, Value};
use telepy_server::mfa;

fn code_at(secret_b32: &str, unix: i64) -> String {
    let secret = mfa::base32_decode(secret_b32).unwrap();
    format!("{:06}", mfa::hotp(&secret, mfa::totp_step(unix as u64)))
}

/// 開 TOTP，回復原碼。/ Enable TOTP; returns the recovery codes.
async fn enable_totp(lab: &Lab, token: &str) -> Vec<String> {
    let r = lab.app.post("/api/auth/mfa/totp/setup", Some(token), json!({})).await;
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let r = lab.app.post("/api/auth/mfa/totp/enable", Some(token), json!({"code": code_at(&secret, chrono::Utc::now().timestamp())})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["recovery_codes"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect()
}

async fn item(lab: &Lab, user: &LabUser, tunnel_id: i64) -> Value {
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&user.token)).await;
    assert!(r.status.is_success(), "dashboard: {}", r.text);
    r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == tunnel_id).cloned().expect("tunnel in my list")
}

async fn events(lab: &Lab, user: &LabUser, tunnel_id: i64) -> Vec<Value> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(&user.token)).await.json.as_array().cloned().unwrap_or_default()
}

fn listening(lab: &Lab, port: u16) -> bool {
    lab.app.state.status.listen_ports().is_some_and(|p| p.contains(&port))
}

#[tokio::test]
async fn only_owner_and_admin_see_and_change_the_tunnel_identity() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let adam = lab.user("adam").await; // ADMIN
    let ed = lab.user("ed").await; // EDIT, with an account
    let vic = lab.user("vic").await; // VIEW, status only
    let mallory = lab.user("mallory").await; // no access
    let machine = lab.machine("box", &[("ops", &[])], false).await;
    let dev = lab.device(&alice, "box", &machine).await;
    let ops = lab.username(&alice, &dev, "ops").await;
    lab.share(&alice, &dev, &adam, "admin", &[]).await;
    lab.share(&alice, &dev, &ed, "edit", &[ops]).await;
    lab.share(&alice, &dev, &vic, "view", &[]).await;
    let id = dev.tunnel_id;
    let one = format!("/api/reverse/server/keys/{id}");

    // 看：裝置金鑰與服務金鑰只給 owner / ADMIN。/ Seeing: device and service keys for owner / ADMIN only.
    for (who, sees) in [(&alice, true), (&adam, true), (&ed, false), (&vic, false)] {
        let listed = item(&lab, who, id).await;
        assert_eq!(listed["key"].as_str().map(str::trim), sees.then(|| dev.key.public.trim()), "{} list key", who.username);
        let single = lab.app.get(&one, Some(&who.token)).await;
        assert_eq!(single.status, StatusCode::OK, "{}", single.text);
        assert_eq!(single.json["key"].is_string(), sees, "{} retrieve key", who.username);
        assert_eq!(single.json["service_key"].is_string(), sees, "{} service key", who.username);
    }

    // 連線腳本：owner / ADMIN；其他分享者 403，看不到的人 404；ssh config 照樣給有帳號的人。
    // Connection scripts: owner / ADMIN; other sharees 403, outsiders 404; the ssh config still serves sharees.
    let script = format!("/tunnels/server/script/ssh/{id}/22");
    assert_eq!(lab.app.get(&script, Some(&adam.token)).await.status, StatusCode::OK);
    for who in [&ed, &vic] {
        let r = lab.app.get(&script, Some(&who.token)).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{}: {}", who.username, r.text);
        let r = lab.app.post("/tunnels/server/script/one-time/token", Some(&who.token), json!({"server_id": id, "ssh_port": 22, "script_type": "ssh"})).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{}: {}", who.username, r.text);
    }
    assert_eq!(lab.app.get(&script, Some(&mallory.token)).await.status, StatusCode::NOT_FOUND);
    let r = lab.app.get(&format!("/tunnels/server/config/{id}"), Some(&ed.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    // 一次性網址：取用時再看一次權限 —— 發出後降成 VIEW 就拿不到。/ One-time URL: checked again on use.
    let issue = json!({"server_id": id, "ssh_port": 22, "script_type": "ssh"});
    let r = lab.app.post("/tunnels/server/script/one-time/token", Some(&adam.token), issue.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.get(&format!("/tunnels/server/script/one-time/{}", r.json["token"].as_str().unwrap()), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.post("/tunnels/server/script/one-time/token", Some(&adam.token), issue).await;
    let token = r.json["token"].as_str().unwrap().to_string();
    let demote = format!("/tunnels/update-permission/{id}/{}", adam.id);
    assert!(lab.app.patch(&demote, Some(&alice.token), json!({"permission_type": "view"})).await.status.is_success());
    assert_eq!(lab.app.get(&format!("/tunnels/server/script/one-time/{token}"), None).await.status, StatusCode::FORBIDDEN);
    assert!(lab.app.patch(&demote, Some(&alice.token), json!({"permission_type": "admin"})).await.status.is_success());

    // EDIT：改描述可以；換金鑰 / 號碼不行；送回原值不算改。/ EDIT: description yes; key / number no; same value is no change.
    let r = lab.app.patch(&one, Some(&ed.token), json!({"description": "rack 3"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["key"].is_null(), "the answer to EDIT carries no key either");
    let other = lab.keygen("other-device");
    let r = lab.app.patch(&one, Some(&ed.token), json!({"key": other.public})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    assert!(r.json["detail"].as_str().unwrap().contains("owner or an ADMIN"), "{}", r.text);
    let r = lab.app.patch(&one, Some(&ed.token), json!({"reverse_port": dev.reverse_port as i64 + 1})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = lab.app.patch(&one, Some(&ed.token), json!({"reverse_port": dev.reverse_port, "key": dev.key.public})).await;
    assert_eq!(r.status, StatusCode::OK, "the current values are not a change: {}", r.text);

    // 新金鑰照建立時的規則檢查：別人的個人金鑰不行。/ A new key follows the create rules: not someone's personal key.
    let r = lab.app.patch(&one, Some(&adam.token), json!({"key": mallory.key.public})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["key"][0].as_str().unwrap().contains("personal key"), "{}", r.text);

    // 只改註解：不算換金鑰，不要再驗證、不斷線、沒有紀錄。/ A comment-only edit: no reauth, no disconnect, no event.
    let codes = enable_totp(&lab, &alice.token).await;
    assert!(listening(&lab, dev.reverse_port));
    let renamed = format!("{} renamed-comment", dev.key.bare());
    let r = lab.app.patch(&one, Some(&alice.token), json!({"key": renamed})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(listening(&lab, dev.reverse_port), "a comment change keeps the device connected");

    // owner 有第二因素：換金鑰要再驗證；換了寫紀錄（只有指紋）並斷開裝置。
    // The owner has a factor: a new key needs reauth; then an event (fingerprints only) and the device is dropped.
    let r = lab.app.patch(&one, Some(&alice.token), json!({"key": other.public})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("reauth_required")), "{}", r.text);
    let r = lab.app.patch(&one, Some(&alice.token), json!({"key": other.public, "reauth": {"method": "recovery_code", "code": codes[0]}})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while listening(&lab, dev.reverse_port) {
        assert!(tokio::time::Instant::now() < deadline, "the old key's connection was not dropped");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let evs = events(&lab, &alice, id).await;
    let changed = evs.iter().find(|e| e["event"] == "device_key_changed").expect("device_key_changed event");
    let msg = changed["message"].as_str().unwrap();
    assert!(msg.contains("alice changed the device key") && msg.contains("SHA256:"), "{msg}");
    assert!(!msg.contains(other.bare().split_whitespace().nth(1).unwrap()), "no key blob in the log: {msg}");

    // 號碼：ADMIN（沒有第二因素）直接可以；寫紀錄。/ The number: an ADMIN without a factor may; it is logged.
    let r = lab.app.patch(&one, Some(&adam.token), json!({"reverse_port": dev.reverse_port as i64 + 7})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(events(&lab, &alice, id).await.iter().any(|e| e["event"] == "reverse_port_changed"));
}
