//! gateway 前面有 L4 代理（PROXY protocol）：列出的代理送來的 header 決定裝置的來源 IP；
//! 沒送 header 的直連照常可用；header 格式錯就拒絕（記 `refused_proxy`）；只連上就斷（健康檢查）不記事件。
//! The gateway behind an L4 proxy: a listed proxy's header sets the device's source IP; a direct
//! connection without a header still works; a malformed header is refused (`refused_proxy`); a bare
//! connect-and-close (health check) is not logged.
mod common;

use std::process::Stdio;
use std::time::Duration;

use common::lab::{free_port, Lab};
use serde_json::Value;
use telepy_server::db;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;

/// 最小的 L4 代理：每條連線先送 v1 header（假裝來源是 203.0.113.50），之後原樣轉送。
/// A minimal L4 proxy that prepends a v1 header claiming the client is 203.0.113.50.
async fn start_proxy(gw_port: u16) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut client, from)) = listener.accept().await {
            tokio::spawn(async move {
                let mut upstream = TcpStream::connect(("127.0.0.1", gw_port)).await.unwrap();
                let header = format!("PROXY TCP4 203.0.113.50 127.0.0.1 {} {gw_port}\r\n", from.port());
                upstream.write_all(header.as_bytes()).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    port
}

async fn events(lab: &Lab, kind: &str) -> Vec<(Option<String>, String)> {
    sqlx::query_as("SELECT peer, message FROM telepy_gateway_event WHERE event = ? ORDER BY id").bind(kind).fetch_all(&lab.app.state.db.read).await.unwrap()
}

#[tokio::test]
async fn proxied_devices_get_the_address_from_the_header() {
    let Some(lab) = Lab::start_with(|c| c.gateway_proxy_protocol_from = Some("127.0.0.1".into())).await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let key = lab.keygen("box-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "box", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();

    let ssh = |gw: u16| {
        Command::new("ssh")
            .args(["-F", "/dev/null", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
            .args(["-o", "ExitOnForwardFailure=yes", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "-i"])
            .arg(&key.path)
            .args(["-p", &gw.to_string(), "-R", &format!("*:{port}:127.0.0.1:{}", boxm.port), "telepy@127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };

    let listening = |want: bool| {
        let status = lab.app.state.status.clone();
        async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            while status.listen_ports().is_some_and(|p| p.contains(&port)) != want {
                assert!(tokio::time::Instant::now() < deadline, "forward never became {want}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    let endpoint = || async {
        let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
        r.json["tunnels"].as_array().unwrap().iter().find(|x| x["id"] == t.id).unwrap()["endpoint"].clone()
    };

    // 直接連（沒有 header）：照常可用，來源是 socket 對端。/ Direct, without a header: works, the socket peer is the source.
    let mut direct = ssh(lab.gw_port);
    listening(true).await;
    let e: Value = endpoint().await;
    assert_eq!(e["ip"], "127.0.0.1", "{e}");
    direct.kill().await.unwrap();
    listening(false).await;

    // header 格式錯：拒絕並記事件。/ A malformed header: refused and logged.
    let mut bad = TcpStream::connect(("127.0.0.1", lab.gw_port)).await.unwrap();
    bad.write_all(b"PROXY TCP4 not-an-address 127.0.0.1 1 2\r\n").await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while events(&lab, "refused_proxy").await.is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "malformed header was not refused");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let refused = events(&lab, "refused_proxy").await;
    assert_eq!(refused.len(), 1, "{refused:?}");
    assert!(refused[0].1.contains("bad PROXY protocol header"), "{refused:?}");

    // 只連上就斷（代理的健康檢查）：不記事件。/ A bare connect-and-close is not logged.
    drop(TcpStream::connect(("127.0.0.1", lab.gw_port)).await.unwrap());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(events(&lab, "refused_proxy").await.len(), 1);

    // 經過代理：來源是 header 裡的位址。/ Through the proxy: the source comes from the header.
    let proxy = start_proxy(lab.gw_port).await;
    let _tunnel = ssh(proxy);
    listening(true).await;
    let e: Value = endpoint().await;
    assert_eq!(e["ip"], "203.0.113.50", "{e}");
    assert_eq!(e["geo"]["scope"], "public");
    let accepted = events(&lab, "accepted").await;
    assert!(accepted.iter().any(|(peer, msg)| peer.as_deref().is_some_and(|p| p.starts_with("203.0.113.50:")) && msg.contains("from 203.0.113.50")), "{accepted:?}");
}

/// 沒列為來源的代理送來的 header **從不被讀**：russh 不接受 banner 前的東西，所以連線在握手就失敗（代理後面的裝置
/// 全都連不上）。gateway 認得它、記一次 `proxy_unlisted`（每小時最多一次），`/api/site/address-sources` 把它列在
/// 最前面讓管理員一鍵加入；加進設定之後（存檔即生效）同一個代理的連線就通了，來源是 header 裡的位址。
/// A header from a proxy that is not a source is **never read**: russh accepts nothing before the banner, so the
/// handshake fails and no device behind that proxy gets in. The gateway recognises it, logs `proxy_unlisted` once
/// (at most hourly) and `/api/site/address-sources` lists it first for a one-click add; once added (a save applies
/// at once) the same proxy's connections work, with the source from the header.
#[tokio::test]
async fn an_unlisted_proxy_is_recognised_but_never_trusted() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service])], false).await;
    let key = lab.keygen("box-tunnel");
    let port = free_port();
    let t = db::tunnels::create(
        &lab.app.state.db,
        db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "box", key: &key.public, reverse_port: port as i64, description: None, default_username_id: None },
    )
    .await
    .unwrap();
    let ssh = |gw: u16| {
        Command::new("ssh")
            .args(["-F", "/dev/null", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
            .args(["-o", "ExitOnForwardFailure=yes", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "-i"])
            .arg(&key.path)
            .args(["-p", &gw.to_string(), "-R", &format!("*:{port}:127.0.0.1:{}", boxm.port), "telepy@127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };
    let listening = |want: bool| {
        let status = lab.app.state.status.clone();
        async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            while status.listen_ports().is_some_and(|p| p.contains(&port)) != want {
                assert!(tokio::time::Instant::now() < deadline, "forward never became {want}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    let endpoint = || async {
        let r = lab.app.get("/api/reverse/server/dashboard", Some(&alice.token)).await;
        r.json["tunnels"].as_array().unwrap().iter().find(|x| x["id"] == t.id).unwrap()["endpoint"].clone()
    };
    let sources = || async {
        let r = lab.app.get("/api/site/address-sources", Some(&lab.admin_token)).await;
        assert_eq!(r.status, 200, "{}", r.json);
        r.json
    };
    let loopback = |s: &Value| s["peers"].as_array().unwrap().iter().find(|p| p["ip"] == "127.0.0.1").cloned().unwrap_or_else(|| panic!("127.0.0.1 not listed: {s}"));

    // 只有管理員看得到。/ Admins only.
    let r = lab.app.get("/api/site/address-sources", Some(&alice.token)).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json["code"], "admin_only");
    let presets = sources().await["presets"].clone();
    assert!(presets.as_array().unwrap().iter().any(|p| p["id"] == "cloudflare" && p["cidrs"].as_array().unwrap().len() > 10), "{presets}");

    // 經過沒列出的代理：header 不被讀，握手失敗，forward 起不來。/ Through an unlisted proxy: the header is not read, the handshake fails.
    let proxy = start_proxy(lab.gw_port).await;
    let headers_seen = || async { sources().await["peers"].as_array().unwrap().iter().find(|p| p["ip"] == "127.0.0.1").map(|p| p["proxy_headers"].as_u64().unwrap()).unwrap_or(0) };
    let mut first = ssh(proxy);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while events(&lab, "proxy_unlisted").await.is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "the unlisted header was not recognised");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let status = tokio::time::timeout(Duration::from_secs(15), first.wait()).await.expect("ssh should give up").unwrap();
    assert!(!status.success(), "an unlisted proxy's connection must not get through");
    assert!(!lab.app.state.status.listen_ports().is_some_and(|p| p.contains(&port)), "no forward through an unlisted proxy");
    assert_eq!(endpoint().await["ip"], Value::Null, "nothing was recorded from the header");
    let seen = loopback(&sources().await);
    assert_eq!(seen["listed"], false, "{seen}");
    assert_eq!(seen["scope"], "loopback");
    assert_eq!(seen["proxy_headers"], 1, "{seen}");

    // 再連一次：還是只有一筆事件（每小時最多一次），次數加一。/ Again: still one event (at most hourly), one more header counted.
    let mut second = ssh(proxy);
    let _ = tokio::time::timeout(Duration::from_secs(15), second.wait()).await.expect("ssh should give up");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while headers_seen().await < 2 {
        assert!(tokio::time::Instant::now() < deadline, "the second header was not counted");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let logged = events(&lab, "proxy_unlisted").await;
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert!(logged[0].1.contains("is not a PROXY protocol source"), "{logged:?}");

    // 加進來源（存檔即生效）：同一個代理的 header 開始被採用。/ Added as a source (applies at once): its header is now used.
    let r = lab.app.post("/api/site/settings", Some(&lab.admin_token), serde_json::json!({ "server_gateway_proxy_protocol_from": "127.0.0.1" })).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let _third = ssh(proxy);
    listening(true).await;
    let e: Value = endpoint().await;
    assert_eq!(e["ip"], "203.0.113.50", "{e}");
    assert_eq!(loopback(&sources().await)["listed"], true);
    assert_eq!(events(&lab, "proxy_unlisted").await.len(), 1, "a listed source is not warned about");
}
