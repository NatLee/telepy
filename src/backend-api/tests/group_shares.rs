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
    let r = lab.app.post("/api/access/groups", Some(&lab.admin_token), json!({"name": "ops", "members": [bob.id, carol.id], "shareable": true})).await;
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
            let r = lab.app.post("/api/access/groups", Some(&lab.admin_token), json!({"name": name, "members": members, "shareable": true})).await;
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
    let r = lab.app.patch(&format!("/api/access/groups/{ops}"), Some(&lab.admin_token), json!({"members": []})).await;
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

/// 組織群組要管理員打開「可以被分享」才選得到；關掉 = 分享給它的通道結束（先預告得到誰會少什麼）。
/// An organization group can be picked only once an admin opens it to sharing; closing it ends its shares (previewed first).
#[tokio::test]
async fn organization_groups_are_shared_only_when_open_to_sharing() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let r = lab.app.post("/api/access/groups", Some(&lab.admin_token), json!({"name": "No terminal", "members": [bob.id]})).await;
    let quiet = r.json["created_id"].as_i64().unwrap();
    assert_eq!(r.json["groups"].as_array().unwrap().iter().find(|g| g["id"] == quiet).unwrap()["shareable"], false, "{}", r.text);

    // 只為功能規則存在的組織群組，成員自己的「我所在的群組」也不列（那是管理員的分類）。/ Hidden from its own members too.
    let r = lab.app.get("/api/user/groups", Some(&bob.token)).await;
    assert!(r.json["member_of"].as_array().unwrap().is_empty(), "{}", r.text);

    // 沒開放分享：通道主人看不到它、也分享不了。/ Not open to sharing: invisible to the tunnel's owner and refused.
    let url = format!("/api/reverse/server/{}/group-shares", dev.tunnel_id);
    let r = lab.app.get(&url, Some(&alice.token)).await;
    assert!(r.json["groups"].as_array().unwrap().is_empty(), "{}", r.text);
    assert_eq!(lab.app.post(&url, Some(&alice.token), json!({"group_id": quiet})).await.status, StatusCode::NOT_FOUND);

    // 管理員打開：選得到（org），分享後 bob 拿到。/ Opened: pickable (org); bob gets the tunnel.
    let r = lab.app.patch(&format!("/api/access/groups/{quiet}"), Some(&lab.admin_token), json!({"shareable": true})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let r = lab.app.get(&url, Some(&alice.token)).await;
    assert_eq!((r.json["groups"][0]["id"].as_i64(), r.json["groups"][0]["kind"].as_str()), (Some(quiet), Some("org")), "{}", r.text);
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": quiet, "allowed_target_username_ids": [ubuntu]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!((r.json["shares"][0]["kind"].as_str(), r.json["shares"][0]["active"].as_bool(), r.json["shares"][0]["owner"].is_null()), (Some("org"), Some(true), true), "{}", r.text);
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_some());
    // 開放之後，bob 的「我所在的群組」列出它，以及他經由它拿到的通道。/ Opened: bob sees it, with the tunnel he holds through it.
    let r = lab.app.get("/api/user/groups", Some(&bob.token)).await;
    let m = &r.json["member_of"][0];
    assert_eq!((m["id"].as_i64(), m["kind"].as_str(), m["owner"].is_null(), m["synced"].as_bool()), (Some(quiet), Some("org"), true, Some(false)), "{}", r.text);
    assert_eq!((m["tunnels"][0]["id"].as_i64(), m["tunnels"][0]["through"].as_bool()), (Some(dev.tunnel_id), Some(true)), "{}", r.text);
    // 單一登入規則會把人放進這個群組 = 成員由身分提供者同步，使用者看得到這一點。/ An SSO rule targets it: shown as synced.
    sqlx::query("INSERT INTO telepy_oidc_group_rule (provider_id, idp_group, target, group_id) VALUES (1, 'ops', 'group', ?)").bind(quiet).execute(&lab.app.state.db.write).await.unwrap();
    let r = lab.app.get("/api/user/groups", Some(&bob.token)).await;
    assert_eq!(r.json["member_of"][0]["synced"], true, "{}", r.text);
    let r = lab.app.get(&url, Some(&alice.token)).await;
    assert_eq!((r.json["shares"][0]["synced"].as_bool(), r.json["groups"][0]["synced"].as_bool()), (Some(true), Some(true)), "{}", r.text);

    // 管理頁看得到分享給它的通道。/ The admin page lists the tunnels shared with it.
    let r = lab.app.get("/api/access", Some(&lab.admin_token)).await;
    let g = r.json["groups"].as_array().unwrap().iter().find(|g| g["id"] == quiet).unwrap().clone();
    assert_eq!((g["shares"][0]["tunnel_id"].as_i64(), g["shares"][0]["owner"].as_str(), g["shares"][0]["through"].as_i64()), (Some(dev.tunnel_id), Some("alice"), Some(1)), "{g}");

    // 預告：關掉分享 = bob 少了這條；換掉成員 = bob 少、alice 不算（她是主人）。/ Previews.
    let pv = format!("/api/access/groups/{quiet}/preview");
    let r = lab.app.post(&pv, Some(&lab.admin_token), json!({"shareable": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["lose"][0]["user_id"].as_i64(), r.json["lose"][0]["tunnels"][0]["id"].as_i64(), r.json["shares"].as_i64()), (Some(bob.id), Some(dev.tunnel_id), Some(1)), "{}", r.text);
    assert!(r.json["gain"].as_array().unwrap().is_empty());
    let r = lab.app.post(&pv, Some(&lab.admin_token), json!({"members": [alice.id]})).await;
    assert_eq!((r.json["lose"].as_array().unwrap().len(), r.json["gain"].as_array().unwrap().len()), (1, 0), "{}", r.text);
    assert_eq!(lab.app.post(&pv, Some(&alice.token), json!({"delete": true})).await.status, StatusCode::FORBIDDEN, "admins only");
    assert_eq!(lab.app.post(&pv, Some(&lab.admin_token), json!({})).await.status, StatusCode::BAD_REQUEST);
    assert!(group_shares::active_shares(&lab.app.state).await.unwrap().len() == 1, "a preview writes nothing");

    // 關掉：分享結束，bob 沒了。/ Closed: the share ends, bob loses it.
    let r = lab.app.patch(&format!("/api/access/groups/{quiet}"), Some(&lab.admin_token), json!({"shareable": false})).await;
    assert!(r.status.is_success(), "{}", r.text);
    settle(&lab).await;
    assert!(db::group_shares::for_tunnel(&lab.app.state.db, dev.tunnel_id).await.unwrap().is_empty());
    assert!(item(&lab, &bob.token, dev.tunnel_id).await.is_none());
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
    let r = lab.app.post("/api/access/groups", Some(&lab.admin_token), json!({"name": "leads", "members": [frank.id], "shareable": true})).await;
    let leads = r.json["created_id"].as_i64().unwrap();
    assert_eq!(lab.app.delete(&format!("/api/user/groups/{leads}/membership"), Some(&frank.token)).await.status, StatusCode::NOT_FOUND, "organization groups are kept by admins");

    // 連帶的暫停：frank 經由組織群組 leads 有 ADMIN，他的個人群組 = gus；管理員預告把 frank 移出 leads 時，gus 也列在會失去的人裡，
    // 而且同一次比對就停。/ Knock-on pauses: frank's ADMIN comes from leads; previewing frank out of leads lists gus too, and one reconcile stops it.
    let r = lab.app.post(&url, Some(&alice.token), json!({"group_id": leads, "permission_type": "admin"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let r = lab.app.post("/api/user/groups", Some(&frank.token), json!({"name": "franks", "members": [gus.id]})).await;
    let franks = r.json["created_id"].as_i64().unwrap();
    assert_eq!(lab.app.post(&url, Some(&frank.token), json!({"group_id": franks})).await.status, StatusCode::CREATED);
    assert!(item(&lab, &gus.token, dev.tunnel_id).await.is_some(), "gus through franks");
    let r = lab.app.post(&format!("/api/access/groups/{leads}/preview"), Some(&lab.admin_token), json!({"members": []})).await;
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
