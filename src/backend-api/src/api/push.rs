//! `/api/push*`：這台裝置的推播訂閱（偏好設定 → 通知）。只有網頁登入能用（API token 一律 403 `token_route`），訂閱綁在
//! 這次請求的登入上；別人的訂閱一律 404。見 `crate::push`。
//! This device's push subscription (Preferences → Notifications). Web sign-ins only (API tokens get 403
//! `token_route`); a subscription is bound to this request's sign-in; anyone else's is a 404. See `crate::push`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::extractor::CurrentSession;
use crate::auth::AuthUser;
use crate::client_ip::ClientMeta;
use crate::db::{self, push::Subscription};
use crate::error::{ApiError, ApiResult};
use crate::push::{crypto, notice, Outcome};
use crate::state::AppState;
use crate::util::db_to_iso_utc_z;
use crate::webhooks::text::Lang;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(overview))
        .routes(routes!(subscribe))
        .routes(routes!(update, remove))
        .routes(routes!(test))
}

fn err(status: StatusCode, code: &str, msg: &str) -> ApiError {
    ApiError::new(status, json!({ "error": msg, "code": code }))
}

fn sub_json(s: &Subscription, current: Option<i64>) -> Value {
    let service = url::Url::parse(&s.endpoint).ok().and_then(|u| notice::service_of(&u));
    json!({
        "id": s.id,
        "user_agent": s.user_agent,
        "lang": s.lang,
        "details": s.details,
        "service": service,
        "current": Some(s.session_id) == current,
        "created_at": db_to_iso_utc_z(&s.created_at),
        "last_success_at": s.last_success_at.as_deref().map(db_to_iso_utc_z),
        "last_error": s.last_error,
        "last_error_at": s.last_error_at.as_deref().map(db_to_iso_utc_z),
    })
}

/// 這個人的推播狀態：站台開了沒、公鑰、裝置清單（`current` = 這次請求的登入）。
/// The person's push state: whether the site allows it, the public key and the device list (`current` = this sign-in).
async fn view(state: &AppState, user_id: i64, sid: Option<i64>) -> ApiResult<Value> {
    let settings = db::settings::get_solo(&state.db).await?;
    let (public_key, key_error) = match state.push.key() {
        Ok(k) => (Some(k.public_key().to_string()), None),
        Err(e) => {
            tracing::warn!(error = %e, "push: no VAPID key");
            (None, Some(e))
        }
    };
    let subs = db::push::live_for_user(&state.db, user_id).await?;
    let delay = db::users::settings_for(&state.db, user_id).await?.map(|s| s.push_status_delay).unwrap_or(crate::push::DEFAULT_STATUS_DELAY);
    Ok(json!({
        "enabled": settings.notify_push,
        "available": settings.notify_push && public_key.is_some(),
        "public_key": public_key,
        "key_error": key_error,
        "per_minute": crate::push::PER_MINUTE,
        "subscriptions": subs.iter().map(|s| sub_json(s, sid)).collect::<Vec<_>>(),
        // 上線 / 離線推播：自己選的等待、站台上限下實際的、可選的與每小時上限。/ Status pushes: the wait, the limits and the choices.
        "status": {
            "delay": delay,
            "effective": crate::push::status_delay(delay, settings.notify_push_max_delay).as_secs(),
            "max_delay": settings.notify_push_max_delay,
            "per_hour": settings.notify_push_per_hour,
            "choices": crate::push::STATUS_DELAYS,
        },
    }))
}

#[utoipa::path(get, path = "/api/push", tag = "Notifications", security(("bearer" = [])), responses(
    (status = 200, description = "Push notifications: whether the site allows them, the VAPID public key for `applicationServerKey`, and your devices (`current` = this sign-in)", body = super::schemas::PushView)
))]
async fn overview(State(state): State<AppState>, AuthUser(me): AuthUser, CurrentSession(sid): CurrentSession) -> ApiResult<Json<Value>> {
    Ok(Json(view(&state, me.id, sid).await?))
}

