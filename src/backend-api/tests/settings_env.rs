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
    c.ssh_server_domain = None;
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
        ("server_ssh_host", json!("ssh.example.com/x y")),
        ("server_ssh_host", json!("-bad.example.com")),
        ("server_ssh_host", json!("fe80::1")),
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

const DEVICE_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4u5n7tS1kO6o4m3yQ0tYQd6v7Jc5Zq8Hh3n5Vt7Wk device-a";

fn kv(text: &str) -> std::collections::HashMap<String, String> {
    text.lines().filter_map(|l| l.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).rev().collect()
}

/// SSH 主機另外設：一鍵加入、腳本、筆電 SSH config 都改連它；known_hosts 別名（伺服器身分）照舊用網域，所以舊的
/// 設定與裝置不會被當成另一台 Telepy。`.env` 的 SSH_SERVER_DOMAIN 優先並鎖住欄位。
/// A separate SSH host: the join facts, scripts and the laptop's SSH config dial it; the known_hosts alias (the
/// server's identity) stays the domain. SSH_SERVER_DOMAIN in .env wins and locks the field.
#[tokio::test]
async fn a_separate_ssh_host_is_what_devices_and_laptops_dial() {
    let app = common::spawn_with(unset).await;
    let admin = app.login("admin", "pw").await;
    let r = app.get("/api/reverse/issue/token", Some(&admin)).await;
    let t = r.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/{t}"), Some(&admin), json!({"host_friendly_name": "box-a", "key": DEVICE_KEY, "ssh_port": 22})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let id = r.json["id"].as_i64().unwrap();
    app.post("/api/reverse/server/usernames", Some(&admin), json!({"reverse_server": id, "username": "ubuntu"})).await;

    // 沒設：跟網頁同一個名稱。/ Unset: the web's name.
    let m = kv(&app.get("/api/join/gateway", None).await.text);
    assert_eq!((m["GATEWAY_HOST"].as_str(), m["GATEWAY_ALIAS"].as_str()), ("telepy.test", "telepy-telepy.test-24242"));
    let r = app.get(&format!("/tunnels/server/config/{id}"), Some(&admin)).await;
    assert_eq!(r.json["server"]["host"], "telepy.test");

    let r = app.post("/api/site/settings", Some(&admin), json!({"server_ssh_host": " SSH.Telepy.test. "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["values"]["server_ssh_host"], "ssh.telepy.test");
    assert_eq!(r.json["env"]["server_ssh_host"], json!({"var": "SSH_SERVER_DOMAIN", "set": false, "value": null}));

    // 一鍵加入：連 SSH 主機，known_hosts 別名還是網域的。/ Join: dial the SSH host, alias still the domain's.
    let m = kv(&app.get("/api/join/gateway", None).await.text);
    assert_eq!((m["GATEWAY_HOST"].as_str(), m["GATEWAY_ALIAS"].as_str()), ("ssh.telepy.test", "telepy-telepy.test-24242"));
    // 筆電：HostName 換了，區塊名稱與 HostKeyAlias 不變。/ Laptop: new HostName, same block name and HostKeyAlias.
    let r = app.get(&format!("/tunnels/server/config/{id}"), Some(&admin)).await;
    let cfg = r.json["config"].as_str().unwrap();
    assert!(cfg.contains("Host telepy-telepy.test-24242\n") && cfg.contains("HostName ssh.telepy.test\n"), "{cfg}");
    assert_eq!((r.json["server"]["host"].as_str(), r.json["server"]["domain"].as_str()), (Some("ssh.telepy.test"), Some("telepy.test")));
    // 安裝腳本。/ Install scripts.
    let r = app.get(&format!("/tunnels/server/script/ssh/{id}/22"), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["script"].as_str().unwrap().contains("telepy@ssh.telepy.test"), "{}", r.text);

    // 檢查端點：管理員才能看。/ The check endpoint is admin-only.
    let r = app.get("/api/site/ssh-host", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["ssh"]["host"].as_str(), r.json["ssh"]["source"].as_str(), r.json["same"].as_bool()), (Some("ssh.telepy.test"), Some("setting"), Some(false)));
    assert_eq!(r.json["ssh"]["port"], "24242");
    assert_eq!(r.json["web"]["from"], "request");
    app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await;
    let bob = app.login("bob", "pw").await;
    let r = app.get("/api/site/ssh-host", Some(&bob)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")));
}

/// `.env` 的 SSH_SERVER_DOMAIN 優先：存不了，腳本用它。/ SSH_SERVER_DOMAIN in .env wins: no saving, scripts use it.
#[tokio::test]
async fn ssh_server_domain_in_env_locks_the_field() {
    let app = common::spawn_with(|c| {
        unset(c);
        c.ssh_server_domain = Some("ssh://Gate.telepy.test:24242/".into());
    })
    .await;
    let admin = app.login("admin", "pw").await;
    let r = app.get("/api/site/settings", Some(&admin)).await;
    assert_eq!(r.json["env"]["server_ssh_host"]["set"], true);
    let r = app.post("/api/site/settings", Some(&admin), json!({"server_ssh_host": "other.telepy.test"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["server_ssh_host"][0].as_str().unwrap().contains("SSH_SERVER_DOMAIN"), "{}", r.text);
    let m = kv(&app.get("/api/join/gateway", None).await.text);
    assert_eq!(m["GATEWAY_HOST"], "gate.telepy.test", "scheme, port and case tolerated in .env");
    let r = app.get("/api/site/ssh-host", Some(&admin)).await;
    assert_eq!(r.json["ssh"]["source"], "env");
}

/// 用 SSH 主機的名稱看網頁：登入被擋（421 + 正確的網址）、網頁的名稱照常；SSH 主機不能設成自己正在用的名稱；公開端點
/// 說出兩個名稱。沒有 PUBLIC_URL 就完全不擋。/ The web through the SSH host's name: sign-ins refused (421 + the right
/// address), the web host unaffected; the SSH host can't be the name you're browsing on; the public endpoint names both.
/// Without PUBLIC_URL nothing is blocked.
#[tokio::test]
async fn sign_ins_through_the_ssh_host_name_are_refused() {
    let app = common::spawn_with(|c| {
        unset(c);
        c.public_url = Some("https://telepy.test".into());
    })
    .await;
    let admin = app.login("admin", "pw").await;
    let login_via = |host: &'static str| {
        let app = &app;
        async move {
            let req = Request::post("/api/auth/token").header("x-forwarded-host", host).header("content-type", "application/json").body(Body::from(json!({"username": "admin", "password": "pw"}).to_string())).unwrap();
            app.send(req).await
        }
    };
    // 還沒設 SSH 主機：哪個名稱都能登入。/ No SSH host yet: any name signs in.
    assert_eq!(login_via("telepy-ssh.test").await.status, StatusCode::OK);

    // 設成自己正在用的名稱：拒絕。/ The name being used right now: refused.
    let req = Request::post("/api/site/settings").header("authorization", format!("Bearer {admin}")).header("x-forwarded-host", "ssh.telepy.test").header("content-type", "application/json").body(Body::from(json!({"server_ssh_host": "ssh.telepy.test"}).to_string())).unwrap();
    let r = app.send(req).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["server_ssh_host"][0].as_str().unwrap().contains("telepy.test"), "{}", r.text);
    // 從網頁的名稱設：可以。/ From the web's name: fine.
    let r = app.post("/api/site/settings", Some(&admin), json!({"server_ssh_host": "ssh.telepy.test"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    let r = login_via("ssh.telepy.test").await;
    assert_eq!(r.status, StatusCode::MISDIRECTED_REQUEST, "{}", r.text);
    assert_eq!((r.json["code"].as_str(), r.json["public_url"].as_str()), (Some("ssh_host"), Some("https://telepy.test")));
    assert_eq!(login_via("telepy.test").await.status, StatusCode::OK, "the web host still signs in");
    assert_eq!(login_via("Ssh.Telepy.Test:443").await.status, StatusCode::MISDIRECTED_REQUEST, "case and port ignored");
    // 其他請求不擋（已登入的頁面照常）。/ Other requests pass.
    let req = Request::get("/api/auth/user/profile").header("authorization", format!("Bearer {admin}")).header("x-forwarded-host", "ssh.telepy.test").body(Body::empty()).unwrap();
    assert_eq!(app.send(req).await.status, StatusCode::OK);
    let r = app.get("/api/auth/sign-in-page", None).await;
    assert_eq!((r.json["web_host"].as_str(), r.json["ssh_host"].as_str(), r.json["public_url"].as_str()), (Some("telepy.test"), Some("ssh.telepy.test"), Some("https://telepy.test")));

    // 沒有 PUBLIC_URL：不知道網頁在哪，完全不擋。/ No PUBLIC_URL: nowhere to send people, never blocked.
    let bare = common::spawn_with(unset).await;
    let a = bare.login("admin", "pw").await;
    assert_eq!(bare.post("/api/site/settings", Some(&a), json!({"server_ssh_host": "ssh.telepy.test"})).await.status, StatusCode::OK);
    let req = Request::post("/api/auth/token").header("x-forwarded-host", "ssh.telepy.test").header("content-type", "application/json").body(Body::from(json!({"username": "admin", "password": "pw"}).to_string())).unwrap();
    assert_eq!(bare.send(req).await.status, StatusCode::OK);
    assert!(bare.get("/api/auth/sign-in-page", None).await.json["web_host"].is_null());
}
