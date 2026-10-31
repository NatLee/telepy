//! 裝置載體的管理與自動更新：對著假的、簽過的 release 頁（測試金鑰），管理員面板的 API、每天的自動更新（比較舊的換掉、
//! 手動放的不動、設定關掉就不做）、通知（其他管理員的站內提示 + 稽核事件）、連不到 release 頁時的失敗通知只說一次。
//! Managing and auto-updating the device carriers against a fake signed release page: the admin panel's API, the
//! daily automatic update (older copies replaced, hand-placed ones left, nothing when switched off), the notices
//! (other admins' in-app notice + audit events), and a failure announced once when the release page can't be reached.
mod common;

use std::collections::HashMap;
use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Value};
use telepy_server::carriers::{self, archive_name, sha256_hex};
use telepy_server::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};

const TAG: &str = "v9.9.9";
const TARGETS: [&str; 2] = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];

fn targz(bin: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let enc = flate2::write::GzEncoder::new(&mut out, flate2::Compression::fast());
        let mut b = tar::Builder::new(enc);
        let mut h = tar::Header::new_gnu();
        h.set_size(bin.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        b.append_data(&mut h, "telepy-carrier", bin).unwrap();
        b.into_inner().unwrap().finish().unwrap();
    }
    out
}

/// 一個簽過的假 release（兩個平台）；回 (網址, 公鑰那一行)。/ A fake signed release; (URL, public key line).
async fn signed_release() -> (String, String) {
    use axum::extract::{Path, State};
    use axum::response::IntoResponse;
    use axum::routing::get;
    let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).unwrap();
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    let mut sums = String::new();
    for t in TARGETS {
        let a = targz(format!("carrier {TAG} for {t}").as_bytes());
        sums.push_str(&format!("{}  {}\n", sha256_hex(&a), archive_name(t)));
        files.insert(archive_name(t), a);
    }
    files.insert("SHA256SUMS.sig".into(), key.sign(telepy_server::release_key::NAMESPACE, HashAlg::Sha512, sums.as_bytes()).unwrap().to_pem(LineEnding::LF).unwrap().into_bytes());
    files.insert("SHA256SUMS".into(), sums.into_bytes());
    let files = Arc::new(files);
    let app = axum::Router::new()
        .route("/releases/latest", get(|| async { (StatusCode::FOUND, [(axum::http::header::LOCATION, format!("/releases/tag/{TAG}"))]).into_response() }))
        .route(
            &format!("/releases/download/{TAG}/{{file}}"),
            get(|State(f): State<Arc<HashMap<String, Vec<u8>>>>, Path(name): Path<String>| async move {
                match f.get(&name) {
                    Some(b) => (StatusCode::OK, b.clone()).into_response(),
                    None => StatusCode::NOT_FOUND.into_response(),
                }
            }),
        )
        .with_state(files);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}/releases"), key.public_key().to_openssh().unwrap())
}

/// 把一個「舊的」載體放進快取（`version` = None 代表手動放的）。/ Put an "old" carrier in the cache.
fn seed(app: &common::TestApp, target: &str, version: Option<&str>) {
    let d = app.state.config.carrier_dir.join(target);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("telepy-carrier"), b"old carrier").unwrap();
    let _ = std::fs::remove_file(d.join("sha256"));
    if let Some(v) = version {
        std::fs::write(d.join("sha256"), format!("{} {v}\n", sha256_hex(b"old carrier"))).unwrap();
    }
}

fn target<'a>(view: &'a Value, t: &str) -> &'a Value {
    view["targets"].as_array().unwrap().iter().find(|x| x["target"] == t).unwrap()
}

async fn user_id(app: &common::TestApp, name: &str) -> i64 {
    sqlx::query_scalar("SELECT id FROM auth_user WHERE username = ?").bind(name).fetch_one(&app.state.db.read).await.unwrap()
}

async fn events(app: &common::TestApp, kind: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT message FROM telepy_gateway_event WHERE event = ? ORDER BY id").bind(kind).fetch_all(&app.state.db.read).await.unwrap()
}

