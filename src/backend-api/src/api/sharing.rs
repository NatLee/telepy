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
use crate::webhooks::{Event, Kind};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(share))
        .routes(routes!(unshare))
        .routes(routes!(update_permission))
        .routes(routes!(shared_users))
        .routes(routes!(available_users))
        .routes(routes!(update_allowed_usernames))
        .routes(routes!(update_expiry))
        .routes(routes!(list_group_shares, create_group_share))
        .routes(routes!(update_group_share, delete_group_share))
}

/// 分享為什麼結束：被撤銷、自己離開、或到期。/ Why a share ended.
pub enum EndReason<'a> {
    Revoked { by: &'a str },
    Left,
    Expired,
    /// 經由群組的分享結束：離開群組、群組分享被收回或改掉。/ A share through a group ended (left the group, the group share went).
    Group { group: &'a str },
}

/// 結束一筆分享（撤銷、離開、到期共用）：他用的帳號交還給 owner、刪分享與釘選、他的金鑰離開這台裝置的清單，
/// 然後通知他和 owner。`actor` = 做這件事的人（到期時是 None）。
/// End a share (revoke, leave or expiry): hand their accounts back to the owner, drop the share and their pin,
/// take their keys off this device's list, then tell them and the owner. `actor` is None on expiry.
pub async fn end_share(state: &AppState, t: &Tunnel, sharing: &db::sharing::Sharing, actor: Option<i64>, reason: EndReason<'_>) -> ApiResult<()> {
    let uid = sharing.shared_with_id;
    let target_name = db::users::by_id(&state.db, uid).await?.map(|u| u.username).unwrap_or_default();
    db::tunnels::transfer_usernames_to_owner(&state.db, t.id, t.user_id, uid).await?;
    db::sharing::delete(&state.db, sharing.id).await?;
    // 看不到了，他的釘選也沒意義。/ They can't see it any more, so their pin goes too.
    db::tunnel_tags::set_pin(&state.db, uid, t.id, false).await?;
    // 分享撤銷：他的金鑰離開這台裝置的清單，並從裝置上移除。/ Their keys leave this device.
    db::device_keys::delete_entries_of_user(&state.db, t.id, uid).await?;
    // 他在這台裝置上開著的網頁終端機（含斷線保留中的）跟著結束。/ Their open web terminals there (detached too) end.
    crate::access_recheck::kick(state, Some(t.id), Some(uid));
    // 他的分組與他的金鑰群組對這條通道的授予也拿掉。/ Their grouping of it and their key groups' grants to it go too.
    db::groups::forget_tunnel_for_user(&state.db, uid, t.id).await?;
    state.device_keys.kick(t.id);
    // 還在等的存取申請一併取消。/ Their pending access requests go too.
    db::access_requests::cancel_pending_of(&state.db, t.id, uid).await?;

    let name = &t.host_friendly_name;
    let (to_sharee, to_owner) = match &reason {
        EndReason::Revoked { by } => (Some(format!("Access to tunnel \"{name}\" has been revoked by {by}")), format!("{by} revoked access from {target_name} for your tunnel \"{name}\"")),
        EndReason::Left => (None, format!("{target_name} left your tunnel \"{name}\"")),
        EndReason::Expired => (Some(format!("Your access to tunnel \"{name}\" has ended: the share expired")), format!("{target_name}'s access to your tunnel \"{name}\" expired")),
        EndReason::Group { group } => (
            Some(format!("Your access to tunnel \"{name}\" through the group \"{group}\" has ended")),
            format!("{target_name} no longer has access to your tunnel \"{name}\" through the group \"{group}\""),
        ),
    };
    if let Some(details) = to_sharee {
        let mut msg = json!({ "action": "TUNNEL-UNSHARED", "details": details, "tunnel_id": t.id });
        if let EndReason::Revoked { by } = &reason {
            msg["revoked_by"] = json!(by);
        }
        if matches!(reason, EndReason::Expired) {
            msg["expired"] = json!(true);
        }
        state.hub.notify_user(uid, &msg);
    }
    if matches!(reason, EndReason::Group { .. }) {
        // 一個群組可以有很多人：主人只收重新整理，細節在通道的紀錄裡。/ A group can be many people: the owner only refreshes.
        state.hub.notify_user(t.user_id, &json!({ "action": "TUNNEL-UNSHARED", "tunnel_id": t.id }));
    } else if Some(t.user_id) != actor {
        state.hub.notify_user(t.user_id, &json!({ "action": "TUNNEL-UNSHARED", "details": to_owner, "tunnel_id": t.id, "revoked_from": target_name }));
    }
    if let Some(actor) = actor {
        state.hub.notify_user(actor, &json!({ "action": "TUNNEL-UNSHARED", "tunnel_id": t.id }));
    }
    let (reason_name, by) = match &reason {
        EndReason::Revoked { by } => ("revoked", Some(by.to_string())),
        EndReason::Left => ("left", Some(target_name.clone())),
        EndReason::Expired => ("expired", None),
        EndReason::Group { .. } => ("group", None),
    };
    let group = match &reason {
        EndReason::Group { group } => Some(group.to_string()),
        _ => None,
    };
    // 群組的變動不寄給主人（可能一次很多人）。/ Group changes don't go to the owner (could be many people at once).
    let audience: Vec<i64> = if group.is_some() { vec![uid] } else { vec![uid, t.user_id] };
    state.webhooks.emit(
        Event::new(Kind::ShareEnded)
            .tunnel(t)
            .to(audience, actor)
            .data(json!({ "user": target_name, "reason": reason_name, "by": by, "group": group }))
            .link("/tunnels"),
    );
    Ok(())
}

/// 收掉所有已到期的分享，回傳收了幾筆。/ End every share past its expiry; returns how many.
pub async fn expire_once(state: &AppState) -> ApiResult<usize> {
    let mut n = 0;
    for s in db::sharing::expired(&state.db).await? {
        let Some(t) = db::tunnels::by_id(&state.db, s.tunnel_id).await? else { continue };
        end_share(state, &t, &s, None, EndReason::Expired).await?;
        tracing::info!(tunnel = %t.host_friendly_name, user_id = s.shared_with_id, "share expired");
        n += 1;
    }
    Ok(n)
}

/// 每 30 秒收一次到期的分享。/ Ends expired shares every 30 seconds.
pub async fn run_expiry(state: AppState) {
    loop {
        if let Err(e) = expire_once(&state).await {
            tracing::warn!(error = ?e, "share expiry failed");
        }
        // 群組分享：收掉到期的，並把成員的分享對齊（成員變動漏掉的也補上）。/ Group shares: end expired ones, line members up.
        if let Err(e) = crate::group_shares::tick(&state).await {
            tracing::warn!(error = ?e, "group share reconcile failed");
        }
        // 存取申請給的暫時授權也在這裡收回。/ Temporary grants from access requests end here too.
        if let Err(e) = super::access_requests::revert_once(&state).await {
            tracing::warn!(error = ?e, "temporary access revert failed");
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

/// 請求裡的 `expires_at`：沒給 = None（不改 / 不到期），給了就要是未來的時間或 null。
/// The request's `expires_at`: absent = None; otherwise a future time or null.
fn requested_expiry(body: &Value) -> ApiResult<Option<Option<String>>> {
    let Some(v) = body.get("expires_at") else { return Ok(None) };
    let t = crate::expiry::parse_expiry(v)
        .and_then(|t| crate::expiry::check_expiry(t, chrono::Utc::now(), 0))
        .map_err(|m| ApiError::field("expires_at", m))?;
    Ok(Some(t.map(crate::util::db_time)))
}

/// 這筆分享是群組給的：要改就改群組分享或群組成員。/ This share comes from a group: change the group share or its members.
async fn refuse_via_group(state: &AppState, sharing: &db::sharing::Sharing, own: bool) -> ApiResult<()> {
    let Some(gs) = sharing.group_share_id else { return Ok(()) };
    let group = match db::group_shares::get(&state.db, gs).await? {
        Some(g) => db::features::group(&state.db, g.group_id).await?.map(|g| g.name).unwrap_or_default(),
        None => String::new(),
    };
    let msg = if own {
        format!("You have this tunnel through the group \"{group}\". An admin can take you out of the group, or the tunnel's owner can stop sharing it with the group.")
    } else {
        format!("This access comes from the group \"{group}\". Change the group's share, or share with this person directly to set their access on its own.")
    };
    Err(ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": msg, "code": "via_group", "group": group })))
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
    // 跟群組比對輪流來：讀到的列在改完之前不會被它的舊快照改回去或收掉。
    // Take turns with the group reconcile: the row read here isn't overwritten or removed from its older snapshot meanwhile.
    let _held = crate::group_shares::lock().await;
    let existing = db::sharing::get(&state.db, t.id, target.id).await?;
    if existing.as_ref().is_some_and(|s| s.group_share_id.is_none()) {
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

    let expires = requested_expiry(&body)?.flatten();
    // 他已經經由群組拿到：這筆改成直接分享，從此照這裡的設定（群組不再碰）。
    // They already have it through a group: the row becomes a direct share with these settings (groups leave it alone).
    if let Some(row) = existing {
        let ids: Vec<i64> = match body.get("allowed_target_username_ids") {
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).collect(),
            _ => vec![],
        };
        db::group_shares::make_direct(&state.db, row.id).await?;
        db::sharing::set_permission(&state.db, row.id, perm.as_str()).await?;
        db::sharing::set_expiry(&state.db, row.id, expires.as_deref()).await?;
        db::sharing::replace_allowed_usernames(&state.db, row.id, t.id, &ids).await?;
        state.device_keys.kick(t.id);
        crate::access_recheck::kick(&state, Some(t.id), Some(target.id));
        state.gateway.event("group_share", None, None, Some(t.id), format!("{} set {}'s access to \"{}\" on its own ({}); their groups no longer change it", me.username, target.username, t.host_friendly_name, perm.as_str())).await;
        state.hub.notify_users([me.id, target.id], &json!({ "action": "TUNNEL-PERMISSION-UPDATED", "tunnel_id": t.id }));
        return Ok((StatusCode::CREATED, Json(json!({ "message": "Tunnel shared successfully", "converted": true }))));
    }
    let sharing = db::sharing::create(&state.db, t.id, me.id, target.id, perm.as_str(), expires.as_deref()).await?;

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
    state.webhooks.emit(
        Event::new(Kind::ShareReceived)
            .tunnel(&t)
            .to([target.id], None)
            .data(json!({ "by": me.username, "permission": perm.as_str(), "expires_at": expires.as_deref().map(crate::util::db_to_iso_utc_z) }))
            .link("/tunnels"),
    );

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
    refuse_via_group(&state, &sharing, is_self).await?;
    let reason = if is_self { EndReason::Left } else { EndReason::Revoked { by: &me.username } };
    end_share(&state, &t, &sharing, Some(me.id), reason).await?;
    // 還在某個分享給這條通道的群組裡：群組會再給他一筆（說出來，免得以為已經拿掉了）。
    // Still in a group the tunnel is shared with: the group gives them a row again (say so, so it isn't mistaken for gone).
    let groups = db::group_shares::covering(&state.db, t.id, uid).await?;
    if !groups.is_empty() {
        crate::group_shares::kick(&state);
    }
    Ok(Json(json!({ "message": "Tunnel unshared successfully", "still_via_groups": groups })))
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
    refuse_via_group(&state, &sharing, false).await?;
    let old = sharing.permission_type.clone();
    db::sharing::set_permission(&state.db, sharing.id, perm.as_str()).await?;
    if perm == Permission::View && matches!(Permission::parse(&old), Some(Permission::Edit) | Some(Permission::Admin)) {
        db::tunnels::transfer_usernames_to_owner(&state.db, t.id, t.user_id, uid).await?;
    }
    // ADMIN ↔ 其他等級會改變可用的 OS 帳號。/ The level changes which accounts their keys go into.
    state.device_keys.kick(t.id);
    crate::access_recheck::kick(&state, Some(t.id), Some(uid));
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
    let via = db::group_shares::row_groups(&state.db, t.id).await?;
    for s in db::sharing::for_tunnel(&state.db, t.id).await? {
        let allowed = db::sharing::allowed_usernames(&state.db, s.id).await?;
        let ends = db::access_requests::username_ends(&state.db, s.id).await?;
        // 暫時提升（存取申請）：期滿還沒被收回的那幾秒就當作已經回去了。/ A raise past its end already counts as reverted.
        let raise = s.base_permission.as_deref().zip(s.permission_until.as_deref()).filter(|(_, until)| *until > crate::util::now_db().as_str());
        users.push(json!({
            "id": s.shared_with_id,
            "username": s.username,
            "email": s.email,
            "permission_type": if s.base_permission.is_some() && raise.is_none() { s.base_permission.clone().unwrap_or_default() } else { s.permission_type.clone() },
            "shared_at": db_to_iso_utc_offset(&s.shared_at),
            "expires_at": s.expires_at.as_deref().map(crate::util::db_to_iso_utc_z),
            "permission_until": raise.map(|(_, until)| crate::util::db_to_iso_utc_z(until)),
            "base_permission": raise.map(|(base, _)| base),
            "allowed_target_usernames": allowed.iter().map(|(id, u)| json!({ "id": id, "username": u, "until": ends.get(id).map(|e| crate::util::db_to_iso_utc_z(e)) })).collect::<Vec<_>>(),
            // 經由哪個群組（null = 直接分享給他）。/ Which group it comes through (null = shared with them directly).
            "via_group": via.get(&s.id).map(|(gs, g, name)| json!({ "group_share_id": gs, "group_id": g, "name": name })),
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
    refuse_via_group(&state, &sharing, false).await?;
    let ids: Vec<i64> = match body.get("allowed_target_username_ids") {
        None => vec![],
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).collect(),
        Some(_) => return Err(ApiError::bad_request("allowed_target_username_ids must be a list")),
    };
    db::sharing::replace_allowed_usernames(&state.db, sharing.id, t.id, &ids).await?;
    state.device_keys.kick(t.id);
    crate::access_recheck::kick(&state, Some(t.id), Some(uid));
    state.hub.notify_users(
        [me.id, uid],
        &json!({ "action": "TUNNEL-USERNAMES-UPDATED", "details": "Allowed target usernames updated", "tunnel_id": t.id }),
    );
    Ok(Json(json!({ "message": "Allowed usernames updated" })))
}

/// 改分享的期限（延長、改日期或改成一直有效）：ADMIN / owner。/ Change when a share ends (ADMIN / owner).
#[utoipa::path(patch, path = "/tunnels/share/{id}/{uid}/expiry", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("uid" = i64, Path, description = "User id")), request_body = super::schemas::ShareExpiryRequest, responses((status = 200, body = super::schemas::ShareExpiryRequest), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_expiry(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, uid)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = tunnel_or_404(&state, id).await?;
    if !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::forbidden("You do not have permission to manage sharing for this tunnel"));
    }
    let sharing = db::sharing::get(&state.db, t.id, uid).await?.ok_or_else(|| ApiError::not_found("Sharing not found"))?;
    refuse_via_group(&state, &sharing, false).await?;
    let Some(expires) = requested_expiry(&body)? else {
        return Err(ApiError::field("expires_at", "expires_at is required (null = no end)."));
    };
    db::sharing::set_expiry(&state.db, sharing.id, expires.as_deref()).await?;
    let iso = expires.as_deref().map(crate::util::db_to_iso_utc_z);
    let name = &t.host_friendly_name;
    let details = match expires.as_deref().and_then(crate::util::parse_db_datetime) {
        Some(at) => format!("Your access to tunnel \"{name}\" now ends {} UTC", at.format("%Y-%m-%d %H:%M")),
        None => format!("Your access to tunnel \"{name}\" no longer has an end date"),
    };
    state.hub.notify_user(uid, &json!({ "action": "TUNNEL-PERMISSION-UPDATED", "details": details, "tunnel_id": t.id, "expires_at": iso }));
    Ok(Json(json!({ "expires_at": iso })))
}

// ---------------------------------------------------------------- shared with a user group

fn id_list(body: &Value) -> ApiResult<Option<Vec<i64>>> {
    match body.get("allowed_target_username_ids") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) => Ok(Some(a.iter().filter_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).collect())),
        Some(_) => Err(ApiError::bad_request("allowed_target_username_ids must be a list")),
    }
}

/// 這條通道分享給哪些使用者群組；能管分享的人另外拿到成員名稱與可選的群組。
/// The user groups a tunnel is shared with; those who manage sharing also get member names and the groups to pick from.
async fn group_shares_json(state: &AppState, t: &Tunnel, can_manage: bool) -> ApiResult<Value> {
    let groups = db::group_shares::groups_with_counts(&state.db).await?;
    let counts: std::collections::HashMap<i64, (String, i64)> = groups.iter().map(|(id, n, c)| (*id, (n.clone(), *c))).collect();
    let rows = db::sharing::for_tunnel(&state.db, t.id).await?;
    let mut shares = Vec::new();
    let mut shared = std::collections::HashSet::new();
    for g in db::group_shares::for_tunnel(&state.db, t.id).await? {
        shared.insert(g.group_id);
        let members = db::group_shares::member_names(&state.db, g.group_id).await?;
        let through = rows.iter().filter(|r| r.group_share_id == Some(g.id)).count();
        let direct = members.iter().filter(|(uid, _)| rows.iter().any(|r| r.shared_with_id == *uid && r.group_share_id.is_none())).count();
        let by = match g.shared_by_id {
            Some(id) => db::users::by_id(&state.db, id).await?.map(|u| u.username),
            None => None,
        };
        let (name, count) = counts.get(&g.group_id).cloned().unwrap_or_default();
        shares.push(json!({
            "id": g.id,
            "group_id": g.group_id,
            "name": name,
            "members": count,
            "member_names": if can_manage { json!(members.iter().map(|(_, n)| n).collect::<Vec<_>>()) } else { Value::Null },
            "through": through,
            "direct": direct,
            "permission_type": g.permission_type,
            "expires_at": g.expires_at.as_deref().map(crate::util::db_to_iso_utc_z),
            "shared_by": by,
            "created_at": crate::util::db_to_iso_utc_z(&g.created_at),
            "allowed_target_usernames": db::group_shares::usernames(&state.db, g.id).await?.into_iter().map(|(id, u)| json!({ "id": id, "username": u, "until": null })).collect::<Vec<_>>(),
        }));
    }
    let choices: Vec<Value> = if can_manage {
        groups.iter().map(|(id, n, c)| json!({ "id": id, "name": n, "members": c, "shared": shared.contains(id) })).collect()
    } else {
        vec![]
    };
    Ok(json!({ "can_manage": can_manage, "shares": shares, "groups": choices }))
}

async fn group_share_of(state: &AppState, t: &Tunnel, gsid: i64) -> ApiResult<db::group_shares::GroupShare> {
    db::group_shares::get(&state.db, gsid).await?.filter(|g| g.tunnel_id == t.id).ok_or_else(|| ApiError::not_found("Group share not found"))
}

/// 分享給使用者群組的清單（看得到這條通道的人都能看）。/ The tunnel's group shares (anyone who can see the tunnel).
#[utoipa::path(get, path = "/api/reverse/server/{id}/group-shares", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::GroupShares), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn list_group_shares(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = tunnel_or_404(&state, id).await?;
    if permissions::effective_for(&state.db, me.id, &t).await?.is_none() {
        return Err(ApiError::forbidden("You do not have permission to view sharing for this tunnel"));
    }
    let can_manage = permissions::check_share_access(&state.db, me.id, &t).await?;
    Ok(Json(group_shares_json(&state, &t, can_manage).await?))
}

/// 分享給一個使用者群組：成員各自拿到一筆分享，之後跟著群組成員增減（owner / ADMIN）。
/// Share with a user group: each member gets a share, which follows the group's members from then on (owner / ADMIN).
#[utoipa::path(post, path = "/api/reverse/server/{id}/group-shares", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::GroupShareRequest, responses((status = 201, body = super::schemas::GroupShares), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn create_group_share(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let t = tunnel_or_404(&state, id).await?;
    if !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::forbidden("You do not have permission to share this tunnel"));
    }
    let group_id = json_i64(&body, "group_id").ok_or_else(|| ApiError::field("group_id", "Pick a user group."))?;
    let group = db::features::group(&state.db, group_id).await?.ok_or_else(|| ApiError::not_found("Group not found"))?;
    if db::group_shares::by_tunnel_group(&state.db, t.id, group.id).await?.is_some() {
        return Err(ApiError::field("group_id", "This tunnel is already shared with that group."));
    }
    let raw = json_str(&body, "permission_type").unwrap_or_else(|| "view".to_string());
    let perm = Permission::parse(&raw).ok_or_else(|| invalid_permission(&raw))?;
    let expires = requested_expiry(&body)?.flatten();
    let gsid = db::group_shares::create(&state.db, t.id, group.id, me.id, perm.as_str(), expires.as_deref()).await?;
    if let Some(ids) = id_list(&body)? {
        db::group_shares::set_usernames(&state.db, gsid, t.id, &ids).await?;
    }
    state.gateway.event("group_share", None, None, Some(t.id), format!("{} shared \"{}\" with the group \"{}\" ({})", me.username, t.host_friendly_name, group.name, perm.as_str())).await;
    crate::group_shares::reconcile(&state, &std::collections::HashMap::new()).await?;
    if t.user_id != me.id {
        state.hub.notify_user(
            t.user_id,
            &json!({ "action": "TUNNEL-SHARED", "details": format!("{} shared your tunnel \"{}\" with the group \"{}\"", me.username, t.host_friendly_name, group.name), "tunnel_id": t.id }),
        );
    }
    state.hub.notify_user(me.id, &json!({ "action": "TUNNEL-SHARED", "tunnel_id": t.id }));
    Ok((StatusCode::CREATED, Json(group_shares_json(&state, &t, true).await?)))
}

