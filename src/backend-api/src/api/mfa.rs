//! 兩步驟驗證（TOTP、passkey、復原碼）的端點。邏輯見 `mfa/`，儲存見 `db/mfa.rs`。
//!
//! 登入（公開）：
//! - 帳密 / Google 通過後，若帳號有任一第二因素，`/api/auth/token`、`/api/auth/google/token` 回
//!   `{mfa_required: true, mfa_token, methods}`（不發 token）；`POST /api/auth/mfa/verify` 以 TOTP / 復原碼 / passkey
//!   完成後才回 token pair。passkey 的選項來自 `POST /api/auth/mfa/passkey/options`。
//! - 免密碼：`POST /api/auth/passkey/options` → 瀏覽器（含 autofill）→ `POST /api/auth/passkey/login`。
//!
//! 管理（要登入）：`GET /api/auth/mfa`、TOTP setup/enable/disable、復原碼重產、passkey 註冊/改名/刪除。新增 / 移除因素與
//! 重產復原碼都要「再驗證」（`reauth`；帳號還沒有任何因素時免）。`DELETE /api/user/users/{id}/mfa`：管理員重設。
//!
//! 錯誤：`{error, code}`，code ∈ mfa_expired / mfa_invalid / mfa_locked / reauth_required / passkey_failed / passkey_unavailable。
//! 驗證失敗刻意回 400 而不是 401：前端 `apiFetch` 收到任何 401 都會登出，再驗證時輸錯碼不該把人踢出去。
//! Failed verifications are 400, not 401: the frontend logs out on any 401, and a mistyped re-auth code must not.
//! Two-factor endpoints: login second step, passwordless passkey login, factor management, re-authentication.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};
use webauthn_rs::prelude::{DiscoverableKey, Passkey, PublicKeyCredential, RegisterPublicKeyCredential, Uuid, Webauthn};

use super::sign_ins::{self, Attempt};
use super::AppJson;
use crate::api::auth::token_pair;
use crate::auth::AuthUser;
use crate::client_ip::ClientMeta;
use crate::db::{self, users::User};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::mfa::passkey::{credential_id_b64, relying_party, Ceremony, Purpose, MAX_NAME_CHARS};
use crate::mfa::{self, LoginChallenge};
use crate::state::AppState;
use crate::util::{db_to_iso, opt_db_to_iso};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(mfa_verify))
        .routes(routes!(mfa_passkey_options))
        .routes(routes!(passkey_login_options))
        .routes(routes!(passkey_login))
        .routes(routes!(status))
        .routes(routes!(reauth_options))
        .routes(routes!(totp_setup))
        .routes(routes!(totp_enable))
        .routes(routes!(totp_disable))
        .routes(routes!(recovery_regenerate))
        .routes(routes!(passkey_register_options))
        .routes(routes!(passkey_register))
        .routes(routes!(passkey_rename, passkey_delete))
        .routes(routes!(admin_reset))
}

fn mfa_error(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

fn rp(state: &AppState, headers: &HeaderMap) -> ApiResult<Webauthn> {
    let issuer = crate::oauth::issuer(state.config.public_url.as_deref(), headers);
    relying_party(&issuer).map_err(|e| mfa_error(StatusCode::BAD_REQUEST, "passkey_unavailable", e))
}

/// webauthn-rs 的選項物件 → `{challenge_id, publicKey, mediation?}`（前端把 publicKey 交給瀏覽器）。
fn options_json(challenge_id: String, options: &impl serde::Serialize) -> Value {
    let v = serde_json::to_value(options).unwrap_or(Value::Null);
    json!({ "challenge_id": challenge_id, "publicKey": v.get("publicKey").cloned().unwrap_or(Value::Null), "mediation": v.get("mediation").cloned().unwrap_or(Value::Null) })
}

// ---------------------------------------------------------------- factors

/// 使用者目前有哪些第二因素。/ The user's second factors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Factors {
    pub totp: bool,
    pub passkeys: usize,
}

