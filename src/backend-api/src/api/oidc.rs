//! OIDC 單一登入的路由（協定本身在 `crate::oidc`）。
//!
//! 公開：`GET /api/auth/oidc/{slug}/start`（整頁導向身分提供者，設綁定 cookie）、`GET …/{slug}/callback`（換 code、
//! 驗 id_token、找 / 建帳號，然後帶一次性票券回 `/login?sso=…`）、`POST /api/auth/oidc/redeem`（同一個瀏覽器兌換票券，
//! 拿到跟密碼登入一樣的 JSON：token 或 2FA 挑戰）。
//! 已登入：`GET /api/auth/oidc/links`、`POST/DELETE /api/auth/oidc/links/{id}`（連結 / 解除；都要「確認是你」，最後一個
//! 登入方式不能拿掉）。管理員：`/api/site/oidc*`（新增 / 修改 / 刪除、discovery 檢查、試登入看 claim）。
//!
//! 錯誤時整頁導回 `/login?sso_error=<code>`（登入）或 `/tunnels/sso?error=<code>`（連結 / 試登入），code 由前端翻譯。
//!
//! OIDC sign-in routes (the protocol is in `crate::oidc`). Public: start (redirects to the provider, sets the binding
//! cookie), callback (exchange, verify, find / create the account, back to `/login?sso=<ticket>`) and redeem (the same
//! browser trades the ticket for the password sign-in's JSON). Signed in: links (link / unlink, both with a
//! confirmation; the last way in can't go). Admins: `/api/site/oidc*`. Failures navigate back with a code the
//! frontend translates.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{AppendHeaders, IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::sign_ins::{self, Attempt};
use super::{body_object, AppJson};
use crate::auth::password::unusable_password;
use crate::auth::AuthUser;
use crate::client_ip::ClientMeta;
use crate::db::oidc::{NewProvider, Provider};
use crate::db::users::{NewUser, User};
use crate::db::{self};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::oidc::flow::{self, Outcome, Pending, Purpose};
use crate::oidc::roles::{self, Current, Rule, SyncPlan, Target};
use crate::oidc::{self as proto, AuthRequest, Claims, UsernameFrom};
use crate::state::AppState;
use crate::util::json_str;

/// 綁定 cookie 只送回這條路徑底下。/ Binding cookies only travel under this path.
const COOKIE_PATH: &str = "/api/auth/oidc";

/// 不能當代號的字（會跟其他路由撞）。/ Slugs that would collide with other routes.
const RESERVED_SLUGS: &[&str] = &["links", "redeem", "test-result"];

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(start))
        .routes(routes!(callback))
        .routes(routes!(redeem))
        .routes(routes!(test_result))
        .routes(routes!(links))
        .routes(routes!(link_start, unlink))
        .routes(routes!(admin_list, admin_create))
        .routes(routes!(admin_update, admin_delete))
        .routes(routes!(admin_discover))
        .routes(routes!(admin_test))
        .routes(routes!(scim_token_create, scim_token_delete))
}

// ---------------------------------------------------------------- helpers

fn base(state: &AppState, headers: &HeaderMap) -> String {
    crate::oauth::issuer(state.config.public_base().as_deref(), headers)
}

fn callback_url(base: &str, slug: &str) -> String {
    format!("{base}/api/auth/oidc/{slug}/callback")
}

fn cookie(name: &str, value: &str, secure: bool, max_age: u64) -> String {
    format!("{name}={value}; Path={COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age={max_age}{}", if secure { "; Secure" } else { "" })
}

fn clear_cookie(name: &str, secure: bool) -> String {
    cookie(name, "", secure, 0)
}

fn cookie_header(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::COOKIE).and_then(|v| v.to_str().ok())
}

fn secret_aad(id: i64) -> String {
    format!("telepy-oidc-provider:{id}")
}

fn open_secret(state: &AppState, p: &Provider) -> Option<String> {
    if p.client_secret.is_empty() {
        return None;
    }
    let plain = state.vault.open(&secret_aad(p.id), &p.client_secret);
    if plain.is_none() {
        tracing::error!(provider = p.slug, "[OIDC] cannot open the client secret (was SECRET_KEY changed?)");
    }
    plain.and_then(|b| String::from_utf8(b).ok())
}

fn found(location: String, cookies: Vec<String>) -> Response {
    let mut headers = vec![(header::LOCATION, location), (header::CACHE_CONTROL, "no-store".to_string())];
    headers.extend(cookies.into_iter().map(|c| (header::SET_COOKIE, c)));
    (StatusCode::FOUND, AppendHeaders(headers)).into_response()
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// 失敗時要回哪一頁。/ Where a failure goes back to.
fn fail_url(purpose: Option<&Purpose>, code: &str, slug: &str) -> String {
    match purpose {
        Some(Purpose::Link { .. }) | Some(Purpose::Test { .. }) => format!("/tunnels/sso?error={code}&provider={}", enc(slug)),
        _ => format!("/login?sso_error={code}&sso_provider={}", enc(slug)),
    }
}

fn sso_error(status: StatusCode, code: &str, msg: &str) -> ApiError {
    ApiError::new(status, json!({ "error": msg, "code": code }))
}

fn admin_only(me: &User) -> ApiResult<()> {
    if me.is_superuser {
        Ok(())
    } else {
        Err(sso_error(StatusCode::FORBIDDEN, "admin_only", "Only administrators can manage single sign-on."))
    }
}

/// 這個身分提供者限定的網域：清單不空時一定要有 email 而且網域在清單裡。/ The provider's domain allow-list.
fn domain_problem(p: &Provider, claims: &Claims) -> Option<&'static str> {
    let allowed = proto::parse_domains(&p.allowed_domains);
    if allowed.is_empty() {
        return None;
    }
    match claims.email.as_deref().and_then(proto::email_domain) {
        None => Some("sso_no_email"),
        Some(d) if !allowed.contains(&d) => Some("sso_domain_not_allowed"),
        Some(_) => None,
    }
}

