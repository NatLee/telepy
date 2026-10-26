//! 每條隧道自己的服務金鑰（SSH lab）：新裝置只授權隧道的金鑰（共用金鑰從不出現）；舊裝置先用共用金鑰登入，
//! 同步把隧道金鑰裝進去，下一次登入就改用它，再同步時共用金鑰被移掉；同一台機器上的另一條隧道還沒驗證前共用金鑰
//! 留著；隧道的服務公鑰不能登記成裝置金鑰或個人金鑰；刪隧道時它的金鑰一定從裝置移掉。
//! Per-tunnel service keys on the SSH lab: fresh devices trust only the tunnel's key; legacy devices migrate (shared
//! login → key installed → next login uses it → shared key removed), the shared key waits for every tunnel on the
//! machine, the key cannot be registered as a device or personal key, and deleting the tunnel removes it.
mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::lab::Lab;
use telepy_server::db::tunnel_keys;
use telepy_server::ssh::tunnel_keys::bare;

fn service_rows(device: &Value, account: &str) -> Vec<(bool, bool)> {
    let acct = device["view"]["accounts"].as_array().unwrap().iter().find(|a| a["username"] == account).unwrap_or_else(|| panic!("no {account} in {device}"));
    acct["rows"].as_array().unwrap().iter().filter(|r| r["state"] == "service").map(|r| (r["legacy"].as_bool().unwrap(), r["verified"].as_bool().unwrap())).collect()
}

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<String> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().map(|a| a.iter().map(|e| e["event"].as_str().unwrap_or("").to_string()).collect()).unwrap_or_default()
}

