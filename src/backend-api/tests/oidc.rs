//! OIDC 單一登入：一個真的在 127.0.0.1 上聽的假身分提供者（discovery、JWKS、token 端點；授權頁由測試自己「按同意」），
//! 從 start → 身分提供者 → callback → 兌換票券走一遍：第一次登入建帳號、網域限制、同名帳號、依 email 連結、
//! 綁定 cookie、單次使用、mix-up、nonce、連結 / 解除連結、最後一個登入方式、管理員試登入。
//!
//! OIDC sign-in against a fake provider listening on 127.0.0.1 (discovery, JWKS, token endpoint; the test "approves"
//! the authorization itself): start → provider → callback → redeem, and every refusal along the way.
mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use base64::Engine;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use common::{Resp, TestApp};

const TEST_EC_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgoOS0b1VN1vPoF+hx
6a2O0kY/iM9BA4hhi4I0XC/9WIuhRANCAARtrvl4kHvci1sPgu/3SF6jp84zZZG6
4yQ1Oh1oLTPd54lw2rE/iCdhzEIJ4UdlLqlNHFpfOt39XfoxaBFatAoT
-----END PRIVATE KEY-----";

struct Code {
    claims: Value,
    nonce: String,
    challenge: String,
    redirect_uri: String,
    client_id: String,
}

#[derive(Default)]
struct Idp {
    issuer: String,
    /// 預期的 client secret（None = public client，client_id 在表單裡）。/ The expected secret (None = public client).
    secret: Option<String>,
    codes: HashMap<String, Code>,
    /// 下一個 id_token 用別的 nonce（測 nonce 檢查）。/ Sign the next id_token with another nonce.
    wrong_nonce: bool,
}

type Shared = Arc<Mutex<Idp>>;

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

async fn discovery(State(idp): State<Shared>) -> Json<Value> {
    let i = idp.lock().unwrap().issuer.clone();
    Json(json!({
        "issuer": i,
        "authorization_endpoint": format!("{i}/authorize?tenant=t1"),
        "token_endpoint": format!("{i}/token"),
        "jwks_uri": format!("{i}/jwks"),
        "end_session_endpoint": format!("{i}/logout?tenant=t1"),
        "code_challenge_methods_supported": ["S256"],
    }))
}

async fn jwks() -> Json<Value> {
    Json(json!({"keys": [{
        "kty": "EC", "crv": "P-256", "kid": "k1", "alg": "ES256", "use": "sig",
        "x": "ba75eJB73ItbD4Lv90heo6fOM2WRuuMkNTodaC0z3ec",
        "y": "iXDasT-IJ2HMQgnhR2UuqU0cWl863f1d-jFoEVq0ChM"
    }]}))
}

async fn token(State(idp): State<Shared>, headers: HeaderMap, Form(form): Form<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
    let mut i = idp.lock().unwrap();
    let bad = |e: &str| (StatusCode::BAD_REQUEST, Json(json!({"error": e})));
    let Some(code) = form.get("code").and_then(|c| i.codes.remove(c)) else { return bad("invalid_grant") };
    // client 認證：有 secret 用 Basic，沒有就是表單裡的 client_id。/ Basic auth with a secret, else client_id in the form.
    let basic = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .and_then(|b| String::from_utf8(b).ok());
    match &i.secret {
        Some(s) if basic.as_deref() != Some(format!("{}:{s}", code.client_id).as_str()) => return bad("invalid_client"),
        None if form.get("client_id") != Some(&code.client_id) => return bad("invalid_client"),
        _ => {}
    }
    let verifier = form.get("code_verifier").cloned().unwrap_or_default();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    if challenge != code.challenge || form.get("redirect_uri") != Some(&code.redirect_uri) || form.get("grant_type").map(String::as_str) != Some("authorization_code") {
        return bad("invalid_grant");
    }
    let nonce = if std::mem::take(&mut i.wrong_nonce) { "someone-else".to_string() } else { code.nonce };
    let mut claims = json!({"iss": i.issuer, "aud": code.client_id, "exp": now() + 300, "iat": now(), "nonce": nonce});
    for (k, v) in code.claims.as_object().unwrap() {
        claims[k] = v.clone();
    }
    let mut h = Header::new(Algorithm::ES256);
    h.kid = Some("k1".into());
    let id_token = encode(&h, &claims, &EncodingKey::from_ec_pem(TEST_EC_PEM.as_bytes()).unwrap()).unwrap();
    (StatusCode::OK, Json(json!({"access_token": "at", "token_type": "Bearer", "id_token": id_token})))
}

async fn start_idp(secret: Option<&str>) -> Shared {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let idp: Shared = Arc::new(Mutex::new(Idp { issuer: format!("http://{addr}"), secret: secret.map(str::to_string), ..Default::default() }));
    let router = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/jwks", get(jwks))
        .route("/token", post(token))
        .with_state(idp.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    idp
}

/// 授權頁上「按同意」：記下 code 會拿到哪些 claim，回 (code, state)。/ "Approve" at the provider; returns (code, state).
fn approve(idp: &Shared, authorize_url: &str, claims: Value) -> (String, String) {
    let url = url::Url::parse(authorize_url).unwrap();
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(q.get("tenant").map(String::as_str), Some("t1"), "the endpoint's own query is kept");
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["code_challenge_method"], "S256");
    assert!(q["scope"].split(' ').any(|s| s == "openid"));
    let code = format!("code-{}", q["state"].chars().take(8).collect::<String>());
    idp.lock().unwrap().codes.insert(
        code.clone(),
        Code { claims, nonce: q["nonce"].clone(), challenge: q["code_challenge"].clone(), redirect_uri: q["redirect_uri"].clone(), client_id: q["client_id"].clone() },
    );
    (code, q["state"].clone())
}

/// Set-Cookie 裡有值的那些（`name=value`）。/ The non-empty cookies a response sets.
fn set_cookies(r: &Resp) -> Vec<String> {
    r.headers.get_all(header::SET_COOKIE).iter().filter_map(|v| v.to_str().ok()).map(|v| v.split(';').next().unwrap().to_string()).filter(|c| !c.ends_with('=')).collect()
}

