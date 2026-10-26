//! 檔案管理的檔案操作（mkdir / 改名 / 搬移 / 複製 / 權限 / 刪除 / 編輯 + 衝突偵測），在 SSH lab 上用真的 sftp-server。
//! 沒有 sftp-server 的環境跳過。
//! File-manager operations end to end on the SSH lab with a real sftp-server; skipped without one.
mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use common::lab::{sftp_server_bin, Lab, MachineOpts};

fn mode_of(p: &Path) -> u32 {
    std::fs::metadata(p).unwrap().permissions().mode() & 0o7777
}

async fn events(lab: &Lab, token: &str, tunnel_id: i64) -> Vec<Value> {
    lab.app.get(&format!("/api/log/ssh/events?tunnel_id={tunnel_id}"), Some(token)).await.json.as_array().cloned().unwrap_or_default()
}

async fn wait_event(lab: &Lab, token: &str, tunnel_id: i64, kind: &str) -> Value {
    for _ in 0..100 {
        if let Some(e) = events(lab, token, tunnel_id).await.into_iter().find(|e| e["event"] == kind) {
            return e;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no {kind} event");
}

#[tokio::test]
async fn file_operations_over_the_shared_sftp_channel() {
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], false).await;
    let home = pc.account_home("ubuntu");
    std::fs::create_dir_all(home.join("docs/nested")).unwrap();
    std::fs::write(home.join("docs/a.txt"), "hello\n").unwrap();
    std::fs::write(home.join("docs/nested/b.txt"), "bee").unwrap();
    std::fs::write(home.join("top.txt"), "top").unwrap();
    std::fs::write(home.join("bin.dat"), b"\x7fELF\0\0\x01").unwrap();
    std::fs::set_permissions(home.join("docs/a.txt"), std::fs::Permissions::from_mode(0o640)).unwrap();
    let dev = lab.device(&alice, "office-pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    let url = |op: &str| format!("/api/sftp/{op}/{id}/ubuntu");
    let tok = Some(alice.token.as_str());

    // mkdir / touch：不覆蓋已存在的東西，名稱要合法。/ mkdir and touch never clobber; names are checked.
    let r = lab.app.post(&url("mkdir"), tok, json!({"path": "~/newdir"})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert!(home.join("newdir").is_dir());
    let r = lab.app.post(&url("mkdir"), tok, json!({"path": "~/newdir"})).await;
    assert_eq!((r.status.as_u16(), r.json["code"].as_str()), (409, Some("exists")));
    let r = lab.app.post(&url("mkdir"), tok, json!({"path": "~/docs/.."})).await;
    assert_eq!(r.json["code"], "invalid_name", "{}", r.text);
    let r = lab.app.post(&url("touch"), tok, json!({"path": "~/newdir/n.txt"})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(std::fs::read(home.join("newdir/n.txt")).unwrap().len(), 0);
    let r = lab.app.post(&url("touch"), tok, json!({"path": "~/top.txt"})).await;
    assert_eq!(r.json["code"], "exists");
    assert_eq!(std::fs::read_to_string(home.join("top.txt")).unwrap(), "top", "touch never truncates");

    // 改名 / 搬移：不覆蓋、資料夾不能搬進自己。/ Rename and move: no overwrite, never into itself.
    let r = lab.app.post(&url("rename"), tok, json!({"from": "~/top.txt", "to": "~/renamed.txt"})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert!(home.join("renamed.txt").exists() && !home.join("top.txt").exists());
    let r = lab.app.post(&url("rename"), tok, json!({"from": "~/renamed.txt", "to": "~/bin.dat"})).await;
    assert_eq!((r.status.as_u16(), r.json["code"].as_str()), (409, Some("exists")));
    let r = lab.app.post(&url("rename"), tok, json!({"paths": ["~/renamed.txt", "~/newdir", "~/docs"], "destination": "~/docs"})).await;
    assert_eq!(r.json["moved"], 2, "{}", r.text);
    assert_eq!(r.json["failed"][0]["code"], "into_itself", "{}", r.text);
    assert!(home.join("docs/renamed.txt").exists() && home.join("docs/newdir/n.txt").exists());
    let r = lab.app.post(&url("rename"), tok, json!({"from": "~", "to": "~/x"})).await;
    assert_eq!(r.json["code"], "protected");

    // 複製：這台沒有 shell（cp → 127），經過後端串流。/ No shell here (cp → 127): streamed through the backend.
    let r = lab.app.post(&url("copy"), tok, json!({"paths": ["~/docs/nested", "~/docs/a.txt"], "destination": "~"})).await;
    assert_eq!((r.json["copied"].as_i64(), r.json["method"].as_str()), (Some(2), Some("stream")), "{}", r.text);
    assert_eq!(std::fs::read_to_string(home.join("nested/b.txt")).unwrap(), "bee");
    assert_eq!(mode_of(&home.join("a.txt")), 0o640, "modes are copied");
    let r = lab.app.post(&url("copy"), tok, json!({"paths": ["~/docs/a.txt"], "destination": "~"})).await;
    assert_eq!(r.json["failed"][0]["code"], "exists");

    // 多選下載：好幾個打成一個 zip。/ Multi-select download: one zip.
    let r = lab.app.post(&url("zip"), tok, json!({"paths": ["~/nested", "~/a.txt"]})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(r.headers.get("content-type").unwrap(), "application/zip");

    // 壓縮過的單檔下載要完整結束（以前串流結束後再被 poll 會 panic，瀏覽器下載卡住）。
    // A compressed single-file download must finish (an unfused stream used to panic when polled after its end).
    std::fs::write(home.join("big.txt"), "telepy ".repeat(4000)).unwrap();
    let http = lab.ws_base().await.replace("ws://", "http://");
    let resp = reqwest::Client::new()
        .get(format!("{http}{}?path=~/big.txt", url("download")))
        .bearer_auth(&alice.token)
        .header("accept-encoding", "gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.headers().get("content-encoding").map(|v| v.to_str().unwrap().to_string()), Some("gzip".into()));
    assert!(!resp.bytes().await.expect("the compressed body ends cleanly").is_empty());

    // 權限：單檔、遞迴（八進位要合法）。/ chmod: one file, recursive, octal checked.
    let r = lab.app.post(&url("chmod"), tok, json!({"paths": ["~/a.txt"], "mode": "600"})).await;
    assert_eq!(r.json["changed"], 1, "{}", r.text);
    assert_eq!(mode_of(&home.join("a.txt")), 0o600);
    let r = lab.app.post(&url("chmod"), tok, json!({"paths": ["~/nested"], "mode": "0750", "recursive": true})).await;
    assert_eq!(r.json["changed"], 2, "{}", r.text);
    assert_eq!((mode_of(&home.join("nested")), mode_of(&home.join("nested/b.txt"))), (0o750, 0o750));
    let r = lab.app.post(&url("chmod"), tok, json!({"paths": ["~/a.txt"], "mode": "rwx"})).await;
    assert_eq!(r.json["code"], "invalid_mode");

    // stat
    let r = lab.app.get(&format!("{}?path=~/docs/a.txt", url("stat")), tok).await;
    assert_eq!((r.json["type"].as_str(), r.json["mode"].as_str(), r.json["size"].as_u64()), (Some("file"), Some("0640"), Some(6)), "{}", r.text);

    // 讀文字檔：二進位、資料夾、太大的都拒絕。/ Text read refuses binaries, folders and big files.
    let r = lab.app.get(&format!("{}?path=~/bin.dat", url("text")), tok).await;
    assert_eq!(r.json["code"], "binary", "{}", r.text);
    let r = lab.app.get(&format!("{}?path=~/docs", url("text")), tok).await;
    assert_eq!(r.json["code"], "is_directory");
    std::fs::write(home.join("big.log"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    let r = lab.app.get(&format!("{}?path=~/big.log", url("text")), tok).await;
    assert_eq!(r.json["code"], "too_large");
    let opened = lab.app.get(&format!("{}?path=~/docs/a.txt", url("text")), tok).await;
    assert_eq!(opened.json["content"], "hello\n", "{}", opened.text);

    // 存檔：暫存檔 + 原子取代，權限照舊，沒有殘留；有人在裝置上改過就 409 modified，force 才覆蓋。
    // Save: temp file + atomic replace, mode kept, nothing left behind; a change on the device → 409, force overwrites.
    let base = json!({"path": "~/docs/a.txt", "mtime": opened.json["mtime_epoch"], "size": opened.json["size"]});
    let mut body = base.clone();
    body["content"] = json!("hello, edited\n");
    let r = lab.app.put(&url("text"), tok, body).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(std::fs::read_to_string(home.join("docs/a.txt")).unwrap(), "hello, edited\n");
    assert_eq!(mode_of(&home.join("docs/a.txt")), 0o640);
    let mut stale = base.clone();
    stale["content"] = json!("mine");
    let r = lab.app.put(&url("text"), tok, stale.clone()).await;
    assert_eq!((r.status.as_u16(), r.json["code"].as_str()), (409, Some("modified")), "{}", r.text);
    assert_eq!(std::fs::read_to_string(home.join("docs/a.txt")).unwrap(), "hello, edited\n", "a conflict writes nothing");
    stale["force"] = json!(true);
    let r = lab.app.put(&url("text"), tok, stale).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(std::fs::read_to_string(home.join("docs/a.txt")).unwrap(), "mine");
    let leftovers: Vec<_> = std::fs::read_dir(home.join("docs")).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".telepy-")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    // symlink：改的是它指到的檔案，連結還在。/ Editing through a link changes the target and keeps the link.
    std::os::unix::fs::symlink(home.join("docs/a.txt"), home.join("link.txt")).unwrap();
    let r = lab.app.put(&url("text"), tok, json!({"path": "~/link.txt", "content": "via link"})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert!(std::fs::symlink_metadata(home.join("link.txt")).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(home.join("docs/a.txt")).unwrap(), "via link");
    let ev = wait_event(&lab, &alice.token, id, "files_edit").await;
    assert!(ev["message"].as_str().unwrap().starts_with("alice edited "), "{ev}");

    // 刪除：先數（dry run），再整棵刪；家目錄受保護；連結只刪連結。/ Delete: count first, then the whole tree.
    let r = lab.app.post(&format!("{}?count=1", url("delete")), tok, json!({"paths": ["~/docs"]})).await;
    assert_eq!((r.json["dirs"].as_u64(), r.json["files"].as_u64()), (Some(3), Some(4)), "{}", r.text);
    assert!(home.join("docs").exists(), "a dry run deletes nothing");
    let r = lab.app.post(&url("delete"), tok, json!({"paths": ["~/link.txt"]})).await;
    assert_eq!(r.json["removed"], 1);
    assert!(home.join("docs/a.txt").exists(), "deleting a link leaves its target");
    let r = lab.app.post(&url("delete"), tok, json!({"paths": ["~/docs"]})).await;
    assert_eq!(r.json["removed"], 7, "{}", r.text);
    assert!(!home.join("docs").exists());
    let r = lab.app.post(&url("delete"), tok, json!({"paths": ["~"]})).await;
    assert_eq!(r.json["code"], "protected");
    let ev = wait_event(&lab, &alice.token, id, "files_delete").await;
    let msg = ev["message"].as_str().unwrap();
    assert!(msg.starts_with("alice deleted ") && msg.contains("as ubuntu"), "{msg}");

    // 同一個 gate：沒有允許帳號的被分享者什麼都不能做。/ Same gate as the terminal: no allowed account, no operation.
    lab.share(&alice, &dev, &bob, "view", &[]).await;
    let r = lab.app.post(&url("delete"), Some(&bob.token), json!({"paths": ["~/a.txt"]})).await;
    assert_eq!(r.status, 400, "{}", r.text);
    assert!(home.join("a.txt").exists());
}

#[tokio::test]
async fn copy_runs_cp_on_a_device_with_a_shell() {
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let pc = lab.machine_with("pc", &[("ubuntu", &[&lab.service])], MachineOpts { shell: true, ..Default::default() }).await;
    let home = pc.account_home("ubuntu");
    std::fs::create_dir_all(home.join("src/inner")).unwrap();
    std::fs::write(home.join("src/inner/x.txt"), "x").unwrap();
    let dev = lab.device(&alice, "box", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let r = lab.app.post(&format!("/api/sftp/copy/{}/ubuntu", dev.tunnel_id), Some(&alice.token), json!({"paths": ["~/src"], "destination": "~/src/inner"})).await;
    assert_eq!(r.json["failed"][0]["code"], "into_itself", "{}", r.text);
    std::fs::create_dir_all(home.join("dst")).unwrap();
    let r = lab.app.post(&format!("/api/sftp/copy/{}/ubuntu", dev.tunnel_id), Some(&alice.token), json!({"paths": ["~/src"], "destination": "~/dst"})).await;
    assert_eq!((r.json["copied"].as_i64(), r.json["method"].as_str()), (Some(1), Some("device")), "{}", r.text);
    assert_eq!(std::fs::read_to_string(home.join("dst/src/inner/x.txt")).unwrap(), "x");
}
