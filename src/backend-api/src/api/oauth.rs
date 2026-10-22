//! OAuth 2.1 授權伺服器端點（MCP 連接器用；邏輯見 `oauth/mod.rs`）：
//! - `GET /.well-known/oauth-authorization-server`（RFC 8414）、`GET /.well-known/oauth-protected-resource[/mcp]`（RFC 9728）
//! - `POST /api/oauth/register`（RFC 7591 動態註冊，公開）
//! - `GET|POST /api/oauth/authorize`（前端同意頁用；要網頁登入）：GET 驗證請求並回顯示資料，POST 核可/拒絕 → `{redirect_to}`
//! - `POST /api/oauth/token`（authorization_code + PKCE S256、refresh_token 輪替）、`POST /api/oauth/revoke`（RFC 7009）
//! - `GET /api/oauth/grants`、`DELETE /api/oauth/grants/{id}`：Connected apps（列出 / 撤銷）
//!
//! 錯誤形狀依 OAuth 規格：`{"error": "<code>", "error_description": "..."}`。
//! OAuth 2.1 authorization-server endpoints; errors use the OAuth `{error, error_description}` shape.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, oauth::Client};
use crate::error::{ApiError, ApiResult};
use crate::oauth::{self, SCOPES};
use crate::permissions;
use crate::state::AppState;
use crate::tokens::OAuthCode;
use crate::util::{db_time, db_to_iso, opt_db_to_iso, uuid_hex};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(authorization_server_metadata))
        .routes(routes!(protected_resource_metadata))
        .routes(routes!(protected_resource_metadata_mcp))
        .routes(routes!(register))
        .routes(routes!(authorize_info, authorize_decide))
        .routes(routes!(token))
        .routes(routes!(revoke))
        .routes(routes!(list_grants))
        .routes(routes!(revoke_grant))
}

fn oauth_error(status: StatusCode, error: &str, description: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": error, "error_description": description.into() }))
}

fn issuer(state: &AppState, headers: &HeaderMap) -> String {
    oauth::issuer(state.config.public_url.as_deref(), headers)
}

// ---------------------------------------------------------------- discovery

#[utoipa::path(get, path = "/.well-known/oauth-authorization-server", tag = "OAuth", responses((status = 200, description = "RFC 8414 authorization server metadata", body = super::schemas::OAuthServerMetadata)))]
async fn authorization_server_metadata(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    Json(oauth::authorization_server_metadata(&issuer(&state, &headers)))
}

#[utoipa::path(get, path = "/.well-known/oauth-protected-resource", tag = "OAuth", responses((status = 200, description = "RFC 9728 metadata of the MCP endpoint", body = super::schemas::ProtectedResourceMetadata)))]
async fn protected_resource_metadata(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    Json(oauth::protected_resource_metadata(&issuer(&state, &headers)))
}

/// RFC 9728 §3.1：resource 有路徑時，metadata 位於 `/.well-known/oauth-protected-resource<path>`。
#[utoipa::path(get, path = "/.well-known/oauth-protected-resource/mcp", tag = "OAuth", responses((status = 200, description = "RFC 9728 metadata of the MCP endpoint (path-specific form)", body = super::schemas::ProtectedResourceMetadata)))]
async fn protected_resource_metadata_mcp(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    Json(oauth::protected_resource_metadata(&issuer(&state, &headers)))
}

// ---------------------------------------------------------------- dynamic client registration

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RegistrationRequest {
    redirect_uris: Option<Vec<String>>,
    client_name: Option<String>,
    token_endpoint_auth_method: Option<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
    scope: Option<String>,
    client_uri: Option<String>,
    logo_uri: Option<String>,
}

fn optional_https_uri(v: Option<String>, field: &str) -> Result<Option<String>, ApiError> {
    let Some(v) = v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else { return Ok(None) };
    let ok = v.len() <= oauth::MAX_URI_LEN && url::Url::parse(&v).map(|u| matches!(u.scheme(), "https" | "http")).unwrap_or(false);
    if !ok {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", format!("{field} must be an http(s) URL")));
    }
    Ok(Some(v))
}

