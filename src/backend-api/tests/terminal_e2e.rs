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
    assert!(t.ping().await, "ping is answered with a binary pong");

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

/// 同一台、同一帳號的分頁共用一條 SSH 連線，檔案管理也一樣。
#[tokio::test]
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

/// 離線裝置：直接 4005（不是等 30 秒、也不是沒有關閉碼；OpenSSH 版只會讓 PTY EOF）。
#[tokio::test]
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

    // 檔案管理也是 4005，不再接受一條沒用、卻算「檔案使用中」的 exec 後備連線。
    // The file manager is refused too, instead of a useless exec-fallback connection that counted as in use.
    let code = lab.filemanager(&alice, &dev, "ubuntu", json!({"action": "shell_detect"})).await.err();
    assert_eq!(code, Some(4005));
    assert!(lab.app.state.presence.for_tunnel(dev.tunnel_id).is_empty());

    // 裝置回來就又能用。/ Works again once the device is back.
    lab.reconnect_device(&dev).await;
    let r = lab.filemanager(&alice, &dev, "ubuntu", json!({"action": "shell_detect"})).await.expect("file manager after reconnect");
    assert_eq!(r["data"]["status"], "success", "{r}");
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

/// 檔案管理：有 SFTP 時走 SFTP；裝置沒有 sftp 子系統時退回 `ls -la`（池子連線上的 exec channel），兩種都與終端機
/// 共用同一條連線。/ File manager: SFTP, or the exec fallback when the device has no sftp subsystem.
#[tokio::test]
async fn file_manager_sftp_and_exec_fallback_share_the_connection() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let plain = lab.machine_with("plain", &[("ubuntu", &[&lab.service])], MachineOpts { shell_without_sftp: true, ..Default::default() }).await;
    std::fs::write(plain.home.join("marker.txt"), b"hi").unwrap();
    let dev = lab.device(&alice, "plain", &plain).await;
    lab.username(&alice, &dev, "ubuntu").await;

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@plain").await;
    let r = lab.filemanager(&alice, &dev, "ubuntu", json!({"action": "list_files", "payload": {}})).await.expect("file manager");
    assert_eq!(r["action"], "list_files", "{r}");
    let names: Vec<&str> = r["data"]["files"].as_array().unwrap().iter().filter_map(|f| f["name"].as_str()).collect();
    assert!(names.contains(&"marker.txt"), "{r}");
    let r = lab.filemanager(&alice, &dev, "ubuntu", json!({"action": "shell_detect"})).await.unwrap();
    assert_eq!(r["data"]["shell"], "unix", "{r}");
    assert_eq!(plain.login_count("ubuntu", &lab.service), 1, "terminal + exec fallback on one connection: {:?}", plain.logins());
}

// ---------------------------------------------------------------- 斷線保留 / detach & resume

async fn set_detach(lab: &Lab, user: &common::lab::LabUser, secs: i64) {
    let r = lab.app.post("/api/user/settings", Some(&user.token), json!({"terminal_detach_secs": secs})).await;
    assert_eq!(r.status, axum::http::StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["terminal_detach_secs"], secs);
}

