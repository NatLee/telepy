//! `Authorization: Bearer <access>` → 使用者。錯誤形狀與 DRF simplejwt 一致。
//! Bearer-token extractor reproducing simplejwt's 401 payloads.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use serde_json::json;

use super::jwt::TokenType;
use crate::db::{self, users::User};
use crate::error::ApiError;
use crate::state::AppState;

/// 已認證的使用者（`request.user`）。
#[derive(Debug, Clone)]
pub struct AuthUser(pub User);

impl std::ops::Deref for AuthUser {
    type Target = User;
    fn deref(&self) -> &User {
        &self.0
    }
}

pub fn bearer_token(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// 用 access token 取使用者；錯誤即 simplejwt 的 401 形狀。
pub async fn user_from_access_token(state: &AppState, token: &str) -> Result<User, ApiError> {
    let claims = state.jwt.verify(token, TokenType::Access).map_err(|_| ApiError::token_invalid())?;
    let user = db::users::by_id(&state.db, claims.user_id)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, json!({"detail": "User not found", "code": "user_not_found"})))?;
    if !user.is_active {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, json!({"detail": "User is inactive", "code": "user_inactive"})));
    }
    Ok(user)
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts).ok_or_else(ApiError::unauthenticated)?;
        Ok(AuthUser(user_from_access_token(state, &token).await?))
    }
}
