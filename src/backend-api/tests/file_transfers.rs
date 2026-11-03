//! 檔案管理的下載與上傳，在 SSH lab 上用真的 sftp-server：
//! - 資料夾 = 邊打包邊送的 zip（連結存成連結、讀不到的列在 TELEPY-SKIPPED.txt、不壓縮回應、中文檔名）；
//! - 一次性下載連結（只能用一次、打開時再檢查權限）；
//! - 分段上傳（建上層資料夾、續傳、重送、同名不覆蓋 / 覆蓋時沿用權限、取消、完成才改名）。
//! 沒有 sftp-server 的環境跳過。
//! Downloads and uploads end to end on the SSH lab with a real sftp-server; skipped without one.
mod common;

use std::io::{Cursor, Read};
use std::os::unix::fs::PermissionsExt;

use serde_json::{json, Value};

use common::lab::{sftp_server_bin, Lab};

fn mode_of(p: &std::path::Path) -> u32 {
    std::fs::metadata(p).unwrap().permissions().mode() & 0o7777
}

fn header(resp: &reqwest::Response, name: &str) -> Option<String> {
    resp.headers().get(name).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

#[tokio::test]
async fn folders_stream_as_zips_through_one_time_links() {
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], false).await;
    let home = pc.account_home("ubuntu");
    let big = pattern(700 * 1024);
    std::fs::create_dir_all(home.join("docs/照片")).unwrap();
    std::fs::create_dir_all(home.join("docs/empty")).unwrap();
    std::fs::write(home.join("docs/a.txt"), "hello").unwrap();
    std::fs::write(home.join("docs/照片/b.bin"), &big).unwrap();
    std::fs::write(home.join("docs/secret.txt"), "no").unwrap();
    std::fs::set_permissions(home.join("docs/secret.txt"), std::fs::Permissions::from_mode(0o000)).unwrap();
    std::os::unix::fs::symlink("a.txt", home.join("docs/link")).unwrap();
    std::os::unix::fs::symlink("/nowhere/at/all", home.join("docs/broken")).unwrap();
    std::fs::write(home.join("報告.txt"), "中文").unwrap();
    let dev = lab.device(&alice, "office-pc", &pc).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    let url = |op: &str| format!("/api/sftp/{op}/{id}/ubuntu");
    let tok = Some(alice.token.as_str());
    let http = lab.ws_base().await.replace("ws://", "http://");
    let client = reqwest::Client::new();

    // 資料夾 → 一次性連結 → 瀏覽器（沒有 Authorization）打開 → 串流 zip。
    // A folder → a one-time link → opened without Authorization → a streamed zip.
    let r = lab.app.post(&url("download-link"), tok, json!({"paths": ["~/docs"]})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!((r.json["zip"].as_bool(), r.json["name"].as_str(), r.json["size"].clone()), (Some(true), Some("docs.zip"), Value::Null), "{}", r.text);
    let link = r.json["url"].as_str().unwrap().to_string();
    assert!(link.starts_with("/api/sftp/fetch/tpd_"), "{link}");
    let (starts, sessions) = (pc.sftp_starts(), pc.open_sessions());
    let resp = client.get(format!("{http}{link}")).header("accept-encoding", "gzip, br").send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(header(&resp, "content-type").as_deref(), Some("application/zip"));
    assert_eq!(header(&resp, "content-encoding"), None, "downloads are never compressed on the way");
    assert!(header(&resp, "content-disposition").unwrap().contains("filename*=UTF-8''docs.zip"));
    assert_eq!(header(&resp, "cache-control").as_deref(), Some("no-store, no-transform"));
    let bytes = resp.bytes().await.unwrap();
    // 下載走自己的 sftp channel（列目錄那條不必排隊），結束就關。/ The download had its own SFTP channel, closed after.
    assert_eq!(pc.sftp_starts(), starts + 1, "a channel of its own");
    for _ in 0..50 {
        if pc.open_sessions() == sessions {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(pc.open_sessions(), sessions, "and it closed when the download ended");
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
    let mut names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["TELEPY-SKIPPED.txt", "docs/", "docs/a.txt", "docs/broken", "docs/empty/", "docs/link", "docs/照片/", "docs/照片/b.bin"]);
    let read = |zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str| {
        let mut out = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut out).unwrap();
        out
    };
    assert_eq!(read(&mut zip, "docs/a.txt"), b"hello");
    assert_eq!(read(&mut zip, "docs/照片/b.bin"), big, "a file bigger than one chunk arrives whole");
    // 連結以連結存（不跟著走，壞掉的也照存）。/ Links are stored as links, dangling ones too.
    assert!(zip.by_name("docs/link").unwrap().is_symlink());
    assert_eq!(read(&mut zip, "docs/link"), b"a.txt");
    assert_eq!(read(&mut zip, "docs/broken"), b"/nowhere/at/all");
    // 讀不到的跳過並寫明，不會讓整包失敗。/ The unreadable file is skipped and noted, not fatal.
    let note = String::from_utf8(read(&mut zip, "TELEPY-SKIPPED.txt")).unwrap();
    assert!(note.contains("docs/secret.txt: "), "{note}");

    // 只能用一次。/ Single use.
    let again = client.get(format!("{http}{link}")).send().await.unwrap();
    assert_eq!(again.status(), 404);
    assert!(again.text().await.unwrap().contains("expired or was already used"));

    // 單一檔案：有 Content-Length、中文檔名用 filename*。/ One file: Content-Length, and a UTF-8 filename*.
    let r = lab.app.post(&url("download-link"), tok, json!({"paths": ["~/報告.txt"]})).await;
    assert_eq!((r.json["zip"].as_bool(), r.json["size"].as_u64(), r.json["name"].as_str()), (Some(false), Some(6), Some("報告.txt")), "{}", r.text);
    let resp = client.get(format!("{http}{}", r.json["url"].as_str().unwrap())).send().await.unwrap();
    assert_eq!(header(&resp, "content-length").as_deref(), Some("6"));
    assert!(header(&resp, "content-disposition").unwrap().ends_with("filename*=UTF-8''%E5%A0%B1%E5%91%8A.txt"));
    assert_eq!(resp.text().await.unwrap(), "中文");

    // 不存在的路徑在發連結時就說。/ A missing path is refused when the link is made.
    let r = lab.app.post(&url("download-link"), tok, json!({"paths": ["~/nope"]})).await;
    assert_eq!((r.status.as_u16(), r.json["code"].as_str()), (404, Some("not_found")), "{}", r.text);

    // 打開時再檢查權限：發完連結後被取消分享 = 404。/ Access is checked again on use: unshared meanwhile = 404.
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let r = lab.app.post(&url("download-link"), Some(&bob.token), json!({"paths": ["~/docs/a.txt"]})).await;
    assert_eq!(r.status, 200, "{}", r.text);
    let bobs = r.json["url"].as_str().unwrap().to_string();
    let r = lab.app.delete(&format!("/tunnels/unshare/{id}/{}", bob.id), tok).await;
    assert!(r.status.is_success(), "{}", r.text);
    assert_eq!(client.get(format!("{http}{bobs}")).send().await.unwrap().status(), 404);

    // 舊的端點（CLI / API token 用）也是串流 zip、不壓縮。/ The older endpoints stream too, uncompressed.
    let resp = client.get(format!("{http}{}?path=~/docs/照片", url("download"))).bearer_auth(&alice.token).header("accept-encoding", "gzip").send().await.unwrap();
    assert_eq!((resp.status().as_u16(), header(&resp, "content-encoding")), (200, None));
    let mut z = zip::ZipArchive::new(Cursor::new(resp.bytes().await.unwrap().to_vec())).unwrap();
    assert_eq!(read(&mut z, "照片/b.bin"), big);
    let resp = client.get(format!("{http}{}?path=~/docs/a.txt", url("download"))).bearer_auth(&alice.token).header("accept-encoding", "gzip").send().await.unwrap();
    assert_eq!((header(&resp, "content-encoding"), header(&resp, "content-length").as_deref()), (None, Some("5")));
    assert_eq!(resp.text().await.unwrap(), "hello");
    let resp = client.post(format!("{http}{}", url("zip"))).bearer_auth(&alice.token).json(&json!({"paths": ["~/docs/a.txt", "~/報告.txt"]})).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert!(header(&resp, "content-disposition").unwrap().contains("filename*=UTF-8''docs.zip"), "named after the first one's folder");
    let mut z = zip::ZipArchive::new(Cursor::new(resp.bytes().await.unwrap().to_vec())).unwrap();
    assert_eq!(read(&mut z, "報告.txt"), "中文".as_bytes());
    let r = lab.app.post(&url("zip"), tok, json!({"paths": ["~/docs/a.txt", "~/gone"]})).await;
    assert_eq!(r.json["code"], "not_found", "a missing path is an error before streaming starts: {}", r.text);
    std::fs::set_permissions(home.join("docs/secret.txt"), std::fs::Permissions::from_mode(0o600)).unwrap();
}