/// 等這條隧道的「使用中」變成符合條件。/ Wait until the tunnel's presence matches.
async fn wait_presence(lab: &Lab, tunnel_id: i64, what: &str, ok: impl Fn(&[telepy_server::presence::Entry]) -> bool) {
    for _ in 0..100 {
        if ok(&lab.app.state.presence.for_tunnel(tunnel_id)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("presence never became {what}: {:?}", lab.app.state.presence.for_tunnel(tunnel_id));
}

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<serde_json::Value> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().cloned().unwrap_or_default()
}

/// 斷線後 shell 照跑、輸出進緩衝；同一個人帶 `resume` 接回：補送沒看到的輸出、同一個 shell 繼續（同一個 PTY、
/// 換視窗前打了一半的字還在）；在別的視窗接回會把舊的那個以 4016 關掉；重新整理（不帶 offset）= 清畫面重畫；
/// 明確結束（`end`）之後就接不回來了（4015）。
/// A dropped browser leaves the shell running and buffering; the same user resumes it: the missed output arrives and
/// the same shell continues (one PTY, a half-typed line survives the switch); resuming elsewhere closes the old socket
/// with 4016; a reload (no offset) redraws everything; after an explicit end there is nothing to resume (4015).
#[tokio::test]
async fn a_dropped_terminal_is_kept_and_resumed() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine_with("box", &[("ubuntu", &[&lab.service])], MachineOpts { echo_shell: true, ..Default::default() }).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    set_detach(&lab, &alice, 300).await;

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    assert_eq!(t.detach(), (300, "user".to_string()), "{:?}", t.shell);
    let id = t.shell_id();
    // 跑一個要一下子才回的指令，馬上斷線。/ Run a command that answers late, and the network drops at once.
    t.input("later\r").await;
    let seen = t.offset;
    t.drop_connection();

    // 還在：「使用中」標成斷線保留中，即時 session 頁看得到。/ Still there: presence marks it detached.
    wait_presence(&lab, dev.tunnel_id, "detached", |p| p.len() == 1 && p[0].detached.is_some()).await;
    let r = lab.app.get("/api/sessions", Some(&alice.token)).await;
    assert!(r.json["sessions"][0]["detached"]["ends_at"].is_string(), "{}", r.text);
    tokio::time::sleep(Duration::from_millis(1200)).await; // `later` 在斷線期間回來 / answers while detached

    let mut t2 = lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id, "offset": seen})).await.expect("resume");
    let frame = t2.shell.clone().expect("shell frame");
    assert_eq!((frame["id"].as_str(), frame["resumed"].as_bool(), frame["reset"].as_bool()), (Some(id.as_str()), Some(true), Some(false)), "{frame}");
    t2.expect("ran:later").await;
    assert!(!t2.seen.contains("login:"), "only what was missed is replayed: {:?}", t2.seen);
    wait_presence(&lab, dev.tunnel_id, "attached again", |p| p.len() == 1 && p[0].detached.is_none()).await;
    t2.input("ab").await;
    t2.expect("ab").await;

    // 另一個視窗接回：舊的以 4016 關掉，新的繼續同一行。/ Resumed in another window: the old one gets 4016.
    let mut t3 = lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.expect("resume elsewhere");
    assert_eq!(t2.wait_closed().await, Some(4016));
    assert_eq!(t3.shell.as_ref().unwrap()["reset"], true, "no offset = a reload: clear and redraw");
    t3.expect("login:ubuntu@box").await;
    t3.input("c\r").await;
    t3.expect("ran:abc").await;
    assert_eq!(boxm.commands(), vec!["later".to_string(), "abc".to_string()], "the same shell all along");
    assert_eq!(boxm.ptys().len(), 1, "never a second shell");

    // 關分頁 = 明確結束：shell 收掉，再也接不回來。/ Closing the tab ends it; nothing left to resume.
    t3.end().await;
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4015));
}

/// 保留時間 0（預設）：斷線就結束，跟以前一樣；接回 = 4015。/ Grace 0 (the default): a drop ends it, resume = 4015.
#[tokio::test]
async fn grace_zero_ends_the_shell_at_once() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    assert_eq!(t.detach(), (0, "user".to_string()));
    let id = t.shell_id();
    t.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4015));
}

/// 時間到：shell 收掉，結束事件寫「斷線保留 N 秒後結束」；站台上限比個人選擇小時用上限。
/// Time is up: the shell ends and the close event says so; the site ceiling caps a longer personal choice.
#[tokio::test]
async fn a_detached_shell_ends_when_time_is_up() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    set_detach(&lab, &alice, 60).await;
    let r = lab.app.post("/api/site/settings", Some(&lab.admin_token), json!({"terminal_detach_max_secs": 1})).await;
    assert_eq!(r.status, axum::http::StatusCode::OK, "{}", r.text);

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    assert_eq!(t.detach(), (1, "site".to_string()), "the site ceiling decides");
    let id = t.shell_id();
    t.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "detached", |p| p.len() == 1 && p[0].detached.is_some()).await;
    wait_presence(&lab, dev.tunnel_id, "empty after the grace", |p| p.is_empty()).await;
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4015));
    let mut close = None;
    for _ in 0..50 {
        close = events(&lab, &alice.token, dev.tunnel_id).await.into_iter().find(|e| e["event"] == "terminal_close");
        if close.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let close = close.expect("terminal_close event");
    assert!(close["message"].as_str().unwrap().contains("ended after 1 s detached"), "{close}");
}

