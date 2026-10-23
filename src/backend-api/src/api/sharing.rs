//! `/tunnels/share|unshare|update-permission|shared-users|available-users`：分享 API
//! （tunnels/views.py + services/tunnel_permissions.py）。錯誤字串逐字相同。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Tunnel};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::{db_to_iso_utc_offset, json_i64, json_str};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(share))
        .routes(routes!(unshare))
        .routes(routes!(update_permission))
        .routes(routes!(shared_users))
        .routes(routes!(available_users))
        .routes(routes!(update_allowed_usernames))
}

fn invalid_permission(raw: &str) -> ApiError {
    ApiError::bad_request(format!("Invalid permission type: {raw}. Valid values are: view, edit, admin"))
}

async fn tunnel_or_404(state: &AppState, id: i64) -> ApiResult<Tunnel> {
    db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))
}

/// `ShareTunnelView` + `TunnelPermissionService.share_tunnel`
#[utoipa::path(post, path = "/tunnels/share/{id}", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::ShareRequest, responses((status = 201, body = super::schemas::Message), (status = 400, body = super::schemas::ErrorBody), (status = 403, description = "Needs ADMIN / owner", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn share(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let t = tunnel_or_404(&state, id).await?;
    if !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::forbidden("You do not have permission to share this tunnel"));
    }
    let Some(target_id) = json_i64(&body, "shared_with_user_id") else {
        return Err(ApiError::bad_request("shared_with_user_id is required"));
    };
    let target = db::users::by_id(&state.db, target_id).await?.ok_or_else(|| ApiError::not_found("User not found"))?;
    if db::sharing::get(&state.db, t.id, target.id).await?.is_some() {
        return Err(ApiError::bad_request("Tunnel already shared with this user"));
    }
    if target.id == t.user_id {
        return Err(ApiError::bad_request("Cannot share tunnel with its owner"));
    }
    if target.id == me.id {
        return Err(ApiError::bad_request("Cannot share tunnel with yourself"));
    }
    let raw_perm = json_str(&body, "permission_type").unwrap_or_else(|| "view".to_string());
    let perm = Permission::parse(&raw_perm).ok_or_else(|| invalid_permission(&raw_perm))?;

    let sharing = db::sharing::create(&state.db, t.id, me.id, target.id, perm.as_str()).await?;

    state.hub.notify_user(
        target.id,
        &json!({
            "action": "TUNNEL-SHARED",
            "details": format!("Tunnel \"{}\" has been shared with you by {}", t.host_friendly_name, me.username),
            "tunnel_id": t.id,
            "shared_by": me.username,
            "permission_type": perm.as_str(),
        }),
    );
    if t.user_id != me.id {
        state.hub.notify_user(
            t.user_id,
            &json!({
                "action": "TUNNEL-SHARED",
                "details": format!("{} shared your tunnel \"{}\" with {}", me.username, t.host_friendly_name, target.username),
                "tunnel_id": t.id,
                "shared_with": target.username,
                "permission_type": perm.as_str(),
            }),
        );
    }
    state.hub.notify_user(me.id, &json!({ "action": "TUNNEL-SHARED", "tunnel_id": t.id }));

    if let Some(Value::Array(ids)) = body.get("allowed_target_username_ids") {
        let ids: Vec<i64> = ids.iter().filter_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).collect();
        if !ids.is_empty() {
            db::sharing::add_allowed_usernames(&state.db, sharing.id, t.id, &ids).await?;
        }
    }
    Ok((StatusCode::CREATED, Json(json!({ "message": "Tunnel shared successfully" }))))
}

