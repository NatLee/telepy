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

/// 白名單的一列：方法（`GET|POST`，`*` = 任何）、路徑樣式（每段：字面、`a|b` 擇一、`{t}` = 隧道 id（整數）、`*` = 任一段）、
/// 需要的 scope（`None` = 任何 token）、隧道從哪裡來。表格化讓 [`routes_catalogue`] 與「每列都對得到 OpenAPI 路徑」的測試
/// 能逐列檢查。/ One allow-list row: methods (`*` = any), a path pattern (per segment: a literal, `a|b`, `{t}` = the
/// tunnel id (an integer) or `*` = any segment), the scope (`None` = any token) and where the tunnel comes from. Kept as a
/// table so the catalogue and the "every row matches an OpenAPI path" test can walk it.
#[derive(Debug, Clone, Copy)]
pub struct RouteRule {
    pub methods: &'static str,
    pub pattern: &'static str,
    pub scope: Option<&'static str>,
    pub tunnel: TunnelFrom,
}

/// [`TunnelRef`] 的「種類」（表格用，沒有 id）。/ The kind of [`TunnelRef`], without the id (for the table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelFrom {
    None,
    Path,
    Handler,
    Unrestricted,
}

impl TunnelFrom {
    pub fn as_str(self) -> &'static str {
        match self {
            TunnelFrom::None => "none",
            TunnelFrom::Path => "path",
            TunnelFrom::Handler => "handler",
            TunnelFrom::Unrestricted => "unrestricted",
        }
    }
}

const READ: &str = "tunnels:read";
const EXEC: &str = "ssh:exec";
const FILES: &str = "ssh:files";
const SCAN: &str = "network:scan";
const BROWSER: &str = "browser:use";

const fn rule(methods: &'static str, pattern: &'static str, scope: &'static str, tunnel: TunnelFrom) -> RouteRule {
    RouteRule { methods, pattern, scope: Some(scope), tunnel }
}

/// token 能打的 REST 路由（白名單，第一個符合的算數）。沒列到 = 不開放給 token。
/// The REST routes a token may call (an allow-list; the first matching row wins). Anything else is closed to tokens.
pub const ROUTES: &[RouteRule] = {
    use TunnelFrom::*;
    &[
        RouteRule { methods: "GET", pattern: "/api/auth/user/profile", scope: Option::None, tunnel: None },
        // 自己的 token 清單與呼叫紀錄（唯讀；`telepy api tokens` / `api activity`）。建立 / 撤銷仍只限網頁登入。
        // Your own tokens and call log, read-only (`telepy api tokens` / `api activity`); create / revoke stay web-only.
        RouteRule { methods: "GET", pattern: "/api/auth/tokens", scope: Option::None, tunnel: None },
        RouteRule { methods: "GET", pattern: "/api/auth/tokens/calls", scope: Option::None, tunnel: None },
        // 讀：隧道、狀態、連線紀錄、帳號、ssh config、群組、區網主機、裝置身分。/ Reads.
        rule("GET", "/api/reverse/server/dashboard", READ, None),
        rule("GET", "/api/reverse/server/keys", READ, None),
        rule("GET", "/api/reverse/server/status/ports|latency", READ, None),
        rule("GET", "/api/reverse/server/keys/{t}", READ, Path),
        rule("GET", "/api/reverse/server/{t}/connections|usernames|host-key|device-install", READ, Path),
        rule("GET", "/api/reverse/server/{t}/lan/hosts", READ, Path),
        rule("GET", "/api/reverse/lan/topology", READ, None),
        rule("GET", "/tunnels/server/config/{t}", READ, Path),
        rule("GET", "/api/reverse/tunnel-groups", READ, None),
        rule("GET", "/api/sessions", READ, None),
        // 在裝置上跑指令：REST 版的 MCP session；錄影 = 終端機輸出，所以也算這個。/ Exec sessions; recordings are terminal output.
        rule("GET|POST", "/api/ai/sessions", EXEC, Handler),
        rule("DELETE", "/api/ai/sessions/*", EXEC, Handler),
        rule("POST", "/api/ai/sessions/*/exec", EXEC, Handler),
        rule("GET", "/api/snippets", EXEC, None),
        rule("GET", "/api/recordings", EXEC, Handler),
        rule("GET", "/api/recordings/*/cast", EXEC, Handler),
        // 檔案：SFTP 的每個操作。/ Files: every SFTP operation.
        rule("*", "/api/sftp/*/{t}/*", FILES, Path),
        rule("GET|POST", "/api/reverse/server/{t}/lan/scan", SCAN, Path),
        // 瀏覽器：REST 版的 MCP browser_*（session 只屬於開它的那把，隧道在開的時候檢查）。/ Scripted browsers.
        rule("GET|POST", "/api/browser/sessions", BROWSER, Handler),
        rule("DELETE", "/api/browser/sessions/*", BROWSER, Handler),
        rule("POST", "/api/browser/sessions/*/navigate|click|type", BROWSER, Handler),
        rule("GET", "/api/browser/sessions/*/text|screenshot", BROWSER, Handler),
        // 管理：建立 / 改 / 刪隧道、分享、標籤、帳號、區網主機、加入裝置、結束 session。/ Management writes.
        rule("POST", "/api/reverse/server/keys", MANAGE, Unrestricted),
        rule("PATCH|PUT|DELETE", "/api/reverse/server/keys/{t}", MANAGE, Path),
        rule("GET", "/api/reverse/server/{t}/delete-check", MANAGE, Path),
        // 裝置上的服務：盤點、改名（刪隧道本來就能移除它，所以同一個 scope）。/ The device's service: survey, rename.
        rule("POST", "/api/reverse/server/{t}/device-install/survey|rename|tidy|switch", MANAGE, Path),
        rule("PUT", "/api/reverse/server/{t}/labels", MANAGE, Path),
        rule("PUT|DELETE", "/api/reverse/server/{t}/pin", MANAGE, Path),
        rule("PATCH", "/api/reverse/server/{t}/default-username", MANAGE, Path),
        rule("POST", "/api/reverse/server/{t}/lan/hosts", MANAGE, Path),
        rule("PATCH|DELETE", "/api/reverse/server/{t}/lan/hosts/*", MANAGE, Path),
        rule("POST", "/tunnels/share/{t}", MANAGE, Path),
        rule("PATCH", "/tunnels/share/{t}/*/expiry|allowed-usernames", MANAGE, Path),
        rule("PATCH", "/tunnels/update-permission/{t}/*", MANAGE, Path),
        rule("DELETE", "/tunnels/unshare/{t}/*", MANAGE, Path),
        rule("GET", "/tunnels/shared-users|available-users/{t}", MANAGE, Path),
        rule("GET|POST", "/api/reverse/server/usernames", MANAGE, Unrestricted),
        rule("PATCH|PUT|DELETE", "/api/reverse/server/usernames/*", MANAGE, Unrestricted),
        rule("POST", "/api/reverse/join", MANAGE, Unrestricted),
        rule("GET|DELETE", "/api/reverse/join/*", MANAGE, Unrestricted),
        rule("DELETE", "/api/sessions/*", MANAGE, Unrestricted),
    ]
};

