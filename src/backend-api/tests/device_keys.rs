//! 裝置金鑰清單端到端（common::lab）：Telepy 用 russh + SFTP 把使用者金鑰寫進裝置帳號的 authorized_keys，
//! 依擁有者允許的帳號安裝、撤銷分享 / 縮小允許清單 / 移出清單 / 刪金鑰時移除，稽核與移除清單外的金鑰。
//! 每一步都用真的筆電 OpenSSH（經 gateway）確認裝置是否真的接受那把金鑰。
//! End-to-end device key lists on the SSH lab, verified with real laptop logins through the gateway.
mod common;

use std::os::unix::fs::PermissionsExt;

use axum::http::StatusCode;
use common::lab::{sftp_server_bin, Hop, Lab, LabUser};
use serde_json::{json, Value};

async fn key_id(lab: &Lab, user: &LabUser) -> i64 {
    let r = lab.app.get("/api/reverse/user/keys", Some(&user.token)).await;
    r.json[0]["id"].as_i64().unwrap()
}

fn path(tunnel_id: i64, rest: &str) -> String {
    format!("/api/reverse/server/{tunnel_id}/{rest}")
}

/// 每個帳號的狀態：`{"ubuntu": "installed", ...}`。
fn targets(entry: &Value) -> Vec<(String, String)> {
    entry["targets"].as_array().unwrap().iter().map(|t| (t["username"].as_str().unwrap().to_string(), t["status"].as_str().unwrap().to_string())).collect()
}

