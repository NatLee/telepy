//! `/api/user/terminal-schemes`：使用者自訂的終端機配色。
//! - `GET`：自己的清單；`POST {name, colors}`：新增（id 由後端產生 `custom-<8 hex>`，每人最多 20 個）
//! - `PATCH /{id} {name?, colors?}`、`DELETE /{id}`：只能動自己的（別人的 = 404）
//!
//! `colors` 是前景 / 背景 / 游標 / 選取 + 16 色 ANSI 的物件，值都是 `#rrggbb`（`validate_colors`，純函式）。
//! 刪掉的配色若還被 terminal_scheme 或某條隧道的覆寫引用，前端找不到 id 就回到預設配色（不認得的 id 本來就如此），
//! 所以這裡不用追著改引用。
//! User-defined terminal colour schemes. `colors` holds foreground / background / cursor / selection plus
//! the 16 ANSI colours, every value `#rrggbb` (`validate_colors`, pure). A deleted scheme that a setting
//! still references falls back to the default scheme in the frontend (unknown ids always did), so the
//! references are left alone.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Map, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, terminal_scheme::{TerminalScheme, MAX_PER_USER}};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::state::AppState;
use crate::util::db_to_iso_utc_z;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list, create)).routes(routes!(update, remove))
}

/// 必填的顏色欄位（順序 = 回應裡的順序）。/ Required colour keys (in response order).
pub const REQUIRED_COLORS: [&str; 20] = [
    "foreground", "background", "cursor", "selectionBackground",
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
/// 選填：游標上的字色、選取時的字色。/ Optional: the colour of the glyph under the cursor, the selected text's colour.
pub const OPTIONAL_COLORS: [&str; 2] = ["cursorAccent", "selectionForeground"];
pub const NAME_MAX: usize = 40;

/// `#rrggbb`（大小寫皆可）→ 小寫。/ `#rrggbb` in either case → lower-case.
pub fn parse_hex_color(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() != 7 || !s.starts_with('#') || !s[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(s.to_ascii_lowercase())
}

/// 驗證並正規化 colors：必填齊全、選填可缺、沒有別的鍵、每個值都是 `#rrggbb`。回傳要存的物件（只含認得的鍵）。
/// Validate and normalise `colors`: every required key present, optional ones allowed, nothing else, every
/// value `#rrggbb`. Returns the object to store (known keys only).
pub fn validate_colors(v: &Value) -> Result<Value, String> {
    let obj = v.as_object().ok_or_else(|| "colors must be an object.".to_string())?;
    let mut out = Map::new();
    for key in REQUIRED_COLORS {
        let raw = obj.get(key).and_then(Value::as_str).ok_or_else(|| format!("colors.{key} is required."))?;
        let c = parse_hex_color(raw).ok_or_else(|| format!("colors.{key} must be a #rrggbb colour."))?;
        out.insert(key.to_string(), Value::String(c));
    }
    for key in OPTIONAL_COLORS {
        match obj.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(raw)) => {
                let c = parse_hex_color(raw).ok_or_else(|| format!("colors.{key} must be a #rrggbb colour."))?;
                out.insert(key.to_string(), Value::String(c));
            }
            Some(_) => return Err(format!("colors.{key} must be a #rrggbb colour.")),
        }
    }
    if let Some(extra) = obj.keys().find(|k| !REQUIRED_COLORS.contains(&k.as_str()) && !OPTIONAL_COLORS.contains(&k.as_str())) {
        return Err(format!("colors.{extra} is not a colour of a terminal scheme."));
    }
    Ok(Value::Object(out))
}

/// 名稱：去頭尾空白後 1–40 字元。/ Name: 1–40 characters after trimming.
pub fn validate_name(v: Option<&Value>) -> Result<String, ApiError> {
    let s = v.and_then(Value::as_str).ok_or_else(|| ApiError::field("name", "This field is required."))?.trim();
    if s.is_empty() {
        return Err(ApiError::field("name", "This field may not be blank."));
    }
    if s.chars().count() > NAME_MAX {
        return Err(ApiError::field("name", format!("Ensure this field has no more than {NAME_MAX} characters.")));
    }
    Ok(s.to_string())
}

fn scheme_json(s: &TerminalScheme) -> Value {
    json!({
        "id": s.scheme_id,
        "name": s.name,
        "colors": serde_json::from_str::<Value>(&s.colors).unwrap_or(Value::Null),
        "created_at": db_to_iso_utc_z(&s.created_at),
        "updated_at": db_to_iso_utc_z(&s.updated_at),
    })
}

/// `custom-<8 hex>`：合乎 id 規則（小寫字母 / 數字 / `-`，≤ 32），內建配色永遠不以 `custom-` 開頭。
/// `custom-<8 hex>`: fits the id rule (lower-case letters / digits / `-`, ≤ 32); built-ins never start with `custom-`.
fn new_scheme_id() -> String {
    format!("custom-{}", &crate::util::uuid_hex()[..8])
}

