//! 存取申請：VIEW sharee 要 root 帳號 + EDIT 權限一段時間；ADMIN / owner 核准後真的登得進 root（網頁終端機經裝置
//! sshd），期滿（還沒回收前就已失效）後回收、回到原本的權限；拒絕、收回、分享結束時取消。
//! Access requests: a VIEW sharee asks for root + EDIT for a while; once approved the web terminal really logs in as
//! root on the device; at the end (already in force before the reaper runs) it is reverted. Deny, cancel, and
//! ending the share cancel pending requests.
mod common;

use axum::http::StatusCode;
use common::lab::Lab;
use serde_json::{json, Value};
use telepy_server::{api::access_requests, db};

async fn item(lab: &Lab, token: &str, id: i64) -> Option<Value> {
    let r = lab.app.get("/api/reverse/server/dashboard", Some(token)).await;
    r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).cloned()
}

#[tokio::test]
async fn sharees_ask_and_owners_grant_for_a_while() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let dave = lab.user("dave").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let root = lab.username(&alice, &dev, "root").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "admin", &[]).await;
    let list = format!("/api/reverse/server/{}/access-requests", dev.tunnel_id);

    // bob 看得到可以要的帳號；root 現在不能用。/ bob sees what he could ask for; root is off limits for now.
    let r = lab.app.get(&list, Some(&bob.token)).await;
    assert_eq!((r.json["can_request"].as_bool(), r.json["can_decide"].as_bool()), (Some(true), Some(false)), "{}", r.text);
    let accounts = r.json["accounts"].as_array().unwrap();
    assert!(accounts.iter().any(|a| a["username"] == "root" && a["allowed"] == false), "{}", r.text);
    assert!(accounts.iter().any(|a| a["username"] == "ubuntu" && a["allowed"] == true), "{}", r.text);
    assert_eq!(lab.terminal(&bob, &dev, "root").await.err(), Some(4003));

    // 檢查：沒要新東西、權限沒更高、時長不對；看不到隧道的人 404。/ Validation; strangers get 404.
    let ask = |body: Value| {
        let (lab, list, token) = (&lab, list.clone(), bob.token.clone());
        async move { lab.app.post(&list, Some(&token), body).await }
    };
    let code = |r: &common::Resp| r.json["code"].as_str().unwrap_or_default().to_string();
    let r = ask(json!({"account_ids": [ubuntu], "duration_secs": 3600})).await;
    assert_eq!((r.status, code(&r).as_str()), (StatusCode::BAD_REQUEST, "nothing_requested"), "{}", r.text);
    let r = ask(json!({"permission": "view", "duration_secs": 3600})).await;
    assert_eq!(code(&r), "permission_not_higher", "{}", r.text);
    let r = ask(json!({"account_ids": [root], "duration_secs": 60})).await;
    assert_eq!(code(&r), "bad_duration", "{}", r.text);
    assert_eq!(lab.app.post(&list, Some(&dave.token), json!({"account_ids": [root], "duration_secs": 3600})).await.status, StatusCode::NOT_FOUND);
    let r = lab.app.post(&list, Some(&carol.token), json!({"permission": "admin", "duration_secs": 3600})).await;
    assert_eq!(code(&r), "not_sharee", "an ADMIN sharee already has everything: {}", r.text);

    // 申請：root + EDIT，一小時。一次只能一筆。/ The request: root + EDIT for an hour; one at a time.
    let r = ask(json!({"account_ids": [root], "permission": "edit", "duration_secs": 3600, "reason": "deploy the fix"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let rid = r.json["id"].as_i64().unwrap();
    assert_eq!(r.json["accounts"][0]["username"], "root");
    assert_eq!(ask(json!({"account_ids": [root], "duration_secs": 3600})).await.status, StatusCode::CONFLICT);
    assert_eq!(item(&lab, &alice.token, dev.tunnel_id).await.unwrap()["access_requests"], 1, "owner sees one waiting");
    assert_eq!(item(&lab, &carol.token, dev.tunnel_id).await.unwrap()["access_requests"], 1, "so does an ADMIN sharee");
    assert_eq!(item(&lab, &bob.token, dev.tunnel_id).await.unwrap()["access_requests"], 0);

    // bob 不能自己核准；carol（ADMIN）看得到並可以決定。/ bob can't approve; carol (ADMIN) can.
    let approve = format!("/api/reverse/access-requests/{rid}/approve");
    assert_eq!(lab.app.post(&approve, Some(&bob.token), json!({})).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.get(&list, Some(&carol.token)).await;
    assert_eq!(r.json["requests"][0]["status"], "pending", "{}", r.text);
    assert_eq!(r.json["requests"][0]["reason"], "deploy the fix");

    // alice 核准、改成兩小時；第二個人再按就是 409。/ alice approves for two hours; a second decision is a 409.
    let r = lab.app.post(&approve, Some(&alice.token), json!({"duration_secs": 7200})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["status"], "approved");
    assert_eq!(r.json["decided_by"], "alice");
    assert!(r.json["ends_at"].is_string());
    assert_eq!(lab.app.post(&approve, Some(&carol.token), json!({})).await.status, StatusCode::CONFLICT);

    // 真的登得進 root；權限是 EDIT（暫時），owner 看得到期限。/ root really works; EDIT for now; the owner sees the ends.
    let mut t = lab.terminal(&bob, &dev, "root").await.expect("root is allowed now");
    t.expect("login:root@box").await;
    t.close().await;
    assert_eq!(item(&lab, &bob.token, dev.tunnel_id).await.unwrap()["can_edit"], true);
    let shared = lab.app.get(&format!("/tunnels/shared-users/{}", dev.tunnel_id), Some(&alice.token)).await;
    let row = shared.json["users"].as_array().unwrap().iter().find(|u| u["username"] == "bob").unwrap().clone();
    assert_eq!((row["permission_type"].as_str(), row["base_permission"].as_str()), (Some("edit"), Some("view")), "{row}");
    assert!(row["permission_until"].is_string(), "{row}");
    let root_row = row["allowed_target_usernames"].as_array().unwrap().iter().find(|a| a["username"] == "root").unwrap().clone();
    assert!(root_row["until"].is_string(), "root is temporary: {root_row}");

    // owner 改允許清單時，暫時的帳號維持暫時。/ Editing the allow-list keeps a temporary account temporary.
    let r = lab.app.patch(&format!("/tunnels/share/{}/{}/allowed-usernames", dev.tunnel_id, bob.id), Some(&alice.token), json!({"allowed_target_username_ids": [ubuntu, root]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let sharing = db::sharing::get(&lab.app.state.db, dev.tunnel_id, bob.id).await.unwrap().unwrap();
    assert!(db::access_requests::username_ends(&lab.app.state.db, sharing.id).await.unwrap().contains_key(&root));

    // 時間到（改 DB 模擬）：回收前就已失效，回收後回到原本的。/ Past the end: in force before the reaper, reverted after.
    let db = &lab.app.state.db;
    sqlx::query("UPDATE tunnels_tunnelsharingallowedusername SET expires_at = '2000-01-01 00:00:00.000000' WHERE expires_at IS NOT NULL").execute(&db.write).await.unwrap();
    sqlx::query("UPDATE tunnels_tunnelsharing SET permission_until = '2000-01-01 00:00:00.000000' WHERE permission_until IS NOT NULL").execute(&db.write).await.unwrap();
    assert_eq!(lab.terminal(&bob, &dev, "root").await.err(), Some(4003), "root ends at its time, not when the reaper runs");
    assert_eq!(item(&lab, &bob.token, dev.tunnel_id).await.unwrap()["can_edit"], false);
    assert_eq!(access_requests::revert_once(&lab.app.state).await.unwrap(), 2);
    assert_eq!(access_requests::revert_once(&lab.app.state).await.unwrap(), 0, "only once");
    let shared = lab.app.get(&format!("/tunnels/shared-users/{}", dev.tunnel_id), Some(&alice.token)).await;
    let row = shared.json["users"].as_array().unwrap().iter().find(|u| u["username"] == "bob").unwrap().clone();
    assert_eq!(row["permission_type"], "view", "{row}");
    assert!(row["base_permission"].is_null() && row["permission_until"].is_null(), "{row}");
    let names: Vec<&str> = row["allowed_target_usernames"].as_array().unwrap().iter().filter_map(|a| a["username"].as_str()).collect();
    assert_eq!(names, ["ubuntu"], "{row}");
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("the permanent account still works");
    t.expect("login:ubuntu@box").await;
    t.close().await;

    // 拒絕：什麼都沒給。/ Denied: nothing granted.
    let rid = ask(json!({"account_ids": [root], "duration_secs": 3600})).await.json["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/reverse/access-requests/{rid}/deny"), Some(&carol.token), json!({})).await;
    assert_eq!((r.status, r.json["status"].as_str()), (StatusCode::OK, Some("denied")), "{}", r.text);
    assert_eq!(lab.terminal(&bob, &dev, "root").await.err(), Some(4003));

    // 收回：只有申請人自己，而且只在還在等的時候。/ Withdraw: the requester only, while pending.
    let rid = ask(json!({"permission": "edit", "duration_secs": 3600})).await.json["id"].as_i64().unwrap();
    let cancel = format!("/api/reverse/access-requests/{rid}");
    assert_eq!(lab.app.delete(&cancel, Some(&alice.token)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(lab.app.delete(&cancel, Some(&bob.token)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(lab.app.delete(&cancel, Some(&bob.token)).await.status, StatusCode::CONFLICT);

    // 分享結束時，還在等的申請一併取消。/ Ending the share cancels what is pending.
    let rid = ask(json!({"permission": "edit", "duration_secs": 3600})).await.json["id"].as_i64().unwrap();
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, bob.id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(db::access_requests::get(db, rid).await.unwrap().unwrap().status, "cancelled");
    let r = lab.app.get(&list, Some(&alice.token)).await;
    assert!(r.json["requests"].as_array().unwrap().iter().all(|q| q["status"] != "pending"), "{}", r.text);
}
