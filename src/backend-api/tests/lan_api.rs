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

use common::lab::{free_port, Lab, MachineOpts};
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

/// 一個小小的網頁伺服器：每條連線回同一頁（標題 + Server 標頭），並記下收到幾個請求、最後一個長什麼樣。
/// A tiny web server: the same page for every connection (a title and a Server header); counts the requests it got.
async fn tiny_web(title: &'static str) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let (port, seen, _) = web_server(title).await;
    (port, seen)
}

/// 同上，再加一個停掉它的把手（停了 port 就關了）。/ The same, plus a handle that stops it (closing the port).
async fn web_server(title: &'static str) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>, tokio::task::AbortHandle) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 2048];
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n > 0 {
                    log.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_string());
                    let body = format!("<html><head><title>{title}</title></head></html>");
                    let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nServer: lab-web/1.0\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).await;
                }
            });
        }
    });
    (port, seen, task.abort_handle())
}

fn write_exec(path: &std::path::Path, body: &str) {
    std::fs::write(path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// 辨識：使用者自己列的、沒先說話的 port 收到一個 GET（帶 Telepy 的 User-Agent），標題 / Server 存成服務、認出產品；
/// SSH port 只聽 banner、從不收到東西；`identify: false` 就什麼都不送。
/// Identify: a listed, silent port gets one GET (Telepy's user agent); title and Server become a service and the
/// product is recognised; the SSH port is only listened to; `identify: false` sends nothing.
#[tokio::test]
async fn a_scan_recognises_web_pages_and_only_listens_elsewhere() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], true).await;
    let nas = lab.machine("nas", &[("admin", &[&lab.service])], false).await;
    let (web, requests) = tiny_web("pve - Proxmox Virtual Environment").await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;

    // 先不辨識：網頁 port 什麼都沒收到。/ Without identify the web port gets nothing.
    let r = app.post(&format!("/api/reverse/server/{id}/lan/scan"), Some(&alice.token), json!({"subnets": ["127.0.0.1/32"], "ports": [nas.port, web], "identify": false})).await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.text);
    assert_eq!(wait_scan(app, &alice.token, id).await["phase"], "done");
    assert!(requests.lock().unwrap().is_empty(), "identify off sends nothing: {:?}", requests.lock().unwrap());
    let h = app.get(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token)).await.json["hosts"][0].clone();
    assert_eq!(h["identity"], Value::Null);
    let ssh = h["services"].as_array().unwrap().iter().find(|s| s["port"] == nas.port).cloned().unwrap();
    assert_eq!(ssh["proto"], "ssh", "{h}");

    // 預設辨識。/ Identify on (the default).
    let r = app.post(&format!("/api/reverse/server/{id}/lan/scan"), Some(&alice.token), json!({"subnets": ["127.0.0.1/32"], "ports": [nas.port, web]})).await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.text);
    assert_eq!(wait_scan(app, &alice.token, id).await["phase"], "done");
    let got = requests.lock().unwrap().clone();
    assert_eq!(got.len(), 1, "one GET for the web port: {got:?}");
    assert!(got[0].starts_with("GET / HTTP/1.1\r\n") && got[0].contains("User-Agent: Telepy-LAN-scan"), "{}", got[0]);
    let h = app.get(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token)).await.json["hosts"][0].clone();
    let page = h["services"].as_array().unwrap().iter().find(|s| s["port"] == web).cloned().unwrap_or_default();
    assert_eq!((page["proto"].as_str(), page["status"].as_i64(), page["title"].as_str(), page["server"].as_str()), (Some("http"), Some(200), Some("pve - Proxmox Virtual Environment"), Some("lab-web/1.0")), "{h}");
    assert_eq!((h["identity"]["product"].as_str(), h["identity"]["kind"].as_str(), h["identity"]["by"]["source"].as_str()), (Some("Proxmox VE"), Some("hypervisor"), Some("title")), "{h}");
    // 掃描看到它是 http，所以它算網頁，網址也照看到的寫。/ Seen as http, so it is a web link with that scheme.
    assert_eq!(h["web"], json!([{ "port": web, "scheme": "http", "url": format!("http://127.0.0.1:{web}/") }]));
    // MCP lan_hosts 一樣帶 identity。/ MCP lan_hosts carries the identity too.
    let token = mcp_token(app, &alice.token, "tunnels:read").await;
    let (err, v) = call(app, &token, "lan_hosts", json!({"tunnel_id": id})).await;
    assert!(!err, "{v}");
    assert_eq!(v["hosts"][0]["identity"]["product"], "Proxmox VE");
}

