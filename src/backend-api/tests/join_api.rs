//! 一行指令加入裝置（#14）端到端：網頁發票 → 「裝置」用 token 註冊 → 用回傳的設定（釘住 gateway host key）
//! 把隧道連上 → 伺服器真的透過隧道登入一次 → verified。也測 token 單次使用、撤銷、重新加入與失敗的登入。
//! One-command device join end to end on the SSH lab: mint, register, connect with the pinned host keys,
//! and the server's test login; plus single use, revocation, rejoin and a failed login.
mod common;

use std::collections::HashMap;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};

use common::lab::Lab;
use common::{Resp, TestApp};

async fn device_post(app: &TestApp, token: &str, body: Value) -> Resp {
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/join/{token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/plain")
        .body(Body::from(body.to_string()))
        .unwrap();
    app.send(req).await
}

/// `KEY=value` 行 → map（重複的 key 收成多個值）。/ Parse `KEY=value` lines.
fn kv(text: &str) -> HashMap<String, Vec<String>> {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once('=') {
            m.entry(k.to_string()).or_default().push(v.to_string());
        }
    }
    m
}

fn one(m: &HashMap<String, Vec<String>>, k: &str) -> String {
    m.get(k).and_then(|v| v.first()).cloned().unwrap_or_default()
}

