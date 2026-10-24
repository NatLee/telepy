//! 敏感隧道的 step-up：打開要自己有第二因素；之後網頁終端機 / 檔案管理（WebSocket 4008）、SFTP REST（403
//! `step_up_required`）都要帶這個瀏覽器的 step-up token；筆電經 gateway 的 SSH 要這個人最近在網頁確認過；token 是每個人
//! 自己的；關掉要再驗證。全部打真的裝置 sshd。
//! Step-up on a sensitive tunnel: turning it on needs a factor of your own; then the web terminal / file manager
//! (WebSocket 4008) and SFTP REST (403 `step_up_required`) need this browser's token, laptop SSH through the gateway
//! needs a recent web confirmation, tokens are per user, and turning it off needs a re-authentication.
mod common;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use common::lab::{Hop, Lab};
use serde_json::json;
use telepy_server::{db, mfa, step_up};

fn code_at(secret_b32: &str, unix: i64) -> String {
    let secret = mfa::base32_decode(secret_b32).unwrap();
    format!("{:06}", mfa::hotp(&secret, mfa::totp_step(unix as u64)))
}

/// 開 TOTP，回復原碼。/ Enable TOTP; returns the recovery codes.
async fn enable_totp(lab: &Lab, token: &str) -> Vec<String> {
    let r = lab.app.post("/api/auth/mfa/totp/setup", Some(token), json!({})).await;
    let secret = r.json["secret"].as_str().unwrap().to_string();
    let r = lab.app.post("/api/auth/mfa/totp/enable", Some(token), json!({"code": code_at(&secret, chrono::Utc::now().timestamp())})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.json["recovery_codes"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect()
}

async fn sftp_shell(lab: &Lab, token: &str, tunnel_id: i64, step_up: Option<&str>) -> common::Resp {
    let mut req = Request::builder().uri(format!("/api/sftp/shell/{tunnel_id}/ubuntu")).header(header::AUTHORIZATION, format!("Bearer {token}"));
    if let Some(s) = step_up {
        req = req.header(step_up::HEADER, s);
    }
    lab.app.send(req.body(Body::empty()).unwrap()).await
}

#[tokio::test]
async fn sensitive_tunnels_ask_for_a_fresh_confirmation() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service, &alice.key, &bob.key])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let setting = format!("/api/reverse/server/{}/step-up", dev.tunnel_id);
    let laptop = [(Hop::Tunnel(&dev), "ubuntu")];

    // 還沒開：一切照舊。/ Off: nothing changes.
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    t.close().await;
    assert!(lab.laptop_exec(&bob, &laptop, "whereami").await.ok);

    // 只有 owner / ADMIN 能開；自己沒有第二因素不能開（不然自己也進不去）。/ Owner / ADMIN only, and only with a factor.
    assert_eq!(lab.app.put(&setting, Some(&bob.token), json!({"required": true})).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.put(&setting, Some(&alice.token), json!({"required": true})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::BAD_REQUEST, Some("step_up_enroll")), "{}", r.text);
    let codes = enable_totp(&lab, &alice.token).await;
    let r = lab.app.put(&setting, Some(&alice.token), json!({"required": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let item = lab.app.get("/api/reverse/server/dashboard", Some(&bob.token)).await.json["tunnels"][0].clone();
    assert_eq!(item["require_step_up"], true, "{item}");

    // 沒 token：終端機 / 檔案 4008、SFTP 403。/ No token: 4008 on the sockets, 403 on SFTP.
    assert_eq!(lab.terminal(&alice, &dev, "ubuntu").await.err(), Some(step_up::CLOSE_CODE));
    assert_eq!(lab.filemanager(&alice, &dev, "ubuntu", json!({"action": "shell_detect"})).await.err(), Some(step_up::CLOSE_CODE));
    let r = sftp_shell(&lab, &alice.token, dev.tunnel_id, None).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("step_up_required")), "{}", r.text);
    assert_eq!(sftp_shell(&lab, &alice.token, dev.tunnel_id, Some("tps_forged")).await.status, StatusCode::FORBIDDEN);

    // 筆電的 SSH：還沒確認過就被 gateway 擋，記一筆事件。/ Laptop SSH is refused at the gateway until a confirmation.
    let r = lab.laptop_exec(&alice, &laptop, "whereami").await;
    assert!(!r.ok, "{r:?}");
    let events = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={}", dev.tunnel_id), Some(&alice.token)).await;
    assert!(events.json.as_array().unwrap().iter().any(|e| e["event"] == "step_up_required"), "{}", events.text);

    // 換 token：要第二因素（沒帶就 403 + 方法），帶了就拿到。/ Getting a token takes a second-factor proof.
    let r = lab.app.post("/api/auth/step-up", Some(&alice.token), json!({})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("reauth_required")), "{}", r.text);
    let r = lab.app.post("/api/auth/step-up", Some(&alice.token), json!({"reauth": {"method": "recovery_code", "code": codes[0]}})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["window_secs"], 900);
    let token = r.json["token"].as_str().unwrap().to_string();
    let r = lab.app.post("/api/auth/step-up", Some(&bob.token), json!({})).await;
    assert_eq!(r.json["code"], "step_up_enroll", "bob has no second factor: {}", r.text);

    // 有 token：都可以了；筆電也放行（同一個人剛確認過）。/ With the token everything opens; so does the laptop.
    let extra = json!({"step_up": token});
    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", extra.clone()).await.expect("terminal with a step-up");
    t.expect("login:ubuntu@box").await;
    t.close().await;
    let r = lab.filemanager_with(&alice, &dev, "ubuntu", extra.clone(), json!({"action": "shell_detect"})).await;
    assert!(r.is_ok(), "{r:?}");
    assert_eq!(sftp_shell(&lab, &alice.token, dev.tunnel_id, Some(&token)).await.status, StatusCode::OK);
    let r = lab.laptop_exec(&alice, &laptop, "whereami").await;
    assert_eq!(r.stdout, "ubuntu@box", "{r:?}");

    // token 是每個人自己的：bob 拿 alice 的不行，筆電也還被擋。/ Tokens are personal; bob's laptop is still refused.
    assert_eq!(lab.terminal_with(&bob, &dev, "ubuntu", extra.clone()).await.err(), Some(step_up::CLOSE_CODE));
    assert!(!lab.laptop_exec(&bob, &laptop, "whoami").await.ok);
    let (bob_token, _) = lab.app.state.step_up.grant(bob.id);
    let t = lab.terminal_with(&bob, &dev, "ubuntu", json!({"step_up": bob_token})).await.expect("bob after his own step-up");
    t.close().await;
    assert!(lab.laptop_exec(&bob, &laptop, "whereami").await.ok);

    // 關掉要再驗證；關掉後不用 token。/ Turning it off needs a re-authentication; afterwards no token is needed.
    let r = lab.app.put(&setting, Some(&alice.token), json!({"required": false})).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("reauth_required")), "{}", r.text);
    let r = lab.app.put(&setting, Some(&alice.token), json!({"required": false, "reauth": {"method": "recovery_code", "code": codes[1]}})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(!db::tunnels::by_id(&lab.app.state.db, dev.tunnel_id).await.unwrap().unwrap().require_step_up);
    lab.app.state.step_up.revoke(alice.id);
    let t = lab.terminal(&alice, &dev, "ubuntu").await.expect("no step-up needed any more");
    t.close().await;
}