/// 這次登入會落到哪個帳號。/ Which account a sign-in lands in.
enum Plan {
    /// 已經連結過。/ Linked before.
    Linked(User),
    /// 依已驗證的 email 連到既有帳號（管理員開了才會）。/ Linked by a verified email (when the admin allowed it).
    ByEmail(User),
    /// 這個提供者用 SCIM 預先建好的帳號（email 或使用者名稱相同）。/ An account this provider provisioned over SCIM.
    Provisioned(User),
    /// 第一次登入，建新帳號。/ A first sign-in creates an account.
    Create { username: String },
    Refuse(&'static str),
}

async fn plan(state: &AppState, p: &Provider, claims: &Claims) -> ApiResult<Plan> {
    if let Some(code) = domain_problem(p, claims) {
        return Ok(Plan::Refuse(code));
    }
    if let Err(code) = roles::allowed(&p.required(), claim_groups(p, claims).as_deref()) {
        return Ok(Plan::Refuse(code));
    }
    if let Some(uid) = db::oidc::user_for(&state.db, p.id, &claims.sub).await? {
        return Ok(match db::users::by_id(&state.db, uid).await? {
            Some(u) => Plan::Linked(u),
            None => Plan::Refuse("sso_not_linked"),
        });
    }
    // SCIM 預先建好的帳號：同一個身分提供者建的，email 或使用者名稱對得上就接上。
    // An account this provider provisioned over SCIM: matched by email or username.
    let from = UsernameFrom::parse(&p.username_from).unwrap_or(UsernameFrom::Email);
    let derived = proto::username_for(claims, from);
    if let Some(uid) = db::scim::provisioned_for(&state.db, p.id, claims.email.as_deref(), derived.as_deref()).await? {
        if db::oidc::sub_for(&state.db, p.id, uid).await?.is_none() {
            if let Some(u) = db::users::by_id(&state.db, uid).await? {
                return Ok(Plan::Provisioned(u));
            }
        }
    }
    if p.link_by_email && claims.email_verified == Some(true) {
        if let Some(email) = claims.email.as_deref().filter(|e| e.contains('@')) {
            if let Some(uid) = db::oidc::user_by_email(&state.db, email).await? {
                // 這個帳號在這個提供者已經連了別的身分：不換。/ Already linked to another identity here: leave it.
                if db::oidc::sub_for(&state.db, p.id, uid).await?.is_none() {
                    if let Some(u) = db::users::by_id(&state.db, uid).await? {
                        return Ok(Plan::ByEmail(u));
                    }
                }
            }
        }
    }
    if !p.create_users {
        return Ok(Plan::Refuse("sso_not_linked"));
    }
    let from = UsernameFrom::parse(&p.username_from).unwrap_or(UsernameFrom::Email);
    let Some(username) = proto::username_for(claims, from) else { return Ok(Plan::Refuse("sso_no_username")) };
    if db::users::by_username(&state.db, &username).await?.is_some() {
        return Ok(Plan::Refuse("sso_username_taken"));
    }
    Ok(Plan::Create { username })
}

/// 登入：照計畫找 / 建帳號，然後跟密碼登入一樣（2FA 照舊）。錯誤是要帶回頁面的 code。
/// Sign in: find / create the account, then the same as a password sign-in (2FA included). Errors are page codes.
async fn sign_in(state: &AppState, p: &Provider, claims: &Claims, id_token: &str, meta: &ClientMeta) -> Result<Value, &'static str> {
    let fail = |e: ApiError| {
        tracing::error!(provider = p.slug, error = ?e, "[OIDC] sign-in failed");
        "sso_failed"
    };
    let user = match plan(state, p, claims).await.map_err(fail)? {
        Plan::Refuse(code) => {
            tracing::warn!(provider = p.slug, code, "[OIDC] sign-in refused");
            return Err(code);
        }
        Plan::Linked(u) => u,
        Plan::ByEmail(u) => {
            db::oidc::link(&state.db, p.id, u.id, &claims.sub).await.map_err(|e| fail(e.into()))?;
            state.gateway.event("sso_link", None, None, None, format!("{} was linked to {} sign-in by their verified email", u.username, p.name)).await;
            u
        }
        Plan::Provisioned(u) => {
            db::oidc::link(&state.db, p.id, u.id, &claims.sub).await.map_err(|e| fail(e.into()))?;
            state.gateway.event("sso_link", None, None, None, format!("{} was linked to {} sign-in: the account it provisioned over SCIM", u.username, p.name)).await;
            u
        }
        Plan::Create { username } => {
            let hash = unusable_password();
            let email = claims.email.clone().unwrap_or_default();
            let new = NewUser {
                username: &username,
                password_hash: &hash,
                email: &email,
                first_name: claims.given_name.as_deref().unwrap_or(""),
                last_name: claims.family_name.as_deref().unwrap_or(""),
            };
            let u = match db::users::create(&state.db, new).await {
                Ok(u) => u,
                Err(e) if is_unique_violation(&e) => return Err("sso_username_taken"),
                Err(e) => return Err(fail(e.into())),
            };
            db::oidc::link(&state.db, p.id, u.id, &claims.sub).await.map_err(|e| fail(e.into()))?;
            tracing::info!(username = u.username, provider = p.slug, "[OIDC] Created user");
            state.webhooks.emit(
                crate::webhooks::Event::new(crate::webhooks::Kind::UserCreated).data(json!({ "user": u.username, "via": "sso", "provider": p.name })).link("/tunnels/admin/users"),
            );
            u
        }
    };
    if !user.is_active {
        sign_ins::record(state, user.id, meta, Attempt::failed("sso", None, "inactive")).await;
        return Err("account_disabled");
    }
    // 群組 → 角色：每次用這個提供者登入都對一次。/ Groups → roles, on every sign-in through this provider.
    apply_roles(state, p, &user, claims).await.map_err(|e| fail(e.into()))?;
    let result = super::mfa::complete_login(state, &user, "sso", meta).await.map_err(fail)?;
    if result.get("mfa_required").is_none() {
        tracing::info!(username = user.username, provider = p.slug, "[OIDC] Login success");
    }
    // 記下 id_token，登出時給身分提供者當提示；要過第二步的話等通過才掛上。
    // Keep the id_token as the sign-out hint; with a second step, it is attached once that passes.
    match result.get("mfa_token").and_then(Value::as_str) {
        Some(mfa_token) => state.oidc_flows.put_awaiting_mfa(mfa_token.to_string(), p.id, id_token.to_string()),
        None => remember_session(state, p.id, &result, id_token).await,
    }
    Ok(result)
}

/// 登入成功的回應裡有 refresh token：從它找出這個網頁登入，記下身分提供者與封存的 id_token。
/// From the sign-in's refresh token, find the web session and remember its provider and sealed id_token.
async fn remember_session(state: &AppState, provider_id: i64, tokens: &Value, id_token: &str) {
    let Some(refresh) = tokens.get("refresh_token").and_then(Value::as_str) else { return };
    let Some(sid) = state.jwt.verify(refresh, crate::auth::jwt::TokenType::Refresh).ok().and_then(|c| c.sid) else { return };
    let sealed = state.vault.seal(&session_aad(sid), id_token.as_bytes());
    if let Err(e) = db::oidc::set_session(&state.db, sid, provider_id, &sealed).await {
        tracing::warn!(error = %e, "[OIDC] could not remember the sign-in for signing out at the provider");
    }
}

fn session_aad(sid: i64) -> String {
    format!("telepy-oidc-session:{sid}")
}

/// 第二步通過了：之前等著的單一登入掛到新的網頁登入上。/ The second step passed: attach the waiting SSO sign-in.
pub async fn after_mfa(state: &AppState, mfa_token: &str, tokens: &Value) {
    if let Some((provider_id, id_token)) = state.oidc_flows.take_awaiting_mfa(mfa_token) {
        remember_session(state, provider_id, tokens, &id_token).await;
    }
}

/// 登出時：這個網頁登入是用單一登入開的，而那個身分提供者設定成一併登出，就回它的登出網址（給瀏覽器整頁打開）。
/// 不管有沒有網址，記錄都刪掉。/ On logout: when this web sign-in came from a provider set to sign out too, its sign-out
/// URL for the browser to open. The record goes either way.
pub async fn end_session_url(state: &AppState, headers: &HeaderMap, refresh: &str) -> Option<String> {
    let claims = state.jwt.verify(refresh, crate::auth::jwt::TokenType::Refresh).ok()?;
    let sid = claims.sid?;
    let (provider_id, sealed) = db::oidc::session(&state.db, sid).await.ok()??;
    let _ = db::oidc::forget_session(&state.db, sid).await;
    let p = db::oidc::by_id(&state.db, provider_id).await.ok()??;
    if !p.end_session {
        return None;
    }
    let id_token = String::from_utf8(state.vault.open(&session_aad(sid), &sealed)?).ok()?;
    let d = match state.oidc.discover(&p.issuer, false).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(provider = p.slug, error = e, "[OIDC] cannot sign out at the provider: discovery failed");
            return None;
        }
    };
    let Some(endpoint) = d.end_session_endpoint.as_deref() else {
        tracing::warn!(provider = p.slug, "[OIDC] the provider publishes no end_session_endpoint; signed out of Telepy only");
        return None;
    };
    match proto::end_session_url(endpoint, &id_token, &post_logout_url(&base(state, headers)), &p.client_id) {
        Ok(u) => Some(u),
        Err(e) => {
            tracing::warn!(provider = p.slug, error = e, "[OIDC] cannot sign out at the provider");
            None
        }
    }
}

