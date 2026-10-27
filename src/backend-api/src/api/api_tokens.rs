//! 個人 API token 的管理端點（只有網頁登入能用；token 自己不能建 token）：
//! - `POST /api/auth/tokens`：建立（帳號有第二因素時要 `reauth`）→ 祕密只回這一次
//! - `GET /api/auth/tokens`、`DELETE /api/auth/tokens/{id}`：自己的
//! - `GET /api/user/users/{id}/tokens`、`DELETE /api/user/users/{id}/tokens/{tid}`：管理員
//!
//! 撤銷立即生效（快取清掉、它開的 session 關掉）。驗證在 `auth::api_tokens` + `auth::mcp`。
//! Personal API token management (web sign-ins only — a token cannot mint tokens). Creating needs `reauth` once the
//! account has a second factor; the secret is returned once. Revocation is immediate (cache cleared, its sessions closed).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
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

async fn token_json(state: &AppState, t: &ApiToken) -> Value {
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
    })
}

async fn list_json(state: &AppState, user_id: i64) -> ApiResult<Value> {
    let mut out = Vec::new();
    for t in db::api_tokens::for_user(&state.db, user_id).await? {
        out.push(token_json(state, &t).await);
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
async fn list_mine(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated) -> ApiResult<Json<Value>> {
    web_only(&d)?;
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
}