#[tokio::test]
async fn a_fresh_device_trusts_only_the_tunnels_own_key() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    // 這台機器從沒見過共用金鑰：只有這條隧道的金鑰（精靈 / 一鍵加入寫進去的）。/ Never had the shared key.
    let fresh = lab.machine("fresh", &[("ubuntu", &[])], false).await;
    let dev = lab.device(&alice, "fresh", &fresh).await;
    lab.trust_tunnel_key(&dev, "ubuntu").await;
    lab.username(&alice, &dev, "ubuntu").await;
    let own = lab.tunnel_service_key(&dev).await;
    assert!(own.ends_with(&format!("telepy-tunnel-{}", dev.tunnel_id)), "{own}");

    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    assert!(fresh.logged_in_bare("ubuntu", &bare(&own)), "logged in with the tunnel's key");
    assert!(!fresh.any_login_with(&lab.service), "the shared key was never offered successfully");
    let row = tunnel_keys::get(&app.state.db, dev.tunnel_id).await.unwrap().unwrap();
    assert!(row.verified_at.is_some());
    assert!(tunnel_keys::account(&app.state.db, dev.tunnel_id, "ubuntu").await.unwrap().unwrap().verified_at.is_some());

    // 網頁拿得到這把（詳細資訊、腳本），金鑰面板把它列成 service（不是舊的共用金鑰）。
    // The web sees it (details, scripts); the key panel lists it as service, not legacy.
    let r = app.get(&format!("/api/reverse/server/keys/{}", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.json["service_key"], own, "{}", r.text);
    let r = app.get(&format!("/tunnels/server/script/docker-run/{}/22", dev.tunnel_id), Some(&alice.token)).await;
    assert!(r.json["script"].as_str().unwrap().contains(&format!("TELEPY_KEY='{own}'")), "{}", r.text);
    let r = app.post(&format!("/api/reverse/server/{}/device-keys/sync", dev.tunnel_id), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(service_rows(&r.json, "ubuntu"), vec![(false, true)], "{}", r.text);

    // 這把公鑰不能拿去當別人的裝置金鑰或個人金鑰。/ It is neither a device key nor a personal key for anyone.
    let t = app.get("/api/reverse/issue/token", Some(&bob.token)).await.json["token"].as_str().unwrap().to_string();
    let r = app.post(&format!("/api/reverse/create/key/duplicate/{t}"), Some(&bob.token), json!({"host_friendly_name": "x", "key": own})).await;
    assert_eq!((r.status, r.json["key_reason"].as_str()), (StatusCode::BAD_REQUEST, Some("service")), "{}", r.text);
    let r = app.post("/api/reverse/user/keys", Some(&bob.token), json!({"host_friendly_name": "x", "key": own})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);

    // 刪隧道：它的金鑰一定從裝置移掉（不管「移除服務金鑰」的選項）。/ Deleting removes the tunnel's key regardless of the option.
    let before = fresh.authorized_keys("ubuntu");
    assert!(before.contains(&bare(&own)));
    let r = app.delete(&format!("/api/reverse/server/keys/{}?remove_device_keys=false&remove_service_key=false", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["accounts"][0]["service_key_removed"], true, "{}", r.text);
    assert!(!fresh.authorized_keys("ubuntu").contains(&bare(&own)), "{}", fresh.authorized_keys("ubuntu"));
    assert!(tunnel_keys::get(&app.state.db, dev.tunnel_id).await.unwrap().is_none());
}

#[tokio::test]
async fn a_legacy_device_moves_from_the_shared_key_to_its_own() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    // 舊裝置：只信共用金鑰，而且它真的寫在 authorized_keys 裡。/ A legacy device: the shared key, in the file.
    let old = lab.machine("old", &[("ubuntu", &[&lab.service])], false).await;
    let dir = old.account_home("ubuntu").join(".ssh");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("authorized_keys"), format!("{}\n", lab.service.public)).unwrap();
    let dev = lab.device(&alice, "old", &old).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let own = lab.tunnel_service_key(&dev).await;
    let path = |t: &str| format!("/api/reverse/server/{}/{t}", dev.tunnel_id);

    // 第一次：隧道金鑰還不在裝置上 → 退回共用金鑰。/ First: the tunnel key is not there yet → shared key.
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    assert!(old.logged_in("ubuntu", &lab.service));
    assert!(!old.logged_in_bare("ubuntu", &bare(&own)));
    assert!(tunnel_keys::get(&app.state.db, dev.tunnel_id).await.unwrap().unwrap().verified_at.is_none());

    // 同步：隧道金鑰裝進去，共用金鑰還在（還沒用新金鑰登入過）。/ Sync installs the key; the shared one stays (not verified yet).
    let r = app.post(&path("device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let ak = old.authorized_keys("ubuntu");
    assert!(ak.contains(&format!("{} telepy-tunnel-{}", bare(&own), dev.tunnel_id)) && ak.contains(&lab.service.bare()), "{ak}");
    let acct = tunnel_keys::account(&app.state.db, dev.tunnel_id, "ubuntu").await.unwrap().unwrap();
    assert!(acct.installed_at.is_some() && acct.verified_at.is_none());
    assert_eq!(service_rows(&r.json, "ubuntu"), vec![(true, true), (false, true)], "legacy + own: {}", r.text);

    // 下一條連線用隧道金鑰登入 → 驗證過。/ The next connection logs in with the tunnel key → verified.
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    assert!(old.logged_in_bare("ubuntu", &bare(&own)));
    assert!(tunnel_keys::account(&app.state.db, dev.tunnel_id, "ubuntu").await.unwrap().unwrap().verified_at.is_some());

    // 再同步：這台機器只有這條隧道、驗證過了 → 共用金鑰移掉，留下事件。/ Sync again: last tunnel here, verified → shared key removed.
    let r = app.post(&path("device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let ak = old.authorized_keys("ubuntu");
    assert!(ak.contains(&bare(&own)) && !ak.contains(&lab.service.bare()), "{ak}");
    assert_eq!(service_rows(&r.json, "ubuntu"), vec![(false, true)], "{}", r.text);
    assert!(events(&lab, &alice.token, dev.tunnel_id).await.contains(&"service_key_migrated".to_string()));
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu", "still reachable afterwards");
}

#[tokio::test]
async fn the_shared_key_waits_for_every_tunnel_on_the_machine() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let m = lab.machine("twice", &[("ubuntu", &[&lab.service])], false).await;
    let dir = m.account_home("ubuntu").join(".ssh");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("authorized_keys"), format!("{}\n", lab.service.public)).unwrap();
    let a1 = lab.device(&alice, "twice-1", &m).await;
    let a2 = lab.device(&alice, "twice-2", &m).await;
    lab.username(&alice, &a1, "ubuntu").await;
    lab.username(&alice, &a2, "ubuntu").await;
    // 兩條都釘選同一把 host key（= 同一台機器）。/ Both pin the same host key (= the same machine).
    assert_eq!(lab.backend_exec(&a1, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    assert_eq!(lab.backend_exec(&a2, "ubuntu", "whoami").await.unwrap(), "ubuntu");

    // a1 裝好、驗證過、再同步：a2 還沒驗證 → 共用金鑰留著。/ a1 installed + verified + synced: a2 not yet → the shared key stays.
    let sync = |id: i64| {
        let token = alice.token.clone();
        async move { app.post(&format!("/api/reverse/server/{id}/device-keys/sync"), Some(&token), json!({})).await }
    };
    sync(a1.tunnel_id).await;
    assert_eq!(lab.backend_exec(&a1, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    sync(a1.tunnel_id).await;
    let ak = m.authorized_keys("ubuntu");
    assert!(ak.contains(&lab.service.bare()), "the shared key waits for twice-2: {ak}");
    assert!(ak.contains(&bare(&lab.tunnel_service_key(&a1).await)));

    // a2 也裝好、驗證過、同步 → 現在才移掉。/ a2 installed + verified + synced → now it goes.
    sync(a2.tunnel_id).await;
    assert_eq!(lab.backend_exec(&a2, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    sync(a2.tunnel_id).await;
    let ak = m.authorized_keys("ubuntu");
    assert!(!ak.contains(&lab.service.bare()), "{ak}");
    assert!(ak.contains(&bare(&lab.tunnel_service_key(&a1).await)) && ak.contains(&bare(&lab.tunnel_service_key(&a2).await)), "{ak}");
    for d in [&a1, &a2] {
        assert_eq!(lab.backend_exec(d, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    }
}

#[tokio::test]
async fn keep_shared_service_key_leaves_the_shared_key_on_the_device() {
    let Some(lab) = Lab::start_with(|c| c.keep_shared_service_key = true).await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    // 和上一個測試同一台舊裝置，但伺服器設定成保留共用金鑰（另一台 Telepy 還用它登入）。
    // The same legacy device as above, on a server told to keep the shared key (another Telepy still logs in with it).
    let old = lab.machine("kept", &[("ubuntu", &[&lab.service])], false).await;
    let dir = old.account_home("ubuntu").join(".ssh");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("authorized_keys"), format!("{}\n", lab.service.public)).unwrap();
    let dev = lab.device(&alice, "kept", &old).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let own = lab.tunnel_service_key(&dev).await;
    let path = |t: &str| format!("/api/reverse/server/{}/{t}", dev.tunnel_id);

    // 遷移照常：隧道金鑰裝進去，下一條連線用它登入。/ The move still happens: key installed, next login uses it.
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = app.post(&path("device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["view"]["keep_shared"], true, "{}", r.text);
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    assert!(old.logged_in_bare("ubuntu", &bare(&own)));
    assert!(tunnel_keys::account(&app.state.db, dev.tunnel_id, "ubuntu").await.unwrap().unwrap().verified_at.is_some());

    // 再同步：驗證過了，共用金鑰還是留著。/ Sync again: verified, and the shared key still stays.
    let r = app.post(&path("device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let ak = old.authorized_keys("ubuntu");
    assert!(ak.contains(&bare(&own)) && ak.contains(&lab.service.bare()), "{ak}");
    assert_eq!(service_rows(&r.json, "ubuntu"), vec![(true, true), (false, true)], "{}", r.text);
    assert!(!events(&lab, &alice.token, dev.tunnel_id).await.contains(&"service_key_migrated".to_string()));

    // 手動也移不掉。/ Not by hand either.
    let acct = r.json["view"]["accounts"].as_array().unwrap().iter().find(|a| a["username"] == "ubuntu").unwrap();
    let fp = acct["rows"].as_array().unwrap().iter().find(|r| r["state"] == "service" && r["legacy"] == true).unwrap()["fingerprint"].as_str().unwrap().to_string();
    let r = app.post(&path("authorized-keys/remove"), Some(&alice.token), json!({"username": "ubuntu", "fingerprint": fp})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("service_key")), "{}", r.text);
    assert!(old.authorized_keys("ubuntu").contains(&lab.service.bare()));
}
