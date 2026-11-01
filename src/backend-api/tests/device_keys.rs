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

/// 合併檢視裡某帳號的每一列：(state, 擁有者, verified)。隧道自己的服務金鑰（`service` 列）每個帳號都有，不列。
/// Rows of one account in the merged view; the tunnel's own service key (`service`) sits in every account and is left out.
fn view_rows(device: &Value, account: &str) -> Vec<(String, String, bool)> {
    let acct = device["view"]["accounts"].as_array().unwrap().iter().find(|a| a["username"] == account).unwrap_or_else(|| panic!("no {account} in {device}"));
    acct["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["state"] != "service")
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
    // 兩把 service：這條隧道自己的金鑰（同步裝的）與手動寫進去的共用金鑰。/ Two service lines: the tunnel's own key and the shared one.
    assert_eq!(kinds, vec!["managed", "service", "service", "unknown"], "{acct}");
    assert_eq!(acct["lines"][0]["owner"], "alice");
    assert_eq!(acct["lines"][0]["in_list"], true);
    assert_eq!(acct["lines"][3]["options"], "no-pty");
    // 讀過檔，合併檢視也看得到服務金鑰與清單外的那把。/ After that read the merged view shows them too.
    let r = lab.app.get(&path(dev.tunnel_id, "device-keys"), Some(&alice.token)).await;
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[("installed", "alice", true), ("unknown", "", true)]));
    let fp = |i: usize| acct["lines"][i]["fingerprint"].as_str().unwrap().to_string();
    let remove = format!("/api/reverse/server/{}/authorized-keys/remove", dev.tunnel_id);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprint": fp(1)})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("service_key")), "{}", r.text);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprint": fp(0)})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::CONFLICT, Some("in_key_list")), "{}", r.text);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprint": fp(3)})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["removed"], 1);
    assert!(!boxm.authorized_keys("ubuntu").contains(&stranger.bare()));

    // --- 移出清單 → 從裝置移除（其他行保留）
    let r = lab.app.delete(&path(dev.tunnel_id, &format!("device-keys/{alice_key}")), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    // 剩下手寫的那行、這條隧道自己的服務金鑰（同步裝的）與共用金鑰。/ Left: the hand-written line, the tunnel's own key, the shared key.
    let own = lab.tunnel_service_key(&dev).await;
    assert_eq!(boxm.authorized_keys("ubuntu"), format!("# written by hand\n{own}\n{}\n", lab.service.public));
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
    assert_eq!((count("unknown"), count("service"), count("managed")), (301, 2, 1), "the tunnel's own key is a service line too");
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

/// 清單上的金鑰可以只裝到選定的帳號：擁有者兩個帳號都能用，金鑰只選 ubuntu → 只進 ubuntu；放寬 → 也進 root；
/// 縮回 → 離開 ubuntu；null → 全部。上限仍是允許清單。
/// A listed key can be limited to chosen accounts; widening installs it there, narrowing removes it.
#[tokio::test]
async fn key_goes_only_to_chosen_accounts() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let boxm = lab.machine("picky", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    boxm.account_home("ubuntu");
    boxm.account_home("root");
    let dev = lab.device(&alice, "picky", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let root = lab.username(&alice, &dev, "root").await;
    let alice_key = key_id(&lab, &alice).await;
    let to_ubuntu = [(Hop::Tunnel(&dev), "ubuntu")];
    let to_root = [(Hop::Tunnel(&dev), "root")];
    let entry = format!("device-keys/{alice_key}");

    // 壞的選擇：空清單、不是這台的帳號。/ Bad choices: empty, or an account of another device.
    for bad in [json!([]), json!([999_999]), json!("ubuntu")] {
        let r = lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&alice.token), json!({"user_key_ids": [alice_key], "accounts": bad})).await;
        assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_accounts")), "{}", r.text);
    }

    // 只選 ubuntu。/ Only ubuntu.
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&alice.token), json!({"user_key_ids": [alice_key], "accounts": [ubuntu]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["entries"][0]["accounts"], json!([ubuntu]));
    assert_eq!(r.json["my_keys"][0]["accounts"], json!([ubuntu]));
    assert_eq!(r.json["account_ids"].as_array().unwrap().len(), 2, "{}", r.text);
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("ubuntu", "pending")]));
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("ubuntu", "installed")]), "{}", r.text);
    assert!(boxm.authorized_keys("ubuntu").contains(&alice.key.bare()));
    assert!(!boxm.authorized_keys("root").contains(&alice.key.bare()));
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[("installed", "alice", true)]));
    assert_eq!(view_rows(&r.json, "root"), rows(&[]));
    let ubuntu_rows = r.json["view"]["accounts"].as_array().unwrap().iter().find(|a| a["username"] == "ubuntu").unwrap()["rows"].as_array().unwrap().clone();
    let alice_row = ubuntu_rows.iter().find(|row| row["state"] == "installed").unwrap();
    assert_eq!(alice_row["accounts"], json!([ubuntu]), "{}", r.text);
    assert_eq!(lab.laptop_exec(&alice, &to_ubuntu, "whereami").await.stdout, "ubuntu@picky");
    assert!(!lab.laptop_exec(&alice, &to_root, "whoami").await.ok);
    // 金鑰頁矩陣也帶選擇與帳號 id。/ The keys-page matrix carries the choice and the account ids.
    let r = lab.app.get("/api/reverse/user/keys/devices", Some(&alice.token)).await;
    assert_eq!(r.json[0]["keys"][0]["accounts"], json!([ubuntu]), "{}", r.text);
    assert_eq!(r.json[0]["account_list"].as_array().unwrap().iter().map(|a| a["username"].as_str().unwrap()).collect::<Vec<_>>(), vec!["ubuntu", "root"]);

    // 放寬到兩個。/ Widen to both.
    let r = lab.app.patch(&path(dev.tunnel_id, &entry), Some(&alice.token), json!({"accounts": [root, ubuntu]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("root", "pending"), ("ubuntu", "installed")]));
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert!(boxm.authorized_keys("root").contains(&alice.key.bare()));
    assert_eq!(lab.laptop_exec(&alice, &to_root, "whereami").await.stdout, "root@picky");

    // 縮回只剩 root：ubuntu 上的變成「移除中」，同步後離開。/ Narrow to root: ubuntu's copy is removed.
    let r = lab.app.patch(&path(dev.tunnel_id, &entry), Some(&alice.token), json!({"accounts": [root]})).await;
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[("removing", "alice", true)]), "{}", r.text);
    assert_eq!(r.json["removals"][0]["username"], "ubuntu");
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(view_rows(&r.json, "ubuntu"), rows(&[]));
    assert!(!boxm.authorized_keys("ubuntu").contains(&alice.key.bare()));
    assert!(boxm.authorized_keys("root").contains(&alice.key.bare()));
    assert!(!lab.laptop_exec(&alice, &to_ubuntu, "whoami").await.ok);

    // null = 全部。/ null = every allowed account.
    let r = lab.app.patch(&path(dev.tunnel_id, &entry), Some(&alice.token), json!({"accounts": null})).await;
    assert_eq!(r.json["entries"][0]["accounts"], Value::Null, "{}", r.text);
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert!(boxm.authorized_keys("ubuntu").contains(&alice.key.bare()));
    // 不在清單上的金鑰：404。/ Not listed: 404.
    let r = lab.app.patch(&path(dev.tunnel_id, "device-keys/424242"), Some(&alice.token), json!({"accounts": null})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
}