/// 收件匣裡的動作名稱（不等待）。/ The actions waiting in a hub receiver.
fn actions(rx: &mut tokio::sync::broadcast::Receiver<telepy_server::hub::Msg>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(m) = rx.try_recv() {
        if let Ok(v) = serde_json::from_str::<Value>(&m) {
            // 通知包在 `message` 裡。/ Notifications come wrapped in `message`.
            out.push(v.get("message").cloned().unwrap_or(v));
        }
    }
    out
}

#[tokio::test]
async fn carriers_are_kept_current_announced_and_managed_by_admins() {
    let (url, public) = signed_release().await;
    let app = common::spawn_with(|c| {
        c.releases_url = url.clone();
        c.release_keys = Some(public.clone());
    })
    .await;
    let (admin, user) = app.admin_and_user("admin", "bob").await;
    let other = app.login("carol", "pw").await;
    let carol = user_id(&app, "carol").await;
    telepy_server::db::users::set_flags(&app.state.db, carol, None, Some(true)).await.unwrap();
    let _ = other;

    // 只有管理員。/ Admins only.
    let r = app.get("/api/site/carriers", Some(&user)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")), "{}", r.text);
    let r = app.get("/api/site/carriers", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["auto_update"], true);
    assert_eq!(r.json["targets"].as_array().unwrap().len(), carriers::TARGETS.len());
    assert_eq!(r.json["keys"].as_array().unwrap().len(), 1);
    assert!(r.json["latest"]["tag"].is_null(), "nothing asked yet");

    // 快取是空的：自動更新什麼都不做，也不連外。/ An empty cache: the automatic update does nothing, no network.
    assert!(carriers::auto_update_once(&app.state).await.is_none());
    assert!(app.get("/api/site/carriers", Some(&admin)).await.json["latest"]["checked_at"].is_null());

    // 從舊 release 抓來的換掉，手動放的不動；其他管理員收到通知，稽核有一筆。
    // The older release copy is replaced, the hand-placed one left; the other admins are told, the audit log has it.
    seed(&app, TARGETS[0], Some("v0.0.1"));
    seed(&app, TARGETS[1], None);
    let mut carol_rx = app.state.hub.subscribe_user(carol);
    let run = carriers::auto_update_once(&app.state).await.expect("an automatic run");
    assert!(run.ok() && run.tag.as_deref() == Some(TAG), "{run:?}");
    assert_eq!(run.updated.iter().map(|u| u.target.as_str()).collect::<Vec<_>>(), vec![TARGETS[0]]);
    let v = app.get("/api/site/carriers", Some(&admin)).await.json;
    assert_eq!(target(&v, TARGETS[0])["cached"]["version"], TAG);
    assert!(target(&v, TARGETS[1])["cached"]["version"].is_null(), "hand-placed stays");
    assert_eq!(v["latest"]["tag"], TAG);
    assert_eq!(v["last_run"]["trigger"], "auto");
    let got = actions(&mut carol_rx);
    let n = got.iter().find(|m| m["action"] == "CARRIERS-UPDATED").expect("CARRIERS-UPDATED to the admins");
    assert_eq!((n["tag"].as_str(), n["targets"][0].as_str()), (Some(TAG), Some(TARGETS[0])));
    let e = events(&app, "carriers_updated").await;
    assert!(e.len() == 1 && e[0].contains("automatically") && e[0].contains("x86_64-unknown-linux-musl (v0.0.1)"), "{e:?}");
    // 今天已經問過：不會再問。/ Already asked today: not again.
    seed(&app, TARGETS[0], Some("v0.0.1"));
    assert!(carriers::auto_update_once(&app.state).await.is_none(), "once a day");

    // 手動：立即檢查、只更新指定的平台、不存在的平台 400；按的人自己不收通知，別的管理員收。
    // Manual: check now, update a picked platform, an unknown one is 400; the clicking admin isn't notified, others are.
    let r = app.post("/api/site/carriers/check", Some(&admin), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["updating"], false, "the answer comes after the check finished");
    assert!(target(&r.json, TARGETS[0])["update_available"].as_bool().unwrap(), "{}", r.text);
    let r = app.post("/api/site/carriers/update", Some(&admin), json!({"targets": ["mips-unknown-linux-musl"]})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);
    let r = app.post("/api/site/carriers/update", Some(&user), json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let admin_id = user_id(&app, "admin").await;
    let mut admin_rx = app.state.hub.subscribe_user(admin_id);
    let r = app.post("/api/site/carriers/update", Some(&admin), json!({"targets": [TARGETS[0], TARGETS[1]]})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let run = &r.json["run"];
    assert_eq!((run["trigger"].as_str(), run["by"].as_str()), (Some("manual"), Some("admin")));
    let was: Vec<(&str, &str)> = run["updated"].as_array().unwrap().iter().map(|u| (u["target"].as_str().unwrap(), u["was"].as_str().unwrap())).collect();
    assert_eq!(was, vec![(TARGETS[0], "release"), (TARGETS[1], "manual")], "{run}");
    assert_eq!(target(&r.json["carriers"], TARGETS[1])["cached"]["version"], TAG);
    assert_eq!(r.json["carriers"]["updating"], false);
    assert!(actions(&mut admin_rx).iter().all(|m| m["action"] != "CARRIERS-UPDATED"), "the admin who clicked is not notified");
    assert!(actions(&mut carol_rx).iter().any(|m| m["action"] == "CARRIERS-UPDATED" && m["by"] == "admin"));
    // 裝置下載的是新的。/ Devices download the new one.
    let r = app.get(&format!("/api/join/carrier/{}", TARGETS[1]), None).await;
    assert_eq!(r.text, format!("carrier {TAG} for {}", TARGETS[1]));
    // 空的 body = 全部平台：這兩個已經是最新，其他平台這個 release 沒有 → 失敗清單。
    // An empty body = every platform: these two are current, the rest are missing from this release.
    let r = app.request(axum::http::Method::POST, "/api/site/carriers/update", Some(&admin), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["run"]["current"].as_array().unwrap().len(), 2);
    assert_eq!(r.json["run"]["failed"].as_array().unwrap().len(), carriers::TARGETS.len() - 2);
    assert!(events(&app, "carriers_update_failed").await.iter().any(|m| m.contains("by admin")));

    // 設定關掉：自動更新不做。/ Switched off: no automatic update.
    let r = app.post("/api/site/settings", Some(&admin), json!({"carrier_auto_update": false})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(app.get("/api/site/carriers", Some(&admin)).await.json["auto_update"], false);
}

/// 連不到 release 頁：自動更新失敗通知一次（站內 + 稽核事件），快取照常給裝置。
/// The release page unreachable: the automatic failure is announced (in-app + audit), the cache keeps serving.
#[tokio::test]
async fn an_unreachable_release_page_is_announced_and_the_cache_keeps_serving() {
    let app = common::spawn().await;
    let (admin, _) = app.admin_and_user("admin", "bob").await;
    let admin_id = user_id(&app, "admin").await;
    seed(&app, TARGETS[0], Some("v0.0.1"));
    let mut rx = app.state.hub.subscribe_user(admin_id);
    let run = carriers::auto_update_once(&app.state).await.expect("a failed run is reported");
    assert!(run.failure().unwrap().contains("cannot read the latest release"), "{run:?}");
    let got = actions(&mut rx);
    assert!(got.iter().any(|m| m["action"] == "CARRIERS-UPDATE-FAILED"), "{got:?}");
    assert_eq!(events(&app, "carriers_update_failed").await.len(), 1);
    let v = app.get("/api/site/carriers", Some(&admin)).await.json;
    assert!(v["latest"]["error"].as_str().unwrap().len() > 0);
    assert_eq!(app.get(&format!("/api/join/carrier/{}", TARGETS[0]), None).await.text, "old carrier");
}
