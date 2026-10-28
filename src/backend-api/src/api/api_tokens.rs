//! 個人 API token 的管理端點（只有網頁登入能用；token 自己不能建 token）：
//! - `POST /api/auth/tokens`：建立（帳號有第二因素時要 `reauth`）→ 祕密只回這一次
//! - `GET /api/auth/tokens`、`DELETE /api/auth/tokens/{id}`：自己的
//! - `GET /api/user/users/{id}/tokens`、`DELETE /api/user/users/{id}/tokens/{tid}`：管理員
//!
//! 撤銷立即生效（快取清掉、它開的 session 關掉）。驗證在 `auth::api_tokens` + `auth::mcp`。
//! Personal API token management (web sign-ins only — a token cannot mint tokens). Creating needs `reauth` once the
//! account has a second factor; the secret is returned once. Revocation is immediate (cache cleared, its sessions closed).

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::Body;
use crate::auth::api_tokens::{self, MAX_DAYS, MAX_PER_USER};
use crate::auth::extractor::Delegated;
use crate::auth::mcp::Credential;
use crate::auth::AuthUser;
use crate::db::{self, api_tokens::ApiToken, users::User};
use crate::error::{ApiError, ApiResult};
use crate::permissions;
use crate::state::AppState;
use crate::util::{db_time, db_to_iso_utc_z, opt_db_to_iso_utc_z};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list_mine, create))
        .routes(routes!(calls))
        .routes(routes!(catalogue))
        .routes(routes!(revoke_mine))
        .routes(routes!(list_for_user))
        .routes(routes!(revoke_for_user))
}

/// 到期時間：必填、在未來、最多一年（多給 10 分鐘，網頁送「那天結束」）。/ Required, in the future, at most a year away.
pub fn check_expiry(at: Option<chrono::DateTime<chrono::Utc>>, now: chrono::DateTime<chrono::Utc>) -> Result<chrono::DateTime<chrono::Utc>, String> {
    match at {
        None => Err("Pick when the token expires (at most a year from now).".into()),
        Some(t) if t <= now => Err("Pick a time in the future.".into()),
        Some(t) if t > now + chrono::Duration::days(MAX_DAYS) + chrono::Duration::days(1) => Err(format!("A token can be valid for at most {MAX_DAYS} days.")),
        Some(t) => Ok(t),
    }
}

pub(crate) fn summary_json(s: Option<&db::api_calls::Summary>) -> Value {
    let s = s.cloned().unwrap_or_default();
    json!({
        "calls_24h": s.calls_24h,
        "calls_7d": s.calls_7d,
        "errors_7d": s.errors_7d,
        "last_call_at": opt_db_to_iso_utc_z(&s.last_call_at),
        "last_status": s.last_status,
    })
}

async fn token_json(state: &AppState, t: &ApiToken) -> Value {
    let mut v = token_json_bare(state, t).await;
    let sums = db::api_calls::summaries(&state.db, &[t.id]).await.unwrap_or_default();
    v["calls"] = summary_json(sums.get(&t.id));
    v
}

async fn token_json_bare(state: &AppState, t: &ApiToken) -> Value {
    let now = crate::util::now_db();
    let tunnels = match t.tunnel_id_list() {
        None => Value::Null,
        Some(ids) => {
            let mut out = Vec::new();
            for id in ids {
                let name = db::tunnels::by_id(&state.db, id).await.ok().flatten().map(|t| t.host_friendly_name);
                out.push(json!({ "id": id, "name": name }));
            }
            Value::Array(out)
        }
    };
    json!({
        "id": t.id,
        "name": t.name,
        "prefix": t.prefix,
        "scopes": t.scopes(),
        "tunnels": tunnels,
        "expires_at": db_to_iso_utc_z(&t.expires_at),
        "created_at": db_to_iso_utc_z(&t.created_at),
        "last_used_at": opt_db_to_iso_utc_z(&t.last_used_at),
        "last_used_ip": t.last_used_ip,
        "revoked_at": opt_db_to_iso_utc_z(&t.revoked_at),
        "expired": t.revoked_at.is_none() && t.expires_at.as_str() <= now.as_str(),
        "active": t.is_active(&now),
        "sessions": state.ai.list().iter().filter(|s| s.credential == Credential::Token(t.id)).count(),
        "browsers": state.ai.browsers.list().iter().filter(|b| b.credential == Credential::Token(t.id)).count(),
        "call_count": t.call_count,
    })
}

