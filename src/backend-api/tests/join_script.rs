//! 一鍵加入的**腳本本身**端到端：真的 `/bin/sh` 跑 `join_install.sh`，對著 lab 的真 gateway、真 HTTP listener 與一台 lab 機器
//! （假 sshd，當「這台裝置的 SSH server」）。先 `--check`（不消耗 token：偵測、嚴格握手驗 host key、gateway 可達、
//! keepalive 探測），再 `--token` 真的加入（`--service loop`，crontab 是 `<dir>/bin` 的替身，金鑰 / known_hosts / 紀錄都寫在
//! 暫存目錄；`--authorized-keys` 指到 lab 機器那個帳號讀的檔案，所以 Telepy 的驗證登入是真的），最後跑它寫的 uninstall。
//! The join script itself, end to end on the lab: a real `/bin/sh`, the real gateway, the real HTTP listener and a lab
//! machine as "this device's SSH server". `--check` first (no token), then a real join as a background loop (stub
//! crontab; every file under a temp dir; the service key goes where the lab sshd reads it, so the verification login is
//! real), then the uninstall script it wrote.
mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::json;

use common::lab::Lab;

fn write_exec(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

/// 假的 crontab：表存在 `<dir>/crontab.txt`，永遠不碰開發者的 crontab。/ A stub crontab keeping its table in a file.
fn stub_bin(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let table = dir.join("crontab.txt");
    write_exec(
        &bin.join("crontab"),
        &format!("#!/bin/sh\nif [ \"$1\" = -l ]; then cat '{t}' 2>/dev/null; exit 0; fi\nif [ \"$1\" = - ]; then cat > '{t}.new' && mv '{t}.new' '{t}'; exit 0; fi\nexit 1\n", t = table.display()),
    );
    bin
}

struct Run {
    status: i32,
    out: String,
}


/// 編好的 telepy-carrier（`cargo build -p telepy-carrier` 的產物，在共用的 target 目錄）；沒有就 None（測試改走 python3）。
/// The built telepy-carrier from the shared target dir; None when it was never built (the test then uses python3).
fn built_carrier() -> Option<std::path::PathBuf> {
    let target = std::env::var("CARGO_TARGET_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target"));
    let p = target.join("debug").join("telepy-carrier");
    p.is_file().then_some(p)
}

/// 這台機器的 target（跟 join 腳本的 `uname -s` / `uname -m` 一樣）。/ This machine's target, as the join script sees it.
fn host_target() -> Option<&'static str> {
    let u = |a: &str| String::from_utf8_lossy(&std::process::Command::new("uname").arg(a).output().ok()?.stdout).trim().to_string().into();
    let (os, m): (Option<String>, Option<String>) = (u("-s"), u("-m"));
    telepy_server::carriers::target_for(&os?, &m?)
}

/// 把編好的載體放進 lab 的快取（像 `telepy-server fetch-carriers` 做的那樣）。/ Place the built carrier in the lab's cache.
fn cache_carrier(app: &common::TestApp) -> Option<&'static str> {
    let (bin, target) = (built_carrier()?, host_target()?);
    let dir = app.state.config.carrier_dir.join(target);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(&bin, dir.join("telepy-carrier")).unwrap();
    Some(target)
}

fn run_script(script: &Path, bin: &Path, args: &[&str]) -> Run {
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
    let o = Command::new("/bin/sh").arg(script).args(args).env("PATH", path).env_remove("SUDO_USER").stdin(Stdio::null()).output().unwrap();
    let out = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    Run { status: o.status.code().unwrap_or(-1), out }
}

