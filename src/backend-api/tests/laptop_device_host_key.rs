//! 筆電的 ssh config 也核對裝置自己的 host key（跟 Telepy 後端同一套）：Telepy 還沒釘住時第一次連線記下來
//! （accept-new），釘住之後 config 帶那一行、只認那把。拿到隧道金鑰的人把隧道接到自己的 sshd，筆電就連不過去；
//! 舊的 `StrictHostKeyChecking no` 寫法會直接連進冒牌貨。
//! The laptop's ssh config checks the device's own host key too, like Telepy's backend: nothing pinned yet =
//! remember it on the first connection (accept-new); once pinned, the config carries that line and only that key
//! passes. Someone holding the tunnel key who points the tunnel at their own sshd stops the laptop; the old
//! `StrictHostKeyChecking no` stanza walks straight into the impostor.
mod common;

use common::lab::Lab;
use telepy_server::db;

fn read(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[tokio::test]
async fn the_laptop_config_checks_the_device_host_key() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let real = lab.machine("box", &[("root", &[&alice.key])], false).await;
    let fake = lab.machine("fake", &[("root", &[&alice.key])], false).await;
    let dev = lab.device(&alice, "box", &real).await;
    lab.username(&alice, &dev, "root").await;
    let device_alias = format!("-device-{} ", dev.tunnel_id);

    // 還沒釘：accept-new，known_hosts 沒有這台；第一次連線把裝置的金鑰記進那個檔。
    // Nothing pinned yet: accept-new and no line for the device; the first connection records its key in that file.
    assert!(db::host_keys::pinned_lines(&lab.app.state.db, dev.tunnel_id).await.unwrap().is_empty());
    let (cfg, alias) = lab.generated_ssh_config(&alice, &dev, "root").await;
    let text = read(&cfg);
    assert!(text.contains("StrictHostKeyChecking accept-new") && text.contains(&format!("-device-{}\n", dev.tunnel_id)), "{text}");
    let known = lab.generated_known_hosts(&alice, &dev);
    assert!(!read(&known).contains(&device_alias), "{}", read(&known));
    let r = lab.ssh_with_config(&cfg, &alias, "whereami").await;
    assert_eq!(r.stdout, "root@box", "{r:?}");
    assert!(read(&known).contains(&device_alias), "accept-new remembered the device: {}", read(&known));

    // Telepy 登入一次就釘住：config 改成 yes，known_hosts 帶釘住的那一行。
    // Telepy's first login pins it: the config says yes and known_hosts carries the pinned line.
    lab.trust_tunnel_key(&dev, "root").await;
    lab.backend_exec(&dev, "root", "whereami").await.unwrap();
    let pins = db::host_keys::pinned_lines(&lab.app.state.db, dev.tunnel_id).await.unwrap();
    assert_eq!(pins.len(), 1);
    let (cfg, alias) = lab.generated_ssh_config(&alice, &dev, "root").await;
    let text = read(&cfg);
    assert!(text.contains(&format!("StrictHostKeyChecking yes\n    UserKnownHostsFile {}\n    HostKeyAlias telepy-", known.display())), "{text}");
    assert!(read(&known).contains(&format!("{device_alias}{}", pins[0])), "{}", read(&known));
    assert_eq!(lab.ssh_with_config(&cfg, &alias, "whereami").await.stdout, "root@box");

    // 冒牌貨：拿著隧道金鑰、把隧道接到另一台 sshd。後端拒絕（早就這樣），筆電現在也拒絕。
    // An impostor holding the tunnel key points the tunnel at another sshd. The backend refuses (as before); now the laptop does too.
    lab.disconnect_device(&dev).await;
    let no_pin = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"].map(String::from);
    let _impostor = lab.spawn_tunnel_to(&dev.key, dev.reverse_port, fake.port, "box-impostor", lab.gw_port, &no_pin).await;
    assert!(lab.backend_exec(&dev, "root", "whereami").await.is_err(), "the backend refuses a different host key");
    let r = lab.ssh_with_config(&cfg, &alias, "whereami").await;
    assert!(!r.ok && r.stdout.is_empty(), "the laptop refuses the impostor: {r:?}");
    assert!(!fake.logged_in("root", &alice.key), "nothing reached the impostor");

    // 對照：舊的裝置區塊（不驗證）就這樣連進冒牌貨。/ Contrast: the old unchecked device stanza lands on the impostor.
    let (head, device) = text.split_at(text.find(&format!("Host {alias}\n")).unwrap());
    let old = format!("{head}{}", device.replacen("StrictHostKeyChecking yes", "StrictHostKeyChecking no", 1));
    let old_cfg = cfg.with_file_name("alice-box-old.conf");
    std::fs::write(&old_cfg, old.replace(&cfg.display().to_string(), &old_cfg.display().to_string())).unwrap();
    let r = lab.ssh_with_config(&old_cfg, &alias, "whereami").await;
    assert_eq!(r.stdout, "root@fake", "without the check the laptop lands on the impostor: {r:?}");
}
