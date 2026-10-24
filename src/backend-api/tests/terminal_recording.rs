//! 終端機錄影：只有 owner / ADMIN 能開關；開了之後網頁終端機會先告知、把輸出與視窗大小錄成 asciicast v2；誰看得到、
//! 誰能刪；保留天數到了會清掉；關掉之後不再錄。全部走真的裝置 sshd。
//! Terminal recording: only owner / ADMIN switch it; once on, the web terminal says so and output + resizes are
//! recorded as asciicast v2; who may see and delete; retention purges old ones; off stops recording.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::lab::{Lab, LabUser};
use serde_json::{json, Value};
use telepy_server::recording;

async fn recordings(lab: &Lab, user: &LabUser) -> Vec<Value> {
    let r = lab.app.get("/api/recordings", Some(&user.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["recordings"].as_array().unwrap().clone()
}

/// 等最新一筆錄完。/ Wait until the newest recording has ended.
async fn wait_finished(lab: &Lab, viewer: &LabUser) -> Value {
    for _ in 0..100 {
        if let Some(r) = recordings(lab, viewer).await.first().filter(|r| r["live"] == false) {
            return r.clone();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the recording never finished");
}

#[tokio::test]
async fn terminal_sessions_can_be_recorded() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let setting = format!("/api/reverse/server/{}/recording", dev.tunnel_id);

    // 只有 owner / ADMIN 能開。/ Only owner / ADMIN switch it on.
    assert_eq!(lab.app.put(&setting, Some(&bob.token), json!({"enabled": true})).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.put(&setting, Some(&alice.token), json!({"enabled": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let item = lab.app.get("/api/reverse/server/dashboard", Some(&bob.token)).await.json["tunnels"][0].clone();
    assert_eq!(item["record_sessions"], true);

    // bob 的終端機：先被告知，再錄。/ bob's terminal is told, then recorded.
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("This session is recorded").await;
    t.expect("login:ubuntu@box").await;
    t.resize(100, 30).await;
    t.input("echo hello-recording\r").await;
    t.expect("hello-recording").await;
    t.close().await;
    let rec = wait_finished(&lab, &alice).await;
    assert_eq!((rec["user"]["username"].as_str(), rec["os_user"].as_str(), rec["tunnel"]["name"].as_str()), (Some("bob"), Some("ubuntu"), Some("box")), "{rec}");
    assert!(rec["bytes"].as_i64().unwrap() > 0 && rec["can_delete"] == true, "{rec}");
    let id = rec["id"].as_i64().unwrap();

    // 檔案是 asciicast v2：檔頭、輸出事件、視窗大小事件；沒有鍵盤輸入事件。/ asciicast v2, no input events.
    let cast = lab.app.get(&format!("/api/recordings/{id}/cast"), Some(&alice.token)).await;
    assert_eq!(cast.status, StatusCode::OK);
    assert_eq!(cast.headers.get("content-type").unwrap(), "application/x-asciicast");
    let mut lines = cast.text.lines();
    let head: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    assert_eq!(head["version"], 2, "{head}");
    let events: Vec<Value> = lines.map(|l| serde_json::from_str(l).unwrap()).collect();
    assert!(events.iter().any(|e| e[1] == "o" && e[2].as_str().unwrap().contains("hello-recording")), "{}", cast.text);
    assert!(events.iter().any(|e| e[1] == "r" && e[2] == "100x30"), "{}", cast.text);
    assert!(events.iter().all(|e| e[1] == "o" || e[1] == "r"), "only output and resizes: {}", cast.text);
    assert!(events.windows(2).all(|w| w[0][0].as_f64() <= w[1][0].as_f64()), "times only go forward");

    // 誰看得到：bob 看得到自己的、carol 什麼都看不到；bob 不能刪。/ Who sees and deletes.
    assert_eq!(recordings(&lab, &bob).await.len(), 1);
    assert_eq!(recordings(&lab, &bob).await[0]["can_delete"], false);
    assert!(recordings(&lab, &carol).await.is_empty());
    assert_eq!(lab.app.get(&format!("/api/recordings/{id}/cast"), Some(&carol.token)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(lab.app.delete(&format!("/api/recordings/{id}"), Some(&bob.token)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(lab.app.delete(&format!("/api/recordings/{id}"), Some(&alice.token)).await.status, StatusCode::NO_CONTENT);
    assert!(recordings(&lab, &alice).await.is_empty());
    let dir = recording::root(&lab.app.state).join(dev.tunnel_id.to_string());
    assert_eq!(std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0), 0, "the file is gone too");

    // 保留天數：比保留期還舊的會被清掉。/ Retention purges recordings older than the setting.
    let t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.close().await;
    let rec = wait_finished(&lab, &alice).await;
    assert_eq!(recording::purge_expired(&lab.app.state).await.unwrap(), 0, "new recordings stay");
    sqlx::query("UPDATE telepy_terminal_recording SET started_at = '2000-01-01 00:00:00.000000' WHERE id = ?")
        .bind(rec["id"].as_i64().unwrap())
        .execute(&lab.app.state.db.write)
        .await
        .unwrap();
    assert_eq!(recording::purge_expired(&lab.app.state).await.unwrap(), 1);
    assert!(recordings(&lab, &alice).await.is_empty());

    // 關掉：不再告知、不再錄。/ Off: no notice, no recording.
    let r = lab.app.put(&setting, Some(&alice.token), json!({"enabled": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    t.close().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(recordings(&lab, &alice).await.is_empty(), "nothing recorded while off");
}