/// 隧道設成 `never`：個人選了要留也一樣斷線就結束；放寬回 `user` 才又會留。設定只有 owner / ADMIN 能改。
/// A `never` tunnel ends the shell at once whatever the user picked; only owner / ADMIN change it.
#[tokio::test]
async fn a_never_tunnel_ends_shells_at_once() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "edit", &[ubuntu]).await;
    set_detach(&lab, &alice, 300).await;
    let path = format!("/api/reverse/server/{}/terminal-detach", dev.tunnel_id);
    assert_eq!(lab.app.put(&path, Some(&bob.token), json!({"policy": "never"})).await.status, axum::http::StatusCode::FORBIDDEN);
    assert_eq!(lab.app.put(&path, Some(&alice.token), json!({"policy": "sometimes"})).await.status, axum::http::StatusCode::BAD_REQUEST);
    let r = lab.app.put(&path, Some(&alice.token), json!({"policy": "never"})).await;
    assert_eq!(r.json["policy"], "never", "{}", r.text);
    let r = lab.app.get(&format!("/api/reverse/server/keys/{}", dev.tunnel_id), Some(&alice.token)).await;
    assert_eq!(r.json["terminal_detach_policy"], "never", "{}", r.text);

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    assert_eq!(t.detach(), (0, "tunnel".to_string()), "the device's policy wins");
    t.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;

    // 放寬回 user（沒有第二因素的帳號不用再驗證）：又會留。/ Back to `user`: kept again.
    assert_eq!(lab.app.put(&path, Some(&alice.token), json!({"policy": "user"})).await.json["policy"], "user");
    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    assert_eq!(t.detach(), (300, "user".to_string()));
}

/// 別人的 shell 接不了（4004），即使他也能用同一個帳號；從即時 session 頁結束斷線中的 shell 會真的收掉。
/// Nobody else resumes your shell (4004), even with access to the same account; ending a detached shell from the
/// live sessions page really ends it.
#[tokio::test]
async fn only_the_owner_resumes_and_a_detached_shell_can_be_ended() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    set_detach(&lab, &alice, 300).await;

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    let id = t.shell_id();
    t.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "detached", |p| p.len() == 1 && p[0].detached.is_some()).await;
    assert_eq!(lab.terminal_with(&bob, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4004));
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": "nope"})).await.err(), Some(4015));

    // 即時 session 頁結束它。/ End it from the live sessions page.
    let sid = lab.app.state.presence.for_tunnel(dev.tunnel_id)[0].id;
    assert_eq!(lab.app.delete(&format!("/api/sessions/{sid}"), Some(&alice.token)).await.status, axum::http::StatusCode::NO_CONTENT);
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4015));
}

/// 區網主機終端機也一樣：OpenSSH 子程序在斷線期間照跑，接回同一個。/ LAN-host terminals too: the OpenSSH child is kept.
#[tokio::test]
async fn a_lan_terminal_is_kept_too() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let nas = lab.machine_with("nas", &[("backup", &[&lab.service])], MachineOpts { echo_shell: true, ..Default::default() }).await;
    let edge = lab.machine("edge", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "edge", &edge).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let nas_id = lab.lan_host(&alice, &dev, "127.0.0.1", nas.port, Some("backup")).await;
    set_detach(&lab, &alice, 300).await;

    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id})).await.expect("LAN terminal");
    t.expect("login:backup@nas").await;
    let id = t.shell_id();
    t.input("x").await;
    t.expect("x").await;
    let seen = t.offset;
    t.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "detached", |p| p.len() == 1 && p[0].detached.is_some()).await;
    // 別的區網主機（或不帶）接不了。/ A different LAN host (or none) can't resume it.
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4004));
    let mut t = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id, "resume": id, "offset": seen})).await.expect("resume");
    t.input("y\r").await;
    t.expect("ran:xy").await;
    assert_eq!(nas.commands(), vec!["xy".to_string()]);
}

