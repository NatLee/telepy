//! Step-up（見 [`crate::step_up`]）的 API：換一個 step-up token、開關隧道的 `require_step_up`，以及 REST 端的檢查。
//! Step-up API: exchange a second-factor proof for a token, switch a tunnel's `require_step_up`, and the REST check.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{mfa, notify, AppJson};
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Tunnel};
use crate::error::{ApiError, ApiResult};
use crate::permissions;
use crate::state::AppState;
use crate::step_up;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(grant)).routes(routes!(set_required))
}

fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// REST 請求帶的 step-up token。/ The step-up token on a REST request.
pub fn token(headers: &HeaderMap) -> Option<&str> {
    headers.get(step_up::HEADER).and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty())
}

/// REST 端的檢查：敏感隧道沒有有效 token → 403 `step_up_required`。/ REST check: 403 `step_up_required` without a valid token.
pub fn check(state: &AppState, user_id: i64, t: &Tunnel, headers: &HeaderMap) -> ApiResult<()> {
    if step_up::allows(t.require_step_up, &state.step_up, user_id, token(headers)) {
        return Ok(());
    }
    Err(coded(StatusCode::FORBIDDEN, "step_up_required", format!("\"{}\" asks you to confirm it's you before opening it.", t.host_friendly_name)))
}

/// 用第二因素換一個 15 分鐘的 step-up token（只屬於這個瀏覽器）。帳號沒有第二因素時 403 `step_up_enroll`。
/// Exchange a second-factor proof for a 15-minute, browser-bound step-up token. 403 `step_up_enroll` without a factor.
#[utoipa::path(post, path = "/api/auth/step-up", tag = "Two-Factor", security(("bearer" = [])), request_body = super::schemas::ReauthRequest, responses((status = 200, body = super::schemas::StepUpGrant), (status = 400, description = "mfa_invalid", body = super::schemas::MfaError), (status = 403, description = "reauth_required (with methods) / step_up_enroll", body = super::schemas::MfaError)))]
async fn grant(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    if !mfa::factors(&state, user.id).await?.any() {
        return Err(coded(StatusCode::FORBIDDEN, "step_up_enroll", "Set up two-step sign-in (an authenticator app or a passkey) to open tunnels that ask you to confirm it's you."));
    }
    mfa::require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    let (token, _) = state.step_up.grant(user.id);
    let window = step_up::WINDOW.as_secs() as i64;
    let until = Utc::now() + chrono::Duration::seconds(window);
    Ok(Json(json!({ "token": token, "until": until.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), "window_secs": window })))
}

/// 開 / 關隧道的 step-up（owner / ADMIN）。打開時自己要有第二因素（不然自己也進不去）；關掉要再確認一次。
/// Switch a tunnel's step-up (owner / ADMIN). Turning it on needs a second factor of your own (or you'd lock yourself
/// out); turning it off needs a re-authentication.
#[utoipa::path(put, path = "/api/reverse/server/{id}/step-up", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::StepUpSetting, responses((status = 200, body = super::schemas::StepUpSetting), (status = 400, description = "step_up_enroll", body = super::schemas::ErrorBody), (status = 403, description = "Needs owner / ADMIN, or reauth_required", body = super::schemas::MfaError), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_required(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let not_found = || ApiError::not_found("Tunnel not found");
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(not_found)?;
    let eff = permissions::effective_for(&state.db, user.id, &t).await?.ok_or_else(not_found)?;
    if !eff.satisfies(permissions::Permission::Admin) {
        return Err(ApiError::forbidden("Only the tunnel owner or an ADMIN sharee can change this."));
    }
    let required = body.get("required").and_then(Value::as_bool).ok_or_else(|| ApiError::field("required", "required must be true or false"))?;
    if required == t.require_step_up {
        return Ok(Json(json!({ "required": required })));
    }
    if required {
        if !mfa::factors(&state, user.id).await?.any() {
            return Err(coded(StatusCode::BAD_REQUEST, "step_up_enroll", "Set up two-step sign-in on your own account first, or you couldn't open this tunnel either."));
        }
    } else {
        mfa::require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    }
    db::tunnels::set_require_step_up(&state.db, t.id, required).await?;
    let t = db::tunnels::by_id(&state.db, t.id).await?.unwrap_or(t);
    notify::tunnel_updated(&state, &t).await?;
    let what = if required { "now asks everyone to confirm it's you before a session" } else { "no longer asks for a step-up" };
    state
        .gateway
        .event("step_up_setting", None, u16::try_from(t.reverse_port).ok(), Some(t.id), format!("{} changed tunnel {}: {what}", user.username, t.host_friendly_name))
        .await;
    Ok(Json(json!({ "required": required })))
}
