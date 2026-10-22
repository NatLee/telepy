//! MCP 端點的 Bearer 驗證：OAuth access token（JWT）→ grant（未撤銷、未過期）→ 使用者（仍啟用）。
//! 每次請求都查 grant，所以撤銷立即生效（不必等 1 小時的 access token 過期）。
//! Bearer check for the MCP endpoint: access token → live grant → active user. The grant is looked up on
//! every request, so revoking it takes effect immediately rather than when the access token expires.

use crate::db::{self, users::User};
use crate::oauth;
use crate::state::AppState;
use crate::util::db_time;

/// 一個已驗證的 MCP 呼叫者：哪個使用者、透過哪個 grant（哪個 app）、允許哪些 scope 與隧道。
#[derive(Debug, Clone)]
pub struct McpPrincipal {
    pub user: User,
    pub grant_id: i64,
    pub client_id: String,
    pub client_name: String,
    pub scopes: Vec<String>,
    /// None = 使用者看得到的全部隧道。/ None = every tunnel the user can see.
    pub tunnel_ids: Option<Vec<i64>>,
    /// 這次 MCP 請求的來源 IP（AI app 的出口）；由 `/mcp` 中介層填。/ Client IP of this MCP request.
    pub ip: Option<String>,
}

impl McpPrincipal {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
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

pub async fn resolve(state: &AppState, token: &str) -> Result<McpPrincipal, McpAuthError> {
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
        grant_id: grant.id,
        client_id: grant.client_id,
        client_name,
        scopes,
        ip: None,
    })
}