impl RouteRule {
    fn allows_method(&self, method: &str) -> bool {
        self.methods == "*" || self.methods.split('|').any(|m| m == method)
    }

    /// 路徑符合嗎；符合時回 `{t}` 那段的隧道 id（沒有就 None）。/ Whether the path matches; with the `{t}` tunnel id.
    fn match_path(&self, path: &str) -> Option<Option<i64>> {
        let want: Vec<&str> = self.pattern.trim_matches('/').split('/').collect();
        let got: Vec<&str> = path.trim_matches('/').split('/').collect();
        if want.len() != got.len() {
            return Option::None;
        }
        let mut tunnel = Option::None;
        for (w, g) in want.iter().zip(&got) {
            match *w {
                "*" => {}
                "{t}" => tunnel = Some(g.parse::<i64>().ok()?),
                alts => {
                    if !alts.split('|').any(|a| a == *g) {
                        return Option::None;
                    }
                }
            }
        }
        Some(tunnel)
    }
}

/// 這個請求符合哪一列（第一個）。/ The first allow-list row matching a request.
pub fn matching_rule(method: &str, path: &str) -> Option<(&'static RouteRule, Option<i64>)> {
    ROUTES.iter().find_map(|r| if r.allows_method(method) { r.match_path(path).map(|t| (r, t)) } else { Option::None })
}

/// token 能打的 REST 路由（白名單）。沒列到 = 不開放給 token。/ The REST routes a token may call (an allow-list).
pub fn rest_route(method: &str, path: &str) -> Option<TokenRoute> {
    let (r, id) = matching_rule(method, path)?;
    let tunnel = match r.tunnel {
        TunnelFrom::None => TunnelRef::None,
        TunnelFrom::Path => TunnelRef::Path(id?),
        TunnelFrom::Handler => TunnelRef::Handler,
        TunnelFrom::Unrestricted => TunnelRef::Unrestricted,
    };
    Some(TokenRoute { scope: r.scope, tunnel })
}