#[tokio::test]
async fn uploads_go_in_parts_and_land_only_when_complete() {
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], false).await;
    let home = pc.account_home("ubuntu");
    let dev = lab.device(&alice, "office-pc", &pc).await;
    lab.username(&alice, &dev, "ubuntu").await;
    let id = dev.tunnel_id;
    let http = lab.ws_base().await.replace("ws://", "http://");
    let client = reqwest::Client::new();
    let base = format!("{http}/api/sftp/upload-part/{id}/ubuntu");
    let put = |query: String, body: Vec<u8>| {
        let req = client.put(format!("{base}?{query}")).bearer_auth(&alice.token).body(body);
        async move {
            let resp = req.send().await.unwrap();
            let status = resp.status().as_u16();
            let json: Value = resp.json().await.unwrap_or(Value::Null);
            (status, json)
        }
    };
    let data = pattern(20_000);
    let q = |offset: usize, extra: &str| format!("path=~/up/new/x.bin&upload=abcd1234&offset={offset}&total=20000{extra}");

    // 第一段：建上層資料夾、寫進隱藏的暫存檔；目標還不存在。/ First part: parents made, a hidden part file, no target yet.
    let (s, j) = put(q(0, "&parents=1"), data[..8000].to_vec()).await;
    assert_eq!((s, j["received"].as_u64(), j["done"].as_bool()), (200, Some(8000), Some(false)), "{j}");
    assert!(home.join("up/new/.x.bin.telepy-upload-abcd1234.part").exists());
    assert!(!home.join("up/new/x.bin").exists());
    // 跳過一段 → 409 + 裝置上有多少，從那裡接。/ A skipped part → 409 with how much the device has.
    let (s, j) = put(q(16000, ""), data[16000..].to_vec()).await;
    assert_eq!((s, j["code"].as_str(), j["received"].as_u64()), (409, Some("upload_offset"), Some(8000)), "{j}");
    // 第二段，再重送一次（同一段寫兩次沒關係）。/ Second part, then the same part again (idempotent).
    for _ in 0..2 {
        let (s, j) = put(q(8000, ""), data[8000..16000].to_vec()).await;
        assert_eq!((s, j["received"].as_u64()), (200, Some(16000)), "{j}");
    }
    // 最後一段：完成才改名成目標，暫存檔不留。/ The last part renames it onto the target; no part file left.
    let (s, j) = put(q(16000, ""), data[16000..].to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(true)), "{j}");
    assert!(j["path"].as_str().unwrap().ends_with("/up/new/x.bin"), "{j}");
    assert_eq!(std::fs::read(home.join("up/new/x.bin")).unwrap(), data);
    let leftovers: Vec<_> = std::fs::read_dir(home.join("up/new")).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".telepy-")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    // 最後一段的回覆丟了、重送：已經完成。/ The last part resent after its answer was lost: already done.
    let (s, j) = put(q(16000, ""), data[16000..].to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(true)), "{j}");

    // 同名不覆蓋（原檔不動）；覆蓋時沿用原本的權限。/ No overwrite by default; overwriting keeps the mode.
    let one = |upload: &str, extra: &str| format!("path=~/up/new/x.bin&upload={upload}&offset=0&total=3{extra}");
    let (s, j) = put(one("efgh5678", ""), b"abc".to_vec()).await;
    assert_eq!((s, j["code"].as_str()), (409, Some("exists")), "{j}");
    assert_eq!(std::fs::read(home.join("up/new/x.bin")).unwrap(), data, "the existing file is untouched");
    std::fs::set_permissions(home.join("up/new/x.bin"), std::fs::Permissions::from_mode(0o640)).unwrap();
    let (s, j) = put(one("efgh5678", "&overwrite=1"), b"abc".to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(true)), "{j}");
    assert_eq!(std::fs::read(home.join("up/new/x.bin")).unwrap(), b"abc");
    assert_eq!(mode_of(&home.join("up/new/x.bin")), 0o640);
    // 覆蓋一個 symlink：改的是它指到的檔案，連結還在。/ Overwriting through a link replaces its target, the link stays.
    std::os::unix::fs::symlink("new/x.bin", home.join("up/alias.bin")).unwrap();
    let (s, j) = put("path=~/up/alias.bin&upload=link0001&offset=0&total=4&overwrite=1".into(), b"via!".to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(true)), "{j}");
    assert!(std::fs::symlink_metadata(home.join("up/alias.bin")).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read(home.join("up/new/x.bin")).unwrap(), b"via!");
    std::fs::write(home.join("up/new/x.bin"), b"abc").unwrap();
    // 只有一段的檔案、回覆丟了再送（retry=1）：不會被當成「已經存在」。/ A one-part retry isn't "exists".
    let (s, j) = put(one("ijkl9012", "&retry=1"), b"abc".to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(true)), "{j}");

    // 暫存檔不見了 → 從頭來；多送的資料、壞的 id 都拒絕。/ A lost part file → start again; bad input is refused.
    let (s, j) = put("path=~/up/y.bin&upload=zzzz9999&offset=5&total=10".into(), b"12345".to_vec()).await;
    assert_eq!((s, j["code"].as_str()), (409, Some("upload_gone")), "{j}");
    let (s, j) = put("path=~/up/y.bin&upload=zzzz9999&offset=0&total=3".into(), b"12345".to_vec()).await;
    assert_eq!((s, j["code"].as_str()), (400, Some("bad_offset")), "{j}");
    let (s, j) = put("path=~/up/y.bin&upload=../../x&offset=0&total=3".into(), b"123".to_vec()).await;
    assert_eq!((s, j["code"].as_str()), (400, Some("bad_upload")), "{j}");
    let (s, j) = put("path=~/up&upload=zzzz9999&offset=0&total=3&overwrite=1".into(), b"123".to_vec()).await;
    assert_eq!((s, j["code"].as_str()), (409, Some("is_directory")), "{j}");

    // 取消：暫存檔刪掉。/ Cancel removes the part file.
    let (s, _) = put("path=~/up/c.bin&upload=cancel01&offset=0&total=10".into(), b"12345".to_vec()).await;
    assert_eq!(s, 200);
    assert!(home.join("up/.c.bin.telepy-upload-cancel01.part").exists());
    let r = lab.app.delete(&format!("/api/sftp/upload-part/{id}/ubuntu?path=~/up/c.bin&upload=cancel01"), Some(&alice.token)).await;
    assert_eq!(r.json["removed"], true, "{}", r.text);
    assert!(!home.join("up/.c.bin.telepy-upload-cancel01.part").exists() && !home.join("up/c.bin").exists());

    // 舊的 multipart 上傳也是先寫暫存檔再改名，並回傳放到哪裡。/ The multipart upload also lands via a part file.
    let form = "--tpb\r\nContent-Disposition: form-data; name=\"file\"; filename=\"m.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nmulti\r\n--tpb--\r\n";
    let resp = client
        .post(format!("{http}/api/sftp/upload/{id}/ubuntu?destination_path=~/up"))
        .bearer_auth(&alice.token)
        .header("content-type", "multipart/form-data; boundary=tpb")
        .body(form)
        .send()
        .await
        .unwrap();
    let j: Value = resp.json().await.unwrap();
    assert!(j["path"].as_str().unwrap().ends_with("/up/m.txt"), "{j}");
    assert_eq!(std::fs::read_to_string(home.join("up/m.txt")).unwrap(), "multi");
}

