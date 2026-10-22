//! 登入紀錄：帳密成功 / 失敗、2FA 兩關記成一筆、來源 IP 從 X-Forwarded-For 右邊數（客戶端塞在左邊的不算）、
//! User-Agent、管理員看別人的紀錄。
//! Sign-in history: outcomes, the 2FA step, client IP read from the right of X-Forwarded-For, the
//! user agent, and the admin view.
mod common;

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};

use common::{Resp, TestApp};
use telepy_server::mfa;

/// socket 對端 = Traefik（compose 裡後端只會被 Traefik 連到）。/ The socket peer is Traefik.
const TRAEFIK: &str = "172.18.0.5:41000";
const CHROME_MAC: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async fn post_via_traefik(app: &TestApp, path: &str, xff: &str, body: Value) -> Resp {
    let mut req = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", xff)
        .header(header::USER_AGENT, CHROME_MAC)
        .body(Body::from(body.to_string()))
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(TRAEFIK.parse::<SocketAddr>().unwrap()));
    app.send(req).await
}

fn totp_now(secret_b32: &str) -> String {
    let secret = mfa::base32_decode(secret_b32).unwrap();
    format!("{:06}", mfa::hotp(&secret, mfa::totp_step(chrono::Utc::now().timestamp() as u64)))
}

async fn uid(app: &TestApp, token: &str) -> i64 {
    app.get("/api/auth/user/profile", Some(token)).await.json["id"].as_i64().unwrap()
}

async fn sign_ins(app: &TestApp, token: &str) -> Vec<Value> {
    let r = app.get("/api/auth/sign-ins", Some(token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json.as_array().unwrap().clone()
}

#[tokio::test]
async fn sign_ins_record_ip_agent_and_outcome() {
    let app = common::spawn().await;
    let admin = app.login("admin", "pw").await; // first user = superuser
    app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    let bob = app.login("bob", "pw").await; // in-process, no proxy info → ip null

    // 密碼錯（客戶端在 XFF 左邊塞了假位址）。/ Wrong password; the client prepends a fake address.
    let r = post_via_traefik(&app, "/api/auth/token", "6.6.6.6, 198.51.100.7", json!({"username": "bob", "password": "nope"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // 不存在的帳號不記。/ Unknown accounts are not recorded.
    post_via_traefik(&app, "/api/auth/token", "198.51.100.7", json!({"username": "nobody", "password": "x"})).await;
    let r = post_via_traefik(&app, "/api/auth/token", "198.51.100.7", json!({"username": "bob", "password": "pw"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    let ev = sign_ins(&app, &bob).await;
    assert_eq!(ev.len(), 3, "{ev:?}");
    // 最新的在前。/ Newest first.
    assert_eq!(ev[0]["ok"], true);
    assert_eq!(ev[0]["method"], "password");
    assert!(ev[0]["second_factor"].is_null());
    assert_eq!(ev[0]["ip"], "198.51.100.7");
    assert_eq!(ev[0]["user_agent"], CHROME_MAC);
    assert!(ev[0]["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(ev[1]["ok"], false);
    assert_eq!(ev[1]["reason"], "bad_password");
    assert_eq!(ev[1]["ip"], "198.51.100.7", "the spoofed leftmost entry is ignored");
    assert!(ev[2]["ip"].is_null());
    assert_eq!(app.get("/api/auth/sign-ins?limit=1", Some(&bob)).await.json.as_array().unwrap().len(), 1);
    assert_eq!(app.get("/api/auth/sign-ins", None).await.status, StatusCode::UNAUTHORIZED);

    // 管理員看得到 bob 的；bob 看不到別人的。/ Admins read anyone's; others get 403.
    let bob_id = uid(&app, &bob).await;
    let r = app.get(&format!("/api/user/users/{bob_id}/sign-ins"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json.as_array().unwrap().len(), 3);
    let admin_id = uid(&app, &admin).await;
    assert_eq!(app.get(&format!("/api/user/users/{admin_id}/sign-ins"), Some(&bob)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get("/api/user/users/9999/sign-ins", Some(&admin)).await.status, StatusCode::NOT_FOUND);

    // 2FA：第一關不記；第二關失敗 / 成功各一筆，帶第一關的方式。/ The 2FA step is one row with both factors.
    let r = app.post("/api/auth/mfa/totp/setup", Some(&bob), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let r = app.post("/api/auth/mfa/totp/enable", Some(&bob), json!({"code": totp_now(&secret)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    // 啟用用掉了這個時間窗；清掉讓登入能再用。/ Let the login reuse this window's code.
    sqlx::query("UPDATE telepy_user_mfa SET totp_last_step = NULL WHERE user_id = ?").bind(bob_id).execute(&app.state.db.write).await.unwrap();

    let ch = post_via_traefik(&app, "/api/auth/token", "203.0.113.20", json!({"username": "bob", "password": "pw"})).await;
    assert_eq!(ch.json["mfa_required"], true, "{}", ch.text);
    assert_eq!(sign_ins(&app, &bob).await.len(), 3, "the first factor alone is not a sign-in");
    let token = ch.json["mfa_token"].as_str().unwrap();
    let r = post_via_traefik(&app, "/api/auth/mfa/verify", "203.0.113.20", json!({"mfa_token": token, "method": "totp", "code": "000000"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = post_via_traefik(&app, "/api/auth/mfa/verify", "203.0.113.20", json!({"mfa_token": token, "method": "totp", "code": totp_now(&secret)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    let ev = sign_ins(&app, &bob).await;
    assert_eq!(ev.len(), 5, "{ev:?}");
    assert_eq!(ev[0]["ok"], true);
    assert_eq!(ev[0]["method"], "password");
    assert_eq!(ev[0]["second_factor"], "totp");
    assert_eq!(ev[0]["ip"], "203.0.113.20");
    assert_eq!(ev[1]["ok"], false);
    assert_eq!(ev[1]["second_factor"], "totp");
    assert_eq!(ev[1]["reason"], "mfa_failed");
}