/// Windows 裝置：管理員的金鑰寫到共用的 `administrators_authorized_keys`（就地改寫，檔案本身不換），一般帳號照舊。
/// On a Windows device an administrator's keys go to the shared admin file, rewritten in place.
#[tokio::test]
async fn windows_administrators_use_the_shared_admin_file() {
    use std::os::unix::fs::MetadataExt;
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let opts = common::lab::MachineOpts { pretend_windows: true, windows_admins: &["nat"], ..Default::default() };
    let boxm = lab.machine_with("winbox", &[("nat", &[&lab.service]), ("guest", &[&lab.service])], opts).await;
    boxm.account_home("nat");
    boxm.account_home("guest");
    let admin_file = boxm.admin_authorized_keys_path();
    std::fs::write(&admin_file, "# admins only\n").unwrap();
    let inode = std::fs::metadata(&admin_file).unwrap().ino();
    let dev = lab.device(&alice, "winbox", &boxm).await;
    lab.username(&alice, &dev, "nat").await;
    lab.username(&alice, &dev, "guest").await;
    let alice_key = key_id(&lab, &alice).await;
    let to_nat = [(Hop::Tunnel(&dev), "nat")];

    assert!(!lab.laptop_exec(&alice, &to_nat, "whoami").await.ok);
    lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&alice.token), json!({"user_key_ids": [alice_key]})).await;
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("guest", "installed"), ("nat", "installed")]));
    assert_eq!(r.json["platform"]["windows"], true, "{}", r.text);
    let accounts = r.json["view"]["accounts"].as_array().unwrap().clone();
    let nat = accounts.iter().find(|a| a["username"] == "nat").unwrap();
    let guest = accounts.iter().find(|a| a["username"] == "guest").unwrap();
    assert_eq!((nat["windows_admin"].as_bool(), nat["file"].as_str()), (Some(true), Some("%ProgramData%\\ssh\\administrators_authorized_keys")));
    assert_eq!((guest["windows_admin"].as_bool(), guest["file"].as_str()), (Some(false), Some("~/.ssh/authorized_keys")));
    // 管理員的金鑰在共用檔裡（註解保留、檔案就地改寫），不在它自己的 ~/.ssh。/ In the shared file, in place; not in ~/.ssh.
    let admin = boxm.admin_authorized_keys();
    assert!(admin.starts_with("# admins only\n"), "{admin}");
    assert!(admin.contains(&format!("{} telepy:alice/alice-laptop", alice.key.bare())), "{admin}");
    assert_eq!(std::fs::metadata(&admin_file).unwrap().ino(), inode, "the admin file must be rewritten in place");
    assert!(!boxm.authorized_keys("nat").contains(&alice.key.bare()));
    assert!(boxm.authorized_keys("guest").contains(&alice.key.bare()));
    assert_eq!(lab.laptop_exec(&alice, &to_nat, "whereami").await.stdout, "nat@winbox");
    assert_eq!(lab.laptop_exec(&alice, &[(Hop::Tunnel(&dev), "guest")], "whereami").await.stdout, "guest@winbox");

    // 移出清單：從共用檔移除，註解還在。/ Off the list: removed from the shared file, the comment stays.
    lab.app.delete(&path(dev.tunnel_id, &format!("device-keys/{alice_key}")), Some(&alice.token)).await;
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    let admin = boxm.admin_authorized_keys();
    assert!(!admin.contains(&alice.key.bare()), "{admin}");
    assert!(admin.starts_with("# admins only\n"), "{admin}");
    assert!(!lab.laptop_exec(&alice, &to_nat, "whoami").await.ok);
}