/// `UnshareTunnelView` + `unshare_tunnel`：被分享者可自行「離開」。
#[utoipa::path(delete, path = "/tunnels/unshare/{id}/{uid}", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("uid" = i64, Path, description = "User id; your own id leaves the share")), responses((status = 200, body = super::schemas::Message), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn unshare(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, uid)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found or access denied"))?;
    let is_self = me.id == uid;
    if !is_self && !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::bad_request("You do not have permission to manage sharing for this tunnel"));
    }
    let sharing = db::sharing::get(&state.db, t.id, uid).await?.ok_or_else(|| ApiError::not_found("Sharing not found"))?;
    let target = db::users::by_id(&state.db, uid).await?;
    let target_name = target.as_ref().map(|u| u.username.clone()).unwrap_or_default();

    db::tunnels::transfer_usernames_to_owner(&state.db, t.id, t.user_id, uid).await?;
    db::sharing::delete(&state.db, sharing.id).await?;
    // 看不到了，他的釘選也沒意義。/ They can't see it any more, so their pin goes too.
    db::tunnel_tags::set_pin(&state.db, uid, t.id, false).await?;
    // 分享撤銷：他的金鑰離開這台裝置的清單，並從裝置上移除。/ Their keys leave this device.
    db::device_keys::delete_entries_of_user(&state.db, t.id, uid).await?;
    state.device_keys.kick(t.id);

    if !is_self {
        state.hub.notify_user(
            uid,
            &json!({
                "action": "TUNNEL-UNSHARED",
                "details": format!("Access to tunnel \"{}\" has been revoked by {}", t.host_friendly_name, me.username),
                "tunnel_id": t.id,
                "revoked_by": me.username,
            }),
        );
    }
    if t.user_id != me.id {
        let action_str = if is_self { "left".to_string() } else { format!("revoked access from {target_name} for") };
        state.hub.notify_user(
            t.user_id,
            &json!({
                "action": "TUNNEL-UNSHARED",
                "details": format!("{} {} your tunnel \"{}\"", me.username, action_str, t.host_friendly_name),
                "tunnel_id": t.id,
                "revoked_from": target_name,
            }),
        );
    }
    state.hub.notify_user(me.id, &json!({ "action": "TUNNEL-UNSHARED", "tunnel_id": t.id }));
    Ok(Json(json!({ "message": "Tunnel unshared successfully" })))
}

/// `UpdateSharingPermissionView` + `update_sharing_permission`
#[utoipa::path(patch, path = "/tunnels/update-permission/{id}/{uid}", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("uid" = i64, Path, description = "User id")), request_body = super::schemas::PermissionUpdateRequest, responses((status = 200, body = super::schemas::PermissionUpdated), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_permission(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, uid)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let raw = json_str(&body, "permission_type").filter(|s| !s.is_empty()).ok_or_else(|| ApiError::bad_request("permission_type is required"))?;
    let perm = Permission::parse(&raw).ok_or_else(|| invalid_permission(&raw))?;
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found or access denied"))?;
    if !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::bad_request("You do not have permission to manage sharing for this tunnel"));
    }
    let sharing = db::sharing::get(&state.db, t.id, uid).await?.ok_or_else(|| ApiError::not_found("Sharing not found"))?;
    let old = sharing.permission_type.clone();
    db::sharing::set_permission(&state.db, sharing.id, perm.as_str()).await?;
    if perm == Permission::View && matches!(Permission::parse(&old), Some(Permission::Edit) | Some(Permission::Admin)) {
        db::tunnels::transfer_usernames_to_owner(&state.db, t.id, t.user_id, uid).await?;
    }
    // ADMIN ↔ 其他等級會改變可用的 OS 帳號。/ The level changes which accounts their keys go into.
    state.device_keys.kick(t.id);
    let target_name = db::users::by_id(&state.db, uid).await?.map(|u| u.username).unwrap_or_default();
    let display = perm.display();
    state.hub.notify_user(
        uid,
        &json!({
            "action": "TUNNEL-PERMISSION-UPDATED",
            "details": format!("Your permission for tunnel \"{}\" has been updated to \"{}\" by {}", t.host_friendly_name, display, me.username),
            "tunnel_id": t.id,
            "updated_by": me.username,
            "old_permission": old,
            "new_permission": perm.as_str(),
        }),
    );
    if t.user_id != me.id {
        state.hub.notify_user(
            t.user_id,
            &json!({
                "action": "TUNNEL-PERMISSION-UPDATED",
                "details": format!("{} updated permission for your tunnel \"{}\" to \"{}\" for {}", me.username, t.host_friendly_name, display, target_name),
                "tunnel_id": t.id,
                "updated_for": target_name,
                "old_permission": old,
                "new_permission": perm.as_str(),
            }),
        );
    }
    state.hub.notify_user(me.id, &json!({ "action": "TUNNEL-PERMISSION-UPDATED", "tunnel_id": t.id }));
    Ok(Json(json!({ "message": "Sharing permission updated successfully", "permission_type": perm.as_str() })))
}

