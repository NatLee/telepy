//! 網頁登入 session：token pair 的發放、續期（refresh token 換發 + 滑動效期）與登出撤銷。效期來自網站設定：
//! `signin_lifetime` = 整個登入（沒有任何造訪多久後要重新登入；每次續期都往後推）、`signin_access_lifetime` =
//! access token 多久換一次。refresh token 一次性：換發後舊的只在 `ROTATION_GRACE` 內還能用（兩個分頁同時續期、
//! 或回應在路上遺失），而且拿回的是同一顆新 token；超過寬限再用 = 有人拿到了舊 token → 整個 session 撤銷。
//! Web sign-in sessions: issuing the token pair, renewal (refresh-token rotation with a sliding expiry) and
//! logout. Lifetimes come from the site settings `signin_lifetime` (the whole sign-in, sliding) and
//! `signin_access_lifetime` (how often the access token is renewed). Refresh tokens are single use: after a
//! rotation the old one works only within `ROTATION_GRACE` (concurrent tabs, a lost response) and yields the
//! same new token; a later reuse means someone else holds it, so the whole session is revoked.

use std::time::Duration;

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::auth::TokenType;
use crate::client_ip::ClientMeta;
use crate::db::{self, web_sessions::{self, SignInMethod, WebSession}};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{db_time, parse_db_datetime, uuid_hex};

/// 換發後舊 refresh token 還能用多久（同時續期的分頁、遺失的回應）。/ How long a replaced refresh token still works.
pub const ROTATION_GRACE: Duration = Duration::from_secs(60);
/// `signin_lifetime` 的值域（秒）：5 分鐘到 365 天。/ Range of `signin_lifetime` in seconds: 5 minutes to 365 days.
pub const SIGNIN_LIFETIME_RANGE: std::ops::RangeInclusive<i64> = 300..=31_536_000;
/// `signin_access_lifetime` 的值域（秒）：1 分鐘到 24 小時。/ Range of `signin_access_lifetime`: 1 minute to 24 hours.
pub const ACCESS_LIFETIME_RANGE: std::ops::RangeInclusive<i64> = 60..=86_400;

#[derive(Debug, Clone, Copy)]
pub struct Lifetimes {
    pub signin: Duration,
    pub access: Duration,
}

/// 目前設定的效期（超出值域的值夾回範圍內）。/ The configured lifetimes (clamped into their ranges).
pub async fn lifetimes(state: &AppState) -> ApiResult<Lifetimes> {
    let s = db::settings::get_solo(&state.db).await?;
    Ok(Lifetimes {
        signin: Duration::from_secs(s.signin_lifetime.clamp(*SIGNIN_LIFETIME_RANGE.start(), *SIGNIN_LIFETIME_RANGE.end()) as u64),
        access: Duration::from_secs(s.signin_access_lifetime.clamp(*ACCESS_LIFETIME_RANGE.start(), *ACCESS_LIFETIME_RANGE.end()) as u64),
    })
}

/// simplejwt 的 401。/ simplejwt's 401 body.
pub fn token_not_valid() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, json!({ "detail": "Token is invalid or expired", "code": "token_not_valid" }))
}

/// 被登出的 session 的 401：形狀同 simplejwt，多帶 `signed_out` = 撤銷原因（user = 你從別的裝置登出它、
/// admin = 管理員、logout、reuse），讓網頁說清楚為什麼回到登入頁。
/// The 401 of a revoked session: simplejwt's shape plus `signed_out` = the reason, so the web can say why.
pub fn signed_out(reason: &str) -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, json!({ "detail": "Token is invalid or expired", "code": "token_not_valid", "signed_out": reason }))
}

/// 撤銷狀態快取多久（其他 process 沒有；同一個 process 的撤銷會直接寫進快取，立刻生效）。
/// How long a session's revocation state is cached (a revocation in this process updates the cache at once).
pub const REVOKED_CACHE_TTL: Duration = Duration::from_secs(5);
/// REST 請求最多多久記一次「最後使用」。/ How often a REST request may record the session's last use.
pub const TOUCH_EVERY: Duration = Duration::from_secs(300);

/// 登入 session 的記憶體狀態：撤銷快取（access token 每個請求都要查）、「最後使用」的寫入節流。
/// In-memory session state: the revocation cache (checked on every access token) and the last-use write throttle.
pub struct SessionGuard {
    /// sid → `Some(reason)` 已撤銷 / `None` 還有效。/ sid → `Some(reason)` revoked, `None` live.
    revoked: moka::sync::Cache<i64, Option<String>>,
    touched: moka::sync::Cache<i64, ()>,
}

impl Default for SessionGuard {
    fn default() -> Self {
        Self {
            revoked: moka::sync::Cache::builder().time_to_live(REVOKED_CACHE_TTL).max_capacity(100_000).build(),
            touched: moka::sync::Cache::builder().time_to_live(TOUCH_EVERY).max_capacity(100_000).build(),
        }
    }
}

