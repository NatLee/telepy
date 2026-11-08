//! `/api/access*`：組織群組與功能權限的管理（管理員專用）——群組、成員、每個功能對「所有人 / 群組 / 使用者」的允許或拒絕。
//! 每個寫入都回整份設定（很小），改完立即生效（快取作廢）並結束那些人已經不能用的進行中 session。
//! 功能權限決定「哪些功能」，分享決定「哪些通道」；兩者只在一個地方交會：打開「可以被分享」的組織群組，它的成員
//! 也決定誰拿到分享給它的通道，所以改成員、刪群組、關掉分享前可以先預告（`…/preview`）。個人群組不在這裡。
//! Organization groups and feature permissions (admins only): groups, members and allow / deny per feature for
//! everyone, a group or a user. Every write answers the whole policy (it is small), applies at once (cache
//! invalidated) and ends the live sessions their users just lost. Features decide *which tools*, sharing decides
//! *which tunnels*; they meet in one place: the members of an organization group open to sharing also decide who gets
//! the tunnels shared with it, so a member change, a delete or closing sharing can be previewed first (`…/preview`).
//! Personal groups never show up here.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Map, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, users::User};
use crate::error::{ApiError, ApiResult};
use crate::features::{Feature, Policy};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_policy))
        .routes(routes!(create_group))
        .routes(routes!(update_group, delete_group))
        .routes(routes!(preview_group))
        .routes(routes!(set_grant))
}

pub const MAX_GROUPS: usize = 100;
pub const MAX_NAME: usize = 64;
pub const MAX_DESCRIPTION: usize = 256;

fn admin(me: &User) -> ApiResult<()> {
    if me.is_superuser {
        Ok(())
    } else {
        Err(ApiError::forbidden("Permission denied. Only administrators can manage feature permissions."))
    }
}

fn grants_json(m: Option<&HashMap<Feature, bool>>) -> Value {
    let mut out = Map::new();
    if let Some(m) = m {
        let sorted: BTreeMap<_, _> = m.iter().collect();
        for (f, a) in sorted {
            out.insert(f.id().to_string(), Value::Bool(*a));
        }
    }
    Value::Object(out)
}

/// 整份設定：功能清單（含預設）、所有人、群組（含成員）、使用者（含所屬群組與各自的有效值）。
/// The whole policy: features (with defaults), everyone, groups (with members), users (groups + effective values).
async fn policy_json(state: &AppState) -> ApiResult<Value> {
    state.features.invalidate();
    let policy: std::sync::Arc<Policy> = state.features.policy().await?;
    let groups = db::features::groups(&state.db).await?;
    let memberships = db::features::memberships(&state.db).await?;
    // 單一登入給的成員資格與管理員：頁面標出來（手動拿掉的話下次登入又會加回來）。
    // Memberships and admin rights a sign-in provider gave: marked on the page (removing one by hand lasts until the next sign-in).
    let mut sso_members: HashMap<i64, Vec<Value>> = HashMap::new();
    for (g, u, provider) in db::oidc::granted_memberships(&state.db).await? {
        sso_members.entry(g).or_default().push(json!({ "user_id": u, "provider": provider }));
    }
    let sso_admins: HashMap<i64, String> = db::oidc::granted_admins(&state.db).await?.into_iter().collect();
    let users = db::users::all_ordered(&state.db).await?;
    let mut members: HashMap<i64, Vec<i64>> = HashMap::new();
    for (g, u) in &memberships {
        members.entry(*g).or_default().push(*u);
    }
    let tz = state.config.tz_offset_minutes;
    let mut shares: HashMap<i64, Vec<Value>> = HashMap::new();
    for (id, g, tunnel_id, tunnel_name, owner, perm, expires, through) in db::group_shares::shares_of_groups(&state.db, &groups.iter().map(|g| g.id).collect::<Vec<_>>()).await? {
        shares.entry(g).or_default().push(json!({
            "id": id,
            "tunnel_id": tunnel_id,
            "tunnel_name": tunnel_name,
            "owner": owner,
            "permission_type": perm,
            "through": through,
            "expires_at": expires.as_deref().map(crate::util::db_to_iso_utc_z),
        }));
    }
    Ok(json!({
        "features": Feature::ALL.iter().map(|f| json!({ "id": f.id(), "default": f.default_allowed() })).collect::<Vec<_>>(),
        "everyone": grants_json(Some(&policy.everyone)),
        "groups": groups.iter().map(|g| json!({
            "id": g.id,
            "name": g.name,
            "description": g.description,
            "created_at": crate::util::db_to_iso(&g.created_at, tz),
            "members": members.get(&g.id).cloned().unwrap_or_default(),
            "sso_members": sso_members.get(&g.id).cloned().unwrap_or_default(),
            "grants": grants_json(policy.groups.get(&g.id)),
            "shareable": g.shareable,
            "shares": shares.remove(&g.id).unwrap_or_default(),
        })).collect::<Vec<_>>(),
        "users": users.iter().map(|u| {
            let effective: Map<String, Value> = Feature::ALL.iter().map(|f| (f.id().to_string(), policy.resolve(u.id, u.is_superuser, *f).json())).collect();
            json!({
                "id": u.id,
                "username": u.username,
                "email": u.email,
                "is_superuser": u.is_superuser,
                "sso_admin": sso_admins.get(&u.id),
                "is_active": u.is_active,
                "groups": policy.member_of.get(&u.id).cloned().unwrap_or_default(),
                "grants": grants_json(policy.users.get(&u.id)),
                "effective": effective,
            })
        }).collect::<Vec<_>>(),
    }))
}

