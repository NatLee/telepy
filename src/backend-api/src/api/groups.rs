//! 群組（每個人自己的，模型見 `db::groups`）：
//! - `GET/POST /api/reverse/tunnel-groups`、`PATCH/DELETE /api/reverse/tunnel-groups/{id}`、
//!   `PUT /api/reverse/tunnel-groups/{id}/tunnels`（整組成員換掉）、`PUT /api/reverse/tunnel-groups/order`、
//!   `PUT /api/reverse/server/{id}/group`（一條通道換組；`group_id: null` = 拿出來）
//! - `GET/POST /api/reverse/user/key-groups`、`PATCH/DELETE /api/reverse/user/key-groups/{id}`、
//!   `PUT /api/reverse/user/key-groups/{id}/keys`、`POST /api/reverse/user/key-groups/{id}/grants`、
//!   `PATCH/DELETE /api/reverse/user/key-groups/{id}/grants/{grant_id}`
//!
//! 兩種群組都有說明（≤ 500 字）與標籤（規則同通道標籤，≤ 12 個）：建立時可給，PATCH 只改有給的欄位。
//! Both kinds carry a description (≤ 500 characters) and labels (the tunnel label rules, ≤ 12): optional on
//! create, and PATCH changes only the fields it is given.
//!
//! 改動都回傳整份清單 `{groups, group?}`（`group` = 新建 / 改到的那組）。動到金鑰群組或通道群組的成員、授予時，
//! 受影響的裝置立刻同步金鑰（`device_keys.kick`）。
//!
//! Personal tunnel groups, key groups and key group grants. Every write answers the whole list `{groups, group?}`;
//! changes that move keys kick the affected devices' key sync.

use std::collections::BTreeSet;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, groups as g};
use crate::error::{ApiError, ApiResult};
use crate::permissions;
use crate::state::AppState;
use crate::util::db_to_iso_utc_z;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list_tunnel_groups, create_tunnel_group))
        .routes(routes!(reorder_tunnel_groups))
        .routes(routes!(update_tunnel_group, delete_tunnel_group))
        .routes(routes!(set_tunnel_group_members))
        .routes(routes!(set_tunnel_group))
        .routes(routes!(list_key_groups, create_key_group))
        .routes(routes!(update_key_group, delete_key_group))
        .routes(routes!(set_key_group_members))
        .routes(routes!(add_grant))
        .routes(routes!(update_grant, delete_grant))
}

fn not_found() -> ApiError {
    ApiError::not_found("Group not found")
}

/// `name` 欄位：正規化、同一個人不能重名（不分大小寫）。/ The `name` field: normalised and unique per person (ignoring case).
fn name_from(body: &Value) -> ApiResult<String> {
    let raw = body.get("name").and_then(Value::as_str).ok_or_else(|| ApiError::field("name", "This field is required."))?;
    g::normalize_name(raw).map_err(|m| ApiError::field("name", m))
}

/// `description` / `labels`：沒給就用 `base`（建立時是空的，修改時是原本的）。
/// `description` / `labels`: absent fields keep `base` (empty when creating, the current values when updating).
fn meta_from(body: &Value, base: g::Meta) -> ApiResult<g::Meta> {
    let mut meta = base;
    match body.get("description") {
        None => {}
        Some(Value::Null) => meta.description = String::new(),
        Some(Value::String(d)) => meta.description = g::normalize_description(d).map_err(|m| ApiError::field("description", m))?,
        Some(_) => return Err(ApiError::field("description", "Expected text.")),
    }
    match body.get("labels") {
        None => {}
        Some(Value::Null) => meta.labels = Vec::new(),
        Some(Value::Array(a)) => {
            let raw = a.iter().map(|v| v.as_str().map(str::to_string).ok_or_else(|| ApiError::field("labels", "Expected a list of labels."))).collect::<ApiResult<Vec<_>>>()?;
            meta.labels = db::tunnel_tags::normalize_labels(&raw).map_err(|m| ApiError::field("labels", m))?;
        }
        Some(_) => return Err(ApiError::field("labels", "Expected a list of labels.")),
    }
    Ok(meta)
}