/// 裝置自己的服務、預設閘道、跟前一次掃描比變了什麼。裝置是真的 `/bin/sh`，`ss` / `ip` 用 `<home>/bin` 的假指令回固定內容
/// （不會探到開發機自己的服務）：第一次 = 新主機 + 閘道 + 裝置自己的網頁；停掉一個 port 再掃 = port 關了；第一個 port
/// 不通再掃 = 沒看到（主機標 `missing`），裝置自己的服務照樣在。
/// The device's own services, its default gateway and what changed since the previous scan. The device runs a real
/// `/bin/sh` with stub `ss` / `ip` in `<home>/bin` (never the developer's own services): first scan = a new host, the
/// gateway and the device's own web page; a port stopped = "closed"; the first port dead = not seen (`missing`), while
/// the device's own services stay.
#[cfg(unix)]
#[tokio::test]
async fn a_scan_lists_the_devices_own_services_its_gateway_and_what_changed() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let boxm = lab.machine_with("box", &[("ubuntu", &[&lab.service])], MachineOpts { allow_jump: true, shell: true, ..Default::default() }).await;
    let nas = lab.machine("nas", &[("admin", &[&lab.service])], false).await;
    let (own_web, own_requests, _own) = web_server("Grafana").await;
    let (extra, _, stop_extra) = web_server("Printer admin").await;
    let dead = free_port();
    let bin = boxm.account_home("ubuntu").join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    write_exec(&bin.join("ss"), &format!("#!/bin/sh\necho 'LISTEN 0 128 127.0.0.1:{own_web} 0.0.0.0:*'\necho 'LISTEN 0 128 0.0.0.0:{dead} 0.0.0.0:*'\necho 'LISTEN 0 128 192.168.77.5:8080 0.0.0.0:*'\n"));
    write_exec(
        &bin.join("ip"),
        "#!/bin/sh\ncase \"$*\" in\n  '-o -4 addr show scope global') echo '2: eth0    inet 10.250.0.5/24 brd 10.250.0.255 scope global eth0' ;;\n  '-4 route show default') echo 'default via 127.0.0.1 dev eth0 proto dhcp metric 100' ;;\nesac\nexit 0\n",
    );
    for quiet in ["route", "netstat", "getent"] {
        write_exec(&bin.join(quiet), "#!/bin/sh\nexit 1\n");
    }
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    let scan = |ports: serde_json::Value| {
        let token = alice.token.clone();
        async move {
            let r = app.post(&format!("/api/reverse/server/{id}/lan/scan"), Some(&token), json!({"subnets": ["127.0.0.1/32"], "ports": ports})).await;
            assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.text);
            let done = wait_scan(app, &token, id).await;
            assert_eq!(done["phase"], "done", "{done}");
            let v = app.get(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&token)).await.json;
            (done, v)
        }
    };
    let host = |v: &Value, address: &str| v["hosts"].as_array().unwrap().iter().find(|h| h["address"] == address).cloned().unwrap_or_else(|| panic!("no {address} in {v}"));

    // 1) 第一次：新主機、閘道、裝置自己的網頁。/ First scan: a new host, the gateway, the device's own page.
    let (done, v) = scan(json!([nas.port, extra])).await;
    assert_eq!(done["gateway"], "127.0.0.1", "{done}");
    assert_eq!(done["changes"]["new"], json!(["127.0.0.1"]), "{done}");
    assert_eq!(v["lan"]["networks"], json!(["127.0.0.1/32"]), "{v}");
    assert_eq!(v["lan"]["gateway"], "127.0.0.1");
    assert!(v["lan"]["scanned_at"].is_string());
    let lanh = host(&v, "127.0.0.1");
    assert_eq!((lanh["gateway"].as_bool(), lanh["own"].as_bool(), lanh["missing"].as_bool()), (Some(true), Some(false), Some(false)), "{lanh}");
    assert_eq!(lanh["since_last"], json!({"new": true, "opened": [], "closed": []}));
    assert_eq!(lanh["open_ports"], json!([nas.port, extra]));
    let own = host(&v, "localhost");
    assert_eq!((own["own"].as_bool(), own["source"].as_str(), own["missing"].as_bool()), (Some(true), Some("self"), Some(false)), "{own}");
    assert_eq!(own["open_ports"], json!([own_web]), "the dead port isn't open and a LAN-only bind isn't on localhost: {own}");
    assert_eq!(own["web"], json!([{ "port": own_web, "scheme": "http", "url": format!("http://localhost:{own_web}/") }]), "{own}");
    assert_eq!(own["services"][0]["title"], "Grafana", "{own}");
    assert_eq!(own_requests.lock().unwrap().len(), 1, "one GET for the device's own silent port");
    assert!(own["since_last"].is_null());

    // 2) 停掉一個 port：「關了」，不是新的。/ A port stopped: "closed", not new.
    stop_extra.abort();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (done, v) = scan(json!([nas.port, extra])).await;
    assert_eq!(done["changes"], json!({"new": [], "gone": [], "changed": [{"address": "127.0.0.1", "opened": [], "closed": [extra]}]}), "{done}");
    let lanh = host(&v, "127.0.0.1");
    assert_eq!(lanh["since_last"], json!({"new": false, "opened": [], "closed": [extra]}));
    assert_eq!(lanh["missing"], false);

    // 3) 第一個 port（最小的那個，後端會排序）不通 → 這次沒看到它；裝置自己的服務還在。
    // The first port (the lowest: the backend sorts them) dead: not seen; the device's own services stay.
    let (done, v) = scan(json!([1, nas.port])).await;
    assert_eq!(done["changes"]["gone"], json!(["127.0.0.1"]), "{done}");
    let lanh = host(&v, "127.0.0.1");
    assert_eq!(lanh["missing"], true, "{lanh}");
    assert!(lanh["since_last"].is_null());
    assert_eq!(host(&v, "localhost")["open_ports"], json!([own_web]));

    // 拓撲與 MCP 也帶同樣的東西。/ The topology and MCP carry the same.
    let topo = app.get("/api/reverse/lan/topology", Some(&alice.token)).await.json;
    let tn = topo["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).cloned().unwrap();
    assert_eq!(tn["lan"]["changes"]["gone"], json!(["127.0.0.1"]), "{tn}");
    let token = mcp_token(app, &alice.token, "tunnels:read").await;
    let (err, m) = call(app, &token, "lan_hosts", json!({"tunnel_id": id})).await;
    assert!(!err, "{m}");
    assert_eq!(m["lan"]["gateway"], "127.0.0.1");
    assert!(m["hosts"].as_array().unwrap().iter().any(|h| h["own"] == true && h["address"] == "localhost"), "{m}");
    // 掃描紀錄寫著幾台不見、幾台 port 變了。/ The scan's event says how many went missing.
    let events = app.get(&format!("/api/log/ssh/events?tunnel_id={id}"), Some(&alice.token)).await.json;
    let last = events.as_array().unwrap().iter().rev().find(|e| e["event"] == "lan_scan").cloned().unwrap();
    assert!(last["message"].as_str().unwrap().contains("1 gone"), "{last}");
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
    assert_eq!(app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "y.lan", "username": "-oProxyCommand=x"})).await.json["username"][0], "Use letters, digits, '.', '_' or '-' (not starting with '-').");
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
    // 裝置自己的位址：跟隧道列表的 `endpoint` 一樣，能登入裝置的人才有。/ The device's own addresses, gated like the list's `endpoint`.
    assert_eq!(t["endpoint"]["live"], true, "{t}");
    assert!(t["endpoint"]["ip"].is_string() && t["endpoint"]["lan"].is_array(), "{t}");
    let r = app.get("/api/reverse/lan/topology", Some(&bob.token)).await;
    assert_eq!((r.json["tunnels"][0]["permission"].as_str(), r.json["tunnels"][0]["can_scan"].as_bool()), (Some("view"), Some(false)));
    assert!(r.json["tunnels"][0]["endpoint"].is_object(), "{}", r.text);
    let carol = lab.user("carol").await;
    lab.share(&alice, &dev, &carol, "view", &[]).await;
    let r = app.get("/api/reverse/lan/topology", Some(&carol.token)).await;
    assert!(r.json["tunnels"][0]["endpoint"].is_null(), "{}", r.text);

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
    assert_eq!(app.delete(&format!("/api/reverse/server/keys/{id}"), Some(&alice.token)).await.status, StatusCode::OK);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_lan_host").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(n, 0);
}

