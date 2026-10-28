//! OpenAPI 文件的根（info、tags、Bearer 安全方案）與登入後才看得到的 Swagger UI。
//! 各端點的 path item 由 `utoipa_axum` 的 `routes!` 收集。
//!
//! Root of the OpenAPI document plus the login-gated Swagger UI; path items are collected by the
//! `routes!` macro in each api module.
//!
//! 登入限制的做法：規格 `/api/openapi.json` 要 Bearer（任何登入使用者）；Swagger 頁面是同源的靜態殼，
//! 它的初始化腳本先用 localStorage 裡前端存的 access token 打 `/api/auth/token/verify`（過期就 refresh），
//! 沒登入就導去 `/login`，有登入才載入規格，並把 Bearer 帶進每個「Try it out」請求。
//! The spec requires a Bearer token; the Swagger shell is same-origin static HTML whose initializer verifies
//! (or refreshes) the frontend's access token from localStorage, redirects to `/login` otherwise, and injects
//! the Bearer header into the spec download and every "Try it out" request.

use std::sync::{Arc, LazyLock};

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa::{Modify, OpenApi};
use utoipa_swagger_ui::Config;

use crate::auth::AuthUser;
use crate::state::AppState;

pub const SWAGGER_PATH: &str = "/api/__hidden_swagger";
pub const OPENAPI_JSON_PATH: &str = "/api/openapi.json";
/// 前端登入頁；沒登入時 Swagger 頁面會導過去。/ Frontend login page the Swagger shell redirects to.
pub const LOGIN_PATH: &str = "/login";

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Telepy API",
        version = "v1",
        description = "REST API of Telepy. Authenticate with `POST /api/auth/token` and send the access token as `Authorization: Bearer <token>`. This page and `/api/openapi.json` are only available to logged-in users; the page reuses your web login. WebSocket endpoints (`/ws/*`) are documented in CLAUDE.md; they authenticate with a first JSON frame `{\"type\":\"auth\",\"token\":\"<access>\"}`."
    ),
    modifiers(&SecurityAddon),
    tags(
        (name = "Login", description = "Obtain, refresh and verify tokens; registration; Google login"),
        (name = "Authentication", description = "The current user"),
        (name = "Reverse Server Keys", description = "Tunnels (reverse server keys), target usernames, live status"),
        (name = "Service Keys", description = "Public keys of the Telepy service itself"),
        (name = "Device Keys", description = "Per-device key lists: Telepy installs users' public keys into a device's authorized_keys over SSH, removes them when access is revoked, and audits what is there"),
        (name = "Tunnel Sharing", description = "Share tunnels with other users (view / edit / admin)"),
        (name = "Command Rules", description = "Commands that the web terminal and MCP agents may not run, or only after the tunnel owner or an ADMIN approves: site-wide rules (admins), per-tunnel rules (owner / ADMIN), and the approval requests"),
        (name = "Toolbox", description = "Saved command snippets for the web terminal: your own (any tunnel), per tunnel (owner / ADMIN edit, anyone who can open its terminal uses them) and site-wide (admins edit); variables are filled in the browser"),
        (name = "Notifications", description = "In-app notification preferences (toasts and desktop notifications) per event and channel: site defaults and enforced events (admins), personal overrides and per-tunnel mutes. Personal webhooks are not affected"),
        (name = "Webhooks", description = "Personal webhooks (each person receives the notifications the web already gives them) and the admins' site-wide webhooks (a curated set of important events); event catalogue, test sends, delivery history and Standard Webhooks signing secrets"),
        (name = "Script", description = "Connection scripts and ssh config for a tunnel"),
        (name = "SFTP", description = "File manager REST endpoints"),
        (name = "Remote Browser", description = "KasmVNC proxy browser sessions"),
        (name = "Browser Automation", description = "Scripted browsers (the REST form of the MCP browser tools): open a Chromium that browses through a device, then navigate, read text, take screenshots, click and type, one action at a time"),
        (name = "API Tokens", description = "Personal API tokens: create / revoke (web sign-ins only), their call log and the catalogue of endpoints a token can call"),
        (name = "User Management", description = "Personal settings and user administration"),
        (name = "Access", description = "Feature permissions (admins): groups and which Telepy features each person may use. Separate from tunnel sharing, which decides which tunnels they reach"),
        (name = "Site Settings", description = "Site-wide settings (admins)"),
        (name = "Logs", description = "SSH gateway events"),
        (name = "Device join", description = "One-command device join: the web mints a short-lived ticket; the device's install script registers itself, installs the reverse tunnel and waits for a verified login"),
        (name = "LAN", description = "Machines on the networks behind each device: discovery through the device's sshd, the jump-host list and the topology view"),
        (name = "Two-Factor", description = "Passkeys (WebAuthn) and authenticator-app (TOTP) sign-in, recovery codes and re-authentication"),
        (name = "AI", description = "SSH sessions opened by AI agents over MCP (/mcp) and their audit trail"),
        (name = "OAuth", description = "OAuth 2.1 authorization server for MCP clients: discovery, dynamic client registration, consent, tokens, connected apps")
    )
)]
pub struct ApiDoc;

pub struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "bearer",
            SecurityScheme::Http(HttpBuilder::new().scheme(HttpAuthScheme::Bearer).bearer_format("JWT").build()),
        );
    }
}

