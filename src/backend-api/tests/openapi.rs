//! OpenAPI 文件與 Swagger UI：spec 覆蓋所有 REST 路由、安全方案正確、頁面可開、可用 OPENAPI_ENABLED 關掉。
//! OpenAPI document + Swagger UI: every REST route is in the spec, security schemes are right, the page serves,
//! and OPENAPI_ENABLED=false hides both.
mod common;

use axum::http::StatusCode;
use serde_json::Value;

#[tokio::test]
async fn spec_is_served_and_covers_the_rest_api() {
    let app = common::spawn().await;
    let r = app.get("/api/openapi.json", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let spec = r.json;
    assert_eq!(spec["openapi"].as_str().unwrap_or("").split('.').next(), Some("3"));
    assert_eq!(spec["info"]["title"], "Telepy API");

    // 核心路徑都在，而且動詞對得上前端 lib/api.ts 用的那些。/ The key paths and verbs the frontend uses.
    let paths = spec["paths"].as_object().unwrap();
    for (path, verbs) in [
        ("/api/auth/token", vec!["post"]),
        ("/api/auth/user/profile", vec!["get"]),
        ("/api/reverse/server/dashboard", vec!["get"]),
        ("/api/reverse/server/keys", vec!["get", "post"]),
        ("/api/reverse/server/keys/{id}", vec!["get", "put", "patch", "delete"]),
        ("/api/reverse/server/usernames/{id}", vec!["get", "put", "patch", "delete"]),
        ("/api/reverse/user/keys/{id}", vec!["get", "put", "patch", "delete"]),
        ("/api/reverse/create/key/{token}", vec!["post"]),
        ("/tunnels/share/{id}", vec!["post"]),
        ("/tunnels/server/script/{kind}/{id}/{ssh_port}", vec!["get"]),
        ("/api/sftp/upload/{id}/{username}", vec!["post"]),
        ("/api/reverse/server/{id}/remote-browser/start", vec!["post"]),
        ("/api/log/ssh/events", vec!["get"]),
        ("/api/reverse/internal/keys", vec!["get"]),
    ] {
        let item = paths.get(path).unwrap_or_else(|| panic!("missing path {path}"));
        for verb in verbs {
            assert!(item.get(verb).is_some(), "{path} lacks {verb}");
        }
    }
    assert!(paths.len() >= 48, "only {} paths documented", paths.len());

    // 每個操作都有 tag；公開端點沒有 security，其餘要求 bearer（internal 端點要求 internal）。
    // Every operation is tagged; public ones carry no security, the rest require bearer (internal → internal).
    let public = ["/api/auth/setup-status", "/api/auth/token", "/api/auth/token/refresh", "/api/auth/token/verify", "/api/auth/register", "/api/auth/google/token", "/tunnels/server/script/one-time/{token}"];
    for (path, item) in paths {
        for (verb, op) in item.as_object().unwrap() {
            assert!(op["tags"].as_array().map(|t| !t.is_empty()).unwrap_or(false), "{verb} {path} has no tag");
            let sec = &op["security"];
            if public.contains(&path.as_str()) {
                assert!(sec.is_null(), "{verb} {path} must be public");
            } else if path.starts_with("/api/reverse/internal/") {
                assert_eq!(sec, &serde_json::json!([{"internal": []}]), "{verb} {path}");
            } else {
                assert_eq!(sec, &serde_json::json!([{"bearer": []}]), "{verb} {path}");
            }
        }
    }
    let schemes = &spec["components"]["securitySchemes"];
    assert_eq!(schemes["bearer"]["scheme"], "bearer");
    assert_eq!(schemes["bearer"]["bearerFormat"], "JWT");
    assert_eq!(schemes["internal"]["scheme"], "bearer");
    // 回應 schema 真的被收進 components。/ Response schemas actually land in components.
    assert!(spec["components"]["schemas"]["Tunnel"]["properties"]["reverse_port"].is_object());
    assert!(spec["components"]["schemas"]["Dashboard"]["properties"]["tunnels"].is_object());

    // 程式內的 openapi() 與 HTTP 端點給的是同一份。/ The in-process document equals the served one.
    let inproc: Value = serde_json::from_str(&telepy_server::app::openapi().to_json().unwrap()).unwrap();
    assert_eq!(inproc["paths"], spec["paths"]);
}

#[tokio::test]
async fn swagger_ui_page_is_served() {
    let app = common::spawn().await;
    for path in ["/api/__hidden_swagger", "/api/__hidden_swagger/"] {
        let r = app.get(path, None).await;
        assert!(r.status == StatusCode::OK || r.status.is_redirection(), "{path}: {}", r.status);
        if r.status == StatusCode::OK {
            assert!(r.text.contains("swagger-ui"), "{path}: not the Swagger page");
        }
    }
    // 頁面的初始化腳本指向我們的 spec。/ The page's initializer points at our spec URL.
    let r = app.get("/api/__hidden_swagger/swagger-initializer.js", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text.contains("/api/openapi.json"), "initializer does not point at the spec: {}", r.text);
}

#[tokio::test]
async fn openapi_can_be_disabled() {
    let mut app = common::spawn().await;
    let mut config = app.state.config.clone();
    config.openapi_enabled = false;
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    assert_eq!(app.get("/api/openapi.json", None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/__hidden_swagger/", None).await.status, StatusCode::NOT_FOUND);
    // 其餘 API 不受影響。/ The rest of the API is unaffected.
    assert_eq!(app.get("/api/auth/setup-status", None).await.status, StatusCode::OK);
}