impl Factors {
    pub fn any(&self) -> bool {
        self.totp || self.passkeys > 0
    }
    pub fn methods(&self) -> Vec<&'static str> {
        let mut m = Vec::new();
        if self.passkeys > 0 {
            m.push("passkey");
        }
        if self.totp {
            m.push("totp");
        }
        if self.any() {
            m.push("recovery_code");
        }
        m
    }
}

pub async fn factors(state: &AppState, user_id: i64) -> sqlx::Result<Factors> {
    let totp = db::mfa::get(&state.db, user_id).await?.map(|r| r.totp_enabled()).unwrap_or(false);
    let passkeys = db::mfa::passkeys_for_user(&state.db, user_id).await?.len();
    Ok(Factors { totp, passkeys })
}

/// 站台要求的因素（快取 ≤ 5 秒）。/ The site's required factors, cached for at most 5 s.
pub async fn requirement(state: &AppState) -> sqlx::Result<mfa::Requirement> {
    if let Some(r) = state.mfa.requirement.get(&()) {
        return Ok(r);
    }
    let s = db::settings::get_solo(&state.db).await?;
    let r = mfa::Requirement { totp: s.mfa_require_totp, passkey: s.mfa_require_passkey };
    state.mfa.requirement.insert((), r);
    Ok(r)
}

/// 管理員要求、但這位使用者還沒設定的因素；兩個開關都關時不查使用者的因素。
/// Required factors the user still lacks; the user's factors are only read when a switch is on.
pub async fn enrollment_missing(state: &AppState, user_id: i64) -> sqlx::Result<Vec<&'static str>> {
    let req = requirement(state).await?;
    if !req.any() {
        return Ok(Vec::new());
    }
    let f = factors(state, user_id).await?;
    Ok(mfa::missing_factors(req.totp, req.passkey, f.totp, f.passkeys))
}

/// 帳密 / Google 第一關通過後：沒有 2FA → token pair；有 → 登入挑戰。`first_factor` = password / google。
/// After the first factor (password / google): tokens, or a challenge when the account has 2FA.
pub async fn complete_login(state: &AppState, user: &User, first_factor: &'static str, meta: &ClientMeta) -> ApiResult<Value> {
    let f = factors(state, user.id).await?;
    if !f.any() {
        // 沒有第二步，這裡就是登入完成（有第二步時由 mfa_verify 記）。/ No second step: the login completes here.
        db::users::touch_last_login(&state.db, user.id).await?;
        sign_ins::record(state, user.id, meta, Attempt::ok(first_factor, None)).await;
        return token_pair(state, user.id, meta, first_factor, None).await;
    }
    let token = crate::oauth::random_token("");
    state.mfa.challenges.insert(token.clone(), LoginChallenge::new(user.id, first_factor));
    Ok(json!({ "mfa_required": true, "mfa_token": token, "methods": f.methods() }))
}

// ---------------------------------------------------------------- proofs

enum Proof<'a> {
    Totp(&'a str),
    Recovery(&'a str),
    Passkey { challenge_id: &'a str, credential: &'a Value },
}

fn parse_proof(v: &Value) -> Result<Proof<'_>, ApiError> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|x| !x.trim().is_empty());
    match s("method") {
        Some("totp") => s("code").map(Proof::Totp).ok_or_else(|| ApiError::field("code", "This field is required.")),
        Some("recovery_code") => s("code").map(Proof::Recovery).ok_or_else(|| ApiError::field("code", "This field is required.")),
        Some("passkey") => match (s("challenge_id"), v.get("credential").filter(|c| c.is_object())) {
            (Some(challenge_id), Some(credential)) => Ok(Proof::Passkey { challenge_id, credential }),
            _ => Err(ApiError::bad_request("challenge_id and credential are required for a passkey")),
        },
        _ => Err(ApiError::field("method", "Must be one of: totp, recovery_code, passkey.")),
    }
}

fn now_unix() -> u64 {
    chrono::Utc::now().timestamp().max(0) as u64
}

