//! `/api/auth/*`：custom_jwt、custom_auth（Google）、login（register）三個 Django app 的端點。

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::sign_ins::{self, Attempt};
use super::{body_object, AppJson};
use crate::auth::password::{check_password, make_password, unusable_password};
use crate::auth::google::{GoogleClaims, GoogleError};
use crate::auth::AuthUser;
use crate::client_ip::ClientMeta;
use crate::db::{self, users::NewUser};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::{json_str, opt_db_to_iso_utc_z, db_to_iso_utc_z};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(setup_status))
        .routes(routes!(obtain_token))
        .routes(routes!(refresh_token))
        .routes(routes!(logout))
        .routes(routes!(verify_token))
        .routes(routes!(profile))
        .routes(routes!(register))
        .routes(routes!(google_login))
}

/// 公開健康/首次設定端點（compose healthcheck 與 Traefik healthCheck 都打這支）。
#[utoipa::path(get, path = "/api/auth/setup-status", tag = "Login", responses((status = 200, description = "Whether no user exists yet (first-time setup)", body = super::schemas::SetupStatus)))]
async fn setup_status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let n = db::users::count(&state.db).await?;
    Ok(Json(json!({ "first_time_setup": n == 0 })))
}

/// 登入完成 → 開一個 session、發 `{refresh_token, access_token}`（`auth::sessions`）。
/// Login done → start a session and issue the pair (`auth::sessions`).
/// `method` / `second_factor` 記在 session 上（「你的裝置」）。/ The sign-in method is stored on the session.
pub(crate) async fn token_pair(state: &AppState, user_id: i64, meta: &ClientMeta, method: &str, second_factor: Option<&str>) -> ApiResult<Value> {
    crate::auth::sessions::issue(state, user_id, meta, method, second_factor).await
}

fn required_fields_error(body: &Value, fields: &[&str]) -> Option<ApiError> {
    let mut errors = serde_json::Map::new();
    for f in fields {
        let missing = match body.get(*f) {
            Some(Value::String(s)) => s.is_empty(),
            Some(Value::Null) | None => true,
            _ => false,
        };
        if missing {
            let msg = match body.get(*f) {
                Some(Value::String(_)) => "This field may not be blank.",
                Some(Value::Null) => "This field may not be null.",
                _ => "This field is required.",
            };
            errors.insert(f.to_string(), json!([msg]));
        }
    }
    (!errors.is_empty()).then(|| ApiError::new(StatusCode::BAD_REQUEST, Value::Object(errors)))
}

/// simplejwt TokenObtainPairView（MyTokenObtainPairSerializer 改名為 access_token/refresh_token）。
#[utoipa::path(post, path = "/api/auth/token", tag = "Login", request_body = super::schemas::LoginRequest, responses((status = 200, body = super::schemas::LoginResponse), (status = 400, description = "Missing fields: {field: [message]}", body = Object), (status = 401, description = "Bad credentials or inactive account", body = super::schemas::ErrorBody)))]
async fn obtain_token(State(state): State<AppState>, meta: ClientMeta, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let body = body_object(&body);
    if let Some(e) = required_fields_error(&body, &["username", "password"]) {
        return Err(e);
    }
    let username = json_str(&body, "username").unwrap_or_default();
    let password = json_str(&body, "password").unwrap_or_default();
    let denied = || ApiError::detail(StatusCode::UNAUTHORIZED, "No active account found with the given credentials");
    let user = db::users::by_username(&state.db, &username).await?.ok_or_else(denied)?;
    let encoded = user.password.clone();
    let ok = tokio::task::spawn_blocking(move || check_password(&password, &encoded))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if !ok || !user.is_active {
        let reason = if ok { "inactive" } else { "bad_password" };
        sign_ins::record(&state, user.id, &meta, Attempt::failed("password", None, reason)).await;
        return Err(denied());
    }
    // 有第二因素 → 回登入挑戰（mfa_required），否則直接發 token。/ Second factor → challenge, else tokens.
    Ok(Json(super::mfa::complete_login(&state, &user, "password", &meta).await?))
}

use crate::auth::sessions::token_not_valid;

/// simplejwt TokenRefreshView，但 ROTATE_REFRESH_TOKENS：回新的 access **和** 新的 refresh（舊的只在寬限內還能用），
/// 登入效期每次續期都往後推（網站設定 `signin_lifetime`）。/ Like simplejwt's refresh view with rotation: a new
/// access **and** refresh token (the old one works only within the grace); the sign-in's expiry slides.
#[utoipa::path(post, path = "/api/auth/token/refresh", tag = "Login", request_body = super::schemas::RefreshRequest, responses((status = 200, body = super::schemas::RefreshResponse), (status = 401, description = "Token is invalid, expired, revoked or already replaced", body = super::schemas::ErrorBody)))]
async fn refresh_token(State(state): State<AppState>, meta: ClientMeta, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let body = body_object(&body);
    if let Some(e) = required_fields_error(&body, &["refresh"]) {
        return Err(e);
    }
    let token = json_str(&body, "refresh").unwrap_or_default();
    Ok(Json(crate::auth::sessions::refresh(&state, &token, &meta).await?))
}