// 多執行緒：腳本（curl、ssh）是同步跑的，lab 的 HTTP listener 與 gateway 得在別的 worker 上回應。
// Multi-threaded: the script runs synchronously (curl, ssh); the lab's HTTP listener and gateway answer on other workers.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_join_script_checks_joins_and_uninstalls_for_real() {
    let Some(lab) = Lab::start().await else { return };
    if !Path::new("/bin/sh").exists() || Command::new("curl").arg("--version").output().is_err() {
        eprintln!("skipping: needs /bin/sh and curl");
        return;
    }
    let app = &lab.app;
    let alice = lab.user("alice").await;
    // 「這台裝置」的 sshd：帳號 = 跑測試的使用者（腳本沒有 root 時只能設定自己的帳號），它的 authorized_keys 由腳本寫
    // （服務金鑰），所以一開始沒有金鑰。/ "This device's" sshd: the account is the user running the test (without root
    // the script only sets up its own account); the script itself writes the service key there, so it starts empty.
    let me = String::from_utf8_lossy(&Command::new("id").arg("-un").output().unwrap().stdout).trim().to_string();
    let pi = lab.machine("pi", &[(me.as_str(), &[])], false).await;
    let my_home = pi.account_home(&me);
    let auth_keys = my_home.join(".ssh").join("authorized_keys");

    // 真的 HTTP listener：腳本用 curl 連它；Host header 決定 TELEPY_URL 與 GATEWAY_HOST（127.0.0.1）。
    let base = lab.ws_base().await.replacen("ws://", "http://", 1);
    let dir = lab.dir.path().join("join-script");
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("telepy-join.sh");
    let fetched = Command::new("curl").args(["-fsS", "-o", script.to_str().unwrap(), &format!("{base}/api/join/install.sh")]).status().unwrap();
    assert!(fetched.success());
    let text = std::fs::read_to_string(&script).unwrap();
    assert!(text.starts_with("#!/bin/sh\n") && text.contains(&format!("TELEPY_URL='{base}'")), "{}", &text[..300]);
    assert!(text.lines().last().unwrap().starts_with("# telepy-sha256: "), "the served script ends with its checksum");
    let bin = stub_bin(&dir);
    let ssh_dir = dir.join("ssh");
    let common_args = ["--ssh-port", &pi.port.to_string(), "--ssh-dir", ssh_dir.to_str().unwrap(), "--authorized-keys", auth_keys.to_str().unwrap(), "--service", "loop", "--no-compat"];

    // 壞掉的下載被抓到。開頭掉字（路由器上發生過的那種）由下載指令裡的 `sh -n` 擋下；內文掉字由腳本自己的校驗碼擋下，
    // 兩者都不是莫名的 ash 語法錯誤。/ A damaged download is caught: damage at the top by the `sh -n` of the download
    // command, damage in the body by the script's own checksum — neither as a baffling syntax error.
    let damaged_top = dir.join("damaged-top.sh");
    std::fs::write(&damaged_top, text.replacen("# Telepy: join this machine", "in this machine", 1)).unwrap();
    assert!(!Command::new("/bin/sh").arg("-n").arg(&damaged_top).output().unwrap().status.success(), "sh -n refuses the damaged head");
    assert!(Command::new("/bin/sh").arg("-n").arg(&script).output().unwrap().status.success(), "sh -n accepts the real script");
    let damaged = dir.join("damaged.sh");
    std::fs::write(&damaged, text.replacen("Preflight passed. This machine", "Preflight passed This machine", 1)).unwrap();
    let r = run_script(&damaged, &bin, &["--check"]);
    assert!(r.status != 0 && r.out.contains("damaged or incomplete"), "{}", r.out);
    // CRLF：sh 在第一個 `set -eu` 就停了（腳本自己來不及說明），`sh -n` 一樣擋下來。/ CRLF stops sh at the first line already.
    let crlf = dir.join("crlf.sh");
    std::fs::write(&crlf, text.replace('\n', "\r\n")).unwrap();
    assert!(!Command::new("/bin/sh").arg("-n").arg(&crlf).output().unwrap().status.success(), "sh -n refuses CRLF");
    assert!(run_script(&crlf, &bin, &["--check"]).status != 0);

    // --check：不用 token，偵測 + host key 嚴格握手 + gateway 探測。/ Preflight without a token.
    let r = run_script(&script, &bin, &[&["--check"][..], &common_args[..]].concat());
    assert_eq!(r.status, 0, "{}", r.out);
    assert!(r.out.contains("Preflight passed") && r.out.contains("verified by a strict handshake") && r.out.contains("ssh client       OpenSSH_"), "{}", r.out);
    assert!(r.out.contains(&format!("gateway          telepy@127.0.0.1:{}", lab.gw_port)) && r.out.contains("host key pinned: yes"), "{}", r.out);
    assert!(r.out.contains("handshake with ServerAliveInterval=30 completed"), "a healthy ssh keeps SSH keepalives: {}", r.out);
    assert!(!ssh_dir.exists(), "--check writes nothing");
    assert_eq!(app.get("/api/reverse/server/dashboard", Some(&alice.token)).await.json["tunnels"].as_array().unwrap().len(), 0, "--check registers nothing");

    // --auto：載體先是這台機器的預編 telepy-carrier（從 lab 的快取下載、核對 sha256），沒有就 python3，再沒有就只走 SSH 的
    // port；同一套探測經載體跑（先 SSH 的 port）。/ --auto: the prebuilt carrier first (downloaded from the lab's cache,
    // sha256 checked), else python3, else the SSH port only; the same probes run through it.
    let cached = cache_carrier(&lab.app);
    let r = run_script(&script, &bin, &[&["--check", "--auto"][..], &common_args[..]].concat());
    assert_eq!(r.status, 0, "{}", r.out);
    if let Some(target) = cached {
        assert!(r.out.contains(&format!("transport: automatic, the SSH port 127.0.0.1:{} first", lab.gw_port)) && r.out.contains(&format!("carrier: telepy-carrier ({target}, checksum verified)")), "{}", r.out);
        assert!(r.out.contains("  web port         telepy-carrier"), "{}", r.out);
    } else if common::lab::have("python3") {
        assert!(r.out.contains(&format!("transport: automatic, the SSH port 127.0.0.1:{} first", lab.gw_port)) && r.out.contains("carrier: python3"), "{}", r.out);
        assert!(r.out.contains("no telepy-carrier for") || r.out.contains("trying python3"), "no cached binary: says so and falls back: {}", r.out);
    } else {
        assert!(r.out.contains("no prebuilt telepy-carrier for") && r.out.contains("the tunnel uses the SSH port only"), "{}", r.out);
    }
    assert!(r.out.contains("Preflight passed") && r.out.contains("handshake with ServerAliveInterval=30 completed"), "{}", r.out);
    assert!(!ssh_dir.exists(), "--check writes nothing");
    // --carrier python 強制 python3；--carrier binary 在沒有預編 binary 的機器上就只走 SSH 的 port。/ --carrier python / binary.
    if common::lab::have("python3") {
        let r = run_script(&script, &bin, &[&["--check", "--auto", "--carrier", "python"][..], &common_args[..]].concat());
        assert_eq!(r.status, 0, "{}", r.out);
        assert!(r.out.contains("carrier: python3") && !r.out.contains("carrier: telepy-carrier"), "{}", r.out);
    }
    let r = run_script(&script, &bin, &[&["--check", "--auto", "--carrier", "nope"][..], &common_args[..]].concat());
    assert!(r.status != 0 && r.out.contains("--carrier must be auto, binary or python"), "{}", r.out);

    // 錯的 port：清楚說沒有 SSH server 在那裡，而不是叫人裝 openssh-server。/ A wrong port is reported as "nothing answers there".
    let r = run_script(&script, &bin, &["--check", "--ssh-port", "1", "--ssh-dir", ssh_dir.to_str().unwrap()]);
    assert!(r.status != 0 && r.out.contains("no SSH server answers on 127.0.0.1:1") && !r.out.contains("apt install"), "{}", r.out);

    // 真的加入。/ The real join.
    let ticket = app.post("/api/reverse/join", Some(&alice.token), json!({"name": "wrt-lab", "key_list": "empty"})).await;
    let token = ticket.json["token"].as_str().unwrap().to_string();
    let r = run_script(&script, &bin, &[&["--token", &token][..], &common_args[..]].concat());
    assert_eq!(r.status, 0, "{}", r.out);
    for needle in ["registered as wrt-lab", "added the service key to", "login verified         yes", "starts at boot         yes (loop", "process running        yes", "tunnel connected       yes"] {
        assert!(r.out.contains(needle), "missing {needle:?} in:\n{}", r.out);
    }
    let r_status = app.get(&format!("/api/join/{token}/status"), None).await;
    assert!(r_status.text.contains("PHASE=verified"), "{}", r_status.text);
    let tunnel_id: i64 = r_status.text.lines().find_map(|l| l.strip_prefix("TUNNEL_ID=")).unwrap().parse().unwrap();
    // 服務金鑰真的進了 lab 機器那個帳號的檔案；Telepy 真的登入過。/ The service key is in the account's file; Telepy really logged in.
    let ak = std::fs::read_to_string(&auth_keys).unwrap();
    assert_eq!(ak.lines().filter(|l| l.starts_with("ssh-ed25519 ")).count(), 1, "{ak}");
    assert!(pi.logins().iter().any(|l| l.user == me), "Telepy's verification login reached the device");
    // 紀錄：裝了什麼、哪裡、以誰執行；沒有 token。/ The record: what, where, as whom; no token.
    let record = std::fs::read_dir(&ssh_dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "install")).expect("install record");
    let rec = std::fs::read_to_string(&record).unwrap();
    for needle in ["SERVICE=loop", "CLIENT=OpenSSH_", "KEY_FORMAT=openssh", "KEEPALIVE=ssh", &format!("AUTHORIZED_KEYS={}", auth_keys.display()), &format!("TUNNEL_ID={tunnel_id}"), "CARRIER=none", "TRANSPORT=ssh"] {
        assert!(rec.contains(needle), "missing {needle:?} in record:\n{rec}");
    }
    assert!(!rec.contains(&token) && !r.out.contains(&token[5..]), "neither the record nor the output shows the token");
    // Telepy 記下了腳本偵測到的環境。/ Telepy recorded what the script found.
    let view = app.get(&format!("/api/reverse/server/{tunnel_id}/device-install"), Some(&alice.token)).await;
    let summary = view.json["join"]["summary"].as_str().unwrap_or("");
    assert!(summary.contains("OpenSSH_") && summary.contains("loop") && summary.contains("keepalive ssh"), "{}", view.text);
    let crontab = std::fs::read_to_string(dir.join("crontab.txt")).unwrap();
    assert!(crontab.contains("@reboot") && crontab.contains(".sh"), "{crontab}");

    // --auto 真的加入：載體與包裝腳本放在金鑰旁、事實說裝了哪種、服務的 ssh 帶 ProxyCommand。
    // A real --auto join: the carrier and its wrapper next to the key, the facts say which one, the service's ssh has the ProxyCommand.
    if cached.is_some() || common::lab::have("python3") {
        let ticket2 = app.post("/api/reverse/join", Some(&alice.token), json!({"name": "wrt-lab-auto", "key_list": "empty", "transport": "auto"})).await;
        let token2 = ticket2.json["token"].as_str().unwrap().to_string();
        let auto_dir = dir.join("ssh-auto");
        let pi_port = pi.port.to_string();
        let auto_args = ["--ssh-port", &pi_port, "--authorized-keys", auth_keys.to_str().unwrap(), "--service", "loop", "--ssh-dir", auto_dir.to_str().unwrap(), "--auto"];
        let r = run_script(&script, &bin, &[&["--token", &token2][..], &auto_args[..]].concat());
        assert_eq!(r.status, 0, "{}", r.out);
        assert!(r.out.contains("login verified         yes") && r.out.contains("the tunnel will connect through ws://"), "{}", r.out);
        let names: Vec<String> = std::fs::read_dir(&auto_dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().any(|n| n.ends_with("-ws.sh")), "the wrapper is there: {names:?}");
        let rec2 = std::fs::read_to_string(auto_dir.join(names.iter().find(|n| n.ends_with(".install")).unwrap())).unwrap();
        let st2 = app.get(&format!("/api/join/{token2}/status"), None).await;
        let tid2: i64 = st2.text.lines().find_map(|l| l.strip_prefix("TUNNEL_ID=")).unwrap().parse().unwrap();
        let view2 = app.get(&format!("/api/reverse/server/{tid2}/device-install"), Some(&alice.token)).await;
        let carrier_fact = view2.json["join"]["facts"]["carrier"].as_str().unwrap_or("").to_string();
        if let Some(target) = cached {
            assert!(names.iter().any(|n| n.ends_with("-ws.bin")) && !names.iter().any(|n| n.ends_with("-ws.py")), "the binary, not the script: {names:?}");
            assert!(rec2.contains("CARRIER=telepy-carrier") && rec2.contains("TRANSPORT=auto"), "{rec2}");
            assert_eq!(carrier_fact, format!("binary {target}"), "{}", view2.text);
        } else {
            assert!(names.iter().any(|n| n.ends_with("-ws.py")), "{names:?}");
            assert!(rec2.contains("CARRIER=python3"), "{rec2}");
            assert_eq!(carrier_fact, "python3", "{}", view2.text);
        }
        let wrapper = std::fs::read_to_string(auto_dir.join(names.iter().find(|n| n.ends_with("-ws.sh")).unwrap())).unwrap();
        assert!(wrapper.contains(&format!("--tcp 127.0.0.1:{} ws://", lab.gw_port)), "{wrapper}");
        let uninstall2 = auto_dir.join(names.iter().find(|n| n.ends_with("-uninstall.sh")).unwrap());
        assert_eq!(run_script(&uninstall2, &bin, &[]).status, 0);
    }

    // 腳本寫的 uninstall：隧道斷、迴圈停、crontab 行走、紀錄與 known_hosts 刪，金鑰留著。
    // The uninstall it wrote: the tunnel drops, the loop stops, the crontab line and the record go, the key stays.
    let uninstall = std::fs::read_dir(&ssh_dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.to_string_lossy().ends_with("-uninstall.sh")).expect("uninstall script");
    let r = run_script(&uninstall, &bin, &[]);
    assert_eq!(r.status, 0, "{}", r.out);
    let port = u16::try_from(telepy_server::db::tunnels::by_id(&app.state.db, tunnel_id).await.unwrap().unwrap().reverse_port).unwrap();
    for _ in 0..100 {
        if !app.state.status.listen_ports().map(|p| p.contains(&port)).unwrap_or(false) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!app.state.status.listen_ports().map(|p| p.contains(&port)).unwrap_or(false), "the tunnel dropped after the uninstall");
    assert!(!record.exists() && !uninstall.exists(), "record and uninstall script removed");
    assert!(ssh_dir.join("telepy_tunnel_ed25519").exists(), "the key is kept");
    assert!(!std::fs::read_to_string(dir.join("crontab.txt")).unwrap().contains("@reboot"), "the crontab line is gone");
}
