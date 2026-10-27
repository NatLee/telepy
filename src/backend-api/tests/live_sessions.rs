//! 即時 session：誰看得到（自己的、擁有 / ADMIN 的隧道上的、陌生人看不到）、結束一個網頁終端機（WebSocket 4009）
//! 與一條筆電經 gateway 的 ssh（真的被切斷，不用等它跑完），記一筆事件。
//! Live sessions: who sees what (your own, everything on tunnels you own / ADMIN, nothing for strangers), ending
//! a web terminal (WebSocket 4009) and a laptop's ssh through the gateway (really cut, not run to completion).
mod common;

use std::time::{Duration, Instant};

use axum::http::StatusCode;
use common::lab::{Hop, Lab, LabUser};
use serde_json::Value;

async fn sessions(lab: &Lab, user: &LabUser) -> Vec<Value> {
    let r = lab.app.get("/api/sessions", Some(&user.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["sessions"].as_array().unwrap().clone()
}

/// 等某種 session 出現，回它的 id。/ Wait for a session of `kind`; returns its id.
async fn wait_for(lab: &Lab, viewer: &LabUser, kind: &str) -> u64 {
    for _ in 0..100 {
        if let Some(s) = sessions(lab, viewer).await.iter().find(|s| s["kind"] == kind) {
            return s["id"].as_u64().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no {kind} session showed up");
}

#[tokio::test]
async fn live_sessions_can_be_seen_and_ended() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let dave = lab.user("dave").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service, &bob.key])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "admin", &[]).await;

    // bob 開一個網頁終端機。/ bob opens a web terminal.
    let mut term = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    term.expect("login:ubuntu@box").await;
    let id = wait_for(&lab, &alice, "terminal").await;

    // 誰看得到：owner、ADMIN sharee、bob 自己；dave 看不到也結束不了。/ Who sees it; dave neither sees nor ends it.
    let s = sessions(&lab, &alice).await;
    assert_eq!((s[0]["user"]["username"].as_str(), s[0]["tunnel"]["name"].as_str(), s[0]["mine"].as_bool()), (Some("bob"), Some("box"), Some(false)), "{s:?}");
    assert_eq!(sessions(&lab, &carol).await.len(), 1);
    assert_eq!(sessions(&lab, &bob).await[0]["mine"], true);
    assert!(sessions(&lab, &dave).await.is_empty());
    assert_eq!(lab.app.delete(&format!("/api/sessions/{id}"), Some(&dave.token)).await.status, StatusCode::NOT_FOUND);

    // 管理員：自己的清單只有自己的（他沒有隧道 = 空的），全站的要 `scope=all`（管理區）；非管理員要 = 403。
    // An admin's own list holds only their own (no tunnels = empty); everyone's needs `scope=all` (the admin
    // section); a non-admin asking for it gets 403.
    let r = lab.app.get("/api/sessions", Some(&lab.admin_token)).await;
    assert_eq!(r.json["sessions"], serde_json::json!([]), "{}", r.text);
    let r = lab.app.get("/api/sessions?scope=all", Some(&lab.admin_token)).await;
    assert_eq!(r.json["sessions"][0]["user"]["username"], "bob", "{}", r.text);
    let r = lab.app.get("/api/sessions?scope=all", Some(&dave.token)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")), "{}", r.text);

    // carol（ADMIN）結束它：bob 的終端機以 4009 關掉，清單上也沒了。/ carol ends it: 4009, and it leaves the list.
    assert_eq!(lab.app.delete(&format!("/api/sessions/{id}"), Some(&carol.token)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(term.wait_closed().await, Some(4009));
    for _ in 0..50 {
        if sessions(&lab, &alice).await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(sessions(&lab, &alice).await.is_empty());
    assert_eq!(lab.app.delete(&format!("/api/sessions/{id}"), Some(&carol.token)).await.status, StatusCode::NOT_FOUND, "already gone");

    // 筆電的 ssh（跑 20 秒的指令）：alice 中途結束，它馬上斷，不會跑完。/ A laptop ssh running 20 s is cut at once.
    let laptop = [(Hop::Tunnel(&dev), "ubuntu")];
    let started = Instant::now();
    let (run, _) = tokio::join!(lab.laptop_exec(&bob, &laptop, "sleep 20"), async {
        let id = wait_for(&lab, &alice, "ssh").await;
        let r = lab.app.delete(&format!("/api/sessions/{id}"), Some(&alice.token)).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    });
    assert!(!run.ok, "the laptop ssh must be cut: {run:?}");
    assert!(started.elapsed() < Duration::from_secs(15), "cut early, not after the command finished");

    // bob 可以結束自己的。/ bob may end his own.
    let mut term = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    term.expect("login:ubuntu@box").await;
    let id = wait_for(&lab, &bob, "terminal").await;
    assert_eq!(lab.app.delete(&format!("/api/sessions/{id}"), Some(&bob.token)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(term.wait_closed().await, Some(4009));

    // 每次結束都記一筆。/ Every end is logged.
    let events = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={}", dev.tunnel_id), Some(&alice.token)).await;
    let ended = events.json.as_array().unwrap().iter().filter(|e| e["event"] == "session_ended").count();
    assert_eq!(ended, 3, "{}", events.text);
}
