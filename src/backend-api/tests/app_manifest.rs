//! 裝成 app（PWA）：公開的 manifest 與它的名稱設定（Telepy / 網域 / 管理員取的名字）。
//! Installing Telepy as an app (PWA): the public manifest and its name setting (Telepy / the domain / the admin's name).
mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};

const PATH: &str = "/api/app/manifest.webmanifest";

async fn manifest_at(app: &common::TestApp, host: Option<&str>) -> Value {
    let mut req = Request::get(PATH);
    if let Some(h) = host {
        req = req.header("x-forwarded-host", h);
    }
    let r = app.send(req.body(Body::empty()).unwrap()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    serde_json::from_str(&r.text).expect("the manifest is JSON")
}

#[tokio::test]
async fn the_manifest_is_public_and_named_by_the_site_settings() {
    let app = common::spawn().await;

    // 預設：不用登入、叫 Telepy、自己的視窗、只有名字與圖示。/ Defaults: no sign-in, "Telepy", standalone, name and icons only.
    let r = app.get(PATH, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.headers["content-type"], "application/manifest+json");
    assert_eq!(r.headers["cache-control"], "no-cache", "a renamed app must reach browsers");
    let m: Value = serde_json::from_str(&r.text).unwrap();
    assert_eq!((m["name"].as_str(), m["short_name"].as_str(), m["display"].as_str()), (Some("Telepy"), Some("Telepy"), Some("standalone")));
    assert!(m.get("description").is_none(), "public: no product copy (the discreet sign-in page links to it)");
    assert_eq!(manifest_at(&app, Some("telepy.example.com")).await["name"], "Telepy", "the default ignores the host");

    let (admin, bob) = app.admin_and_user("admin", "bob").await;
    let r = app.get("/api/site/settings", Some(&admin)).await;
    assert_eq!((r.json["values"]["app_name_mode"].as_str(), r.json["values"]["app_name"].as_str()), (Some("telepy"), Some("")));
    assert_eq!(r.json["meta"]["app_name_mode"]["choices"], json!(["telepy", "domain", "custom"]));

    // 網域：這次請求的主機（沒設 PUBLIC_URL 時）。/ The domain: this request's host (without PUBLIC_URL).
    let r = app.post("/api/site/settings", Some(&admin), json!({"app_name_mode": "domain"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(manifest_at(&app, Some("Telepy.Example.com:8443")).await["name"], "telepy.example.com", "lower-cased, port dropped");
    // 設了公開網址就用它的主機，不管從哪個名稱來。/ With a public address its host wins, whatever name the request used.
    let r = app.post("/api/site/settings", Some(&admin), json!({"server_public_url": "https://lab.example.org"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(manifest_at(&app, Some("other.example.net")).await["name"], "lab.example.org");

    // 自訂：沒給名字不行；名字整理過；太長、不認得的選項都拒絕。/ Custom: needs a name, which is tidied; too long or unknown is refused.
    let r = app.post("/api/site/settings", Some(&admin), json!({"app_name_mode": "custom"})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json, json!({"app_name": ["Enter a name, or choose Telepy or the domain."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"app_name_mode": "custom", "app_name": "  Lab \n servers "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["values"]["app_name"], "Lab servers");
    assert_eq!(manifest_at(&app, None).await["name"], "Lab servers");
    let r = app.post("/api/site/settings", Some(&admin), json!({"app_name": "x".repeat(31)})).await;
    assert_eq!(r.json, json!({"app_name": ["Keep the name to 30 characters or fewer."]}));
    let r = app.post("/api/site/settings", Some(&admin), json!({"app_name": ""})).await;
    assert_eq!(r.json, json!({"app_name": ["Enter a name, or choose Telepy or the domain."]}), "can't blank the name while it is in use");
    let r = app.post("/api/site/settings", Some(&admin), json!({"app_name_mode": "neon"})).await;
    assert_eq!(r.json, json!({"app_name_mode": ["Must be one of: telepy, domain, custom."]}));

    // 名字留著，切回 Telepy 也可以；一般使用者不能改。/ The name stays when switching back; others cannot change it.
    let r = app.post("/api/site/settings", Some(&admin), json!({"app_name_mode": "telepy"})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.json["values"]["app_name"], "Lab servers");
    assert_eq!(manifest_at(&app, None).await["name"], "Telepy");
    let r = app.post("/api/site/settings", Some(&bob), json!({"app_name_mode": "domain"})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}
