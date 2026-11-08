//! 個人群組（`/api/user/groups*`）：任何人都能自己建一群人，一次把通道分享給他們。只有建立的人看得到、改得到；
//! 只用在分享 —— 功能權限永遠不看它（那是管理員的組織群組，見 `api::access`）。
//! - `GET /api/user/groups` → `{groups, users, limit, max_members}`（`users` = 能加進來的人：其他還在用的帳號）
//! - `POST /api/user/groups`、`PATCH/DELETE /api/user/groups/{id}` → 同上（建立多一個 `created_id`）
//! - `POST /api/user/groups/{id}/preview` `{members}` | `{delete: true}` → 誰會多了 / 少了哪些通道
//! - `DELETE /api/user/groups/{id}/membership` → 退出別人的個人群組（任何人都能把你加進去，所以你一定能自己退出）
//!
//! 能加誰：只有至少管得到一條通道分享的人（擁有者或 ADMIN）拿得到帳號清單、能放成員 —— 跟「可分享的人」名單同一道
//! 門檻；不然誰都能用成員 id 試出有哪些帳號。/ Only people who manage sharing on at least one tunnel get the account
//! list and may add members — the available-users bar; otherwise anyone could probe member ids to list accounts.
//!
//! 分享給個人群組的通道跟著它的成員走，但只在群組主人還管得到那條通道時算（見 `crate::group_shares`）。
//! 別人的群組一律 404。
//!
//! Personal groups: anyone may make a group of people to share tunnels with at once. Only its maker sees and edits it;
//! it is used only for sharing — feature permissions never read it (those are the admins' organization groups, see
//! `api::access`). Tunnels shared with one follow its members while its owner still manages the tunnel (see
//! `crate::group_shares`). Someone else's group is a 404.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, users::User};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, create))
        .routes(routes!(update, remove))
        .routes(routes!(preview))
        .routes(routes!(leave))
}

/// 一個人最多幾個個人群組。/ Personal groups per person.
pub const MAX_GROUPS: usize = 50;
/// 一個個人群組最多幾個人。/ Members per personal group.
pub const MAX_MEMBERS: usize = 200;

async fn list_json(state: &AppState, me: &User) -> ApiResult<Value> {
    let can_share = db::group_shares::manages_any(&state.db, me.id).await?;
    let groups = db::features::personal_groups(&state.db, me.id).await?;
    let ids: Vec<i64> = groups.iter().map(|g| g.id).collect();
    let active = crate::group_shares::active_shares(state).await?;
    let mut shares: HashMap<i64, Vec<Value>> = HashMap::new();
    let mut sees: HashMap<i64, bool> = HashMap::new();
    for (id, g, tunnel_id, tunnel_name, _owner, perm, _expires, _through) in db::group_shares::shares_of_groups(&state.db, &ids).await? {
        // 已經看不到的通道（分享暫停中）不說名字。/ No name for a tunnel I can no longer see (the share is paused).
        let visible = match sees.get(&tunnel_id) {
            Some(v) => *v,
            None => {
                let v = match db::tunnels::by_id(&state.db, tunnel_id).await? {
                    Some(t) => crate::permissions::effective_for(&state.db, me.id, &t).await?.is_some(),
                    None => false,
                };
                sees.insert(tunnel_id, v);
                v
            }
        };
        shares.entry(g).or_default().push(json!({
            "id": id,
            "tunnel_id": tunnel_id,
            "tunnel_name": if visible { Some(tunnel_name) } else { None },
            "permission_type": perm,
            "active": active.contains(&id),
        }));
    }
    let users = db::users::all_ordered(&state.db).await?;
    let names: HashMap<i64, &str> = users.iter().map(|u| (u.id, u.username.as_str())).collect();
    let mut out = Vec::new();
    for g in &groups {
        let members = db::features::members_of(&state.db, g.id).await?;
        let mut member_names: Vec<&str> = members.iter().filter_map(|u| names.get(u).copied()).collect();
        member_names.sort_by_key(|n| n.to_lowercase());
        out.push(json!({
            "id": g.id,
            "name": g.label(),
            "description": g.description,
            "members": members,
            "member_names": member_names,
            "shares": shares.remove(&g.id).unwrap_or_default(),
            "created_at": crate::util::db_to_iso_utc_z(&g.created_at),
        }));
    }
    let pickable: Vec<Value> = if can_share {
        users.iter().filter(|u| u.is_active && u.id != me.id).map(|u| json!({ "id": u.id, "username": u.username, "email": u.email })).collect()
    } else {
        vec![]
    };
    Ok(json!({
        "groups": out,
        "can_share": can_share,
        "users": pickable,
        "limit": MAX_GROUPS,
        "max_members": MAX_MEMBERS,
    }))
}

