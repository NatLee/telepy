//! Google 登入在 id_token 驗證之後的每一種結果（#23）：建立帳號、網域不允許、註冊關閉、同名的帳密帳號、停用、沒有 email。
//! Every outcome of the Google sign-in after the id_token is verified, each with its own code (#23).
mod common;

use axum::http::StatusCode;
use serde_json::json;

use telepy_server::api::auth::google_sign_in;
use telepy_server::auth::google::GoogleClaims;
use telepy_server::client_ip::ClientMeta;
use telepy_server::db;

fn claims(email: Option<&str>, sub: &str) -> GoogleClaims {
    GoogleClaims { sub: sub.into(), email: email.map(str::to_string), given_name: Some("Ada".into()), family_name: Some("L".into()), email_verified: Some(true) }
}

#[tokio::test]
async fn google_sign_in_outcomes() {
    let app = common::spawn().await;
    let err = |e: telepy_server::error::ApiError| (e.status, e.body);

    // 第一位使用者（註冊永遠開放）→ 建立並拿到 token。/ The first user is created and gets tokens.
    let ok = google_sign_in(&app.state, claims(Some("ada@gmail.com"), "g-1"), &ClientMeta::default()).await.unwrap();
    assert!(ok["access_token"].is_string(), "{ok}");
    let ada = db::users::by_username(&app.state.db, "ada").await.unwrap().unwrap();
    assert_eq!(ada.email, "ada@gmail.com");
    // 再次登入同一個帳號。/ Signing in again.
    assert!(google_sign_in(&app.state, claims(Some("ada@gmail.com"), "g-1"), &ClientMeta::default()).await.unwrap()["access_token"].is_string());

    // 沒有 email。/ No email.
    let (status, body) = err(google_sign_in(&app.state, claims(None, "g-2"), &ClientMeta::default()).await.unwrap_err());
    assert_eq!((status, body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("google_no_email")));

    // 網域不在白名單（預設只有 gmail.com）。/ Domain not on the allow-list.
    let (status, body) = err(google_sign_in(&app.state, claims(Some("bob@corp.example"), "g-3"), &ClientMeta::default()).await.unwrap_err());
    assert_eq!((status, body["code"].as_str(), body["domain"].as_str()), (StatusCode::FORBIDDEN, Some("google_domain_not_allowed"), Some("corp.example")));
    assert_eq!(body["detail"], "Accounts from corp.example cannot sign in to this server.");

    // 註冊關閉（已有使用者、allow_registration 預設 false）。/ Registration closed.
    let (status, body) = err(google_sign_in(&app.state, claims(Some("carol@gmail.com"), "g-4"), &ClientMeta::default()).await.unwrap_err());
    assert_eq!((status, body["code"].as_str()), (StatusCode::FORBIDDEN, Some("registration_closed")));
    assert!(db::users::by_username(&app.state.db, "carol").await.unwrap().is_none());

    // 同名的帳密帳號（沒有 Google 連結）→ 409，告訴對方用密碼登入。/ A password account with that username → 409.
    let r = app.post("/api/auth/register", None, json!({"username": "admin", "password": "pw"})).await;
    assert!(r.status.is_success() || r.status == StatusCode::BAD_REQUEST, "{}", r.text);
    let r = app.post("/api/auth/token", None, json!({"username": "ada", "password": "x"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "Google accounts have no usable password");
    sqlx::query("INSERT INTO auth_user (password, is_superuser, username, last_name, email, is_staff, is_active, date_joined, first_name) VALUES ('!', 0, 'dave', '', 'dave@gmail.com', 0, 1, '2026-01-01 00:00:00', '')")
        .execute(&app.state.db.write)
        .await
        .unwrap();
    let (status, body) = err(google_sign_in(&app.state, claims(Some("dave@gmail.com"), "g-5"), &ClientMeta::default()).await.unwrap_err());
    assert_eq!((status, body["code"].as_str(), body["username"].as_str()), (StatusCode::CONFLICT, Some("google_account_conflict"), Some("dave")));

    // 停用的帳號。/ A disabled account.
    sqlx::query("UPDATE auth_user SET is_active = 0 WHERE username = 'ada'").execute(&app.state.db.write).await.unwrap();
    let (status, body) = err(google_sign_in(&app.state, claims(Some("ada@gmail.com"), "g-1"), &ClientMeta::default()).await.unwrap_err());
    assert_eq!((status, body["code"].as_str()), (StatusCode::FORBIDDEN, Some("account_disabled")));
}
