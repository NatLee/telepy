//! 裝置連線池（`ssh::pool`）：同一台、同一個 OS 帳號共用一條 SSH 連線；額度只算 session channel；
//! SFTP 共用一條 channel。用 common::lab 的裝置 sshd 數「握手了幾次」「開過幾條 sftp」「現在開著幾個 session」。
//! Device connection pool: one SSH handshake per (tunnel, OS account), only session channels count, one shared
//! SFTP channel — counted on the device's login log, sftp starts and open sessions.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::lab::{Device, Lab, LabUser, MachineOpts};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use telepy_server::ssh::pool::MAX_SESSIONS;
use tokio_tungstenite::{connect_async, tungstenite::Message};

async fn list(lab: &Lab, user: &LabUser, dev: &Device, os_user: &str) -> StatusCode {
    let r = lab.app.get(&format!("/api/sftp/list/{}/{os_user}", dev.tunnel_id), Some(&user.token)).await;
    assert!(r.status != StatusCode::OK || r.text.contains("marker.txt"), "{}", r.text);
    r.status
}

/// 等到條件成立（裝置那端關 channel 是非同步的）。/ Wait for a condition (the device closes channels asynchronously).
async fn eventually(what: &str, done: impl Fn() -> bool) {
    for _ in 0..100 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn sftp_requests_share_one_connection_and_one_channel_per_account() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("deploy", &[&lab.service])], false).await;
    std::fs::write(boxm.home.join("marker.txt"), b"hi").unwrap();
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    lab.username(&alice, &dev, "deploy").await;
    let pool = &lab.app.state.pool;
    let port = dev.reverse_port as i64;

    // 一個接一個：只握手一次，也只開一條 sftp
    for _ in 0..5 {
        assert_eq!(list(&lab, &alice, &dev, "ubuntu").await, StatusCode::OK);
    }
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 1);
    assert_eq!(pool.connections(port, "ubuntu"), 1);
    assert_eq!(boxm.sftp_starts(), 1);

    // 同時 12 個：還是同一條連線、同一條 sftp channel（以前每個請求一條 channel，超過 8 個就多一條連線）
    let all = futures::future::join_all((0..12).map(|_| list(&lab, &alice, &dev, "ubuntu"))).await;
    assert!(all.iter().all(|s| *s == StatusCode::OK), "{all:?}");
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 1, "{:?}", boxm.logins());
    assert_eq!(boxm.sftp_starts(), 1);
    assert_eq!(pool.sessions(port, "ubuntu"), 1, "the shared channel is one session");

    // 另一個 OS 帳號是另一條連線；第一次就同時來 6 個，也只開一條 sftp
    let all = futures::future::join_all((0..6).map(|_| list(&lab, &alice, &dev, "deploy"))).await;
    assert!(all.iter().all(|s| *s == StatusCode::OK), "{all:?}");
    assert_eq!(boxm.login_count("deploy", &lab.service), 1);
    assert_eq!(boxm.sftp_starts(), 2);

    // 下載也走同一條
    let (logins, starts) = (boxm.logins().len(), boxm.sftp_starts());
    let r = lab.app.get(&format!("/api/sftp/download/{}/ubuntu?path=marker.txt", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.text, "hi");
    assert_eq!((boxm.logins().len(), boxm.sftp_starts()), (logins, starts));
}

/// 裝置的 MaxSessions 比池子預設的小：開不了 channel 時改開第二條連線，之後那條不再超量借出。
#[tokio::test]
async fn a_device_session_limit_opens_another_connection() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let tight = lab.machine_with("tight", &[("ubuntu", &[&lab.service])], MachineOpts { max_sessions: Some(2), ..Default::default() }).await;
    let dev = lab.device(&alice, "tight", &tight).await;
    let (state, port) = (&lab.app.state, dev.reverse_port as i64);

    let a = state.pool.session_channel(state, port, "ubuntu").await.unwrap();
    let b = state.pool.session_channel(state, port, "ubuntu").await.unwrap();
    let c = state.pool.session_channel(state, port, "ubuntu").await.unwrap();
    assert_eq!(tight.login_count("ubuntu", &lab.service), 2, "the third channel needed a second connection");
    assert_eq!(state.pool.connections(port, "ubuntu"), 2);
    // 第一條已學到上限 2：第四個走第二條（它還有空位），不再撞牆
    let d = state.pool.session_channel(state, port, "ubuntu").await.unwrap();
    assert_eq!(tight.login_count("ubuntu", &lab.service), 2);
    assert_eq!(tight.open_sessions(), 4);
    let r = telepy_server::ssh::exec::run_on(d.1, "whoami", Duration::from_secs(5), 1024).await.unwrap();
    assert_eq!(r.stdout.text.trim(), "ubuntu");
    drop((a, b, c));
}

/// 只開 direct-tcpip 的用途（遠端瀏覽器、遠端桌面、區網跳板）不占 session 額度：8 個分頁照樣塞得進同一條連線。
/// Transport leases (direct-tcpip users) take no session slot.
#[tokio::test]
async fn direct_tcpip_leases_take_no_session_slot() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let (state, port) = (&lab.app.state, dev.reverse_port as i64);

    let mut transports = Vec::new();
    for _ in 0..10 {
        transports.push(state.pool.acquire(state, port, "ubuntu").await.unwrap());
    }
    let mut sessions = Vec::new();
    for _ in 0..MAX_SESSIONS {
        sessions.push(state.pool.session_channel(state, port, "ubuntu").await.unwrap());
    }
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 1, "{:?}", boxm.logins());
    assert_eq!(state.pool.connections(port, "ubuntu"), 1);
    assert_eq!(state.pool.sessions(port, "ubuntu"), MAX_SESSIONS);
    assert_eq!(boxm.open_sessions(), MAX_SESSIONS);

    // 第九條 session 才需要第二條連線；傳輸 lease 照用現成的
    sessions.push(state.pool.session_channel(state, port, "ubuntu").await.unwrap());
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 2);
    transports.push(state.pool.acquire(state, port, "ubuntu").await.unwrap());
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 2);
}

