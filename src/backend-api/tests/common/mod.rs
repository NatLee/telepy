//! 整合測試共用：臨時 SQLite + 完整 Router，用 tower `oneshot` 打請求（不開真正的 socket）。

#![allow(dead_code)]

pub mod lab;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use telepy_server::config::Config;
use telepy_server::db::{self, Db};
use telepy_server::state::AppState;

pub struct TestApp {
    pub router: Router,
    pub state: AppState,
    _dir: tempfile::TempDir,
}

pub async fn spawn() -> TestApp {
    spawn_with(|_| {}).await
}

/// 同 `spawn`，但先讓測試改 Config（例如固定的 `TRUSTED_PROXY_HOPS`）。/ `spawn` with a Config hook.
#[allow(dead_code)]
pub async fn spawn_with(customize: impl FnOnce(&mut Config)) -> TestApp {
    // 不用環境變數（測試並行時會互相覆蓋），直接改 Config 欄位。
    // Avoid env vars (parallel tests race on them); set the Config fields directly.
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::from_env();
    customize(&mut config);
    config.data_dir = dir.path().to_path_buf();
    config.db_path = dir.path().join("db.sqlite3");
    config.log_root = dir.path().join("logs");
    config.reverse_server_ssh_port = "24242".to_string();
    config.server_domain = Some("telepy.test".to_string());
    config.internal_api_token = "internal-secret".to_string();
    config.ssh_logs_path = dir.path().join("missing.log");
    // 測試不碰網路：載體只從暫存目錄來，release 頁指到沒人聽的位址。/ No network: carriers from the temp dir only.
    config.carrier_dir = dir.path().join("carriers");
    config.releases_url = "http://127.0.0.1:9/releases".to_string();
    let db = Db::open(&config.db_path).await.unwrap();
    db::schema::ensure_schema(&db.write).await.unwrap();
    let state = AppState::new(config, db);
    let router = telepy_server::app::build(state.clone());
    TestApp { router, state, _dir: dir }
}

pub struct Resp {
    pub status: StatusCode,
    pub json: Value,
    pub text: String,
    pub headers: axum::http::HeaderMap,
}

impl TestApp {
    pub async fn request(&self, method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Resp {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        let req = match body {
            Some(v) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(v.to_string())).unwrap(),
            None => req.body(Body::empty()).unwrap(),
        };
        self.send(req).await
    }

    /// 送任意請求（自訂 header / form body 用）。/ Send an arbitrary request (custom headers, form bodies).
    pub async fn send(&self, req: Request<Body>) -> Resp {
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).to_string();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Resp { status, json, text, headers }
    }

    pub async fn get(&self, path: &str, token: Option<&str>) -> Resp {
        self.request(Method::GET, path, token, None).await
    }
    pub async fn post(&self, path: &str, token: Option<&str>, body: Value) -> Resp {
        self.request(Method::POST, path, token, Some(body)).await
    }
    pub async fn put(&self, path: &str, token: Option<&str>, body: Value) -> Resp {
        self.request(Method::PUT, path, token, Some(body)).await
    }
    pub async fn patch(&self, path: &str, token: Option<&str>, body: Value) -> Resp {
        self.request(Method::PATCH, path, token, Some(body)).await
    }
    pub async fn delete(&self, path: &str, token: Option<&str>) -> Resp {
        self.request(Method::DELETE, path, token, None).await
    }

    /// 換掉 ssh 執行檔（terminal 測試用假程式）：重建 state + router。
    pub async fn set_ssh_binary(&mut self, path: &str) {
        let mut config = self.state.config.clone();
        config.ssh_binary = path.to_string();
        let db = self.state.db.clone();
        self.state = AppState::new(config, db);
        self.router = telepy_server::app::build(self.state.clone());
    }

    /// 第一個使用者（管理員）+ 一個一般使用者，回 (admin token, user token)。會先開放註冊。
    /// The first user (a superuser) plus a regular user; opens registration in between.
    pub async fn admin_and_user(&self, admin: &str, user: &str) -> (String, String) {
        let a = self.login(admin, "pw").await;
        let r = self.post("/api/site/settings", Some(&a), serde_json::json!({"allow_registration": true})).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        let u = self.login(user, "pw").await;
        (a, u)
    }

    /// 稽核雜湊鏈的外部錨點檔（`<log_root>/audit-anchors.log`）。/ The audit chain's anchors file.
    pub fn audit_anchors_file(&self) -> std::path::PathBuf {
        self.state.config.log_root.join(telepy_server::db::audit_chain::ANCHORS_FILE)
    }

    /// 註冊 + 登入，回 access token。/ Register and log in; returns the access token.
    pub async fn login(&self, username: &str, password: &str) -> String {
        let r = self.post("/api/auth/register", None, serde_json::json!({"username": username, "password": password})).await;
        assert!(r.status == StatusCode::CREATED || r.status == StatusCode::BAD_REQUEST, "register: {}", r.text);
        let r = self.post("/api/auth/token", None, serde_json::json!({"username": username, "password": password})).await;
        assert_eq!(r.status, StatusCode::OK, "login: {}", r.text);
        r.json["access_token"].as_str().unwrap().to_string()
    }
}
