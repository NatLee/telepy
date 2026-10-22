//! 區網探索（#20）端到端：真的 gateway + 真的 OpenSSH 反向隧道 + 裝置 sshd（lab 的 Machine，可當跳板），
//! 裝置「區網」裡有一台 sshd（nas）、一個普通 TCP 服務、一個沒開的 port。
//! LAN discovery end to end through a real gateway, a real reverse tunnel and a jump-capable device sshd.
mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;

use common::lab::{free_port, Lab};
use common::TestApp;

async fn wait_scan(app: &TestApp, token: &str, tunnel_id: i64) -> Value {
    for _ in 0..150 {
        let r = app.get(&format!("/api/reverse/server/{tunnel_id}/lan/scan"), Some(token)).await;
        if r.json["phase"] == "done" || r.json["phase"] == "failed" {
            return r.json;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("the scan did not finish");
}

/// 一個不送任何東西的 TCP 服務（像 HTTP）。/ A TCP service that sends nothing first (like HTTP).
async fn quiet_listener() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                drop(s);
            });
        }
    });
    port
}

const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-0123";

async fn mcp_token(app: &TestApp, web: &str, scope: &str) -> String {
    let r = app.post("/api/oauth/register", None, json!({"client_name": "Agent", "redirect_uris": ["http://localhost:9/cb"], "token_endpoint_auth_method": "none"})).await;
    let client_id = r.json["client_id"].as_str().unwrap().to_string();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(VERIFIER.as_bytes()));
    let r = app
        .post("/api/oauth/authorize", Some(web), json!({"response_type": "code", "client_id": client_id, "redirect_uri": "http://localhost:9/cb", "code_challenge": challenge, "code_challenge_method": "S256", "scope": scope, "approve": true}))
        .await;
    let to = url::Url::parse(r.json["redirect_to"].as_str().unwrap()).unwrap();
    let code = to.query_pairs().find(|(k, _)| k == "code").unwrap().1.into_owned();
    let form = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([("grant_type", "authorization_code"), ("code", code.as_str()), ("client_id", client_id.as_str()), ("code_verifier", VERIFIER)])
        .finish();
    let r = app.send(Request::post("/api/oauth/token").header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(Body::from(form)).unwrap()).await;
    r.json["access_token"].as_str().unwrap().to_string()
}

async fn call(app: &TestApp, token: &str, tool: &str, args: Value) -> (bool, Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/mcp")
        .header(header::HOST, "telepy.test")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}).to_string()))
        .unwrap();
    let r = app.send(req).await;
    let result = &r.json["result"];
    let value = if result["structuredContent"].is_object() { result["structuredContent"].clone() } else { result["content"][0]["text"].clone() };
    (result["isError"].as_bool().unwrap_or(false), value)
}

