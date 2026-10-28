//! OAuth 2.1 授權伺服器（給 MCP 連接器用）的純邏輯：scope、redirect URI 驗證與比對、PKCE、token 產生與雜湊、
//! issuer 推導、RFC 8414 / RFC 9728 metadata。HTTP handler 在 `api/oauth.rs`，SQL 在 `db/oauth.rs`。
//!
//! 流程：MCP 客戶端打 `/mcp` 拿到 401 + `WWW-Authenticate: Bearer resource_metadata=…` → 讀
//! `/.well-known/oauth-protected-resource` → 讀 `/.well-known/oauth-authorization-server` → `POST /api/oauth/register`
//! （RFC 7591 動態註冊）→ 把使用者帶到前端的 `/oauth/authorize` 同意頁（使用者用網頁登入狀態核可，前端呼叫
//! `POST /api/oauth/authorize` 拿 code）→ `POST /api/oauth/token`（authorization_code + PKCE S256；之後 refresh_token 輪替）。
//! Pure logic of the OAuth 2.1 authorization server used by MCP connectors (scopes, redirect URIs, PKCE,
//! token hashing, issuer derivation, discovery metadata).

use std::time::Duration;

use axum::http::{header, HeaderMap};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 支援的 scope 與說明（說明只給 API / metadata 用；同意頁的文字走前端 i18n）。
/// Supported scopes (the consent page localizes its own labels).
pub const SCOPES: &[(&str, &str)] = &[
    ("tunnels:read", "List your tunnels and see whether they are online"),
    ("ssh:exec", "Open SSH sessions to your devices and run commands"),
    ("ssh:files", "Read and write files on your devices over SFTP"),
    ("network:scan", "Discover the machines on the local networks behind your devices"),
    ("browser:use", "Browse the web through your devices with a remote browser (navigate, read pages, click, type, screenshots)"),
];

/// MCP 端點路徑（protected resource = `<issuer>/mcp`）。/ Path of the MCP endpoint.
pub const MCP_PATH: &str = "/mcp";
/// 前端的同意頁（authorization_endpoint）。/ Frontend consent page (the authorization endpoint).
pub const AUTHORIZE_PAGE: &str = "/oauth/authorize";
/// `telepy login` 換到 token 之後把瀏覽器送去的那一頁（前端，跟著授權頁的樣子）。用 metadata 的
/// `telepy_cli_done_page` 告訴 CLI；舊伺服器沒有這個欄位，CLI 就自己畫一頁。
/// Where `telepy login` sends the browser once it has its token (a frontend page in the approval page's look).
/// Announced as `telepy_cli_done_page` in the metadata; without it (older servers) the CLI draws its own page.
pub const CLI_DONE_PAGE: &str = "/oauth/done";
pub const ACCESS_TOKEN_TTL: Duration = Duration::from_secs(3600);
pub const REFRESH_TOKEN_TTL: Duration = Duration::from_secs(30 * 86400);
/// 動態註冊後一直沒換到 token 的 client 保留多久。/ How long a registered client without any grant is kept.
pub const UNUSED_CLIENT_TTL: Duration = Duration::from_secs(86400);
/// 已撤銷 / 已過期的 grant 保留多久（Connected apps 不顯示，只是延後刪除）。
pub const DEAD_GRANT_TTL: Duration = Duration::from_secs(30 * 86400);
pub const MAX_CLIENTS: i64 = 10_000;
pub const MAX_REDIRECT_URIS: usize = 10;
pub const MAX_URI_LEN: usize = 2000;
pub const MAX_CLIENT_NAME_LEN: usize = 200;

pub fn is_supported_scope(s: &str) -> bool {
    SCOPES.iter().any(|(name, _)| *name == s)
}

pub fn all_scopes() -> Vec<String> {
    SCOPES.iter().map(|(n, _)| n.to_string()).collect()
}