fn location(r: &Resp) -> String {
    assert_eq!(r.status, StatusCode::FOUND, "{} {:?}", r.text, r.headers);
    r.headers[header::LOCATION].to_str().unwrap().to_string()
}

async fn get_with(app: &TestApp, path: &str, cookies: &[String], token: Option<&str>) -> Resp {
    let mut req = Request::builder().method(Method::GET).uri(path);
    if !cookies.is_empty() {
        req = req.header(header::COOKIE, cookies.join("; "));
    }
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    app.send(req.body(Body::empty()).unwrap()).await
}

async fn post_with(app: &TestApp, method: Method, path: &str, cookies: &[String], token: Option<&str>, body: Value) -> Resp {
    let mut req = Request::builder().method(method).uri(path).header(header::CONTENT_TYPE, "application/json");
    if !cookies.is_empty() {
        req = req.header(header::COOKIE, cookies.join("; "));
    }
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    app.send(req.body(Body::from(body.to_string())).unwrap()).await
}

/// start → 同意 → callback；回 callback 的回應與這個瀏覽器的 cookie。/ start → approve → callback.
async fn through(app: &TestApp, idp: &Shared, start_path: &str, cookies: &[String], claims: Value) -> (Resp, Vec<String>) {
    let r = get_with(app, start_path, cookies, None).await;
    let to = location(&r);
    assert!(to.starts_with(&idp.lock().unwrap().issuer), "to the provider: {to}");
    let jar = set_cookies(&r);
    assert_eq!(jar.len(), 1, "one binding cookie: {jar:?}");
    let (code, state) = approve(idp, &to, claims);
    let slug = start_path.trim_start_matches("/api/auth/oidc/").split('/').next().unwrap();
    let r = get_with(app, &format!("/api/auth/oidc/{slug}/callback?code={code}&state={state}"), &jar, None).await;
    (r, jar)
}