// ---------------------------------------------------------------- 失去存取 = 斷線保留中的 shell 也結束 / lost access ends kept shells

/// 等 `terminal_close` 事件裡出現這句（看得到 Logs 的人的 token）。/ Wait for a `terminal_close` event containing `needle`.
async fn close_event(lab: &Lab, token: &str, tunnel_id: i64, needle: &str) -> serde_json::Value {
    for _ in 0..50 {
        let found = events(lab, token, tunnel_id).await.into_iter().find(|e| e["event"] == "terminal_close" && e["message"].as_str().is_some_and(|m| m.contains(needle)));
        if let Some(e) = found {
            return e;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no terminal_close event with {needle:?}: {:?}", events(lab, token, tunnel_id).await);
}

async fn grant(lab: &Lab, subject: &str, id: Option<i64>, feature: &str, value: &str) {
    let r = lab.app.put("/api/access/grants", Some(&lab.admin_token), json!({"subject": subject, "id": id, "feature": feature, "value": value})).await;
    assert_eq!(r.status, axum::http::StatusCode::OK, "{}", r.text);
}

/// 等裝置那端的 session channel 數變成 `n`（shell 真的收掉了）。/ Wait until the device sees `n` session channels.
async fn wait_device_sessions(m: &common::lab::Machine, n: usize) {
    for _ in 0..100 {
        if m.open_sessions() == n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the device still has {} session channels, expected {n}", m.open_sessions());
}

/// 管理員把終端機關掉（個人的拒絕，或群組的拒絕）：斷線保留中的 shell 立刻結束——裝置上的 shell 收掉、
/// `terminal_close` 寫原因、之後（功能再打開）接回 = 4015；跟連著的 shell 一樣。
/// Turning the terminal off (a personal deny, or a group deny) ends a detached shell at once: the device's shell
/// closes, `terminal_close` says why, and a later resume (feature back on) gets 4015 — like an attached shell.
#[tokio::test]
async fn turning_the_terminal_off_ends_detached_shells() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    set_detach(&lab, &alice, 300).await;

    // 個人的拒絕。/ A personal deny.
    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    let id = t.shell_id();
    t.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "detached", |p| p.len() == 1 && p[0].detached.is_some()).await;
    assert!(boxm.open_sessions() >= 1, "the detached shell is still open on the device");
    grant(&lab, "user", Some(alice.id), "terminal", "deny").await;
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;
    wait_device_sessions(&boxm, 0).await;
    let close = close_event(&lab, &alice.token, dev.tunnel_id, "while detached").await;
    assert!(close["message"].as_str().unwrap().contains("Web terminal was turned off for this account"), "{close}");
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4012), "still off");
    grant(&lab, "user", Some(alice.id), "terminal", "inherit").await;
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4015), "the shell is gone");

    // 群組的拒絕：一樣。/ A group deny does the same.
    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    let id = t.shell_id();
    t.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "detached", |p| p.len() == 1 && p[0].detached.is_some()).await;
    let r = lab.app.post("/api/access/groups", Some(&lab.admin_token), json!({"name": "Night shift", "members": [alice.id]})).await;
    assert_eq!(r.status, axum::http::StatusCode::CREATED, "{}", r.text);
    let gid = r.json["created_id"].as_i64().unwrap();
    grant(&lab, "group", Some(gid), "terminal", "deny").await;
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;
    wait_device_sessions(&boxm, 0).await;
    grant(&lab, "group", Some(gid), "terminal", "inherit").await;
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4015));
}

