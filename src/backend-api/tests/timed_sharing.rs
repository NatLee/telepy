//! 限時分享：建立時帶 `expires_at`、改期限（只有 ADMIN / owner）、到期後 `expire_once` 收掉分享（看不到隧道、
//! 帳號交還 owner、他的金鑰離開裝置清單）；手動取消分享仍走同一條路。
//! Timed sharing: expires_at on create, changing it (ADMIN / owner only), and `expire_once` ending the share
//! (tunnel hidden, accounts handed back, keys off the device list); manual unsharing still uses the same path.
mod common;

use axum::http::StatusCode;
use common::lab::{free_port, Device, Lab};
use serde_json::{json, Value};
use telepy_server::{api::sharing, db};

async fn sees(lab: &Lab, token: &str, id: i64) -> Option<Value> {
    let r = lab.app.get("/api/reverse/server/dashboard", Some(token)).await;
    r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).cloned()
}

#[tokio::test]
async fn shares_can_end_on_their_own() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let key = lab.keygen("dev-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "dev", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let dev = Device { tunnel_id: t.id, name: "dev".into(), reverse_port: port, target: lab.machine("unused", &[], false).await, key };
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let share = format!("/tunnels/share/{}", t.id);

    // 過去的時間不行。/ A past end is refused.
    let r = lab.app.post(&share, Some(&alice.token), json!({"shared_with_user_id": bob.id, "permission_type": "view", "expires_at": "2001-01-01"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.post(&share, Some(&alice.token), json!({"shared_with_user_id": bob.id, "permission_type": "view", "allowed_target_username_ids": [ubuntu], "expires_at": "2099-12-31"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);

    // owner 在分享名單看得到期限；bob 的列表也有。/ The owner sees the end; so does bob's list.
    let r = lab.app.get(&format!("/tunnels/shared-users/{}", t.id), Some(&alice.token)).await;
    assert!(r.json["users"][0]["expires_at"].as_str().unwrap().starts_with("2099-12-31"), "{}", r.text);
    let item = sees(&lab, &bob.token, t.id).await.expect("bob sees it");
    assert!(item["share_expires_at"].as_str().unwrap().starts_with("2099-12-31"), "{item}");
    assert!(sees(&lab, &alice.token, t.id).await.unwrap()["share_expires_at"].is_null(), "owners have no share end");

    // 改期限：bob 不行；alice 可以改成一直有效、再改回來。/ Only ADMIN / owner change it.
    let expiry = format!("/tunnels/share/{}/{}/expiry", t.id, bob.id);
    assert_eq!(lab.app.patch(&expiry, Some(&bob.token), json!({"expires_at": null})).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.patch(&expiry, Some(&alice.token), json!({"expires_at": null})).await;
    assert!(r.json["expires_at"].is_null(), "{}", r.text);
    assert!(sees(&lab, &bob.token, t.id).await.unwrap()["share_expires_at"].is_null());
    assert_eq!(lab.app.patch(&expiry, Some(&alice.token), json!({})).await.status, StatusCode::BAD_REQUEST);
    lab.app.patch(&expiry, Some(&alice.token), json!({"expires_at": "2099-01-01"})).await;

    // 還沒到期：expire_once 不動它。/ Not expired yet: untouched.
    assert_eq!(sharing::expire_once(&lab.app.state).await.unwrap(), 0);

    // 到期（改 DB 模擬時間到了）：收掉。/ Expired: the share ends.
    sqlx::query("UPDATE tunnels_tunnelsharing SET expires_at = '2000-01-01 00:00:00.000000' WHERE tunnel_id = ?").bind(t.id).execute(&lab.app.state.db.write).await.unwrap();
    assert_eq!(sharing::expire_once(&lab.app.state).await.unwrap(), 1);
    assert!(sees(&lab, &bob.token, t.id).await.is_none(), "bob no longer sees the tunnel");
    assert!(db::sharing::get(&lab.app.state.db, t.id, bob.id).await.unwrap().is_none());
    let r = lab.app.get(&format!("/tunnels/shared-users/{}", t.id), Some(&alice.token)).await;
    assert!(r.json["users"].as_array().unwrap().is_empty());
    assert_eq!(sharing::expire_once(&lab.app.state).await.unwrap(), 0, "only once");

    // 一般的取消分享仍然正常（同一條路）。/ Manual unsharing still works through the same path.
    lab.app.post(&share, Some(&alice.token), json!({"shared_with_user_id": bob.id, "permission_type": "view"})).await;
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", t.id, bob.id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(sees(&lab, &bob.token, t.id).await.is_none());
}
