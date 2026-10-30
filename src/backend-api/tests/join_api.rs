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
    // 名稱 = ssh 主機名稱：空白不行（數字開頭可以）。/ The name is an ssh host name: no spaces (a leading digit is fine).
    assert_eq!(app.post("/api/reverse/join", Some(&alice.token), json!({"name": "office pi"})).await.status, StatusCode::BAD_REQUEST);
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
    let reg = device_post(app, &token, json!({"public_key": device_key.public, "hostname": "raspberrypi", "username": "ubuntu", "ssh_port": 22, "os": "Linux aarch64", "host_keys": [pi.host_key, "garbage"]})).await;
    assert_eq!(reg.status, StatusCode::CREATED, "{}", reg.text);
    let m = kv(&reg.text);
    assert_eq!(one(&m, "TUNNEL_NAME"), "office-pi", "the name chosen on the web wins");
    assert!(m.get("SAME_MACHINE_AS").is_none(), "{}", reg.text);
    assert_eq!(one(&m, "GATEWAY_USER"), "telepy");
    assert_eq!(one(&m, "GATEWAY_PORT"), lab.gw_port.to_string());
    // 裝置拿到的是這條隧道自己的服務金鑰，不是全站共用的那把。/ The device gets the tunnel's own key, not the shared one.
    assert_ne!(one(&m, "SERVICE_KEY").split_whitespace().take(2).collect::<Vec<_>>(), lab.service.public.split_whitespace().take(2).collect::<Vec<_>>());
    assert!(one(&m, "SERVICE_KEY").starts_with("ssh-ed25519 ") && one(&m, "SERVICE_KEY").ends_with(&format!("telepy-tunnel-{}", one(&m, "TUNNEL_ID"))), "{}", reg.text);
    let host_keys = m.get("HOST_KEY").cloned().unwrap_or_default();
    assert!(!host_keys.is_empty() && host_keys.iter().all(|k| k.starts_with("ssh-")), "{}", reg.text);
    let tunnel_id: i64 = one(&m, "TUNNEL_ID").parse().unwrap();
    let reverse_port: u16 = one(&m, "REVERSE_PORT").parse().unwrap();
    assert!(one(&m, "WEB_URL").ends_with("/tunnels"));
    // 腳本送來的 host key 立刻釘住（第一次連線不再是看到什麼信什麼）。/ The host key the script sent is pinned at once.
    let r = app.get(&format!("/api/reverse/server/{tunnel_id}/host-key"), Some(&alice.token)).await;
    assert_eq!((r.json["pinned"].as_array().unwrap().len(), r.json["pinned"][0]["source"].as_str()), (1, Some("join")), "{}", r.text);
    assert_eq!(r.json["pinned"][0]["public_key"], pi.host_key);

    // 單次使用。/ Single use.
    let again = device_post(app, &token, json!({"public_key": device_key.public, "username": "ubuntu"})).await;
    assert_eq!(again.status, StatusCode::CONFLICT, "{}", again.text);

    // 建好的隧道：預設帳號、我的金鑰清單、描述。/ The tunnel: default login, key list seeded, description.
    let r = app.get(&format!("/api/reverse/server/{tunnel_id}/usernames"), Some(&alice.token)).await;
    assert_eq!(r.json["usernames"][0]["username"], "ubuntu", "{}", r.text);
    assert_eq!(r.json["default_username_id"], r.json["usernames"][0]["id"]);
    let t = telepy_server::db::tunnels::by_id(&app.state.db, tunnel_id).await.unwrap().unwrap();
    assert_eq!(t.description.as_deref(), Some("Joined from raspberrypi (Linux aarch64)"));
    // 這張票走 SSH port：還沒連上就知道它是怎麼加進來的。/ The ticket chose the SSH port: known before it connects.
    assert_eq!(t.way_in.as_deref(), Some("ssh"));
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
    // 別人的機器也不能：host key 已經被 Alice 的隧道釘選 → 拒絕、告訴 Alice（事件 + 通知），票還能再用。
    // Nor another user's machine: its host key is pinned by Alice's tunnel → refused, Alice is told, the ticket stays usable.
    drop(rx.try_recv());
    while rx.try_recv().is_ok() {}
    let r = device_post(app, &token3, json!({"public_key": lab.keygen("bob-on-alices-pi").public, "hostname": "raspberrypi", "username": "ubuntu", "host_keys": [pi.host_key]})).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.text);
    assert!(r.text.contains("another Telepy account") && r.text.contains("ssh-keygen -A"), "{}", r.text);
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(&alice.token)).await;
    let attempt = r.json.as_array().unwrap().iter().find(|e| e["event"] == "claim_attempt").expect("alice's tunnel logs the attempt");
    assert!(attempt["message"].as_str().unwrap().contains("'raspberrypi' of bob"), "{}", attempt["message"]);
    let mut told = false;
    while let Ok(msg) = rx.try_recv() {
        let v: Value = serde_json::from_str(&msg).unwrap();
        told |= v["message"]["action"] == "DEVICE-CLAIM-ATTEMPT" && v["message"]["by"] == "bob";
    }
    assert!(told, "alice is notified");
    assert_eq!(app.get("/api/reverse/server/dashboard", Some(&bob.token)).await.json["tunnels"].as_array().unwrap().len(), 0, "nothing was created for bob");
    // Alice 自己在同一台再跑一次（另一把金鑰）：可以，但回答與票上都說這是同一台。
    // Alice again on the same machine with another key: allowed, but the answer and the ticket say it is the same machine.
    let r = app.post("/api/reverse/join", Some(&alice.token), json!({})).await;
    let (token4, id4) = (r.json["token"].as_str().unwrap().to_string(), r.json["id"].as_str().unwrap().to_string());
    let m = kv(&device_post(app, &token4, json!({"public_key": lab.keygen("pi-second-account").public, "hostname": "raspberrypi", "username": "nobody", "host_keys": [pi.host_key]})).await.text);
    assert_eq!((one(&m, "SAME_MACHINE_AS").as_str(), one(&m, "SAME_MACHINE_ID").as_str()), ("office-pi", tunnel_id.to_string().as_str()), "{m:?}");
    assert_eq!(one(&m, "TUNNEL_NAME"), "raspberrypi");
    let r = app.get(&format!("/api/reverse/join/{id4}"), Some(&alice.token)).await;
    assert_eq!(r.json["same_machine_as"], json!({"id": tunnel_id, "name": "office-pi"}), "{}", r.text);
    let second: i64 = one(&m, "TUNNEL_ID").parse().unwrap();
    let r = app.get(&format!("/api/reverse/server/{second}/host-key"), Some(&alice.token)).await;
    assert_eq!(r.json["same_machine"], json!([{"id": tunnel_id, "name": "office-pi"}]), "{}", r.text);

    // 名稱沿用主機名稱、撞名加 -2；登入失敗會說明原因。/ Hostname naming with a suffix; a failed login is explained.
    let r = app.post("/api/reverse/join", Some(&bob.token), json!({"name": "office-pi"})).await;
    assert_eq!(r.json["name"][0], "A tunnel with this name already exists.", "{}", r.text);
    let other_key = lab.keygen("pi2-device");
    let m = kv(&device_post(app, &token3, json!({"public_key": other_key.public, "hostname": "office-pi", "username": "nobody"})).await.text);
    assert_eq!(one(&m, "TUNNEL_NAME"), "office-pi-2");
    let tid: i64 = one(&m, "TUNNEL_ID").parse().unwrap();
    let pi2 = lab.machine("pi2", &[("ubuntu", &[&lab.service]), ("nobody", &[])], false).await;
    lab.connect_joined(tid, &other_key, one(&m, "REVERSE_PORT").parse().unwrap(), &pi2, &m["HOST_KEY"]).await;
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