#[utoipa::path(post, path = "/api/oauth/register", tag = "OAuth", request_body = super::schemas::ClientRegistrationRequest, responses((status = 201, body = super::schemas::ClientRegistrationResponse), (status = 400, description = "invalid_redirect_uri / invalid_client_metadata", body = super::schemas::OAuthErrorBody)))]
async fn register(State(state): State<AppState>, AppJson(req): AppJson<RegistrationRequest>) -> ApiResult<(StatusCode, Json<Value>)> {
    let redirect_uris = req.redirect_uris.unwrap_or_default();
    if redirect_uris.is_empty() {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_redirect_uri", "redirect_uris is required"));
    }
    if redirect_uris.len() > oauth::MAX_REDIRECT_URIS {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_redirect_uri", format!("at most {} redirect URIs", oauth::MAX_REDIRECT_URIS)));
    }
    for uri in &redirect_uris {
        oauth::validate_redirect_uri(uri).map_err(|e| oauth_error(StatusCode::BAD_REQUEST, "invalid_redirect_uri", e))?;
    }
    // RFC 7591 §2：沒指定時預設 client_secret_basic；MCP 的原生客戶端會明確送 "none"。
    let method = req.token_endpoint_auth_method.unwrap_or_else(|| "client_secret_basic".to_string());
    if !matches!(method.as_str(), "none" | "client_secret_post" | "client_secret_basic") {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", format!("unsupported token_endpoint_auth_method: {method}")));
    }
    let grant_types = req.grant_types.unwrap_or_else(|| vec!["authorization_code".into(), "refresh_token".into()]);
    if grant_types.is_empty() || grant_types.iter().any(|g| !matches!(g.as_str(), "authorization_code" | "refresh_token")) {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", "grant_types may only contain authorization_code and refresh_token"));
    }
    let response_types = req.response_types.unwrap_or_else(|| vec!["code".into()]);
    if response_types.iter().any(|r| r != "code") {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", "response_types may only contain code"));
    }
    if let Some(scope) = req.scope.as_deref() {
        oauth::parse_scope(Some(scope)).map_err(|s| oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", format!("unsupported scope: {s}")))?;
    }
    let client_uri = optional_https_uri(req.client_uri, "client_uri")?;
    let logo_uri = optional_https_uri(req.logo_uri, "logo_uri")?;
    let name: String = req.client_name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "MCP client".to_string());
    let name: String = name.chars().take(oauth::MAX_CLIENT_NAME_LEN).collect();
    if db::oauth::client_count(&state.db).await? >= oauth::MAX_CLIENTS {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", "too many registered clients; try again later"));
    }

    let client_id = uuid_hex();
    let secret = (method != "none").then(|| oauth::random_token("tpcs_"));
    let secret_hash = secret.as_deref().map(oauth::hash_token);
    let client = db::oauth::client_create(
        &state.db,
        db::oauth::NewClient {
            client_id: &client_id,
            client_secret_hash: secret_hash.as_deref(),
            client_name: &name,
            redirect_uris: &redirect_uris,
            token_endpoint_auth_method: &method,
            client_uri: client_uri.as_deref(),
            logo_uri: logo_uri.as_deref(),
        },
    )
    .await?;
    tracing::info!(client_id = %client.client_id, client_name = %client.client_name, method = %method, "OAuth client registered");
    let mut body = json!({
        "client_id": client.client_id,
        "client_id_issued_at": chrono::Utc::now().timestamp(),
        "client_name": client.client_name,
        "redirect_uris": redirect_uris,
        "grant_types": grant_types,
        "response_types": response_types,
        "token_endpoint_auth_method": method,
    });
    if let Some(secret) = secret {
        body["client_secret"] = json!(secret);
        body["client_secret_expires_at"] = json!(0);
    }
    if let Some(u) = client.client_uri {
        body["client_uri"] = json!(u);
    }
    if let Some(u) = client.logo_uri {
        body["logo_uri"] = json!(u);
    }
    Ok((StatusCode::CREATED, Json(body)))
}

// ---------------------------------------------------------------- authorization (consent page)

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AuthorizeParams {
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    scope: Option<String>,
    state: Option<String>,
    resource: Option<String>,
}

struct ValidAuthorize {
    client: Client,
    redirect_uri: String,
    code_challenge: String,
    scopes: Vec<String>,
    state: Option<String>,
    resource: String,
}