/// 改群組分享的權限、帳號或期限；成員的分享跟著改（owner / ADMIN）。/ Change a group share; members' shares follow.
#[utoipa::path(patch, path = "/api/reverse/server/{id}/group-shares/{gsid}", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("gsid" = i64, Path, description = "Group share id")), request_body = super::schemas::GroupShareRequest, responses((status = 200, body = super::schemas::GroupShares), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_group_share(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, gsid)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = tunnel_or_404(&state, id).await?;
    if !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::forbidden("You do not have permission to manage sharing for this tunnel"));
    }
    let g = group_share_of(&state, &t, gsid).await?;
    let perm = match json_str(&body, "permission_type") {
        Some(raw) => Some(Permission::parse(&raw).ok_or_else(|| invalid_permission(&raw))?),
        None => None,
    };
    let expires = requested_expiry(&body)?;
    let ids = id_list(&body)?;
    db::group_shares::update(&state.db, g.id, perm.map(|p| p.as_str()), expires.as_ref().map(|e| e.as_deref())).await?;
    if let Some(ids) = &ids {
        db::group_shares::set_usernames(&state.db, g.id, t.id, ids).await?;
    }
    let name = db::features::group(&state.db, g.group_id).await?.map(|g| g.name).unwrap_or_default();
    let mut what = Vec::new();
    if let Some(p) = perm {
        what.push(format!("permission {}", p.as_str()));
    }
    if ids.is_some() {
        what.push("accounts".to_string());
    }
    if expires.is_some() {
        what.push("end".to_string());
    }
    state.gateway.event("group_share", None, None, Some(t.id), format!("{} changed the share of \"{}\" with the group \"{name}\": {}", me.username, t.host_friendly_name, what.join(", "))).await;
    crate::group_shares::reconcile(&state, &std::collections::HashMap::new()).await?;
    state.hub.notify_user(me.id, &json!({ "action": "TUNNEL-PERMISSION-UPDATED", "tunnel_id": t.id }));
    Ok(Json(group_shares_json(&state, &t, true).await?))
}

