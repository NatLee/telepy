//! `POST /api/reverse/server/{id}/ssh-check` on the SSH lab: what `telepy ssh` asks before handing over to OpenSSH.
//! Each answer is confirmed against the real path — the laptop's OpenSSH through the gateway into the device's sshd —
//! so "ready" means it really gets in and every problem means it really doesn't. Also: the token allow-list (a read
//! with `tunnels:read`, placing your own key with `ssh:exec`, your key list without a scope, registering a key never).
//! 「這台電腦的 ssh 進得去嗎」端到端：每個回答都用筆電的 OpenSSH 經 gateway 進裝置驗證過。
mod common;

use axum::http::StatusCode;
use common::lab::{sftp_server_bin, Hop, Lab};
use serde_json::{json, Value};
use telepy_server::db;
use telepy_server::device_keys::authorized_keys::parse_public_key;

fn fp(public: &str) -> String {
    parse_public_key(public).unwrap().fingerprint
}

async fn check(lab: &Lab, token: &str, tunnel: i64, account: Option<&str>, fps: &[&str]) -> Value {
    let r = lab.app.post(&format!("/api/reverse/server/{tunnel}/ssh-check"), Some(token), json!({"account": account, "fingerprints": fps})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json
}

fn problems(v: &Value) -> Vec<String> {
    v["problems"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn ssh_check_follows_the_path_hop_by_hop() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let stranger = lab.keygen("stranger");
    let boxm = lab.machine("box", &[("pi", &[&lab.service]), ("root", &[&lab.service])], false).await;
    boxm.account_home("pi");
    boxm.account_home("root");
    let dev = lab.device(&alice, "box", &boxm).await;
    let pi = lab.username(&alice, &dev, "pi").await;
    let root = lab.username(&alice, &dev, "root").await;
    let to_pi = [(Hop::Tunnel(&dev), "pi")];
    let expires = (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339();
    let r = lab.app.post("/api/auth/tokens", Some(&alice.token), json!({"name": "cli", "scopes": ["tunnels:read", "ssh:exec"], "expires_at": expires})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let token = r.json["secret"].as_str().unwrap().to_string();
    let (a_fp, s_fp) = (fp(&alice.key.public), fp(&stranger.public));

    // 1) 一把 Telepy 不認得的金鑰：gateway 會拒絕，裝置那一關無從看起。/ A key Telepy doesn't know: refused at the gateway.
    let v = check(&lab, &token, dev.tunnel_id, Some("pi"), &[&s_fp]).await;
    assert_eq!((v["ready"].as_bool(), problems(&v)), (Some(false), vec!["no_key".to_string()]), "{v}");
    assert_eq!((v["gateway"].as_str(), v["device"]["state"].as_str(), v["registered"].as_i64()), (Some("no_key"), Some("unknown"), Some(1)), "{v}");
    assert!(v["matched"].as_array().unwrap().is_empty());
    let none = check(&lab, &token, dev.tunnel_id, Some("pi"), &[]).await;
    assert_eq!(problems(&none), ["no_key"], "nothing offered at all");
    // 指紋格式不對 = 400。/ Bad fingerprints are a 400.
    let r = lab.app.post(&format!("/api/reverse/server/{}/ssh-check", dev.tunnel_id), Some(&token), json!({"fingerprints": ["MD5:aa"]})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_fingerprints")), "{}", r.text);

    // 2) alice 的金鑰（排在一把陌生的後面）：過得了 gateway，但不在裝置的清單上——Telepy 也還沒讀過那個帳號的檔案。
    // Alice's key behind a stranger's: passes the gateway, isn't on the device's list, and the file hasn't been read yet.
    let v = check(&lab, &token, dev.tunnel_id, Some("pi"), &[&s_fp, &a_fp]).await;
    assert_eq!((v["gateway"].as_str(), problems(&v)), (Some("ok"), vec!["not_listed".to_string()]), "{v}");
    assert_eq!(v["matched"].as_array().unwrap().len(), 1, "only the offered keys that are alice's: {v}");
    assert_eq!(v["device"]["key"]["fingerprint"].as_str(), Some(a_fp.as_str()));
    assert_eq!(v["device"]["place_accounts"], json!([pi]), "placing it names only this account: {v}");
    assert!(!lab.laptop_exec(&alice, &to_pi, "whoami").await.ok, "the device really refuses it");

    // 3) 用 token 放上清單（ssh:exec），只到 pi → 排隊中 → 同步完就進得去。
    // Put on the list with the token (ssh:exec), pi only → queued → in once synced.
    let key_id = v["device"]["key"]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/reverse/server/{}/device-keys", dev.tunnel_id), Some(&token), json!({"user_key_ids": [key_id], "accounts": v["device"]["place_accounts"]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let v = check(&lab, &token, dev.tunnel_id, Some("pi"), &[&a_fp]).await;
    assert_eq!(problems(&v), ["pending"], "{v}");
    let r = lab.app.post(&format!("/api/reverse/server/{}/device-keys/sync", dev.tunnel_id), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let v = check(&lab, &token, dev.tunnel_id, Some("pi"), &[&s_fp, &a_fp]).await;
    assert_eq!((v["ready"].as_bool(), v["device"]["state"].as_str()), (Some(true), Some("installed")), "{v}");
    assert!(v["device"]["file_read_at"].is_string(), "the sync read the file: {v}");
    assert_eq!(lab.laptop_exec(&alice, &to_pi, "whereami").await.stdout, "pi@box");
    // root：同步時讀過它的檔案，金鑰確定不在 → 不在裝置上；放上去時帳號 = pi + root（不是「全部」）。
    // root: the sync read its file and the key is certainly absent → not_on_device; placing names pi + root.
    let v = check(&lab, &token, dev.tunnel_id, Some("root"), &[&a_fp]).await;
    assert_eq!((problems(&v), v["device"]["place_accounts"].clone()), (vec!["not_on_device".to_string()], json!([pi.min(root), pi.max(root)])), "{v}");
    assert!(!lab.laptop_exec(&alice, &[(Hop::Tunnel(&dev), "root")], "whoami").await.ok);
    // 手動加進 root 的檔案、同步重讀 → 「別的方式加的」，進得去。/ Added by hand, re-read → added_by_hand, gets in.
    let root_ak = boxm.home.join("root/.ssh/authorized_keys");
    let mut text = std::fs::read_to_string(&root_ak).unwrap_or_default();
    text.push_str(&format!("{}\n", alice.key.public));
    std::fs::create_dir_all(root_ak.parent().unwrap()).unwrap();
    std::fs::write(&root_ak, text).unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(6)).await; // sync-now reuses a read younger than 5 s
    lab.app.post(&format!("/api/reverse/server/{}/device-keys/sync", dev.tunnel_id), Some(&alice.token), json!({})).await;
    let v = check(&lab, &token, dev.tunnel_id, Some("root"), &[&a_fp]).await;
    assert_eq!((v["ready"].as_bool(), v["device"]["state"].as_str()), (Some(true), Some("added_by_hand")), "{v}");
    assert!(lab.laptop_exec(&alice, &[(Hop::Tunnel(&dev), "root")], "whoami").await.ok);

    // 4) 沒指定帳號：跟終端機一樣挑（兩個帳號、沒有預設 = 挑不出來；設了預設就是它）。
    // No account given: picked like the terminal (two accounts, no default = none; with a default, that one).
    let v = check(&lab, &token, dev.tunnel_id, None, &[&a_fp]).await;
    assert_eq!((v["account"]["username"].clone(), problems(&v)), (Value::Null, vec!["account_not_allowed".to_string()]), "{v}");
    let r = lab.app.patch(&format!("/api/reverse/server/{}/default-username", dev.tunnel_id), Some(&alice.token), json!({"default_username_id": pi})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let v = check(&lab, &token, dev.tunnel_id, None, &[&a_fp]).await;
    assert_eq!((v["account"]["username"].as_str(), v["ready"].as_bool()), (Some("pi"), Some(true)), "{v}");

    // 5) bob：只看狀態的分享 = 連不到；只允許 root → pi 不允許。/ Bob: status-only = no access; root only → pi not allowed.
    lab.share(&alice, &dev, &bob, "view", &[]).await;
    let b_fp = fp(&bob.key.public);
    let v = check(&lab, &bob.token, dev.tunnel_id, Some("pi"), &[&b_fp]).await;
    assert_eq!((problems(&v), v["reach"].as_bool()), (vec!["no_access".to_string()], Some(false)), "{v}");
    let r = lab.app.patch(&format!("/tunnels/share/{}/{}/allowed-usernames", dev.tunnel_id, bob.id), Some(&alice.token), json!({"allowed_target_username_ids": [root]})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let v = check(&lab, &bob.token, dev.tunnel_id, Some("pi"), &[&b_fp]).await;
    assert_eq!(problems(&v), ["account_not_allowed"], "{v}");
    let v = check(&lab, &bob.token, dev.tunnel_id, Some("root"), &[&b_fp]).await;
    assert_eq!(problems(&v), ["not_on_device"], "{v}");
    // 看不到的隧道 = 404。/ A tunnel you can't see is a 404.
    let other = lab.machine("other", &[("pi", &[&lab.service])], false).await;
    let other_dev = lab.device(&alice, "other", &other).await;
    let r = lab.app.post(&format!("/api/reverse/server/{}/ssh-check", other_dev.tunnel_id), Some(&bob.token), json!({"fingerprints": [b_fp]})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);

    // 6) 敏感隧道：最近沒在網頁確認過 → step_up；確認過 → 沒事。/ Step-up: needed until confirmed in the web.
    db::tunnels::set_require_step_up(&lab.app.state.db, dev.tunnel_id, true).await.unwrap();
    let v = check(&lab, &token, dev.tunnel_id, Some("pi"), &[&a_fp]).await;
    assert_eq!((problems(&v), v["step_up"]["confirmed"].as_bool()), (vec!["step_up".to_string()], Some(false)), "{v}");
    assert!(!lab.laptop_exec(&alice, &to_pi, "whoami").await.ok, "the gateway really refuses it");
    lab.app.state.step_up.grant(alice.id);
    let v = check(&lab, &token, dev.tunnel_id, Some("pi"), &[&a_fp]).await;
    assert_eq!((v["ready"].as_bool(), v["step_up"]["confirmed"].as_bool()), (Some(true), Some(true)), "{v}");
    db::tunnels::set_require_step_up(&lab.app.state.db, dev.tunnel_id, false).await.unwrap();

    // 7) 到期的金鑰：gateway 不認。/ An expired key: the gateway refuses it.
    sqlx::query("UPDATE authorized_keys_userauthorizedkeys SET expires_at = '2001-01-01 00:00:00.000000' WHERE id = ?").bind(key_id).execute(&lab.app.state.db.write).await.unwrap();
    let v = check(&lab, &token, dev.tunnel_id, Some("pi"), &[&a_fp]).await;
    assert_eq!((problems(&v), v["matched"][0]["expired"].as_bool(), v["registered"].as_i64()), (vec!["key_expired".to_string()], Some(true), Some(0)), "{v}");
    assert!(!lab.laptop_exec(&alice, &to_pi, "whoami").await.ok);
    sqlx::query("UPDATE authorized_keys_userauthorizedkeys SET expires_at = NULL WHERE id = ?").bind(key_id).execute(&lab.app.state.db.write).await.unwrap();

    // 8) 「個人 SSH 金鑰」被關掉：任何金鑰都沒用。/ Personal keys turned off: no key helps.
    let r = lab.app.put("/api/access/grants", Some(&lab.admin_token), json!({"subject": "user", "id": alice.id, "feature": "keys.personal", "value": "deny"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let v = check(&lab, &alice.token, dev.tunnel_id, Some("pi"), &[&a_fp]).await;
    assert_eq!(problems(&v), ["keys_off"], "{v}");
    assert!(!lab.laptop_exec(&alice, &to_pi, "whoami").await.ok);
    lab.app.put("/api/access/grants", Some(&lab.admin_token), json!({"subject": "user", "id": alice.id, "feature": "keys.personal", "value": "inherit"})).await;

    // 9) 離線：裝置的轉發沒了就說。/ Offline once the device's forward is gone.
    let v = check(&lab, &token, other_dev.tunnel_id, Some("pi"), &[&a_fp]).await;
    assert!(!problems(&v).contains(&"offline".to_string()), "{v}");
    let off = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "never-on", key: &lab.keygen("never-on-tunnel").public, reverse_port: 1, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let v = check(&lab, &token, off.id, None, &[&a_fp]).await;
    assert!(problems(&v).contains(&"offline".to_string()), "{v}");
}

#[tokio::test]
async fn tokens_read_keys_and_place_their_own_but_never_register_one() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let m = lab.machine("box", &[("pi", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &m).await;
    let other_m = lab.machine("other", &[("pi", &[&lab.service])], false).await;
    let other = lab.device(&alice, "other", &other_m).await;
    let pi = lab.username(&alice, &dev, "pi").await;
    let token = |scopes: Value, tunnels: Value| {
        let lab = &lab;
        let web = alice.token.clone();
        async move {
            let expires = (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339();
            let r = lab.app.post("/api/auth/tokens", Some(&web), json!({"name": format!("t{}", rand_suffix()), "scopes": scopes, "tunnel_ids": tunnels, "expires_at": expires})).await;
            assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
            r.json["secret"].as_str().unwrap().to_string()
        }
    };
    let read = token(json!(["tunnels:read"]), json!(null)).await;
    // 自己的金鑰清單：任何 token 都能讀。/ Your key list: any token reads it.
    let r = lab.app.get("/api/reverse/user/keys", Some(&read)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let key_id = r.json[0]["id"].as_i64().unwrap();
    assert_eq!(r.json[0]["fingerprint"].as_str(), Some(fp(&alice.key.public).as_str()));
    // 登記 / 刪除金鑰：token 永遠不行（一把金鑰是一個身分）。/ Registering or deleting a key: never with a token.
    let extra = lab.keygen("extra");
    let r = lab.app.post("/api/reverse/user/keys", Some(&read), json!({"host_friendly_name": "extra", "key": extra.public})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("token_route")), "{}", r.text);
    assert_eq!(lab.app.delete(&format!("/api/reverse/user/keys/{key_id}"), Some(&read)).await.status, StatusCode::FORBIDDEN);
    // 放上清單要 ssh:exec。/ Placing needs ssh:exec.
    let place = json!({"user_key_ids": [key_id], "accounts": [pi]});
    let r = lab.app.post(&format!("/api/reverse/server/{}/device-keys", dev.tunnel_id), Some(&read), place.clone()).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("token_scope")), "{}", r.text);
    // 限定在 other 的 token：box 看不到（404），金鑰清單裡也不會說它是 box 的裝置金鑰。
    // A token limited to `other`: box is a 404, and the key list doesn't name box.
    let limited = token(json!(["tunnels:read", "ssh:exec"]), json!([other.tunnel_id])).await;
    let r = lab.app.post(&format!("/api/reverse/server/{}/device-keys", dev.tunnel_id), Some(&limited), place.clone()).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let r = lab.app.post(&format!("/api/reverse/server/{}/ssh-check", dev.tunnel_id), Some(&limited), json!({"fingerprints": []})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let exec = token(json!(["tunnels:read", "ssh:exec"]), json!(null)).await;
    let r = lab.app.post(&format!("/api/reverse/server/{}/device-keys", dev.tunnel_id), Some(&exec), place).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    // 別人的金鑰不行（跟網頁一樣）。/ Not someone else's key (as in the web).
    let bob = lab.user("bob").await;
    let bob_key = lab.app.get("/api/reverse/user/keys", Some(&bob.token)).await.json[0]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/reverse/server/{}/device-keys", dev.tunnel_id), Some(&exec), json!({"user_key_ids": [bob_key]})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("not_your_key")), "{}", r.text);
}

fn rand_suffix() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}
