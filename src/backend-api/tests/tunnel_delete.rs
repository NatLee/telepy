//! 刪隧道前的檢查與刪除時的清理（common::lab）：檢查列出分享、Telepy 裝過的金鑰、MCP 授權與 AI session；
//! 刪除依選項從裝置移除金鑰（與服務金鑰）、撤銷只限這條隧道的授權、把隧道從其他授權拿掉，並踢掉裝置的連線。
//! The delete check and the cleanup on delete, on the SSH lab: keys removed from the real device files,
//! grants revoked / detached, the device's gateway connection dropped.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::lab::{sftp_server_bin, Lab, LabUser};
use serde_json::{json, Value};
use telepy_server::db;

async fn client(lab: &Lab, id: &str, name: &str) {
    db::oauth::client_create(
        &lab.app.state.db,
        db::oauth::NewClient {
            client_id: id,
            client_secret_hash: None,
            client_name: name,
            redirect_uris: &["http://localhost:9/cb".to_string()],
            token_endpoint_auth_method: "none",
            client_uri: None,
            logo_uri: None,
        },
    )
    .await
    .unwrap();
}

async fn grant(lab: &Lab, user: &LabUser, client_id: &str, tunnels: Option<&[i64]>) -> i64 {
    let expires = telepy_server::util::db_time(chrono::Utc::now() + chrono::Duration::days(30));
    db::oauth::grant_create(
        &lab.app.state.db,
        db::oauth::NewGrant {
            user_id: user.id,
            client_id,
            scope: "tunnels:read ssh:exec",
            tunnel_ids: tunnels,
            resource: "http://localhost/mcp",
            refresh_token_hash: &format!("hash-{client_id}-{}", user.id),
            refresh_expires_at: &expires,
        },
    )
    .await
    .unwrap()
    .id
}

fn coverages(check: &Value) -> Vec<(String, String, String)> {
    check["grants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| (g["client_name"].as_str().unwrap().to_string(), g["user"]["username"].as_str().unwrap().to_string(), g["coverage"].as_str().unwrap().to_string()))
        .collect()
}

fn own(v: &[(&str, &str, &str)]) -> Vec<(String, String, String)> {
    v.iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string())).collect()
}