async fn list_json(state: &AppState, user_id: i64) -> ApiResult<Value> {
    let tokens = db::api_tokens::for_user(&state.db, user_id).await?;
    let ids: Vec<i64> = tokens.iter().map(|t| t.id).collect();
    let sums = db::api_calls::summaries(&state.db, &ids).await?;
    let mut out = Vec::new();
    for t in &tokens {
        let mut v = token_json_bare(state, t).await;
        v["calls"] = summary_json(sums.get(&t.id));
        out.push(v);
    }
    Ok(Value::Array(out))
}

/// 撤銷一把：寫 DB、清快取、關掉它開的 session、記事件。/ Revoke one: DB, cache, its sessions, an event.
async fn revoke(state: &AppState, t: &ApiToken, by: &User) -> ApiResult<()> {
    if !db::api_tokens::revoke(&state.db, t.id).await? {
        return Ok(());
    }
    state.api_tokens.invalidate();
    let closed = crate::ai::close_for(state, Credential::Token(t.id), crate::ai::CloseReason::Revoked).await;
    let owner = if by.id == t.user_id { String::new() } else { format!(" of user #{}", t.user_id) };
    state.gateway.event("api_token", None, None, None, format!("{} revoked the API token \"{}\"{owner} ({}…; {closed} session(s) closed)", by.username, t.name, t.prefix)).await;
    Ok(())
}

fn web_only(d: &Delegated) -> ApiResult<()> {
    if d.0.is_some() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Manage API tokens in the Telepy web app.", "code": "token_route" })));
    }
    Ok(())
}

#[utoipa::path(get, path = "/api/auth/tokens", tag = "API Tokens", security(("bearer" = [])), responses((status = 200, description = "Your API tokens: live ones plus those revoked or expired in the last 30 days, newest first", body = Vec<super::schemas::ApiToken>)))]
async fn list_mine(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    // token 也能讀（唯讀、只有自己的）：`telepy api tokens`。/ Tokens may read it too (own, read-only).
    Ok(Json(list_json(&state, me.id).await?))
}

