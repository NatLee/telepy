//! REST parity tests：對照 Django 版的回應形狀、狀態碼與錯誤字串。
mod common;

use axum::http::{Method, StatusCode};
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
    // 伺服器區塊的別名 = 它的 HostKeyAlias（每台 Telepy 各一個）。/ The server alias is its HostKeyAlias.
    let server_alias = r.json["server"]["alias"].as_str().unwrap().to_string();
    assert!(server_alias.starts_with("telepy-") && server_alias != "telepy-ssh-server", "{server_alias}");
    assert!(cfg.contains(&format!("Host {server_alias}\n")), "{cfg}");
    assert!(cfg.contains(&format!("ProxyCommand ssh -W %h:%p {server_alias}\n")), "{cfg}");
    assert_eq!(r.json["server"]["legacy_alias"], "telepy-ssh-server");
    assert!(cfg.contains("Host box-a\n"), "{cfg}");
    assert!(cfg.contains("User ubuntu"), "{cfg}");
    assert_eq!(r.json["usernames"][0]["username"], "ubuntu");
    // 指令速查用的結構化欄位。/ Structured fields for the command sheet.
    assert_eq!(r.json["hosts"][0]["alias"], "box-a");
    assert_eq!(r.json["hosts"][0]["username"], "ubuntu");
    assert_eq!(r.json["hosts"][0]["username_id"], uname_id);
    assert_eq!(r.json["reverse_port"], 1024);
    // 這個測試 app 的 gateway 沒有 host key：退回不驗證（lab 上的測試走釘住的那條路）。
    // This test app's gateway has no host keys: the no-check fallback (the lab tests cover pinning).
    assert_eq!(r.json["known_hosts"], "", "{}", r.text);
    assert_eq!(r.json["known_hosts_path"], "~/.ssh/telepy_known_hosts");
    assert!(cfg.contains("StrictHostKeyChecking no"), "{cfg}");

    let r = app.get(&format!("/tunnels/server/script/ssh/{id}/22"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["language"], "bash");
    assert!(r.json["script"].as_str().unwrap().contains("-NR '*:0:localhost:22'"), "{}", r.text);
    assert!(r.json["script"].as_str().unwrap().contains("StrictHostKeyChecking=no"));
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
    assert_eq!(r.json, json!({"language": null, "theme": "system", "terminal_font_size": 14, "ui_scale": 100, "terminal_font": "hack", "terminal_scheme": "telepy", "terminal_bold": "face", "terminal_ligatures": false, "desktop_clipboard": "both", "desktop_clipboard_limit": "both", "terminal_detach_secs": 0, "terminal_detach_max_secs": 1800, "view_modes": {}, "ssh_alias_prefix": ""}));
    let r = app.post("/api/user/settings", Some(&admin), json!({"language": "zh-TW", "terminal_font_size": 16, "ui_scale": 115, "terminal_font": "fira-code", "terminal_scheme": "solarized-dark", "terminal_bold": "bright", "terminal_ligatures": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json, json!({"language": "zh-TW", "theme": "system", "terminal_font_size": 16, "ui_scale": 115, "terminal_font": "fira-code", "terminal_scheme": "solarized-dark", "terminal_bold": "bright", "terminal_ligatures": true, "desktop_clipboard": "both", "desktop_clipboard_limit": "both", "terminal_detach_secs": 0, "terminal_detach_max_secs": 1800, "view_modes": {}, "ssh_alias_prefix": ""}));
    // 各頁的卡片 / 清單顯示：整份取代，跟著帳號（profile 也帶）。/ Card / list per page: replaced whole, on the account (and the profile).
    let r = app.post("/api/user/settings", Some(&admin), json!({"view_modes": {"tunnels": "list", "key_groups": "card"}})).await;
    assert_eq!(r.json["view_modes"], json!({"key_groups": "card", "tunnels": "list"}), "{}", r.text);
    let r = app.get("/api/auth/user/profile", Some(&admin)).await;
    assert_eq!(r.json["view_modes"], json!({"key_groups": "card", "tunnels": "list"}), "{}", r.text);
    let r = app.post("/api/user/settings", Some(&admin), json!({"view_modes": {"tunnels": "grid"}})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.json["view_modes"][0].as_str().unwrap().starts_with("Must be an object"), "{}", r.text);
    let r = app.post("/api/user/settings", Some(&admin), json!({"view_modes": {"key_groups": "list"}})).await;
    assert_eq!(r.json["view_modes"], json!({"key_groups": "list"}), "{}", r.text);
    // 網頁終端機斷線保留：只收固定選項。/ Terminal detach grace: only the fixed choices.
    let r = app.post("/api/user/settings", Some(&admin), json!({"terminal_detach_secs": 42})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["terminal_detach_secs"][0], "Must be one of: 0, 60, 300, 900, 1800, 3600.");
    let r = app.post("/api/user/settings", Some(&admin), json!({"terminal_detach_secs": 900})).await;
    assert_eq!(r.json["terminal_detach_secs"], 900, "{}", r.text);
    let r = app.post("/api/site/settings", Some(&admin), json!({"terminal_detach_max_secs": 90000})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    // 粗體畫法 / 連字的值。/ Bold style and ligature values.
    let r = app.post("/api/user/settings", Some(&admin), json!({"terminal_bold": "heavy"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["terminal_bold"][0], "Must be one of: face, bright, both.");
    let r = app.post("/api/user/settings", Some(&admin), json!({"terminal_ligatures": "yes"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["terminal_ligatures"][0], "Must be a valid boolean.");
    // 字型 / 配色 id 只檢查形狀（清單在前端）。/ Font / scheme ids are shape-checked only.
    let r = app.post("/api/user/settings", Some(&admin), json!({"terminal_font": "Hack Nerd Font"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["terminal_font"][0], "Use 1-32 lowercase letters, digits or '-'.");
    let r = app.post("/api/user/settings", Some(&admin), json!({"terminal_scheme": ""})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
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
    assert_eq!(r.json["terminal_font"], "fira-code");
    assert_eq!(r.json["terminal_scheme"], "solarized-dark");
    assert_eq!(r.json["terminal_bold"], "bright");
    assert_eq!(r.json["terminal_ligatures"], true);

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
    assert_eq!(keys.len(), 35);
    assert_eq!(r.json["values"]["signin_page_style"], "standard", "the sign-in page shows the product by default");
    assert_eq!(r.json["values"]["signin_oauth_style"], "standard");
    assert_eq!(r.json["values"]["signin_page_message"], "");
    assert_eq!(r.json["values"]["desktop_file_transfer"], true, "RustDesk file transfer is allowed by default");
    assert_eq!(r.json["values"]["terminal_detach_max_secs"], 1800, "a detached web terminal is kept at most 30 minutes by default");
    assert_eq!(r.json["values"]["command_approval_timeout"], 300, "approvals wait five minutes by default");
    assert_eq!(r.json["values"]["signin_lifetime"], 2_592_000, "a sign-in lasts 30 days without a visit by default");
    assert_eq!(r.json["values"]["signin_access_lifetime"], 3600, "access tokens are renewed hourly by default");
    assert_eq!(r.json["values"]["user_key_max_days"], 0, "personal keys don't expire by default");
    assert_eq!(r.json["values"]["device_ip_lookup_url"], "https://api.ipify.org", "devices ask ipify only when Telepy cannot see their public IP");
    assert_eq!(r.json["values"]["notify_user_webhooks"], true, "everyone may set up their own webhooks by default");
    assert_eq!(r.json["values"]["notify_private_targets"], false, "personal webhooks may not reach private addresses by default");
    assert_eq!(r.json["values"]["notify_max_webhooks"], 10);
    assert!(r.json["values"].get("notify_webhook_url").is_none(), "the single alert URL became a site-wide webhook");
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

/// 列表的 `shared_with`（「已分享給 N 人」hover 的名單）：owner 與 ADMIN sharee 看得到、依分享先後、權限是現在有效的那個；
/// 其他 sharee 是 null。/ The list's `shared_with`: owner and ADMIN sharees see it, in sharing order with the permission in force; others get null.
#[tokio::test]
async fn shared_with_names_go_to_owner_and_admin_sharees_only() {
    let app = common::spawn().await;
    let (owner, bob) = app.admin_and_user("owner", "bob").await;
    let carol = app.login("carol", "pw").await;
    let bob_id = app.get("/api/auth/user/profile", Some(&bob)).await.json["id"].as_i64().unwrap();
    let carol_id = app.get("/api/auth/user/profile", Some(&carol)).await.json["id"].as_i64().unwrap();
    let t = create_tunnel(&app, &owner, "shared-box", KEY_A).await;
    let id = t["id"].as_i64().unwrap();
    let item = |json: &Value| json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).cloned().unwrap();

    // not shared yet: the owner gets an empty list, not null
    let r = app.get("/api/reverse/server/dashboard", Some(&owner)).await;
    assert_eq!(item(&r.json)["shared_with"], json!([]));

    for (uid, perm) in [(carol_id, "view"), (bob_id, "admin")] {
        let r = app.post(&format!("/tunnels/share/{id}"), Some(&owner), json!({"shared_with_user_id": uid, "permission_type": perm})).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    }
    let expected = json!([
        {"id": carol_id, "username": "carol", "permission": "view"},
        {"id": bob_id, "username": "bob", "permission": "admin"},
    ]);
    // the owner: names in sharing order, like the share dialog
    let r = app.get("/api/reverse/server/dashboard", Some(&owner)).await;
    let o = item(&r.json);
    assert_eq!(o["shared_with_count"], 2);
    assert_eq!(o["shared_with"], expected);
    let r = app.get("/api/reverse/server/keys", Some(&owner)).await;
    assert_eq!(r.json.as_array().unwrap().iter().find(|t| t["id"] == id).unwrap()["shared_with"], expected, "the plain list carries it too");
    // an ADMIN sharee manages sharing, so they see it as well
    let r = app.get("/api/reverse/server/dashboard", Some(&bob)).await;
    assert_eq!(item(&r.json)["shared_with"], expected);
    // a VIEW sharee does not
    let r = app.get("/api/reverse/server/dashboard", Some(&carol)).await;
    assert!(item(&r.json)["shared_with"].is_null(), "{}", r.text);

    // a temporary raise that ran out counts as the original permission (before the reaper reverts it)
    sqlx::query("UPDATE tunnels_tunnelsharing SET base_permission = 'view', permission_until = '2000-01-01 00:00:00.000000' WHERE shared_with_id = ?")
        .bind(bob_id)
        .execute(&app.state.db.write)
        .await
        .unwrap();
    let r = app.get("/api/reverse/server/dashboard", Some(&owner)).await;
    assert_eq!(item(&r.json)["shared_with"][1], json!({"id": bob_id, "username": "bob", "permission": "view"}));
    let r = app.get("/api/reverse/server/dashboard", Some(&bob)).await;
    assert!(item(&r.json)["shared_with"].is_null(), "an expired ADMIN raise no longer shows the list");
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
    let s_editor = sharing::create(db, t.id, owner.id, editor.id, "edit", None).await.unwrap();
    sharing::create(db, t.id, owner.id, admin.id, "admin", None).await.unwrap();

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

async fn put_profile(app: &common::TestApp, path: &str, token: &str, body: Value) -> common::Resp {
    app.request(Method::PUT, path, Some(token), Some(body)).await
}

/// 每個使用者對每條隧道的終端機外觀覆寫：看得到就能設、只影響自己、PUT 整列覆寫、全 null = 刪列、隧道刪了一起刪。
/// Per-user, per-tunnel terminal appearance override: visible → settable, affects only the caller, PUT replaces
/// the row, all null removes it, and it goes with the tunnel.
#[tokio::test]
async fn terminal_profile_per_tunnel() {
    let app = common::spawn().await;
    let owner = app.login("owner", "pw").await;
    let r = app.post("/api/site/settings", Some(&owner), json!({"allow_registration": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let bob = app.login("bob", "pw").await;
    let bob_id = app.get("/api/auth/user/profile", Some(&bob)).await.json["id"].as_i64().unwrap();
    let t = create_tunnel(&app, &owner, "box", KEY_A).await;
    let id = t["id"].as_i64().unwrap();
    let path = format!("/api/reverse/server/{id}/terminal-profile");

    // 還沒有覆寫 = 全 null。/ No override yet.
    let r = app.get(&path, Some(&owner)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json, json!({"tunnel_id": id, "font": null, "font_size": null, "scheme": null, "bold": null, "ligatures": null}));
    // 看不到隧道 → 404（讀寫皆然）。/ Not visible → 404 for reads and writes.
    assert_eq!(app.get(&path, Some(&bob)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(put_profile(&app, &path, &bob, json!({"scheme": "nord"})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/reverse/server/999/terminal-profile", Some(&owner)).await.status, StatusCode::NOT_FOUND);

    let r = put_profile(&app, &path, &owner, json!({"font": "fira-code", "scheme": "nord", "bold": "both", "ligatures": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json, json!({"tunnel_id": id, "font": "fira-code", "font_size": null, "scheme": "nord", "bold": "both", "ligatures": true}));
    assert_eq!(app.get(&path, Some(&owner)).await.json["scheme"], "nord");

    // 驗證：字級範圍、id 形狀。/ Validation: size range, id shape.
    let r = put_profile(&app, &path, &owner, json!({"font_size": 30})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["font_size"][0], "font_size must be between 10 and 24.");
    let r = put_profile(&app, &path, &owner, json!({"font": "Hack Nerd Font"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["font"][0], "Use 1-32 lowercase letters, digits or '-'.");
    let r = put_profile(&app, &path, &owner, json!({"font_size": "big"})).await;
    assert_eq!(r.json["font_size"][0], "A valid integer is required.");
    let r = put_profile(&app, &path, &owner, json!({"bold": "heavy"})).await;
    assert_eq!(r.json["bold"][0], "Must be one of: face, bright, both.");
    let r = put_profile(&app, &path, &owner, json!({"ligatures": 1})).await;
    assert_eq!(r.json["ligatures"][0], "Must be a valid boolean.");
    // 錯誤的 PUT 不動原本的覆寫。/ A rejected PUT leaves the stored override alone.
    assert_eq!(app.get(&path, Some(&owner)).await.json["font"], "fira-code");

    // PUT 是整列覆寫：只給 font_size → font / scheme 回到跟隨預設。/ PUT replaces the whole row.
    let r = put_profile(&app, &path, &owner, json!({"font_size": 18, "font": null})).await;
    assert_eq!(r.json, json!({"tunnel_id": id, "font": null, "font_size": 18, "scheme": null, "bold": null, "ligatures": null}));
    // 只有連字 = 仍是一個覆寫（false 也算，它跟「跟隨預設」不同）。/ Ligatures alone is still an override (false counts: it differs from inheriting).
    let r = put_profile(&app, &path, &owner, json!({"ligatures": false})).await;
    assert_eq!(r.json, json!({"tunnel_id": id, "font": null, "font_size": null, "scheme": null, "bold": null, "ligatures": false}));
    // 全部跟隨預設 = 刪掉覆寫列。/ Everything inherits = the row goes away.
    let r = put_profile(&app, &path, &owner, json!({})).await;
    assert_eq!(r.json, json!({"tunnel_id": id, "font": null, "font_size": null, "scheme": null, "bold": null, "ligatures": null}));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_terminal_profile").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(n, 0);

    // 覆寫是每個人自己的：分享給 bob 後，他看到的是自己的（空），兩邊互不影響。
    // Overrides are personal: once shared, bob sees his own (empty) one and neither side affects the other.
    assert_eq!(put_profile(&app, &path, &owner, json!({"scheme": "dracula"})).await.status, StatusCode::OK);
    let r = app.post(&format!("/tunnels/share/{id}"), Some(&owner), json!({"shared_with_user_id": bob_id})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(app.get(&path, Some(&bob)).await.json["scheme"], Value::Null);
    assert_eq!(put_profile(&app, &path, &bob, json!({"scheme": "nord", "font_size": 12})).await.status, StatusCode::OK);
    assert_eq!(app.get(&path, Some(&owner)).await.json["scheme"], "dracula");
    assert_eq!(app.get(&path, Some(&bob)).await.json["font_size"], 12);

    // DELETE 只刪自己的。/ DELETE removes only the caller's row.
    assert_eq!(app.delete(&path, Some(&owner)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.delete(&path, Some(&owner)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get(&path, Some(&owner)).await.json["scheme"], Value::Null);
    assert_eq!(app.get(&path, Some(&bob)).await.json["scheme"], "nord");

    // 隧道刪除連帶刪掉覆寫列。/ Deleting the tunnel removes the remaining rows.
    let r = app.delete(&format!("/api/reverse/server/keys/{id}"), Some(&owner)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["deleted"], true, "{}", r.text);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_terminal_profile").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(n, 0);
    assert_eq!(app.get(&path, Some(&bob)).await.status, StatusCode::NOT_FOUND);
}

/// 裝置金鑰全站唯一（不看註解、不分誰的），也不能是任何人的個人金鑰或 Telepy 的服務金鑰：公鑰不是祕密，別人拿你裝置的
/// 公鑰換個註解就能登記，而 gateway 只認金鑰。/ Device keys are unique across users (comment ignored) and never a personal or service key.
#[tokio::test]
async fn device_keys_are_unique_across_users_and_never_personal_or_service_keys() {
    let app = common::spawn().await;
    let admin = app.login("admin", "pw").await;
    // 第二個帳號直接建在 DB（註冊預設只開給第一個人）。/ The second account goes straight into the DB.
    let bob_user = telepy_server::db::users::create(&app.state.db, telepy_server::db::users::NewUser { username: "bob", password_hash: "!", email: "", first_name: "", last_name: "" }).await.unwrap();
    let bob = app.state.jwt.access(bob_user.id, std::time::Duration::from_secs(3600));
    create_tunnel(&app, &admin, "box-a", KEY_A).await;
    let renamed = KEY_A.replace("device-a", "stolen");
    let issue = |token: String| { let app = &app; async move { app.get("/api/reverse/issue/token", Some(&token)).await.json["token"].as_str().unwrap().to_string() } };

    // 別人的裝置金鑰、換個註解：查重與建立都擋。/ Another user's device key under a new comment: refused by both calls.
    let t = issue(bob.clone()).await;
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": renamed})).await;
    assert_eq!((r.status, r.json["key_exists"].as_bool(), r.json["key_reason"].as_str(), r.json["error"].as_str()), (StatusCode::BAD_REQUEST, Some(true), Some("taken"), Some("Key already exists")), "{}", r.text);
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": renamed})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["error"].as_str().unwrap().starts_with("This key is already registered as a device key"), "{}", r.text);

    // 某人的個人金鑰。/ Someone's personal key.
    let r = app.post("/api/reverse/user/keys", Some(&admin), json!({"host_friendly_name": "laptop", "key": USER_KEY})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": USER_KEY.replace("laptop", "x")})).await;
    assert_eq!((r.status, r.json["key_reason"].as_str()), (StatusCode::BAD_REQUEST, Some("personal")), "{}", r.text);
    assert!(r.json["error"].as_str().unwrap().starts_with("This is a personal key"), "{}", r.text);
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": USER_KEY})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);

    // Telepy 的服務金鑰。/ Telepy's own service key.
    telepy_server::db::keys::service_key_upsert(&app.state.db, "web-service", USER_KEY_2, "").await.unwrap();
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": USER_KEY_2})).await;
    assert_eq!((r.status, r.json["key_reason"].as_str()), (StatusCode::BAD_REQUEST, Some("service")), "{}", r.text);

    // 太弱的金鑰在查重就說明；名稱撞到時兩件事一起講。/ Weak keys are explained by the check too; with a taken name, both.
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": RSA_1024})).await;
    assert_eq!((r.status, r.json["key_reason"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid")), "{}", r.text);
    assert!(r.json["error"].as_str().unwrap().contains("2048"), "{}", r.text);
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": RSA_1024})).await;
    assert!(r.json["error"].as_str().unwrap().contains("2048"), "{}", r.text);
    let t2 = issue(admin.clone()).await;
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t2}"), Some(&admin), json!({"host_friendly_name": "box-a", "key": renamed})).await;
    assert_eq!((r.json["host_friendly_name_exists"].as_bool(), r.json["key_reason"].as_str(), r.json["error"].as_str()), (Some(true), Some("taken"), Some("Host friendly name and key already exists")), "{}", r.text);

    // 一把新的金鑰照常。/ A fresh key is fine.
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": KEY_B})).await;
    assert_eq!((r.status, r.json["key_exists"].as_bool(), r.json["key_reason"].is_null()), (StatusCode::OK, Some(false), true), "{}", r.text);
    assert_eq!(app.post(&format!("/api/reverse/create/key/{t}"), Some(&bob), json!({"host_friendly_name": "mine", "key": KEY_B})).await.status, StatusCode::OK);
}

/// 自訂終端機配色：自己的清單、後端產生的 id、嚴格的顏色驗證、每人 20 個、別人的 id 看起來像不存在、
/// 刪掉後引用它的設定留著（前端回到預設配色）。
/// Custom terminal schemes: own list, server-made ids, strict colour validation, 20 per person, someone
/// else's id looks missing, and a deleted scheme leaves the settings that point at it alone (the frontend
/// falls back to the default).
#[tokio::test]
async fn terminal_schemes_crud() {
    let app = common::spawn().await;
    let (alice, bob) = app.admin_and_user("alice", "bob").await;
    let path = "/api/user/terminal-schemes";
    let colors = |fg: &str| {
        let mut m = serde_json::Map::new();
        for k in ["foreground", "background", "cursor", "selectionBackground", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
            "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] {
            m.insert(k.into(), json!("#102030"));
        }
        m.insert("foreground".into(), json!(fg));
        Value::Object(m)
    };

    assert_eq!(app.get(path, Some(&alice)).await.json, json!([]));

    // 驗證：名稱、顏色。/ Validation: name, colours.
    let r = app.post(path, Some(&alice), json!({"colors": colors("#ffffff")})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["name"][0], "This field is required.");
    let r = app.post(path, Some(&alice), json!({"name": "  ", "colors": colors("#ffffff")})).await;
    assert_eq!(r.json["name"][0], "This field may not be blank.");
    let r = app.post(path, Some(&alice), json!({"name": "x".repeat(41), "colors": colors("#ffffff")})).await;
    assert_eq!(r.json["name"][0], "Ensure this field has no more than 40 characters.");
    let r = app.post(path, Some(&alice), json!({"name": "Mine", "colors": colors("white")})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["colors"][0], "colors.foreground must be a #rrggbb colour.");
    let r = app.post(path, Some(&alice), json!({"name": "Mine"})).await;
    assert_eq!(r.json["colors"][0], "colors must be an object.");
    let mut partial = colors("#ffffff");
    partial.as_object_mut().unwrap().remove("brightCyan");
    let r = app.post(path, Some(&alice), json!({"name": "Mine", "colors": partial})).await;
    assert_eq!(r.json["colors"][0], "colors.brightCyan is required.");

    // 新增：id 由後端產生、顏色小寫化、選填的欄位照給的回。/ Create: server id, lower-cased colours, optional keys echoed.
    let mut c = colors("#FFFFFF");
    c.as_object_mut().unwrap().insert("cursorAccent".into(), json!("#000000"));
    let r = app.post(path, Some(&alice), json!({"name": " Office dark ", "colors": c})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let id = r.json["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("custom-") && id.len() == 15, "{id}");
    assert_eq!(r.json["name"], "Office dark");
    assert_eq!(r.json["colors"]["foreground"], "#ffffff");
    assert_eq!(r.json["colors"]["cursorAccent"], "#000000");
    assert!(r.json["colors"].get("selectionForeground").is_none());
    assert!(r.json["created_at"].as_str().unwrap().ends_with('Z'));
    let list = app.get(path, Some(&alice)).await.json;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], id);

    // 只有本人看得到 / 改得到。/ Owner only.
    assert_eq!(app.get(path, Some(&bob)).await.json, json!([]));
    assert_eq!(app.patch(&format!("{path}/{id}"), Some(&bob), json!({"name": "Stolen"})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&format!("{path}/{id}"), Some(&bob)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get(path, Some(&alice)).await.json[0]["name"], "Office dark");

    // PATCH：只改給的欄位；colors 整組換。/ PATCH: only the given fields; colors replaces the whole set.
    let r = app.patch(&format!("{path}/{id}"), Some(&alice), json!({"name": "Office"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["name"], "Office");
    assert_eq!(r.json["colors"]["cursorAccent"], "#000000");
    let r = app.patch(&format!("{path}/{id}"), Some(&alice), json!({"colors": colors("#eeeeee")})).await;
    assert_eq!(r.json["colors"]["foreground"], "#eeeeee");
    assert!(r.json["colors"].get("cursorAccent").is_none());
    let r = app.patch(&format!("{path}/{id}"), Some(&alice), json!({"colors": colors("bad")})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.patch(&format!("{path}/custom-00000000"), Some(&alice), json!({"name": "x"})).await.status, StatusCode::NOT_FOUND);

    // 自訂的 id 可以當個人預設與每條隧道的覆寫（後端只看形狀）。/ The id is accepted by the settings and overrides.
    let r = app.post("/api/user/settings", Some(&alice), json!({"terminal_scheme": id})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["terminal_scheme"], id);

    // 每人 20 個。/ 20 per person.
    for i in 1..20 {
        let r = app.post(path, Some(&alice), json!({"name": format!("s{i}"), "colors": colors("#ffffff")})).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    }
    let r = app.post(path, Some(&alice), json!({"name": "one too many", "colors": colors("#ffffff")})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["code"], "limit");
    assert_eq!(app.get(path, Some(&alice)).await.json.as_array().unwrap().len(), 20);
    // bob 不受 alice 的數量影響。/ bob's quota is his own.
    assert_eq!(app.post(path, Some(&bob), json!({"name": "b", "colors": colors("#ffffff")})).await.status, StatusCode::CREATED);

    // 刪除：設定裡的引用留著（前端回到預設）。/ Delete: the setting keeps the id (the frontend falls back).
    assert_eq!(app.delete(&format!("{path}/{id}"), Some(&alice)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.delete(&format!("{path}/{id}"), Some(&alice)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get(path, Some(&alice)).await.json.as_array().unwrap().len(), 19);
    assert_eq!(app.get("/api/user/settings", Some(&alice)).await.json["terminal_scheme"], id);
}