fn sha_hex(data: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// 帳本那筆的最後動作改成 `ago` 之前（模擬時間過去）。/ Pretend an upload's last activity was `ago` ago.
async fn age(lab: &Lab, upload: &str, ago: chrono::Duration) {
    sqlx::query("UPDATE telepy_upload_part SET updated_at = ? WHERE upload = ?")
        .bind(telepy_server::util::db_time(chrono::Utc::now() - ago))
        .bind(upload)
        .execute(&lab.app.state.db.write)
        .await
        .unwrap();
}

async fn ledger_rows(lab: &Lab) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM telepy_upload_part").fetch_one(&lab.app.state.db.read).await.unwrap()
}

#[tokio::test]
async fn unfinished_uploads_resume_safely_and_are_cleaned() {
    if sftp_server_bin().is_none() {
        eprintln!("skipping: no sftp-server");
        return;
    }
    let Some(lab) = Lab::start().await else { return };
    let alice = lab.user("alice").await;
    let bob = lab.user("bob").await;
    let pc = lab.machine("pc", &[("ubuntu", &[&lab.service])], false).await;
    let home = pc.account_home("ubuntu");
    let dev = lab.device(&alice, "office-pc", &pc).await;
    let ubuntu = lab.username(&alice, &dev, "ubuntu").await;
    lab.share(&alice, &dev, &bob, "view", &[ubuntu]).await;
    let id = dev.tunnel_id;
    let http = lab.ws_base().await.replace("ws://", "http://");
    let client = reqwest::Client::new();
    let start = |token: &str, body: Value| {
        let req = client.post(format!("{http}/api/sftp/upload-start/{id}/ubuntu")).bearer_auth(token).json(&body);
        async move {
            let r = req.send().await.unwrap();
            (r.status().as_u16(), r.json::<Value>().await.unwrap_or(Value::Null))
        }
    };
    let put = |token: &str, query: String, body: Vec<u8>| {
        let req = client.put(format!("{http}/api/sftp/upload-part/{id}/ubuntu?{query}")).bearer_auth(token).body(body);
        async move {
            let r = req.send().await.unwrap();
            (r.status().as_u16(), r.json::<Value>().await.unwrap_or(Value::Null))
        }
    };
    let q = |path: &str, j: &Value, offset: usize, total: usize, extra: &str| {
        format!("path={path}&upload={}&lease={}&offset={offset}&total={total}{extra}", j["upload"].as_str().unwrap(), j["lease"].as_str().unwrap())
    };
    let part_of = |j: &Value, name: &str| home.join(format!(".{name}.telepy-upload-{}.part", j["upload"].as_str().unwrap()));
    let data = pattern(30_000);
    let local = json!({"name": "big.iso", "modified": 1_700_000_000_000i64});

    // 開始、傳第一段，然後「分頁關掉」。/ Start, send a part, then the tab closes.
    let (s, a) = start(&alice.token, json!({"path": "~/big.iso", "total": 30000, "local": local})).await;
    assert_eq!((s, a["resumed"].as_bool(), a["offset"].as_u64()), (200, Some(false), Some(0)), "{a}");
    let (s, j) = put(&alice.token, q("~/big.iso", &a, 0, 30000, ""), data[..10_000].to_vec()).await;
    assert_eq!((s, j["received"].as_u64()), (200, Some(10_000)), "{j}");

    // 剛剛還在寫 = 另一個視窗正在傳：不給續傳。/ Written just now = another window is on it: no takeover.
    let (s, j) = start(&alice.token, json!({"path": "~/big.iso", "total": 30000, "local": local})).await;
    assert_eq!((s, j["code"].as_str()), (409, Some("upload_busy")), "{j}");
    // 同一個視窗帶著自己的 lease 回來可以。/ The same window, with its lease, may continue.
    let (s, j) = start(&alice.token, json!({"path": "~/big.iso", "total": 30000, "local": local, "lease": a["lease"]})).await;
    assert_eq!((s, j["resumed"].as_bool(), j["offset"].as_u64()), (200, Some(true), Some(10_000)), "{j}");
    let own = j;

    // 閒置之後另一個視窗接手：同一個上傳、從 10000 接；舊視窗的 lease 失效。
    // Idle, then another window takes over at 10000; the old window's lease is void.
    age(&lab, a["upload"].as_str().unwrap(), chrono::Duration::minutes(2)).await;
    let (s, b) = start(&alice.token, json!({"path": "~/big.iso", "total": 30000, "local": local})).await;
    assert_eq!((s, b["resumed"].as_bool(), b["upload"].clone(), b["offset"].as_u64(), b["check_from"].as_u64()), (200, Some(true), a["upload"].clone(), Some(10_000), Some(0)), "{b}");
    let (s, j) = put(&alice.token, q("~/big.iso", &own, 10_000, 30000, ""), data[10_000..20_000].to_vec()).await;
    assert_eq!((s, j["code"].as_str()), (409, Some("upload_taken")), "the earlier window stops: {j}");
    // 比對不合（本機其實是另一個檔案）：刪掉暫存檔，從頭來。/ A mismatch (a different local file): removed, start over.
    let wrong = sha_hex(&pattern(10_000)[..9_999]);
    let (s, j) = put(&alice.token, q("~/big.iso", &b, 10_000, 30000, &format!("&check={wrong}")), data[10_000..20_000].to_vec()).await;
    assert_eq!((s, j["code"].as_str()), (409, Some("upload_mismatch")), "{j}");
    assert!(!part_of(&b, "big.iso").exists() && ledger_rows(&lab).await == 0);
    let (s, c) = start(&alice.token, json!({"path": "~/big.iso", "total": 30000, "local": local})).await;
    assert_eq!((s, c["resumed"].as_bool()), (200, Some(false)), "nothing left to resume: {c}");
    assert_ne!(c["upload"], a["upload"]);

    // 正常續傳：比對相符就接著傳，傳完帳本清空。/ A real resume: the check matches, it finishes, the ledger empties.
    let (s, _) = put(&alice.token, q("~/big.iso", &c, 0, 30000, ""), data[..10_000].to_vec()).await;
    assert_eq!(s, 200);
    age(&lab, c["upload"].as_str().unwrap(), chrono::Duration::minutes(2)).await;
    let (s, r) = start(&alice.token, json!({"path": "~/big.iso", "total": 30000, "local": local})).await;
    assert_eq!((s, r["resumed"].as_bool(), r["offset"].as_u64()), (200, Some(true), Some(10_000)), "{r}");
    let check = sha_hex(&data[..10_000]);
    let (s, j) = put(&alice.token, q("~/big.iso", &r, 10_000, 30000, &format!("&check={check}")), data[10_000..20_000].to_vec()).await;
    assert_eq!((s, j["received"].as_u64()), (200, Some(20_000)), "{j}");
    let (s, j) = put(&alice.token, q("~/big.iso", &r, 20_000, 30000, ""), data[20_000..].to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(true)), "{j}");
    assert_eq!(std::fs::read(home.join("big.iso")).unwrap(), data);
    assert_eq!(ledger_rows(&lab).await, 0, "a finished upload leaves no entry");

    // 裝置上的暫存檔被刪了：帳本那筆丟掉，從頭來。/ The part file was deleted on the device: dropped, start over.
    let lc = json!({"name": "c.iso", "modified": 1});
    let (_, c1) = start(&alice.token, json!({"path": "~/c.iso", "total": 30000, "local": lc})).await;
    put(&alice.token, q("~/c.iso", &c1, 0, 30000, ""), data[..10_000].to_vec()).await;
    age(&lab, c1["upload"].as_str().unwrap(), chrono::Duration::minutes(2)).await;
    std::fs::remove_file(part_of(&c1, "c.iso")).unwrap();
    let (s, c2) = start(&alice.token, json!({"path": "~/c.iso", "total": 30000, "local": lc})).await;
    assert_eq!((s, c2["resumed"].as_bool(), c2["offset"].as_u64()), (200, Some(false), Some(0)), "{c2}");
    // 本機檔案改過（修改時間不同）：不會接到舊的上，舊的留在清單裡可以捨棄。
    // The local file changed (another mtime): never resumed onto the old one, which stays listed to discard.
    put(&alice.token, q("~/c.iso", &c2, 0, 30000, ""), data[..10_000].to_vec()).await;
    age(&lab, c2["upload"].as_str().unwrap(), chrono::Duration::minutes(2)).await;
    let (s, c3) = start(&alice.token, json!({"path": "~/c.iso", "total": 30000, "local": {"name": "c.iso", "modified": 2}})).await;
    assert_eq!((s, c3["resumed"].as_bool()), (200, Some(false)), "{c3}");
    let r = lab.app.get(&format!("/api/sftp/uploads/{id}/ubuntu?dir=~"), Some(&alice.token)).await;
    let listed: Vec<&str> = r.json["uploads"].as_array().unwrap().iter().map(|u| u["upload"].as_str().unwrap()).collect();
    assert!(listed.contains(&c2["upload"].as_str().unwrap()), "{}", r.text);
    let old = r.json["uploads"].as_array().unwrap().iter().find(|u| u["upload"] == c2["upload"]).unwrap().clone();
    assert_eq!((old["mine"].as_bool(), old["received"].as_i64(), old["active"].as_bool()), (Some(true), Some(10_000), Some(false)), "the size as the device has it: {old}");
    // 清單照裝置上的樣子：暫存檔被刪掉的那筆不再列出，帳本也拿掉。/ The list follows the device: a vanished part drops out.
    let (_, gone) = start(&alice.token, json!({"path": "~/gone.iso", "total": 30000, "local": {"name": "gone.iso", "modified": 3}})).await;
    put(&alice.token, q("~/gone.iso", &gone, 0, 30000, ""), data[..10_000].to_vec()).await;
    age(&lab, gone["upload"].as_str().unwrap(), chrono::Duration::minutes(2)).await;
    std::fs::remove_file(part_of(&gone, "gone.iso")).unwrap();
    let r = lab.app.get(&format!("/api/sftp/uploads/{id}/ubuntu?dir=~"), Some(&alice.token)).await;
    assert!(!r.text.contains(gone["upload"].as_str().unwrap()), "{}", r.text);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_upload_part WHERE upload = ?").bind(gone["upload"].as_str().unwrap()).fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(left, 0);

    // 兩個人傳同名的檔案：各自的暫存檔，互不續傳、互不能寫。/ Two people, same name: separate part files, no crossing.
    let same = json!({"name": "same.bin", "modified": 5});
    let (_, x) = start(&alice.token, json!({"path": "~/same.bin", "total": 30000, "local": same})).await;
    let (_, y) = start(&bob.token, json!({"path": "~/same.bin", "total": 30000, "local": same})).await;
    assert_ne!(x["upload"], y["upload"]);
    put(&alice.token, q("~/same.bin", &x, 0, 30000, ""), data[..10_000].to_vec()).await;
    let bobs = pattern(30_007)[7..].to_vec();
    put(&bob.token, q("~/same.bin", &y, 0, 30000, ""), bobs[..10_000].to_vec()).await;
    let (s, j) = put(&alice.token, q("~/same.bin", &y, 10_000, 30000, ""), data[10_000..20_000].to_vec()).await;
    assert_eq!((s, j["code"].as_str()), (409, Some("upload_taken")), "alice can't write bob's upload: {j}");
    for u in [&x, &y] {
        age(&lab, u["upload"].as_str().unwrap(), chrono::Duration::minutes(2)).await;
    }
    let (s, j) = start(&alice.token, json!({"path": "~/same.bin", "total": 30000, "local": same})).await;
    assert_eq!((s, j["upload"].clone()), (200, x["upload"].clone()), "alice resumes her own, never bob's: {j}");
    let r = lab.app.delete(&format!("/api/sftp/upload-part/{id}/ubuntu?path=~/same.bin&upload={}", x["upload"].as_str().unwrap()), Some(&bob.token)).await;
    assert_eq!((r.status.as_u16(), r.json["code"].as_str()), (403, Some("not_yours")), "{}", r.text);
    // alice 先完成；bob 完成時同名已存在：他的暫存檔留著，選擇取代就用他的內容，不必重傳。
    // Alice finishes first; Bob's finish finds the name taken: his part waits, and replacing needs no re-upload.
    let x2 = j;
    put(&alice.token, q("~/same.bin", &x2, 10_000, 30000, ""), data[10_000..20_000].to_vec()).await;
    let (s, _) = put(&alice.token, q("~/same.bin", &x2, 20_000, 30000, ""), data[20_000..].to_vec()).await;
    assert_eq!(s, 200);
    age(&lab, y["upload"].as_str().unwrap(), chrono::Duration::minutes(2)).await;
    let y2 = start(&bob.token, json!({"path": "~/same.bin", "total": 30000, "local": same, "overwrite": true})).await.1;
    assert_eq!((y2["resumed"].as_bool(), y2["offset"].as_u64()), (Some(true), Some(10_000)), "{y2}");
    put(&bob.token, q("~/same.bin", &y2, 10_000, 30000, &format!("&check={}", sha_hex(&bobs[..10_000]))), bobs[10_000..20_000].to_vec()).await;
    let (s, j) = put(&bob.token, q("~/same.bin", &y2, 20_000, 30000, ""), bobs[20_000..].to_vec()).await;
    assert_eq!((s, j["code"].as_str(), j["kept"].as_bool()), (409, Some("exists"), Some(true)), "{j}");
    assert!(part_of(&y2, "same.bin").exists(), "bob's upload is kept");
    assert_eq!(std::fs::read(home.join("same.bin")).unwrap(), data, "alice's file is untouched");
    let (s, j) = put(&bob.token, q("~/same.bin", &y2, 20_000, 30000, "&overwrite=1"), bobs[20_000..].to_vec()).await;
    assert_eq!((s, j["done"].as_bool()), (200, Some(true)), "replace = resend the last part: {j}");
    assert_eq!(std::fs::read(home.join("same.bin")).unwrap(), bobs);

    // 清理：閒置 24 小時以上、裝置在線 → 刪掉帳上那個暫存檔並記一筆；被換成資料夾的不碰；離線的等它回來。
    // Cleanup: idle past 24 h with the device online → the recorded file goes, with an event; a folder in its place is
    // left alone; an offline device waits.
    let leftover = part_of(&c3, "c.iso");
    put(&alice.token, q("~/c.iso", &c3, 0, 30000, ""), data[..10_000].to_vec()).await;
    assert!(leftover.exists());
    std::fs::remove_file(part_of(&c2, "c.iso")).unwrap();
    std::fs::create_dir(part_of(&c2, "c.iso")).unwrap();
    for u in [&c2, &c3] {
        age(&lab, u["upload"].as_str().unwrap(), chrono::Duration::hours(25)).await;
    }
    let removed = telepy_server::uploads::reap_once(&lab.app.state, chrono::Utc::now()).await;
    assert_eq!(removed, 1, "only the real part file");
    assert!(!leftover.exists());
    assert!(part_of(&c2, "c.iso").is_dir(), "a folder in its place is never removed");
    let events = lab.app.get(&format!("/api/log/ssh/events?tunnel_id={id}"), Some(&alice.token)).await;
    assert!(events.json.as_array().unwrap().iter().any(|e| e["event"] == "files_upload_cleaned"), "{}", events.text);
    let (_, d) = start(&alice.token, json!({"path": "~/d.iso", "total": 30000, "local": {"name": "d.iso", "modified": 9}})).await;
    put(&alice.token, q("~/d.iso", &d, 0, 30000, ""), data[..10_000].to_vec()).await;
    age(&lab, d["upload"].as_str().unwrap(), chrono::Duration::hours(25)).await;
    lab.disconnect_device(&dev).await;
    assert_eq!(telepy_server::uploads::reap_once(&lab.app.state, chrono::Utc::now()).await, 0, "offline: wait");
    assert!(part_of(&d, "d.iso").exists());
    age(&lab, d["upload"].as_str().unwrap(), chrono::Duration::days(31)).await;
    telepy_server::uploads::reap_once(&lab.app.state, chrono::Utc::now()).await;
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_upload_part WHERE upload = ?").bind(d["upload"].as_str().unwrap()).fetch_one(&lab.app.state.db.read).await.unwrap();
    assert_eq!(left, 0, "offline for a month: the entry is forgotten");
}
