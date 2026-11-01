//! `/api/user/settings`、`/api/user/users[/{id}]`（user_management app）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, users::{SettingsPatch, User, UserSettings}};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::{db_to_iso, opt_db_to_iso};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_settings, update_settings))
        .routes(routes!(list_users))
        .routes(routes!(update_user))
        .routes(routes!(disable_preview))
}

const LANGUAGES: [&str; 4] = ["auto", "en", "zh-TW", "ja"];
const THEMES: [&str; 3] = ["system", "light", "dark"];

/// `desktop_clipboard_limit` 是站台設定（唯讀）：桌面頁和偏好設定拿它把超過上限的選項關掉。
/// `desktop_clipboard_limit` is the site setting (read-only), so the UI can disable choices above it.
/// `terminal_detach_max_secs` 同理：網頁終端機斷線保留的站台上限（唯讀，0 = 功能關閉）。
/// Likewise `terminal_detach_max_secs`: the site's ceiling for keeping a detached web terminal (read-only, 0 = off).
async fn settings_json(state: &AppState, s: &UserSettings) -> ApiResult<Value> {
    let site = db::settings::get_solo(&state.db).await?;
    let limit = site.desktop_clipboard;
    Ok(json!({
        "language": s.language,
        "theme": s.theme,
        "terminal_font_size": s.terminal_font_size,
        "ui_scale": s.ui_scale,
        "terminal_font": s.terminal_font,
        "terminal_scheme": s.terminal_scheme,
        "terminal_bold": s.terminal_bold,
        "terminal_ligatures": s.terminal_ligatures,
        "desktop_clipboard": s.desktop_clipboard,
        "desktop_clipboard_limit": limit,
        "terminal_detach_secs": s.terminal_detach_secs,
        "terminal_detach_max_secs": site.terminal_detach_max_secs,
        "view_modes": view_modes_json(&s.view_modes),
        "desktop_display": crate::desktop::display::json(&s.desktop_display),
        "ssh_alias_prefix": s.ssh_alias_prefix,
        "tapi_color": s.tapi_color,
        "tapi_daily": s.tapi_daily,
        "tapi_visits": s.tapi_visits,
        "shell_history": crate::shell_history::Mode::parse(&s.shell_history).unwrap_or(crate::shell_history::Mode::Keep).as_str(),
    }))
}

/// 各頁的卡片 / 清單顯示最多記幾頁。/ How many pages' card / list choices are kept.
pub const MAX_VIEW_MODES: usize = 20;
pub const VIEW_MODES_RULE: &str = "Must be an object of page ids (lowercase letters, digits or '_', up to 32) to \"card\" or \"list\", at most 20.";

/// 檢查並正規化 `view_modes`：物件、頁面 id 形狀、值只能 card / list；回傳排序過的 JSON。頁面清單在前端。
/// Validates and normalises `view_modes`: an object of page ids to card / list, returned as sorted JSON. The list
/// of pages lives in the frontend, so only the shape is checked here.
pub fn parse_view_modes(v: &Value) -> Result<String, &'static str> {
    let obj = v.as_object().ok_or(VIEW_MODES_RULE)?;
    if obj.len() > MAX_VIEW_MODES {
        return Err(VIEW_MODES_RULE);
    }
    let mut out = std::collections::BTreeMap::new();
    for (page, mode) in obj {
        let ok_page = (1..=32).contains(&page.len()) && page.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        match mode.as_str() {
            Some(m @ ("card" | "list")) if ok_page => {
                out.insert(page.clone(), m.to_string());
            }
            _ => return Err(VIEW_MODES_RULE),
        }
    }
    Ok(serde_json::to_string(&out).expect("a map of strings serialises"))
}

/// 存的 JSON → 物件（壞掉的就當空的）。/ Stored JSON → object (anything broken reads as empty).
pub fn view_modes_json(stored: &str) -> Value {
    match serde_json::from_str::<Value>(stored) {
        Ok(v @ Value::Object(_)) => v,
        _ => json!({}),
    }
}

pub const CHOICE_ID_RULE: &str = "Use 1-32 lowercase letters, digits or '-'.";

