//! 指令規則端到端（common::lab）：誰能改哪些規則（個人 / 全站、指定隧道、「只有我」）、網頁終端機的擋下 / 等核准 /
//! 拒絕 / 撤回 / 逾時，以及規則管不到的情況（沒打東西、全螢幕程式）。裝置是會回顯的假 shell，`Machine::commands` 是真的
//! 跑到 shell 的行。
//! Command rules end to end: who edits which rules (personal / site-wide, picked tunnels, "only me"), and the web
//! terminal's block / hold / deny / withdraw / expiry.
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
async fn rules_are_edited_by_admins_and_their_authors() {
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
    let r = lab.app.post("/api/command-rules", Some(&alice.token), json!({"scope": "site", "action": "block", "pattern": "reboot"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let site = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "block", "pattern": "reboot", "note": "Ask in #ops"})).await;
    assert_eq!(site["scope"], "site");
    assert_eq!(site["who"], "everyone");
    assert_eq!(site["via"], "all");
    let r = lab.app.get("/api/command-rules", Some(&bob.token)).await;
    assert_eq!(r.json["site"][0]["pattern"], "reboot", "everyone can read the site-wide rules");
    assert_eq!(r.json["can_edit_site"], false);
    assert_eq!(r.json["mine"], json!([]));
    assert_eq!(r.json["tunnels"], json!([{"id": dev.tunnel_id, "name": "box", "manage": false}]));

    // 管別人的規則：owner 與 ADMIN sharee 可以，VIEW 不行（「只有我」可以），看不到隧道的人 404。
    // Rules about other people: owner and ADMIN yes, VIEW no (but "only me" yes), strangers 404.
    let r = lab.app.post(&tunnel, Some(&bob.token), json!({"action": "approve", "pattern": "sudo"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = lab.app.post("/api/command-rules", Some(&bob.token), json!({"action": "approve", "pattern": "sudo", "all_tunnels": false, "tunnel_ids": [dev.tunnel_id]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["tunnel_ids"].is_array(), "{}", r.text);
    let own = add_rule(&lab, &bob.token, Some(dev.tunnel_id), json!({"action": "block", "pattern": "dd", "who": "me"})).await;
    assert_eq!((own["scope"].as_str(), own["who"].as_str(), own["mine"].as_bool()), (Some("personal"), Some("me"), Some(true)));
    assert_eq!(own["tunnels"], json!([{"id": dev.tunnel_id, "name": "box", "applies": true}]));
    let r = lab.app.post(&tunnel, Some(&dave.token), json!({"action": "approve", "pattern": "sudo"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let sudo = add_rule(&lab, &carol.token, Some(dev.tunnel_id), json!({"action": "approve", "pattern": "sudo", "who": "sharees"})).await;
    let curl = add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "block", "kind": "regex", "pattern": r"curl .*\|\s*sh", "via": "agents"})).await;
    assert_eq!(curl["kind"], "regex");

    assert_eq!(sudo["owner"]["username"], "carol");
    // 一模一樣的規則不能再加一次（同一個人）；別人寫一樣的是他自己的規則。/ No exact duplicates per person.
    let r = lab.app.post(&tunnel, Some(&carol.token), json!({"action": "approve", "pattern": "sudo", "who": "sharees"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["pattern"].is_array(), "{}", r.text);
    // 全站規則不能「只有我」。/ Site rules can't be "only me".
    let r = lab.app.post("/api/command-rules", Some(&lab.admin_token), json!({"scope": "site", "action": "block", "pattern": "x", "who": "me"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["who"].is_array(), "{}", r.text);

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

    // 看得到隧道就看得到這裡算數的規則（加上全站的）；別人「只有我」的規則看不到。
    // Anyone who sees the tunnel reads the rules in force there plus the site-wide ones; others' "only me" rules stay private.
    let r = lab.app.get(&tunnel, Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["rules"].as_array().unwrap().len(), 3, "carol's, alice's and bob's own: {}", r.text);
    assert_eq!(r.json["site_rules"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["can_edit"], false);
    assert_eq!(lab.app.get(&tunnel, Some(&alice.token)).await.json["rules"].as_array().unwrap().len(), 2, "bob's own rule is his");
    assert_eq!(lab.app.get(&tunnel, Some(&dave.token)).await.status, StatusCode::NOT_FOUND);

    // 改 / 刪：只有寫的人（看得到的人 403，其他人 404）。/ Only the author changes it (403 when visible, else 404).
    let rid = sudo["id"].as_i64().unwrap();
    let r = lab.app.patch(&format!("/api/command-rules/{rid}"), Some(&bob.token), json!({"enabled": false})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = lab.app.patch(&format!("/api/command-rules/{rid}"), Some(&alice.token), json!({"enabled": false})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "not even the tunnel owner: {}", r.text);
    assert_eq!(lab.app.patch(&format!("/api/command-rules/{rid}"), Some(&dave.token), json!({"enabled": false})).await.status, StatusCode::NOT_FOUND);
    let oid = own["id"].as_i64().unwrap();
    assert_eq!(lab.app.delete(&format!("/api/command-rules/{oid}"), Some(&alice.token)).await.status, StatusCode::NOT_FOUND, "an only-me rule is invisible");
    let r = lab.app.patch(&format!("/api/command-rules/{rid}"), Some(&carol.token), json!({"note": "Ping me first"})).await;
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

    // 刪隧道：只套用它的規則跟著走。/ Deleting the tunnel takes the rules limited to it along.
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}?remove_device_keys=false", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_command_rule WHERE scope = 'user'").fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(n, 0);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_command_rule_target WHERE tunnel_id = ?").bind(dev.tunnel_id).fetch_one(&lab.app.state.db.read).await.unwrap();
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
    add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "block", "pattern": "reboot"})).await;
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
    let site_block = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "block", "pattern": "rm -rf", "mode": "enforced"})).await;
    assert_eq!(site_block["approver_ids"], json!([]));
    assert_eq!(site_block["mode"], "enforced");
    // 個人的允許蓋不過強制的全站擋下。/ A personal allow never beats an enforced site-wide block.
    let tunnel_allow = add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "allow", "pattern": "rm -rf /tmp/build/*"})).await;
    assert_eq!(tunnel_allow["action"], "allow");
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["for_approvers"]["action"], "block", "{}", r.text);
    assert_eq!(r.json["for_approvers"]["personal"]["allowed_by"]["pattern"], "rm -rf /tmp/build/*");
    assert_eq!(r.json["for_approvers"]["personal"]["exempted"], false);
    assert!(r.json["for_approvers"]["allowed_by"].is_null());
    // 全站的允許才豁免全站的擋下，而且說得出是哪一條。/ A site allow exempts the site block, and is named.
    let site_allow = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "allow", "pattern": "rm -rf /tmp/build/*", "note": "build scratch"})).await;
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.json["for_sharees"]["action"], "allow", "{}", r.text);
    assert_eq!(r.json["for_sharees"]["allowed_by"]["id"], site_allow["id"]);
    assert_eq!(r.json["for_sharees"]["site"]["exempted"], true);
    assert_eq!(r.json["for_sharees"]["site"]["hit"]["id"], site_block["id"], "the exempted rule is still reported");
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /srv")).await;
    assert_eq!(r.json["for_sharees"]["action"], "block", "outside the exception the block holds");
    // alice 的允許也豁免她自己的「要核准」（同一個人）。/ alice's allow exempts her own approve rule too (same owner).
    add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "approve", "pattern": "rm", "who": "sharees"})).await;
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.json["for_sharees"]["action"], "allow", "{}", r.text);
    assert_eq!(r.json["for_sharees"]["personal"]["exempted"], true);
    // carol（也管這條隧道）的允許豁免不了 alice 的規則。/ carol's allow (she manages the tunnel too) can't exempt alice's rule.
    let carols = add_rule(&lab, &carol.token, Some(dev.tunnel_id), json!({"action": "allow", "pattern": "rm -rf /tmp/build/*"})).await;
    let r = lab.app.patch(&format!("/api/command-rules/{}", tunnel_allow["id"]), Some(&alice.token), json!({"enabled": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.json["for_sharees"]["action"], "approve", "{}", r.text);
    assert_eq!(lab.app.delete(&format!("/api/command-rules/{}", carols["id"]), Some(&carol.token)).await.status, StatusCode::NO_CONTENT);
    // alice 的允許關掉：全站的允許蓋不過個人的「要核准」。/ alice's allow off: a site allow never beats a personal approve rule.
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("rm -rf /tmp/build/x")).await;
    assert_eq!(r.json["for_sharees"]["action"], "approve", "{}", r.text);
    assert_eq!(r.json["for_sharees"]["rule"]["scope"], "personal");
    assert_eq!(r.json["for_sharees"]["rule"]["owner"]["username"], "alice");
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
    // 個人規則只能指定自己管的隧道的 owner / ADMIN sharee（或管理員）。/ A personal rule may only name owners / ADMIN sharees of tunnels its author manages (or admins).
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
    let r = lab.app.post("/api/command-rules", Some(&lab.admin_token), json!({"scope": "site", "action": "approve", "pattern": "reboot", "approver_ids": [admin.id, 999_999]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "unknown users are refused: {}", r.text);
    // dave 跟這條隧道毫無關係，但全站規則點名他。/ dave has nothing to do with the tunnel, but the site rule names him.
    let dave = lab.user("dave").await;
    let reboot = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "approve", "pattern": "reboot", "approver_ids": [admin.id, dave.id]})).await;
    assert_eq!(reboot["approvers"][0]["username"], "admin");
    assert_eq!(reboot["approvers"][1]["username"], "dave");
    let r = lab.app.get("/api/command-rules", Some(&lab.admin_token)).await;
    assert!(r.json["site_approver_candidates"].as_array().unwrap().len() >= 4, "{}", r.text);
    let r = lab.app.get("/api/command-rules", Some(&bob.token)).await;
    assert_eq!(r.json["site_approver_candidates"], json!([]));
    assert_eq!(r.json["site_tunnels"], Value::Null);
    let names: Vec<&str> = r.json["approver_candidates"].as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect();
    assert_eq!(names, ["bob"], "bob manages no tunnel: only himself");
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