async fn verify_totp(state: &AppState, user_id: i64, code: &str) -> ApiResult<bool> {
    let Some(row) = db::mfa::get(&state.db, user_id).await?.filter(|r| r.totp_enabled()) else { return Ok(false) };
    let Some(secret) = row.totp_secret.as_deref().and_then(|s| state.mfa.secrets.open(s)) else {
        tracing::error!(user_id, "cannot decrypt the TOTP secret (was SECRET_KEY changed?)");
        return Ok(false);
    };
    match mfa::totp_verify(&secret, code, now_unix(), row.totp_last_step) {
        Some(step) => Ok(db::mfa::claim_totp_step(&state.db, user_id, step).await?),
        None => Ok(false),
    }
}

/// 驗一個 passkey 斷言並更新計數器。/ Verify a passkey assertion and update the counter.
async fn verify_assertion(state: &AppState, headers: &HeaderMap, user_id: i64, purpose: Purpose, challenge_id: &str, credential: &Value) -> ApiResult<bool> {
    let Some(Ceremony::Assert { user_id: owner, purpose: p, state: st }) = state.mfa.ceremonies.take(challenge_id) else { return Ok(false) };
    if owner != user_id || p != purpose {
        return Ok(false);
    }
    let Ok(cred) = serde_json::from_value::<PublicKeyCredential>(credential.clone()) else { return Ok(false) };
    let Ok(result) = rp(state, headers)?.finish_passkey_authentication(&cred, &st) else { return Ok(false) };
    let used = credential_id_b64(result.cred_id().as_ref());
    for row in db::mfa::passkeys_for_user(&state.db, user_id).await? {
        if row.credential_id == used {
            let mut pk: Passkey = match serde_json::from_str(&row.passkey) {
                Ok(p) => p,
                Err(_) => return Ok(false),
            };
            let updated = (pk.update_credential(&result) == Some(true)).then(|| serde_json::to_string(&pk).unwrap_or_default());
            db::mfa::passkey_used(&state.db, row.id, updated.as_deref()).await?;
            return Ok(true);
        }
    }
    Ok(false)
}

/// 驗證第二因素（含鎖定）：成功回方法名稱。/ Verify a second factor, honouring the per-user lockout.
async fn verify_proof(state: &AppState, headers: &HeaderMap, user_id: i64, proof: Proof<'_>, purpose: Purpose) -> ApiResult<&'static str> {
    if state.mfa.locked(user_id) {
        return Err(mfa_error(StatusCode::TOO_MANY_REQUESTS, "mfa_locked", "Too many failed attempts. Try again in 15 minutes."));
    }
    let (method, ok) = match proof {
        Proof::Totp(code) => ("totp", verify_totp(state, user_id, code).await?),
        Proof::Recovery(code) => ("recovery_code", db::mfa::recovery_consume(&state.db, user_id, &mfa::hash_recovery_code(code)).await?),
        Proof::Passkey { challenge_id, credential } => ("passkey", verify_assertion(state, headers, user_id, purpose, challenge_id, credential).await?),
    };
    if ok {
        state.mfa.clear_failures(user_id);
        Ok(method)
    } else {
        state.mfa.record_failure(user_id);
        Err(mfa_error(StatusCode::BAD_REQUEST, "mfa_invalid", "The code or passkey could not be verified."))
    }
}

/// 敏感操作前再驗證：帳號沒有任何第二因素時免；否則 `reauth` 必須是一個有效的證明。
/// Re-authentication for sensitive actions; skipped when the account has no second factor yet.
pub async fn require_reauth(state: &AppState, headers: &HeaderMap, user: &User, reauth: Option<&Value>) -> ApiResult<()> {
    let f = factors(state, user.id).await?;
    if !f.any() {
        return Ok(());
    }
    let Some(r) = reauth.filter(|v| v.is_object()) else {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            json!({ "error": "Confirm it's you with your passkey, authenticator code or a recovery code.", "code": "reauth_required", "methods": f.methods() }),
        ));
    };
    verify_proof(state, headers, user.id, parse_proof(r)?, Purpose::Reauth).await.map(|_| ())
}

fn new_recovery_codes() -> (Vec<String>, Vec<String>) {
    let codes: Vec<String> = (0..mfa::RECOVERY_CODES).map(|_| mfa::new_recovery_code()).collect();
    let hashes = codes.iter().map(|c| mfa::hash_recovery_code(c)).collect();
    (codes, hashes)
}