/// 精簡裝置（OpenWrt 的 uclient-fetch）需要的那些：`?soft=1` 把狀態碼放進 body、不看 Content-Type 的註冊、預檢用的
/// `/api/join/gateway`、回應丟了之後再拿一次的 `/config`，以及腳本回報的環境記在票、事件與隧道上。
/// What a minimal device (OpenWrt's uclient-fetch) needs: `?soft=1`, registration regardless of Content-Type, the
/// public `/api/join/gateway` for the preflight, `/config` after a lost answer, and the facts on ticket, event and tunnel.
#[tokio::test]
async fn soft_answers_gateway_info_config_recovery_and_facts() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;

    // 預檢資料：公開、不用 token；soft 時第一行 STATUS=200。/ Public gateway facts; STATUS first with soft.
    let r = app.get("/api/join/gateway", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let m = kv(&r.text);
    assert_eq!(one(&m, "GATEWAY_PORT"), lab.gw_port.to_string());
    assert_eq!(one(&m, "GATEWAY_USER"), "telepy");
    assert!(m.get("HOST_KEY").is_some_and(|k| !k.is_empty()) && one(&m, "WS_URL").starts_with("ws://"), "{}", r.text);
    let r = app.get("/api/join/gateway?soft=1", None).await;
    assert!(r.text.starts_with("STATUS=200\nGATEWAY_HOST="), "{}", r.text);

    // soft 的錯誤：200 + STATUS=404 + ERROR。/ A soft error: 200 with STATUS=404.
    let r = app.get("/api/join/tpj_nope/status?soft=1", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text.starts_with("STATUS=404\nERROR="), "{}", r.text);
    assert_eq!(app.get("/api/join/tpj_nope/config", None).await.status, StatusCode::NOT_FOUND);

    let token = app.post("/api/reverse/join", Some(&alice.token), json!({"name": "wrt"})).await.json["token"].as_str().unwrap().to_string();
    assert_eq!(app.get(&format!("/api/join/{token}/config"), None).await.status, StatusCode::CONFLICT, "not registered yet");

    // uclient-fetch 的 POST：x-www-form-urlencoded、看不到狀態碡 → soft。/ A uclient-fetch style POST: form content type + soft.
    let key = lab.keygen("wrt-device");
    let body = json!({"public_key": key.public, "hostname": "GL-AR750S", "username": "root", "ssh_port": 22, "os": "Linux mips",
        "facts": {"shell": "ash (BusyBox v1.36.1)", "client": "OpenSSH_8.9p1", "server": "Dropbear 2022.82", "init": "procd", "keepalive": "tcp", "http": "uclient-fetch", "compat": ["no_server_alive"], "token": "leak?"}});
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/join/{token}?soft=1"))
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(body.to_string()))
        .unwrap();
    let reg = app.send(req).await;
    assert_eq!(reg.status, StatusCode::OK, "{}", reg.text);
    assert!(reg.text.starts_with("STATUS=201\n"), "{}", reg.text);
    let m = kv(&reg.text);
    assert_eq!(one(&m, "TUNNEL_NAME"), "wrt");
    assert_eq!(one(&m, "USERNAME"), "root");
    let tunnel_id: i64 = one(&m, "TUNNEL_ID").parse().unwrap();

    // 回應丟了：同一張票再拿一次設定，內容相同。/ Lost answer: the config comes again, identical.
    let again = app.get(&format!("/api/join/{token}/config"), None).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.text);
    let m2 = kv(&again.text);
    for k in ["TUNNEL_ID", "INSTALL_ID", "SERVICE_KEY", "GATEWAY_HOST", "GATEWAY_PORT", "WEB_URL", "USERNAME"] {
        assert_eq!(one(&m, k), one(&m2, k), "{k}");
    }
    assert_eq!(m.get("HOST_KEY"), m2.get("HOST_KEY"));
    // 再 POST 同一張票 = 已用過（不會建第二條隧道）。/ Posting again is refused; no second tunnel.
    let dup = device_post(app, &token, json!({"public_key": key.public, "username": "root"})).await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
    assert_eq!(app.get("/api/reverse/server/dashboard", Some(&alice.token)).await.json["tunnels"].as_array().unwrap().len(), 1);

    // 腳本回報的環境：票上有（白名單，token 欄位丟掉）、事件一句話、隧道的 device-install 也有。
    // The facts: on the ticket (allow-listed), in the event line, on the tunnel's device-install view.
    let t = app.state.join.by_token(&token).unwrap();
    let facts = t.facts.expect("facts recorded");
    assert_eq!(facts["server"], "Dropbear 2022.82");
    assert_eq!(facts["compat"], json!(["no_server_alive"]));
    assert!(facts.get("token").is_none());
    let web = app.get(&format!("/api/reverse/join/{}", t.id), Some(&alice.token)).await;
    assert_eq!(web.json["facts"]["init"], "procd", "{}", web.text);
    let events = app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(&alice.token)).await;
    let join_msg = events.json.as_array().unwrap().iter().find(|e| e["event"] == "join").unwrap()["message"].as_str().unwrap().to_string();
    assert!(join_msg.contains("found: ash (BusyBox v1.36.1), OpenSSH_8.9p1 → Dropbear 2022.82, procd, keepalive tcp, compat: no_server_alive"), "{join_msg}");
    let view = app.get(&format!("/api/reverse/server/{tunnel_id}/device-install"), Some(&alice.token)).await;
    assert_eq!(view.json["join"]["facts"]["client"], "OpenSSH_8.9p1", "{}", view.text);
    assert!(view.json["join"]["summary"].as_str().unwrap().contains("compat: no_server_alive"));
    assert!(view.json["join"]["at"].is_string());

    // 非 JSON 的 body：清楚的 400。/ A body that is not JSON: a clear 400.
    let token2 = app.post("/api/reverse/join", Some(&alice.token), json!({})).await.json["token"].as_str().unwrap().to_string();
    let req = Request::builder().method(Method::POST).uri(format!("/api/join/{token2}")).body(Body::from("public_key=ssh-ed25519")).unwrap();
    let r = app.send(req).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.text.contains("not JSON"), "{}", r.text);
    assert!(app.state.join.by_token(&token2).unwrap().open(), "a bad body does not consume the ticket");
}
