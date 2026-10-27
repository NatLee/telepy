//! `Authorization: Bearer <access>` → 使用者。錯誤形狀與 DRF simplejwt 一致。
//! Bearer-token extractor reproducing simplejwt's 401 payloads.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use serde_json::json;

use std::sync::{Arc, OnceLock};

use super::api_tokens;
use super::jwt::TokenType;
use super::mcp::{self, Credential, McpPrincipal};
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

/// 這個請求是用委派 token（個人 API token / OAuth app 的 access token）打的：誰、哪把、什麼 scope、哪些隧道。
/// 網頁登入的請求沒有（`None` = 完整的使用者權限）。清單類 handler 用它照隧道限制過濾。放在 `AuthUser` 之後。
/// Set when the request came with a delegated token (personal API token / OAuth app token): who, which credential,
/// scopes and tunnels. Web sign-ins have none (= the user's full access). List handlers filter by its tunnel
/// restriction. Put it after `AuthUser` in the handler's arguments.
#[derive(Debug, Clone, Default)]
pub struct Delegated(pub Option<Arc<McpPrincipal>>);

impl Delegated {
    /// 這條隧道在 token 的限制內嗎（網頁登入 = 永遠是）。/ Whether the tunnel is within the token's restriction.
    pub fn allows(&self, tunnel_id: i64) -> bool {
        self.0.as_ref().map(|p| p.tunnel_allowed(tunnel_id)).unwrap_or(true)
    }
}

impl FromRequestParts<AppState> for Delegated {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(parts.extensions.get::<Delegated>().cloned().unwrap_or_default())
    }
}

/// 委派 token 打的 REST 寫入要記一筆 gateway 事件（誰透過哪把 token 做了什麼）：中介層先放一個空格子，
/// extractor 認出 token 時填進去，回應出來後中介層讀它寫事件。/ A slot the middleware puts in each request; the
/// extractor fills it for a delegated token, and the middleware writes the gateway event after the response.
#[derive(Clone, Default)]
pub struct TokenCallSlot(pub Arc<OnceLock<TokenCall>>);

#[derive(Debug, Clone)]
pub struct TokenCall {
    pub username: String,
    pub client_name: String,
    pub tunnel_id: Option<i64>,
}

fn token_error(status: StatusCode, code: &str, msg: String) -> ApiError {
    ApiError::new(status, json!({ "error": msg, "code": code }))
}

/// 委派 token → 使用者，並檢查這條路由開放給 token、scope、隧道限制。/ A delegated token → the user, with the route,
/// scope and tunnel restriction checked.
async fn delegated(parts: &mut Parts, state: &AppState, token: &str) -> Result<User, ApiError> {
    let mut p = mcp::resolve_delegated(state, token).await.map_err(|_| ApiError::token_invalid())?;
    p.ip = crate::client_ip::ClientMeta::from_parts(parts, &state.config).ip;
    if let Credential::Token(id) = p.credential {
        state.api_tokens.note_use(&state.db, id, p.ip.as_deref()).await;
    }
    let method = parts.method.as_str().to_string();
    let path = parts.uri.path().to_string();
    let Some(route) = api_tokens::rest_route(&method, &path) else {
        return Err(token_error(StatusCode::FORBIDDEN, "token_route", format!("{method} {path} is not available to API tokens or connected apps. Use the Telepy web app for it.")));
    };
    if let Some(scope) = route.scope {
        if !p.has_scope(scope) {
            let mut e = token_error(StatusCode::FORBIDDEN, "token_scope", format!("This token was not given the `{scope}` scope."));
            e.body["scope"] = json!(scope);
            return Err(e);
        }
    }
    let tunnel_id = match route.tunnel {
        api_tokens::TunnelRef::Path(id) => {
            if !p.tunnel_allowed(id) {
                return Err(ApiError::drf_not_found());
            }
            Some(id)
        }
        api_tokens::TunnelRef::Unrestricted if p.tunnel_ids.is_some() => {
            return Err(token_error(StatusCode::FORBIDDEN, "token_tunnels", "This token is limited to some tunnels, so it can't do this. Use a token without a tunnel limit.".into()));
        }
        _ => None,
    };
    if let Some(f) = crate::features::for_route(&method, &path) {
        crate::features::check(state, &p.user, f).await?;
    }
    if let Some(slot) = parts.extensions.get::<TokenCallSlot>() {
        let _ = slot.0.set(TokenCall { username: p.user.username.clone(), client_name: p.client_name.clone(), tunnel_id });
    }
    // step-up 只屬於網頁上確認過的那個瀏覽器：token 帶來的一律不算（跟 MCP 一樣，敏感隧道拒絕 token）。
    // A step-up belongs to the browser that confirmed it: never honoured with a token (step-up tunnels refuse tokens, as MCP does).
    parts.headers.remove(crate::step_up::HEADER);
    let user = p.user.clone();
    parts.extensions.insert(Delegated(Some(Arc::new(p))));
    Ok(user)
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts).ok_or_else(ApiError::unauthenticated)?;
        // 個人 API token 或 OAuth app 的 access token：照 token 的 scope / 隧道限制走。
        // A personal API token or an OAuth app's access token: limited by its scopes and tunnels.
        if api_tokens::looks_like_token(&token) || state.jwt.verify_mcp(&token).is_ok() {
            return Ok(AuthUser(delegated(parts, state, &token).await?));
        }
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
        // 功能權限：這條路由屬於管理員替這個人關掉的功能 → 403 feature_disabled（`crate::features`）。
        // Feature permissions: a route of a feature turned off for this person is a 403 feature_disabled.
        if let Some(f) = crate::features::for_route(parts.method.as_str(), parts.uri.path()) {
            crate::features::check(state, &user, f).await?;
        }
        Ok(AuthUser(user))
    }
}
