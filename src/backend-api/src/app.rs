//! Router 組裝與中介層。/ Router assembly and middleware.

use axum::http::header;
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
        .merge(api::tunnels::router())
        .merge(api::usernames::router())
        .merge(api::user_keys::router())
        .merge(api::device_keys::router())
        .merge(api::reverse_keys::router())
        .merge(api::scripts::router())
        .merge(api::sharing::router())
        .merge(api::sessions::router())
        .merge(api::recordings::router())
        .merge(api::step_up::router())
        .merge(api::access_requests::router())
        .merge(api::command_rules::router())
        .merge(api::webhooks::router())
        .merge(api::users::router())
        .merge(api::site_settings::router())
        .merge(api::logs::router())
        .merge(api::sftp::router())
        .merge(api::remote_browser::router())
        .merge(api::desktop::router())
        .merge(api::rustdesk::router())
        .merge(api::credentials::router())
        .merge(api::host_keys::router())
        .merge(api::oauth::router())
        .merge(api::ai::router())
        .merge(api::mfa::router())
        .merge(api::sign_ins::router())
        .merge(api::whoami::router())
        .merge(api::lan::router())
        .merge(api::join::router())
        .merge(api::terminal_profile::router())
        .merge(api::terminal_schemes::router())
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
    if state.config.openapi_enabled {
        // Swagger UI 沿用 Django 時代的路徑；spec 在 /api/openapi.json。兩者都要登入（見 api/doc.rs），
        // OPENAPI_ENABLED=false 可整組關掉。/ Login-gated Swagger UI + spec (see api/doc.rs); OPENAPI_ENABLED=false removes both.
        rest = rest.merge(api::doc::router(&openapi));
    }
    let rest = rest.layer(CompressionLayer::new());

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

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}