/// 第一個因素建立時一併產生復原碼；最後一個因素移除時清掉。/ Recovery codes follow the first / last factor.
async fn recovery_after_change(state: &AppState, user_id: i64, had_any: bool) -> ApiResult<Option<Vec<String>>> {
    let now_any = factors(state, user_id).await?.any();
    if now_any && !had_any {
        let (codes, hashes) = new_recovery_codes();
        db::mfa::recovery_replace(&state.db, user_id, &hashes).await?;
        return Ok(Some(codes));
    }
    if !now_any && had_any {
        db::mfa::recovery_replace(&state.db, user_id, &[]).await?;
    }
    Ok(None)
}

// ---------------------------------------------------------------- login (public)

#[utoipa::path(post, path = "/api/auth/mfa/verify", tag = "Two-Factor", request_body = super::schemas::MfaVerifyRequest, responses((status = 200, body = super::schemas::TokenPair), (status = 400, description = "Missing fields, mfa_invalid or mfa_expired (never 401: the web client logs out on any 401)", body = super::schemas::MfaError), (status = 429, description = "mfa_locked", body = super::schemas::MfaError)))]
async fn mfa_verify(State(state): State<AppState>, headers: HeaderMap, meta: ClientMeta, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let expired = || mfa_error(StatusCode::BAD_REQUEST, "mfa_expired", "The sign-in attempt expired. Log in again.");
    let token = body.get("mfa_token").and_then(Value::as_str).unwrap_or_default().to_string();
    let Some(ch) = state.mfa.challenges.get(&token) else { return Err(expired()) };
    if ch.exhausted() {
        state.mfa.challenges.invalidate(&token);
        return Err(expired());
    }
    let proof = parse_proof(&body)?;
    match verify_proof(&state, &headers, ch.user_id, proof, Purpose::Mfa).await {
        Ok(method) => {
            state.mfa.challenges.invalidate(&token);
            let user = db::users::by_id(&state.db, ch.user_id).await?.filter(|u| u.is_active).ok_or_else(expired)?;
            db::users::touch_last_login(&state.db, user.id).await?;
            sign_ins::record(&state, user.id, &meta, Attempt::ok(ch.first_factor, Some(method))).await;
            tracing::info!(username = %user.username, method, "[AUTH][2FA] Login success");
            Ok(Json(token_pair(&state, user.id, &meta, ch.first_factor, Some(method)).await?))
        }
        Err(e) => {
            let attempted = body.get("method").and_then(Value::as_str);
            sign_ins::record(&state, ch.user_id, &meta, Attempt::failed(ch.first_factor, attempted, "mfa_failed")).await;
            // 原地累加，不重新 insert（那會把挑戰的 5 分鐘重算）；用完次數就直接作廢。
            // Count in place (re-inserting would reset the TTL); drop the challenge once the attempts are used up.
            if ch.fail() >= mfa::CHALLENGE_ATTEMPTS {
                state.mfa.challenges.invalidate(&token);
            }
            Err(e)
        }
    }
}

#[utoipa::path(post, path = "/api/auth/mfa/passkey/options", tag = "Two-Factor", request_body = super::schemas::MfaTokenRequest, responses((status = 200, description = "WebAuthn request options for the user's passkeys", body = super::schemas::PasskeyOptions), (status = 400, description = "mfa_expired / passkey_unavailable", body = super::schemas::MfaError)))]
async fn mfa_passkey_options(State(state): State<AppState>, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let token = body.get("mfa_token").and_then(Value::as_str).unwrap_or_default();
    let ch = state.mfa.challenges.get(token).ok_or_else(|| mfa_error(StatusCode::BAD_REQUEST, "mfa_expired", "The sign-in attempt expired. Log in again."))?;
    assertion_options(&state, &headers, ch.user_id, Purpose::Mfa).await.map(Json)
}

