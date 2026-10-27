//! 個人 API token（`Authorization: Bearer tpt_…`）：給 `telepy` CLI、腳本、CI 用，不必走瀏覽器的 OAuth 同意。
//! 一把 token = 一個使用者 + 一組 scope（MCP 的 scope 加上 `tunnels:manage`）+ 可選的隧道限制 + 必填的到期時間。
//! REST extractor 與 `/mcp` 都收；REST 只開放 [`rest_route`] 列出的路由（其他一律 403 `token_route`，帳號設定、
//! 密碼、兩步驟、建立 token 本身都不在裡面），每條路由要一個 scope。撤銷立即生效：查詢結果快取 ≤ 5 秒，撤銷時清掉。
//! Personal API tokens for the `telepy` CLI, scripts and CI — no browser consent flow. A token is one user, a set of
//! scopes (the MCP scopes plus `tunnels:manage`), an optional tunnel restriction and a required expiry. Both the REST
//! extractor and `/mcp` accept it; on REST only the routes in [`rest_route`] are open (everything else, account
//! settings and token creation included, is a 403 `token_route`), each needing one scope. Revocation is immediate:
//! lookups are cached ≤ 5 s and the cache is cleared on revoke.

use std::sync::Arc;
use std::time::Duration;

use crate::db::{self, api_tokens::ApiToken, Db};

/// 祕密的前綴（祕密掃描工具用它辨識）。/ Secret prefix (lets secret scanners recognise it).
pub const PREFIX: &str = "tpt_";
/// 列表上顯示的開頭長度（含前綴）。/ Characters of the secret shown in lists (prefix included).
pub const SHOWN_PREFIX_LEN: usize = 10;
/// 最長效期。/ Longest lifetime.
pub const MAX_DAYS: i64 = 365;
/// 每人最多幾把有效的 token。/ Live tokens per person at most.
pub const MAX_PER_USER: i64 = 50;
pub const MAX_NAME_CHARS: usize = 100;
/// 查詢結果快取多久（撤銷時直接清掉，所以這只影響其他 process）。/ How long a lookup is cached.
pub const CACHE_TTL: Duration = Duration::from_secs(5);
/// 「最後使用」最多多久寫一次。/ How often last-use may be written.
pub const TOUCH_EVERY: Duration = Duration::from_secs(60);

/// token 能拿的 scope：MCP 的全部 + `tunnels:manage`（REST 的寫入：建立 / 刪除 / 分享 / 標籤 / 結束 session）。
/// Scopes a token may carry: every MCP scope plus `tunnels:manage` (REST writes).
pub const MANAGE: &str = "tunnels:manage";

pub fn all_scopes() -> Vec<&'static str> {
    crate::oauth::SCOPES.iter().map(|(n, _)| *n).chain(std::iter::once(MANAGE)).collect()
}

/// 檢查並依標準順序排好；至少一個。/ Validate and put in canonical order; at least one.
pub fn parse_scopes(requested: &[String]) -> Result<Vec<String>, String> {
    if requested.is_empty() {
        return Err("Pick at least one scope.".into());
    }
    let all = all_scopes();
    if let Some(bad) = requested.iter().find(|s| !all.contains(&s.as_str())) {
        return Err(format!("Unknown scope: {bad}"));
    }
    Ok(all.into_iter().filter(|s| requested.iter().any(|r| r == s)).map(str::to_string).collect())
}

pub fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the token a name.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("Keep the name under {MAX_NAME_CHARS} characters."));
    }
    if name.chars().any(char::is_control) {
        return Err("The name can't contain control characters.".into());
    }
    Ok(name.to_string())
}

pub fn looks_like_token(raw: &str) -> bool {
    raw.starts_with(PREFIX)
}

/// 新祕密：`tpt_` + 43 字元 base64url（256 位元）。/ A new secret: `tpt_` + 256 random bits.
pub fn new_secret() -> String {
    crate::oauth::random_token(PREFIX)
}

