//! `/api/access*`：功能權限的管理（管理員專用）——群組、成員、每個功能對「所有人 / 群組 / 使用者」的允許或拒絕。
//! 每個寫入都回整份設定（很小），改完立即生效（快取作廢）並結束那些人已經不能用的進行中 session。
//! 跟隧道分享無關：分享決定「哪些隧道」，這裡決定「哪些功能」。
//! Feature-permission administration (admins only): groups, members and allow / deny per feature for everyone, a group
//! or a user. Every write answers the whole policy (it is small), applies at once (cache invalidated) and ends the live
//! sessions their users just lost. Unrelated to tunnel sharing.

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
    let users = db::users::all_ordered(&state.db).await?;
    let mut members: HashMap<i64, Vec<i64>> = HashMap::new();
    for (g, u) in &memberships {
        members.entry(*g).or_default().push(*u);
    }
    let tz = state.config.tz_offset_minutes;
    Ok(json!({
        "features": Feature::ALL.iter().map(|f| json!({ "id": f.id(), "default": f.default_allowed() })).collect::<Vec<_>>(),
        "everyone": grants_json(Some(&policy.everyone)),
        "groups": groups.iter().map(|g| json!({
            "id": g.id,
            "name": g.name,
            "description": g.description,
            "created_at": crate::util::db_to_iso(&g.created_at, tz),
            "members": members.get(&g.id).cloned().unwrap_or_default(),
            "grants": grants_json(policy.groups.get(&g.id)),
        })).collect::<Vec<_>>(),
        "users": users.iter().map(|u| {
            let effective: Map<String, Value> = Feature::ALL.iter().map(|f| (f.id().to_string(), policy.resolve(u.id, u.is_superuser, *f).json())).collect();
            json!({
                "id": u.id,
                "username": u.username,
                "email": u.email,
                "is_superuser": u.is_superuser,
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
    state.gateway.event(kind, None, None, None, message).await;
    let (state, by) = (state.clone(), me.username.clone());
    tokio::spawn(async move {
        let n = crate::features::end_denied_sessions(&state, &by).await;
        if n > 0 {
            tracing::info!(sessions = n, "feature permissions: ended sessions of features that were turned off");
        }
    });
}

fn parse_name(body: &Value) -> ApiResult<Option<String>> {
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

fn parse_description(body: &Value) -> ApiResult<Option<String>> {
    match body.get("description") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().chars().count() <= MAX_DESCRIPTION => Ok(Some(s.trim().to_string())),
        Some(Value::String(_)) => Err(ApiError::field("description", format!("At most {MAX_DESCRIPTION} characters."))),
        Some(_) => Err(ApiError::field("description", "Must be a string.")),
    }
}

/// `members`：使用者 id 陣列（要存在）。/ `members`: an array of existing user ids.
async fn parse_members(state: &AppState, body: &Value) -> ApiResult<Option<Vec<i64>>> {
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
    if db::features::groups(&state.db).await?.len() >= MAX_GROUPS {
        return Err(ApiError::bad_request(format!("At most {MAX_GROUPS} groups.")));
    }
    if db::features::name_taken(&state.db, &name, None).await? {
        return Err(ApiError::field("name", "A group with this name already exists."));
    }
    let id = db::features::create_group(&state.db, &name, &description).await?;
    let mut msg = format!("{} created the group \"{name}\"", me.username);
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
    if !changes.is_empty() {
        after_write(&state, &me, "user_group", format!("{} changed the group \"{}\": {}", me.username, group.name, changes.join("; "))).await;
    }
    Ok(Json(policy_json(&state).await?))
}

#[utoipa::path(delete, path = "/api/access/groups/{id}", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), responses((status = 200, body = super::schemas::AccessPolicy), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let group = db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Group not found."))?;
    db::features::delete_group(&state.db, id).await?;
    after_write(&state, &me, "user_group", format!("{} deleted the group \"{}\"", me.username, group.name)).await;
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
