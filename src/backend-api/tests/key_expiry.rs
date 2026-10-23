//! 個人金鑰到期：API 規則（未來、站台上限、續期）、gateway 拒絕到期的金鑰（並記 `expired_key` 事件）、
//! 裝置金鑰清單把到期的金鑰從 authorized_keys 移除。用真的筆電 OpenSSH 經 gateway 驗證。
//! Personal key expiry: API rules, the gateway refusing an expired key (with an `expired_key` event), and device
//! key lists removing it from authorized_keys, checked with a real laptop OpenSSH through the gateway.
mod common;

use axum::http::StatusCode;
use common::lab::{sftp_server_bin, Hop, Lab};
use serde_json::json;

const PAST: &str = "2000-01-01 00:00:00.000000";

#[tokio::test]
async fn personal_keys_expire() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let keys = "/api/reverse/user/keys";

    // --- API 規則 / API rules
    let extra = lab.keygen("extra");
    let r = lab.app.post(keys, Some(&alice.token), json!({"host_friendly_name": "old", "key": extra.public, "expires_at": "2001-01-01"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["expires_at"][0].as_str().unwrap().contains("future"), "{}", r.text);
    let r = lab.app.post(keys, Some(&alice.token), json!({"host_friendly_name": "extra", "key": extra.public, "expires_at": "2099-12-31"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["expired"], false);
    assert!(r.json["expires_at"].as_str().unwrap().starts_with("2100-01-01") || r.json["expires_at"].as_str().unwrap().starts_with("2099-12-31"), "{}", r.text);
    let extra_id = r.json["id"].as_i64().unwrap();
    let r = lab.app.patch(&format!("{keys}/{extra_id}"), Some(&alice.token), json!({"expires_at": null})).await;
    assert!(r.json["expires_at"].is_null(), "{}", r.text);

    // 站台上限 30 天：沒給就自動 30 天；超過或不到期都不行。/ A 30-day site limit.
    let r = lab.app.post("/api/site/settings", Some(&lab.admin_token), json!({"user_key_max_days": 30})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let limited = lab.keygen("limited");
    let r = lab.app.post(keys, Some(&alice.token), json!({"host_friendly_name": "limited", "key": limited.public})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let exp = chrono::DateTime::parse_from_rfc3339(r.json["expires_at"].as_str().unwrap()).unwrap();
    let days = (exp.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_hours() as f64 / 24.0;
    assert!((29.9..=30.1).contains(&days), "defaulted to the limit: {days} days");
    assert_eq!(lab.app.patch(&format!("{keys}/{extra_id}"), Some(&alice.token), json!({"expires_at": "2099-12-31"})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(lab.app.patch(&format!("{keys}/{extra_id}"), Some(&alice.token), json!({"expires_at": null})).await.status, StatusCode::BAD_REQUEST);
    lab.app.post("/api/site/settings", Some(&lab.admin_token), json!({"user_key_max_days": 0})).await;

    // --- gateway + 裝置清單 / Gateway and the device key list
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    std::fs::create_dir_all(boxm.account_home("ubuntu").join(".ssh")).unwrap();
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let alice_key = lab.app.get(keys, Some(&alice.token)).await.json.as_array().unwrap().iter().find(|k| k["key"].as_str().unwrap().contains(&alice.key.bare())).unwrap()["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/reverse/server/{}/device-keys", dev.tunnel_id), Some(&alice.token), json!({"user_key_ids": [alice_key]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    lab.app.post(&format!("/api/reverse/server/{}/device-keys/sync", dev.tunnel_id), Some(&alice.token), json!({})).await;
    assert!(boxm.authorized_keys("ubuntu").contains(&alice.key.bare()), "installed while valid");
    let to_ubuntu = [(Hop::Tunnel(&dev), "ubuntu")];
    assert!(lab.laptop_exec(&alice, &to_ubuntu, "whoami").await.ok, "logs in while valid");

    // 到期（直接改 DB，模擬時間到了）。/ Expire it (as if the time had come).
    sqlx::query("UPDATE authorized_keys_userauthorizedkeys SET expires_at = ? WHERE id = ?").bind(PAST).bind(alice_key).execute(&lab.app.state.db.write).await.unwrap();
    let r = lab.app.get(&format!("{keys}/{alice_key}"), Some(&alice.token)).await;
    assert_eq!(r.json["expired"], true, "{}", r.text);
    assert!(!lab.laptop_exec(&alice, &to_ubuntu, "whoami").await.ok, "the gateway refuses an expired key");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_gateway_event WHERE event = 'expired_key'").fetch_one(&lab.app.state.db.read).await.unwrap();
    assert!(n >= 1, "the refusal is logged as expired_key");
    lab.app.post(&format!("/api/reverse/server/{}/device-keys/sync", dev.tunnel_id), Some(&alice.token), json!({})).await;
    assert!(!boxm.authorized_keys("ubuntu").contains(&alice.key.bare()), "removed from the device once expired");

    // 續期：回到裝置上、又能登入。/ Renewed: back on the device and accepted again.
    let r = lab.app.patch(&format!("{keys}/{alice_key}"), Some(&alice.token), json!({"expires_at": "2099-12-31"})).await;
    assert_eq!(r.json["expired"], false, "{}", r.text);
    lab.app.post(&format!("/api/reverse/server/{}/device-keys/sync", dev.tunnel_id), Some(&alice.token), json!({})).await;
    assert!(boxm.authorized_keys("ubuntu").contains(&alice.key.bare()));
    assert!(lab.laptop_exec(&alice, &to_ubuntu, "whoami").await.ok);
}
