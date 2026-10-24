//! 網頁主控台 session 的開始 / 結束事件（含持續時間）：終端機與檔案管理，在 SSH lab 上。
//! Open / close events with durations for the web terminal and the file manager, on the SSH lab.
mod common;

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use common::lab::{sftp_server_bin, Lab};

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<Value> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().cloned().unwrap_or_default()
}

async fn wait_event(lab: &Lab, token: &str, tunnel_id: i64, kind: &str) -> Value {
    for _ in 0..100 {
        if let Some(e) = events(lab, token, tunnel_id).await.into_iter().find(|e| e["event"] == kind) {
            return e;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no {kind} event: {:?}", events(lab, token, tunnel_id).await);
}

#[tokio::test]
async fn terminal_and_file_manager_sessions_are_logged_with_their_duration() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "office-pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.input("whoami\n").await;
    t.expect("ubuntu").await;
    let open = wait_event(&lab, &alice.token, id, "terminal_open").await;
    let msg = open["message"].as_str().unwrap();
    assert!(msg.starts_with("Web terminal by alice as ubuntu@office-pc (session "), "{msg}");
    drop(t);
    let close = wait_event(&lab, &alice.token, id, "terminal_close").await;
    let msg = close["message"].as_str().unwrap();
    assert!(msg.starts_with("Web terminal by alice as ubuntu@office-pc closed after "), "{msg}");
    let sid = |m: &str| m.rsplit("session ").next().unwrap().trim_end_matches(')').to_string();
    assert_eq!(sid(open["message"].as_str().unwrap()), sid(msg), "open and close share the session id");

    // 檔案管理（需要本機的 sftp-server）。/ File manager (needs a local sftp-server).
    if sftp_server_bin().is_none() {
        eprintln!("skipping the file manager part: no sftp-server");
        return;
    }
    let (mut ws, _) = connect_async(format!("{}/ws/filemanager/", lab.ws_base().await)).await.unwrap();
    ws.send(Message::Text(json!({"type": "auth", "token": alice.token, "server_id": id.to_string(), "username": "ubuntu"}).to_string().into())).await.unwrap();
    ws.send(Message::Text(json!({"action": "list_files", "payload": {}}).to_string().into())).await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(15), ws.next()).await.expect("file manager reply");
    assert!(matches!(reply, Some(Ok(Message::Text(_)))), "{reply:?}");
    let open = wait_event(&lab, &alice.token, id, "files_open").await;
    assert!(open["message"].as_str().unwrap().starts_with("File manager by alice as ubuntu@office-pc"), "{open}");
    ws.close(None).await.unwrap();
    let close = wait_event(&lab, &alice.token, id, "files_close").await;
    assert!(close["message"].as_str().unwrap().contains(" closed after "), "{close}");
}