/// 字型 / 配色 id 的形狀：清單在前端（lib/terminalAppearance.ts），後端不認得的 id 前端會回到預設，
/// 所以這裡只擋垃圾。/ Shape of a font / colour-scheme id. The list lives in the frontend, which falls
/// back to its default for an unknown id, so the backend only rejects garbage.
pub fn is_choice_id(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub const BOLD_STYLES: [&str; 3] = ["face", "bright", "both"];
pub const BOLD_RULE: &str = "Must be one of: face, bright, both.";

/// 粗體的畫法：face = 真正的粗體字、bright = 只換亮色（經典終端機）、both。/ Bold style: real face, bright colour only, or both.
pub fn is_bold_style(s: &str) -> bool {
    BOLD_STYLES.contains(&s)
}

fn parse_choice(body: &Value, key: &str) -> Result<Option<String>, ApiError> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if is_choice_id(s) => Ok(Some(s.clone())),
        Some(_) => Err(ApiError::field(key, CHOICE_ID_RULE)),
    }
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
    Ok(Json(settings_json(&state, &s).await?))
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
    // 介面顯示大小：85–130%（前端的滑桿範圍；預設 100）。/ UI display scale: 85–130 percent.
    let scale = match body.get("ui_scale") {
        Some(v) => {
            let n = v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).ok_or_else(|| ApiError::field("ui_scale", "A valid integer is required."))?;
            if !(85..=130).contains(&n) {
                return Err(ApiError::field("ui_scale", "ui_scale must be between 85 and 130."));
            }
            Some(n)
        }
        None => None,
    };
    let patch = SettingsPatch {
        language,
        theme,
        terminal_font_size: font,
        ui_scale: scale,
        terminal_font: parse_choice(&body, "terminal_font")?,
        terminal_scheme: parse_choice(&body, "terminal_scheme")?,
        terminal_bold: match body.get("terminal_bold") {
            None => None,
            Some(Value::String(b)) if is_bold_style(b) => Some(b.clone()),
            Some(_) => return Err(ApiError::field("terminal_bold", BOLD_RULE)),
        },
        terminal_ligatures: match body.get("terminal_ligatures") {
            None => None,
            Some(Value::Bool(l)) => Some(*l),
            Some(_) => return Err(ApiError::field("terminal_ligatures", "Must be a valid boolean.")),
        },
        desktop_clipboard: match body.get("desktop_clipboard") {
            None => None,
            Some(Value::String(c)) if crate::desktop::Clipboard::parse(c).is_some() => Some(c.trim().to_string()),
            Some(_) => return Err(ApiError::field("desktop_clipboard", format!("Must be one of: {}.", crate::desktop::Clipboard::VALUES.join(", ")))),
        },
        // 各頁的卡片 / 清單顯示（整份取代）。/ Card / list view per page (replaces the whole map).
        view_modes: match body.get("view_modes") {
            None => None,
            Some(v) => Some(parse_view_modes(v).map_err(|e| ApiError::field("view_modes", e))?),
        },
        // 遠端桌面的顯示偏好（整份取代；null = 清掉，回到「還沒選過」）。/ Desktop display preferences (whole object; null clears).
        desktop_display: match body.get("desktop_display") {
            None => None,
            Some(Value::Null) => Some(String::new()),
            Some(v) => Some(crate::desktop::display::parse(v).map_err(|e| ApiError::field("desktop_display", e))?),
        },
        // ~/.ssh/config 的裝置別名前綴（空 = 不加）。/ The device alias prefix in ~/.ssh/config (empty = none).
        ssh_alias_prefix: match body.get("ssh_alias_prefix") {
            None => None,
            Some(Value::String(p)) => {
                let p = p.trim();
                if let Some(problem) = crate::scripts::alias_prefix_problem(p) {
                    return Err(ApiError::field("ssh_alias_prefix", problem));
                }
                Some(p.to_string())
            }
            Some(Value::Null) => Some(String::new()),
            Some(_) => return Err(ApiError::field("ssh_alias_prefix", "Must be a string.")),
        },
        // Tapi 的十字髮夾顏色（找到 Tapi 才會設；null / "" = 回到沒解鎖）。/ Tapi's clip colour (null / "" = locked again).
        tapi_color: match body.get("tapi_color") {
            None => None,
            Some(Value::Null) => Some(String::new()),
            Some(Value::String(c)) if c.is_empty() || crate::mascot::clip_color(c).is_some() || c == crate::mascot::DAILY => Some(c.clone()),
            Some(_) => {
                let names = crate::mascot::CLIP_COLORS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ");
                return Err(ApiError::field("tapi_color", format!("Must be one of: {names}, {}.", crate::mascot::DAILY)));
            }
        },
        // 只能打開（看完片尾名單）；關回去沒有意義。/ Can only be turned on (credits watched).
        tapi_daily: match body.get("tapi_daily") {
            None => None,
            Some(Value::Bool(true)) => Some(true),
            Some(_) => return Err(ApiError::field("tapi_daily", "Can only be true.")),
        },
        // Tapi 偶爾自己來串門子（網頁）。/ Whether Tapi drops by now and then (the web).
        tapi_visits: match body.get("tapi_visits") {
            None => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return Err(ApiError::field("tapi_visits", "Must be a boolean.")),
        },
        // 網頁終端機 / agent shell 的指令寫不寫進裝置的歷史檔。/ Whether Telepy's shells write the device's shell history.
        shell_history: match body.get("shell_history") {
            None => None,
            Some(Value::String(m)) if crate::shell_history::Mode::parse(m).is_some() => Some(m.trim().to_string()),
            Some(_) => return Err(ApiError::field("shell_history", format!("Must be one of: {}.", crate::shell_history::Mode::VALUES.join(", ")))),
        },
        // 網頁終端機斷線保留秒數：只收固定的幾個選項。/ Web terminal detach grace: one of the fixed choices.
        terminal_detach_secs: match body.get("terminal_detach_secs") {
            None => None,
            Some(v) => match v.as_i64() {
                Some(n) if crate::terminal_detach::CHOICES.contains(&n) => Some(n),
                _ => {
                    let list = crate::terminal_detach::CHOICES.iter().map(i64::to_string).collect::<Vec<_>>().join(", ");
                    return Err(ApiError::field("terminal_detach_secs", format!("Must be one of: {list}.")));
                }
            },
        },
    };
    if patch.tapi_color.as_deref() == Some(crate::mascot::DAILY) && patch.tapi_daily != Some(true) {
        let unlocked = db::users::settings_for(&state.db, user.id).await?.is_some_and(|s| s.tapi_daily);
        if !unlocked {
            return Err(ApiError::field("tapi_color", "Watch the credits to the end to unlock it."));
        }
    }
    let s = db::users::settings_update(&state.db, user.id, patch).await?;
    Ok(Json(settings_json(&state, &s).await?))
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
    // 停用帳號：登出所有瀏覽器、結束所有進行中的 session（含斷線保留中的終端機）與 MCP agent，token / app 暫停。
    // Disabling: sign out every browser, end every live session (detached terminals too) and agent; tokens / apps pause.
    let disabled = if is_active == Some(false) && target.is_active { Some(crate::access_recheck::account_disabled(&state, id).await?) } else { None };
    // 重新啟用：他的金鑰回到清單上的裝置（同步馬上跑）。/ Re-enabled: their keys go back onto the listed devices.
    if is_active == Some(true) && !target.is_active {
        crate::access_recheck::kick_device_keys(&state, id).await?;
    }
    if let Some(v) = body.get("language") {
        let lang = parse_language(v)?;
        db::users::settings_update(&state.db, id, SettingsPatch { language: Some(lang), ..SettingsPatch::default() }).await?;
    }
    let target = db::users::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("User not found."))?;
    let lang = db::users::settings_for(&state.db, id).await?.and_then(|s| s.language);
    let mfa_enabled = super::mfa::factors(&state, id).await?.any();
    let mut out = managed_user_json(&target, lang.as_deref(), mfa_enabled, state.config.tz_offset_minutes);
    if let Some(d) = disabled {
        out["disabled"] = d.json();
        let what = format!(
            "{} disabled {}: {} sign-ins revoked, {} live sessions and {} agent sessions ended, {} API tokens and {} connected apps suspended, keys Telepy installed on {} devices ({} offline) being removed",
            me.username, target.username, d.web_sessions, d.live_sessions, d.agent_sessions, d.api_tokens, d.connected_apps, d.device_keys.devices, d.device_keys.offline_devices
        );
        tracing::info!("{what}");
    }
    Ok(Json(out))
}