/// 登出：撤銷這顆 refresh token 的登入 session（之後不能再續期）。不需要 access token（它可能已經過期）；
/// 無效的 token 也回 200（沒東西可撤）。/ Logout: revoke the refresh token's sign-in session. No access
/// token needed (it may have expired); an invalid token is still a 200 (nothing to revoke).
#[utoipa::path(post, path = "/api/auth/logout", tag = "Login", request_body = super::schemas::LogoutRequest, responses((status = 200, description = "{\"revoked\": bool}", body = Object)))]
async fn logout(State(state): State<AppState>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let body = body_object(&body);
    if let Some(e) = required_fields_error(&body, &["refresh"]) {
        return Err(e);
    }
    let token = json_str(&body, "refresh").unwrap_or_default();
    let revoked = crate::auth::sessions::revoke(&state, &token).await?;
    Ok(Json(json!({ "revoked": revoked })))
}

/// simplejwt TokenVerifyView：任何型別的有效 token 都回 200 `{}`。
#[utoipa::path(post, path = "/api/auth/token/verify", tag = "Login", request_body = super::schemas::VerifyRequest, responses((status = 200, description = "Valid token (empty object)", body = Object), (status = 401, body = super::schemas::ErrorBody)))]
async fn verify_token(State(state): State<AppState>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let body = body_object(&body);
    if let Some(e) = required_fields_error(&body, &["token"]) {
        return Err(e);
    }
    let token = json_str(&body, "token").unwrap_or_default();
    state.jwt.verify_any(&token).map_err(|_| token_not_valid())?;
    Ok(Json(json!({})))
}

/// UserProfileView：基本資料 + 個人設定（language / theme / terminal_* / ui_scale）。
#[utoipa::path(get, path = "/api/auth/user/profile", tag = "Authentication", security(("bearer" = [])), responses((status = 200, body = super::schemas::UserProfile), (status = 401, body = super::schemas::ErrorBody)))]
async fn profile(State(state): State<AppState>, AuthUser(user): AuthUser, d: crate::auth::extractor::Delegated) -> ApiResult<Json<Value>> {
    // 用 API token / OAuth app 的 token 打的：說明是哪一把、哪些 scope 與隧道（`telepy whoami` / `doctor`）。
    // Called with an API token or an OAuth app token: which one, its scopes and tunnels (`telepy whoami` / `doctor`).
    let credential = match d.0.as_deref() {
        None => Value::Null,
        Some(p) => {
            let expires_at = match p.credential {
                crate::auth::mcp::Credential::Token(id) => db::api_tokens::by_id(&state.db, id).await?.map(|t| db_to_iso_utc_z(&t.expires_at)),
                crate::auth::mcp::Credential::Grant(_) => None,
            };
            json!({
                "kind": if p.credential.token_id().is_some() { "api_token" } else { "oauth_app" },
                "id": p.credential.token_id().or(p.credential.grant_id()),
                "name": p.client_name,
                "scopes": p.scopes,
                "tunnel_ids": p.tunnel_ids,
                "expires_at": expires_at,
            })
        }
    };
    let settings = db::users::settings_for(&state.db, user.id).await?;
    // 這個人能用的功能（前端用來藏導覽 / 選單；真正的門在 API）。/ Features this person may use (the UI hides the rest).
    let features = state.features.policy().await?.allowed_ids(&user);
    Ok(Json(json!({
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "is_staff": user.is_staff,
        "is_superuser": user.is_superuser,
        "is_active": user.is_active,
        "date_joined": db_to_iso_utc_z(&user.date_joined),
        "last_login": opt_db_to_iso_utc_z(&user.last_login),
        "language": settings.as_ref().and_then(|s| s.language.clone()),
        "theme": settings.as_ref().map(|s| s.theme.clone()).unwrap_or_else(|| "system".into()),
        "terminal_font_size": settings.as_ref().map(|s| s.terminal_font_size).unwrap_or(14),
        "ui_scale": settings.as_ref().map(|s| s.ui_scale).unwrap_or(100),
        "terminal_font": settings.as_ref().map(|s| s.terminal_font.clone()).unwrap_or_else(|| "hack".into()),
        "terminal_scheme": settings.as_ref().map(|s| s.terminal_scheme.clone()).unwrap_or_else(|| "telepy".into()),
        "terminal_bold": settings.as_ref().map(|s| s.terminal_bold.clone()).unwrap_or_else(|| "face".into()),
        "terminal_ligatures": settings.as_ref().map(|s| s.terminal_ligatures).unwrap_or(false),
        "mfa_enabled": super::mfa::factors(&state, user.id).await?.any(),
        "mfa_missing": super::mfa::enrollment_missing(&state, user.id).await?,
        "features": features,
        "credential": credential,
    })))
}