/// PATCH 的名稱：沒給就是原本的。/ The name on PATCH: absent = unchanged.
fn name_or(body: &Value, current: &str) -> ApiResult<String> {
    if body.get("name").is_some() { name_from(body) } else { Ok(current.to_string()) }
}

/// 一串 id（`field` 必須是整數陣列；去重複、保留順序）。/ A list of ids (deduplicated, order kept).
fn ids_from(body: &Value, field: &str) -> ApiResult<Option<Vec<i64>>> {
    let Some(v) = body.get(field) else { return Ok(None) };
    let list = v.as_array().ok_or_else(|| ApiError::field(field, "Expected a list of ids."))?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(list.len());
    for x in list {
        let id = x.as_i64().ok_or_else(|| ApiError::field(field, "Expected a list of ids."))?;
        if seen.insert(id) {
            out.push(id);
        }
    }
    Ok(Some(out))
}

/// 只能放自己看得到的通道。/ Only tunnels the caller can see.
async fn check_tunnels(state: &AppState, user_id: i64, ids: &[i64]) -> ApiResult<()> {
    let visible: BTreeSet<i64> = db::tunnels::visible_to(&state.db, user_id).await?.into_iter().map(|t| t.id).collect();
    if let Some(bad) = ids.iter().find(|id| !visible.contains(id)) {
        return Err(ApiError::field("tunnel_ids", format!("Tunnel {bad} not found or access denied.")));
    }
    Ok(())
}

/// 只能放自己的金鑰。/ Only the caller's own keys.
async fn check_keys(state: &AppState, user_id: i64, ids: &[i64]) -> ApiResult<()> {
    let mine: BTreeSet<i64> = db::keys::user_keys(&state.db, user_id).await?.into_iter().map(|k| k.id).collect();
    if let Some(bad) = ids.iter().find(|id| !mine.contains(id)) {
        return Err(ApiError::field("key_ids", format!("Key {bad} is not one of your keys.")));
    }
    Ok(())
}

// ---------------------------------------------------------------- tunnel groups

/// 我的通道群組（照我排的順序），每組列出我還看得到的成員。/ My tunnel groups in my order, with the members I can still see.
async fn tunnel_groups_json(state: &AppState, user_id: i64) -> ApiResult<Vec<Value>> {
    let groups = g::tunnel_groups(&state.db, user_id).await?;
    let membership = g::tunnel_group_of(&state.db, user_id).await?;
    let visible: BTreeSet<i64> = db::tunnels::visible_to(&state.db, user_id).await?.into_iter().map(|t| t.id).collect();
    Ok(groups
        .iter()
        .map(|grp| {
            let mut ids: Vec<i64> = membership.iter().filter(|(t, gid)| **gid == grp.id && visible.contains(t)).map(|(t, _)| *t).collect();
            ids.sort_unstable();
            json!({
                "id": grp.id,
                "name": grp.name,
                "description": grp.description,
                "labels": g::parse_labels(&grp.labels),
                "position": grp.position,
                "tunnel_ids": ids,
                "created_at": db_to_iso_utc_z(&grp.created_at),
            })
        })
        .collect())
}

async fn tunnel_groups_reply(state: &AppState, user_id: i64, group: Option<i64>) -> ApiResult<Json<Value>> {
    let groups = tunnel_groups_json(state, user_id).await?;
    let one = group.and_then(|id| groups.iter().find(|v| v["id"] == id).cloned());
    Ok(Json(json!({ "groups": groups, "group": one })))
}

async fn own_tunnel_group(state: &AppState, user_id: i64, id: i64) -> ApiResult<g::TunnelGroup> {
    g::tunnel_group(&state.db, user_id, id).await?.ok_or_else(not_found)
}

#[utoipa::path(get, path = "/api/reverse/tunnel-groups", tag = "Groups", security(("bearer" = [])), responses((status = 200, body = super::schemas::TunnelGroups)))]
async fn list_tunnel_groups(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    tunnel_groups_reply(&state, user.id, None).await
}

