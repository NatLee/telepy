//! 隧道在裝置上的名稱與足跡（見 `crate::device_install`）：
//! - `GET  /api/reverse/server/{id}/device-install`：安裝代號、各種名稱、最近一次盤點到的東西、能不能自動改名
//! - `POST /api/reverse/server/{id}/device-install/survey`：現在重新盤點（裝置要在線）
//! - `POST /api/reverse/server/{id}/device-install/rename`：把舊名稱的服務換成用代號取名的新服務（先接上再拆舊的）
//!
//! 都只給擁有者 / ADMIN 被分享者；看不到隧道 → 404。
//!
//! A tunnel's names and footprint on its device; owner and ADMIN sharees only.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::db;
use crate::device_install::{self, RenameError};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(show)).routes(routes!(survey)).routes(routes!(rename))
}

fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// 擁有者 / ADMIN 才行；看不到 → 404。/ Owner or ADMIN only; invisible → 404.
async fn load(state: &AppState, user_id: i64, id: i64) -> ApiResult<db::tunnels::Tunnel> {
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    let eff = permissions::effective_for(&state.db, user_id, &tunnel).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !eff.satisfies(Permission::Admin) {
        return Err(ApiError::forbidden("Only the owner or an ADMIN sharee can see what runs this tunnel on the device."));
    }
    Ok(tunnel)
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/device-install", tag = "Device install", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::DeviceInstall), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn show(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let tunnel = load(&state, user.id, id).await?;
    Ok(Json(device_install::view(&state, &tunnel).await?))
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/device-install/survey", tag = "Device install", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "Surveyed; the fresh view", body = super::schemas::DeviceInstall), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "code = device_offline | busy", body = super::schemas::ErrorBody), (status = 502, description = "code = survey_failed", body = super::schemas::ErrorBody)))]
async fn survey(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let tunnel = load(&state, user.id, id).await?;
    if device_install::busy(&tunnel) {
        return Err(coded(StatusCode::CONFLICT, "busy", "The device's service is being renamed right now."));
    }
    if !crate::device_keys::online(&state, tunnel.reverse_port) {
        return Err(coded(StatusCode::CONFLICT, "device_offline", format!("The device '{}' is offline.", tunnel.host_friendly_name)));
    }
    if let Err(e) = device_install::survey_and_record(&state, &tunnel).await {
        return Err(coded(StatusCode::BAD_GATEWAY, "survey_failed", e));
    }
    Ok(Json(device_install::view(&state, &tunnel).await?))
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/device-install/rename", tag = "Device install", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "The rename ran (see ok / steps / code); the view after it", body = super::schemas::DeviceInstallRename), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "code = device_offline | busy | no_accounts", body = super::schemas::ErrorBody)))]
async fn rename(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let tunnel = load(&state, user.id, id).await?;
    let report = match device_install::rename(&state, &tunnel, &user.username).await {
        Ok(r) => r,
        Err(RenameError::Busy) => return Err(coded(StatusCode::CONFLICT, "busy", "The device's service is being renamed right now.")),
        Err(RenameError::Offline) => return Err(coded(StatusCode::CONFLICT, "device_offline", format!("The device '{}' is offline.", tunnel.host_friendly_name))),
        Err(RenameError::NoAccounts) => return Err(coded(StatusCode::CONFLICT, "no_accounts", "The tunnel has no login accounts, so Telepy cannot log in to the device.")),
    };
    let view = device_install::view(&state, &tunnel).await?;
    Ok(Json(json!({ "report": report, "view": view })))
}
