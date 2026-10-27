//! REST handlers，依 Django app 分檔。每個檔案的回應形狀/狀態碼/錯誤字串都對照原 view。
//! REST handlers grouped by the Django app they replace; shapes mirror the original views.

pub mod access_requests;
pub mod ai;
pub mod auth;
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
pub mod oauth;
pub mod recordings;
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