#[utoipa::path(post, path = "/api/push/subscriptions", tag = "Notifications", security(("bearer" = [])), request_body(content = Object, description = "`{endpoint, keys: {p256dh, auth}, lang, details}` — the browser's PushSubscription plus this device's language and whether it shows commands"), responses(
    (status = 200, description = "Subscribed (or updated); the push state", body = super::schemas::PushView),
    (status = 400, description = "`code`: push_endpoint (not a known push service), push_keys, push_session (no web sign-in)", body = super::schemas::ErrorBody),
    (status = 409, description = "`code`: push_off — the site turned push notifications off", body = super::schemas::ErrorBody)
))]
async fn subscribe(State(state): State<AppState>, AuthUser(me): AuthUser, CurrentSession(sid): CurrentSession, meta: ClientMeta, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let sid = sid.ok_or_else(|| err(StatusCode::BAD_REQUEST, "push_session", "Push notifications belong to a web sign-in; sign in again."))?;
    if !db::settings::get_solo(&state.db).await?.notify_push {
        return Err(err(StatusCode::CONFLICT, "push_off", "An administrator turned push notifications off."));
    }
    let endpoint = body.get("endpoint").and_then(Value::as_str).unwrap_or_default();
    state.push.check_endpoint(endpoint).map_err(|e| err(StatusCode::BAD_REQUEST, "push_endpoint", e))?;
    let key = |k: &str| body.get("keys").and_then(|v| v.get(k)).and_then(Value::as_str).unwrap_or_default().to_string();
    let (p256dh, auth) = (key("p256dh"), key("auth"));
    crypto::check_keys(&p256dh, &auth).map_err(|e| err(StatusCode::BAD_REQUEST, "push_keys", e))?;
    let lang = Lang::from_pref(body.get("lang").and_then(Value::as_str));
    let details = body.get("details").and_then(Value::as_bool).unwrap_or(false);
    let user_agent: String = meta.user_agent.unwrap_or_default().chars().take(256).collect();
    db::push::upsert(
        &state.db,
        &db::push::New { user_id: me.id, session_id: sid, endpoint, p256dh: &p256dh, auth: &auth, lang: lang.as_str(), details, user_agent: &user_agent },
    )
    .await?;
    tracing::info!(user = %me.username, session = sid, service = ?url::Url::parse(endpoint).ok().and_then(|u| notice::service_of(&u)), "push: subscribed");
    Ok(Json(view(&state, me.id, Some(sid)).await?))
}

/// 自己的、登入還有效的訂閱；其他一律 404。/ One's own subscription with a live sign-in; anything else is a 404.
async fn own(state: &AppState, user_id: i64, id: i64) -> ApiResult<Subscription> {
    match db::push::get_live(&state.db, id).await? {
        Some(s) if s.user_id == user_id => Ok(s),
        _ => Err(err(StatusCode::NOT_FOUND, "not_found", "No such device.")),
    }
}

#[utoipa::path(patch, path = "/api/push/subscriptions/{id}", tag = "Notifications", security(("bearer" = [])), params(("id" = i64, Path)), request_body(content = Object, description = "`{details?, lang?}`"), responses(
    (status = 200, body = super::schemas::PushView), (status = 404, body = super::schemas::ErrorBody)
))]
async fn update(State(state): State<AppState>, AuthUser(me): AuthUser, CurrentSession(sid): CurrentSession, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    own(&state, me.id, id).await?;
    let details = body.get("details").and_then(Value::as_bool);
    let lang = body.get("lang").and_then(Value::as_str).map(|l| Lang::from_pref(Some(l)).as_str());
    db::push::set_prefs(&state.db, id, details, lang).await?;
    Ok(Json(view(&state, me.id, sid).await?))
}

#[utoipa::path(delete, path = "/api/push/subscriptions/{id}", tag = "Notifications", security(("bearer" = [])), params(("id" = i64, Path)), responses(
    (status = 200, body = super::schemas::PushView), (status = 404, body = super::schemas::ErrorBody)
))]
async fn remove(State(state): State<AppState>, AuthUser(me): AuthUser, CurrentSession(sid): CurrentSession, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    own(&state, me.id, id).await?;
    db::push::delete(&state.db, id).await?;
    Ok(Json(view(&state, me.id, sid).await?))
}

#[utoipa::path(post, path = "/api/push/subscriptions/{id}/test", tag = "Notifications", security(("bearer" = [])), params(("id" = i64, Path)), responses(
    (status = 200, description = "`outcome`: sent | gone (the push service forgot this device; removed) | skipped (too many this minute) | failed (+ `error`), plus the push state", body = Object),
    (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "`code`: push_off", body = super::schemas::ErrorBody)
))]
async fn test(State(state): State<AppState>, AuthUser(me): AuthUser, CurrentSession(sid): CurrentSession, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let sub = own(&state, me.id, id).await?;
    if !db::settings::get_solo(&state.db).await?.notify_push {
        return Err(err(StatusCode::CONFLICT, "push_off", "An administrator turned push notifications off."));
    }
    let outcome = state.push.test(&sub).await;
    let (name, error) = match &outcome {
        Outcome::Sent => ("sent", None),
        Outcome::Gone => ("gone", None),
        Outcome::Skipped => ("skipped", None),
        Outcome::Failed(e) => ("failed", Some(e.clone())),
    };
    let mut v = view(&state, me.id, sid).await?;
    v["outcome"] = json!(name);
    v["error"] = json!(error);
    Ok(Json(v))
}