impl SessionGuard {
    /// 快取裡已知撤銷了（WebSocket 訂閱後的二次確認用，不讀 DB）。/ Known revoked from the cache (no DB read).
    pub fn known_revoked(&self, sid: i64) -> Option<String> {
        self.revoked.get(&sid).flatten()
    }
}

/// access token 的 `sid` 還有效嗎？撤銷了回 `Some(原因)`。到期的 session 也算結束（`expired`）。快取 ≤ 5 秒。
/// Is the access token's session still live? `Some(reason)` when revoked (or `expired`). Cached ≤ 5 s.
pub async fn ended(state: &AppState, sid: i64) -> ApiResult<Option<String>> {
    if let Some(v) = state.sessions.revoked.get(&sid) {
        return Ok(v);
    }
    let v = match web_sessions::by_id(&state.db, sid).await? {
        None => Some("revoked".to_string()),
        Some(s) => s.revoked_at.as_ref().map(|_| s.revoked_reason.clone().unwrap_or_else(|| "revoked".into())).or_else(|| {
            let expired = parse_utc(&s.expires_at).map(|t| t <= Utc::now()).unwrap_or(false);
            expired.then(|| "expired".to_string())
        }),
    };
    state.sessions.revoked.insert(sid, v.clone());
    Ok(v)
}

/// REST 請求用到了這個 session：最多每 `TOUCH_EVERY` 寫一次 `last_used_at`（背景，不擋請求）。
/// A REST request used this session: write `last_used_at` at most every `TOUCH_EVERY` (in the background).
pub fn note_use(state: &AppState, sid: i64, ip: Option<String>) {
    if state.sessions.touched.contains_key(&sid) {
        return;
    }
    state.sessions.touched.insert(sid, ());
    let db = state.db.clone();
    tokio::spawn(async move {
        if let Err(e) = web_sessions::touch(&db, sid, ip.as_deref()).await {
            tracing::debug!(sid, error = %e, "cannot record session use");
        }
    });
}

/// 撤銷之後的共同收尾：快取立刻記上（這個 process 的 access token 馬上失效）、通知開著的 WebSocket（4010）。
/// After a revocation: mark the cache (access tokens stop at once in this process) and close open sockets (4010).
pub fn revoked(state: &AppState, sid: i64, reason: &str) {
    state.sessions.revoked.insert(sid, Some(reason.to_string()));
    state.sessions.touched.invalidate(&sid);
    state.hub.session_ended(sid, reason);
}

/// 撤銷一個 session（DB + 快取 + 開著的頁面）。回傳是否真的撤銷了（已撤銷的回 false）。
/// Revoke one session (DB, cache, open pages). False when it was already revoked.
pub async fn revoke_sid(state: &AppState, sid: i64, reason: &str) -> ApiResult<bool> {
    let done = web_sessions::revoke(&state.db, sid, reason).await?;
    if done {
        revoked(state, sid, reason);
    }
    Ok(done)
}

/// 撤銷使用者其他所有 session（`except` 除外），回傳撤銷了幾個。/ Revoke a user's other sessions; returns how many.
pub async fn revoke_all(state: &AppState, user_id: i64, except: Option<i64>, reason: &str) -> ApiResult<usize> {
    let ids = web_sessions::revoke_for_user(&state.db, user_id, except, reason).await?;
    for sid in &ids {
        revoked(state, *sid, reason);
    }
    Ok(ids.len())
}

fn pair(state: &AppState, user_id: i64, sid: i64, jti: &str, iat: i64, exp: i64, access: Duration) -> Value {
    json!({
        "refresh_token": state.jwt.refresh(user_id, sid, jti, iat, exp),
        "access_token": state.jwt.access_in(user_id, Some(sid), access),
    })
}

async fn start(state: &AppState, user_id: i64, meta: &ClientMeta, how: SignInMethod<'_>, lt: Lifetimes, now: DateTime<Utc>) -> ApiResult<Value> {
    let jti = uuid_hex();
    let expires = now + chrono::Duration::seconds(lt.signin.as_secs() as i64);
    let sid = web_sessions::create(&state.db, user_id, &jti, &db_time(expires), meta.ip.as_deref(), meta.user_agent.as_deref(), how).await?;
    Ok(pair(state, user_id, sid, &jti, now.timestamp(), expires.timestamp(), lt.access))
}

/// 登入完成：開一個 session、回 `{refresh_token, access_token}`。`method` / `second_factor` 記在 session 上
/// （「你的裝置」清單顯示）。/ Login done: start a session and return the pair; the sign-in method is stored on it.
pub async fn issue(state: &AppState, user_id: i64, meta: &ClientMeta, method: &str, second_factor: Option<&str>) -> ApiResult<Value> {
    let lt = lifetimes(state).await?;
    start(state, user_id, meta, SignInMethod { method: Some(method), second_factor }, lt, Utc::now()).await
}

