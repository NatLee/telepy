//! 指令規則端到端（common::lab）：誰能改哪些規則、網頁終端機的擋下 / 等核准 / 拒絕 / 撤回 / 逾時，以及規則
//! 管不到的情況（沒打東西、全螢幕程式）。裝置是會回顯的假 shell，`Machine::commands` 是真的跑到 shell 的行。
//! Command rules end to end: who edits which rules, and the web terminal's block / hold / deny / withdraw / expiry.
//! The device is an echoing fake shell; `Machine::commands` lists the lines that really reached it.
mod common;

use axum::http::StatusCode;
use common::lab::{Device, Lab, LabUser, Machine, MachineOpts};
use serde_json::{json, Value};
use telepy_server::db;

async fn echo_device(lab: &Lab, owner: &LabUser) -> (Machine, Device) {
    let m = lab.machine_with("box", &[("ubuntu", &[&lab.service])], MachineOpts { echo_shell: true, ..Default::default() }).await;
    let dev = lab.device(owner, "box", &m).await;
    (m, dev)
}

async fn add_rule(lab: &Lab, token: &str, tunnel: Option<i64>, body: Value) -> Value {
    let path = match tunnel {
        Some(id) => format!("/api/reverse/server/{id}/command-rules"),
        None => "/api/command-rules".to_string(),
    };
    let r = lab.app.post(&path, Some(token), body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    r.json
}

/// 等某個通知（其他的——例如 presence——略過）；5 秒內沒有 = None。/ Wait for one notification kind (skipping others, e.g. presence).
async fn next_action(rx: &mut tokio::sync::broadcast::Receiver<telepy_server::hub::Msg>, action: &str) -> Option<Value> {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let m = rx.recv().await.ok()?;
            let m: Value = serde_json::from_str(&m).ok()?;
            if m["message"]["action"] == action {
                return Some(m["message"].clone());
            }
        }
    })
    .await
    .ok()
    .flatten()
}

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<String> {
    let r = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}&limit=500"), Some(token)).await;
    r.json.as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap_or_default().to_string()).collect()
}

