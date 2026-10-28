//! 站內通知偏好：全站預設被繼承、我的覆寫贏、強制的不能關、隧道靜音、全站預設只有管理員能改、刪隧道清掉靜音。
//! In-app notification preferences: site defaults are inherited, my override wins, enforced events can't be turned
//! off, tunnel mutes, admin-only defaults, and mutes go with the tunnel.
mod common;

use axum::http::StatusCode;
use common::lab::{free_port, Device, Lab};
use serde_json::{json, Value};
use telepy_server::db;

fn row<'a>(v: &'a Value, event: &str) -> &'a Value {
    v["events"].as_array().unwrap().iter().find(|e| e["event"] == event).unwrap_or_else(|| panic!("no {event} in {v}"))
}

#[tokio::test]
async fn layered_notification_preferences() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let mallory = lab.user("mallory").await;
    let admin = lab.user("root").await;
    db::users::set_flags(&lab.app.state.db, admin.id, None, Some(true)).await.unwrap();
    let mine = "/api/notifications/preferences";
    let defaults = "/api/notifications/defaults";

    // 什麼都沒設：內建開；只列有站內通知的事件與它們的管道。/ Nothing set: built-in on; only in-app events.
    let r = lab.app.get(mine, Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let ip = row(&r.json, "tunnel.ip_changed");
    assert_eq!((ip["effective"]["toast"].clone(), ip["source"]["toast"].clone()), (json!(true), json!("builtin")));
    assert_eq!(row(&r.json, "tunnel.online")["channels"], json!(["desktop"]));
    assert!(r.json["events"].as_array().unwrap().iter().all(|e| e["event"] != "user.created"));

    // 全站預設只有管理員能看能改。/ Site defaults are admin-only.
    assert_eq!(lab.app.get(defaults, Some(&alice.token)).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.put(defaults, Some(&alice.token), json!({"locks": [{"event": "tunnel.host_key_changed", "locked": true}]})).await;
    assert_eq!((r.status, r.json["code"].clone()), (StatusCode::FORBIDDEN, json!("admin_only")));

    // 管理員把 ip_changed 的 toast 關掉、強制 host key 事件。/ The admin turns a toast off and enforces an event.
    let r = lab
        .app
        .put(
            defaults,
            Some(&admin.token),
            json!({
                "defaults": [{"event": "tunnel.ip_changed", "channel": "toast", "value": "off"}, {"event": "tunnel.host_key_changed", "channel": "desktop", "value": "off"}],
                "locks": [{"event": "tunnel.host_key_changed", "locked": true}],
            }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(row(&r.json, "tunnel.ip_changed")["site"]["toast"], false);
    assert_eq!(row(&r.json, "tunnel.host_key_changed")["locked"], true);
    // 不存在的管道 / 事件是欄位錯誤。/ Unknown channels / events are field errors.
    let r = lab.app.put(defaults, Some(&admin.token), json!({"defaults": [{"event": "tunnel.online", "channel": "toast", "value": "off"}]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.put(defaults, Some(&admin.token), json!({"defaults": [{"event": "user.created", "channel": "toast", "value": "off"}]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    // 寫了一筆沒有隧道的 gateway 事件。/ A tunnel-less gateway event was written.
    let r = lab.app.get("/api/log/ssh/events?scope=all&tunnel_id=none", Some(&admin.token)).await;
    assert!(r.text.contains("notify_default") && r.text.contains("tunnel.host_key_changed enforced"), "{}", r.text);

    // 繼承全站；強制的就算全站關了也是開。/ Inherited; an enforced event is on even where the site value is off.
    let r = lab.app.get(mine, Some(&alice.token)).await;
    let ip = row(&r.json, "tunnel.ip_changed");
    assert_eq!((ip["effective"]["toast"].clone(), ip["source"]["toast"].clone()), (json!(false), json!("site")));
    let hk = row(&r.json, "tunnel.host_key_changed");
    assert_eq!((hk["effective"]["desktop"].clone(), hk["source"]["desktop"].clone()), (json!(true), json!("locked")));

    // 我的覆寫贏過全站；強制的不能關（400 locked，什麼都沒寫）。/ My override wins; enforced can't be turned off.
    let r = lab.app.put(mine, Some(&alice.token), json!({"prefs": [{"event": "tunnel.ip_changed", "channel": "toast", "value": "on"}]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let ip = row(&r.json, "tunnel.ip_changed");
    assert_eq!((ip["mine"]["toast"].clone(), ip["effective"]["toast"].clone(), ip["source"]["toast"].clone()), (json!(true), json!(true), json!("mine")));
    let r = lab
        .app
        .put(
            mine,
            Some(&alice.token),
            json!({"prefs": [{"event": "share.received", "channel": "toast", "value": "off"}, {"event": "tunnel.host_key_changed", "channel": "toast", "value": "off"}]}),
        )
        .await;
    assert_eq!((r.status, r.json["code"].clone(), r.json["event"].clone()), (StatusCode::BAD_REQUEST, json!("locked"), json!("tunnel.host_key_changed")));
    let r = lab.app.get(mine, Some(&alice.token)).await;
    assert_eq!(row(&r.json, "share.received")["mine"]["toast"], Value::Null, "nothing written on a refused change");
    // 只影響自己；inherit 刪掉覆寫。/ Only mine; inherit removes the override.
    assert_eq!(row(&lab.app.get(mine, Some(&bob.token)).await.json, "tunnel.ip_changed")["source"]["toast"], "site");
    let r = lab.app.put(mine, Some(&alice.token), json!({"prefs": [{"event": "tunnel.ip_changed", "channel": "toast", "value": "inherit"}]})).await;
    assert_eq!(row(&r.json, "tunnel.ip_changed")["source"]["toast"], "site");
    // 解鎖之後就能關。/ Once unlocked it can be turned off.
    lab.app.put(defaults, Some(&admin.token), json!({"locks": [{"event": "tunnel.host_key_changed", "locked": false}]})).await;
    let r = lab.app.put(mine, Some(&alice.token), json!({"prefs": [{"event": "tunnel.host_key_changed", "channel": "toast", "value": "off"}]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(row(&r.json, "tunnel.host_key_changed")["source"]["desktop"], "site");

    // 隧道靜音：看得到才能設；分享給 bob 後 bob 也能設自己的。/ Mutes: visible tunnels only, per person.
    let key = lab.keygen("dev-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "dev", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let dev = Device { tunnel_id: t.id, name: "dev".into(), reverse_port: port, target: lab.machine("unused", &[], false).await, key };
    lab.share(&alice, &dev, &bob, "view", &[]).await;
    let path = format!("/api/notifications/mute/{}", t.id);
    assert_eq!(lab.app.put(&path, Some(&mallory.token), json!({"scope": "all"})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(lab.app.put(&path, Some(&bob.token), json!({"scope": "loud"})).await.status, StatusCode::BAD_REQUEST);
    let r = lab.app.put(&path, Some(&bob.token), json!({"scope": "status"})).await;
    assert_eq!((r.status, r.json["scope"].clone()), (StatusCode::OK, json!("status")), "{}", r.text);
    let r = lab.app.get(mine, Some(&bob.token)).await;
    assert_eq!(r.json["mutes"], json!([{"tunnel_id": t.id, "tunnel_name": "dev", "scope": "status"}]));
    assert_eq!(lab.app.get(mine, Some(&alice.token)).await.json["mutes"], json!([]), "bob's mute is his alone");
    let r = lab.app.delete(&path, Some(&bob.token)).await;
    assert_eq!(r.json["scope"], Value::Null);
    assert_eq!(lab.app.get(mine, Some(&bob.token)).await.json["mutes"], json!([]));

    // 刪隧道：靜音一起刪。/ Deleting the tunnel drops its mutes.
    lab.app.put(&path, Some(&alice.token), json!({})).await;
    assert_eq!(db::notify_prefs::mutes(&lab.app.state.db, alice.id).await.unwrap().len(), 1);
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{}", t.id), Some(&alice.token)).await;
    assert!(r.status.is_success(), "{}", r.text);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_notify_tunnel_mute WHERE tunnel_id = ?").bind(t.id).fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(left, 0);
}