/// 註冊是否開放：第一位使用者永遠可以；之後看 SiteSettings.allow_registration（pre_save signal 的語意）。
async fn registration_allowed(state: &AppState) -> ApiResult<bool> {
    if db::users::count(&state.db).await? == 0 {
        return Ok(true);
    }
    Ok(db::settings::get_solo(&state.db).await?.allow_registration)
}

/// login.views.Register：帳密註冊。第一位使用者成為 superuser。
#[utoipa::path(post, path = "/api/auth/register", tag = "Login", request_body = super::schemas::RegisterRequest, responses((status = 201, body = super::schemas::RegisterResponse), (status = 400, description = "Username taken, registration disabled, …", body = super::schemas::ErrorBody)))]
async fn register(State(state): State<AppState>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let body = body_object(&body);
    let username = json_str(&body, "username").unwrap_or_default();
    let password = json_str(&body, "password");
    if username.trim().is_empty() {
        return Err(ApiError::bad_request("The given username must be set"));
    }
    if !registration_allowed(&state).await? {
        return Err(ApiError::bad_request("Registration is currently disabled."));
    }
    let hash = match password {
        Some(p) if !p.is_empty() => tokio::task::spawn_blocking(move || make_password(&p))
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?,
        _ => unusable_password(),
    };
    let user = db::users::create(
        &state.db,
        NewUser { username: username.trim(), password_hash: &hash, email: "", first_name: "", last_name: "" },
    )
    .await
    .map_err(|e| {
        if is_unique_violation(&e) {
            ApiError::bad_request("UNIQUE constraint failed: auth_user.username")
        } else {
            ApiError::from(e)
        }
    })?;
    state.webhooks.emit(
        crate::webhooks::Event::new(crate::webhooks::Kind::UserCreated).data(json!({ "user": user.username, "via": "registration" })).link("/tunnels/settings?tab=users"),
    );
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "status": "success",
            "data": { "user": { "id": user.id, "username": user.username } },
            "details": "User created successfully"
        })),
    ))
}

/// Google 登入的錯誤：`{status: "error", detail, code, …}`。前端依 code 轉成在地化訊息，detail 是英文退路。
/// Google-login errors carry a machine-readable `code` (mapped to dictionary text by the frontend).
fn google_error(status: StatusCode, code: &str, detail: impl Into<String>, extra: Value) -> ApiError {
    let mut body = json!({ "status": "error", "detail": detail.into(), "code": code });
    if let (Some(b), Value::Object(extra)) = (body.as_object_mut(), extra) {
        b.extend(extra);
    }
    ApiError::new(status, body)
}

fn google_verify_error(e: &GoogleError) -> ApiError {
    match e {
        GoogleError::NotConfigured => google_error(StatusCode::INTERNAL_SERVER_ERROR, "google_not_configured", "Google sign-in is not configured on this server (SOCIAL_GOOGLE_CLIENT_ID).", json!({})),
        GoogleError::Fetch(_) => google_error(StatusCode::BAD_GATEWAY, "google_unreachable", "Could not reach Google to verify the sign-in. Try again in a moment.", json!({})),
        GoogleError::Expired => google_error(StatusCode::BAD_REQUEST, "google_expired", "The Google sign-in expired. Please try again.", json!({})),
        GoogleError::WrongAudience => google_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "google_client_mismatch",
            "This server's Google client ID does not match the sign-in button. Check SOCIAL_GOOGLE_CLIENT_ID.",
            json!({}),
        ),
        GoogleError::Invalid(_) => google_error(StatusCode::BAD_REQUEST, "google_invalid", "The Google sign-in could not be verified. Please try again.", json!({})),
    }
}