/// 網頁終端機經裝置跳到區網主機（裝置那跳用服務金鑰 + `-W`）。/ The web terminal through the device to a LAN host.
#[tokio::test]
async fn web_terminal_to_a_lan_host() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], true).await;
    let nas = lab.machine("nas", &[("admin", &[&lab.service]), ("backup", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    let token = alice.token.as_str();
    let host = |body: Value| async move {
        let r = app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(token), body).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
        r.json["id"].as_i64().unwrap()
    };
    let nas_id = host(json!({"address": "127.0.0.1", "label": "nas", "username": "admin", "ssh_port": nas.port})).await;
    let anon = host(json!({"address": "localhost", "ssh_port": nas.port})).await;

    // 預設帳號，或指定別的帳號。/ The host's default login, or another one.
    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id})).await.expect("LAN terminal");
    t.expect("login:admin@nas").await;
    t.input("ping-lan\n").await;
    t.expect("ping-lan").await;
    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id.to_string(), "lan_username": "backup"})).await.expect("LAN terminal");
    t.expect("login:backup@nas").await;
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={id}"), Some(&alice.token)).await;
    assert!(r.json.as_array().unwrap().iter().any(|e| e["event"] == "lan_terminal" && e["message"].as_str().unwrap().contains("backup@127.0.0.1")), "{}", r.text);

    // 不安全的帳號、沒有帳號 → 4003；不是這條隧道的主機 → 4004。/ Unsafe or missing login → 4003; foreign host → 4004.
    // 存進資料庫前就擋過了，這裡模擬舊資料。/ The API rejects these already; simulate a legacy row.
    sqlx::query("UPDATE telepy_lan_host SET username = 'x y' WHERE id = ?").bind(anon).execute(&app.state.db.write).await.unwrap();
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": anon})).await.err(), Some(4003));
    sqlx::query("UPDATE telepy_lan_host SET username = NULL WHERE id = ?").bind(anon).execute(&app.state.db.write).await.unwrap();
    for bad in ["-oProxyCommand=touch /tmp/x", "a b", "root;id"] {
        assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id, "lan_username": bad})).await.err(), Some(4003), "{bad}");
    }
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": anon})).await.err(), Some(4003));
    let other_box = lab.machine("other-box", &[("ubuntu", &[&lab.service])], true).await;
    let other = lab.device(&bob, "other", &other_box).await;
    let r = app.post(&format!("/api/reverse/server/{}/lan/hosts", other.tunnel_id), Some(&bob.token), json!({"address": "127.0.0.1", "username": "admin", "ssh_port": nas.port})).await;
    let foreign = r.json["id"].as_i64().unwrap();
    for hid in [json!(foreign), json!(999_999), json!("nope")] {
        assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": hid})).await.err(), Some(4004), "{hid}");
    }
    // 裝置那跳的權限照舊。/ Device access is checked as before.
    assert_eq!(lab.terminal_with(&bob, &dev, "ubuntu", json!({"lan_host_id": nas_id})).await.err(), Some(4004));
}

