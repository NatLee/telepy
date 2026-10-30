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
    assert_eq!(ev[0]["geo"]["scope"], "public", "{}", ev[0]);
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

#[tokio::test]
async fn whoami_returns_the_callers_own_address() {
    let app = common::spawn().await;
    let mut req = Request::builder().method(Method::GET).uri("/api/whoami").header("x-forwarded-for", "6.6.6.6, 114.34.69.11").body(Body::empty()).unwrap();
    req.extensions_mut().insert(ConnectInfo(TRAEFIK.parse::<SocketAddr>().unwrap()));
    let r = app.send(req).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.text.trim(), "114.34.69.11", "read from the right of X-Forwarded-For");
    assert!(r.headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/plain"));
    assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
}

async fn ip_check(app: &TestApp, token: &str, xff: &str, extra: &[(&str, &str)]) -> Resp {
    let mut b = Request::builder().method(Method::GET).uri("/api/auth/client-ip-check").header(header::AUTHORIZATION, format!("Bearer {token}")).header("x-forwarded-for", xff);
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    let mut req = b.body(Body::empty()).unwrap();
    req.extensions_mut().insert(ConnectInfo(TRAEFIK.parse::<SocketAddr>().unwrap()));
    app.send(req).await
}

/// 管理員的「Telepy 怎麼看你的位址」：攤開鏈、相關標頭與判定；一般使用者 403。
/// The admin's address check spells out the chain, related headers and the verdict; others get 403.
#[tokio::test]
async fn client_ip_check_explains_the_chain() {
    let app = common::spawn().await;
    let admin = app.login("admin", "pw").await;
    app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    let bob = app.login("bob", "pw").await;

    let r = ip_check(&app, &bob, "198.51.100.7", &[]).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")));

    // 預設 TRUSTED_PROXY_HOPS = auto：只有 Traefik 時跳過它；左邊訪客自己塞的內部位址不算。
    // Default auto: Traefik alone is skipped; an internal entry the visitor put on the left is ignored.
    let r = ip_check(&app, &admin, "10.9.9.9, 198.51.100.7", &[]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["ip"].as_str(), r.json["verdict"].as_str(), r.json["from"].as_str()), (Some("198.51.100.7"), Some("ok"), Some("chain")));
    assert_eq!((r.json["hops_mode"].as_str(), r.json["trusted_proxy_hops"].is_null(), r.json["skipped_hops"].as_i64()), (Some("auto"), true, Some(1)), "{}", r.text);
    let roles: Vec<&str> = r.json["chain"].as_array().unwrap().iter().map(|h| h["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["ignored", "client", "proxy"]);
    assert_eq!(r.json["chain"][2]["source"], "peer");

    // 前面再一層內網的 Nginx Proxy Manager：自動模式一樣跳過，不用設層數。/ An upstream internal proxy is skipped too.
    let r = ip_check(&app, &admin, "198.51.100.7, 10.0.0.2", &[]).await;
    assert_eq!((r.json["ip"].as_str(), r.json["verdict"].as_str(), r.json["skipped_hops"].as_i64()), (Some("198.51.100.7"), Some("ok"), Some(2)), "{}", r.text);

    // 上游代理把每個人都換成 Docker 的位址：每一段都是內部位址。/ The upstream proxy hands everyone a Docker address.
    let r = ip_check(&app, &admin, "172.19.0.1", &[("x-real-ip", "172.19.0.1")]).await;
    assert_eq!((r.json["verdict"].as_str(), r.json["scope"].as_str()), (Some("all_private"), Some("private")), "{}", r.text);
    assert_eq!(r.json["headers"][0]["name"], "x-real-ip");
    assert_eq!(r.json["headers"][0]["addresses"][0]["scope"], "private");

    // 前面是一台公網 IP 的代理（VPS）：自動模式會把它當成訪客，建議改成固定 2 層。
    // A proxy with a public address (a VPS) is taken for the visitor in auto mode: suggest a fixed 2.
    let r = ip_check(&app, &admin, "198.51.100.7, 203.0.113.9", &[]).await;
    assert_eq!((r.json["ip"].as_str(), r.json["verdict"].as_str(), r.json["suggest"]["trusted_proxy_hops"].as_i64()), (Some("203.0.113.9"), Some("hops_too_low"), Some(2)), "{}", r.text);

    // 固定層數 1（只有 Traefik）：多一層代理沒算到就建議 2。/ Fixed 1: an uncounted proxy suggests 2.
    let app = common::spawn_with(|c| c.trusted_proxy_hops = telepy_server::client_ip::Hops::Fixed(1)).await;
    let admin = app.login("admin", "pw").await;
    let r = ip_check(&app, &admin, "198.51.100.7, 10.0.0.2", &[]).await;
    assert_eq!((r.json["hops_mode"].as_str(), r.json["trusted_proxy_hops"].as_i64()), (Some("fixed"), Some(1)), "{}", r.text);
    assert_eq!((r.json["verdict"].as_str(), r.json["suggest"]["trusted_proxy_hops"].as_i64()), (Some("hops_too_low"), Some(2)), "{}", r.text);
}

/// 管理區的「伺服器狀態」= doctor 的檢查，從網頁跑；一般使用者 403。
/// The admin "Server health" page runs the doctor checks from the web; others get 403.
#[tokio::test]
async fn server_health_runs_the_doctor_checks_for_admins() {
    let app = common::spawn().await;
    let admin = app.login("admin", "pw").await;
    app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    let bob = app.login("bob", "pw").await;

    let r = app.get("/api/site/health", Some(&bob)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")));

    // 一次經 Traefik 的登入，讓「client addresses」有公網位址可看。/ One sign-in through Traefik gives it a public address.
    let r = post_via_traefik(&app, "/api/auth/token", "198.51.100.7", json!({"username": "admin", "password": "pw"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.get("/api/site/health", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
    let checks = r.json["checks"].as_array().unwrap();
    let find = |name: &str| checks.iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("no check {name}: {}", r.text));
    assert_eq!(find("database")["status"], "ok", "{}", r.text);
    assert!(find("database")["detail"].as_str().unwrap().contains("users"), "{}", r.text);
    assert_eq!(find("audit log")["status"], "ok", "{}", r.text);
    // 剛才兩次登入都經 Traefik 記成公網位址。/ Both sign-ins above were recorded with public addresses.
    assert_eq!(find("client addresses")["status"], "ok", "{}", r.text);
    assert!(find("client addresses")["detail"].as_str().unwrap().contains("TRUSTED_PROXY_HOPS=auto"), "{}", r.text);
    let total = r.json["ok"].as_u64().unwrap() + r.json["info"].as_u64().unwrap() + r.json["warnings"].as_u64().unwrap() + r.json["failures"].as_u64().unwrap();
    assert_eq!(total as usize, checks.len());
    assert!(r.json["ran_at"].as_str().unwrap().ends_with('Z'));
}