#[utoipa::path(post, path = "/api/auth/tokens", tag = "API Tokens", security(("bearer" = [])), request_body = super::schemas::ApiTokenCreate, responses(
    (status = 201, description = "Created; `secret` is shown only now", body = super::schemas::ApiTokenCreated),
    (status = 400, description = "Field errors ({field: [msg]})", body = super::schemas::ErrorBody),
    (status = 403, description = "reauth_required, or the API tokens feature is off", body = super::schemas::ErrorBody),
))]
async fn create(State(state): State<AppState>, headers: HeaderMap, AuthUser(me): AuthUser, d: Delegated, body: Body) -> ApiResult<(StatusCode, Json<Value>)> {
    web_only(&d)?;
    let body = body.0;
    let name = api_tokens::validate_name(body.get("name").and_then(Value::as_str).unwrap_or_default()).map_err(|e| ApiError::field("name", e))?;
    let requested: Vec<String> = body.get("scopes").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    let scopes = api_tokens::parse_scopes(&requested).map_err(|e| ApiError::field("scopes", e))?;
    let at = crate::expiry::parse_expiry(body.get("expires_at").unwrap_or(&Value::Null)).map_err(|e| ApiError::field("expires_at", e))?;
    let expires = check_expiry(at, chrono::Utc::now()).map_err(|e| ApiError::field("expires_at", e))?;
    let tunnel_ids: Option<Vec<i64>> = match body.get("tunnel_ids") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => {
            let mut ids: Vec<i64> = a.iter().filter_map(Value::as_i64).collect();
            ids.sort_unstable();
            ids.dedup();
            if ids.is_empty() {
                return Err(ApiError::field("tunnel_ids", "Pick at least one tunnel, or allow every tunnel."));
            }
            for id in &ids {
                let visible = match db::tunnels::by_id(&state.db, *id).await? {
                    Some(t) => permissions::effective_for(&state.db, me.id, &t).await?.is_some(),
                    None => false,
                };
                if !visible {
                    return Err(ApiError::field("tunnel_ids", format!("Tunnel {id} not found.")));
                }
            }
            Some(ids)
        }
        Some(_) => return Err(ApiError::field("tunnel_ids", "Expected a list of tunnel ids or null.")),
    };
    if db::api_tokens::active_count(&state.db, me.id).await? >= MAX_PER_USER {
        return Err(ApiError::field("name", format!("You already have {MAX_PER_USER} tokens. Revoke one first.")));
    }
    // 跟新增 passkey 一樣：有第二因素就要再確認一次是你。/ Like adding a passkey: confirm it's you once you have a factor.
    crate::api::mfa::require_reauth(&state, &headers, &me, body.get("reauth")).await?;
    let secret = api_tokens::new_secret();
    let hash = crate::oauth::hash_token(&secret);
    let prefix = api_tokens::shown_prefix(&secret);
    let scope = scopes.join(" ");
    let row = db::api_tokens::create(
        &state.db,
        db::api_tokens::NewToken { user_id: me.id, name: &name, prefix: &prefix, token_hash: &hash, scope: &scope, tunnel_ids: tunnel_ids.as_deref(), expires_at: &db_time(expires) },
    )
    .await?;
    state.api_tokens.invalidate();
    let tunnels = tunnel_ids.as_ref().map(|ids| format!("{} tunnel(s)", ids.len())).unwrap_or_else(|| "every tunnel".into());
    state.gateway.event("api_token", None, None, None, format!("{} created the API token \"{name}\" ({prefix}…; {scope}; {tunnels}; expires {})", me.username, db_to_iso_utc_z(&row.expires_at))).await;
    Ok((StatusCode::CREATED, Json(json!({ "token": token_json(&state, &row).await, "secret": secret }))))
}

