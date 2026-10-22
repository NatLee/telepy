//! 兩步驟驗證端到端：TOTP（啟用、登入第二步、防重放、復原碼、鎖定、停用）、passkey（用官方 soft authenticator 模擬瀏覽器：
//! 註冊、登入第二步、免帳號登入、再驗證、改名、刪除）、管理員重設、OAuth 同意頁的再驗證。
//! Two-factor end to end: TOTP, passkeys (software authenticator), admin reset and the OAuth consent step-up.
mod common;

use axum::http::StatusCode;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_rs::prelude::{CreationChallengeResponse, RequestChallengeResponse, Url};

use common::TestApp;
use telepy_server::{db, mfa};

const ORIGIN: &str = "https://telepy.test";

async fn app_with_public_url() -> TestApp {
    let mut app = common::spawn().await;
    let mut config = app.state.config.clone();
    config.public_url = Some(ORIGIN.into());
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    app
}

async fn user_id(app: &TestApp, token: &str) -> i64 {
    app.get("/api/auth/user/profile", Some(token)).await.json["id"].as_i64().unwrap()
}

fn code_at(secret_b32: &str, unix: i64) -> String {
    let secret = mfa::base32_decode(secret_b32).unwrap();
    format!("{:06}", mfa::hotp(&secret, mfa::totp_step(unix as u64)))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 清掉「最後用過的時間窗」，讓測試在同一個 30 秒內再用 TOTP。/ Allow another TOTP use within the same window.
async fn forget_totp_step(app: &TestApp, uid: i64) {
    sqlx::query("UPDATE telepy_user_mfa SET totp_last_step = NULL WHERE user_id = ?").bind(uid).execute(&app.state.db.write).await.unwrap();
}

async fn password_login(app: &TestApp, username: &str) -> Value {
    let r = app.post("/api/auth/token", None, json!({"username": username, "password": "pw"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json
}

// ---------------------------------------------------------------- passkey helpers

struct Browser(WebauthnAuthenticator<SoftPasskey>);

impl Browser {
    fn new() -> Self {
        Self(WebauthnAuthenticator::new(SoftPasskey::new(true)))
    }
    fn create(&mut self, options: &Value) -> Value {
        let ccr: CreationChallengeResponse = serde_json::from_value(json!({ "publicKey": options["publicKey"] })).unwrap();
        serde_json::to_value(self.0.do_registration(Url::parse(ORIGIN).unwrap(), ccr).unwrap()).unwrap()
    }
    fn get(&mut self, options: &Value) -> Value {
        let rcr: RequestChallengeResponse = serde_json::from_value(json!({ "publicKey": options["publicKey"] })).unwrap();
        serde_json::to_value(self.0.do_authentication(Url::parse(ORIGIN).unwrap(), rcr).unwrap()).unwrap()
    }
}

async fn reauth_with_passkey(app: &TestApp, token: &str, browser: &mut Browser) -> Value {
    let opts = app.post("/api/auth/mfa/reauth/options", Some(token), json!({})).await;
    assert_eq!(opts.status, StatusCode::OK, "{}", opts.text);
    json!({"method": "passkey", "challenge_id": opts.json["challenge_id"], "credential": browser.get(&opts.json)})
}

async fn register_passkey(app: &TestApp, token: &str, browser: &mut Browser, name: &str, reauth: Option<Value>) -> Value {
    let opts = app.post("/api/auth/passkeys/register/options", Some(token), json!({ "reauth": reauth })).await;
    assert_eq!(opts.status, StatusCode::OK, "{}", opts.text);
    assert_eq!(opts.json["publicKey"]["rp"]["id"], "telepy.test");
    let credential = browser.create(&opts.json);
    let r = app.post("/api/auth/passkeys/register", Some(token), json!({"challenge_id": opts.json["challenge_id"], "name": name, "credential": credential})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    r.json
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn totp_login_recovery_codes_and_lockout() {
    let app = app_with_public_url().await;
    let web = app.login("admin", "pw").await;
    let uid = user_id(&app, &web).await;
    // 沒有 2FA：登入照舊直接拿 token。/ Without 2FA the login is unchanged.
    assert!(password_login(&app, "admin").await["access_token"].is_string());
    let st = app.get("/api/auth/mfa", Some(&web)).await;
    assert_eq!(st.json["mfa_enabled"], false);
    assert_eq!(st.json["methods"], json!([]));

    // 設定：secret + otpauth URI + QR（SVG）；DB 裡是加密的。/ Setup; the secret is encrypted at rest.
    let r = app.post("/api/auth/mfa/totp/setup", Some(&web), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let secret = r.json["secret"].as_str().unwrap().to_string();
    assert!(r.json["otpauth_uri"].as_str().unwrap().starts_with("otpauth://totp/Telepy%3Aadmin%40telepy.test?secret="));
    assert!(r.json["qr_svg"].as_str().unwrap().contains("<svg"));
    let stored = db::mfa::get(&app.state.db, uid).await.unwrap().unwrap().totp_pending_secret.unwrap();
    assert!(stored.starts_with("v1:") && !stored.contains(&secret));
    // 還沒啟用前，登入不受影響。/ Pending setup does not change the login.
    assert!(password_login(&app, "admin").await["access_token"].is_string());

    let r = app.post("/api/auth/mfa/totp/enable", Some(&web), json!({"code": "000000"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["code"], "mfa_invalid");
    let t0 = now();
    let r = app.post("/api/auth/mfa/totp/enable", Some(&web), json!({"code": code_at(&secret, t0)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let codes: Vec<String> = serde_json::from_value(r.json["recovery_codes"].clone()).unwrap();
    assert_eq!(codes.len(), 10);
    assert_eq!(app.get("/api/auth/user/profile", Some(&web)).await.json["mfa_enabled"], true);
    assert_eq!(app.get("/api/user/users", Some(&web)).await.json["users"][0]["mfa_enabled"], true);
    assert_eq!(app.post("/api/auth/mfa/totp/setup", Some(&web), json!({})).await.status, StatusCode::BAD_REQUEST, "already enabled");

    // 登入第二步。/ The login second step.
    let ch = password_login(&app, "admin").await;
    assert_eq!(ch["mfa_required"], true);
    assert!(ch.get("access_token").is_none());
    assert_eq!(ch["methods"], json!(["totp", "recovery_code"]));
    let token = ch["mfa_token"].as_str().unwrap();
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "totp", "code": code_at(&secret, t0)})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "the code used to enable cannot be replayed: {}", r.text);
    assert_eq!(r.json["code"], "mfa_invalid");
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "totp", "code": code_at(&secret, t0 + 30)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["access_token"].is_string() && r.json["refresh_token"].is_string());
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "totp", "code": code_at(&secret, now())})).await;
    assert_eq!(r.json["code"], "mfa_expired", "a challenge is single use");

    // 復原碼：可用一次，格式寬鬆。/ Recovery codes: single use, forgiving format.
    let token = password_login(&app, "admin").await["mfa_token"].as_str().unwrap().to_string();
    let sloppy = codes[0].to_uppercase().replace('-', " ");
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "recovery_code", "code": sloppy})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let token = password_login(&app, "admin").await["mfa_token"].as_str().unwrap().to_string();
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "recovery_code", "code": codes[0]})).await;
    assert_eq!(r.json["code"], "mfa_invalid");
    assert_eq!(app.get("/api/auth/mfa", Some(&web)).await.json["recovery_codes_remaining"], 9);

    // 每個挑戰最多 5 次；每人 15 分鐘內最多 10 次失敗（成功會歸零；上一次成功後已失敗 1 次）。
    // 5 tries per challenge; 10 failures per user, reset by a success (1 so far since the last success).
    for _ in 0..4 {
        app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "totp", "code": "000000"})).await;
    }
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "totp", "code": "000000"})).await;
    assert_eq!(r.json["code"], "mfa_expired", "{}", r.text);
    let token = password_login(&app, "admin").await["mfa_token"].as_str().unwrap().to_string();
    let mut last = Value::Null;
    for _ in 0..5 {
        last = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "totp", "code": "000000"})).await.json;
    }
    assert_eq!(last["code"], "mfa_invalid", "the 10th failure is still an ordinary failure");
    let token = password_login(&app, "admin").await["mfa_token"].as_str().unwrap().to_string();
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": token, "method": "recovery_code", "code": codes[1]})).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "locked even with a valid code: {}", r.text);
    assert_eq!(r.json["code"], "mfa_locked");
    app.state.mfa.clear_failures(uid);

    // 敏感操作要再驗證。/ Sensitive actions need re-authentication.
    let r = app.post("/api/auth/mfa/recovery-codes", Some(&web), json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json["code"], "reauth_required");
    assert_eq!(r.json["methods"], json!(["totp", "recovery_code"]));
    forget_totp_step(&app, uid).await;
    let r = app.post("/api/auth/mfa/recovery-codes", Some(&web), json!({"reauth": {"method": "totp", "code": code_at(&secret, now())}})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let codes: Vec<String> = serde_json::from_value(r.json["recovery_codes"].clone()).unwrap();
    assert_eq!(app.get("/api/auth/mfa", Some(&web)).await.json["recovery_codes_remaining"], 10);

    // 停用（再驗證）→ 復原碼一起清掉、登入恢復一步。/ Disable → recovery codes cleared, single-step login again.
    assert_eq!(app.delete("/api/auth/mfa/totp", Some(&web)).await.status, StatusCode::FORBIDDEN);
    let r = app.request(axum::http::Method::DELETE, "/api/auth/mfa/totp", Some(&web), Some(json!({"reauth": {"method": "recovery_code", "code": codes[0]}}))).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    let st = app.get("/api/auth/mfa", Some(&web)).await.json;
    assert_eq!((st["mfa_enabled"].as_bool(), st["recovery_codes_remaining"].as_i64()), (Some(false), Some(0)));
    assert!(password_login(&app, "admin").await["access_token"].is_string());
}