#[tokio::test]
async fn rules_are_edited_by_admins_owners_and_admin_sharees() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let dave = lab.user("dave").await;
    let (_m, dev) = echo_device(&lab, &alice).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "admin", &[]).await;
    let tunnel = format!("/api/reverse/server/{}/command-rules", dev.tunnel_id);

    // 全站規則只有管理員能加。/ Only admins add site-wide rules.
    let r = lab.app.post("/api/command-rules", Some(&alice.token), json!({"action": "block", "pattern": "reboot"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let site = add_rule(&lab, &lab.admin_token, None, json!({"action": "block", "pattern": "reboot", "note": "Ask in #ops"})).await;
    assert_eq!(site["scope"], "site");
    assert_eq!(site["who"], "everyone");
    assert_eq!(site["via"], "all");
    let r = lab.app.get("/api/command-rules", Some(&bob.token)).await;
    assert_eq!(r.json["rules"][0]["pattern"], "reboot", "everyone can read the site-wide rules");
    assert_eq!(r.json["can_edit"], false);

    // 隧道規則：owner 與 ADMIN sharee 可以，VIEW 不行，看不到隧道的人 404。/ Owner and ADMIN yes, VIEW no, strangers 404.
    let r = lab.app.post(&tunnel, Some(&bob.token), json!({"action": "approve", "pattern": "sudo"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = lab.app.post(&tunnel, Some(&dave.token), json!({"action": "approve", "pattern": "sudo"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let sudo = add_rule(&lab, &carol.token, Some(dev.tunnel_id), json!({"action": "approve", "pattern": "sudo", "who": "sharees"})).await;
    let curl = add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "block", "kind": "regex", "pattern": r"curl .*\|\s*sh", "via": "agents"})).await;
    assert_eq!(curl["kind"], "regex");

    // 一模一樣的規則不能再加一次。/ The very same rule can't be added twice.
    let r = lab.app.post(&tunnel, Some(&alice.token), json!({"action": "approve", "pattern": "sudo", "who": "sharees"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["pattern"].is_array(), "{}", r.text);

    // 比對式要合法。/ Patterns are validated.
    for (body, field) in [
        (json!({"action": "block", "kind": "regex", "pattern": "("}), "pattern"),
        (json!({"action": "block", "pattern": "rm -rf; reboot"}), "pattern"),
        (json!({"action": "block", "pattern": ""}), "pattern"),
        (json!({"action": "nope", "pattern": "x"}), "action"),
        (json!({"action": "block", "pattern": "x", "who": "nobody"}), "who"),
        (json!({"action": "block", "pattern": "x", "via": "carrier pigeon"}), "via"),
    ] {
        let r = lab.app.post(&tunnel, Some(&alice.token), body.clone()).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}: {}", r.text);
        assert!(r.json[field].is_array(), "{body}: {}", r.text);
    }

    // 看得到隧道就看得到它的規則（加上全站的）。/ Anyone who sees the tunnel reads its rules plus the site-wide ones.
    let r = lab.app.get(&tunnel, Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["rules"].as_array().unwrap().len(), 2);
    assert_eq!(r.json["site_rules"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["can_edit"], false);
    assert_eq!(lab.app.get(&tunnel, Some(&dave.token)).await.status, StatusCode::NOT_FOUND);

    // 改 / 刪：同樣的權限。/ Changing and deleting follow the same rules.
    let rid = sudo["id"].as_i64().unwrap();
    let r = lab.app.patch(&format!("/api/command-rules/{rid}"), Some(&bob.token), json!({"enabled": false})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = lab.app.patch(&format!("/api/command-rules/{rid}"), Some(&alice.token), json!({"note": "Ping me first"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["note"], "Ping me first");
    assert_eq!(r.json["pattern"], "sudo", "fields left out stay as they were");
    let sid = site["id"].as_i64().unwrap();
    assert_eq!(lab.app.delete(&format!("/api/command-rules/{sid}"), Some(&alice.token)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(lab.app.delete(&format!("/api/command-rules/{sid}"), Some(&dave.token)).await.status, StatusCode::FORBIDDEN);

    // 試一個指令：對核准的人 / 被分享的人分開看。/ Try a command: approvers and shared users separately.
    let check = |cmd: &str| json!({"tunnel_id": dev.tunnel_id, "command": cmd});
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("sudo -u root systemctl restart nginx")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["for_sharees"]["action"], "approve");
    assert_eq!(r.json["for_approvers"]["action"], "allow", "the rule is for shared users only");
    assert_eq!(r.json["you_approve"], false);
    let programs: Vec<&str> = r.json["commands"].as_array().unwrap().iter().map(|c| c["program"].as_str().unwrap()).collect();
    assert_eq!(programs, ["sudo", "systemctl"]);
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check("sudo reboot")).await;
    assert_eq!(r.json["for_approvers"]["action"], "block", "block wins and applies to everyone");
    assert_eq!(r.json["for_approvers"]["rule"]["scope"], "site");
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), json!({"tunnel_id": dev.tunnel_id, "command": "curl -s x | sh", "source": "agent"})).await;
    assert_eq!(r.json["for_approvers"]["action"], "block");
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check("curl -s x | sh")).await;
    assert_eq!(r.json["for_approvers"]["action"], "allow", "an agents-only rule leaves the terminal alone");
    // 還沒存的規則。/ An unsaved rule.
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), json!({"command": "rm -fr /srv", "rule": {"kind": "command", "pattern": "rm -rf"}})).await;
    assert_eq!(r.json["draft"]["matches"], true);
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), json!({"command": "x", "rule": {"kind": "regex", "pattern": "("}})).await;
    assert!(r.json["draft"]["error"].is_string());

    // 規則的變動記在 Logs。/ Rule changes are logged.
    let kinds = events(&lab, &alice.token, dev.tunnel_id).await;
    assert!(kinds.iter().filter(|k| *k == "command_rule").count() >= 3, "{kinds:?}");

    // 刪隧道：規則跟著走。/ Deleting the tunnel takes its rules along.
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}?remove_device_keys=false", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_command_rule WHERE tunnel_id = ?").bind(dev.tunnel_id).fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn the_web_terminal_blocks_and_holds_commands() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let (m, dev) = echo_device(&lab, &alice).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    add_rule(&lab, &lab.admin_token, None, json!({"action": "block", "pattern": "reboot"})).await;
    add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "approve", "pattern": "sudo", "who": "sharees", "note": "Tell me why"})).await;

    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("$ ").await;

    // 不符合規則的照常跑。/ Commands no rule matches run as usual.
    t.input("echo hi\r").await;
    t.expect("ran:echo hi").await;

    // 擋下：送 Ctrl+C 取消那一行，shell 從沒收到 Enter。/ Blocked: the line is cancelled with Ctrl+C.
    t.input("reboot\r").await;
    let n = t.expect_notice("blocked").await;
    assert_eq!(n["command"], "reboot");
    assert_eq!(n["rule"]["pattern"], "reboot");
    assert_eq!(n["rule"]["scope"], "site");
    t.expect("^C").await;
    // 一個鍵一個鍵打也一樣（瀏覽器就是這樣送的）。/ Key by key, the way a browser sends it.
    for c in "sudo -i".chars().chain("\x7f\x7f\x7f reboot".chars()) {
        t.input(&c.to_string()).await;
    }
    t.input("\r").await;
    let n = t.expect_notice("blocked").await;
    assert_eq!(n["command"], "sudo reboot", "{n}");
    assert!(!m.commands().iter().any(|c| c.contains("reboot")), "{:?}", m.commands());

    // 要核准：停住，owner 看得到、bob 不能自己核准。/ Held for approval: alice sees it, bob can't approve it.
    t.notices.clear();
    t.input("sudo apt update\r").await;
    let n = t.expect_notice("pending").await;
    assert_eq!(n["can_decide"], false);
    assert_eq!(n["rule"]["note"], "Tell me why");
    let id = n["request"]["id"].as_i64().unwrap();
    assert!(!m.commands().contains(&"sudo apt update".to_string()));
    // 等的時候打的字丟掉（只認 Ctrl+C）。/ Keys typed while waiting are dropped (only Ctrl+C counts).
    t.input("x").await;
    let r = lab.app.get("/api/command-requests?status=pending", Some(&alice.token)).await;
    let req = r.json["requests"].as_array().unwrap().iter().find(|q| q["id"] == id).cloned().expect("alice sees the request");
    assert_eq!(req["can_decide"], true);
    assert_eq!(req["command"], "sudo apt update");
    assert_eq!(req["user"]["username"], "bob");
    assert_eq!(r.json["pending"], 1);
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&bob.token), json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let n = t.expect_notice("approved").await;
    assert_eq!(n["by"], "alice");
    t.expect("ran:sudo apt update").await;
    assert_eq!(m.commands().last().map(String::as_str), Some("sudo apt update"), "the dropped key never reached the line");
    let r = lab.app.post(&format!("/api/command-requests/{id}/deny"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "only the first decision counts");

    // 拒絕：取消那一行，附上原因。/ Denied: the line is cancelled, with the reason.
    t.input("sudo rm -rf /srv\r").await;
    let n = t.expect_notice("pending").await;
    let id = n["request"]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/command-requests/{id}/deny"), Some(&alice.token), json!({"reason": "not today"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let n = t.expect_notice("denied").await;
    assert_eq!(n["reason"], "not today");
    t.expect("^C").await;

    // Ctrl+C 撤回。/ Ctrl+C withdraws.
    t.notices.clear();
    t.input("sudo ls\r").await;
    let n = t.expect_notice("pending").await;
    let id = n["request"]["id"].as_i64().unwrap();
    t.input("\x03").await;
    t.expect_notice("cancelled").await;
    let r = lab.app.get("/api/command-requests", Some(&bob.token)).await;
    let mine = r.json["requests"].as_array().unwrap().iter().find(|q| q["id"] == id).cloned().unwrap();
    assert_eq!(mine["status"], "cancelled");
    assert!(!m.commands().iter().any(|c| c.contains("rm -rf") || c == "sudo ls"), "{:?}", m.commands());

    // owner：只管 sharee 的規則不管她；全站的「擋下」管所有人。/ The sharees-only rule skips the owner; the block applies to all.
    let mut own = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    own.expect("$ ").await;
    own.input("sudo ls\r").await;
    own.expect("ran:sudo ls").await;
    own.input("reboot\r").await;
    own.expect_notice("blocked").await;

    let kinds = events(&lab, &alice.token, dev.tunnel_id).await;
    for k in ["command_blocked", "command_held", "command_approved", "command_denied", "command_cancelled"] {
        assert!(kinds.iter().any(|e| e == k), "missing {k}: {kinds:?}");
    }
    // Logs 不寫指令本身（只有核准的人看得到完整指令）。/ The Logs leave the command itself out.
    let r = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={}&limit=500", dev.tunnel_id), Some(&bob.token)).await;
    assert!(!r.text.contains("apt update"), "{}", r.text);
}