#[tokio::test]
async fn lan_discovery_through_the_device() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], true).await;
    let nas = lab.machine("nas", &[("admin", &[&lab.service])], false).await;
    let web = quiet_listener().await;
    let closed = free_port();
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let id = dev.tunnel_id;
    let ports = json!([nas.port, web, closed]);

    // VIEW 分享者不能掃。/ A VIEW sharee cannot scan.
    let r = app.post(&format!("/api/reverse/server/{id}/lan/scan"), Some(&bob.token), json!({"subnets": ["127.0.0.1/32"], "ports": ports})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("lan_scan_forbidden")), "{}", r.text);

    // owner 掃：由裝置的 sshd 去連。/ The owner scans; the device's sshd makes the connections.
    let mut alice_rx = app.state.hub.subscribe_user(alice.id);
    let r = app.post(&format!("/api/reverse/server/{id}/lan/scan"), Some(&alice.token), json!({"subnets": ["127.0.0.1/32"], "ports": ports})).await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.text);
    let st = wait_scan(app, &alice.token, id).await;
    assert_eq!(st["phase"], "done", "{st}");
    assert_eq!(st["networks"], json!(["127.0.0.1/32"]));
    assert_eq!(st["hosts_found"], 1);
    assert_eq!(st["started_by"], "alice");
    let mut actions = Vec::new();
    while let Ok(m) = alice_rx.try_recv() {
        actions.push(serde_json::from_str::<Value>(&m).unwrap()["message"]["action"].as_str().unwrap().to_string());
    }
    assert!(actions.contains(&"LAN-SCAN-PROGRESS".to_string()) && actions.contains(&"LAN-SCAN-DONE".to_string()) && actions.contains(&"UPDATED-LAN-HOSTS".to_string()), "{actions:?}");

    let r = app.get(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token)).await;
    assert_eq!((r.json["can_scan"].as_bool(), r.json["can_edit"].as_bool()), (Some(true), Some(true)));
    let h = &r.json["hosts"][0];
    assert_eq!(h["address"], "127.0.0.1");
    let mut expected = vec![nas.port, web];
    expected.sort();
    assert_eq!(h["open_ports"], json!(expected), "the closed port is not reported");
    assert!(h["ssh_banner"].as_str().unwrap().starts_with("SSH-2.0-"), "{h}");
    assert_eq!(h["source"], "scan");
    let host_id = h["id"].as_i64().unwrap();
    let r = app.get(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&bob.token)).await;
    assert_eq!((r.json["can_scan"].as_bool(), r.json["can_edit"].as_bool(), r.json["hosts"].as_array().unwrap().len()), (Some(false), Some(false), 1));

    // 使用者的標籤 / 帳號在重掃後保留，不會重複。/ The user's label and username survive a rescan.
    let r = app.patch(&format!("/api/reverse/server/{id}/lan/hosts/{host_id}"), Some(&alice.token), json!({"label": "storage", "username": "admin", "ssh_port": nas.port})).await;
    assert_eq!((r.json["label"].as_str(), r.json["username"].as_str()), (Some("storage"), Some("admin")), "{}", r.text);
    app.post(&format!("/api/reverse/server/{id}/lan/scan"), Some(&alice.token), json!({"subnets": ["127.0.0.1/32"], "ports": ports})).await;
    wait_scan(app, &alice.token, id).await;
    let r = app.get(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token)).await;
    assert_eq!(r.json["hosts"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["hosts"][0]["label"], "storage");

    // 每次掃描都進該隧道的 Logs。/ Every scan lands in the tunnel's logs.
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={id}"), Some(&alice.token)).await;
    let scans: Vec<&Value> = r.json.as_array().unwrap().iter().filter(|e| e["event"] == "lan_scan").collect();
    assert_eq!(scans.len(), 2, "{}", r.text);
    assert!(scans[0]["message"].as_str().unwrap().contains("LAN scan of 127.0.0.1/32"), "{}", scans[0]);

    // 參數驗證。/ Parameter validation.
    for (body, code) in [
        (json!({"subnets": ["8.8.8.0/24"]}), "subnet"),
        (json!({"subnets": ["10.0.0.0/16"]}), "subnet"),
        (json!({"ports": [0]}), "ports"),
        (json!({"username": "root"}), "username"),
    ] {
        let r = app.post(&format!("/api/reverse/server/{id}/lan/scan"), Some(&alice.token), body.clone()).await;
        assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some(code)), "{body}: {}", r.text);
    }

    // 站台開關。/ The site switch.
    let r = app.post("/api/site/settings", Some(&lab.admin_token), json!({"lan_scan_enabled": false})).await;
    assert_eq!(r.json["values"]["lan_scan_enabled"], false, "{}", r.text);
    let r = app.post(&format!("/api/reverse/server/{id}/lan/scan"), Some(&alice.token), json!({})).await;
    assert_eq!(r.json["code"], "lan_scan_disabled");
    assert_eq!(app.get(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token)).await.json["can_scan"], false);
    app.post("/api/site/settings", Some(&lab.admin_token), json!({"lan_scan_enabled": true})).await;

    // 手動維護跳板機表（EDIT）。/ Manual entries (EDIT).
    let r = app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "192.168.1.50", "label": "printer"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!((r.json["source"].as_str(), r.json["ssh_port"].as_i64()), (Some("manual"), Some(22)));
    let printer = r.json["id"].as_i64().unwrap();
    assert_eq!(app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "192.168.1.50"})).await.json, json!({"address": ["This address is already in the list."]}));
    assert_eq!(app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "8.8.8.8"})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "NAS.local", "ssh_port": 2222})).await.json["address"], "nas.local");
    assert_eq!(app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "x.lan", "ssh_port": 70000})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&bob.token), json!({"address": "192.168.1.51"})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.delete(&format!("/api/reverse/server/{id}/lan/hosts/{printer}"), Some(&bob.token)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.delete(&format!("/api/reverse/server/{id}/lan/hosts/{printer}"), Some(&alice.token)).await.status, StatusCode::NO_CONTENT);

    // 拓撲圖資料。/ The topology view.
    let r = app.get("/api/reverse/lan/topology", Some(&alice.token)).await;
    let t = &r.json["tunnels"][0];
    assert_eq!((t["name"].as_str(), t["online"].as_bool(), t["can_scan"].as_bool()), (Some("box"), Some(true), Some(true)), "{t}");
    assert_eq!(t["default_username"], "ubuntu");
    let addrs: Vec<&str> = t["hosts"].as_array().unwrap().iter().map(|h| h["address"].as_str().unwrap()).collect();
    assert_eq!(addrs, vec!["127.0.0.1", "nas.local"]);
    let r = app.get("/api/reverse/lan/topology", Some(&bob.token)).await;
    assert_eq!((r.json["tunnels"][0]["permission"].as_str(), r.json["tunnels"][0]["can_scan"].as_bool()), (Some("view"), Some(false)));

    // MCP：lan_hosts（tunnels:read）、lan_scan（network:scan）。/ MCP tools and their scopes.
    let read_only = mcp_token(app, &alice.token, "tunnels:read").await;
    let (err, v) = call(app, &read_only, "lan_hosts", json!({"tunnel_id": id})).await;
    assert!(!err, "{v}");
    assert_eq!(v["hosts"].as_array().unwrap().len(), 2);
    let (err, v) = call(app, &read_only, "lan_scan", json!({"tunnel_id": id})).await;
    assert!(err && v.as_str().unwrap().contains("network:scan"), "{v}");
    let scanner = mcp_token(app, &alice.token, "tunnels:read network:scan").await;
    let (err, v) = call(app, &scanner, "lan_scan", json!({"tunnel_id": id, "subnets": ["127.0.0.1/32"], "ports": [nas.port]})).await;
    assert!(!err, "{v}");
    assert_eq!(v["scan"]["phase"], "done");
    let bob_scanner = mcp_token(app, &bob.token, "network:scan").await;
    let (err, v) = call(app, &bob_scanner, "lan_scan", json!({"tunnel_id": id})).await;
    assert!(err && v.as_str().unwrap().contains("owner and ADMIN"), "{v}");

    // 刪隧道 → 它的區網主機一起刪。/ Deleting the tunnel removes its LAN hosts.
    assert_eq!(app.delete(&format!("/api/reverse/server/keys/{id}"), Some(&alice.token)).await.status, StatusCode::NO_CONTENT);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_lan_host").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(n, 0);
}