/// 手動（批次）移除可以還原：移掉的行記 7 天，還原接回檔尾、已經在檔案裡的跳過；還原兩次 = 什麼都不做。
/// A manual removal can be undone: the lines are kept, restore appends them back, restoring twice is a no-op.
#[tokio::test]
async fn bulk_removal_can_be_undone() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let boxm = lab.machine("undo", &[("ubuntu", &[&lab.service])], false).await;
    let home = boxm.account_home("ubuntu");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    let keys: Vec<String> = (0..3).map(|i| fake_ed25519(100 + i, &format!("fleet-{i}"))).collect();
    std::fs::write(home.join(".ssh/authorized_keys"), format!("# fleet\n{}\n{}\nno-pty {}\n{}\n", lab.service.public, keys[0], keys[1], keys[2])).unwrap();
    let dev = lab.device(&alice, "undo", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let r = lab.app.get(&path(dev.tunnel_id, "authorized-keys"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let lines = r.json["accounts"][0]["lines"].as_array().unwrap().clone();
    let fp = |comment: &str| lines.iter().find(|l| l["comment"] == comment).unwrap()["fingerprint"].as_str().unwrap().to_string();

    let remove = path(dev.tunnel_id, "authorized-keys/remove");
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprints": [fp("fleet-0"), fp("fleet-1")]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["keys"], 2);
    let removal_id = r.json["removal_id"].as_i64().expect("removal_id");
    let after = boxm.authorized_keys("ubuntu");
    assert_eq!(after, format!("# fleet\n{}\n{}\n", lab.service.public, keys[2]));

    let r = lab.app.get(&path(dev.tunnel_id, "authorized-keys/removals"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["retention_days"], 7);
    assert_eq!(r.json["removals"][0]["id"], removal_id);
    assert_eq!((r.json["removals"][0]["keys"].as_i64(), r.json["removals"][0]["lines"].as_i64()), (Some(2), Some(2)));
    assert_eq!(r.json["removals"][0]["removed_by"], "alice");
    assert!(r.json["removals"][0]["restored_at"].is_null());

    // 還原：兩行接回檔尾（options 也保留）。/ Restore: both lines come back at the end, options kept.
    let restore = path(dev.tunnel_id, &format!("authorized-keys/restore/{removal_id}"));
    let r = lab.app.post(&restore, Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["restored"].as_i64(), r.json["skipped"].as_i64()), (Some(2), Some(0)));
    assert_eq!(boxm.authorized_keys("ubuntu"), format!("{after}{}\nno-pty {}\n", keys[0], keys[1]));
    // 再還原一次：都在了，檔案不變。/ Again: everything is present, nothing changes.
    let r = lab.app.post(&restore, Some(&alice.token), json!({})).await;
    assert_eq!((r.json["restored"].as_i64(), r.json["skipped"].as_i64()), (Some(0), Some(2)), "{}", r.text);
    assert_eq!(boxm.authorized_keys("ubuntu"), format!("{after}{}\nno-pty {}\n", keys[0], keys[1]));
    let r = lab.app.get(&path(dev.tunnel_id, "authorized-keys/removals"), Some(&alice.token)).await;
    assert!(r.json["removals"][0]["restored_at"].is_string(), "{}", r.text);
    // 不存在的紀錄、單把移除也有 removal_id、沒權限的人 403。/ Unknown record; single removal has an id too; non-managers 403.
    let r = lab.app.post(&path(dev.tunnel_id, "authorized-keys/restore/999999"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprint": fp("fleet-2")})).await;
    assert!(r.json["removal_id"].is_i64(), "{}", r.text);
    let r = lab.app.post(&remove, Some(&alice.token), json!({"username": "ubuntu", "fingerprints": ["SHA256:nope"]})).await;
    assert!(r.json["removal_id"].is_null(), "{}", r.text);
    let bob = lab.user("bob").await;
    let r = lab.app.get(&path(dev.tunnel_id, "authorized-keys/removals"), Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
}

/// 等到條件成立（最多 `secs` 秒）。/ Wait until a condition holds (at most `secs` seconds).
async fn eventually(what: &str, secs: u64, mut ok: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(secs);
    while !ok() {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for: {what}");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// 停用一個帳號：Telepy 替他裝的金鑰離開每台裝置（在線的馬上、離線的等它回來），手動加的那行留著，清單也留著；
/// 重新啟用就裝回去。直接在清單上的與金鑰群組授予的一樣；停用前的預估數得出來。
/// Disabling an account takes the keys Telepy installed for them off every device (online ones at once, offline
/// ones when they reconnect); a line added by hand stays, the list stays, and re-enabling puts the keys back.
/// Direct entries and key-group grants behave alike; the disable preview counts them.
#[tokio::test]
async fn a_disabled_accounts_keys_leave_the_devices() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    // 背景同步（kick + 15 秒一輪）：正式環境 main.rs 起的那個。/ The background sync main.rs starts in production.
    tokio::spawn(telepy_server::device_keys::run(lab.app.state.clone()));
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let bob_key = key_id(&lab, &bob).await;
    // bob 的第二把金鑰：Telepy 認得，但是手動貼進 one 的檔案裡。/ Bob's second key, pasted into one's file by hand.
    let bob2 = lab.keygen("bob-2");
    let r = lab.app.post("/api/reverse/user/keys", Some(&bob.token), json!({"host_friendly_name": "bob-2", "key": bob2.public})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let one = lab.machine("one", &[("pi", &[&lab.service])], false).await;
    let two = lab.machine("two", &[("pi", &[&lab.service])], false).await;
    let home = one.account_home("pi");
    two.account_home("pi");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::write(home.join(".ssh/authorized_keys"), format!("{}\n", bob2.public)).unwrap();
    let d1 = lab.device(&alice, "one", &one).await;
    let d2 = lab.device(&alice, "two", &two).await;
    let pi1 = lab.username(&alice, &d1, "pi").await;
    let pi2 = lab.username(&alice, &d2, "pi").await;
    lab.share(&alice, &d1, &bob, "view", &[pi1]).await;
    lab.share(&alice, &d2, &bob, "view", &[pi2]).await;
    // one：直接在清單上；two：經由 bob 的金鑰群組。/ one: listed directly; two: through bob's key group.
    let r = lab.app.post(&path(d1.tunnel_id, "device-keys"), Some(&bob.token), json!({"user_key_ids": [bob_key]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.post("/api/reverse/user/key-groups", Some(&bob.token), json!({"name": "Laptop", "key_ids": [bob_key]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let group = r.json["group"]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/reverse/user/key-groups/{group}/grants"), Some(&bob.token), json!({"tunnel_id": d2.tunnel_id})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    for d in [&d1, &d2] {
        let r = lab.app.post(&path(d.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    }
    let bare = bob.key.bare();
    assert!(one.authorized_keys("pi").contains(&bare) && two.authorized_keys("pi").contains(&bare));

    // two 離線；停用前的預估：兩台、兩個帳號、一台離線。/ two goes offline; the preview: two devices, one offline.
    lab.disconnect_device(&d2).await;
    let preview = lab.app.get(&format!("/api/user/users/{}/disable-preview", bob.id), Some(&lab.admin_token)).await;
    assert_eq!(preview.json["device_keys"], json!({"devices": 2, "accounts": 2, "offline_devices": 1}), "{}", preview.text);

    // 停用：在線的 one 幾秒內就拿掉，手動那行留著；離線的 two 還在。/ Disable: one is cleaned at once, two keeps it.
    let r = lab.app.post(&format!("/api/user/users/{}", bob.id), Some(&lab.admin_token), json!({"is_active": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["disabled"]["device_keys"], json!({"devices": 2, "accounts": 2, "offline_devices": 1}));
    eventually("one loses the key Telepy installed", 10, || !one.authorized_keys("pi").contains(&bare)).await;
    assert!(one.authorized_keys("pi").contains(&bob2.bare()), "a line added by hand stays: {}", one.authorized_keys("pi"));
    assert!(two.authorized_keys("pi").contains(&bare), "an offline device keeps it for now");
    // 面板：清單還在（擁有者停用）、手動的那行標出來；記一筆事件。/ The panel and the event.
    let v = lab.app.get(&path(d1.tunnel_id, "device-keys"), Some(&alice.token)).await.json;
    let entry = v["entries"].as_array().unwrap().iter().find(|e| e["user_key_id"] == bob_key).unwrap_or_else(|| panic!("the entry stays: {v}")).clone();
    assert_eq!((entry["owner_disabled"].as_bool(), entry["targets"].clone()), (Some(true), json!([])), "{entry}");
    let rows = v["view"]["accounts"][0]["rows"].as_array().unwrap().clone();
    let manual = rows.iter().find(|r| r["state"] == "manual").unwrap_or_else(|| panic!("{rows:?}"));
    assert_eq!((manual["owner"].as_str(), manual["owner_disabled"].as_bool()), (Some("bob"), Some(true)));
    assert!(rows.iter().all(|r| r["state"] != "removing" && r["state"] != "installed"), "{rows:?}");
    let events = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={}", d1.tunnel_id), Some(&alice.token)).await.json;
    let ev = events.as_array().unwrap().iter().find(|e| e["event"] == "device_key_owner_disabled").unwrap_or_else(|| panic!("{events}")).clone();
    assert!(ev["message"].as_str().unwrap().contains("bob's account is disabled"), "{ev}");
    // 管理者用既有的移除鈕拿掉手動那行。/ A manager removes the hand-added line with the existing remove action.
    let fp = manual["fingerprint"].as_str().unwrap().to_string();
    let r = lab.app.post(&path(d1.tunnel_id, "authorized-keys/remove"), Some(&alice.token), json!({"username": "pi", "fingerprint": fp})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(!one.authorized_keys("pi").contains(&bob2.bare()));

    // two 回來：下一輪（≤ 15 秒）拿掉。/ two comes back: the next tick removes it.
    lab.reconnect_device(&d2).await;
    eventually("two loses the key once it is back", 30, || !two.authorized_keys("pi").contains(&bare)).await;
    let events = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={}", d2.tunnel_id), Some(&alice.token)).await.json;
    assert!(events.as_array().unwrap().iter().any(|e| e["event"] == "device_key_owner_disabled"), "{events}");
    assert_eq!(lab.app.get(&format!("/api/user/users/{}/disable-preview", bob.id), Some(&lab.admin_token)).await.json["device_keys"]["devices"], 0);

    // 重新啟用：兩台都裝回去（直接的與群組的）。/ Re-enable: both devices get the key back.
    let r = lab.app.post(&format!("/api/user/users/{}", bob.id), Some(&lab.admin_token), json!({"is_active": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    eventually("one gets the key back", 10, || one.authorized_keys("pi").contains(&bare)).await;
    eventually("two gets the key back", 10, || two.authorized_keys("pi").contains(&bare)).await;
    let v = lab.app.get(&path(d1.tunnel_id, "device-keys"), Some(&alice.token)).await.json;
    let entry = v["entries"].as_array().unwrap().iter().find(|e| e["user_key_id"] == bob_key).unwrap().clone();
    assert_eq!(entry["owner_disabled"], false);
    assert_eq!(lab.laptop_exec(&bob, &[(Hop::Tunnel(&d1), "pi")], "whereami").await.stdout, "pi@one");
}

/// 伺服器讀的不是 `~/.ssh/authorized_keys`（像 GL-MT3000 的 Dropbear 對 root 只讀 `/etc/dropbear/authorized_keys`），而且
/// Telepy 的金鑰兩個檔都有（舊版在 SFTP 模式寫進伺服器不讀的 `~/.ssh`）：Telepy 用一把臨時金鑰登入，試出伺服器讀的那個
/// 檔，使用者的金鑰裝到那裡（筆電真的登得進去），臨時那行不留。
/// The server reads something other than `~/.ssh/authorized_keys` (like the GL-MT3000's Dropbear, which reads only
/// `/etc/dropbear/authorized_keys` for root) and Telepy's key sits in both files (an older Telepy wrote the unread
/// `~/.ssh` in SFTP mode): a throwaway-key login finds the file the server reads, the user's key goes there (the laptop
/// really logs in), and no throwaway line is left behind.
#[tokio::test]
async fn keys_go_to_the_file_the_server_reads() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let opts = common::lab::MachineOpts { shell: true, keys_file: Some(".ssh/authorized_keys2"), ..Default::default() };
    let none: &[&common::lab::LabKey] = &[];
    let boxm = lab.machine_with("wrt-keys", &[("root", none)], opts).await;
    let ssh = boxm.account_home("root").join(".ssh");
    std::fs::create_dir_all(&ssh).unwrap();
    let dev = lab.device(&alice, "wrt-keys", &boxm).await;
    let line = lab.tunnel_service_key(&dev).await;
    std::fs::write(ssh.join("authorized_keys"), format!("{line}\n")).unwrap();
    std::fs::write(ssh.join("authorized_keys2"), format!("# the server reads this one\n{line}\n")).unwrap();
    lab.username(&alice, &dev, "root").await;
    let alice_key = key_id(&lab, &alice).await;
    let to_root = [(Hop::Tunnel(&dev), "root")];
    assert!(!lab.laptop_exec(&alice, &to_root, "echo in").await.ok);

    lab.app.post(&path(dev.tunnel_id, "device-keys"), Some(&alice.token), json!({"user_key_ids": [alice_key]})).await;
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(targets(&r.json["entries"][0]), pairs(&[("root", "installed")]), "{}", r.text);
    let read = |f: &str| std::fs::read_to_string(ssh.join(f)).unwrap_or_default();
    let read_by_server = read("authorized_keys2");
    assert!(read_by_server.starts_with("# the server reads this one\n") && read_by_server.contains(&alice.key.bare()), "{read_by_server}");
    assert!(!read("authorized_keys").contains(&alice.key.bare()), "not into the file the server ignores: {}", read("authorized_keys"));
    assert!(!read_by_server.contains("telepy-locate-") && !read("authorized_keys").contains("telepy-locate-"), "the throwaway key is gone");
    assert!(!ssh.join("authorized_keys2.telepy-locate").exists() && !ssh.join("authorized_keys.telepy-locate").exists());
    assert_eq!(lab.laptop_exec(&alice, &to_root, "echo in").await.stdout, "in", "the laptop logs in with the installed key");
    let root = r.json["view"]["accounts"].as_array().unwrap().iter().find(|a| a["username"] == "root").unwrap().clone();
    assert!(root["file"].as_str().unwrap_or("").ends_with("/.ssh/authorized_keys2"), "the panel names the real file: {root}");

    // 移出清單：從伺服器讀的那個檔拿掉。/ Off the list: removed from the file the server reads.
    lab.app.delete(&path(dev.tunnel_id, &format!("device-keys/{alice_key}")), Some(&alice.token)).await;
    lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&alice.token), json!({})).await;
    assert!(!read("authorized_keys2").contains(&alice.key.bare()), "{}", read("authorized_keys2"));
    assert!(!lab.laptop_exec(&alice, &to_root, "echo in").await.ok);
}
