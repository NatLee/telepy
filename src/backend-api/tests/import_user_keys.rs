//! `telepy-server import-user-keys`：跟 API 一樣的檢查（重複、通道金鑰、服務金鑰、站台到期上限），已經有的不算錯，
//! 試跑什麼都不寫；最後用真的 binary 跑一次看輸出與結束碼。
//! `import-user-keys`: the API's checks, "already there" is not an error, a dry run writes nothing; then the real
//! binary once for its output and exit code.
mod common;

use axum::http::StatusCode;
use serde_json::json;
use telepy_server::db;
use telepy_server::import_keys::{self, Outcome};

const USER_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHAgjb8hhCbQ4/2TIVTp6pRlUi97oIezKoHrwtI5hIDU laptop";
const USER_KEY_2: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC0IpUODAh6nEE6nsxVUVINtlvKLCYnrc/Xfzbp1ui1K other";
const TUNNEL_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4u5n7tS1kO6o4m3yQ0tYQd6v7Jc5Zq8Hh3n5Vt7Wk device-a";
const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4u5n7tS1kO6o4m3yQ0tYQd6v7Jc5Zq8Hh3n5Vt7Wl device-b";
const RSA_1024: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDfJoXhbfbTVWOGa30diB5dY07RMBntvLd+q1uT8vc7qLbQhsStQ3uK6g2kj2s/fMn9J3Ayan4au4KLfcMcnWaTy+A6J/vSFogh8q3M8w/80nkQ3clT/492fRCOWb1usAmMRJsl38BgO8BfbQtY65KFxC/mPvv6zBvKMbI4Vtd6Xw== small";

fn outcomes(lines: &[import_keys::Line]) -> Vec<Outcome> {
    lines.iter().map(|l| l.outcome.clone()).collect()
}

fn skipped(o: &Outcome, needle: &str) -> bool {
    matches!(o, Outcome::Skipped(r) if r.contains(needle))
}

#[tokio::test]
async fn imports_keys_like_the_api() {
    let app = common::spawn().await;
    let (admin, alice_token) = app.admin_and_user("admin", "alice").await;
    app.login("bob", "pw").await;
    app.login("carol", "pw").await;
    let db = &app.state.db;
    let alice = db::users::by_username(db, "alice").await.unwrap().unwrap();
    let carol = db::users::by_username(db, "carol").await.unwrap().unwrap();
    db::users::set_flags(db, carol.id, Some(false), None).await.unwrap();
    // 一個裝置（通道）金鑰。/ A device (tunnel) key.
    db::tunnels::create(db, db::tunnels::NewTunnel { user_id: alice.id, host_friendly_name: "dev", key: TUNNEL_KEY, reverse_port: 40001, description: None, default_username_id: None })
        .await
        .unwrap();
    // alice 已經有 USER_KEY（透過 API）。/ alice already has USER_KEY (through the API).
    let r = app.post("/api/reverse/user/keys", Some(&alice_token), json!({"host_friendly_name": "laptop", "key": USER_KEY})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);

    let file = format!(
        r#"[
          {{"username": "bob", "name": "bob-pc", "key": "{USER_KEY_2}"}},
          {{"username": "alice", "name": "renamed", "key": "{}"}},
          {{"username": "bob", "name": "stolen", "key": "{USER_KEY}"}},
          {{"username": "bob", "name": "dev-key", "key": "{TUNNEL_KEY}"}},
          {{"username": "nobody", "name": "x", "key": "{USER_KEY_2}"}},
          {{"username": "carol", "name": "y", "key": "{USER_KEY_2}"}},
          {{"username": "bob", "name": "weak", "key": "{RSA_1024}"}},
          {{"username": "bob", "name": "garbage", "key": "ssh-ed25519 nope"}},
          {{"username": "bob", "name": "laptop", "key": "{KEY_B}"}},
          {{"username": "bob"}}
        ]"#,
        USER_KEY.replace("laptop", "different-comment")
    );
    let items = import_keys::parse_items(&file).unwrap();
    let count = || async { db::keys::user_keys(db, alice.id).await.unwrap().len() + db::keys::user_keys(db, db::users::by_username(db, "bob").await.unwrap().unwrap().id).await.unwrap().len() };
    assert_eq!(count().await, 1);

    // --- 試跑：什麼都不寫。/ Dry run: nothing is written.
    let events_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_gateway_event").fetch_one(&db.read).await.unwrap();
    let dry = import_keys::run(&app.state, &items, true).await.unwrap();
    let o = outcomes(&dry);
    assert_eq!(o[0], Outcome::WouldAdd);
    assert_eq!(o[1], Outcome::AlreadyThere, "same key, other comment, same user");
    assert!(skipped(&o[2], "already exists"), "{:?}", o[2]);
    assert!(skipped(&o[3], "used by a tunnel"), "{:?}", o[3]);
    assert!(skipped(&o[4], "no account named \"nobody\""), "{:?}", o[4]);
    assert!(skipped(&o[5], "disabled"), "{:?}", o[5]);
    assert!(skipped(&o[6], "key:"), "{:?}", o[6]);
    assert!(skipped(&o[7], "Invalid SSH public key"), "{:?}", o[7]);
    assert!(skipped(&o[8], "Host Friendly Name already exists"), "{:?}", o[8]);
    assert!(skipped(&o[9], "\"name\" is required"), "{:?}", o[9]);
    assert!(import_keys::failed(&dry));
    assert_eq!(count().await, 1, "dry run wrote nothing");
    let events_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_gateway_event").fetch_one(&db.read).await.unwrap();
    assert_eq!(events_before, events_after);
    let text = import_keys::render(&dry, true);
    assert!(!text.contains("AAAAC3"), "no key blobs in the output: {text}");
    assert!(text.ends_with("10 entries: 1 would add, 1 already there, 8 skipped (dry run, nothing written)\n"), "{text}");

    // --- 真的跑：結果跟試跑一樣（「會加」變「已加」）。/ The real run matches the dry run.
    let real = import_keys::run(&app.state, &items, false).await.unwrap();
    let ro = outcomes(&real);
    assert_eq!(ro[0], Outcome::Added);
    for i in 1..o.len() {
        assert_eq!(std::mem::discriminant(&ro[i]), std::mem::discriminant(&o[i]), "entry {}: {:?} vs {:?}", i + 1, ro[i], o[i]);
    }
    assert_eq!(count().await, 2);
    // 跟 API 建的一樣：指紋等欄位從公鑰算出、清單看得到。/ Same as an API-created key in the list.
    let bob_token = app.login("bob", "pw").await;
    let r = app.get("/api/reverse/user/keys", Some(&bob_token)).await;
    let keys = r.json.as_array().unwrap();
    assert_eq!(keys.len(), 1, "{}", r.text);
    assert_eq!(keys[0]["host_friendly_name"], "bob-pc");
    assert!(keys[0]["fingerprint"].as_str().unwrap().starts_with("SHA256:"));
    assert!(keys[0]["expires_at"].is_null());
    // 稽核事件（不屬於任何通道）。/ The tunnel-less audit event.
    let (event, msg, tunnel): (String, String, Option<i64>) =
        sqlx::query_as("SELECT event, message, tunnel_id FROM telepy_gateway_event ORDER BY id DESC LIMIT 1").fetch_one(&db.read).await.unwrap();
    assert_eq!(event, "user_key_import");
    assert_eq!(tunnel, None);
    assert_eq!(msg, format!("bob-pc ({}) added to bob by import-user-keys", keys[0]["fingerprint"].as_str().unwrap()));

    // --- 再跑一次：全部「已經有了」或照舊跳過，不會重複加。/ Idempotent.
    let again = import_keys::run(&app.state, &items[..2], false).await.unwrap();
    assert_eq!(outcomes(&again), vec![Outcome::AlreadyThere, Outcome::AlreadyThere]);
    assert!(!import_keys::failed(&again));
    assert_eq!(count().await, 2);

    // --- 站台到期上限跟 API 一樣套用。/ The site's key lifetime limit applies as in the API.
    let r = app.post("/api/site/settings", Some(&admin), json!({"user_key_max_days": 30})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let k3 = KEY_B;
    let items = import_keys::parse_items(&format!(
        r#"[{{"username": "alice", "name": "too-long", "key": "{k3}", "expires_at": "2099-12-31"}},
            {{"username": "alice", "name": "limited", "key": "{k3}"}}]"#
    ))
    .unwrap();
    let lines = import_keys::run(&app.state, &items, false).await.unwrap();
    assert!(skipped(&lines[0].outcome, "expires_at:"), "{:?}", lines[0].outcome);
    assert_eq!(lines[1].outcome, Outcome::Added);
    let limited = db::keys::user_keys(db, alice.id).await.unwrap().into_iter().find(|k| k.host_friendly_name == "limited").unwrap();
    assert!(limited.expires_at.is_some(), "defaulted to the site limit");
}

