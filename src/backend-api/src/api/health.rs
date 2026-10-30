//! `GET /api/site/health`（管理員）：`telepy-server doctor` 的同一組檢查，從網頁看——用後端自己開著的資料庫，
//! 不必 shell 進容器。只讀；每次呼叫重跑（審計鏈驗證也在內，所以不要自動輪詢）。
//! The admin "Server health" page: the same checks as `telepy-server doctor`, run on the backend's own open
//! database so nobody has to shell into the container. Read-only; every call runs them again (the audit-chain
//! verification included, so the page does not poll).
//!
//! 確認：管理員可以把一個已知的 ⚠ / ✗ 標成「已確認」（附說明），頁面就不再當成警報；確認綁在那個結果的指紋上，
//! 問題一變（新的列被改、更多不符…）就失效，變回 ✓ 時自動刪掉。
//! Acknowledgements: an admin marks a known warning / failure as acknowledged (with a note) so the page stops
//! treating it as an alert. It is tied to the result's fingerprint, so a changed problem shows up again, and it is
//! removed once the check passes.

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{mfa, AppJson};
use crate::auth::AuthUser;
use crate::db::{self, health_acks::AckRow};
use crate::doctor::{self, Check, Status};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// 說明的長度上限（字元）。/ Longest note, in characters.
const NOTE_MAX: usize = 500;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(server_health)).routes(routes!(acknowledge)).routes(routes!(remove_ack))
}

fn admin_only(me: &crate::db::users::User) -> ApiResult<()> {
    if me.is_superuser {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Only administrators can see the server's health.", "code": "admin_only" })))
    }
}

/// GET / POST / DELETE 共用的回應：重新對確認（剛寫的也算），已經沒問題的確認順手刪掉。
/// The body shared by GET / POST / DELETE: match acknowledgements again (fresh writes included) and drop the
/// ones whose check passes now.
async fn respond(state: &AppState, mut checks: Vec<Check>) -> ApiResult<impl IntoResponse> {
    let stored = db::health_acks::list(&state.db).await?;
    let resolved = doctor::apply_acks(&mut checks, &stored);
    if !resolved.is_empty() {
        db::health_acks::delete_many(&state.db, &resolved).await?;
    }
    let count = |st: Status| checks.iter().filter(|c| c.status == st).count();
    let acknowledged = checks.iter().filter(|c| c.ack.is_some()).count();
    let body = json!({
        "checks": checks,
        "ok": count(Status::Ok),
        "info": count(Status::Info),
        "warnings": count(Status::Warn),
        "failures": count(Status::Fail),
        "acknowledged": acknowledged,
        "ran_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)))
}

async fn run(state: &AppState) -> Vec<Check> {
    doctor::run_with(&state.config, Ok(state.db.clone())).await
}

#[utoipa::path(get, path = "/api/site/health", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "The `telepy-server doctor` checks run now (superusers): configuration, database, service and host keys, companion services, GeoIP, recent client addresses, audit chain; each with its fingerprint and acknowledgement", body = super::schemas::ServerHealth),
    (status = 403, body = super::schemas::ErrorBody)
))]
async fn server_health(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    let checks = run(&state).await;
    respond(&state, checks).await
}

#[utoipa::path(post, path = "/api/site/health/ack", tag = "Site Settings", security(("bearer" = [])), request_body = super::schemas::HealthAckBody, responses(
    (status = 200, description = "Acknowledged; the whole health answer, as GET", body = super::schemas::ServerHealth),
    (status = 400, description = "{note: [msg]}, or code not_a_problem (the check is not a warning / failure now)", body = super::schemas::ErrorBody),
    (status = 403, description = "admin_only, or reauth_required", body = super::schemas::MfaError),
    (status = 409, description = "code changed: the result differs from the fingerprint sent", body = super::schemas::ErrorBody)
))]
async fn acknowledge(State(state): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    let check_id = body.get("check_id").and_then(Value::as_str).unwrap_or_default().to_string();
    let sent_fp = body.get("fingerprint").and_then(Value::as_str).unwrap_or_default().to_string();
    let note = body.get("note").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    if note.is_empty() {
        return Err(ApiError::field("note", "Say why this is known and fine for now."));
    }
    if note.chars().count() > NOTE_MAX {
        return Err(ApiError::field("note", format!("At most {NOTE_MAX} characters.")));
    }
    mfa::require_reauth(&state, &headers, &me, body.get("reauth")).await?;
    let checks = run(&state).await;
    let Some(c) = checks.iter().find(|c| c.id == check_id && c.status.is_problem()) else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Only a current warning or failure can be acknowledged.", "code": "not_a_problem" }),
        ));
    };
    if c.fingerprint != sent_fp {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            json!({ "error": "The result has changed since the page loaded. Look at it again first.", "code": "changed" }),
        ));
    }
    let row = AckRow {
        check_id: c.id.to_string(),
        fingerprint: c.fingerprint.clone(),
        status: c.status.as_str().to_string(),
        note: note.clone(),
        user_id: Some(me.id),
        username: me.username.clone(),
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    };
    db::health_acks::upsert(&state.db, &row).await?;
    let msg = format!("{} acknowledged \"{}\" ({}): {note}", me.username, c.name, c.status.as_str());
    state.gateway.event("health_ack", None, None, None, msg).await;
    respond(&state, checks).await
}

#[utoipa::path(delete, path = "/api/site/health/ack/{check_id}", tag = "Site Settings", security(("bearer" = [])), params(("check_id" = String, Path, description = "The check's id, e.g. audit_log")), responses(
    (status = 200, description = "Removed; the whole health answer, as GET", body = super::schemas::ServerHealth),
    (status = 403, body = super::schemas::ErrorBody),
    (status = 404, description = "No acknowledgement for that check", body = super::schemas::ErrorBody)
))]
async fn remove_ack(State(state): State<AppState>, AuthUser(me): AuthUser, Path(check_id): Path<String>) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    if !db::health_acks::delete(&state.db, &check_id).await? {
        return Err(ApiError::new(StatusCode::NOT_FOUND, json!({ "error": "That check has no acknowledgement.", "code": "not_found" })));
    }
    let checks = run(&state).await;
    let name = checks.iter().find(|c| c.id == check_id).map(|c| c.name.to_string()).unwrap_or_else(|| check_id.clone());
    state.gateway.event("health_ack", None, None, None, format!("{} removed the acknowledgement of \"{name}\"", me.username)).await;
    respond(&state, checks).await
}
