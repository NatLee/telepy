//! 推播通知：訂閱、加密（用裝置的私鑰解回來）、VAPID 簽章、照通知偏好過濾、指令內容藏不藏、推播服務說不在了就刪、
//! 登出就刪，全部對一個本機的假推播服務跑。
//! Push notifications against a local fake push service: subscribing, encryption (decrypted with the device's key), the
//! VAPID signature, filtering by notification preferences, hiding the command, removal on 410 and on sign-out.
mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::{PublicKey, SecretKey};
use serde_json::{json, Value};
use sha2::Sha256;
use telepy_server::webhooks::{Event, Kind, TunnelRef};
use common::lab::{free_port, Lab, LabKey};
use std::process::Stdio;
use telepy_server::{db, monitor::runner};
use tokio::process::{Child, Command};

#[derive(Clone, Debug)]
struct Got {
    path: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

type Inbox = Arc<Mutex<Vec<Got>>>;

async fn fake_push_service() -> (String, Inbox) {
    async fn take(State(inbox): State<Inbox>, Path(rest): Path<String>, headers: HeaderMap, body: Bytes) -> StatusCode {
        inbox.lock().unwrap().push(Got { path: rest.clone(), headers, body: body.to_vec() });
        if rest.starts_with("gone") { StatusCode::GONE } else { StatusCode::CREATED }
    }
    let inbox: Inbox = Arc::default();
    let app = axum::Router::new().route("/{*rest}", axum::routing::post(take)).with_state(inbox.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, inbox)
}

/// 一台「瀏覽器」：P-256 金鑰與 16 位元組的共用秘密。/ A "browser": a P-256 key and a 16-byte secret.
struct Device {
    secret: SecretKey,
    auth: [u8; 16],
}

impl Device {
    fn new(seed: u8) -> Self {
        let mut b = [seed; 32];
        b[0] = 1;
        Self { secret: SecretKey::from_slice(&b).unwrap(), auth: [seed; 16] }
    }
    fn keys(&self) -> Value {
        json!({ "p256dh": URL_SAFE_NO_PAD.encode(self.secret.public_key().to_sec1_bytes()), "auth": URL_SAFE_NO_PAD.encode(self.auth) })
    }
    /// RFC 8291 的解密（瀏覽器那一端）。/ RFC 8291 decryption, the browser's side.
    fn open(&self, body: &[u8]) -> Value {
        let idlen = body[20] as usize;
        let as_public = &body[21..21 + idlen];
        let ecdh = p256::ecdh::diffie_hellman(self.secret.to_nonzero_scalar(), PublicKey::from_sec1_bytes(as_public).unwrap().as_affine());
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(&self.secret.public_key().to_sec1_bytes());
        info.extend_from_slice(as_public);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&self.auth), ecdh.raw_secret_bytes().as_slice()).expand(&info, &mut ikm).unwrap();
        let prk = Hkdf::<Sha256>::new(Some(&body[..16]), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let mut plain = Aes128Gcm::new_from_slice(&cek).unwrap().decrypt(Nonce::from_slice(&nonce), &body[21 + idlen..]).unwrap();
        assert_eq!(plain.pop(), Some(2));
        serde_json::from_slice(&plain).unwrap()
    }
}