/// 空白分隔的 scope 字串 → 依 `SCOPES` 順序去重；空 / 缺 → 全部。未知的 scope → `Err(那個 scope)`。
/// Space-delimited scope string → canonical order, deduplicated; empty means every scope.
pub fn parse_scope(raw: Option<&str>) -> Result<Vec<String>, String> {
    let requested: Vec<&str> = raw.unwrap_or("").split_whitespace().collect();
    if requested.is_empty() {
        return Ok(all_scopes());
    }
    if let Some(bad) = requested.iter().find(|s| !is_supported_scope(s)) {
        return Err((*bad).to_string());
    }
    Ok(SCOPES.iter().map(|(n, _)| *n).filter(|n| requested.contains(n)).map(str::to_string).collect())
}

pub fn scope_string(scopes: &[String]) -> String {
    scopes.join(" ")
}

pub fn scope_list(scope: &str) -> Vec<String> {
    scope.split_whitespace().map(str::to_string).collect()
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// 註冊時檢查 redirect URI：絕對 URL、無 fragment；https、loopback 的 http（RFC 8252 §7.3），或原生 app 的
/// 私有 scheme（RFC 8252 §7.1）。拒絕 javascript/data/file 這類危險 scheme。
/// Registration-time redirect URI check: absolute, no fragment; https, loopback http, or a private-use scheme.
pub fn validate_redirect_uri(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_URI_LEN {
        return Err("redirect URI is too long".into());
    }
    let url = url::Url::parse(raw).map_err(|_| format!("redirect URI is not an absolute URL: {raw}"))?;
    if url.fragment().is_some() {
        return Err(format!("redirect URI must not contain a fragment: {raw}"));
    }
    match url.scheme() {
        "https" => {
            if url.host_str().unwrap_or("").is_empty() {
                return Err(format!("redirect URI has no host: {raw}"));
            }
            Ok(())
        }
        "http" => {
            if is_loopback_host(url.host_str().unwrap_or("")) {
                Ok(())
            } else {
                Err(format!("http redirect URIs are only allowed for localhost: {raw}"))
            }
        }
        "javascript" | "data" | "file" | "vbscript" | "blob" | "about" | "ws" | "wss" => Err(format!("redirect URI scheme is not allowed: {raw}")),
        _ => Ok(()),
    }
}

/// 授權請求的 redirect_uri 是否等於某個已註冊的值。loopback 的 http 不比 port（RFC 8252 §7.3：原生 app
/// 每次用隨機 port）。/ Exact match, except loopback http URIs where the port may differ.
pub fn redirect_matches(registered: &[String], requested: &str) -> bool {
    if registered.iter().any(|r| r == requested) {
        return true;
    }
    let Ok(req) = url::Url::parse(requested) else { return false };
    if req.scheme() != "http" || !is_loopback_host(req.host_str().unwrap_or("")) {
        return false;
    }
    registered.iter().filter_map(|r| url::Url::parse(r).ok()).any(|r| {
        r.scheme() == "http"
            && r.host_str() == req.host_str()
            && r.path() == req.path()
            && r.query() == req.query()
    })
}

/// RFC 7636 §4.1：43–128 個 unreserved 字元。/ A syntactically valid code_verifier.
pub fn valid_code_verifier(v: &str) -> bool {
    (43..=128).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

/// `BASE64URL(SHA256(verifier)) == challenge`
pub fn pkce_s256_matches(verifier: &str, challenge: &str) -> bool {
    use subtle::ConstantTimeEq;
    let computed = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    computed.len() == challenge.len() && bool::from(computed.as_bytes().ct_eq(challenge.as_bytes()))
}

/// 32 bytes 亂數的 base64url（43 字元），可加前綴方便祕密掃描辨識。/ 256-bit random token, optional prefix.
pub fn random_token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// 存進 DB 的是 SHA-256 hex（refresh token、client secret 都不存原文）。/ Tokens are stored hashed.
pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hashes_equal(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn first_header(headers: &HeaderMap, name: impl header::AsHeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
        .filter(|v| !v.is_empty())
}

/// issuer（= 對外的 base URL）：`PUBLIC_URL` 優先；否則依 X-Forwarded-Proto / X-Forwarded-Host / Host 推導
/// （與一次性腳本 URL 的規則相同）。metadata、token 的 `aud` 與 WWW-Authenticate 都用它，所以要穩定 ——
/// 正式環境建議設 PUBLIC_URL。/ Issuer = PUBLIC_URL, else derived from the forwarded headers.
pub fn issuer(public_url: Option<&str>, headers: &HeaderMap) -> String {
    if let Some(u) = public_url.map(str::trim).filter(|u| !u.is_empty()) {
        return u.trim_end_matches('/').to_string();
    }
    let scheme = first_header(headers, "x-forwarded-proto").filter(|v| v == "https").unwrap_or_else(|| "http".to_string());
    let host = first_header(headers, "x-forwarded-host").or_else(|| first_header(headers, header::HOST)).unwrap_or_else(|| "localhost".to_string());
    format!("{scheme}://{host}")
}

pub fn resource_url(issuer: &str) -> String {
    format!("{issuer}{MCP_PATH}")
}

pub fn resource_metadata_url(issuer: &str) -> String {
    format!("{issuer}/.well-known/oauth-protected-resource{MCP_PATH}")
}

/// 客戶端在 authorize / token 帶的 `resource`（RFC 8707）是否指向我們的 MCP 端點。只比路徑：反向代理後的
/// scheme/host 可能和客戶端看到的不同，而我們只有這一個 resource。/ Accept any resource whose path is /mcp.
pub fn resource_is_ours(resource: &str) -> bool {
    url::Url::parse(resource).map(|u| u.path().trim_end_matches('/') == MCP_PATH).unwrap_or(false)
}

/// RFC 8414 authorization server metadata。/ Authorization server metadata.
pub fn authorization_server_metadata(issuer: &str) -> Value {
    let auth_methods = ["none", "client_secret_post", "client_secret_basic"];
    json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}{AUTHORIZE_PAGE}"),
        "token_endpoint": format!("{issuer}/api/oauth/token"),
        "registration_endpoint": format!("{issuer}/api/oauth/register"),
        "revocation_endpoint": format!("{issuer}/api/oauth/revoke"),
        "scopes_supported": all_scopes(),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": auth_methods,
        "revocation_endpoint_auth_methods_supported": auth_methods,
        "code_challenge_methods_supported": ["S256"],
        "authorization_response_iss_parameter_supported": true,
        "telepy_cli_done_page": format!("{issuer}{CLI_DONE_PAGE}"),
    })
}

