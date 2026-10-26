//! 登入紀錄：`GET /api/auth/sign-ins`（自己的）與 `GET /api/user/users/{id}/sign-ins`（管理員看任何人）。
//! 寫入點在各登入流程（帳密 / Google / passkey / 2FA），經 [`record`]。
//! Sign-in history: your own, and any user's for admins. Written by the login flows through [`record`].

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::AuthUser;
use crate::client_ip::ClientMeta;
use crate::db::{self, sign_ins::{NewSignIn, SignIn}};
use crate::error::{ApiError, ApiResult};
use crate::geoip::GeoIp;
use crate::state::AppState;
use crate::util::db_to_iso_utc_z;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(mine)).routes(routes!(for_user))
}

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 200;

/// 一次登入嘗試的結果。/ The outcome of one sign-in attempt.
pub struct Attempt<'a> {
    pub method: &'a str,
    pub second_factor: Option<&'a str>,
    pub ok: bool,
    pub reason: Option<&'a str>,
}

impl<'a> Attempt<'a> {
    pub fn ok(method: &'a str, second_factor: Option<&'a str>) -> Self {
        Self { method, second_factor, ok: true, reason: None }
    }
    pub fn failed(method: &'a str, second_factor: Option<&'a str>, reason: &'a str) -> Self {
        Self { method, second_factor, ok: false, reason: Some(reason) }
    }
}

/// 這次成功登入的國家 / 瀏覽器在 90 天內沒出現過嗎（`auth::devices::is_new_device`）。查不到紀錄就當不是。
/// Is this successful sign-in's country or browser new within 90 days? A failed lookup counts as no.
async fn new_device(state: &AppState, user_id: i64, meta: &ClientMeta) -> bool {
    use crate::auth::devices::{is_new_device, ua_family, Seen, SEEN_WINDOW_DAYS};
    let since = crate::util::db_time(chrono::Utc::now() - chrono::Duration::days(SEEN_WINDOW_DAYS));
    let Ok(rows) = db::sign_ins::recent_ok(&state.db, user_id, &since).await else { return false };
    let seen = |ip: Option<&str>, ua: Option<&str>| Seen { country: country_of(&state.geoip, ip), family: ua_family(ua) };
    let history: Vec<Seen> = rows.iter().map(|(ip, ua)| seen(ip.as_deref(), ua.as_deref())).collect();
    is_new_device(&history, &seen(meta.ip.as_deref(), meta.user_agent.as_deref()))
}

fn country_of(geo: &GeoIp, ip: Option<&str>) -> Option<String> {
    geo.json(ip).get("country").and_then(Value::as_str).map(str::to_string)
}

/// 記一筆；寫不進去只記 log，不影響登入本身。成功而且是新裝置 → `SIGN-IN-NEW-DEVICE` 通知 + webhook。
/// Best effort: a failed write never blocks the login. A successful sign-in from a new device also notifies.
pub async fn record(state: &AppState, user_id: i64, meta: &ClientMeta, a: Attempt<'_>) {
    let fresh = a.ok && new_device(state, user_id, meta).await;
    let row = NewSignIn {
        user_id,
        ok: a.ok,
        method: a.method,
        second_factor: a.second_factor,
        ip: meta.ip.as_deref(),
        user_agent: meta.user_agent.as_deref(),
        reason: a.reason,
    };
    if let Err(e) = db::sign_ins::insert(&state.db, &row).await {
        tracing::warn!(user_id, error = %e, "cannot record sign-in");
    }
    let username = db::users::by_id(&state.db, user_id).await.ok().flatten().map(|u| u.username).unwrap_or_default();
    let geo = state.geoip.json(meta.ip.as_deref());
    state.webhooks.emit(
        crate::webhooks::Event::new(if a.ok { crate::webhooks::Kind::AccountSignIn } else { crate::webhooks::Kind::AccountSignInFailed })
            .to([user_id], None)
            .data(json!({
                "user": username,
                "method": a.method,
                "second_factor": a.second_factor,
                "reason": a.reason,
                "ip": meta.ip,
                "country": geo.get("country").cloned().unwrap_or(Value::Null),
                "user_agent": meta.user_agent,
            })),
    );
    if fresh {
        let device = crate::auth::devices::ua_family(meta.user_agent.as_deref());
        let country = geo.get("country").cloned().unwrap_or(Value::Null);
        tracing::info!(user = %username, ip = ?meta.ip, device = ?device, "sign-in from a new device");
        state.hub.notify_user(
            user_id,
            &json!({
                "action": "SIGN-IN-NEW-DEVICE",
                "ip": meta.ip,
                "geo": geo,
                "device": device,
                "user_agent": meta.user_agent,
                "method": a.method,
                "second_factor": a.second_factor,
                "at": crate::util::db_to_iso_utc_z(&crate::util::now_db()),
            }),
        );
        state.webhooks.emit(
            crate::webhooks::Event::new(crate::webhooks::Kind::AccountSignInNewDevice)
                .to([user_id], None)
                .data(json!({
                    "user": username,
                    "method": a.method,
                    "second_factor": a.second_factor,
                    "ip": meta.ip,
                    "country": country,
                    "device": device,
                    "user_agent": meta.user_agent,
                }))
                .link("/tunnels"),
        );
    }
}

fn sign_in_json(e: &SignIn, geo: &GeoIp) -> Value {
    json!({
        "id": e.id,
        "at": db_to_iso_utc_z(&e.at),
        "ok": e.ok,
        "method": e.method,
        "second_factor": e.second_factor,
        "ip": e.ip,
        "geo": geo.json(e.ip.as_deref()),
        "user_agent": e.user_agent,
        "reason": e.reason,
    })
}

async fn list(state: &AppState, user_id: i64, q: &HashMap<String, String>) -> ApiResult<Json<Value>> {
    let limit = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let rows = db::sign_ins::for_user(&state.db, user_id, limit).await?;
    Ok(Json(Value::Array(rows.iter().map(|e| sign_in_json(e, &state.geoip)).collect())))
}

#[utoipa::path(get, path = "/api/auth/sign-ins", tag = "Login", security(("bearer" = [])), params(("limit" = Option<i64>, Query, description = "Default 20, max 200")), responses((status = 200, description = "Your recent sign-ins (successful and failed), newest first; kept 90 days", body = Vec<super::schemas::SignInEvent>)))]
async fn mine(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    list(&state, user.id, &q).await
}

#[utoipa::path(get, path = "/api/user/users/{id}/sign-ins", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path), ("limit" = Option<i64>, Query, description = "Default 20, max 200")), responses((status = 200, description = "That user's recent sign-ins, newest first (admins only)", body = Vec<super::schemas::SignInEvent>), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn for_user(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can view sign-in history."));
    }
    db::users::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    list(&state, id, &q).await
}