/// 區網主機的終端機要「終端機」+「區網探索」：關掉 network 只結束區網那個 shell（斷線中的也算），裝置本身的留著。
/// A LAN-host terminal needs terminal + network: turning network off ends only the LAN shell (detached too).
#[tokio::test]
async fn turning_network_off_ends_detached_lan_shells_only() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let nas = lab.machine("nas", &[("backup", &[&lab.service])], false).await;
    let edge = lab.machine("edge", &[("ubuntu", &[&lab.service])], true).await;
    let dev = lab.device(&alice, "edge", &edge).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let nas_id = lab.lan_host(&alice, &dev, "127.0.0.1", nas.port, Some("backup")).await;
    set_detach(&lab, &alice, 300).await;

    let mut lan = lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id})).await.expect("LAN terminal");
    lan.expect("login:backup@nas").await;
    let lan_id = lan.shell_id();
    lan.drop_connection();
    let mut own = lab.terminal(&alice, &dev, "ubuntu").await.expect("device terminal");
    own.expect("login:ubuntu@edge").await;
    wait_presence(&lab, dev.tunnel_id, "one detached, one attached", |p| p.len() == 2 && p.iter().filter(|e| e.detached.is_some()).count() == 1).await;

    grant(&lab, "user", Some(alice.id), "network", "deny").await;
    wait_presence(&lab, dev.tunnel_id, "only the device shell", |p| p.len() == 1 && p[0].detached.is_none()).await;
    wait_device_sessions(&nas, 0).await;
    close_event(&lab, &alice.token, dev.tunnel_id, "LAN discovery was turned off").await;
    own.input("still-here\r").await;
    own.expect("still-here").await;
    grant(&lab, "user", Some(alice.id), "network", "inherit").await;
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"lan_host_id": nas_id, "resume": lan_id})).await.err(), Some(4015));
}

/// 隧道改成 `never`：這條隧道上已經在斷線保留的 shell 立刻結束；連著的照舊（斷線時才照政策）。
/// Switching a tunnel to `never` ends the shells already detached there; attached ones carry on.
#[tokio::test]
async fn a_never_policy_ends_shells_already_detached() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;
    set_detach(&lab, &alice, 300).await;

    let mut kept = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    kept.expect("login:ubuntu@box").await;
    let id = kept.shell_id();
    kept.drop_connection();
    let mut live = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    live.expect("login:ubuntu@box").await;
    wait_presence(&lab, dev.tunnel_id, "one detached", |p| p.len() == 2 && p.iter().any(|e| e.detached.is_some())).await;

    let r = lab.app.put(&format!("/api/reverse/server/{}/terminal-detach", dev.tunnel_id), Some(&alice.token), json!({"policy": "never"})).await;
    assert_eq!(r.json["policy"], "never", "{}", r.text);
    wait_presence(&lab, dev.tunnel_id, "only the attached one", |p| p.len() == 1 && p[0].detached.is_none()).await;
    wait_device_sessions(&boxm, 1).await;
    close_event(&lab, &alice.token, dev.tunnel_id, "this tunnel no longer keeps disconnected shells").await;
    assert_eq!(lab.terminal_with(&alice, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4015));
    live.input("ok-live\r").await;
    live.expect("ok-live").await;
}

