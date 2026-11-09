//! `/api/access*`：角色、功能權限與管理員維護的群組（管理員專用）。
//! - 角色（`/api/access/groups*`）：成員 + 每個功能對「所有人 / 角色 / 使用者」的允許或拒絕。只決定功能，永遠不能拿來
//!   分享通道，所以改角色從不動到誰拿得到哪條通道。
//! - 管理員維護的群組（`/api/access/share-groups*`）：只用來分享通道（出現在每個人的分享對話框）；改成員、刪掉前可以先
//!   預告（`…/preview`）誰會多了 / 少了哪些通道。功能權限永遠不看它。
//! 每個寫入都回整份設定（很小），改完立即生效。個人群組不在這裡（`api::personal_groups`），這裡的路徑碰不到它（404）。
//! Roles, feature permissions and admin-kept groups (admins only).
//! - Roles (`/api/access/groups*`): members and allow / deny per feature for everyone, a role or a user. They decide
//!   features only and can never be shared with, so a role change never touches who reaches which tunnel.
//! - Admin-kept groups (`/api/access/share-groups*`): sharing only (offered in everyone's share dialog); a member change
//!   or a delete can be previewed first (`…/preview`). Feature permissions never read them.
//! Every write answers the whole policy (it is small) and applies at once. Personal groups live in
//! `api::personal_groups`; the routes here can't reach them (404).

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
        .routes(routes!(role_members))
        .routes(routes!(set_grant))
        .routes(routes!(create_share_group))
        .routes(routes!(update_share_group, delete_share_group))
        .routes(routes!(preview_share_group))
        .routes(routes!(share_group_members))
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