/// 從身分提供者登出後回到哪裡（要在身分提供者那邊登記）。/ Where the browser comes back after signing out at the provider.
fn post_logout_url(base: &str) -> String {
    format!("{base}/login")
}

/// 已登入的人把這個身分連到自己。/ A signed-in person links this identity.
async fn link(state: &AppState, p: &Provider, claims: &Claims, user_id: i64) -> Result<(), &'static str> {
    let fail = |e: sqlx::Error| {
        tracing::error!(provider = p.slug, error = %e, "[OIDC] linking failed");
        "sso_failed"
    };
    let user = db::users::by_id(&state.db, user_id).await.map_err(fail)?.filter(|u| u.is_active).ok_or("account_disabled")?;
    if let Some(code) = domain_problem(p, claims) {
        return Err(code);
    }
    match db::oidc::user_for(&state.db, p.id, &claims.sub).await.map_err(fail)? {
        Some(other) if other != user.id => return Err("sso_linked_elsewhere"),
        Some(_) => return Ok(()),
        None => {}
    }
    if db::oidc::sub_for(&state.db, p.id, user.id).await.map_err(fail)?.is_some() {
        return Err("sso_already_linked");
    }
    db::oidc::link(&state.db, p.id, user.id, &claims.sub).await.map_err(fail)?;
    state.gateway.event("sso_link", None, None, None, format!("{} linked their {} sign-in", user.username, p.name)).await;
    Ok(())
}

/// 試登入給管理員看的：原始 claim + Telepy 會怎麼做。/ What a test shows: the claims and what Telepy would do.
async fn test_report(state: &AppState, p: &Provider, claims: &Claims) -> ApiResult<Value> {
    let raw = full_claims(claims);
    let groups = claim_groups(p, claims);
    let (mut would, user) = match plan(state, p, claims).await? {
        Plan::Linked(u) => (json!({ "action": "sign_in", "username": u.username }), Some(Some(u))),
        Plan::ByEmail(u) => (json!({ "action": "link_by_email", "username": u.username }), Some(Some(u))),
        Plan::Provisioned(u) => (json!({ "action": "link_provisioned", "username": u.username }), Some(Some(u))),
        Plan::Create { username } => (json!({ "action": "create", "username": username }), Some(None)),
        Plan::Refuse(code) => (json!({ "action": "refuse", "code": code }), None),
    };
    // 會怎麼改角色（沒有群組 claim = 不改）。/ How roles would change (no groups claim = unchanged).
    if let (Some(user), Some(groups)) = (user, groups.as_ref()) {
        let rules = live_rules(state, p.id).await?;
        let now = match &user {
            Some(u) => current(state, p, u).await?,
            None => Current { other_admins: true, ..Default::default() },
        };
        // 沒有規則也沒給過東西 = 不會碰角色，就不提。/ No rules and nothing granted = roles untouched; say nothing.
        if !rules.is_empty() || !now.granted.is_empty() {
            let sync = roles::plan(&roles::desired(&rules, groups), &now);
            let names = group_names(state).await?;
            would["roles"] = roles_json(&sync, &names);
        }
    }
    Ok(json!({ "provider": { "id": p.id, "slug": p.slug, "name": p.name }, "claims": raw, "groups_claim": p.groups_claim, "groups": groups, "would": would }))
}

/// id_token 的所有 claim（具名欄位放回去）。/ Every claim of the id_token (named fields put back).
fn full_claims(claims: &Claims) -> serde_json::Map<String, Value> {
    let mut raw = claims.rest.clone();
    raw.insert("sub".into(), json!(claims.sub));
    for (k, v) in [("email", &claims.email), ("preferred_username", &claims.preferred_username), ("name", &claims.name), ("given_name", &claims.given_name), ("family_name", &claims.family_name)] {
        if let Some(v) = v {
            raw.insert(k.into(), json!(v));
        }
    }
    if let Some(v) = claims.email_verified {
        raw.insert("email_verified".into(), json!(v));
    }
    raw
}

fn claim_groups(p: &Provider, claims: &Claims) -> Option<Vec<String>> {
    roles::claim_groups(&full_claims(claims), &p.groups_claim)
}

async fn group_names(state: &AppState) -> sqlx::Result<std::collections::HashMap<i64, String>> {
    Ok(db::features::groups(&state.db).await?.into_iter().map(|g| (g.id, g.name)).collect())
}

/// 這個提供者的規則，指向已經不存在的群組的那些不算。/ The provider's rules, minus ones whose group is gone.
async fn live_rules(state: &AppState, provider_id: i64) -> sqlx::Result<Vec<Rule>> {
    let names = group_names(state).await?;
    Ok(db::oidc::rules(&state.db, provider_id).await?.into_iter().filter(|r| r.target.group_id().is_none_or(|id| names.contains_key(&id))).collect())
}

async fn current(state: &AppState, p: &Provider, user: &User) -> sqlx::Result<Current> {
    Ok(Current {
        member_of: db::features::groups_of(&state.db, user.id).await?,
        is_admin: user.is_superuser,
        granted: db::oidc::granted(&state.db, p.id, user.id).await?,
        other_admins: db::oidc::other_admins(&state.db, user.id).await? > 0,
    })
}

fn roles_json(sync: &SyncPlan, names: &std::collections::HashMap<i64, String>) -> Value {
    let name = |id: &i64| names.get(id).cloned().unwrap_or_else(|| format!("#{id}"));
    let admin = if sync.make_admin {
        Some("grant")
    } else if sync.revoke_admin {
        Some("revoke")
    } else if sync.kept_last_admin {
        Some("keep_last")
    } else {
        None
    };
    json!({ "join": sync.join.iter().map(name).collect::<Vec<_>>(), "leave": sync.leave.iter().map(name).collect::<Vec<_>>(), "admin": admin })
}

/// 照群組 claim 對一次角色：加規則說要的、拿掉這個提供者以前給但現在不該有的。沒有 claim 就什麼都不動。
/// Sync roles from the groups claim: add what the rules call for, take away what this provider gave before and the
/// groups no longer call for. Without the claim nothing changes.
async fn apply_roles(state: &AppState, p: &Provider, user: &User, claims: &Claims) -> sqlx::Result<()> {
    let Some(groups) = claim_groups(p, claims) else {
        if !db::oidc::rules(&state.db, p.id).await?.is_empty() {
            tracing::info!(provider = p.slug, claim = p.groups_claim, "[OIDC] the id_token has no groups claim; roles left as they are");
        }
        return Ok(());
    };
    let rules = live_rules(state, p.id).await?;
    let now = current(state, p, user).await?;
    if rules.is_empty() && now.granted.is_empty() {
        return Ok(());
    }
    let sync = roles::plan(&roles::desired(&rules, &groups), &now);
    if sync.is_empty() && !sync.kept_last_admin {
        return Ok(());
    }
    for id in &sync.join {
        db::features::add_member(&state.db, *id, user.id).await?;
    }
    for id in &sync.leave {
        db::features::remove_member(&state.db, *id, user.id).await?;
    }
    if sync.make_admin || sync.revoke_admin {
        db::users::set_flags(&state.db, user.id, None, Some(sync.make_admin)).await?;
    }
    for t in &sync.record {
        db::oidc::record(&state.db, p.id, user.id, *t).await?;
    }
    for t in &sync.forget {
        db::oidc::forget(&state.db, p.id, user.id, *t).await?;
    }
    state.features.invalidate();
    // 分享給這些群組的通道跟著走。/ Tunnels shared with these groups follow.
    crate::group_shares::kick(state);
    let names = group_names(state).await?;
    let quoted = |ids: &[i64]| ids.iter().map(|id| format!("\"{}\"", names.get(id).cloned().unwrap_or_else(|| format!("#{id}")))).collect::<Vec<_>>().join(", ");
    let mut parts = Vec::new();
    if !sync.join.is_empty() {
        parts.push(format!("joined {}", quoted(&sync.join)));
    }
    if !sync.leave.is_empty() {
        parts.push(format!("left {}", quoted(&sync.leave)));
    }
    if sync.make_admin {
        parts.push("became an administrator".to_string());
    }
    if sync.revoke_admin {
        parts.push("is no longer an administrator".to_string());
    }
    if sync.kept_last_admin {
        parts.push("stays an administrator because they are the last one".to_string());
    }
    if !parts.is_empty() {
        state.gateway.event("sso_role", None, None, None, format!("{} {} (groups from {})", user.username, parts.join(", "), p.name)).await;
    }
    // 拿掉了東西：進行中的 session 重新檢查一次。/ Something was taken away: re-check live sessions now.
    if sync.takes_away() {
        crate::access_recheck::kick(state, None, Some(user.id));
    }
    Ok(())
}

