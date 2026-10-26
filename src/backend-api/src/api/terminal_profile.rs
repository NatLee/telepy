//! `/api/reverse/server/{id}/terminal-profile`：使用者對這條隧道的終端機外觀覆寫（字型 / 字級 / 配色 / 粗體 / 連字）。
//! 看得到隧道的人就能設，只影響自己；NULL 欄位 = 跟隨個人預設（`/api/user/settings` 的 terminal_*）。
//! 字型 / 配色 id 的清單在前端（lib/terminalAppearance.ts），後端只檢查形狀；不認得的 id 前端回到預設。
//! Per-user terminal appearance override for one tunnel. Anyone who can see the tunnel may set one and it
//! only affects them; a null field inherits the personal default (terminal_* in `/api/user/settings`).
//! Font / scheme ids are listed in the frontend; the backend only checks their shape.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, terminal_profile::{ProfileFields, TerminalProfile}};
use crate::error::{ApiError, ApiResult};
use crate::permissions;
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(get_profile, put_profile, delete_profile))
}

fn profile_json(tunnel_id: i64, p: Option<&TerminalProfile>) -> Value {
    json!({
        "tunnel_id": tunnel_id,
        "font": p.and_then(|p| p.font.clone()),
        "font_size": p.and_then(|p| p.font_size),
        "scheme": p.and_then(|p| p.scheme.clone()),
        "bold": p.and_then(|p| p.bold.clone()),
        "ligatures": p.and_then(|p| p.ligatures),
    })
}

/// 看得到的隧道，否則 404（與其他隧道端點一致）。/ A tunnel the user can see, else 404.
async fn visible(state: &AppState, user_id: i64, id: i64) -> ApiResult<i64> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    permissions::effective_for(&state.db, user_id, &t).await?.ok_or_else(ApiError::drf_not_found)?;
    Ok(t.id)
}

/// 缺少或 null = 跟隨預設。/ Missing or null = inherit.
fn optional_choice(body: &Value, key: &str) -> Result<Option<String>, ApiError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if super::users::is_choice_id(s) => Ok(Some(s.clone())),
        Some(_) => Err(ApiError::field(key, super::users::CHOICE_ID_RULE)),
    }
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/terminal-profile", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "The caller's override for this tunnel; every field is null when there is none", body = super::schemas::TerminalProfile), (status = 404, body = super::schemas::ErrorBody)))]
async fn get_profile(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let tunnel_id = visible(&state, user.id, id).await?;
    let p = db::terminal_profile::get(&state.db, user.id, tunnel_id).await?;
    Ok(Json(profile_json(tunnel_id, p.as_ref())))
}

#[utoipa::path(put, path = "/api/reverse/server/{id}/terminal-profile", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::TerminalProfilePatch, responses((status = 200, description = "The stored override (a missing or null field inherits the personal default; every field null removes the row)", body = super::schemas::TerminalProfile), (status = 400, description = "{field: [message]}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn put_profile(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let tunnel_id = visible(&state, user.id, id).await?;
    let fields = ProfileFields {
        font: optional_choice(&body, "font")?,
        scheme: optional_choice(&body, "scheme")?,
        font_size: match body.get("font_size") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let n = v.as_i64().ok_or_else(|| ApiError::field("font_size", "A valid integer is required."))?;
                if !(10..=24).contains(&n) {
                    return Err(ApiError::field("font_size", "font_size must be between 10 and 24."));
                }
                Some(n)
            }
        },
        bold: match body.get("bold") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if super::users::is_bold_style(s) => Some(s.clone()),
            Some(_) => return Err(ApiError::field("bold", super::users::BOLD_RULE)),
        },
        ligatures: match body.get("ligatures") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return Err(ApiError::field("ligatures", "Must be a valid boolean.")),
        },
    };
    if fields.is_empty() {
        // 全部跟隨預設 = 沒有覆寫：刪列，而不是存一列全 NULL。/ Everything inherits = no override: drop the row.
        db::terminal_profile::delete(&state.db, user.id, tunnel_id).await?;
        return Ok(Json(profile_json(tunnel_id, None)));
    }
    let p = db::terminal_profile::upsert(&state.db, user.id, tunnel_id, &fields).await?;
    Ok(Json(profile_json(tunnel_id, Some(&p))))
}

#[utoipa::path(delete, path = "/api/reverse/server/{id}/terminal-profile", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 204, description = "Override removed (also when there was none)"), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_profile(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let tunnel_id = visible(&state, user.id, id).await?;
    db::terminal_profile::delete(&state.db, user.id, tunnel_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