/// OpenAPI 路徑樣板 → 一個符合它的具體路徑（每個 `{參數}` 換成 `1`），拿來問 [`rest_route`] / `features::for_route`。
/// An OpenAPI path template → a concrete path for it (every `{param}` becomes `1`), to ask the matchers.
pub fn sample_path(template: &str) -> String {
    template.split('/').map(|seg| if seg.starts_with('{') && seg.ends_with('}') { "1" } else { seg }).collect::<Vec<_>>().join("/")
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
            ("GET", "/api/reverse/server/7/device-install", rule("tunnels:read", Path(7))),
            ("POST", "/api/reverse/server/7/device-install/survey", rule("tunnels:manage", Path(7))),
            ("POST", "/api/reverse/server/7/device-install/rename", rule("tunnels:manage", Path(7))),
            ("POST", "/api/reverse/server/7/device-install/tidy", rule("tunnels:manage", Path(7))),
            ("POST", "/api/reverse/server/7/device-install/switch", rule("tunnels:manage", Path(7))),
            ("POST", "/api/ai/sessions", rule("ssh:exec", Handler)),
            ("POST", "/api/ai/sessions/ais_x/exec", rule("ssh:exec", Handler)),
            ("GET", "/api/recordings/3/cast", rule("ssh:exec", Handler)),
            ("GET", "/api/sftp/download/4/root", rule("ssh:files", Path(4))),
            ("POST", "/api/sftp/upload/4/root", rule("ssh:files", Path(4))),
            ("POST", "/api/reverse/server/4/lan/scan", rule("network:scan", Path(4))),
            ("GET", "/api/reverse/lan/topology", rule("tunnels:read", None)),
            ("POST", "/api/reverse/server/4/lan/hosts", rule("tunnels:manage", Path(4))),
            ("PATCH", "/api/reverse/server/4/lan/hosts/9", rule("tunnels:manage", Path(4))),
            ("DELETE", "/api/reverse/server/4/lan/hosts/9", rule("tunnels:manage", Path(4))),
            ("GET", "/api/reverse/server/4/lan/hosts", rule("tunnels:read", Path(4))),
            ("POST", "/api/browser/sessions", rule("browser:use", Handler)),
            ("GET", "/api/browser/sessions", rule("browser:use", Handler)),
            ("POST", "/api/browser/sessions/aib_x/navigate", rule("browser:use", Handler)),
            ("GET", "/api/browser/sessions/aib_x/screenshot", rule("browser:use", Handler)),
            ("DELETE", "/api/browser/sessions/aib_x", rule("browser:use", Handler)),
            ("GET", "/api/browser/sessions/aib_x/navigate", Option::None),
            ("POST", "/api/reverse/server/keys", rule("tunnels:manage", Unrestricted)),
            ("DELETE", "/api/reverse/server/keys/4", rule("tunnels:manage", Path(4))),
            ("POST", "/tunnels/share/4", rule("tunnels:manage", Path(4))),
            ("DELETE", "/api/sessions/12", rule("tunnels:manage", Unrestricted)),
            // 帳號、兩步驟、token 本身、管理員設定、網頁登入：token 不能碰。/ Never reachable with a token.
            ("GET", "/api/auth/tokens", Some(TokenRoute { scope: Option::None, tunnel: None })),
            ("GET", "/api/auth/tokens/calls", Some(TokenRoute { scope: Option::None, tunnel: None })),
            ("POST", "/api/auth/tokens", Option::None),
            ("DELETE", "/api/auth/tokens/3", Option::None),
            ("GET", "/api/auth/tokens/routes", Option::None),
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

    /// 白名單的每一列（每個方法 × 每個擇一的字面）都要對得到一個真的 OpenAPI 操作：路由改名或刪掉時，白名單不能留著死列。
    /// Every allow-list row (each method × each literal alternative) must match a real OpenAPI operation, so a renamed
    /// or removed route can't leave a dead row behind.
    #[test]
    fn every_allow_list_row_matches_an_openapi_operation() {
        let ops = crate::api::api_tokens::operations();
        let mut missing = Vec::new();
        for r in ROUTES {
            // 把 `a|b` 展開成每一種組合。/ Expand `a|b` into every combination.
            let mut paths = vec![String::new()];
            for seg in r.pattern.trim_matches('/').split('/') {
                let alts: Vec<&str> = if seg == "{t}" || seg == "*" { vec![seg] } else { seg.split('|').collect() };
                paths = paths.iter().flat_map(|p| alts.iter().map(move |a| format!("{p}/{a}"))).collect();
            }
            let methods: Vec<&str> = if r.methods == "*" { vec!["*"] } else { r.methods.split('|').collect() };
            for m in &methods {
                for concrete in &paths {
                    let one = RouteRule { methods: m, pattern: Box::leak(concrete.clone().into_boxed_str()), ..*r };
                    let hit = ops.iter().any(|(om, tpl)| (m == &"*" || om == m) && one.match_path(&sample_path(tpl)).is_some());
                    if !hit {
                        missing.push(format!("{m} {concrete}"));
                    }
                }
            }
        }
        assert!(missing.is_empty(), "allow-list rows without an OpenAPI operation: {missing:#?}");
    }
}