// ---------------------------------------------------------------- public flow

#[derive(Deserialize, Default)]
struct StartQuery {
    #[serde(default)]
    next: Option<String>,
    #[serde(default)]
    intent: Option<String>,
}

#[utoipa::path(get, path = "/api/auth/oidc/{slug}/start", tag = "Login", params(("slug" = String, Path, description = "The provider's slug"), ("next" = Option<String>, Query, description = "A same-site path to open after signing in"), ("intent" = Option<String>, Query, description = "A link / test intent from POST /api/auth/oidc/links/{id} or /api/site/oidc/{id}/test")), responses(
    (status = 302, description = "To the provider's authorization endpoint (sets an HttpOnly binding cookie), or back to /login?sso_error=<code> / /tunnels/sso?error=<code>")
))]
async fn start(State(state): State<AppState>, Path(slug): Path<String>, Query(q): Query<StartQuery>, headers: HeaderMap) -> Response {
    let base = base(&state, &headers);
    let secure = base.starts_with("https://");
    let mut cookies = Vec::new();
    // 連結 / 試登入：意圖要是同一個瀏覽器建立的。/ A link / test intent must come from this browser.
    let purpose = match q.intent.as_deref().filter(|i| !i.is_empty()) {
        None => Purpose::Login,
        Some(intent) => {
            let name = flow::intent_cookie(intent);
            cookies.push(clear_cookie(&name, secure));
            let binding = flow::read_cookie(cookie_header(&headers), &name).map(|v| flow::hash(&v)).unwrap_or_default();
            let provider_id = match db::oidc::by_slug(&state.db, &slug).await {
                Ok(Some(p)) => p.id,
                _ => return found(fail_url(Some(&Purpose::Link { user_id: 0 }), "sso_unknown", &slug), cookies),
            };
            match state.oidc_flows.take_intent(intent, provider_id, &binding) {
                Some(p) => p,
                None => return found(fail_url(Some(&Purpose::Link { user_id: 0 }), "sso_expired", &slug), cookies),
            }
        }
    };
    let fail = |code: &str, cookies: Vec<String>| found(fail_url(Some(&purpose), code, &slug), cookies);
    let p = match db::oidc::by_slug(&state.db, &slug).await {
        // 管理員可以先試再啟用。/ Admins may test a provider before enabling it.
        Ok(Some(p)) if p.enabled || matches!(purpose, Purpose::Test { .. }) => p,
        Ok(_) => return fail("sso_unknown", cookies),
        Err(e) => {
            tracing::error!(error = %e, "[OIDC] provider lookup failed");
            return fail("sso_failed", cookies);
        }
    };
    let d = match state.oidc.discover(&p.issuer, false).await {
        Ok(d) => d,
        Err(e) => {
            tracing::error!(provider = p.slug, error = e, "[OIDC] discovery failed");
            return fail("sso_unreachable", cookies);
        }
    };
    let redirect_uri = callback_url(&base, &p.slug);
    let (verifier, challenge) = proto::pkce_pair();
    let state_token = proto::random_token(32);
    let nonce = proto::random_token(32);
    let binding = proto::random_token(32);
    let url = match proto::authorize_url(&d.authorization_endpoint, &AuthRequest { client_id: &p.client_id, redirect_uri: &redirect_uri, scopes: &p.scopes, state: &state_token, nonce: &nonce, challenge: &challenge }) {
        Ok(u) => u,
        Err(e) => {
            tracing::error!(provider = p.slug, error = e, "[OIDC] bad authorization endpoint");
            return fail("sso_failed", cookies);
        }
    };
    cookies.push(cookie(&flow::cookie_name(&state_token), &binding, secure, flow::PENDING_TTL.as_secs()));
    let next = match &purpose {
        Purpose::Login => proto::safe_next(q.next.as_deref()),
        _ => None,
    };
    state.oidc_flows.put_pending(
        state_token,
        Pending { provider_id: p.id, slug: p.slug.clone(), nonce, verifier, next, purpose, redirect_uri, binding: flow::hash(&binding), created: std::time::Instant::now() },
    );
    found(url, cookies)
}

#[derive(Deserialize, Default)]
struct CallbackQuery {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

#[utoipa::path(get, path = "/api/auth/oidc/{slug}/callback", tag = "Login", params(("slug" = String, Path, description = "The provider's slug")), responses(
    (status = 302, description = "To /login?sso=<ticket> (redeem it with POST /api/auth/oidc/redeem), /tunnels/sso?linked=<slug> / ?test=<ticket>, or back with ?sso_error=<code> / ?error=<code>")
))]
async fn callback(State(state): State<AppState>, Path(slug): Path<String>, Query(q): Query<CallbackQuery>, meta: ClientMeta, headers: HeaderMap) -> Response {
    let secure = base(&state, &headers).starts_with("https://");
    let Some(state_token) = q.state.filter(|s| !s.is_empty()) else { return found(fail_url(None, "sso_expired", &slug), vec![]) };
    let state_cookie = flow::cookie_name(&state_token);
    let mut cookies = vec![clear_cookie(&state_cookie, secure)];
    let Some(pending) = state.oidc_flows.take_pending(&state_token) else { return found(fail_url(None, "sso_expired", &slug), cookies) };
    let purpose = pending.purpose.clone();
    let fail = |code: &str, cookies: Vec<String>| found(fail_url(Some(&purpose), code, &slug), cookies);
    // 每個提供者自己的回呼路徑：別家的回應送不到這裡來（mix-up）。/ Each provider's own callback path (mix-up).
    if pending.slug != slug {
        tracing::warn!(expected = pending.slug, got = slug, "[OIDC] callback on another provider's path");
        return fail("sso_failed", cookies);
    }
    let binding = flow::read_cookie(cookie_header(&headers), &state_cookie).map(|v| flow::hash(&v));
    if binding.as_deref() != Some(pending.binding.as_str()) {
        tracing::warn!(provider = slug, "[OIDC] callback from a browser that didn't start this sign-in");
        return fail("sso_browser", cookies);
    }
    if let Some(err) = q.error.as_deref() {
        tracing::warn!(provider = slug, error = err, description = q.error_description.as_deref().unwrap_or(""), "[OIDC] the provider answered an error");
        return fail(if err == "access_denied" { "sso_denied" } else { "sso_provider_error" }, cookies);
    }
    let Some(code) = q.code.filter(|c| !c.is_empty()) else { return fail("sso_failed", cookies) };
    let p = match db::oidc::by_id(&state.db, pending.provider_id).await {
        Ok(Some(p)) => p,
        _ => return fail("sso_unknown", cookies),
    };
    let (claims, id_token) = {
        let d = match state.oidc.discover(&p.issuer, false).await {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(provider = p.slug, error = e, "[OIDC] discovery failed");
                return fail("sso_unreachable", cookies);
            }
        };
        let secret = open_secret(&state, &p);
        let id_token = match state.oidc.exchange(&d, &p.client_id, secret.as_deref(), &code, &pending.redirect_uri, &pending.verifier).await {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(provider = p.slug, error = e, "[OIDC] code exchange failed");
                return fail("sso_failed", cookies);
            }
        };
        match state.oidc.verify(&d, &id_token, &p.client_id, &pending.nonce).await {
            Ok(c) => (c, id_token),
            Err(e) => {
                tracing::error!(provider = p.slug, error = e, "[OIDC] id_token rejected");
                return fail("sso_failed", cookies);
            }
        }
    };
    let ticket_binding = proto::random_token(32);
    match purpose {
        Purpose::Login => match sign_in(&state, &p, &claims, &id_token, &meta).await {
            Ok(v) => {
                let ticket = state.oidc_flows.put_ticket(Outcome::Login(v), flow::hash(&ticket_binding));
                cookies.push(cookie(&flow::ticket_cookie(&ticket), &ticket_binding, secure, flow::TICKET_TTL.as_secs()));
                let next = pending.next.map(|n| format!("&next={}", enc(&n))).unwrap_or_default();
                found(format!("/login?sso={ticket}{next}"), cookies)
            }
            Err(code) => fail(code, cookies),
        },
        Purpose::Link { user_id } => match link(&state, &p, &claims, user_id).await {
            Ok(()) => found(format!("/tunnels/sso?linked={}", enc(&p.slug)), cookies),
            Err(code) => fail(code, cookies),
        },
        Purpose::Test { user_id } => match test_report(&state, &p, &claims).await {
            Ok(report) => {
                let ticket = state.oidc_flows.put_ticket(Outcome::Test { user_id, claims: report }, flow::hash(&ticket_binding));
                cookies.push(cookie(&flow::ticket_cookie(&ticket), &ticket_binding, secure, flow::TICKET_TTL.as_secs()));
                found(format!("/tunnels/sso?test={ticket}&provider={}", enc(&p.slug)), cookies)
            }
            Err(e) => {
                tracing::error!(provider = p.slug, error = ?e, "[OIDC] test report failed");
                fail("sso_failed", cookies)
            }
        },
    }
}