/// 區網那一跳怎麼登入：預設 Telepy 的金鑰（這條隧道自己的 + 共用的），`prompt` 不出示金鑰，`credential` 用憑證庫的
/// 私鑰 / 密碼；壞的憑證 = 4010。/ How the LAN hop logs in: Telepy's keys by default, `prompt` offers none,
/// `credential` uses a saved key / password; an unusable saved login = 4010.
#[tokio::test]
async fn lan_hop_logs_in_with_the_chosen_key() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], true).await;
    let own_key = lab.keygen("alice-nas");
    // nas：admin 只認這條隧道自己的服務金鑰；backup 只認 alice 存進憑證庫的金鑰。
    // nas: admin trusts only the tunnel's own key; backup trusts only the key alice saves in the vault.
    let nas = lab.machine("nas", &[("admin", &[]), ("backup", &[&own_key])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    let tunnel_key = lab.tunnel_service_key(&dev).await;
    let dir = nas.account_home("admin").join(".ssh");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("authorized_keys"), format!("{tunnel_key}\n")).unwrap();
    let r = app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "127.0.0.1", "label": "nas", "username": "admin", "ssh_port": nas.port})).await;
    let nas_id = r.json["id"].as_i64().unwrap();

    // 預設：這條隧道自己的服務金鑰登入了 admin。/ Default: the tunnel's own key logged in as admin.
    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id})).await.expect("LAN terminal");
    t.expect("login:admin@nas").await;
    assert!(nas.logged_in_bare("admin", &telepy_server::ssh::tunnel_keys::bare(&tunnel_key)));
    t.close().await;

    // prompt：不出示金鑰 → 這台機器沒有密碼登入，OpenSSH 說 Permission denied。/ prompt: no key offered → refused here.
    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id, "lan_auth": "prompt"})).await.expect("LAN terminal");
    t.expect("Permission denied").await;
    t.close().await;

    // credential：憑證庫的私鑰登入了 backup。/ credential: the saved key logged in as backup.
    let pem = std::fs::read_to_string(&own_key.path).unwrap();
    let r = app.post("/api/credentials", Some(&alice.token), json!({"label": "backup key", "protocol": "ssh", "tunnel_id": id, "lan_host_id": nas_id, "login": "backup", "private_key": pem})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let cid = r.json["id"].as_i64().unwrap();
    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id, "lan_username": "backup", "lan_auth": "credential", "lan_credential_id": cid})).await.expect("LAN terminal");
    t.expect("login:backup@nas").await;
    assert!(nas.logged_in("backup", &own_key));
    t.close().await;
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={id}"), Some(&alice.token)).await;
    assert!(r.json.as_array().unwrap().iter().any(|e| e["event"] == "lan_terminal" && e["message"].as_str().unwrap().contains("saved login 'backup key'")), "{}", r.text);

    // 不存在 / 別人的 / 別台主機的憑證 → 4010。/ A missing or foreign saved login → 4010.
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id, "lan_auth": "credential", "lan_credential_id": 999})).await.err(), Some(4010));
    let other = app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), json!({"address": "127.0.0.2", "username": "admin", "ssh_port": nas.port})).await.json["id"].as_i64().unwrap();
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": other, "lan_auth": "credential", "lan_credential_id": cid})).await.err(), Some(4010));
}
