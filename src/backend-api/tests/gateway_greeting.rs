//! 直接 ssh 進 gateway（SSH lab）：個人金鑰拿到一段招呼（pty 時有 Tapi、exec 時純文字），exit 1、什麼都沒執行；
//! sftp subsystem 失敗；隧道金鑰仍然開不了 session；一條連線最多同時 2 個招呼 channel。
//! Ssh-ing straight into the gateway: a personal key gets a greeting (Tapi with a pty, plain text for exec), exit 1,
//! nothing run; the sftp subsystem fails; a tunnel key still gets no session; at most 2 greeting channels per connection.
mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::lab::{Lab, LabKey};
use serde_json::json;
use tokio::process::Command;

/// 直接連 gateway 的 OpenSSH（不讀開發者的 ~/.ssh）。/ OpenSSH straight at the gateway (never the developer's ~/.ssh).
async fn ssh_gateway(lab: &Lab, key: &LabKey, extra: &[&str]) -> (Option<i32>, String, String) {
    let mut cmd = Command::new("ssh");
    cmd.args(["-F", "/dev/null", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "-i"])
        .arg(&key.path)
        .args(["-p", &lab.gw_port.to_string()])
        .args(extra)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(30), cmd.output()).await.expect("ssh timed out").expect("spawn ssh");
    (out.status.code(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
}

async fn russh_client(lab: &Lab, key: &Path) -> russh::client::Handle<telepy_server::ssh::device::ClientHandler> {
    let cfg = Arc::new(russh::client::Config::default());
    let mut h = russh::client::connect(cfg, ("127.0.0.1", lab.gw_port), telepy_server::ssh::device::ClientHandler::unchecked()).await.unwrap();
    let k = Arc::new(russh::keys::load_secret_key(key, None).unwrap());
    assert!(h.authenticate_publickey("telepy", russh::keys::PrivateKeyWithHashAlg::new(k, None)).await.unwrap().success());
    h
}

#[tokio::test]
async fn a_personal_key_gets_a_greeting_and_nothing_runs() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let carol = lab.user("carol").await;
    let m1 = lab.machine("m1", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "tapi-box", &m1).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let target = "telepy@127.0.0.1".to_string();

    // 1) pty + shell：Tapi 與招呼，裝置名稱在裡面，exit 1。/ pty + shell: Tapi and the greeting with the device name, exit 1.
    let (code, out, err) = ssh_gateway(&lab, &alice.key, &["-tt", &target]).await;
    assert_eq!(code, Some(1), "stdout: {out}\nstderr: {err}");
    assert!(out.contains("Telepy") && out.contains("tapi-box") && out.contains("alice"), "{out}");
    assert!(out.contains('▀') && out.contains('\x1b'), "a pty gets Tapi in colour: {out:?}");

    // 2) exec：純文字招呼（沒有跳脫碼），exit 1，指令沒有執行。/ exec: plain greeting, exit 1, the command never ran.
    let marker = lab.dir.path().join("pwned");
    let (code, out, err) = ssh_gateway(&lab, &alice.key, &[&target, &format!("touch {}; uname -a", marker.display())]).await;
    assert_eq!(code, Some(1), "stdout: {out}\nstderr: {err}");
    assert!(out.contains("tapi-box") && out.contains("telepy ssh"), "{out}");
    assert!(!out.contains('\x1b') && !out.contains('▀'), "exec gets plain text: {out:?}");
    assert!(!marker.exists(), "nothing may run on the gateway");
    let r = lab.app.get("/api/log/ssh/events?scope=all&limit=500", Some(&lab.admin_token)).await;
    assert!(!r.text.contains("pwned") && !r.text.contains("uname"), "the exec command is not logged: {}", r.text);

    // 3) sftp subsystem：失敗。/ The sftp subsystem fails.
    let (code, out, err) = ssh_gateway(&lab, &alice.key, &["-s", &target, "sftp"]).await;
    assert_ne!(code, Some(0), "stdout: {out}\nstderr: {err}");
    assert!(!out.contains("Telepy"), "{out}");

    // 語言跟著使用者設定；只看狀態的 sharee（沒有允許帳號）沒有可連的裝置。
    // The user's language; a status-only sharee (no allowed account) has no device to reach.
    lab.share(&alice, &dev, &carol, "view", &[]).await;
    let r = lab.app.post("/api/user/settings", Some(&carol.token), json!({"language": "ja"})).await;
    assert!(r.status.is_success(), "{}", r.text);
    let (code, out, _) = ssh_gateway(&lab, &carol.key, &[&target, "true"]).await;
    assert_eq!(code, Some(1));
    assert!(out.contains("ゲートウェイ") && out.contains("接続できるデバイスはまだありません") && !out.contains("tapi-box"), "{out}");

    // 4) 隧道金鑰：session 照舊被拒。/ A tunnel key's session is still refused.
    let h = russh_client(&lab, &dev.key.path).await;
    assert!(h.channel_open_session().await.is_err(), "a tunnel key gets no session");

    // 5) 一條連線最多同時 2 個招呼 channel；關掉一個才能再開。/ At most 2 greeting channels at once per connection.
    let h = russh_client(&lab, &alice.key.path).await;
    let first = h.channel_open_session().await.expect("first greeting channel");
    let _second = h.channel_open_session().await.expect("second greeting channel");
    assert!(h.channel_open_session().await.is_err(), "a third greeting channel is refused");
    // exec 一個：收到招呼與 exit 1，channel 關掉後又能開新的。/ Run one: greeting + exit 1; then a new one opens.
    let mut first = first;
    first.exec(true, "id").await.unwrap();
    let (mut got, mut status) = (Vec::new(), None);
    let mut closed = false;
    while let Ok(Some(msg)) = tokio::time::timeout(Duration::from_secs(10), first.wait()).await {
        match msg {
            russh::ChannelMsg::Data { data } => got.extend_from_slice(&data),
            russh::ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            russh::ChannelMsg::Close => {
                closed = true;
                break;
            }
            _ => {}
        }
    }
    assert!(closed, "the gateway closes the greeting channel");
    assert_eq!(status, Some(1));
    assert!(String::from_utf8_lossy(&got).contains("tapi-box"));
    let _ = first.close().await;
    let mut reopened = false;
    for _ in 0..20 {
        if h.channel_open_session().await.is_ok() {
            reopened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(reopened, "a closed greeting channel frees its slot");
}
