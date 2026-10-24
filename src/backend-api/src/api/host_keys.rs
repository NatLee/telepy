//! 裝置 SSH host key（釘選與待確認）：
//! - `GET    /api/reverse/server/{id}/host-key`：看得到隧道（VIEW）就能看；也列出同一台機器上的其他隧道（`same_machine`）
//!   與最近一次因「機器屬於別的帳號」被拒的連線（`refused_claim`）
//! - `POST   /api/reverse/server/{id}/host-key/accept` `{fingerprint}`：擁有者 / ADMIN 改信任被拒絕的那把
//!   （屬於別的帳號的機器 → 409 `device_claimed`）
//! - `DELETE /api/reverse/server/{id}/host-key`：擁有者 / ADMIN 忘掉全部（下一次連線重新第一次使用）
//! 邏輯見 `ssh::host_keys`。/ Device host-key endpoints; see `ssh::host_keys`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, host_keys::HostKeyRow};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::ssh::host_keys;
use crate::state::AppState;
use crate::util::{db_to_iso_utc_z, json_str};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(show, forget)).routes(routes!(accept))
}

fn row_json(r: &HostKeyRow) -> Value {
    json!({
        "key_type": r.key_type,
        "fingerprint": r.fingerprint,
        "public_key": r.public_key,
        "source": r.source,
        "attempts": r.attempts,
        "first_seen": db_to_iso_utc_z(&r.first_seen),
        "last_seen": db_to_iso_utc_z(&r.last_seen),
    })
}

/// (隧道, 能不能管理)；看不到隧道 → 404。/ (tunnel, may manage); invisible → 404.
async fn load(state: &AppState, user_id: i64, id: i64) -> ApiResult<(db::tunnels::Tunnel, bool)> {
    let tunnel = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    let eff = permissions::effective_for(&state.db, user_id, &tunnel).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    Ok((tunnel, eff.satisfies(Permission::Admin)))
}

async fn body(state: &AppState, user_id: i64, tunnel_id: i64, can_manage: bool) -> ApiResult<Value> {
    let rows = db::host_keys::for_tunnel(&state.db, tunnel_id).await?;
    let pick = |status: &str| rows.iter().filter(|r| r.status == status).map(row_json).collect::<Vec<_>>();
    // 同一台機器上的其他隧道（只列這個人看得到的；別的帳號的隧道釘不到同一把，所以都是同一個擁有者的）。
    // Other tunnels on this machine that the caller can see (another account cannot pin the same key, so same owner).
    let mut same = Vec::new();
    for c in db::host_keys::same_machine(&state.db, tunnel_id).await? {
        let Some(t) = db::tunnels::by_id(&state.db, c.tunnel_id).await? else { continue };
        if permissions::effective_for(&state.db, user_id, &t).await?.is_some() {
            same.push(json!({ "id": t.id, "name": t.host_friendly_name }));
        }
    }
    let claim = state.host_keys.refused_claim(tunnel_id).map(|c| json!({ "key_type": c.key_type, "fingerprint": c.fingerprint, "at": db_to_iso_utc_z(&c.at) }));
    Ok(json!({ "pinned": pick(db::host_keys::PINNED), "rejected": pick(db::host_keys::REJECTED), "can_manage": can_manage, "same_machine": same, "refused_claim": claim }))
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/host-key", tag = "Device host key", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::DeviceHostKeys), (status = 404, body = super::schemas::ErrorBody)))]
async fn show(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (tunnel, can_manage) = load(&state, user.id, id).await?;
    Ok(Json(body(&state, user.id, tunnel.id, can_manage).await?))
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/host-key/accept", tag = "Device host key", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::HostKeyAccept, responses((status = 200, description = "The key is now the only pinned key", body = super::schemas::DeviceHostKeys), (status = 400, body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "code = device_claimed: the key belongs to another account's machine", body = super::schemas::ErrorBody)))]
async fn accept(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(req): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (tunnel, can_manage) = load(&state, user.id, id).await?;
    if !can_manage {
        return Err(ApiError::forbidden("Only the owner or an ADMIN sharee can change the device's host key."));
    }
    let fingerprint = json_str(&req, "fingerprint").filter(|f| !f.is_empty()).ok_or_else(|| ApiError::field("fingerprint", "This field is required."))?;
    let candidate = db::host_keys::rejected_by_fingerprint(&state.db, tunnel.id, &fingerprint).await?.ok_or_else(|| ApiError::not_found("No refused host key with that fingerprint."))?;
    // 那把金鑰是別的帳號的機器：確認也不行（否則「先指到自己的機器、再改指到別人的」就繞過了認領規則）。
    // The key belongs to another account's machine: accepting it would bypass the claim rule.
    let others = db::host_keys::claimants(&state.db, &candidate.public_key, tunnel.id).await?;
    if host_keys::foreign_claimant(&others, tunnel.user_id).is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            json!({ "error": format!("This host key belongs to a device managed by another Telepy account; {}.", host_keys::CLAIMED_HINT), "code": "device_claimed" }),
        ));
    }
    let row = db::host_keys::accept(&state.db, tunnel.id, &fingerprint).await?.ok_or_else(|| ApiError::not_found("No refused host key with that fingerprint."))?;
    state.host_keys.invalidate(tunnel.id);
    let same = host_keys::same_machine_note(&others);
    state
        .gateway
        .event("host_key_accepted", None, u16::try_from(tunnel.reverse_port).ok(), Some(tunnel.id), format!("{} trusted the new device host key {} {} of '{}'{same}", user.username, row.key_type, row.fingerprint, tunnel.host_friendly_name))
        .await;
    let _ = crate::api::notify::tunnel_updated(&state, &tunnel).await;
    Ok(Json(body(&state, user.id, tunnel.id, true).await?))
}

#[utoipa::path(delete, path = "/api/reverse/server/{id}/host-key", tag = "Device host key", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "Forgotten; the next connection pins the key it sees", body = super::schemas::DeviceHostKeys), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn forget(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (tunnel, can_manage) = load(&state, user.id, id).await?;
    if !can_manage {
        return Err(ApiError::forbidden("Only the owner or an ADMIN sharee can change the device's host key."));
    }
    db::host_keys::forget(&state.db, tunnel.id).await?;
    state.host_keys.invalidate(tunnel.id);
    state
        .gateway
        .event("host_key_forgotten", None, u16::try_from(tunnel.reverse_port).ok(), Some(tunnel.id), format!("{} cleared the pinned device host key of '{}'; the next connection pins again", user.username, tunnel.host_friendly_name))
        .await;
    let _ = crate::api::notify::tunnel_updated(&state, &tunnel).await;
    Ok(Json(body(&state, user.id, tunnel.id, true).await?))
}