async fn assertion_options(state: &AppState, headers: &HeaderMap, user_id: i64, purpose: Purpose) -> ApiResult<Value> {
    let passkeys: Vec<Passkey> = db::mfa::passkeys_for_user(&state.db, user_id).await?.iter().filter_map(|r| serde_json::from_str(&r.passkey).ok()).collect();
    if passkeys.is_empty() {
        return Err(mfa_error(StatusCode::BAD_REQUEST, "passkey_unavailable", "No passkey is registered for this account."));
    }
    let (rcr, st) = rp(state, headers)?
        .start_passkey_authentication(&passkeys)
        .map_err(|e| mfa_error(StatusCode::BAD_REQUEST, "passkey_unavailable", e.to_string()))?;
    let id = state.mfa.ceremonies.start(Ceremony::Assert { user_id, purpose, state: st });
    Ok(options_json(id, &rcr))
}

#[utoipa::path(post, path = "/api/auth/passkey/options", tag = "Two-Factor", responses((status = 200, description = "WebAuthn options for a usernameless (discoverable) sign-in; mediation is `conditional` (autofill) but a modal prompt works too", body = super::schemas::PasskeyOptions), (status = 400, body = super::schemas::MfaError)))]
async fn passkey_login_options(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let (rcr, st) = rp(&state, &headers)?.start_discoverable_authentication().map_err(|e| mfa_error(StatusCode::BAD_REQUEST, "passkey_unavailable", e.to_string()))?;
    let id = state.mfa.ceremonies.start(Ceremony::Login(st));
    Ok(Json(options_json(id, &rcr)))
}

#[utoipa::path(post, path = "/api/auth/passkey/login", tag = "Two-Factor", request_body = super::schemas::PasskeyCredentialRequest, responses((status = 200, description = "Signed in (a passkey is two factors on its own)", body = super::schemas::TokenPair), (status = 400, description = "passkey_failed", body = super::schemas::MfaError)))]
async fn passkey_login(State(state): State<AppState>, headers: HeaderMap, meta: ClientMeta, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let failed = || mfa_error(StatusCode::BAD_REQUEST, "passkey_failed", "Passkey sign-in failed.");
    let challenge_id = body.get("challenge_id").and_then(Value::as_str).unwrap_or_default();
    let Some(Ceremony::Login(st)) = state.mfa.ceremonies.take(challenge_id) else { return Err(failed()) };
    let cred: PublicKeyCredential = serde_json::from_value(body.get("credential").cloned().unwrap_or(Value::Null)).map_err(|_| failed())?;
    let rp = rp(&state, &headers)?;
    let (handle, _) = rp.identify_discoverable_authentication(&cred).map_err(|_| failed())?;
    let row = db::mfa::by_webauthn_user_id(&state.db, &handle.to_string()).await?.ok_or_else(failed)?;
    let rows = db::mfa::passkeys_for_user(&state.db, row.user_id).await?;
    let keys: Vec<(i64, Passkey)> = rows.iter().filter_map(|r| serde_json::from_str(&r.passkey).ok().map(|p| (r.id, p))).collect();
    let discoverable: Vec<DiscoverableKey> = keys.iter().map(|(_, p)| DiscoverableKey::from(p)).collect();
    let result = rp.finish_discoverable_authentication(&cred, st, &discoverable).map_err(|_| failed())?;
    let used = credential_id_b64(result.cred_id().as_ref());
    if let Some((id, mut pk)) = keys.into_iter().find(|(_, p)| credential_id_b64(p.cred_id().as_ref()) == used) {
        let updated = (pk.update_credential(&result) == Some(true)).then(|| serde_json::to_string(&pk).unwrap_or_default());
        db::mfa::passkey_used(&state.db, id, updated.as_deref()).await?;
    }
    let user = db::users::by_id(&state.db, row.user_id).await?.filter(|u| u.is_active).ok_or_else(failed)?;
    db::users::touch_last_login(&state.db, user.id).await?;
    sign_ins::record(&state, user.id, &meta, Attempt::ok("passkey", None)).await;
    tracing::info!(username = %user.username, "[AUTH][PASSKEY] Login success");
    Ok(Json(token_pair(&state, user.id, &meta, "passkey", None).await?))
}

// ---------------------------------------------------------------- management (logged in)

