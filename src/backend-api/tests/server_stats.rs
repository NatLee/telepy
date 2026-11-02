//! `GET /api/site/health/stats`：只給管理員；24 小時分桶、帳號 / 隧道 / 儲存空間的計數對得上剛寫進去的東西。
//! The server stats endpoint: superusers only; the hourly buckets and the counts match what the test wrote.
mod common;

use axum::http::{header, StatusCode};
use serde_json::json;
use telepy_server::db;

#[tokio::test]
async fn server_stats_for_admins_only() {
    let app = common::spawn().await;
    let (admin, bob) = app.admin_and_user("admin", "bob").await;

    let r = app.get("/api/site/health/stats", Some(&bob)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")), "{}", r.text);

    // 一次失敗的登入與兩個閘道事件（一個算問題）。/ One failed sign-in and two gateway events (one a problem).
    let r = app.post("/api/auth/token", None, json!({"username": "bob", "password": "wrong"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.text);
    app.state.gateway.event("listening", None, None, None, "test listening".into()).await;
    app.state.gateway.event("invalid_user", None, None, None, "test invalid user".into()).await;
    // 一條從沒連上過的隧道。/ One tunnel that never connected.
    let admin_id = db::users::by_username(&app.state.db, "admin").await.unwrap().unwrap().id;
    db::tunnels::create(&app.state.db, db::tunnels::NewTunnel {
        user_id: admin_id,
        host_friendly_name: "stats-dev",
        key: "ssh-ed25519 AAAAstats",
        reverse_port: 41001,
        description: None,
        default_username_id: None,
    })
    .await
    .unwrap();

    let r = app.get("/api/site/health/stats", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
    let j = &r.json;

    let server = &j["server"];
    assert_eq!(server["version"], option_env!("TELEPY_VERSION").map(serde_json::Value::from).unwrap_or(serde_json::Value::Null));
    assert!(server["started_at"].as_str().unwrap().ends_with('Z'), "{}", r.text);
    assert!(server["now"].as_str().unwrap().ends_with('Z'), "{}", r.text);
    assert!(server["uptime_secs"].as_u64().is_some(), "{}", r.text);

    let a = &j["activity"];
    for key in ["hours", "gateway_events", "gateway_problems", "sign_ins", "sign_ins_failed", "api_calls", "api_errors"] {
        assert_eq!(a[key].as_array().map(Vec::len), Some(24), "{key}: {}", r.text);
    }
    let sum = |key: &str| a[key].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).sum::<i64>();
    // admin 與 bob 各登入一次 + bob 失敗一次。/ admin and bob signed in once each, bob failed once.
    assert_eq!(sum("sign_ins"), 3, "{}", r.text);
    assert_eq!(sum("sign_ins_failed"), 1, "{}", r.text);
    assert!(sum("gateway_events") >= 2, "{}", r.text);
    assert_eq!(sum("gateway_problems"), 1, "{}", r.text);
    assert_eq!(sum("api_calls"), 0, "{}", r.text);
    // 剛寫的都在最後一桶。/ Everything just written is in the last bucket.
    assert_eq!(a["sign_ins"][23], 3, "{}", r.text);
    assert_eq!(a["gateway_problems"][23], 1, "{}", r.text);
    assert!(a["hours"][0].as_str().unwrap() < a["hours"][23].as_str().unwrap());

    let users = &j["users"];
    assert_eq!((users["total"].as_i64(), users["active"].as_i64(), users["admins"].as_i64(), users["signed_in_24h"].as_i64()), (Some(2), Some(2), Some(1), Some(2)), "{}", r.text);

    let t = &j["tunnels"];
    let parts = ["online", "degraded", "offline", "never"].iter().map(|k| t[*k].as_i64().unwrap()).sum::<i64>();
    assert_eq!(t["total"].as_i64(), Some(parts), "{}", r.text);
    assert_eq!((t["total"].as_i64(), t["never"].as_i64()), (Some(1), Some(1)), "{}", r.text);

    assert_eq!((j["gateway"]["connections"].as_i64(), j["gateway"]["forwards"].as_i64()), (Some(0), Some(0)), "{}", r.text);
    assert_eq!(j["sessions"]["total"], 0, "{}", r.text);
    for kind in ["terminal", "files", "browser", "desktop", "rustdesk", "ssh", "watch", "ai"] {
        assert_eq!(j["sessions"]["by_kind"][kind], 0, "{kind}: {}", r.text);
    }

    let s = &j["storage"];
    assert!(s["db_bytes"].as_u64().unwrap() > 0, "{}", r.text);
    assert!(s["wal_bytes"].as_u64().is_some(), "{}", r.text);
    assert!(s["data_dir"]["total_bytes"].as_u64().unwrap() >= s["data_dir"]["free_bytes"].as_u64().unwrap(), "{}", r.text);
    assert_eq!(s["recordings_bytes"], 0, "{}", r.text);
    // 裝置載體與 IP / 廠商資料：沒有就是 0，放了檔案就算進去。/ Device carriers and IP / vendor data: 0 when empty, counted once present.
    for key in ["carriers_bytes", "geoip_bytes", "oui_bytes"] {
        assert_eq!(s[key], 0, "{key}: {}", r.text);
    }
    let config = &app.state.config;
    std::fs::create_dir_all(config.carrier_dir.join("x86_64-unknown-linux-musl")).unwrap();
    std::fs::write(config.carrier_dir.join("x86_64-unknown-linux-musl/telepy-carrier"), vec![0u8; 1500]).unwrap();
    std::fs::create_dir_all(&config.geoip_dir).unwrap();
    std::fs::write(config.geoip_dir.join("dbip-country-lite.mmdb"), vec![0u8; 700]).unwrap();
    std::fs::write(config.geoip_dir.join("dbip-asn-lite.mmdb"), vec![0u8; 300]).unwrap();
    std::fs::create_dir_all(&config.oui_dir).unwrap();
    std::fs::write(config.oui_dir.join("oui.csv"), vec![b'x'; 42]).unwrap();
    let r = app.get("/api/site/health/stats", Some(&admin)).await;
    let s = &r.json["storage"];
    assert_eq!((s["carriers_bytes"].as_u64(), s["geoip_bytes"].as_u64(), s["oui_bytes"].as_u64()), (Some(1500), Some(1000), Some(42)), "{}", r.text);
    for key in ["carriers_truncated", "geoip_truncated", "oui_truncated"] {
        assert_eq!(s[key], false, "{key}: {}", r.text);
    }
    assert_eq!(s["recordings_truncated"], false);
    // 閘道事件寫了 ssh-gateway.log 到 LOG_ROOT。/ The gateway events appended to LOG_ROOT's ssh-gateway.log.
    assert!(s["logs_bytes"].as_u64().is_some(), "{}", r.text);

    let w = &j["webhooks"];
    assert_eq!((w["total"].as_i64(), w["enabled"].as_i64(), w["paused"].as_i64(), w["failing_recent"].as_i64()), (Some(0), Some(0), Some(0), Some(0)), "{}", r.text);
}
