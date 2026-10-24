//! 誰在用隧道（presence）：網頁終端機與筆電經 gateway 的 ssh 都算；人數給所有看得到隧道的人，
//! 誰 / 哪種連線 / IP 只給 owner、ADMIN 與管理員；有變動時推 `UPDATE-TUNNEL-PRESENCE`。
//! Presence end to end: web terminal and laptop ssh count; everyone sees the count, only owner / ADMIN /
//! superuser see who and from where; changes are pushed as UPDATE-TUNNEL-PRESENCE.
mod common;

use std::time::Duration;

use futures::SinkExt;
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use common::lab::{Hop, Lab, LabUser};

async fn presence(lab: &Lab, user: &LabUser, tunnel_id: i64) -> Value {
    let r = lab.app.get("/api/reverse/server/dashboard", Some(&user.token)).await;
    assert!(r.status.is_success(), "dashboard: {}", r.text);
    let t = r.json["tunnels"].as_array().unwrap().iter().find(|t| t["id"] == tunnel_id).cloned();
    t.unwrap_or_else(|| panic!("tunnel {tunnel_id} not listed for {}: {}", user.username, r.text))["presence"].clone()
}

async fn wait_presence(lab: &Lab, user: &LabUser, tunnel_id: i64, what: &str, cond: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let p = presence(lab, user, tunnel_id).await;
        if cond(&p) {
            return p;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}; last: {p}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn presence_counts_sessions_and_hides_details_from_sharees() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await; // owner
    let bob = lab.user("bob").await; // VIEW + ubuntu
    let carol = lab.user("carol").await; // VIEW, status only
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service, &alice.key])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    lab.share(&alice, &dev, &carol, "view", &[]).await;

    let idle = presence(&lab, &alice, dev.tunnel_id).await;
    assert_eq!(idle["count"], 0, "{idle}");
    assert_eq!(idle["sessions"], serde_json::json!([]));
    let _ = lab.app.state.presence.take_dirty();
    let mut alice_rx = lab.app.state.hub.subscribe_user(alice.id);
    let mut carol_rx = lab.app.state.hub.subscribe_user(carol.id);

    // bob 開網頁終端機。/ Bob opens a web terminal.
    let mut term = lab.terminal(&bob, &dev, "ubuntu").await.expect("terminal");
    term.input("echo ready\n").await;
    term.expect("ready").await;
    let p = wait_presence(&lab, &alice, dev.tunnel_id, "bob's terminal", |p| p["count"] == 1).await;
    let s = &p["sessions"][0];
    assert_eq!(s["user"], "bob", "{p}");
    assert_eq!(s["kind"], "terminal");
    assert_eq!(s["ip"], "127.0.0.1");
    assert!(s["since"].as_str().unwrap().ends_with('Z'));
    // 其他 sharee 只看到人數（連 bob 自己是 VIEW 也一樣）。/ Sharees only get the count.
    for who in [&carol, &bob] {
        let p = presence(&lab, who, dev.tunnel_id).await;
        assert_eq!(p["count"], 1, "{}: {p}", who.username);
        assert!(p["sessions"].is_null(), "{}: {p}", who.username);
    }

    // 推播：owner 與只看狀態的 sharee 都收到新人數。/ Owner and status-only sharee both get the new count.
    telepy_server::monitor::runner::dispatch_presence(&lab.app.state).await.unwrap();
    for rx in [&mut alice_rx, &mut carol_rx] {
        let msg: Value = serde_json::from_str(&rx.try_recv().expect("presence notification")).unwrap();
        assert_eq!(msg["message"]["action"], "UPDATE-TUNNEL-PRESENCE");
        assert_eq!(msg["message"]["tunnel_id"], dev.tunnel_id);
        assert_eq!(msg["message"]["count"], 1);
    }

    drop(term);
    wait_presence(&lab, &alice, dev.tunnel_id, "terminal closed", |p| p["count"] == 0).await;

    // 筆電經 gateway 的 ssh（使用者金鑰 → direct-tcpip）也算。/ A laptop ssh through the gateway counts too.
    let hops = [(Hop::Tunnel(&dev), "ubuntu")];
    let (run, seen) = tokio::join!(lab.laptop_exec(&alice, &hops, "sleep 2"), async {
        wait_presence(&lab, &alice, dev.tunnel_id, "laptop ssh", |p| p["count"] == 1).await
    });
    assert!(run.ok, "{run:?}");
    let s = &seen["sessions"][0];
    assert_eq!(s["user"], "alice", "{seen}");
    assert_eq!(s["kind"], "ssh");
    assert_eq!(s["ip"], "127.0.0.1");
    wait_presence(&lab, &alice, dev.tunnel_id, "laptop ssh ended", |p| p["count"] == 0).await;
}

/// 筆電睡著、換網路、代理斷線：瀏覽器不會送 close，TCP 也可能一直不報錯。伺服器的 Ping 沒人回就自己結束連線、
/// 移出「使用中」；開著但沒在打字的分頁（會自動回 Ping）不受影響。
/// A client that vanishes without a close frame (laptop asleep, network switch, dropped proxy) stops answering the
/// server's pings and is dropped from presence; an open tab nobody types in still answers and stays.
#[tokio::test]
async fn vanished_clients_leave_presence() {
    let Some(mut lab) = Lab::start().await else { return };
    lab.reconfigure(|c| {
        c.ws_ping_interval = Duration::from_millis(300);
        c.ws_peer_timeout = Duration::from_millis(900);
    });
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    lab.username(&alice, &dev, "ubuntu").await;

    // 開著沒打字的分頁：撐過好幾個逾時，還在、也還能用。/ An idle open tab survives several timeouts and still works.
    let mut term = lab.terminal(&alice, &dev, "ubuntu").await.expect("terminal");
    term.input("echo ready\n").await;
    term.expect("ready").await;
    wait_presence(&lab, &alice, dev.tunnel_id, "terminal", |p| p["count"] == 1).await;
    term.idle(Duration::from_secs(3)).await;
    assert_eq!(presence(&lab, &alice, dev.tunnel_id).await["count"], 1, "a live idle tab must stay");
    term.input("echo still-here\n").await;
    term.expect("still-here").await;

    // 同一條連線從此不讀也不送（= 睡著的筆電，socket 還開著）：伺服器自己收掉。
    // The same connection now neither reads nor writes (a sleeping laptop, socket still open): the server drops it.
    let frozen = term;
    wait_presence(&lab, &alice, dev.tunnel_id, "the frozen terminal to leave", |p| p["count"] == 0).await;
    drop(frozen);

    // 檔案管理也一樣。/ Same for the file manager.
    let base = lab.ws_base().await;
    let (mut fm, _) = connect_async(format!("{base}/ws/filemanager/")).await.unwrap();
    let auth = json!({"type": "auth", "token": alice.token, "server_id": dev.tunnel_id.to_string(), "username": "ubuntu"});
    fm.send(Message::Text(auth.to_string().into())).await.unwrap();
    let p = wait_presence(&lab, &alice, dev.tunnel_id, "file manager", |p| p["count"] == 1).await;
    assert_eq!(p["sessions"][0]["kind"], "files", "{p}");
    wait_presence(&lab, &alice, dev.tunnel_id, "the frozen file manager to leave", |p| p["count"] == 0).await;
    drop(fm);
}