/// 建立通道群組，可順便放進通道（從別組移過來）。/ Create a tunnel group, optionally moving tunnels into it.
#[utoipa::path(post, path = "/api/reverse/tunnel-groups", tag = "Groups", security(("bearer" = [])), request_body = super::schemas::TunnelGroupWrite, responses((status = 201, body = super::schemas::TunnelGroups), (status = 400, description = "{name: [message]} / {tunnel_ids: [message]}", body = super::schemas::ErrorBody)))]
async fn create_tunnel_group(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = name_from(&body)?;
    let meta = meta_from(&body, g::Meta::default())?;
    let tunnels = ids_from(&body, "tunnel_ids")?.unwrap_or_default();
    if g::tunnel_groups(&state.db, user.id).await?.len() >= g::MAX_GROUPS {
        return Err(ApiError::field("name", format!("You can have at most {} tunnel groups.", g::MAX_GROUPS)));
    }
    if g::tunnel_group_name_taken(&state.db, user.id, &name, None).await? {
        return Err(ApiError::field("name", "You already have a group with this name."));
    }
    check_tunnels(&state, user.id, &tunnels).await?;
    let grp = g::create_tunnel_group(&state.db, user.id, &name, &meta).await?;
    if !tunnels.is_empty() {
        let moved = g::replace_tunnel_group_members(&state.db, user.id, grp.id, &tunnels).await?;
        state.device_keys.kick_many(moved);
    }
    Ok((StatusCode::CREATED, tunnel_groups_reply(&state, user.id, Some(grp.id)).await?))
}

#[utoipa::path(put, path = "/api/reverse/tunnel-groups/order", tag = "Groups", security(("bearer" = [])), request_body = super::schemas::GroupOrder, responses((status = 200, body = super::schemas::TunnelGroups), (status = 400, body = super::schemas::ErrorBody)))]
async fn reorder_tunnel_groups(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let ids = ids_from(&body, "ids")?.ok_or_else(|| ApiError::field("ids", "This field is required."))?;
    g::reorder_tunnel_groups(&state.db, user.id, &ids).await?;
    tunnel_groups_reply(&state, user.id, None).await
}

#[utoipa::path(patch, path = "/api/reverse/tunnel-groups/{id}", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel group id")), request_body = super::schemas::GroupUpdate, responses((status = 200, body = super::schemas::TunnelGroups), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_tunnel_group(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let grp = own_tunnel_group(&state, user.id, id).await?;
    let name = name_or(&body, &grp.name)?;
    let meta = meta_from(&body, g::Meta { description: grp.description.clone(), labels: g::parse_labels(&grp.labels) })?;
    if g::tunnel_group_name_taken(&state.db, user.id, &name, Some(id)).await? {
        return Err(ApiError::field("name", "You already have a group with this name."));
    }
    g::update_tunnel_group(&state.db, id, &name, &meta).await?;
    tunnel_groups_reply(&state, user.id, Some(id)).await
}

/// 刪掉群組：通道回到未分組，授予給這組的金鑰群組從這些裝置移除。/ Delete: tunnels become ungrouped; grants to it end.
#[utoipa::path(delete, path = "/api/reverse/tunnel-groups/{id}", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel group id")), responses((status = 200, body = super::schemas::TunnelGroups), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_tunnel_group(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    own_tunnel_group(&state, user.id, id).await?;
    let members = g::delete_tunnel_group(&state.db, user.id, id).await?;
    state.device_keys.kick_many(members);
    tunnel_groups_reply(&state, user.id, None).await
}

/// 整組成員換掉（給的通道從別組移過來，沒給的回到未分組）。/ Replace the members (moved from other groups; the rest ungrouped).
#[utoipa::path(put, path = "/api/reverse/tunnel-groups/{id}/tunnels", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel group id")), request_body = super::schemas::TunnelGroupMembers, responses((status = 200, body = super::schemas::TunnelGroups), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_tunnel_group_members(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    own_tunnel_group(&state, user.id, id).await?;
    let tunnels = ids_from(&body, "tunnel_ids")?.ok_or_else(|| ApiError::field("tunnel_ids", "This field is required."))?;
    check_tunnels(&state, user.id, &tunnels).await?;
    let involved = g::replace_tunnel_group_members(&state.db, user.id, id, &tunnels).await?;
    state.device_keys.kick_many(involved);
    tunnel_groups_reply(&state, user.id, Some(id)).await
}