/// 個人規則與指定隧道：只能替自己管的隧道設管別人的規則、失去 ADMIN 就不算數、「只有我」只管自己（核准人是自己，別人看
/// 不到）、全站規則限定幾條隧道、刪隧道只帶走只套用它的規則。
/// Personal rules and picked tunnels: rules about other people only on tunnels you manage, they stop counting when you
/// lose ADMIN, "only me" covers just you (you approve, nobody else sees it), site rules limited to some tunnels, and
/// deleting a tunnel only takes the rules limited to it.
#[tokio::test]
async fn personal_rules_cover_picked_tunnels_and_only_me() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let dave = lab.user("dave").await;
    let (m1, one) = echo_device(&lab, &alice).await;
    let m2 = lab.machine_with("box2", &[("ubuntu", &[&lab.service])], MachineOpts { echo_shell: true, ..Default::default() }).await;
    let two = lab.device(&alice, "box2", &m2).await;
    let u1 = lab.username(&alice, &one, "ubuntu").await;
    lab.share(&alice, &one, &bob, "view", &[u1]).await;
    lab.share(&alice, &two, &bob, "admin", &[]).await;
    let check = |tunnel: i64, cmd: &str| json!({"tunnel_id": tunnel, "command": cmd});

    // alice：一條規則管兩條隧道。/ alice: one rule for both tunnels.
    let both = add_rule(&lab, &alice.token, None, json!({"action": "block", "pattern": "reboot", "all_tunnels": false, "tunnel_ids": [one.tunnel_id, two.tunnel_id]})).await;
    assert_eq!(both["scope"], "personal");
    assert_eq!(both["all_tunnels"], false);
    assert_eq!(both["tunnels"].as_array().unwrap().len(), 2);
    for t in [one.tunnel_id, two.tunnel_id] {
        let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check(t, "sudo reboot")).await;
        assert_eq!(r.json["for_sharees"]["action"], "block", "{}", r.text);
    }
    let r = lab.app.post("/api/command-rules", Some(&alice.token), json!({"action": "block", "pattern": "x", "all_tunnels": false, "tunnel_ids": []})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["tunnel_ids"].is_array());

    // bob 只能在他是 ADMIN 的 box2 替別人設規則。/ bob may only set rules for others on box2, where he is an Admin.
    let r = lab.app.post("/api/command-rules", Some(&bob.token), json!({"action": "block", "pattern": "shutdown", "all_tunnels": false, "tunnel_ids": [one.tunnel_id, two.tunnel_id]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let shutdown = add_rule(&lab, &bob.token, None, json!({"action": "block", "pattern": "shutdown", "all_tunnels": false, "tunnel_ids": [two.tunnel_id]})).await;
    let everywhere = add_rule(&lab, &bob.token, None, json!({"action": "block", "pattern": "halt"})).await;
    assert_eq!(everywhere["all_tunnels"], true);
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check(two.tunnel_id, "shutdown -h now")).await;
    assert_eq!(r.json["for_approvers"]["action"], "block", "{}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check(one.tunnel_id, "halt")).await;
    assert_eq!(r.json["for_approvers"]["action"], "allow", "bob's every-tunnel rule only covers tunnels he manages: {}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check(two.tunnel_id, "halt")).await;
    assert_eq!(r.json["for_approvers"]["action"], "block", "{}", r.text);
    // 不是寫的人：看得到 403，看不到 404。/ Not the author: 403 when visible, 404 otherwise.
    let sid = shutdown["id"].as_i64().unwrap();
    assert_eq!(lab.app.patch(&format!("/api/command-rules/{sid}"), Some(&alice.token), json!({"note": "x"})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(lab.app.patch(&format!("/api/command-rules/{sid}"), Some(&dave.token), json!({"note": "x"})).await.status, StatusCode::NOT_FOUND);

    // bob 降成 VIEW：他的規則在 box2 不再算數，清單上標成不算數。/ bob drops to VIEW: his rules stop counting on box2.
    let r = lab.app.patch(&format!("/tunnels/update-permission/{}/{}", two.tunnel_id, bob.id), Some(&alice.token), json!({"permission_type": "view"})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check(two.tunnel_id, "shutdown -h now")).await;
    assert_eq!(r.json["for_approvers"]["action"], "allow", "{}", r.text);
    let r = lab.app.get("/api/command-rules", Some(&bob.token)).await;
    let mine = r.json["mine"].as_array().unwrap().iter().find(|x| x["id"] == shutdown["id"]).cloned().unwrap();
    assert_eq!(mine["tunnels"][0]["applies"], false, "{mine}");
    assert_eq!(lab.app.get(&format!("/api/reverse/server/{}/command-rules", two.tunnel_id), Some(&alice.token)).await.json["rules"].as_array().unwrap().len(), 1, "only alice's rule is in force there");
    // 之後再改這條規則：留在清單上的隧道不擋存檔，新加的要能管。/ Kept tunnels don't block a save; new ones must be managed.
    let r = lab.app.patch(&format!("/api/command-rules/{sid}"), Some(&bob.token), json!({"note": "until I'm an admin again"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    // bob 替自己的指令加護欄（只有我，所有隧道）：要核准，核准人是他自己；alice 不受影響，也看不到。
    // bob guards his own commands (only me, every tunnel): approval by himself; alice is unaffected and can't see it.
    let guard = add_rule(&lab, &bob.token, None, json!({"action": "approve", "pattern": "sudo", "who": "me", "approver_ids": [alice.id]})).await;
    assert_eq!(guard["approver_ids"], json!([]), "an only-me rule is approved by its owner");
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check(one.tunnel_id, "sudo ls")).await;
    assert_eq!(r.json["for_sharees"]["action"], "approve", "{}", r.text);
    assert_eq!(r.json["for_sharees"]["approvers"]["users"][0]["username"], "bob");
    assert_eq!(r.json["for_approvers"]["action"], "allow", "someone else on the tunnel: {}", r.text);
    let mut alice_rx = lab.app.state.hub.subscribe_user(alice.id);
    let mut t = lab.terminal(&bob, &one, "ubuntu").await.expect("terminal");
    t.expect("$ ").await;
    t.input("sudo ls\r").await;
    let n = t.expect_notice("pending").await;
    assert_eq!(n["can_decide"], true, "bob approves his own guard");
    assert_eq!(n["request"]["rule"]["scope"], "self");
    let id = n["request"]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "the owner can't decide on bob's own guard: {}", r.text);
    let r = lab.app.post(&format!("/api/command-requests/{id}/approve"), Some(&bob.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    t.expect_notice("approved").await;
    t.expect("ran:sudo ls").await;
    t.close().await;
    while let Ok(m) = alice_rx.try_recv() {
        let m: Value = serde_json::from_str(&m).unwrap();
        assert_ne!(m["message"]["action"], "COMMAND-APPROVAL-REQUESTED", "the owner is not asked");
    }
    let r = lab.app.get("/api/command-requests", Some(&alice.token)).await;
    assert!(r.json["requests"].as_array().unwrap().iter().all(|q| q["id"] != id), "others don't see an only-me request: {}", r.text);
    let r = lab.app.get("/api/command-requests", Some(&bob.token)).await;
    assert!(r.json["requests"].as_array().unwrap().iter().any(|q| q["id"] == id), "{}", r.text);
    // alice 自己的 sudo 照跑。/ alice's own sudo just runs.
    let mut at = lab.terminal(&alice, &one, "ubuntu").await.expect("terminal");
    at.expect("$ ").await;
    at.input("sudo id\r").await;
    at.expect("ran:sudo id").await;
    at.close().await;
    assert!(m1.commands().iter().any(|c| c == "sudo id"), "{:?}", m1.commands());

    // 全站規則限定 box2：box 不受影響；看不到 box2 的人只看到「1 條看不到的隧道」。
    // A site rule limited to box2: box is unaffected; people who can't see box2 only get a count.
    let halt = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "block", "pattern": "poweroff", "all_tunnels": false, "tunnel_ids": [two.tunnel_id]})).await;
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check(one.tunnel_id, "poweroff")).await;
    assert_eq!(r.json["for_approvers"]["action"], "allow", "{}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check(two.tunnel_id, "poweroff")).await;
    assert_eq!(r.json["for_approvers"]["action"], "block", "{}", r.text);
    assert_eq!(lab.app.get(&format!("/api/reverse/server/{}/command-rules", one.tunnel_id), Some(&alice.token)).await.json["site_rules"], json!([]));
    let r = lab.app.get("/api/command-rules", Some(&dave.token)).await;
    let seen = r.json["site"].as_array().unwrap().iter().find(|x| x["id"] == halt["id"]).cloned().unwrap();
    assert_eq!((seen["tunnels"].clone(), seen["hidden_tunnels"].as_i64()), (json!([]), Some(1)));
    let r = lab.app.post("/api/command-rules", Some(&lab.admin_token), json!({"scope": "site", "action": "block", "pattern": "y", "all_tunnels": false, "tunnel_ids": [999_999]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);

    // 刪 box2：只套用它的規則（bob 的 shutdown、全站的 poweroff）跟著走；alice 管兩條的留下，只剩 box。
    // Deleting box2: rules limited to it go; alice's two-tunnel rule stays with box only.
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}?remove_device_keys=false", two.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    for gone in [&shutdown, &halt] {
        assert!(db::command_rules::rule(&lab.app.state.db, gone["id"].as_i64().unwrap()).await.unwrap().is_none(), "{gone}");
    }
    let r = lab.app.get("/api/command-rules", Some(&alice.token)).await;
    assert_eq!(r.json["mine"][0]["id"], both["id"]);
    assert_eq!(r.json["mine"][0]["tunnels"], json!([{"id": one.tunnel_id, "name": "box", "applies": true}]));
    assert!(db::command_rules::rule(&lab.app.state.db, everywhere["id"].as_i64().unwrap()).await.unwrap().is_some(), "every-tunnel rules stay");
}

/// 升級：舊的隧道規則變成建立者的個人規則（建立者不再管那條隧道就給 owner），舊的全站規則照舊，隧道不在的刪掉；只跑一次。
/// The upgrade: a tunnel's rule becomes its creator's personal rule (the owner's when the creator no longer manages the
/// tunnel), site rules stay site-wide, rules of vanished tunnels go; it runs once.
#[tokio::test]
async fn old_tunnel_rules_become_personal_rules() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let (_m, dev) = echo_device(&lab, &alice).await;
    lab.share(&alice, &dev, &bob, "view", &[]).await;
    lab.share(&alice, &dev, &carol, "admin", &[]).await;
    let db = &lab.app.state.db;
    let old = |tunnel: Option<i64>, pattern: &'static str, by: i64| async move {
        sqlx::query(
            "INSERT INTO telepy_command_rule (tunnel_id, scope, user_id, action, kind, pattern, who, via, note, enabled, created_by_id, created_at, updated_at) \
             VALUES (?, NULL, NULL, 'block', 'command', ?, 'everyone', 'all', '', 1, ?, '2026-10-24 00:00:00', '2026-10-24 00:00:00')",
        )
        .bind(tunnel)
        .bind(pattern)
        .bind(by)
        .execute(&db.write)
        .await
        .unwrap()
        .last_insert_rowid()
    };
    let by_carol = old(Some(dev.tunnel_id), "reboot", carol.id).await;
    let by_bob = old(Some(dev.tunnel_id), "halt", bob.id).await;
    let site = old(None, "mkfs*", 1).await;
    let orphan = old(Some(999_999), "dd", alice.id).await;
    sqlx::query("DELETE FROM telepy_data_migration WHERE name = ?").bind(db::schema::PERSONAL_COMMAND_RULES).execute(&db.write).await.unwrap();
    db::schema::ensure_schema(&db.write).await.unwrap();
    db::schema::ensure_schema(&db.write).await.unwrap();
    let row = |id: i64| async move { db::command_rules::rule(db, id).await.unwrap() };
    let r = row(by_carol).await.unwrap();
    assert_eq!((r.scope.as_deref(), r.user_id, r.all_tunnels), (Some("user"), Some(carol.id), false), "an ADMIN sharee keeps her rule");
    let r = row(by_bob).await.unwrap();
    assert_eq!((r.scope.as_deref(), r.user_id), (Some("user"), Some(alice.id)), "a creator who no longer manages it hands it to the owner");
    let r = row(site).await.unwrap();
    assert_eq!((r.scope.as_deref(), r.all_tunnels), (Some("site"), true));
    assert!(row(orphan).await.is_none());
    let map = db::command_rules::tunnel_map(db, &[by_carol, by_bob]).await.unwrap();
    assert_eq!(map.get(&by_carol), Some(&vec![dev.tunnel_id]));
    assert_eq!(map.get(&by_bob), Some(&vec![dev.tunnel_id]));
    lab.app.state.commands.invalidate();
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), json!({"tunnel_id": dev.tunnel_id, "command": "sudo reboot"})).await;
    assert_eq!(r.json["for_sharees"]["action"], "block", "{}", r.text);
    assert_eq!(r.json["for_sharees"]["rule"]["owner"]["username"], "carol");
}

/// 全站規則的覆寫：可以覆寫的，隧道的 owner / ADMIN 可以在自己的隧道上關掉（失去 ADMIN 就不算）；強制的誰都不行。提醒規則：
/// 指令照跑、終端機顯示一行提示，每個人可以替自己靜音（強制的不行）。規則自己的核准等待不能比網站設定長。
/// Overriding site rules: owners / ADMINs turn overridable ones off on their tunnels (until they lose ADMIN); enforced
/// ones can't be. Reminders: the command runs with a notice, anyone mutes them for themselves (not enforced ones). A
/// rule's own approval wait can't exceed the site setting.
#[tokio::test]
async fn site_rules_can_be_overridden_and_reminders_muted() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let (m, dev) = echo_device(&lab, &alice).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "admin", &[]).await;
    let check = |cmd: &str| json!({"tunnel_id": dev.tunnel_id, "command": cmd});
    let tunnel = format!("/api/reverse/server/{}/command-rules", dev.tunnel_id);

    // 新的全站規則預設可以覆寫。/ New site rules are overridable by default.
    let sudo = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "approve", "pattern": "sudo"})).await;
    assert_eq!(sudo["mode"], "default");
    let reboot = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "block", "pattern": "reboot", "mode": "enforced"})).await;
    let (sid, rid) = (sudo["id"].as_i64().unwrap(), reboot["id"].as_i64().unwrap());

    // 誰能關：VIEW 什麼都不管 → 400；強制的 → 400 enforced；alice 在 box 上關掉。/ Who may turn it off.
    let r = lab.app.put(&format!("/api/command-rules/{sid}/off"), Some(&bob.token), json!({})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.put(&format!("/api/command-rules/{rid}/off"), Some(&alice.token), json!({})).await;
    assert_eq!((r.status, r.json["code"].clone()), (StatusCode::BAD_REQUEST, json!("enforced")), "{}", r.text);
    let r = lab.app.put(&format!("/api/command-rules/{sid}/off"), Some(&alice.token), json!({"all_tunnels": false, "tunnel_ids": [dev.tunnel_id]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["my_override"]["off"]["tunnels"], json!([{"id": dev.tunnel_id, "name": "box"}]));
    let here = lab.app.get(&tunnel, Some(&bob.token)).await;
    let row = here.json["site_rules"].as_array().unwrap().iter().find(|x| x["id"] == sudo["id"]).cloned().unwrap();
    assert_eq!(row["off_here"], json!([{"id": alice.id, "username": "alice"}]), "{}", here.text);
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("sudo ls")).await;
    assert_eq!(r.json["for_sharees"]["action"], "allow", "{}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("sudo reboot")).await;
    assert_eq!(r.json["for_sharees"]["action"], "block", "the enforced rule still holds: {}", r.text);
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("$ ").await;
    t.input("sudo ls\r").await;
    t.expect("ran:sudo ls").await;

    // carol（ADMIN）也關掉；alice 打開回來還是關著；carol 降成 VIEW 之後她的關掉不算了。
    // carol (ADMIN) turns it off too; alice turning it back on isn't enough; carol losing ADMIN ends hers.
    assert_eq!(lab.app.put(&format!("/api/command-rules/{sid}/off"), Some(&carol.token), json!({})).await.status, StatusCode::OK);
    let r = lab.app.delete(&format!("/api/command-rules/{sid}/off"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.json["my_override"]["off"].is_null());
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("sudo ls")).await;
    assert_eq!(r.json["for_sharees"]["action"], "allow", "carol's still counts: {}", r.text);
    let r = lab.app.patch(&format!("/tunnels/update-permission/{}/{}", dev.tunnel_id, carol.id), Some(&alice.token), json!({"permission_type": "view"})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("sudo ls")).await;
    assert_eq!(r.json["for_sharees"]["action"], "approve", "{}", r.text);

    // 提醒：照跑、終端機有提示；bob 靜音後就安靜了；強制的提醒不能靜音。
    // A reminder: it runs with a notice; quiet once bob mutes it; an enforced reminder can't be muted.
    let warn = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "warn", "pattern": "systemctl restart", "note": "Tell #ops"})).await;
    let wid = warn["id"].as_i64().unwrap();
    t.input("systemctl restart nginx\r").await;
    let n = t.expect_notice("warned").await;
    assert_eq!(n["rule"]["note"], "Tell #ops");
    t.expect("ran:systemctl restart nginx").await;
    let r = lab.app.put(&format!("/api/command-rules/{wid}/mute"), Some(&bob.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["my_override"]["muted"], true);
    let r = lab.app.post("/api/command-rules/check", Some(&bob.token), check("systemctl restart nginx")).await;
    assert_eq!(r.json["for_sharees"]["action"], "allow", "muted for bob: {}", r.text);
    let r = lab.app.post("/api/command-rules/check", Some(&alice.token), check("systemctl restart nginx")).await;
    assert_eq!(r.json["for_approvers"]["action"], "warn", "still reminds alice: {}", r.text);
    let hard = add_rule(&lab, &lab.admin_token, None, json!({"scope": "site", "action": "warn", "pattern": "halt", "mode": "enforced"})).await;
    let r = lab.app.put(&format!("/api/command-rules/{}/mute", hard["id"]), Some(&bob.token), json!({})).await;
    assert_eq!((r.status, r.json["code"].clone()), (StatusCode::BAD_REQUEST, json!("enforced")), "{}", r.text);
    let r = lab.app.put(&format!("/api/command-rules/{sid}/mute"), Some(&bob.token), json!({})).await;
    assert_eq!(r.json["code"], "not_reminder", "{}", r.text);

    // 規則自己的核准等待：比網站設定長 → 400；45 秒 → 申請 45 秒後到期。/ A rule's own wait.
    let r = lab.app.post(&tunnel, Some(&alice.token), json!({"action": "approve", "pattern": "apt", "approval_timeout": 99_999})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["approval_timeout"].is_array(), "{}", r.text);
    let apt = add_rule(&lab, &alice.token, Some(dev.tunnel_id), json!({"action": "approve", "pattern": "apt", "approval_timeout": 45})).await;
    assert_eq!(apt["approval_timeout"], 45);
    t.input("apt update\r").await;
    let n = t.expect_notice("pending").await;
    let at = |k: &str| chrono::DateTime::parse_from_rfc3339(n["request"][k].as_str().unwrap()).unwrap();
    assert!((44..=45).contains(&(at("expires_at") - at("created_at")).num_seconds()), "{n}");
    t.input("\x03").await;
    t.expect_notice("cancelled").await;
    t.close().await;
    assert!(!m.commands().iter().any(|c| c == "apt update"), "{:?}", m.commands());
}
