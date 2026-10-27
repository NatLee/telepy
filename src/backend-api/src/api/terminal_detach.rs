//! 隧道的網頁終端機斷線政策（見 `crate::terminal_detach`）：owner / ADMIN 設 `user`（照每個人的保留時間）或
//! `never`（斷線就結束，給敏感裝置）。從 `never` 放寬回 `user` 要再驗證（帳號有第二因素時）。
//! A tunnel's web terminal detach policy: owner / ADMIN set `user` (each person's grace time) or `never` (end at once,
//! for sensitive devices). Relaxing `never` back to `user` needs a re-authentication when you have a factor.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{mfa, notify, AppJson};
use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::permissions;
use crate::state::AppState;
use crate::terminal_detach::Policy;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(set_policy))
}

#[utoipa::path(put, path = "/api/reverse/server/{id}/terminal-detach", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::TerminalDetachPolicy, responses((status = 200, body = super::schemas::TerminalDetachPolicy), (status = 400, description = "{policy: [msg]}", body = super::schemas::ErrorBody), (status = 403, description = "Needs owner / ADMIN, or reauth_required", body = super::schemas::MfaError), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_policy(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let nf = || ApiError::not_found("Tunnel not found");
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(nf)?;
    let eff = permissions::effective_for(&state.db, user.id, &t).await?.ok_or_else(nf)?;
    if !eff.satisfies(permissions::Permission::Admin) {
        return Err(ApiError::forbidden("Only the tunnel owner or an ADMIN sharee can change this."));
    }
    let policy = body
        .get("policy")
        .and_then(Value::as_str)
        .and_then(Policy::parse)
        .ok_or_else(|| ApiError::field("policy", format!("Must be one of: {}.", Policy::VALUES.join(", "))))?;
    let current = Policy::parse(&t.terminal_detach_policy).unwrap_or(Policy::User);
    if policy == current {
        return Ok(Json(json!({ "policy": policy.as_str() })));
    }
    if policy == Policy::User {
        mfa::require_reauth(&state, &headers, &user, body.get("reauth")).await?;
    }
    db::tunnels::set_terminal_detach_policy(&state.db, t.id, policy.as_str()).await?;
    // 改成 never：這條隧道上斷線保留中的 shell 立刻結束。/ Now `never`: detached shells on this tunnel end at once.
    if policy == Policy::Never {
        crate::terminal_detach::kick(&state, Some(t.id), None);
    }
    let t = db::tunnels::by_id(&state.db, t.id).await?.unwrap_or(t);
    notify::tunnel_updated(&state, &t).await?;
    let what = match policy {
        Policy::Never => "web terminal shells now end as soon as the browser drops",
        Policy::User => "web terminal shells are kept after a drop for each person's chosen time",
    };
    state
        .gateway
        .event("terminal_detach_setting", None, u16::try_from(t.reverse_port).ok(), Some(t.id), format!("{} changed tunnel {}: {what}", user.username, t.host_friendly_name))
        .await;
    Ok(Json(json!({ "policy": policy.as_str() })))
}