#[tokio::test]
async fn passkeys_register_second_factor_usernameless_and_reauth() {
    let app = app_with_public_url().await;
    let web = app.login("admin", "pw").await;
    let uid = user_id(&app, &web).await;
    let mut laptop = Browser::new();

    // 第一個因素：免再驗證，並拿到復原碼。/ First factor: no re-auth, recovery codes issued.
    let r = register_passkey(&app, &web, &mut laptop, "Laptop", None).await;
    assert_eq!(r["passkey"]["name"], "Laptop");
    assert_eq!(r["recovery_codes"].as_array().unwrap().len(), 10);
    let st = app.get("/api/auth/mfa", Some(&web)).await.json;
    assert_eq!(st["methods"], json!(["passkey", "recovery_code"]));
    assert_eq!(st["passkeys"].as_array().unwrap().len(), 1);

    // 第二把：要再驗證（用第一把）。/ The second one needs re-authentication with the first.
    let r = app.post("/api/auth/passkeys/register/options", Some(&web), json!({})).await;
    assert_eq!(r.json["code"], "reauth_required");
    let mut phone = Browser::new();
    let proof = reauth_with_passkey(&app, &web, &mut laptop).await;
    let r = register_passkey(&app, &web, &mut phone, "Phone", Some(proof)).await;
    assert!(r["recovery_codes"].is_null(), "not the first factor");
    // 用過的再驗證證明不能重用。/ A re-auth proof is single use.
    let opts = app.post("/api/auth/mfa/reauth/options", Some(&web), json!({})).await.json;
    let cred = laptop.get(&opts);
    let proof = json!({"method": "passkey", "challenge_id": opts["challenge_id"], "credential": cred});
    assert_eq!(app.post("/api/auth/mfa/recovery-codes", Some(&web), json!({"reauth": proof})).await.status, StatusCode::OK);
    let r = app.post("/api/auth/mfa/recovery-codes", Some(&web), json!({"reauth": proof})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "a failed re-auth must not be a 401 (the web client logs out on 401)");
    assert_eq!(r.json["code"], "mfa_invalid");

    // 帳密 + passkey 第二步。/ Password, then a passkey as the second step.
    let ch = password_login(&app, "admin").await;
    assert_eq!(ch["methods"], json!(["passkey", "recovery_code"]));
    let opts = app.post("/api/auth/mfa/passkey/options", None, json!({"mfa_token": ch["mfa_token"]})).await;
    assert_eq!(opts.status, StatusCode::OK, "{}", opts.text);
    assert_eq!(opts.json["publicKey"]["allowCredentials"].as_array().unwrap().len(), 2);
    let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": ch["mfa_token"], "method": "passkey", "challenge_id": opts.json["challenge_id"], "credential": phone.get(&opts.json)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["access_token"].is_string());
    let used = app.get("/api/auth/mfa", Some(&web)).await.json;
    assert!(used["passkeys"][1]["last_used_at"].is_string(), "{used}");

    // 免帳號登入（discoverable）。soft authenticator 不存 resident key，所以這裡補上 allowCredentials 與 userHandle
    // （userHandle 不在簽章範圍內）。/ Usernameless sign-in; emulate a resident key for the software authenticator.
    let opts = app.post("/api/auth/passkey/options", None, json!({})).await;
    assert_eq!(opts.status, StatusCode::OK, "{}", opts.text);
    assert_eq!(opts.json["mediation"], "conditional");
    assert_eq!(opts.json["publicKey"]["allowCredentials"], json!([]));
    let handle = db::mfa::get(&app.state.db, uid).await.unwrap().unwrap().webauthn_user_id;
    let cred_id = db::mfa::passkeys_for_user(&app.state.db, uid).await.unwrap()[0].credential_id.clone();
    let mut with_allow = opts.json.clone();
    with_allow["publicKey"]["allowCredentials"] = json!([{"type": "public-key", "id": cred_id}]);
    let mut cred = laptop.get(&with_allow);
    let r = app.post("/api/auth/passkey/login", None, json!({"challenge_id": opts.json["challenge_id"], "credential": cred.clone()})).await;
    assert_eq!(r.json["code"], "passkey_failed", "no user handle → cannot identify the user");
    let opts = app.post("/api/auth/passkey/options", None, json!({})).await.json;
    let mut with_allow = opts.clone();
    with_allow["publicKey"]["allowCredentials"] = json!([{"type": "public-key", "id": cred_id}]);
    cred = laptop.get(&with_allow);
    cred["response"]["userHandle"] = json!(URL_SAFE_NO_PAD.encode(uuid::Uuid::parse_str(&handle).unwrap().as_bytes()));
    let r = app.post("/api/auth/passkey/login", None, json!({"challenge_id": opts["challenge_id"], "credential": cred.clone()})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/auth/user/profile", Some(r.json["access_token"].as_str().unwrap())).await.json["username"], "admin");
    let r = app.post("/api/auth/passkey/login", None, json!({"challenge_id": opts["challenge_id"], "credential": cred})).await;
    assert_eq!(r.json["code"], "passkey_failed", "a challenge is single use");

    // 別的網站（origin 不同）做出的斷言不被接受。/ An assertion made for another origin is rejected.
    let ch = password_login(&app, "admin").await;
    let opts = app.post("/api/auth/mfa/passkey/options", None, json!({"mfa_token": ch["mfa_token"]})).await.json;
    let rcr: RequestChallengeResponse = serde_json::from_value(json!({ "publicKey": opts["publicKey"] })).unwrap();
    let phishing = laptop.0.do_authentication(Url::parse("https://telepy.test.evil.example").unwrap(), rcr);
    if let Ok(c) = phishing {
        let r = app.post("/api/auth/mfa/verify", None, json!({"mfa_token": ch["mfa_token"], "method": "passkey", "challenge_id": opts["challenge_id"], "credential": serde_json::to_value(c).unwrap()})).await;
        assert_eq!(r.json["code"], "mfa_invalid");
    }
    app.state.mfa.clear_failures(uid);

    // 改名、刪除（要再驗證）；刪光 → 2FA 關閉、復原碼清掉。/ Rename, delete; deleting the last one turns 2FA off.
    let ids: Vec<i64> = app.get("/api/auth/mfa", Some(&web)).await.json["passkeys"].as_array().unwrap().iter().map(|p| p["id"].as_i64().unwrap()).collect();
    let r = app.patch(&format!("/api/auth/passkeys/{}", ids[1]), Some(&web), json!({"name": "  Pixel  "})).await;
    assert_eq!(r.json["name"], "Pixel");
    assert_eq!(app.patch(&format!("/api/auth/passkeys/{}", ids[1]), Some(&web), json!({"name": ""})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.delete(&format!("/api/auth/passkeys/{}", ids[0]), Some(&web)).await.status, StatusCode::FORBIDDEN);
    let proof = reauth_with_passkey(&app, &web, &mut phone).await;
    let r = app.request(axum::http::Method::DELETE, &format!("/api/auth/passkeys/{}", ids[0]), Some(&web), Some(json!({"reauth": proof}))).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    let proof = reauth_with_passkey(&app, &web, &mut phone).await;
    app.request(axum::http::Method::DELETE, &format!("/api/auth/passkeys/{}", ids[1]), Some(&web), Some(json!({"reauth": proof}))).await;
    let st = app.get("/api/auth/mfa", Some(&web)).await.json;
    assert_eq!((st["mfa_enabled"].as_bool(), st["recovery_codes_remaining"].as_i64()), (Some(false), Some(0)));

    // 其他人的 passkey 動不到。/ Other users' passkeys are out of reach.
    app.post("/api/site/settings", Some(&web), json!({"allow_registration": true})).await;
    let bob = app.login("bob", "pw").await;
    let mut bob_key = Browser::new();
    register_passkey(&app, &bob, &mut bob_key, "Bob key", None).await;
    let bob_pk = app.get("/api/auth/mfa", Some(&bob)).await.json["passkeys"][0]["id"].as_i64().unwrap();
    assert_eq!(app.patch(&format!("/api/auth/passkeys/{bob_pk}"), Some(&web), json!({"name": "x"})).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_reset_and_oauth_consent_step_up() {
    let app = app_with_public_url().await;
    let admin = app.login("admin", "pw").await;
    app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    let bob = app.login("bob", "pw").await;
    let bob_id = user_id(&app, &bob).await;
    let secret = app.post("/api/auth/mfa/totp/setup", Some(&bob), json!({})).await.json["secret"].as_str().unwrap().to_string();
    let codes = app.post("/api/auth/mfa/totp/enable", Some(&bob), json!({"code": code_at(&secret, now())})).await.json["recovery_codes"].clone();
    let codes: Vec<String> = serde_json::from_value(codes).unwrap();

    // OAuth 同意頁：bob 有 2FA → 核可要再驗證。/ Consent step-up for an account with 2FA.
    let r = app.post("/api/oauth/register", None, json!({"redirect_uris": ["http://localhost:9/cb"], "token_endpoint_auth_method": "none"})).await;
    let client_id = r.json["client_id"].as_str().unwrap().to_string();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(b"verifier-verifier-verifier-verifier-verifier-0123"));
    let q = format!("response_type=code&client_id={client_id}&redirect_uri=http%3A%2F%2Flocalhost%3A9%2Fcb&code_challenge={challenge}&code_challenge_method=S256");
    let info = app.get(&format!("/api/oauth/authorize?{q}"), Some(&bob)).await;
    assert_eq!(info.json["reauth"], json!({"required": true, "methods": ["totp", "recovery_code"]}));
    let mut body = json!({"response_type": "code", "client_id": client_id, "redirect_uri": "http://localhost:9/cb", "code_challenge": challenge, "code_challenge_method": "S256", "approve": true});
    let r = app.post("/api/oauth/authorize", Some(&bob), body.clone()).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.json["code"], "reauth_required");
    body["reauth"] = json!({"method": "recovery_code", "code": codes[0]});
    let r = app.post("/api/oauth/authorize", Some(&bob), body.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["redirect_to"].as_str().unwrap().contains("code="));
    // 拒絕不需要再驗證。/ Denying needs no step-up.
    body["approve"] = json!(false);
    body.as_object_mut().unwrap().remove("reauth");
    assert_eq!(app.post("/api/oauth/authorize", Some(&bob), body).await.status, StatusCode::OK);
    // 沒有 2FA 的帳號照舊。/ Accounts without 2FA are unchanged.
    assert_eq!(app.get(&format!("/api/oauth/authorize?{q}"), Some(&admin)).await.json["reauth"]["required"], false);

    // 管理員重設：只有管理員能做，做完 bob 回到單步登入。/ Admin reset.
    assert_eq!(app.delete(&format!("/api/user/users/{bob_id}/mfa"), Some(&bob)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.delete("/api/user/users/999/mfa", Some(&admin)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&format!("/api/user/users/{bob_id}/mfa"), Some(&admin)).await.status, StatusCode::NO_CONTENT);
    assert!(password_login(&app, "bob").await["access_token"].is_string());
    assert_eq!(app.get("/api/auth/mfa", Some(&bob)).await.json["recovery_codes_remaining"], 0);

    // passkey 需要網域名稱：IP 位址部署回清楚的錯誤。/ Passkeys need a domain name.
    let mut app = app;
    let mut config = app.state.config.clone();
    config.public_url = Some("http://192.168.1.10:8787".into());
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    let r = app.post("/api/auth/passkey/options", None, json!({})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["code"], "passkey_unavailable");
}
