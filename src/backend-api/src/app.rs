//! Router 組裝與中介層。/ Router assembly and middleware.

use axum::http::header;
use axum::routing::get;
use axum::{Json, Router};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::api;
use crate::ws;
use crate::state::AppState;

pub fn build(state: AppState) -> Router {
    // Django：CORS_ALLOW_ALL_ORIGINS + CORS_ALLOW_CREDENTIALS → 回應 echo Origin。
    // tower-http 不允許 `*` 搭配 credentials，所以用 mirror（語意相同）。
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
        .allow_credentials(true)
        .expose_headers([header::CONTENT_DISPOSITION]);

    let rest = Router::new()
        .merge(api::auth::router())
        .merge(api::tunnels::router())
        .merge(api::usernames::router())
        .merge(api::user_keys::router())
        .merge(api::reverse_keys::router())
        .merge(api::scripts::router())
        .merge(api::sharing::router())
        .merge(api::users::router())
        .merge(api::site_settings::router())
        .merge(api::logs::router())
        .merge(api::internal::router())
        .route("/healthz", get(healthz))
        .layer(CompressionLayer::new());

    // WebSocket 路由不掛壓縮層（升級回應沒有 body；與 Traefik 的 /ws router 一致）。
    Router::new()
        .merge(rest)
        .merge(ws::router())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}
