//! 網頁終端機端到端（common::lab）：PTY、視窗大小、多分頁、關分頁不影響別的分頁、裝置斷線、區網主機。
//! 這些是把終端機從 OpenSSH 子程序搬到 russh（連線池）之前先寫好的驗收測試：搬之前就要全綠，搬之後也要。
//! Web terminal end to end: PTY, resize, tabs, close isolation, device drop, LAN hop. The gate for the russh port.
mod common;

use std::time::Duration;

use common::lab::{Lab, MachineOpts};
use serde_json::json;

/// PTY 有要到、尺寸送到裝置、輸入會回來、resize 會以 window-change 到裝置。
#[tokio::test]
async fn pty_echo_and_resize_reach_the_device() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    let ptys = boxm.ptys();
    assert_eq!(ptys.len(), 1, "exactly one pty-req for one tab: {ptys:?}");
    assert_eq!(ptys[0].term, "xterm");

    t.input("hello-from-the-browser\r").await;
    t.expect("hello-from-the-browser").await;
    // 多位元組字元不能被切半。/ Multibyte characters survive the hop.
    t.input("中文字 → ok\r").await;
    t.expect("中文字 → ok").await;

    t.resize(132, 43).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !boxm.resizes().contains(&(132, 43)) {
        assert!(tokio::time::Instant::now() < deadline, "device never saw the resize: {:?}", boxm.resizes());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    t.input("tty\r").await;
    t.expect("tty:xterm 132x43").await;

    // shell 結束 → 伺服器正常關閉（1000 或不帶碼；前端兩種都當正常）。/ The shell exiting closes the socket normally.
    t.input("exit\r").await;
    assert!(matches!(t.wait_closed().await, None | Some(1000)));
}

/// 同一個人開五個分頁：每個分頁各自一個 PTY、各自回自己的輸入；關掉其中一個，其餘照常。
/// 這就是 Django 時代 killpg 會把所有分頁踢掉的那個情境。
#[tokio::test]
async fn five_tabs_are_independent_and_closing_one_keeps_the_rest() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;

    let mut tabs = Vec::new();
    for _ in 0..5 {
        let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
        t.expect("login:ubuntu@box").await;
        tabs.push(t);
    }
    assert_eq!(boxm.ptys().len(), 5);
    for (i, t) in tabs.iter_mut().enumerate() {
        t.input(&format!("tab-{i}\r")).await;
        t.expect(&format!("tab-{i}")).await;
    }
    // 每個分頁只看到自己的回聲。/ No cross-talk between tabs.
    for (i, t) in tabs.iter().enumerate() {
        for j in 0..5 {
            assert_eq!(t.seen.contains(&format!("tab-{j}\r")), i == j, "tab {i} saw tab {j}'s echo: {:?}", t.seen);
        }
    }

    // 關第三個分頁（像瀏覽器那樣直接關 socket），其餘四個還能用。
    let closed = tabs.remove(2);
    closed.close().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    for (i, t) in tabs.iter_mut().enumerate() {
        t.input(&format!("still-alive-{i}\r")).await;
        t.expect(&format!("still-alive-{i}")).await;
    }
}

/// 同一台、同一帳號的分頁共用一條 SSH 連線（搬到連線池後才成立）。
#[tokio::test]
#[ignore = "passes once the web terminal runs on the shared device connection (ssh::pool)"]
async fn tabs_share_one_connection() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let mut tabs = Vec::new();
    for _ in 0..3 {
        let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
        t.expect("login:ubuntu@box").await;
        tabs.push(t);
    }
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 1, "three tabs, one SSH login: {:?}", boxm.logins());
    // 檔案管理（SFTP）也走同一條。/ SFTP shares it too.
    let _sftp = lab.backend_sftp(&dev, "ubuntu").await.unwrap();
    assert_eq!(boxm.login_count("ubuntu", &lab.service), 1);
}

/// 裝置的 MaxSessions 很小：第三個分頁也開得起來（池子換一條連線），不是 4005。
#[tokio::test]
async fn tabs_beyond_the_device_session_limit_still_open() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let tight = lab.machine_with("tight", &[("ubuntu", &[&lab.service])], MachineOpts { max_sessions: Some(2), ..Default::default() }).await;
    let dev = lab.device(&alice, "tight", &tight).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let mut tabs = Vec::new();
    for i in 0..3 {
        let mut t = lab.terminal(&alice, &dev, "ubuntu").await.unwrap_or_else(|code| panic!("tab {i} refused with {code}"));
        t.expect("login:ubuntu@tight").await;
        tabs.push(t);
    }
    for (i, t) in tabs.iter_mut().enumerate() {
        t.input(&format!("t{i}\r")).await;
        t.expect(&format!("t{i}")).await;
    }
}

/// 裝置斷線：開著的分頁被伺服器關掉（不是永遠掛著）；裝置回來後能再開。
#[tokio::test]
async fn device_drop_closes_tabs_and_reconnect_works() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    lab.reconnect_device(&dev).await; // kills the device's ssh -NR, then brings it back
    t.wait_closed().await; // panics if the server leaves the dead tab open

    let mut t2 = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal after reconnect");
    t2.expect("login:ubuntu@box").await;
    t2.input("back\r").await;
    t2.expect("back").await;
}

/// 離線裝置：直接 4005（不是等 30 秒、也不是沒有關閉碼）。OpenSSH 版做不到：ssh 連不上只會讓 PTY EOF。
#[tokio::test]
#[ignore = "passes once the web terminal runs on the shared device connection (ssh::pool): 4005 on an offline device"]
async fn offline_device_is_refused_quickly() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    lab.disconnect_device(&dev).await;
    let started = std::time::Instant::now();
    let code = lab.terminal(&alice, &dev, "ubuntu").await.err();
    assert_eq!(code, Some(4005));
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
}

/// 經裝置跳到區網主機的終端機（#20）：第一跳服務金鑰，第二跳是那台機器自己的帳號；兩台都看到登入。
#[tokio::test]
async fn lan_host_terminal_through_the_device() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let nas = lab.machine("nas", &[("backup", &[&lab.service])], false).await;
    let edge = lab.machine("edge", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "edge", &edge).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let nas_id = lab.lan_host(&alice, &dev, "127.0.0.1", nas.port, Some("backup")).await;

    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id})).await.expect("LAN terminal");
    t.expect("login:backup@nas").await;
    t.input("over-two-hops\r").await;
    t.expect("over-two-hops").await;
    assert!(edge.logged_in("ubuntu", &lab.service), "the device hop logged in with the service key");
    assert!(nas.logged_in("backup", &lab.service));
}