pub fn shown_prefix(secret: &str) -> String {
    secret.chars().take(SHOWN_PREFIX_LEN).collect()
}

// ---------------------------------------------------------------- REST routes

/// 一條路由的隧道從哪裡來（token 有隧道限制時要檢查）。/ Where a route's tunnel comes from (for restricted tokens).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelRef {
    /// 跟隧道無關（個人資料、清單——清單由 handler 照限制過濾）。/ Not about one tunnel (lists are filtered by the handler).
    None,
    /// 路徑上的隧道 id，extractor 檢查。/ The tunnel id in the path, checked by the extractor.
    Path(i64),
    /// handler 自己檢查（id 在 body，或要先查一列才知道）。/ The handler checks it (id in the body or behind a lookup).
    Handler,
    /// 只給沒有隧道限制的 token（建立隧道、帳號清單、加入裝置…）。/ Unrestricted tokens only.
    Unrestricted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenRoute {
    /// 需要的 scope；`None` = 任何 token 都行。/ The scope needed; `None` = any token.
    pub scope: Option<&'static str>,
    pub tunnel: TunnelRef,
}

/// token 能打的 REST 路由（白名單）。沒列到 = 不開放給 token。/ The REST routes a token may call (an allow-list).
pub fn rest_route(method: &str, path: &str) -> Option<TokenRoute> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    let id = |s: &str| s.parse::<i64>().ok();
    let r = |scope: &'static str, tunnel: TunnelRef| Some(TokenRoute { scope: Some(scope), tunnel });
    const READ: &str = "tunnels:read";
    const EXEC: &str = "ssh:exec";
    const FILES: &str = "ssh:files";
    const SCAN: &str = "network:scan";
    use TunnelRef::*;
    match (method, segs.as_slice()) {
        ("GET", ["api", "auth", "user", "profile"]) => Some(TokenRoute { scope: Option::None, tunnel: None }),

        // 讀：隧道、狀態、連線紀錄、帳號、ssh config、群組、區網主機、裝置身分。/ Reads.
        ("GET", ["api", "reverse", "server", "dashboard"]) => r(READ, None),
        ("GET", ["api", "reverse", "server", "keys"]) => r(READ, None),
        ("GET", ["api", "reverse", "server", "status", "ports" | "latency"]) => r(READ, None),
        ("GET", ["api", "reverse", "server", "keys", t]) => r(READ, Path(id(t)?)),
        ("GET", ["api", "reverse", "server", t, "connections" | "usernames" | "host-key"]) => r(READ, Path(id(t)?)),
        ("GET", ["api", "reverse", "server", t, "lan", "hosts"]) => r(READ, Path(id(t)?)),
        ("GET", ["tunnels", "server", "config", t]) => r(READ, Path(id(t)?)),
        ("GET", ["api", "reverse", "tunnel-groups"]) => r(READ, None),
        ("GET", ["api", "sessions"]) => r(READ, None),

        // 在裝置上跑指令：REST 版的 MCP session；錄影 = 終端機輸出，所以也算這個。/ Exec sessions; recordings are terminal output.
        ("GET" | "POST", ["api", "ai", "sessions"]) => r(EXEC, Handler),
        ("DELETE", ["api", "ai", "sessions", _]) => r(EXEC, Handler),
        ("POST", ["api", "ai", "sessions", _, "exec"]) => r(EXEC, Handler),
        ("GET", ["api", "snippets"]) => r(EXEC, None),
        ("GET", ["api", "recordings"]) => r(EXEC, Handler),
        ("GET", ["api", "recordings", _, "cast"]) => r(EXEC, Handler),

        // 檔案：SFTP 的每個操作。/ Files: every SFTP operation.
        (_, ["api", "sftp", _, t, _]) => r(FILES, Path(id(t)?)),

        ("GET" | "POST", ["api", "reverse", "server", t, "lan", "scan"]) => r(SCAN, Path(id(t)?)),

        // 管理：建立 / 改 / 刪隧道、分享、標籤、帳號、加入裝置、結束 session。/ Management writes.
        ("POST", ["api", "reverse", "server", "keys"]) => r(MANAGE, Unrestricted),
        ("PATCH" | "PUT" | "DELETE", ["api", "reverse", "server", "keys", t]) => r(MANAGE, Path(id(t)?)),
        ("GET", ["api", "reverse", "server", t, "delete-check"]) => r(MANAGE, Path(id(t)?)),
        ("PUT", ["api", "reverse", "server", t, "labels"]) => r(MANAGE, Path(id(t)?)),
        ("PUT" | "DELETE", ["api", "reverse", "server", t, "pin"]) => r(MANAGE, Path(id(t)?)),
        ("PATCH", ["api", "reverse", "server", t, "default-username"]) => r(MANAGE, Path(id(t)?)),
        ("POST", ["tunnels", "share", t]) => r(MANAGE, Path(id(t)?)),
        ("PATCH", ["tunnels", "share", t, _, "expiry" | "allowed-usernames"]) => r(MANAGE, Path(id(t)?)),
        ("PATCH", ["tunnels", "update-permission", t, _]) => r(MANAGE, Path(id(t)?)),
        ("DELETE", ["tunnels", "unshare", t, _]) => r(MANAGE, Path(id(t)?)),
        ("GET", ["tunnels", "shared-users" | "available-users", t]) => r(MANAGE, Path(id(t)?)),
        ("GET" | "POST", ["api", "reverse", "server", "usernames"]) => r(MANAGE, Unrestricted),
        ("PATCH" | "PUT" | "DELETE", ["api", "reverse", "server", "usernames", _]) => r(MANAGE, Unrestricted),
        ("POST", ["api", "reverse", "join"]) => r(MANAGE, Unrestricted),
        ("GET" | "DELETE", ["api", "reverse", "join", _]) => r(MANAGE, Unrestricted),
        ("DELETE", ["api", "sessions", _]) => r(MANAGE, Unrestricted),
        _ => Option::None,
    }
}

