//! 低調登入頁：管理員在網站設定切換一般登入頁 / OAuth 登入頁的樣子與那句話，公開端點不用登入就讀得到。
//! The discreet sign-in page: admins pick the look of the sign-in and OAuth sign-in pages plus the line;
//! the public endpoint answers without a sign-in.
mod common;

use axum::http::StatusCode;
use serde_json::json;

#[tokio::test]
async fn admins_choose_the_sign_in_page_look_and_anyone_can_read_it() {
    let app = common::spawn().await;

    // 預設：兩頁都是一般樣子、沒有自訂的句子；不用登入。/ Defaults, read without a sign-in.
    let r = app.get("/api/auth/sign-in-page", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json, json!({"style": "standard", "oauth_style": "standard", "message": ""}));

    let (admin, bob) = app.admin_and_user("admin", "bob").await;
    let r = app.get("/api/site/settings", Some(&admin)).await;
    assert_eq!(r.json["values"]["signin_page_style"], "standard");
    assert_eq!(r.json["meta"]["signin_page_message"]["type"], "text");

    // 切成低調 + 一句話（頭尾空白、\r\n 都整理掉）。/ Switch to discreet with a line (whitespace and \r\n tidied).
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_style": "discreet", "signin_oauth_style": "discreet", "signin_page_message": "  Welcome to the lab \r\nSee you inside  "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.get("/api/auth/sign-in-page", None).await;
    assert_eq!(r.json, json!({"style": "discreet", "oauth_style": "discreet", "message": "Welcome to the lab\nSee you inside"}));

    // 清空 = 回到內建的句子。/ Clearing it brings the built-in lines back.
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_message": ""})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["message"], "");

    // 不認得的樣子、太長、太多行都拒絕。/ Unknown looks, long or many-line text are refused.
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_style": "neon"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!({"signin_page_style": ["Must be one of: standard, discreet."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_message": "x".repeat(201)})).await;
    assert_eq!(r.json, json!({"signin_page_message": ["Ensure this field has no more than 200 characters."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_message": "a\nb\nc\nd"})).await;
    assert_eq!(r.json, json!({"signin_page_message": ["Use at most 3 lines."]}));

    // 一般使用者不能改；其中一頁單獨切回一般樣子。/ Others cannot change it; one page goes back on its own.
    let r = app.post("/api/site/settings", Some(&bob), json!({"signin_page_style": "standard"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_oauth_style": "standard"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.get("/api/auth/sign-in-page", None).await;
    assert_eq!(r.json, json!({"style": "discreet", "oauth_style": "standard", "message": ""}));
}
