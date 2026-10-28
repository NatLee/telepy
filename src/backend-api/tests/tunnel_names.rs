//! 隧道名稱 = ssh 的主機名稱（SSH lab）：建立（精靈、API）與改名都照 [`telepy_server::tunnel_name`] 的規則、不分大小寫
//! 唯一；舊的、不合規則的名稱照樣能改其他欄位，產生的 ssh config 改用 `localhost:<號碼>`，筆電照樣連得上。
//! Tunnel names are ssh host names: creating (wizard, API) and renaming follow the rule and are unique ignoring case;
//! an older non-conforming name still edits its other fields, and its generated ssh config uses `localhost:<number>`
//! so a laptop still gets through.
mod common;

use axum::http::StatusCode;
use common::lab::Lab;
use serde_json::json;
use telepy_server::db::{self, tunnels::NewTunnel};

/// 精靈建立一條隧道（拿一次性 token 再建立）。/ Create a tunnel through the wizard (issue token, then create).
async fn wizard(app: &common::TestApp, name: &str, key: &str, token: &str) -> common::Resp {
    let issue = app.get("/api/reverse/issue/token", Some(token)).await.json["token"].as_str().unwrap().to_string();
    app.post(&format!("/api/reverse/create/key/{issue}"), Some(token), json!({"host_friendly_name": name, "key": key})).await
}

#[tokio::test]
async fn names_are_ssh_host_names_and_unique_ignoring_case() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;

    // 精靈：空白、`-` 開頭、`@` 被擋；數字開頭可以。/ The wizard: spaces, a leading '-', '@' refused; a digit may start.
    for (i, bad) in ["My Box", "-box", "pi@box", "客廳"].into_iter().enumerate() {
        let r = wizard(app, bad, &lab.keygen(&format!("k-bad-{i}")).public, &alice.token).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}: {}", r.text);
        assert!(r.text.contains("SSH host name"), "{bad}: {}", r.text);
    }
    let r = wizard(app, "3d-printer", &lab.keygen("k-3d").public, &alice.token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = wizard(app, "MyBox", &lab.keygen("k-mybox").public, &alice.token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let mybox = r.json["id"].as_i64().unwrap();

    // 只差大小寫 = 同一個名稱（ssh 連線時轉小寫），別人也不能用。/ Case-only differences are the same name, for anyone.
    let r = wizard(app, "mybox", &lab.keygen("k-mybox-bob").public, &bob.token).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.text.contains("already exists"), "{}", r.text);

    // 精靈的預檢：不合規則的原因與（不分大小寫的）重複。/ The wizard's pre-check: the rule's code and case-insensitive taken.
    let issue = app.get("/api/reverse/issue/token", Some(&bob.token)).await.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{issue}"), Some(&bob.token), json!({"host_friendly_name": "my box", "key": lab.keygen("k-dup").public})).await;
    assert_eq!(r.json["host_friendly_name_problem"], "name_chars", "{}", r.text);
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{issue}"), Some(&bob.token), json!({"host_friendly_name": "MYBOX", "key": lab.keygen("k-dup2").public})).await;
    assert_eq!(r.json["host_friendly_name_exists"], true, "{}", r.text);
    assert!(r.json["host_friendly_name_problem"].is_null(), "{}", r.text);

    // 一般的建立 API：欄位錯誤。/ The plain create API: a field error.
    let r = app.post("/api/reverse/server/keys", Some(&alice.token), json!({"host_friendly_name": "web 01", "key": lab.keygen("k-web").public, "reverse_port": 30201})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["host_friendly_name"][0].as_str().unwrap().contains("letters, digits"), "{}", r.text);

    // 改名：同樣的規則；只改自己的大小寫可以。/ Renaming: the same rule; changing only your own case is fine.
    let r = app.patch(&format!("/api/reverse/server/keys/{mybox}"), Some(&alice.token), json!({"host_friendly_name": "my box"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["host_friendly_name"].is_array(), "{}", r.text);
    let r = app.patch(&format!("/api/reverse/server/keys/{mybox}"), Some(&alice.token), json!({"host_friendly_name": "3D-Printer"})).await;
    assert!(r.text.contains("already exists"), "another tunnel's name in other case: {}", r.text);
    let r = app.patch(&format!("/api/reverse/server/keys/{mybox}"), Some(&alice.token), json!({"host_friendly_name": "mybox"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["host_friendly_name"], "mybox");

    // 一鍵加入的名稱也是。/ The one-command join's name too.
    let r = app.post("/api/reverse/join", Some(&alice.token), json!({"name": "living room"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = app.post("/api/reverse/join", Some(&alice.token), json!({"name": "MYBOX"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "taken ignoring case: {}", r.text);
}

#[tokio::test]
async fn an_older_name_keeps_working_through_the_generated_config() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let m = lab.machine("oldname", &[("ubuntu", &[&lab.service, &alice.key])], false).await;
    // 規則之前建立的名稱（直接寫 DB，跟升級前一樣）。/ A name from before the rule (written straight to the DB).
    let dev = lab.device(&alice, "Living Room #2", &m).await;
    lab.username(&alice, &dev, "ubuntu").await;

    let (cfg, alias) = lab.generated_ssh_config(&alice, &dev, "ubuntu").await;
    let text = std::fs::read_to_string(&cfg).unwrap();
    assert!(text.contains("HostName localhost\n") && text.contains(&format!("Port {} \n", dev.reverse_port)), "{text}");
    assert!(!text.contains("HostName Living"), "{text}");
    let r = lab.ssh_with_config(&cfg, &alias, "whereami").await;
    assert_eq!(r.stdout, "ubuntu@oldname", "{r:?}");

    // 舊名稱還能改其他欄位（沒改名就不檢查）。/ Other fields of an older name can still be edited.
    let r = lab.app.patch(&format!("/api/reverse/server/keys/{}", dev.tunnel_id), Some(&alice.token), json!({"description": "kept", "host_friendly_name": "Living Room #2"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["description"], "kept");

    // 規則之前也可能有只差大小寫的兩條：都還在，DB 本身不擋。/ Case twins from before the rule both still exist.
    let twin = db::tunnels::create(&lab.app.state.db, NewTunnel { user_id: alice.id, host_friendly_name: "living room #2", key: &lab.keygen("twin").public, reverse_port: 30999, description: None, default_username_id: None }).await;
    assert!(twin.is_ok(), "{twin:?}");
}
