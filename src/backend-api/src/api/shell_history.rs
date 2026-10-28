//! `/api/reverse/server/{id}/shell-history`：自己在這條隧道上「連線中打的指令寫不寫進 shell 歷史檔」的覆寫。
//! 看得到隧道的人就能設，只影響自己（網頁終端機與自己的 agent shell）；null = 跟隨個人預設
//! （`/api/user/settings` 的 `shell_history`）。怎麼做到的見 `crate::shell_history`。
//! The caller's own override of the shell history choice for one tunnel (web terminal and their agent shells);
//! null follows the personal default (`shell_history` in `/api/user/settings`). See `crate::shell_history`.

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::permissions;
use crate::shell_history::{self, Mode};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(get_pref, put_pref))
}

/// 看得到的隧道，否則 404（與其他隧道端點一致）。/ A tunnel the user can see, else 404.
async fn visible(state: &AppState, user_id: i64, id: i64) -> ApiResult<i64> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    permissions::effective_for(&state.db, user_id, &t).await?.ok_or_else(ApiError::drf_not_found)?;
    Ok(t.id)
}

async fn pref_json(state: &AppState, user_id: i64, tunnel_id: i64) -> ApiResult<Value> {
    let default = db::users::settings_for(&state.db, user_id).await?.and_then(|s| Mode::parse(&s.shell_history)).unwrap_or(Mode::Keep);
    let tunnel = db::shell_history::get(&state.db, user_id, tunnel_id).await?.and_then(|m| Mode::parse(&m));
    let (effective, source) = shell_history::effective(default, tunnel);
    Ok(json!({
        "tunnel_id": tunnel_id,
        "mode": tunnel.map(Mode::as_str),
        "default": default.as_str(),
        "effective": effective.as_str(),
        "source": source.as_str(),
    }))
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/shell-history", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "The caller's choice for this tunnel: the override (null = follow the default), the default and what applies", body = super::schemas::ShellHistoryPref), (status = 404, body = super::schemas::ErrorBody)))]
async fn get_pref(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let tunnel_id = visible(&state, user.id, id).await?;
    Ok(Json(pref_json(&state, user.id, tunnel_id).await?))
}

#[utoipa::path(put, path = "/api/reverse/server/{id}/shell-history", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::ShellHistoryPrefPatch, responses((status = 200, description = "Stored; applies to shells opened from now on", body = super::schemas::ShellHistoryPref), (status = 400, description = "{mode: [message]}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn put_pref(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let tunnel_id = visible(&state, user.id, id).await?;
    match body.get("mode") {
        None | Some(Value::Null) => db::shell_history::delete(&state.db, user.id, tunnel_id).await?,
        Some(Value::String(m)) if Mode::parse(m).is_some() => db::shell_history::set(&state.db, user.id, tunnel_id, m.trim()).await?,
        Some(_) => return Err(ApiError::field("mode", format!("Must be one of: {}, or null to follow your default.", Mode::VALUES.join(", ")))),
    }
    Ok(Json(pref_json(&state, user.id, tunnel_id).await?))
}
