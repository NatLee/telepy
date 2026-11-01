//! IP 與網卡廠商資料（DB-IP Lite + IEEE OUI）的下載與自動更新：對著假的 DB-IP / IEEE 伺服器，管理員面板的 API、
//! 什麼都沒裝時自動更新不連外、下載後不重啟就讀進來、已經是這個月的不重抓、舊月份自動換新、這個月還沒出就等、
//! 失敗只記一次、設定關掉就不做、檔案被換掉時重讀。
//! Downloading and auto-updating the IP and NIC vendor data against fake DB-IP / IEEE servers: the admin panel's API,
//! no network while nothing is installed, data loaded without a restart, the current month never fetched again, an
//! older month replaced automatically, waiting while this month is not out, a failure announced once, nothing when
//! switched off, and files replaced on disk picked up.
mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::http::StatusCode;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use telepy_server::datasets::{self, Sources};

const OUI_CSV: &str = "Registry,Assignment,Organization Name,Organization Address\n\
MA-L,B827EB,Raspberry Pi Foundation,Cambridge GB\n\
MA-L,001132,Synology Inc,Taipei TW\n\
MA-L,286FB9,Nokia,Shanghai CN\n";

/// 最小的合法 MaxMind DB：一個節點（查什麼都沒有）、空的資料區、metadata 寫好建置時間。
/// The smallest valid MaxMind DB: one node (every lookup finds nothing), an empty data section and the metadata.
fn mmdb(build_epoch: u64, database_type: &str) -> Vec<u8> {
    let mut b = vec![0, 0, 1, 0, 0, 1];
    b.extend([0u8; 16]);
    b.extend(b"\xAB\xCD\xEFMaxMind.com");
    let key = |b: &mut Vec<u8>, k: &str| {
        b.push(0x40 | k.len() as u8);
        b.extend(k.as_bytes());
    };
    b.push(0xE0 | 9);
    key(&mut b, "binary_format_major_version");
    b.extend([0xA1, 2]);
    key(&mut b, "binary_format_minor_version");
    b.push(0xA0);
    key(&mut b, "build_epoch");
    b.extend([0x08, 0x02]);
    b.extend(build_epoch.to_be_bytes());
    key(&mut b, "database_type");
    b.push(0x40 | database_type.len() as u8);
    b.extend(database_type.as_bytes());
    key(&mut b, "description");
    b.push(0xE0);
    key(&mut b, "ip_version");
    b.extend([0xA1, 4]);
    key(&mut b, "languages");
    b.extend([0x00, 0x04]);
    key(&mut b, "node_count");
    b.extend([0xC1, 1]);
    key(&mut b, "record_size");
    b.extend([0xA1, 24]);
    b
}

fn gz(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

/// 假的 DB-IP（`/free/` 任何月份都有、`/none/` 都 404）與 IEEE（`/oui.csv`、壞掉的 `/bad.csv`）；回網址與下載次數。
/// Fake DB-IP (`/free/` has every month, `/none/` 404s) and IEEE (`/oui.csv`, a broken `/bad.csv`); URL + hit count.
async fn fake_sources() -> (String, Arc<AtomicUsize>) {
    use axum::extract::{Path, State};
    use axum::response::IntoResponse;
    use axum::routing::get;
    let hits = Arc::new(AtomicUsize::new(0));
    let app = axum::Router::new()
        .route(
            "/free/{file}",
            get(|State(h): State<Arc<AtomicUsize>>, Path(file): Path<String>| async move {
                h.fetch_add(1, Ordering::SeqCst);
                let kind = if file.starts_with("dbip-country-lite-") { "DBIP-Country-Lite" } else if file.starts_with("dbip-asn-lite-") { "DBIP-ASN-Lite" } else { return StatusCode::NOT_FOUND.into_response() };
                (StatusCode::OK, gz(&mmdb(Utc::now().timestamp() as u64, kind))).into_response()
            }),
        )
        .route(
            "/none/{file}",
            get(|State(h): State<Arc<AtomicUsize>>| async move {
                h.fetch_add(1, Ordering::SeqCst);
                StatusCode::NOT_FOUND
            }),
        )
        .route("/oui.csv", get(|| async { OUI_CSV }))
        .route("/bad.csv", get(|| async { "<html>rate limited</html>" }))
        .with_state(hits.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), hits)
}

