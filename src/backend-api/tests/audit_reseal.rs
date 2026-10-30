//! 重新封存審計鏈（伺服器狀態頁）：只有管理員、要說明、只在 ✗ 時、指紋要對；封存後 ✓、紀錄在資料庫 / 錨點檔 / Logs，
//! 之後再改任何一列照樣變 ✗。
//! Re-sealing the audit chain from the Server health page: superusers only, a note is required, only while the
//! audit log fails and with the fingerprint the page showed; afterwards it passes, the re-seal is recorded in the
//! database, the anchors file and the Logs, and any later edit fails it again.
mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use telepy_server::db::audit_chain;

fn find<'a>(health: &'a Value, id: &str) -> &'a Value {
    health["checks"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("no check {id}: {health}"))
}

fn table<'a>(plan: &'a Value, name: &str) -> &'a Value {
    plan["tables"].as_array().unwrap().iter().find(|t| t["table"] == name).unwrap_or_else(|| panic!("no table {name}: {plan}"))
}

#[tokio::test]
async fn a_failing_audit_log_can_be_resealed_and_later_edits_still_show() {
    let app = common::spawn_with(|c| {
        c.guacd_addr = "127.0.0.1:1".into();
        c.kasm_api = "http://127.0.0.1:1".into();
    })
    .await;
    let (admin, bob) = app.admin_and_user("admin", "bob").await;
    let gw = app.state.gateway.clone();
    for i in 0..6 {
        gw.event("accepted", None, None, None, format!("Accepted publickey #{i}")).await;
    }
    audit_chain::checkpoint_all(&app.state.db).await;

    // 沒問題時不能封存。/ Nothing to re-seal while it passes.
    let plan = app.get("/api/site/health/audit", Some(&admin)).await;
    assert_eq!(plan.status, StatusCode::OK, "{}", plan.text);
    assert_eq!((plan.json["status"].as_str(), plan.json["can_reseal"].as_bool()), (Some("ok"), Some(false)), "{}", plan.text);
    assert_eq!(plan.json["anchors_file"], true);
    let ok_fp = plan.json["fingerprint"].as_str().unwrap().to_string();
    let r = app.post("/api/site/health/audit/reseal", Some(&admin), json!({"fingerprint": ok_fp, "note": "nothing"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("not_a_problem")), "{}", r.text);

    // 一列被改 + 一行舊資料庫的錨點（沒有 db）。/ One edited row plus a legacy anchors line of a previous database.
    let file = app.audit_anchors_file();
    let mut anchors = std::fs::read_to_string(&file).unwrap();
    anchors.push_str(&format!("{}\n", json!({"at": "2026-10-01T00:00:00Z", "table": "telepy_sign_in_event", "row_id": 1, "row_hash": "0".repeat(64)})));
    std::fs::write(&file, &anchors).unwrap();
    sqlx::query("UPDATE telepy_gateway_event SET message = 'edited' WHERE id = 3").execute(&app.state.db.write).await.unwrap();

    let health = app.get("/api/site/health", Some(&admin)).await;
    let audit = find(&health.json, "audit_log");
    assert_eq!(audit["status"], "fail", "{audit}");
    assert!(audit["detail"].as_str().unwrap().contains("re-seal"), "{audit}");
    let fp = audit["fingerprint"].as_str().unwrap().to_string();

    // 試算：只有管理員；每張表的問題、要重算幾列、作廢幾行。/ The dry run: admins only; per table problem, rows, lines.
    assert_eq!(app.get("/api/site/health/audit", Some(&bob)).await.status, StatusCode::FORBIDDEN);
    let plan = app.get("/api/site/health/audit", Some(&admin)).await;
    assert_eq!((plan.json["can_reseal"].as_bool(), plan.json["fingerprint"].as_str()), (Some(true), Some(fp.as_str())), "{}", plan.text);
    let g = table(&plan.json, "telepy_gateway_event");
    assert_eq!((g["ok"].as_bool(), g["from_row"].as_i64(), g["retire"].as_i64()), (Some(false), Some(3), Some(1)), "{g}");
    let gw_rows = g["rehash"].as_i64().unwrap();
    assert!(gw_rows >= 4, "{g}");
    assert!(g["problem"].as_str().unwrap().contains("row 3 (hash_mismatch)"), "{g}");
    let s = table(&plan.json, "telepy_sign_in_event");
    assert_eq!((s["ok"].as_bool(), s["rehash"].as_i64(), s["checkpoint_reason"].as_str()), (Some(false), Some(0), Some("checkpoint_mismatch")), "{s}");
    let a = table(&plan.json, "telepy_ai_audit_event");
    assert_eq!((a["ok"].as_bool(), a["problem"].as_str(), a["retire"].as_i64()), (Some(true), None, Some(0)), "{a}");

    // 不是管理員 / 沒說明 / 指紋不對。/ Not an admin, no note, a stale fingerprint.
    let r = app.post("/api/site/health/audit/reseal", Some(&bob), json!({"fingerprint": fp, "note": "x"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")), "{}", r.text);
    let r = app.post("/api/site/health/audit/reseal", Some(&admin), json!({"fingerprint": fp, "note": "  "})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["note"].is_array(), "{}", r.text);
    let r = app.post("/api/site/health/audit/reseal", Some(&admin), json!({"fingerprint": fp, "note": "x".repeat(501)})).await;
    assert!(r.json["note"].is_array(), "{}", r.text);
    let r = app.post("/api/site/health/audit/reseal", Some(&admin), json!({"fingerprint": "0000000000000000", "note": "restored"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::CONFLICT, Some("changed")), "{}", r.text);
    // 先確認過：封存之後確認自動消失。/ Acknowledged first: the acknowledgement goes once it passes.
    let r = app.post("/api/site/health/ack", Some(&admin), json!({"check_id": "audit_log", "fingerprint": fp, "note": "looking into it"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    // 封存。/ Re-seal.
    let note = "Database restored from the 28 Oct backup; the edited row was a test.";
    let r = app.post("/api/site/health/audit/reseal", Some(&admin), json!({"fingerprint": fp, "note": format!("  {note} ")})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let audit = find(&r.json, "audit_log");
    assert_eq!(audit["status"], "ok", "{audit}");
    assert!(audit["detail"].as_str().unwrap().contains("re-sealed") && audit["detail"].as_str().unwrap().contains("by admin"), "{audit}");
    assert!(audit["ack"].is_null() && audit["stale_ack"].is_null(), "{audit}");
    let done = r.json["resealed"].as_array().unwrap();
    assert_eq!(done.len(), 2, "{}", r.text);
    assert_eq!(done[0]["reseal_id"], done[1]["reseal_id"]);
    let gw_done = done.iter().find(|d| d["table"] == "telepy_gateway_event").unwrap();
    // 試算之後多了一列（確認的 health_ack 事件），也一起重算。/ One more row since the dry run (the health_ack event).
    assert_eq!((gw_done["rehashed"].as_i64(), gw_done["from_row"].as_i64(), gw_done["note"].as_str()), (Some(gw_rows + 1), Some(3), Some(note)), "{gw_done}");
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_health_ack").fetch_one(&app.state.db.read).await.unwrap();
    assert_eq!(left, 0);

    // 紀錄：錨點檔兩行 reseal、Logs 一筆 audit_reseal（寫在新鏈頭後面，鏈照樣完好）、試算的歷史。
    // The record: two reseal lines in the anchors file, one audit_reseal event (after the new head; the chain still
    // verifies) and the history in the dry run.
    let anchors = std::fs::read_to_string(&file).unwrap();
    let reseal_lines: Vec<Value> = anchors.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|l| l["reseal"].is_string()).collect();
    assert_eq!(reseal_lines.len(), 2, "{anchors}");
    assert!(reseal_lines.iter().all(|l| l["by"] == "admin" && l["note"] == note), "{anchors}");
    let msgs: Vec<String> = sqlx::query_scalar("SELECT message FROM telepy_gateway_event WHERE event = 'audit_reseal'").fetch_all(&app.state.db.read).await.unwrap();
    assert_eq!(msgs.len(), 1, "{msgs:?}");
    assert!(msgs[0].starts_with("admin re-sealed the audit log: "), "{}", msgs[0]);
    assert!(msgs[0].contains("telepy_gateway_event (was row 3 (hash_mismatch") && msgs[0].contains("rows re-hashed from row 3"), "{}", msgs[0]);
    assert!(msgs[0].contains("telepy_sign_in_event (was checkpoint at row 1 (checkpoint_mismatch); no rows re-hashed, 2 earlier checkpoints set aside)"), "{}", msgs[0]);
    assert!(msgs[0].ends_with(&format!("Note: {note}")), "{}", msgs[0]);
    let v = app.get("/api/log/audit/verify", Some(&admin)).await;
    assert_eq!(v.json["ok"], true, "{}", v.text);
    assert_eq!(v.json["tables"][0]["last_reseal"]["username"], "admin", "{}", v.text);
    assert_eq!(v.json["tables"][1]["checkpoints_retired"], 2, "{}", v.text);
    assert!(v.json["tables"][2]["last_reseal"].is_null(), "{}", v.text);
    let plan = app.get("/api/site/health/audit", Some(&admin)).await;
    assert_eq!((plan.json["status"].as_str(), plan.json["reseals"].as_array().map(Vec::len)), (Some("ok"), Some(2)), "{}", plan.text);

    // 之後再改一列（封存前的也算）：又變 ✗。/ A later edit — a row from before the re-seal included — fails it again.
    sqlx::query("UPDATE telepy_gateway_event SET message = 'edited again' WHERE id = 2").execute(&app.state.db.write).await.unwrap();
    let health = app.get("/api/site/health", Some(&admin)).await;
    assert_eq!(find(&health.json, "audit_log")["status"], "fail", "{}", health.text);
    let v = app.get("/api/log/audit/verify", Some(&admin)).await;
    assert_eq!((v.json["tables"][0]["chain_broken_at"].as_i64(), v.json["tables"][1]["ok"].as_bool()), (Some(2), Some(true)), "{}", v.text);
}
