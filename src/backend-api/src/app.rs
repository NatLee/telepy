//! Router 組裝與中介層。/ Router assembly and middleware.

use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;

use crate::api;
use crate::api::doc::ApiDoc;
use crate::state::AppState;
use crate::ws;

/// 所有 REST 路由；`OpenApiRouter` 在收集路由的同時產生 OpenAPI path items。
/// Every REST route; the `OpenApiRouter` collects the OpenAPI path items as a side effect.
fn api_router() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .merge(api::auth::router())
        .merge(api::api_tokens::router())
        .merge(api::tunnels::router())
        .merge(api::usernames::router())
        .merge(api::user_keys::router())
        .merge(api::device_keys::router())
        .merge(api::groups::router())
        .merge(api::reverse_keys::router())
        .merge(api::scripts::router())
        .merge(api::sharing::router())
        .merge(api::sessions::router())
        .merge(api::recordings::router())
        .merge(api::terminal_detach::router())
        .merge(api::step_up::router())
        .merge(api::access_requests::router())
        .merge(api::command_rules::router())
        .merge(api::snippets::router())
        .merge(api::webhooks::router())
        .merge(api::users::router())
        .merge(api::access::router())
        .merge(api::site_settings::router())
        .merge(api::logs::router())
        .merge(api::sftp::router())
        .merge(api::remote_browser::router())
        .merge(api::browser::router())
        .merge(api::desktop::router())
        .merge(api::rustdesk::router())
        .merge(api::credentials::router())
        .merge(api::host_keys::router())
        .merge(api::device_install::router())
        .merge(api::oauth::router())
        .merge(api::ai::router())
        .merge(api::mfa::router())
        .merge(api::sign_ins::router())
        .merge(api::web_sessions::router())
        .merge(api::whoami::router())
        .merge(api::health::router())
        .merge(api::health_stats::router())
        .merge(api::carriers::router())
        .merge(api::datasets::router())
        .merge(api::address_sources::router())
        .merge(api::ssh_host::router())
        .merge(api::lan::router())
        .merge(api::join::router())
        .merge(api::terminal_profile::router())
        .merge(api::shell_history::router())
        .merge(api::terminal_schemes::router())
        .merge(api::notify_prefs::router())
}

/// 完整的 OpenAPI 文件（不需要 AppState；`telepy-server openapi` 子命令與測試用）。
/// The full OpenAPI document; needs no state (used by the `openapi` subcommand and tests).
pub fn openapi() -> utoipa::openapi::OpenApi {
    api_router().split_for_parts().1
}