// ---------------------------------------------------------------- lookup

/// token 查詢快取 + 「最後使用」節流（`AppState.api_tokens`）。/ Lookup cache and last-use throttle.
pub struct TokenCache {
    /// SHA-256 → 那一列（None = 查無）。/ Hash → row (None = no such token).
    by_hash: moka::sync::Cache<String, Option<Arc<ApiToken>>>,
    touched: moka::sync::Cache<i64, ()>,
}

impl Default for TokenCache {
    fn default() -> Self {
        Self {
            by_hash: moka::sync::Cache::builder().time_to_live(CACHE_TTL).max_capacity(10_000).build(),
            touched: moka::sync::Cache::builder().time_to_live(TOUCH_EVERY).max_capacity(10_000).build(),
        }
    }
}

impl TokenCache {
    /// 祕密 → 有效的 token（未撤銷、未過期）。/ Secret → a live token.
    pub async fn lookup(&self, db: &Db, secret: &str) -> sqlx::Result<Option<Arc<ApiToken>>> {
        let hash = crate::oauth::hash_token(secret);
        let row = match self.by_hash.get(&hash) {
            Some(hit) => hit,
            None => {
                let row = db::api_tokens::by_hash(db, &hash).await?.map(Arc::new);
                self.by_hash.insert(hash, row.clone());
                row
            }
        };
        Ok(row.filter(|t| t.is_active(&crate::util::now_db())))
    }

    /// 撤銷後清快取（同一個 process 立刻生效）。/ Clear after a revocation (immediate in this process).
    pub fn invalidate(&self) {
        self.by_hash.invalidate_all();
    }

