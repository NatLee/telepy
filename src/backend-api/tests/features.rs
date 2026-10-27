//! 功能權限（群組 + 使用者）端到端：真的 gateway + 真的裝置 sshd。群組拒絕終端機 → 成員的終端機 WebSocket 4012、
//! 使用者自己的允許蓋過群組、管理員不受影響、檔案 REST 403、MCP tool 被拒、關掉 MCP app = token 失效、
//! 個人 SSH 金鑰被關 = 筆電經 gateway 連不上、正在開的終端機被結束（4009），每個變更都是管理員事件。
//! Feature permissions end to end: a group deny closes its member's terminal with 4012, the user's own allow
//! overrides it, admins are unaffected, file REST answers 403, MCP tools are refused, MCP apps off = token refused,
//! personal keys off = laptop SSH refused, a live terminal is ended (4009), and every change is an admin event.
mod common;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use common::lab::{Hop, Lab};
use common::TestApp;

const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-0123";
const FEATURE_CLOSE: u16 = 4012;

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

/// (HTTP 狀態, isError, 內容)。/ (HTTP status, isError, content).
async fn call(app: &TestApp, token: &str, tool: &str, args: Value) -> (StatusCode, bool, Value) {
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
    (r.status, result["isError"].as_bool().unwrap_or(false), value)
}

