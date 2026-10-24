//! 釘選（每個人自己的）與標籤（大家共用、EDIT 以上可改）：權限、整理、隧道刪除與取消分享時一起清掉。
//! Pins (per user) and labels (shared, EDIT and up): permissions, normalisation and cleanup on delete / unshare.
mod common;

use common::lab::{free_port, Device, Lab};
use axum::http::StatusCode;
use serde_json::{json, Value};
use telepy_server::db;

async fn item(lab: &Lab, token: &str, tunnel_id: i64) -> Option<Value> {
    let r = lab.app.get("/api/reverse/server/dashboard", Some(token)).await;
    assert!(r.status.is_success(), "dashboard: {}", r.text);
    r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == tunnel_id).cloned()
}

#[tokio::test]
async fn pins_are_per_user_and_labels_are_shared() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let bob = lab.user("bob").await; // EDIT
    let carol = lab.user("carol").await; // VIEW
    let mallory = lab.user("mallory").await; // no access
    let key = lab.keygen("dev-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "dev", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let dev = Device { tunnel_id: t.id, name: "dev".into(), reverse_port: port, target: lab.machine("unused", &[], false).await, key };
    lab.share(&alice, &dev, &bob, "edit", &[]).await;
    lab.share(&alice, &dev, &carol, "view", &[]).await;
    let pin = format!("/api/reverse/server/{}/pin", t.id);
    let labels = format!("/api/reverse/server/{}/labels", t.id);

    // 釘選：每個人自己的；看不到的隧道 404。/ Pins are per user; invisible tunnels are 404.
    assert_eq!(item(&lab, &alice.token, t.id).await.unwrap()["pinned"], false);
    let r = lab.app.put(&pin, Some(&carol.token), json!({})).await;
    assert_eq!((r.status, r.json["pinned"].clone()), (StatusCode::OK, json!(true)), "{}", r.text);
    assert_eq!(item(&lab, &carol.token, t.id).await.unwrap()["pinned"], true);
    assert_eq!(item(&lab, &alice.token, t.id).await.unwrap()["pinned"], false, "carol's pin is hers alone");
    assert_eq!(lab.app.put(&pin, Some(&mallory.token), json!({})).await.status, StatusCode::NOT_FOUND);
    let r = lab.app.delete(&pin, Some(&carol.token)).await;
    assert_eq!(r.json["pinned"], false);
    assert_eq!(item(&lab, &carol.token, t.id).await.unwrap()["pinned"], false);

    // 標籤：EDIT 以上可改，送進來的會被整理；VIEW 不行；壞的標籤是欄位錯誤。
    // Labels: EDIT and up, normalised; VIEW is refused; bad labels are a field error.
    let r = lab.app.put(&labels, Some(&bob.token), json!({"labels": [" Prod ", "home", "prod", "env=lab"]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["labels"], json!(["env=lab", "home", "prod"]));
    assert_eq!(item(&lab, &carol.token, t.id).await.unwrap()["labels"], json!(["env=lab", "home", "prod"]), "everyone sees them");
    assert_eq!(lab.app.put(&labels, Some(&carol.token), json!({"labels": ["x"]})).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.put(&labels, Some(&alice.token), json!({"labels": ["has space"]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.json["labels"][0].as_str().unwrap().contains("not a valid label"), "{}", r.text);
    assert_eq!(lab.app.put(&labels, Some(&alice.token), json!({"labels": "prod"})).await.status, StatusCode::BAD_REQUEST);
    let r = lab.app.put(&labels, Some(&alice.token), json!({"labels": []})).await;
    assert_eq!(r.json["labels"], json!([]));

    // 取消分享：那個人的釘選一起刪。/ Unsharing drops that person's pin.
    lab.app.put(&pin, Some(&bob.token), json!({})).await;
    lab.app.put(&labels, Some(&alice.token), json!({"labels": ["home"]})).await;
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", t.id, bob.id), Some(&alice.token)).await;
    assert!(r.status.is_success(), "{}", r.text);
    assert!(!db::tunnel_tags::pinned_by(&lab.app.state.db, bob.id).await.unwrap().contains(&t.id));

    // 刪隧道：釘選與標籤一起刪。/ Deleting the tunnel drops its pins and labels.
    lab.app.put(&pin, Some(&alice.token), json!({})).await;
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}", t.id), Some(&alice.token)).await;
    assert!(r.status.is_success() && r.json["deleted"] == true, "{}", r.text);
    assert!(db::tunnel_tags::pinned_by(&lab.app.state.db, alice.id).await.unwrap().is_empty());
    assert!(db::tunnel_tags::labels_of(&lab.app.state.db, t.id).await.unwrap().is_empty());
}
