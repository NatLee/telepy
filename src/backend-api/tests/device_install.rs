//! 裝置上的名稱（安裝代號）：盤點記下跑這條隧道的是什麼、改名「先接上再拆舊的」、刪隧道照代號清乾淨。
//! 裝置是真的 `/bin/sh`（HOME / TMPDIR 在暫存目錄），舊服務是一個真的重連迴圈 + 假的 crontab（`<home>/bin`），
//! 永遠不會碰到開發者的 crontab 或 launchd。
//!
//! A tunnel's install names on a real-shell device: the survey records what runs the tunnel, the rename is
//! make-before-break, and deleting the tunnel cleans up by the install id. The old service is a real reconnect loop
//! with a stub crontab in `<home>/bin`, so the developer's crontab and launchd are never touched.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::http::StatusCode;
use common::lab::{Device, Lab, MachineOpts};
use serde_json::Value;
use tokio::process::{Child, Command};

/// 假的 crontab：內容存在 `<home>/crontab.txt`。/ A stub crontab keeping its table in `<home>/crontab.txt`.
fn stub_crontab(home: &Path, lines: &str) {
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let table = home.join("crontab.txt");
    std::fs::write(&table, lines).unwrap();
    // 像真的 crontab：先讀完 stdin 再換掉（`crontab -l | … | crontab -` 不會讀到半空的表）。/ Read all, then swap, like the real one.
    let script = format!("#!/bin/sh\nif [ \"$1\" = -l ]; then cat '{t}' 2>/dev/null; exit 0; fi\nif [ \"$1\" = - ]; then cat > '{t}.new' && mv '{t}.new' '{t}'; exit 0; fi\nexit 1\n", t = table.display());
    write_exec(&bin.join("crontab"), &script);
}

