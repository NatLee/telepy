//! 分享給群組：成員各自拿到一筆分享（真的用允許的帳號登得進裝置），跟著群組成員增減；直接分享的人優先；
//! 經由群組的分享不能單獨改或離開；改群組分享、到期、刪群組都會收回。組織群組要打開「可以被分享」才選得到；
//! 個人群組任何人都能建、只有自己看得到，它的分享只在主人還管得到那條通道時算。
//! Sharing with a group: each member gets a share (and really logs in to the device as an allowed account), which
//! follows the group's members; a direct share wins; a share through a group can't be changed or left on its own;
//! changing the group share, its end and deleting the group all take access back. An organization group must be open
//! to sharing to be picked; anyone may make personal groups, seen only by them, whose shares count only while their
//! owner still manages the tunnel.
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
    let r = lab.app.post("/api/access/share-groups", Some(&lab.admin_token), json!({"name": "ops", "members": [bob.id, carol.id]})).await;
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
    let r = lab.app.patch(&format!("/api/access/share-groups/{ops}"), Some(&lab.admin_token), json!({"members": [carol.id, dave.id]})).await;
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
    assert!(lab.app.delete(&format!("/api/access/share-groups/{ops}"), Some(&lab.admin_token)).await.status.is_success());
    settle(&lab).await;
    assert!(item(&lab, &dave.token, dev.tunnel_id).await.is_none());
    assert!(db::group_shares::for_tunnel(&lab.app.state.db, dev.tunnel_id).await.unwrap().is_empty());
    assert!(item(&lab, &carol.token, dev.tunnel_id).await.is_some(), "carol's direct share is untouched");

    // 稽核：通道的紀錄有群組分享的事件。/ The tunnel's log has the group share events.
    let r = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={}&limit=500", dev.tunnel_id), Some(&alice.token)).await;
    let events: Vec<&str> = r.json.as_array().map(|a| a.iter().filter_map(|e| e["event"].as_str()).collect()).unwrap_or_default();
    assert!(events.iter().filter(|e| **e == "group_share").count() >= 5, "{}", r.text);
}