fn redirect_with(uri: &str, params: &[(&str, &str)], state: Option<&str>, issuer: &str) -> String {
    let mut all: Vec<(&str, &str)> = params.to_vec();
    if let Some(s) = state {
        all.push(("state", s));
    }
    all.push(("iss", issuer));
    oauth::append_query(uri, &all)
}

/// client / redirect_uri 有問題時不能導回去（RFC 6749 §4.1.2.1），其餘錯誤附上 `redirect_to`，前端顯示後讓使用者回 app。
/// Client and redirect URI errors are shown without redirecting; other errors carry a `redirect_to`.
async fn validate_authorize(state: &AppState, issuer: &str, p: &AuthorizeParams) -> Result<ValidAuthorize, ApiError> {
    let client_id = p.client_id.as_deref().filter(|c| !c.is_empty()).ok_or_else(|| oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "client_id is required"))?;
    let client = db::oauth::client_by_id(&state.db, client_id)
        .await?
        .ok_or_else(|| oauth_error(StatusCode::BAD_REQUEST, "invalid_client", "Unknown client_id. Remove the connector and add it again."))?;
    let registered = client.redirect_uri_list();
    let redirect_uri = match p.redirect_uri.as_deref().filter(|u| !u.is_empty()) {
        Some(u) if oauth::redirect_matches(&registered, u) => u.to_string(),
        Some(_) => return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "redirect_uri is not registered for this client")),
        None if registered.len() == 1 => registered[0].clone(),
        None => return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "redirect_uri is required")),
    };
    let st = p.state.as_deref();
    let fail = |error: &str, description: &str| {
        let to = redirect_with(&redirect_uri, &[("error", error), ("error_description", description)], st, issuer);
        ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": error, "error_description": description, "redirect_to": to }))
    };
    if p.response_type.as_deref() != Some("code") {
        return Err(fail("unsupported_response_type", "response_type must be code"));
    }
    let challenge = p.code_challenge.as_deref().unwrap_or("");
    if challenge.is_empty() {
        return Err(fail("invalid_request", "code_challenge is required (PKCE)"));
    }
    if p.code_challenge_method.as_deref() != Some("S256") {
        return Err(fail("invalid_request", "code_challenge_method must be S256"));
    }
    if !oauth::valid_code_verifier(challenge) {
        return Err(fail("invalid_request", "code_challenge is malformed"));
    }
    let scopes = oauth::parse_scope(p.scope.as_deref()).map_err(|s| fail("invalid_scope", &format!("unsupported scope: {s}")))?;
    let resource = match p.resource.as_deref().filter(|r| !r.is_empty()) {
        Some(r) if oauth::resource_is_ours(r) => r.to_string(),
        Some(_) => return Err(fail("invalid_target", "resource must be this server's MCP endpoint")),
        None => oauth::resource_url(issuer),
    };
    Ok(ValidAuthorize { client, redirect_uri, code_challenge: challenge.to_string(), scopes, state: p.state.clone(), resource })
}

fn scope_json(scopes: &[String]) -> Vec<Value> {
    SCOPES
        .iter()
        .filter(|(n, _)| scopes.iter().any(|s| s == n))
        .map(|(n, d)| json!({ "name": n, "description": d }))
        .collect()
}

fn redirect_host(uri: &str) -> String {
    url::Url::parse(uri)
        .map(|u| match u.host_str() {
            Some(h) => match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            },
            None => format!("{}:", u.scheme()),
        })
        .unwrap_or_default()
}