/// RFC 9728 protected resource metadata（MCP 端點）。/ Protected resource metadata for the MCP endpoint.
pub fn protected_resource_metadata(issuer: &str) -> Value {
    json!({
        "resource": resource_url(issuer),
        "authorization_servers": [issuer],
        "scopes_supported": all_scopes(),
        "bearer_methods_supported": ["header"],
        "resource_name": "Telepy",
    })
}

/// 每小時清一次沒用到的 client 與死掉的 grant。/ Hourly housekeeping of unused clients and dead grants.
pub async fn run_cleanup(db: crate::db::Db) {
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tick.tick().await;
        match crate::db::oauth::cleanup(&db).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(rows = n, "OAuth cleanup"),
            Err(e) => tracing::warn!(error = %e, "OAuth cleanup failed"),
        }
        // 個人 API token：撤銷 / 到期超過 30 天的。/ Personal API tokens dead for over 30 days.
        match crate::db::api_tokens::cleanup(&db).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(rows = n, "API token cleanup"),
            Err(e) => tracing::warn!(error = %e, "API token cleanup failed"),
        }
    }
}

/// 在 redirect URI 後面接 query 參數（保留既有 query）。/ Append query parameters to a redirect URI.
pub fn append_query(uri: &str, params: &[(&str, &str)]) -> String {
    match url::Url::parse(uri) {
        Ok(mut u) => {
            {
                let mut q = u.query_pairs_mut();
                for (k, v) in params {
                    q.append_pair(k, v);
                }
            }
            u.to_string()
        }
        Err(_) => uri.to_string(),
    }
}

/// 一個 grant 怎麼涵蓋某條隧道（刪隧道前的檢查與刪除時的處理）。/ How a grant covers one tunnel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coverage {
    /// 不限隧道（使用者看得到的全部）：刪掉一條不影響其他的。/ Unrestricted: keeps every other tunnel.
    All,
    /// 只限這一條：刪掉之後這個授權什麼都碰不到。/ Restricted to this tunnel alone: useless afterwards.
    Only,
    /// 這條加上其他 n 條：刪除時把這條從清單拿掉。/ This tunnel plus `n` others: it is dropped from the list.
    Shared(usize),
}