/// 共用的 sftp channel 關掉了：下一個借的人拿到新的一條；沒人用了就關掉（連線還有人用時也一樣）。
/// A closed shared SFTP channel is replaced on the next borrow; an unused one is closed by the reaper.
#[tokio::test]
async fn a_broken_shared_sftp_channel_is_replaced_and_an_idle_one_closed() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    std::fs::write(boxm.home.join("marker.txt"), b"hi").unwrap();
    let dev = lab.device(&alice, "box", &boxm).await;
    let (state, port) = (&lab.app.state, dev.reverse_port as i64);

    let first = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    let second = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    assert_eq!(boxm.sftp_starts(), 1);
    assert_eq!(second.read("marker.txt").await.unwrap(), b"hi");

    first.close().await.unwrap();
    eventually("the closed channel to look broken", || !second.healthy()).await;
    let third = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    assert!(third.healthy());
    assert_eq!(third.read("marker.txt").await.unwrap(), b"hi");
    assert_eq!(boxm.sftp_starts(), 2);
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 1, "the connection itself was fine");
    assert_eq!(state.pool.sessions(port, "ubuntu"), 1);
    drop((first, second));

    // 連線還有人用（一個傳輸 lease），共用 sftp 卻沒人用了：reaper 只關 sftp，不關連線
    let hold = state.pool.acquire(state, port, "ubuntu").await.unwrap();
    drop(third);
    assert_eq!(state.pool.reap(Duration::ZERO), 0);
    assert_eq!(state.pool.sessions(port, "ubuntu"), 0);
    eventually("the device to close every session", || boxm.open_sessions() == 0).await;
    drop(hold);
}

/// 檔案管理拿著的共用 sftp channel 壞了：下一次列目錄自己換一條，不用重開分頁。
/// The file manager renews a broken shared channel on its next listing.
#[tokio::test]
async fn the_file_manager_renews_a_broken_shared_channel() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    std::fs::write(boxm.home.join("marker.txt"), b"hi").unwrap();
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;

    let (mut fm, _) = connect_async(format!("{}/ws/filemanager/", lab.ws_base().await)).await.unwrap();
    let auth = json!({"type": "auth", "token": alice.token, "server_id": dev.tunnel_id.to_string(), "username": "ubuntu"});
    fm.send(Message::Text(auth.to_string().into())).await.unwrap();
    let mut listing = async || -> Value {
        fm.send(Message::Text(json!({"action": "list_files", "payload": {}}).to_string().into())).await.unwrap();
        loop {
            match tokio::time::timeout(Duration::from_secs(15), fm.next()).await.expect("no file manager frame") {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v.get("type").is_none() {
                        return v;
                    }
                }
                Some(Ok(_)) => {}
                other => panic!("file manager socket ended: {other:?}"),
            }
        }
    };
    let r = listing().await;
    assert_eq!(r["data"]["status"], "success", "{r}");

    let shared = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    shared.close().await.unwrap();
    eventually("the closed channel to look broken", || !shared.healthy()).await;
    let r = listing().await;
    assert_eq!(r["data"]["status"], "success", "{r}");
    assert!(r.to_string().contains("marker.txt"), "{r}");
    assert_eq!(boxm.sftp_starts(), 2);
}

/// 裝置沒有 sftp 子系統：那條 session channel 要關掉，不能留在裝置上占 MaxSessions。
/// A failed sftp start closes its session channel instead of leaving it open on the device.
#[tokio::test]
async fn a_failed_sftp_start_leaves_no_session_on_the_device() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let m = lab.machine_with("nosftp", &[("ubuntu", &[&lab.service])], MachineOpts { shell_without_sftp: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "nosftp", &m).await;
    let (state, port) = (&lab.app.state, dev.reverse_port as i64);

    for _ in 0..3 {
        assert!(lab.backend_sftp(&dev, "ubuntu").await.is_err());
    }
    assert_eq!(state.pool.sessions(port, "ubuntu"), 0);
    eventually("the device to close the refused channels", || m.open_sessions() == 0).await;
}

/// 裝置斷線重連後池子自動換新連線；閒置的連線會被收掉。
#[tokio::test]
async fn reconnects_after_the_device_drops_and_reaps_idle_connections() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    std::fs::write(boxm.home.join("marker.txt"), b"hi").unwrap();
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let pool = &lab.app.state.pool;
    let port = dev.reverse_port as i64;

    assert_eq!(list(&lab, &alice, &dev, "ubuntu").await, StatusCode::OK);
    lab.reconnect_device(&dev).await;
    assert_eq!(list(&lab, &alice, &dev, "ubuntu").await, StatusCode::OK, "the pool replaces the dead connection");
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 2);

    // 閒置回收（測試用 0 秒門檻）
    assert!(pool.reap(Duration::ZERO) >= 1);
    assert_eq!(pool.connections(port, "ubuntu"), 0);
    assert_eq!(list(&lab, &alice, &dev, "ubuntu").await, StatusCode::OK);
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 3);

    // 正在用的連線不會被收
    let held = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    assert_eq!(pool.reap(Duration::ZERO), 0);
    assert_eq!(held.read("marker.txt").await.unwrap(), b"hi");
}
