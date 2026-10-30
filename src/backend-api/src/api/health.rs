//! `GET /api/site/health`（管理員）：`telepy-server doctor` 的同一組檢查，從網頁看——用後端自己開著的資料庫，
//! 不必 shell 進容器。只讀；每次呼叫重跑（審計鏈驗證也在內，所以不要自動輪詢）。
//! The admin "Server health" page: the same checks as `telepy-server doctor`, run on the backend's own open
//! database so nobody has to shell into the container. Read-only; every call runs them again (the audit-chain
//! verification included, so the page does not poll).

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::AuthUser;
use crate::doctor::{self, Status};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(server_health))
}

#[utoipa::path(get, path = "/api/site/health", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "The `telepy-server doctor` checks run now (superusers): configuration, database, service and host keys, companion services, GeoIP, recent client addresses, audit chain", body = super::schemas::ServerHealth),
    (status = 403, body = super::schemas::ErrorBody)
))]
async fn server_health(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<impl IntoResponse> {
    if !me.is_superuser {
        return Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Only administrators can see the server's health.", "code": "admin_only" })));
    }
    let checks = doctor::run_with(&state.config, Ok(state.db.clone())).await;
    let count = |st: Status| checks.iter().filter(|c| c.status == st).count();
    let body = json!({
        "checks": checks,
        "ok": count(Status::Ok),
        "info": count(Status::Info),
        "warnings": count(Status::Warn),
        "failures": count(Status::Fail),
        "ran_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)))
}