#[utoipa::path(get, path = "/api/user/terminal-schemes", tag = "User Management", security(("bearer" = [])), responses((status = 200, description = "The caller's custom schemes, oldest first", body = Vec<super::schemas::TerminalScheme>)))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let rows = db::terminal_scheme::list_for_user(&state.db, user.id).await?;
    Ok(Json(Value::Array(rows.iter().map(scheme_json).collect())))
}

#[utoipa::path(post, path = "/api/user/terminal-schemes", tag = "User Management", security(("bearer" = [])), request_body = super::schemas::TerminalSchemeBody, responses((status = 201, body = super::schemas::TerminalScheme), (status = 400, description = "{field: [message]}, or {error, code: limit} at 20 schemes", body = Object)))]
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = validate_name(body.get("name"))?;
    let colors = validate_colors(body.get("colors").unwrap_or(&Value::Null)).map_err(|m| ApiError::field("colors", m))?;
    if db::terminal_scheme::count_for_user(&state.db, user.id).await? >= MAX_PER_USER {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": format!("You can have at most {MAX_PER_USER} custom schemes."), "code": "limit" })));
    }
    let colors = colors.to_string();
    // id 撞到（機率極低）就換一個。/ On the (very unlikely) id clash, pick another.
    for _ in 0..5 {
        match db::terminal_scheme::insert(&state.db, user.id, &new_scheme_id(), &name, &colors).await {
            Ok(s) => return Ok((StatusCode::CREATED, Json(scheme_json(&s)))),
            Err(e) if is_unique_violation(&e) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::internal("could not allocate a scheme id"))
}

#[utoipa::path(patch, path = "/api/user/terminal-schemes/{id}", tag = "User Management", security(("bearer" = [])), params(("id" = String, Path, description = "Scheme id (custom-…)")), request_body = super::schemas::TerminalSchemePatch, responses((status = 200, body = super::schemas::TerminalScheme), (status = 400, description = "{field: [message]}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<String>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let name = match body.get("name") {
        None => None,
        Some(v) => Some(validate_name(Some(v))?),
    };
    let colors = match body.get("colors") {
        None => None,
        Some(v) => Some(validate_colors(v).map_err(|m| ApiError::field("colors", m))?.to_string()),
    };
    let s = db::terminal_scheme::update(&state.db, user.id, &id, name.as_deref(), colors.as_deref()).await?.ok_or_else(ApiError::drf_not_found)?;
    Ok(Json(scheme_json(&s)))
}

#[utoipa::path(delete, path = "/api/user/terminal-schemes/{id}", tag = "User Management", security(("bearer" = [])), params(("id" = String, Path, description = "Scheme id (custom-…)")), responses((status = 204, description = "Deleted; settings that pointed at it fall back to the default scheme"), (status = 404, body = super::schemas::ErrorBody)))]
async fn remove(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if !db::terminal_scheme::delete(&state.db, user.id, &id).await? {
        return Err(ApiError::drf_not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full(extra: &[(&str, &str)]) -> Value {
        let mut m = Map::new();
        for (i, k) in REQUIRED_COLORS.iter().enumerate() {
            m.insert(k.to_string(), Value::String(format!("#{:02X}{:02x}00", i, 255 - i)));
        }
        for (k, v) in extra {
            m.insert(k.to_string(), Value::String(v.to_string()));
        }
        Value::Object(m)
    }

    #[test]
    fn colors_are_normalised_to_lower_case() {
        let out = validate_colors(&full(&[("cursorAccent", "#ABCDEF")])).unwrap();
        assert_eq!(out.as_object().unwrap().len(), 21);
        assert_eq!(out["foreground"], "#00ff00");
        assert_eq!(out["cursorAccent"], "#abcdef");
        assert!(out.get("selectionForeground").is_none());
    }

    #[test]
    fn colors_are_checked_strictly() {
        assert_eq!(validate_colors(&json!("x")).unwrap_err(), "colors must be an object.");
        let mut v = full(&[]);
        v.as_object_mut().unwrap().remove("brightWhite");
        assert_eq!(validate_colors(&v).unwrap_err(), "colors.brightWhite is required.");
        assert_eq!(validate_colors(&full(&[("red", "#fff")])).unwrap_err(), "colors.red must be a #rrggbb colour.");
        assert_eq!(validate_colors(&full(&[("red", "ff0000")])).unwrap_err(), "colors.red must be a #rrggbb colour.");
        assert_eq!(validate_colors(&full(&[("selectionForeground", "red")])).unwrap_err(), "colors.selectionForeground must be a #rrggbb colour.");
        assert_eq!(validate_colors(&full(&[("purple", "#800080")])).unwrap_err(), "colors.purple is not a colour of a terminal scheme.");
        // null 的選填 = 沒給。/ A null optional = absent.
        let mut v = full(&[]);
        v.as_object_mut().unwrap().insert("cursorAccent".into(), Value::Null);
        assert!(validate_colors(&v).unwrap()["cursorAccent"].is_null());
    }

    #[test]
    fn scheme_ids_fit_the_choice_rule() {
        let id = new_scheme_id();
        assert_eq!(id.len(), 15);
        assert!(id.starts_with("custom-"));
        assert!(super::super::users::is_choice_id(&id));
    }
}
