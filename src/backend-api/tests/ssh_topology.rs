//! 端到端 SSH 拓撲（common::lab）：同一台裝置上的多個 Telepy 使用者 / 多個 OS 帳號，以及兩跳、三跳的路徑。
//! 每一層都是真的 SSH：裝置隧道與筆電用 OpenSSH 客戶端，裝置 sshd 記錄每次登入是「哪個帳號、哪把金鑰」。
//! End-to-end SSH topologies: many users on one device, and multi-hop paths through the gateway.
mod common;

use common::lab::{Hop, Lab};

/// 一台裝置、三位 Telepy 使用者、兩個 OS 帳號：
/// - alice 擁有隧道；bob 是 VIEW 分享、只允許 ubuntu；carol 什麼都沒有
/// - 裝置上 ubuntu 信任服務金鑰 + alice + bob；root 只信任 alice（不信任服務金鑰）
#[tokio::test]
async fn one_device_many_users() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let carol = lab.user("carol").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service, &alice.key, &bob.key]), ("root", &[&alice.key])], false).await;
    std::fs::write(boxm.home.join("marker.txt"), b"on the device").unwrap();
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.username(&alice, &dev, "root").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;

    // --- 後端（行程內通道，服務金鑰）
    // russh：AI session 這類自己的連線
    assert_eq!(lab.backend_exec(&dev, "ubuntu", "whereami").await.unwrap(), "ubuntu@box");
    // root 不信任服務金鑰 → 裝置自己拒絕，不管 Telepy 允許什麼
    assert!(lab.backend_exec(&dev, "root", "whoami").await.is_err());
    assert!(!boxm.logged_in("root", &lab.service));
    // SFTP 子系統（有 sftp-server 的環境）
    if let Ok(sftp) = lab.backend_sftp(&dev, "ubuntu").await {
        assert_eq!(sftp.read("marker.txt").await.unwrap(), b"on the device");
    }

    // --- 筆電（兩層 SSH：先用個人金鑰登入 gateway，再登入裝置）
    let r = lab.laptop_exec(&alice, &[(Hop::Tunnel(&dev), "root")], "whereami").await;
    assert_eq!(r.stdout, "root@box", "{r:?}");
    let r = lab.laptop_exec(&bob, &[(Hop::Tunnel(&dev), "ubuntu")], "whereami").await;
    assert_eq!(r.stdout, "ubuntu@box", "{r:?}");
    // bob 過得了 gateway（有分享），但 root 的 authorized_keys 沒有他的金鑰
    let r = lab.laptop_exec(&bob, &[(Hop::Tunnel(&dev), "root")], "whoami").await;
    assert!(!r.ok, "{r:?}");
    assert!(!boxm.logged_in("root", &bob.key));
    // carol 沒有隧道也沒被分享：gateway 就拒絕她的金鑰，裝置完全沒看到她
    let r = lab.laptop_exec(&carol, &[(Hop::Tunnel(&dev), "ubuntu")], "whoami").await;
    assert!(!r.ok, "{r:?}");
    assert!(!boxm.any_login_with(&carol.key));
    // dave 被分享但一個帳號都不准用（只看狀態）：gateway 不開通道，裝置的 sshd 連他的敲門都看不到
    // dave is shared the tunnel with no allowed account (status only): no direct-tcpip, the device never sees him
    let dave = lab.user("dave").await;
    lab.share(&alice, &dev, &dave, "edit", &[]).await;
    let r = lab.laptop_exec(&dave, &[(Hop::Tunnel(&dev), "ubuntu")], "whoami").await;
    assert!(!r.ok, "{r:?}");
    assert!(!boxm.any_login_with(&dave.key));
    let r = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={}", dev.tunnel_id), Some(&alice.token)).await;
    assert!(r.json.as_array().unwrap().iter().any(|e| e["event"] == "refused_direct"), "{}", r.text);
    // ADMIN sharee 管帳號清單，所以不需要在清單上：過得了 gateway，裝置再用 authorized_keys 決定（這裡放了她的金鑰）
    // An ADMIN sharee manages the allow-list, so needs no entry: passes the gateway; the device decides by authorized_keys
    let erin = lab.user("erin").await;
    lab.share(&alice, &dev, &erin, "admin", &[]).await;
    let ssh_dir = boxm.account_home("ubuntu").join(".ssh");
    std::fs::create_dir_all(&ssh_dir).unwrap();
    std::fs::write(ssh_dir.join("authorized_keys"), format!("{}\n", erin.key.public)).unwrap();
    let r = lab.laptop_exec(&erin, &[(Hop::Tunnel(&dev), "ubuntu")], "whereami").await;
    assert_eq!(r.stdout, "ubuntu@box", "{r:?}");
    assert!(boxm.logged_in("ubuntu", &erin.key));
    // API 產生的 ~/.ssh/config 原樣可用，而且釘住了 gateway 的 host key：換成別的金鑰就連不上
    // The generated config works as is and pins the gateway's host key: a different key in known_hosts and ssh refuses
    let (cfg, alias) = lab.generated_ssh_config(&alice, &dev, "root").await;
    let text = std::fs::read_to_string(&cfg).unwrap();
    assert!(text.contains("StrictHostKeyChecking yes") && text.contains("HostKeyAlias telepy-"), "{text}");
    let known = lab.generated_known_hosts(&alice, &dev);
    let saved = std::fs::read_to_string(&known).unwrap();
    assert!(saved.starts_with("telepy-") && saved.contains(" ssh-ed25519 "), "{saved}");
    let r = lab.ssh_with_config(&cfg, &alias, "whereami").await;
    assert_eq!(r.stdout, "root@box", "{r:?}");
    std::fs::write(&known, saved.replacen("ssh-ed25519 ", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHEFltoMG4X8MG60ALp7MCsyv9mKKK1QjxImZr4QVzQ1 #", 1)).unwrap();
    let r = lab.ssh_with_config(&cfg, &alias, "whereami").await;
    assert!(!r.ok, "a wrong pinned key must stop the laptop: {r:?}");
    std::fs::write(&known, &saved).unwrap();
    assert_eq!(lab.ssh_with_config(&cfg, &alias, "whereami").await.stdout, "root@box");
    // 不同使用者同時連同一台，各自的身分不會混
    let (alice_root, bob_ubuntu) = ([(Hop::Tunnel(&dev), "root")], [(Hop::Tunnel(&dev), "ubuntu")]);
    let (a, b) = tokio::join!(lab.laptop_exec(&alice, &alice_root, "whereami"), lab.laptop_exec(&bob, &bob_ubuntu, "whereami"));
    assert_eq!((a.stdout.as_str(), b.stdout.as_str()), ("root@box", "ubuntu@box"), "{a:?} {b:?}");

    // --- 網頁終端機：SSH 開始前先由 Telepy 的允許清單決定
    assert_eq!(lab.terminal(&bob, &dev, "root").await.err(), Some(4003), "root is not on bob's allow-list");
    assert_eq!(lab.terminal(&carol, &dev, "ubuntu").await.err(), Some(4004), "carol cannot see the tunnel");
    let mut t = lab.terminal(&bob, &dev, "ubuntu").await.unwrap();
    t.expect("login:ubuntu@box").await;
    t.input("hello-from-bob\r").await;
    t.expect("hello-from-bob").await;

    // 裝置端的登入紀錄：誰用哪把金鑰登入成哪個帳號
    assert!(boxm.logged_in("ubuntu", &lab.service));
    assert!(boxm.logged_in("root", &alice.key));
    assert!(boxm.logged_in("ubuntu", &bob.key));
}

/// 兩跳以上：
/// 1. 裝置把隧道轉到內網另一台（`-R *:port:lan-host:22`）：後端 → gateway → 裝置的 ssh 客戶端 → 內網機器
/// 2. 筆電 → gateway → 跳板裝置（sshd）→ ProxyJump → 內網機器：三次 SSH 登入，每層各自驗證
/// 3. 不是跳板的裝置會擋下第二跳
#[tokio::test]
async fn multi_hop_paths() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let inner = lab.machine("inner", &[("deploy", &[&lab.service, &alice.key])], false).await;
    let edge = lab.machine("edge", &[("ops", &[&alice.key])], true).await;

    // 1) 隧道直接落在內網機器
    let lan = lab.device(&alice, "inner-via-lan", &inner).await;
    assert_eq!(lab.backend_exec(&lan, "deploy", "whereami").await.unwrap(), "deploy@inner");
    let r = lab.laptop_exec(&alice, &[(Hop::Tunnel(&lan), "deploy")], "whereami").await;
    assert_eq!(r.stdout, "deploy@inner", "{r:?}");

    // 2) 經跳板裝置再 ProxyJump
    let dev = lab.device(&alice, "edge", &edge).await;
    let r = lab.laptop_exec(&alice, &[(Hop::Tunnel(&dev), "ops"), (Hop::Direct(&inner), "deploy")], "whereami").await;
    assert_eq!(r.stdout, "deploy@inner", "{r:?}");
    assert!(edge.logged_in("ops", &alice.key), "the jump host saw alice log in");
    assert!(inner.logged_in("deploy", &alice.key));
    // 跳板上的帳號不對 → 第一層就失敗，到不了內網機器
    let before = inner.logins().len();
    let r = lab.laptop_exec(&alice, &[(Hop::Tunnel(&dev), "nobody"), (Hop::Direct(&inner), "deploy")], "whereami").await;
    assert!(!r.ok, "{r:?}");
    assert_eq!(inner.logins().len(), before);

    // 3) inner 不是跳板：經它往 edge 的第二跳被拒，edge 沒有新的登入
    let before = edge.logins().len();
    let r = lab.laptop_exec(&alice, &[(Hop::Tunnel(&lan), "deploy"), (Hop::Direct(&edge), "ops")], "whereami").await;
    assert!(!r.ok, "{r:?}");
    assert_eq!(edge.logins().len(), before);
}

