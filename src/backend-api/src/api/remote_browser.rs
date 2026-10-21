//! `/api/reverse/server/{id}/remote-browser/start`、`/remote-browser/{sid}/{stop,ping}`（browse_views.py）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::remote_browser::StartError;
use crate::state::AppState;
use crate::util::json_str;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/reverse/server/{id}/remote-browser/start", post(start))
        .route("/api/reverse/server/remote-browser/{sid}/stop", post(stop))
        .route("/api/reverse/server/remote-browser/{sid}/ping", post(ping))
}

async fn start(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await? {
        return Err(ApiError::forbidden("Permission denied"));
    }
    let allowed = permissions::allowed_usernames(&state.db, user.id, &tunnel).await?;
    let username = match json_str(&body, "username").filter(|u| !u.is_empty()) {
        Some(u) => {
            if !allowed.iter().any(|a| a.username == u) {
                return Err(ApiError::forbidden("Username not authorized"));
            }
            u
        }
        None => {
            if allowed.is_empty() {
                return Err(ApiError::forbidden("No authorized target user available"));
            }
            let default = tunnel.default_username_id.and_then(|d| allowed.iter().find(|a| a.id == d));
            default.or_else(|| allowed.first()).map(|a| a.username.clone()).unwrap()
        }
    };
    match state.remote_browser.start(&state.config, &state.db, &username, tunnel.reverse_port, id).await {
        Ok(v) => Ok(Json(v)),
        Err(StartError::Coded { message, code }) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": message, "code": code }))),
        Err(StartError::Other(message)) => Err(ApiError::internal(message)),
    }
}

async fn stop(State(state): State<AppState>, AuthUser(_): AuthUser, Path(sid): Path<String>) -> ApiResult<Json<Value>> {
    if state.remote_browser.stop(&state.db, &sid).await {
        Ok(Json(json!({ "status": "success" })))
    } else {
        Err(ApiError::not_found("Session not found"))
    }
}

async fn ping(State(state): State<AppState>, AuthUser(_): AuthUser, Path(sid): Path<String>) -> ApiResult<Json<Value>> {
    if state.remote_browser.ping(&state.db, &sid).await {
        Ok(Json(json!({ "status": "ok" })))
    } else {
        Err(ApiError::not_found("Session not found"))
    }
}