async fn wait_phase(app: &TestApp, token: &str, want: &str) -> HashMap<String, Vec<String>> {
    for _ in 0..200 {
        let r = app.get(&format!("/api/join/{token}/status"), None).await;
        let m = kv(&r.text);
        let phase = one(&m, "PHASE");
        if phase == want || phase == "failed" || phase == "verified" {
            assert_eq!(phase, want, "status: {}", r.text);
            return m;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("join never reached {want}");
}

#[tokio::test]
async fn one_command_join() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let pi = lab.machine("pi", &[("ubuntu", &[&lab.service]), ("nobody", &[])], false).await;

    // 網頁發票。/ Mint a ticket on the web.
    assert_eq!(app.post("/api/reverse/join", Some(&alice.token), json!({"name": "9lives"})).await.status, StatusCode::BAD_REQUEST);
    let r = app.post("/api/reverse/join", Some(&alice.token), json!({"name": "office-pi", "key_list": "mine"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let token = r.json["token"].as_str().unwrap().to_string();
    let id = r.json["id"].as_str().unwrap().to_string();
    assert!(token.starts_with("tpj_"));
    assert!(r.json["command"].as_str().unwrap().ends_with(&format!("/api/join/install.sh' | sudo sh -s -- --token {token}")), "{}", r.json["command"]);
    assert!(!r.json["command_no_sudo"].as_str().unwrap().contains("sudo"));
    assert_eq!(r.json["phase"], "waiting");
    assert_eq!(app.get(&format!("/api/reverse/join/{id}"), Some(&bob.token)).await.status, StatusCode::NOT_FOUND, "only the owner sees it");

    // 安裝腳本：公開、帶入伺服器網址。/ The install script is public and carries the server URL.
    let r = app.get("/api/join/install.sh", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text.starts_with("#!/bin/sh") && r.text.contains("TELEPY_URL='http://") && !r.text.contains("${server_url}"), "{}", &r.text[..200]);

    // 裝置註冊。/ The device registers.
    let device_key = lab.keygen("pi-device");
    let bad = device_post(app, &token, json!({"public_key": "not a key", "username": "ubuntu"})).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert!(bad.text.starts_with("ERROR="), "{}", bad.text);
    let bad = device_post(app, &token, json!({"public_key": device_key.public, "username": "-oProxyCommand=x"})).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST, "unsafe login names are refused");
    let reg = device_post(app, &token, json!({"public_key": device_key.public, "hostname": "raspberrypi", "username": "ubuntu", "ssh_port": 22, "os": "Linux aarch64"})).await;
    assert_eq!(reg.status, StatusCode::CREATED, "{}", reg.text);
    let m = kv(&reg.text);
    assert_eq!(one(&m, "TUNNEL_NAME"), "office-pi", "the name chosen on the web wins");
    assert_eq!(one(&m, "GATEWAY_USER"), "telepy");
    assert_eq!(one(&m, "GATEWAY_PORT"), lab.gw_port.to_string());
    assert_eq!(one(&m, "SERVICE_KEY").split_whitespace().take(2).collect::<Vec<_>>(), lab.service.public.split_whitespace().take(2).collect::<Vec<_>>());
    let host_keys = m.get("HOST_KEY").cloned().unwrap_or_default();
    assert!(!host_keys.is_empty() && host_keys.iter().all(|k| k.starts_with("ssh-")), "{}", reg.text);
    let tunnel_id: i64 = one(&m, "TUNNEL_ID").parse().unwrap();
    let reverse_port: u16 = one(&m, "REVERSE_PORT").parse().unwrap();
    assert!(one(&m, "WEB_URL").ends_with("/tunnels"));

    // 單次使用。/ Single use.
    let again = device_post(app, &token, json!({"public_key": device_key.public, "username": "ubuntu"})).await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{}", again.text);

    // 建好的隧道：預設帳號、我的金鑰清單、描述。/ The tunnel: default login, key list seeded, description.
    let r = app.get(&format!("/api/reverse/server/{tunnel_id}/usernames"), Some(&alice.token)).await;
    assert_eq!(r.json["usernames"][0]["username"], "ubuntu", "{}", r.text);
    assert_eq!(r.json["default_username_id"], r.json["usernames"][0]["id"]);
    let t = telepy_server::db::tunnels::by_id(&app.state.db, tunnel_id).await.unwrap().unwrap();
    assert_eq!(t.description.as_deref(), Some("Joined from raspberrypi (Linux aarch64)"));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_device_key WHERE tunnel_id = ?").bind(tunnel_id).fetch_one(&app.state.db.read).await.unwrap();
    assert!(n >= 1, "key list seeded with alice's key");
    assert_eq!(wait_phase(app, &token, "registered").await.get("TUNNEL_ID").unwrap()[0], tunnel_id.to_string());

    // 隧道連上（host key 釘住）→ 伺服器登入一次 → verified。/ Up with pinned host keys → verified.
    let mut rx = app.state.hub.subscribe_user(alice.id);
    lab.connect_joined(tunnel_id, &device_key, reverse_port, &pi, &host_keys).await;
    wait_phase(app, &token, "verified").await;
    let r = app.get(&format!("/api/reverse/join/{id}"), Some(&alice.token)).await;
    assert_eq!((r.json["phase"].as_str(), r.json["tunnel_id"].as_i64(), r.json["hostname"].as_str(), r.json["ssh_port"].as_i64()), (Some("verified"), Some(tunnel_id), Some("raspberrypi"), Some(22)), "{}", r.text);
    let mut phases = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        let v: Value = serde_json::from_str(&msg).unwrap();
        if v["message"]["action"] == "JOIN-UPDATED" {
            phases.push(v["message"]["phase"].as_str().unwrap().to_string());
        }
    }
    assert!(phases.contains(&"connected".to_string()) && phases.contains(&"verified".to_string()), "{phases:?}");
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(&alice.token)).await;
    let joins: Vec<&Value> = r.json.as_array().unwrap().iter().filter(|e| e["event"] == "join").collect();
    assert_eq!(joins.len(), 2, "{}", r.text);
    assert!(joins[1]["message"].as_str().unwrap().contains("verified"));

    // 同一台再跑一次（新票、同一把金鑰）→ 同一條隧道。/ Re-running on the same machine rejoins the same tunnel.
    let token2 = app.post("/api/reverse/join", Some(&alice.token), json!({})).await.json["token"].as_str().unwrap().to_string();
    let m = kv(&device_post(app, &token2, json!({"public_key": device_key.public, "hostname": "raspberrypi", "username": "ubuntu"})).await.text);
    assert_eq!(one(&m, "TUNNEL_ID"), tunnel_id.to_string());
    wait_phase(app, &token2, "verified").await;
    // 別人的金鑰不能拿來加入。/ Another user's device key cannot be claimed.
    let token3 = app.post("/api/reverse/join", Some(&bob.token), json!({})).await.json["token"].as_str().unwrap().to_string();
    let r = device_post(app, &token3, json!({"public_key": device_key.public, "username": "ubuntu"})).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.text);

    // 名稱沿用主機名稱、撞名加 -2；登入失敗會說明原因。/ Hostname naming with a suffix; a failed login is explained.
    let r = app.post("/api/reverse/join", Some(&bob.token), json!({"name": "office-pi"})).await;
    assert_eq!(r.json["name"][0], "A tunnel with this name already exists.", "{}", r.text);
    let other_key = lab.keygen("pi2-device");
    let m = kv(&device_post(app, &token3, json!({"public_key": other_key.public, "hostname": "office-pi", "username": "nobody"})).await.text);
    assert_eq!(one(&m, "TUNNEL_NAME"), "office-pi-2");
    let tid: i64 = one(&m, "TUNNEL_ID").parse().unwrap();
    lab.connect_joined(tid, &other_key, one(&m, "REVERSE_PORT").parse().unwrap(), &pi, &m["HOST_KEY"]).await;
    let m = wait_phase(app, &token3, "failed").await;
    assert!(one(&m, "DETAIL").contains("did not accept Telepy's key for nobody"), "{m:?}");

    // 撤銷與無效 token。/ Revocation and unknown tokens.
    let r = app.post("/api/reverse/join", Some(&alice.token), json!({})).await;
    let (tok, tid) = (r.json["token"].as_str().unwrap().to_string(), r.json["id"].as_str().unwrap().to_string());
    assert_eq!(app.delete(&format!("/api/reverse/join/{tid}"), Some(&bob.token)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&format!("/api/reverse/join/{tid}"), Some(&alice.token)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(device_post(app, &tok, json!({"public_key": lab.keygen("x").public, "username": "ubuntu"})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/join/tpj_nope/status", None).await.status, StatusCode::NOT_FOUND);
}
