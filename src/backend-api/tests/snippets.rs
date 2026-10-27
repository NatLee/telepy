//! 工具箱（指令片段）：三種範圍誰看得到、誰能改、上限、刪隧道時一起刪；以及從工具箱送出的指令走的是同一條
//! 終端機輸入路徑，所以被規則擋下的照樣擋下（裝置是會回顯的假 shell，`Machine::commands` = 真的跑到 shell 的行）。
//! Toolbox snippets: who sees and edits each scope, the limit, cleanup with the tunnel; and a snippet sent from the
//! toolbox takes the same terminal input path, so a blocked command stays blocked.
mod common;

use axum::http::StatusCode;
use common::lab::{Device, Lab, LabUser, Machine, MachineOpts};
use serde_json::{json, Value};

async fn echo_device(lab: &Lab, owner: &LabUser) -> (Machine, Device) {
    let m = lab.machine_with("box", &[("ubuntu", &[&lab.service])], MachineOpts { echo_shell: true, ..Default::default() }).await;
    let dev = lab.device(owner, "box", &m).await;
    (m, dev)
}

async fn add(lab: &Lab, token: &str, body: Value) -> Value {
    let r = lab.app.post("/api/snippets", Some(token), body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    r.json
}

/// 那裡能用的片段名稱。/ The names of the snippets usable there.
async fn names(lab: &Lab, token: &str, tunnel: Option<i64>) -> Vec<String> {
    let path = match tunnel {
        Some(id) => format!("/api/snippets?tunnel_id={id}"),
        None => "/api/snippets".to_string(),
    };
    let r = lab.app.get(&path, Some(token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["snippets"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap().to_string()).collect()
}

/// 前端「執行」送出的輸入：多行 = 每行一個 Enter，最後再一個 Enter（不是括號貼上）。
/// What the front end's Run sends: one Enter per line plus the final one (never a bracketed paste).
fn typed(command: &str) -> String {
    format!("{}\r", command.replace("\r\n", "\n").replace('\n', "\r"))
}

#[tokio::test]
async fn scopes_decide_who_sees_and_edits_snippets() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let bob = lab.user("bob").await; // VIEW with an account
    let carol = lab.user("carol").await; // ADMIN sharee
    let dave = lab.user("dave").await; // VIEW, no account
    let erin = lab.user("erin").await; // no access
    let (_m, dev) = echo_device(&lab, &alice).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "admin", &[]).await;
    lab.share(&alice, &dev, &dave, "view", &[]).await;
    let tid = dev.tunnel_id;

    // 自己的：預設範圍，只有自己看得到，變數照規則整理（秘密變數不留預設值）。
    // Your own: the default scope, visible to you alone; variables normalised (a secret keeps no default).
    let mine = add(&lab, &bob.token, json!({"name": "Logs", "command": "journalctl -u $unit -n ${lines}", "variables": [{"name": "unit", "label": "Unit", "default": "nginx"}, {"name": "lines", "default": "50"}, {"name": "token", "secret": true, "default": "s3cret"}], "confirm": true})).await;
    assert_eq!(mine["scope"], "user");
    assert_eq!(mine["confirm"], true);
    assert_eq!(mine["can_edit"], true);
    assert_eq!(mine["variables"][2], json!({"name": "token", "label": "", "default": "", "secret": true}));
    assert_eq!(names(&lab, &bob.token, None).await, ["Logs"]);
    assert_eq!(names(&lab, &bob.token, Some(tid)).await, ["Logs"], "usable on any tunnel");
    assert!(names(&lab, &alice.token, None).await.is_empty(), "nobody else sees it");
    let mid = mine["id"].as_i64().unwrap();
    assert_eq!(lab.app.patch(&format!("/api/snippets/{mid}"), Some(&lab.admin_token), json!({"name": "x"})).await.status, StatusCode::NOT_FOUND, "admins included");
    assert_eq!(lab.app.post(&format!("/api/snippets/{mid}/used"), Some(&alice.token), json!({})).await.status, StatusCode::NOT_FOUND);

    // 隧道的：owner 與 ADMIN sharee 能加，VIEW 不行，看不到隧道的人 404。
    // A tunnel's: owner and ADMIN sharee add, VIEW can't, strangers get a 404.
    let ts = add(&lab, &carol.token, json!({"scope": "tunnel", "tunnel_id": tid, "name": "Restart app", "command": "sudo systemctl restart app"})).await;
    assert_eq!((ts["scope"].clone(), ts["tunnel_id"].clone()), (json!("tunnel"), json!(tid)));
    let r = lab.app.post("/api/snippets", Some(&bob.token), json!({"scope": "tunnel", "tunnel_id": tid, "name": "x", "command": "x"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = lab.app.post("/api/snippets", Some(&erin.token), json!({"scope": "tunnel", "tunnel_id": tid, "name": "x", "command": "x"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let r = lab.app.post("/api/snippets", Some(&alice.token), json!({"scope": "tunnel", "name": "x", "command": "x"})).await;
    assert!(r.json["tunnel_id"].is_array(), "{}", r.text);

    // 用：能開終端機的人（bob 有帳號）；只能看狀態的 dave 拿不到，也不能拿來算次數。
    // Use: whoever can open the terminal (bob has an account); status-only dave gets none and can't count a use.
    let r = lab.app.get(&format!("/api/snippets?tunnel_id={tid}"), Some(&bob.token)).await;
    assert_eq!(r.json["tunnel"], json!({"id": tid, "name": "box", "can_use": true, "can_edit": false}));
    let item = r.json["snippets"].as_array().unwrap().iter().find(|s| s["name"] == "Restart app").cloned().expect("bob sees the tunnel's snippet");
    assert_eq!(item["can_edit"], false);
    let r = lab.app.get(&format!("/api/snippets?tunnel_id={tid}"), Some(&dave.token)).await;
    assert_eq!(r.json["tunnel"]["can_use"], false);
    assert!(r.json["snippets"].as_array().unwrap().is_empty(), "{}", r.text);
    let tsid = ts["id"].as_i64().unwrap();
    assert_eq!(lab.app.post(&format!("/api/snippets/{tsid}/used"), Some(&dave.token), json!({})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(lab.app.get(&format!("/api/snippets?tunnel_id={tid}"), Some(&erin.token)).await.status, StatusCode::NOT_FOUND);

    // 改 / 刪：能用不能改 = 403，看不到 = 404；範圍不能換。/ Edit: usable but read-only = 403, invisible = 404; no scope moves.
    assert_eq!(lab.app.patch(&format!("/api/snippets/{tsid}"), Some(&bob.token), json!({"name": "x"})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(lab.app.delete(&format!("/api/snippets/{tsid}"), Some(&erin.token)).await.status, StatusCode::NOT_FOUND);
    let r = lab.app.patch(&format!("/api/snippets/{tsid}"), Some(&alice.token), json!({"description": "After a deploy", "confirm": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["description"].clone(), r.json["command"].clone()), (json!("After a deploy"), json!("sudo systemctl restart app")));
    let r = lab.app.patch(&format!("/api/snippets/{tsid}"), Some(&alice.token), json!({"scope": "site"})).await;
    assert!(r.json["scope"].is_array(), "{}", r.text);

    // 全站：只有管理員能加 / 改，大家都能用。/ Site-wide: admins add and change, everyone uses.
    let r = lab.app.post("/api/snippets", Some(&alice.token), json!({"scope": "site", "name": "x", "command": "x"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let site = add(&lab, &lab.admin_token, json!({"scope": "site", "name": "Disk usage", "command": "df -h"})).await;
    assert_eq!(names(&lab, &erin.token, None).await, ["Disk usage"]);
    let sid = site["id"].as_i64().unwrap();
    assert_eq!(lab.app.delete(&format!("/api/snippets/{sid}"), Some(&alice.token)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(names(&lab, &bob.token, Some(tid)).await, ["Logs", "Restart app", "Disk usage"], "mine, then the tunnel's, then site-wide");

    // 計數。/ The use counter.
    let r = lab.app.post(&format!("/api/snippets/{sid}/used"), Some(&erin.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.post(&format!("/api/snippets/{sid}/used"), Some(&bob.token), json!({})).await;
    assert_eq!(r.json["use_count"], 2);
    assert!(r.json["last_used_at"].is_string());

    // 欄位檢查。/ Field validation.
    for (body, field) in [
        (json!({"name": "", "command": "x"}), "name"),
        (json!({"name": "x", "command": ""}), "command"),
        (json!({"name": "x", "command": "y".repeat(4001)}), "command"),
        (json!({"name": "x", "command": "y", "variables": [{"name": "1st"}]}), "variables"),
        (json!({"name": "x", "command": "y", "scope": "galaxy"}), "scope"),
    ] {
        let r = lab.app.post("/api/snippets", Some(&bob.token), body.clone()).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}: {}", r.text);
        assert!(r.json[field].is_array(), "{body}: {}", r.text);
    }

    // 刪隧道：它的片段一起刪，自己的與全站的留著。/ Deleting the tunnel removes its snippets; personal and site ones stay.
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{tid}?remove_device_keys=false"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_snippet WHERE tunnel_id = ?").bind(tid).fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(n, 0);
    assert_eq!(names(&lab, &bob.token, None).await, ["Logs", "Disk usage"]);
}

#[tokio::test]
async fn each_scope_holds_at_most_200_snippets() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    for i in 0..200 {
        let r = lab.app.post("/api/snippets", Some(&alice.token), json!({"name": format!("s{i}"), "command": "true"})).await;
        assert_eq!(r.status, StatusCode::CREATED, "{i}: {}", r.text);
    }
    let r = lab.app.post("/api/snippets", Some(&alice.token), json!({"name": "one more", "command": "true"})).await;
    assert_eq!((r.status, r.json["code"].clone()), (StatusCode::BAD_REQUEST, json!("limit")), "{}", r.text);
    // 別人的範圍不受影響。/ Someone else's scope is separate.
    add(&lab, &bob.token, json!({"name": "mine", "command": "true"})).await;
    add(&lab, &lab.admin_token, json!({"scope": "site", "name": "site", "command": "true"})).await;
}

#[tokio::test]
async fn a_blocked_command_stays_blocked_when_sent_from_the_toolbox() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let (m, dev) = echo_device(&lab, &alice).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let r = lab.app.post(&format!("/api/reverse/server/{}/command-rules", dev.tunnel_id), Some(&alice.token), json!({"action": "block", "pattern": "reboot"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    // owner 存的隧道片段裡有一行被擋的指令。/ The owner saves a tunnel snippet with a blocked line in it.
    add(&lab, &alice.token, json!({"scope": "tunnel", "tunnel_id": dev.tunnel_id, "name": "Patch and reboot", "command": "echo patched\nreboot"})).await;
    let r = lab.app.get(&format!("/api/snippets?tunnel_id={}", dev.tunnel_id), Some(&bob.token)).await;
    let command = r.json["snippets"][0]["command"].as_str().unwrap().to_string();
    assert_eq!(command, "echo patched\nreboot");

    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("$ ").await;
    // 前端一行一行送（等上一行的輸出停了再送下一行）：被擋的那行單獨出現在通知裡。
    // The front end sends line by line (the next once output settles): the blocked line shows up on its own.
    let lines: Vec<&str> = command.lines().collect();
    t.input(&typed(lines[0])).await;
    t.expect("ran:echo patched").await;
    t.expect("ran:echo patched\r\n$ ").await;
    t.input(&typed(lines[1])).await;
    let n = t.expect_notice("blocked").await;
    assert_eq!(n["command"], "reboot");
    assert_eq!(n["rule"]["pattern"], "reboot");
    t.expect("^C").await;

    // 整段一次送出（打字快過提示字元）也一樣擋得住。/ Sent in one go (typed ahead of the prompt): still blocked.
    t.input(&typed(&command)).await;
    let n = t.expect_notice("blocked").await;
    assert!(n["command"].as_str().unwrap().contains("reboot"), "{n}");
    assert!(m.commands().iter().filter(|c| c.as_str() == "echo patched").count() >= 1, "{:?}", m.commands());
    assert!(!m.commands().iter().any(|c| c.contains("reboot")), "{:?}", m.commands());
}