/// 取消分享 / 允許的帳號被拿掉 / 帳號被停用：他的 shell（連著的 4009、斷線保留中的）都結束。
/// Unsharing, removing the allowed account, or disabling the account ends their shells: attached (4009) and detached.
#[tokio::test]
async fn losing_access_ends_attached_and_detached_shells() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let root = lab.username(&alice, &dev, "root").await;
    set_detach(&lab, &bob, 300).await;
    let path = format!("/tunnels/share/{}/{}/allowed-usernames", dev.tunnel_id, bob.id);

    // 1. 取消分享：連著的收到 4009（原因說存取變了），斷線保留中的也收掉。/ Unshare: 4009 for the attached, the detached ends.
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let mut kept = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    kept.expect("login:ubuntu@box").await;
    let id = kept.shell_id();
    kept.drop_connection();
    let mut live = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    live.expect("login:ubuntu@box").await;
    wait_presence(&lab, dev.tunnel_id, "two of bob's", |p| p.len() == 2).await;
    let r = lab.app.delete(&format!("/tunnels/unshare/{}/{}", dev.tunnel_id, bob.id), Some(&alice.token)).await;
    assert_eq!(r.status, axum::http::StatusCode::OK, "{}", r.text);
    let (code, reason) = live.wait_closed_reason().await.expect("closed");
    assert_eq!((code, reason.as_str()), (4009, telepy_server::terminal_detach::ENDED_BY));
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;
    wait_device_sessions(&boxm, 0).await;
    close_event(&lab, &alice.token, dev.tunnel_id, "while detached: access to the tunnel was removed").await;
    close_event(&lab, &alice.token, dev.tunnel_id, ": access to the tunnel was removed").await;
    assert_eq!(lab.terminal_with(&bob, &dev, "ubuntu", json!({"resume": id})).await.err(), Some(4004), "no access any more");

    // 2. 允許清單拿掉 ubuntu：ubuntu 的 shell 結束，root 的留著。/ ubuntu leaves the allow-list: only that shell ends.
    lab.share(&alice, &dev, &bob, "view", &[ubuntu, root]).await;
    let mut kept = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    kept.expect("login:ubuntu@box").await;
    kept.drop_connection();
    let mut as_root = lab.terminal(&bob, &dev, "root").await.expect("terminal");
    as_root.expect("login:root@box").await;
    wait_presence(&lab, dev.tunnel_id, "two of bob's", |p| p.len() == 2).await;
    let r = lab.app.patch(&path, Some(&alice.token), json!({"allowed_target_username_ids": [root]})).await;
    assert_eq!(r.status, axum::http::StatusCode::OK, "{}", r.text);
    wait_presence(&lab, dev.tunnel_id, "only root's", |p| p.len() == 1 && p[0].detached.is_none()).await;
    close_event(&lab, &alice.token, dev.tunnel_id, "the login account is no longer allowed").await;
    as_root.input("ok-root\r").await;
    as_root.expect("ok-root").await;

    // 3. 停用帳號：剩下的也結束（斷線保留中的一樣）。/ Disabling the account ends the rest, detached ones too.
    as_root.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "detached", |p| p.len() == 1 && p[0].detached.is_some()).await;
    let r = lab.app.post(&format!("/api/user/users/{}", bob.id), Some(&lab.admin_token), json!({"is_active": false})).await;
    assert_eq!(r.status, axum::http::StatusCode::OK, "{}", r.text);
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;
    wait_device_sessions(&boxm, 0).await;
    close_event(&lab, &alice.token, dev.tunnel_id, "the account was disabled").await;
}

/// 這個瀏覽器的登入被撤銷（4010 那條路）：socket 已經不在的斷線保留 shell 也跟著結束。
/// This browser's sign-in is revoked (the 4010 path): a detached shell, whose socket is gone, ends too.
#[tokio::test]
async fn signing_out_ends_a_detached_shell() {
    let Some(lab) = Lab::start().await else { return };
    let plain = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&plain, "box", &boxm).await;
    lab.username(&plain, &dev, "ubuntu").await;
    set_detach(&lab, &plain, 300).await;
    // 一個真的登入（token 帶 sid）。/ A real sign-in (the token carries its sid).
    let state = &lab.app.state;
    let pair = telepy_server::auth::sessions::issue(state, plain.id, &Default::default(), "password", None).await.unwrap();
    let alice = common::lab::LabUser { id: plain.id, username: plain.username.clone(), token: pair["access_token"].as_str().unwrap().to_string(), key: plain.key.clone() };

    let mut t = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    t.expect("login:ubuntu@box").await;
    t.drop_connection();
    wait_presence(&lab, dev.tunnel_id, "detached", |p| p.len() == 1 && p[0].detached.is_some()).await;
    assert_eq!(telepy_server::auth::sessions::revoke_all(state, plain.id, None, "user").await.unwrap(), 1);
    wait_presence(&lab, dev.tunnel_id, "empty", |p| p.is_empty()).await;
    wait_device_sessions(&boxm, 0).await;
    close_event(&lab, &plain.token, dev.tunnel_id, "signed out while detached").await;
}