/// 整份設定：功能清單（含預設）、所有人、角色（`groups`，含成員）、使用者（含角色與各自的有效值），以及管理員維護的
/// 群組（`share_groups`，含成員與分享給它的通道）。/ The whole policy: features (with defaults), everyone, roles
/// (`groups`, with members), users (roles + effective values), and admin-kept groups (`share_groups`, with members and
/// the tunnels shared with them).
async fn policy_json(state: &AppState) -> ApiResult<Value> {
    state.features.invalidate();
    let policy: std::sync::Arc<Policy> = state.features.policy().await?;
    let groups = db::features::groups(&state.db).await?;
    let share_groups = db::features::share_groups(&state.db).await?;
    let memberships = db::features::all_memberships(&state.db).await?;
    let synced = db::group_shares::synced_groups(&state.db).await?;
    let scim_groups: HashSet<i64> = db::scim::mapped_groups(&state.db).await?;
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
    for (id, g, tunnel_id, tunnel_name, owner, perm, expires, through) in db::group_shares::shares_of_groups(&state.db, &share_groups.iter().map(|g| g.id).collect::<Vec<_>>()).await? {
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
            "scim": scim_groups.contains(&g.id),
        })).collect::<Vec<_>>(),
        "share_groups": share_groups.iter().map(|g| json!({
            "id": g.id,
            "name": g.label(),
            "description": g.description,
            "created_at": crate::util::db_to_iso(&g.created_at, tz),
            "members": members.get(&g.id).cloned().unwrap_or_default(),
            "sso_members": sso_members.get(&g.id).cloned().unwrap_or_default(),
            "synced": synced.contains(&g.id),
            "scim": scim_groups.contains(&g.id),
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

/// 角色 / 功能的寫入之後：快取作廢、結束失去功能的 session、寫稽核事件。角色不碰通道，所以不比對群組分享。
/// After a role / grant write: invalidate, end lost sessions, audit. Roles never touch tunnels, so no share reconcile.
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

/// 增減成員的 body：`{add?, remove?}`，至少一個非空、id 要存在。回傳去重排序後的 (add, remove)。
/// A member delta body `{add?, remove?}`: at least one non-empty, ids must exist. Returns (add, remove) de-duplicated.
pub async fn parse_delta(state: &AppState, body: &Value, active_only: bool) -> ApiResult<(Vec<i64>, Vec<i64>)> {
    let list = |key: &str| -> ApiResult<Vec<i64>> {
        let Some(v) = body.get(key) else { return Ok(vec![]) };
        let Some(arr) = v.as_array() else { return Err(ApiError::field(key, "Must be a list of user ids.")) };
        let mut ids: Vec<i64> = Vec::new();
        for x in arr {
            let Some(id) = x.as_i64() else { return Err(ApiError::field(key, "Must be a list of user ids.")) };
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids.sort_unstable();
        Ok(ids)
    };
    let (add, remove) = (list("add")?, list("remove")?);
    if add.is_empty() && remove.is_empty() {
        return Err(ApiError::bad_request("Send add and / or remove with at least one user id."));
    }
    let users = db::users::all_ordered(&state.db).await?;
    let known: HashSet<i64> = users.iter().filter(|u| !active_only || u.is_active).map(|u| u.id).collect();
    let everyone: HashSet<i64> = users.iter().map(|u| u.id).collect();
    if let Some(bad) = add.iter().find(|id| !known.contains(id)) {
        return Err(ApiError::field("add", format!("User {bad} does not exist{}.", if active_only { " or is disabled" } else { "" })));
    }
    // 拿掉的只要帳號存在就好（停用的也能移出）。/ Removing only needs the account to exist (disabled ones can leave).
    if let Some(bad) = remove.iter().find(|id| !everyone.contains(id)) {
        return Err(ApiError::field("remove", format!("User {bad} does not exist.")));
    }
    Ok((add, remove))
}

/// 角色不能被分享：舊的 `shareable` 欄位一律拒絕（別讓人以為它有作用）。/ Roles can't be shared with: the old
/// `shareable` field is refused (so nobody thinks it did something).
fn refuse_shareable(body: &Value) -> ApiResult<()> {
    if body.get("shareable").is_some() {
        return Err(ApiError::field("shareable", "Roles decide features only and can't be shared with. Make a group (POST /api/access/share-groups) to share tunnels."));
    }
    Ok(())
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
    refuse_shareable(&body)?;
    let name = parse_name(&body)?.ok_or_else(|| ApiError::field("name", "This field is required."))?;
    let description = parse_description(&body)?.unwrap_or_default();
    let members = parse_members(&state, &body).await?;
    if db::features::groups(&state.db).await?.len() >= MAX_GROUPS {
        return Err(ApiError::bad_request(format!("At most {MAX_GROUPS} roles.")));
    }
    if db::features::name_taken(&state.db, &name, None).await? {
        return Err(ApiError::field("name", "A role with this name already exists."));
    }
    let id = db::features::create_group(&state.db, &name, &description).await?;
    let mut msg = format!("{} created the role \"{name}\"", me.username);
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

/// 成員名單換掉前後：(加進來的, 拿掉的)。/ Before / after a member list change: (added, removed).
fn member_changes(before: &[i64], after: &[i64]) -> (Vec<i64>, Vec<i64>) {
    (after.iter().filter(|u| !before.contains(u)).copied().collect(), before.iter().filter(|u| !after.contains(u)).copied().collect())
}

#[utoipa::path(patch, path = "/api/access/groups/{id}", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Role id")), request_body = super::schemas::AccessGroupWrite, responses((status = 200, body = super::schemas::AccessPolicy), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    // 只有角色：管理員維護的群組、個人群組在這裡都是 404。/ Roles only: admin-kept and personal groups are a 404 here.
    let group = db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Role not found."))?;
    refuse_shareable(&body)?;
    let name = parse_name(&body)?;
    let description = parse_description(&body)?;
    let members = parse_members(&state, &body).await?;
    if let Some(n) = &name {
        if db::features::name_taken(&state.db, n, Some(id)).await? {
            return Err(ApiError::field("name", "A role with this name already exists."));
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
        let before = db::features::members_of(&state.db, id).await?;
        db::features::set_members(&state.db, id, m).await?;
        let (added, removed) = member_changes(&before, m);
        if !added.is_empty() {
            changes.push(format!("added {}", usernames(&state, &added).await?));
        }
        if !removed.is_empty() {
            changes.push(format!("removed {}", usernames(&state, &removed).await?));
        }
    }
    if !changes.is_empty() {
        after_write(&state, &me, "user_group", format!("{} changed the role \"{}\": {}", me.username, group.name, changes.join("; "))).await;
    }
    Ok(Json(policy_json(&state).await?))
}

#[utoipa::path(delete, path = "/api/access/groups/{id}", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Role id")), responses((status = 200, body = super::schemas::AccessPolicy), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let group = db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Role not found."))?;
    db::features::delete_group(&state.db, id).await?;
    // 單一登入規則、紀錄與 SCIM 對應指向它的一起走。/ Sign-in rules, grant records and the SCIM mapping pointing at it go too.
    db::oidc::forget_user_group(&state.db, id).await?;
    db::scim::forget_group(&state.db, id).await?;
    after_write(&state, &me, "user_group", format!("{} deleted the role \"{}\"", me.username, group.name)).await;
    Ok(Json(policy_json(&state).await?))
}

// ---------------------------------------------------------------- admin-kept groups (sharing only)

/// 一個管理員維護的群組最多幾個。/ Admin-kept groups at most.
pub const MAX_SHARE_GROUPS: usize = 100;

async fn share_group_or_404(state: &AppState, id: i64) -> ApiResult<db::features::Group> {
    // 只有管理員維護的群組：角色、個人群組在這裡都是 404。/ Admin-kept groups only: roles and personal groups are a 404.
    db::features::share_group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Group not found."))
}

/// 管理員維護的群組寫入之後：稽核（不分通道）+ 比對群組分享（同步，讓存取立刻跟著走）。
/// After an admin-kept group write: audit (tunnel-less) + reconcile group shares (inline, so access follows at once).
async fn after_share_write(state: &AppState, message: String, gone: &HashMap<i64, String>) -> ApiResult<()> {
    state.gateway.event("share_group", None, None, None, message).await;
    crate::group_shares::reconcile(state, gone).await
}

#[utoipa::path(post, path = "/api/access/share-groups", tag = "Access", security(("bearer" = [])), request_body = super::schemas::ShareGroupWrite, responses((status = 201, description = "The whole policy, plus `created_id`", body = super::schemas::AccessPolicy), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody)))]
async fn create_share_group(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    admin(&me)?;
    let name = parse_name(&body)?.ok_or_else(|| ApiError::field("name", "This field is required."))?;
    let description = parse_description(&body)?.unwrap_or_default();
    let members = parse_members(&state, &body).await?;
    if db::features::share_groups(&state.db).await?.len() >= MAX_SHARE_GROUPS {
        return Err(ApiError::bad_request(format!("At most {MAX_SHARE_GROUPS} groups.")));
    }
    if db::features::share_group_name_taken(&state.db, &name, None).await? {
        return Err(ApiError::field("name", "A group with this name already exists."));
    }
    let id = db::features::create_share_group(&state.db, &name, &description).await?;
    let mut msg = format!("{} created the group \"{name}\"", me.username);
    if let Some(m) = &members {
        db::features::set_members(&state.db, id, m).await?;
        if !m.is_empty() {
            msg.push_str(&format!(" with {}", usernames(&state, m).await?));
        }
    }
    after_share_write(&state, msg, &HashMap::new()).await?;
    let mut out = policy_json(&state).await?;
    out["created_id"] = json!(id);
    Ok((StatusCode::CREATED, Json(out)))
}

#[utoipa::path(patch, path = "/api/access/share-groups/{id}", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), request_body = super::schemas::ShareGroupWrite, responses((status = 200, body = super::schemas::AccessPolicy), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update_share_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let group = share_group_or_404(&state, id).await?;
    let name = parse_name(&body)?;
    let description = parse_description(&body)?;
    let members = parse_members(&state, &body).await?;
    if let Some(n) = &name {
        if db::features::share_group_name_taken(&state.db, n, Some(id)).await? {
            return Err(ApiError::field("name", "A group with this name already exists."));
        }
    }
    db::features::update_share_group(&state.db, id, name.as_deref(), description.as_deref()).await?;
    let mut changes: Vec<String> = Vec::new();
    if let Some(n) = name.as_deref().filter(|n| *n != group.label()) {
        changes.push(format!("renamed it to \"{n}\""));
    }
    if description.as_deref().is_some_and(|d| d != group.description) {
        changes.push("changed its description".into());
    }
    if let Some(m) = &members {
        let before = db::features::members_of(&state.db, id).await?;
        db::features::set_members(&state.db, id, m).await?;
        let (added, removed) = member_changes(&before, m);
        if !added.is_empty() {
            changes.push(format!("added {}", usernames(&state, &added).await?));
        }
        if !removed.is_empty() {
            changes.push(format!("removed {}", usernames(&state, &removed).await?));
        }
    }
    if !changes.is_empty() {
        after_share_write(&state, format!("{} changed the group \"{}\": {}", me.username, group.label(), changes.join("; ")), &HashMap::new()).await?;
    }
    Ok(Json(policy_json(&state).await?))
}

/// 預告：改成員或刪群組，誰會多了 / 少了哪些通道（什麼都不寫）。body 二選一：`{members: [ids]}`、`{delete: true}`。
/// Preview what a member change or a delete would do to tunnel access (writes nothing). The body is one of
/// `{members: [ids]}`, `{delete: true}`.
#[utoipa::path(post, path = "/api/access/share-groups/{id}/preview", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), request_body = super::schemas::GroupPreviewRequest, responses((status = 200, body = super::schemas::GroupPreview), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn preview_share_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    share_group_or_404(&state, id).await?;
    let change = preview_change(&state, &body).await?;
    Ok(Json(crate::group_shares::preview(&state, id, &change).await?))
}

/// 預告的 body → 改動。/ A preview body → the change.
pub async fn preview_change(state: &AppState, body: &Value) -> ApiResult<crate::group_shares::Change> {
    if let Some(m) = parse_members(state, body).await? {
        return Ok(crate::group_shares::Change::Members(m));
    }
    if body.get("delete") == Some(&Value::Bool(true)) {
        return Ok(crate::group_shares::Change::Unshared);
    }
    Err(ApiError::bad_request("Send one of: members, delete: true."))
}

#[utoipa::path(delete, path = "/api/access/share-groups/{id}", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), responses((status = 200, body = super::schemas::AccessPolicy), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_share_group(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let group = share_group_or_404(&state, id).await?;
    let shares = db::group_shares::shares_of_groups(&state.db, &[id]).await?;
    let gone = crate::group_shares::gone_for_group(&state, id, group.label()).await?;
    db::features::delete_group(&state.db, id).await?;
    // 單一登入規則、紀錄與 SCIM 對應指向它的一起走。/ Sign-in rules, grant records and the SCIM mapping pointing at it go too.
    db::oidc::forget_user_group(&state.db, id).await?;
    db::scim::forget_group(&state.db, id).await?;
    for (_, _, tunnel_id, tunnel_name, ..) in &shares {
        state
            .gateway
            .event("group_share", None, None, Some(*tunnel_id), format!("The share of \"{tunnel_name}\" with the group \"{}\" ended: {} deleted the group", group.label(), me.username))
            .await;
    }
    after_share_write(&state, format!("{} deleted the group \"{}\" ({} tunnel shares ended)", me.username, group.label(), shares.len()), &gone).await?;
    Ok(Json(policy_json(&state).await?))
}

/// 角色成員的增減（不會蓋掉別人同時的修改）。body `{add?, remove?}`；效果同 PATCH `members`。
/// Add / remove role members as a delta (never overwrites a concurrent edit); same effects as a PATCH of `members`.
#[utoipa::path(post, path = "/api/access/groups/{id}/members", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Role id")), request_body = super::schemas::MembersDelta, responses((status = 200, body = super::schemas::AccessPolicy), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn role_members(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let group = db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Role not found."))?;
    let (add, remove) = parse_delta(&state, &body, false).await?;
    let (added, removed) = db::features::apply_delta(&state.db, id, &add, &remove).await?;
    let mut changes: Vec<String> = Vec::new();
    if !added.is_empty() {
        changes.push(format!("added {}", usernames(&state, &added).await?));
    }
    if !removed.is_empty() {
        changes.push(format!("removed {}", usernames(&state, &removed).await?));
    }
    if !changes.is_empty() {
        after_write(&state, &me, "user_group", format!("{} changed the role \"{}\": {}", me.username, group.name, changes.join("; "))).await;
    }
    Ok(Json(policy_json(&state).await?))
}

