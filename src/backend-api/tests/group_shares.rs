//! 分享給使用者群組：成員各自拿到一筆分享（真的用允許的帳號登得進裝置），跟著群組成員增減；直接分享的人優先；
//! 經由群組的分享不能單獨改或離開；改群組分享、到期、刪群組都會收回。
//! Sharing with a user group: each member gets a share (and really logs in to the device as an allowed account),
//! which follows the group's members; a direct share wins; a share through a group can't be changed or left on its
//! own; changing the group share, its end and deleting the group all take access back.
mod common;

use std::collections::HashMap;

use axum::http::StatusCode;
use common::lab::Lab;
use serde_json::{json, Value};
use telepy_server::{db, group_shares};

async fn item(lab: &Lab, token: &str, id: i64) -> Option<Value> {
    let r = lab.app.get("/api/reverse/server/dashboard", Some(token)).await;
    r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == id).cloned()
}

/// 等背景的比對跑完（拿同一把鎖）。/ Wait for the background reconcile (same lock).
async fn settle(lab: &Lab) {
    group_shares::reconcile(&lab.app.state, &HashMap::new()).await.unwrap();
}

#[tokio::test]
async fn a_group_share_follows_the_group_and_a_direct_share_wins() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let dave = lab.user("dave").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let root = lab.username(&alice, &dev, "root").await;
    // carol 已經直接分享到 EDIT + root。/ carol already holds a direct share (EDIT + root).
    lab.share(&alice, &dev, &carol, "edit", &[root]).await;

    // 管理員建群組 ops = bob + carol。/ The admin makes the group ops = bob + carol.
    let r = lab.app.post("/api/access/groups", Some(&lab.admin_token), json!({"name": "ops", "members": [bob.id, carol.id]})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let ops = r.json["created_id"].as_i64().unwrap();

    let url = format!("/api/reverse/server/{}/group-shares", dev.tunnel_id);
    // 只有 owner / ADMIN 能分享；看不到通道的人 403。/ Only owner / ADMIN share; strangers are refused.
    assert_eq!(lab.app.post(&url, Some(&dave.token), json!({"group_id": ops})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(lab.app.get(&url, Some(&dave.token)).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": ops, "permission_type": "view", "allowed_target_username_ids": [ubuntu]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let gs = r.json["shares"][0]["id"].as_i64().unwrap();
    assert_eq!((r.json["shares"][0]["through"].as_i64(), r.json["shares"][0]["direct"].as_i64()), (Some(1), Some(1)), "{}", r.text);
    assert!(r.json["groups"].as_array().unwrap().iter().any(|g| g["id"] == ops && g["shared"] == true), "{}", r.text);
    assert_eq!(lab.app.post(&url, Some(&alice.token), json!({"group_id": ops})).await.status, StatusCode::BAD_REQUEST, "only once per group");

    // bob 經由群組拿到：看得到、ubuntu 登得進、root 不行。/ bob holds it through the group: ubuntu yes, root no.
    let it = item(&lab, &bob.token, dev.tunnel_id).await.expect("bob sees it");
    assert_eq!(it["share_group"], "ops", "{it}");
    assert!(lab.terminal(&bob, &dev, "ubuntu").await.is_ok());
    assert_eq!(lab.terminal(&bob, &dev, "root").await.err(), Some(4003));
    // carol 的直接分享不被群組改掉。/ carol's direct share is left alone.
    let c = db::sharing::get(&lab.app.state.db, dev.tunnel_id, carol.id).await.unwrap().unwrap();
    assert_eq!((c.permission_type.as_str(), c.group_share_id), ("edit", None));
    assert!(lab.terminal(&carol, &dev, "root").await.is_ok());

    // 名單標出經由哪個群組；成員名單只給能管分享的人。/ The list marks the group; member names only for managers.
    let r = lab.app.get(&format!("/tunnels/shared-users/{}", dev.tunnel_id), Some(&alice.token)).await;
    let users = r.json["users"].as_array().unwrap();
    let b = users.iter().find(|u| u["id"] == bob.id).unwrap();
    assert_eq!(b["via_group"]["name"], "ops", "{}", r.text);
    assert!(users.iter().find(|u| u["id"] == carol.id).unwrap()["via_group"].is_null());
    let r = lab.app.get(&url, Some(&bob.token)).await;
    assert_eq!((r.json["can_manage"].as_bool(), r.json["shares"][0]["member_names"].is_null()), (Some(false), true), "{}", r.text);

    // 經由群組的分享不能單獨改、撤銷或自己離開。/ It can't be changed, revoked or left on its own.
    let code = |r: &common::Resp| r.json["code"].as_str().unwrap_or_default().to_string();
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, bob.id), Some(&bob.token)).await;
    assert_eq!((r.status, code(&r).as_str()), (StatusCode::BAD_REQUEST, "via_group"), "{}", r.text);
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, bob.id), Some(&alice.token)).await;
    assert_eq!(code(&r), "via_group", "{}", r.text);
    let r = lab.app.patch(&format!("/tunnels/update-permission/{}/{}", dev.tunnel_id, bob.id), Some(&alice.token), json!({"permission_type": "admin"})).await;
    assert_eq!(code(&r), "via_group", "{}", r.text);
    let r = lab.app.patch(&format!("/tunnels/share/{}/{}/allowed-usernames", dev.tunnel_id, bob.id), Some(&alice.token), json!({"allowed_target_username_ids": [root]})).await;
    assert_eq!(code(&r), "via_group", "{}", r.text);

    // 改群組分享：EDIT + root，bob 跟著變。/ Changing the group share changes bob's access.
    let r = lab.app.patch(&format!("{url}/{gs}"), Some(&alice.token), json!({"permission_type": "edit", "allowed_target_username_ids": [ubuntu, root]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(db::sharing::get(&lab.app.state.db, dev.tunnel_id, bob.id).await.unwrap().unwrap().permission_type, "edit");
    assert!(lab.terminal(&bob, &dev, "root").await.is_ok());

    // 加 dave 進群組：他也拿到；拿掉 bob：他看不到了。/ dave joins and gets it; bob leaves and loses it.
    let r = lab.app.patch(&format!("/api/access/groups/{ops}"), Some(&lab.admin_token), json!({"members": [carol.id, dave.id]})).await;
    assert!(r.status.is_success(), "{}", r.text);
    settle(&lab).await;
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_none(), "bob left the group");
    assert_eq!(lab.terminal(&bob, &dev, "ubuntu").await.err(), Some(4004));
    assert_eq!(item(&lab, &dave.token, dev.tunnel_id).await.expect("dave sees it")["share_group"], "ops");

    // 主人單獨設定 dave：變成直接分享，之後群組不碰。/ Setting dave on his own makes it a direct share.
    let r = lab.app.post(&format!("/tunnels/share/{}", dev.tunnel_id), Some(&alice.token), json!({"shared_with_user_id": dave.id, "permission_type": "view", "allowed_target_username_ids": [ubuntu]})).await;
    assert_eq!((r.status, r.json["converted"].as_bool()), (StatusCode::CREATED, Some(true)), "{}", r.text);
    settle(&lab).await;
    let d = db::sharing::get(&lab.app.state.db, dev.tunnel_id, dave.id).await.unwrap().unwrap();
    assert_eq!((d.permission_type.as_str(), d.group_share_id), ("view", None));

    // 撤銷一個也在群組裡的直接分享：回應說群組還會給他。/ Revoking a direct share of a group member says the group still gives it.
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, dave.id), Some(&alice.token)).await;
    assert_eq!(r.json["still_via_groups"], json!(["ops"]), "{}", r.text);
    settle(&lab).await;
    let d = db::sharing::get(&lab.app.state.db, dev.tunnel_id, dave.id).await.unwrap().unwrap();
    assert_eq!((d.permission_type.as_str(), d.group_share_id), ("edit", Some(gs)), "back through the group");

    // 不再分享給群組：經由它的人收回，直接分享的 carol 留著。/ Stop sharing with the group: dave goes, carol stays.
    let r = lab.app.delete(&format!("{url}/{gs}"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(item(&lab, &dave.token, dev.tunnel_id).await.is_none());
    assert!(item(&lab, &carol.token, dev.tunnel_id).await.is_some());

    // 到期：群組分享和成員的分享一起收掉。/ Expiry ends the group share and the members' shares.
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": ops, "expires_at": "2099-01-01"})).await;
    let gs = r.json["shares"][0]["id"].as_i64().unwrap();
    assert!(item(&lab, &dave.token, dev.tunnel_id).await.unwrap()["share_expires_at"].as_str().unwrap().starts_with("2099-01-01"));
    for table in ["telepy_group_share", "tunnels_tunnelsharing"] {
        sqlx::query(&format!("UPDATE {table} SET expires_at = '2000-01-01 00:00:00.000000' WHERE expires_at IS NOT NULL")).execute(&lab.app.state.db.write).await.unwrap();
    }
    telepy_server::api::sharing::expire_once(&lab.app.state).await.unwrap();
    group_shares::tick(&lab.app.state).await.unwrap();
    assert!(db::group_shares::get(&lab.app.state.db, gs).await.unwrap().is_none());
    assert!(item(&lab, &dave.token, dev.tunnel_id).await.is_none());

    // 刪群組：群組分享與成員的分享一起走。/ Deleting the group takes its shares along.
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": ops})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert!(item(&lab, &dave.token, dev.tunnel_id).await.is_some());
    assert!(lab.app.delete(&format!("/api/access/groups/{ops}"), Some(&lab.admin_token)).await.status.is_success());
    settle(&lab).await;
    assert!(item(&lab, &dave.token, dev.tunnel_id).await.is_none());
    assert!(db::group_shares::for_tunnel(&lab.app.state.db, dev.tunnel_id).await.unwrap().is_empty());
    assert!(item(&lab, &carol.token, dev.tunnel_id).await.is_some(), "carol's direct share is untouched");

    // 稽核：通道的紀錄有群組分享的事件。/ The tunnel's log has the group share events.
    let r = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={}&limit=500", dev.tunnel_id), Some(&alice.token)).await;
    let events: Vec<&str> = r.json.as_array().map(|a| a.iter().filter_map(|e| e["event"].as_str()).collect()).unwrap_or_default();
    assert!(events.iter().filter(|e| **e == "group_share").count() >= 5, "{}", r.text);
}