fn write_exec(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// 像 hdre 遷移腳本那樣的舊服務：`~/.ssh/telepy-natlee-loop.sh` 一直重連。/ An older service like the hdre migration's loop.
async fn start_old_loop(lab: &Lab, dev: &Device, home: &Path) -> (PathBuf, Child) {
    let runner = home.join(".ssh/telepy-natlee-loop.sh");
    let log = home.join(".ssh/telepy-natlee.log");
    let body = format!(
        "#!/bin/sh\n# Telepy tunnel (alongside the hdre-proxy.natlee.info one); installed by add-telepy-natlee.sh\nwhile :; do\n    ssh -F /dev/null -N -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=5 -o LogLevel=ERROR -i {} -p {} -R '*:0:127.0.0.1:{}' telepy@127.0.0.1 >> {} 2>&1\n    sleep 1\ndone\n",
        dev.key.path.display(),
        lab.gw_port,
        dev.target.port,
        log.display()
    );
    write_exec(&runner, &body);
    let child = Command::new("/bin/sh").arg(&runner).env("HOME", home).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn().unwrap();
    wait_online(lab, dev, true).await;
    (runner, child)
}

async fn wait_online(lab: &Lab, dev: &Device, up: bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while lab.app.state.status.listen_ports().map(|p| p.contains(&dev.reverse_port)).unwrap_or(false) != up {
        assert!(tokio::time::Instant::now() < deadline, "device never went {}", if up { "online" } else { "offline" });
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// 測試留下的背景程序（新舊迴圈與它們的 ssh）都在暫存 home 底下：照路徑收掉，失敗時也一樣。
/// Stop what the test left running, by its scratch path, also when an assertion fails.
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::process::Command::new("pkill").arg("-f").arg(self.0.to_string_lossy().as_ref()).status();
    }
}

fn events(lab: &Lab) -> Vec<String> {
    let rt = tokio::runtime::Handle::current();
    let db = lab.app.state.db.clone();
    tokio::task::block_in_place(|| rt.block_on(async { sqlx::query_scalar::<_, String>("SELECT event FROM telepy_gateway_event ORDER BY id").fetch_all(&db.read).await.unwrap() }))
}

fn names(v: &Value, key: &str) -> Vec<String> {
    v[key].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
}

fn alive(pattern: &str) -> bool {
    std::process::Command::new("pgrep").arg("-f").arg(pattern).output().map(|o| !o.stdout.is_empty()).unwrap_or(false)
}

#[tokio::test(flavor = "multi_thread")]
async fn survey_rename_and_delete_follow_the_install_id() {
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let opts = MachineOpts { shell: true, ..Default::default() };
    let boxm = lab.machine_with("box", &[("pi", &[&lab.service])], opts).await;
    let home = boxm.account_home("pi");
    let _cleanup = Cleanup(home.clone());
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    let dev = lab.device_requesting(&alice, "box", &boxm, 0).await;
    lab.username(&alice, &dev, "pi").await;
    let id = dev.tunnel_id;
    // 換成一個由迴圈帶著的舊服務（實際上 ssh 的父程序就是它）。/ Replace the lab's ssh with an older-named loop.
    lab.disconnect_device(&dev).await;
    let (old_runner, _old) = start_old_loop(&lab, &dev, &home).await;
    stub_crontab(&home, &format!("0 3 * * * echo keep-me\n@reboot sh {} >/dev/null 2>&1\n", old_runner.display()));
    // 同一把金鑰、連到別台伺服器的腳本：絕對不碰。/ The same key dialing another server: never touched.
    let other = home.join("other-server.sh");
    std::fs::write(&other, format!("ssh -i {} -p 57575 -NR '*:0:localhost:22' telepy@hdre.example\n", dev.key.path.display())).unwrap();

    // 只有擁有者 / ADMIN 看得到。/ Owner and ADMIN only.
    let bob = lab.user("bob").await;
    let r = lab.app.get(&format!("/api/reverse/server/{id}/device-install"), Some(&bob.token)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);

    // 盤點：看到舊迴圈、正在跑的 ssh；別台伺服器的腳本不在裡面。/ Survey: the old loop and the ssh, not the other server's script.
    let r = lab.app.post(&format!("/api/reverse/server/{id}/device-install/survey"), Some(&alice.token), serde_json::json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let v = r.json.clone();
    let install = v["install_id"].as_str().unwrap().to_string();
    assert!(telepy_server::device_install::names::is_id(&install), "{v}");
    assert_eq!(v["names"]["loop"], format!("~/.ssh/telepy-{install}.sh"));
    assert_eq!(names(&v, "older"), vec!["telepy-natlee-loop.sh".to_string()], "{v}");
    let parts = v["parts"].as_array().unwrap();
    assert!(parts.iter().any(|p| p["kind"] == "process"), "{v}");
    assert!(!parts.iter().any(|p| p["name"].as_str().unwrap_or("").contains("other-server")), "another server's script is not this tunnel's: {v}");
    assert_eq!(v["rename"]["possible"], true, "{v}");
    assert_eq!((v["rename"]["method"].as_str(), v["rename"]["account"].as_str()), (Some("loop"), Some("pi")), "{v}");
    // 列表也帶著代號與舊名稱（給擁有者）。/ The list item carries it too, for the owner.
    let list = lab.app.get("/api/reverse/server/keys", Some(&alice.token)).await;
    let item = list.json.as_array().unwrap().iter().find(|t| t["id"] == id).unwrap().clone();
    assert_eq!(item["device_install"]["id"], install.as_str(), "{item}");
    assert_eq!(item["device_install"]["older"][0], "telepy-natlee-loop.sh", "{item}");

    // 改名：先接上新的、再拆舊的；隧道一路都在線。/ Rename, make-before-break; the tunnel stays online throughout.
    let watch = {
        let state = lab.app.state.clone();
        let port = dev.reverse_port;
        tokio::spawn(async move {
            let mut dropped = false;
            for _ in 0..600 {
                if !state.status.listen_ports().map(|p| p.contains(&port)).unwrap_or(false) {
                    dropped = true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            dropped
        })
    };
    let r = lab.app.post(&format!("/api/reverse/server/{id}/device-install/rename"), Some(&alice.token), serde_json::json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let rep = &r.json["report"];
    assert_eq!(rep["ok"], true, "{rep:#}");
    let steps: Vec<(String, String)> = rep["steps"].as_array().unwrap().iter().map(|s| (s["id"].as_str().unwrap().into(), s["state"].as_str().unwrap().into())).collect();
    let want: Vec<(String, String)> = ["survey", "install", "standby", "check", "switch", "remove", "confirm"].iter().map(|s| (s.to_string(), "done".to_string())).collect();
    assert_eq!(steps, want, "{rep:#}");
    assert_eq!(rep["new_name"], format!("telepy-{install}.sh"));
    watch.abort();

    let new_runner = home.join(format!(".ssh/telepy-{install}.sh"));
    let new_kh = home.join(format!(".ssh/telepy-{install}.known_hosts"));
    assert!(new_runner.exists() && new_kh.exists(), "the new loop and its known_hosts were written");
    let kh = std::fs::read_to_string(&new_kh).unwrap();
    assert!(kh.starts_with(&format!("telepy-127.0.0.1-{} ", lab.gw_port)), "the gateway's host keys are pinned: {kh}");
    let runner = std::fs::read_to_string(&new_runner).unwrap();
    assert!(runner.contains("Telepy reverse tunnel ") && !runner.contains("natlee") && runner.contains("'StrictHostKeyChecking=yes'"), "{runner}");
    // 舊的走了：迴圈腳本、它的 log、crontab 那一行、程序；無關的 crontab 行與別台伺服器的腳本還在。
    // The old one is gone (script, its log, crontab line, process); unrelated crontab lines and the other server's script stay.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while old_runner.exists() || alive(&old_runner.to_string_lossy()) || home.join(".ssh/telepy-natlee.log").exists() {
        assert!(tokio::time::Instant::now() < deadline, "the old loop was left behind");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let cron = std::fs::read_to_string(home.join("crontab.txt")).unwrap();
    assert!(cron.contains("keep-me") && cron.contains(&format!("@reboot sh {} >/dev/null 2>&1", new_runner.display())) && !cron.contains("natlee"), "{cron}");
    assert!(other.exists(), "another server's script stays");
    assert!(alive(&new_runner.to_string_lossy()), "the new loop runs");
    wait_online(&lab, &dev, true).await;
    let ev = events(&lab);
    for kind in ["standby_forward", "handover", "service_renamed"] {
        assert!(ev.iter().any(|e| e == kind), "{kind} event: {ev:?}");
    }
    assert!(!ev.iter().skip_while(|e| *e != "standby_forward").any(|e| e == "forward_released"), "the forward was never released during the switch: {ev:?}");

    // 再看一次：都是新名稱了，沒什麼要改。/ Surveyed again: everything is private now.
    let v = &r.json["view"];
    assert!(names(v, "older").is_empty(), "{v}");
    assert_eq!(v["rename"]["blocker"], "nothing_to_rename", "{v}");
    assert!(v["parts"].as_array().unwrap().iter().any(|p| p["kind"] == "service" && p["private"] == true), "{v}");
    assert_eq!(v["renamed_from"][0], "telepy-natlee-loop.sh");

    // 刪隧道（連裝置上的服務）：照代號清掉新迴圈、known_hosts、crontab 行。/ Delete with the service: cleaned up by the install id.
    let r = lab.app.delete(&format!("/api/reverse/server/keys/{id}?remove_device_keys=true&remove_service=true"), Some(&alice.token)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["service"]["stopped"], true, "{}", r.json["service"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while new_runner.exists() || new_kh.exists() || alive(&new_runner.to_string_lossy()) {
        assert!(tokio::time::Instant::now() < deadline, "the renamed service was left behind: {}", r.json["service"]);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let cron = std::fs::read_to_string(home.join("crontab.txt")).unwrap();
    assert!(cron.contains("keep-me") && !cron.contains("telepy-"), "{cron}");
    assert!(other.exists(), "another server's script stays after the delete too");
    let gone = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM telepy_device_install WHERE tunnel_id = ?").bind(id).fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(gone, 0, "the record goes with the tunnel");
}

/// 新服務連不上：剛裝的拆掉、舊的沒動、隧道一直在線。/ The new service cannot connect: it is undone, the old one untouched.
#[tokio::test(flavor = "multi_thread")]
async fn a_rename_that_cannot_connect_is_undone() {
    let Some(lab) = Lab::start().await else { return };
    telepy_server::device_install::set_standby_wait(Duration::from_secs(8));
    let alice = lab.user("alice").await;
    let opts = MachineOpts { shell: true, ..Default::default() };
    let boxm = lab.machine_with("box", &[("pi", &[&lab.service])], opts).await;
    let home = boxm.account_home("pi");
    let _cleanup = Cleanup(home.clone());
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    let dev = lab.device_requesting(&alice, "box", &boxm, 0).await;
    lab.username(&alice, &dev, "pi").await;
    lab.disconnect_device(&dev).await;
    let (old_runner, _old) = start_old_loop(&lab, &dev, &home).await;
    stub_crontab(&home, &format!("@reboot sh {} >/dev/null 2>&1\n", old_runner.display()));
    // 新服務會在 PATH 找到這個壞掉的 ssh（舊迴圈是測試自己起的，看不到它）。/ The new service finds a broken ssh first.
    write_exec(&home.join("bin/ssh"), "#!/bin/sh\necho 'ssh: connect to host 127.0.0.1: Connection refused' >&2\nexit 255\n");

    let r = lab.app.post(&format!("/api/reverse/server/{}/device-install/rename", dev.tunnel_id), Some(&alice.token), serde_json::json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let rep = &r.json["report"];
    assert_eq!((rep["ok"].as_bool(), rep["code"].as_str()), (Some(false), Some("standby_timeout")), "{rep:#}");
    assert!(rep["log"].as_str().unwrap_or("").contains("Connection refused"), "the new service's own log explains it: {rep:#}");
    assert!(rep["undo"].as_array().unwrap().iter().any(|i| i["kind"] == "done"), "{rep:#}");
    let install = r.json["view"]["install_id"].as_str().unwrap().to_string();
    assert!(!home.join(format!(".ssh/telepy-{install}.sh")).exists() && !home.join(format!(".ssh/telepy-{install}.known_hosts")).exists(), "the new files are gone");
    assert!(old_runner.exists() && alive(&old_runner.to_string_lossy()), "the old service was never touched");
    let cron = std::fs::read_to_string(home.join("crontab.txt")).unwrap();
    assert!(cron.contains("telepy-natlee-loop.sh") && !cron.contains(&install), "{cron}");
    assert!(lab.app.state.status.listen_ports().map(|p| p.contains(&dev.reverse_port)).unwrap_or(false), "still online");
    assert_eq!(lab.app.state.gateway.standby_conn(u16::try_from(dev.reverse_port).unwrap()), None);
}