/// 一條通道換組（`group_id: null` = 拿出來）。看得到通道就能分（分組只影響自己）。
/// Move one tunnel to a group (`group_id: null` = ungroup). Anyone who sees the tunnel may (it only affects them).
#[utoipa::path(put, path = "/api/reverse/server/{id}/group", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::TunnelGroupChoice, responses((status = 200, body = super::schemas::TunnelGroups), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_tunnel_group(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    if permissions::effective_for(&state.db, user.id, &t).await?.is_none() {
        return Err(ApiError::drf_not_found());
    }
    let group = match body.get("group_id") {
        None => return Err(ApiError::field("group_id", "This field is required.")),
        Some(Value::Null) => None,
        Some(v) => {
            let gid = v.as_i64().ok_or_else(|| ApiError::field("group_id", "Expected a group id or null."))?;
            own_tunnel_group(&state, user.id, gid).await.map_err(|_| ApiError::field("group_id", "Group not found."))?;
            Some(gid)
        }
    };
    g::set_tunnel_group(&state.db, user.id, t.id, group).await?;
    state.device_keys.kick(t.id);
    tunnel_groups_reply(&state, user.id, group).await
}

// ---------------------------------------------------------------- key groups

/// 我的金鑰群組（依名稱），每組的金鑰與授予。/ My key groups by name, with their keys and grants.
async fn key_groups_json(state: &AppState, user_id: i64) -> ApiResult<Vec<Value>> {
    let groups = g::key_groups(&state.db, user_id).await?;
    let membership = g::key_group_of(&state.db, user_id).await?;
    let grants = g::grants_of_user(&state.db, user_id).await?;
    Ok(groups
        .iter()
        .map(|grp| {
            let mut keys: Vec<i64> = membership.iter().filter(|(_, gid)| **gid == grp.id).map(|(k, _)| *k).collect();
            keys.sort_unstable();
            let grants: Vec<Value> = grants.iter().filter(|gr| gr.key_group_id == grp.id).map(grant_json).collect();
            json!({
                "id": grp.id,
                "name": grp.name,
                "description": grp.description,
                "labels": g::parse_labels(&grp.labels),
                "key_ids": keys,
                "grants": grants,
                "created_at": db_to_iso_utc_z(&grp.created_at),
            })
        })
        .collect())
}

fn grant_json(gr: &g::Grant) -> Value {
    json!({
        "id": gr.id,
        "tunnel": gr.tunnel_id.map(|id| json!({ "id": id, "name": gr.tunnel_name })),
        "tunnel_group": gr.tunnel_group_id.map(|id| json!({ "id": id, "name": gr.tunnel_group_name })),
        "accounts": gr.account_names(),
        "created_at": db_to_iso_utc_z(&gr.created_at),
    })
}

async fn key_groups_reply(state: &AppState, user_id: i64, group: Option<i64>) -> ApiResult<Json<Value>> {
    let groups = key_groups_json(state, user_id).await?;
    let one = group.and_then(|id| groups.iter().find(|v| v["id"] == id).cloned());
    Ok(Json(json!({ "groups": groups, "group": one })))
}

async fn own_key_group(state: &AppState, user_id: i64, id: i64) -> ApiResult<g::KeyGroup> {
    g::key_group(&state.db, user_id, id).await?.ok_or_else(not_found)
}

/// 這些金鑰群組碰到的通道全部同步一次。/ Kick every tunnel these key groups reach.
async fn kick_key_groups(state: &AppState, ids: impl IntoIterator<Item = i64>) -> ApiResult<()> {
    for id in ids {
        state.device_keys.kick_many(g::key_group_reach(&state.db, id).await?);
    }
    Ok(())
}

#[utoipa::path(get, path = "/api/reverse/user/key-groups", tag = "Groups", security(("bearer" = [])), responses((status = 200, body = super::schemas::KeyGroups)))]
async fn list_key_groups(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    key_groups_reply(&state, user.id, None).await
}

