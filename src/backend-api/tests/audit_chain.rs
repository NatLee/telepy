//! `/api/log/audit/verify`：管理員才能驗；完整的鏈 ok，改過一列就指出哪一列；外部錨點檔一起檢查。
//! The audit verify endpoint: superusers only; an intact chain is ok, an edited row is reported, and the
//! anchors file outside the database is checked too.
mod common;

use axum::http::StatusCode;

use telepy_server::db::audit_chain;

#[tokio::test]
async fn verify_endpoint_reports_tampering_to_admins_only() {
    let app = common::spawn().await;
    let (admin, bob) = app.admin_and_user("admin", "bob").await;
    let gw = app.state.gateway.clone();
    for i in 0..5 {
        gw.event("accepted", None, None, None, format!("Accepted publickey #{i}")).await;
    }
    audit_chain::checkpoint_all(&app.state.db).await;
    let anchors = std::fs::read_to_string(app.audit_anchors_file()).unwrap();
    assert!(anchors.contains("\"table\":\"telepy_gateway_event\"") && anchors.contains("\"table\":\"telepy_sign_in_event\""), "{anchors}");

    let r = app.get("/api/log/audit/verify", Some(&bob)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    assert!(r.json["error"].is_string());
    assert_eq!(app.get("/api/log/audit/verify", None).await.status, StatusCode::UNAUTHORIZED);

    let r = app.get("/api/log/audit/verify", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["ok"], true, "{}", r.text);
    let tables = r.json["tables"].as_array().unwrap();
    assert_eq!(tables.len(), 3);
    let gw_report = &tables[0];
    assert_eq!(gw_report["table"], "telepy_gateway_event");
    assert_eq!(gw_report["checked"], 5);
    assert_eq!(gw_report["checkpoints_checked"], 1);
    // admin + bob 的登入各一筆（或更多）。/ Sign-ins of admin and bob.
    assert!(tables[1]["checked"].as_u64().unwrap() >= 2, "{}", r.text);

    sqlx::query("UPDATE telepy_gateway_event SET message = 'edited' WHERE id = 3").execute(&app.state.db.write).await.unwrap();
    let r = app.get("/api/log/audit/verify", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["ok"], false);
    assert_eq!(r.json["tables"][0]["ok"], false);
    assert_eq!(r.json["tables"][0]["broken_at"], 3);
    assert_eq!(r.json["tables"][0]["reason"], "hash_mismatch");
    assert_eq!(r.json["tables"][1]["ok"], true);
}
