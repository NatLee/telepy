//! Webhook：個人 webhook 的政策與 CRUD、事件只到該收的人、全站 webhook 的精選事件、簽章、一直失敗會暫停，
//! 以及真的隧道斷線 / 重連時每個 webhook 依自己的延遲送 offline / online。監控迴圈在測試裡手動推。
//! Webhooks: personal policy and CRUD, events reaching only their audience, the site-wide curated events,
//! signatures, pausing after repeated failures, and offline / online on a real tunnel drop with per-webhook
//! timers. The monitor loop is stepped by hand.
mod common;

use std::process::Stdio;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::{routing::post, Router};
use common::lab::{free_port, Lab, LabKey};
use serde_json::{json, Value};
use telepy_server::webhooks::{sign, Event, Kind};
use telepy_server::{db, monitor::runner};
use tokio::process::{Child, Command};

/// 收到的一則：headers + 原始內容。/ One received request.
#[derive(Clone, Debug)]
struct Got {
    headers: HeaderMap,
    body: Bytes,
}

impl Got {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn event(&self) -> String {
        self.headers.get("x-telepy-event").and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
    }
}

struct Receiver {
    url: String,
    got: Arc<Mutex<Vec<Got>>>,
    /// 回什麼狀態碼（預設 204）。/ The status to answer with.
    status: Arc<AtomicU16>,
}

