//! 裝置連線池（`ssh::pool`）：同一台、同一個 OS 帳號的 SFTP REST / 檔案管理共用一條 SSH 連線。
//! 用 common::lab 的裝置 sshd 登入紀錄數「握手了幾次」。
//! Device connection pool: one SSH handshake per (tunnel, OS account), counted on the device's login log.
mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::lab::{Device, Lab, LabUser, MachineOpts};

async fn list(lab: &Lab, user: &LabUser, dev: &Device, os_user: &str) -> StatusCode {
    let r = lab.app.get(&format!("/api/sftp/list/{}/{os_user}", dev.tunnel_id), Some(&user.token)).await;
    assert!(r.status != StatusCode::OK || r.text.contains("marker.txt"), "{}", r.text);
    r.status
}

#[tokio::test]
async fn sftp_requests_share_one_connection_per_account() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("deploy", &[&lab.service])], false).await;
    std::fs::write(boxm.home.join("marker.txt"), b"hi").unwrap();
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    lab.username(&alice, &dev, "deploy").await;
    let pool = &lab.app.state.pool;
    let port = dev.reverse_port as i64;

    // 一個接一個：只握手一次
    for _ in 0..5 {
        assert_eq!(list(&lab, &alice, &dev, "ubuntu").await, StatusCode::OK);
    }
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 1);
    assert_eq!(pool.connections(port, "ubuntu"), 1);

    // 同時 12 個：每條連線最多 8 條 channel，最多兩條連線
    let all = futures::future::join_all((0..12).map(|_| list(&lab, &alice, &dev, "ubuntu"))).await;
    assert!(all.iter().all(|s| *s == StatusCode::OK), "{all:?}");
    assert!((1..=2).contains(&boxm.login_count("ubuntu", &lab.service)), "{:?}", boxm.logins());

    // 另一個 OS 帳號是另一條連線
    assert_eq!(list(&lab, &alice, &dev, "deploy").await, StatusCode::OK);
    assert_eq!(boxm.login_count("deploy", &lab.service), 1);

    // 下載也走同一條
    let before = boxm.logins().len();
    let r = lab.app.get(&format!("/api/sftp/download/{}/ubuntu?path=marker.txt", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.text, "hi");
    assert_eq!(boxm.logins().len(), before);
}

/// 裝置的 MaxSessions 比池子預設的 8 小：開不了 channel 時改開第二條連線，之後那條不再超量借出。
#[tokio::test]
async fn a_device_session_limit_opens_another_connection() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let tight = lab.machine_with("tight", &[("ubuntu", &[&lab.service])], MachineOpts { max_sessions: Some(2), ..Default::default() }).await;
    std::fs::write(tight.home.join("marker.txt"), b"hi").unwrap();
    let dev = lab.device(&alice, "tight", &tight).await;

    let a = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    let b = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    let c = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    assert_eq!(tight.login_count("ubuntu", &lab.service), 2, "the third channel needed a second connection");
    assert_eq!(lab.app.state.pool.connections(dev.reverse_port as i64, "ubuntu"), 2);
    for s in [&a, &b, &c] {
        assert_eq!(s.read("marker.txt").await.unwrap(), b"hi");
    }
    // 第一條已學到上限 2：再借第四個走第二條（它還有空位），不再撞牆
    let d = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    assert_eq!(d.read("marker.txt").await.unwrap(), b"hi");
    assert_eq!(tight.login_count("ubuntu", &lab.service), 2);
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
