//! `/api/user/settings`、`/api/user/users[/{id}]`（user_management app）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, users::{User, UserSettings}};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::{db_to_iso, opt_db_to_iso};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_settings, update_settings))
        .routes(routes!(list_users))
        .routes(routes!(update_user))
}

const LANGUAGES: [&str; 4] = ["auto", "en", "zh-TW", "ja"];
const THEMES: [&str; 3] = ["system", "light", "dark"];

fn settings_json(s: &UserSettings) -> Value {
    json!({ "language": s.language, "theme": s.theme, "terminal_font_size": s.terminal_font_size })
}

/// `validate_language`：空字串 → None；不在清單 → 錯誤（選項依 Python sorted 順序）。
fn parse_language(v: &Value) -> Result<Option<String>, ApiError> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        Value::String(s) if LANGUAGES.contains(&s.as_str()) => Ok(Some(s.clone())),
        Value::String(s) => {
            let mut valid: Vec<&str> = LANGUAGES.to_vec();
            valid.sort();
            Err(ApiError::field("language", format!("Invalid language '{}'. Valid options: {}.", s, valid.join(", "))))
        }
        other => Err(ApiError::field("language", format!("\"{other}\" is not a valid choice."))),
    }
}

#[utoipa::path(get, path = "/api/user/settings", tag = "User Management", security(("bearer" = [])), responses((status = 200, body = super::schemas::UserSettings)))]
async fn get_settings(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let s = db::users::settings_get_or_create(&state.db, user.id).await?;
    Ok(Json(settings_json(&s)))
}

#[utoipa::path(post, path = "/api/user/settings", tag = "User Management", security(("bearer" = [])), request_body = super::schemas::UserSettingsPatch, responses((status = 200, body = super::schemas::UserSettings), (status = 400, description = "{field: [message]}", body = Object)))]
async fn update_settings(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let language = match body.get("language") {
        Some(v) => Some(parse_language(v)?),
        None => None,
    };
    let theme = match body.get("theme") {
        Some(Value::String(t)) if THEMES.contains(&t.as_str()) => Some(t.clone()),
        Some(v) => return Err(ApiError::field("theme", format!("\"{}\" is not a valid choice.", v.as_str().unwrap_or(&v.to_string())))),
        None => None,
    };
    let font = match body.get("terminal_font_size") {
        Some(v) => {
            let n = v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).ok_or_else(|| ApiError::field("terminal_font_size", "A valid integer is required."))?;
            if !(10..=24).contains(&n) {
                return Err(ApiError::field("terminal_font_size", "terminal_font_size must be between 10 and 24."));
            }
            Some(n)
        }
        None => None,
    };
    let s = db::users::settings_update(&state.db, user.id, language, theme, font).await?;
    Ok(Json(settings_json(&s)))
}

fn managed_user_json(u: &User, language: Option<&str>, mfa_enabled: bool, tz: i32) -> Value {
    json!({
        "id": u.id,
        "username": u.username,
        "email": u.email,
        "is_active": u.is_active,
        "is_superuser": u.is_superuser,
        "date_joined": db_to_iso(&u.date_joined, tz),
        "last_login": opt_db_to_iso(&u.last_login, tz),
        "language": language,
        "mfa_enabled": mfa_enabled,
    })
}

#[utoipa::path(get, path = "/api/user/users", tag = "User Management", security(("bearer" = [])), responses((status = 200, description = "All users (admins only)", body = super::schemas::ManagedUsers), (status = 403, body = super::schemas::ErrorBody)))]
async fn list_users(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can list users."));
    }
    let users = db::users::all_ordered(&state.db).await?;
    let langs = db::users::settings_language_map(&state.db).await?;
    let mfa = db::mfa::users_with_mfa(&state.db).await?;
    let tz = state.config.tz_offset_minutes;
    Ok(Json(json!({
        "users": users.iter().map(|u| managed_user_json(u, langs.get(&u.id).and_then(|l| l.as_deref()), mfa.contains(&u.id), tz)).collect::<Vec<_>>()
    })))
}

#[utoipa::path(post, path = "/api/user/users/{id}", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path, description = "User id")), request_body = super::schemas::ManagedUserUpdate, responses((status = 200, body = super::schemas::ManagedUser), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_user(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can manage users."));
    }
    let target = db::users::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("User not found."))?;
    if target.id == me.id {
        if body.get("is_active") == Some(&Value::Bool(false)) {
            return Err(ApiError::bad_request("You cannot deactivate your own account."));
        }
        if body.get("is_superuser") == Some(&Value::Bool(false)) {
            return Err(ApiError::bad_request("You cannot remove your own administrator role."));
        }
    }
    let is_active = match body.get("is_active") {
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(ApiError::bad_request("is_active must be a boolean.")),
        None => None,
    };
    let is_superuser = match body.get("is_superuser") {
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(ApiError::bad_request("is_superuser must be a boolean.")),
        None => None,
    };
    db::users::set_flags(&state.db, id, is_active, is_superuser).await?;
    if let Some(v) = body.get("language") {
        let lang = parse_language(v)?;
        db::users::settings_update(&state.db, id, Some(lang), None, None).await?;
    }
    let target = db::users::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("User not found."))?;
    let lang = db::users::settings_for(&state.db, id).await?.and_then(|s| s.language);
    let mfa_enabled = super::mfa::factors(&state, id).await?.any();
    Ok(Json(managed_user_json(&target, lang.as_deref(), mfa_enabled, state.config.tz_offset_minutes)))
}

#[allow(dead_code)]
fn _status_unused() -> StatusCode {
    StatusCode::OK
}