#[tokio::test]
async fn requests_expire_and_end_with_the_terminal() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let (m, dev) = echo_device(&lab, &alice).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "approve", "pattern": "systemctl stop"})).await;

    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("$ ").await;
    // 沒打東西的 Enter、不在規則裡的子指令照常。/ An empty Enter and other subcommands go through.
    t.input("\r").await;
    t.input("systemctl status nginx\r").await;
    t.expect("ran:systemctl status nginx").await;

    // 逾時沒人回應 = 取消。/ Nobody answers in time: cancelled.
    t.input("systemctl --now stop nginx\r").await;
    let n = t.expect_notice("pending").await;
    let id = n["request"]["id"].as_i64().unwrap();
    assert!(n["request"]["expires_at"].is_string());
    sqlx::query("UPDATE telepy_command_event SET expires_at = '2000-01-01 00:00:00.000000' WHERE id = ?").bind(id).execute(&lab.app.state.db.write).await.unwrap();
    telepy_server::command_rules::expire_due(&lab.app.state).await;
    t.expect_notice("expired").await;
    t.expect("^C").await;

    // 等的時候關掉終端機 = 撤回。/ Closing the terminal while waiting withdraws the request.
    t.input("systemctl stop nginx\r").await;
    let n = t.expect_notice("pending").await;
    let id = n["request"]["id"].as_i64().unwrap();
    t.close().await;
    let mut status = String::new();
    for _ in 0..50 {
        let r = lab.app.get("/api/command-requests", Some(&alice.token)).await;
        status = r.json["requests"].as_array().unwrap().iter().find(|q| q["id"] == id).map(|q| q["status"].as_str().unwrap().to_string()).unwrap_or_default();
        if status != "pending" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(status, "cancelled");
    assert!(!m.commands().iter().any(|c| c.contains("stop")), "{:?}", m.commands());
}

