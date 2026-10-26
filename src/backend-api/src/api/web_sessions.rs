//! 「你的裝置」：列出自己（管理員：任何人）還有效的網頁登入，並登出其中一個或全部。
//! 撤銷 = refresh token 立刻不能續期、這個 session 的 access token 在 5 秒內（同一個 process 立刻）被拒、
//! 那個瀏覽器開著的 WebSocket 以 4010 關閉（`auth::sessions::revoked`）。
//! "Your devices": list the live web sign-ins of yourself (admins: anyone) and sign one or all of them out.
//! Revoking stops the refresh token at once, rejects the session's access tokens (immediately in this process,
//! ≤ 5 s elsewhere) and closes that browser's open WebSockets with 4010.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::extractor::CurrentSession;
use crate::auth::sessions;
use crate::auth::AuthUser;
use crate::db::{self, web_sessions::WebSession};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::db_to_iso_utc_z;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(mine, revoke_mine_all))
        .routes(routes!(revoke_mine))
        .routes(routes!(for_user, revoke_user_all))
        .routes(routes!(revoke_user))
}

fn session_json(state: &AppState, s: &WebSession, current: Option<i64>) -> Value {
    json!({
        "id": s.id,
        "ip": s.ip,
        "geo": state.geoip.json(s.ip.as_deref()),
        "user_agent": s.user_agent,
        "device": crate::auth::devices::ua_family(s.user_agent.as_deref()),
        "created_at": db_to_iso_utc_z(&s.created_at),
        "last_seen_at": db_to_iso_utc_z(&s.last_used_at),
        "expires_at": db_to_iso_utc_z(&s.expires_at),
        "current": current == Some(s.id),
        "sign_in_method": s.method,
        "mfa_method": s.second_factor,
    })
}

async fn list(state: &AppState, user_id: i64, current: Option<i64>) -> ApiResult<Json<Value>> {
    let rows = db::web_sessions::active_for_user(&state.db, user_id).await?;
    let lt = sessions::lifetimes(state).await?;
    Ok(Json(json!({
        "sessions": rows.iter().map(|s| session_json(state, s, current)).collect::<Vec<_>>(),
        "signin_lifetime": lt.signin.as_secs(),
        "access_lifetime": lt.access.as_secs(),
    })))
}

/// 撤銷一個屬於 `user_id` 的 session；不是他的 / 已結束 = 404。/ Revoke one of the user's sessions; 404 otherwise.
async fn revoke_one(state: &AppState, user_id: i64, sid: i64, reason: &str) -> ApiResult<Json<Value>> {
    let owned = db::web_sessions::by_id(&state.db, sid).await?.is_some_and(|s| s.user_id == user_id && s.revoked_at.is_none());
    if !owned || !sessions::revoke_sid(state, sid, reason).await? {
        return Err(ApiError::not_found("Session not found."));
    }
    Ok(Json(json!({ "revoked": 1 })))
}

fn others(q: &HashMap<String, String>) -> bool {
    matches!(q.get("others").map(String::as_str), Some("1" | "true" | "yes"))
}

fn require_admin(me: &crate::db::users::User) -> ApiResult<()> {
    if me.is_superuser {
        Ok(())
    } else {
        Err(ApiError::forbidden("Permission denied. Only administrators can manage other users' sign-ins."))
    }
}

#[utoipa::path(get, path = "/api/auth/sessions", tag = "Login", security(("bearer" = [])), responses((status = 200, description = "Your live web sign-ins (one per browser), most recently used first; `current` = this browser", body = super::schemas::WebSessionList)))]
async fn mine(State(state): State<AppState>, AuthUser(user): AuthUser, CurrentSession(current): CurrentSession) -> ApiResult<Json<Value>> {
    list(&state, user.id, current).await
}

#[utoipa::path(delete, path = "/api/auth/sessions", tag = "Login", security(("bearer" = [])), params(("others" = Option<String>, Query, description = "1 = every session except this browser's; otherwise every session, this one included")), responses((status = 200, description = "{\"revoked\": n}", body = Object)))]
async fn revoke_mine_all(State(state): State<AppState>, AuthUser(user): AuthUser, CurrentSession(current): CurrentSession, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let except = if others(&q) { current } else { None };
    let n = sessions::revoke_all(&state, user.id, except, "user").await?;
    tracing::info!(user = %user.username, revoked = n, keep_current = except.is_some(), "signed out other sessions");
    Ok(Json(json!({ "revoked": n })))
}

#[utoipa::path(delete, path = "/api/auth/sessions/{id}", tag = "Login", security(("bearer" = [])), params(("id" = i64, Path, description = "Session id")), responses((status = 200, description = "{\"revoked\": 1}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn revoke_mine(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    revoke_one(&state, user.id, id, "user").await
}

#[utoipa::path(get, path = "/api/user/users/{id}/sessions", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 200, description = "That user's live web sign-ins (admins only)", body = super::schemas::WebSessionList), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn for_user(State(state): State<AppState>, AuthUser(me): AuthUser, CurrentSession(current): CurrentSession, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    require_admin(&me)?;
    db::users::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    list(&state, id, current).await
}

#[utoipa::path(delete, path = "/api/user/users/{id}/sessions", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 200, description = "Every live sign-in of that user ended (reason admin): {\"revoked\": n}", body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn revoke_user_all(State(state): State<AppState>, AuthUser(me): AuthUser, CurrentSession(current): CurrentSession, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    require_admin(&me)?;
    let target = db::users::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    // 管理員登出自己的全部時保留眼前這個瀏覽器。/ An admin signing themselves out everywhere keeps this browser.
    let except = if id == me.id { current } else { None };
    let n = sessions::revoke_all(&state, id, except, "admin").await?;
    tracing::info!(admin = %me.username, user = %target.username, revoked = n, "admin signed a user out");
    Ok(Json(json!({ "revoked": n })))
}

#[utoipa::path(delete, path = "/api/user/users/{id}/sessions/{sid}", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path), ("sid" = i64, Path, description = "Session id")), responses((status = 200, description = "{\"revoked\": 1}", body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn revoke_user(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, sid)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    require_admin(&me)?;
    let r = revoke_one(&state, id, sid, "admin").await?;
    tracing::info!(admin = %me.username, user_id = id, session = sid, "admin ended a sign-in");
    Ok(r)
}