#[utoipa::path(delete, path = "/api/auth/tokens/{id}", tag = "API Tokens", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 204, description = "Revoked; requests with it fail at once and its sessions are closed"), (status = 404, body = super::schemas::ErrorBody)))]
async fn revoke_mine(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    web_only(&d)?;
    let t = db::api_tokens::by_id(&state.db, id).await?.filter(|t| t.user_id == me.id).ok_or_else(ApiError::drf_not_found)?;
    revoke(&state, &t, &me).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- call log

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct CallsQuery {
    scope: Option<String>,
    token_id: Option<i64>,
    grant_id: Option<i64>,
    user_id: Option<i64>,
    /// 用帳號名找人（給 `telepy api activity --user <name>`，token 打不到使用者清單）。/ A person by username.
    username: Option<String>,
    status: Option<String>,
    method: Option<String>,
    limit: Option<i64>,
    before: Option<i64>,
}

/// 每頁預設 / 最多幾列（網頁一次加 300）。/ Rows per page by default and at most (the web adds 300 at a time).
pub const CALLS_DEFAULT_LIMIT: i64 = 300;
pub const CALLS_MAX_LIMIT: i64 = 1000;

fn call_json(c: &db::api_calls::Call, visible: Option<&std::collections::HashSet<i64>>) -> Value {
    // 「我的」：隧道名稱只給看得到那條隧道的人（被拒絕的請求可能指向別人的隧道）。/ Tunnel names only for tunnels the viewer can see.
    let tunnel = c.tunnel_id.map(|id| {
        let name = if visible.map(|v| v.contains(&id)).unwrap_or(true) { c.tunnel_name.clone() } else { None };
        json!({ "id": id, "name": name })
    });
    json!({
        "id": c.id,
        "at": db_to_iso_utc_z(&c.at),
        "user": { "id": c.user_id, "username": c.username },
        "token": c.token_id.map(|id| json!({ "id": id, "name": c.token_name, "prefix": c.token_prefix })),
        "grant_id": c.grant_id,
        "client_name": c.client_name,
        "kind": c.kind,
        "method": c.method,
        "route": c.route,
        "tunnel": tunnel,
        "status": c.status,
        "duration_ms": c.duration_ms,
        "ip": c.ip,
        "error": c.error,
    })
}

#[utoipa::path(get, path = "/api/auth/tokens/calls", tag = "API Tokens", security(("bearer" = [])), params(
    ("scope" = Option<String>, Query, description = "`mine` (default): your own calls; `all`: everyone's (admins only, else 403 admin_only)"),
    ("token_id" = Option<i64>, Query, description = "Only the calls of one personal API token"),
    ("grant_id" = Option<i64>, Query, description = "Only the calls of one connected app (OAuth grant)"),
    ("user_id" = Option<i64>, Query, description = "Only one person's calls (needs scope=all)"),
    ("username" = Option<String>, Query, description = "Only one person's calls, by username (needs scope=all; 400 when there is no such user)"),
    ("status" = Option<String>, Query, description = "ok (< 400), 4xx, 5xx or error (≥ 400)"),
    ("method" = Option<String>, Query, description = "GET, POST, PUT, PATCH, DELETE, or MCP (tool calls)"),
    ("limit" = Option<i64>, Query, description = "Rows, newest first (default 300, max 1000)"),
    ("before" = Option<i64>, Query, description = "Only rows with an id below this (page back)"),
), responses(
    (status = 200, description = "Calls made with personal API tokens and connected apps' tokens (REST requests, reads included, and MCP tool calls of personal tokens), newest first. Route templates, never query strings", body = super::schemas::ApiCallPage),
    (status = 400, body = super::schemas::ErrorBody),
    (status = 403, description = "admin_only (scope=all without being an admin)", body = super::schemas::ErrorBody),
))]
async fn calls(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, Query(q): Query<CallsQuery>) -> ApiResult<Json<Value>> {
    // token 也能讀自己的（`telepy api activity`）；`scope=all` 照樣只給管理員。/ Tokens may read their own; `all` stays admin-only.
    let scope = super::ViewScope::parse(q.scope.as_deref(), me.is_superuser)?;
    let by_name = match q.username.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        None => None,
        Some(name) => Some(db::users::by_username(&state.db, name).await?.ok_or_else(|| ApiError::bad_request(format!("no user called {name}")))?.id),
    };
    let wanted = by_name.or(q.user_id);
    let user_id = match scope {
        super::ViewScope::Mine => {
            if wanted.is_some_and(|u| u != me.id) {
                return Err(ApiError::bad_request("user_id needs scope=all"));
            }
            Some(me.id)
        }
        super::ViewScope::All => wanted,
    };
    let status = match q.status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(raw) => Some(db::api_calls::StatusFilter::parse(raw).ok_or_else(|| ApiError::bad_request("status must be ok, 4xx, 5xx or error"))?),
    };
    let filter = db::api_calls::Filter {
        user_id,
        token_id: q.token_id,
        grant_id: q.grant_id,
        status,
        method: q.method.filter(|m| !m.trim().is_empty()),
        before: q.before,
        limit: q.limit.unwrap_or(CALLS_DEFAULT_LIMIT).clamp(1, CALLS_MAX_LIMIT),
    };
    let rows = db::api_calls::list(&state.db, &filter).await?;
    let visible: Option<std::collections::HashSet<i64>> = match scope {
        super::ViewScope::All => None,
        super::ViewScope::Mine => {
            // 限定隧道的 token：只給它那幾條的名稱。/ A tunnel-limited token only gets the names of its own tunnels.
            let limit = d.0.as_ref().and_then(|p| p.tunnel_ids.clone());
            Some(db::tunnels::visible_to(&state.db, me.id).await?.iter().map(|t| t.id).filter(|id| limit.as_ref().is_none_or(|l| l.contains(id))).collect())
        }
    };
    let has_more = rows.len() as i64 == filter.limit;
    Ok(Json(json!({
        "calls": rows.iter().map(|c| call_json(c, visible.as_ref())).collect::<Vec<_>>(),
        "limit": filter.limit,
        "has_more": has_more,
        // 寫入佇列滿了而丟掉的筆數（啟動以來，全站）：管理員才看得到。/ Calls dropped because the queue was full (admins).
        "dropped": if me.is_superuser { json!(state.api_calls.dropped()) } else { Value::Null },
    })))
}

