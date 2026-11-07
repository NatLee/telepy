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