/// `ListSharedUsersView`：有任何存取權的人都能看分享名單。
#[utoipa::path(get, path = "/tunnels/shared-users/{id}", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::SharedUsers), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn shared_users(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = tunnel_or_404(&state, id).await?;
    if permissions::effective_for(&state.db, me.id, &t).await?.is_none() {
        return Err(ApiError::forbidden("You do not have permission to view sharing for this tunnel"));
    }
    let mut users = Vec::new();
    for s in db::sharing::for_tunnel(&state.db, t.id).await? {
        let allowed = db::sharing::allowed_usernames(&state.db, s.id).await?;
        users.push(json!({
            "id": s.shared_with_id,
            "username": s.username,
            "email": s.email,
            "permission_type": s.permission_type,
            "shared_at": db_to_iso_utc_offset(&s.shared_at),
            "allowed_target_usernames": allowed.iter().map(|(id, u)| json!({ "id": id, "username": u })).collect::<Vec<_>>(),
        }));
    }
    Ok(Json(json!({ "users": users })))
}

/// `ListAvailableUsersView`
#[utoipa::path(get, path = "/tunnels/available-users/{id}", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "Users the tunnel is not shared with yet", body = super::schemas::AvailableUsers), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn available_users(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = tunnel_or_404(&state, id).await?;
    if !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::forbidden("You do not have permission to manage sharing for this tunnel"));
    }
    let mut exclude = db::sharing::sharee_ids(&state.db, t.id).await?;
    exclude.push(me.id);
    exclude.push(t.user_id);
    let users = db::users::all_except(&state.db, &exclude).await?;
    Ok(Json(json!({
        "users": users.iter().map(|(id, u, e)| json!({ "id": id, "username": u, "email": e })).collect::<Vec<_>>()
    })))
}

/// `UpdateAllowedUsernamesView`：整組取代。
#[utoipa::path(patch, path = "/tunnels/share/{id}/{uid}/allowed-usernames", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("uid" = i64, Path, description = "User id")), request_body = super::schemas::AllowedUsernamesRequest, responses((status = 200, body = super::schemas::Message), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_allowed_usernames(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, uid)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = tunnel_or_404(&state, id).await?;
    if !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::forbidden("You do not have permission to manage this tunnel"));
    }
    let sharing = db::sharing::get(&state.db, t.id, uid).await?.ok_or_else(|| ApiError::not_found("Sharing record not found"))?;
    let ids: Vec<i64> = match body.get("allowed_target_username_ids") {
        None => vec![],
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).collect(),
        Some(_) => return Err(ApiError::bad_request("allowed_target_username_ids must be a list")),
    };
    db::sharing::replace_allowed_usernames(&state.db, sharing.id, t.id, &ids).await?;
    state.device_keys.kick(t.id);
    state.hub.notify_users(
        [me.id, uid],
        &json!({ "action": "TUNNEL-USERNAMES-UPDATED", "details": "Allowed target usernames updated", "tunnel_id": t.id }),
    );
    Ok(Json(json!({ "message": "Allowed usernames updated" })))
}