/// 整個登入：回兌換出來的 JSON（token 或錯誤 code）。/ A whole sign-in; returns the redeemed JSON, or the error code.
async fn sign_in(app: &TestApp, idp: &Shared, slug: &str, claims: Value) -> Result<Value, String> {
    let (r, _) = through(app, idp, &format!("/api/auth/oidc/{slug}/start"), &[], claims).await;
    let to = location(&r);
    if let Some(code) = to.split("sso_error=").nth(1) {
        return Err(code.split('&').next().unwrap().to_string());
    }
    let ticket = to.strip_prefix("/login?sso=").unwrap_or_else(|| panic!("{to}")).split('&').next().unwrap().to_string();
    let r = post_with(app, Method::POST, "/api/auth/oidc/redeem", &set_cookies(&r), None, json!({"ticket": ticket})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    Ok(r.json)
}

async fn whoami(app: &TestApp, token: &Value) -> String {
    let r = app.get("/api/auth/user/profile", token["access_token"].as_str()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["username"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn sso_sign_in_creates_finds_and_refuses() {
    let app = common::spawn().await;
    let idp = start_idp(Some("s3cret")).await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let admin = app.login("admin", "pw").await;

    // 管理員：檢查 discovery、新增（secret 只存不回）。/ Admin: discovery check, then add (the secret is never returned).
    let r = app.post("/api/site/oidc/discover", Some(&admin), json!({"issuer": format!("{issuer}/")})).await;
    assert_eq!((r.status, r.json["ok"].as_bool(), r.json["keys"].as_i64(), r.json["pkce"].as_str()), (StatusCode::OK, Some(true), Some(1), Some("S256")), "{}", r.text);
    let r = app.post("/api/site/oidc/discover", Some(&admin), json!({"issuer": "http://idp.example"})).await;
    assert!(r.json["issuer"].is_array(), "http only for loopback: {}", r.text);
    let r = app.post("/api/site/oidc", Some(&admin), json!({"name": "Corp IdP", "issuer": issuer, "client_id": "telepy", "client_secret": "s3cret", "allowed_domains": ["corp.example"]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let p = &r.json["providers"][0];
    assert_eq!((p["slug"].as_str(), p["has_secret"].as_bool(), p["create_users"].as_bool(), p["link_by_email"].as_bool()), (Some("corp-idp"), Some(true), Some(true), Some(false)));
    assert_eq!(p["callback_url"], "http://localhost/api/auth/oidc/corp-idp/callback");
    assert!(!r.text.contains("s3cret"), "the secret never comes back");
    let id = r.json["created_id"].as_i64().unwrap();
    let r = app.post("/api/site/oidc", Some(&admin), json!({"name": "x", "slug": "links", "issuer": issuer, "client_id": "c"})).await;
    assert!(r.json["slug"].is_array(), "reserved slug: {}", r.text);
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["sso"], json!([{"slug": "corp-idp", "name": "Corp IdP"}]));

    // 第一次登入建帳號，第二次回到同一個。/ The first sign-in creates the account; the second finds it.
    let alice = json!({"sub": "u-1", "email": "alice@corp.example", "email_verified": true, "given_name": "Alice"});
    let t = sign_in(&app, &idp, "corp-idp", alice.clone()).await.unwrap();
    assert_eq!(whoami(&app, &t).await, "alice");
    let user = telepy_server::db::users::by_username(&app.state.db, "alice").await.unwrap().unwrap();
    assert_eq!((user.email.as_str(), user.first_name.as_str(), user.password.starts_with('!')), ("alice@corp.example", "Alice", true));
    let t = sign_in(&app, &idp, "corp-idp", json!({"sub": "u-1", "email": "alice.renamed@corp.example"})).await.unwrap();
    assert_eq!(whoami(&app, &t).await, "alice", "found by sub, not by email");
    let r = app.get("/api/auth/sign-ins", t["access_token"].as_str()).await;
    assert!(r.text.contains("\"sso\""), "recorded as an sso sign-in: {}", r.text);

    // 拒絕：網域、同名、沒有 email。/ Refusals: domain, a taken username, no email.
    assert_eq!(sign_in(&app, &idp, "corp-idp", json!({"sub": "u-2", "email": "bob@other.example"})).await.unwrap_err(), "sso_domain_not_allowed");
    assert_eq!(sign_in(&app, &idp, "corp-idp", json!({"sub": "u-3"})).await.unwrap_err(), "sso_no_email");
    assert_eq!(sign_in(&app, &idp, "corp-idp", json!({"sub": "u-4", "email": "admin@corp.example"})).await.unwrap_err(), "sso_username_taken");

    // 不建帳號：沒連結過就拒絕；依已驗證的 email 連結（沒驗證的不算）。/ No creation; link by a verified email only.
    let r = app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"create_users": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["providers"][0]["has_secret"], true, "an omitted secret is kept");
    assert_eq!(sign_in(&app, &idp, "corp-idp", json!({"sub": "u-5", "email": "carol@corp.example"})).await.unwrap_err(), "sso_not_linked");
    app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    let r = app.post("/api/auth/register", None, json!({"username": "dave", "password": "pw"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    sqlx::query("UPDATE auth_user SET email = 'Dave@Corp.example' WHERE username = 'dave'").execute(&app.state.db.write).await.unwrap();
    let dave = json!({"sub": "u-6", "email": "dave@corp.example", "email_verified": false});
    app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"link_by_email": true})).await;
    assert_eq!(sign_in(&app, &idp, "corp-idp", dave).await.unwrap_err(), "sso_not_linked", "an unverified email links nothing");
    let t = sign_in(&app, &idp, "corp-idp", json!({"sub": "u-6", "email": "dave@corp.example", "email_verified": "true"})).await.unwrap();
    assert_eq!(whoami(&app, &t).await, "dave");
    let t = sign_in(&app, &idp, "corp-idp", json!({"sub": "u-6", "email": "dave@corp.example"})).await.unwrap();
    assert_eq!(whoami(&app, &t).await, "dave", "linked for good");

    // `next`：只收站內路徑。/ `next`: same-site paths only.
    let (r, jar) = through(&app, &idp, "/api/auth/oidc/corp-idp/start?next=%2Ftunnels%2Fkeys", &[], alice.clone()).await;
    let to = location(&r);
    assert!(to.starts_with("/login?sso=") && to.ends_with("&next=%2Ftunnels%2Fkeys"), "{to}");
    let ticket = to.trim_start_matches("/login?sso=").split('&').next().unwrap().to_string();
    // 票券：別的瀏覽器兌換不到（也不會作廢），同一個只能一次。/ Another browser can't redeem it (nor burn it); once only.
    let r = post_with(&app, Method::POST, "/api/auth/oidc/redeem", &jar, None, json!({"ticket": ticket})).await;
    assert_eq!(r.json["code"], "sso_browser", "the state cookie is not the ticket's: {}", r.text);
    let r = post_with(&app, Method::POST, "/api/auth/oidc/redeem", &[format!("telepy_oidc_t_{}=forged", ticket.chars().take(14).collect::<String>())], None, json!({"ticket": ticket})).await;
    assert_eq!(r.json["code"], "sso_expired", "a forged cookie gets nothing: {}", r.text);
    let r = get_with(&app, "/api/auth/oidc/corp-idp/start?next=%2F%2Fevil.example", &[], None).await;
    let (code, state) = approve(&idp, &location(&r), alice.clone());
    let r = get_with(&app, &format!("/api/auth/oidc/corp-idp/callback?code={code}&state={state}"), &set_cookies(&r), None).await;
    let to = location(&r);
    assert!(!to.contains("next="), "{to}");
    let ticket = to.trim_start_matches("/login?sso=").to_string();
    let jar = set_cookies(&r);
    assert_eq!(post_with(&app, Method::POST, "/api/auth/oidc/redeem", &jar, None, json!({"ticket": ticket})).await.status, StatusCode::OK);
    let r = post_with(&app, Method::POST, "/api/auth/oidc/redeem", &jar, None, json!({"ticket": ticket})).await;
    assert_eq!(r.json["code"], "sso_expired", "once only");

    // callback：沒有綁定 cookie、重播、別家的路徑、nonce 不對、身分提供者拒絕。
    // Callback: no binding cookie, a replay, another provider's path, a wrong nonce, the provider refusing.
    let r = get_with(&app, "/api/auth/oidc/corp-idp/start", &[], None).await;
    let (code, state) = approve(&idp, &location(&r), alice.clone());
    let jar = set_cookies(&r);
    let cb = format!("/api/auth/oidc/corp-idp/callback?code={code}&state={state}");
    assert_eq!(location(&get_with(&app, &cb, &[], None).await), "/login?sso_error=sso_browser&sso_provider=corp-idp");
    assert_eq!(location(&get_with(&app, &cb, &jar, None).await), "/login?sso_error=sso_expired&sso_provider=corp-idp", "the state is single use");
    app.post("/api/site/oidc", Some(&admin), json!({"name": "Other", "issuer": issuer, "client_id": "telepy", "client_secret": "s3cret"})).await;
    let r = get_with(&app, "/api/auth/oidc/corp-idp/start", &[], None).await;
    let (code, state) = approve(&idp, &location(&r), alice.clone());
    let r = get_with(&app, &format!("/api/auth/oidc/other/callback?code={code}&state={state}"), &set_cookies(&r), None).await;
    assert_eq!(location(&r), "/login?sso_error=sso_failed&sso_provider=other", "mix-up");
    idp.lock().unwrap().wrong_nonce = true;
    assert_eq!(sign_in(&app, &idp, "corp-idp", alice.clone()).await.unwrap_err(), "sso_failed", "nonce");
    let r = get_with(&app, "/api/auth/oidc/corp-idp/start", &[], None).await;
    let state = url::Url::parse(&location(&r)).unwrap().query_pairs().find(|(k, _)| k == "state").unwrap().1.to_string();
    let r = get_with(&app, &format!("/api/auth/oidc/corp-idp/callback?error=access_denied&state={state}"), &set_cookies(&r), None).await;
    assert_eq!(location(&r), "/login?sso_error=sso_denied&sso_provider=corp-idp");
    // 錯的 secret：換 code 失敗。/ A wrong secret: the exchange fails.
    app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"client_secret": "nope"})).await;
    assert_eq!(sign_in(&app, &idp, "corp-idp", alice.clone()).await.unwrap_err(), "sso_failed");
    app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"client_secret": "s3cret"})).await;

    // 停用的帳號、關掉的提供者。/ A disabled account; a turned-off provider.
    sqlx::query("UPDATE auth_user SET is_active = 0 WHERE username = 'alice'").execute(&app.state.db.write).await.unwrap();
    assert_eq!(sign_in(&app, &idp, "corp-idp", alice.clone()).await.unwrap_err(), "account_disabled");
    app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"enabled": false})).await;
    let r = get_with(&app, "/api/auth/oidc/corp-idp/start", &[], None).await;
    assert_eq!(location(&r), "/login?sso_error=sso_unknown&sso_provider=corp-idp");
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["sso"], json!([{"slug": "other", "name": "Other"}]));
}

