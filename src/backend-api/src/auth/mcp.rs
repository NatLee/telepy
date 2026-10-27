//! MCP 端點（與 REST 上的委派 token）的 Bearer 驗證：OAuth access token（JWT）→ grant（未撤銷、未過期）→ 使用者
//! （仍啟用）；或個人 API token（`tpt_…`，`auth::api_tokens`）→ token（未撤銷、未過期）→ 使用者。
//! 每次請求都查 grant / token，所以撤銷立即生效（不必等 1 小時的 access token 過期）。
//! Bearer check for the MCP endpoint (and delegated tokens on REST): an OAuth access token → live grant → active
//! user, or a personal API token (`tpt_…`) → live token → active user. Looked up on every request, so revoking
//! takes effect immediately rather than when the access token expires.

use crate::db::{self, users::User};
use crate::oauth;
use crate::state::AppState;
use crate::util::db_time;

/// 呼叫者拿的是什麼：OAuth grant（一個 app 的同意）或個人 API token。/ What the caller holds: an OAuth grant or an API token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Credential {
    Grant(i64),
    Token(i64),
}

impl Credential {
    pub fn grant_id(self) -> Option<i64> {
        match self {
            Credential::Grant(id) => Some(id),
            Credential::Token(_) => None,
        }
    }
    pub fn token_id(self) -> Option<i64> {
        match self {
            Credential::Token(id) => Some(id),
            Credential::Grant(_) => None,
        }
    }
    /// 撤銷 / 到期了嗎（reaper 用；DB 錯誤 = 不知道 → None）。/ Whether it is still live (None on a DB error).
    pub async fn is_live(self, db: &crate::db::Db) -> Option<bool> {
        let now = crate::util::now_db();
        Some(match self {
            Credential::Grant(id) => db::oauth::grant_by_id(db, id).await.ok()?.map(|g| g.is_active(&now)).unwrap_or(false),
            Credential::Token(id) => db::api_tokens::by_id(db, id).await.ok()?.map(|t| t.is_active(&now)).unwrap_or(false),
        })
    }
}

/// 個人 API token 在稽核 / 通知裡的名稱。/ How an API token is named in audit rows and notifications.
pub fn token_client_name(name: &str) -> String {
    format!("API token \"{name}\"")
}

/// 一個已驗證的 MCP（或 REST 上的委派）呼叫者：哪個使用者、透過哪個 grant / token、允許哪些 scope 與隧道。
/// An authenticated delegated caller: the user, the grant or token, its scopes and tunnels.
#[derive(Debug, Clone)]
pub struct McpPrincipal {
    pub user: User,
    pub credential: Credential,
    pub client_id: String,
    pub client_name: String,
    pub scopes: Vec<String>,
    /// None = 使用者看得到的全部隧道。/ None = every tunnel the user can see.
    pub tunnel_ids: Option<Vec<i64>>,
    /// 這次 MCP 請求的來源 IP（AI app 的出口）；由 `/mcp` 中介層填。/ Client IP of this MCP request.
    pub ip: Option<String>,
    /// 管理員替這個人關掉的功能（tool 照 scope 對應的功能拒絕）。/ Features turned off for this person.
    pub denied: Vec<crate::features::Feature>,
}