/// `members`：其他還在用的帳號（不能放自己：自己分享出去的不會回到自己身上）。
/// `members`: other active accounts (not yourself: what you share never comes back to you).
async fn parse_members(state: &AppState, me: &User, body: &Value) -> ApiResult<Option<Vec<i64>>> {
    let Some(v) = body.get("members") else { return Ok(None) };
    let Some(arr) = v.as_array() else { return Err(ApiError::field("members", "Must be a list of user ids.")) };
    let mut ids: Vec<i64> = Vec::new();
    for x in arr {
        let Some(id) = x.as_i64() else { return Err(ApiError::field("members", "Must be a list of user ids.")) };
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.len() > MAX_MEMBERS {
        return Err(ApiError::field("members", format!("At most {MAX_MEMBERS} people in a group.")));
    }
    if ids.contains(&me.id) {
        return Err(ApiError::field("members", "You don't need to be in your own group."));
    }
    // 管不到任何通道的人不能放成員（不然成員 id 的對錯就能列出帳號）。/ No tunnel to manage, no members (else ids would list accounts).
    if !ids.is_empty() && !db::group_shares::manages_any(&state.db, me.id).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            json!({ "error": "Add people once you own or administer a tunnel to share.", "code": "no_tunnels" }),
        ));
    }
    let active: std::collections::HashSet<i64> = db::users::all_ordered(&state.db).await?.iter().filter(|u| u.is_active).map(|u| u.id).collect();
    if let Some(bad) = ids.iter().find(|id| !active.contains(id)) {
        return Err(ApiError::field("members", format!("User {bad} does not exist or is disabled.")));
    }
    ids.sort_unstable();
    Ok(Some(ids))
}

async fn mine(state: &AppState, me: &User, id: i64) -> ApiResult<db::features::Group> {
    db::features::personal_group(&state.db, me.id, id).await?.ok_or_else(|| ApiError::not_found("Group not found."))
}

#[utoipa::path(get, path = "/api/user/groups", tag = "Personal Groups", security(("bearer" = [])), responses((status = 200, body = super::schemas::PersonalGroups)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(list_json(&state, &me).await?))
}

#[utoipa::path(post, path = "/api/user/groups", tag = "Personal Groups", security(("bearer" = [])), request_body = super::schemas::PersonalGroupWrite, responses((status = 201, description = "The list, plus `created_id`", body = super::schemas::PersonalGroups), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody)))]
async fn create(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = super::access::parse_name(&body)?.ok_or_else(|| ApiError::field("name", "This field is required."))?;
    let description = super::access::parse_description(&body)?.unwrap_or_default();
    let members = parse_members(&state, &me, &body).await?;
    if db::features::personal_groups(&state.db, me.id).await?.len() >= MAX_GROUPS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": format!("At most {MAX_GROUPS} personal groups."), "code": "limit" })));
    }
    if db::features::personal_name_taken(&state.db, me.id, &name, None).await? {
        return Err(ApiError::field("name", "A group with this name already exists."));
    }
    let id = db::features::create_personal(&state.db, me.id, &name, &description).await?;
    if let Some(m) = &members {
        db::features::set_members(&state.db, id, m).await?;
    }
    let mut out = list_json(&state, &me).await?;
    out["created_id"] = json!(id);
    Ok((StatusCode::CREATED, Json(out)))
}

