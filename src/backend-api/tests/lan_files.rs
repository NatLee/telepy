//! 區網主機的檔案管理：經裝置的 sshd 開 direct-tcpip 到那台主機、russh 登入（Telepy 的金鑰 / 密碼 / 憑證庫）、
//! 開 SFTP；之後檔案管理的 REST 與 WebSocket 把 `~<代號>` 放在帳號的位置，每個操作都落在那台主機上。
//! 在 SSH lab 上用真的 sftp-server；沒有就跳過。
//! LAN host file management end to end on the SSH lab with a real sftp-server; skipped without one.
mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use common::lab::{sftp_server_bin, Lab, MachineOpts};
use common::TestApp;

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

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<Value> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().cloned().unwrap_or_default()
}

async fn wait_event(lab: &Lab, token: &str, tunnel_id: i64, kind: &str, needle: &str) -> Value {
    for _ in 0..100 {
        if let Some(e) = events(lab, token, tunnel_id).await.into_iter().find(|e| e["event"] == kind && e["message"].as_str().unwrap_or("").contains(needle)) {
            return e;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no {kind} event with {needle:?}: {:?}", events(lab, token, tunnel_id).await);
}

#[tokio::test]
async fn a_lan_hosts_files_are_managed_through_the_device() {
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], true).await;
    // nas：admin 只認這條隧道自己的服務金鑰；backup 收密碼。/ nas: admin trusts the tunnel's key; backup takes a password.
    let nas = lab.machine_with("nas", &[("admin", &[]), ("backup", &[])], MachineOpts { password: Some("s3cret"), ..Default::default() }).await;
    // pam：密碼只走 keyboard-interactive。/ pam: the password only through keyboard-interactive.
    let pam = lab.machine_with("pam", &[("ops", &[])], MachineOpts { password: Some("kbd-pass"), password_kbd_only: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    let tunnel_key = lab.tunnel_service_key(&dev).await;
    let admin_home = nas.account_home("admin");
    std::fs::create_dir_all(admin_home.join(".ssh")).unwrap();
    std::fs::write(admin_home.join(".ssh/authorized_keys"), format!("{tunnel_key}\n")).unwrap();
    std::fs::create_dir_all(admin_home.join("share")).unwrap();
    std::fs::write(admin_home.join("share/report.txt"), "quarterly\n").unwrap();
    std::fs::create_dir_all(nas.account_home("backup")).unwrap();
    std::fs::create_dir_all(pam.account_home("ops")).unwrap();
    let host = |address: &str, username: &str, port: u16| json!({"address": address, "label": username, "username": username, "ssh_port": port});
    let nas_id = app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), host("127.0.0.1", "admin", nas.port)).await.json["id"].as_i64().unwrap();
    let pam_id = app.post(&format!("/api/reverse/server/{id}/lan/hosts"), Some(&alice.token), host("localhost", "ops", pam.port)).await.json["id"].as_i64().unwrap();
    let open = |user: &str, host_id: i64, body: Value| {
        let token = user.to_string();
        async move { app.post(&format!("/api/reverse/server/{id}/lan/hosts/{host_id}/files"), Some(&token), body).await }
    };

    // Telepy 的金鑰（預設）：這條隧道的服務金鑰登入了 admin，session 在帳號的位置。
    // Telepy's key (default): the tunnel's own service key logged in as admin.
    let r = open(&alice.token, nas_id, json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let sid = r.json["session"].as_str().unwrap().to_string();
    assert!(sid.starts_with('~'), "{sid}");
    assert_eq!((r.json["login"].as_str(), r.json["account"].as_str(), r.json["auth"].as_str()), (Some("admin"), Some("ubuntu"), Some("Telepy's key")));
    assert!(r.json["fingerprint"].as_str().unwrap().starts_with("SHA256:"), "{}", r.text);
    assert!(nas.logged_in_bare("admin", &telepy_server::ssh::tunnel_keys::bare(&tunnel_key)));
    wait_event(&lab, &alice.token, id, "lan_files", "admin@127.0.0.1").await;
    let url = |op: &str| format!("/api/sftp/{op}/{id}/{sid}");
    let tok = Some(alice.token.as_str());

    // 檔案管理的操作都落在 nas（不是 box）。/ Every operation lands on the nas, never the box.
    let r = app.get(&format!("{}?path=~/share", url("list")), tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["files"].as_array().unwrap().iter().any(|f| f["name"] == "report.txt"), "{}", r.text);
    let r = app.post(&url("mkdir"), tok, json!({"path": "~/share/new"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(admin_home.join("share/new").is_dir());
    assert!(!boxm.home.join("share").exists(), "nothing happened on the device");
    let r = app.get(&format!("{}?path=~/share/report.txt", url("text")), tok).await;
    assert_eq!(r.json["content"], "quarterly\n", "{}", r.text);
    let r = app.put(&url("text"), tok, json!({"path": "~/share/report.txt", "content": "Q4\n", "mtime": r.json["mtime_epoch"], "size": r.json["size"]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(std::fs::read_to_string(admin_home.join("share/report.txt")).unwrap(), "Q4\n", "saved with the host's posix-rename");
    let r = app.post(&url("copy"), tok, json!({"paths": ["~/share/report.txt"], "destination": "~/share/new"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(std::fs::read_to_string(admin_home.join("share/new/report.txt")).unwrap(), "Q4\n");

    // 分段上傳 + 一次性下載連結。/ Upload in parts, then a one-time download link.
    let http = lab.ws_base().await.replace("ws://", "http://");
    let client = reqwest::Client::new();
    let put = |query: String, body: Vec<u8>| {
        let req = client.put(format!("{http}/api/sftp/upload-part/{id}/{sid}?{query}")).bearer_auth(&alice.token).body(body);
        async move {
            let r = req.send().await.unwrap();
            (r.status().as_u16(), r.json::<Value>().await.unwrap_or(Value::Null))
        }
    };
    let (s, j) = put("path=~/share/up.bin&upload=lanup001&offset=0&total=6".into(), b"abc".to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(false)), "{j}");
    let (s, j) = put("path=~/share/up.bin&upload=lanup001&offset=3&total=6".into(), b"def".to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(true)), "{j}");
    assert_eq!(std::fs::read(admin_home.join("share/up.bin")).unwrap(), b"abcdef");
    let r = app.post(&url("download-link"), tok, json!({"paths": ["~/share/up.bin"]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let got = client.get(format!("{http}{}", r.json["url"].as_str().unwrap())).send().await.unwrap();
    assert_eq!(got.status().as_u16(), 200);
    assert_eq!(got.bytes().await.unwrap().as_ref(), b"abcdef");

    // 檔案管理的 WebSocket 也一樣。/ The file manager's socket too.
    let listed = lab.filemanager(&alice, &dev, &sid, json!({"action": "list_files", "payload": {"path": "~/share"}})).await.expect("file manager");
    assert!(listed["data"]["files"].as_array().unwrap().iter().any(|f| f["name"] == "up.bin"), "{listed}");

    // 刪除照樣（不能刪家目錄）。/ Delete works the same (the home folder is protected).
    let r = app.post(&url("delete"), tok, json!({"paths": ["~/share/new"]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(!admin_home.join("share/new").exists());

    // 別人拿到代號也不能用；bob 能看隧道、用 ubuntu，但那是 alice 的 session。
    // Someone else can't use the id: bob may use the tunnel, but the session is alice's.
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let r = app.get(&format!("/api/sftp/list/{id}/{sid}"), Some(&bob.token)).await;
    assert_eq!((r.status.as_u16(), r.json["code"].as_str()), (404, Some("lan_files_gone")), "{}", r.text);
    assert_eq!(lab.filemanager(&bob, &dev, &sid, json!({"action": "list_files", "payload": {}})).await.err(), Some(4017));

    // 密碼：對的進得去，錯的說清楚。/ A password: the right one gets in, a wrong one says so.
    let r = open(&alice.token, nas_id, json!({"login": "backup", "auth": "password", "password": "nope"})).await;
    assert_eq!((r.status.as_u16(), r.json["code"].as_str()), (400, Some("lan_files_login")), "{}", r.text);
    let r = open(&alice.token, nas_id, json!({"login": "backup", "auth": "password", "password": "s3cret"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(nas.logins().iter().any(|l| l.user == "backup" && l.key == "password"), "password login recorded");
    let backup_sid = r.json["session"].as_str().unwrap().to_string();
    // keyboard-interactive 的 sshd 也收這個密碼。/ A keyboard-interactive-only sshd takes the password too.
    let r = open(&alice.token, pam_id, json!({"auth": "password", "password": "kbd-pass"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let pam_sid = r.json["session"].as_str().unwrap().to_string();
    let r = app.get(&format!("/api/reverse/server/{id}/lan/files"), tok).await;
    assert_eq!(r.json["sessions"].as_array().unwrap().len(), 3, "{}", r.text);

    // 憑證庫的密碼。/ A saved login's password.
    let r = app.post("/api/credentials", tok, json!({"label": "nas backup", "protocol": "ssh", "tunnel_id": id, "lan_host_id": nas_id, "login": "backup", "password": "s3cret"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let cid = r.json["id"].as_i64().unwrap();
    let r = open(&alice.token, nas_id, json!({"login": "backup", "auth": "credential", "credential_id": cid})).await;
    assert_eq!((r.status.as_u16(), r.json["auth"].as_str()), (200, Some("saved login 'nas backup'")), "{}", r.text);
    let r = open(&alice.token, pam_id, json!({"auth": "credential", "credential_id": cid})).await;
    assert_eq!(r.json["code"], "lan_credential", "a saved login of another host: {}", r.text);
    // 第五個把最舊的關掉（每人最多四個）。/ A fifth closes the oldest (four per person).
    assert_eq!(app.get(&format!("/api/reverse/server/{id}/lan/files"), tok).await.json["sessions"].as_array().unwrap().len(), 4);
    let r = open(&alice.token, nas_id, json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let latest = r.json["session"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = app.get(&format!("/api/reverse/server/{id}/lan/files"), tok).await;
    let open_now: Vec<&str> = r.json["sessions"].as_array().unwrap().iter().filter_map(|s| s["session"].as_str()).collect();
    assert_eq!(open_now.len(), 4, "{}", r.text);
    assert!(!open_now.contains(&sid.as_str()) && open_now.contains(&latest.as_str()), "the oldest went: {}", r.text);

    // 關掉時，沒傳完的暫存檔一起從那台主機刪掉。/ Closing removes its unfinished part files from the host.
    let put_b = |query: String| {
        let req = client.put(format!("{http}/api/sftp/upload-part/{id}/{backup_sid}?{query}")).bearer_auth(&alice.token).body(b"half".to_vec());
        async move { req.send().await.unwrap().status().as_u16() }
    };
    assert_eq!(put_b("path=~/half.bin&upload=lanhalf01&offset=0&total=8".into()).await, 200);
    let part = nas.account_home("backup").join(".half.bin.telepy-upload-lanhalf01.part");
    assert!(part.exists());
    let r = app.delete(&format!("/api/reverse/server/{id}/lan/files/{backup_sid}"), tok).await;
    assert_eq!(r.json["closed"], true, "{}", r.text);
    assert!(!part.exists(), "the part file went with the session");
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_upload_part").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(left, 0, "and its ledger entry");
    wait_event(&lab, &alice.token, id, "lan_files_close", "backup@127.0.0.1").await;
    let r = app.get(&format!("/api/sftp/list/{id}/{backup_sid}"), tok).await;
    assert_eq!(r.json["code"], "lan_files_gone", "{}", r.text);

    // 沒了權限就關：bob 開一個，拿掉他的帳號 → 下一輪檢查就關。/ Lost access closes it.
    let r = open(&bob.token, pam_id, json!({"auth": "password", "password": "kbd-pass"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let bob_sid = r.json["session"].as_str().unwrap().to_string();
    let r = app.patch(&format!("/tunnels/share/{id}/{}/allowed-usernames", bob.id), Some(&alice.token), json!({"allowed_target_username_ids": []})).await;
    assert!(r.status.is_success(), "{}", r.text);
    telepy_server::lan::files::reap_once(&app.state).await;
    let r = app.get(&format!("/api/sftp/list/{id}/{bob_sid}"), Some(&bob.token)).await;
    assert_ne!(r.status, StatusCode::OK, "{}", r.text);
    assert!(app.state.lan_files.all().iter().all(|s| s.id != bob_sid), "bob's session was closed");
    wait_event(&lab, &alice.token, id, "lan_files_close", "no longer allowed").await;
    let _ = pam_sid;

    // MCP：lan_files 列 / 讀 / 寫，登入重用；沒有 ssh:files 就說要什麼。/ MCP: list / read / write, the login reused.
    let read_only = mcp_token(app, &alice.token, "tunnels:read").await;
    let (err, v) = call(app, &read_only, "lan_files", json!({"tunnel_id": id, "host": "admin", "action": "list"})).await;
    assert!(err && v.as_str().unwrap().contains("ssh:files"), "{v}");
    let agent = mcp_token(app, &alice.token, "tunnels:read ssh:files").await;
    let (err, v) = call(app, &agent, "lan_files", json!({"tunnel_id": id, "host": "admin", "action": "list", "path": "~/share"})).await;
    assert!(!err, "{v}");
    assert_eq!(v["host"], "admin@127.0.0.1");
    assert!(v["entries"].as_array().unwrap().iter().any(|e| e["name"] == "report.txt"), "{v}");
    let (err, v) = call(app, &agent, "lan_files", json!({"tunnel_id": id, "host": "127.0.0.1", "action": "write", "path": "~/share/agent.txt", "content": "from an agent\n"})).await;
    assert!(!err, "{v}");
    assert_eq!(std::fs::read_to_string(admin_home.join("share/agent.txt")).unwrap(), "from an agent\n");
    let (err, v) = call(app, &agent, "lan_files", json!({"tunnel_id": id, "host": "admin", "action": "read", "path": "~/share/agent.txt"})).await;
    assert!(!err && v["content"] == "from an agent\n", "{v}");
    let agent_sessions = app.state.lan_files.all().into_iter().filter(|s| s.opener.starts_with("mcp:")).count();
    assert_eq!(agent_sessions, 1, "one login, reused by the three calls");
    let r = app.get(&format!("/api/ai/activity?tunnel_id={id}"), Some(&alice.token)).await;
    assert!(r.json.as_array().unwrap().iter().any(|e| e["tool"] == "lan_files" && e["detail"].as_str().unwrap_or("").contains("write admin@127.0.0.1:~/share/agent.txt")), "{}", r.text);
}
