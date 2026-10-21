//! `/tunnels/server/config/*`、`/tunnels/server/script/*`：ssh config 與六種連線腳本、一次性 token。

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Tunnel};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::scripts::{self, ScriptContext, ALLOWED_SCRIPT_TYPES};
use crate::state::AppState;
use crate::tokens::ScriptTokenPayload;
use crate::util::{host_without_port, json_i64, json_str};

const CLIENT_STEM: &str = "\n# ========================================\n# Endpoint Configuration\n# ========================================\n";
const SERVER_STEM: &str = "# ========================================\n# Reverse Server Configuration\n# ========================================\n";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tunnels/server/config/{id}", get(config))
        .route("/tunnels/server/script/one-time/token", post(one_time_token))
        .route("/tunnels/server/script/one-time/{token}", get(one_time_script))
        .route("/tunnels/server/script/{kind}/{id}/{ssh_port}", get(script))
}

/// Django 用 `HTTP_HOST`（去掉 port）當 server_domain，沒有才退回 settings.SERVER_DOMAIN。
fn server_domain(headers: &HeaderMap, state: &AppState) -> String {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(host_without_port)
        .or_else(|| state.config.server_domain.clone())
        .unwrap_or_default()
}

async fn viewable_tunnel(state: &AppState, user_id: i64, id: i64) -> ApiResult<Tunnel> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Reverse server keys not found"))?;
    if !permissions::check_access(&state.db, user_id, &t, Permission::View).await? {
        return Err(ApiError::not_found("Reverse server keys not found"));
    }
    Ok(t)
}