#[utoipa::path(get, path = "/api/auth/mfa", tag = "Two-Factor", security(("bearer" = [])), responses((status = 200, body = super::schemas::MfaStatus)))]
async fn status(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let tz = state.config.tz_offset_minutes;
    let row = db::mfa::get(&state.db, user.id).await?;
    let passkeys = db::mfa::passkeys_for_user(&state.db, user.id).await?;
    let f = Factors { totp: row.as_ref().map(|r| r.totp_enabled()).unwrap_or(false), passkeys: passkeys.len() };
    Ok(Json(json!({
        "mfa_enabled": f.any(),
        "methods": f.methods(),
        "totp_enabled": f.totp,
        "totp_enabled_at": row.as_ref().map(|r| opt_db_to_iso(&r.totp_enabled_at, tz)).unwrap_or(Value::Null),
        "passkeys": passkeys.iter().map(|p| passkey_json(p, tz)).collect::<Vec<_>>(),
        "recovery_codes_remaining": db::mfa::recovery_remaining(&state.db, user.id).await?,
    })))
}

fn passkey_json(p: &db::mfa::PasskeyRow, tz: i32) -> Value {
    json!({ "id": p.id, "name": p.name, "created_at": db_to_iso(&p.created_at, tz), "last_used_at": opt_db_to_iso(&p.last_used_at, tz) })
}

#[utoipa::path(post, path = "/api/auth/mfa/reauth/options", tag = "Two-Factor", security(("bearer" = [])), responses((status = 200, description = "WebAuthn options to re-authenticate with one of your passkeys", body = super::schemas::PasskeyOptions), (status = 400, body = super::schemas::MfaError)))]
async fn reauth_options(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    assertion_options(&state, &headers, user.id, Purpose::Reauth).await.map(Json)
}

#[utoipa::path(post, path = "/api/auth/mfa/totp/setup", tag = "Two-Factor", security(("bearer" = [])), request_body = super::schemas::ReauthRequest, responses((status = 200, description = "A new secret to scan; confirm it with /api/auth/mfa/totp/enable", body = super::schemas::TotpSetup), (status = 400, body = super::schemas::ErrorBody), (status = 403, description = "reauth_required", body = super::schemas::MfaError)))]
async fn totp_setup(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    if db::mfa::get(&state.db, user.id).await?.is_some_and(|r| r.totp_enabled()) {
        return Err(ApiError::bad_request("Authenticator app sign-in is already enabled. Turn it off first to set up a new one."));
    }
    require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    db::mfa::ensure(&state.db, user.id).await?;
    let secret = mfa::new_totp_secret();
    db::mfa::set_pending_totp(&state.db, user.id, &state.mfa.secrets.seal(&secret)).await?;
    let issuer = crate::oauth::issuer(state.config.public_url.as_deref(), &headers);
    let host = url::Url::parse(&issuer).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let b32 = mfa::base32_encode(&secret);
    let uri = mfa::otpauth_uri("Telepy", &format!("{}@{host}", user.username), &b32);
    Ok(Json(json!({ "secret": b32, "otpauth_uri": uri, "qr_svg": mfa::qr_svg(&uri) })))
}

#[utoipa::path(post, path = "/api/auth/mfa/totp/enable", tag = "Two-Factor", security(("bearer" = [])), request_body = super::schemas::TotpEnableRequest, responses((status = 200, description = "Enabled; recovery_codes is set when this is the account's first second factor (shown once)", body = super::schemas::RecoveryCodes), (status = 400, body = super::schemas::MfaError)))]
async fn totp_enable(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let code = body.get("code").and_then(Value::as_str).unwrap_or_default();
    let row = db::mfa::get(&state.db, user.id).await?;
    let Some(pending) = row.as_ref().and_then(|r| r.totp_pending_secret.as_deref()).and_then(|s| state.mfa.secrets.open(s)) else {
        return Err(ApiError::bad_request("Start the setup first."));
    };
    if state.mfa.locked(user.id) {
        return Err(mfa_error(StatusCode::TOO_MANY_REQUESTS, "mfa_locked", "Too many failed attempts. Try again in 15 minutes."));
    }
    let Some(step) = mfa::totp_verify(&pending, code, now_unix(), None) else {
        state.mfa.record_failure(user.id);
        return Err(mfa_error(StatusCode::BAD_REQUEST, "mfa_invalid", "That code is not valid. Check the time on your phone and try the next code."));
    };
    state.mfa.clear_failures(user.id);
    let had_any = factors(&state, user.id).await?.any();
    db::mfa::enable_totp(&state.db, user.id, step).await?;
    let codes = recovery_after_change(&state, user.id, had_any).await?;
    tracing::info!(username = %user.username, "[AUTH][2FA] TOTP enabled");
    Ok(Json(json!({ "totp_enabled": true, "recovery_codes": codes })))
}