async fn login(app: &common::TestApp, username: &str) -> (String, String) {
    let r = app.post("/api/auth/register", None, json!({"username": username, "password": "pw"})).await;
    assert!(r.status == StatusCode::CREATED || r.status == StatusCode::BAD_REQUEST, "{}", r.text);
    let r = app.post("/api/auth/token", None, json!({"username": username, "password": "pw"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    (r.json["access_token"].as_str().unwrap().to_string(), r.json["refresh_token"].as_str().unwrap().to_string())
}

/// 等收件匣有 `n` 則（推播是背景送的）。/ Wait until the inbox holds `n` (pushes go out in the background).
async fn wait_for(inbox: &Inbox, n: usize) -> Vec<Got> {
    for _ in 0..100 {
        if inbox.lock().unwrap().len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    inbox.lock().unwrap().clone()
}

/// 給背景一點時間，確定「沒有送」。/ Give the background a moment, to be sure nothing was sent.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(600)).await;
}

fn lab() -> TunnelRef {
    TunnelRef { id: 7, name: "lab-pi".into(), reverse_port: 2201 }
}

#[tokio::test]
async fn pushes_are_encrypted_signed_filtered_and_end_with_the_sign_in() {
    let app = common::spawn().await;
    let (base, inbox) = fake_push_service().await;
    app.state.push.set_test_service(&base);
    let admin = app.login("admin", "pw").await;
    assert_eq!(app.post("/api/site/settings", Some(&admin), json!({"allow_registration": true})).await.status, StatusCode::OK);
    let (bob, bob_refresh) = login(&app, "bob").await;
    let bob_id: i64 = sqlx::query_scalar("SELECT id FROM auth_user WHERE username = 'bob'").fetch_one(&app.state.db.read).await.unwrap();

    // 公鑰與空的裝置清單。/ The public key and an empty device list.
    let r = app.get("/api/push", Some(&bob)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!((r.json["enabled"].as_bool(), r.json["available"].as_bool()), (Some(true), Some(true)));
    let public_key = r.json["public_key"].as_str().unwrap().to_string();
    assert_eq!(URL_SAFE_NO_PAD.decode(&public_key).unwrap().len(), 65);
    assert_eq!(r.json["subscriptions"], json!([]));

    // 只收認得的推播服務、像樣的金鑰。/ Only known push services and sound keys.
    let phone = Device::new(3);
    let r = app.post("/api/push/subscriptions", Some(&bob), json!({"endpoint": "https://example.com/push", "keys": phone.keys(), "lang": "zh-TW"})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("push_endpoint")));
    let r = app.post("/api/push/subscriptions", Some(&bob), json!({"endpoint": format!("{base}ok/phone"), "keys": {"p256dh": "AAAA", "auth": "AAAA"}})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("push_keys")));

    let r = app.post("/api/push/subscriptions", Some(&bob), json!({"endpoint": format!("{base}ok/phone"), "keys": phone.keys(), "lang": "zh-TW", "details": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let subs = r.json["subscriptions"].as_array().unwrap().clone();
    assert_eq!(subs.len(), 1);
    assert_eq!((subs[0]["current"].as_bool(), subs[0]["lang"].as_str(), subs[0]["details"].as_bool()), (Some(true), Some("zh-TW"), Some(false)));
    let sub_id = subs[0]["id"].as_i64().unwrap();

    // 新裝置登入 → 推到手機：解得開、VAPID 驗得過、標題是 App 名稱、內文是那台裝置的語言。
    // A new-device sign-in reaches the phone: it decrypts, VAPID verifies, the title is the app name, the body in the device's language.
    app.state.webhooks.emit(Event::new(Kind::AccountSignInNewDevice).to([bob_id], None).data(json!({"ip": "203.0.113.9", "device": "Firefox on Linux", "method": "password"})));
    let got = wait_for(&inbox, 1).await;
    assert_eq!((got.len(), got[0].path.as_str()), (1, "ok/phone"));
    let h = &got[0].headers;
    assert_eq!((h["content-encoding"].to_str().unwrap(), h["ttl"].to_str().unwrap(), h["urgency"].to_str().unwrap(), h["topic"].to_str().unwrap()), ("aes128gcm", "86400", "high", "sign-in"));
    let auth = h["authorization"].to_str().unwrap();
    let (t, k) = auth.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
    assert_eq!(k, public_key, "the key the browser subscribed with");
    let parts: Vec<&str> = t.split('.').collect();
    let vk = VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(k).unwrap()).unwrap();
    let sig = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
    assert!(vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).is_ok());
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(claims["aud"], base.trim_end_matches('/'));
    let msg = phone.open(&got[0].body);
    assert_eq!((msg["title"].as_str(), msg["tag"].as_str()), (Some("Telepy"), Some("sign-in")));
    assert!(msg["body"].as_str().unwrap().contains("203.0.113.9"), "{msg}");
    let r = app.get("/api/push", Some(&bob)).await;
    assert!(r.json["subscriptions"][0]["last_success_at"].is_string(), "the success is recorded");

    // 等核准的指令：預設不寫內容；這台裝置打開「顯示指令」才寫。/ An approval request hides the command unless this device shows it.
    let approval = |id: i64| Event::new(Kind::CommandApprovalRequested).tunnel_ref(lab()).to([bob_id], None).data(json!({"request_id": id, "by": "alice", "account": "root", "command": "rm -rf /tmp/x"})).link("/tunnels/commands?tunnel=7");
    app.state.webhooks.emit(approval(41));
    let got = wait_for(&inbox, 2).await;
    let msg = phone.open(&got[1].body);
    assert_eq!((msg["tag"].as_str(), msg["path"].as_str()), (Some("command-41"), Some("/tunnels/commands?tunnel=7")));
    assert!(!msg["body"].as_str().unwrap().contains("rm -rf"), "{msg}");
    assert_eq!(got[1].headers["ttl"].to_str().unwrap(), "600", "a pending command is useless once it expires");
    let r = app.patch(&format!("/api/push/subscriptions/{sub_id}"), Some(&bob), json!({"details": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    app.state.webhooks.emit(approval(42));
    let got = wait_for(&inbox, 3).await;
    assert!(phone.open(&got[2].body)["body"].as_str().unwrap().contains("rm -rf /tmp/x"));

    // 狀態事件這一步不推；關掉那個事件的桌面通知就不推；站台關掉就全部不推。
    // Status events are not pushed yet; turning the event's desktop notification off stops it; the site switch stops all.
    app.state.webhooks.emit(Event::new(Kind::TunnelOffline).tunnel_ref(lab()).to([bob_id], None));
    let r = app.put("/api/notifications/preferences", Some(&bob), json!({"prefs": [{"event": Kind::AccountSignInNewDevice.name(), "channel": "desktop", "value": "off"}]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    app.state.webhooks.emit(Event::new(Kind::AccountSignInNewDevice).to([bob_id], None).data(json!({"ip": "203.0.113.10"})));
    let r = app.post("/api/site/settings", Some(&admin), json!({"notify_push": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    app.state.webhooks.emit(approval(43));
    settle().await;
    assert_eq!(inbox.lock().unwrap().len(), 3, "nothing more went out");
    let r = app.post("/api/push/subscriptions", Some(&bob), json!({"endpoint": format!("{base}ok/laptop"), "keys": Device::new(5).keys()})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::CONFLICT, Some("push_off")));
    assert_eq!(app.get("/api/push", Some(&bob)).await.json["available"], false);
    assert_eq!(app.post("/api/site/settings", Some(&admin), json!({"notify_push": true})).await.status, StatusCode::OK);

    // 測試推播；別人的裝置是 404。/ A test push; someone else's device is a 404.
    let r = app.post(&format!("/api/push/subscriptions/{sub_id}/test"), Some(&bob), json!({})).await;
    assert_eq!((r.status, r.json["outcome"].as_str()), (StatusCode::OK, Some("sent")), "{}", r.text);
    let got = wait_for(&inbox, 4).await;
    assert_eq!(phone.open(&got[3].body)["tag"], "push-test");
    assert_eq!(app.post(&format!("/api/push/subscriptions/{sub_id}/test"), Some(&admin), json!({})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.patch(&format!("/api/push/subscriptions/{sub_id}"), Some(&admin), json!({"details": false})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.delete(&format!("/api/push/subscriptions/{sub_id}"), Some(&admin)).await.status, StatusCode::NOT_FOUND);

    // 同一個登入重新訂閱（瀏覽器換了網址）= 取代，不會變兩台。/ Re-subscribing from the same sign-in replaces, never two rows.
    let (bob_laptop, _) = login(&app, "bob").await;
    let r = app.post("/api/push/subscriptions", Some(&bob_laptop), json!({"endpoint": format!("{base}ok/laptop-1"), "keys": Device::new(9).keys()})).await;
    assert_eq!(r.json["subscriptions"].as_array().unwrap().len(), 2);
    let r = app.post("/api/push/subscriptions", Some(&bob_laptop), json!({"endpoint": format!("{base}ok/laptop-2"), "keys": Device::new(9).keys()})).await;
    let rows = r.json["subscriptions"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows.iter().filter(|s| s["current"] == true).count(), 1, "one row per sign-in");
    let laptop_id = rows.iter().find(|s| s["current"] == true).unwrap()["id"].as_i64().unwrap();
    assert_eq!(app.delete(&format!("/api/push/subscriptions/{laptop_id}"), Some(&bob_laptop)).await.status, StatusCode::OK);

    // 推播服務說訂閱不在了（410）→ 刪掉。/ The push service says the subscription is gone (410): removed.
    let old = Device::new(7);
    let r = app.post("/api/push/subscriptions", Some(&bob_laptop), json!({"endpoint": format!("{base}gone/old"), "keys": old.keys()})).await;
    assert_eq!(r.json["subscriptions"].as_array().unwrap().len(), 2);
    app.state.webhooks.emit(approval(44));
    wait_for(&inbox, 6).await;
    settle().await;
    let r = app.get("/api/push", Some(&bob)).await;
    assert_eq!(r.json["subscriptions"].as_array().unwrap().iter().map(|s| s["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![sub_id]);

    // 登出 → 這台裝置的訂閱跟著刪。/ Signing out removes this device's subscription.
    let r = app.post("/api/auth/logout", None, json!({"refresh": bob_refresh})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let mut left = 1;
    for _ in 0..50 {
        left = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM telepy_push_subscription WHERE user_id = ?").bind(bob_id).fetch_one(&app.state.db.read).await.unwrap();
        if left == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(left, 0, "a signed-out device gets no more pushes");
    let before = inbox.lock().unwrap().len();
    app.state.webhooks.emit(approval(45));
    settle().await;
    assert_eq!(inbox.lock().unwrap().len(), before);
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

/// 監控迴圈推 n 輪（去彈跳要連兩輪），再等背景的推播送完。/ Step the monitor n cycles, then let the pushes go out.
async fn step(lab: &Lab, r: &mut runner::Runner, n: usize) {
    for _ in 0..n {
        runner::cycle(&lab.app.state, r).await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
}

/// 實驗室使用者的網頁登入（推播訂閱要綁在一個登入上）。/ A web sign-in for a lab user (subscriptions belong to one).
async fn web_sign_in(lab: &Lab, user_id: i64) -> String {
    let pair = telepy_server::auth::sessions::issue(&lab.app.state, user_id, &telepy_server::client_ip::ClientMeta::default(), "password", None).await.unwrap();
    pair["access_token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn status_pushes_wait_follow_the_audience_and_stop_at_the_hourly_cap() {
    let Some(lab) = Lab::start().await else { return };
    let (base, inbox) = fake_push_service().await;
    lab.app.state.push.set_test_service(&base);
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let (alice_web, bob_web) = (web_sign_in(&lab, alice.id).await, web_sign_in(&lab, bob.id).await);
    let (phone, other) = (Device::new(3), Device::new(4));
    for (token, dev, path) in [(&alice_web, &phone, "ok/alice"), (&bob_web, &other, "ok/bob")] {
        let r = lab.app.post("/api/push/subscriptions", Some(token), json!({"endpoint": format!("{base}{path}"), "keys": dev.keys(), "lang": "en"})).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    }

    // 每個人自己選等多久：只收固定選項；站台上限把它收窄。/ Each person picks the wait: fixed choices, narrowed by the site.
    let r = lab.app.post("/api/user/settings", Some(&alice_web), json!({"push_status_delay": 42})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.post("/api/user/settings", Some(&alice_web), json!({"push_status_delay": 3600})).await;
    assert_eq!((r.status, r.json["push_status_delay_max"].as_i64()), (StatusCode::OK, Some(3600)), "{}", r.text);
    let r = lab.app.post("/api/site/settings", Some(&lab.admin_token), json!({"notify_push_max_delay": 0})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = lab.app.get("/api/push", Some(&alice_web)).await;
    assert_eq!((r.json["status"]["delay"].as_i64(), r.json["status"]["effective"].as_i64()), (Some(3600), Some(0)), "{}", r.text);

    let key = lab.keygen("dev-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "dev", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let sshd = lab.machine("dev", &[], false).await;
    let status = lab.app.state.status.clone();
    let wait_listen = |up: bool| {
        let status = status.clone();
        async move {
            while status.listen_ports().is_some_and(|p| p.contains(&port)) != up {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    let mut mon = runner::Runner::default();
    step(&lab, &mut mon, 2).await;
    let mut ssh = tunnel_ssh(&lab, &key, port, sshd.port);
    wait_listen(true).await;
    step(&lab, &mut mon, 3).await;
    assert_eq!(inbox.lock().unwrap().len(), 0, "coming up for the first time is not news");

    // 斷線 → 離線推播（只給看得到這條隧道的 alice）；回來 → 上線推播。/ Down → offline (alice only); back → online.
    ssh.kill().await.unwrap();
    wait_listen(false).await;
    step(&lab, &mut mon, 3).await;
    let got = wait_for(&inbox, 1).await;
    assert_eq!(got.len(), 1, "bob cannot see alice's tunnel");
    assert_eq!(got[0].path, "ok/alice");
    let off = phone.open(&got[0].body);
    assert_eq!((off["tag"].clone(), off["path"].clone()), (json!(format!("tunnel-{}", t.id)), json!(format!("/tunnels/{}", t.id))));
    assert_eq!(off["body"], format!("dev is offline (port {port})"));

    let mut ssh = tunnel_ssh(&lab, &key, port, sshd.port);
    wait_listen(true).await;
    step(&lab, &mut mon, 3).await;
    let got = wait_for(&inbox, 2).await;
    assert_eq!(phone.open(&got[1].body)["body"], format!("dev is back online (port {port})"));

    // 每小時上限：已經送了 2 則，上限 2 → 下一次變化只送一則「還有更多」，之後都不送。
    // The hourly cap: 2 sent, cap 2 → the next change sends one "more are waiting", then nothing.
    let r = lab.app.post("/api/site/settings", Some(&lab.admin_token), json!({"notify_push_per_hour": 2})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    ssh.kill().await.unwrap();
    wait_listen(false).await;
    step(&lab, &mut mon, 3).await;
    let got = wait_for(&inbox, 3).await;
    let held = phone.open(&got[2].body);
    assert_eq!(held["tag"], "status-held", "{held}");
    let _ssh = tunnel_ssh(&lab, &key, port, sshd.port);
    wait_listen(true).await;
    step(&lab, &mut mon, 3).await;
    settle().await;
    assert_eq!(inbox.lock().unwrap().len(), 3, "nothing more this hour");
}