#[utoipa::path(get, path = "/api/oauth/authorize", tag = "OAuth", security(("bearer" = [])), params(
    ("response_type" = String, Query, description = "Must be `code`"),
    ("client_id" = String, Query),
    ("redirect_uri" = Option<String>, Query),
    ("code_challenge" = String, Query, description = "PKCE S256 challenge"),
    ("code_challenge_method" = String, Query, description = "Must be `S256`"),
    ("scope" = Option<String>, Query, description = "Space-delimited; empty = every scope"),
    ("state" = Option<String>, Query),
    ("resource" = Option<String>, Query, description = "RFC 8707 resource (the MCP endpoint)"),
), responses((status = 200, description = "What the consent page shows", body = super::schemas::AuthorizeInfo), (status = 400, description = "OAuth error; `redirect_to` is present when the error may be sent back to the client", body = super::schemas::OAuthErrorBody)))]
async fn authorize_info(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Query(p): Query<AuthorizeParams>) -> ApiResult<Json<Value>> {
    let iss = issuer(&state, &headers);
    let v = validate_authorize(&state, &iss, &p).await?;
    let tunnels = db::tunnels::visible_to(&state.db, user.id).await?;
    let (mine, _) = db::sharing::permission_context(&state.db, user.id).await?;
    let factors = super::mfa::factors(&state, user.id).await?;
    Ok(Json(json!({
        "client": {
            "client_id": v.client.client_id,
            "client_name": v.client.client_name,
            "client_uri": v.client.client_uri,
            "logo_uri": v.client.logo_uri,
        },
        "redirect_uri": v.redirect_uri,
        "redirect_host": redirect_host(&v.redirect_uri),
        "scopes": scope_json(&v.scopes),
        "tunnels": tunnels.iter().map(|t| {
            let eff = permissions::effective(user.id, t.user_id, mine.get(&t.id).map(String::as_str));
            json!({ "id": t.id, "name": t.host_friendly_name, "permission": eff.map(|e| e.label()) })
        }).collect::<Vec<_>>(),
        "user": { "id": user.id, "username": user.username },
        "reauth": { "required": factors.any(), "methods": factors.methods() },
    })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AuthorizeDecision {
    #[serde(flatten)]
    params: AuthorizeParams,
    approve: bool,
    /// 使用者勾選的 scope（⊆ 請求的）；缺 = 全部請求的。/ Scopes the user kept (subset of the request).
    scopes: Option<Vec<String>>,
    /// null = 全部隧道；陣列 = 只限這些。/ null = every tunnel; an array restricts the grant.
    tunnel_ids: Option<Vec<i64>>,
    /// 有第二因素的帳號核可時要再驗證（TOTP / passkey / 復原碼）。/ Step-up proof for accounts with a second factor.
    reauth: Option<Value>,
}

#[utoipa::path(post, path = "/api/oauth/authorize", tag = "OAuth", security(("bearer" = [])), request_body = super::schemas::AuthorizeDecision, responses((status = 200, description = "Where the browser goes next (the client's redirect URI with a code, or with error=access_denied)", body = super::schemas::AuthorizeRedirect), (status = 400, body = super::schemas::OAuthErrorBody)))]
async fn authorize_decide(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, AppJson(body): AppJson<AuthorizeDecision>) -> ApiResult<Json<Value>> {
    let iss = issuer(&state, &headers);
    let v = validate_authorize(&state, &iss, &body.params).await?;
    if !body.approve {
        tracing::info!(user = %user.username, client = %v.client.client_name, "OAuth authorization denied");
        let to = redirect_with(&v.redirect_uri, &[("error", "access_denied"), ("error_description", "The user denied the request")], v.state.as_deref(), &iss);
        return Ok(Json(json!({ "redirect_to": to })));
    }
    let scopes: Vec<String> = match &body.scopes {
        Some(kept) => v.scopes.iter().filter(|s| kept.contains(s)).cloned().collect(),
        None => v.scopes.clone(),
    };
    if scopes.is_empty() {
        return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_scope", "Select at least one permission"));
    }
    // 核可 = 讓 AI 拿到 SSH 權限：有 passkey / TOTP 的帳號要再驗證一次。/ Approving grants SSH access: step up.
    super::mfa::require_reauth(&state, &headers, &user, body.reauth.as_ref()).await?;
    let tunnel_ids = match body.tunnel_ids {
        None => None,
        Some(ids) => {
            if ids.is_empty() {
                return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "Select at least one tunnel"));
            }
            let visible: Vec<i64> = db::tunnels::visible_to(&state.db, user.id).await?.iter().map(|t| t.id).collect();
            if let Some(bad) = ids.iter().find(|id| !visible.contains(id)) {
                return Err(oauth_error(StatusCode::BAD_REQUEST, "invalid_request", format!("Unknown tunnel: {bad}")));
            }
            let mut ids = ids;
            ids.sort_unstable();
            ids.dedup();
            Some(ids)
        }
    };
    let code = state.tokens.issue_oauth_code(OAuthCode {
        client_id: v.client.client_id.clone(),
        redirect_uri: v.redirect_uri.clone(),
        code_challenge: v.code_challenge,
        user_id: user.id,
        scope: oauth::scope_string(&scopes),
        tunnel_ids,
        resource: v.resource,
    });
    tracing::info!(user = %user.username, client = %v.client.client_name, scope = %oauth::scope_string(&scopes), "OAuth authorization approved");
    let to = redirect_with(&v.redirect_uri, &[("code", &code)], v.state.as_deref(), &iss);
    Ok(Json(json!({ "redirect_to": to })))
}

// ---------------------------------------------------------------- token / revoke

/// token / revoke 的參數：規格是 form-urlencoded；也接受 JSON（方便測試與部分客戶端）。
/// Token-endpoint parameters: form-urlencoded per spec, JSON accepted too.
fn parse_params(headers: &HeaderMap, body: &Bytes) -> HashMap<String, String> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false);
    if is_json {
        let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        return v
            .as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| match v {
                        Value::String(s) => Some((k.clone(), s.clone())),
                        Value::Number(n) => Some((k.clone(), n.to_string())),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    url::form_urlencoded::parse(body).into_owned().collect()
}

/// `Authorization: Basic base64(urlencode(id):urlencode(secret))`（RFC 6749 §2.3.1）。
fn basic_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, encoded) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = String::from_utf8(STANDARD.decode(encoded.trim()).ok()?).ok()?;
    let (id, secret) = decoded.split_once(':')?;
    Some((urlencoding::decode(id).ok()?.into_owned(), urlencoding::decode(secret).ok()?.into_owned()))
}

