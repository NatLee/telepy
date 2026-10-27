//! 多台裝置一次產生 ~/.ssh/config（`GET /tunnels/server/config`）：一個伺服器區塊 + 每台的區塊，別名不重複，
//! 只放我能登入的裝置；產生的檔案原樣存起來，`ssh <別名>` 每一台都連得到（真的 OpenSSH 經 gateway）。
//! The bulk ~/.ssh/config: one server stanza plus every device's, unique aliases, only devices I can log in to; the
//! generated file works as is for every device (real OpenSSH through the gateway).
mod common;

use common::lab::Lab;
use serde_json::{json, Value};

fn hosts_in(config: &str) -> Vec<String> {
    config.lines().filter_map(|l| l.trim().strip_prefix("Host ")).map(|h| h.trim().to_string()).collect()
}

fn names(list: &Value) -> Vec<&str> {
    list.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn one_config_for_many_devices() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let pi = lab.machine("pi", &[("root", &[&alice.key])], false).await;
    let nas = lab.machine("nas", &[("admin", &[&alice.key]), ("backup", &[&alice.key])], false).await;
    let cam = lab.machine("cam", &[("ubuntu", &[&bob.key])], false).await;
    let vault = lab.machine("vault", &[("root", &[&bob.key])], false).await;
    let dev_pi = lab.device(&alice, "pi", &pi).await;
    let dev_nas = lab.device(&alice, "nas", &nas).await;
    let dev_cam = lab.device(&bob, "cam", &cam).await;
    let dev_vault = lab.device(&bob, "vault", &vault).await;
    lab.username(&alice, &dev_pi, "root").await;
    lab.username(&alice, &dev_nas, "admin").await;
    let backup = lab.username(&alice, &dev_nas, "backup").await;
    lab.username(&bob, &dev_cam, "ubuntu").await;
    lab.username(&bob, &dev_vault, "root").await;
    // cam 分享給 alice 但一個帳號都不准用 → 列在 skipped；vault 沒分享 → 完全不出現
    // cam is shared with alice without any account → skipped; vault is not shared → never mentioned
    lab.share(&bob, &dev_cam, &alice, "view", &[]).await;
    // nas 的預設帳號是 backup（不是第一個）。/ nas defaults to backup, not its first account.
    let r = lab.app.patch(&format!("/api/reverse/server/{}/default-username", dev_nas.tunnel_id), Some(&alice.token), json!({ "default_username_id": backup })).await;
    assert!(r.status.is_success(), "{}", r.text);

    // --- 每台一個 Host（預設）：別名 = 裝置名稱，帳號 = 隧道預設帳號 / one Host per device
    let r = lab.app.get("/tunnels/server/config", Some(&alice.token)).await;
    assert!(r.status.is_success(), "{}", r.text);
    let config = r.json["config"].as_str().unwrap();
    assert_eq!(hosts_in(config), ["telepy-ssh-server", "nas", "pi"], "{config}");
    assert_eq!(r.json["accounts"], "default");
    assert_eq!(names(&r.json["tunnels"]), ["nas", "pi"]);
    assert_eq!(r.json["tunnels"][0]["hosts"], json!([{ "alias": "nas", "username": "backup", "username_id": backup }]));
    assert_eq!(r.json["tunnels"][0]["usernames"].as_array().unwrap().len(), 2);
    assert_eq!(r.json["skipped"], json!([{ "id": dev_cam.tunnel_id, "name": "cam", "reason": "no_accounts" }]));
    assert!(!r.text.contains("vault"), "a device that is not shared must not appear: {}", r.text);
    assert_eq!(r.json["server"]["alias"], "telepy-ssh-server");
    assert!(r.json["known_hosts"].as_str().unwrap().starts_with("telepy-"), "{}", r.text);

    // 存起來原樣可用：每一台都用自己的帳號登入 / The file works as is for every device
    let cfg = lab.write_ssh_config(&alice, "all-devices", config, r.json["known_hosts"].as_str().unwrap());
    assert_eq!(lab.ssh_with_config(&cfg, "pi", "whereami").await.stdout, "root@pi");
    assert_eq!(lab.ssh_with_config(&cfg, "nas", "whereami").await.stdout, "backup@nas");

    // --- 每個帳號一個 Host：別名跟單台的「全部帳號」一樣 / one Host per account, same aliases as the single config
    let r = lab.app.get("/tunnels/server/config?accounts=all", Some(&alice.token)).await;
    let config = r.json["config"].as_str().unwrap();
    assert_eq!(hosts_in(config), ["telepy-ssh-server", "nas-admin", "nas-backup", "pi"], "{config}");
    let single = lab.app.get(&format!("/tunnels/server/config/{}", dev_nas.tunnel_id), Some(&alice.token)).await;
    assert_eq!(single.json["hosts"], r.json["tunnels"][0]["hosts"]);
    let cfg = lab.write_ssh_config(&alice, "all-accounts", config, r.json["known_hosts"].as_str().unwrap());
    assert_eq!(lab.ssh_with_config(&cfg, "nas-admin", "whereami").await.stdout, "admin@nas");
    assert_eq!(lab.ssh_with_config(&cfg, "nas-backup", "whereami").await.stdout, "backup@nas");

    // --- 只挑幾台；看不到的 id 直接略過 / Picked devices; ids I can't see are ignored
    let r = lab.app.get(&format!("/tunnels/server/config?ids={},{}", dev_pi.tunnel_id, dev_vault.tunnel_id), Some(&alice.token)).await;
    assert_eq!(hosts_in(r.json["config"].as_str().unwrap()), ["telepy-ssh-server", "pi"]);
    assert_eq!(r.json["skipped"], json!([]));
    let r = lab.app.get(&format!("/tunnels/server/config?ids={}", dev_vault.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.json["tunnels"], json!([]));
    assert_eq!(hosts_in(r.json["config"].as_str().unwrap()), ["telepy-ssh-server"]);

    // WebSocket 載體：伺服器區塊多 ProxyCommand，裝置區塊不變 / WebSocket transport only changes the server stanza
    let r = lab.app.get("/tunnels/server/config?transport=websocket", Some(&alice.token)).await;
    assert_eq!(r.json["transport"], "websocket");
    assert!(r.json["config"].as_str().unwrap().contains("telepy-ws.py"), "{}", r.text);

    // 錯的參數 → 欄位錯誤 / Bad parameters are field errors
    let r = lab.app.get("/tunnels/server/config?ids=1,x", Some(&alice.token)).await;
    assert_eq!(r.status.as_u16(), 400, "{}", r.text);
    assert!(r.json["ids"].is_array(), "{}", r.text);
    let r = lab.app.get("/tunnels/server/config?accounts=some", Some(&alice.token)).await;
    assert_eq!(r.status.as_u16(), 400, "{}", r.text);
    let r = lab.app.get("/tunnels/server/config", None).await;
    assert_eq!(r.status.as_u16(), 401);

    // bob 只看到自己的兩台 / bob sees only his own two
    let r = lab.app.get("/tunnels/server/config", Some(&bob.token)).await;
    assert_eq!(names(&r.json["tunnels"]), ["cam", "vault"]);
}
