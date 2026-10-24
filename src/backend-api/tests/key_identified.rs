//! 隧道由金鑰辨識（SSH lab）：裝置在 `-R` 要求 0 或別的號碼，forward 還是記在它自己的號碼下（回給裝置的也是），
//! 要求別人的號碼也搶不到別人的隧道；筆電 `ssh -W <隧道名稱>:22` 以名稱找隧道（舊的 `localhost:<號碼>` 照常），
//! 看不到的名稱被拒；使用者金鑰仍然只能開自己擁有的隧道的號碼。
//! Tunnels identified by key: the device may ask for 0 or any number and still lands on its own; a laptop reaches a
//! tunnel by name through direct-tcpip (the old `localhost:<number>` form keeps working); invisible names are refused;
//! a user key still only forwards the number of a tunnel it owns.
mod common;

use common::lab::{Hop, Lab};

#[tokio::test]
async fn the_key_picks_the_tunnel_whatever_number_the_device_asks_for() {
    let Some(lab) = Lab::start().await else { return };
    let app = &lab.app;
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let m1 = lab.machine("m1", &[("ubuntu", &[&lab.service, &alice.key])], false).await;
    let m2 = lab.machine("m2", &[("ubuntu", &[&lab.service])], false).await;
    let m3 = lab.machine("m3", &[("ubuntu", &[&lab.service])], false).await;

    // `-R 0`：伺服器挑 → 就是隧道自己的號碼。/ `-R 0`: the server picks → the tunnel's own number.
    let zero = lab.device_requesting(&alice, "zero", &m1, 0).await;
    lab.username(&alice, &zero, "ubuntu").await;
    assert_eq!(lab.backend_exec(&zero, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={}", zero.tunnel_id), Some(&alice.token)).await;
    let fwd = r.json.as_array().unwrap().iter().find(|e| e["event"] == "forward").unwrap();
    assert_eq!(fwd["port"].as_u64(), Some(u64::from(zero.reverse_port)), "{fwd}");
    assert!(fwd["message"].as_str().unwrap().contains("(the device asked for 0)"), "{}", fwd["message"]);

    // 要求別人的號碼：還是記在自己的號碼下，別人的隧道不受影響。/ Asking for someone else's number changes nothing.
    let greedy = lab.device_requesting(&bob, "greedy", &m2, zero.reverse_port).await;
    lab.username(&bob, &greedy, "ubuntu").await;
    assert_eq!(lab.backend_exec(&greedy, "ubuntu", "whoami").await.unwrap(), "ubuntu");
    assert_eq!(lab.backend_exec(&zero, "ubuntu", "whoami").await.unwrap(), "ubuntu", "alice's tunnel is untouched");
    let ports = app.state.status.listen_ports().unwrap_or_default();
    assert!(ports.contains(&zero.reverse_port) && ports.contains(&greedy.reverse_port), "{ports:?}");

    // 筆電以名稱連：`-W zero:22`；舊寫法 `localhost:<號碼>` 也還能用。/ A laptop reaches the tunnel by name; the old form still works.
    let named = lab.laptop_config_named(&alice, &zero, "ubuntu");
    let r = lab.ssh_with_config(&named, "hop0", "whereami").await;
    assert_eq!(r.stdout, "ubuntu@m1", "{r:?}");
    let r = lab.laptop_exec(&alice, &[(Hop::Tunnel(&zero), "ubuntu")], "whereami").await;
    assert_eq!(r.stdout, "ubuntu@m1", "{r:?}");
    // 產生的 ssh config 就是名稱形式。/ The generated config uses the name form.
    let (cfg, alias) = lab.generated_ssh_config(&alice, &zero, "ubuntu").await;
    assert!(std::fs::read_to_string(&cfg).unwrap().contains("HostName zero\n"), "{}", std::fs::read_to_string(&cfg).unwrap());
    assert_eq!(lab.ssh_with_config(&cfg, &alias, "whereami").await.stdout, "ubuntu@m1");

    // 看不到的名稱、不存在的名稱：拒絕，裝置沒看到任何登入。/ Invisible or unknown names are refused.
    let r = lab.ssh_with_config(&lab.laptop_config_named(&bob, &zero, "ubuntu"), "hop0", "whoami").await;
    assert!(!r.ok, "{r:?}");
    assert!(!m1.any_login_with(&bob.key));
    let ghost = common::lab::Device { tunnel_id: 0, name: "ghost".into(), reverse_port: 1, target: m1.clone(), key: zero.key.clone() };
    let r = lab.ssh_with_config(&lab.laptop_config_named(&alice, &ghost, "ubuntu"), "hop0", "whoami").await;
    assert!(!r.ok, "{r:?}");
    let r = app.get(&format!("/api/log/ssh/events?tunnel_id={}", zero.tunnel_id), Some(&alice.token)).await;
    assert!(r.json.as_array().unwrap().iter().any(|e| e["event"] == "refused_direct"), "bob's attempt on 'zero' is logged on the tunnel");

    // 使用者金鑰的 forward：只能是自己擁有的隧道的號碼（金鑰認不出隧道）。/ A user key may only forward an owned tunnel's number.
    let own = lab.spawn_tunnel_requesting(&alice.key, zero.reverse_port, zero.reverse_port, m3.port, "alice-forward", lab.gw_port, &["-o".into(), "StrictHostKeyChecking=no".into(), "-o".into(), "UserKnownHostsFile=/dev/null".into()]).await;
    drop(own);
    // 連別人的號碼 / 0：被拒。/ Someone else's number or 0: refused (ssh exits because the forward fails).
    for asked in [greedy.reverse_port, 0] {
        let out = tokio::process::Command::new("ssh")
            .args(["-F", "/dev/null", "-N", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ExitOnForwardFailure=yes", "-o", "LogLevel=ERROR", "-i"])
            .arg(&alice.key.path)
            .args(["-p", &lab.gw_port.to_string(), "-R", &format!("*:{asked}:127.0.0.1:{}", m3.port), "telepy@127.0.0.1"])
            .output()
            .await
            .unwrap();
        assert!(!out.status.success(), "a user key must not forward {asked}: {}", String::from_utf8_lossy(&out.stderr));
    }
}