/// 有 ADMIN 的人把通道分享給自己也在的群組：他自己不從那筆拿到東西，所以他的 ADMIN 被收回就真的沒了；
/// 群組的寫入在寫的那一刻才看列的狀態（暫時提升中、已改成直接分享）。
/// An ADMIN sharee sharing with a group they're in gets nothing from it, so losing their ADMIN really ends it;
/// group writes look at the row when they write (a raise in progress, a row made direct meanwhile).
#[tokio::test]
async fn a_sharer_gets_nothing_from_their_own_group_share_and_writes_follow_the_row() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let dave = lab.user("dave").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let group = |name: &'static str, members: Vec<i64>| {
        let lab = &lab;
        async move {
            let r = lab.app.post("/api/access/share-groups", Some(&lab.admin_token), json!({"name": name, "members": members})).await;
            assert!(r.status.is_success(), "{}", r.text);
            r.json["created_id"].as_i64().unwrap()
        }
    };
    let ops = group("ops", vec![bob.id]).await;
    let team = group("team", vec![bob.id, dave.id]).await;
    let url = format!("/api/reverse/server/{}/group-shares", dev.tunnel_id);
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": ops, "permission_type": "admin", "allowed_target_username_ids": [ubuntu]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    settle(&lab).await;
    let ops_share = db::sharing::get(&lab.app.state.db, dev.tunnel_id, bob.id).await.unwrap().unwrap().group_share_id;

    // bob（經由 ops 有 ADMIN）分享給 team（他自己也在）。/ bob (ADMIN through ops) shares with team, which he is in.
    let r = lab.app.post(&url, Some(&bob.token), json!({"group_id": team, "permission_type": "admin", "allowed_target_username_ids": [ubuntu]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    settle(&lab).await;
    let b = db::sharing::get(&lab.app.state.db, dev.tunnel_id, bob.id).await.unwrap().unwrap();
    assert_eq!(b.group_share_id, ops_share, "bob still holds it only through ops");
    assert!(db::sharing::get(&lab.app.state.db, dev.tunnel_id, dave.id).await.unwrap().is_some(), "dave gets it through team");

    // 管理員把 bob 移出 ops：他的存取就結束，不會被自己的 team 分享接住。/ Out of ops: bob's access ends.
    let r = lab.app.patch(&format!("/api/access/share-groups/{ops}"), Some(&lab.admin_token), json!({"members": []})).await;
    assert!(r.status.is_success(), "{}", r.text);
    settle(&lab).await;
    assert!(db::sharing::get(&lab.app.state.db, dev.tunnel_id, bob.id).await.unwrap().is_none(), "bob lost it");
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_none());
    assert!(lab.terminal(&bob, &dev, "ubuntu").await.is_err());

    // 暫時提升中的群組列：群組只改它結束後回去的權限，現在的權限不動。/ A raised group row: only the permission it returns to changes.
    let d = db::sharing::get(&lab.app.state.db, dev.tunnel_id, dave.id).await.unwrap().unwrap();
    let gs = d.group_share_id.unwrap();
    sqlx::query("UPDATE tunnels_tunnelsharing SET base_permission = 'view', permission_type = 'admin', permission_until = '2099-01-01 00:00:00' WHERE id = ?")
        .bind(d.id)
        .execute(&lab.app.state.db.write)
        .await
        .unwrap();
    assert!(db::group_shares::update_row(&lab.app.state.db, d.id, "edit", None, gs).await.unwrap());
    let d2 = db::sharing::get(&lab.app.state.db, dev.tunnel_id, dave.id).await.unwrap().unwrap();
    assert_eq!((d2.permission_type.as_str(), d2.base_permission.as_deref()), ("admin", Some("edit")));
    // 提升結束後（基準清掉）才寫：改的是現在的權限。/ Written after the raise ended: the current permission changes.
    sqlx::query("UPDATE tunnels_tunnelsharing SET base_permission = NULL, permission_until = NULL, permission_type = 'view' WHERE id = ?")
        .bind(d.id)
        .execute(&lab.app.state.db.write)
        .await
        .unwrap();
    assert!(db::group_shares::update_row(&lab.app.state.db, d.id, "edit", None, gs).await.unwrap());
    let d3 = db::sharing::get(&lab.app.state.db, dev.tunnel_id, dave.id).await.unwrap().unwrap();
    assert_eq!((d3.permission_type.as_str(), d3.base_permission.as_deref()), ("edit", None));
    // 已經改成直接分享的列：群組的寫入不碰它。/ A row made direct meanwhile: a group write leaves it alone.
    db::group_shares::make_direct(&lab.app.state.db, d.id).await.unwrap();
    assert!(!db::group_shares::update_row(&lab.app.state.db, d.id, "admin", None, gs).await.unwrap());
    let d4 = db::sharing::get(&lab.app.state.db, dev.tunnel_id, dave.id).await.unwrap().unwrap();
    assert_eq!((d4.permission_type.as_str(), d4.group_share_id), ("edit", None));
}

/// 角色只決定功能、永遠不給通道；管理員維護的群組只給通道、永遠不決定功能。兩種各有各的名稱空間、各有各的路徑，
/// 個人群組的路徑碰不到它們，它們的路徑也碰不到個人群組；刪掉時指向它們的規則、紀錄與分享一起走。
/// Roles decide features and never grant a tunnel; admin-kept groups grant tunnels and never decide a feature. Each has
/// its own names and routes, personal-group routes can't reach them and theirs can't reach personal groups; deleting
/// one takes the rules, records and shares pointing at it along.
#[tokio::test]
async fn roles_never_share_and_groups_never_decide_features() {
    let Some(lab) = Lab::start().await else { return };
    let db = &lab.app.state.db;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let url = format!("/api/reverse/server/{}/group-shares", dev.tunnel_id);
    let admin = Some(lab.admin_token.as_str());

    // 角色：不收 `shareable`（400），JSON 裡沒有分享的欄位。/ Roles: `shareable` is refused, no sharing fields in the JSON.
    let r = lab.app.post("/api/access/groups", admin, json!({"name": "ops", "members": [bob.id], "shareable": true})).await;
    assert_eq!((r.status, r.json["shareable"].is_array()), (StatusCode::BAD_REQUEST, true), "{}", r.text);
    let r = lab.app.post("/api/access/groups", admin, json!({"name": "ops", "members": [bob.id]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let role = r.json["created_id"].as_i64().unwrap();
    let rj = r.json["groups"].as_array().unwrap().iter().find(|g| g["id"] == role).unwrap().clone();
    assert!(rj.get("shareable").is_none() && rj.get("shares").is_none(), "{rj}");
    assert_eq!(lab.app.patch(&format!("/api/access/groups/{role}"), admin, json!({"shareable": false})).await.status, StatusCode::BAD_REQUEST);
    // 角色的預告已經拿掉（角色不會改變誰拿得到通道）。/ The role preview is gone (a role never changes tunnel access).
    assert_ne!(lab.app.post(&format!("/api/access/groups/{role}/preview"), admin, json!({"delete": true})).await.status, StatusCode::OK);

    // 不變式 1：角色不在分享的選項、`member_of` 裡；拿角色 id 分享 = 404。/ Invariant 1: never offered, never listed, 404.
    let r = lab.app.get(&url, Some(&alice.token)).await;
    assert!(r.json["groups"].as_array().unwrap().iter().all(|g| g["id"] != role), "{}", r.text);
    assert_eq!(lab.app.post(&url, Some(&alice.token), json!({"group_id": role})).await.status, StatusCode::NOT_FOUND);
    let r = lab.app.get("/api/user/groups", Some(&bob.token)).await;
    assert!(r.json["member_of"].as_array().unwrap().is_empty(), "{}", r.text);
    // 保險：就算資料庫裡有一筆指向角色的分享，比對也不給任何人、清單也不列。/ Defence in depth: a share pointing at a role grants nothing.
    let rogue = db::group_shares::create(db, dev.tunnel_id, role, alice.id, "admin", None).await.unwrap();
    settle(&lab).await;
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_none(), "a role never grants a tunnel");
    assert!(!group_shares::active_shares(&lab.app.state).await.unwrap().contains(&rogue));
    let r = lab.app.get(&url, Some(&alice.token)).await;
    assert!(r.json["shares"].as_array().unwrap().is_empty(), "{}", r.text);
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, bob.id), Some(&alice.token)).await;
    assert_ne!(r.json["code"], "via_group", "{}", r.text);
    db::group_shares::delete(db, rogue).await.unwrap();

    // 管理員維護的群組：名稱跟角色分開算（同名可以），跟其他管理員維護的群組不能撞（不分大小寫）。
    // Admin-kept groups: named apart from roles (the same name is fine), unique among themselves (case-insensitive).
    assert_eq!(lab.app.post("/api/access/share-groups", Some(&alice.token), json!({"name": "x"})).await.status, StatusCode::FORBIDDEN, "admins only");
    let r = lab.app.post("/api/access/share-groups", admin, json!({"name": "ops", "description": "on call", "members": [bob.id]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let kept = r.json["created_id"].as_i64().unwrap();
    let k = r.json["share_groups"].as_array().unwrap().iter().find(|g| g["id"] == kept).unwrap().clone();
    assert_eq!((k["name"].as_str(), k["description"].as_str(), k["members"].clone(), k["synced"].as_bool(), k["scim"].as_bool()), (Some("ops"), Some("on call"), json!([bob.id]), Some(false), Some(false)), "{k}");
    assert!(r.json["groups"].as_array().unwrap().iter().all(|g| g["id"] != kept), "an admin-kept group is not a role");
    let r = lab.app.post("/api/access/share-groups", admin, json!({"name": "OPS"})).await;
    assert_eq!((r.status, r.json["name"].is_array()), (StatusCode::BAD_REQUEST, true), "{}", r.text);
    assert_eq!(lab.app.post("/api/access/groups", admin, json!({"name": "OPS"})).await.status, StatusCode::BAD_REQUEST, "roles are unique among roles");

    // 不變式 2：群組永遠不決定功能 —— 拿它當授權對象 = 404，就算資料庫裡硬塞一列拒絕也沒用；角色照樣決定。
    // Invariant 2: a group never decides a feature — 404 as a grant subject, and even a forced deny row does nothing; roles still do.
    let r = lab.app.put("/api/access/grants", admin, json!({"subject": "group", "id": kept, "feature": "terminal", "value": "deny"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    db::features::set_grant(db, "group", kept, "terminal", Some(false)).await.unwrap();
    lab.app.state.features.invalidate();
    let r = lab.app.get("/api/access", admin).await;
    let b = r.json["users"].as_array().unwrap().iter().find(|u| u["id"] == bob.id).unwrap().clone();
    assert_eq!((b["groups"].clone(), b["effective"]["terminal"]["allowed"].as_bool()), (json!([role]), Some(true)), "{b}");
    assert_eq!(db::features::groups_of(db, bob.id).await.unwrap().into_iter().collect::<Vec<_>>(), vec![role]);
    let r = lab.app.put("/api/access/grants", admin, json!({"subject": "group", "id": role, "feature": "terminal", "value": "deny"})).await;
    let b = r.json["users"].as_array().unwrap().iter().find(|u| u["id"] == bob.id).unwrap().clone();
    assert_eq!((b["effective"]["terminal"]["allowed"].as_bool(), b["effective"]["terminal"]["group_id"].as_i64()), (Some(false), Some(role)), "{b}");
    lab.app.put("/api/access/grants", admin, json!({"subject": "group", "id": role, "feature": "terminal", "value": "inherit"})).await;

    // 分享給管理員維護的群組：誰都能選（種類 org，名稱不是佔位），一直算。/ Shared: offered to anyone (kind org, never the placeholder), always counts.
    let r = lab.app.get(&url, Some(&alice.token)).await;
    let choice = r.json["groups"].as_array().unwrap().iter().find(|g| g["id"] == kept).cloned().expect("offered");
    assert_eq!((choice["name"].as_str(), choice["kind"].as_str(), choice["members"].as_i64()), (Some("ops"), Some("org"), Some(1)), "{choice}");
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": kept, "allowed_target_username_ids": [ubuntu]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let s0 = &r.json["shares"][0];
    assert_eq!((s0["kind"].as_str(), s0["name"].as_str(), s0["active"].as_bool(), s0["owner"].is_null()), (Some("org"), Some("ops"), Some(true), true), "{}", r.text);
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_some());
    let r = lab.app.get("/api/user/groups", Some(&bob.token)).await;
    let m = &r.json["member_of"][0];
    assert_eq!((m["id"].as_i64(), m["kind"].as_str(), m["name"].as_str(), m["synced"].as_bool()), (Some(kept), Some("org"), Some("ops"), Some(false)), "{}", r.text);
    assert_eq!(r.json["member_of"].as_array().unwrap().len(), 1, "the role is not listed");
    // 單一登入規則指向它 = 成員由身分提供者同步。/ A sign-in rule targets it: synced.
    sqlx::query("INSERT INTO telepy_oidc_group_rule (provider_id, idp_group, target, group_id) VALUES (1, 'ops', 'group', ?)").bind(kept).execute(&db.write).await.unwrap();
    sqlx::query("INSERT INTO telepy_oidc_group_rule (provider_id, idp_group, target, group_id) VALUES (1, 'ops', 'group', ?)").bind(role).execute(&db.write).await.unwrap();
    assert_eq!(lab.app.get("/api/user/groups", Some(&bob.token)).await.json["member_of"][0]["synced"], true);
    let r = lab.app.get("/api/access", admin).await;
    let k = r.json["share_groups"].as_array().unwrap().iter().find(|g| g["id"] == kept).unwrap().clone();
    assert_eq!((k["synced"].as_bool(), k["shares"][0]["tunnel_id"].as_i64(), k["shares"][0]["owner"].as_str(), k["shares"][0]["through"].as_i64()), (Some(true), Some(dev.tunnel_id), Some("alice"), Some(1)), "{k}");

    // 不變式 3：管理員的路徑碰不到個人群組，個人群組的路徑碰不到角色 / 管理員維護的群組；角色與群組的路徑互不相通。
    // Invariant 3: admin routes can't reach personal groups, personal routes can't reach roles / admin-kept groups, and
    // the role and group routes don't reach each other.
    let pals = lab.app.post("/api/user/groups", Some(&alice.token), json!({"name": "pals"})).await.json["created_id"].as_i64().unwrap();
    for (method, path) in [
        ("PATCH", format!("/api/access/share-groups/{pals}")),
        ("DELETE", format!("/api/access/share-groups/{pals}")),
        ("PATCH", format!("/api/access/groups/{pals}")),
        ("DELETE", format!("/api/access/groups/{pals}")),
        ("PATCH", format!("/api/access/groups/{kept}")),
        ("DELETE", format!("/api/access/groups/{kept}")),
        ("PATCH", format!("/api/access/share-groups/{role}")),
        ("DELETE", format!("/api/access/share-groups/{role}")),
    ] {
        let r = if method == "PATCH" { lab.app.patch(&path, admin, json!({"name": "taken over"})).await } else { lab.app.delete(&path, admin).await };
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{method} {path}: {}", r.text);
    }
    assert_eq!(lab.app.post(&format!("/api/access/share-groups/{role}/preview"), admin, json!({"delete": true})).await.status, StatusCode::NOT_FOUND);
    for id in [kept, role] {
        assert_eq!(lab.app.patch(&format!("/api/user/groups/{id}"), Some(&lab.admin_token), json!({"name": "mine"})).await.status, StatusCode::NOT_FOUND);
        assert_eq!(lab.app.delete(&format!("/api/user/groups/{id}"), Some(&lab.admin_token)).await.status, StatusCode::NOT_FOUND);
        assert_eq!(lab.app.post(&format!("/api/user/groups/{id}/preview"), Some(&lab.admin_token), json!({"delete": true})).await.status, StatusCode::NOT_FOUND);
        assert_eq!(lab.app.delete(&format!("/api/user/groups/{id}/membership"), Some(&bob.token)).await.status, StatusCode::NOT_FOUND, "only personal groups can be left");
    }
    let r = lab.app.get("/api/access", admin).await;
    assert!(r.json["share_groups"].as_array().unwrap().iter().chain(r.json["groups"].as_array().unwrap()).all(|g| g["id"] != pals), "{}", r.text);
    assert_eq!(db::features::share_group(db, kept).await.unwrap().unwrap().label(), "ops", "nothing was renamed");

    // 預告：換掉成員 = bob 少了這條；刪掉 = 一筆分享結束；什麼都沒寫。/ Previews write nothing.
    let pv = format!("/api/access/share-groups/{kept}/preview");
    let r = lab.app.post(&pv, admin, json!({"members": []})).await;
    assert_eq!((r.json["lose"][0]["user_id"].as_i64(), r.json["lose"][0]["tunnels"][0]["id"].as_i64()), (Some(bob.id), Some(dev.tunnel_id)), "{}", r.text);
    let r = lab.app.post(&pv, admin, json!({"delete": true})).await;
    assert_eq!(r.json["shares"].as_i64(), Some(1), "{}", r.text);
    assert_eq!(lab.app.post(&pv, admin, json!({"shareable": false})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(lab.app.post(&pv, Some(&alice.token), json!({"delete": true})).await.status, StatusCode::FORBIDDEN, "admins only");
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_some(), "a preview writes nothing");

    // 改名：只動 display_name，換成員：存取立刻跟著（同步比對）。/ Rename keeps the placeholder; members apply at once (inline reconcile).
    let r = lab.app.patch(&format!("/api/access/share-groups/{kept}"), admin, json!({"name": "on-call", "members": []})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_none(), "bob left the group, no settle needed");
    assert!(r.json["share_groups"].as_array().unwrap().iter().any(|g| g["name"] == "on-call"));
    lab.app.patch(&format!("/api/access/share-groups/{kept}"), admin, json!({"members": [bob.id]})).await;
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_some());

    // 不變式 8：刪掉管理員維護的群組 = 分享結束、成員失去、規則與紀錄一起走；刪掉角色 = 授權、規則一起走。
    // Invariant 8: deleting an admin-kept group ends its shares (members lose access) and drops its rules and records;
    // deleting a role drops its grants and rules.
    sqlx::query("INSERT INTO telepy_oidc_grant (provider_id, user_id, target, group_id, created_at) VALUES (1, ?, 'group', ?, '2026-01-01')").bind(bob.id).bind(kept).execute(&db.write).await.unwrap();
    sqlx::query("INSERT INTO telepy_scim_group (provider_id, group_id, created_at, updated_at) VALUES (1, ?, '2026-01-01', '2026-01-01')").bind(kept).execute(&db.write).await.unwrap();
    let r = lab.app.delete(&format!("/api/access/share-groups/{kept}"), admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_none());
    assert!(db::group_shares::for_tunnel(db, dev.tunnel_id).await.unwrap().is_empty());
    let count = |sql: &'static str, id: i64| async move { sqlx::query_scalar::<_, i64>(sql).bind(id).fetch_one(&db.read).await.unwrap() };
    for sql in [
        "SELECT COUNT(*) FROM telepy_oidc_group_rule WHERE group_id = ?",
        "SELECT COUNT(*) FROM telepy_oidc_grant WHERE group_id = ?",
        "SELECT COUNT(*) FROM telepy_scim_group WHERE group_id = ?",
        "SELECT COUNT(*) FROM telepy_user_group_member WHERE group_id = ?",
        "SELECT COUNT(*) FROM telepy_feature_grant WHERE subject_kind = 'group' AND subject_id = ?",
    ] {
        assert_eq!(count(sql, kept).await, 0, "{sql}");
    }
    lab.app.put("/api/access/grants", admin, json!({"subject": "group", "id": role, "feature": "files", "value": "deny"})).await;
    assert_eq!(lab.app.delete(&format!("/api/access/groups/{role}"), admin).await.status, StatusCode::OK);
    for sql in ["SELECT COUNT(*) FROM telepy_oidc_group_rule WHERE group_id = ?", "SELECT COUNT(*) FROM telepy_feature_grant WHERE subject_kind = 'group' AND subject_id = ?"] {
        assert_eq!(count(sql, role).await, 0, "{sql}");
    }
    // 稽核：管理員維護的群組的建立 / 修改 / 刪除是 `share_group` 事件。/ Audit: `share_group` events.
    let r = lab.app.get("/api/log/ssh/events?scope=all&tunnel_id=none&limit=500", admin).await;
    let n = r.json.as_array().map(|a| a.iter().filter(|e| e["event"] == "share_group").count()).unwrap_or(0);
    assert!(n >= 4, "{}", r.text);
}

/// 個人群組：任何人都能建、只有自己看得到；只用在分享，功能權限不看它；它的分享只在主人還管得到那條通道時算
/// （經由別人的個人群組拿到的 ADMIN 不算），主人停用也暫停。
/// Personal groups: anyone makes them, only they see them; used only for sharing, never for features; their shares
/// count only while the owner still manages the tunnel (ADMIN through someone's personal group doesn't count) and
/// pause while the owner is disabled.
#[tokio::test]
async fn personal_groups_share_only_while_their_owner_manages_the_tunnel() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let dave = lab.user("dave").await;
    let eve = lab.user("eve").await;
    let frank = lab.user("frank").await;
    let gus = lab.user("gus").await;
    let zed = lab.user("zed").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let url = format!("/api/reverse/server/{}/group-shares", dev.tunnel_id);

    // 管不到任何通道的人：拿不到帳號清單、不能放成員（不然成員 id 的對錯就能列出帳號）；空群組可以。
    // Someone who manages no tunnel gets no account list and can't add members (ids would list accounts); empty groups are fine.
    let r = lab.app.get("/api/user/groups", Some(&zed.token)).await;
    assert_eq!((r.json["can_share"].as_bool(), r.json["users"].as_array().map(Vec::len)), (Some(false), Some(0)), "{}", r.text);
    let r = lab.app.post("/api/user/groups", Some(&zed.token), json!({"name": "probe", "members": [alice.id]})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("no_tunnels")), "{}", r.text);
    let r = lab.app.post("/api/user/groups", Some(&zed.token), json!({"name": "later"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let later = r.json["created_id"].as_i64().unwrap();
    assert_eq!(lab.app.patch(&format!("/api/user/groups/{later}"), Some(&zed.token), json!({"members": [bob.id]})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(lab.app.post(&format!("/api/user/groups/{later}/preview"), Some(&zed.token), json!({"members": [bob.id]})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(lab.app.get("/api/user/groups", Some(&alice.token)).await.json["can_share"], true, "alice owns a tunnel");

    // alice 建「pals」= carol。不能放自己、不能重名；別人可以用同一個名字。/ alice makes "pals"; rules for members and names.
    assert_eq!(lab.app.post("/api/user/groups", Some(&alice.token), json!({"name": "pals", "members": [alice.id]})).await.status, StatusCode::BAD_REQUEST);
    let r = lab.app.post("/api/user/groups", Some(&alice.token), json!({"name": "pals", "members": [carol.id]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let pals = r.json["created_id"].as_i64().unwrap();
    assert_eq!(r.json["groups"][0]["member_names"], json!(["carol"]), "{}", r.text);
    assert!(r.json["users"].as_array().unwrap().iter().all(|u| u["id"] != alice.id), "the picker leaves me out");
    assert_eq!(lab.app.post("/api/user/groups", Some(&alice.token), json!({"name": "PALS"})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(lab.app.post("/api/user/groups", Some(&bob.token), json!({"name": "pals"})).await.status, StatusCode::CREATED);

    // 只有自己看得到、改得到；管理頁和功能權限都沒有它。/ Only alice sees it; the admin page and features never do.
    let r = lab.app.get("/api/user/groups", Some(&dave.token)).await;
    assert!(r.json["groups"].as_array().unwrap().is_empty(), "{}", r.text);
    assert_eq!(lab.app.patch(&format!("/api/user/groups/{pals}"), Some(&dave.token), json!({"name": "mine"})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(lab.app.delete(&format!("/api/user/groups/{pals}"), Some(&lab.admin_token)).await.status, StatusCode::NOT_FOUND);
    let r = lab.app.get("/api/access", Some(&lab.admin_token)).await;
    assert!(r.json["groups"].as_array().unwrap().iter().all(|g| g["id"] != pals), "{}", r.text);
    let r = lab.app.put("/api/access/grants", Some(&lab.admin_token), json!({"subject": "group", "id": pals, "feature": "terminal", "value": "deny"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    assert!(db::features::groups_of(&lab.app.state.db, carol.id).await.unwrap().is_empty());

    // alice 分享給 pals：carol 拿到；dave 不能拿 alice 的群組去分享自己的通道。/ alice shares with pals; carol gets it.
    let r = lab.app.get(&url, Some(&alice.token)).await;
    assert_eq!((r.json["groups"][0]["id"].as_i64(), r.json["groups"][0]["kind"].as_str()), (Some(pals), Some("personal")), "{}", r.text);
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": pals, "permission_type": "admin", "allowed_target_username_ids": [ubuntu]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let s = &r.json["shares"][0];
    assert_eq!((s["kind"].as_str(), s["owner"].as_str(), s["mine"].as_bool(), s["active"].as_bool()), (Some("personal"), Some("alice"), Some(true), Some(true)), "{}", r.text);
    assert_eq!(item(&lab, &carol.token, dev.tunnel_id).await.expect("carol sees it")["share_group"], "pals");
    assert!(lab.terminal(&carol, &dev, "ubuntu").await.is_ok());
    // carol 的「我所在的群組」：alice 的個人群組 pals，經由它拿到 box。/ carol's groups: alice's pals, holding box through it.
    let r = lab.app.get("/api/user/groups", Some(&carol.token)).await;
    let m = r.json["member_of"].as_array().unwrap().iter().find(|g| g["id"] == pals).cloned().expect("pals listed");
    assert_eq!((m["kind"].as_str(), m["owner"].as_str(), m["tunnels"][0]["name"].as_str(), m["tunnels"][0]["through"].as_bool()), (Some("personal"), Some("alice"), Some("box"), Some(true)), "{m}");
    let dboxm = lab.machine("dbox", &[("ubuntu", &[&lab.service])], false).await;
    let ddev = lab.device(&dave, "dbox", &dboxm).await;
    let r = lab.app.post(&format!("/api/reverse/server/{}/group-shares", ddev.tunnel_id), Some(&dave.token), json!({"group_id": pals})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);

    // 預告 + 改成員：dave 會拿到。/ Preview, then add dave.
    let r = lab.app.post(&format!("/api/user/groups/{pals}/preview"), Some(&alice.token), json!({"members": [carol.id, dave.id]})).await;
    assert_eq!((r.json["gain"][0]["user_id"].as_i64(), r.json["gain"][0]["tunnels"][0]["name"].as_str()), (Some(dave.id), Some("box")), "{}", r.text);
    let r = lab.app.patch(&format!("/api/user/groups/{pals}"), Some(&alice.token), json!({"members": [carol.id, dave.id]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(item(&lab, &dave.token, dev.tunnel_id).await.is_some(), "dave joined pals");

    // 經由別人的個人群組拿到 ADMIN 的 carol：她自己的個人群組分享不算（暫停）。/ ADMIN through a personal group doesn't pass on.
    let r = lab.app.post("/api/user/groups", Some(&carol.token), json!({"name": "carols", "members": [eve.id]})).await;
    let carols = r.json["created_id"].as_i64().unwrap();
    let r = lab.app.post(&url, Some(&carol.token), json!({"group_id": carols})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let share = r.json["shares"].as_array().unwrap().iter().find(|s| s["group_id"] == carols).unwrap().clone();
    assert_eq!(share["active"], false, "{share}");
    assert!(item(&lab, &eve.token, dev.tunnel_id).await.is_none(), "eve gets nothing through carol's group");

    // bob 有直接的 ADMIN：他的個人群組分享算；降成 VIEW 就暫停，回到 ADMIN 又恢復。/ bob's direct ADMIN; losing it pauses.
    lab.share(&alice, &dev, &bob, "admin", &[ubuntu]).await;
    let r = lab.app.post("/api/user/groups", Some(&bob.token), json!({"name": "bobs", "members": [eve.id]})).await;
    let bobs = r.json["created_id"].as_i64().unwrap();
    let r = lab.app.post(&url, Some(&bob.token), json!({"group_id": bobs})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let it = item(&lab, &eve.token, dev.tunnel_id).await.expect("eve through bobs");
    assert_eq!((it["share_group"].as_str(), it["share_group_id"].as_i64(), it["share_group_owner"].as_str()), (Some("bobs"), Some(bobs), Some("bob")), "{it}");
    let set = |perm: &'static str| {
        let (lab, alice, bob) = (&lab, &alice, &bob);
        async move {
            let r = lab.app.patch(&format!("/tunnels/update-permission/{}/{}", dev.tunnel_id, bob.id), Some(&alice.token), json!({"permission_type": perm})).await;
            assert!(r.status.is_success(), "{}", r.text);
            settle(lab).await;
        }
    };
    set("view").await;
    assert!(item(&lab, &eve.token, dev.tunnel_id).await.is_none(), "paused once bob no longer manages it");
    let r = lab.app.get(&url, Some(&alice.token)).await;
    let share = r.json["shares"].as_array().unwrap().iter().find(|s| s["group_id"] == bobs).unwrap().clone();
    assert_eq!((share["active"].as_bool(), share["mine"].as_bool(), share["owner"].as_str()), (Some(false), Some(false), Some("bob")), "{share}");
    set("admin").await;
    assert!(item(&lab, &eve.token, dev.tunnel_id).await.is_some(), "resumed");

    // bob 停用：暫停；重新啟用：恢復。/ bob disabled: paused; enabled again: resumed.
    let active = |on: bool| {
        let (lab, bob) = (&lab, &bob);
        async move {
            let r = lab.app.post(&format!("/api/user/users/{}", bob.id), Some(&lab.admin_token), json!({"is_active": on})).await;
            assert!(r.status.is_success(), "{}", r.text);
            settle(lab).await;
        }
    };
    active(false).await;
    assert!(item(&lab, &eve.token, dev.tunnel_id).await.is_none(), "paused while bob is disabled");
    active(true).await;
    assert!(item(&lab, &eve.token, dev.tunnel_id).await.is_some());

    // 任何人都能把你加進個人群組，所以你一定能自己退出：離開通道會說「經由個人群組」並給群組 id，退出群組就沒了。
    // Anyone can add you to a personal group, so you can always leave it: leaving the tunnel names the group, leaving the group ends it.
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, eve.id), Some(&eve.token)).await;
    assert_eq!((r.status, r.json["code"].as_str(), r.json["group_id"].as_i64(), r.json["personal"].as_bool()), (StatusCode::BAD_REQUEST, Some("via_group"), Some(bobs), Some(true)), "{}", r.text);
    let r = lab.app.delete(&format!("/api/user/groups/{bobs}/membership"), Some(&eve.token)).await;
    assert_eq!((r.status, r.json["left"].as_bool()), (StatusCode::OK, Some(true)), "{}", r.text);
    assert!(item(&lab, &eve.token, dev.tunnel_id).await.is_none(), "eve left bobs");
    assert_eq!(lab.app.delete(&format!("/api/user/groups/{bobs}/membership"), Some(&eve.token)).await.status, StatusCode::NOT_FOUND, "not a member any more");
    assert_eq!(lab.app.delete(&format!("/api/user/groups/{bobs}/membership"), Some(&bob.token)).await.status, StatusCode::NOT_FOUND, "not your own group");
    let r = lab.app.post("/api/access/share-groups", Some(&lab.admin_token), json!({"name": "leads", "members": [frank.id]})).await;
    let leads = r.json["created_id"].as_i64().unwrap();
    assert_eq!(lab.app.delete(&format!("/api/user/groups/{leads}/membership"), Some(&frank.token)).await.status, StatusCode::NOT_FOUND, "admin-kept groups are kept by admins");

    // 連帶的暫停：frank 經由組織群組 leads 有 ADMIN，他的個人群組 = gus；管理員預告把 frank 移出 leads 時，gus 也列在會失去的人裡，
    // 而且同一次比對就停。/ Knock-on pauses: frank's ADMIN comes from leads; previewing frank out of leads lists gus too, and one reconcile stops it.
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": leads, "permission_type": "admin"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let r = lab.app.post("/api/user/groups", Some(&frank.token), json!({"name": "franks", "members": [gus.id]})).await;
    let franks = r.json["created_id"].as_i64().unwrap();
    assert_eq!(lab.app.post(&url, Some(&frank.token), json!({"group_id": franks})).await.status, StatusCode::CREATED);
    assert!(item(&lab, &gus.token, dev.tunnel_id).await.is_some(), "gus through franks");
    let r = lab.app.post(&format!("/api/access/share-groups/{leads}/preview"), Some(&lab.admin_token), json!({"members": []})).await;
    let lost: Vec<i64> = r.json["lose"].as_array().unwrap().iter().filter_map(|p| p["user_id"].as_i64()).collect();
    assert_eq!(lost, vec![frank.id, gus.id], "{}", r.text);
    db::features::set_members(&lab.app.state.db, leads, &[]).await.unwrap();
    settle(&lab).await;
    assert!(item(&lab, &gus.token, dev.tunnel_id).await.is_none(), "paused in the same reconcile");

    // 刪掉 pals：預告 carol、dave 會少；刪了就真的沒了。/ Deleting pals: previewed, then carol and dave lose it.
    let r = lab.app.post(&format!("/api/user/groups/{pals}/preview"), Some(&alice.token), json!({"delete": true})).await;
    let lost: Vec<i64> = r.json["lose"].as_array().unwrap().iter().filter_map(|p| p["user_id"].as_i64()).collect();
    assert_eq!((lost, r.json["shares"].as_i64()), (vec![carol.id, dave.id], Some(1)), "{}", r.text);
    let r = lab.app.delete(&format!("/api/user/groups/{pals}"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(item(&lab, &carol.token, dev.tunnel_id).await.is_none());
    assert!(item(&lab, &dave.token, dev.tunnel_id).await.is_none());
    // carol 已經看不到這條通道：她暫停中的分享不再說通道名稱。/ carol can't see the tunnel any more: her paused share hides its name.
    let r = lab.app.get("/api/user/groups", Some(&carol.token)).await;
    let s = r.json["groups"].as_array().unwrap().iter().find(|g| g["id"] == carols).unwrap()["shares"][0].clone();
    assert_eq!((s["tunnel_name"].is_null(), s["active"].as_bool()), (true, Some(false)), "{}", r.text);
}

/// 每個人在這條通道上的分享列：(人, 列 id, 權限, 群組分享, 到期, 允許的帳號)。/ Everyone's row on the tunnel.
async fn rows_of(lab: &Lab, tunnel: i64) -> Vec<(i64, i64, String, Option<i64>, Option<String>, Vec<i64>)> {
    let db = &lab.app.state.db;
    let mut out = Vec::new();
    for s in db::sharing::for_tunnel(db, tunnel).await.unwrap() {
        let row = db::sharing::get(db, tunnel, s.shared_with_id).await.unwrap().unwrap();
        let mut accounts = db::sharing::allowed_username_ids(db, row.id).await.unwrap();
        accounts.sort_unstable();
        out.push((row.shared_with_id, row.id, row.permission_type, row.group_share_id, row.expires_at, accounts));
    }
    out.sort();
    out
}

/// 不變式 7：升級把被分享的組織群組變成群組，誰拿得到哪條通道、什麼權限、哪些帳號、到什麼時候都不變，功能也不變。
/// 只為分享存在的就地轉換；同時當角色用的複製一份、分享改指向它，角色留著成員、授權與單一登入規則；從沒算數過的分享刪掉。
/// Invariant 7: the upgrade turns shared organization groups into groups without changing anyone's tunnels, permission,
/// accounts, end or features. One used only for sharing is converted in place; one also used as a role is copied and its
/// shares move to the copy while the role keeps its members, grants and sign-in rules; shares that never counted go.
#[tokio::test]
async fn the_upgrade_keeps_everyones_tunnels_and_features() {
    let Some(lab) = Lab::start().await else { return };
    let db = &lab.app.state.db;
    let admin = Some(lab.admin_token.as_str());
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let dave = lab.user("dave").await;
    let eve = lab.user("eve").await;
    let frank = lab.user("frank").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let root = lab.username(&alice, &dev, "root").await;
    let url = format!("/api/reverse/server/{}/group-shares", dev.tunnel_id);

    // 用現在的模型建出分享（成員的列都長出來），再把群組改回升級前的樣子。/ Build the shares now, then turn the groups back into their pre-upgrade shape.
    let kept = |name: &'static str, members: Vec<i64>| {
        let lab = &lab;
        async move { lab.app.post("/api/access/share-groups", Some(&lab.admin_token), json!({"name": name, "members": members})).await.json["created_id"].as_i64().unwrap() }
    };
    let ops = kept("ops", vec![bob.id]).await;
    let leads = kept("leads", vec![carol.id, dave.id]).await;
    assert_eq!(lab.app.post(&url, Some(&alice.token), json!({"group_id": ops, "allowed_target_username_ids": [ubuntu]})).await.status, StatusCode::CREATED);
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": leads, "permission_type": "admin", "allowed_target_username_ids": [ubuntu, root], "expires_at": "2099-01-01"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let pals = lab.app.post("/api/user/groups", Some(&alice.token), json!({"name": "pals", "members": [frank.id]})).await.json["created_id"].as_i64().unwrap();
    assert_eq!(lab.app.post(&url, Some(&alice.token), json!({"group_id": pals, "permission_type": "edit"})).await.status, StatusCode::CREATED);
    settle(&lab).await;
    let before = rows_of(&lab, dev.tunnel_id).await;
    assert_eq!(before.iter().map(|r| r.0).collect::<Vec<_>>(), vec![bob.id, carol.id, dave.id, frank.id], "{before:?}");

    // 升級前的樣子：ops / leads 是開放分享的組織群組，leads 同時有功能規則與單一登入規則；pals 是沒有 purpose 的個人群組；
    // closed 是沒開放分享、卻留著一筆分享的組織群組（從來不算）。
    // The pre-upgrade shape: ops / leads are organization groups open to sharing, leads also has a feature rule and a
    // sign-in rule; pals is a personal group without a purpose; closed is an organization group closed to sharing that
    // still has a share (which never counted).
    for (id, name) in [(ops, "ops"), (leads, "leads")] {
        sqlx::query("UPDATE telepy_user_group SET purpose = 'role', name = ?, display_name = NULL, shareable = 1 WHERE id = ?").bind(name).bind(id).execute(&db.write).await.unwrap();
    }
    sqlx::query("UPDATE telepy_user_group SET purpose = 'role' WHERE id = ?").bind(pals).execute(&db.write).await.unwrap();
    db::features::set_grant(db, "group", leads, "files", Some(false)).await.unwrap();
    sqlx::query("INSERT INTO telepy_oidc_group_rule (provider_id, idp_group, target, group_id) VALUES (1, 'leads', 'group', ?)").bind(leads).execute(&db.write).await.unwrap();
    // carol 是單一登入放進 leads 的；ops 也有一條單一登入規則（但沒有功能規則）。/ carol came into leads through sign-in; ops has a rule too.
    sqlx::query("INSERT INTO telepy_oidc_grant (provider_id, user_id, target, group_id, created_at) VALUES (1, ?, 'group', ?, '2026-11-01 00:00:00')").bind(carol.id).bind(leads).execute(&db.write).await.unwrap();
    sqlx::query("INSERT INTO telepy_oidc_group_rule (provider_id, idp_group, target, group_id) VALUES (1, 'ops', 'group', ?)").bind(ops).execute(&db.write).await.unwrap();
    let closed = db::features::create_group(db, "closed", "").await.unwrap();
    db::features::set_members(db, closed, &[eve.id]).await.unwrap();
    let never = db::group_shares::create(db, dev.tunnel_id, closed, alice.id, "admin", None).await.unwrap();
    let leads_shares = db::group_shares::ids_of_group(db, leads).await.unwrap();
    lab.app.state.features.invalidate();
    let files_before = lab.app.get("/api/access", admin).await.json["users"].as_array().unwrap().iter().find(|u| u["id"] == carol.id).unwrap()["effective"]["files"]["allowed"].clone();
    assert_eq!(files_before, false);

    sqlx::query("DELETE FROM telepy_data_migration WHERE name = ?").bind(db::schema::ROLES_AND_GROUPS).execute(&db.write).await.unwrap();
    db::schema::ensure_schema(&db.write).await.unwrap();
    db::schema::ensure_schema(&db.write).await.unwrap();
    settle(&lab).await;

    // 每個人的列一模一樣（同一列、同權限、同群組分享、同到期、同帳號）；eve 從來沒有，現在也沒有。
    // Everyone's row is identical (same row, permission, group share, end, accounts); eve never had one and still doesn't.
    assert_eq!(rows_of(&lab, dev.tunnel_id).await, before);
    assert!(lab.terminal(&carol, &dev, "root").await.is_ok());
    assert!(lab.terminal(&bob, &dev, "ubuntu").await.is_ok());
    assert!(db::group_shares::get(db, never).await.unwrap().is_none(), "a share that never counted is gone");
    assert!(item(&lab, &eve.token, dev.tunnel_id).await.is_none());

    // ops 沒有功能規則：就地變成群組（同 id、名稱在 display_name、name 是佔位），單一登入規則留在它身上 —— 身分提供者照樣維護成員。
    // ops has no feature rule: converted in place, its sign-in rule stays on it — the identity provider still keeps its members.
    let g = db::features::share_group(db, ops).await.unwrap().expect("ops is an admin-kept group now");
    assert_eq!((g.label(), g.name != "ops"), ("ops", true));
    assert!(db::features::group(db, ops).await.unwrap().is_none(), "no longer a role");
    let ops_rules: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_oidc_group_rule WHERE group_id = ?").bind(ops).fetch_one(&db.read).await.unwrap();
    assert_eq!(ops_rules, 1, "the sign-in rule keeps feeding the group");
    // leads 也當角色用：角色留著（成員、授權、規則），分享改指向同名的新群組。/ leads: the role stays, its shares moved to a copy.
    let role = db::features::group(db, leads).await.unwrap().expect("leads is still a role");
    assert_eq!(role.name, "leads");
    assert_eq!(db::features::members_of(db, leads).await.unwrap(), vec![carol.id, dave.id]);
    let copy = db::group_shares::get(db, leads_shares[0]).await.unwrap().unwrap().group_id;
    assert_ne!(copy, leads);
    let c = db::features::share_group(db, copy).await.unwrap().expect("the copy is an admin-kept group");
    assert_eq!((c.label(), db::features::members_of(db, copy).await.unwrap()), ("leads", vec![carol.id, dave.id]));
    // 規則與授予紀錄：角色留著原本的，複本也拿到一份 —— 身分提供者把 carol 移出團隊時，兩邊都會拿掉她。
    // Rules and grant records: the role keeps its own and the copy gets the same, so the provider removing carol from the
    // team removes her from both.
    let rules = |gid: i64| async move { sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM telepy_oidc_group_rule WHERE group_id = ?").bind(gid).fetch_one(&db.read).await.unwrap() };
    assert_eq!((rules(leads).await, rules(copy).await), (1, 1), "the sign-in rule stays on the role and follows the copy");
    let granted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_oidc_grant WHERE user_id = ? AND target = 'group' AND group_id = ?").bind(carol.id).bind(copy).fetch_one(&db.read).await.unwrap();
    assert_eq!(granted, 1, "carol's grant record follows the copy");
    // 個人群組標成群組；`shareable` 只在管理員維護的群組留 1（給退回舊版用）。/ Personal groups are groups; `shareable` stays 1 only on admin-kept groups (for a rollback).
    assert!(db::features::personal_group(db, alice.id, pals).await.unwrap().is_some());
    let mut open: Vec<i64> = sqlx::query_scalar("SELECT id FROM telepy_user_group WHERE shareable != 0").fetch_all(&db.read).await.unwrap();
    open.sort_unstable();
    let mut want = vec![ops, copy];
    want.sort_unstable();
    assert_eq!(open, want);
    // 功能不變：carol 的檔案仍然被角色擋著。/ Features unchanged: carol's files are still denied by the role.
    let r = lab.app.get("/api/access", admin).await;
    let cu = r.json["users"].as_array().unwrap().iter().find(|u| u["id"] == carol.id).unwrap().clone();
    assert_eq!((cu["effective"]["files"]["allowed"].as_bool(), cu["groups"].clone()), (Some(false), json!([leads])), "{cu}");
    // 分享選項：兩個群組都在、角色不在。/ Share choices: both groups, never the role.
    let r = lab.app.get(&url, Some(&alice.token)).await;
    let ids: Vec<i64> = r.json["groups"].as_array().unwrap().iter().filter(|g| g["kind"] == "org").filter_map(|g| g["id"].as_i64()).collect();
    assert!(ids.contains(&ops) && ids.contains(&copy) && !ids.contains(&leads), "{}", r.text);
}
