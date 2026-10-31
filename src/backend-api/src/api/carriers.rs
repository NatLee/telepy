//! 裝置載體（`telepy-carrier`）的管理（管理員）：伺服器健康頁的載體面板。`GET /api/site/carriers` 列出每個平台快取裡的版本、
//! 最新 release、信任的發行公鑰、自動更新開關與最近一次更新；`POST /api/site/carriers/check` 立刻問一次最新版；
//! `POST /api/site/carriers/update`（`{targets?}`）把平台更新到最新版（沒指定 = 全部：沒有的抓、舊的與手動放的換）。
//! 更新寫稽核事件、通知其他管理員與全站 webhook（`carriers::announce`）。
//! Managing the device carriers (superusers): the Server health page's carriers panel. `GET /api/site/carriers` lists
//! each platform's cached version, the latest release, the trusted release keys, the auto-update switch and the last
//! run; `POST /api/site/carriers/check` asks for the latest release now; `POST /api/site/carriers/update`
//! (`{targets?}`) brings platforms to the latest release (none given = every platform). Updates write an audit event
//! and tell the other admins and the site-wide webhooks (`carriers::announce`).

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::AuthUser;
use crate::carriers::{self, Trigger};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list)).routes(routes!(check_now)).routes(routes!(update))
}

fn admin_only(me: &crate::db::users::User) -> ApiResult<()> {
    if me.is_superuser {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Only administrators can manage the device carriers.", "code": "admin_only" })))
    }
}

fn busy() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, json!({ "error": "The device carriers are being updated right now. Try again in a moment.", "code": "busy" }))
}

/// 面板的樣子 + 自動更新開關（網站設定）。/ The view plus the auto-update site setting.
async fn view(state: &AppState) -> ApiResult<Value> {
    let mut v = state.carriers.view();
    let auto = crate::db::settings::get_solo(&state.db).await?.carrier_auto_update;
    v["auto_update"] = json!(auto);
    Ok(v)
}

#[utoipa::path(get, path = "/api/site/carriers", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "Every platform's cached telepy-carrier, the latest release, the trusted release keys, the auto-update switch and the last run (superusers)", body = super::schemas::CarriersView),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody)
))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(view(&state).await?)))
}

#[utoipa::path(post, path = "/api/site/carriers/check", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "Asked the release page for the latest tag now (a failure is in `latest.error`); the view after it", body = super::schemas::CarriersView),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody),
    (status = 409, description = "code = busy: an update is running", body = super::schemas::ErrorBody)
))]
async fn check_now(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    let guard = state.carriers.begin().ok_or_else(busy)?;
    let _ = state.carriers.check().await;
    // 放掉標記再回答，不然回答裡的 `updating` 一直是 true。/ Release the mark first, else the answer says `updating`.
    drop(guard);
    Ok(Json(view(&state).await?))
}

#[derive(Deserialize, Default)]
struct UpdateBody {
    /// 只更新這些平台；沒給 = 全部。/ Only these platforms; omitted = every platform.
    #[serde(default)]
    targets: Option<Vec<String>>,
}

#[utoipa::path(post, path = "/api/site/carriers/update", tag = "Site Settings", security(("bearer" = [])), request_body = super::schemas::CarriersUpdateRequest, responses(
    (status = 200, description = "Brought the platforms to the latest signed release (missing ones fetched, older and hand-placed ones replaced, current ones left); `run` says what happened, `carriers` is the view after it", body = super::schemas::CarriersUpdateResponse),
    (status = 400, description = "targets lists a platform there is no carrier for", body = super::schemas::ErrorBody),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody),
    (status = 409, description = "code = busy: an update is running", body = super::schemas::ErrorBody)
))]
async fn update(State(state): State<AppState>, AuthUser(me): AuthUser, raw: axum::body::Bytes) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    // 空的 body = 全部平台。/ An empty body = every platform.
    let body: UpdateBody = if raw.iter().all(u8::is_ascii_whitespace) { UpdateBody::default() } else { serde_json::from_slice(&raw).map_err(|e| ApiError::bad_request(format!("Invalid JSON: {e}")))? };
    if let Some(bad) = body.targets.iter().flatten().find(|t| !carriers::is_target(t)) {
        return Err(ApiError::field("targets", format!("There is no carrier for {bad}.")));
    }
    let wanted: Option<Vec<&str>> = body.targets.as_ref().map(|t| t.iter().map(String::as_str).collect());
    let guard = state.carriers.begin().ok_or_else(busy)?;
    let run = state.carriers.update(wanted.as_deref(), Trigger::Manual, Some((me.id, me.username.clone()))).await;
    drop(guard);
    carriers::announce(&state, &run).await;
    Ok(Json(json!({ "run": run, "carriers": view(&state).await? })))
}