#[tokio::test]
async fn linking_unlinking_and_test_sign_ins() {
    let app = common::spawn().await;
    // public client：沒有 secret，client_id 在表單裡。/ A public client: no secret.
    let idp = start_idp(None).await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let (admin, erin) = app.admin_and_user("admin", "erin").await;
    let r = app.post("/api/site/oidc", Some(&admin), json!({"name": "Keycloak", "issuer": issuer, "client_id": "telepy-web", "username_from": "preferred_username"})).await;
    assert_eq!((r.status, r.json["providers"][0]["has_secret"].as_bool()), (StatusCode::OK, Some(false)), "{}", r.text);
    let id = r.json["created_id"].as_i64().unwrap();
    assert_eq!(app.get("/api/site/oidc", Some(&erin)).await.json["code"], "admin_only");

    // erin 連結自己的身分：意圖綁這個瀏覽器。/ erin links her identity; the intent is bound to this browser.
    let r = app.get("/api/auth/oidc/links", Some(&erin)).await;
    assert_eq!((r.json["providers"][0]["linked"].as_bool(), r.json["has_password"].as_bool()), (Some(false), Some(true)), "{}", r.text);
    let r = app.post(&format!("/api/auth/oidc/links/{id}"), Some(&erin), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let url = r.json["url"].as_str().unwrap().to_string();
    // 別的瀏覽器打開同一個網址：什麼都不連。/ The same URL in another browser links nothing.
    assert_eq!(location(&get_with(&app, &url, &[], None).await), "/tunnels/sso?error=sso_expired&provider=keycloak");
    let r = app.post(&format!("/api/auth/oidc/links/{id}"), Some(&erin), json!({})).await;
    let (url, intent_jar) = (r.json["url"].as_str().unwrap().to_string(), set_cookies(&r));
    let (r, _) = through(&app, &idp, &url, &intent_jar, json!({"sub": "kc-erin", "preferred_username": "erin.w@corp.example"})).await;
    assert_eq!(location(&r), "/tunnels/sso?linked=keycloak");
    assert_eq!(app.get("/api/auth/oidc/links", Some(&erin)).await.json["providers"][0]["linked"], true);
    let r = app.post(&format!("/api/auth/oidc/links/{id}"), Some(&erin), json!({})).await;
    assert_eq!(r.json["code"], "already_linked");
    let t = sign_in(&app, &idp, "keycloak", json!({"sub": "kc-erin"})).await.unwrap();
    assert_eq!(whoami(&app, &t).await, "erin");

    // 第一次登入建的帳號（preferred_username 的 @ 前面）；它不能連到 erin 已經連的身分。
    // An account from a first sign-in (preferred_username's local part); it can't take erin's identity.
    let t = sign_in(&app, &idp, "keycloak", json!({"sub": "kc-frank", "preferred_username": "frank@corp.example", "email": "f@corp.example"})).await.unwrap();
    assert_eq!(whoami(&app, &t).await, "frank");
    let frank = t["access_token"].as_str().unwrap().to_string();
    let admin_link = app.post(&format!("/api/auth/oidc/links/{id}"), Some(&admin), json!({})).await;
    let (r, _) = through(&app, &idp, admin_link.json["url"].as_str().unwrap(), &set_cookies(&admin_link), json!({"sub": "kc-frank"})).await;
    assert_eq!(location(&r), "/tunnels/sso?error=sso_linked_elsewhere&provider=keycloak");

    // 解除：erin 有密碼可以；frank 只有這個登入方式不行。/ Unlink: erin has a password; frank has no other way in.
    let r = post_with(&app, Method::DELETE, &format!("/api/auth/oidc/links/{id}"), &[], Some(&frank), json!({})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("last_sign_in_method")), "{}", r.text);
    let r = post_with(&app, Method::DELETE, &format!("/api/auth/oidc/links/{id}"), &[], Some(&erin), json!({})).await;
    assert_eq!((r.status, r.json["providers"][0]["linked"].as_bool()), (StatusCode::OK, Some(false)), "{}", r.text);

    // 管理員試登入（提供者還沒啟用也可以）：看 claim 與 Telepy 會怎麼做，誰都沒登入、沒建帳號。
    // An admin's test (works before enabling): the claims and what Telepy would do; nobody signed in or created.
    app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"enabled": false})).await;
    let r = app.post(&format!("/api/site/oidc/{id}/test"), Some(&admin), json!({})).await;
    let (r, _) = through(&app, &idp, r.json["url"].as_str().unwrap(), &set_cookies(&r), json!({"sub": "kc-new", "preferred_username": "grace", "groups": ["ops"]})).await;
    let to = location(&r);
    assert!(to.starts_with("/tunnels/sso?test="), "{to}");
    let ticket = to.trim_start_matches("/tunnels/sso?test=").split('&').next().unwrap().to_string();
    let jar = set_cookies(&r);
    let r = post_with(&app, Method::POST, "/api/auth/oidc/test-result", &jar, Some(&erin), json!({"ticket": ticket})).await;
    assert_eq!(r.json["code"], "admin_only");
    let r = post_with(&app, Method::POST, "/api/auth/oidc/test-result", &jar, Some(&admin), json!({"ticket": ticket})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["claims"]["groups"].clone(), r.json["would"].clone()), (json!(["ops"]), json!({"action": "create", "username": "grace"})));
    assert!(telepy_server::db::users::by_username(&app.state.db, "grace").await.unwrap().is_none(), "a test creates nobody");
    let r = post_with(&app, Method::POST, "/api/auth/oidc/redeem", &jar, None, json!({"ticket": ticket})).await;
    assert_eq!(r.json["code"], "sso_expired", "a test ticket never signs in");

    // 刪掉提供者：連結一起走。/ Deleting a provider removes its links.
    let r = app.delete(&format!("/api/site/oidc/{id}"), Some(&admin)).await;
    assert_eq!((r.status, r.json["providers"].as_array().map(Vec::len)), (StatusCode::OK, Some(0)), "{}", r.text);
    assert_eq!(telepy_server::db::oidc::user_for(&app.state.db, id, "kc-frank").await.unwrap(), None);
    let r = app.get("/api/log/ssh/events?scope=all&limit=50", Some(&admin)).await;
    for kind in ["sso_provider", "sso_link"] {
        assert!(r.json.as_array().unwrap().iter().any(|e| e["event"] == kind), "{kind} event: {}", r.text);
    }
}

