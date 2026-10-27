//! Gateway 事件的可見範圍：預設（`mine`）每個人只看自己擁有／被分享的隧道，管理員也一樣；`scope=all` 只給管理員
//! （含沒有隧道的事件，`tunnel_id=none` 只看那些）；指定別人的隧道 404（管理員可以指定任何一條）。
//! Visibility of gateway events: by default (`mine`) everyone — admins too — sees their own / shared tunnels;
//! `scope=all` is admins only (tunnel-less events included, `tunnel_id=none` = only those); a foreign tunnel → 404
//! (admins may name any tunnel).
mod common;

use axum::http::StatusCode;
use serde_json::json;

use telepy_server::db;

async fn tunnel(app: &common::TestApp, user_id: i64, name: &str, port: i64) -> i64 {
    db::tunnels::create(
        &app.state.db,
        db::tunnels::NewTunnel { user_id, host_friendly_name: name, key: &format!("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI{name}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx {name}"), reverse_port: port, description: None, default_username_id: None },
    )
    .await
    .unwrap()
    .id
}

#[tokio::test]
async fn events_are_scoped_to_visible_tunnels() {
    let app = common::spawn().await;
    let admin = app.login("admin", "pw").await; // first user = superuser
    // 之後的註冊要先開放。/ Registration is closed after the first user; open it for bob and carol.
    let r = app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let bob = app.login("bob", "pw").await;
    let admin_id = app.get("/api/auth/user/profile", Some(&admin)).await.json["id"].as_i64().unwrap();
    let bob_id = app.get("/api/auth/user/profile", Some(&bob)).await.json["id"].as_i64().unwrap();
    let a = tunnel(&app, admin_id, "boxa", 40001).await;
    let b = tunnel(&app, bob_id, "boxb", 40002).await;

    let gw = app.state.gateway.clone();
    gw.event("listening", None, Some(2222), None, "Server listening on 0.0.0.0 port 2222.".into()).await;
    gw.event("accepted", None, None, Some(a), "Accepted publickey for telepy (tunnel a)".into()).await;
    gw.event("forward", None, Some(40001), Some(a), "Remote forward registered on port 40001".into()).await;
    gw.event("accepted", None, None, Some(b), "Accepted publickey for telepy (tunnel b)".into()).await;

    // admin, scope=all: everything, oldest first, with tunnel names
    let r = app.get("/api/log/ssh/events?scope=all", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let kinds: Vec<&str> = r.json.as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["listening", "accepted", "forward", "accepted"]);
    assert_eq!(r.json[1]["tunnel_name"], "boxa");
    assert_eq!(r.json[0]["tunnel_name"], serde_json::Value::Null);
    let text = app.get("/api/log/ssh?scope=all", Some(&admin)).await.json;
    assert!(text.as_str().unwrap().contains("Server listening"));
    // tunnel_id=none = only the tunnel-less site events
    let r = app.get("/api/log/ssh/events?scope=all&tunnel_id=none", Some(&admin)).await;
    let kinds: Vec<&str> = r.json.as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["listening"]);

    // admin, default (mine): only their own tunnel a, no tunnel-less events — but any tunnel by id
    let r = app.get("/api/log/ssh/events", Some(&admin)).await;
    let kinds: Vec<&str> = r.json.as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["accepted", "forward"], "{}", r.text);
    assert!(!app.get("/api/log/ssh", Some(&admin)).await.json.as_str().unwrap().contains("Server listening"));
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={b}"), Some(&admin)).await;
    assert_eq!(r.json.as_array().unwrap().len(), 1);
    assert_eq!(r.json[0]["tunnel_id"], b);
    assert_eq!(app.get("/api/log/ssh/events?tunnel_id=none", Some(&admin)).await.json, json!([]));

    // the admin tunnel list: every tunnel with its owner
    let r = app.get("/api/log/tunnels", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let names: Vec<&str> = r.json.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["boxa", "boxb"]);
    assert_eq!(r.json[1]["owner"]["username"], "bob");

    // bob: only tunnel b, no tunnel-less events, a is a 404
    let r = app.get("/api/log/ssh/events", Some(&bob)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json.as_array().unwrap().len(), 1, "{}", r.text);
    assert_eq!(r.json[0]["message"], "Accepted publickey for telepy (tunnel b)");
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={a}"), Some(&bob)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.json, json!({"error": "Reverse server keys not found"}));
    let text = app.get("/api/log/ssh", Some(&bob)).await.json;
    let text = text.as_str().unwrap();
    assert!(text.contains("(tunnel b)") && !text.contains("(tunnel a)") && !text.contains("Server listening"), "{text}");
    // everyone's events and the admin tunnel list are admins only
    for path in ["/api/log/ssh/events?scope=all", "/api/log/ssh?scope=all", "/api/log/tunnels"] {
        let r = app.get(path, Some(&bob)).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{path}: {}", r.text);
    }
    assert_eq!(app.get("/api/log/ssh/events?scope=all", Some(&bob)).await.json["code"], "admin_only");
    assert_eq!(app.get("/api/log/ssh/events?scope=bogus", Some(&bob)).await.status, StatusCode::BAD_REQUEST);

    // sharing a with bob makes its events visible
    let r = app.post(&format!("/tunnels/share/{a}"), Some(&admin), json!({"shared_with_user_id": bob_id, "permission_type": "view"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let r = app.get("/api/log/ssh/events", Some(&bob)).await;
    assert_eq!(r.json.as_array().unwrap().len(), 3, "{}", r.text);
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={a}"), Some(&bob)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json.as_array().unwrap().len(), 2);

    // a user without any tunnel sees nothing (200, empty)
    let carol = app.login("carol", "pw").await;
    let r = app.get("/api/log/ssh/events", Some(&carol)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json, json!([]));
    assert_eq!(app.get("/api/log/ssh", Some(&carol)).await.json, json!(""));
}