impl McpPrincipal {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
    /// 這個功能被關掉了嗎（跟 web 同一道門：`ssh:exec` ↔ 終端機、`ssh:files` ↔ 檔案…）。
    /// Whether a feature is turned off for this person (the same gate as the web).
    pub fn feature_denied(&self, f: crate::features::Feature) -> bool {
        self.denied.contains(&f)
    }
    /// scope 有給、而且它對應的功能沒被關掉。/ The scope is granted and its feature is not turned off.
    pub fn may_use(&self, scope: &str) -> bool {
        self.has_scope(scope) && !crate::features::Feature::for_scope(scope).is_some_and(|f| self.feature_denied(f))
    }
    /// grant 的隧道限制（權限另外照 web 規則檢查）。/ The grant's tunnel restriction (permissions are checked separately).
    pub fn tunnel_allowed(&self, tunnel_id: i64) -> bool {
        self.tunnel_ids.as_ref().map(|ids| ids.contains(&tunnel_id)).unwrap_or(true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpAuthError {
    /// 沒帶 token → 401，只帶 resource_metadata（讓客戶端開始 OAuth）。
    Missing,
    /// token 無效 / 過期 / grant 已撤銷 → 401 `error="invalid_token"`。
    Invalid,
}

/// `WWW-Authenticate` 標頭值（RFC 6750 + RFC 9728 的 resource_metadata）。
pub fn www_authenticate(issuer: &str, err: McpAuthError) -> String {
    let meta = oauth::resource_metadata_url(issuer);
    match err {
        McpAuthError::Missing => format!(r#"Bearer resource_metadata="{meta}""#),
        McpAuthError::Invalid => format!(r#"Bearer error="invalid_token", error_description="The access token is invalid, expired or revoked", resource_metadata="{meta}""#),
    }
}

/// last_used_at 最多每分鐘寫一次（避免每個 MCP 請求都寫 DB）。/ Touch last_used_at at most once a minute.
const TOUCH_INTERVAL_SECS: i64 = 60;

/// `/mcp` 的 Bearer：OAuth access token 或個人 API token。API token 用 MCP 時「MCP app」功能也要開著
/// （那個開關的意思就是「可以接 MCP」）。/ The `/mcp` bearer: an OAuth access token or a personal API token; a token
/// used for MCP also needs the "MCP apps" feature (which means "may connect MCP").
pub async fn resolve(state: &AppState, token: &str) -> Result<McpPrincipal, McpAuthError> {
    let p = resolve_delegated(state, token).await?;
    if matches!(p.credential, Credential::Token(_)) && p.feature_denied(crate::features::Feature::McpConnect) {
        return Err(McpAuthError::Invalid);
    }
    Ok(p)
}

/// OAuth access token 或個人 API token → 呼叫者（REST extractor 與 `/mcp` 共用）。
/// An OAuth access token or a personal API token → the caller (shared by the REST extractor and `/mcp`).
pub async fn resolve_delegated(state: &AppState, token: &str) -> Result<McpPrincipal, McpAuthError> {
    if crate::auth::api_tokens::looks_like_token(token) {
        return resolve_api_token(state, token).await;
    }
    resolve_oauth(state, token).await
}

/// 個人 API token：有效的 token → 啟用中的使用者 → 兩步驟已設好 → 「API token」功能開著。
/// A personal API token: live token → active user → enrolled → the "API tokens" feature is on.
async fn resolve_api_token(state: &AppState, secret: &str) -> Result<McpPrincipal, McpAuthError> {
    let t = state.api_tokens.lookup(&state.db, secret).await.ok().flatten().ok_or(McpAuthError::Invalid)?;
    let user = db::users::by_id(&state.db, t.user_id).await.ok().flatten().ok_or(McpAuthError::Invalid)?;
    if !user.is_active {
        return Err(McpAuthError::Invalid);
    }
    if !crate::api::mfa::enrollment_missing(state, user.id).await.map(|m| m.is_empty()).unwrap_or(false) {
        return Err(McpAuthError::Invalid);
    }
    let policy = state.features.policy().await.map_err(|_| McpAuthError::Invalid)?;
    // 「API token」被關掉 = 這個人的 token 全部不能用（跟撤銷一樣）。/ API tokens turned off = every token refused.
    if !policy.allowed(&user, crate::features::Feature::ApiTokens) {
        return Err(McpAuthError::Invalid);
    }
    let denied = crate::features::Feature::ALL.into_iter().filter(|f| !policy.allowed(&user, *f)).collect();
    Ok(McpPrincipal {
        tunnel_ids: t.tunnel_id_list(),
        user,
        credential: Credential::Token(t.id),
        client_id: t.prefix.clone(),
        client_name: token_client_name(&t.name),
        scopes: t.scopes(),
        ip: None,
        denied,
    })
}

async fn resolve_oauth(state: &AppState, token: &str) -> Result<McpPrincipal, McpAuthError> {
    let claims = state.jwt.verify_mcp(token).map_err(|_| McpAuthError::Invalid)?;
    let grant = db::oauth::grant_by_id(&state.db, claims.grant_id).await.ok().flatten().ok_or(McpAuthError::Invalid)?;
    let now = chrono::Utc::now();
    if grant.user_id != claims.user_id || grant.client_id != claims.client_id || !grant.is_active(&db_time(now)) {
        return Err(McpAuthError::Invalid);
    }
    let user = db::users::by_id(&state.db, claims.user_id).await.ok().flatten().ok_or(McpAuthError::Invalid)?;
    if !user.is_active {
        return Err(McpAuthError::Invalid);
    }
    // 管理員要求的第二因素還沒設好 → 和撤銷一樣視為無效。/ Not enrolled in the required factors: treated as invalid.
    if !crate::api::mfa::enrollment_missing(state, user.id).await.map(|m| m.is_empty()).unwrap_or(false) {
        return Err(McpAuthError::Invalid);
    }
    // 功能權限：「MCP app」被關掉 = 這個人的 app 全部不能用（跟撤銷一樣）；其他功能在各個 tool 擋。
    // Feature permissions: MCP apps turned off = every app of this person is refused like a revoked one.
    let policy = state.features.policy().await.map_err(|_| McpAuthError::Invalid)?;
    if !policy.allowed(&user, crate::features::Feature::McpConnect) {
        return Err(McpAuthError::Invalid);
    }
    let denied = crate::features::Feature::ALL.into_iter().filter(|f| !policy.allowed(&user, *f)).collect();
    let client_name = db::oauth::client_by_id(&state.db, &grant.client_id).await.ok().flatten().map(|c| c.client_name).unwrap_or_default();
    let stale_before = db_time(now - chrono::Duration::seconds(TOUCH_INTERVAL_SECS));
    if grant.last_used_at.as_deref().map(|t| t < stale_before.as_str()).unwrap_or(true) {
        if let Err(e) = db::oauth::grant_touch(&state.db, grant.id).await {
            tracing::warn!(error = %e, grant_id = grant.id, "cannot update grant last_used_at");
        }
    }
    // access token 的 scope 可能比 grant 窄（refresh 時縮小過）；兩者取交集。
    // The token's scope may be narrower than the grant's (narrowed on refresh); use the intersection.
    let granted = oauth::scope_list(&grant.scope);
    let scopes = oauth::scope_list(&claims.scope).into_iter().filter(|s| granted.contains(s)).collect();
    Ok(McpPrincipal {
        tunnel_ids: grant.tunnel_id_list(),
        user,
        credential: Credential::Grant(grant.id),
        client_id: grant.client_id,
        client_name,
        scopes,
        ip: None,
        denied,
    })
}