#[tokio::test]
async fn provider_groups_become_admin_rights_and_user_groups() {
    let app = common::spawn().await;
    let idp = start_idp(Some("s3cret")).await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let admin = app.login("admin", "pw").await;
    let group = |name: &'static str| {
        let (app, admin) = (&app, admin.clone());
        async move {
            let r = app.post("/api/access/groups", Some(&admin), json!({"name": name})).await;
            assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
            r.json["created_id"].as_i64().unwrap()
        }
    };
    let (ops, dev) = (group("Ops").await, group("Dev").await);

    // 規則要指向存在的群組；claim 路徑要合規。/ Rules must point at existing groups; the claim path must be valid.
    let base = json!({"name": "Corp", "issuer": issuer, "client_id": "telepy", "client_secret": "s3cret"});
    let with = |extra: Value| {
        let mut b = base.clone();
        b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        b
    };
    let r = app.post("/api/site/oidc", Some(&admin), with(json!({"group_rules": [{"idp_group": "x", "target": "group", "group_id": 9999}]}))).await;
    assert!(r.json["group_rules"].is_array(), "{}", r.text);
    let r = app.post("/api/site/oidc", Some(&admin), with(json!({"groups_claim": "a..b"}))).await;
    assert!(r.json["groups_claim"].is_array(), "{}", r.text);
    let r = app
        .post(
            "/api/site/oidc",
            Some(&admin),
            with(json!({"required_groups": ["staff", " staff "], "group_rules": [{"idp_group": "ops", "target": "group", "group_id": ops}, {"idp_group": "telepy-admins", "target": "admin"}]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let p = &r.json["providers"][0];
    assert_eq!(p["required_groups"], json!(["staff"]));
    assert_eq!(p["group_rules"][0], json!({"idp_group": "ops", "target": "group", "group_id": ops, "group_name": "Ops"}));
    assert_eq!(p["groups_claim"], "groups");
    assert_eq!(r.json["user_groups"].as_array().map(Vec::len), Some(2));
    let id = r.json["created_id"].as_i64().unwrap();

    // 只有 staff 能登入；沒有群組 claim 也不行。/ Only staff may sign in; no groups claim = no.
    assert_eq!(sign_in(&app, &idp, "corp", json!({"sub": "g-1", "email": "grace@corp.example", "groups": ["contractors"]})).await.unwrap_err(), "sso_group_not_allowed");
    assert_eq!(sign_in(&app, &idp, "corp", json!({"sub": "g-1", "email": "grace@corp.example"})).await.unwrap_err(), "sso_no_groups");

    let db = &app.state.db;
    let grace = || async { telepy_server::db::users::by_username(db, "grace").await.unwrap().unwrap() };
    let groups_of = |uid: i64| async move { telepy_server::db::features::groups_of(db, uid).await.unwrap() };

    // 第一次登入：建帳號，進 Ops。/ First sign-in: the account is created and joins Ops.
    sign_in(&app, &idp, "corp", json!({"sub": "g-1", "email": "grace@corp.example", "groups": ["staff", "ops"]})).await.unwrap();
    let g = grace().await;
    assert_eq!((groups_of(g.id).await, g.is_superuser), (std::collections::BTreeSet::from([ops]), false));

    // 管理員手動把她加進 Dev；下次登入 ops → telepy-admins：離開 Ops、成為管理員、Dev 不動。
    // An admin adds her to Dev by hand; the next sign-in moves her from ops to telepy-admins.
    let r = app.patch(&format!("/api/access/groups/{dev}"), Some(&admin), json!({"members": [g.id]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    sign_in(&app, &idp, "corp", json!({"sub": "g-1", "groups": ["staff", "telepy-admins"]})).await.unwrap();
    let g = grace().await;
    assert_eq!((groups_of(g.id).await, g.is_superuser), (std::collections::BTreeSet::from([dev]), true));
    let policy = app.get("/api/access", Some(&admin)).await;
    let me = policy.json["users"].as_array().unwrap().iter().find(|u| u["id"] == g.id).unwrap().clone();
    assert_eq!(me["sso_admin"], "Corp", "the access page knows where the admin right came from");

    // 不在 telepy-admins 了：管理員拿掉（還有別的管理員），手動給的 Dev 留著。
    // Out of telepy-admins: the admin right goes (another admin remains), the hand-given Dev stays.
    sign_in(&app, &idp, "corp", json!({"sub": "g-1", "groups": ["staff"]})).await.unwrap();
    let g = grace().await;
    assert_eq!((groups_of(g.id).await, g.is_superuser), (std::collections::BTreeSet::from([dev]), false));

    // 手動加進 Ops：提供者沒給的，它就不拿走。/ Ops added by hand: the provider never takes away what it didn't give.
    app.patch(&format!("/api/access/groups/{ops}"), Some(&admin), json!({"members": [g.id]})).await;
    sign_in(&app, &idp, "corp", json!({"sub": "g-1", "groups": ["staff"]})).await.unwrap();
    assert!(groups_of(g.id).await.contains(&ops));
    let policy = app.get("/api/access", Some(&admin)).await;
    let ops_json = policy.json["groups"].as_array().unwrap().iter().find(|x| x["id"] == ops).unwrap().clone();
    assert_eq!(ops_json["sso_members"], json!([]), "a hand-given membership is not marked as the provider's");

    // 沒有群組 claim（不再限定群組時）：什麼都不動。/ No groups claim (once nothing is required): nothing changes.
    app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"required_groups": []})).await;
    app.patch(&format!("/api/access/groups/{ops}"), Some(&admin), json!({"members": []})).await;
    sign_in(&app, &idp, "corp", json!({"sub": "g-1", "groups": ["ops"]})).await.unwrap();
    assert!(groups_of(g.id).await.contains(&ops));
    sign_in(&app, &idp, "corp", json!({"sub": "g-1"})).await.unwrap();
    assert!(groups_of(g.id).await.contains(&ops), "no claim = left as it is");
    let policy = app.get("/api/access", Some(&admin)).await;
    let ops_json = policy.json["groups"].as_array().unwrap().iter().find(|x| x["id"] == ops).unwrap().clone();
    assert_eq!(ops_json["sso_members"], json!([{"user_id": g.id, "provider": "Corp"}]));

    // 試登入：列出讀到的群組與會怎麼改。/ A test sign-in lists the groups and what would change.
    let r = app.post(&format!("/api/site/oidc/{id}/test"), Some(&admin), json!({})).await;
    let (r, _) = through(&app, &idp, r.json["url"].as_str().unwrap(), &set_cookies(&r), json!({"sub": "g-1", "groups": ["telepy-admins"]})).await;
    let to = location(&r);
    let ticket = to.trim_start_matches("/tunnels/sso?test=").split('&').next().unwrap().to_string();
    let r = post_with(&app, Method::POST, "/api/auth/oidc/test-result", &set_cookies(&r), Some(&admin), json!({"ticket": ticket})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["groups"].clone(), r.json["groups_claim"].clone()), (json!(["telepy-admins"]), json!("groups")));
    assert_eq!(r.json["would"]["roles"], json!({"join": [], "leave": ["Ops"], "admin": "grant"}));
    assert!(!grace().await.is_superuser, "a test changes nothing");

    // 刪掉 Ops：指向它的規則一起走。/ Deleting Ops removes the rules pointing at it.
    app.delete(&format!("/api/access/groups/{ops}"), Some(&admin)).await;
    let r = app.get("/api/site/oidc", Some(&admin)).await;
    assert_eq!(r.json["providers"][0]["group_rules"], json!([{"idp_group": "telepy-admins", "target": "admin", "group_id": null, "group_name": null}]));
    let r = app.get("/api/log/ssh/events?scope=all&limit=100", Some(&admin)).await;
    assert!(r.json.as_array().unwrap().iter().any(|e| e["event"] == "sso_role" && e["message"].as_str().unwrap_or("").contains("became an administrator")), "{}", r.text);
}

fn code_at(secret_b32: &str, unix: i64) -> String {
    let secret = telepy_server::mfa::base32_decode(secret_b32).unwrap();
    format!("{:06}", telepy_server::mfa::hotp(&secret, telepy_server::mfa::totp_step(unix as u64)))
}

async fn logout_url(app: &TestApp, tokens: &Value) -> Value {
    let r = app.post("/api/auth/logout", None, json!({"refresh": tokens["refresh_token"]})).await;
    assert_eq!((r.status, r.json["revoked"].as_bool()), (StatusCode::OK, Some(true)), "{}", r.text);
    r.json["end_session_url"].clone()
}

#[tokio::test]
async fn signing_out_also_signs_out_at_the_provider_when_asked() {
    let app = common::spawn().await;
    let idp = start_idp(Some("s3cret")).await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let admin = app.login("admin", "pw").await;
    let r = app.post("/api/site/oidc", Some(&admin), json!({"name": "Corp", "issuer": issuer, "client_id": "telepy", "client_secret": "s3cret", "end_session": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["providers"][0]["end_session"].as_bool(), r.json["providers"][0]["post_logout_url"].as_str()), (Some(true), Some("http://localhost/login")));
    let id = r.json["created_id"].as_i64().unwrap();
    let kim = json!({"sub": "k-1", "email": "kim@corp.example"});

    // 單一登入的登出：回身分提供者的登出網址，帶 id_token、回來的網址與 client_id；只回一次。
    // An SSO sign-in's logout answers the provider's sign-out URL (id_token, way back, client id), once.
    let tokens = sign_in(&app, &idp, "corp", kim.clone()).await.unwrap();
    let url = logout_url(&app, &tokens).await;
    let url = url::Url::parse(url.as_str().unwrap_or_else(|| panic!("no url: {url}"))).unwrap();
    assert_eq!(format!("{}://{}{}", url.scheme(), url.host_str().unwrap(), url.path()), format!("{}/logout", issuer.replace(&format!(":{}", url.port().unwrap()), "")));
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!((q["tenant"].as_str(), q["post_logout_redirect_uri"].as_str(), q["client_id"].as_str()), ("t1", "http://localhost/login", "telepy"));
    let payload = q["id_token_hint"].split('.').nth(1).unwrap();
    let payload: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
    assert_eq!(payload["sub"], "k-1", "the hint is this sign-in's own id_token");
    let r = app.post("/api/auth/logout", None, json!({"refresh": tokens["refresh_token"]})).await;
    assert_eq!(r.json["end_session_url"], Value::Null, "the record goes with the first logout");

    // 密碼登入、或身分提供者沒開這個選項：只登出 Telepy。/ A password sign-in, or the option off: Telepy only.
    let r = app.post("/api/auth/token", None, json!({"username": "admin", "password": "pw"})).await;
    assert_eq!(logout_url(&app, &r.json).await, Value::Null);
    app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"end_session": false})).await;
    let tokens = sign_in(&app, &idp, "corp", kim.clone()).await.unwrap();
    assert_eq!(logout_url(&app, &tokens).await, Value::Null);
    app.patch(&format!("/api/site/oidc/{id}"), Some(&admin), json!({"end_session": true})).await;

    // 有兩步驟驗證：通過第二步之後的登入一樣會登出身分提供者。/ With two-step sign-in, the sign-in after the second step too.
    let tokens = sign_in(&app, &idp, "corp", kim.clone()).await.unwrap();
    let web = tokens["access_token"].as_str().unwrap().to_string();
    let r = app.post("/api/auth/mfa/totp/setup", Some(&web), json!({})).await;
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let now = chrono::Utc::now().timestamp();
    let r = app.post("/api/auth/mfa/totp/enable", Some(&web), json!({"code": code_at(&secret, now)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    sqlx::query("UPDATE telepy_user_mfa SET totp_last_step = NULL").execute(&app.state.db.write).await.unwrap();
    let ch = sign_in(&app, &idp, "corp", kim.clone()).await.unwrap();
    assert_eq!(ch["mfa_required"], true, "{ch}");
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": ch["mfa_token"], "method": "totp", "code": code_at(&secret, now)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(logout_url(&app, &r.json).await.as_str().is_some_and(|u| u.contains("id_token_hint=")));
}

/// 帶 SCIM 權杖、`application/scim+json` 的請求。/ A request with the SCIM token and `application/scim+json`.
async fn scim(app: &TestApp, method: Method, path: &str, token: &str, body: Option<Value>) -> Resp {
    let mut req = Request::builder().method(method).uri(format!("/api/scim/v2{path}")).header(header::AUTHORIZATION, format!("Bearer {token}"));
    let req = match body {
        Some(b) => req.header(header::CONTENT_TYPE, "application/scim+json").body(Body::from(b.to_string())).unwrap(),
        None => {
            req = req.header(header::ACCEPT, "application/scim+json");
            req.body(Body::empty()).unwrap()
        }
    };
    app.send(req).await
}

#[tokio::test]
async fn scim_provisions_accounts_and_groups_that_sso_then_signs_in_to() {
    let app = common::spawn().await;
    let idp = start_idp(Some("s3cret")).await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let admin = app.login("admin", "pw").await;
    let r = app.post("/api/site/oidc", Some(&admin), json!({"name": "Corp", "issuer": issuer, "client_id": "telepy", "client_secret": "s3cret", "create_users": false})).await;
    let id = r.json["created_id"].as_i64().unwrap();
    assert_eq!(r.json["scim_base"], "http://localhost/api/scim/v2");
    assert_eq!(r.json["providers"][0]["scim"]["active"], false);

    // 權杖：只顯示一次；沒有或錯的權杖 = 401（SCIM 的錯誤格式）。/ The token is shown once; none or wrong = 401.
    let r = app.post(&format!("/api/site/oidc/{id}/scim-token"), Some(&admin), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let token = r.json["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("tps_") && r.json["base_url"] == "http://localhost/api/scim/v2");
    let r = scim(&app, Method::GET, "/Users", "tps_wrong", None).await;
    assert_eq!((r.status, r.json["status"].as_str(), r.json["schemas"][0].as_str()), (StatusCode::UNAUTHORIZED, Some("401"), Some("urn:ietf:params:scim:api:messages:2.0:Error")));
    assert_eq!(app.get("/api/scim/v2/Users", Some(&admin)).await.status, StatusCode::UNAUTHORIZED, "a web sign-in is not a SCIM token");
    let r = scim(&app, Method::GET, "/ServiceProviderConfig", &token, None).await;
    assert_eq!((r.status, r.json["patch"]["supported"].as_bool()), (StatusCode::OK, Some(true)));
    assert_eq!(r.headers[header::CONTENT_TYPE], "application/scim+json");

    // 建帳號（Okta 的樣子）。/ Create an account, Okta style.
    let alice = json!({"schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"], "userName": "alice@corp.example", "externalId": "00u1",
        "name": {"givenName": "Alice", "familyName": "W"}, "emails": [{"value": "alice@corp.example", "primary": true, "type": "work"}], "active": true});
    let r = scim(&app, Method::POST, "/Users", &token, Some(alice.clone())).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let uid: i64 = r.json["id"].as_str().unwrap().parse().unwrap();
    assert_eq!((r.json["userName"].as_str(), r.json["active"].as_bool()), (Some("alice@corp.example"), Some(true)), "userName echoed as sent");
    assert_eq!(r.json["meta"]["location"], format!("http://localhost/api/scim/v2/Users/{uid}"));
    let u = telepy_server::db::users::by_id(&app.state.db, uid).await.unwrap().unwrap();
    assert_eq!((u.username.as_str(), u.first_name.as_str(), u.email.as_str(), u.is_active), ("alice", "Alice", "alice@corp.example", true));
    assert_eq!(scim(&app, Method::POST, "/Users", &token, Some(alice.clone())).await.json["scimType"], "uniqueness");
    let r = scim(&app, Method::POST, "/Users", &token, Some(json!({"userName": "admin@corp.example"}))).await;
    assert_eq!((r.status, r.json["scimType"].as_str()), (StatusCode::CONFLICT, Some("uniqueness")), "an existing account is never taken over: {}", r.text);
    let r = scim(&app, Method::GET, "/Users?filter=userName%20eq%20%22ALICE@corp.example%22", &token, None).await;
    assert_eq!((r.json["totalResults"].as_u64(), r.json["Resources"][0]["id"].as_str()), (Some(1), Some(uid.to_string().as_str())));
    assert_eq!(scim(&app, Method::GET, "/Users?filter=externalId%20eq%20%2200u1%22", &token, None).await.json["totalResults"], 1);
    let admin_id = app.get("/api/auth/user/profile", Some(&admin)).await.json["id"].as_i64().unwrap();
    assert_eq!(scim(&app, Method::GET, &format!("/Users/{admin_id}"), &token, None).await.status, StatusCode::NOT_FOUND, "only its own accounts");

    // 第一次單一登入：接上預先建好的帳號（沒開建帳號也可以）。/ The first SSO sign-in takes the provisioned account.
    let t = sign_in(&app, &idp, "corp", json!({"sub": "u-alice", "email": "alice@corp.example"})).await.unwrap();
    assert_eq!(whoami(&app, &t).await, "alice");

    // Entra 的停用：op 大寫、字串布林。帳號停用、登入撤銷。/ Entra's deactivation: the account is disabled, sign-ins revoked.
    let r = scim(&app, Method::PATCH, &format!("/Users/{uid}"), &token, Some(json!({"schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], "Operations": [{"op": "Replace", "path": "active", "value": "False"}]}))).await;
    assert_eq!((r.status, r.json["active"].as_bool()), (StatusCode::OK, Some(false)), "{}", r.text);
    assert!(!telepy_server::db::users::by_id(&app.state.db, uid).await.unwrap().unwrap().is_active);
    assert_eq!(app.get("/api/auth/user/profile", t["access_token"].as_str()).await.status, StatusCode::UNAUTHORIZED, "her open sign-in ended");
    assert_eq!(sign_in(&app, &idp, "corp", json!({"sub": "u-alice", "email": "alice@corp.example"})).await.unwrap_err(), "account_disabled");
    // Okta 的重新啟用 + 改名字：沒有 path 的物件。/ Okta's reactivation and rename: a path-less object.
    let r = scim(&app, Method::PATCH, &format!("/Users/{uid}"), &token, Some(json!({"Operations": [{"op": "replace", "value": {"active": true, "name.givenName": "Ali"}}]}))).await;
    assert_eq!((r.json["active"].as_bool(), r.json["name"]["givenName"].as_str()), (Some(true), Some("Ali")), "{}", r.text);
    let r = scim(&app, Method::PUT, &format!("/Users/{uid}"), &token, Some(json!({"userName": "alice@corp.example", "name": {"givenName": "Alice", "familyName": "Wong"}, "emails": [{"value": "a.wong@corp.example"}], "active": true}))).await;
    assert_eq!((r.json["name"]["familyName"].as_str(), r.json["emails"][0]["value"].as_str()), (Some("Wong"), Some("a.wong@corp.example")));
    let bob = scim(&app, Method::POST, "/Users", &token, Some(json!({"userName": "bob@corp.example", "active": true}))).await;
    let bob: i64 = bob.json["id"].as_str().unwrap().parse().unwrap();

    // 群組 → 功能權限的使用者群組；管理員手動加的成員留著。/ Groups → user groups; members added by hand stay.
    let r = scim(&app, Method::POST, "/Groups", &token, Some(json!({"displayName": "Ops", "members": [{"value": uid.to_string()}, {"value": admin_id.to_string()}]}))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let gid: i64 = r.json["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(r.json["members"], json!([{"value": uid.to_string(), "display": "alice", "$ref": format!("http://localhost/api/scim/v2/Users/{uid}")}]), "only its own accounts become members");
    let members = || async { telepy_server::db::features::groups_of(&app.state.db, uid).await.unwrap().contains(&gid) };
    assert!(members().await);
    app.patch(&format!("/api/access/groups/{gid}"), Some(&admin), json!({"members": [uid, admin_id]})).await;
    let r = scim(&app, Method::PATCH, &format!("/Groups/{gid}"), &token, Some(json!({"Operations": [
        {"op": "Add", "path": "members", "value": [{"value": bob.to_string()}]},
        {"op": "remove", "path": format!("members[value eq \"{uid}\"]")}
    ]}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(!members().await);
    let all: Vec<i64> = telepy_server::db::scim::members(&app.state.db, gid).await.unwrap().into_iter().map(|(id, _)| id).collect();
    assert_eq!(all, vec![admin_id, bob], "the admin added by hand stays");
    assert_eq!(scim(&app, Method::GET, "/Groups?filter=displayName%20eq%20%22ops%22&excludedAttributes=members", &token, None).await.json["Resources"][0].get("members"), None);
    let r = scim(&app, Method::PATCH, &format!("/Groups/{gid}"), &token, Some(json!({"Operations": [{"op": "replace", "value": {"id": gid.to_string(), "displayName": "Operations"}}]}))).await;
    assert_eq!(r.json["displayName"], "Operations");
    assert_eq!(scim(&app, Method::POST, "/Groups", &token, Some(json!({"displayName": "Operations"}))).await.json["scimType"], "uniqueness");

    // 管理頁看得到它管多少；使用者清單標出來。/ The admin page counts them; the user list marks them.
    let r = app.get("/api/site/oidc", Some(&admin)).await;
    assert_eq!((r.json["providers"][0]["scim"]["users"].as_i64(), r.json["providers"][0]["scim"]["groups"].as_i64()), (Some(2), Some(1)));
    assert!(r.json["providers"][0]["scim"]["last_used_at"].is_string());
    let users = app.get("/api/user/users", Some(&admin)).await;
    let row = users.json["users"].as_array().unwrap().iter().find(|u| u["id"] == uid).unwrap().clone();
    assert_eq!(row["provisioned_by"], "Corp");

    // DELETE：帳號留著但停用，之後 GET 是 404；再建一次就接回來。/ DELETE keeps the account, deactivated; a new POST brings it back.
    assert_eq!(scim(&app, Method::DELETE, &format!("/Users/{uid}"), &token, None).await.status, StatusCode::NO_CONTENT);
    assert!(!telepy_server::db::users::by_id(&app.state.db, uid).await.unwrap().unwrap().is_active);
    assert_eq!(scim(&app, Method::GET, &format!("/Users/{uid}"), &token, None).await.status, StatusCode::NOT_FOUND);
    let r = scim(&app, Method::POST, "/Users", &token, Some(alice)).await;
    assert_eq!((r.status, r.json["id"].as_str()), (StatusCode::CREATED, Some(uid.to_string().as_str())), "{}", r.text);
    assert_eq!(scim(&app, Method::DELETE, &format!("/Groups/{gid}"), &token, None).await.status, StatusCode::NO_CONTENT);
    assert!(telepy_server::db::features::group(&app.state.db, gid).await.unwrap().is_none());

    // 拿掉權杖：馬上不能用。/ Removing the token stops it at once.
    app.delete(&format!("/api/site/oidc/{id}/scim-token"), Some(&admin)).await;
    assert_eq!(scim(&app, Method::GET, "/Users", &token, None).await.status, StatusCode::UNAUTHORIZED);
    let r = app.get("/api/log/ssh/events?scope=all&limit=200", Some(&admin)).await;
    for kind in ["scim_token", "scim_user", "scim_group"] {
        assert!(r.json.as_array().unwrap().iter().any(|e| e["event"] == kind), "{kind}");
    }
}