#[utoipa::path(patch, path = "/api/user/groups/{id}", tag = "Personal Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), request_body = super::schemas::PersonalGroupWrite, responses((status = 200, body = super::schemas::PersonalGroups), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    mine(&state, &me, id).await?;
    let name = super::access::parse_name(&body)?;
    let description = super::access::parse_description(&body)?;
    let members = parse_members(&state, &me, &body).await?;
    if let Some(n) = &name {
        if db::features::personal_name_taken(&state.db, me.id, n, Some(id)).await? {
            return Err(ApiError::field("name", "A group with this name already exists."));
        }
    }
    db::features::update_personal(&state.db, id, name.as_deref(), description.as_deref()).await?;
    if let Some(m) = &members {
        db::features::set_members(&state.db, id, m).await?;
        // 分享給這個群組的通道跟著成員走。/ Tunnels shared with it follow its members.
        crate::group_shares::reconcile(&state, &HashMap::new()).await?;
    }
    Ok(Json(list_json(&state, &me).await?))
}

#[utoipa::path(delete, path = "/api/user/groups/{id}", tag = "Personal Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), responses((status = 200, body = super::schemas::PersonalGroups), (status = 404, body = super::schemas::ErrorBody)))]
async fn remove(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let group = mine(&state, &me, id).await?;
    let shares = db::group_shares::shares_of_groups(&state.db, &[id]).await?;
    let gone = crate::group_shares::gone_for_group(&state, id, group.label()).await?;
    db::features::delete_group(&state.db, id).await?;
    for (_, _, tunnel_id, tunnel_name, ..) in &shares {
        state
            .gateway
            .event("group_share", None, None, Some(*tunnel_id), format!("The share of \"{tunnel_name}\" with the personal group \"{}\" ended: {} deleted the group", group.label(), me.username))
            .await;
    }
    crate::group_shares::reconcile(&state, &gone).await?;
    Ok(Json(list_json(&state, &me).await?))
}

/// 預告：換掉成員或刪掉群組，誰會多了 / 少了哪些通道（什麼都不寫）。/ Preview a member change or a delete (writes nothing).
#[utoipa::path(post, path = "/api/user/groups/{id}/preview", tag = "Personal Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), request_body = super::schemas::GroupPreviewRequest, responses((status = 200, body = super::schemas::GroupPreview), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn preview(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    mine(&state, &me, id).await?;
    let change = match parse_members(&state, &me, &body).await? {
        Some(m) => crate::group_shares::Change::Members(m),
        None if body.get("delete") == Some(&Value::Bool(true)) => crate::group_shares::Change::Unshared,
        None => return Err(ApiError::bad_request("Send one of: members, delete: true.")),
    };
    Ok(Json(crate::group_shares::preview(&state, id, &change).await?))
}

/// 退出別人的個人群組：經由它拿到的通道收回（自己另有的分享不受影響）。只限個人群組，組織群組由管理員管。
/// Leave someone else's personal group: tunnels held through it go (shares of your own stay). Personal groups only;
/// organization groups are kept by admins.
#[utoipa::path(delete, path = "/api/user/groups/{id}/membership", tag = "Personal Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), responses((status = 200, body = super::schemas::GroupLeft), (status = 404, body = super::schemas::ErrorBody)))]
async fn leave(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let group = db::features::any_group(&state.db, id)
        .await?
        .filter(|g| g.owner_id.is_some_and(|o| o != me.id))
        .ok_or_else(|| ApiError::not_found("Group not found."))?;
    if !db::features::members_of(&state.db, id).await?.contains(&me.id) {
        return Err(ApiError::not_found("Group not found."));
    }
    db::features::remove_member(&state.db, id, me.id).await?;
    let owner = match group.owner_id {
        Some(o) => db::users::by_id(&state.db, o).await?.map(|u| u.username).unwrap_or_default(),
        None => String::new(),
    };
    let shares = db::group_shares::shares_of_groups(&state.db, &[id]).await?;
    for (_, _, tunnel_id, ..) in &shares {
        state
            .gateway
            .event("group_share", None, None, Some(*tunnel_id), format!("{} left {owner}'s personal group \"{}\"", me.username, group.label()))
            .await;
    }
    crate::group_shares::reconcile(&state, &HashMap::new()).await?;
    if let Some(o) = group.owner_id {
        state.hub.notify_user(o, &json!({ "action": "PERSONAL-GROUP-LEFT", "group_id": id, "group": group.label(), "user": me.username }));
    }
    Ok(Json(json!({ "left": true, "group": group.label(), "tunnels": shares.len() })))
}
