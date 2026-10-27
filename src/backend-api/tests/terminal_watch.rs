//! 看別人的網頁終端機（common::lab）：看的人先拿到現在的畫面再收即時輸出、不能打字；被看的人看到提示；申請打字
//! → 允許 → 看的人的按鍵進同一個 shell（指令規則算在他頭上）→ 收回；owner 直接接手；誰不能看；即時 session 頁。
//! Watching a web terminal end to end: the watcher gets the current screen and then live output, cannot type; the
//! watched user is told; ask → allow → the watcher's keys reach the same shell (command rules attribute the line to
//! them) → revoke; the owner forces control; who may not watch; the live sessions page.
mod common;

use axum::http::StatusCode;
use common::lab::{Lab, MachineOpts};
use serde_json::{json, Value};
use telepy_server::presence::Kind;

fn watchers_with(v: &Value, f: impl Fn(&Value) -> bool) -> bool {
    v["type"] == "watchers" && v["watchers"].as_array().is_some_and(|l| l.iter().any(f))
}

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<Value> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().cloned().unwrap_or_default()
}

async fn wait_event(lab: &Lab, token: &str, tunnel_id: i64, kind: &str) -> Value {
    for _ in 0..100 {
        if let Some(e) = events(lab, token, tunnel_id).await.into_iter().rev().find(|e| e["event"] == kind) {
            return e;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("no {kind} event: {:?}", events(lab, token, tunnel_id).await);
}

#[tokio::test]
async fn watch_ask_to_type_and_take_back() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let bob = lab.user("bob").await; // VIEW sharee who uses the terminal
    let carol = lab.user("carol").await; // EDIT sharee: may not watch
    let boxm = lab.machine_with("box", &[("ubuntu", &[&lab.service])], MachineOpts { echo_shell: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "edit", &[ubuntu]).await;
    // sharee 的 `rm` 要擋；owner 的不擋。/ `rm` is blocked for sharees, not for the owner.
    let r = lab.app.post(&format!("/api/reverse/server/{}/command-rules", dev.tunnel_id), Some(&alice.token), json!({"action": "block", "pattern": "rm", "who": "sharees"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);

    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("bob's terminal");
    t.expect("login:ubuntu@box").await;
    t.input("echo hi\r").await;
    t.expect("ran:echo hi").await;
    let shell = t.shell_id();

    // 不能看：EDIT sharee、自己的 shell；不存在的 = 4015。/ Refused: an EDIT sharee, your own shell; unknown = 4015.
    assert_eq!(lab.watch(&carol, &shell).await.err(), Some(4004));
    assert_eq!(lab.watch(&bob, &shell).await.err(), Some(4004));
    assert_eq!(lab.watch(&alice, "nope").await.err(), Some(4015));

    let mut hub = lab.app.state.hub.subscribe_user(bob.id);
    let mut w = lab.watch(&alice, &shell).await.expect("alice watches");
    let first = w.expect_frame("the watch frame", |v| v["type"] == "watch").await;
    assert_eq!(first["user"]["username"], "bob", "{first}");
    assert_eq!(first["account"], "ubuntu");
    assert_eq!(first["can_force"], true, "the owner may take control");
    let me = first["you"].as_u64().unwrap();
    // 先是現在的畫面（之前的輸出也在），再來是即時的。/ The current screen first (earlier output included), then live.
    w.expect("ran:echo hi").await;
    t.expect("alice is watching this session.").await;
    t.expect_frame("bob's watchers state", |v| watchers_with(v, |x| x["username"] == "alice")).await;
    let note = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let m: Value = serde_json::from_str(&hub.recv().await.unwrap()).unwrap();
            if m["message"]["action"] == "TERMINAL-WATCHED" {
                return m["message"].clone();
            }
        }
    })
    .await
    .expect("TERMINAL-WATCHED");
    assert_eq!((note["by"].as_str(), note["watching"].as_bool()), (Some("alice"), Some(true)), "{note}");
    t.input("ls\r").await;
    w.expect("ran:ls").await;

    // 「使用中」：看的人是 kind watch；即時 session 頁給 alice「看」用的 shell 代號與誰在看。
    // Presence: the watcher is kind watch; the live sessions page gives alice the shell id and who watches.
    let p = lab.app.state.presence.for_tunnel(dev.tunnel_id);
    assert!(p.iter().any(|e| e.kind == Kind::Watch && e.username == "alice" && e.watching.as_ref().is_some_and(|x| x.username == "bob")), "{p:?}");
    let r = lab.app.get("/api/sessions", Some(&alice.token)).await;
    let list = r.json["sessions"].as_array().unwrap();
    let term = list.iter().find(|s| s["kind"] == "terminal").expect("bob's terminal");
    assert_eq!(term["shell_id"], shell.as_str(), "{}", r.text);
    assert_eq!(term["watched_by"], json!(["alice"]));
    let watch = list.iter().find(|s| s["kind"] == "watch").expect("alice's watch");
    assert_eq!(watch["watching"]["user"]["username"], "bob");
    let r = lab.app.get("/api/sessions", Some(&bob.token)).await;
    assert!(r.json["sessions"].as_array().unwrap().iter().all(|s| s["shell_id"].is_null()), "bob doesn't watch his own: {}", r.text);
    wait_event(&lab, &alice.token, dev.tunnel_id, "terminal_watch").await;

    // 沒有控制權：打的字不進 shell。/ Without control, input goes nowhere.
    w.send_json(json!({"action": "pty_input", "payload": {"input": "nope\r"}})).await;
    // 申請 → bob 看到 → 允許。/ Ask → bob sees it → allow.
    w.send_json(json!({"type": "control", "want": true})).await;
    t.expect("alice asks to type").await;
    t.expect_frame("the request", |v| watchers_with(v, |x| x["requested"] == true)).await;
    t.send_json(json!({"action": "watch_answer", "watcher": me, "allow": true})).await;
    w.expect_frame("control granted", |v| v["type"] == "watchers" && v["control"] == me).await;
    t.expect("alice can type in this session now.").await;
    // 看的人在打字：`rm` 算 alice 的（owner 不擋）。/ The watcher types: `rm` is alice's (not blocked for the owner).
    w.send_json(json!({"action": "pty_input", "payload": {"input": "rm -rf tmp\r"}})).await;
    t.expect("ran:rm -rf tmp").await;
    w.expect("ran:rm -rf tmp").await;
    wait_event(&lab, &alice.token, dev.tunnel_id, "terminal_control_granted").await;

    // 收回：之後 alice 打的不算；bob 自己的 `rm` 照樣被擋。/ Revoke: alice's input stops; bob's own `rm` is blocked again.
    t.send_json(json!({"action": "watch_revoke"})).await;
    w.expect_frame("control revoked", |v| v["type"] == "watchers" && v["control"].is_null()).await;
    w.send_json(json!({"action": "pty_input", "payload": {"input": "later2\r"}})).await;
    t.input("rm x\r").await;
    t.expect_notice("blocked").await;
    wait_event(&lab, &alice.token, dev.tunnel_id, "terminal_control_revoked").await;

    // owner 不問就接手。/ The owner forces control.
    w.send_json(json!({"type": "control", "force": true})).await;
    t.expect("alice took control of this session.").await;
    w.expect_frame("forced", |v| v["type"] == "watchers" && v["control"] == me).await;
    w.send_json(json!({"action": "pty_input", "payload": {"input": "pwd\r"}})).await;
    t.expect("ran:pwd").await;
    let ran = boxm.commands();
    assert!(!ran.iter().any(|c| c == "nope" || c == "later2" || c == "rm x"), "input without control never ran: {ran:?}");
    assert!(ran.contains(&"rm -rf tmp".to_string()) && ran.contains(&"pwd".to_string()), "{ran:?}");
    assert_eq!(boxm.ptys().len(), 1, "one shell: the watcher is not a separate login");

    // shell 結束：看的人 4015 `ended`；稽核記結束。/ The shell ends: the watcher gets 4015 `ended`; the audit records it.
    t.end().await;
    assert_eq!(w.wait_closed_reason().await, Some((4015, "ended".to_string())));
    let end = wait_event(&lab, &alice.token, dev.tunnel_id, "terminal_watch_end").await;
    assert!(end["message"].as_str().unwrap().contains("alice stopped watching bob's web terminal"), "{end}");
    for _ in 0..100 {
        if lab.app.state.presence.for_tunnel(dev.tunnel_id).is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(lab.app.state.presence.for_tunnel(dev.tunnel_id).is_empty());
}

/// 斷線保留中的 shell 也能看（看的人知道它斷線了）；從即時 session 頁結束這個觀看 = 4009，被看的人看到「停止觀看」。
/// A detached shell can be watched (the watcher sees it detached); ending the watch from the live sessions page = 4009.
#[tokio::test]
async fn watch_a_detached_shell_and_end_the_watch() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine_with("box", &[("ubuntu", &[&lab.service])], MachineOpts { echo_shell: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let r = lab.app.post("/api/user/settings", Some(&bob.token), json!({"terminal_detach_secs": 300})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    let shell = t.shell_id();
    t.input("later\r").await;
    let seen = t.offset;
    t.drop_connection();
    for _ in 0..100 {
        if lab.app.state.presence.for_tunnel(dev.tunnel_id).iter().any(|e| e.detached.is_some()) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let mut w = lab.watch(&alice, &shell).await.expect("watch a detached shell");
    let first = w.expect_frame("watch frame", |v| v["type"] == "watch").await;
    assert_eq!(first["detached"], true, "{first}");
    // `later` 在斷線期間回來，看的人照樣看到。/ `later` answers while detached; the watcher sees it.
    w.expect("ran:later").await;

    // 接回：看的人收到 detached false；被看的人的補送裡有「在看」那行。/ Resume: the watcher learns; the replay has the notice.
    let mut t2 = lab.terminal_with(&bob, &dev, "ubuntu", json!({"resume": shell, "offset": seen})).await.expect("resume");
    w.expect_frame("attached again", |v| v["type"] == "detached" && v["detached"] == false).await;
    t2.expect("alice is watching this session.").await;
    t2.expect_frame("watchers on reattach", |v| watchers_with(v, |x| x["username"] == "alice")).await;

    // bob 從即時 session 頁結束 alice 的觀看？不行（不是他的、他不管這條隧道）；alice 自己可以。
    // Bob can't end alice's watch (not his, not his tunnel to manage); alice can end her own.
    let id = lab.app.state.presence.for_tunnel(dev.tunnel_id).into_iter().find(|e| e.kind == Kind::Watch).expect("watch entry").id;
    let r = lab.app.delete(&format!("/api/sessions/{id}"), Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let r = lab.app.delete(&format!("/api/sessions/{id}"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    assert_eq!(w.wait_closed_reason().await.map(|c| c.0), Some(4009));
    t2.expect("alice stopped watching.").await;
    t2.end().await;
}