fn clean_key_path(raw: Option<&String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// `ReverseServerAuthorizedKeysConfig`
async fn config(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let t = viewable_tunnel(&state, user.id, id).await?;
    let domain = server_domain(&headers, &state);
    let mut out = String::from(SERVER_STEM);
    out.push_str(&scripts::render_server_config(&domain, &state.config.reverse_server_ssh_port));

    let all = permissions::allowed_usernames(&state.db, user.id, &t).await?;
    let usernames_list: Vec<Value> = all
        .iter()
        .map(|u| json!({ "id": u.id, "username": u.username, "created_by": u.created_by, "created_by_id": u.user_id }))
        .collect();
    let selected: Vec<_> = match q.get("username_id").and_then(|s| s.parse::<i64>().ok()) {
        Some(sel) => all.iter().filter(|u| u.id == sel).collect(),
        None => all.iter().collect(),
    };
    if !selected.is_empty() {
        out.push_str(CLIENT_STEM);
    }
    let multi = selected.len() > 1;
    for u in selected {
        let alias = if multi { format!("{}-{}", t.host_friendly_name, u.username) } else { t.host_friendly_name.clone() };
        out.push_str(&scripts::render_client_config(&alias, &u.username, t.reverse_port));
    }
    Ok(Json(json!({ "config": out, "usernames": usernames_list })))
}

/// 六種腳本的共用渲染：autossh-service 需要目標使用者名稱（username_id 可指定）。
async fn render_for(
    state: &AppState,
    user_id: i64,
    t: &Tunnel,
    kind: &str,
    ssh_port: i64,
    key_path: Option<&str>,
    username_id: Option<i64>,
    domain: &str,
) -> Result<(String, &'static str), ApiError> {
    let username = if kind == "autossh-service" {
        let allowed = permissions::allowed_usernames(&state.db, user_id, t).await?;
        let selected = allowed.iter().find(|u| username_id.map(|id| u.id == id).unwrap_or(true));
        match selected {
            Some(u) => u.username.clone(),
            None => return Err(ApiError::not_found("No username found for this server")),
        }
    } else {
        "root".to_string()
    };
    let service_key = db::keys::first_service_key(&state.db).await?;
    let ctx = ScriptContext {
        server_domain: domain,
        reverse_port: t.reverse_port,
        ssh_port,
        reverse_server_ssh_port: &state.config.reverse_server_ssh_port,
        username: &username,
        key_path,
        telepy_public_key: service_key.as_deref(),
    };
    scripts::render_script(kind, &ctx).map_err(ApiError::bad_request)
}

/// `/tunnels/server/script/{kind}/{id}/{ssh_port}`
async fn script(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((kind, id, ssh_port)): Path<(String, i64, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    if !ALLOWED_SCRIPT_TYPES.contains(&kind.as_str()) {
        return Err(ApiError::drf_not_found());
    }
    let t = viewable_tunnel(&state, user.id, id).await?;
    let domain = server_domain(&headers, &state);
    let key_path = clean_key_path(q.get("key_path"));
    let username_id = q.get("username_id").and_then(|s| s.parse::<i64>().ok());
    let (script, language) = render_for(&state, user.id, &t, &kind, ssh_port, key_path.as_deref(), username_id, &domain).await?;
    Ok(Json(json!({ "script": script, "language": language })))
}

/// `OneTimeScriptTokenView`：`{"token", "url"}`；url 的 scheme/host 依 X-Forwarded-* 決定。
async fn one_time_token(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    AppJson(body): AppJson<Value>,
) -> ApiResult<Json<Value>> {
    let server_id = json_i64(&body, "server_id");
    let ssh_port = json_i64(&body, "ssh_port");
    let script_type = json_str(&body, "script_type");
    let (Some(server_id), Some(ssh_port), Some(script_type)) = (server_id, ssh_port, script_type) else {
        return Err(ApiError::bad_request("server_id, ssh_port, and script_type are required"));
    };
    if server_id == 0 || ssh_port == 0 || script_type.is_empty() {
        return Err(ApiError::bad_request("server_id, ssh_port, and script_type are required"));
    }
    if !ALLOWED_SCRIPT_TYPES.contains(&script_type.as_str()) {
        let mut sorted: Vec<&str> = ALLOWED_SCRIPT_TYPES.to_vec();
        sorted.sort();
        let list = sorted.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ");
        return Err(ApiError::bad_request(format!("Invalid script_type. Allowed: [{list}]")));
    }
    let t = db::tunnels::by_id(&state.db, server_id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &t, Permission::View).await? {
        return Err(ApiError::forbidden("Access denied"));
    }
    let username_id = json_i64(&body, "username_id");
    if script_type == "autossh-service" {
        if let Some(uid) = username_id {
            let allowed = permissions::allowed_usernames(&state.db, user.id, &t).await?;
            if !allowed.iter().any(|u| u.id == uid) {
                return Err(ApiError::bad_request("Username not allowed or not found"));
            }
        }
    }
    let token = state.tokens.issue_script_token(ScriptTokenPayload {
        user_id: user.id,
        server_id,
        ssh_port,
        script_type,
        key_path: json_str(&body, "key_path"),
        username_id,
    });
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
        .filter(|v| v == "https")
        .unwrap_or_else(|| "http".to_string());
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
        .unwrap_or_default();
    Ok(Json(json!({ "token": token, "url": format!("{scheme}://{host}/tunnels/server/script/one-time/{token}") })))
}

fn plain(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

/// `OneTimeScriptView`（AllowAny）：取用即失效，回 text/plain。
async fn one_time_script(State(state): State<AppState>, Path(token): Path<String>, headers: HeaderMap) -> Response {
    let Some(payload) = state.tokens.pop_script_token(&token) else {
        return plain(StatusCode::NOT_FOUND, "Token invalid or already used".into());
    };
    let user = match db::users::by_id(&state.db, payload.user_id).await {
        Ok(Some(u)) => u,
        Ok(None) => return plain(StatusCode::NOT_FOUND, "User not found".into()),
        Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let t = match db::tunnels::by_id(&state.db, payload.server_id).await {
        Ok(Some(t)) => t,
        Ok(None) => return plain(StatusCode::NOT_FOUND, "Tunnel not found".into()),
        Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    match permissions::check_access(&state.db, user.id, &t, Permission::View).await {
        Ok(true) => {}
        Ok(false) => return plain(StatusCode::FORBIDDEN, "Access denied".into()),
        Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
    let domain = server_domain(&headers, &state);
    let key_path = payload.key_path.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    match render_for(&state, user.id, &t, &payload.script_type, payload.ssh_port, key_path.as_deref(), payload.username_id, &domain).await {
        Ok((script, _)) => plain(StatusCode::OK, script),
        Err(e) => {
            let msg = e.body.get("error").and_then(|v| v.as_str()).unwrap_or("error").to_string();
            plain(e.status, msg)
        }
    }
}