/// 寫入之後：快取作廢、結束失去功能的 session、寫稽核事件。/ After a write: invalidate, end lost sessions, audit.
async fn after_write(state: &AppState, me: &User, kind: &str, message: String) {
    state.features.invalidate();
    // 分享給群組的通道跟著成員走。/ Tunnels shared with a group follow its members.
    crate::group_shares::kick(state);
    state.gateway.event(kind, None, None, None, message).await;
    let (state, by) = (state.clone(), me.username.clone());
    tokio::spawn(async move {
        let n = crate::features::end_denied_sessions(&state, &by).await;
        if n > 0 {
            tracing::info!(sessions = n, "feature permissions: ended sessions of features that were turned off");
        }
    });
}

pub fn parse_name(body: &Value) -> ApiResult<Option<String>> {
    match body.get("name") {
        None => Ok(None),
        Some(Value::String(s)) => {
            let n = s.trim();
            if n.is_empty() || n.chars().count() > MAX_NAME {
                return Err(ApiError::field("name", format!("Use 1-{MAX_NAME} characters.")));
            }
            Ok(Some(n.to_string()))
        }
        Some(_) => Err(ApiError::field("name", "Must be a string.")),
    }
}

pub fn parse_description(body: &Value) -> ApiResult<Option<String>> {
    match body.get("description") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().chars().count() <= MAX_DESCRIPTION => Ok(Some(s.trim().to_string())),
        Some(Value::String(_)) => Err(ApiError::field("description", format!("At most {MAX_DESCRIPTION} characters."))),
        Some(_) => Err(ApiError::field("description", "Must be a string.")),
    }
}

/// `members`：使用者 id 陣列（要存在）。/ `members`: an array of existing user ids.
pub async fn parse_members(state: &AppState, body: &Value) -> ApiResult<Option<Vec<i64>>> {
    let Some(v) = body.get("members") else { return Ok(None) };
    let Some(arr) = v.as_array() else { return Err(ApiError::field("members", "Must be a list of user ids.")) };
    let mut ids: Vec<i64> = Vec::new();
    for x in arr {
        let Some(id) = x.as_i64() else { return Err(ApiError::field("members", "Must be a list of user ids.")) };
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let known: HashSet<i64> = db::users::all_ordered(&state.db).await?.iter().map(|u| u.id).collect();
    if let Some(bad) = ids.iter().find(|id| !known.contains(id)) {
        return Err(ApiError::field("members", format!("User {bad} does not exist.")));
    }
    ids.sort_unstable();
    Ok(Some(ids))
}

fn parse_shareable(body: &Value) -> ApiResult<Option<bool>> {
    match body.get("shareable") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(ApiError::field("shareable", "Must be true or false.")),
    }
}

async fn usernames(state: &AppState, ids: &[i64]) -> ApiResult<String> {
    let map = db::users::usernames_for(&state.db, ids).await?;
    Ok(ids.iter().map(|id| map.get(id).cloned().unwrap_or_else(|| format!("#{id}"))).collect::<Vec<_>>().join(", "))
}

#[utoipa::path(get, path = "/api/access", tag = "Access", security(("bearer" = [])), responses((status = 200, body = super::schemas::AccessPolicy), (status = 403, body = super::schemas::ErrorBody)))]
async fn get_policy(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    admin(&me)?;
    Ok(Json(policy_json(&state).await?))
}