/// 停用前的預估：停用這個帳號會登出幾個瀏覽器、結束幾個 session、暫停幾把 token / 幾個 app（管理員）。
/// Before disabling: how many browsers are signed out, sessions ended, tokens and apps suspended (admins only).
#[utoipa::path(get, path = "/api/user/users/{id}/disable-preview", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path, description = "User id")), responses((status = 200, body = super::schemas::DisableImpact), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn disable_preview(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can manage users."));
    }
    db::users::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("User not found."))?;
    Ok(Json(crate::access_recheck::disable_preview(&state, id).await?.json()))
}

#[allow(dead_code)]
fn _status_unused() -> StatusCode {
    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_modes_are_normalised_and_checked() {
        assert_eq!(parse_view_modes(&json!({"tunnels": "list", "key_groups": "card"})).unwrap(), r#"{"key_groups":"card","tunnels":"list"}"#);
        assert_eq!(parse_view_modes(&json!({})).unwrap(), "{}");
        assert!(parse_view_modes(&json!({"tunnels": "grid"})).is_err());
        assert!(parse_view_modes(&json!({"Tunnels": "list"})).is_err());
        assert!(parse_view_modes(&json!({"a-b": "list"})).is_err());
        assert!(parse_view_modes(&json!(["tunnels"])).is_err());
        let many: serde_json::Map<String, Value> = (0..21).map(|i| (format!("p{i}"), json!("card"))).collect();
        assert!(parse_view_modes(&Value::Object(many)).is_err());
    }

    #[test]
    fn stored_view_modes_read_back_safely() {
        assert_eq!(view_modes_json(r#"{"tunnels":"list"}"#), json!({"tunnels": "list"}));
        assert_eq!(view_modes_json("not json"), json!({}));
        assert_eq!(view_modes_json("[]"), json!({}));
    }
}