/// 允許規則（只豁免同範圍）與規則自己指定的核准人：隧道規則指定 ADMIN sharee 之後 owner 不能決定；全站規則指定一位
/// 沒有任何隧道的管理員，他就能在別人的隧道上核准。
/// Allow rules (same scope only) and per-rule approvers: once a tunnel rule names an ADMIN sharee the owner can't
/// decide; a site rule naming a superuser who owns no tunnel lets that admin approve on anyone's tunnel.
#[tokio::test]
async fn allow_rules_and_named_approvers() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let admin = db::users::by_username(&lab.app.state.db, "admin").await.unwrap().expect("lab admin");
    assert!(admin.is_superuser);
    let (m, dev) = echo_device(&lab, &alice).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "admin", &[]).await;
    let tunnel = format!("/api/reverse/server/{}/command-rules", dev.tunnel_id);
    let check = |cmd: &str| json!({"tunnel_id": dev.tunnel_id, "command": cmd});

    // ---- 允許規則 / allow rules
    let site_block = add_rule(&lab, &lab.admin_token, None, json!({"action": "block", "pattern": "rm -rf"})).await;
    assert_eq!(site_block["approver_ids"], json!([]));
    // 隧道的允許蓋不過全站的擋下。/ A tunnel allow never beats a site-wide block.
    let tunnel_allow = add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "allow", "pattern": "rm -rf /tmp/build/*"})).await;
    assert_eq!(tunnel_allow["action"], "allow");
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["for_approvers"]["action"], "block", "{}", r.text);
    assert_eq!(r.json["for_approvers"]["tunnel"]["allowed_by"]["pattern"], "rm -rf /tmp/build/*");
    assert_eq!(r.json["for_approvers"]["tunnel"]["exempted"], false);
    assert!(r.json["for_approvers"]["allowed_by"].is_null());
    // 全站的允許才豁免全站的擋下，而且說得出是哪一條。/ A site allow exempts the site block, and is named.
    let site_allow = add_rule(&lab, &lab.admin_token, None, json!({"action": "allow", "pattern": "rm -rf /tmp/build/*", "note": "build scratch"})).await;
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.json["for_sharees"]["action"], "allow", "{}", r.text);
    assert_eq!(r.json["for_sharees"]["allowed_by"]["id"], site_allow["id"]);
    assert_eq!(r.json["for_sharees"]["site"]["exempted"], true);
    assert_eq!(r.json["for_sharees"]["site"]["hit"]["id"], site_block["id"], "the exempted rule is still reported");
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /srv")).await;
    assert_eq!(r.json["for_sharees"]["action"], "block", "outside the exception the block holds");
    // 隧道的允許也豁免隧道自己的「要核准」（同範圍）。/ The tunnel allow exempts the tunnel's own approve rule too (same scope).
    add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "approve", "pattern": "rm", "who": "sharees"})).await;
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.json["for_sharees"]["action"], "allow", "{}", r.text);
    assert_eq!(r.json["for_sharees"]["tunnel"]["exempted"], true);
    // 隧道的允許關掉：全站的允許蓋不過隧道自己的「要核准」。/ Tunnel allow off: a site allow never beats the tunnel's approve rule.
    let r = lab.app.patch(&format!("/api/command-rules/{}", tunnel_allow["id"]), Some(&alice.token), json!({"enabled": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.json["for_sharees"]["action"], "approve", "{}", r.text);
    assert_eq!(r.json["for_sharees"]["rule"]["scope"], "tunnel");
    assert_eq!(r.json["for_sharees"]["site"]["exempted"], true);
    assert_eq!(r.json["for_sharees"]["approvers"]["default"], true);
    let names: Vec<&str> = r.json["for_sharees"]["approvers"]["users"].as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect();
    assert_eq!(names, ["alice", "carol"], "default approvers = owner + ADMIN sharees");
    assert_eq!(r.json["for_approvers"]["action"], "allow", "the sharees-only approve rule skips the owner");
    // 終端機：被豁免的指令真的跑了，沒有紀錄。/ In the terminal the exempted command really runs, unrecorded.
    let mut own = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    own.expect("$ ").await;
    own.input("rm -rf /tmp/build/x\r").await;
    own.expect("ran:rm -rf /tmp/build/x").await;
    own.input("rm -rf /srv\r").await;
    own.expect_notice("blocked").await;
    assert!(!m.commands().iter().any(|c| c == "rm -rf /srv"), "{:?}", m.commands());
    own.close().await;
    let r = lab.app.get("/api/command-requests", Some(&alice.token)).await;
    assert!(r.json["requests"].as_array().unwrap().iter().all(|q| q["command"] != "rm -rf /tmp/build/x"), "allowed commands are not recorded");

    // ---- 核准人 / named approvers
    // 隧道規則只能指定 owner / ADMIN sharee / 管理員。/ A tunnel rule may only name the owner, ADMIN sharees or admins.
    let r = lab.app.post(&tunnel, Some(&alice.token), json!({"action": "approve", "pattern": "sudo", "approver_ids": [bob.id]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["approver_ids"].is_array(), "{}", r.text);
    let r = lab.app.post(&tunnel, Some(&alice.token), json!({"action": "approve", "pattern": "sudo", "approver_ids": "carol"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.get(&tunnel, Some(&alice.token)).await;
    let candidates: Vec<i64> = r.json["approver_candidates"].as_array().unwrap().iter().map(|u| u["id"].as_i64().unwrap()).collect();
    assert_eq!(candidates, [alice.id, carol.id].into_iter().collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>());
    assert_eq!(lab.app.get(&tunnel, Some(&bob.token)).await.json["approver_candidates"], json!([]), "only editors get the candidates");
    // 擋下 / 允許規則不留核准人。/ Block / allow rules keep no approvers.
    let r = lab.app.post(&tunnel, Some(&alice.token), json!({"action": "block", "pattern": "mkfs*", "approver_ids": [carol.id]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.json["approver_ids"], json!([]));

    // carol（ADMIN sharee）是唯一的核准人：owner 不能決定。/ carol is the only approver: the owner can't decide.
    let sudo = add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "approve", "pattern": "sudo", "approver_ids": [carol.id]})).await;
    assert_eq!(sudo["approver_ids"], json!([carol.id]));
    assert_eq!(sudo["approvers"][0]["username"], "carol");
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check("sudo ls")).await;
    assert_eq!(r.json["for_approvers"]["approvers"]["default"], false);
    assert_eq!(r.json["for_approvers"]["approvers"]["users"][0]["username"], "carol");
    let mut alice_rx = lab.app.state.hub.subscribe_user(alice.id);
    let mut carol_rx = lab.app.state.hub.subscribe_user(carol.id);
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("$ ").await;
    t.input("sudo ls\r").await;
    let n = t.expect_notice("pending").await;
    assert_eq!(n["can_decide"], false);
    assert_eq!(n["rule"]["approver_ids"], json!([carol.id]));
    assert_eq!(n["request"]["rule"]["approver_ids"], json!([carol.id]), "the snapshot keeps who could decide");
    let id = n["request"]["id"].as_i64().unwrap();
    let requested = next_action(&mut carol_rx, "COMMAND-APPROVAL-REQUESTED").await.expect("carol is asked");
    assert_eq!(requested["approver_ids"], json!([carol.id]));
    // owner 只收到 presence 之類的，沒有這筆申請。/ The owner gets presence and the like, not this request.
    while let Ok(m) = alice_rx.try_recv() {
        let m: Value = serde_json::from_str(&m).unwrap();
        assert_ne!(m["message"]["action"], "COMMAND-APPROVAL-REQUESTED", "the owner is not asked");
    }
    let r = lab.app.get("/api/command-requests?status=pending", Some(&alice.token)).await;
    let req = r.json["requests"].as_array().unwrap().iter().find(|q| q["id"] == id).cloned().expect("the owner still sees it");
    assert_eq!(req["can_decide"], false);
    assert_eq!(r.json["pending"], 0);
    let r = lab.app.get("/api/command-requests?status=pending", Some(&carol.token)).await;
    assert_eq!(r.json["requests"][0]["can_decide"], true);
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    assert_eq!(r.json["code"], "not_approver");
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&carol.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let n = t.expect_notice("approved").await;
    assert_eq!(n["by"], "carol");
    t.expect("ran:sudo ls").await;

    // carol 自己打的 sudo：她在名單裡，橫幅可以自己按。/ carol's own sudo: she is on the list, so she can run it herself.
    let mut ct = lab.terminal(&carol, &dev, "ubuntu").await.expect("terminal");
    ct.expect("$ ").await;
    ct.input("sudo whoami\r").await;
    let n = ct.expect_notice("pending").await;
    assert_eq!(n["can_decide"], true);
    ct.input("\x03").await;
    ct.expect_notice("cancelled").await;
    ct.close().await;

    // 改回預設：owner 又能決定了。/ Back to the default: the owner decides again.
    let rid = sudo["id"].as_i64().unwrap();
    let r = lab.app.patch(&format!("/api/command-rules/{rid}"), Some(&alice.token), json!({"approver_ids": null})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["approver_ids"], json!([]));
    t.input("sudo id\r").await;
    let n = t.expect_notice("pending").await;
    let id = n["request"]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(t.expect_notice("approved").await["by"], "alice");
    t.expect("ran:sudo id").await;

    // 全站規則指定一位沒有隧道的管理員：他能在 alice 的隧道上核准，owner 不能。
    // A site rule naming a superuser who owns no tunnel: the admin approves on alice's tunnel, the owner can't.
    let r = lab.app.post("/api/command-rules", Some(&lab.admin_token), json!({"action": "approve", "pattern": "reboot", "approver_ids": [admin.id, 999_999]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "unknown users are refused: {}", r.text);
    // dave 跟這條隧道毫無關係，但全站規則點名他。/ dave has nothing to do with the tunnel, but the site rule names him.
    let dave = lab.user("dave").await;
    let reboot = add_rule(&lab, &lab.admin_token, None, json!({"action": "approve", "pattern": "reboot", "approver_ids": [admin.id, dave.id]})).await;
    assert_eq!(reboot["approvers"][0]["username"], "admin");
    assert_eq!(reboot["approvers"][1]["username"], "dave");
    let r = lab.app.get("/api/command-rules", Some(&lab.admin_token)).await;
    assert!(r.json["approver_candidates"].as_array().unwrap().len() >= 4, "{}", r.text);
    assert_eq!(lab.app.get("/api/command-rules", Some(&bob.token)).await.json["approver_candidates"], json!([]));
    let mut admin_rx = lab.app.state.hub.subscribe_user(admin.id);
    t.input("reboot\r").await;
    let n = t.expect_notice("pending").await;
    assert_eq!(n["rule"]["scope"], "site");
    assert_eq!(n["request"]["rule"]["approver_ids"], json!([admin.id, dave.id]));
    let id = n["request"]["id"].as_i64().unwrap();
    let requested = next_action(&mut admin_rx, "COMMAND-APPROVAL-REQUESTED").await.expect("the admin is asked");
    assert_eq!(requested["approver_ids"], json!([admin.id, dave.id]));
    // dave 看不到隧道，但看得到（也能決定）這筆申請。/ dave can't see the tunnel, yet sees and decides this request.
    let r = lab.app.get("/api/command-requests?status=pending", Some(&dave.token)).await;
    assert_eq!(r.json["requests"].as_array().unwrap().len(), 1, "{}", r.text);
    assert_eq!(r.json["requests"][0]["id"], id);
    assert_eq!(r.json["requests"][0]["can_decide"], true);
    assert_eq!(r.json["requests"][0]["tunnel_name"], "box");
    assert_eq!(r.json["pending"], 1);
    assert_eq!(lab.app.get(&format!("/api/reverse/server/{}/command-rules", dev.tunnel_id), Some(&dave.token)).await.status, StatusCode::NOT_FOUND);
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&carol.token), json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = lab.app.get("/api/command-requests?status=pending", Some(&lab.admin_token)).await;
    assert_eq!(r.json["requests"][0]["can_decide"], true, "{}", r.text);
    assert_eq!(r.json["pending"], 1);
    let r = lab.app.post(&format!("/api/command-requests/{id}/deny"), Some(&lab.admin_token), json!({"reason": "not during the demo"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let n = t.expect_notice("denied").await;
    assert_eq!(n["by"], "admin");
    assert_eq!(n["reason"], "not during the demo");
    t.input("reboot now\r").await;
    let n = t.expect_notice("pending").await;
    let id2 = n["request"]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/command-requests/{id2}/approve"), Some(&dave.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let n = t.expect_notice("approved").await;
    assert_eq!(n["by"], "dave");
    t.expect("ran:reboot now").await;
    // 歷史裡的規則快照帶著核准人。/ The history's rule snapshot carries the approvers.
    let r = lab.app.get(&format!("/api/command-requests?tunnel_id={}", dev.tunnel_id), Some(&alice.token)).await;
    let row = r.json["requests"].as_array().unwrap().iter().find(|q| q["id"] == id).cloned().unwrap();
    assert_eq!(row["rule"]["approver_ids"], json!([admin.id, dave.id]));
    assert_eq!(row["status"], "denied");
    let kinds = events(&lab, &alice.token, dev.tunnel_id).await;
    assert!(kinds.iter().any(|k| k == "command_denied"), "{kinds:?}");
}