#[utoipa::path(post, path = "/api/access/groups", tag = "Access", security(("bearer" = [])), request_body = super::schemas::AccessGroupWrite, responses((status = 201, description = "The whole policy, plus `created_id`", body = super::schemas::AccessPolicy), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody)))]
async fn create_group(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    admin(&me)?;
    let name = parse_name(&body)?.ok_or_else(|| ApiError::field("name", "This field is required."))?;
    let description = parse_description(&body)?.unwrap_or_default();
    let members = parse_members(&state, &body).await?;
    let shareable = parse_shareable(&body)?.unwrap_or(false);
    if db::features::groups(&state.db).await?.len() >= MAX_GROUPS {
        return Err(ApiError::bad_request(format!("At most {MAX_GROUPS} groups.")));
    }
    if db::features::name_taken(&state.db, &name, None).await? {
        return Err(ApiError::field("name", "A group with this name already exists."));
    }
    let id = db::features::create_group(&state.db, &name, &description).await?;
    let mut msg = format!("{} created the group \"{name}\"", me.username);
    if shareable {
        db::features::set_shareable(&state.db, id, true).await?;
        msg.push_str(" (can be shared)");
    }
    if let Some(m) = &members {
        db::features::set_members(&state.db, id, m).await?;
        if !m.is_empty() {
            msg.push_str(&format!(" with {}", usernames(&state, m).await?));
        }
    }
    after_write(&state, &me, "user_group", msg).await;
    let mut out = policy_json(&state).await?;
    out["created_id"] = json!(id);
    Ok((StatusCode::CREATED, Json(out)))
}

#[utoipa::path(patch, path = "/api/access/groups/{id}", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), request_body = super::schemas::AccessGroupWrite, responses((status = 200, body = super::schemas::AccessPolicy), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let group = db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Group not found."))?;
    let name = parse_name(&body)?;
    let description = parse_description(&body)?;
    let members = parse_members(&state, &body).await?;
    let shareable = parse_shareable(&body)?;
    if let Some(n) = &name {
        if db::features::name_taken(&state.db, n, Some(id)).await? {
            return Err(ApiError::field("name", "A group with this name already exists."));
        }
    }
    db::features::update_group(&state.db, id, name.as_deref(), description.as_deref()).await?;
    let mut changes: Vec<String> = Vec::new();
    if let Some(n) = name.as_deref().filter(|n| *n != group.name) {
        changes.push(format!("renamed it to \"{n}\""));
    }
    if description.as_deref().is_some_and(|d| d != group.description) {
        changes.push("changed its description".into());
    }
    if let Some(m) = &members {
        let before: Vec<i64> = db::features::memberships(&state.db).await?.into_iter().filter(|(g, _)| *g == id).map(|(_, u)| u).collect();
        db::features::set_members(&state.db, id, m).await?;
        let added: Vec<i64> = m.iter().filter(|u| !before.contains(u)).copied().collect();
        let removed: Vec<i64> = before.iter().filter(|u| !m.contains(u)).copied().collect();
        if !added.is_empty() {
            changes.push(format!("added {}", usernames(&state, &added).await?));
        }
        if !removed.is_empty() {
            changes.push(format!("removed {}", usernames(&state, &removed).await?));
        }
    }
    let mut gone = HashMap::new();
    if let Some(on) = shareable.filter(|on| *on != group.shareable) {
        db::features::set_shareable(&state.db, id, on).await?;
        if on {
            changes.push("opened it to sharing".into());
        } else {
            // 不再開放分享：分享給它的通道全部結束（成員自己的分享不受影響）。/ Closed to sharing: every share with it ends.
            let shares = db::group_shares::shares_of_groups(&state.db, &[id]).await?;
            gone = crate::group_shares::gone_for_group(&state, id, &group.name).await?;
            db::group_shares::forget_group(&state.db, id).await?;
            for (_, _, tunnel_id, tunnel_name, ..) in &shares {
                state
                    .gateway
                    .event("group_share", None, None, Some(*tunnel_id), format!("The share of \"{tunnel_name}\" with the group \"{}\" ended: {} closed the group to sharing", group.name, me.username))
                    .await;
            }
            changes.push(format!("closed it to sharing ({} tunnel shares ended)", shares.len()));
        }
    }
    if !changes.is_empty() {
        after_write(&state, &me, "user_group", format!("{} changed the group \"{}\": {}", me.username, group.name, changes.join("; "))).await;
    }
    if !gone.is_empty() {
        crate::group_shares::kick_with(&state, gone);
    }
    Ok(Json(policy_json(&state).await?))
}

