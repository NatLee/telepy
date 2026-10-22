//! `/api/auth/*`：custom_jwt、custom_auth（Google）、login（register）三個 Django app 的端點。

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::{body_object, AppJson};
use crate::auth::password::{check_password, make_password, unusable_password};
use crate::auth::{AuthUser, TokenType};
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

pub(crate) fn token_pair(state: &AppState, user_id: i64) -> Value {
    json!({
        "refresh_token": state.jwt.refresh(user_id),
        "access_token": state.jwt.access(user_id),
    })
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
async fn obtain_token(State(state): State<AppState>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
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
        return Err(denied());
    }
    // 有第二因素 → 回登入挑戰（mfa_required），否則直接發 token。/ Second factor → challenge, else tokens.
    Ok(Json(super::mfa::complete_login(&state, &user).await?))
}

fn token_not_valid() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, json!({ "detail": "Token is invalid or expired", "code": "token_not_valid" }))
}

/// simplejwt TokenRefreshView（ROTATE_REFRESH_TOKENS=False：只回新的 access）。
#[utoipa::path(post, path = "/api/auth/token/refresh", tag = "Login", request_body = super::schemas::RefreshRequest, responses((status = 200, body = super::schemas::AccessToken), (status = 401, description = "Token is invalid or expired", body = super::schemas::ErrorBody)))]
async fn refresh_token(State(state): State<AppState>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let body = body_object(&body);
    if let Some(e) = required_fields_error(&body, &["refresh"]) {
        return Err(e);
    }
    let token = json_str(&body, "refresh").unwrap_or_default();
    let claims = state.jwt.verify(&token, TokenType::Refresh).map_err(|_| token_not_valid())?;
    Ok(Json(json!({ "access_token": state.jwt.access(claims.user_id) })))
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

/// UserProfileView：基本資料 + 個人設定（language/theme/terminal_font_size）。
#[utoipa::path(get, path = "/api/auth/user/profile", tag = "Authentication", security(("bearer" = [])), responses((status = 200, body = super::schemas::UserProfile), (status = 401, body = super::schemas::ErrorBody)))]
async fn profile(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let settings = db::users::settings_for(&state.db, user.id).await?;
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
        "mfa_enabled": super::mfa::factors(&state, user.id).await?.any(),
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
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "status": "success",
            "data": { "user": { "id": user.id, "username": user.username } },
            "details": "User created successfully"
        })),
    ))
}

fn third_party_error(status: StatusCode, detail: &str) -> ApiError {
    ApiError::new(status, json!({ "status": "error", "detail": detail }))
}

/// custom_auth GoogleLogin + third_party_login：驗 id_token、網域白名單、建立/取得使用者、發 JWT。
#[utoipa::path(post, path = "/api/auth/google/token", tag = "Login", request_body = super::schemas::GoogleLoginRequest, responses((status = 200, body = super::schemas::LoginResponse), (status = 400, description = "Registration disabled", body = super::schemas::ErrorBody), (status = 401, description = "Email domain not allowed", body = super::schemas::ErrorBody), (status = 500, description = "Token could not be verified", body = super::schemas::ErrorBody)))]
async fn google_login(State(state): State<AppState>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let body = body_object(&body);
    if let Some(e) = required_fields_error(&body, &["credential"]) {
        return Err(e);
    }
    let credential = json_str(&body, "credential").unwrap_or_default();
    let claims = match state.google.verify(&credential, state.config.google_client_id.as_deref()).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "[AUTH][GOOGLE] id_token verification failed");
            return Err(third_party_error(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong :("));
        }
    };
    let Some(email) = claims.email.filter(|e| e.contains('@')) else {
        tracing::error!("[AUTH][GOOGLE] Token has no `email` claim");
        return Err(third_party_error(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong :("));
    };
    let (account, domain) = email.split_once('@').expect("checked above");
    let settings = db::settings::get_solo(&state.db).await?;
    let allowed = settings.register_domains(&state.config.default_register_domains);
    if !allowed.contains(&domain.to_ascii_lowercase()) {
        tracing::warn!(email, domain, "[AUTH][GOOGLE] attempts to register with disallowed domain");
        return Err(third_party_error(StatusCode::UNAUTHORIZED, "This email is invalid."));
    }
    let first_name = claims.given_name.clone().unwrap_or_default();
    let last_name = claims.family_name.clone().unwrap_or_default();

    let user = match db::users::by_username(&state.db, account).await? {
        Some(u) => u,
        None => {
            if !registration_allowed(&state).await? {
                tracing::warn!(email, "[AUTH][GOOGLE] registration disabled");
                return Err(third_party_error(StatusCode::BAD_REQUEST, "Disallowed creation of user now."));
            }
            let hash = unusable_password();
            let u = db::users::create(
                &state.db,
                NewUser { username: account, password_hash: &hash, email: &email, first_name: &first_name, last_name: &last_name },
            )
            .await?;
            db::users::social_create(&state.db, u.id, "google", &claims.sub).await?;
            tracing::info!(username = account, email, "[AUTH][GOOGLE] Created user");
            u
        }
    };
    // 帳號可能是用其他方式註冊的：沒有 SocialAccount 就拒絕（與 Django 版相同的 ValueError → 500）。
    if db::users::social_for(&state.db, user.id, "google").await?.is_none() {
        tracing::error!(username = user.username, "[AUTH][GOOGLE] SocialAccount does not exist");
        return Err(third_party_error(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong :("));
    }
    if !user.is_active {
        return Err(third_party_error(StatusCode::UNAUTHORIZED, "This email is invalid."));
    }
    let result = super::mfa::complete_login(&state, &user).await?;
    if result.get("mfa_required").is_none() {
        db::users::touch_last_login(&state.db, user.id).await?;
        tracing::info!(username = user.username, "[AUTH][3RD] Login success");
    }
    Ok(Json(result))
}