    /// 記「最後使用」（每把最多每分鐘一次）。/ Record the last use, at most once a minute per token.
    pub async fn note_use(&self, db: &Db, id: i64, ip: Option<&str>) {
        if self.touched.contains_key(&id) {
            return;
        }
        self.touched.insert(id, ());
        if let Err(e) = db::api_tokens::touch(db, id, ip).await {
            tracing::warn!(error = %e, token_id = id, "cannot update API token last_used_at");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_are_checked_and_ordered() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_scopes(&s(&["tunnels:manage", "tunnels:read"])).unwrap(), s(&["tunnels:read", "tunnels:manage"]));
        assert_eq!(parse_scopes(&s(&["ssh:exec", "ssh:exec"])).unwrap(), s(&["ssh:exec"]));
        assert!(parse_scopes(&[]).is_err());
        assert!(parse_scopes(&s(&["admin"])).is_err());
        assert!(all_scopes().contains(&"browser:use"));
    }

    #[test]
    fn names_and_secrets() {
        assert_eq!(validate_name("  ci deploy ").unwrap(), "ci deploy");
        assert!(validate_name(" ").is_err());
        assert!(validate_name(&"x".repeat(101)).is_err());
        assert!(validate_name("a\nb").is_err());
        let s = new_secret();
        assert!(looks_like_token(&s) && s.len() > 40);
        assert_eq!(shown_prefix(&s).len(), SHOWN_PREFIX_LEN);
        assert!(!looks_like_token("eyJhbGciOi"));
    }

    #[test]
    fn rest_routes_are_an_allow_list() {
        use TunnelRef::*;
        let rule = |scope: &'static str, tunnel| Some(TokenRoute { scope: Some(scope), tunnel });
        let cases: &[(&str, &str, Option<TokenRoute>)] = &[
            ("GET", "/api/auth/user/profile", Some(TokenRoute { scope: Option::None, tunnel: None })),
            ("GET", "/api/reverse/server/dashboard", rule("tunnels:read", None)),
            ("GET", "/api/reverse/server/keys/4", rule("tunnels:read", Path(4))),
            ("GET", "/tunnels/server/config/7", rule("tunnels:read", Path(7))),
            ("GET", "/api/reverse/server/7/connections", rule("tunnels:read", Path(7))),
            ("POST", "/api/ai/sessions", rule("ssh:exec", Handler)),
            ("POST", "/api/ai/sessions/ais_x/exec", rule("ssh:exec", Handler)),
            ("GET", "/api/recordings/3/cast", rule("ssh:exec", Handler)),
            ("GET", "/api/sftp/download/4/root", rule("ssh:files", Path(4))),
            ("POST", "/api/sftp/upload/4/root", rule("ssh:files", Path(4))),
            ("POST", "/api/reverse/server/4/lan/scan", rule("network:scan", Path(4))),
            ("POST", "/api/reverse/server/keys", rule("tunnels:manage", Unrestricted)),
            ("DELETE", "/api/reverse/server/keys/4", rule("tunnels:manage", Path(4))),
            ("POST", "/tunnels/share/4", rule("tunnels:manage", Path(4))),
            ("DELETE", "/api/sessions/12", rule("tunnels:manage", Unrestricted)),
            // 帳號、兩步驟、token 本身、管理員設定、網頁登入：token 不能碰。/ Never reachable with a token.
            ("POST", "/api/auth/tokens", Option::None),
            ("GET", "/api/auth/tokens", Option::None),
            ("POST", "/api/auth/mfa/totp/setup", Option::None),
            ("POST", "/api/user/settings", Option::None),
            ("GET", "/api/site/settings", Option::None),
            ("DELETE", "/api/auth/sessions", Option::None),
            ("POST", "/api/oauth/authorize", Option::None),
            ("POST", "/api/reverse/user/keys", Option::None),
            ("GET", "/api/reverse/server/abc/connections", Option::None),
            ("GET", "/api/credentials", Option::None),
        ];
        for (m, p, want) in cases {
            assert_eq!(rest_route(m, p), *want, "{m} {p}");
        }
    }
}