// ---------------------------------------------------------------- reachable endpoints

/// OpenAPI 的每個操作：(方法, 路徑樣板, tag, 摘要)。從 `app::openapi()` 算一次。
/// Every OpenAPI operation as (method, path template, tag, summary), computed once from `app::openapi()`.
fn openapi_ops() -> &'static [(String, String, String, String)] {
    static OPS: std::sync::OnceLock<Vec<(String, String, String, String)>> = std::sync::OnceLock::new();
    OPS.get_or_init(|| {
        let doc = crate::app::openapi();
        let mut out = Vec::new();
        for (path, item) in &doc.paths.paths {
            let ops = [("GET", &item.get), ("POST", &item.post), ("PUT", &item.put), ("PATCH", &item.patch), ("DELETE", &item.delete)];
            for (m, op) in ops {
                let Some(op) = op else { continue };
                let tag = op.tags.as_ref().and_then(|t| t.first().cloned()).unwrap_or_default();
                let first_ok = op.responses.responses.iter().find(|(code, _)| code.starts_with('2')).and_then(|(_, r)| match r {
                    utoipa::openapi::RefOr::T(r) => Some(r.description.clone()),
                    _ => None,
                });
                // 回應說明是英文且具體；doc comment 是中英混寫，只取英文那半。/ Response descriptions are English and
                // specific; doc comments mix Chinese and English, so only their English half is used.
                let summary = [first_ok, op.summary.as_deref().and_then(english_part), op.description.as_deref().and_then(english_part)]
                    .into_iter()
                    .flatten()
                    .find(|s| !s.trim().is_empty())
                    .unwrap_or_default();
                out.push((m.to_string(), path.clone(), tag, summary));
            }
        }
        out
    })
}

/// 中英混寫的說明 → 英文的那一段（`中文。/ English.` 取斜線後；全是中文 = None）。
/// A bilingual doc line → its English part (after the slash in `中文。/ English.`; all-Chinese = None).
pub fn english_part(text: &str) -> Option<String> {
    let cjk = |s: &str| s.chars().any(|c| ('\u{3000}'..='\u{9fff}').contains(&c) || ('\u{ff00}'..='\u{ffef}').contains(&c));
    let line = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
    if !cjk(&line) {
        return (!line.is_empty()).then_some(line);
    }
    let tail = line.rsplit_once(" / ").or_else(|| line.rsplit_once("/ ")).map(|(_, t)| t.trim().to_string())?;
    (!tail.is_empty() && !cjk(&tail)).then_some(tail)
}

/// (方法, 路徑樣板)：白名單漂移測試用。/ (method, path template) pairs, for the allow-list drift test.
pub fn operations() -> Vec<(String, String)> {
    openapi_ops().iter().map(|(m, p, _, _)| (m.clone(), p.clone())).collect()
}

/// 一個操作在目錄裡的樣子（純函式：白名單 + 功能表）。/ One operation as the catalogue shows it (pure).
pub fn catalogue_entry(method: &str, path: &str, tag: &str, summary: &str) -> Value {
    let sample = api_tokens::sample_path(path);
    let route = api_tokens::matching_rule(method, &sample).map(|(r, _)| r);
    json!({
        "method": method,
        "path": path,
        "tag": tag,
        "summary": summary,
        "token": route.is_some(),
        "scope": route.and_then(|r| r.scope),
        "tunnel": route.map(|r| r.tunnel.as_str()),
        "feature": crate::features::for_route(method, &sample).map(|f| f.id()),
    })
}