/// 真的 binary：報告格式與結束碼。/ The real binary: report format and exit code.
#[tokio::test]
async fn binary_reports_and_exits_nonzero_on_skips() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("db.sqlite3");
    {
        let db = db::Db::open(&db_path).await.unwrap();
        db::schema::ensure_schema(&db.write).await.unwrap();
        db::users::create(&db, db::users::NewUser { username: "alice", password_hash: "!", email: "", first_name: "", last_name: "" }).await.unwrap();
    }
    let file = dir.path().join("keys.json");
    let run = |args: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_telepy-server"))
            .args(args)
            .env("DATA_DIR", dir.path())
            .env("LOG_ROOT", dir.path().join("logs"))
            .env_remove("DB_PATH")
            .output()
            .unwrap()
    };
    let path = file.to_str().unwrap();

    std::fs::write(&file, format!(r#"[{{"username": "alice", "name": "laptop", "key": "{USER_KEY}"}}]"#)).unwrap();
    let out = run(&["import-user-keys", path, "--dry-run"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout} {}", String::from_utf8_lossy(&out.stderr));
    assert!(stdout.starts_with("#1 alice \"laptop\" SHA256:") && stdout.contains(": would add\n"), "{stdout}");
    let out = run(&["import-user-keys", path]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout}");
    assert!(stdout.contains(": added\n") && stdout.ends_with("1 entry: 1 added, 0 already there, 0 skipped\n"), "{stdout}");
    assert!(!stdout.contains("AAAAC3"), "{stdout}");
    let gateway_log = std::fs::read_to_string(dir.path().join("logs/ssh-gateway.log")).unwrap();
    assert!(gateway_log.contains("added to alice by import-user-keys"), "{gateway_log}");

    std::fs::write(&file, format!(r#"[{{"username": "alice", "name": "laptop", "key": "{USER_KEY}"}}, {{"username": "zed", "name": "z", "key": "{USER_KEY_2}"}}]"#)).unwrap();
    let out = run(&["import-user-keys", path]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{stdout}");
    assert!(stdout.contains("#1 alice \"laptop\" SHA256:") && stdout.contains(": already there\n"), "{stdout}");
    assert!(stdout.contains("#2 zed \"z\" SHA256:") && stdout.contains("skipped: no account named \"zed\""), "{stdout}");
}
