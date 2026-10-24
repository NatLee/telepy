//! REST parity tests：對照 Django 版的回應形狀、狀態碼與錯誤字串。
mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4u5n7tS1kO6o4m3yQ0tYQd6v7Jc5Zq8Hh3n5Vt7Wk device-a";
const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4u5n7tS1kO6o4m3yQ0tYQd6v7Jc5Zq8Hh3n5Vt7Wl device-b";
const USER_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHAgjb8hhCbQ4/2TIVTp6pRlUi97oIezKoHrwtI5hIDU laptop";
const USER_KEY_2: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC0IpUODAh6nEE6nsxVUVINtlvKLCYnrc/Xfzbp1ui1K other";
const RSA_1024: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDfJoXhbfbTVWOGa30diB5dY07RMBntvLd+q1uT8vc7qLbQhsStQ3uK6g2kj2s/fMn9J3Ayan4au4KLfcMcnWaTy+A6J/vSFogh8q3M8w/80nkQ3clT/492fRCOWb1usAmMRJsl38BgO8BfbQtY65KFxC/mPvv6zBvKMbI4Vtd6Xw== small";

async fn create_tunnel(app: &common::TestApp, token: &str, name: &str, key: &str) -> Value {
    let r = app.get("/api/reverse/issue/token", Some(token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let t = r.json["token"].as_str().unwrap().to_string();
    assert!(r.json["issuer"]["username"].is_string());
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(token), json!({"host_friendly_name": name, "key": key, "ssh_port": 22})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json
}

#[tokio::test]
async fn tunnel_lifecycle_and_dashboard() {
    let app = common::spawn().await;
    let admin = app.login("admin", "pw").await;

    // dashboard is empty but well-formed
    let r = app.get("/api/reverse/server/dashboard", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json, json!({"tunnels": [], "ports": {}, "latency": {}}));

    // create via one-time token (wizard flow)
    let created = create_tunnel(&app, &admin, "box-a", KEY_A).await;
    assert_eq!(created["host_friendly_name"], "box-a");
    assert_eq!(created["port"], "24242", "port echoes the env string");
    assert_eq!(created["reverse_port"], 1024, "first free port ≥ 1024");
    let id = created["id"].as_i64().unwrap();

    // token is single-use
    let r = app.post("/api/reverse/create/key/deadbeef", Some(&admin), json!({"host_friendly_name": "x", "key": KEY_B})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["error"], "Invalid or expired token");

    // validation messages
    let r = app.get("/api/reverse/issue/token", Some(&admin)).await;
    let t = r.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&admin), json!({"host_friendly_name": "1abc", "key": KEY_B})).await;
    assert_eq!(r.json["error"], "Host friendly name cannot start with a number.");
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&admin), json!({"host_friendly_name": "abc", "key": "garbage"})).await;
    assert_eq!(r.json["error"], "Invalid SSH public key format");
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t}"), Some(&admin), json!({"host_friendly_name": "box-a", "key": KEY_B})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["error"], "Host friendly name already exists");
    assert_eq!(r.json["host_friendly_name_exists"], true);
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t}"), Some(&admin), json!({"host_friendly_name": "box-b", "key": KEY_B})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["message"], "Host friendly name and key are not used");

    // list serializer shape
    let r = app.get("/api/reverse/server/keys", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK);
    let t0 = &r.json[0];
    for f in ["id", "can_edit", "can_share", "can_delete", "is_owner", "user_permission", "shared_with_count", "host_friendly_name", "key", "reverse_port", "description", "created_at", "updated_at", "user", "default_username"] {
        assert!(t0.get(f).is_some(), "missing field {f}: {t0}");
    }
    assert_eq!(t0["is_owner"], true);
    assert_eq!(t0["user_permission"], "owner");
    assert_eq!(t0["shared_with_count"], 0);
    assert!(t0["created_at"].as_str().unwrap().ends_with("+08:00"), "{}", t0["created_at"]);

    // dashboard ports: no sample yet → {}
    let r = app.get("/api/reverse/server/dashboard", Some(&admin)).await;
    assert_eq!(r.json["tunnels"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["ports"], json!({}));

    // the gateway reports a live forward → ports map keyed by string
    app.state.status.set_listen_ports([1024u16].into_iter().collect());
    let r = app.get("/api/reverse/server/status/ports", Some(&admin)).await;
    assert_eq!(r.json, json!({"1024": true}));

    // patch description (details modal)
    let r = app.patch(&format!("/api/reverse/server/keys/{id}"), Some(&admin), json!({"description": "hello"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["description"], "hello");

    // usernames
    let r = app.post("/api/reverse/server/usernames", Some(&admin), json!({"reverse_server": id, "username": "ubuntu"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let uname_id = r.json["id"].as_i64().unwrap();
    assert_eq!(r.json["reverse_server"], id);
    let r = app.post("/api/reverse/server/usernames", Some(&admin), json!({"reverse_server": id, "username": "ubuntu"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!(["This tunnel already has a target user named 'ubuntu'."]));
    let r = app.post("/api/reverse/server/usernames", Some(&admin), json!({"reverse_server": 999, "username": "x"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["reverse_server"][0], "Invalid pk \"999\" - object does not exist.");

    let r = app.get(&format!("/api/reverse/server/{id}/usernames"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["usernames"][0]["username"], "ubuntu");
    assert_eq!(r.json["usernames"][0]["created_by"], "admin");
    assert_eq!(r.json["default_username_id"], Value::Null);

    let r = app.patch(&format!("/api/reverse/server/{id}/default-username"), Some(&admin), json!({"default_username_id": uname_id})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["default_username_id"], uname_id);
    let r = app.get(&format!("/api/reverse/server/{id}/usernames"), Some(&admin)).await;
    assert_eq!(r.json["default_username_id"], uname_id);
    let r = app.patch(&format!("/api/reverse/server/{id}/default-username"), Some(&admin), json!({"default_username_id": 4242})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["error"], "Username not found for this tunnel");

    // scripts & config
    let r = app.get(&format!("/tunnels/server/config/{id}"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let cfg = r.json["config"].as_str().unwrap();
    assert!(cfg.contains("Host telepy-ssh-server"), "{cfg}");
    assert!(cfg.contains("Host box-a\n"), "{cfg}");
    assert!(cfg.contains("User ubuntu"), "{cfg}");
    assert_eq!(r.json["usernames"][0]["username"], "ubuntu");
    // 指令速查用的結構化欄位。/ Structured fields for the command sheet.
    assert_eq!(r.json["server"]["alias"], "telepy-ssh-server");
    assert_eq!(r.json["hosts"][0]["alias"], "box-a");
    assert_eq!(r.json["hosts"][0]["username"], "ubuntu");
    assert_eq!(r.json["hosts"][0]["username_id"], uname_id);
    assert_eq!(r.json["reverse_port"], 1024);

    let r = app.get(&format!("/tunnels/server/script/ssh/{id}/22"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["language"], "bash");
    assert!(r.json["script"].as_str().unwrap().contains("-NR '*:1024:localhost:22'"));
    let r = app.get(&format!("/tunnels/server/script/autossh-service/{id}/22"), Some(&admin)).await;
    assert!(r.json["script"].as_str().unwrap().contains("User=ubuntu"), "{}", r.text);
    let r = app.get(&format!("/tunnels/server/script/docker-compose/{id}/22"), Some(&admin)).await;
    assert_eq!(r.json["language"], "yaml");
    let r = app.get(&format!("/tunnels/server/script/bogus/{id}/22"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // one-time script token
    let r = app.post("/tunnels/server/script/one-time/token", Some(&admin), json!({"server_id": id, "ssh_port": 22, "script_type": "ssh"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let url = r.json["url"].as_str().unwrap().to_string();
    let token = r.json["token"].as_str().unwrap().to_string();
    assert!(url.ends_with(&format!("/tunnels/server/script/one-time/{token}")), "{url}");
    let r = app.get(&format!("/tunnels/server/script/one-time/{token}"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.headers.get("content-type").unwrap().to_str().unwrap().starts_with("text/plain"));
    assert!(r.text.contains("#!/bin/bash"));
    let r = app.get(&format!("/tunnels/server/script/one-time/{token}"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.text, "Token invalid or already used");
    let r = app.post("/tunnels/server/script/one-time/token", Some(&admin), json!({"server_id": id, "ssh_port": 22, "script_type": "nope"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.json["error"].as_str().unwrap().starts_with("Invalid script_type. Allowed: ["));

    // service keys list (seeded only inside the container; empty here)
    let r = app.get("/api/reverse/service/keys", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json.is_array());

    // delete tunnel cascades usernames
    let r = app.delete(&format!("/api/reverse/server/keys/{id}"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["deleted"], true, "{}", r.text);
    let r = app.get("/api/reverse/server/usernames", Some(&admin)).await;
    assert_eq!(r.json, json!([]));
    let r = app.get(&format!("/api/reverse/server/keys/{id}"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.json, json!({"detail": "Not found."}));
}

#[tokio::test]
async fn sharing_permissions_flow() {
    let app = common::spawn().await;
    let owner = app.login("owner", "pw").await;
    // open registration so a second user can be created
    let r = app.post("/api/site/settings", Some(&owner), json!({"allow_registration": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["values"]["allow_registration"], true);
    assert_eq!(r.json["meta"]["allow_registration"]["type"], "boolean");
    let bob = app.login("bob", "pw").await;
    let bob_id = app.get("/api/auth/user/profile", Some(&bob)).await.json["id"].as_i64().unwrap();

    let t = create_tunnel(&app, &owner, "shared-box", KEY_A).await;
    let id = t["id"].as_i64().unwrap();
    let r = app.post("/api/reverse/server/usernames", Some(&owner), json!({"reverse_server": id, "username": "root"})).await;
    let root_uid = r.json["id"].as_i64().unwrap();

    // bob cannot see it yet
    let r = app.get("/api/reverse/server/dashboard", Some(&bob)).await;
    assert_eq!(r.json["tunnels"], json!([]));
    let r = app.get(&format!("/tunnels/shared-users/{id}"), Some(&bob)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json["error"], "You do not have permission to view sharing for this tunnel");

    // available users excludes owner
    let r = app.get(&format!("/tunnels/available-users/{id}"), Some(&owner)).await;
    assert_eq!(r.json["users"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["users"][0]["username"], "bob");

    // share errors
    let r = app.post(&format!("/tunnels/share/{id}"), Some(&owner), json!({})).await;
    assert_eq!(r.json["error"], "shared_with_user_id is required");
    let r = app.post(&format!("/tunnels/share/{id}"), Some(&owner), json!({"shared_with_user_id": 999})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.json["error"], "User not found");
    let r = app.post(&format!("/tunnels/share/{id}"), Some(&owner), json!({"shared_with_user_id": bob_id, "permission_type": "god"})).await;
    assert_eq!(r.json["error"], "Invalid permission type: god. Valid values are: view, edit, admin");
    let r = app.post(&format!("/tunnels/share/{id}"), Some(&bob), json!({"shared_with_user_id": bob_id})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    // share view-only with an allow-list
    let r = app.post(&format!("/tunnels/share/{id}"), Some(&owner), json!({"shared_with_user_id": bob_id, "allowed_target_username_ids": [root_uid]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["message"], "Tunnel shared successfully");
    let r = app.post(&format!("/tunnels/share/{id}"), Some(&owner), json!({"shared_with_user_id": bob_id})).await;
    assert_eq!(r.json["error"], "Tunnel already shared with this user");

    // bob sees it as viewer
    let r = app.get("/api/reverse/server/dashboard", Some(&bob)).await;
    let bt = &r.json["tunnels"][0];
    assert_eq!(bt["is_owner"], false);
    assert_eq!(bt["user_permission"], "view");
    assert_eq!(bt["can_edit"], false);
    assert_eq!(bt["can_share"], false);
    let r = app.get("/api/reverse/server/dashboard", Some(&owner)).await;
    assert_eq!(r.json["tunnels"][0]["shared_with_count"], 1);

    // allowed usernames: bob can use root via allow-list
    let r = app.get(&format!("/api/reverse/server/{id}/usernames"), Some(&bob)).await;
    assert_eq!(r.json["usernames"][0]["username"], "root");
    // viewer cannot add usernames
    let r = app.post("/api/reverse/server/usernames", Some(&bob), json!({"reverse_server": id, "username": "bobuser"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json["detail"], "You don't have permission to add usernames to this tunnel.");
    // viewer cannot edit the tunnel
    let r = app.patch(&format!("/api/reverse/server/keys/{id}"), Some(&bob), json!({"description": "x"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json["detail"], "You don't have permission to edit this tunnel.");

    // shared-users listing
    let r = app.get(&format!("/tunnels/shared-users/{id}"), Some(&owner)).await;
    assert_eq!(r.status, StatusCode::OK);
    let u = &r.json["users"][0];
    assert_eq!(u["username"], "bob");
    assert_eq!(u["permission_type"], "view");
    assert_eq!(u["allowed_target_usernames"][0]["id"], root_uid);
    assert!(u["shared_at"].as_str().unwrap().ends_with("+00:00"));

    // an editor still cannot manage target users: only the owner and ADMIN sharees can
    let r = app.patch(&format!("/tunnels/update-permission/{id}/{bob_id}"), Some(&owner), json!({"permission_type": "edit"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["permission_type"], "edit");
    let r = app.post("/api/reverse/server/usernames", Some(&bob), json!({"reverse_server": id, "username": "bobuser"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = app.delete(&format!("/api/reverse/server/usernames/{root_uid}"), Some(&bob)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    // ADMIN adds one (sees every username), then a downgrade transfers it to the owner and bob is back to his allow-list
    let r = app.patch(&format!("/tunnels/update-permission/{id}/{bob_id}"), Some(&owner), json!({"permission_type": "admin"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.post("/api/reverse/server/usernames", Some(&bob), json!({"reverse_server": id, "username": "bobuser"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let r = app.post("/api/reverse/server/usernames", Some(&bob), json!({"reverse_server": id, "username": "root"})).await;
    assert_eq!(r.json, json!(["This tunnel already has a target user named 'root'."]), "names are unique per tunnel, whoever created them");
    let r = app.get(&format!("/api/reverse/server/{id}/usernames"), Some(&bob)).await;
    let names: Vec<&str> = r.json["usernames"].as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["root", "bobuser"]);
    let r = app.patch(&format!("/tunnels/update-permission/{id}/{bob_id}"), Some(&owner), json!({"permission_type": "view"})).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = app.get(&format!("/api/reverse/server/{id}/usernames"), Some(&owner)).await;
    let creators: Vec<&str> = r.json["usernames"].as_array().unwrap().iter().map(|u| u["created_by"].as_str().unwrap()).collect();
    assert_eq!(creators, vec!["owner", "owner"], "downgrade transfers bob's username to the owner");
    let r = app.get(&format!("/api/reverse/server/{id}/usernames"), Some(&bob)).await;
    let names: Vec<&str> = r.json["usernames"].as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["root"], "a viewer gets exactly the allow-list");

    // replace allow-list
    let r = app.patch(&format!("/tunnels/share/{id}/{bob_id}/allowed-usernames"), Some(&owner), json!({"allowed_target_username_ids": "nope"})).await;
    assert_eq!(r.json["error"], "allowed_target_username_ids must be a list");
    let r = app.patch(&format!("/tunnels/share/{id}/{bob_id}/allowed-usernames"), Some(&owner), json!({"allowed_target_username_ids": []})).await;
    assert_eq!(r.json["message"], "Allowed usernames updated");
    let r = app.get(&format!("/api/reverse/server/{id}/usernames"), Some(&bob)).await;
    assert_eq!(r.json["usernames"], json!([]), "empty allow-list → no target users at all");

    // self-unshare (leave)
    let r = app.delete(&format!("/tunnels/unshare/{id}/{bob_id}"), Some(&bob)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["message"], "Tunnel unshared successfully");
    let r = app.delete(&format!("/tunnels/unshare/{id}/{bob_id}"), Some(&owner)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.json["error"], "Sharing not found");
    let r = app.get("/api/reverse/server/dashboard", Some(&bob)).await;
    assert_eq!(r.json["tunnels"], json!([]));
}

#[tokio::test]
async fn user_keys_settings_and_admin_users() {
    let app = common::spawn().await;
    let admin = app.login("admin", "pw").await;

    // user keys
    let r = app.post("/api/reverse/user/keys", Some(&admin), json!({"host_friendly_name": "laptop", "key": USER_KEY, "description": ""})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let kid = r.json["id"].as_i64().unwrap();
    // russh 解析出的指紋 / 類型。/ Parsed by russh.
    assert_eq!(r.json["key_type"], "ED25519");
    assert_eq!(r.json["bits"], 256);
    assert_eq!(r.json["comment"], "laptop");
    assert!(r.json["fingerprint"].as_str().unwrap().starts_with("SHA256:"), "{}", r.text);
    assert_eq!(r.json["last_used_at"], Value::Null);
    let r = app.post("/api/reverse/user/keys", Some(&admin), json!({"host_friendly_name": "laptop", "key": USER_KEY_2})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!({"host_friendly_name": ["user keys with this Host Friendly Name already exists."]}));
    // 格式錯誤、太短的 RSA、同一把金鑰換個註解。/ Garbage, short RSA, same key with another comment.
    for bad in ["ssh-rsa BBBB other", RSA_1024, &USER_KEY.replace("laptop", "renamed")] {
        let r = app.post("/api/reverse/user/keys", Some(&admin), json!({"host_friendly_name": "second", "key": bad})).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}: {}", r.text);
        assert!(r.json["key"][0].is_string(), "{}", r.text);
    }
    let r = app.post("/api/reverse/user/keys", Some(&admin), json!({})).await;
    assert_eq!(r.json, json!({"host_friendly_name": ["This field is required."], "key": ["This field is required."]}));
    let r = app.patch(&format!("/api/reverse/user/keys/{kid}"), Some(&admin), json!({"description": "my laptop"})).await;
    assert_eq!(r.json["description"], "my laptop");
    let r = app.get("/api/reverse/user/keys", Some(&admin)).await;
    assert_eq!(r.json.as_array().unwrap().len(), 1);
    let r = app.delete(&format!("/api/reverse/user/keys/{kid}"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);

    // personal settings
    let r = app.get("/api/user/settings", Some(&admin)).await;
    assert_eq!(r.json, json!({"language": null, "theme": "system", "terminal_font_size": 14, "ui_scale": 100}));
    let r = app.post("/api/user/settings", Some(&admin), json!({"language": "zh-TW", "terminal_font_size": 16, "ui_scale": 115})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json, json!({"language": "zh-TW", "theme": "system", "terminal_font_size": 16, "ui_scale": 115}));
    let r = app.post("/api/user/settings", Some(&admin), json!({"ui_scale": 200})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["ui_scale"][0], "ui_scale must be between 85 and 130.");
    let r = app.post("/api/user/settings", Some(&admin), json!({"language": "fr"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["language"][0], "Invalid language 'fr'. Valid options: auto, en, ja, zh-TW.");
    let r = app.post("/api/user/settings", Some(&admin), json!({"terminal_font_size": 99})).await;
    assert_eq!(r.json["terminal_font_size"][0], "terminal_font_size must be between 10 and 24.");
    let r = app.get("/api/auth/user/profile", Some(&admin)).await;
    assert_eq!(r.json["language"], "zh-TW");
    assert_eq!(r.json["terminal_font_size"], 16);
    assert_eq!(r.json["ui_scale"], 115);

    // admin users
    let r = app.get("/api/user/users", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK);
    let u = &r.json["users"][0];
    assert_eq!(u["username"], "admin");
    assert_eq!(u["language"], "zh-TW");
    assert_eq!(u["is_superuser"], true);
    assert!(u["date_joined"].as_str().unwrap().ends_with("+08:00"));
    let admin_id = u["id"].as_i64().unwrap();
    let r = app.post(&format!("/api/user/users/{admin_id}"), Some(&admin), json!({"is_superuser": false})).await;
    assert_eq!(r.json["error"], "You cannot remove your own administrator role.");
    let r = app.post(&format!("/api/user/users/{admin_id}"), Some(&admin), json!({"is_active": "yes"})).await;
    assert_eq!(r.json["error"], "is_active must be a boolean.");
    let r = app.post("/api/user/users/999", Some(&admin), json!({"language": "en"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // non-admin gets empty site settings and 403 on write
    let r = app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    assert_eq!(r.status, StatusCode::OK);
    let bob = app.login("bob", "pw").await;
    let r = app.get("/api/site/settings", Some(&bob)).await;
    assert_eq!(r.json, json!({"values": {}, "meta": {}}));
    let r = app.post("/api/site/settings", Some(&bob), json!({"allow_registration": false})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = app.get("/api/user/users", Some(&bob)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json["error"], "Permission denied. Only administrators can list users.");

    // site settings validation
    let r = app.post("/api/site/settings", Some(&admin), json!({"remote_browser_max_sessions": "abc"})).await;
    assert_eq!(r.json, json!({"remote_browser_max_sessions": ["A valid integer is required."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"remote_browser_geometry": ""})).await;
    assert_eq!(r.json, json!({"remote_browser_geometry": ["This field may not be blank."]}));
    let r = app.get("/api/site/settings", Some(&admin)).await;
    let keys: Vec<&String> = r.json["values"].as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 22);
    assert_eq!(r.json["values"]["user_key_max_days"], 0, "personal keys don't expire by default");
    assert_eq!(r.json["values"]["notify_webhook_url"], "", "alerts are off by default");
    assert_eq!(r.json["values"]["notify_down_delay"], 60);
    assert_eq!(r.json["meta"]["notify_webhook_url"]["type"], "url");
    assert_eq!(r.json["meta"]["remote_browser_homepage"]["label"], "Remote Browser Homepage");
    assert_eq!(r.json["values"]["ai_session_idle_timeout"], 600);
    assert_eq!(r.json["values"]["ai_session_max_lifetime"], 7200);
    assert_eq!(r.json["values"]["ai_max_sessions_per_user"], 3);
    assert_eq!(r.json["values"]["lan_scan_enabled"], true);
    assert_eq!(r.json["meta"]["ai_max_sessions_per_user"]["type"], "integer");

    // logs: no gateway events yet → 200 with an empty string
    let r = app.get("/api/log/ssh", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json, json!(""));
}

/// 一次性 data migration：非 ADMIN 被分享者以前自己建的 username 全部刪掉（連同允許清單、預設值），之後不再跑。
#[tokio::test]
async fn legacy_sharee_usernames_are_dropped_once() {
    use telepy_server::db::{schema, sharing, tunnels, users};
    let app = common::spawn().await;
    let db = &app.state.db;
    let mk = |name: &'static str| users::NewUser { username: name, password_hash: "!", email: "", first_name: "", last_name: "" };
    let owner = users::create(db, mk("owner")).await.unwrap();
    let editor = users::create(db, mk("editor")).await.unwrap();
    let admin = users::create(db, mk("admin2")).await.unwrap();
    let gone = users::create(db, mk("gone")).await.unwrap();
    let t = tunnels::create(db, tunnels::NewTunnel { user_id: owner.id, host_friendly_name: "box", key: KEY_A, reverse_port: 40001, description: None, default_username_id: None }).await.unwrap();
    let s_editor = sharing::create(db, t.id, owner.id, editor.id, "edit").await.unwrap();
    sharing::create(db, t.id, owner.id, admin.id, "admin").await.unwrap();

    let ubuntu = tunnels::username_create(db, owner.id, t.id, "ubuntu").await.unwrap();
    let by_editor = tunnels::username_create(db, editor.id, t.id, "root").await.unwrap();
    tunnels::username_create(db, admin.id, t.id, "deploy").await.unwrap();
    tunnels::username_create(db, gone.id, t.id, "old").await.unwrap(); // creator no longer shared
    sharing::add_allowed_usernames(db, s_editor.id, t.id, &[ubuntu.id, by_editor.id]).await.unwrap();
    sqlx::query("UPDATE authorized_keys_reverseserverauthorizedkeys SET default_username_id = ? WHERE id = ?").bind(by_editor.id).bind(t.id).execute(&db.write).await.unwrap();

    // the fresh DB already recorded the migration; forget it to replay it on this data
    sqlx::query("DELETE FROM telepy_data_migration").execute(&db.write).await.unwrap();
    schema::ensure_schema(&db.write).await.unwrap();
    let names: Vec<String> = tunnels::usernames_for_tunnel(db, t.id).await.unwrap().into_iter().map(|u| u.username).collect();
    assert_eq!(names, vec!["ubuntu", "deploy"], "owner and ADMIN rows stay; editor and ex-sharee rows go");
    assert_eq!(sharing::allowed_username_ids(db, s_editor.id).await.unwrap(), vec![ubuntu.id]);
    assert_eq!(tunnels::by_id(db, t.id).await.unwrap().unwrap().default_username_id, None);

    // recorded → a later run leaves rows alone (e.g. an ADMIN downgraded afterwards keeps theirs)
    let later = tunnels::username_create(db, editor.id, t.id, "later").await.unwrap();
    schema::ensure_schema(&db.write).await.unwrap();
    assert!(tunnels::username_by_id(db, later.id).await.unwrap().is_some());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_data_migration WHERE name = ?").bind(schema::DROP_SHAREE_USERNAMES).fetch_one(&db.read).await.unwrap();
    assert_eq!(n, 1);
}