#[utoipa::path(delete, path = "/api/auth/mfa/totp", tag = "Two-Factor", security(("bearer" = [])), request_body = super::schemas::ReauthRequest, responses((status = 204, description = "Disabled"), (status = 403, description = "reauth_required", body = super::schemas::MfaError)))]
async fn totp_disable(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<StatusCode> {
    if !db::mfa::get(&state.db, user.id).await?.is_some_and(|r| r.totp_enabled() || r.totp_pending_secret.is_some()) {
        return Err(ApiError::bad_request("Authenticator app sign-in is not enabled."));
    }
    require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    let had_any = factors(&state, user.id).await?.any();
    db::mfa::disable_totp(&state.db, user.id).await?;
    recovery_after_change(&state, user.id, had_any).await?;
    tracing::info!(username = %user.username, "[AUTH][2FA] TOTP disabled");
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/auth/mfa/recovery-codes", tag = "Two-Factor", security(("bearer" = [])), request_body = super::schemas::ReauthRequest, responses((status = 200, description = "A new set (the old codes stop working); shown once", body = super::schemas::RecoveryCodes), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::MfaError)))]
async fn recovery_regenerate(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    if !factors(&state, user.id).await?.any() {
        return Err(ApiError::bad_request("Set up a passkey or an authenticator app first."));
    }
    require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    let (codes, hashes) = new_recovery_codes();
    db::mfa::recovery_replace(&state.db, user.id, &hashes).await?;
    Ok(Json(json!({ "recovery_codes": codes })))
}

#[utoipa::path(post, path = "/api/auth/passkeys/register/options", tag = "Two-Factor", security(("bearer" = [])), request_body = super::schemas::ReauthRequest, responses((status = 200, description = "WebAuthn creation options", body = super::schemas::PasskeyOptions), (status = 400, body = super::schemas::MfaError), (status = 403, body = super::schemas::MfaError)))]
async fn passkey_register_options(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let rp = rp(&state, &headers)?;
    require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    let row = db::mfa::ensure(&state.db, user.id).await?;
    let handle = Uuid::parse_str(&row.webauthn_user_id).map_err(|e| ApiError::internal(e.to_string()))?;
    let existing: Vec<_> = db::mfa::passkeys_for_user(&state.db, user.id)
        .await?
        .iter()
        .filter_map(|r| serde_json::from_str::<Passkey>(&r.passkey).ok())
        .map(|p| p.cred_id().clone())
        .collect();
    let display = format!("{} {}", user.first_name, user.last_name).trim().to_string();
    let display = if display.is_empty() { user.username.clone() } else { display };
    let (ccr, st) = rp
        .start_passkey_registration(handle, &user.username, &display, Some(existing))
        .map_err(|e| mfa_error(StatusCode::BAD_REQUEST, "passkey_unavailable", e.to_string()))?;
    let id = state.mfa.ceremonies.start(Ceremony::Register { user_id: user.id, state: st });
    Ok(Json(options_json(id, &ccr)))
}

#[utoipa::path(post, path = "/api/auth/passkeys/register", tag = "Two-Factor", security(("bearer" = [])), request_body = super::schemas::PasskeyRegisterRequest, responses((status = 201, description = "Registered; recovery_codes is set when this is the account's first second factor", body = super::schemas::PasskeyRegistered), (status = 400, body = super::schemas::MfaError)))]
async fn passkey_register(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let failed = |msg: &str| mfa_error(StatusCode::BAD_REQUEST, "passkey_failed", msg);
    let challenge_id = body.get("challenge_id").and_then(Value::as_str).unwrap_or_default();
    let st = match state.mfa.ceremonies.take(challenge_id) {
        Some(Ceremony::Register { user_id, state: st }) if user_id == user.id => st,
        _ => return Err(failed("The registration expired. Start again.")),
    };
    let cred: RegisterPublicKeyCredential = serde_json::from_value(body.get("credential").cloned().unwrap_or(Value::Null)).map_err(|_| failed("Malformed credential."))?;
    let pk = rp(&state, &headers)?.finish_passkey_registration(&cred, &st).map_err(|e| failed(&format!("The passkey could not be verified: {e}")))?;
    let count = db::mfa::passkeys_for_user(&state.db, user.id).await?.len();
    let name: String = body
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Passkey {}", count + 1))
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    let had_any = factors(&state, user.id).await?.any();
    let json_pk = serde_json::to_string(&pk).map_err(|e| ApiError::internal(e.to_string()))?;
    let row = db::mfa::passkey_create(&state.db, user.id, &name, &credential_id_b64(pk.cred_id().as_ref()), &json_pk).await.map_err(|e| {
        if is_unique_violation(&e) {
            failed("This passkey is already registered.")
        } else {
            ApiError::from(e)
        }
    })?;
    let codes = recovery_after_change(&state, user.id, had_any).await?;
    tracing::info!(username = %user.username, name = %row.name, "[AUTH][PASSKEY] Registered");
    Ok((StatusCode::CREATED, Json(json!({ "passkey": passkey_json(&row, state.config.tz_offset_minutes), "recovery_codes": codes }))))
}

async fn own_passkey(state: &AppState, user: &User, id: i64) -> ApiResult<db::mfa::PasskeyRow> {
    db::mfa::passkey_by_id(&state.db, id).await?.filter(|p| p.user_id == user.id).ok_or_else(ApiError::drf_not_found)
}

#[utoipa::path(patch, path = "/api/auth/passkeys/{id}", tag = "Two-Factor", security(("bearer" = [])), params(("id" = i64, Path)), request_body = super::schemas::PasskeyRename, responses((status = 200, body = super::schemas::PasskeyInfo), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn passkey_rename(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let row = own_passkey(&state, &user, id).await?;
    let name: String = body.get("name").and_then(Value::as_str).map(str::trim).unwrap_or_default().chars().take(MAX_NAME_CHARS).collect();
    if name.is_empty() {
        return Err(ApiError::field("name", "This field may not be blank."));
    }
    db::mfa::passkey_rename(&state.db, row.id, &name).await?;
    let row = own_passkey(&state, &user, id).await?;
    Ok(Json(passkey_json(&row, state.config.tz_offset_minutes)))
}

#[utoipa::path(delete, path = "/api/auth/passkeys/{id}", tag = "Two-Factor", security(("bearer" = [])), params(("id" = i64, Path)), request_body = super::schemas::ReauthRequest, responses((status = 204, description = "Removed"), (status = 403, description = "reauth_required", body = super::schemas::MfaError), (status = 404, body = super::schemas::ErrorBody)))]
async fn passkey_delete(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<StatusCode> {
    let row = own_passkey(&state, &user, id).await?;
    require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    let had_any = factors(&state, user.id).await?.any();
    db::mfa::passkey_delete(&state.db, row.id).await?;
    recovery_after_change(&state, user.id, had_any).await?;
    tracing::info!(username = %user.username, name = %row.name, "[AUTH][PASSKEY] Removed");
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/api/user/users/{id}/mfa", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path, description = "User id")), responses((status = 204, description = "Every second factor of the user removed (passkeys, authenticator app, recovery codes)"), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn admin_reset(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can manage users."));
    }
    let target = db::users::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("User not found."))?;
    db::mfa::reset(&state.db, target.id).await?;
    state.mfa.clear_failures(target.id);
    tracing::warn!(admin = %me.username, user = %target.username, "[AUTH][2FA] Second factors reset by an administrator");
    Ok(StatusCode::NO_CONTENT)
}