fn parse_utc(s: &str) -> Option<DateTime<Utc>> {
    parse_db_datetime(s).map(|t| t.and_utc())
}

/// 寬限：拿的是上一顆、而且換發不到 `ROTATION_GRACE` → 再給一次目前這顆（同 jti / iat / exp，所以 token 一模一樣）。
/// Grace: the previous token within `ROTATION_GRACE` of the rotation gets the current one again (identical token).
fn grace_reissue(state: &AppState, session: &WebSession, presented_jti: &str, now: DateTime<Utc>, access: Duration) -> Option<Value> {
    if session.prev_jti.as_deref() != Some(presented_jti) {
        return None;
    }
    let rotated = parse_utc(&session.rotated_at)?;
    if (now - rotated).to_std().map(|d| d <= ROTATION_GRACE).unwrap_or(true) {
        let exp = parse_utc(&session.expires_at)?.timestamp();
        return Some(pair(state, session.user_id, session.id, &session.jti, rotated.timestamp(), exp, access));
    }
    None
}

/// 續期：驗 refresh token → 使用者還在且啟用 → session 沒撤銷、沒到期 → 換發（到期往後推）。
/// 升級前的 token（沒有 `sid`）補開一個 session。拿已換掉的 token 來：寬限內給同一顆新 token，否則撤銷整個 session。
/// Renewal: verify the refresh token → the account exists and is active → the session is live → rotate
/// (sliding expiry). Pre-upgrade tokens (no `sid`) get a session. A replaced token: the same new token within
/// the grace, otherwise the whole session is revoked.
pub async fn refresh(state: &AppState, token: &str, meta: &ClientMeta) -> ApiResult<Value> {
    let claims = state.jwt.verify(token, TokenType::Refresh).map_err(|_| token_not_valid())?;
    let user = db::users::by_id(&state.db, claims.user_id).await?.filter(|u| u.is_active).ok_or_else(token_not_valid)?;
    let lt = lifetimes(state).await?;
    let now = Utc::now();
    let Some(sid) = claims.sid else {
        return start(state, user.id, meta, SignInMethod::default(), lt, now).await;
    };
    let live = |s: &WebSession| s.user_id == user.id && s.revoked_at.is_none() && parse_utc(&s.expires_at).map(|t| t > now).unwrap_or(false);
    let session = match web_sessions::by_id(&state.db, sid).await? {
        Some(s) if live(&s) => s,
        // 被使用者 / 管理員登出的：說是誰，網頁好解釋。/ Signed out by the user or an admin: say so, for the web.
        Some(s) if s.user_id == user.id && matches!(s.revoked_reason.as_deref(), Some("user" | "admin")) => {
            return Err(signed_out(s.revoked_reason.as_deref().unwrap_or("user")));
        }
        _ => return Err(token_not_valid()),
    };
    if claims.jti == session.jti {
        let jti = uuid_hex();
        let expires = now + chrono::Duration::seconds(lt.signin.as_secs() as i64);
        if web_sessions::rotate(&state.db, sid, &session.jti, &jti, &db_time(expires), meta.ip.as_deref(), meta.user_agent.as_deref()).await? {
            return Ok(pair(state, user.id, sid, &jti, now.timestamp(), expires.timestamp(), lt.access));
        }
        // 讀到寫之間被另一個請求換掉了（同時續期的分頁）：重讀，走寬限。/ Rotated by a concurrent request: re-read, grace applies.
        let session = web_sessions::by_id(&state.db, sid).await?.filter(live).ok_or_else(token_not_valid)?;
        return grace_reissue(state, &session, &claims.jti, now, lt.access).ok_or_else(token_not_valid);
    }
    if let Some(v) = grace_reissue(state, &session, &claims.jti, now, lt.access) {
        return Ok(v);
    }
    // 換掉超過寬限的 token 又被拿來用：不是遺失的回應，是另一個持有者 → 整個登入撤銷，兩邊都得重新登入。
    // A long-replaced token presented again: not a lost response but another holder; revoke the sign-in for both.
    revoke_sid(state, sid, "reuse").await?;
    tracing::warn!(user = %user.username, session = sid, ip = ?meta.ip, "refresh token reused after rotation; sign-in revoked");
    Err(token_not_valid())
}

/// 登出：撤銷這顆 refresh token 的 session。無效 / 過期 / 升級前的 token 沒東西可撤，回 `false`。
/// Logout: revoke the refresh token's session. Invalid, expired or pre-upgrade tokens have nothing to revoke.
pub async fn revoke(state: &AppState, token: &str) -> ApiResult<bool> {
    let Ok(claims) = state.jwt.verify(token, TokenType::Refresh) else { return Ok(false) };
    let Some(sid) = claims.sid else { return Ok(false) };
    match web_sessions::by_id(&state.db, sid).await? {
        Some(s) if s.user_id == claims.user_id => revoke_sid(state, sid, "logout").await,
        _ => Ok(false),
    }
}