/// 被分享 EDIT 的人不能自己加 OS 帳號來繞過允許清單；就算擁有者自己有 root，不在他清單上就用不到。
/// 以前（Django 起）EDIT 自己建的 username 會自動算進允許清單，猜到 `root` 就拿到 root shell。
#[tokio::test]
async fn sharees_only_get_their_allow_list() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let dave = lab.user("dave").await;
    let boxm = lab.machine("box", &[("ubuntu", &[&lab.service]), ("root", &[&lab.service])], false).await;
    let dev = lab.device(&alice, "box", &boxm).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &dave, "edit", &[ubuntu]).await;

    // dave 猜 root 並想自己加上去 → 403
    let r = lab.add_username(&dave, &dev, "root").await;
    assert_eq!(r.status, axum::http::StatusCode::FORBIDDEN, "{}", r.text);
    // alice 自己有 root，但不在 dave 的清單上：每條路都拒絕
    lab.username(&alice, &dev, "root").await;
    assert_eq!(lab.terminal(&dave, &dev, "root").await.err(), Some(4003), "dave must not get a root shell");
    let r = lab.app.get(&format!("/api/sftp/list/{}/root", dev.tunnel_id), Some(&dave.token)).await;
    assert_eq!(r.status, axum::http::StatusCode::BAD_REQUEST, "{}", r.text);
    let r = lab.app.get(&format!("/api/reverse/server/{}/usernames", dev.tunnel_id), Some(&dave.token)).await;
    assert_eq!(r.json["usernames"].as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect::<Vec<_>>(), vec!["ubuntu"]);
    assert!(!boxm.logged_in("root", &lab.service));
    // 清單上的照常可用
    let mut t = lab.terminal(&dave, &dev, "ubuntu").await.unwrap();
    t.expect("login:ubuntu@box").await;
}
