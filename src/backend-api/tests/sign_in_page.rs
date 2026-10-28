//! 低調登入頁：管理員在網站設定切換一般登入頁 / OAuth 登入頁 / CLI 登入頁 / 授權頁的樣子與那句話，公開端點不用登入就讀得到。
//! The discreet sign-in page: admins pick the look of the sign-in, OAuth, CLI sign-in and approval pages plus the line;
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
    assert_eq!(r.json, json!({"style": "standard", "oauth_style": "standard", "cli_style": "standard", "consent_style": "standard", "message": ""}));

    let (admin, bob) = app.admin_and_user("admin", "bob").await;
    let r = app.get("/api/site/settings", Some(&admin)).await;
    assert_eq!(r.json["values"]["signin_page_style"], "standard");
    assert_eq!(r.json["meta"]["signin_page_message"]["type"], "text");

    // 切成低調 + 一句話（頭尾空白、\r\n 都整理掉）。/ Switch to discreet with a line (whitespace and \r\n tidied).
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_style": "discreet", "signin_oauth_style": "discreet", "signin_cli_style": "discreet", "signin_consent_style": "discreet", "signin_page_message": "  Welcome to the lab \r\nSee you inside  "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.get("/api/auth/sign-in-page", None).await;
    assert_eq!(r.json, json!({"style": "discreet", "oauth_style": "discreet", "cli_style": "discreet", "consent_style": "discreet", "message": "Welcome to the lab\nSee you inside"}));

    // 清空 = 回到內建的句子。/ Clearing it brings the built-in lines back.
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_message": ""})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["message"], "");

    // 不認得的樣子、太長、太多行都拒絕。/ Unknown looks, long or many-line text are refused.
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_style": "neon"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!({"signin_page_style": ["Must be one of: standard, discreet."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_cli_style": "neon"})).await;
    assert_eq!(r.json, json!({"signin_cli_style": ["Must be one of: standard, discreet."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_consent_style": "neon"})).await;
    assert_eq!(r.json, json!({"signin_consent_style": ["Must be one of: standard, discreet."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_message": "x".repeat(81)})).await;
    assert_eq!(r.json, json!({"signin_page_message": ["Keep each line to 80 characters or fewer."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_message": "a\nb\nc\nd\ne\nf\ng"})).await;
    assert_eq!(r.json, json!({"signin_page_message": ["Use at most 6 lines."]}));
    // 輪播的句子：一行一句，空行拿掉。/ Rotating lines, one per line, blank lines dropped.
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_message": "One\n\n  Two  \nThree\nFour\nFive\nSix"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["message"], "One\nTwo\nThree\nFour\nFive\nSix");
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_page_message": ""})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    // 一般使用者不能改；其中一頁單獨切回一般樣子。/ Others cannot change it; one page goes back on its own.
    let r = app.post("/api/site/settings", Some(&bob), json!({"signin_page_style": "standard"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_oauth_style": "standard"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.get("/api/auth/sign-in-page", None).await;
    assert_eq!(r.json, json!({"style": "discreet", "oauth_style": "standard", "cli_style": "discreet", "consent_style": "discreet", "message": ""}));
    // 授權頁也是自己一個設定。/ The approval page has its own setting too.
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_consent_style": "standard"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["consent_style"], "standard");
    let r = app.get("/api/site/settings", Some(&admin)).await;
    assert_eq!(r.json["values"]["signin_cli_style"], "discreet");
    assert_eq!(r.json["meta"]["signin_cli_style"]["type"], "string");
}

/// CLI 的登入頁以前跟著 OAuth 登入頁：升級時抄一次那時的樣子，之後各管各的。
/// The CLI sign-in used to follow the OAuth page: an upgrade copies that look once, then each has its own.
#[tokio::test]
async fn the_cli_sign_in_look_starts_from_the_oauth_one_once() {
    use telepy_server::db::schema;
    let app = common::spawn().await;
    let db = &app.state.db;
    // 升級前的樣子：OAuth 頁是低調的，CLI 這欄剛加上（預設 standard），migration 還沒跑。
    // Before the upgrade: the OAuth page is discreet, the new CLI column has its default and the migration hasn't run.
    sqlx::query("UPDATE site_settings_sitesettings SET signin_oauth_style = 'discreet', signin_cli_style = 'standard' WHERE id = 1").execute(&db.write).await.unwrap();
    sqlx::query("DELETE FROM telepy_data_migration WHERE name = ?").bind(schema::CLI_SIGNIN_STYLE).execute(&db.write).await.unwrap();
    schema::ensure_schema(&db.write).await.unwrap();
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["cli_style"], "discreet", "the CLI page keeps looking like before");

    // 之後管理員把 CLI 頁切回一般：再跑一次 schema 也不會被蓋掉。/ Later changes survive another schema run.
    let admin = app.login("admin", "pw").await;
    let r = app.post("/api/site/settings", Some(&admin), json!({"signin_cli_style": "standard"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    schema::ensure_schema(&db.write).await.unwrap();
    let r = app.get("/api/auth/sign-in-page", None).await;
    assert_eq!((r.json["oauth_style"].as_str(), r.json["cli_style"].as_str()), (Some("discreet"), Some("standard")));
}