/// 預告：改成員、刪群組或不再開放分享，誰會多了 / 少了哪些通道（什麼都不寫）。body 三選一：
/// `{members: [ids]}`、`{delete: true}`、`{shareable: false}`。
/// Preview what a member change, a delete or closing sharing would do to tunnel access (writes nothing). The body is
/// one of `{members: [ids]}`, `{delete: true}`, `{shareable: false}`.
#[utoipa::path(post, path = "/api/access/groups/{id}/preview", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), request_body = super::schemas::GroupPreviewRequest, responses((status = 200, body = super::schemas::GroupPreview), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn preview_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Group not found."))?;
    let change = preview_change(&state, &body).await?;
    Ok(Json(crate::group_shares::preview(&state, id, &change).await?))
}

/// 預告的 body → 改動（組織群組與個人群組共用）。/ A preview body → the change (shared with personal groups).
pub async fn preview_change(state: &AppState, body: &Value) -> ApiResult<crate::group_shares::Change> {
    if let Some(m) = parse_members(state, body).await? {
        return Ok(crate::group_shares::Change::Members(m));
    }
    if body.get("delete") == Some(&Value::Bool(true)) || body.get("shareable") == Some(&Value::Bool(false)) {
        return Ok(crate::group_shares::Change::Unshared);
    }
    Err(ApiError::bad_request("Send one of: members, delete: true, shareable: false."))
}

#[utoipa::path(delete, path = "/api/access/groups/{id}", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), responses((status = 200, body = super::schemas::AccessPolicy), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let group = db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Group not found."))?;
    let gone = crate::group_shares::gone_for_group(&state, id, &group.name).await?;
    db::features::delete_group(&state.db, id).await?;
    // 單一登入規則與紀錄指向它的一起走。/ Single sign-on rules and grant records pointing at it go too.
    db::oidc::forget_user_group(&state.db, id).await?;
    db::scim::forget_group(&state.db, id).await?;
    after_write(&state, &me, "user_group", format!("{} deleted the group \"{}\"", me.username, group.name)).await;
    crate::group_shares::kick_with(&state, gone);
    Ok(Json(policy_json(&state).await?))
}

/// `value`：allow | deny | inherit（刪掉那一列）。/ `value`: allow | deny | inherit (removes the row).
pub fn parse_value(v: Option<&Value>) -> Result<Option<bool>, ApiError> {
    match v.and_then(Value::as_str) {
        Some("allow") => Ok(Some(true)),
        Some("deny") => Ok(Some(false)),
        Some("inherit") => Ok(None),
        _ => Err(ApiError::field("value", "Must be one of: allow, deny, inherit.")),
    }
}

#[utoipa::path(put, path = "/api/access/grants", tag = "Access", security(("bearer" = [])), request_body = super::schemas::AccessGrantWrite, responses((status = 200, body = super::schemas::AccessPolicy), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_grant(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let feature = body
        .get("feature")
        .and_then(Value::as_str)
        .and_then(Feature::from_id)
        .ok_or_else(|| ApiError::field("feature", "Unknown feature."))?;
    let value = parse_value(body.get("value"))?;
    let subject = body.get("subject").and_then(Value::as_str).unwrap_or_default();
    let (kind, sid, who) = match subject {
        "everyone" => ("everyone", 0, "everyone".to_string()),
        "group" => {
            let id = body.get("id").and_then(Value::as_i64).ok_or_else(|| ApiError::field("id", "This field is required."))?;
            let g = db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Group not found."))?;
            ("group", id, format!("the group \"{}\"", g.name))
        }
        "user" => {
            let id = body.get("id").and_then(Value::as_i64).ok_or_else(|| ApiError::field("id", "This field is required."))?;
            let u = db::users::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("User not found."))?;
            if u.is_superuser {
                return Err(ApiError::bad_request("Administrators always have every feature."));
            }
            ("user", id, u.username)
        }
        _ => return Err(ApiError::field("subject", "Must be one of: everyone, group, user.")),
    };
    db::features::set_grant(&state.db, kind, sid, feature.id(), value).await?;
    let verb = match value {
        Some(true) => "allowed",
        Some(false) => "denied",
        None => "reset to inherit",
    };
    after_write(&state, &me, "feature_grant", format!("{} {verb} {} for {who}", me.username, feature.label())).await;
    Ok(Json(policy_json(&state).await?))
}

#[cfg(test)]
mod tests {
    use super::parse_value;
    use serde_json::json;

    #[test]
    fn grant_values() {
        assert_eq!(parse_value(Some(&json!("allow"))).unwrap(), Some(true));
        assert_eq!(parse_value(Some(&json!("deny"))).unwrap(), Some(false));
        assert_eq!(parse_value(Some(&json!("inherit"))).unwrap(), None);
        assert!(parse_value(Some(&json!(true))).is_err());
        assert!(parse_value(None).is_err());
    }
}