fn token_error(status: StatusCode, error: &str, description: &str) -> Response {
    let mut resp = (status, Json(json!({ "error": error, "error_description": description }))).into_response();
    no_store(&mut resp);
    if status == StatusCode::UNAUTHORIZED {
        resp.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static(r#"Basic realm="telepy""#));
    }
    resp
}

fn no_store(resp: &mut Response) {
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp.headers_mut().insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
}

/// 客戶端認證：confidential client 要 secret（Basic 或 POST 皆可）；public client 只要 client_id。
/// Client authentication: confidential clients need their secret (Basic or POST); public ones only the id.
async fn authenticate_client(state: &AppState, headers: &HeaderMap, params: &HashMap<String, String>) -> Result<Client, Response> {
    let (client_id, secret) = match basic_credentials(headers) {
        Some((id, secret)) => (id, Some(secret)),
        None => (params.get("client_id").cloned().unwrap_or_default(), params.get("client_secret").cloned()),
    };
    let invalid = || token_error(StatusCode::UNAUTHORIZED, "invalid_client", "Client authentication failed");
    if client_id.is_empty() {
        return Err(invalid());
    }
    let client = match db::oauth::client_by_id(&state.db, &client_id).await {
        Ok(Some(c)) => c,
        Ok(None) => return Err(invalid()),
        Err(e) => return Err(ApiError::from(e).into_response()),
    };
    if let Some(expected) = client.client_secret_hash.as_deref() {
        match secret.as_deref() {
            Some(s) if oauth::hashes_equal(&oauth::hash_token(s), expected) => {}
            _ => return Err(invalid()),
        }
    }
    Ok(client)
}

fn token_response(state: &AppState, grant: &db::oauth::Grant, scope: &str, refresh: &str) -> Response {
    let access = state.jwt.mcp_access(grant.user_id, grant.id, &grant.client_id, scope, &grant.resource, oauth::ACCESS_TOKEN_TTL);
    let mut resp = Json(json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": oauth::ACCESS_TOKEN_TTL.as_secs(),
        "refresh_token": refresh,
        "scope": scope,
    }))
    .into_response();
    no_store(&mut resp);
    resp
}

fn refresh_expiry() -> String {
    db_time(chrono::Utc::now() + chrono::Duration::from_std(oauth::REFRESH_TOKEN_TTL).unwrap_or_default())
}

async fn user_is_active(state: &AppState, user_id: i64) -> bool {
    matches!(db::users::by_id(&state.db, user_id).await, Ok(Some(u)) if u.is_active)
}