impl Receiver {
    async fn start() -> Self {
        let got: Arc<Mutex<Vec<Got>>> = Arc::default();
        let status = Arc::new(AtomicU16::new(204));
        let (sink, code) = (got.clone(), status.clone());
        let app = Router::new().route(
            "/hook",
            post(move |headers: HeaderMap, body: Bytes| {
                let (sink, code) = (sink.clone(), code.clone());
                async move {
                    sink.lock().unwrap().push(Got { headers, body });
                    StatusCode::from_u16(code.load(Ordering::SeqCst)).unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/hook", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, got, status }
    }

    fn of(&self, event: &str) -> Vec<Got> {
        self.got.lock().unwrap().iter().filter(|g| g.event() == event).cloned().collect()
    }

    async fn wait(&self, event: &str) -> Got {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(g) = self.of(event).into_iter().next() {
                return g;
            }
            assert!(tokio::time::Instant::now() < deadline, "no {event}; got {:?}", self.got.lock().unwrap().iter().map(Got::event).collect::<Vec<_>>());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 等一下，確定什麼都沒來。/ Wait a moment and make sure nothing arrived.
    async fn quiet(&self, event: &str) {
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(self.of(event).is_empty(), "unexpected {event}");
    }
}

async fn settings(lab: &Lab, body: Value) {
    let r = lab.app.post("/api/site/settings", Some(&lab.admin_token), body).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
}

async fn create(lab: &Lab, token: &str, body: Value) -> (i64, String) {
    let r = lab.app.post("/api/webhooks", Some(token), body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    (r.json["webhook"]["id"].as_i64().unwrap(), r.json["secret"].as_str().unwrap().to_string())
}

fn new_tunnel<'a>(owner: i64, name: &'a str, key: &'a LabKey) -> db::tunnels::NewTunnel<'a> {
    db::tunnels::NewTunnel { user_id: owner, host_friendly_name: name, key: &key.public, reverse_port: free_port() as i64, description: None, default_username_id: None }
}

#[tokio::test]
async fn personal_webhooks_policy_crud_and_signatures() {
    let Some(lab) = Lab::start().await else { return };
    let hook = Receiver::start().await;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;

    // 預設不准連內網（SSRF）；全站 webhook 只有管理員能建。/ Private targets are refused by default; site webhooks are admin-only.
    let r = lab.app.post("/api/webhooks", Some(&alice.token), json!({"url": hook.url})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("private_target")), "{}", r.text);
    assert!(r.json["url"].is_array());
    let r = lab.app.post("/api/webhooks", Some(&alice.token), json!({"url": "ftp://example.com/x"})).await;
    assert_eq!(r.json["code"], "invalid_url", "{}", r.text);
    let r = lab.app.post("/api/webhooks", Some(&alice.token), json!({"scope": "site", "url": hook.url})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text);

    settings(&lab, json!({"notify_private_targets": true})).await;
    let r = lab.app.post("/api/webhooks", Some(&alice.token), json!({"url": hook.url, "events": ["user.created"]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "site-only events are not personal: {}", r.text);
    let r = lab.app.post("/api/webhooks", Some(&alice.token), json!({"url": hook.url, "events": []})).await;
    assert_eq!(r.json["code"], "no_events", "{}", r.text);
    let r = lab.app.post("/api/webhooks", Some(&alice.token), json!({"url": hook.url, "all_tunnels": false, "tunnel_ids": [999]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "a tunnel alice can't see: {}", r.text);

    let (id, secret) = create(&lab, &alice.token, json!({"url": hook.url, "name": "phone"})).await;
    assert!(secret.starts_with("whsec_"));
    let list = lab.app.get("/api/webhooks", Some(&alice.token)).await;
    assert_eq!(list.json["mine"].as_array().unwrap().len(), 1, "{}", list.text);
    assert_eq!(list.json["mine"][0]["events"], json!(["tunnel.offline", "tunnel.online", "tunnel.degraded", "tunnel.recovered"]), "status events by default");
    assert_eq!(list.json["mine"][0]["format_resolved"], "json");
    assert!(list.json["site"].is_null() && list.json["catalog"]["site"].is_null(), "no site webhooks for non-admins");
    assert!(list.json["catalog"]["personal"].as_array().unwrap().iter().any(|e| e["event"] == "share.received"));

    // 別人的 webhook 一律 404。/ Someone else's webhook is a 404.
    for r in [
        lab.app.get(&format!("/api/webhooks/{id}"), Some(&bob.token)).await,
        lab.app.patch(&format!("/api/webhooks/{id}"), Some(&bob.token), json!({"name": "x"})).await,
        lab.app.delete(&format!("/api/webhooks/{id}"), Some(&bob.token)).await,
        lab.app.post(&format!("/api/webhooks/{id}/test"), Some(&bob.token), json!({})).await,
        lab.app.get(&format!("/api/webhooks/{id}/secret"), Some(&bob.token)).await,
    ] {
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    }

    // 測試送出：Standard Webhooks 簽章驗得過。/ The test send carries a Standard Webhooks signature that verifies.
    let r = lab.app.post(&format!("/api/webhooks/{id}/test"), Some(&alice.token), json!({})).await;
    assert_eq!(r.json["ok"], true, "{}", r.text);
    let got = hook.wait("webhook.test").await;
    let h = |k: &str| got.headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let ts: i64 = h("webhook-timestamp").parse().unwrap();
    assert_eq!(Some(h("webhook-signature")), sign::signature(&secret, &h("webhook-id"), ts, &got.body), "signature");
    assert_eq!(got.json()["text"], "[Telepy] Test message from alice: this webhook works.");
    let r = lab.app.get(&format!("/api/webhooks/{id}/secret"), Some(&alice.token)).await;
    assert_eq!(r.json["secret"], secret.as_str());
    let rotated = lab.app.post(&format!("/api/webhooks/{id}/secret"), Some(&alice.token), json!({})).await;
    assert_ne!(rotated.json["secret"], secret.as_str());

    let r = lab.app.get(&format!("/api/webhooks/{id}/deliveries"), Some(&alice.token)).await;
    assert_eq!(r.json.as_array().unwrap().len(), 1, "{}", r.text);
    assert_eq!((r.json[0]["status"].as_str(), r.json[0]["test"].as_bool(), r.json[0]["http_status"].as_i64()), (Some("ok"), Some(true), Some(204)));
    assert!(r.json[0]["body"].as_str().unwrap().contains("webhook.test"));

    // 上限與總開關。/ The per-person limit and the site switch.
    settings(&lab, json!({"notify_max_webhooks": 1})).await;
    let r = lab.app.post("/api/webhooks", Some(&alice.token), json!({"url": hook.url})).await;
    assert_eq!(r.json["code"], "limit", "{}", r.text);
    settings(&lab, json!({"notify_user_webhooks": false})).await;
    let r = lab.app.post("/api/webhooks", Some(&bob.token), json!({"url": hook.url})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("personal_disabled")), "{}", r.text);

    // 存的時候准內網、之後管理員關掉：送的時候也擋。/ Private allowed when saved, then turned off: delivery refuses too.
    settings(&lab, json!({"notify_user_webhooks": true, "notify_private_targets": false})).await;
    let r = lab.app.post(&format!("/api/webhooks/{id}/test"), Some(&alice.token), json!({})).await;
    assert_eq!(r.json["ok"], false, "{}", r.text);
    assert!(r.json["error"].as_str().unwrap().contains("private network"), "{}", r.text);

    // PATCH 只改帶來的欄位；網址沒改不重查。/ PATCH changes only what is sent; an unchanged URL is not re-checked.
    let r = lab.app.patch(&format!("/api/webhooks/{id}"), Some(&alice.token), json!({"name": "pager", "language": "ja"})).await;
    assert_eq!((r.status, r.json["name"].as_str(), r.json["language"].as_str()), (StatusCode::OK, Some("pager"), Some("ja")), "{}", r.text);
    let r = lab.app.delete(&format!("/api/webhooks/{id}"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(lab.app.get(&format!("/api/webhooks/{id}"), Some(&alice.token)).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn events_reach_only_their_audience() {
    let Some(lab) = Lab::start().await else { return };
    settings(&lab, json!({"notify_private_targets": true})).await;
    let (a_all, a_only_own, b_hook, c_hook) = (Receiver::start().await, Receiver::start().await, Receiver::start().await, Receiver::start().await);
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let db = &lab.app.state.db;
    let (k1, k2) = (lab.keygen("alice-pi-tunnel"), lab.keygen("bob-nas-tunnel"));
    let own = db::tunnels::create(db, new_tunnel(alice.id, "alice-pi", &k1)).await.unwrap();
    let shared = db::tunnels::create(db, new_tunnel(bob.id, "bob-nas", &k2)).await.unwrap();

    let ev = json!(["share.received", "share.ended"]);
    create(&lab, &alice.token, json!({"url": a_all.url, "events": ev, "format": "slack", "language": "zh-TW"})).await;
    create(&lab, &alice.token, json!({"url": a_only_own.url, "events": ev, "all_tunnels": false, "tunnel_ids": [own.id]})).await;
    create(&lab, &bob.token, json!({"url": b_hook.url, "events": ev})).await;
    create(&lab, &carol.token, json!({"url": c_hook.url, "events": ev})).await;

    // bob 分享給 alice：只有 alice 不限隧道的那個收到，用她選的語言與 Slack 格式。
    // bob shares with alice: only alice's unrestricted webhook gets it, in her language and the Slack format.
    let r = lab.app.post(&format!("/tunnels/share/{}", shared.id), Some(&bob.token), json!({"shared_with_user_id": alice.id, "permission_type": "view"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let got = a_all.wait("share.received").await.json();
    let text = got["text"].as_str().unwrap();
    assert!(text.starts_with("[Telepy] bob 把 bob-nas 分享給你（VIEW） <") && text.ends_with("/tunnels|在 Telepy 開啟>"), "{got}");
    a_only_own.quiet("share.received").await;
    b_hook.quiet("share.received").await;
    c_hook.quiet("share.received").await;

    // bob 撤銷：alice 收到；bob 自己動手的不送給他。/ bob revokes: alice hears about it; bob, who did it, doesn't.
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", shared.id, alice.id), Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    a_all.wait("share.ended").await;
    b_hook.quiet("share.ended").await;
    c_hook.quiet("share.ended").await;

    // 限定的隧道刪掉後從清單拿掉。/ A deleted tunnel leaves the webhook's list.
    let id = lab.app.get("/api/webhooks", Some(&alice.token)).await.json["mine"][1]["id"].as_i64().unwrap();
    db::tunnels::delete(db, own.id).await.unwrap();
    db::webhooks::forget_tunnel(db, own.id).await.unwrap();
    assert!(db::webhooks::tunnels_of(db, id).await.unwrap().is_empty());
}

#[tokio::test]
async fn site_webhooks_get_the_curated_events() {
    let Some(lab) = Lab::start().await else { return };
    let site = Receiver::start().await;
    let mine = Receiver::start().await;
    // 全站 webhook 可以連內網（管理員設的），不用改網站設定。/ Site webhooks may target private addresses without the setting.
    let (site_id, _) = create(&lab, &lab.admin_token, json!({"scope": "site", "url": site.url, "events": ["user.created", "account.sign_in_failed"]})).await;
    let r = lab.app.patch(&format!("/api/webhooks/{site_id}"), Some(&lab.admin_token), json!({"events": ["share.received"]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "not a site event: {}", r.text);
    let list = lab.app.get("/api/webhooks", Some(&lab.admin_token)).await;
    assert_eq!(list.json["site"][0]["id"], site_id, "{}", list.text);
    assert!(list.json["catalog"]["site"].as_array().unwrap().iter().all(|e| e["audience"] == "site"));

    settings(&lab, json!({"allow_registration": true, "notify_private_targets": true})).await;
    let r = lab.app.post("/api/auth/register", None, json!({"username": "dave"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let got = site.wait("user.created").await.json();
    assert_eq!((got["data"]["user"].as_str(), got["data"]["via"].as_str()), (Some("dave"), Some("registration")), "{got}");

    // 登入失敗：全站收到，帳號本人訂了也收到。/ A failed sign-in reaches the site webhook and the account's own.
    let alice = lab.user("alice").await;
    create(&lab, &alice.token, json!({"url": mine.url, "events": ["account.sign_in_failed"]})).await;
    let r = lab.app.post("/api/auth/token", None, json!({"username": "alice", "password": "wrong"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.text);
    let got = site.wait("account.sign_in_failed").await.json();
    assert_eq!((got["data"]["user"].as_str(), got["data"]["reason"].as_str()), (Some("alice"), Some("bad_password")), "{got}");
    assert!(got["tunnel"].is_null());
    mine.wait("account.sign_in_failed").await;

    // 全站 webhook 的變動記進 Logs。/ Site webhook changes are in the Logs.
    let logs = lab.app.get("/api/log/ssh/events?limit=50", Some(&lab.admin_token)).await;
    assert!(logs.json.as_array().unwrap().iter().any(|e| e["event"] == "webhook"), "{}", logs.text);
}

#[tokio::test]
async fn failing_webhooks_are_paused_and_can_be_turned_back_on() {
    let Some(lab) = Lab::start().await else { return };
    settings(&lab, json!({"notify_private_targets": true})).await;
    let hook = Receiver::start().await;
    hook.status.store(500, Ordering::SeqCst);
    let alice = lab.user("alice").await;
    let (id, _) = create(&lab, &alice.token, json!({"url": hook.url, "events": ["account.sign_in"]})).await;
    let hooks = lab.app.state.webhooks.clone();
    hooks.set_retry_delays(vec![Duration::ZERO]);
    for _ in 0..telepy_server::webhooks::PAUSE_AFTER {
        hooks.emit(Event::new(Kind::AccountSignIn).to([alice.id], None).data(json!({"user": "alice"})));
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let row = loop {
        let r = lab.app.get(&format!("/api/webhooks/{id}"), Some(&alice.token)).await;
        if r.json["enabled"] == false {
            break r.json;
        }
        assert!(tokio::time::Instant::now() < deadline, "not paused: {}", r.text);
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(row["paused_reason"], "failing", "{row}");
    assert_eq!(row["last"]["http_status"], 500);
    assert_eq!(hook.of("account.sign_in").len() as i64, telepy_server::webhooks::PAUSE_AFTER * 2, "every delivery was retried once");
    let r = lab.app.get(&format!("/api/webhooks/{id}/deliveries"), Some(&alice.token)).await;
    assert_eq!(r.json[0]["attempts"], 2, "{}", r.text);

    // 暫停後不再送；重新打開清掉暫停。/ Nothing while paused; turning it back on clears the pause.
    hooks.emit(Event::new(Kind::AccountSignIn).to([alice.id], None));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(hook.of("account.sign_in").len() as i64, telepy_server::webhooks::PAUSE_AFTER * 2);
    let r = lab.app.patch(&format!("/api/webhooks/{id}"), Some(&alice.token), json!({"enabled": true})).await;
    assert_eq!((r.json["enabled"].as_bool(), r.json["paused_reason"].is_null(), r.json["failures"].as_i64()), (Some(true), true, Some(0)), "{}", r.text);
}

fn tunnel_ssh(lab: &Lab, key: &LabKey, reverse_port: u16, target_port: u16) -> Child {
    Command::new("ssh")
        .args(["-F", "/dev/null", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
        .args(["-o", "ExitOnForwardFailure=yes", "-o", "LogLevel=ERROR", "-i"])
        .arg(&key.path)
        .args(["-p", &lab.gw_port.to_string(), "-R", &format!("*:{reverse_port}:127.0.0.1:{target_port}"), "telepy@127.0.0.1"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

/// 推監控迴圈 n 輪（去彈跳要連兩輪）。/ Step the monitor n cycles (debounce needs two in a row).
async fn step(lab: &Lab, r: &mut runner::Runner, n: usize) {
    for _ in 0..n {
        runner::cycle(&lab.app.state, r).await.unwrap();
    }
}

#[tokio::test]
async fn status_alerts_follow_each_webhooks_delay_and_audience() {
    let Some(lab) = Lab::start().await else { return };
    settings(&lab, json!({"notify_private_targets": true})).await;
    let (mine, slow, theirs, site) = (Receiver::start().await, Receiver::start().await, Receiver::start().await, Receiver::start().await);
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    create(&lab, &alice.token, json!({"url": mine.url, "delay": 0})).await;
    create(&lab, &alice.token, json!({"url": slow.url, "delay": 3600})).await;
    create(&lab, &bob.token, json!({"url": theirs.url, "delay": 0})).await;
    create(&lab, &lab.admin_token, json!({"scope": "site", "url": site.url, "delay": 0, "events": ["tunnel.offline", "tunnel.online"]})).await;

    // 真的隧道：上線 → 斷線（offline）→ 回來（online）。/ A real tunnel: up, down (offline), back (online).
    let key = lab.keygen("dev-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "dev", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let sshd = lab.machine("dev", &[], false).await;
    let mut r = runner::Runner::default();
    step(&lab, &mut r, 2).await; // commit "offline" for the new tunnel
    let status = lab.app.state.status.clone();
    let mut ssh = tunnel_ssh(&lab, &key, port, sshd.port);
    while !status.listen_ports().is_some_and(|p| p.contains(&port)) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    step(&lab, &mut r, 3).await;
    mine.quiet("tunnel.online").await; // coming up for the first time is not an alert

    ssh.kill().await.unwrap();
    while status.listen_ports().is_some_and(|p| p.contains(&port)) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    step(&lab, &mut r, 3).await;
    let off = mine.wait("tunnel.offline").await.json();
    assert_eq!((off["tunnel"]["id"].clone(), off["tunnel"]["name"].clone()), (json!(t.id), json!("dev")), "{off}");
    assert_eq!(off["text"], format!("[Telepy] dev is offline (port {port})"));
    site.wait("tunnel.offline").await;
    slow.quiet("tunnel.offline").await; // its delay has not passed
    theirs.quiet("tunnel.offline").await; // bob cannot see alice's tunnel

    let _ssh = tunnel_ssh(&lab, &key, port, sshd.port);
    while !status.listen_ports().is_some_and(|p| p.contains(&port)) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    step(&lab, &mut r, 3).await;
    mine.wait("tunnel.online").await;
    site.wait("tunnel.online").await;
    slow.quiet("tunnel.online").await; // never announced offline, so no online either
    assert_eq!(mine.of("tunnel.offline").len(), 1, "offline is sent once");
}
