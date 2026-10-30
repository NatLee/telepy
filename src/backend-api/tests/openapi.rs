//! OpenAPI 文件與 Swagger UI：spec 覆蓋所有 REST 路由、安全方案正確、兩者都要登入、可用 OPENAPI_ENABLED 關掉。
//! OpenAPI document + Swagger UI: every REST route is in the spec, security schemes are right, both need a login,
//! and OPENAPI_ENABLED=false hides both.
mod common;

use axum::http::StatusCode;
use serde_json::Value;

#[tokio::test]
async fn spec_is_served_and_covers_the_rest_api() {
    let app = common::spawn().await;
    // 規格要登入。/ The spec needs a login.
    assert_eq!(app.get("/api/openapi.json", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/openapi.json", Some("not-a-token")).await.status, StatusCode::UNAUTHORIZED);
    let token = app.login("admin", "pw").await;
    let r = app.get("/api/openapi.json", Some(&token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.headers.get("content-type").unwrap().to_str().unwrap().starts_with("application/json"));
    let spec = r.json;
    assert_eq!(spec["openapi"].as_str().unwrap_or("").split('.').next(), Some("3"));
    assert_eq!(spec["info"]["title"], "Telepy API");

    // 核心路徑都在，而且動詞對得上前端 lib/api.ts 用的那些。/ The key paths and verbs the frontend uses.
    let paths = spec["paths"].as_object().unwrap();
    for (path, verbs) in [
        ("/api/auth/token", vec!["post"]),
        ("/api/snippets", vec!["get", "post"]),
        ("/api/snippets/{id}", vec!["patch", "delete"]),
        ("/api/snippets/{id}/used", vec!["post"]),
        ("/api/notifications/preferences", vec!["get", "put"]),
        ("/api/notifications/mute/{tunnel_id}", vec!["put", "delete"]),
        ("/api/notifications/defaults", vec!["get", "put"]),
        ("/api/webhooks", vec!["get", "post"]),
        ("/api/webhooks/{id}", vec!["get", "patch", "delete"]),
        ("/api/webhooks/{id}/test", vec!["post"]),
        ("/api/webhooks/{id}/deliveries", vec!["get"]),
        ("/api/webhooks/{id}/deliveries/{delivery_id}/redeliver", vec!["post"]),
        ("/api/webhooks/{id}/secret", vec!["get", "post"]),
        ("/api/webhooks/{id}/optout", vec!["put", "delete"]),
        ("/api/auth/user/profile", vec!["get"]),
        ("/api/reverse/server/dashboard", vec!["get"]),
        ("/api/reverse/join", vec!["post"]),
        ("/api/reverse/join/{id}", vec!["get", "delete"]),
        ("/api/join/{token}", vec!["post"]),
        ("/api/reverse/server/keys", vec!["get", "post"]),
        ("/api/reverse/server/keys/{id}", vec!["get", "put", "patch", "delete"]),
        ("/api/reverse/server/{id}/delete-check", vec!["get"]),
        ("/api/reverse/server/usernames/{id}", vec!["get", "put", "patch", "delete"]),
        ("/api/reverse/user/keys/{id}", vec!["get", "put", "patch", "delete"]),
        ("/api/reverse/user/keys/devices", vec!["get"]),
        ("/api/reverse/server/{id}/device-keys", vec!["get", "post"]),
        ("/api/reverse/server/{id}/device-keys/{key_id}", vec!["delete"]),
        ("/api/reverse/server/{id}/device-keys/sync", vec!["post"]),
        ("/api/reverse/server/{id}/authorized-keys", vec!["get"]),
        ("/api/reverse/server/{id}/authorized-keys/remove", vec!["post"]),
        ("/api/reverse/create/key/{token}", vec!["post"]),
        ("/tunnels/share/{id}", vec!["post"]),
        ("/tunnels/server/script/{kind}/{id}/{ssh_port}", vec!["get"]),
        ("/tunnels/server/config", vec!["get"]),
        ("/api/sftp/upload/{id}/{username}", vec!["post"]),
        ("/api/reverse/server/{id}/remote-browser/start", vec!["post"]),
        ("/api/credentials", vec!["get", "post"]),
        ("/api/credentials/{id}", vec!["patch", "delete"]),
        ("/api/log/ssh/events", vec!["get"]),
        ("/api/log/tunnels", vec!["get"]),
        ("/api/log/audit/verify", vec!["get"]),
        ("/.well-known/oauth-authorization-server", vec!["get"]),
        ("/api/oauth/authorize", vec!["get", "post"]),
        ("/api/oauth/authorize/preview", vec!["get"]),
        ("/api/oauth/token", vec!["post"]),
        ("/api/oauth/grants/{id}", vec!["get", "delete"]),
        ("/api/ai/sessions", vec!["get"]),
        ("/api/ai/sessions/{id}", vec!["delete"]),
        ("/api/ai/activity", vec!["get"]),
        ("/api/auth/mfa", vec!["get"]),
        ("/api/auth/client-ip-check", vec!["get"]),
        ("/api/site/health", vec!["get"]),
        ("/api/site/health/audit", vec!["get"]),
        ("/api/site/health/audit/reseal", vec!["post"]),
        ("/api/site/address-sources", vec!["get"]),
        ("/api/reverse/server/{id}/lan/hosts", vec!["get", "post"]),
        ("/api/reverse/server/{id}/lan/hosts/{host_id}", vec!["patch", "delete"]),
        ("/api/reverse/server/{id}/lan/scan", vec!["get", "post"]),
        ("/api/reverse/lan/topology", vec!["get"]),
        ("/api/reverse/server/{id}/terminal-profile", vec!["get", "put", "delete"]),
        ("/api/reverse/server/{id}/shell-history", vec!["get", "put"]),
        ("/api/user/terminal-schemes", vec!["get", "post"]),
        ("/api/user/terminal-schemes/{id}", vec!["patch", "delete"]),
        ("/api/auth/passkeys/{id}", vec!["patch", "delete"]),
        ("/api/user/users/{id}/mfa", vec!["delete"]),
    ] {
        let item = paths.get(path).unwrap_or_else(|| panic!("missing path {path}"));
        for verb in verbs {
            assert!(item.get(verb).is_some(), "{path} lacks {verb}");
        }
    }
    assert!(paths.len() >= 45, "only {} paths documented", paths.len());

    // 每個操作都有 tag；公開端點沒有 security，其餘要求 bearer。
    // Every operation is tagged; public ones carry no security, the rest require bearer.
    let public = ["/api/auth/setup-status", "/api/auth/sign-in-page", "/api/auth/token", "/api/auth/token/refresh", "/api/auth/logout", "/api/auth/token/verify", "/api/auth/register", "/api/auth/google/token", "/tunnels/server/script/one-time/{token}",
        "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/api/oauth/register", "/api/oauth/token", "/api/oauth/revoke", "/api/oauth/authorize/preview",
        "/api/auth/mfa/verify", "/api/auth/mfa/passkey/options", "/api/auth/passkey/options", "/api/auth/passkey/login",
        "/api/join/install.sh", "/api/join/telepy-ws.py", "/api/join/gateway", "/api/join/{token}", "/api/join/{token}/status", "/api/join/{token}/config", "/api/whoami"];
    for (path, item) in paths {
        for (verb, op) in item.as_object().unwrap() {
            assert!(op["tags"].as_array().map(|t| !t.is_empty()).unwrap_or(false), "{verb} {path} has no tag");
            let sec = &op["security"];
            if public.contains(&path.as_str()) {
                assert!(sec.is_null(), "{verb} {path} must be public");
            } else {
                assert_eq!(sec, &serde_json::json!([{"bearer": []}]), "{verb} {path}");
            }
        }
    }
    let schemes = &spec["components"]["securitySchemes"];
    assert_eq!(schemes["bearer"]["scheme"], "bearer");
    assert_eq!(schemes["bearer"]["bearerFormat"], "JWT");
    // 回應 schema 真的被收進 components。/ Response schemas actually land in components.
    assert!(spec["components"]["schemas"]["Tunnel"]["properties"]["reverse_port"].is_object());
    assert!(spec["components"]["schemas"]["Dashboard"]["properties"]["tunnels"].is_object());
    assert!(spec["components"]["schemas"]["DeviceKeys"]["properties"]["entries"].is_object());
    assert!(spec["components"]["schemas"]["UserKey"]["properties"]["fingerprint"].is_object());

    // 程式內的 openapi() 與 HTTP 端點給的是同一份。/ The in-process document equals the served one.
    let inproc: Value = serde_json::from_str(&telepy_server::app::openapi().to_json().unwrap()).unwrap();
    assert_eq!(inproc["paths"], spec["paths"]);
}

#[tokio::test]
async fn swagger_ui_page_is_served_behind_the_web_login() {
    let app = common::spawn().await;
    // 無斜線 → 導到有斜線（相對路徑的資產才找得到）。/ No slash → redirect so the relative asset URLs resolve.
    let r = app.get("/api/__hidden_swagger", None).await;
    assert_eq!(r.status, StatusCode::SEE_OTHER);
    assert_eq!(r.headers.get("location").unwrap(), "/api/__hidden_swagger/");

    // 頁殼本身不含任何 API 資訊；沒 token 時第一個 script 就導去 /login。
    // The shell holds no API information; without a stored token its first script redirects to /login.
    let r = app.get("/api/__hidden_swagger/", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.headers.get("content-type").unwrap().to_str().unwrap().starts_with("text/html"));
    assert!(r.text.contains(r#"location.replace("/login")"#), "{}", r.text);
    assert!(r.text.contains("swagger-initializer.js"));
    assert!(!r.text.contains("/api/reverse/"), "shell must not embed the spec");

    // 初始化腳本：先 verify/refresh 再載入規格，並把 Bearer 帶進每個請求。
    // Initializer: verify/refresh first, then load the spec with the Bearer header on every request.
    let r = app.get("/api/__hidden_swagger/swagger-initializer.js", None).await;
    assert_eq!(r.status, StatusCode::OK);
    for needle in ["/api/openapi.json", "/api/auth/token/verify", "/api/auth/token/refresh", "requestInterceptor", r#"location.replace(LOGIN)"#] {
        assert!(r.text.contains(needle), "initializer lacks {needle}");
    }

    // 靜態資產來自 vendored bundle；不存在的檔案 404。/ Assets come from the vendored bundle; unknown files 404.
    let r = app.get("/api/__hidden_swagger/swagger-ui-bundle.js", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.headers.get("content-type").unwrap().to_str().unwrap().contains("javascript"));
    let r = app.get("/api/__hidden_swagger/swagger-ui.css", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(app.get("/api/__hidden_swagger/nope.js", None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/__hidden_swagger/../openapi.json", None).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn openapi_can_be_disabled() {
    let mut app = common::spawn().await;
    let mut config = app.state.config.clone();
    config.openapi_enabled = Some(false);
    app.state = telepy_server::state::AppState::new(config, app.state.db.clone());
    app.router = telepy_server::app::build(app.state.clone());
    let token = app.login("admin", "pw").await;
    assert_eq!(app.get("/api/openapi.json", Some(&token)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/__hidden_swagger/", None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/__hidden_swagger/swagger-ui-bundle.js", None).await.status, StatusCode::NOT_FOUND);
    // 其餘 API 不受影響。/ The rest of the API is unaffected.
    assert_eq!(app.get("/api/auth/setup-status", None).await.status, StatusCode::OK);
}