async fn events(app: &common::TestApp, kind: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT message FROM telepy_gateway_event WHERE event = ? ORDER BY id").bind(kind).fetch_all(&app.state.db.read).await.unwrap()
}

fn item<'a>(view: &'a Value, id: &str) -> &'a Value {
    view["items"].as_array().unwrap().iter().find(|x| x["id"] == id).unwrap_or_else(|| panic!("no {id} in {view}"))
}

fn outcome(run: &Value, id: &str) -> String {
    run["items"].as_array().unwrap().iter().find(|x| x["id"] == id).map(|x| x["outcome"].as_str().unwrap().to_string()).unwrap_or_else(|| "absent".into())
}

#[tokio::test]
async fn ip_and_vendor_data_are_downloaded_reloaded_and_kept_current() {
    let (base, hits) = fake_sources().await;
    let app = common::spawn().await;
    let (admin, user) = app.admin_and_user("admin", "bob").await;
    let state = &app.state;
    let month = |at: chrono::DateTime<Utc>| datasets::months(at.date_naive())[0].clone();

    // 只有管理員。/ Admins only.
    let r = app.get("/api/site/datasets", Some(&user)).await;
    assert_eq!((r.status, r.json["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")), "{}", r.text);
    let r = app.get("/api/site/datasets", Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["auto_update"], true, "on by default");
    assert_eq!(r.json["items"].as_array().unwrap().len(), 3);
    assert!(r.json["items"].as_array().unwrap().iter().all(|i| i["present"] == false && i["in_use"].is_null()), "{}", r.json);

    // 什麼都沒裝：自動更新不做、不連外。/ Nothing installed: the automatic update does nothing and connects nowhere.
    state.datasets.set_sources(Sources { dbip: format!("{base}/free"), oui: format!("{base}/oui.csv") });
    assert!(datasets::auto_update_once(state, Utc::now()).await.is_none());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert!(!state.geoip.enabled());

    // 管理員按下載：三項都換上，不用重啟就讀進來，稽核事件記是誰。/ An admin downloads: loaded at once, audited.
    let r = app.post("/api/site/datasets/update", Some(&admin), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let now = Utc::now();
    for id in ["country", "asn", "oui"] {
        assert_eq!(outcome(&r.json["run"], id), "updated", "{id}: {}", r.json["run"]);
    }
    assert_eq!(r.json["run"]["items"][0]["to"], month(now));
    let view = &r.json["datasets"];
    assert_eq!(item(view, "country")["release"], month(now), "{view}");
    assert_eq!(item(view, "country")["in_use"]["file"], "dbip-country-lite.mmdb");
    assert_eq!(item(view, "asn")["in_use"]["source"], "DB-IP");
    assert_eq!(item(view, "oui")["vendors"], 3);
    assert!(view["items"].as_array().unwrap().iter().all(|i| i["due"] == false), "fresh data is not due: {view}");
    assert!(state.geoip.enabled(), "loaded without a restart");
    assert_eq!(state.oui.vendor("b8:27:eb:00:00:01").as_deref(), Some("Raspberry Pi Foundation"));
    assert_eq!(std::fs::read_to_string(state.config.geoip_dir.join("dbip-country-lite.mmdb.release")).unwrap(), month(now));
    let e = events(&app, "datasets_updated").await;
    assert!(e.len() == 1 && e[0].contains("by admin") && e[0].contains("DB-IP country"), "{e:?}");

    // 已經是這個月的：不再抓 DB-IP。/ Already this month's: DB-IP is not fetched again.
    let before = hits.load(Ordering::SeqCst);
    let r = app.post("/api/site/datasets/update", Some(&admin), json!({ "items": ["country"] })).await;
    assert_eq!(outcome(&r.json["run"], "country"), "current", "{}", r.json);
    assert_eq!(hits.load(Ordering::SeqCst), before);
    let r = app.post("/api/site/datasets/update", Some(&admin), json!({ "items": ["nope"] })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text);

    // 舊月份：自動更新（隔天）換成這個月的，只動它。/ An older month: the next day's automatic update replaces only it.
    std::fs::write(state.config.geoip_dir.join("dbip-country-lite.mmdb.release"), "2000-01").unwrap();
    assert!(datasets::auto_update_once(state, now).await.is_none(), "checked today already");
    let day2 = now + Duration::hours(25);
    let run = datasets::auto_update_once(state, day2).await.expect("an automatic run");
    let run = serde_json::to_value(&run).unwrap();
    assert_eq!(outcome(&run, "country"), "updated", "{run}");
    assert_eq!(run["items"][0]["from"], "2000-01");
    if month(day2) == month(now) {
        assert_eq!(outcome(&run, "asn"), "absent", "only what is due");
    }
    assert!(events(&app, "datasets_updated").await.last().unwrap().contains("automatically"));

    // 這個月的還沒出：等著，不算失敗。/ This month's is not out yet: wait, no failure.
    std::fs::write(state.config.geoip_dir.join("dbip-country-lite.mmdb.release"), "2000-01").unwrap();
    state.datasets.set_sources(Sources { dbip: format!("{base}/none"), oui: format!("{base}/bad.csv") });
    let day3 = day2 + Duration::hours(25);
    let run = serde_json::to_value(datasets::auto_update_once(state, day3).await.unwrap()).unwrap();
    assert_eq!(outcome(&run, "country"), "current", "{run}");
    assert_eq!(outcome(&run, "oui"), "absent", "the vendor table is not due yet");
    assert!(events(&app, "datasets_update_failed").await.is_empty());

    // 廠商表到期但來源壞了：失敗只記一次；資料保留舊的。/ A broken vendor source: announced once; the old table stays.
    let later = day3 + Duration::days(40);
    let run = serde_json::to_value(datasets::auto_update_once(state, later).await.unwrap()).unwrap();
    assert_eq!(outcome(&run, "oui"), "failed", "{run}");
    assert!(run["items"].as_array().unwrap().iter().any(|i| i["error"].as_str().is_some_and(|e| e.contains("unexpected content"))));
    assert_eq!(events(&app, "datasets_update_failed").await.len(), 1);
    let _ = datasets::auto_update_once(state, later + Duration::hours(25)).await;
    assert_eq!(events(&app, "datasets_update_failed").await.len(), 1, "the same failure is said once");
    assert_eq!(state.oui.len(), 3, "a failed download keeps the old table");
    let view = app.get("/api/site/datasets", Some(&admin)).await.json;
    assert!(item(&view, "oui")["failure"]["error"].as_str().unwrap().contains("unexpected content"), "{view}");

    // 設定關掉：不做。/ Switched off: nothing.
    let r = app.post("/api/site/settings", Some(&admin), json!({ "datasets_auto_update": false })).await;
    assert!(r.status.is_success(), "{}", r.text);
    assert!(datasets::auto_update_once(state, later + Duration::days(3)).await.is_none());
    assert_eq!(app.get("/api/site/datasets", Some(&admin)).await.json["auto_update"], false);

    // 檔案在磁碟上被換掉（子指令、手動）：不用重啟就跟上。/ Files changed on disk are picked up without a restart.
    std::fs::remove_file(state.config.geoip_dir.join("dbip-country-lite.mmdb")).unwrap();
    assert!(state.datasets.pick_up_changes(&state.geoip, &state.oui));
    let (country, asn) = state.geoip.in_use();
    assert!(country.is_none() && asn.is_some());
    assert!(!state.datasets.pick_up_changes(&state.geoip, &state.oui), "nothing changed since");
}