/// 登入後才看得到的文件路由：規格 JSON、Swagger 殼頁、初始化腳本、靜態資產。
/// Login-gated documentation routes: spec JSON, Swagger shell, initializer and static assets.
pub fn router(openapi: &utoipa::openapi::OpenApi) -> Router<AppState> {
    let spec = Bytes::from(openapi.to_json().expect("OpenAPI document serialises"));
    Router::new()
        .route(
            OPENAPI_JSON_PATH,
            get(move |_user: AuthUser| {
                let spec = spec.clone();
                async move { ([(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], spec) }
            }),
        )
        .route(SWAGGER_PATH, get(|| async { Redirect::to(&format!("{SWAGGER_PATH}/")) }))
        .route(&format!("{SWAGGER_PATH}/"), get(index))
        .route(&format!("{SWAGGER_PATH}/swagger-initializer.js"), get(initializer))
        .route(&format!("{SWAGGER_PATH}/{{*file}}"), get(asset))
}

/// 頁殼：沒有任何 token 時在第一個 script 就導去登入頁，不先下載 Swagger 的 JS。
/// Shell page: without any stored token the first script redirects to login before the Swagger JS loads.
async fn index() -> Response {
    let html = format!(
        r##"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Telepy API</title>
    <script>
      if (!localStorage.getItem("accessToken") && !localStorage.getItem("refreshToken")) {{
        location.replace("{LOGIN_PATH}");
      }}
    </script>
    <link rel="stylesheet" href="./swagger-ui.css" />
    <link rel="stylesheet" href="./index.css" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="./swagger-ui-bundle.js" charset="UTF-8"></script>
    <script src="./swagger-ui-standalone-preset.js" charset="UTF-8"></script>
    <script src="./swagger-initializer.js" charset="UTF-8"></script>
  </body>
</html>
"##
    );
    (
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")), (header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        html,
    )
        .into_response()
}

/// 初始化腳本：驗證／更新前端的 access token，沒登入就導去登入頁；有登入才載入規格並帶 Bearer。
/// Initializer: verify / refresh the frontend's access token, redirect to login otherwise, then load the spec
/// with the Bearer header and inject it into every request.
async fn initializer() -> Response {
    let js = format!(
        r##"(async () => {{
  const LOGIN = "{LOGIN_PATH}";
  const SPEC = "{OPENAPI_JSON_PATH}";
  const token = () => localStorage.getItem("accessToken");
  const post = (url, body) => fetch(url, {{ method: "POST", headers: {{ "Content-Type": "application/json" }}, body: JSON.stringify(body) }});
  async function verify(t) {{
    if (!t) return false;
    try {{ return (await post("/api/auth/token/verify", {{ token: t }})).ok; }} catch {{ return false; }}
  }}
  async function refresh() {{
    const refresh = localStorage.getItem("refreshToken");
    if (!refresh) return false;
    try {{
      const r = await post("/api/auth/token/refresh", {{ refresh }});
      if (!r.ok) return false;
      const d = await r.json();
      const access = d.access_token || d.access;
      if (!access) return false;
      localStorage.setItem("accessToken", access);
      // 後端每次續期都換發 refresh token（舊的只在寬限內還能用）。/ The refresh token rotates on every renewal.
      if (d.refresh_token) localStorage.setItem("refreshToken", d.refresh_token);
      return true;
    }} catch {{ return false; }}
  }}
  if (!(await verify(token())) && !(await refresh())) {{
    location.replace(LOGIN);
    return;
  }}
  window.ui = SwaggerUIBundle({{
    url: SPEC,
    dom_id: "#swagger-ui",
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: "StandaloneLayout",
    persistAuthorization: true,
    requestInterceptor: (req) => {{
      // 「Authorize」手動填的 token 優先；否則用網頁登入的 token。/ A manual Authorize token wins; else the web login.
      const t = token();
      if (t && !req.headers["Authorization"] && !req.headers["authorization"]) req.headers["Authorization"] = "Bearer " + t;
      return req;
    }},
    responseInterceptor: async (res) => {{
      if (res.status === 401 && typeof res.url === "string" && res.url.endsWith(SPEC)) {{
        if (await refresh()) location.reload(); else location.replace(LOGIN);
      }}
      return res;
    }},
  }});
}})();
"##
    );
    (
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/javascript; charset=utf-8")), (header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        js,
    )
        .into_response()
}

/// Swagger UI 的靜態資產（vendored zip）。只是函式庫檔案，沒有任何 API 資訊。
/// Static Swagger UI assets from the vendored bundle; library files only, nothing about the API.
async fn asset(Path(file): Path<String>) -> Response {
    static CONFIG: LazyLock<Arc<Config<'static>>> = LazyLock::new(|| Arc::new(Config::from(OPENAPI_JSON_PATH)));
    match utoipa_swagger_ui::serve(&file, CONFIG.clone()) {
        Ok(Some(f)) => {
            let mut resp = (StatusCode::OK, [(header::CONTENT_TYPE, f.content_type)], f.bytes.into_owned()).into_response();
            if f.gzpipped {
                resp.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            }
            resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
            resp
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::error!(error = %e, file, "swagger asset");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