#[tokio::test]
async fn delete_check_and_cleanup_on_a_live_device() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    for account in ["ubuntu", "root"] {
        let home = boxm.account_home(account);
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh/authorized_keys"), format!("# by hand\n{}\n", lab.service.public)).unwrap();
    }
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.username(&alice, &dev, "root").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let alice_key = lab.app.get("/api/reverse/user/keys", Some(&alice.token)).await.json[0]["id"].as_i64().unwrap();
    let base = format!("/api/reverse/server/{}", dev.tunnel_id);
    let r = lab.app.post(&format!("{base}/device-keys"), Some(&alice.token), json!({"user_key_ids": [alice_key]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.post(&format!("{base}/device-keys/sync"), Some(&alice.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(boxm.authorized_keys("ubuntu").contains(&alice.key.bare()));

    let other = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "other", key: &lab.keygen("other-tunnel").public, reverse_port: 1, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    for (id, name) in [("c-only", "Only App"), ("c-shared", "Shared App"), ("c-all", "All App")] {
        client(&lab, id, name).await;
    }
    let g_only = grant(&lab, &alice, "c-only", Some(&[dev.tunnel_id])).await;
    let g_shared = grant(&lab, &alice, "c-shared", Some(&[dev.tunnel_id, other.id])).await;
    grant(&lab, &alice, "c-all", None).await;
    grant(&lab, &bob, "c-all", None).await;
    // carol 看不到這條隧道：她不限隧道的授權跟它無關。/ Carol cannot see the tunnel; her grant is unrelated.
    grant(&lab, &carol, "c-all", None).await;

    // --- 檢查：VIEW 的 bob 不能刪也不能看；alice 看到全部影響
    let check_path = format!("{base}/delete-check");
    assert_eq!(lab.app.get(&check_path, Some(&bob.token)).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.get(&check_path, Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let c = r.json;
    assert_eq!(c["online"], true);
    assert_eq!(c["accounts"], json!(["ubuntu", "root"]));
    assert_eq!(c["sharees"], json!([{"id": bob.id, "username": "bob", "permission": "view"}]));
    let keys = c["device_keys"].as_array().unwrap();
    assert_eq!(keys.len(), 1, "{c}");
    assert_eq!((keys[0]["owner"].as_str(), keys[0]["name"].as_str(), keys[0]["in_list"].as_bool()), (Some("alice"), Some("alice-laptop"), Some(true)));
    assert_eq!(keys[0]["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(
        coverages(&c),
        own(&[("Only App", "alice", "only"), ("Shared App", "alice", "shared"), ("All App", "alice", "all"), ("All App", "bob", "all")])
    );
    assert_eq!(c["grants"][1]["other_tunnels"], 1);
    assert_eq!(c["grants"][3]["mine"], false);

    // --- 刪除：移除金鑰 + 服務金鑰、撤銷只限這條的授權
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}?remove_device_keys=true&remove_service_key=true&revoke_grants=true", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let rep = r.json;
    assert_eq!((rep["deleted"].as_bool(), rep["online"].as_bool(), rep["keys_left"].as_i64()), (Some(true), Some(true), Some(0)), "{rep}");
    for a in rep["accounts"].as_array().unwrap() {
        assert_eq!((a["removed"].as_i64(), a["service_key_removed"].as_bool(), a["error"].clone()), (Some(1), Some(true), Value::Null), "{rep}");
    }
    assert_eq!((rep["grants_revoked"].as_i64(), rep["grants_detached"].as_i64()), (Some(1), Some(1)), "{rep}");
    assert_eq!(rep["device_disconnected"], true);
    for account in ["ubuntu", "root"] {
        assert_eq!(boxm.authorized_keys(account), "# by hand\n", "{account}");
    }
    let only = db::oauth::grant_by_id(&lab.app.state.db, g_only).await.unwrap().unwrap();
    assert!(only.revoked_at.is_some());
    let shared = db::oauth::grant_by_id(&lab.app.state.db, g_shared).await.unwrap().unwrap();
    assert_eq!((shared.revoked_at.is_none(), shared.tunnel_id_list()), (true, Some(vec![other.id])));
    // 裝置被踢掉，forward 釋放。/ The device was dropped and its forward released.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while lab.app.state.status.listen_ports().is_some_and(|p| p.contains(&dev.reverse_port)) {
        assert!(tokio::time::Instant::now() < deadline, "forward never released");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(lab.app.get(&format!("/api/reverse/server/keys/{}", dev.tunnel_id), Some(&alice.token)).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn offline_delete_keeps_grants_by_default_and_app_details() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    // 從沒連上來的隧道 + 一筆「裝過」的紀錄 = 裝置離線時刪除。/ A tunnel that is offline, with an install record.
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "gone", key: &lab.keygen("gone-tunnel").public, reverse_port: 2, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    db::device_keys::installed_insert(&lab.app.state.db, t.id, "pi", &alice.key.bare(), "SHA256:x", None, Some(alice.id)).await.unwrap();
    client(&lab, "c-only", "Only App").await;
    let g = grant(&lab, &alice, "c-only", Some(&[t.id])).await;
    db::ai_audit::insert(
        &lab.app.state.db,
        db::ai_audit::NewEvent { user_id: alice.id, grant_id: Some(g), client_name: "Only App", tool: "list_tunnels", ok: false, error: Some("boom"), ..Default::default() },
    )
    .await
    .unwrap();

    // --- app 詳細資料：本人看得到（client、統計、最近紀錄），別人 404
    let path = format!("/api/oauth/grants/{g}");
    assert_eq!(lab.app.get(&path, Some(&bob.token)).await.status, StatusCode::NOT_FOUND);
    let r = lab.app.get(&path, Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["tunnels"], json!([{"id": t.id, "name": "gone"}]));
    assert_eq!(r.json["client"]["redirect_hosts"], json!(["localhost:9"]));
    assert_eq!(r.json["client"]["public"], true);
    assert_eq!(r.json["user"]["username"], "alice");
    assert_eq!((r.json["stats"]["calls"].as_i64(), r.json["stats"]["failed"].as_i64()), (Some(1), Some(1)));
    assert_eq!(r.json["activity"][0]["tool"], "list_tunnels");
    assert_eq!(r.json["activity"][0]["grant_id"], g);
    assert_eq!(r.json["sessions"], json!([]));
    // 同一個 app 的紀錄也能從 /api/ai/activity 篩出來。/ The activity endpoint filters by grant too.
    let r = lab.app.get(&format!("/api/ai/activity?grant_id={g}"), Some(&alice.token)).await;
    assert_eq!(r.json.as_array().unwrap().len(), 1);
    let r = lab.app.get(&format!("/api/ai/activity?grant_id={}", g + 1), Some(&alice.token)).await;
    assert_eq!(r.json, json!([]));

    let r = lab.app.get(&format!("/api/reverse/server/{}/delete-check", t.id), Some(&alice.token)).await;
    assert_eq!((r.json["online"].as_bool(), r.json["device_keys"][0]["in_list"].as_bool()), (Some(false), Some(false)), "{}", r.text);
    assert_eq!(r.json["device_keys"][0]["owner"], "alice");

    // --- 沒帶選項：離線所以金鑰留在裝置上；授權不撤銷，但這條隧道從清單拿掉
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}", t.id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["online"].as_bool(), r.json["keys_left"].as_i64(), r.json["accounts"].clone()), (Some(false), Some(1), json!([])), "{}", r.text);
    assert_eq!((r.json["grants_revoked"].as_i64(), r.json["grants_detached"].as_i64()), (Some(0), Some(1)));
    assert_eq!(r.json["device_disconnected"], false);
    let grants = lab.app.get("/api/oauth/grants", Some(&alice.token)).await.json;
    assert_eq!(grants[0]["tunnels"], json!([]), "{grants}");
    assert!(db::device_keys::installed_for_tunnel(&lab.app.state.db, t.id).await.unwrap().is_empty());
}