/// 不再分享給這個群組：經由它拿到的人都結束（直接分享的人不受影響；owner / ADMIN）。
/// Stop sharing with the group: everyone holding access through it loses it (direct shares stay; owner / ADMIN).
#[utoipa::path(delete, path = "/api/reverse/server/{id}/group-shares/{gsid}", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("gsid" = i64, Path, description = "Group share id")), responses((status = 200, body = super::schemas::GroupShares), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_group_share(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, gsid)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    let t = tunnel_or_404(&state, id).await?;
    if !permissions::check_share_access(&state.db, me.id, &t).await? {
        return Err(ApiError::forbidden("You do not have permission to manage sharing for this tunnel"));
    }
    let g = group_share_of(&state, &t, gsid).await?;
    let name = db::features::group(&state.db, g.group_id).await?.map(|g| g.name).unwrap_or_default();
    db::group_shares::delete(&state.db, g.id).await?;
    state.gateway.event("group_share", None, None, Some(t.id), format!("{} stopped sharing \"{}\" with the group \"{name}\"", me.username, t.host_friendly_name)).await;
    crate::group_shares::reconcile(&state, &std::collections::HashMap::from([(g.id, name)])).await?;
    state.hub.notify_user(me.id, &json!({ "action": "TUNNEL-UNSHARED", "tunnel_id": t.id }));
    // 刪的人自己可能也是經由這個群組拿到的（ADMIN）：那就看不到了。/ The deleter may have held it through this group.
    let can_manage = permissions::check_share_access(&state.db, me.id, &t).await?;
    Ok(Json(group_shares_json(&state, &t, can_manage).await?))
}