/// 建立金鑰群組，可順便放進金鑰（從別組移過來）。/ Create a key group, optionally moving keys into it.
#[utoipa::path(post, path = "/api/reverse/user/key-groups", tag = "Groups", security(("bearer" = [])), request_body = super::schemas::KeyGroupWrite, responses((status = 201, body = super::schemas::KeyGroups), (status = 400, description = "{name: [message]} / {key_ids: [message]}", body = super::schemas::ErrorBody)))]
async fn create_key_group(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = name_from(&body)?;
    let meta = meta_from(&body, g::Meta::default())?;
    let keys = ids_from(&body, "key_ids")?.unwrap_or_default();
    if g::key_groups(&state.db, user.id).await?.len() >= g::MAX_GROUPS {
        return Err(ApiError::field("name", format!("You can have at most {} key groups.", g::MAX_GROUPS)));
    }
    if g::key_group_name_taken(&state.db, user.id, &name, None).await? {
        return Err(ApiError::field("name", "You already have a group with this name."));
    }
    check_keys(&state, user.id, &keys).await?;
    let grp = g::create_key_group(&state.db, user.id, &name, &meta).await?;
    if !keys.is_empty() {
        let others = g::replace_key_group_members(&state.db, grp.id, &keys).await?;
        kick_key_groups(&state, others).await?;
    }
    Ok((StatusCode::CREATED, key_groups_reply(&state, user.id, Some(grp.id)).await?))
}

#[utoipa::path(patch, path = "/api/reverse/user/key-groups/{id}", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Key group id")), request_body = super::schemas::GroupUpdate, responses((status = 200, body = super::schemas::KeyGroups), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_key_group(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let grp = own_key_group(&state, user.id, id).await?;
    let name = name_or(&body, &grp.name)?;
    let meta = meta_from(&body, g::Meta { description: grp.description.clone(), labels: g::parse_labels(&grp.labels) })?;
    if g::key_group_name_taken(&state.db, user.id, &name, Some(id)).await? {
        return Err(ApiError::field("name", "You already have a group with this name."));
    }
    g::update_key_group(&state.db, id, &name, &meta).await?;
    key_groups_reply(&state, user.id, Some(id)).await
}

/// 刪掉金鑰群組：金鑰留著，經由它授予的從裝置移除（直接在清單上的不受影響）。
/// Delete a key group: the keys stay; what it granted leaves the devices (directly listed keys are untouched).
#[utoipa::path(delete, path = "/api/reverse/user/key-groups/{id}", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Key group id")), responses((status = 200, body = super::schemas::KeyGroups), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_key_group(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    own_key_group(&state, user.id, id).await?;
    let reach = g::key_group_reach(&state.db, id).await?;
    g::delete_key_group(&state.db, user.id, id).await?;
    state.device_keys.kick_many(reach);
    key_groups_reply(&state, user.id, None).await
}

/// 整組金鑰換掉：加進來的裝到這組授予的每台裝置，拿掉的從那些裝置移除。
/// Replace the keys: added keys go to every device the group is granted to, removed ones leave them.
#[utoipa::path(put, path = "/api/reverse/user/key-groups/{id}/keys", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Key group id")), request_body = super::schemas::KeyGroupMembers, responses((status = 200, body = super::schemas::KeyGroups), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_key_group_members(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    own_key_group(&state, user.id, id).await?;
    let keys = ids_from(&body, "key_ids")?.ok_or_else(|| ApiError::field("key_ids", "This field is required."))?;
    check_keys(&state, user.id, &keys).await?;
    let mut touched = g::replace_key_group_members(&state.db, id, &keys).await?;
    touched.insert(id);
    kick_key_groups(&state, touched).await?;
    key_groups_reply(&state, user.id, Some(id)).await
}

