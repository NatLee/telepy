//! 憑證庫（遠端桌面的登入）REST：存了就看不到密碼、只動得到自己的、綁定的隧道 / 主機要看得到、隧道刪除時一併刪。
//! Credential vault REST: passwords never come back, only your own rows, targets must be visible, deleted with the tunnel.
mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

async fn tunnel(app: &common::TestApp, token: &str, name: &str, key: &str) -> i64 {
    let r = app.get("/api/reverse/issue/token", Some(token)).await;
    let t = r.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(token), json!({"host_friendly_name": name, "key": key, "ssh_port": 22})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["id"].as_i64().unwrap()
}

const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHEFltoMG4X8MG60ALp7MCsyv9mKKK1QjxImZr4QVzQ1 a";
const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg4i0sZ3Yd9yS9kD1k0e8v8bqE7f5c4bX5tqG7Uo3Ln b";

#[tokio::test]
async fn saved_logins_are_private_and_never_return_the_password() {
    let app = common::spawn().await;
    let (alice, bob) = app.admin_and_user("alice", "bob").await;
    let pc = tunnel(&app, &alice, "pc", KEY_A).await;
    let r = app.post(&format!("/api/reverse/server/{pc}/lan/hosts"), Some(&alice), json!({"address": "192.168.1.50", "label": "win"})).await;
    let host = r.json["id"].as_i64().unwrap();

    let r = app.post("/api/credentials", Some(&alice), json!({"label": "Windows box", "protocol": "rdp", "tunnel_id": pc, "lan_host_id": host, "login": "Administrator", "domain": "CORP", "password": "s3cret-pw", "port": 3389})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert!(!r.text.contains("s3cret-pw"), "{}", r.text);
    assert_eq!(r.json["has_password"], true);
    assert_eq!(r.json["lan_host"], "win");
    assert_eq!(r.json["tunnel_name"], "pc");
    let id = r.json["id"].as_i64().unwrap();
    // 資料庫裡也只有密文。/ Only the sealed form is stored.
    let secret: String = sqlx::query_scalar("SELECT secret FROM telepy_credential WHERE id = ?").bind(id).fetch_one(&app.state.db.read).await.unwrap();
    assert!(secret.starts_with("v1:") && !secret.contains("s3cret-pw"));

    // 篩選。/ Filters.
    let list = |q: String| { let app = &app; let alice = alice.clone(); async move { app.get(&format!("/api/credentials{q}"), Some(&alice)).await.json } };
    assert_eq!(list(String::new()).await.as_array().unwrap().len(), 1);
    assert_eq!(list(format!("?tunnel_id={pc}&lan_host_id={host}&protocol=rdp")).await.as_array().unwrap().len(), 1);
    assert_eq!(list(format!("?tunnel_id={pc}&protocol=rdp")).await.as_array().unwrap().len(), 0, "the device itself is a different target");
    assert_eq!(list(format!("?tunnel_id={pc}&lan_host_id={host}&protocol=vnc")).await.as_array().unwrap().len(), 0);

    // 別人看不到、動不了。/ Others see nothing and cannot touch it.
    assert_eq!(app.get("/api/credentials", Some(&bob)).await.json, json!([]));
    assert_eq!(app.patch(&format!("/api/credentials/{id}"), Some(&bob), json!({"label": "x"})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&format!("/api/credentials/{id}"), Some(&bob)).await.status, StatusCode::NOT_FOUND);
    // 看不到的隧道不能存。/ No saving for a tunnel you cannot see.
    let r = app.post("/api/credentials", Some(&bob), json!({"label": "x", "protocol": "rdp", "tunnel_id": pc, "password": "p"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    // 別條隧道的主機不行。/ A LAN host of another tunnel is refused.
    let other = tunnel(&app, &alice, "other", KEY_B).await;
    let r = app.post("/api/credentials", Some(&alice), json!({"label": "x", "protocol": "rdp", "tunnel_id": other, "lan_host_id": host, "password": "p"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    // 欄位驗證。/ Validation.
    for body in [
        json!({"protocol": "rdp", "tunnel_id": pc, "password": "p"}),
        json!({"label": "x", "protocol": "ssh", "tunnel_id": pc, "password": "p"}),
        json!({"label": "x", "protocol": "rdp", "tunnel_id": pc}),
        json!({"label": "x", "protocol": "rdp", "tunnel_id": pc, "password": "p", "port": 0}),
    ] {
        assert_eq!(app.post("/api/credentials", Some(&alice), body.clone()).await.status, StatusCode::BAD_REQUEST, "{body}");
    }

    // 改名、換密碼：密文換了，密碼仍不回傳。/ Rename and change the password: new ciphertext, still never returned.
    let r = app.patch(&format!("/api/credentials/{id}"), Some(&alice), json!({"label": "Win 11", "password": "n3w-pw"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["label"], "Win 11");
    assert!(!r.text.contains("n3w-pw"));
    let secret2: String = sqlx::query_scalar("SELECT secret FROM telepy_credential WHERE id = ?").bind(id).fetch_one(&app.state.db.read).await.unwrap();
    assert_ne!(secret, secret2);
    // 不給密碼就保留原本的。/ Without a password the old one stays.
    app.patch(&format!("/api/credentials/{id}"), Some(&alice), json!({"login": "admin2"})).await;
    let secret3: String = sqlx::query_scalar("SELECT secret FROM telepy_credential WHERE id = ?").bind(id).fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(secret2, secret3);

    // 主機刪掉 → 存給它的登入一起刪；隧道刪掉也是。/ Deleting the host or the tunnel deletes its logins.
    let r = app.post("/api/credentials", Some(&alice), json!({"label": "device", "protocol": "vnc", "tunnel_id": pc, "password": "v"})).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(app.delete(&format!("/api/reverse/server/{pc}/lan/hosts/{host}"), Some(&alice)).await.status, StatusCode::NO_CONTENT);
    let left: Vec<Value> = app.get("/api/credentials", Some(&alice)).await.json.as_array().cloned().unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["label"], "device");
    let r = app.delete(&format!("/api/reverse/server/keys/{pc}"), Some(&alice)).await;
    assert!(r.status.is_success(), "{}", r.text);
    assert_eq!(app.get("/api/credentials", Some(&alice)).await.json, json!([]));

    // 刪除自己的。/ Deleting your own.
    let r = app.post("/api/credentials", Some(&alice), json!({"label": "o", "protocol": "rdp", "tunnel_id": other, "password": "p"})).await;
    let oid = r.json["id"].as_i64().unwrap();
    assert_eq!(app.delete(&format!("/api/credentials/{oid}"), Some(&alice)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.delete(&format!("/api/credentials/{oid}"), Some(&alice)).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rustdesk_passwords_can_be_saved_too() {
    let app = common::spawn().await;
    let (alice, _bob) = app.admin_and_user("alice", "bob").await;
    let pc = tunnel(&app, &alice, "pc", KEY_A).await;
    // 沒有登入帳號：RustDesk 只有固定密碼。/ No login: RustDesk has a permanent password only.
    let r = app.post("/api/credentials", Some(&alice), json!({"label": "rd", "protocol": "rustdesk", "tunnel_id": pc, "password": "rd-secret", "port": 21118})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["protocol"], "rustdesk");
    assert_eq!(r.json["login"], "");
    assert_eq!(r.json["has_password"], true);
    assert!(!r.text.contains("rd-secret"));
    let r = app.get(&format!("/api/credentials?tunnel_id={pc}&protocol=rustdesk"), Some(&alice)).await;
    assert_eq!(r.json.as_array().unwrap().len(), 1);
    let r = app.get(&format!("/api/credentials?tunnel_id={pc}&protocol=vnc"), Some(&alice)).await;
    assert_eq!(r.json.as_array().unwrap().len(), 0, "a RustDesk login is not a VNC login");
    let r = app.post("/api/credentials", Some(&alice), json!({"label": "x", "protocol": "ssh", "tunnel_id": pc, "password": "p"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.json["protocol"][0].as_str().unwrap().contains("rustdesk"), "{}", r.text);
}