/// custom_auth GoogleLogin + third_party_login：驗 id_token、網域白名單、建立/取得使用者、發 JWT。
/// 錯誤不再一律是 "Something went wrong :("（#23）：每種情況有自己的 code 與訊息。
#[utoipa::path(post, path = "/api/auth/google/token", tag = "Login", request_body = super::schemas::GoogleLoginRequest, responses(
    (status = 200, body = super::schemas::LoginResponse),
    (status = 400, description = "google_invalid / google_expired / google_no_email, or a missing credential", body = super::schemas::GoogleLoginError),
    (status = 403, description = "google_domain_not_allowed / registration_closed / account_disabled", body = super::schemas::GoogleLoginError),
    (status = 409, description = "google_account_conflict: the username belongs to a password account", body = super::schemas::GoogleLoginError),
    (status = 500, description = "google_not_configured / google_client_mismatch (server configuration)", body = super::schemas::GoogleLoginError),
    (status = 502, description = "google_unreachable", body = super::schemas::GoogleLoginError),
))]
async fn google_login(State(state): State<AppState>, meta: ClientMeta, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let body = body_object(&body);
    if let Some(e) = required_fields_error(&body, &["credential"]) {
        return Err(e);
    }
    let credential = json_str(&body, "credential").unwrap_or_default();
    let claims = state.google.verify(&credential, state.config.google_client_id.as_deref()).await.map_err(|e| {
        tracing::error!(error = %e, "[AUTH][GOOGLE] id_token verification failed");
        google_verify_error(&e)
    })?;
    Ok(Json(google_sign_in(&state, claims, &meta).await?))
}

/// id_token 驗過之後：網域白名單 → 找 / 建帳號 → 檢查 → 發 token 或 2FA 挑戰。拆出來以便直接測試各種錯誤。
/// After the id_token is verified: domain allow-list, find or create the account, checks, tokens or a 2FA challenge.
pub async fn google_sign_in(state: &AppState, claims: GoogleClaims, meta: &ClientMeta) -> ApiResult<Value> {
    let Some(email) = claims.email.filter(|e| e.contains('@')) else {
        tracing::error!("[AUTH][GOOGLE] Token has no `email` claim");
        return Err(google_error(StatusCode::BAD_REQUEST, "google_no_email", "Your Google account did not share an email address.", json!({})));
    };
    let (account, domain) = email.split_once('@').expect("checked above");
    let settings = db::settings::get_solo(&state.db).await?;
    let allowed = settings.register_domains(&state.config.default_register_domains);
    if !allowed.contains(&domain.to_ascii_lowercase()) {
        tracing::warn!(email, domain, "[AUTH][GOOGLE] attempts to register with disallowed domain");
        return Err(google_error(
            StatusCode::FORBIDDEN,
            "google_domain_not_allowed",
            format!("Accounts from {domain} cannot sign in to this server."),
            json!({ "domain": domain }),
        ));
    }
    let first_name = claims.given_name.clone().unwrap_or_default();
    let last_name = claims.family_name.clone().unwrap_or_default();

    let user = match db::users::by_username(&state.db, account).await? {
        Some(u) => u,
        None => {
            if !registration_allowed(state).await? {
                tracing::warn!(email, "[AUTH][GOOGLE] registration disabled");
                return Err(google_error(
                    StatusCode::FORBIDDEN,
                    "registration_closed",
                    "This server does not accept new accounts. Ask an administrator to create one for you.",
                    json!({}),
                ));
            }
            let hash = unusable_password();
            let u = db::users::create(
                &state.db,
                NewUser { username: account, password_hash: &hash, email: &email, first_name: &first_name, last_name: &last_name },
            )
            .await?;
            db::users::social_create(&state.db, u.id, "google", &claims.sub).await?;
            tracing::info!(username = account, email, "[AUTH][GOOGLE] Created user");
            state.webhooks.emit(
                crate::webhooks::Event::new(crate::webhooks::Kind::UserCreated).data(json!({ "user": u.username, "via": "google" })).link("/tunnels/settings?tab=users"),
            );
            u
        }
    };
    // 同名帳號是用帳密建立的（沒有 Google 連結）：說清楚該怎麼登入，而不是 500。
    // The username belongs to a password account without a Google link: say how to sign in instead of a 500.
    if db::users::social_for(&state.db, user.id, "google").await?.is_none() {
        tracing::warn!(username = user.username, "[AUTH][GOOGLE] username belongs to an account without a Google link");
        sign_ins::record(state, user.id, meta, Attempt::failed("google", None, "google_account_conflict")).await;
        return Err(google_error(
            StatusCode::CONFLICT,
            "google_account_conflict",
            format!("An account named \"{}\" already exists and signs in with a password. Sign in with your password instead.", user.username),
            json!({ "username": user.username }),
        ));
    }
    if !user.is_active {
        sign_ins::record(state, user.id, meta, Attempt::failed("google", None, "inactive")).await;
        return Err(google_error(StatusCode::FORBIDDEN, "account_disabled", "This account is disabled. Contact an administrator.", json!({})));
    }
    // last_login 由 complete_login（無第二步）或 mfa_verify（有第二步）更新。/ last_login is touched by complete_login / mfa_verify.
    let result = super::mfa::complete_login(state, &user, "google", meta).await?;
    if result.get("mfa_required").is_none() {
        tracing::info!(username = user.username, "[AUTH][3RD] Login success");
    }
    Ok(result)
}