#[utoipa::path(post, path = "/api/oauth/token", tag = "OAuth", request_body(content = super::schemas::TokenRequest, content_type = "application/x-www-form-urlencoded"), responses((status = 200, body = super::schemas::TokenResponse), (status = 400, description = "invalid_request / invalid_grant / unsupported_grant_type / invalid_scope", body = super::schemas::OAuthErrorBody), (status = 401, description = "invalid_client", body = super::schemas::OAuthErrorBody)))]
async fn token(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let params = parse_params(&headers, &body);
    let client = match authenticate_client(&state, &headers, &params).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let get = |k: &str| params.get(k).map(String::as_str).filter(|v| !v.is_empty());
    match get("grant_type") {
        Some("authorization_code") => {
            let (Some(code), Some(verifier)) = (get("code"), get("code_verifier")) else {
                return token_error(StatusCode::BAD_REQUEST, "invalid_request", "code and code_verifier are required");
            };
            let invalid_grant = |d: &str| token_error(StatusCode::BAD_REQUEST, "invalid_grant", d);
            let Some(c) = state.tokens.pop_oauth_code(code) else {
                return invalid_grant("The authorization code is invalid, expired or already used");
            };
            if c.client_id != client.client_id {
                return invalid_grant("The authorization code was issued to another client");
            }
            if get("redirect_uri").is_some_and(|u| u != c.redirect_uri) {
                return invalid_grant("redirect_uri does not match the authorization request");
            }
            if !oauth::valid_code_verifier(verifier) || !oauth::pkce_s256_matches(verifier, &c.code_challenge) {
                return invalid_grant("PKCE verification failed");
            }
            if get("resource").is_some_and(|r| !oauth::resource_is_ours(r)) {
                return token_error(StatusCode::BAD_REQUEST, "invalid_target", "resource must be this server's MCP endpoint");
            }
            if !user_is_active(&state, c.user_id).await {
                return invalid_grant("The user account is not active");
            }
            let refresh = oauth::random_token("tpr_");
            let hash = oauth::hash_token(&refresh);
            let expires = refresh_expiry();
            let grant = db::oauth::grant_create(
                &state.db,
                db::oauth::NewGrant {
                    user_id: c.user_id,
                    client_id: &c.client_id,
                    scope: &c.scope,
                    tunnel_ids: c.tunnel_ids.as_deref(),
                    resource: &c.resource,
                    refresh_token_hash: &hash,
                    refresh_expires_at: &expires,
                },
            )
            .await;
            match grant {
                Ok(g) => {
                    tracing::info!(grant_id = g.id, user_id = g.user_id, client = %client.client_name, "OAuth grant created");
                    token_response(&state, &g, &g.scope, &refresh)
                }
                Err(e) => ApiError::from(e).into_response(),
            }
        }
        Some("refresh_token") => {
            let Some(presented) = get("refresh_token") else {
                return token_error(StatusCode::BAD_REQUEST, "invalid_request", "refresh_token is required");
            };
            let invalid_grant = || token_error(StatusCode::BAD_REQUEST, "invalid_grant", "The refresh token is invalid, expired or revoked");
            let old_hash = oauth::hash_token(presented);
            let grant = match db::oauth::grant_by_refresh_hash(&state.db, &old_hash).await {
                Ok(Some(g)) => g,
                Ok(None) => return invalid_grant(),
                Err(e) => return ApiError::from(e).into_response(),
            };
            if grant.client_id != client.client_id || !grant.is_active(&crate::util::now_db()) || !user_is_active(&state, grant.user_id).await {
                return invalid_grant();
            }
            // 可以縮小 scope（不能擴大）。/ The scope may be narrowed, never widened.
            let scope = match get("scope") {
                None => grant.scope.clone(),
                Some(s) => {
                    let granted = oauth::scope_list(&grant.scope);
                    let asked = oauth::scope_list(s);
                    if asked.is_empty() || asked.iter().any(|a| !granted.contains(a)) {
                        return token_error(StatusCode::BAD_REQUEST, "invalid_scope", "The requested scope exceeds the grant");
                    }
                    oauth::scope_string(&oauth::parse_scope(Some(s)).unwrap_or_default())
                }
            };
            let refresh = oauth::random_token("tpr_");
            match db::oauth::grant_rotate_refresh(&state.db, grant.id, &old_hash, &oauth::hash_token(&refresh), &refresh_expiry()).await {
                Ok(true) => token_response(&state, &grant, &scope, &refresh),
                Ok(false) => invalid_grant(),
                Err(e) => ApiError::from(e).into_response(),
            }
        }
        Some(_) => token_error(StatusCode::BAD_REQUEST, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token"),
        None => token_error(StatusCode::BAD_REQUEST, "invalid_request", "grant_type is required"),
    }
}

/// 撤銷 grant 的共同出口（Connected apps 的 DELETE 與 RFC 7009 都走這裡）。
/// Shared revocation path (Connected apps and RFC 7009).
pub async fn revoke_grant_by_id(state: &AppState, grant_id: i64) -> sqlx::Result<()> {
    db::oauth::grant_revoke(&state.db, grant_id).await?;
    // 這個 app 開著的 SSH session 立即關掉（不等 reaper）。/ Close the app's live SSH sessions right away.
    let closed = crate::ai::close_for_grant(state, grant_id, crate::ai::CloseReason::Revoked).await;
    tracing::info!(grant_id, closed_sessions = closed, "OAuth grant revoked");
    Ok(())
}

#[utoipa::path(post, path = "/api/oauth/revoke", tag = "OAuth", request_body(content = super::schemas::RevokeRequest, content_type = "application/x-www-form-urlencoded"), responses((status = 200, description = "Always 200 for a known client (RFC 7009 §2.2), whether or not the token was valid"), (status = 401, body = super::schemas::OAuthErrorBody)))]
async fn revoke(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let params = parse_params(&headers, &body);
    let client = match authenticate_client(&state, &headers, &params).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let Some(token) = params.get("token").filter(|t| !t.is_empty()) else {
        return token_error(StatusCode::BAD_REQUEST, "invalid_request", "token is required");
    };
    // refresh token（存雜湊）或 access token（JWT 帶 grant_id）都能撤銷整個 grant。
    let grant = match db::oauth::grant_by_refresh_hash(&state.db, &oauth::hash_token(token)).await {
        Ok(Some(g)) => Some(g),
        _ => match state.jwt.verify_mcp(token) {
            Ok(claims) => db::oauth::grant_by_id(&state.db, claims.grant_id).await.ok().flatten(),
            Err(_) => None,
        },
    };
    if let Some(g) = grant.filter(|g| g.client_id == client.client_id) {
        if let Err(e) = revoke_grant_by_id(&state, g.id).await {
            return ApiError::from(e).into_response();
        }
    }
    let mut resp = Json(json!({})).into_response();
    no_store(&mut resp);
    resp
}

// ---------------------------------------------------------------- connected apps

#[utoipa::path(get, path = "/api/oauth/grants", tag = "OAuth", security(("bearer" = [])), responses((status = 200, description = "Apps the current user has authorized (active grants, newest first)", body = Vec<super::schemas::OAuthGrant>)))]
async fn list_grants(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let tz = state.config.tz_offset_minutes;
    let grants = db::oauth::active_grants_for_user(&state.db, user.id).await?;
    let mut out = Vec::with_capacity(grants.len());
    for g in grants {
        let tunnels = match g.tunnel_ids.as_deref() {
            None => Value::Null,
            Some(raw) => {
                let ids: Vec<i64> = serde_json::from_str(raw).unwrap_or_default();
                let mut list = Vec::new();
                for id in ids {
                    if let Some(t) = db::tunnels::by_id(&state.db, id).await? {
                        list.push(json!({ "id": t.id, "name": t.host_friendly_name }));
                    }
                }
                Value::Array(list)
            }
        };
        out.push(json!({
            "id": g.id,
            "client_id": g.client_id,
            "client_name": g.client_name,
            "client_uri": g.client_uri,
            "scopes": oauth::scope_list(&g.scope),
            "tunnels": tunnels,
            "created_at": db_to_iso(&g.created_at, tz),
            "last_used_at": opt_db_to_iso(&g.last_used_at, tz),
            "expires_at": opt_db_to_iso(&g.refresh_expires_at, tz),
        }));
    }
    Ok(Json(Value::Array(out)))
}

#[utoipa::path(delete, path = "/api/oauth/grants/{id}", tag = "OAuth", security(("bearer" = [])), params(("id" = i64, Path, description = "Grant id")), responses((status = 204, description = "Revoked: its refresh token and access tokens stop working immediately"), (status = 404, body = super::schemas::ErrorBody)))]
async fn revoke_grant(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let grant = db::oauth::grant_by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    if grant.user_id != user.id && !user.is_superuser {
        return Err(ApiError::drf_not_found());
    }
    revoke_grant_by_id(&state, grant.id).await?;
    Ok(StatusCode::NO_CONTENT)
}