async fn grant(lab: &Lab, subject: &str, id: Option<i64>, feature: &str, value: &str) -> Value {
    let r = lab.app.put("/api/access/grants", Some(&lab.admin_token), json!({"subject": subject, "id": id, "feature": feature, "value": value})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json
}

fn features_of(profile: &Value) -> Vec<String> {
    profile["features"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn groups_and_users_decide_which_features_people_use() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service, &alice.key, &bob.key])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let id = dev.tunnel_id;
    // bob 的 MCP app 先連好（之後關掉 MCP app 時要被拒）。/ Bob's MCP app, connected while it is still allowed.
    let mcp = mcp_token(app, &bob.token, "tunnels:read ssh:exec").await;

    // 預設全部可以用；只有管理員能看 / 改設定。/ Everything is allowed by default; only admins manage it.
    let profile = app.get("/api/auth/user/profile", Some(&bob.token)).await.json;
    assert_eq!(features_of(&profile).len(), 14, "{profile}");
    assert_eq!(app.get("/api/access", Some(&bob.token)).await.status, StatusCode::FORBIDDEN);
    let t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal by default");
    t.close().await;

    // 群組拒絕終端機 → 成員 bob 4012，不在群組的 alice 照舊。/ A group deny: bob 4012, alice unaffected.
    let r = app.post("/api/access/groups", Some(&lab.admin_token), json!({"name": "Contractors", "members": [bob.id]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let gid = r.json["created_id"].as_i64().unwrap();
    let r = app.post("/api/access/groups", Some(&lab.admin_token), json!({"name": "contractors"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "names are unique regardless of case: {}", r.text);
    let policy = grant(&lab, "group", Some(gid), "terminal", "deny").await;
    let bob_row = policy["users"].as_array().unwrap().iter().find(|u| u["id"] == bob.id).unwrap().clone();
    assert_eq!(bob_row["effective"]["terminal"], json!({"allowed": false, "from": "group", "group_id": gid}), "{bob_row}");
    assert_eq!(lab.terminal(&bob, &dev, "ubuntu").await.err(), Some(FEATURE_CLOSE));
    lab.terminal(&alice, &dev, "ubuntu").await.expect("alice is not in the group").close().await;
    assert!(!features_of(&app.get("/api/auth/user/profile", Some(&bob.token)).await.json).contains(&"terminal".to_string()));

    // MCP：ssh:exec 對應終端機，被關掉 → tool error。/ MCP: ssh:exec maps to the terminal; refused as a tool error.
    let (status, is_error, text) = call(app, &mcp, "ssh_session_open", json!({"tunnel_id": id, "username": "ubuntu"})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(is_error && text.as_str().unwrap().contains("turned off"), "{text}");

    // 使用者自己的允許是最終端，蓋過群組。/ The user's own allow overrides the group.
    grant(&lab, "user", Some(bob.id), "terminal", "allow").await;
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("the user's allow wins");
    t.expect("login:ubuntu@box").await;

    // 改回沿用 → 群組拒絕又生效，開著的終端機被結束（4009，原因 = 管理員）。/ Back to inherit: the open terminal is ended.
    grant(&lab, "user", Some(bob.id), "terminal", "inherit").await;
    assert_eq!(t.wait_closed().await, Some(4009));

    // 檔案：REST 403 feature_disabled；建立精靈的登入測試（sftp/shell）不受影響。/ Files: REST 403; the login test stays.
    grant(&lab, "group", Some(gid), "files", "deny").await;
    let r = app.get(&format!("/api/sftp/list/{id}/ubuntu"), Some(&bob.token)).await;
    assert_eq!((r.status, r.json["code"].as_str(), r.json["feature"].as_str()), (StatusCode::FORBIDDEN, Some("feature_disabled"), Some("files")), "{}", r.text);
    assert_eq!(lab.filemanager(&bob, &dev, "ubuntu", json!({"action": "shell_detect"})).await.err(), Some(FEATURE_CLOSE));
    assert_eq!(app.get(&format!("/api/sftp/shell/{id}/ubuntu"), Some(&bob.token)).await.status, StatusCode::OK);

    // 所有人都不能用遠端桌面 → 管理員還是可以（superuser 永遠全部都有）。/ Everyone denied; the admin still has it.
    grant(&lab, "everyone", None, "remote_desktop", "deny").await;
    assert_eq!(app.get("/api/credentials", Some(&alice.token)).await.json["code"], "feature_disabled");
    assert_eq!(app.get("/api/credentials", Some(&lab.admin_token)).await.status, StatusCode::OK);
    let admin_id = app.get("/api/auth/user/profile", Some(&lab.admin_token)).await.json["id"].as_i64().unwrap();
    let r = app.put("/api/access/grants", Some(&lab.admin_token), json!({"subject": "user", "id": admin_id, "feature": "terminal", "value": "deny"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "admins always have everything: {}", r.text);

    // 個人 SSH 金鑰被關：筆電經 gateway 連不上、也不能新增金鑰。/ Personal keys off: laptop SSH refused, no new keys.
    let laptop = [(Hop::Tunnel(&dev), "ubuntu")];
    assert!(lab.laptop_exec(&bob, &laptop, "whereami").await.ok);
    grant(&lab, "user", Some(bob.id), "keys.personal", "deny").await;
    assert!(!lab.laptop_exec(&bob, &laptop, "whereami").await.ok);
    let r = app.post("/api/reverse/user/keys", Some(&bob.token), json!({"host_friendly_name": "spare", "key": lab.keygen("spare").public})).await;
    assert_eq!(r.json["code"], "feature_disabled", "{}", r.text);

    // MCP app 被關 = 這個人的 token 全部失效（401，跟撤銷一樣）。/ MCP apps off: the person's tokens are refused.
    grant(&lab, "group", Some(gid), "mcp.connect", "deny").await;
    let (status, _, _) = call(app, &mcp, "list_tunnels", json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 刪群組 = 它的設定一起走。/ Deleting the group drops its settings.
    let r = app.delete(&format!("/api/access/groups/{gid}"), Some(&lab.admin_token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    lab.terminal(&bob, &dev, "ubuntu").await.expect("the group is gone").close().await;

    // 每個變更都是沒有隧道的管理員事件。/ Every change is a tunnel-less admin event.
    let events = app.get("/api/log/ssh/events?limit=500", Some(&lab.admin_token)).await.json;
    let kinds: Vec<&str> = events.as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"user_group") && kinds.contains(&"feature_grant"), "{kinds:?}");
    let mine = app.get("/api/log/ssh/events?limit=500", Some(&bob.token)).await.json;
    assert!(!mine.as_array().unwrap().iter().any(|e| e["event"] == "feature_grant"), "admin-only events");
}
