//! API token 的呼叫紀錄、可呼叫端點目錄、用 token 管理區網主機。
//! - 每個 token 請求（讀取、寫入、被拒絕的）都進 `telepy_api_call`，存路由樣板；網頁登入的不記
//! - `GET /api/auth/tokens/calls`：預設只有自己的；`scope=all` 只給管理員（403 admin_only），`user_id` 要搭 `all`
//! - token 清單帶每把的呼叫摘要；`GET /api/auth/tokens/routes` 跟白名單一致
//! - 區網主機的新增 / 修改 / 刪除：`tunnels:manage`、隧道限制、EDIT 權限、「區網探索」功能
//!
//! The token call log, the endpoint catalogue and LAN host management with tokens.
mod common;

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};

use common::TestApp;

fn in_days(n: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::days(n)).to_rfc3339()
}

async fn token(app: &TestApp, web: &str, body: Value) -> (String, i64) {
    let r = app.post("/api/auth/tokens", Some(web), body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    (r.json["secret"].as_str().unwrap().to_string(), r.json["token"]["id"].as_i64().unwrap())
}

async fn tunnel(app: &TestApp, web: &str, name: &str, port: i64) -> i64 {
    let r = app.post("/api/reverse/server/keys", Some(web), json!({"host_friendly_name": name, "key": format!("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI{name} {name}"), "reverse_port": port})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    r.json["id"].as_i64().unwrap()
}

async fn calls(app: &TestApp, web: &str, query: &str) -> Vec<Value> {
    app.state.api_calls.flush().await;
    let r = app.get(&format!("/api/auth/tokens/calls{query}"), Some(web)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["calls"].as_array().unwrap().clone()
}

#[tokio::test]
async fn token_calls_are_logged_and_scoped() {
    let app = common::spawn().await;
    let (admin, bob) = app.admin_and_user("admin", "bob").await;
    let a = tunnel(&app, &admin, "boxa", 42001).await;
    let (read, read_id) = token(&app, &admin, json!({"name": "ci read", "scopes": ["tunnels:read"], "expires_at": in_days(30)})).await;

    // 網頁登入的呼叫不記；token 的讀取、被拒絕的寫入、白名單外的都記。/ Web calls aren't logged; token calls are, refusals too.
    app.get("/api/reverse/server/dashboard", Some(&admin)).await;
    assert_eq!(app.get("/api/reverse/server/dashboard", Some(&read)).await.status, StatusCode::OK);
    assert_eq!(app.get(&format!("/api/reverse/server/keys/{a}?secret=never-stored"), Some(&read)).await.status, StatusCode::OK);
    assert_eq!(app.request(Method::DELETE, &format!("/api/reverse/server/keys/{a}"), Some(&read), None).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get("/api/auth/tokens", Some(&read)).await.status, StatusCode::FORBIDDEN);
    // 用 token 讀呼叫紀錄 / 目錄：不行（token_route）。/ The log and the catalogue are web-only.
    for p in ["/api/auth/tokens/calls", "/api/auth/tokens/routes"] {
        let r = app.get(p, Some(&read)).await;
        assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("token_route")), "{p}");
    }

    let rows = calls(&app, &admin, "").await;
    let seen: Vec<(String, String, i64)> = rows.iter().map(|c| (c["method"].as_str().unwrap().to_string(), c["route"].as_str().unwrap().to_string(), c["status"].as_i64().unwrap())).collect();
    assert_eq!(rows.len(), 6, "{seen:?}");
    assert!(seen.contains(&("GET".into(), "/api/reverse/server/dashboard".into(), 200)), "{seen:?}");
    assert!(seen.contains(&("GET".into(), "/api/reverse/server/keys/{id}".into(), 200)), "route templates: {seen:?}");
    assert!(seen.contains(&("DELETE".into(), "/api/reverse/server/keys/{id}".into(), 403)), "{seen:?}");
    assert!(seen.contains(&("GET".into(), "/api/auth/tokens".into(), 403)), "{seen:?}");
    assert!(!serde_json::to_string(&rows).unwrap().contains("never-stored"), "no query strings");
    let row = rows.iter().find(|c| c["status"] == 200 && c["route"] == "/api/reverse/server/keys/{id}").unwrap();
    assert_eq!((row["token"]["id"].as_i64(), row["token"]["name"].as_str(), row["kind"].as_str()), (Some(read_id), Some("ci read"), Some("rest")));
    assert_eq!((row["tunnel"]["id"].as_i64(), row["tunnel"]["name"].as_str()), (Some(a), Some("boxa")));
    assert_eq!(row["user"]["username"], "admin");

    // 篩選：狀態、方法、token、往前翻頁。/ Filters and paging.
    assert_eq!(calls(&app, &admin, "?status=4xx").await.len(), 4);
    assert_eq!(calls(&app, &admin, "?status=ok").await.len(), 2);
    assert_eq!(calls(&app, &admin, "?method=delete").await.len(), 1);
    assert_eq!(calls(&app, &admin, &format!("?token_id={read_id}")).await.len(), 6);
    let page = calls(&app, &admin, "?limit=2").await;
    assert_eq!(page.len(), 2);
    let older = calls(&app, &admin, &format!("?limit=10&before={}", page[1]["id"])).await;
    assert_eq!(older.len(), 4);
    assert_eq!(app.get("/api/auth/tokens/calls?status=teapot", Some(&admin)).await.status, StatusCode::BAD_REQUEST);

    // token 清單的摘要。/ The per-token summary in the list.
    let list = app.get("/api/auth/tokens", Some(&admin)).await;
    let t = list.json.as_array().unwrap().iter().find(|t| t["id"] == read_id).unwrap().clone();
    assert_eq!((t["call_count"].as_i64(), t["calls"]["calls_24h"].as_i64(), t["calls"]["errors_7d"].as_i64()), (Some(6), Some(6), Some(4)), "{t}");
    assert!(t["calls"]["last_call_at"].is_string());

    // 範圍：一般人只看自己的；all 只給管理員；user_id 要搭 all。/ Scope rules.
    let (bob_tok, _) = token(&app, &bob, json!({"name": "bob ci", "scopes": ["tunnels:read"], "expires_at": in_days(3)})).await;
    app.get("/api/reverse/server/dashboard", Some(&bob_tok)).await;
    let mine = calls(&app, &bob, "").await;
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0]["user"]["username"], "bob");
    let r = app.get("/api/auth/tokens/calls?scope=all", Some(&bob)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")));
    let bob_id = mine[0]["user"]["id"].as_i64().unwrap();
    let admin_id = row["user"]["id"].as_i64().unwrap();
    assert_eq!(app.get(&format!("/api/auth/tokens/calls?user_id={admin_id}"), Some(&bob)).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(calls(&app, &admin, "").await.len(), 6, "an admin's own page is their own calls");
    assert_eq!(calls(&app, &admin, "?scope=all").await.len(), 7);
    let only_bob = calls(&app, &admin, &format!("?scope=all&user_id={bob_id}")).await;
    assert_eq!(only_bob.len(), 1);

    // bob 的 token 去碰 admin 的隧道（他看不到）：呼叫記下來，但隧道名稱不給 bob。/ A tunnel bob can't see stays nameless for him.
    app.get(&format!("/api/reverse/server/keys/{a}"), Some(&bob_tok)).await;
    let mine = calls(&app, &bob, "").await;
    let probe = mine.iter().find(|c| c["route"] == "/api/reverse/server/keys/{id}").unwrap();
    assert_eq!(probe["status"], 404);
    assert!(probe["tunnel"].is_null() || probe["tunnel"]["name"].is_null(), "{probe}");

    // 目錄：跟白名單一樣。/ The catalogue matches the allow-list.
    let r = app.get("/api/auth/tokens/routes", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["base_url"].is_string());
    let routes = r.json["routes"].as_array().unwrap();
    let find = |m: &str, p: &str| routes.iter().find(|x| x["method"] == m && x["path"] == p).cloned().unwrap_or_else(|| panic!("{m} {p}"));
    let lan = find("POST", "/api/reverse/server/{id}/lan/hosts");
    assert_eq!((lan["token"].as_bool(), lan["scope"].as_str(), lan["tunnel"].as_str(), lan["feature"].as_str()), (Some(true), Some("tunnels:manage"), Some("path"), Some("network")));
    assert_eq!(find("GET", "/api/browser/sessions/{id}/screenshot")["scope"], "browser:use");
    assert_eq!(find("POST", "/api/auth/tokens")["token"], false);
}

#[tokio::test]
async fn lan_hosts_with_tokens() {
    let app = common::spawn().await;
    let (admin, bob) = app.admin_and_user("admin", "bob").await;
    let a = tunnel(&app, &admin, "boxa", 42011).await;
    let b = tunnel(&app, &admin, "boxb", 42012).await;
    let (manage_a, _) = token(&app, &admin, json!({"name": "lan a", "scopes": ["tunnels:read", "tunnels:manage"], "tunnel_ids": [a], "expires_at": in_days(30)})).await;
    let (read, _) = token(&app, &admin, json!({"name": "read", "scopes": ["tunnels:read"], "expires_at": in_days(30)})).await;

    let r = app.post(&format!("/api/reverse/server/{a}/lan/hosts"), Some(&manage_a), json!({"address": "192.168.1.20", "label": "nas", "username": "pi", "ssh_port": 2222})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let host = r.json["id"].as_i64().unwrap();
    // 隧道限制外 → 404；只有 tunnels:read → token_scope。/ Outside the restriction → 404; read-only → token_scope.
    assert_eq!(app.post(&format!("/api/reverse/server/{b}/lan/hosts"), Some(&manage_a), json!({"address": "10.0.0.2"})).await.status, StatusCode::NOT_FOUND);
    let r = app.post(&format!("/api/reverse/server/{a}/lan/hosts"), Some(&read), json!({"address": "192.168.1.21"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("token_scope")));

    let r = app.patch(&format!("/api/reverse/server/{a}/lan/hosts/{host}"), Some(&manage_a), json!({"label": "storage"})).await;
    assert_eq!((r.status, r.json["label"].as_str()), (StatusCode::OK, Some("storage")), "{}", r.text);
    let r = app.get(&format!("/api/reverse/server/{a}/lan/hosts"), Some(&read)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    // 拓撲照 token 的隧道過濾。/ The topology follows the token's tunnels.
    let topo = app.get("/api/reverse/lan/topology", Some(&manage_a)).await;
    let ids: Vec<i64> = topo.json["tunnels"].as_array().unwrap().iter().map(|t| t["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![a]);
    assert_eq!(app.get("/api/reverse/lan/topology", Some(&read)).await.json["tunnels"].as_array().unwrap().len(), 2);

    // 跟網頁同一套權限：VIEW 分享的人用 manage token 也改不了。/ Same rules as the web: a VIEW sharee can't edit.
    let bob_id = app.get("/api/auth/user/profile", Some(&bob)).await.json["id"].as_i64().unwrap();
    let r = app.post(&format!("/tunnels/share/{a}"), Some(&admin), json!({"shared_with_user_id": bob_id, "permission_type": "view"})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let (bob_manage, _) = token(&app, &bob, json!({"name": "bob lan", "scopes": ["tunnels:read", "tunnels:manage"], "expires_at": in_days(3)})).await;
    assert_eq!(app.get(&format!("/api/reverse/server/{a}/lan/hosts"), Some(&bob_manage)).await.status, StatusCode::OK);
    assert_eq!(app.request(Method::DELETE, &format!("/api/reverse/server/{a}/lan/hosts/{host}"), Some(&bob_manage), None).await.status, StatusCode::FORBIDDEN);
    // 「區網探索」功能關掉 → feature_disabled。/ The network feature off → feature_disabled.
    let r = app.put("/api/access/grants", Some(&admin), json!({"subject": "user", "id": bob_id, "feature": "network", "value": "deny"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = app.get(&format!("/api/reverse/server/{a}/lan/hosts"), Some(&bob_manage)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("feature_disabled")), "{}", r.text);

    assert_eq!(app.request(Method::DELETE, &format!("/api/reverse/server/{a}/lan/hosts/{host}"), Some(&manage_a), None).await.status, StatusCode::NO_CONTENT);
    assert!(app.get(&format!("/api/reverse/server/{a}/lan/hosts"), Some(&read)).await.json["hosts"].as_array().unwrap().is_empty());
}