/// 合併檢視裡某帳號的每一列：(state, 擁有者, verified)。/ Rows of one account in the merged view.
fn view_rows(device: &Value, account: &str) -> Vec<(String, String, bool)> {
    let acct = device["view"]["accounts"].as_array().unwrap().iter().find(|a| a["username"] == account).unwrap_or_else(|| panic!("no {account} in {device}"));
    acct["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["state"].as_str().unwrap().to_string(), r["owner"].as_str().unwrap_or("").to_string(), r["verified"].as_bool().unwrap()))
        .collect()
}

fn view_accounts(device: &Value) -> Vec<String> {
    device["view"]["accounts"].as_array().unwrap().iter().map(|a| a["username"].as_str().unwrap().to_string()).collect()
}

fn rows(v: &[(&str, &str, bool)]) -> Vec<(String, String, bool)> {
    v.iter().map(|(a, b, c)| (a.to_string(), b.to_string(), *c)).collect()
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

#[tokio::test]
async fn device_key_list_installs_and_revokes() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let stranger = lab.keygen("stranger");
    // 裝置：兩個帳號都信任服務金鑰（後端靠它管理 authorized_keys）；使用者金鑰只能來自檔案。
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    let ubuntu_home = boxm.account_home("ubuntu");
    boxm.account_home("root");
    std::fs::create_dir_all(ubuntu_home.join(".ssh")).unwrap();
    let ak_path = ubuntu_home.join(".ssh/authorized_keys");
    std::fs::write(&ak_path, "# written by hand\n").unwrap();
    std::fs::set_permissions(&ak_path, std::fs::Permissions::from_mode(0o640)).unwrap();
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.username(&alice, &dev, "root").await;
    let (alice_key, bob_key) = (key_id(&lab, &alice).await, key_id(&lab, &bob).await);
    let to_ubuntu = [(Hop::Tunnel(&dev), "ubuntu")];
    let to_root = [(Hop::Tunnel(&dev), "root")];

    // 之前：alice 過得了 gateway，但裝置不認她的金鑰。/ Before: the device does not trust alice.
    assert!(!lab.laptop_exec(&alice, &to_ubuntu, "whoami").await.ok);

    // --- alice 把自己的金鑰放進清單 → 裝進她能用的每個帳號
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&alice.token), json!({"user_key_ids": [alice_key]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["can_manage"], true);
    assert_eq!(r.json["tunnel"]["online"], true);
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("root", "pending"), ("ubuntu", "pending")]));
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("root", "installed"), ("ubuntu", "installed")]));
    // 合併檢視：同步時寫過 / 讀過檔，所以是「在裝置上看到了」。/ Merged view: verified on the device by the sync.
    assert_eq!(view_accounts(&r.json), vec!["root", "ubuntu"]);
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[("installed", "alice", true)]));
    assert!(r.json["view"]["accounts"][1]["checked_at"].is_string(), "{}", r.text);
    let ak = boxm.authorized_keys("ubuntu");
    assert!(ak.starts_with("# written by hand\n"), "{ak}");
    assert!(ak.contains(&format!("{} telepy:alice/alice-laptop", alice.key.bare())), "{ak}");
    // 原本的權限保留；新建的檔案是 0600。/ Mode kept; new files are 0600.
    assert_eq!(std::fs::metadata(&ak_path).unwrap().permissions().mode() & 0o777, 0o640);
    let root_ak = boxm.home.join("root/.ssh/authorized_keys");
    assert_eq!(std::fs::metadata(&root_ak).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(lab.laptop_exec(&alice, &to_ubuntu, "whereami").await.stdout, "ubuntu@box");
    assert_eq!(lab.laptop_exec(&alice, &to_root, "whereami").await.stdout, "root@box");
    // 再同步一次：檔案不變（不會重複加）。/ Idempotent.
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(boxm.authorized_keys("ubuntu"), ak);

    // --- bob：VIEW 分享、只允許 ubuntu；他放自己的金鑰 → 只進 ubuntu
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&bob.token), json!({"user_key_ids": [alice_key]})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("not_your_key")), "{}", r.text);
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&bob.token), json!({"user_key_ids": [bob_key]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["can_manage"].as_bool(), r.json["accounts"].clone()), (Some(false), json!(["ubuntu"])));
    // 被分享者只看得到自己的。/ Sharees only see their own entries.
    assert_eq!(r.json["entries"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["entries"][0]["mine"], true);
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&bob.token), json!({})).await;
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("ubuntu", "installed")]));
    // 被分享者：只有自己能用的帳號、只有自己的金鑰。/ A sharee: only their accounts and their own keys.
    assert_eq!(view_accounts(&r.json), vec!["ubuntu"]);
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[("installed", "bob", true)]));
    assert!(boxm.authorized_keys("ubuntu").contains(&bob.key.bare()));
    assert!(!boxm.authorized_keys("root").contains(&bob.key.bare()));
    assert_eq!(lab.laptop_exec(&bob, &to_ubuntu, "whereami").await.stdout, "ubuntu@box");
    assert!(!lab.laptop_exec(&bob, &to_root, "whoami").await.ok);
    // bob 不能動 alice 的、也不能稽核。/ Bob cannot remove alice's entry or audit.
    let r = lab.app.delete(&path(dev.tunnel_id, &format!("device-keys/{alice_key}")), Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    let r = lab.app.get(&path(dev.tunnel_id, "authorized-keys"), Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);
    // 擁有者看得到全部。/ The owner sees everyone's entries.
    let r = lab.app.get(&path(dev.tunnel_id, "device-keys"), Some(&alice.token)).await;
    assert_eq!(r.json["entries"].as_array().unwrap().len(), 2);
    // 金鑰頁矩陣。/ Keys-page matrix.
    let r = lab.app.get("/api/reverse/user/keys/devices", Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json[0]["role"], "view");
    assert_eq!(r.json[0]["keys"][0]["user_key_id"], bob_key);
    assert_eq!(targets(&r.json[0]["keys"][0]), pairs(&[("ubuntu", "installed")]));

    // --- 縮小允許清單 → bob 的金鑰離開 ubuntu；放回來 → 再裝上
    let allowed = format!("/tunnels/share/{}/{}/allowed-usernames", dev.tunnel_id, bob.id);
    let r = lab.app.patch(&allowed, Some(&alice.token), json!({"allowed_target_username_ids": []})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.get(&path(dev.tunnel_id, "device-keys"), Some(&alice.token)).await;
    assert_eq!(r.json["removals"][0]["owner"], "bob", "{}", r.text);
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[("installed", "alice", true), ("removing", "bob", true)]));
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[("installed", "alice", true)]));
    assert!(!boxm.authorized_keys("ubuntu").contains(&bob.key.bare()));
    assert!(!lab.laptop_exec(&bob, &to_ubuntu, "whoami").await.ok);
    lab.app.patch(&allowed, Some(&alice.token), json!({"allowed_target_username_ids": [ubuntu]})).await;
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert!(boxm.authorized_keys("ubuntu").contains(&bob.key.bare()));

    // --- 撤銷分享 → bob 的金鑰離開清單與裝置
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, bob.id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert!(!boxm.authorized_keys("ubuntu").contains(&bob.key.bare()));
    let r = lab.app.get(&path(dev.tunnel_id, "device-keys"), Some(&alice.token)).await;
    assert_eq!(r.json["entries"].as_array().unwrap().len(), 1);
    assert_eq!(r.json["removals"], json!([]));

    // --- 稽核：服務金鑰 / Telepy 管理的 / 清單外的；移除清單外的那把
    let ak = boxm.authorized_keys("ubuntu");
    std::fs::write(&ak_path, format!("{ak}{}\nno-pty {}\n", lab.service.public, stranger.public)).unwrap();
    let r = lab.app.get(&path(dev.tunnel_id, "authorized-keys"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let acct = r.json["accounts"].as_array().unwrap().iter().find(|a| a["username"] == "ubuntu").unwrap().clone();
    let kinds: Vec<&str> = acct["lines"].as_array().unwrap().iter().map(|l| l["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["managed", "service", "unknown"], "{acct}");
    assert_eq!(acct["lines"][0]["owner"], "alice");
    assert_eq!(acct["lines"][0]["in_list"], true);
    assert_eq!(acct["lines"][2]["options"], "no-pty");
    // 讀過檔，合併檢視也看得到服務金鑰與清單外的那把。/ After that read the merged view shows them too.
    let r = lab.app.get(&path(dev.tunnel_id, "device-keys"), Some(&alice.token)).await;
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[("service", "", true), ("installed", "alice", true), ("unknown", "", true)]));
    let fp = |i: usize| acct["lines"][i]["fingerprint"].as_str().unwrap().to_string();
    let remove = format!("/api/reverse/server/{}/authorized-keys/remove", dev.tunnel_id);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprint": fp(1)})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("service_key")), "{}", r.text);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprint": fp(0)})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::CONFLICT, Some("in_key_list")), "{}", r.text);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprint": fp(2)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["removed"], 1);
    assert!(!boxm.authorized_keys("ubuntu").contains(&stranger.bare()));

    // --- 移出清單 → 從裝置移除（其他行保留）
    let r = lab.app.delete(&path(dev.tunnel_id, &format!("device-keys/{alice_key}")), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(boxm.authorized_keys("ubuntu"), format!("# written by hand\n{}\n", lab.service.public));
    assert!(!boxm.authorized_keys("root").contains(&alice.key.bare()));
    assert!(!lab.laptop_exec(&alice, &to_root, "whoami").await.ok);

    // --- 放回去，再刪掉金鑰本身 → 也從裝置移除
    lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&alice.token), json!({"user_key_ids": [alice_key]})).await;
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert!(boxm.authorized_keys("root").contains(&alice.key.bare()));
    // 最後使用：alice 前面經 gateway 登入過。/ Last use was recorded by the gateway.
    let r = lab.app.get("/api/reverse/user/keys", Some(&alice.token)).await;
    assert!(r.json[0]["last_used_at"].is_string(), "{}", r.text);
    assert_eq!(r.json[0]["last_used_ip"], "127.0.0.1");
    assert_eq!(r.json[0]["key_type"], "ED25519");
    let r = lab.app.delete(&format!("/api/reverse/user/keys/{alice_key}"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert!(!boxm.authorized_keys("root").contains(&alice.key.bare()));
    assert!(!boxm.authorized_keys("ubuntu").contains(&alice.key.bare()));
}

/// 離線裝置：清單照存、狀態 pending，同步回 409；`key_list: "mine"` 建隧道時帶入所有金鑰。
#[tokio::test]
async fn offline_device_and_key_list_seed() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let alice_key = key_id(&lab, &alice).await;
    let dev_key = lab.keygen("offline-box");
    let r = lab
        .app
        .post("/api/reverse/server/keys", Some(&alice.token), json!({"host_friendly_name": "offline", "key": dev_key.public, "reverse_port": common::lab::free_port(), "key_list": "mine"}))
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let tid = r.json["id"].as_i64().unwrap();
    let r = lab.app.post("/api/reverse/server/usernames", Some(&alice.token), json!({"reverse_server": tid, "username": "pi"})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let r = lab.app.get(&path(tid, "device-keys"), Some(&alice.token)).await;
    assert_eq!(r.json["tunnel"]["online"], false);
    assert_eq!(r.json["my_keys"][0]["in_list"], true);
    assert_eq!(r.json["entries"][0]["user_key_id"], alice_key);
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("pi", "pending")]));
    let r = lab.app.post(&path(tid, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::CONFLICT, Some("device_offline")), "{}", r.text);
    let r = lab.app.get(&path(tid, "authorized-keys"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.text);
    let r = lab.app.post("/api/reverse/server/keys", Some(&alice.token), json!({"host_friendly_name": "x", "key": lab.keygen("x").public, "reverse_port": common::lab::free_port(), "key_list": "all"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    // 別人看不到這台。/ Strangers get a 404.
    let carol = lab.user("carol").await;
    let r = lab.app.get(&path(tid, "device-keys"), Some(&carol.token)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

/// 合成一把 Ed25519 公鑰（不用跑 ssh-keygen：只要能解析、指紋各不相同）。/ A parseable, distinct Ed25519 public key.
fn fake_ed25519(i: u32, comment: &str) -> String {
    use base64::Engine;
    let mut blob = Vec::new();
    for part in [&b"ssh-ed25519"[..], &[&i.to_be_bytes()[..], &[7u8; 28][..]].concat()] {
        blob.extend_from_slice(&(part.len() as u32).to_be_bytes());
        blob.extend_from_slice(part);
    }
    format!("ssh-ed25519 {} {comment}", base64::engine::general_purpose::STANDARD.encode(blob))
}

/// 帳號裡有幾百把金鑰：稽核全部列出，批次移除一次改寫檔案，服務金鑰 / 清單上的 / 不存在的列在 skipped。
/// Hundreds of keys in one account: the audit lists them all, a batch removal rewrites the file once.
#[tokio::test]
async fn audit_lists_many_keys_and_removes_a_batch() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let boxm = lab.machine("crowd", &[("ubuntu", &[&lab.service])], false).await;
    let home = boxm.account_home("ubuntu");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    let fleet: Vec<String> = (0..300).map(|i| fake_ed25519(i, &format!("fleet-{i}"))).collect();
    // 第一把出現兩次（一次帶 options）。/ The first key appears twice, once with options.
    let content = format!("# fleet\n{}\n{}\nno-pty {}\n", lab.service.public, fleet.join("\n"), fleet[0]);
    std::fs::write(home.join(".ssh/authorized_keys"), content).unwrap();
    let dev = lab.device(&alice, "crowd", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let alice_key = key_id(&lab, &alice).await;
    lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&alice.token), json!({"user_key_ids": [alice_key]})).await;
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("ubuntu", "installed")]), "{}", r.text);

    // 面板的合併檢視：每把一列，重複的行合併並附行數。/ The panel view: one row per key, duplicates counted.
    let view_rows = |r: &common::Resp| r.json["view"]["accounts"][0]["rows"].as_array().unwrap().clone();
    let rows = view_rows(&r);
    assert_eq!(rows.iter().filter(|r| r["state"] == "unknown").count(), 300, "{}", r.text);
    let fleet0 = rows.iter().find(|r| r["comment"] == "fleet-0").unwrap();
    assert_eq!((fleet0["line_count"].as_i64(), fleet0["options"].as_str()), (Some(2), None));

    let r = lab.app.get(&path(dev.tunnel_id, "authorized-keys"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let lines = r.json["accounts"][0]["lines"].as_array().unwrap().clone();
    let count = |kind: &str| lines.iter().filter(|l| l["kind"] == kind).count();
    assert_eq!((count("unknown"), count("service"), count("managed")), (301, 1, 1));
    let fp_of = |kind: &str| lines.iter().find(|l| l["kind"] == kind).unwrap()["fingerprint"].as_str().unwrap().to_string();
    // fleet-0 … fleet-249；fleet-0 有兩行。/ fleet-0 … fleet-249; fleet-0 is on two lines.
    let fps: Vec<String> = lines.iter().filter(|l| l["kind"] == "unknown").filter_map(|l| l["fingerprint"].as_str().map(str::to_string)).take(250).collect();
    let remove = path(dev.tunnel_id, "authorized-keys/remove");
    let mut batch = fps.clone();
    batch.extend([fp_of("service"), fp_of("managed"), "SHA256:not-there".to_string(), fps[0].clone()]);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprints": batch})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["keys"].as_i64(), r.json["removed"].as_i64()), (Some(250), Some(251)), "{}", r.text);
    let skipped: Vec<&str> = r.json["skipped"].as_array().unwrap().iter().map(|s| s["code"].as_str().unwrap()).collect();
    assert_eq!(skipped, vec!["service_key", "in_key_list", "not_found"]);
    let ak = boxm.authorized_keys("ubuntu");
    assert!(ak.starts_with(&format!("# fleet\n{}\n", lab.service.public)), "{ak}");
    assert_eq!(ak.lines().filter(|l| l.contains("fleet-")).count(), 50, "{ak}");
    assert!(!ak.contains(&fleet[0]) && ak.contains(&fleet[299]));
    assert!(ak.contains(&alice.key.bare()));
    assert_eq!(lab.laptop_exec(&alice, &[(Hop::Tunnel(&dev), "ubuntu")], "whereami").await.stdout, "ubuntu@crowd");
    // 移除時寫檔的內容就是面板看到的（不用再連裝置）。/ The panel shows the file as written, without dialing the device.
    let r = lab.app.get(&path(dev.tunnel_id, "device-keys"), Some(&alice.token)).await;
    assert_eq!(view_rows(&r).iter().filter(|r| r["state"] == "unknown").count(), 50, "{}", r.text);

    // 只剩不能移的：200、什麼都沒改。/ Nothing removable: 200, file untouched.
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprints": [fp_of("service")]})).await;
    assert_eq!((r.status, r.json["keys"].as_i64()), (StatusCode::OK, Some(0)), "{}", r.text);
    assert_eq!(boxm.authorized_keys("ubuntu"), ak);
    for bad in [json!([]), json!(["SHA256:x", 3]), json!("SHA256:x")] {
        let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprints": bad})).await;
        assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_request")), "{}", r.text);
    }
}
