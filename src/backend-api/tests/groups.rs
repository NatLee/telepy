//! 通道群組與金鑰群組端到端（common::lab）：整組授予的金鑰真的裝進裝置、跟著群組成員增減，
//! 仍以 `allowed_usernames` 為上限，取消分享時一併清掉。每一步都用真的筆電 OpenSSH（經 gateway）確認。
//! Tunnel groups and key groups end to end on the SSH lab: a key group granted as a unit really lands on the
//! devices, follows membership changes, stays under `allowed_usernames`, and goes away on unshare.
mod common;

use axum::http::StatusCode;
use common::lab::{sftp_server_bin, Device, Hop, Lab, LabUser};
use serde_json::{json, Value};
use telepy_server::db;

fn path(tunnel_id: i64, rest: &str) -> String {
    format!("/api/reverse/server/{tunnel_id}/{rest}")
}

async fn sync(lab: &Lab, user: &LabUser, dev: &Device) -> Value {
    let r = lab.app.post(&path(dev.tunnel_id, "device-keys/sync"), Some(&user.token), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json
}

async fn add_key(lab: &Lab, user: &LabUser, name: &str) -> (i64, common::lab::LabKey) {
    let key = lab.keygen(name);
    let r = lab.app.post("/api/reverse/user/keys", Some(&user.token), json!({"host_friendly_name": name, "key": key.public})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    (r.json["id"].as_i64().unwrap(), key)
}

async fn first_key(lab: &Lab, user: &LabUser) -> i64 {
    lab.app.get("/api/reverse/user/keys", Some(&user.token)).await.json[0]["id"].as_i64().unwrap()
}

fn group_of(list: &Value, tunnel_id: i64) -> Value {
    list.as_array().unwrap().iter().find(|t| t["id"] == tunnel_id).unwrap()["group_id"].clone()
}

#[tokio::test]
async fn key_group_follows_its_groups() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let laptop = first_key(&lab, &alice).await;
    let one = lab.machine("one", &[("ubuntu", &[&lab.service]), ("deploy", &[&lab.service])], false).await;
    let two = lab.machine("two", &[("ubuntu", &[&lab.service]), ("deploy", &[&lab.service])], false).await;
    for m in [&one, &two] {
        m.account_home("ubuntu");
        m.account_home("deploy");
    }
    let d1 = lab.device(&alice, "one", &one).await;
    let d2 = lab.device(&alice, "two", &two).await;
    for d in [&d1, &d2] {
        lab.username(&alice, d, "ubuntu").await;
        lab.username(&alice, d, "deploy").await;
    }
    let one_ubuntu = [(Hop::Tunnel(&d1), "ubuntu")];
    let one_deploy = [(Hop::Tunnel(&d1), "deploy")];
    let two_ubuntu = [(Hop::Tunnel(&d2), "ubuntu")];

    // --- 通道群組「Prod」裡只有 one。/ Tunnel group "Prod" holds only `one`.
    let r = lab.app.post("/api/reverse/tunnel-groups", Some(&alice.token), json!({"name": "  Prod ", "tunnel_ids": [d1.tunnel_id]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let prod = r.json["group"]["id"].as_i64().unwrap();
    assert_eq!(r.json["group"]["name"], "Prod");
    assert_eq!(r.json["group"]["tunnel_ids"], json!([d1.tunnel_id]));
    let list = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await.json["tunnels"].clone();
    assert_eq!((group_of(&list, d1.tunnel_id), group_of(&list, d2.tunnel_id)), (json!(prod), Value::Null));
    // 同名（不分大小寫）不行。/ Names are unique per person, ignoring case.
    let r = lab.app.post("/api/reverse/tunnel-groups", Some(&alice.token), json!({"name": "prod"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["name"].is_array(), "{}", r.text);

    // --- 金鑰群組「Laptops」= 筆電金鑰，授予給 Prod。/ Key group "Laptops" granted to Prod.
    let r = lab.app.post("/api/reverse/user/key-groups", Some(&alice.token), json!({"name": "Laptops", "key_ids": [laptop]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let laptops = r.json["group"]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/reverse/user/key-groups/{laptops}/grants"), Some(&alice.token), json!({"tunnel_group_id": prod})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let grant = r.json["group"]["grants"][0].clone();
    assert_eq!((grant["tunnel_group"]["name"].as_str(), grant["tunnel"].clone(), grant["accounts"].clone()), (Some("Prod"), Value::Null, Value::Null));
    let grant_id = grant["id"].as_i64().unwrap();

    let d = sync(&lab, &alice, &d1).await;
    assert!(one.authorized_keys("ubuntu").contains(&alice.key.bare()));
    assert!(one.authorized_keys("deploy").contains(&alice.key.bare()));
    assert_eq!(lab.laptop_exec(&alice, &one_ubuntu, "whereami").await.stdout, "ubuntu@one");
    // 面板說它從哪來：不是直接加的，是經由 Laptops（授予給 Prod）。/ The panel says where it comes from.
    let entry = &d["entries"][0];
    assert_eq!((entry["direct"].as_bool(), entry["groups"][0]["name"].as_str()), (Some(false), Some("Laptops")), "{d}");
    assert_eq!(entry["groups"][0]["tunnel_group"]["name"], "Prod");
    assert_eq!(d["my_keys"][0]["in_list"], false);
    assert_eq!(d["my_keys"][0]["via_groups"][0]["id"], laptops);
    assert_eq!(d["my_key_groups"][0]["via_tunnel_group"]["name"], "Prod", "{d}");
    assert_eq!(d["my_key_groups"][0]["grant"], Value::Null);
    let row = d["view"]["accounts"][0]["rows"].as_array().unwrap().iter().find(|r| r["state"] == "installed").unwrap().clone();
    assert_eq!((row["direct"].as_bool(), row["groups"][0]["name"].as_str()), (Some(false), Some("Laptops")), "{d}");
    // two 不在 Prod：沒裝。/ `two` is not in Prod: nothing there.
    sync(&lab, &alice, &d2).await;
    assert!(!two.authorized_keys("ubuntu").contains(&alice.key.bare()));

    // --- two 移進 Prod → 跟著裝上。/ Moving `two` into Prod installs the key there.
    let r = lab.app.put(&path(d2.tunnel_id, "group"), Some(&alice.token), json!({"group_id": prod})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["group"]["tunnel_ids"], json!([d1.tunnel_id, d2.tunnel_id]));
    sync(&lab, &alice, &d2).await;
    assert_eq!(lab.laptop_exec(&alice, &two_ubuntu, "whereami").await.stdout, "ubuntu@two");
    let matrix = lab.app.get("/api/reverse/user/keys/devices", Some(&alice.token)).await.json;
    let two_row = matrix.as_array().unwrap().iter().find(|d| d["tunnel_id"] == d2.tunnel_id).unwrap().clone();
    assert_eq!((two_row["group_id"].as_i64(), two_row["keys"][0]["direct"].as_bool()), (Some(prod), Some(false)), "{matrix}");
    assert_eq!(two_row["keys"][0]["groups"][0]["name"], "Laptops");

    // --- 新金鑰放進 Laptops → 兩台都裝上。/ A new key added to Laptops lands on both devices.
    let (desk, desk_key) = add_key(&lab, &alice, "desk").await;
    let r = lab.app.patch(&format!("/api/reverse/user/keys/{desk}"), Some(&alice.token), json!({"group_id": laptops})).await;
    assert_eq!((r.status, r.json["group_id"].as_i64()), (StatusCode::OK, Some(laptops)), "{}", r.text);
    sync(&lab, &alice, &d1).await;
    sync(&lab, &alice, &d2).await;
    assert!(one.authorized_keys("deploy").contains(&desk_key.bare()));
    assert!(two.authorized_keys("ubuntu").contains(&desk_key.bare()));
    let keys = lab.app.get("/api/reverse/user/keys", Some(&alice.token)).await.json;
    assert!(keys.as_array().unwrap().iter().all(|k| k["group_id"] == laptops), "{keys}");

    // --- 授予只給 deploy：ubuntu 上的被移除。/ Narrow the grant to `deploy`: ubuntu loses the keys.
    let r = lab.app.patch(&format!("/api/reverse/user/key-groups/{laptops}/grants/{grant_id}"), Some(&alice.token), json!({"accounts": ["deploy"]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["group"]["grants"][0]["accounts"], json!(["deploy"]));
    sync(&lab, &alice, &d1).await;
    assert!(!one.authorized_keys("ubuntu").contains(&alice.key.bare()));
    assert!(one.authorized_keys("deploy").contains(&alice.key.bare()));
    assert!(!lab.laptop_exec(&alice, &one_ubuntu, "whoami").await.ok);
    assert_eq!(lab.laptop_exec(&alice, &one_deploy, "whereami").await.stdout, "deploy@one");
    // 同一把金鑰也直接在 one 的清單上（全部帳號）→ 聯集：ubuntu 又有了。/ Also listed directly → union.
    let r = lab.app.post(&path(d1.tunnel_id, "device-keys"), Some(&alice.token), json!({"user_key_ids": [laptop]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let d = sync(&lab, &alice, &d1).await;
    assert!(one.authorized_keys("ubuntu").contains(&alice.key.bare()));
    let entry = d["entries"].as_array().unwrap().iter().find(|e| e["user_key_id"] == laptop).unwrap().clone();
    assert_eq!((entry["direct"].as_bool(), entry["groups"].as_array().unwrap().len()), (Some(true), 1), "{d}");
    // 移出直接清單：只剩群組的（deploy）。/ Off the direct list: only the group's (deploy) remains.
    lab.app.delete(&path(d1.tunnel_id, &format!("device-keys/{laptop}")), Some(&alice.token)).await;
    sync(&lab, &alice, &d1).await;
    assert!(!one.authorized_keys("ubuntu").contains(&alice.key.bare()));
    assert!(one.authorized_keys("deploy").contains(&alice.key.bare()));

    // --- one 拿出 Prod → 群組來的全部離開。/ Taking `one` out of Prod removes what the group brought.
    let r = lab.app.put(&path(d1.tunnel_id, "group"), Some(&alice.token), json!({"group_id": null})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    sync(&lab, &alice, &d1).await;
    assert!(!one.authorized_keys("deploy").contains(&alice.key.bare()));
    assert!(!one.authorized_keys("deploy").contains(&desk_key.bare()));

    // --- 把 desk 拿出 Laptops → 只有 desk 離開 two。/ Taking `desk` out of Laptops removes only it.
    let r = lab.app.put(&format!("/api/reverse/user/key-groups/{laptops}/keys"), Some(&alice.token), json!({"key_ids": [laptop]})).await;
    assert_eq!((r.status, r.json["group"]["key_ids"].clone()), (StatusCode::OK, json!([laptop])), "{}", r.text);
    sync(&lab, &alice, &d2).await;
    assert!(!two.authorized_keys("deploy").contains(&desk_key.bare()));
    assert!(two.authorized_keys("deploy").contains(&alice.key.bare()));

    // --- 刪掉金鑰群組 → two 上的也離開；金鑰本身還在。/ Deleting the key group removes the rest; the keys stay.
    let r = lab.app.delete(&format!("/api/reverse/user/key-groups/{laptops}"), Some(&alice.token)).await;
    assert_eq!((r.status, r.json["groups"].clone()), (StatusCode::OK, json!([])), "{}", r.text);
    sync(&lab, &alice, &d2).await;
    assert!(!two.authorized_keys("ubuntu").contains(&alice.key.bare()));
    assert_eq!(lab.app.get("/api/reverse/user/keys", Some(&alice.token)).await.json.as_array().unwrap().len(), 2);

    // --- 一個金鑰群組直接授予一條通道，刪掉通道群組不影響它。/ A direct grant survives deleting a tunnel group.
    let r = lab.app.post("/api/reverse/user/key-groups", Some(&alice.token), json!({"name": "Desk", "key_ids": [desk]})).await;
    let desk_group = r.json["group"]["id"].as_i64().unwrap();
    let r = lab.app.post(&format!("/api/reverse/user/key-groups/{desk_group}/grants"), Some(&alice.token), json!({"tunnel_id": d2.tunnel_id})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.delete(&format!("/api/reverse/tunnel-groups/{prod}"), Some(&alice.token)).await;
    assert_eq!((r.status, r.json["groups"].clone()), (StatusCode::OK, json!([])), "{}", r.text);
    let d = sync(&lab, &alice, &d2).await;
    assert!(two.authorized_keys("ubuntu").contains(&desk_key.bare()));
    assert_eq!(d["my_key_groups"][0]["grant"]["accounts"], Value::Null, "{d}");
    // 授予要「剛好一個」對象。/ A grant needs exactly one target.
    let r = lab.app.post(&format!("/api/reverse/user/key-groups/{desk_group}/grants"), Some(&alice.token), json!({"tunnel_id": d1.tunnel_id, "tunnel_group_id": 1})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);

    // --- 刪掉通道：它的授予與分組一起清掉。/ Deleting a tunnel drops its grants and grouping.
    db::tunnels::delete(&lab.app.state.db, d2.tunnel_id).await.unwrap();
    let r = lab.app.get("/api/reverse/user/key-groups", Some(&alice.token)).await;
    assert_eq!(r.json["groups"][0]["grants"], json!([]), "{}", r.text);
}

#[tokio::test]
async fn groups_stay_inside_what_you_may_use() {
    let Some(lab) = Lab::start().await else { return };
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let bob_key = first_key(&lab, &bob).await;
    let alice_key = first_key(&lab, &alice).await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    boxm.account_home("ubuntu");
    boxm.account_home("root");
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.username(&alice, &dev, "root").await;
    let other = lab.machine("private", &[("ubuntu", &[&lab.service])], false).await;
    let private = lab.device(&alice, "private", &other).await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;

    // bob 自己的分組（alice 看不到、不受影響）。/ Bob's own grouping (alice's view is unaffected).
    let r = lab.app.post("/api/reverse/tunnel-groups", Some(&bob.token), json!({"name": "Work", "tunnel_ids": [dev.tunnel_id]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let work = r.json["group"]["id"].as_i64().unwrap();
    let mine = lab.app.get("/api/reverse/server/dashboard", Some(&bob.token)).await.json["tunnels"].clone();
    assert_eq!(group_of(&mine, dev.tunnel_id), json!(work));
    let theirs = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await.json["tunnels"].clone();
    assert_eq!(group_of(&theirs, dev.tunnel_id), Value::Null);
    // 看不到的通道不能放進來；別人的群組 404。/ Tunnels you can't see are refused; other people's groups are 404s.
    let r = lab.app.put(&format!("/api/reverse/tunnel-groups/{work}/tunnels"), Some(&bob.token), json!({"tunnel_ids": [dev.tunnel_id, private.tunnel_id]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["tunnel_ids"].is_array(), "{}", r.text);
    let r = lab.app.put(&path(private.tunnel_id, "group"), Some(&bob.token), json!({"group_id": work})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let r = lab.app.patch(&format!("/api/reverse/tunnel-groups/{work}"), Some(&alice.token), json!({"name": "Mine now"})).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    let r = lab.app.put(&path(dev.tunnel_id, "group"), Some(&alice.token), json!({"group_id": work})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);

    // 金鑰群組只能放自己的金鑰，授予只能給看得到的通道 / 自己的通道群組。
    // Key groups take only your own keys; grants go only to tunnels you see and your own tunnel groups.
    let r = lab.app.post("/api/reverse/user/key-groups", Some(&bob.token), json!({"name": "Mine", "key_ids": [alice_key]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert!(r.json["key_ids"].is_array(), "{}", r.text);
    let r = lab.app.post("/api/reverse/user/key-groups", Some(&bob.token), json!({"name": "Mine", "key_ids": [bob_key]})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let bob_group = r.json["group"]["id"].as_i64().unwrap();
    let grants = format!("/api/reverse/user/key-groups/{bob_group}/grants");
    let r = lab.app.post(&grants, Some(&bob.token), json!({"tunnel_id": private.tunnel_id})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.post("/api/reverse/tunnel-groups", Some(&alice.token), json!({"name": "Alice's"})).await;
    let alice_tg = r.json["group"]["id"].as_i64().unwrap();
    let r = lab.app.post(&grants, Some(&bob.token), json!({"tunnel_group_id": alice_tg})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.patch(&format!("/api/reverse/user/keys/{bob_key}"), Some(&bob.token), json!({"group_id": 999_999})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);

    // 授予給 Work（全部帳號）→ 只裝進 bob 被允許的 ubuntu。/ Granted to Work (all accounts) → only ubuntu, bob's ceiling.
    let r = lab.app.post(&grants, Some(&bob.token), json!({"tunnel_group_id": work})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let d = sync(&lab, &bob, &dev).await;
    assert!(boxm.authorized_keys("ubuntu").contains(&bob.key.bare()));
    assert!(!boxm.authorized_keys("root").contains(&bob.key.bare()));
    assert_eq!(lab.laptop_exec(&bob, &[(Hop::Tunnel(&dev), "ubuntu")], "whereami").await.stdout, "ubuntu@box");
    // 擁有者在面板上看得到這把是 bob 經由群組放的。/ The owner sees that bob's key came through a group.
    let owner = lab.app.get(&path(dev.tunnel_id, "device-keys"), Some(&alice.token)).await.json;
    let entry = owner["entries"].as_array().unwrap().iter().find(|e| e["owner"]["username"] == "bob").unwrap().clone();
    assert_eq!((entry["direct"].as_bool(), entry["groups"][0]["name"].as_str()), (Some(false), Some("Mine")), "{owner}");
    assert_eq!(d["my_key_groups"][0]["via_tunnel_group"]["id"], work);

    // 取消分享 → bob 的分組與授予都清掉，金鑰離開裝置。/ Unshare → bob's grouping and grants go, and so does his key.
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, bob.id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    sync(&lab, &alice, &dev).await;
    assert!(!boxm.authorized_keys("ubuntu").contains(&bob.key.bare()));
    let r = lab.app.get("/api/reverse/tunnel-groups", Some(&bob.token)).await;
    assert_eq!(r.json["groups"][0]["tunnel_ids"], json!([]), "{}", r.text);
    // 授予給 Work 的那筆還在（Work 是 bob 自己的群組），只是 Work 裡沒有這台了。/ The grant to Work stays; Work is empty.
    let r = lab.app.get("/api/reverse/user/key-groups", Some(&bob.token)).await;
    assert_eq!(r.json["groups"][0]["grants"][0]["tunnel_group"]["id"], work, "{}", r.text);
}

#[tokio::test]
async fn tunnel_groups_order_and_rename() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let mut ids = Vec::new();
    for name in ["A", "B", "C"] {
        let r = lab.app.post("/api/reverse/tunnel-groups", Some(&alice.token), json!({"name": name})).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
        ids.push(r.json["group"]["id"].as_i64().unwrap());
    }
    let names = |v: &Value| v["groups"].as_array().unwrap().iter().map(|g| g["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    // 只列一部分：其餘照原順序接在後面。/ Listing some: the rest follow in their old order.
    let r = lab.app.put("/api/reverse/tunnel-groups/order", Some(&alice.token), json!({"ids": [ids[2]]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(names(&r.json), vec!["C", "A", "B"]);
    let r = lab.app.patch(&format!("/api/reverse/tunnel-groups/{}", ids[0]), Some(&alice.token), json!({"name": "Alpha"})).await;
    assert_eq!(names(&r.json), vec!["C", "Alpha", "B"]);
    // 改成同一個名字（自己）可以，撞別組不行，空白不行。/ Its own name is fine; another group's or blank is not.
    let r = lab.app.patch(&format!("/api/reverse/tunnel-groups/{}", ids[0]), Some(&alice.token), json!({"name": "alpha"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.patch(&format!("/api/reverse/tunnel-groups/{}", ids[0]), Some(&alice.token), json!({"name": "b"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.post("/api/reverse/tunnel-groups", Some(&alice.token), json!({"name": "   "})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    // 新群組排最後。/ New groups go last.
    let r = lab.app.post("/api/reverse/tunnel-groups", Some(&alice.token), json!({"name": "D"})).await;
    assert_eq!(names(&r.json), vec!["C", "alpha", "B", "D"]);
    // 金鑰群組依名稱排。/ Key groups are ordered by name.
    for name in ["zeta", "Beta"] {
        lab.app.post("/api/reverse/user/key-groups", Some(&alice.token), json!({"name": name})).await;
    }
    let r = lab.app.get("/api/reverse/user/key-groups", Some(&alice.token)).await;
    assert_eq!(names(&r.json), vec!["Beta", "zeta"]);
}