pub fn build(state: AppState) -> Router {
    // Django：CORS_ALLOW_ALL_ORIGINS + CORS_ALLOW_CREDENTIALS → 回應 echo Origin。
    // tower-http 不允許 `*` 搭配 credentials，所以用 mirror（語意相同）。
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
        .allow_credentials(true)
        .expose_headers([header::CONTENT_DISPOSITION, header::WWW_AUTHENTICATE, header::HeaderName::from_static("mcp-session-id")]);

    let (mut rest, openapi) = api_router().split_for_parts();
    rest = rest.route("/healthz", get(healthz));
    // Swagger UI 沿用 Django 時代的路徑；spec 在 /api/openapi.json。兩者都要登入（見 api/doc.rs）。開關
    // （OPENAPI_ENABLED / 網站設定）每個請求讀，關掉時整組回 404。
    // Login-gated Swagger UI + spec (see api/doc.rs); the switch (OPENAPI_ENABLED / the site setting) is read per
    // request and answers 404 for both while off.
    rest = rest.merge(api::doc::router(&openapi).route_layer(axum::middleware::from_fn_with_state(state.clone(), openapi_gate)));
    let rest = rest.layer(CompressionLayer::new()).layer(axum::middleware::from_fn_with_state(state.clone(), token_calls)).layer(axum::middleware::from_fn_with_state(state.clone(), ssh_host_guard));

    // WebSocket 與 MCP 路由不掛壓縮層（升級回應沒有 body；MCP 可能回 SSE 串流）。
    // No compression on WebSockets (no body) or MCP (may stream SSE).
    Router::new()
        .merge(rest)
        .merge(ws::router())
        .merge(crate::mcp::router(state.clone()))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// 委派 token（個人 API token / OAuth app）打的 REST 請求：每一個都進呼叫紀錄（`api_calls`，路由樣板、狀態、耗時；
/// 背景批次寫入）；通過檢查的寫入另外記一筆 `token_call` gateway 事件，Logs 頁上看得到「誰透過哪把 token 做了什麼」
/// （handler 自己的事件照常寫）。`/api/ai/` 有自己的稽核，不寫 gateway 事件。
/// Every REST request made with a delegated token goes into the call log (route template, status, duration; written
/// in the background); writes that passed the checks also get a `token_call` gateway event. `/api/ai/` has its own
/// audit trail, so no gateway event there.
/// 用 SSH 主機的名稱看網頁時擋住登入（`ssh_host::arrives_on_ssh_host`）：那個名稱只是給 SSH 用的，網頁在 `PUBLIC_URL`。
/// 只擋會建立登入的端點（登入、註冊、續期），回 421 + 正確的網址；其他請求不動，設定不全時完全不擋。
/// Refuse sign-ins through the SSH host's name: that name is for SSH, the web lives at PUBLIC_URL. Only the endpoints
/// that create or renew a sign-in get 421 + the right address; anything else passes, and nothing is blocked unless
/// both names are configured and differ.
async fn ssh_host_guard(axum::extract::State(state): axum::extract::State<AppState>, req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    const SIGN_IN: &[&str] = &["/api/auth/token", "/api/auth/token/refresh", "/api/auth/google/token", "/api/auth/passkey/login", "/api/auth/register"];
    if req.method() == axum::http::Method::POST && SIGN_IN.contains(&req.uri().path()) {
        let public = state.config.public_base();
        let web = crate::ssh_host::web_host(public.as_deref());
        let ssh = state.config.ssh_host();
        let here = crate::ssh_host::request_host(req.headers());
        if crate::ssh_host::arrives_on_ssh_host(here.as_deref(), web.as_deref(), ssh.as_deref()) {
            let body = serde_json::json!({ "error": "This address is Telepy's SSH host; sign in at the web address.", "code": "ssh_host", "public_url": public });
            return (axum::http::StatusCode::MISDIRECTED_REQUEST, axum::Json(body)).into_response();
        }
    }
    next.run(req).await
}

async fn token_calls(axum::extract::State(state): axum::extract::State<AppState>, mut req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let slot = crate::auth::extractor::TokenCallSlot::default();
    req.extensions_mut().insert(slot.clone());
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let template = req.extensions().get::<axum::extract::MatchedPath>().map(|m| m.as_str().to_string());
    let started = std::time::Instant::now();
    let resp = next.run(req).await;
    if let Some(call) = slot.get() {
        let status = resp.status().as_u16();
        let route = template.unwrap_or_else(|| path.clone());
        state.api_calls.record(crate::api_calls::NewCall {
            at: crate::util::now_db(),
            user_id: call.user_id,
            token_id: call.credential.token_id(),
            grant_id: call.credential.grant_id(),
            client_name: call.client_name.clone(),
            kind: "rest",
            method: method.to_string(),
            route,
            tunnel_id: call.tunnel_id,
            status: i64::from(status),
            duration_ms: started.elapsed().as_millis() as i64,
            ip: call.ip.clone(),
            error: None,
        });
        if call.passed && !matches!(method, axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS) && !path.starts_with("/api/ai/") {
            let msg = format!("{} via {}: {method} {path} → {status}", call.username, call.client_name);
            state.gateway.event("token_call", None, None, call.tunnel_id, msg).await;
        }
    }
    resp
}

/// API 文件關掉時回 404（跟沒有這條路由一樣）。/ 404 while the API docs are off, as if the route didn't exist.
async fn openapi_gate(axum::extract::State(state): axum::extract::State<AppState>, req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    if !state.config.openapi_on() {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    next.run(req).await
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}