impl Coverage {
    pub fn as_str(self) -> &'static str {
        match self {
            Coverage::All => "all",
            Coverage::Only => "only",
            Coverage::Shared(_) => "shared",
        }
    }
}

/// `tunnel_ids`：None = 不限隧道。沒涵蓋這條隧道回 None。/ None when the grant does not cover the tunnel.
pub fn coverage(tunnel_ids: Option<&[i64]>, tunnel_id: i64) -> Option<Coverage> {
    let ids = match tunnel_ids {
        None => return Some(Coverage::All),
        Some(ids) => ids,
    };
    if !ids.contains(&tunnel_id) {
        return None;
    }
    let others: std::collections::BTreeSet<i64> = ids.iter().copied().filter(|&i| i != tunnel_id).collect();
    Some(if others.is_empty() { Coverage::Only } else { Coverage::Shared(others.len()) })
}

/// 刪隧道時能不能把整個 grant 撤銷（不只拿掉這條隧道）：自己的、管理員，或本來就只限這條（刪完也沒用了）。
/// 別人涵蓋多條隧道的授權只會拿掉這一條——不能順手斷掉他對自己其他隧道的存取。
/// Whether the delete dialog may revoke a whole grant: your own, an admin, or one limited to this tunnel.
/// Someone else's multi-tunnel grant only loses this tunnel; deleting a tunnel must not cut their other access.
pub fn may_revoke_whole(mine: bool, superuser: bool, coverage: Coverage) -> bool {
    mine || superuser || coverage == Coverage::Only
}

/// 把隧道從限制清單拿掉。/ Drop a tunnel from a restriction list.
pub fn without_tunnel(ids: &[i64], tunnel_id: i64) -> Vec<i64> {
    ids.iter().copied().filter(|&i| i != tunnel_id).collect()
}

/// 同時保留幾個 `telepy` CLI 的瀏覽器登入（每次 `telepy login` 一個 grant）；再多一個時最久沒用的那個自動登出，
/// 像 GitHub 對同一個 OAuth app 的 token 上限。同一台電腦再登入一次則在同意頁取代它先前的登入。
/// How many browser sign-ins of the `telepy` CLI one person keeps (one grant per `telepy login`); one more signs out
/// the least recently used, like GitHub's per-app token limit. Signing in again from the same computer replaces it.
pub const MAX_CLI_SIGNINS: usize = 10;

/// `telepy` CLI 註冊的名字是 `telepy CLI (<電腦>)`（`src/cli/src/oauth.rs`）→ Some(電腦，可能是空字串)；其他 app → None。
/// 名字是對方自己報的，只拿來分類與顯示（CLI 登入列在 API 頁、不混進 MCP app），不決定權限。對應前端 `lib/cliClient.ts`。
/// The CLI registers as `telepy CLI (<host>)` → Some(host, maybe empty); any other app → None. Self-declared, so it
/// only sorts and labels (CLI sign-ins live on the API page, apart from MCP apps), never grants anything.
pub fn cli_host(client_name: &str) -> Option<String> {
    let rest = client_name.trim().strip_prefix("telepy CLI")?;
    if rest.is_empty() {
        return Some(String::new());
    }
    let host = rest.strip_prefix(" (")?.strip_suffix(')')?;
    (!host.is_empty()).then(|| host.to_string())
}

/// 兩個 client 算不算「同一個 app」（同意頁的「取代先前的連線」）：同一個 client_id，或都是 CLI 而且同一台電腦——
/// CLI 每次 `telepy login` 都重新註冊，client_id 永遠不同。
/// Whether two clients are "the same app" for replacing earlier connections: the same client_id, or both the CLI
/// on the same computer (the CLI registers anew on every `telepy login`, so its client_id always differs).
pub fn same_app(a_id: &str, a_name: &str, b_id: &str, b_name: &str) -> bool {
    a_id == b_id || cli_host(a_name).is_some_and(|h| cli_host(b_name).as_deref() == Some(h.as_str()))
}