/// 從 body 拿票券，配上這個瀏覽器的綁定 cookie。/ The ticket from the body, with this browser's binding cookie.
fn take_ticket(state: &AppState, headers: &HeaderMap, body: &Value) -> ApiResult<(Outcome, String)> {
    let ticket = json_str(body, "ticket").filter(|t| !t.is_empty()).ok_or_else(|| ApiError::field("ticket", "This field is required."))?;
    let name = flow::ticket_cookie(&ticket);
    let Some(value) = flow::read_cookie(cookie_header(headers), &name) else {
        return Err(sso_error(StatusCode::BAD_REQUEST, "sso_browser", "Finish signing in in the browser that started it."));
    };
    let outcome = state
        .oidc_flows
        .take_ticket(&ticket, &flow::hash(&value))
        .ok_or_else(|| sso_error(StatusCode::BAD_REQUEST, "sso_expired", "That sign-in has expired or was already used. Start again."))?;
    Ok((outcome, name))
}

#[utoipa::path(post, path = "/api/auth/oidc/redeem", tag = "Login", request_body = super::schemas::OidcTicketRequest, responses(
    (status = 200, description = "The same as a password sign-in: tokens, or a two-step challenge", body = super::schemas::LoginResponse),
    (status = 400, description = "code = sso_browser (another browser) / sso_expired", body = super::schemas::ErrorBody)
))]
async fn redeem(State(state): State<AppState>, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Response> {
    let secure = base(&state, &headers).starts_with("https://");
    let (outcome, name) = take_ticket(&state, &headers, &body_object(&body))?;
    match outcome {
        Outcome::Login(v) => Ok((AppendHeaders([(header::SET_COOKIE, clear_cookie(&name, secure))]), Json(v)).into_response()),
        Outcome::Test { .. } => Err(sso_error(StatusCode::BAD_REQUEST, "sso_expired", "That sign-in has expired or was already used. Start again.")),
    }
}

#[utoipa::path(post, path = "/api/auth/oidc/test-result", tag = "Site Settings", security(("bearer" = [])), request_body = super::schemas::OidcTicketRequest, responses(
    (status = 200, description = "What a test sign-in got: the id_token's claims and what Telepy would do with them (the admin who started it only)", body = super::schemas::OidcTestResult),
    (status = 400, description = "code = sso_browser / sso_expired", body = super::schemas::ErrorBody),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody)
))]
async fn test_result(State(state): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Response> {
    admin_only(&me)?;
    let secure = base(&state, &headers).starts_with("https://");
    let (outcome, name) = take_ticket(&state, &headers, &body_object(&body))?;
    match outcome {
        Outcome::Test { user_id, claims } if user_id == me.id => Ok((AppendHeaders([(header::SET_COOKIE, clear_cookie(&name, secure))]), Json(claims)).into_response()),
        _ => Err(sso_error(StatusCode::BAD_REQUEST, "sso_expired", "That sign-in has expired or was already used. Start again.")),
    }
}

// ---------------------------------------------------------------- your links

async fn links_json(state: &AppState, me: &User) -> ApiResult<Value> {
    let linked = db::oidc::linked_ids(&state.db, me.id).await?;
    let providers: Vec<Value> = db::oidc::list(&state.db)
        .await?
        .into_iter()
        .filter(|p| p.enabled || linked.contains(&p.id))
        .map(|p| json!({ "id": p.id, "slug": p.slug, "name": p.name, "enabled": p.enabled, "linked": linked.contains(&p.id) }))
        .collect();
    let has_password = !me.password.starts_with('!') && !me.password.is_empty();
    let google = db::users::social_for(&state.db, me.id, "google").await?.is_some();
    let passkeys = super::mfa::factors(state, me.id).await?.passkeys;
    Ok(json!({ "providers": providers, "has_password": has_password, "google": google, "passkeys": passkeys }))
}

#[utoipa::path(get, path = "/api/auth/oidc/links", tag = "Two-factor", security(("bearer" = [])), responses(
    (status = 200, description = "The single sign-on providers and which ones you linked, plus your other ways in", body = super::schemas::OidcLinks)
))]
async fn links(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(links_json(&state, &me).await?))
}

/// 意圖：存起來、綁這個瀏覽器，回要整頁導向的網址。/ Store an intent bound to this browser; answer the URL to open.
fn intent_response(state: &AppState, headers: &HeaderMap, p: &Provider, purpose: Purpose) -> Response {
    let secure = base(state, headers).starts_with("https://");
    let binding = proto::random_token(32);
    let id = state.oidc_flows.put_intent(p.id, purpose, flow::hash(&binding));
    let url = format!("/api/auth/oidc/{}/start?intent={id}", p.slug);
    (AppendHeaders([(header::SET_COOKIE, cookie(&flow::intent_cookie(&id), &binding, secure, flow::TICKET_TTL.as_secs()))]), Json(json!({ "url": url }))).into_response()
}

