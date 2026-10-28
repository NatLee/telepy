//! 網頁登入 session：refresh token 換發（滑動效期）、寬限內的重複使用、寬限外的重複使用撤銷整個登入、登出撤銷、
//! 停用的帳號不能續期、升級前的 token 補開 session、效期由網站設定決定。
//! Web sign-in sessions: refresh-token rotation (sliding expiry), reuse within / outside the grace, logout,
//! inactive accounts, pre-upgrade tokens and the lifetimes from the site settings.
mod common;

use axum::http::StatusCode;
use serde_json::json;
use telepy_server::auth::jwt::Claims;
use telepy_server::auth::TokenType;

/// 不驗簽、只讀 payload（測試只關心 claims）。/ Read the payload without verifying (the test only needs the claims).
fn claims(token: &str) -> Claims {
    use base64::Engine;
    let payload = token.split('.').nth(1).unwrap();
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn login(app: &common::TestApp, username: &str) -> (String, String) {
    let r = app.post("/api/auth/register", None, json!({"username": username, "password": "pw"})).await;
    assert!(r.status == StatusCode::CREATED || r.status == StatusCode::BAD_REQUEST, "{}", r.text);
    let r = app.post("/api/auth/token", None, json!({"username": username, "password": "pw"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    (r.json["access_token"].as_str().unwrap().to_string(), r.json["refresh_token"].as_str().unwrap().to_string())
}

async fn refresh(app: &common::TestApp, token: &str) -> common::Resp {
    app.post("/api/auth/token/refresh", None, json!({"refresh": token})).await
}

/// 把 session 的換發時間往前撥，讓寬限過掉。/ Move the session's rotation back in time so the grace is over.
async fn age_rotation(app: &common::TestApp, sid: i64, seconds: i64) {
    let at = telepy_server::util::db_time(chrono::Utc::now() - chrono::Duration::seconds(seconds));
    sqlx::query("UPDATE telepy_web_session SET rotated_at = ? WHERE id = ?").bind(at).bind(sid).execute(&app.state.db.write).await.unwrap();
}

#[tokio::test]
async fn refresh_rotates_and_a_replaced_token_only_works_within_the_grace() {
    let app = common::spawn().await;
    let (_access, refresh0) = login(&app, "admin").await;
    let c0 = claims(&refresh0);
    let sid = c0.sid.expect("a refresh token carries its session id");
    assert_eq!(c0.token_type, "refresh");

    // 續期：新的 access + 新的 refresh（同 session、不同 jti）。/ Renewal: a new pair, same session, new jti.
    let r = refresh(&app, &refresh0).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let refresh1 = r.json["refresh_token"].as_str().unwrap().to_string();
    let access1 = r.json["access_token"].as_str().unwrap().to_string();
    let c1 = claims(&refresh1);
    assert_eq!(c1.sid, Some(sid));
    assert_ne!(c1.jti, c0.jti);
    assert_eq!(app.get("/api/auth/user/profile", Some(&access1)).await.status, StatusCode::OK);

    // 寬限內再拿舊的來（同時續期的另一個分頁）：拿到一模一樣的新 refresh token，不撤銷。
    // The old one again within the grace (a concurrent tab): the very same new refresh token, nothing revoked.
    let r = refresh(&app, &refresh0).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["refresh_token"].as_str().unwrap(), refresh1, "the grace hands out the current token again");
    assert!(r.json["access_token"].is_string());
    let r = refresh(&app, &refresh1).await;
    assert_eq!(r.status, StatusCode::OK, "the current token still works after a grace reissue: {}", r.text);
    let refresh2 = r.json["refresh_token"].as_str().unwrap().to_string();

    // 寬限過了還拿舊的來：有人拿到了舊 token → 整個登入撤銷，目前的那顆也死了。
    // The replaced token after the grace: someone else holds it, so the whole sign-in is revoked, current token included.
    age_rotation(&app, sid, 120).await;
    let r = refresh(&app, &refresh1).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.text);
    assert_eq!(r.json["code"], "token_not_valid");
    let r = refresh(&app, &refresh2).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "reuse revokes the session for everyone: {}", r.text);
    let reason: Option<String> = sqlx::query_scalar("SELECT revoked_reason FROM telepy_web_session WHERE id = ?").bind(sid).fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(reason.as_deref(), Some("reuse"));
    // access token 帶著 session id，撤銷後到期前也不能用了。/ Access tokens carry the session id, so they stop too.
    assert_eq!(app.get("/api/auth/user/profile", Some(&access1)).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logout_revokes_the_session_and_inactive_accounts_cannot_renew() {
    let app = common::spawn().await;
    let (admin_access, admin_refresh) = login(&app, "admin").await;
    let r = app.post("/api/site/settings", Some(&admin_access), json!({"allow_registration": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let (_, user_refresh) = login(&app, "bob").await;

    // 登出：之後不能再續期；再登出一次或拿垃圾來都是 200（沒東西可撤）。
    // Logout: no renewal afterwards; a second logout or garbage is still a 200 (nothing to revoke).
    let r = app.post("/api/auth/logout", None, json!({"refresh": admin_refresh})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["revoked"], true);
    let r = refresh(&app, &admin_refresh).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = app.post("/api/auth/logout", None, json!({"refresh": admin_refresh})).await;
    assert_eq!((r.status, r.json["revoked"].as_bool()), (StatusCode::OK, Some(false)));
    let r = app.post("/api/auth/logout", None, json!({"refresh": "x.y.z"})).await;
    assert_eq!((r.status, r.json["revoked"].as_bool()), (StatusCode::OK, Some(false)));
    let r = app.post("/api/auth/logout", None, json!({})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!({"refresh": ["This field is required."]}));

    // 管理員停用帳號 → 它的 refresh token 立刻沒用。/ An admin disables the account: its refresh token is dead at once.
    let r = refresh(&app, &user_refresh).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let user_refresh = r.json["refresh_token"].as_str().unwrap().to_string();
    let admin_access = app.login("admin", "pw").await;
    let bob_id: i64 = sqlx::query_scalar("SELECT id FROM auth_user WHERE username = 'bob'").fetch_one(&app.state.db.read).await.unwrap();
    let r = app.post(&format!("/api/user/users/{bob_id}"), Some(&admin_access), json!({"is_active": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = refresh(&app, &user_refresh).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.text);
}

#[tokio::test]
async fn pre_upgrade_refresh_tokens_get_a_session_on_their_first_renewal() {
    let app = common::spawn().await;
    let (_, _) = login(&app, "admin").await;
    let admin_id: i64 = sqlx::query_scalar("SELECT id FROM auth_user WHERE username = 'admin'").fetch_one(&app.state.db.read).await.unwrap();
    let now = chrono::Utc::now().timestamp();
    let legacy = app.state.jwt.encode_claims(&Claims { token_type: "refresh".into(), exp: now + 600, iat: now, jti: "legacy".into(), user_id: admin_id, sid: None });
    assert_eq!(app.state.jwt.verify(&legacy, TokenType::Refresh).unwrap().sid, None);

    let r = refresh(&app, &legacy).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let rotated = r.json["refresh_token"].as_str().unwrap().to_string();
    let c = claims(&rotated);
    assert!(c.sid.is_some(), "the renewal started a session for it");
    assert_eq!(app.get("/api/auth/user/profile", Some(r.json["access_token"].as_str().unwrap())).await.status, StatusCode::OK);
    // 之後就是一次性的了。/ From then on it is single use.
    let r = refresh(&app, &rotated).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    age_rotation(&app, c.sid.unwrap(), 120).await;
    assert_eq!(refresh(&app, &rotated).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn lifetimes_come_from_the_site_settings() {
    let app = common::spawn().await;
    let (admin_access, admin_refresh) = login(&app, "admin").await;
    // 預設：access 1 小時、登入 30 天。/ Defaults: access 1 hour, sign-in 30 days.
    let a = claims(&admin_access);
    let r = claims(&admin_refresh);
    assert_eq!(a.exp - a.iat, 3600);
    assert_eq!(r.exp - r.iat, 30 * 86_400);
    let s = app.get("/api/site/settings", Some(&admin_access)).await;
    assert_eq!(s.json["values"]["signin_lifetime"], 2_592_000);
    assert_eq!(s.json["values"]["signin_access_lifetime"], 3600);
    assert_eq!(s.json["meta"]["signin_lifetime"]["type"], "integer");

    // 值域。/ Ranges.
    for (field, value, msg) in [
        ("signin_lifetime", 299, "between 300 seconds"),
        ("signin_lifetime", 31_536_001, "between 300 seconds"),
        ("signin_access_lifetime", 59, "between 60 seconds"),
        ("signin_access_lifetime", 86_401, "between 60 seconds"),
    ] {
        let r = app.post("/api/site/settings", Some(&admin_access), json!({field: value})).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{field}={value}: {}", r.text);
        assert!(r.json[field][0].as_str().unwrap().contains(msg), "{}", r.text);
    }

    // 改了之後：新登入 / 續期用新效期（續期的 refresh token 從現在起算 = 滑動）。
    // After a change: new sign-ins and renewals use the new lifetimes (the renewed token counts from now = sliding).
    let r = app.post("/api/site/settings", Some(&admin_access), json!({"signin_lifetime": 7200, "signin_access_lifetime": 300})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = refresh(&app, &admin_refresh).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let a = claims(r.json["access_token"].as_str().unwrap());
    let rr = claims(r.json["refresh_token"].as_str().unwrap());
    assert_eq!(a.exp - a.iat, 300);
    assert_eq!(rr.exp - rr.iat, 7200);
    let expires_at: String = sqlx::query_scalar("SELECT expires_at FROM telepy_web_session WHERE id = ?").bind(rr.sid.unwrap()).fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(telepy_server::util::parse_db_datetime(&expires_at).unwrap().and_utc().timestamp(), rr.exp, "the row's expiry is the token's");
    let (access2, refresh2) = login(&app, "admin").await;
    let a = claims(&access2);
    let rr = claims(&refresh2);
    assert_eq!(a.exp - a.iat, 300);
    assert_eq!(rr.exp - rr.iat, 7200);

    // 到期的 session 列（例如管理員縮短效期前發的）不能續期。/ A row that expired cannot renew.
    let past = telepy_server::util::db_time(chrono::Utc::now() - chrono::Duration::seconds(1));
    sqlx::query("UPDATE telepy_web_session SET expires_at = ? WHERE id = ?").bind(past).bind(rr.sid.unwrap()).execute(&app.state.db.write).await.unwrap();
    assert_eq!(refresh(&app, &refresh2).await.status, StatusCode::UNAUTHORIZED);

    // 到期超過一天的列由保留機制清掉。/ Rows expired for over a day are purged by retention.
    let old = telepy_server::util::db_time(chrono::Utc::now() - chrono::Duration::days(2));
    sqlx::query("UPDATE telepy_web_session SET expires_at = ? WHERE id = ?").bind(old).bind(rr.sid.unwrap()).execute(&app.state.db.write).await.unwrap();
    telepy_server::db::retention::purge(&app.state.db).await.unwrap();
    let left: Option<i64> = sqlx::query_scalar("SELECT id FROM telepy_web_session WHERE id = ?").bind(rr.sid.unwrap()).fetch_optional(&app.state.db.read).await.unwrap();
    assert_eq!(left, None);
}

// ---------------------------------------------------------------- "Your devices": list and sign out

const MAC_CHROME: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const WIN_FIREFOX: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

/// 用指定的瀏覽器（User-Agent）登入；回 (access, refresh, sid)。/ Sign in as a given browser.
async fn login_as(app: &common::TestApp, username: &str, ua: &str) -> (String, String, i64) {
    use axum::body::Body;
    use axum::http::{header, Method, Request};
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/token")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::USER_AGENT, ua)
        .header("x-forwarded-for", "198.51.100.7")
        .body(Body::from(json!({"username": username, "password": "pw"}).to_string()))
        .unwrap();
    let r = app.send(req).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let (a, rf) = (r.json["access_token"].as_str().unwrap().to_string(), r.json["refresh_token"].as_str().unwrap().to_string());
    let sid = claims(&a).sid.expect("an access token names its session");
    assert_eq!(claims(&rf).sid, Some(sid));
    (a, rf, sid)
}

async fn serve(app: &common::TestApp) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("ws://{addr}")
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 通知 socket，認證完成（ping → pong）才回。/ A notifications socket, returned once authenticated.
async fn notifications(base: &str, token: &str) -> Ws {
    use futures::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{base}/ws/notifications/")).await.unwrap();
    ws.send(Message::Text(json!({"type": "auth", "token": token}).to_string().into())).await.unwrap();
    ws.send(Message::Text(json!({"type": "ping"}).to_string().into())).await.unwrap();
    match next_frame(&mut ws).await {
        Message::Text(t) => assert_eq!(serde_json::from_str::<serde_json::Value>(&t).unwrap(), json!({"type": "pong"})),
        other => panic!("expected pong, got {other:?}"),
    }
    ws
}

async fn next_frame(ws: &mut Ws) -> tokio_tungstenite::tungstenite::Message {
    use futures::StreamExt;
    loop {
        let m = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await.expect("timeout waiting for a frame").expect("stream ended").unwrap();
        if !matches!(m, tokio_tungstenite::tungstenite::Message::Ping(_) | tokio_tungstenite::tungstenite::Message::Pong(_)) {
            return m;
        }
    }
}

/// 下一個 frame 是 4010 + 原因。/ The next frame is a 4010 close with the reason.
async fn expect_signed_out(ws: &mut Ws, reason: &str) {
    match next_frame(ws).await {
        tokio_tungstenite::tungstenite::Message::Close(Some(f)) => {
            assert_eq!(u16::from(f.code), 4010);
            assert_eq!(f.reason.as_str(), reason);
        }
        other => panic!("expected a 4010 close, got {other:?}"),
    }
}

#[tokio::test]
async fn your_devices_list_and_sign_out() {
    let app = common::spawn().await;
    let (_, _) = login(&app, "admin").await;
    let (a, _a_refresh, sid_a) = login_as(&app, "admin", MAC_CHROME).await;
    let (b, b_refresh, sid_b) = login_as(&app, "admin", WIN_FIREFOX).await;

    let r = app.get("/api/auth/sessions", Some(&a)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["signin_lifetime"], 2_592_000);
    assert_eq!(r.json["access_lifetime"], 3600);
    let list = r.json["sessions"].as_array().unwrap();
    assert_eq!(list.len(), 3, "the first plain login plus two browsers: {}", r.text);
    let row = |sid: i64| list.iter().find(|s| s["id"] == sid).unwrap().clone();
    let me = row(sid_a);
    assert_eq!(me["current"], true);
    assert_eq!(me["device"], "Chrome · macOS");
    assert_eq!(me["ip"], "198.51.100.7");
    assert_eq!(me["sign_in_method"], "password");
    assert!(me["mfa_method"].is_null());
    assert!(me["expires_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(row(sid_b)["current"], false);
    assert_eq!(row(sid_b)["device"], "Firefox · Windows");
    assert_eq!(list.iter().filter(|s| s["current"] == true).count(), 1);

    // B 開著一個 WebSocket；A 把 B 登出 → socket 4010（原因 user）、B 的 access token 立刻失效、refresh 被拒。
    // B has a socket open; A signs B out: 4010 (reason user), B's access token stops at once, its refresh too.
    let base = serve(&app).await;
    let mut ws_b = notifications(&base, &b).await;
    let mut ws_a = notifications(&base, &a).await;
    assert_eq!(app.get("/api/auth/user/profile", Some(&b)).await.status, StatusCode::OK);
    let r = app.delete(&format!("/api/auth/sessions/{sid_b}"), Some(&a)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    expect_signed_out(&mut ws_b, "user").await;
    let r = app.get("/api/auth/user/profile", Some(&b)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "a revoked session's access token is refused before it expires");
    assert_eq!((r.json["code"].as_str(), r.json["signed_out"].as_str()), (Some("token_not_valid"), Some("user")));
    let r = refresh(&app, &b_refresh).await;
    assert_eq!((r.status, r.json["signed_out"].as_str()), (StatusCode::UNAUTHORIZED, Some("user")), "{}", r.text);
    // 新的 socket 也連不上（4001）。/ A new socket is refused too.
    {
        use futures::SinkExt;
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("{base}/ws/notifications/")).await.unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type": "auth", "token": b}).to_string().into())).await.unwrap();
        match next_frame(&mut ws).await {
            tokio_tungstenite::tungstenite::Message::Close(Some(f)) => assert_eq!(u16::from(f.code), 4001),
            other => panic!("expected 4001, got {other:?}"),
        }
    }
    // 已登出的、別人的 → 404。/ Already revoked, or someone else's: 404.
    assert_eq!(app.delete(&format!("/api/auth/sessions/{sid_b}"), Some(&a)).await.status, StatusCode::NOT_FOUND);
    let r = app.post("/api/site/settings", Some(&a), json!({"allow_registration": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let (_, _) = login(&app, "bob").await;
    let (bob, _, sid_bob) = login_as(&app, "bob", MAC_CHROME).await;
    assert_eq!(app.delete(&format!("/api/auth/sessions/{sid_bob}"), Some(&a)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/auth/user/profile", Some(&bob)).await.status, StatusCode::OK);

    // 登出其他所有裝置：自己留著。/ Sign out everywhere else: this browser stays.
    let (c, _, _) = login_as(&app, "admin", WIN_FIREFOX).await;
    let r = app.delete("/api/auth/sessions?others=1", Some(&a)).await;
    assert_eq!((r.status, r.json["revoked"].as_i64()), (StatusCode::OK, Some(2)), "{}", r.text);
    assert_eq!(app.get("/api/auth/user/profile", Some(&c)).await.status, StatusCode::UNAUTHORIZED);
    let r = app.get("/api/auth/sessions", Some(&a)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let ids: Vec<i64> = r.json["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![sid_a]);
    // A 的 socket 沒被波及。/ A's socket was not touched.
    {
        use futures::SinkExt;
        ws_a.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type": "ping"}).to_string().into())).await.unwrap();
        assert!(matches!(next_frame(&mut ws_a).await, tokio_tungstenite::tungstenite::Message::Text(_)));
    }
    let reason: Option<String> = sqlx::query_scalar("SELECT revoked_reason FROM telepy_web_session WHERE id = ?").bind(sid_b).fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(reason.as_deref(), Some("user"));
}

#[tokio::test]
async fn admins_sign_users_out() {
    let app = common::spawn().await;
    let (admin, _) = login(&app, "admin").await;
    let r = app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let (_, _) = login(&app, "bob").await;
    let bob_id: i64 = sqlx::query_scalar("SELECT id FROM auth_user WHERE username = 'bob'").fetch_one(&app.state.db.read).await.unwrap();
    let admin_id: i64 = sqlx::query_scalar("SELECT id FROM auth_user WHERE username = 'admin'").fetch_one(&app.state.db.read).await.unwrap();
    let (bob, bob_refresh, sid) = login_as(&app, "bob", MAC_CHROME).await;

    // 只有管理員。/ Admins only.
    assert_eq!(app.get(&format!("/api/user/users/{admin_id}/sessions"), Some(&bob)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.delete(&format!("/api/user/users/{admin_id}/sessions"), Some(&bob)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get("/api/user/users/999/sessions", Some(&admin)).await.status, StatusCode::NOT_FOUND);

    let r = app.get(&format!("/api/user/users/{bob_id}/sessions"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["sessions"].as_array().unwrap().len(), 2);
    assert!(r.json["sessions"].as_array().unwrap().iter().all(|s| s["current"] == false), "the admin's browser is none of them");

    let base = serve(&app).await;
    let mut ws = notifications(&base, &bob).await;
    let r = app.delete(&format!("/api/user/users/{bob_id}/sessions/{sid}"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    expect_signed_out(&mut ws, "admin").await;
    let r = app.get("/api/auth/user/profile", Some(&bob)).await;
    assert_eq!((r.status, r.json["signed_out"].as_str()), (StatusCode::UNAUTHORIZED, Some("admin")));
    assert_eq!(refresh(&app, &bob_refresh).await.json["signed_out"], "admin");
    // 不是 bob 的 session → 404。/ A session that is not bob's: 404.
    let r = app.get(&format!("/api/user/users/{admin_id}/sessions"), Some(&admin)).await;
    let admin_sid = r.json["sessions"][0]["id"].as_i64().unwrap();
    assert_eq!(app.delete(&format!("/api/user/users/{bob_id}/sessions/{admin_sid}"), Some(&admin)).await.status, StatusCode::NOT_FOUND);

    // 全部登出。/ Everything.
    let (bob2, _, _) = login_as(&app, "bob", WIN_FIREFOX).await;
    let r = app.delete(&format!("/api/user/users/{bob_id}/sessions"), Some(&admin)).await;
    assert_eq!((r.status, r.json["revoked"].as_i64()), (StatusCode::OK, Some(2)), "{}", r.text);
    assert_eq!(app.get("/api/auth/user/profile", Some(&bob2)).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get(&format!("/api/user/users/{bob_id}/sessions"), Some(&admin)).await.json["sessions"], json!([]));
    assert_eq!(app.get("/api/auth/user/profile", Some(&admin)).await.status, StatusCode::OK);
}

/// 別的 process（或直接改 DB）撤銷的：快取最多 5 秒後也拒絕。/ A revocation this process did not see: refused within the 5 s cache.
#[tokio::test]
async fn a_revocation_elsewhere_is_seen_within_the_cache_window() {
    let app = common::spawn().await;
    let (_, _) = login(&app, "admin").await;
    let (a, _, sid) = login_as(&app, "admin", MAC_CHROME).await;
    assert_eq!(app.get("/api/auth/user/profile", Some(&a)).await.status, StatusCode::OK);
    sqlx::query("UPDATE telepy_web_session SET revoked_at = ?, revoked_reason = 'admin' WHERE id = ?")
        .bind(telepy_server::util::now_db())
        .bind(sid)
        .execute(&app.state.db.write)
        .await
        .unwrap();
    tokio::time::sleep(telepy_server::auth::sessions::REVOKED_CACHE_TTL + std::time::Duration::from_millis(300)).await;
    let r = app.get("/api/auth/user/profile", Some(&a)).await;
    assert_eq!((r.status, r.json["signed_out"].as_str()), (StatusCode::UNAUTHORIZED, Some("admin")));
}

#[tokio::test]
async fn a_sign_in_from_a_new_browser_is_announced() {
    let app = common::spawn().await;
    let (_, _) = login(&app, "admin").await;
    let uid: i64 = sqlx::query_scalar("SELECT id FROM auth_user WHERE username = 'admin'").fetch_one(&app.state.db.read).await.unwrap();
    // 第一次登入（沒有 User-Agent）不算新裝置；接著用 Chrome 登入是新瀏覽器。
    // The first sign-in (no User-Agent) is never new; Chrome afterwards is a new browser.
    let mut rx = app.state.hub.subscribe_user(uid);
    let _ = login_as(&app, "admin", MAC_CHROME).await;
    let msg: serde_json::Value = serde_json::from_str(&tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await.unwrap().unwrap()).unwrap();
    assert_eq!(msg["message"]["action"], "SIGN-IN-NEW-DEVICE");
    assert_eq!(msg["message"]["device"], "Chrome · macOS");
    assert_eq!(msg["message"]["ip"], "198.51.100.7");
    assert_eq!(msg["message"]["method"], "password");
    // 同一個瀏覽器再登入：不再通知。/ The same browser again: no alert.
    let _ = login_as(&app, "admin", &MAC_CHROME.replace("130.0", "131.0")).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(rx.try_recv().is_err(), "a known browser is not announced");
    // 失敗的登入不算。/ A failed sign-in never counts.
    let r = app.post("/api/auth/token", None, json!({"username": "admin", "password": "wrong"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let _ = login_as(&app, "admin", WIN_FIREFOX).await;
    let msg: serde_json::Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(msg["message"]["device"], "Firefox · Windows");
}

/// 續期時沒有來源資訊（後端直接被叫、沒有代理）不會把記下的 IP / User-Agent 洗成空的；有新位址就更新。
/// A renewal without address info keeps the stored IP and user agent; one from a new address updates it.
#[tokio::test]
async fn a_renewal_without_address_keeps_the_stored_ip() {
    use axum::body::Body;
    use axum::http::{header, Method, Request};
    let app = common::spawn().await;
    let (_, _) = login(&app, "admin").await;
    let (a, rf, sid) = login_as(&app, "admin", MAC_CHROME).await;
    let ip_of = |r: &common::Resp| r.json["sessions"].as_array().unwrap().iter().find(|s| s["id"] == sid).map(|s| (s["ip"].clone(), s["device"].clone())).unwrap();

    let r = refresh(&app, &rf).await; // in-process: no XFF, no peer, no user agent
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let rf2 = r.json["refresh_token"].as_str().unwrap().to_string();
    let list = app.get("/api/auth/sessions", Some(&a)).await;
    assert_eq!(ip_of(&list), (json!("198.51.100.7"), json!("Chrome · macOS")), "{}", list.text);

    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/auth/token/refresh")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", "203.0.113.20")
        .body(Body::from(json!({"refresh": rf2}).to_string()))
        .unwrap();
    assert_eq!(app.send(req).await.status, StatusCode::OK);
    let list = app.get("/api/auth/sessions", Some(&a)).await;
    assert_eq!(ip_of(&list).0, json!("203.0.113.20"));
}
