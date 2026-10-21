//! API 錯誤型別：維持與 Django/DRF 完全相同的 JSON 形狀與狀態碼，前端 `formatApiError` 讀
//! `{detail}` / `{error}` / `{field: [...]}` 三種。/ API error type reproducing the exact DRF/Django
//! response shapes the frontend already parses.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub body: Value,
}

impl ApiError {
    pub fn new(status: StatusCode, body: Value) -> Self {
        Self { status, body }
    }
    /// `{"error": msg}` — 本專案自訂 view 最常用的形狀。
    pub fn error(status: StatusCode, msg: impl Into<String>) -> Self {
        Self::new(status, json!({ "error": msg.into() }))
    }
    /// `{"detail": msg}` — DRF 內建例外（PermissionDenied / NotFound / NotAuthenticated）。
    pub fn detail(status: StatusCode, msg: impl Into<String>) -> Self {
        Self::new(status, json!({ "detail": msg.into() }))
    }
    /// `{"field": ["msg"]}` — DRF serializer 欄位驗證錯誤。
    pub fn field(field: &str, msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, json!({ field: [msg.into()] }))
    }
    /// `["msg"]` — DRF `ValidationError("msg")` 直接 raise 時的形狀。
    pub fn validation_list(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, json!([msg.into()]))
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::error(StatusCode::BAD_REQUEST, msg)
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::error(StatusCode::NOT_FOUND, msg)
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::error(StatusCode::FORBIDDEN, msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::error(StatusCode::INTERNAL_SERVER_ERROR, msg)
    }
    /// DRF `NotFound` 預設訊息。
    pub fn drf_not_found() -> Self {
        Self::detail(StatusCode::NOT_FOUND, "Not found.")
    }
    pub fn unauthenticated() -> Self {
        Self::detail(StatusCode::UNAUTHORIZED, "Authentication credentials were not provided.")
    }
    pub fn token_invalid() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            json!({
                "detail": "Given token not valid for any token type",
                "code": "token_not_valid",
                "messages": [{
                    "token_class": "AccessToken",
                    "token_type": "access",
                    "message": "Token is invalid or expired"
                }]
            }),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, axum::Json(self.body)).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "database error");
        ApiError::internal(db_error_message(&e))
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "internal error");
        ApiError::internal(e.to_string())
    }
}

/// 把 sqlx 的錯誤壓成 Django 風格的訊息（例如 `UNIQUE constraint failed: auth_user.username`），
/// 前端會把它原樣顯示。/ Reduce sqlx errors to the bare SQLite message Django would have surfaced.
pub fn db_error_message(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(db) => db.message().to_string(),
        other => other.to_string(),
    }
}

pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(db) if db.is_unique_violation())
}

pub type ApiResult<T> = Result<T, ApiError>;