/// `accounts`：沒給 / null = 每個允許的帳號，否則是帳號名稱。/ `accounts`: absent / null = all, else account names.
fn grant_accounts(body: &Value) -> ApiResult<Option<Vec<String>>> {
    let names: Option<Vec<String>> = match body.get("accounts") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => Some(a.iter().map(|v| v.as_str().map(str::to_string).ok_or_else(|| ApiError::field("accounts", "Expected a list of account names."))).collect::<ApiResult<_>>()?),
        Some(_) => return Err(ApiError::field("accounts", "Expected a list of account names or null.")),
    };
    g::normalize_accounts(names.as_deref()).map_err(|m| ApiError::field("accounts", m))
}

/// 授予這個金鑰群組：給一條通道（`tunnel_id`，看得到就行）或自己的一個通道群組（`tunnel_group_id`）。同一個對象再給一次 = 改帳號。
/// Grant the key group to a tunnel (`tunnel_id`, any tunnel you can see) or one of your tunnel groups
/// (`tunnel_group_id`). Granting the same target again updates its accounts.
#[utoipa::path(post, path = "/api/reverse/user/key-groups/{id}/grants", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Key group id")), request_body = super::schemas::KeyGroupGrantWrite, responses((status = 200, body = super::schemas::KeyGroups), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn add_grant(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    own_key_group(&state, user.id, id).await?;
    let tunnel = body.get("tunnel_id").and_then(Value::as_i64);
    let tunnel_group = body.get("tunnel_group_id").and_then(Value::as_i64);
    let target = match (tunnel, tunnel_group) {
        (Some(t), None) => {
            check_tunnels(&state, user.id, &[t]).await.map_err(|_| ApiError::field("tunnel_id", "Tunnel not found or access denied."))?;
            g::Target::Tunnel(t)
        }
        (None, Some(tg)) => {
            own_tunnel_group(&state, user.id, tg).await.map_err(|_| ApiError::field("tunnel_group_id", "Group not found."))?;
            g::Target::TunnelGroup(tg)
        }
        _ => return Err(ApiError::field("tunnel_id", "Give exactly one of tunnel_id or tunnel_group_id.")),
    };
    let accounts = grant_accounts(&body)?;
    if g::grant_count(&state.db, id).await? >= g::MAX_GRANTS {
        return Err(ApiError::bad_request(format!("A key group can be granted to at most {} places.", g::MAX_GRANTS)));
    }
    let gid = g::upsert_grant(&state.db, id, target, accounts.as_deref()).await?;
    if let Some(gr) = g::grant(&state.db, id, gid).await? {
        state.device_keys.kick_many(g::grant_reach(&state.db, &gr).await?);
    }
    key_groups_reply(&state, user.id, Some(id)).await
}

async fn own_grant(state: &AppState, user_id: i64, id: i64, grant_id: i64) -> ApiResult<g::Grant> {
    own_key_group(state, user_id, id).await?;
    g::grant(&state.db, id, grant_id).await?.ok_or_else(|| ApiError::not_found("Grant not found"))
}

#[utoipa::path(patch, path = "/api/reverse/user/key-groups/{id}/grants/{grant_id}", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Key group id"), ("grant_id" = i64, Path, description = "Grant id")), request_body = super::schemas::KeyGroupGrantAccounts, responses((status = 200, body = super::schemas::KeyGroups), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_grant(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, grant_id)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let gr = own_grant(&state, user.id, id, grant_id).await?;
    let accounts = grant_accounts(&body)?;
    g::set_grant_accounts(&state.db, gr.id, accounts.as_deref()).await?;
    state.device_keys.kick_many(g::grant_reach(&state.db, &gr).await?);
    key_groups_reply(&state, user.id, Some(id)).await
}

#[utoipa::path(delete, path = "/api/reverse/user/key-groups/{id}/grants/{grant_id}", tag = "Groups", security(("bearer" = [])), params(("id" = i64, Path, description = "Key group id"), ("grant_id" = i64, Path, description = "Grant id")), responses((status = 200, body = super::schemas::KeyGroups), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_grant(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, grant_id)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    let gr = own_grant(&state, user.id, id, grant_id).await?;
    let reach = g::grant_reach(&state.db, &gr).await?;
    g::delete_grant(&state.db, gr.id).await?;
    state.device_keys.kick_many(reach);
    key_groups_reply(&state, user.id, Some(id)).await
}
