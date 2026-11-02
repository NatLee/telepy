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
//!
//! 重新封存審計鏈：知道原因之後（例如資料庫從備份還原、從別台搬來），管理員可以把現在的列封成新的基準——鏈重算、
//! 舊的錨點行作廢，誰、什麼時候、為什麼記在資料庫、audit-anchors.log 與 Logs（`audit_reseal`）。
//! `GET /api/site/health/audit` 是試算（每張表的問題、要重算幾列、作廢幾行、之前的封存）。
//! Re-sealing the audit chain: once the cause is known (a database restored from a backup or moved over), an admin
//! makes the rows as they are the new baseline — the chain is re-hashed and old anchors lines are set aside, with
//! who / when / why kept in the database, audit-anchors.log and the Logs (`audit_reseal`).
//! `GET /api/site/health/audit` is the dry run (each table's problem, rows to re-hash, lines to set aside, earlier
//! re-seals).

use axum::extract::{Path, Query, State};
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
/// 試算最多回幾筆封存紀錄（每張表一筆）。/ Re-seal records the dry run returns at most (one per table).
const RESEAL_HISTORY_MAX: usize = 1000;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(server_health))
        .routes(routes!(acknowledge))
        .routes(routes!(remove_ack))
        .routes(routes!(audit_plan))
        .routes(routes!(audit_reseal))
}

/// 說明必填（去頭尾空白後 1–500 字元）。/ A note is required: 1–500 characters once trimmed.
fn check_note(note: &str, empty: &str) -> ApiResult<()> {
    if note.is_empty() {
        return Err(ApiError::field("note", empty));
    }
    if note.chars().count() > NOTE_MAX {
        return Err(ApiError::field("note", format!("At most {NOTE_MAX} characters.")));
    }
    Ok(())
}

fn not_a_problem(msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": msg, "code": "not_a_problem" }))
}

fn changed() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, json!({ "error": "The result has changed since the page loaded. Look at it again first.", "code": "changed" }))
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
async fn respond(state: &AppState, checks: Vec<Check>) -> ApiResult<impl IntoResponse> {
    let body = health_body(state, checks).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)))
}

async fn health_body(state: &AppState, mut checks: Vec<Check>) -> ApiResult<Value> {
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
    Ok(body)
}

/// 跑檢查。審計鏈：`fresh` = 現在驗；否則用背景最近一次的驗證（每 10 分鐘一次），太舊才現在驗。
/// Run the checks. The audit chain: `fresh` = verify now; otherwise the background's latest verification (every 10
/// minutes), verified now only when that is too old.
async fn run_checks(state: &AppState, fresh: bool) -> Vec<Check> {
    let audit_max_age = (!fresh).then_some(db::audit_chain::VERIFIED_FRESH);
    doctor::run_with(&state.config, Ok(state.db.clone()), audit_max_age).await
}

/// 確認 / 取消時重跑：審計鏈用頁面看到的那份（指紋才對得上）。/ Reruns for acknowledgements use the audit result the page showed.
async fn run(state: &AppState) -> Vec<Check> {
    run_checks(state, false).await
}

#[derive(Debug, Default, serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct HealthQuery {
    /// `1` / `true`: verify the audit chain now instead of reusing the background verification (at most 11 minutes old)
    pub fresh: Option<String>,
}

