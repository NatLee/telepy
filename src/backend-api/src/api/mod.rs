//! REST handlers，依 Django app 分檔。每個檔案的回應形狀/狀態碼/錯誤字串都對照原 view。
//! REST handlers grouped by the Django app they replace; shapes mirror the original views.

pub mod access;
pub mod access_requests;
pub mod ai;
pub mod api_tokens;
pub mod auth;
pub mod browser;
pub mod command_rules;
pub mod credentials;
pub mod desktop;
pub mod device_keys;
pub mod doc;
pub mod groups;
pub mod host_keys;
pub mod join;
pub mod lan;
pub mod logs;
pub mod mfa;
pub mod notify;
pub mod notify_prefs;
pub mod oauth;
pub mod recordings;
pub mod terminal_detach;
pub mod remote_browser;
pub mod reverse_keys;
pub mod rustdesk;
pub mod schemas;
pub mod scripts;
pub mod serialize;
pub mod sessions;
pub mod sftp;
pub mod sharing;
pub mod sign_ins;
pub mod snippets;
pub mod web_sessions;
pub mod site_settings;
pub mod step_up;
pub mod terminal_profile;
pub mod terminal_schemes;
pub mod tunnels;
pub mod user_keys;
pub mod usernames;
pub mod users;
pub mod webhooks;
pub mod whoami;

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// JSON body extractor，解析失敗回 DRF 風格的 400 `{"detail": "JSON parse error - ..."}`。
/// 缺 body / 非 JSON content-type 時視為空物件（Django `request.data` 對空 body 回空 dict）。
pub struct AppJson<T>(pub T);

impl<S, T> FromRequest<S> for AppJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Default,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(v)) => Ok(AppJson(v)),
            Err(JsonRejection::MissingJsonContentType(_)) => Ok(AppJson(T::default())),
            Err(JsonRejection::JsonSyntaxError(e)) => Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                format!("JSON parse error - {}", e.body_text()),
            )),
            Err(JsonRejection::JsonDataError(e)) => Err(ApiError::detail(StatusCode::BAD_REQUEST, e.body_text())),
            Err(e) => Err(ApiError::detail(StatusCode::BAD_REQUEST, e.body_text())),
        }
    }
}

/// `serde_json::Value` 版本：空 body → `{}`（方便逐欄位用 `json_str`/`json_i64` 取值）。
pub type Body = AppJson<serde_json::Value>;

pub fn body_object(v: &serde_json::Value) -> serde_json::Value {
    if v.is_object() {
        v.clone()
    } else {
        serde_json::json!({})
    }
}

/// 列表端點的 `?scope=`：`mine`（預設，每個人都一樣 —— 管理員也只看到自己的）或 `all`（只有管理員，給管理區的頁面）。
/// The `?scope=` of the list endpoints: `mine` (the default, the same for everyone — admins too) or `all` (admins
/// only, for the admin section's pages).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewScope {
    Mine,
    All,
}

impl ViewScope {
    /// 解析並檢查權限：非管理員要 `all` = 403 `admin_only`，認不得的值 = 400。
    /// Parse and check: `all` from a non-admin is 403 `admin_only`, an unknown value 400.
    pub fn parse(raw: Option<&str>, is_superuser: bool) -> crate::error::ApiResult<Self> {
        match raw.map(str::trim) {
            None | Some("") | Some("mine") => Ok(Self::Mine),
            Some("all") if is_superuser => Ok(Self::All),
            Some("all") => Err(crate::error::ApiError::new(
                axum::http::StatusCode::FORBIDDEN,
                serde_json::json!({ "error": "Only administrators can see everyone's records.", "code": "admin_only" }),
            )),
            Some(_) => Err(crate::error::ApiError::bad_request("scope must be mine or all")),
        }
    }
}

#[cfg(test)]
mod view_scope_tests {
    use super::ViewScope;

    #[test]
    fn mine_is_the_default_and_all_needs_an_admin() {
        assert_eq!(ViewScope::parse(None, true).unwrap(), ViewScope::Mine);
        assert_eq!(ViewScope::parse(Some("mine"), true).unwrap(), ViewScope::Mine);
        assert_eq!(ViewScope::parse(Some("all"), true).unwrap(), ViewScope::All);
        assert_eq!(ViewScope::parse(Some("all"), false).unwrap_err().status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(ViewScope::parse(Some("everything"), true).unwrap_err().status, axum::http::StatusCode::BAD_REQUEST);
    }
}
