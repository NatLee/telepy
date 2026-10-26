mod common;

use axum::http::StatusCode;
use serde_json::json;

#[tokio::test]
async fn setup_status_register_login_profile_refresh() {
    let app = common::spawn().await;

    let r = app.get("/api/auth/setup-status", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json, json!({"first_time_setup": true}));

    // register: first user becomes superuser
    let r = app.post("/api/auth/register", None, json!({"username": "admin", "password": "1234"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["status"], "success");
    assert_eq!(r.json["data"]["user"]["username"], "admin");
    assert_eq!(r.json["details"], "User created successfully");

    let r = app.get("/api/auth/setup-status", None).await;
    assert_eq!(r.json, json!({"first_time_setup": false}));

    // registration is closed by default after the first user
    let r = app.post("/api/auth/register", None, json!({"username": "bob", "password": "x"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json["error"], "Registration is currently disabled.");

    // missing fields → DRF field errors
    let r = app.post("/api/auth/token", None, json!({"username": "admin"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!({"password": ["This field is required."]}));

    // wrong password
    let r = app.post("/api/auth/token", None, json!({"username": "admin", "password": "nope"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json["detail"], "No active account found with the given credentials");

    // login
    let r = app.post("/api/auth/token", None, json!({"username": "admin", "password": "1234"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let access = r.json["access_token"].as_str().unwrap().to_string();
    let refresh = r.json["refresh_token"].as_str().unwrap().to_string();
    assert!(r.json.get("access").is_none(), "simplejwt keys must be renamed");

    // profile
    let r = app.get("/api/auth/user/profile", Some(&access)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["username"], "admin");
    assert_eq!(r.json["is_superuser"], true);
    assert_eq!(r.json["is_staff"], true);
    assert_eq!(r.json["language"], serde_json::Value::Null);
    assert_eq!(r.json["theme"], "system");
    assert_eq!(r.json["terminal_font_size"], 14);
    assert_eq!(r.json["ui_scale"], 100);
    assert_eq!(r.json["terminal_font"], "hack");
    assert_eq!(r.json["terminal_scheme"], "telepy");
    assert!(r.json["date_joined"].as_str().unwrap().ends_with('Z'));
    assert!(r.json["last_login"].is_string(), "a password login records last_login: {}", r.text);

    // unauthenticated / bad token
    let r = app.get("/api/auth/user/profile", None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json["detail"], "Authentication credentials were not provided.");
    let r = app.get("/api/auth/user/profile", Some("garbage")).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json["code"], "token_not_valid");

    // refresh token cannot be used as access token
    let r = app.get("/api/auth/user/profile", Some(&refresh)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // refresh：換發新的 access + refresh（詳細規則在 tests/web_sessions.rs）。/ Rotation; the rules live in tests/web_sessions.rs.
    let r = app.post("/api/auth/token/refresh", None, json!({"refresh": refresh})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["access_token"].is_string());
    assert!(r.json["refresh_token"].is_string(), "the refresh token rotates: {}", r.text);
    assert!(r.json.get("access").is_none() && r.json.get("refresh").is_none(), "simplejwt keys must be renamed");
    let r = app.post("/api/auth/token/refresh", None, json!({"refresh": access})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json["code"], "token_not_valid");

    // verify
    let r = app.post("/api/auth/token/verify", None, json!({"token": access})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json, json!({}));
    let r = app.post("/api/auth/token/verify", None, json!({"token": "x.y.z"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // google: missing credential → field error; bogus credential → a specific error with a code (#23)
    let r = app.post("/api/auth/google/token", None, json!({})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!({"credential": ["This field is required."]}));
}

#[tokio::test]
async fn google_token_errors_are_specific() {
    // 沒設 client ID → 伺服器設定錯誤；有設 → 壞掉的 token 是 400。/ Not configured → 500; configured → 400.
    let mut app = common::spawn().await;
    for (client_id, status, code) in [(None, StatusCode::INTERNAL_SERVER_ERROR, "google_not_configured"), (Some("cid.apps.googleusercontent.com"), StatusCode::BAD_REQUEST, "google_invalid")] {
        let mut config = app.state.config.clone();
        config.google_client_id = client_id.map(str::to_string);
        app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
        app.router = telepy_server::app::build(app.state.clone());
        let r = app.post("/api/auth/google/token", None, json!({"credential": "not-a-jwt"})).await;
        assert_eq!(r.status, status, "{}", r.text);
        assert_eq!(r.json["code"], code);
        assert_eq!(r.json["status"], "error");
        assert!(r.json["detail"].as_str().unwrap().len() > 10);
    }
}

#[tokio::test]
async fn malformed_json_is_a_400_with_detail() {
    let app = common::spawn().await;
    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/api/auth/token")
        .header("content-type", "application/json")
        .body(axum::body::Body::from("{not json"))
        .unwrap();
    let resp = tower::ServiceExt::oneshot(app.router.clone(), req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}