#[utoipa::path(get, path = "/api/auth/tokens/routes", tag = "API Tokens", security(("bearer" = [])), responses(
    (status = 200, description = "Every documented endpoint with whether an API token may call it, the scope it needs, where its tunnel restriction is checked (path / handler / unrestricted / none) and its feature gate — built from the same allow-list the server enforces", body = super::schemas::ApiRouteCatalogue),
))]
async fn catalogue(State(state): State<AppState>, headers: HeaderMap, AuthUser(_me): AuthUser, d: Delegated) -> ApiResult<Json<Value>> {
    web_only(&d)?;
    let routes: Vec<Value> = openapi_ops().iter().map(|(m, p, t, s)| catalogue_entry(m, p, t, s)).collect();
    Ok(Json(json!({
        "base_url": crate::oauth::issuer(state.config.public_url.as_deref(), &headers),
        "scopes": api_tokens::all_scopes(),
        "routes": routes,
    })))
}

fn admin_only(me: &User) -> ApiResult<()> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can manage other people's API tokens."));
    }
    Ok(())
}

#[utoipa::path(get, path = "/api/user/users/{id}/tokens", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 200, description = "That user's API tokens (admins only)", body = Vec<super::schemas::ApiToken>), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn list_for_user(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    web_only(&d)?;
    admin_only(&me)?;
    db::users::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    Ok(Json(list_json(&state, id).await?))
}

#[utoipa::path(delete, path = "/api/user/users/{id}/tokens/{tid}", tag = "User Management", security(("bearer" = [])), params(("id" = i64, Path), ("tid" = i64, Path, description = "Token id")), responses((status = 204, description = "Revoked"), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn revoke_for_user(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, Path((id, tid)): Path<(i64, i64)>) -> ApiResult<StatusCode> {
    web_only(&d)?;
    admin_only(&me)?;
    let t = db::api_tokens::by_id(&state.db, tid).await?.filter(|t| t.user_id == id).ok_or_else(ApiError::drf_not_found)?;
    revoke(&state, &t, &me).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_is_required_and_bounded() {
        let now = chrono::Utc::now();
        assert!(check_expiry(None, now).is_err());
        assert!(check_expiry(Some(now - chrono::Duration::minutes(1)), now).is_err());
        assert!(check_expiry(Some(now + chrono::Duration::days(366) + chrono::Duration::hours(1)), now).is_err());
        assert!(check_expiry(Some(now + chrono::Duration::days(365)), now).is_ok());
        assert!(check_expiry(Some(now + chrono::Duration::days(30)), now).is_ok());
    }

    #[test]
    fn summaries_keep_the_english_half() {
        assert_eq!(english_part("List the tunnels").as_deref(), Some("List the tunnels"));
        assert_eq!(english_part("列出隧道。/ List the tunnels.").as_deref(), Some("List the tunnels."));
        assert_eq!(english_part("UserProfileView：基本資料 + 個人設定。"), None);
        assert_eq!(english_part(""), None);
    }

    #[test]
    fn the_catalogue_follows_the_allow_list_and_features() {
        let e = catalogue_entry("GET", "/api/reverse/server/{id}/lan/hosts", "LAN", "x");
        assert_eq!((e["token"].as_bool(), e["scope"].as_str(), e["tunnel"].as_str(), e["feature"].as_str()), (Some(true), Some("tunnels:read"), Some("path"), Some("network")));
        let e = catalogue_entry("POST", "/api/browser/sessions/{id}/click", "", "");
        assert_eq!((e["scope"].as_str(), e["tunnel"].as_str(), e["feature"].as_str()), (Some("browser:use"), Some("handler"), Some("remote_browser")));
        let e = catalogue_entry("POST", "/api/auth/tokens", "", "");
        assert_eq!((e["token"].as_bool(), e["scope"].is_null(), e["feature"].as_str()), (Some(false), true, Some("api.tokens")));
        let e = catalogue_entry("GET", "/api/auth/user/profile", "", "");
        assert_eq!((e["token"].as_bool(), e["scope"].is_null(), e["tunnel"].as_str()), (Some(true), true, Some("none")));
        // 目錄涵蓋每一個 OpenAPI 操作，而且至少一些是 token 能打的。/ It covers every operation, some reachable.
        let ops = openapi_ops();
        assert!(ops.len() > 100);
        assert!(ops.iter().filter(|(m, p, t, s)| catalogue_entry(m, p, t, s)["token"] == true).count() > 40);
    }
}
