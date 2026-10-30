//! 以前只能寫在 .env 的伺服器設定，現在也能在「網站設定 → 伺服器」改：環境變數有設就以它為準（欄位鎖住），沒設就看
//! 存的值，再沒有就是預設；存檔立即生效，不必重啟。
//! Server settings that used to live only in .env are editable under Site settings → Server: a set variable wins
//! (the field is locked), otherwise the saved value, otherwise the default; a save applies without a restart.
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;

use telepy_server::client_ip::Hops;

/// 帶著 X-Forwarded-For（與選用的 CF-Connecting-IP）問 /api/whoami。/ Ask /api/whoami with a crafted chain.
async fn whoami(app: &common::TestApp, xff: &str, cf: Option<&str>) -> String {
    let mut req = Request::get("/api/whoami").header("x-forwarded-for", xff);
    if let Some(cf) = cf {
        req = req.header("cf-connecting-ip", cf);
    }
    let r = app.send(req.body(Body::empty()).unwrap()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.text.trim().to_string()
}

/// 沒有任何伺服器設定的環境變數（開發者 shell 裡有設也不影響）。/ No server-setting variables, whatever the shell has.
fn unset(c: &mut telepy_server::config::Config) {
    c.trusted_proxy_hops = None;
    c.client_ip_header = None;
    c.device_probe = None;
    c.keep_shared_service_key = None;
    c.gateway_proxy_protocol_from = None;
    c.log_level = None;
    c.openapi_enabled = None;
    c.google_client_id = None;
    c.public_url = None;
}

#[tokio::test]
async fn a_saved_hop_count_applies_without_a_restart() {
    let app = common::spawn_with(unset).await;
    let admin = app.login("admin", "pw").await;

    let r = app.get("/api/site/settings", Some(&admin)).await;
    assert_eq!(r.json["values"]["client_ip_hops"], "auto");
    assert_eq!(r.json["env"]["client_ip_hops"], json!({"var": "TRUSTED_PROXY_HOPS", "set": false, "value": null}));
    assert!(r.json["env"].get("client_ip_cloudflare").is_none(), "no variable behind the Cloudflare mode");
    for (key, var) in telepy_server::server_settings::ENV_KEYS {
        assert_eq!(r.json["env"][key]["var"], *var);
        assert!(r.json["meta"][key]["label"].is_string(), "{key} has a label");
    }
    assert_eq!(r.json["meta"]["client_ip_cloudflare"]["type"], "choice");
    assert_eq!(r.json["meta"]["client_ip_cloudflare"]["choices"], json!(["auto", "always", "off"]));

    // auto：最右邊的公網位址（一個公網 IP 的代理被當成訪客）。/ auto: the rightmost public address.
    assert_eq!(whoami(&app, "198.51.100.7, 203.0.113.9", None).await, "203.0.113.9");
    let r = app.post("/api/site/settings", Some(&admin), json!({"client_ip_hops": " 1 "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["values"]["client_ip_hops"], "1");
    // 同一個 app、沒重啟：固定跳過一段。/ Same app, no restart: one entry skipped.
    assert_eq!(whoami(&app, "198.51.100.7, 203.0.113.9", None).await, "198.51.100.7");
    let r = app.get("/api/auth/client-ip-check", Some(&admin)).await;
    assert_eq!((r.json["hops_mode"].as_str(), r.json["trusted_proxy_hops"].as_i64()), (Some("fixed"), Some(1)), "{}", r.text);
    assert_eq!(r.json["sources"]["client_ip_hops"], "setting");

    // 指定的標頭也是存了就生效。/ The header too.
    let req = Request::get("/api/whoami").header("x-forwarded-for", "198.51.100.7").header("x-real-ip", "192.0.2.44");
    assert_eq!(app.send(req.body(Body::empty()).unwrap()).await.text.trim(), "198.51.100.7");
    app.post("/api/site/settings", Some(&admin), json!({"client_ip_header": "X-Real-IP"})).await;
    let req = Request::get("/api/whoami").header("x-forwarded-for", "198.51.100.7").header("x-real-ip", "192.0.2.44");
    assert_eq!(app.send(req.body(Body::empty()).unwrap()).await.text.trim(), "192.0.2.44");
}

#[tokio::test]
async fn a_set_variable_wins_and_locks_the_field() {
    let app = common::spawn_with(|c| {
        unset(c);
        c.trusted_proxy_hops = Some(Hops::Fixed(2));
        c.google_client_id = Some("env-client.apps.googleusercontent.com".into());
    })
    .await;
    let admin = app.login("admin", "pw").await;
    let r = app.get("/api/site/settings", Some(&admin)).await;
    assert_eq!(r.json["env"]["client_ip_hops"], json!({"var": "TRUSTED_PROXY_HOPS", "set": true, "value": "2"}));
    assert_eq!(r.json["env"]["server_public_url"], json!({"var": "PUBLIC_URL", "set": false, "value": null}));

    // 鎖住：拒絕、什麼都不存（同一個請求裡別的欄位也不存）。/ Locked: refused, nothing saved (not even the other field).
    let r = app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true, "client_ip_hops": "1"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!({"client_ip_hops": ["Set by TRUSTED_PROXY_HOPS in .env; remove it there to edit it here."]}));
    let r = app.get("/api/site/settings", Some(&admin)).await;
    assert_eq!((r.json["values"]["client_ip_hops"].as_str(), r.json["values"]["allow_registration"].as_bool()), (Some("auto"), Some(false)));
    let r = app.post("/api/site/settings", Some(&admin), json!({"server_google_client_id": "saved"})).await;
    assert_eq!(r.json, json!({"server_google_client_id": ["Set by SOCIAL_GOOGLE_CLIENT_ID in .env; remove it there to edit it here."]}));

    // 生效的值是環境變數的。/ The variable's value is in effect.
    assert_eq!(whoami(&app, "6.6.6.6, 198.51.100.7, 10.0.0.2", None).await, "6.6.6.6");
    let r = app.get("/api/auth/client-ip-check", Some(&admin)).await;
    assert_eq!(r.json["sources"]["client_ip_hops"], "env");
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["google_client_id"], "env-client.apps.googleusercontent.com");
}

#[tokio::test]
async fn the_google_client_id_follows_the_saved_setting() {
    let app = common::spawn_with(unset).await;
    let admin = app.login("admin", "pw").await;
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["google_client_id"], "");
    let r = app.post("/api/site/settings", Some(&admin), json!({"server_google_client_id": " 123-abc.apps.googleusercontent.com "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/auth/sign-in-page", None).await.json["google_client_id"], "123-abc.apps.googleusercontent.com");
    // 公開網址也是：OAuth issuer 立刻換。/ The public URL too: the OAuth issuer changes at once.
    let r = app.post("/api/site/settings", Some(&admin), json!({"server_public_url": "https://saved.example/"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["values"]["server_public_url"], "https://saved.example");
    assert_eq!(app.get("/.well-known/oauth-authorization-server", None).await.json["issuer"], "https://saved.example");
}

#[tokio::test]
async fn cloudflare_header_is_used_only_from_a_cloudflare_hop() {
    // 固定跳過 0 段（測試的請求沒有 socket 對端）：被選中的是 XFF 最右邊那段。
    // Skip nothing (test requests have no socket peer): the rightmost XFF entry is the chosen hop.
    let app = common::spawn_with(|c| {
        unset(c);
        c.trusted_proxy_hops = Some(Hops::Fixed(0));
    })
    .await;
    let admin = app.login("admin", "pw").await;

    // auto（預設）：最後一段是 Cloudflare 的位址 → 用 CF-Connecting-IP。/ auto: a Cloudflare hop → the header.
    assert_eq!(whoami(&app, "198.51.100.7, 104.16.1.1", Some("203.0.113.50")).await, "203.0.113.50");
    // 不是 Cloudflare 的位址送的標頭不算數。/ The header from anyone else doesn't count.
    assert_eq!(whoami(&app, "104.16.1.1, 198.51.100.7", Some("203.0.113.50")).await, "198.51.100.7");
    let req = Request::get("/api/auth/client-ip-check")
        .header("authorization", format!("Bearer {admin}"))
        .header("x-forwarded-for", "198.51.100.7, 104.16.1.1")
        .header("cf-connecting-ip", "203.0.113.50");
    let r = app.send(req.body(Body::empty()).unwrap()).await;
    assert_eq!(r.json["cloudflare"], json!({"mode": "auto", "header": "203.0.113.50", "edge_seen": true, "used": true}), "{}", r.text);
    assert_eq!((r.json["from"].as_str(), r.json["ip"].as_str()), (Some("cloudflare"), Some("203.0.113.50")));
    // 有標頭但看不到 Cloudflare：前面的代理換掉了它。/ Header but no Cloudflare hop: masked by a proxy in front.
    let req = Request::get("/api/auth/client-ip-check")
        .header("authorization", format!("Bearer {admin}"))
        .header("x-forwarded-for", "172.19.0.1")
        .header("cf-connecting-ip", "203.0.113.50");
    let r = app.send(req.body(Body::empty()).unwrap()).await;
    assert_eq!(r.json["hints"], json!(["cloudflare_masked"]), "{}", r.text);
    assert_eq!(r.json["cloudflare"]["edge_seen"], false);

    // off：不看。/ off: ignored.
    let r = app.post("/api/site/settings", Some(&admin), json!({"client_ip_cloudflare": "off"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(whoami(&app, "198.51.100.7, 104.16.1.1", Some("203.0.113.50")).await, "104.16.1.1");
    // always：有就用。/ always: whenever present.
    app.post("/api/site/settings", Some(&admin), json!({"client_ip_cloudflare": "Always"})).await;
    assert_eq!(whoami(&app, "104.16.1.1, 198.51.100.7", Some("203.0.113.50")).await, "203.0.113.50");
    assert_eq!(whoami(&app, "198.51.100.7", None).await, "198.51.100.7");
}

#[tokio::test]
async fn openapi_switches_off_per_request() {
    let app = common::spawn_with(unset).await;
    let admin = app.login("admin", "pw").await;
    assert_eq!(app.get("/api/openapi.json", Some(&admin)).await.status, StatusCode::OK);
    let r = app.post("/api/site/settings", Some(&admin), json!({"server_openapi_enabled": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/openapi.json", Some(&admin)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/__hidden_swagger/", None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/auth/setup-status", None).await.status, StatusCode::OK);
    app.post("/api/site/settings", Some(&admin), json!({"server_openapi_enabled": true})).await;
    assert_eq!(app.get("/api/openapi.json", Some(&admin)).await.status, StatusCode::OK);
    assert_eq!(app.get("/api/__hidden_swagger/", None).await.status, StatusCode::OK);
}

#[tokio::test]
async fn invalid_values_are_field_errors() {
    let app = common::spawn_with(unset).await;
    let admin = app.login("admin", "pw").await;
    for (key, value) in [
        ("client_ip_hops", json!("11")),
        ("client_ip_hops", json!("two")),
        ("client_ip_hops", json!("")),
        ("client_ip_header", json!("X Real IP")),
        ("client_ip_cloudflare", json!("sometimes")),
        ("server_gateway_proxy_protocol_from", json!("proxy.local")),
        ("server_gateway_proxy_protocol_from", json!("10.0.0.0/33")),
        ("server_log_level", json!("info,x=[")),
        ("server_public_url", json!("https://t.example.com/app")),
        ("server_public_url", json!("telepy.example.com")),
        ("server_google_client_id", json!("a b")),
        ("server_device_probe", json!("maybe")),
    ] {
        let r = app.post("/api/site/settings", Some(&admin), json!({ key: value })).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{key}={value}: {}", r.text);
        assert!(r.json[key][0].is_string(), "{key}={value}: {}", r.text);
    }
    // 合法的值會被整理後存下。/ Valid values are tidied and saved.
    let r = app
        .post(
            "/api/site/settings",
            Some(&admin),
            json!({"server_gateway_proxy_protocol_from": "10.0.0.5,  172.16.0.0/12", "server_log_level": "debug", "server_device_probe": false, "server_keep_shared_service_key": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["values"]["server_gateway_proxy_protocol_from"], "10.0.0.5, 172.16.0.0/12");
    let c = &app.state.config;
    assert!(!c.device_probe_on() && c.keep_shared_key());
    assert!(c.proxy_protocol_from().contains("172.16.3.4".parse().unwrap()));
    assert_eq!(c.log_level_effective(), "debug");
}
