//! 個人 API token 端到端：建立（有第二因素要 reauth）、祕密只給一次、REST 白名單 + scope + 隧道限制、到期、撤銷立即生效、
//! 管理員撤銷、「API token」功能關掉 = token 失效、`/mcp` 收 token（要「MCP app」功能）、REST 版 session 在真的裝置上跑指令
//! （同樣的稽核、指令規則路徑），敏感隧道（step-up）拒絕 token，撤銷時它開的 session 一起關。
//! Personal API tokens end to end: create (reauth with a factor), the secret shown once, the REST allow-list + scopes +
//! tunnel restriction, expiry, immediate revocation, admin revocation, the feature switch, `/mcp` accepting tokens, REST
//! exec sessions on a real device (audited), step-up tunnels refusing tokens, and revocation closing the sessions.
mod common;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};

use common::lab::{Lab, MachineOpts};
use common::TestApp;
use telepy_server::mfa;

fn in_days(n: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::days(n)).to_rfc3339()
}

async fn create(app: &TestApp, web: &str, body: Value) -> (String, Value) {
    let r = app.post("/api/auth/tokens", Some(web), body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    (r.json["secret"].as_str().unwrap().to_string(), r.json["token"].clone())
}

async fn mcp(app: &TestApp, token: &str, body: Value) -> common::Resp {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/mcp")
        .header(header::HOST, "telepy.test")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    app.send(req).await
}

fn code_at(secret_b32: &str, unix: i64) -> String {
    let secret = mfa::base32_decode(secret_b32).unwrap();
    format!("{:06}", mfa::hotp(&secret, mfa::totp_step(unix as u64)))
}

#[tokio::test]
async fn tokens_scopes_restriction_expiry_and_revocation() {
    let app = common::spawn().await;
    let web = app.login("admin", "pw").await;
    let r = app.post("/api/reverse/server/keys", Some(&web), json!({"host_friendly_name": "box-a", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIboxa box-a", "reverse_port": 41001})).await;
    let a = r.json["id"].as_i64().unwrap();
    let r = app.post("/api/reverse/server/keys", Some(&web), json!({"host_friendly_name": "box-b", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIboxb box-b", "reverse_port": 41002})).await;
    let b = r.json["id"].as_i64().unwrap();

    // 欄位檢查：名稱、scope、到期（必填、≤ 1 年）、看得到的隧道。/ Field checks.
    let bad = |body: Value, field: &'static str| {
        let app = &app;
        let web = web.clone();
        async move {
            let r = app.post("/api/auth/tokens", Some(&web), body).await;
            assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
            assert!(r.json[field].is_array(), "{field}: {}", r.text);
        }
    };
    bad(json!({"name": "", "scopes": ["tunnels:read"], "expires_at": in_days(30)}), "name").await;
    bad(json!({"name": "x", "scopes": [], "expires_at": in_days(30)}), "scopes").await;
    bad(json!({"name": "x", "scopes": ["root"], "expires_at": in_days(30)}), "scopes").await;
    bad(json!({"name": "x", "scopes": ["tunnels:read"]}), "expires_at").await;
    bad(json!({"name": "x", "scopes": ["tunnels:read"], "expires_at": in_days(400)}), "expires_at").await;
    bad(json!({"name": "x", "scopes": ["tunnels:read"], "expires_at": in_days(30), "tunnel_ids": [9999]}), "tunnel_ids").await;

    let (read, row) = create(&app, &web, json!({"name": "ci read", "scopes": ["tunnels:read"], "expires_at": in_days(30)})).await;
    assert!(read.starts_with("tpt_"));
    assert_eq!(row["prefix"], read[..10]);
    assert_eq!(row["scopes"], json!(["tunnels:read"]));
    assert!(row["tunnels"].is_null() && row["active"] == true);
    // 列表不會再給祕密。/ The list never shows the secret again.
    let list = app.get("/api/auth/tokens", Some(&web)).await;
    assert_eq!(list.json.as_array().unwrap().len(), 1);
    assert!(!list.text.contains(&read));

    // token 可以讀；白名單外（帳號設定、建 token）一律 403 token_route。/ Reads work; everything off the allow-list is refused.
    assert_eq!(app.get("/api/auth/user/profile", Some(&read)).await.json["username"], "admin");
    let dash = app.get("/api/reverse/server/dashboard", Some(&read)).await;
    assert_eq!(dash.status, StatusCode::OK, "{}", dash.text);
    assert_eq!(dash.json["tunnels"].as_array().unwrap().len(), 2);
    for (m, p) in [(Method::POST, "/api/auth/tokens"), (Method::GET, "/api/auth/tokens/routes"), (Method::GET, "/api/site/settings"), (Method::POST, "/api/user/settings")] {
        let r = app.request(m.clone(), p, Some(&read), Some(json!({}))).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{m} {p}: {}", r.text);
        assert_eq!(r.json["code"], "token_route", "{m} {p}");
    }
    // scope 不夠 → 403 token_scope（而且說缺哪個）。/ Missing scope → 403 token_scope naming it.
    let r = app.request(Method::DELETE, &format!("/api/reverse/server/keys/{a}"), Some(&read), None).await;
    assert_eq!((r.status, r.json["code"].as_str(), r.json["scope"].as_str()), (StatusCode::FORBIDDEN, Some("token_scope"), Some("tunnels:manage")), "{}", r.text);

    // 隧道限制：清單只剩那條，別條 404，「不限隧道才能做」的寫入 403。/ Tunnel restriction.
    let r = app.post("/api/auth/tokens", Some(&web), json!({"name": "too long", "scopes": ["tunnels:read"], "expires_at": "2099-01-01"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "2099 is more than a year away");
    let (only_a, _) = create(&app, &web, json!({"name": "only a", "scopes": ["tunnels:read", "tunnels:manage"], "tunnel_ids": [a], "expires_at": in_days(10)})).await;
    let list = app.get("/api/reverse/server/keys", Some(&only_a)).await;
    let ids: Vec<i64> = list.json.as_array().unwrap().iter().map(|t| t["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![a]);
    assert_eq!(app.get(&format!("/api/reverse/server/keys/{b}"), Some(&only_a)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get(&format!("/tunnels/server/config/{a}"), Some(&only_a)).await.status, StatusCode::OK);
    let r = app.post("/api/reverse/server/keys", Some(&only_a), json!({"host_friendly_name": "box-c", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIboxc box-c", "reverse_port": 41003})).await;
    assert_eq!(r.json["code"], "token_tunnels", "{}", r.text);
    // 寫入成功 + 記一筆 token_call 事件（誰透過哪把 token）。/ A write succeeds and leaves a token_call event.
    let r = app.put(&format!("/api/reverse/server/{a}/labels"), Some(&only_a), json!({"labels": ["env=prod"]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM telepy_gateway_event WHERE event = 'token_call' AND tunnel_id = ? AND message LIKE '%via API token \"only a\"%'")
        .bind(a)
        .fetch_one(&app.state.db.read)
        .await
        .unwrap();
    assert_eq!(n, 1);

    // 到期 → 401；撤銷 → 立刻 401（快取清掉）。/ Expired → 401; revoked → 401 at once.
    sqlx::query("UPDATE telepy_api_token SET expires_at = '2000-01-01 00:00:00.000000' WHERE name = 'ci read'").execute(&app.state.db.write).await.unwrap();
    app.state.api_tokens.invalidate();
    assert_eq!(app.get("/api/auth/user/profile", Some(&read)).await.status, StatusCode::UNAUTHORIZED);
    let id = app.get("/api/auth/tokens", Some(&web)).await.json.as_array().unwrap().iter().find(|t| t["name"] == "only a").unwrap()["id"].as_i64().unwrap();
    assert_eq!(app.get("/api/auth/user/profile", Some(&only_a)).await.status, StatusCode::OK);
    assert_eq!(app.request(Method::DELETE, &format!("/api/auth/tokens/{id}"), Some(&web), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/auth/user/profile", Some(&only_a)).await.status, StatusCode::UNAUTHORIZED);
    let revoked = app.get("/api/auth/tokens", Some(&web)).await.json.as_array().unwrap().iter().find(|t| t["id"] == id).cloned().unwrap();
    assert_eq!(revoked["active"], false);
    assert!(revoked["revoked_at"].is_string());

    // 管理員看 / 撤銷別人的 token；一般人不行。/ Admins list and revoke anyone's tokens; others can't.
    app.post("/api/site/settings", Some(&web), json!({"allow_registration": true})).await;
    let bob_web = app.login("bob", "pw").await;
    let bob_id = app.get("/api/auth/user/profile", Some(&bob_web)).await.json["id"].as_i64().unwrap();
    let (bob_tok, bob_row) = create(&app, &bob_web, json!({"name": "bob laptop", "scopes": ["tunnels:read"], "expires_at": in_days(5)})).await;
    assert_eq!(app.get(&format!("/api/user/users/{bob_id}/tokens"), Some(&bob_web)).await.status, StatusCode::FORBIDDEN);
    let listed = app.get(&format!("/api/user/users/{bob_id}/tokens"), Some(&web)).await;
    assert_eq!(listed.json[0]["name"], "bob laptop");
    let tid = bob_row["id"].as_i64().unwrap();
    assert_eq!(app.request(Method::DELETE, &format!("/api/user/users/{bob_id}/tokens/{tid}"), Some(&web), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/auth/user/profile", Some(&bob_tok)).await.status, StatusCode::UNAUTHORIZED);

    // 「API token」功能關掉：建不了、既有的 token 失效。/ The feature off: no new tokens, existing ones refused.
    let (bob_tok2, _) = create(&app, &bob_web, json!({"name": "bob 2", "scopes": ["tunnels:read"], "expires_at": in_days(5)})).await;
    let r = app.put("/api/access/grants", Some(&web), json!({"subject": "user", "id": bob_id, "feature": "api.tokens", "value": "deny"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/auth/user/profile", Some(&bob_tok2)).await.status, StatusCode::UNAUTHORIZED);
    let r = app.post("/api/auth/tokens", Some(&bob_web), json!({"name": "bob 3", "scopes": ["tunnels:read"], "expires_at": in_days(5)})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("feature_disabled")), "{}", r.text);
    // 列表與撤銷照常（收回權限永遠可以做）。/ Listing and revoking stay open.
    assert_eq!(app.get("/api/auth/tokens", Some(&bob_web)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn creating_a_token_needs_reauth_once_the_account_has_a_factor() {
    let app = common::spawn().await;
    let web = app.login("admin", "pw").await;
    let r = app.post("/api/auth/mfa/totp/setup", Some(&web), json!({})).await;
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let now = chrono::Utc::now().timestamp();
    let r = app.post("/api/auth/mfa/totp/enable", Some(&web), json!({"code": code_at(&secret, now)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let codes: Vec<String> = r.json["recovery_codes"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
    let body = json!({"name": "ci", "scopes": ["tunnels:read"], "expires_at": in_days(7)});
    let r = app.post("/api/auth/tokens", Some(&web), body.clone()).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("reauth_required")), "{}", r.text);
    let mut with = body;
    with["reauth"] = json!({"method": "recovery_code", "code": codes[0]});
    let (tok, _) = create(&app, &web, with).await;
    assert_eq!(app.get("/api/reverse/server/dashboard", Some(&tok)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn mcp_accepts_api_tokens_while_mcp_apps_are_allowed() {
    let app = common::spawn().await;
    let (web, carol) = app.admin_and_user("admin", "carol").await;
    let carol_id = app.get("/api/auth/user/profile", Some(&carol)).await.json["id"].as_i64().unwrap();
    let (tok, _) = create(&app, &carol, json!({"name": "agent", "scopes": ["tunnels:read"], "expires_at": in_days(7)})).await;
    let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_tunnels", "arguments": {}}});
    let r = mcp(&app, &tok, list.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["result"]["isError"], false, "{}", r.text);
    // audit 記成「API token "agent"」。/ Audited under the token's name.
    let (client,): (String,) = sqlx::query_as("SELECT client_name FROM telepy_ai_audit_event WHERE tool = 'list_tunnels' ORDER BY id DESC LIMIT 1").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(client, "API token \"agent\"");
    // 「MCP app」關掉：token 在 /mcp 失效，REST 照常。/ MCP apps off: refused on /mcp, REST still works.
    app.put("/api/access/grants", Some(&web), json!({"subject": "user", "id": carol_id, "feature": "mcp.connect", "value": "deny"})).await;
    assert_eq!(mcp(&app, &tok, list).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/reverse/server/dashboard", Some(&tok)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn rest_exec_sessions_on_a_device_and_step_up_refusal() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let m = lab.machine_with("box", &[("pi", &[&lab.service])], MachineOpts { shell: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &m).await;
    lab.username(&alice, &dev, "pi").await;
    let app = &lab.app;
    let (tok, row) = create(app, &alice.token, json!({"name": "deploy", "scopes": ["tunnels:read", "ssh:exec"], "tunnel_ids": [dev.tunnel_id], "expires_at": in_days(3)})).await;

    // 網頁登入不能開 REST session（那是 token 的）。/ A web sign-in can't open REST sessions.
    let r = app.post("/api/ai/sessions", Some(&alice.token), json!({"tunnel_id": dev.tunnel_id})).await;
    assert_eq!(r.json["code"], "token_required", "{}", r.text);

    let r = app.post("/api/ai/sessions", Some(&tok), json!({"tunnel_id": dev.tunnel_id, "username": "pi"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let sid = r.json["id"].as_str().unwrap().to_string();
    assert_eq!(r.json["token_id"], row["id"]);
    let r = app.post(&format!("/api/ai/sessions/{sid}/exec"), Some(&tok), json!({"command": "echo hi-from-$USER"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["exit_code"], 0);
    assert_eq!(r.json["stdout"].as_str().unwrap().trim(), "hi-from-pi");
    let (client, detail): (String, Option<String>) = sqlx::query_as("SELECT client_name, detail FROM telepy_ai_audit_event WHERE tool = 'ssh_exec' ORDER BY id DESC LIMIT 1").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!((client.as_str(), detail.as_deref()), ("API token \"deploy\"", Some("echo hi-from-$USER")));
    // 別把 token 的 session 不能用。/ Another token can't use this session.
    let (other, _) = create(app, &alice.token, json!({"name": "other", "scopes": ["ssh:exec"], "expires_at": in_days(3)})).await;
    assert_eq!(app.post(&format!("/api/ai/sessions/{sid}/exec"), Some(&other), json!({"command": "id"})).await.status, StatusCode::NOT_FOUND);
    let listed = app.get("/api/ai/sessions", Some(&tok)).await;
    assert_eq!(listed.json.as_array().unwrap().len(), 1);

    // 撤銷 → 它開的 session 立刻關。/ Revoking closes its sessions.
    let tid = row["id"].as_i64().unwrap();
    assert_eq!(app.request(Method::DELETE, &format!("/api/auth/tokens/{tid}"), Some(&alice.token), None).await.status, StatusCode::NO_CONTENT);
    assert!(app.state.ai.get(&sid).is_none(), "the token's session closed with it");

    // 敏感隧道（step-up）：token 開不了 session，也不能拿瀏覽器的 step-up header 混過去。/ Step-up tunnels refuse tokens.
    sqlx::query("UPDATE authorized_keys_reverseserverauthorizedkeys SET require_step_up = 1 WHERE id = ?").bind(dev.tunnel_id).execute(&app.state.db.write).await.unwrap();
    let (tok2, _) = create(app, &alice.token, json!({"name": "deploy 2", "scopes": ["ssh:exec", "ssh:files"], "expires_at": in_days(3)})).await;
    let r = app.post("/api/ai/sessions", Some(&tok2), json!({"tunnel_id": dev.tunnel_id})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.json["error"].as_str().unwrap().contains("step-up"), "{}", r.text);
    let (step, _) = app.state.step_up.grant(alice.id);
    let req = Request::get(format!("/api/sftp/list/{}/pi", dev.tunnel_id)).header(header::AUTHORIZATION, format!("Bearer {tok2}")).header("x-telepy-step-up", step).body(Body::empty()).unwrap();
    let r = app.send(req).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("step_up_required")), "{}", r.text);
}