#[utoipa::path(post, path = "/api/auth/oidc/links/{id}", tag = "Two-factor", security(("bearer" = [])), params(("id" = i64, Path, description = "Provider id")), request_body = super::schemas::OidcReauth, responses(
    (status = 200, description = "Open `url` in this browser to sign in at the provider; it is linked to you when you come back", body = super::schemas::OidcIntent),
    (status = 403, description = "reauth_required", body = super::schemas::ErrorBody),
    (status = 404, description = "No such enabled provider", body = super::schemas::ErrorBody),
    (status = 409, description = "code = already_linked", body = super::schemas::ErrorBody)
))]
async fn link_start(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Response> {
    let p = db::oidc::by_id(&state.db, id).await?.filter(|p| p.enabled).ok_or_else(|| ApiError::not_found("No such sign-in provider."))?;
    if db::oidc::sub_for(&state.db, p.id, me.id).await?.is_some() {
        return Err(sso_error(StatusCode::CONFLICT, "already_linked", "This sign-in is already linked to your account."));
    }
    super::mfa::require_reauth(&state, &headers, &me, body.get("reauth")).await?;
    Ok(intent_response(&state, &headers, &p, Purpose::Link { user_id: me.id }))
}

#[utoipa::path(delete, path = "/api/auth/oidc/links/{id}", tag = "Two-factor", security(("bearer" = [])), params(("id" = i64, Path, description = "Provider id")), request_body = super::schemas::OidcReauth, responses(
    (status = 200, description = "Unlinked; the links again", body = super::schemas::OidcLinks),
    (status = 400, description = "code = last_sign_in_method: it is your only way in", body = super::schemas::ErrorBody),
    (status = 403, description = "reauth_required", body = super::schemas::ErrorBody),
    (status = 404, description = "Not linked", body = super::schemas::ErrorBody)
))]
async fn unlink(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let p = db::oidc::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("No such sign-in provider."))?;
    if db::oidc::sub_for(&state.db, p.id, me.id).await?.is_none() {
        return Err(ApiError::not_found("This sign-in is not linked to your account."));
    }
    let passkey = super::mfa::factors(&state, me.id).await?.passkeys > 0;
    if !db::oidc::other_ways_in(&state.db, &me, passkey, p.id).await? {
        return Err(sso_error(StatusCode::BAD_REQUEST, "last_sign_in_method", "This is your only way to sign in. Set a password or add a passkey first."));
    }
    super::mfa::require_reauth(&state, &headers, &me, body.get("reauth")).await?;
    db::oidc::unlink(&state.db, p.id, me.id).await?;
    state.gateway.event("sso_link", None, None, None, format!("{} unlinked their {} sign-in", me.username, p.name)).await;
    Ok(Json(links_json(&state, &me).await?))
}

// ---------------------------------------------------------------- admin

fn provider_json(p: &Provider, base: &str, links: i64, rules: &[&db::oidc::RuleRow], names: &std::collections::HashMap<i64, String>, scim_counts: (i64, i64)) -> Value {
    json!({
        "id": p.id,
        "slug": p.slug,
        "name": p.name,
        "issuer": p.issuer,
        "client_id": p.client_id,
        "has_secret": !p.client_secret.is_empty(),
        "scopes": p.scopes,
        "username_from": p.username_from,
        "allowed_domains": proto::parse_domains(&p.allowed_domains),
        "create_users": p.create_users,
        "link_by_email": p.link_by_email,
        "enabled": p.enabled,
        "created_at": crate::util::db_to_iso_utc_z(&p.created_at),
        "updated_at": crate::util::db_to_iso_utc_z(&p.updated_at),
        "callback_url": callback_url(base, &p.slug),
        "links": links,
        "groups_claim": p.groups_claim,
        "required_groups": p.required(),
        "end_session": p.end_session,
        // SCIM 帳號同步：有沒有權杖、前幾碼、最後一次使用、管理幾個帳號與群組。/ SCIM provisioning state.
        "scim": {
            "active": !p.scim_token.is_empty(),
            "prefix": p.scim_token_prefix,
            "created_at": p.scim_token_created.as_deref().map(crate::util::db_to_iso_utc_z),
            "last_used_at": p.scim_last_used.as_deref().map(crate::util::db_to_iso_utc_z),
            "users": scim_counts.0,
            "groups": scim_counts.1,
        },
        // 要在身分提供者那邊登記的「登出後回來的網址」。/ The post-logout redirect URI to register at the provider.
        "post_logout_url": post_logout_url(base),
        // 規則；指向已刪掉的群組的 group_name = null。/ Rules; group_name null when the group is gone.
        "group_rules": rules.iter().map(|r| json!({
            "idp_group": r.idp_group,
            "target": r.target,
            "group_id": r.group_id,
            "group_name": r.group_id.and_then(|id| names.get(&id).cloned()),
        })).collect::<Vec<_>>(),
    })
}

async fn admin_json(state: &AppState, headers: &HeaderMap) -> ApiResult<Value> {
    let base = base(state, headers);
    let counts = db::oidc::link_counts(&state.db).await?;
    let rules = db::oidc::all_rules(&state.db).await?;
    let scim = db::scim::counts(&state.db).await?;
    let groups = db::features::groups(&state.db).await?;
    let names: std::collections::HashMap<i64, String> = groups.iter().map(|g| (g.id, g.name.clone())).collect();
    let providers: Vec<Value> = db::oidc::list(&state.db)
        .await?
        .iter()
        .map(|p| {
            let mine: Vec<&db::oidc::RuleRow> = rules.iter().filter(|r| r.provider_id == p.id).collect();
            provider_json(p, &base, counts.get(&p.id).copied().unwrap_or(0), &mine, &names, scim.get(&p.id).copied().unwrap_or((0, 0)))
        })
        .collect();
    Ok(json!({
        "providers": providers,
        "callback_base": format!("{base}/api/auth/oidc/"),
        "public_url_set": state.config.public_base().is_some(),
        // SCIM 的基底網址（填到身分提供者那邊）。/ The SCIM base URL to give the provider.
        "scim_base": format!("{base}/api/scim/v2"),
        // 規則可以指向的使用者群組（功能權限的群組）。/ The user groups rules may point at (feature-access groups).
        "user_groups": groups.iter().map(|g| json!({ "id": g.id, "name": g.name })).collect::<Vec<_>>(),
    }))
}

/// 一個網域：小寫、有點、只有網域字元。/ One domain: lowercase, dotted, hostname characters.
fn valid_domain(d: &str) -> bool {
    d.contains('.') && d.len() <= 253 && d.split('.').all(|l| !l.is_empty() && l.len() <= 63 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !l.starts_with('-') && !l.ends_with('-'))
}

/// 表單驗完的樣子。/ A checked form.
struct Form {
    slug: String,
    name: String,
    issuer: String,
    client_id: String,
    /// None = 不動；Some("") = 清掉。/ None = keep; Some("") = clear.
    secret: Option<String>,
    scopes: String,
    username_from: String,
    allowed_domains: String,
    create_users: bool,
    link_by_email: bool,
    enabled: bool,
    groups_claim: String,
    /// JSON 陣列。/ A JSON array.
    required_groups: String,
    /// None = 不動（修改時沒給）。/ None = keep (omitted on update).
    rules: Option<Vec<Rule>>,
    end_session: bool,
}

/// 一串群組名稱：去頭尾空白、不空、不重複、不太長。/ A list of group names: trimmed, non-empty, unique, bounded.
fn parse_group_list(v: &Value, field: &str, max: usize) -> ApiResult<Vec<String>> {
    let items = match v {
        Value::Array(a) => a.clone(),
        Value::Null => vec![],
        _ => return Err(ApiError::field(field, "A list of group names.")),
    };
    let mut out: Vec<String> = Vec::new();
    for it in items {
        let g = it.as_str().map(str::trim).unwrap_or("");
        if g.is_empty() || g.chars().count() > roles::MAX_GROUP_LEN {
            return Err(ApiError::field(field, format!("Group names are 1–{} characters.", roles::MAX_GROUP_LEN)));
        }
        if !out.iter().any(|x| x == g) {
            out.push(g.to_string());
        }
    }
    if out.len() > max {
        return Err(ApiError::field(field, format!("At most {max}.")));
    }
    Ok(out)
}

