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
    // access token 本身是無狀態的，到期前仍可用（短效）。/ Access tokens stay stateless and valid until they expire.
    assert_eq!(app.get("/api/auth/user/profile", Some(&access1)).await.status, StatusCode::OK);
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
