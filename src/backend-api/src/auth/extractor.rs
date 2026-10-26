//! `Authorization: Bearer <access>` → 使用者。錯誤形狀與 DRF simplejwt 一致。
//! Bearer-token extractor reproducing simplejwt's 401 payloads.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use serde_json::json;

use super::jwt::TokenType;
use crate::db::{self, users::User};
use crate::error::ApiError;
use crate::mfa;
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
    Ok(session_from_access_token(state, token).await?.0)
}

/// 同上，另回 token 所屬的登入 session（`sid`）。session 已撤銷（使用者從別的裝置登出它、管理員）= 401，
/// 即使 access token 還沒到期。/ Like above, plus the token's sign-in session; a revoked session is a 401 even
/// before the access token expires.
pub async fn session_from_access_token(state: &AppState, token: &str) -> Result<(User, Option<i64>), ApiError> {
    let claims = state.jwt.verify(token, TokenType::Access).map_err(|_| ApiError::token_invalid())?;
    if let Some(sid) = claims.sid {
        if let Some(reason) = crate::auth::sessions::ended(state, sid).await? {
            return Err(crate::auth::sessions::signed_out(&reason));
        }
    }
    let user = db::users::by_id(&state.db, claims.user_id)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, json!({"detail": "User not found", "code": "user_not_found"})))?;
    if !user.is_active {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, json!({"detail": "User is inactive", "code": "user_inactive"})));
    }
    Ok((user, claims.sid))
}

/// 這個請求的 access token 屬於哪個登入 session（「這個瀏覽器」）。只讀 token，不驗證使用者 —— 跟 `AuthUser` 一起用。
/// The sign-in session of this request's access token ("this browser"). Reads the token only; use with `AuthUser`.
#[derive(Debug, Clone, Copy)]
pub struct CurrentSession(pub Option<i64>);

impl FromRequestParts<AppState> for CurrentSession {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let sid = bearer_token(parts).and_then(|t| state.jwt.verify(&t, TokenType::Access).ok()).and_then(|c| c.sid);
        Ok(CurrentSession(sid))
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts).ok_or_else(ApiError::unauthenticated)?;
        let (user, sid) = session_from_access_token(state, &token).await?;
        if let Some(sid) = sid {
            crate::auth::sessions::note_use(state, sid, crate::client_ip::ClientMeta::from_parts(parts, &state.config).ip);
        }
        // 管理員要求兩步驟、這個帳號還沒設好：只開放設定所需的路徑。403 而不是 401（web 遇到 401 會登出）。
        // The admin requires two-step sign-in and this account has not enrolled: only the enrollment paths stay open.
        if !mfa::allowed_while_enrolling(parts.uri.path()) {
            let missing = crate::api::mfa::enrollment_missing(state, user.id).await?;
            if !missing.is_empty() {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    json!({"error": mfa::ENROLLMENT_REQUIRED_MSG, "code": mfa::ENROLLMENT_REQUIRED, "missing": missing}),
                ));
            }
        }
        Ok(AuthUser(user))
    }
}