/// 規則：`[{idp_group, target: admin|group, group_id}]`，群組必須存在。/ Rules; the user group must exist.
fn parse_rules(v: &Value, known: &std::collections::HashMap<i64, String>) -> ApiResult<Vec<Rule>> {
    let items = match v {
        Value::Array(a) => a.clone(),
        Value::Null => vec![],
        _ => return Err(ApiError::field("group_rules", "A list of rules.")),
    };
    let mut out: Vec<Rule> = Vec::new();
    for it in items {
        let idp_group = it.get("idp_group").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        if idp_group.is_empty() || idp_group.chars().count() > roles::MAX_GROUP_LEN {
            return Err(ApiError::field("group_rules", format!("Each rule needs the provider's group name (1–{} characters).", roles::MAX_GROUP_LEN)));
        }
        let target = match it.get("target").and_then(Value::as_str) {
            Some("admin") => Target::Admin,
            Some("group") => match it.get("group_id").and_then(Value::as_i64) {
                Some(id) if known.contains_key(&id) => Target::Group(id),
                _ => return Err(ApiError::field("group_rules", "Pick a Telepy user group that exists.")),
            },
            _ => return Err(ApiError::field("group_rules", "target must be admin or group.")),
        };
        let rule = Rule { idp_group, target };
        if !out.contains(&rule) {
            out.push(rule);
        }
    }
    if out.len() > roles::MAX_RULES {
        return Err(ApiError::field("group_rules", format!("At most {} rules.", roles::MAX_RULES)));
    }
    Ok(out)
}

/// 新增時全部欄位，修改時沒給的沿用舊值。/ All fields on create; on update, missing ones keep their value.
fn parse_form(body: &Value, old: Option<&Provider>, known_groups: &std::collections::HashMap<i64, String>) -> ApiResult<Form> {
    let s = |k: &str| body.get(k).and_then(Value::as_str).map(str::trim).map(str::to_string);
    let b = |k: &str, default: bool| body.get(k).and_then(Value::as_bool).unwrap_or(default);
    let name = s("name").or_else(|| old.map(|o| o.name.clone())).unwrap_or_default();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(ApiError::field("name", "Give it a name of 1–64 characters."));
    }
    let slug = s("slug").filter(|x| !x.is_empty()).or_else(|| old.map(|o| o.slug.clone())).unwrap_or_else(|| proto::slugify(&name));
    proto::check_slug(&slug).map_err(|e| ApiError::field("slug", e))?;
    if RESERVED_SLUGS.contains(&slug.as_str()) {
        return Err(ApiError::field("slug", format!("\"{slug}\" is used by Telepy itself; pick another.")));
    }
    let issuer = s("issuer").or_else(|| old.map(|o| o.issuer.clone())).unwrap_or_default();
    let issuer = proto::check_issuer(&issuer).map_err(|e| ApiError::field("issuer", e))?;
    let client_id = s("client_id").or_else(|| old.map(|o| o.client_id.clone())).unwrap_or_default();
    if client_id.is_empty() || client_id.len() > 256 {
        return Err(ApiError::field("client_id", "This field is required."));
    }
    let secret = body.get("client_secret").and_then(Value::as_str).map(|x| x.trim().to_string());
    if secret.as_ref().is_some_and(|x| x.len() > 1024) {
        return Err(ApiError::field("client_secret", "That is too long for a client secret."));
    }
    let scopes = proto::normalize_scopes(&s("scopes").or_else(|| old.map(|o| o.scopes.clone())).unwrap_or_else(|| "openid email profile".into()));
    if scopes.len() > 256 {
        return Err(ApiError::field("scopes", "Too many scopes."));
    }
    let username_from = s("username_from").or_else(|| old.map(|o| o.username_from.clone())).unwrap_or_else(|| "email".into());
    if UsernameFrom::parse(&username_from).is_none() {
        return Err(ApiError::field("username_from", "Must be email or preferred_username."));
    }
    let domains: Vec<String> = match body.get("allowed_domains") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).flat_map(proto::parse_domains).collect(),
        Some(Value::String(x)) => proto::parse_domains(x),
        Some(Value::Null) => vec![],
        Some(_) => return Err(ApiError::field("allowed_domains", "A list of domains.")),
        None => old.map(|o| proto::parse_domains(&o.allowed_domains)).unwrap_or_default(),
    };
    if let Some(bad) = domains.iter().find(|d| !valid_domain(d)) {
        return Err(ApiError::field("allowed_domains", format!("\"{bad}\" is not a domain.")));
    }
    let mut seen = Vec::new();
    for d in domains {
        if !seen.contains(&d) {
            seen.push(d);
        }
    }
    let allowed_domains = seen.join(",");
    if allowed_domains.len() > 1024 {
        return Err(ApiError::field("allowed_domains", "Too many domains."));
    }
    let groups_claim = s("groups_claim").filter(|x| !x.is_empty()).or_else(|| old.map(|o| o.groups_claim.clone())).unwrap_or_else(|| "groups".into());
    roles::check_claim_path(&groups_claim).map_err(|e| ApiError::field("groups_claim", e))?;
    let required = match body.get("required_groups") {
        Some(v) => parse_group_list(v, "required_groups", roles::MAX_REQUIRED)?,
        None => old.map(|o| o.required()).unwrap_or_default(),
    };
    let rules = match body.get("group_rules") {
        Some(v) => Some(parse_rules(v, known_groups)?),
        None if old.is_none() => Some(vec![]),
        None => None,
    };
    Ok(Form {
        slug,
        name,
        issuer,
        client_id,
        secret,
        scopes,
        username_from,
        allowed_domains,
        create_users: b("create_users", old.map(|o| o.create_users).unwrap_or(true)),
        link_by_email: b("link_by_email", old.map(|o| o.link_by_email).unwrap_or(false)),
        enabled: b("enabled", old.map(|o| o.enabled).unwrap_or(true)),
        groups_claim,
        required_groups: serde_json::to_string(&required).unwrap_or_else(|_| "[]".into()),
        rules,
        end_session: b("end_session", old.map(|o| o.end_session).unwrap_or(false)),
    })
}

impl Form {
    fn row(&self) -> NewProvider<'_> {
        NewProvider {
            slug: &self.slug,
            name: &self.name,
            issuer: &self.issuer,
            client_id: &self.client_id,
            scopes: &self.scopes,
            username_from: &self.username_from,
            allowed_domains: &self.allowed_domains,
            create_users: self.create_users,
            link_by_email: self.link_by_email,
            enabled: self.enabled,
            groups_claim: &self.groups_claim,
            required_groups: &self.required_groups,
            end_session: self.end_session,
        }
    }
}

fn slug_taken(e: sqlx::Error) -> ApiError {
    if is_unique_violation(&e) {
        ApiError::field("slug", "Another provider already uses this slug.")
    } else {
        e.into()
    }
}

async fn save_secret(state: &AppState, id: i64, secret: &Option<String>) -> ApiResult<()> {
    match secret.as_deref() {
        None => Ok(()),
        Some("") => Ok(db::oidc::set_secret(&state.db, id, "").await?),
        Some(s) => Ok(db::oidc::set_secret(&state.db, id, &state.vault.seal(&secret_aad(id), s.as_bytes())).await?),
    }
}

#[utoipa::path(get, path = "/api/site/oidc", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "Single sign-on providers with their callback URLs and how many accounts each links (superusers)", body = super::schemas::OidcProviderList),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody)
))]
async fn admin_list(State(state): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    Ok(Json(admin_json(&state, &headers).await?))
}