#[utoipa::path(get, path = "/api/site/health", tag = "Site Settings", security(("bearer" = [])), params(HealthQuery), responses(
    (status = 200, description = "The `telepy-server doctor` checks run now (superusers): configuration, database, service and host keys, companion services, GeoIP, recent client addresses, audit chain; each with its fingerprint and acknowledgement. Independent checks run at the same time. The audit chain reuses the background verification (every 10 minutes; `checked_at` says when) unless `fresh=1`", body = super::schemas::ServerHealth),
    (status = 403, body = super::schemas::ErrorBody)
))]
async fn server_health(State(state): State<AppState>, AuthUser(me): AuthUser, Query(q): Query<HealthQuery>) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    let fresh = matches!(q.fresh.as_deref().map(str::trim), Some("1" | "true" | "yes"));
    let checks = run_checks(&state, fresh).await;
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
    check_note(&note, "Say why this is known and fine for now.")?;
    mfa::require_reauth(&state, &headers, &me, body.get("reauth")).await?;
    let checks = run(&state).await;
    let Some(c) = checks.iter().find(|c| c.id == check_id && c.status.is_problem()) else {
        return Err(not_a_problem("Only a current warning or failure can be acknowledged."));
    };
    if c.fingerprint != sent_fp {
        return Err(changed());
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

/// 每張失敗的表與它的問題（`doctor` 的說法）。/ Each failing table with its problem, as the doctor says it.
fn failing_tables(report: &db::audit_chain::Report) -> Vec<(db::audit_chain::Table, String)> {
    report.tables.iter().filter(|t| !t.ok).filter_map(|t| db::audit_chain::Table::from_name(&t.table).map(|tb| (tb, doctor::audit_problem(t)))).collect()
}

#[utoipa::path(get, path = "/api/site/health/audit", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "The audit-log check now and what re-sealing would do (superusers): per table the verification, its problem, rows to re-hash and anchors-file lines to set aside; earlier re-seals, newest first (at most 1000 records)", body = super::schemas::AuditResealPlan),
    (status = 403, body = super::schemas::ErrorBody)
))]
async fn audit_plan(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    let (check, report) = doctor::audit_log_check(&state.db).await;
    let mut tables = Vec::new();
    if let Some(report) = &report {
        let failing = failing_tables(report);
        let plans = db::audit_chain::reseal_plan(&state.db, &failing.iter().map(|f| f.0).collect::<Vec<_>>()).await.map_err(|e| ApiError::internal(format!("{e:#}")))?;
        for t in &report.tables {
            let mut v = serde_json::to_value(t).map_err(|e| ApiError::internal(e.to_string()))?;
            let plan = plans.iter().find(|p| p.table == t.table);
            let problem = failing.iter().find(|f| f.0.name() == t.table).map(|f| f.1.clone());
            if let Value::Object(m) = &mut v {
                m.insert("problem".into(), json!(problem));
                m.insert("rehash".into(), json!(plan.map(|p| p.rehash).unwrap_or(0)));
                m.insert("from_row".into(), json!(plan.and_then(|p| p.from_row)));
                m.insert("retire".into(), json!(plan.map(|p| p.retire).unwrap_or(0)));
            }
            tables.push(v);
        }
    }
    let mut reseals = db::audit_chain::list_reseals(&state.db).await?;
    // 全部給（每次封存是管理員刻意做的事，不會多到哪去），頁面自己分頁；上限只是保險。
    // All of them (each is a deliberate admin act, so they stay few); the page pages them. The cap is a safeguard.
    reseals.reverse();
    reseals.truncate(RESEAL_HISTORY_MAX);
    let body = json!({
        "status": check.status.as_str(),
        "fingerprint": check.fingerprint,
        "detail": check.detail,
        "can_reseal": check.status == Status::Fail,
        "tables": tables,
        "reseals": reseals,
        "anchors_file": state.db.audit.anchors_file().is_some(),
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)))
}

#[utoipa::path(post, path = "/api/site/health/audit/reseal", tag = "Site Settings", security(("bearer" = [])), request_body = super::schemas::AuditResealBody, responses(
    (status = 200, description = "Re-sealed; the whole health answer, as GET, plus `resealed` (one record per table)", body = super::schemas::ServerHealth),
    (status = 400, description = "{note: [msg]}, or code not_a_problem (the audit log is not failing now)", body = super::schemas::ErrorBody),
    (status = 403, description = "admin_only, or reauth_required", body = super::schemas::MfaError),
    (status = 409, description = "code changed: the audit-log result differs from the fingerprint sent", body = super::schemas::ErrorBody)
))]
async fn audit_reseal(State(state): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    let sent_fp = body.get("fingerprint").and_then(Value::as_str).unwrap_or_default().to_string();
    let note = body.get("note").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    check_note(&note, "Say what happened, so whoever reads the audit log later knows why it was re-sealed.")?;
    mfa::require_reauth(&state, &headers, &me, body.get("reauth")).await?;
    let (check, report) = doctor::audit_log_check(&state.db).await;
    let Some(report) = report.filter(|_| check.status == Status::Fail) else {
        return Err(not_a_problem("Only a failing audit log can be re-sealed."));
    };
    if check.fingerprint != sent_fp {
        return Err(changed());
    }
    let targets = failing_tables(&report);
    let by = db::audit_chain::ResealBy { user_id: Some(me.id), username: &me.username, note: &note };
    let done = db::audit_chain::reseal(&state.db, &targets, &by).await.map_err(|e| ApiError::internal(format!("cannot re-seal the audit log: {e:#}")))?;
    // 記進 Logs（寫在新的鏈頭後面）。/ Into the Logs, after the new head.
    let parts: Vec<String> = done.iter().map(reseal_summary).collect();
    let msg = format!("{} re-sealed the audit log: {}. Note: {note}", me.username, parts.join("; "));
    state.gateway.event("audit_reseal", None, None, None, msg).await;
    let checks = run_checks(&state, true).await;
    let mut out = health_body(&state, checks).await?;
    if let Value::Object(m) = &mut out {
        m.insert("resealed".into(), serde_json::to_value(&done).map_err(|e| ApiError::internal(e.to_string()))?);
    }
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(out)))
}

/// Logs 的一句：哪張表、原本的問題、重算幾列、作廢幾行。/ One clause for the Logs: table, problem, rows re-hashed, lines set aside.
fn reseal_summary(r: &db::audit_chain::ResealRecord) -> String {
    let rows = match r.from_row {
        Some(from) => format!("{} rows re-hashed from row {from}", r.rehashed),
        None => "no rows re-hashed".to_string(),
    };
    let problem = r.problem.strip_prefix(&format!("{}: ", r.table)).unwrap_or(&r.problem);
    format!("{} (was {problem}; {rows}, {} earlier checkpoints set aside)", r.table, r.retired)
}