/// 超過上限要登出的 CLI 登入：`(grant id, 最後活動時間)`，新的那個一定留下，其餘依最近活動留 `keep - 1` 個。純函式。
/// CLI sign-ins over the limit, as `(grant id, last activity)`: the new one always stays, then the `keep - 1` most
/// recently active; the rest are returned (to revoke). Pure.
pub fn cli_overflow(signins: &[(i64, String)], new_id: i64, keep: usize) -> Vec<i64> {
    let mut others: Vec<&(i64, String)> = signins.iter().filter(|(id, _)| *id != new_id).collect();
    others.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)));
    others.into_iter().skip(keep.saturating_sub(1)).map(|(id, _)| *id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_coverage_of_a_tunnel() {
        assert_eq!(coverage(None, 3), Some(Coverage::All));
        assert_eq!(coverage(Some(&[3]), 3), Some(Coverage::Only));
        assert_eq!(coverage(Some(&[3, 3]), 3), Some(Coverage::Only));
        assert_eq!(coverage(Some(&[1, 3, 5, 5]), 3), Some(Coverage::Shared(2)));
        assert_eq!(coverage(Some(&[1, 5]), 3), None);
        assert_eq!(coverage(Some(&[]), 3), None);
        assert_eq!(without_tunnel(&[1, 3, 5, 3], 3), vec![1, 5]);
        assert_eq!(Coverage::Shared(1).as_str(), "shared");
        assert!(may_revoke_whole(true, false, Coverage::All));
        assert!(may_revoke_whole(false, true, Coverage::Shared(2)));
        assert!(may_revoke_whole(false, false, Coverage::Only));
        assert!(!may_revoke_whole(false, false, Coverage::Shared(1)));
        assert!(!may_revoke_whole(false, false, Coverage::All));
    }

    #[test]
    fn scopes_parse_in_canonical_order() {
        assert_eq!(parse_scope(None).unwrap(), all_scopes());
        assert_eq!(parse_scope(Some("  ")).unwrap(), all_scopes());
        assert_eq!(parse_scope(Some("ssh:files tunnels:read ssh:files")).unwrap(), vec!["tunnels:read", "ssh:files"]);
        assert_eq!(parse_scope(Some("tunnels:read admin")).unwrap_err(), "admin");
        assert_eq!(scope_list("a b"), vec!["a", "b"]);
    }

    #[test]
    fn redirect_uri_rules() {
        assert!(validate_redirect_uri("https://claude.ai/api/mcp/auth_callback").is_ok());
        assert!(validate_redirect_uri("http://localhost:33418/callback").is_ok());
        assert!(validate_redirect_uri("http://127.0.0.1/cb").is_ok());
        assert!(validate_redirect_uri("cursor://anysphere.cursor-retrieval/oauth/callback").is_ok());
        assert!(validate_redirect_uri("http://evil.example/cb").is_err());
        assert!(validate_redirect_uri("https://a.example/cb#frag").is_err());
        assert!(validate_redirect_uri("javascript:alert(1)").is_err());
        assert!(validate_redirect_uri("/relative").is_err());
    }

    #[test]
    fn loopback_redirects_ignore_the_port() {
        let reg = vec!["http://localhost:1234/callback".to_string(), "https://app.example/cb".to_string()];
        assert!(redirect_matches(&reg, "http://localhost:1234/callback"));
        assert!(redirect_matches(&reg, "http://localhost:5555/callback"));
        assert!(!redirect_matches(&reg, "http://localhost:5555/other"));
        assert!(!redirect_matches(&reg, "http://127.0.0.1:1234/callback"));
        assert!(redirect_matches(&reg, "https://app.example/cb"));
        assert!(!redirect_matches(&reg, "https://app.example/cb2"));
        assert!(!redirect_matches(&reg, "https://app.example:8443/cb"));
    }

    #[test]
    fn pkce_rfc7636_appendix_b() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert!(valid_code_verifier(verifier));
        assert!(pkce_s256_matches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!pkce_s256_matches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN"));
        assert!(!valid_code_verifier("short"));
        assert!(!valid_code_verifier(&"a".repeat(129)));
        assert!(!valid_code_verifier(&format!("{}!", "a".repeat(50))));
    }

    #[test]
    fn tokens_and_hashes() {
        let a = random_token("tpr_");
        assert!(a.starts_with("tpr_") && a.len() == 4 + 43);
        assert_ne!(a, random_token("tpr_"));
        assert_eq!(hash_token("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(hashes_equal(&hash_token("x"), &hash_token("x")));
        assert!(!hashes_equal(&hash_token("x"), &hash_token("y")));
    }

    #[test]
    fn issuer_derivation() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "backend:8000".parse().unwrap());
        assert_eq!(issuer(None, &h), "http://backend:8000");
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        h.insert("x-forwarded-host", "telepy.example.com, proxy".parse().unwrap());
        assert_eq!(issuer(None, &h), "https://telepy.example.com");
        assert_eq!(issuer(Some("https://t.example/ "), &h), "https://t.example");
        assert_eq!(resource_url("https://t.example"), "https://t.example/mcp");
        assert!(resource_is_ours("https://t.example/mcp/"));
        assert!(resource_is_ours("http://other-host:8787/mcp"));
        assert!(!resource_is_ours("https://t.example/api"));
    }

    #[test]
    fn metadata_documents() {
        let m = authorization_server_metadata("https://t.example");
        assert_eq!(m["authorization_endpoint"], "https://t.example/oauth/authorize");
        assert_eq!(m["token_endpoint"], "https://t.example/api/oauth/token");
        assert_eq!(m["code_challenge_methods_supported"], json!(["S256"]));
        assert_eq!(m["telepy_cli_done_page"], "https://t.example/oauth/done");
        let p = protected_resource_metadata("https://t.example");
        assert_eq!(p["resource"], "https://t.example/mcp");
        assert_eq!(p["authorization_servers"], json!(["https://t.example"]));
        assert_eq!(resource_metadata_url("https://t.example"), "https://t.example/.well-known/oauth-protected-resource/mcp");
    }

    #[test]
    fn query_appending_keeps_existing_params() {
        assert_eq!(append_query("https://a.example/cb?x=1", &[("code", "c d"), ("state", "s")]), "https://a.example/cb?x=1&code=c+d&state=s");
        assert_eq!(append_query("http://localhost:9/cb", &[("error", "access_denied")]), "http://localhost:9/cb?error=access_denied");
    }

    #[test]
    fn the_cli_is_recognised_by_its_registered_name() {
        assert_eq!(cli_host("telepy CLI (mac-studio.local)").as_deref(), Some("mac-studio.local"));
        assert_eq!(cli_host("  telepy CLI  ").as_deref(), Some(""));
        assert_eq!(cli_host("telepy CLI ((x))").as_deref(), Some("(x)"));
        assert_eq!(cli_host("telepy CLI ()"), None);
        assert_eq!(cli_host("telepy CLIx"), None);
        assert_eq!(cli_host("my telepy CLI (x)"), None);
        assert_eq!(cli_host("Claude Code"), None);
    }

    #[test]
    fn the_same_app_means_the_same_client_or_the_cli_on_the_same_computer() {
        assert!(same_app("a", "Cursor", "a", "Cursor"));
        assert!(!same_app("a", "Cursor", "b", "Cursor"), "two registrations of an app are two apps");
        assert!(same_app("a", "telepy CLI (mac)", "b", "telepy CLI (mac)"));
        assert!(!same_app("a", "telepy CLI (mac)", "b", "telepy CLI (pc)"));
        assert!(!same_app("a", "telepy CLI (mac)", "b", "mac"));
    }

    #[test]
    fn the_least_recently_used_cli_sign_ins_go_first() {
        let rows: Vec<(i64, String)> = vec![(1, "2026-10-01".into()), (2, "2026-10-20".into()), (3, "2026-10-10".into()), (4, "2026-10-28".into())];
        assert_eq!(cli_overflow(&rows, 4, 10), Vec::<i64>::new());
        assert_eq!(cli_overflow(&rows, 4, 3), vec![1], "the new one plus the two most recent stay");
        assert_eq!(cli_overflow(&rows, 1, 2), vec![2, 3], "the new one stays even when it is the oldest");
        assert_eq!(cli_overflow(&rows, 4, 1), vec![2, 3, 1]);
    }
}