#[utoipa::path(post, path = "/api/site/oidc", tag = "Site Settings", security(("bearer" = [])), request_body = super::schemas::OidcProviderRequest, responses(
    (status = 200, description = "Added; the list again with `created_id`", body = super::schemas::OidcProviderList),
    (status = 400, description = "Field errors", body = super::schemas::ErrorBody),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody)
))]
async fn admin_create(State(state): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    let known = group_names(&state).await?;
    let form = parse_form(&body_object(&body), None, &known)?;
    let id = db::oidc::create(&state.db, &form.row()).await.map_err(slug_taken)?;
    save_secret(&state, id, &form.secret).await?;
    if let Some(rules) = &form.rules {
        db::oidc::set_rules(&state.db, id, rules).await?;
    }
    state.gateway.event("sso_provider", None, None, None, format!("{} added the sign-in provider {} ({})", me.username, form.name, form.issuer)).await;
    let mut v = admin_json(&state, &headers).await?;
    v["created_id"] = json!(id);
    Ok(Json(v))
}

#[utoipa::path(patch, path = "/api/site/oidc/{id}", tag = "Site Settings", security(("bearer" = [])), params(("id" = i64, Path, description = "Provider id")), request_body = super::schemas::OidcProviderRequest, responses(
    (status = 200, description = "Saved; the list again. `client_secret` omitted = kept, empty = removed", body = super::schemas::OidcProviderList),
    (status = 400, description = "Field errors", body = super::schemas::ErrorBody),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody),
    (status = 404, description = "No such provider", body = super::schemas::ErrorBody)
))]
async fn admin_update(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    let old = db::oidc::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("No such sign-in provider."))?;
    let known = group_names(&state).await?;
    let form = parse_form(&body_object(&body), Some(&old), &known)?;
    db::oidc::update(&state.db, id, &form.row()).await.map_err(slug_taken)?;
    save_secret(&state, id, &form.secret).await?;
    if let Some(rules) = &form.rules {
        db::oidc::set_rules(&state.db, id, rules).await?;
    }
    let what = if old.enabled != form.enabled { if form.enabled { "turned on" } else { "turned off" } } else { "changed" };
    state.gateway.event("sso_provider", None, None, None, format!("{} {what} the sign-in provider {}", me.username, form.name)).await;
    Ok(Json(admin_json(&state, &headers).await?))
}

#[utoipa::path(delete, path = "/api/site/oidc/{id}", tag = "Site Settings", security(("bearer" = [])), params(("id" = i64, Path, description = "Provider id")), responses(
    (status = 200, description = "Deleted with every account link to it; the list again", body = super::schemas::OidcProviderList),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody),
    (status = 404, description = "No such provider", body = super::schemas::ErrorBody)
))]
async fn admin_delete(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    let old = db::oidc::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("No such sign-in provider."))?;
    db::oidc::delete(&state.db, id).await?;
    state.gateway.event("sso_provider", None, None, None, format!("{} removed the sign-in provider {} and its account links", me.username, old.name)).await;
    Ok(Json(admin_json(&state, &headers).await?))
}

#[utoipa::path(post, path = "/api/site/oidc/discover", tag = "Site Settings", security(("bearer" = [])), request_body = super::schemas::OidcDiscoverRequest, responses(
    (status = 200, description = "`ok` with the endpoints and how many signing keys the provider publishes, or `ok: false` with why", body = super::schemas::OidcDiscoverResult),
    (status = 400, description = "Field error on issuer", body = super::schemas::ErrorBody),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody)
))]
async fn admin_discover(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    let raw = json_str(&body_object(&body), "issuer").unwrap_or_default();
    let issuer = proto::check_issuer(&raw).map_err(|e| ApiError::field("issuer", e))?;
    let d = match state.oidc.discover(&issuer, true).await {
        Ok(d) => d,
        Err(e) => return Ok(Json(json!({ "ok": false, "issuer": issuer, "error": e }))),
    };
    let keys = match state.oidc.key_count(&d).await {
        Ok(n) => n,
        Err(e) => return Ok(Json(json!({ "ok": false, "issuer": issuer, "error": e }))),
    };
    let pkce = match &d.code_challenge_methods_supported {
        Some(_) => "S256",
        None => "unlisted",
    };
    Ok(Json(json!({
        "ok": keys > 0,
        "issuer": d.issuer,
        "authorization_endpoint": d.authorization_endpoint,
        "token_endpoint": d.token_endpoint,
        "jwks_uri": d.jwks_uri,
        "end_session_endpoint": d.end_session_endpoint,
        "keys": keys,
        "pkce": pkce,
        "error": if keys == 0 { Some("The provider publishes no signing keys.") } else { None },
    })))
}

#[utoipa::path(post, path = "/api/site/oidc/{id}/test", tag = "Site Settings", security(("bearer" = [])), params(("id" = i64, Path, description = "Provider id")), responses(
    (status = 200, description = "Open `url` in this browser: you sign in at the provider and come back to /tunnels/sso?test=<ticket>; nobody is signed in or created", body = super::schemas::OidcIntent),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody),
    (status = 404, description = "No such provider", body = super::schemas::ErrorBody)
))]
async fn admin_test(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, headers: HeaderMap) -> ApiResult<Response> {
    admin_only(&me)?;
    let p = db::oidc::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("No such sign-in provider."))?;
    Ok(intent_response(&state, &headers, &p, Purpose::Test { user_id: me.id }))
}

/// 登入頁的按鈕。/ The sign-in page's buttons.
pub async fn buttons(state: &AppState) -> Vec<Value> {
    match db::oidc::enabled(&state.db).await {
        Ok(list) => list.iter().map(|p| json!({ "slug": p.slug, "name": p.name })).collect(),
        Err(e) => {
            tracing::error!(error = %e, "[OIDC] cannot list providers");
            vec![]
        }
    }
}

#[utoipa::path(post, path = "/api/site/oidc/{id}/scim-token", tag = "Site Settings", security(("bearer" = [])), params(("id" = i64, Path, description = "Provider id")), request_body = super::schemas::OidcReauth, responses(
    (status = 200, description = "A new SCIM token, shown this once (`tps_…`); any earlier one stops working", body = super::schemas::ScimTokenCreated),
    (status = 403, description = "admin_only / reauth_required", body = super::schemas::ErrorBody),
    (status = 404, description = "No such provider", body = super::schemas::ErrorBody)
))]
async fn scim_token_create(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    let p = db::oidc::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("No such sign-in provider."))?;
    super::mfa::require_reauth(&state, &headers, &me, body.get("reauth")).await?;
    let token = format!("tps_{}", proto::random_token(30));
    let prefix: String = token.chars().take(10).collect();
    db::oidc::set_scim_token(&state.db, p.id, &flow::hash(&token), &prefix).await?;
    let replaced = if p.scim_token.is_empty() { "" } else { " (the earlier one stopped working)" };
    state.gateway.event("scim_token", None, None, None, format!("{} made a SCIM token for {}{replaced}", me.username, p.name)).await;
    Ok(Json(json!({ "token": token, "prefix": prefix, "base_url": format!("{}/api/scim/v2", base(&state, &headers)) })))
}

#[utoipa::path(delete, path = "/api/site/oidc/{id}/scim-token", tag = "Site Settings", security(("bearer" = [])), params(("id" = i64, Path, description = "Provider id")), responses(
    (status = 200, description = "Provisioning off: the token stops working at once; the accounts it made stay", body = super::schemas::OidcProviderList),
    (status = 403, description = "admin_only", body = super::schemas::ErrorBody),
    (status = 404, description = "No such provider", body = super::schemas::ErrorBody)
))]
async fn scim_token_delete(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    let p = db::oidc::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("No such sign-in provider."))?;
    db::oidc::set_scim_token(&state.db, p.id, "", "").await?;
    state.gateway.event("scim_token", None, None, None, format!("{} removed the SCIM token of {}", me.username, p.name)).await;
    Ok(Json(admin_json(&state, &headers).await?))
}
