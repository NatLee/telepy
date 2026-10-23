//! 隧道狀態告警的 webhook：網址驗證、測試發送，以及真的斷線 / 重連時（延遲 0）送出 offline 與 online。
//! 監控迴圈在測試裡手動推（`monitor::runner::cycle`），不靠計時器。
//! Status alert webhook: URL validation, the test send, and offline / online on a real drop and reconnect
//! (delay 0). The monitor loop is stepped by hand with `monitor::runner::cycle`.
mod common;

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use axum::{routing::post, Json, Router};
use common::lab::{free_port, Lab, LabKey};
use serde_json::{json, Value};
use telepy_server::{db, monitor::runner};
use tokio::process::{Child, Command};

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

/// 收 webhook 的小伺服器：每則 JSON 存起來。/ A tiny receiver that keeps every JSON body.
async fn receiver() -> (String, Arc<Mutex<Vec<Value>>>) {
    let got: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = got.clone();
    let app = Router::new().route(
        "/hook",
        post(move |Json(v): Json<Value>| {
            let sink = sink.clone();
            async move {
                sink.lock().unwrap().push(v);
                StatusCode::NO_CONTENT
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, got)
}

async fn wait_event(got: &Arc<Mutex<Vec<Value>>>, event: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(v) = got.lock().unwrap().iter().find(|v| v["event"] == event).cloned() {
            return v;
        }
        assert!(tokio::time::Instant::now() < deadline, "no {event} webhook; got {:?}", got.lock().unwrap());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 推監控迴圈 n 輪（去彈跳要連兩輪）。/ Step the monitor n cycles (debounce needs two in a row).
async fn step(lab: &Lab, r: &mut runner::Runner, n: usize) {
    for _ in 0..n {
        runner::cycle(&lab.app.state, r).await.unwrap();
    }
}

#[tokio::test]
async fn webhook_alerts() {
    let Some(lab) = Lab::start().await else { return };
    let (url, got) = receiver().await;
    let settings = "/api/site/settings";

    // 只接受 http(s)；空白 = 關閉。/ Only http(s); blank turns it off.
    let r = lab.app.post(settings, Some(&lab.admin_token), json!({"notify_webhook_url": "ftp://example.com/x"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    assert_eq!(lab.app.post(settings, Some(&lab.admin_token), json!({"notify_webhook_url": ""})).await.status, StatusCode::OK);
    assert_eq!(lab.app.post("/api/site/settings/notify-test", Some(&lab.admin_token), json!({})).await.status, StatusCode::BAD_REQUEST, "nothing saved yet");

    let r = lab.app.post(settings, Some(&lab.admin_token), json!({"notify_webhook_url": url, "notify_down_delay": 0})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["values"]["notify_down_delay"], 0);

    // 測試發送。/ The test send.
    let alice = lab.user("alice").await;
    assert_eq!(lab.app.post("/api/site/settings/notify-test", Some(&alice.token), json!({})).await.status, StatusCode::FORBIDDEN);
    let r = lab.app.post("/api/site/settings/notify-test", Some(&lab.admin_token), json!({})).await;
    assert_eq!(r.json["ok"], true, "{}", r.text);
    let test = wait_event(&got, "test").await;
    assert_eq!(test["text"], test["content"]);

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
    assert!(!got.lock().unwrap().iter().any(|v| v["event"] == "tunnel.online"), "coming up for the first time is not an alert");

    ssh.kill().await.unwrap();
    while status.listen_ports().is_some_and(|p| p.contains(&port)) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    step(&lab, &mut r, 3).await;
    let off = wait_event(&got, "tunnel.offline").await;
    assert_eq!((off["tunnel"]["id"].clone(), off["tunnel"]["name"].clone()), (json!(t.id), json!("dev")), "{off}");
    assert!(off["text"].as_str().unwrap().contains("dev is offline"), "{off}");

    let _ssh = tunnel_ssh(&lab, &key, port, sshd.port);
    while !status.listen_ports().is_some_and(|p| p.contains(&port)) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    step(&lab, &mut r, 3).await;
    wait_event(&got, "tunnel.online").await;
    assert_eq!(got.lock().unwrap().iter().filter(|v| v["event"] == "tunnel.offline").count(), 1, "offline is sent once");
}