/// 管理員維護群組成員的增減；通道分享立刻跟著走。/ Add / remove admin-kept group members as a delta; group shares follow at once.
#[utoipa::path(post, path = "/api/access/share-groups/{id}/members", tag = "Access", security(("bearer" = [])), params(("id" = i64, Path, description = "Group id")), request_body = super::schemas::MembersDelta, responses((status = 200, body = super::schemas::AccessPolicy), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn share_group_members(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin(&me)?;
    let group = share_group_or_404(&state, id).await?;
    let (add, remove) = parse_delta(&state, &body, false).await?;
    let (added, removed) = db::features::apply_delta(&state.db, id, &add, &remove).await?;
    let mut changes: Vec<String> = Vec::new();
    if !added.is_empty() {
        changes.push(format!("added {}", usernames(&state, &added).await?));
    }
    if !removed.is_empty() {
        changes.push(format!("removed {}", usernames(&state, &removed).await?));
    }
    if changes.is_empty() {
        return Ok(Json(policy_json(&state).await?));
    }
    after_share_write(&state, format!("{} changed the group \"{}\": {}", me.username, group.label(), changes.join("; ")), &HashMap::new()).await?;
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
            // 只有角色；群組（管理員維護的、個人的）永遠不決定功能 → 404。/ Roles only; groups never decide features → 404.
            let g = db::features::group(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Role not found."))?;
            ("group", id, format!("the role \"{}\"", g.name))
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
    use super::{member_changes, parse_value};

    #[test]
    fn member_changes_say_who_was_added_and_removed() {
        assert_eq!(member_changes(&[1, 2, 3], &[2, 3, 4]), (vec![4], vec![1]));
        assert_eq!(member_changes(&[], &[]), (vec![], vec![]));
    }
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
