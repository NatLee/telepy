//! OAuth 2.1 授權伺服器（MCP 連接器）：discovery → 動態註冊 → 同意 → PKCE 換 token → refresh 輪替 → 撤銷。
//! The OAuth 2.1 authorization server end to end: discovery, registration, consent, PKCE, rotation, revocation.
mod common;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use common::{Resp, TestApp};
use telepy_server::auth::mcp::{self, McpAuthError};
use telepy_server::db;

const REDIRECT: &str = "http://localhost:33418/callback";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-and-some-more";

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

async fn form(app: &TestApp, path: &str, pairs: &[(&str, &str)], basic: Option<(&str, &str)>) -> Resp {
    let mut req = Request::builder().method(Method::POST).uri(path).header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if let Some((id, secret)) = basic {
        req = req.header(header::AUTHORIZATION, format!("Basic {}", STANDARD.encode(format!("{id}:{secret}"))));
    }
    app.send(req.body(Body::from(query(pairs))).unwrap()).await
}

async fn register_public(app: &TestApp) -> String {
    let r = app
        .post("/api/oauth/register", None, json!({"client_name": "Claude Code", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"}))
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert!(r.json.get("client_secret").is_none(), "public clients get no secret");
    r.json["client_id"].as_str().unwrap().to_string()
}

fn authorize_params<'a>(client_id: &'a str, challenge: &'a str, scope: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", REDIRECT),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("scope", scope),
        ("state", "xyz"),
        ("resource", "http://telepy.test/mcp"),
    ]
}

/// 同意頁核可 → 回 code。/ Approve on the consent page and return the code.
async fn approve(app: &TestApp, web: &str, client_id: &str, scope: &str, extra: Value) -> String {
    let ch = challenge(VERIFIER);
    let mut body: serde_json::Map<String, Value> = authorize_params(client_id, &ch, scope).into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
    body.insert("approve".into(), json!(true));
    if let Value::Object(extra) = extra {
        body.extend(extra);
    }
    let r = app.post("/api/oauth/authorize", Some(web), Value::Object(body)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let to = url::Url::parse(r.json["redirect_to"].as_str().unwrap()).unwrap();
    assert_eq!(to.as_str().split('?').next().unwrap(), REDIRECT);
    let q: std::collections::HashMap<String, String> = to.query_pairs().into_owned().collect();
    assert_eq!(q["state"], "xyz");
    assert!(q.contains_key("iss"));
    q["code"].clone()
}

async fn exchange(app: &TestApp, client_id: &str, code: &str) -> Resp {
    form(
        app,
        "/api/oauth/token",
        &[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", REDIRECT), ("client_id", client_id), ("code_verifier", VERIFIER), ("resource", "http://telepy.test/mcp")],
        None,
    )
    .await
}

#[tokio::test]
async fn discovery_documents() {
    let mut app = common::spawn().await;
    // 沒有 PUBLIC_URL：依 X-Forwarded-* 推導。/ No PUBLIC_URL: derived from the forwarded headers.
    let req = Request::get("/.well-known/oauth-authorization-server")
        .header(header::HOST, "backend:8000")
        .header("x-forwarded-proto", "https")
        .header("x-forwarded-host", "telepy.example.com")
        .body(Body::empty())
        .unwrap();
    let r = app.send(req).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["issuer"], "https://telepy.example.com");
    assert_eq!(r.json["authorization_endpoint"], "https://telepy.example.com/oauth/authorize");
    assert_eq!(r.json["registration_endpoint"], "https://telepy.example.com/api/oauth/register");
    assert_eq!(r.json["code_challenge_methods_supported"], json!(["S256"]));
    assert!(r.json["scopes_supported"].as_array().unwrap().iter().any(|s| s == "ssh:exec"));

    let mut config = app.state.config.clone();
    config.public_url = Some("https://t.example".into());
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    for path in ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"] {
        let r = app.get(path, None).await;
        assert_eq!(r.status, StatusCode::OK, "{path}");
        assert_eq!(r.json["resource"], "https://t.example/mcp");
        assert_eq!(r.json["authorization_servers"], json!(["https://t.example"]));
    }
    assert_eq!(app.get("/.well-known/oauth-authorization-server", None).await.json["token_endpoint"], "https://t.example/api/oauth/token");
    assert_eq!(mcp::www_authenticate("https://t.example", McpAuthError::Missing), r#"Bearer resource_metadata="https://t.example/.well-known/oauth-protected-resource/mcp""#);
}

#[tokio::test]
async fn dynamic_registration_validates_metadata() {
    let app = common::spawn().await;
    for (body, code) in [
        (json!({}), "invalid_redirect_uri"),
        (json!({"redirect_uris": ["http://evil.example/cb"]}), "invalid_redirect_uri"),
        (json!({"redirect_uris": ["javascript:alert(1)"]}), "invalid_redirect_uri"),
        (json!({"redirect_uris": [REDIRECT], "grant_types": ["client_credentials"]}), "invalid_client_metadata"),
        (json!({"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "private_key_jwt"}), "invalid_client_metadata"),
        (json!({"redirect_uris": [REDIRECT], "scope": "root"}), "invalid_client_metadata"),
    ] {
        let r = app.post("/api/oauth/register", None, body.clone()).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}: {}", r.text);
        assert_eq!(r.json["error"], code, "{body}");
    }
    // 沒指定認證方式 → RFC 7591 預設 client_secret_basic，拿到 secret。/ Default method gets a secret.
    let r = app.post("/api/oauth/register", None, json!({"redirect_uris": ["https://claude.ai/api/mcp/auth_callback"], "client_name": "claude.ai"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["token_endpoint_auth_method"], "client_secret_basic");
    assert!(r.json["client_secret"].as_str().unwrap().starts_with("tpcs_"));
    assert_eq!(r.json["grant_types"], json!(["authorization_code", "refresh_token"]));
    let stored = db::oauth::client_by_id(&app.state.db, r.json["client_id"].as_str().unwrap()).await.unwrap().unwrap();
    assert_ne!(stored.client_secret_hash.as_deref(), r.json["client_secret"].as_str(), "the secret is stored hashed");
}

#[tokio::test]
async fn consent_page_validation() {
    let app = common::spawn().await;
    let web = app.login("admin", "pw").await;
    let client_id = register_public(&app).await;
    let ch = challenge(VERIFIER);

    // 要網頁登入。/ Needs the web login.
    let path = format!("/api/oauth/authorize?{}", query(&authorize_params(&client_id, &ch, "")));
    assert_eq!(app.get(&path, None).await.status, StatusCode::UNAUTHORIZED);

    // client / redirect_uri 錯：不給 redirect_to（不可導回）。/ Bad client or redirect: no redirect_to.
    for params in [
        authorize_params("nope", &ch, ""),
        authorize_params(&client_id, &ch, "").into_iter().map(|(k, v)| if k == "redirect_uri" { (k, "http://localhost:1/other") } else { (k, v) }).collect(),
    ] {
        let r = app.get(&format!("/api/oauth/authorize?{}", query(&params)), Some(&web)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
        assert!(r.json.get("redirect_to").is_none(), "{}", r.text);
    }

    // 其餘錯誤：帶 redirect_to（含 error 與 state）。/ Other errors carry a redirect_to with error + state.
    for (params, code) in [
        (authorize_params(&client_id, &ch, "").into_iter().filter(|(k, _)| *k != "code_challenge").collect::<Vec<_>>(), "invalid_request"),
        (authorize_params(&client_id, &ch, "").into_iter().map(|(k, v)| if k == "code_challenge_method" { (k, "plain") } else { (k, v) }).collect(), "invalid_request"),
        (authorize_params(&client_id, &ch, "").into_iter().map(|(k, v)| if k == "response_type" { (k, "token") } else { (k, v) }).collect(), "unsupported_response_type"),
        (authorize_params(&client_id, &ch, "tunnels:read sudo"), "invalid_scope"),
        (authorize_params(&client_id, &ch, "").into_iter().map(|(k, v)| if k == "resource" { (k, "https://elsewhere.example/api") } else { (k, v) }).collect(), "invalid_target"),
    ] {
        let r = app.get(&format!("/api/oauth/authorize?{}", query(&params)), Some(&web)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
        assert_eq!(r.json["error"], code);
        let to = r.json["redirect_to"].as_str().unwrap();
        assert!(to.starts_with(REDIRECT) && to.contains(&format!("error={code}")) && to.contains("state=xyz"), "{to}");
    }

    // 正確的請求 → 同意頁資料（含可選隧道）；loopback 的 port 可以不同。/ Valid request (loopback port may differ).
    let me = app.get("/api/auth/user/profile", Some(&web)).await.json["id"].as_i64().unwrap();
    db::tunnels::create(&app.state.db, db::tunnels::NewTunnel { user_id: me, host_friendly_name: "box-a", key: "ssh-ed25519 AAAA a", reverse_port: 31001, description: None, default_username_id: None }).await.unwrap();
    let params: Vec<(&str, &str)> = authorize_params(&client_id, &ch, "ssh:exec tunnels:read").into_iter().map(|(k, v)| if k == "redirect_uri" { (k, "http://localhost:50999/callback") } else { (k, v) }).collect();
    let r = app.get(&format!("/api/oauth/authorize?{}", query(&params)), Some(&web)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["client"]["client_name"], "Claude Code");
    assert_eq!(r.json["redirect_host"], "localhost:50999");
    let scopes: Vec<&str> = r.json["scopes"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(scopes, vec!["tunnels:read", "ssh:exec"], "canonical order");
    assert_eq!(r.json["tunnels"][0]["name"], "box-a");
    assert_eq!(r.json["tunnels"][0]["permission"], "owner");

    // 拒絕 → access_denied。/ Deny → access_denied.
    let mut body: serde_json::Map<String, Value> = authorize_params(&client_id, &ch, "").into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
    body.insert("approve".into(), json!(false));
    let r = app.post("/api/oauth/authorize", Some(&web), Value::Object(body.clone())).await;
    assert!(r.json["redirect_to"].as_str().unwrap().contains("error=access_denied"), "{}", r.text);
    // 不能限制到看不到的隧道、也不能全部取消勾選。/ Unknown tunnels and empty selections are rejected.
    body.insert("approve".into(), json!(true));
    body.insert("tunnel_ids".into(), json!([999]));
    assert_eq!(app.post("/api/oauth/authorize", Some(&web), Value::Object(body.clone())).await.status, StatusCode::BAD_REQUEST);
    body.insert("tunnel_ids".into(), json!(null));
    body.insert("scopes".into(), json!([]));
    assert_eq!(app.post("/api/oauth/authorize", Some(&web), Value::Object(body)).await.json["error"], "invalid_scope");
}

#[tokio::test]
async fn preview_before_login() {
    let app = common::spawn().await;
    let client_id = register_public(&app).await;
    let ch = challenge(VERIFIER);

    // 公開：不用登入就能看到是誰在要求，以及取消時導回哪裡；不含任何帳號資料。
    // Public: who is asking and where Cancel goes, without any account data.
    let path = format!("/api/oauth/authorize/preview?{}", query(&authorize_params(&client_id, &ch, "ssh:exec tunnels:read")));
    let r = app.get(&path, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["client"]["client_name"], "Claude Code");
    assert_eq!(r.json["redirect_host"], "localhost:33418");
    let scopes: Vec<&str> = r.json["scopes"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(scopes, vec!["tunnels:read", "ssh:exec"]);
    let cancel = r.json["cancel_to"].as_str().unwrap();
    assert!(cancel.starts_with(REDIRECT) && cancel.contains("error=access_denied") && cancel.contains("state=xyz") && cancel.contains("iss="), "{cancel}");
    for key in ["user", "tunnels", "existing", "reauth"] {
        assert!(r.json.get(key).is_none(), "{key} must not be public: {}", r.text);
    }

    // 壞掉的請求在登入前就說清楚；client / redirect_uri 錯時不給導回網址。
    // Broken requests fail before the login; no redirect for a bad client or redirect URI.
    let r = app.get(&format!("/api/oauth/authorize/preview?{}", query(&authorize_params("nope", &ch, ""))), None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["error"], "invalid_client");
    assert!(r.json.get("redirect_to").is_none() && r.json.get("cancel_to").is_none(), "{}", r.text);
    let bad: Vec<(&str, &str)> = authorize_params(&client_id, &ch, "").into_iter().map(|(k, v)| if k == "response_type" { (k, "token") } else { (k, v) }).collect();
    let r = app.get(&format!("/api/oauth/authorize/preview?{}", query(&bad)), None).await;
    assert_eq!(r.json["error"], "unsupported_response_type");
    assert!(r.json["redirect_to"].as_str().unwrap().contains("error=unsupported_response_type"));
}

#[tokio::test]
async fn reconnecting_an_app_can_replace_the_old_connection() {
    let app = common::spawn().await;
    let web = app.login("admin", "pw").await;
    let client_id = register_public(&app).await;
    let ch = challenge(VERIFIER);
    let info_path = format!("/api/oauth/authorize?{}", query(&authorize_params(&client_id, &ch, "")));
    assert_eq!(app.get(&info_path, Some(&web)).await.json["existing"], json!([]));

    let code = approve(&app, &web, &client_id, "", json!({})).await;
    let first = exchange(&app, &client_id, &code).await.json["access_token"].as_str().unwrap().to_string();
    let info = app.get(&info_path, Some(&web)).await.json;
    assert_eq!(info["existing"].as_array().unwrap().len(), 1, "{info}");
    let first_id = info["existing"][0]["id"].as_i64().unwrap();
    assert!(info["existing"][0]["created_at"].as_str().unwrap().ends_with("+08:00"));

    // 不取代：兩個連線並存。/ Without replace both connections stay.
    let code = approve(&app, &web, &client_id, "", json!({})).await;
    let second = exchange(&app, &client_id, &code).await.json["access_token"].as_str().unwrap().to_string();
    assert_eq!(app.get("/api/oauth/grants", Some(&web)).await.json.as_array().unwrap().len(), 2);

    // 取代：核可時還不動舊的，客戶端兌換成功才撤銷。/ Replace: the old ones go only once the code is redeemed.
    let code = approve(&app, &web, &client_id, "", json!({"replace": true})).await;
    assert!(mcp::resolve(&app.state, &first).await.is_ok(), "nothing is revoked before the redemption");
    let r = exchange(&app, &client_id, &code).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let third = r.json["access_token"].as_str().unwrap().to_string();
    assert_eq!(mcp::resolve(&app.state, &first).await.unwrap_err(), McpAuthError::Invalid);
    assert_eq!(mcp::resolve(&app.state, &second).await.unwrap_err(), McpAuthError::Invalid);
    assert!(mcp::resolve(&app.state, &third).await.is_ok());
    let grants = app.get("/api/oauth/grants", Some(&web)).await.json;
    assert_eq!(grants.as_array().unwrap().len(), 1, "{grants}");
    assert_ne!(grants[0]["id"].as_i64().unwrap(), first_id);

    // 另一個 app 的連線不受影響。/ Another app's connection is untouched.
    let other = register_public(&app).await;
    let code = approve(&app, &web, &other, "", json!({})).await;
    let other_access = exchange(&app, &other, &code).await.json["access_token"].as_str().unwrap().to_string();
    let code = approve(&app, &web, &client_id, "", json!({"replace": true})).await;
    assert_eq!(exchange(&app, &client_id, &code).await.status, StatusCode::OK);
    assert!(mcp::resolve(&app.state, &other_access).await.is_ok());
    assert_eq!(app.get("/api/oauth/grants", Some(&web)).await.json.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn code_exchange_refresh_rotation_and_revocation() {
    let app = common::spawn().await;
    let web = app.login("admin", "pw").await;
    let me = app.get("/api/auth/user/profile", Some(&web)).await.json["id"].as_i64().unwrap();
    let tunnel = db::tunnels::create(&app.state.db, db::tunnels::NewTunnel { user_id: me, host_friendly_name: "box-a", key: "ssh-ed25519 AAAA a", reverse_port: 31001, description: None, default_username_id: None }).await.unwrap();
    let client_id = register_public(&app).await;

    // PKCE 錯 → invalid_grant，而且 code 已被消耗。/ Wrong verifier → invalid_grant, and the code is spent.
    let code = approve(&app, &web, &client_id, "", json!({})).await;
    let r = form(&app, "/api/oauth/token", &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client_id), ("code_verifier", &"x".repeat(43))], None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["error"], "invalid_grant");
    assert_eq!(exchange(&app, &client_id, &code).await.json["error"], "invalid_grant", "a code is single use");

    // 正確兌換；只勾 ssh:exec + tunnels:read，限制在 box-a。/ Proper exchange with a narrowed consent.
    let code = approve(&app, &web, &client_id, "", json!({"scopes": ["ssh:exec", "tunnels:read"], "tunnel_ids": [tunnel.id]})).await;
    let other = register_public(&app).await;
    assert_eq!(exchange(&app, &other, &code).await.json["error"], "invalid_grant", "the code belongs to another client");
    let code = approve(&app, &web, &client_id, "", json!({"scopes": ["ssh:exec", "tunnels:read"], "tunnel_ids": [tunnel.id]})).await;
    let r = exchange(&app, &client_id, &code).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
    assert_eq!(r.json["token_type"], "Bearer");
    assert_eq!(r.json["expires_in"], 3600);
    assert_eq!(r.json["scope"], "tunnels:read ssh:exec");
    let access = r.json["access_token"].as_str().unwrap().to_string();
    let refresh = r.json["refresh_token"].as_str().unwrap().to_string();
    assert!(refresh.starts_with("tpr_"));

    // MCP 端的驗證接受它，REST API 不接受。/ The MCP check accepts it; the REST API does not.
    let p = mcp::resolve(&app.state, &access).await.unwrap();
    assert_eq!(p.user.id, me);
    assert!(p.has_scope("ssh:exec") && !p.has_scope("ssh:files"));
    assert!(p.tunnel_allowed(tunnel.id) && !p.tunnel_allowed(tunnel.id + 1));
    assert_eq!(p.client_name, "Claude Code");
    assert_eq!(app.get("/api/auth/user/profile", Some(&access)).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(mcp::resolve(&app.state, &web).await.unwrap_err(), McpAuthError::Invalid, "web tokens are not MCP tokens");

    // refresh：輪替；舊的失效；可縮小 scope、不可擴大。/ Rotation; the old token dies; narrowing only.
    let r = form(&app, "/api/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client_id), ("scope", "tunnels:read")], None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["scope"], "tunnels:read");
    let refresh2 = r.json["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(refresh2, refresh);
    let narrowed = mcp::resolve(&app.state, r.json["access_token"].as_str().unwrap()).await.unwrap();
    assert!(!narrowed.has_scope("ssh:exec"));
    let r = form(&app, "/api/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client_id)], None).await;
    assert_eq!(r.json["error"], "invalid_grant", "a rotated refresh token is dead");
    let r = form(&app, "/api/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", &refresh2), ("client_id", &client_id), ("scope", "ssh:files")], None).await;
    assert_eq!(r.json["error"], "invalid_scope");
    let r = form(&app, "/api/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", &refresh2), ("client_id", &other)], None).await;
    assert_eq!(r.json["error"], "invalid_grant", "another client cannot use the refresh token");
    let r = form(&app, "/api/oauth/token", &[("grant_type", "password"), ("client_id", &client_id)], None).await;
    assert_eq!(r.json["error"], "unsupported_grant_type");

    // Connected apps：列出、別人刪不到、撤銷後 access 與 refresh 立即失效。
    // Connected apps: listed, not deletable by others, revocation kills access and refresh at once.
    let grants = app.get("/api/oauth/grants", Some(&web)).await.json;
    assert_eq!(grants.as_array().unwrap().len(), 1, "{grants}");
    assert_eq!(grants[0]["client_name"], "Claude Code");
    assert_eq!(grants[0]["scopes"], json!(["tunnels:read", "ssh:exec"]));
    assert_eq!(grants[0]["tunnels"], json!([{"id": tunnel.id, "name": "box-a"}]));
    assert!(grants[0]["expires_at"].as_str().unwrap().ends_with("+08:00"));
    let gid = grants[0]["id"].as_i64().unwrap();
    app.post("/api/site/settings", Some(&web), json!({"allow_registration": true})).await;
    let bob = app.login("bob", "pw").await;
    assert_eq!(app.get("/api/oauth/grants", Some(&bob)).await.json, json!([]));
    assert_eq!(app.delete(&format!("/api/oauth/grants/{gid}"), Some(&bob)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&format!("/api/oauth/grants/{gid}"), Some(&web)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(mcp::resolve(&app.state, &access).await.unwrap_err(), McpAuthError::Invalid);
    let r = form(&app, "/api/oauth/token", &[("grant_type", "refresh_token"), ("refresh_token", &refresh2), ("client_id", &client_id)], None).await;
    assert_eq!(r.json["error"], "invalid_grant");
    assert_eq!(app.get("/api/oauth/grants", Some(&web)).await.json, json!([]));

    // 停用的帳號：token 立即失效。/ Deactivated users lose access immediately.
    let code = approve(&app, &web, &client_id, "", json!({})).await;
    let access = exchange(&app, &client_id, &code).await.json["access_token"].as_str().unwrap().to_string();
    assert!(mcp::resolve(&app.state, &access).await.is_ok());
    sqlx::query("UPDATE auth_user SET is_active = 0 WHERE id = ?").bind(me).execute(&app.state.db.write).await.unwrap();
    assert_eq!(mcp::resolve(&app.state, &access).await.unwrap_err(), McpAuthError::Invalid);
}

#[tokio::test]
async fn confidential_clients_and_rfc7009_revocation() {
    let app = common::spawn().await;
    let web = app.login("admin", "pw").await;
    let r = app.post("/api/oauth/register", None, json!({"client_name": "claude.ai", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_post"})).await;
    let client_id = r.json["client_id"].as_str().unwrap().to_string();
    let secret = r.json["client_secret"].as_str().unwrap().to_string();

    let code = approve(&app, &web, &client_id, "tunnels:read", json!({})).await;
    // 缺 secret / 錯 secret → 401 invalid_client（code 不被消耗）。/ Missing or wrong secret → 401; the code survives.
    let r = exchange(&app, &client_id, &code).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json["error"], "invalid_client");
    let r = form(&app, "/api/oauth/token", &[("grant_type", "authorization_code"), ("code", &code), ("code_verifier", VERIFIER)], Some((&client_id, "wrong"))).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // Basic 認證可用（即使註冊時寫 client_secret_post）。/ Basic works too.
    let r = form(&app, "/api/oauth/token", &[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER)], Some((&client_id, &secret))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let access = r.json["access_token"].as_str().unwrap().to_string();
    let refresh = r.json["refresh_token"].as_str().unwrap().to_string();

    // RFC 7009：用 refresh token 撤銷整個 grant；未知 token 也回 200。/ Revocation by refresh token; unknown → 200.
    let r = form(&app, "/api/oauth/revoke", &[("token", "garbage"), ("client_id", &client_id), ("client_secret", &secret)], None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(mcp::resolve(&app.state, &access).await.is_ok());
    let r = form(&app, "/api/oauth/revoke", &[("token", &refresh), ("token_type_hint", "refresh_token"), ("client_id", &client_id), ("client_secret", &secret)], None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(mcp::resolve(&app.state, &access).await.is_err());
    let r = form(&app, "/api/oauth/revoke", &[("token", &refresh), ("client_id", &client_id)], None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "revocation authenticates the client");
}

#[tokio::test]
async fn cleanup_removes_unused_clients_and_dead_grants() {
    let app = common::spawn().await;
    let client_id = register_public(&app).await;
    sqlx::query("UPDATE telepy_oauth_client SET created_at = '2000-01-01 00:00:00.000000'").execute(&app.state.db.write).await.unwrap();
    assert_eq!(db::oauth::cleanup(&app.state.db).await.unwrap(), 1);
    assert!(db::oauth::client_by_id(&app.state.db, &client_id).await.unwrap().is_none());
}
