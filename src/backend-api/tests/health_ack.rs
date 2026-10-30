//! 「伺服器狀態」的確認：只對同一個指紋有效、只能確認 ⚠ / ✗、要說明、只有管理員；寫入 / 移除都記 `health_ack` 事件。
//! Server health acknowledgements: tied to one fingerprint, only for warnings / failures, a note is required,
//! superusers only; adding and removing both write a `health_ack` gateway event.
mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

fn find<'a>(health: &'a Value, id: &str) -> &'a Value {
    health["checks"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("no check {id}: {health}"))
}

#[tokio::test]
async fn a_known_warning_can_be_acknowledged_until_it_changes() {
    // SECRET_KEY 沒設 = 一定是 ⚠；guacd / kasm 指到關著的埠，免得等 DNS。
    // An unset SECRET_KEY is reliably a warning; point guacd / kasm at closed ports so nothing waits on DNS.
    let app = common::spawn_with(|c| {
        c.secret_key_is_default = true;
        c.guacd_addr = "127.0.0.1:1".into();
        c.kasm_api = "http://127.0.0.1:1".into();
    })
    .await;
    let (admin, bob) = app.admin_and_user("admin", "bob").await;

    let r = app.get("/api/site/health", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["acknowledged"], 0, "{}", r.text);
    let secret = find(&r.json, "secret_key").clone();
    assert_eq!(secret["status"], "warn");
    let fp = secret["fingerprint"].as_str().unwrap().to_string();
    assert_eq!(fp.len(), 16);
    assert!(secret["ack"].is_null() && secret["stale_ack"].is_null(), "{secret}");
    // 沒變就同一個指紋。/ The same fingerprint while nothing changes.
    let again = app.get("/api/site/health", Some(&admin)).await;
    assert_eq!(find(&again.json, "secret_key")["fingerprint"], fp.as_str());
    let db_fp = find(&r.json, "database")["fingerprint"].as_str().unwrap().to_string();

    // 不是管理員。/ Not an admin.
    let r = app.post("/api/site/health/ack", Some(&bob), json!({"check_id": "secret_key", "fingerprint": fp, "note": "dev box"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")), "{}", r.text);
    assert_eq!(app.delete("/api/site/health/ack/secret_key", Some(&bob)).await.status, StatusCode::FORBIDDEN);

    // 說明必填、有上限。/ The note is required and bounded.
    let r = app.post("/api/site/health/ack", Some(&admin), json!({"check_id": "secret_key", "fingerprint": fp, "note": "   "})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["note"].is_array(), "{}", r.text);
    let r = app.post("/api/site/health/ack", Some(&admin), json!({"check_id": "secret_key", "fingerprint": fp, "note": "x".repeat(501)})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["note"].is_array(), "{}", r.text);

    // ✓ 的不能確認。/ A passing check cannot be acknowledged.
    let r = app.post("/api/site/health/ack", Some(&admin), json!({"check_id": "database", "fingerprint": db_fp, "note": "fine"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("not_a_problem")), "{}", r.text);
    let r = app.post("/api/site/health/ack", Some(&admin), json!({"check_id": "no_such_check", "fingerprint": "x", "note": "fine"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("not_a_problem")), "{}", r.text);

    // 指紋對不上 = 結果變了。/ A different fingerprint = the result changed.
    let r = app.post("/api/site/health/ack", Some(&admin), json!({"check_id": "secret_key", "fingerprint": "0000000000000000", "note": "dev box"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::CONFLICT, Some("changed")), "{}", r.text);

    // 確認。/ Acknowledge.
    let r = app.post("/api/site/health/ack", Some(&admin), json!({"check_id": "secret_key", "fingerprint": fp, "note": "  local dev box  "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let ack = &find(&r.json, "secret_key")["ack"];
    assert_eq!((ack["by"].as_str(), ack["note"].as_str()), (Some("admin"), Some("local dev box")), "{}", r.text);
    assert!(ack["at"].as_str().unwrap().ends_with('Z'), "{ack}");
    assert_eq!(r.json["acknowledged"], 1, "{}", r.text);
    // 原始筆數照舊（確認過的仍算 warnings）。/ Raw counts stay raw.
    assert!(r.json["warnings"].as_u64().unwrap() >= 1);

    let r = app.get("/api/site/health", Some(&admin)).await;
    assert_eq!(r.json["acknowledged"], 1, "{}", r.text);
    assert_eq!(find(&r.json, "secret_key")["ack"]["note"], "local dev box");
    assert!(find(&r.json, "secret_key")["stale_ack"].is_null());

    // 存著的指紋不再相符（問題變了）= stale_ack，不再算確認。/ A stored fingerprint that no longer matches = stale.
    sqlx::query("UPDATE telepy_health_ack SET fingerprint = 'feedfeedfeedfeed' WHERE check_id = 'secret_key'").execute(&app.state.db.write).await.unwrap();
    let r = app.get("/api/site/health", Some(&admin)).await;
    assert_eq!(r.json["acknowledged"], 0, "{}", r.text);
    assert!(find(&r.json, "secret_key")["ack"].is_null());
    assert_eq!(find(&r.json, "secret_key")["stale_ack"]["by"], "admin");

    // 移除。/ Remove it.
    let r = app.delete("/api/site/health/ack/secret_key", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(find(&r.json, "secret_key")["ack"].is_null() && find(&r.json, "secret_key")["stale_ack"].is_null());
    assert_eq!(r.json["acknowledged"], 0);
    let r = app.delete("/api/site/health/ack/secret_key", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);

    // 已經是 ✓ 的項目，存著的確認會被自動清掉。/ A stored ack of a passing check is removed automatically.
    sqlx::query("INSERT INTO telepy_health_ack (check_id, fingerprint, status, note, user_id, username, at) VALUES ('database', 'x', 'warn', 'old', 1, 'admin', '2026-10-30T00:00:00Z')")
        .execute(&app.state.db.write)
        .await
        .unwrap();
    let r = app.get("/api/site/health", Some(&admin)).await;
    assert!(find(&r.json, "database")["ack"].is_null() && find(&r.json, "database")["stale_ack"].is_null());
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_health_ack").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(left, 0);

    // 兩次都記成 health_ack 事件（不屬於任何隧道）。/ Both changes are tunnel-less `health_ack` events.
    let msgs: Vec<(String, Option<i64>)> =
        sqlx::query_as("SELECT message, tunnel_id FROM telepy_gateway_event WHERE event = 'health_ack' ORDER BY id").fetch_all(&app.state.db.read).await.unwrap();
    assert_eq!(msgs.len(), 2, "{msgs:?}");
    assert_eq!(msgs[0].0, "admin acknowledged \"SECRET_KEY\" (warn): local dev box");
    assert_eq!(msgs[1].0, "admin removed the acknowledgement of \"SECRET_KEY\"");
    assert!(msgs.iter().all(|m| m.1.is_none()));
    // 審計鏈照樣完好。/ The audit chain still verifies.
    let r = app.get("/api/site/health", Some(&admin)).await;
    assert_eq!(find(&r.json, "audit_log")["status"], "ok", "{}", r.text);
}
