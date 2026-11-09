//! SCIM 2.0 的端點，在 `/api/scim/v2`（Traefik 本來就把 `/api/*` 送到後端）。用身分提供者自己的 SCIM 權杖
//! （`Authorization: Bearer tps_…`）；只看得到、只改得到這個提供者自己建的帳號與群組。不放進 OpenAPI 文件——
//! 那是給人與 API token 看的，SCIM 權杖用不了其他端點。
//!
//! The SCIM 2.0 endpoints at `/api/scim/v2`, authenticated with the provider's own SCIM token; a provider only sees
//! and changes the accounts and groups it created. Not in the OpenAPI document (that is for people and API tokens;
//! a SCIM token opens nothing else).

use std::collections::{BTreeSet, HashMap};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{Filter, ScimError, ScimGroup, ScimUser, GROUP_SCHEMA, USER_SCHEMA};
use crate::db::oidc::Provider;
use crate::db::scim::{ScimGroupRow, ScimUserRow};
use crate::db::{self, users::NewUser};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/scim/v2/ServiceProviderConfig", get(service_provider_config))
        .route("/api/scim/v2/ResourceTypes", get(resource_types))
        .route("/api/scim/v2/Schemas", get(schemas))
        .route("/api/scim/v2/Users", get(list_users).post(create_user))
        .route("/api/scim/v2/Users/{id}", get(get_user).put(replace_user).patch(patch_user).delete(delete_user))
        .route("/api/scim/v2/Groups", get(list_groups).post(create_group))
        .route("/api/scim/v2/Groups/{id}", get(get_group).put(replace_group).patch(patch_group).delete(delete_group))
}

type Res = Result<Response, ScimError>;

impl IntoResponse for ScimError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::BAD_REQUEST);
        scim_response(status, self.json())
    }
}

fn scim_response(status: StatusCode, body: Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/scim+json")], body.to_string()).into_response()
}

fn internal(e: impl std::fmt::Display) -> ScimError {
    tracing::error!(error = %e, "[SCIM] request failed");
    ScimError::new(500, None, "Telepy could not finish this request.")
}

/// 用 SCIM 權杖找出是哪個身分提供者。/ Which provider this SCIM token belongs to.
async fn provider(state: &AppState, headers: &HeaderMap) -> Result<Provider, ScimError> {
    let unauthorized = || ScimError::new(401, None, "A valid SCIM token is required.");
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::trim)
        .filter(|t| t.starts_with("tps_"))
        .ok_or_else(unauthorized)?;
    let p = db::oidc::by_scim_token(&state.db, &crate::oidc::flow::hash(token)).await.map_err(internal)?.ok_or_else(unauthorized)?;
    let _ = db::oidc::touch_scim(&state.db, p.id).await;
    Ok(p)
}

fn body_json(body: &Bytes) -> Result<Value, ScimError> {
    serde_json::from_slice(body).map_err(|e| ScimError::new(400, Some("invalidSyntax"), format!("The body is not JSON: {e}")))
}

fn base(state: &AppState, headers: &HeaderMap) -> String {
    format!("{}/api/scim/v2", crate::oauth::issuer(state.config.public_base().as_deref(), headers))
}

fn id_of(raw: &str) -> Result<i64, ScimError> {
    raw.parse().map_err(|_| ScimError::new(404, None, "No such resource."))
}

/// SCIM 的 userName → Telepy 的使用者名稱：像 email 就取 @ 前面（跟單一登入建帳號一樣）。
/// A SCIM userName → a Telepy username: the part before @ when it looks like an email (as SSO sign-in does).
pub fn telepy_username(user_name: &str) -> Option<String> {
    let local = user_name.split_once('@').map(|(l, _)| l).unwrap_or(user_name);
    crate::oidc::clean_username(local)
}

fn user_json(base: &str, r: &ScimUserRow) -> Value {
    let mut v = json!({
        "schemas": [USER_SCHEMA],
        "id": r.user_id.to_string(),
        "userName": r.user_name,
        "name": { "givenName": r.first_name, "familyName": r.last_name, "formatted": format!("{} {}", r.first_name, r.last_name).trim() },
        "active": r.is_active,
        "meta": {
            "resourceType": "User",
            "created": crate::util::db_to_iso_utc_z(&r.created_at),
            "lastModified": crate::util::db_to_iso_utc_z(&r.updated_at),
            "location": format!("{base}/Users/{}", r.user_id),
        },
    });
    if let Some(x) = &r.external_id {
        v["externalId"] = json!(x);
    }
    if let Some(x) = &r.display_name {
        v["displayName"] = json!(x);
    }
    if !r.email.is_empty() {
        v["emails"] = json!([{ "value": r.email, "type": "work", "primary": true }]);
    }
    v
}

fn as_scim(r: &ScimUserRow) -> ScimUser {
    ScimUser {
        user_name: r.user_name.clone(),
        external_id: r.external_id.clone(),
        given_name: r.first_name.clone(),
        family_name: r.last_name.clone(),
        display_name: r.display_name.clone(),
        email: (!r.email.is_empty()).then(|| r.email.clone()),
        active: r.is_active,
    }
}

/// 寫進 Telepy：資料、紀錄、啟用狀態（停用走跟管理員停用帳號同一條路）。
/// Write it into Telepy: profile, record, active state (deactivating takes the admin's disable path).
async fn store(state: &AppState, p: &Provider, user_id: i64, was_active: bool, u: &ScimUser) -> Result<(), ScimError> {
    db::scim::set_profile(&state.db, user_id, &u.given_name, &u.family_name, u.email.as_deref().unwrap_or("")).await.map_err(internal)?;
    db::scim::upsert_user(&state.db, p.id, user_id, &u.user_name, u.external_id.as_deref(), u.display_name.as_deref()).await.map_err(internal)?;
    let username = db::users::by_id(&state.db, user_id).await.map_err(internal)?.map(|x| x.username).unwrap_or_default();
    if was_active && !u.active {
        // 最後一位管理員不停用（網站不能沒人管）。/ Never the last active administrator.
        let user = db::users::by_id(&state.db, user_id).await.map_err(internal)?;
        if user.as_ref().is_some_and(|x| x.is_superuser) && db::oidc::other_admins(&state.db, user_id).await.map_err(internal)? == 0 {
            state.gateway.event("scim_user", None, None, None, format!("{} (SCIM) asked to deactivate {username}, the last administrator; left active", p.name)).await;
            return Ok(());
        }
        db::users::set_flags(&state.db, user_id, Some(false), None).await.map_err(internal)?;
        crate::access_recheck::account_disabled(state, user_id).await.map_err(|e| internal(format!("{e:?}")))?;
        state.gateway.event("scim_user", None, None, None, format!("{} (SCIM) deactivated {username}", p.name)).await;
    } else if !was_active && u.active {
        db::users::set_flags(&state.db, user_id, Some(true), None).await.map_err(internal)?;
        crate::access_recheck::kick_device_keys(state, user_id).await.map_err(internal)?;
        state.gateway.event("scim_user", None, None, None, format!("{} (SCIM) reactivated {username}", p.name)).await;
    }
    Ok(())
}

async fn managed(state: &AppState, p: &Provider, user_id: i64) -> Result<ScimUserRow, ScimError> {
    db::scim::user(&state.db, p.id, user_id).await.map_err(internal)?.ok_or_else(|| ScimError::new(404, None, "No such user."))
}

// ---------------------------------------------------------------- discovery

async fn service_provider_config(State(state): State<AppState>, headers: HeaderMap) -> Res {
    provider(&state, &headers).await?;
    Ok(scim_response(
        StatusCode::OK,
        json!({
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
            "documentationUri": "https://github.com/NatLee/telepy/blob/main/docs/sso.md",
            "patch": { "supported": true },
            "bulk": { "supported": false, "maxOperations": 0, "maxPayloadSize": 0 },
            "filter": { "supported": true, "maxResults": super::MAX_COUNT },
            "changePassword": { "supported": false },
            "sort": { "supported": false },
            "etag": { "supported": false },
            "authenticationSchemes": [{ "type": "oauthbearertoken", "name": "OAuth Bearer Token", "description": "The SCIM token from the sign-in provider's settings in Telepy", "primary": true }],
        }),
    ))
}

async fn resource_types(State(state): State<AppState>, headers: HeaderMap) -> Res {
    provider(&state, &headers).await?;
    let base = base(&state, &headers);
    let rt = |name: &str, endpoint: &str, schema: &str| json!({ "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], "id": name, "name": name, "endpoint": endpoint, "schema": schema, "meta": { "resourceType": "ResourceType", "location": format!("{base}/ResourceTypes/{name}") } });
    Ok(scim_response(StatusCode::OK, super::list_json(2, 0, vec![rt("User", "/Users", USER_SCHEMA), rt("Group", "/Groups", GROUP_SCHEMA)])))
}

async fn schemas(State(state): State<AppState>, headers: HeaderMap) -> Res {
    provider(&state, &headers).await?;
    let s = |id: &str, name: &str| json!({ "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Schema"], "id": id, "name": name });
    Ok(scim_response(StatusCode::OK, super::list_json(2, 0, vec![s(USER_SCHEMA, "User"), s(GROUP_SCHEMA, "Group")])))
}

// ---------------------------------------------------------------- users

#[derive(Deserialize, Default)]
struct ListQuery {
    #[serde(default)]
    filter: Option<String>,
    #[serde(default, rename = "startIndex")]
    start_index: Option<i64>,
    #[serde(default)]
    count: Option<i64>,
    #[serde(default, rename = "excludedAttributes")]
    excluded_attributes: Option<String>,
}

async fn list_users(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<ListQuery>) -> Res {
    let p = provider(&state, &headers).await?;
    let filter = q.filter.as_deref().map(super::parse_filter).transpose()?;
    let rows: Vec<ScimUserRow> = db::scim::users(&state.db, p.id)
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|r| match &filter {
            None => true,
            Some(Filter::Eq { attr, value }) => match attr.as_str() {
                "username" => r.user_name.eq_ignore_ascii_case(value),
                "externalid" => r.external_id.as_deref() == Some(value.as_str()),
                "id" => r.user_id.to_string() == *value,
                "emails.value" | "emails" => r.email.eq_ignore_ascii_case(value),
                _ => false,
            },
        })
        .collect();
    let (skip, take) = super::page(q.start_index, q.count);
    let base = base(&state, &headers);
    let page: Vec<Value> = rows.iter().skip(skip).take(take).map(|r| user_json(&base, r)).collect();
    Ok(scim_response(StatusCode::OK, super::list_json(rows.len(), skip, page)))
}

async fn get_user(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Res {
    let p = provider(&state, &headers).await?;
    let r = managed(&state, &p, id_of(&id)?).await?;
    Ok(scim_response(StatusCode::OK, user_json(&base(&state, &headers), &r)))
}

async fn create_user(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Res {
    let p = provider(&state, &headers).await?;
    let u = super::user_from_resource(&body_json(&body)?)?;
    let username = telepy_username(&u.user_name).ok_or_else(|| ScimError::bad("userName gives no usable Telepy username."))?;
    let user_id = match db::users::by_username(&state.db, &username).await.map_err(internal)? {
        // 這個提供者以前建過、後來刪掉的：接回來。/ Provisioned here before and deleted since: bring it back.
        Some(existing) if db::scim::was_deleted(&state.db, p.id, existing.id).await.map_err(internal)? => {
            store(&state, &p, existing.id, existing.is_active, &u).await?;
            existing.id
        }
        Some(existing) if db::scim::user(&state.db, p.id, existing.id).await.map_err(internal)?.is_some() => {
            return Err(ScimError::new(409, Some("uniqueness"), format!("{} is already provisioned.", u.user_name)));
        }
        Some(_) => {
            // 不接管既有的帳號（可能是管理員自己的）。/ Existing accounts are never taken over (it may be an admin's own).
            return Err(ScimError::new(409, Some("uniqueness"), format!("Telepy already has an account named {username} that this provider doesn't manage.")));
        }
        None => {
            let hash = crate::auth::password::unusable_password();
            let email = u.email.clone().unwrap_or_default();
            let created = db::users::create(&state.db, NewUser { username: &username, password_hash: &hash, email: &email, first_name: &u.given_name, last_name: &u.family_name })
                .await
                .map_err(|e| if crate::error::is_unique_violation(&e) { ScimError::new(409, Some("uniqueness"), "That username was just taken.") } else { internal(e) })?;
            db::scim::upsert_user(&state.db, p.id, created.id, &u.user_name, u.external_id.as_deref(), u.display_name.as_deref()).await.map_err(internal)?;
            if !u.active {
                db::users::set_flags(&state.db, created.id, Some(false), None).await.map_err(internal)?;
            }
            state.gateway.event("scim_user", None, None, None, format!("{} (SCIM) created {username}", p.name)).await;
            state.webhooks.emit(
                crate::webhooks::Event::new(crate::webhooks::Kind::UserCreated).data(json!({ "user": username, "via": "scim", "provider": p.name })).link("/tunnels/admin/users"),
            );
            created.id
        }
    };
    let r = managed(&state, &p, user_id).await?;
    Ok(scim_response(StatusCode::CREATED, user_json(&base(&state, &headers), &r)))
}

async fn replace_user(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> Res {
    let p = provider(&state, &headers).await?;
    let r = managed(&state, &p, id_of(&id)?).await?;
    let u = super::user_from_resource(&body_json(&body)?)?;
    store(&state, &p, r.user_id, r.is_active, &u).await?;
    let r = managed(&state, &p, r.user_id).await?;
    Ok(scim_response(StatusCode::OK, user_json(&base(&state, &headers), &r)))
}

async fn patch_user(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> Res {
    let p = provider(&state, &headers).await?;
    let r = managed(&state, &p, id_of(&id)?).await?;
    let u = super::apply_user_patch(&as_scim(&r), &body_json(&body)?)?;
    store(&state, &p, r.user_id, r.is_active, &u).await?;
    let r = managed(&state, &p, r.user_id).await?;
    Ok(scim_response(StatusCode::OK, user_json(&base(&state, &headers), &r)))
}

/// DELETE = 停用並不再由這個提供者管理（之後 GET 是 404）；帳號本身留著，紀錄與歸屬都在。
/// DELETE = deactivate and stop managing (GET answers 404 afterwards); the account itself stays.
async fn delete_user(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Res {
    let p = provider(&state, &headers).await?;
    let r = managed(&state, &p, id_of(&id)?).await?;
    let mut u = as_scim(&r);
    u.active = false;
    store(&state, &p, r.user_id, r.is_active, &u).await?;
    db::scim::mark_deleted(&state.db, p.id, r.user_id).await.map_err(internal)?;
    state.gateway.event("scim_user", None, None, None, format!("{} (SCIM) removed {} (account kept, deactivated)", p.name, r.username)).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------- groups

fn group_json(base: &str, g: &ScimGroupRow, members: Option<&[(i64, String)]>) -> Value {
    let mut v = json!({
        "schemas": [GROUP_SCHEMA],
        "id": g.group_id.to_string(),
        "displayName": g.name,
        "meta": {
            "resourceType": "Group",
            "created": crate::util::db_to_iso_utc_z(&g.created_at),
            "lastModified": crate::util::db_to_iso_utc_z(&g.updated_at),
            "location": format!("{base}/Groups/{}", g.group_id),
        },
    });
    if let Some(x) = &g.external_id {
        v["externalId"] = json!(x);
    }
    if let Some(m) = members {
        v["members"] = json!(m.iter().map(|(id, name)| json!({ "value": id.to_string(), "display": name, "$ref": format!("{base}/Users/{id}") })).collect::<Vec<_>>());
    }
    v
}

/// 群組裡這個提供者管理的成員（回給身分提供者的只有這些）。/ The group's members this provider manages (all it is shown).
async fn managed_members(state: &AppState, p: &Provider, group_id: i64) -> Result<Vec<(i64, String)>, ScimError> {
    let mine: BTreeSet<i64> = db::scim::users(&state.db, p.id).await.map_err(internal)?.iter().map(|r| r.user_id).collect();
    Ok(db::scim::members(&state.db, group_id).await.map_err(internal)?.into_iter().filter(|(id, _)| mine.contains(id)).collect())
}

/// 換掉這個提供者管理的成員：管理員手動加的（不是它管理的帳號）留著。
/// Replace the members this provider manages; members it doesn't manage (added by hand) stay.
async fn set_members(state: &AppState, p: &Provider, group_id: i64, role: bool, wanted: &BTreeSet<i64>) -> Result<(), ScimError> {
    let mine: BTreeSet<i64> = db::scim::users(&state.db, p.id).await.map_err(internal)?.iter().map(|r| r.user_id).collect();
    let current: BTreeSet<i64> = db::scim::members(&state.db, group_id).await.map_err(internal)?.into_iter().map(|(id, _)| id).collect();
    let next: Vec<i64> = current.iter().filter(|id| !mine.contains(id)).copied().chain(wanted.iter().filter(|id| mine.contains(id)).copied()).collect::<BTreeSet<i64>>().into_iter().collect();
    if next.iter().copied().collect::<BTreeSet<i64>>() == current {
        return Ok(());
    }
    db::features::set_members(&state.db, group_id, &next).await.map_err(internal)?;
    after_group_change(state, p, role, HashMap::new());
    Ok(())
}

/// 改了之後：角色 → 功能權限跟著變（快取作廢、結束失去功能的 session）；群組 → 分享給它的通道跟著成員走（比對群組分享）。
/// After a change: a role → feature access follows (invalidate, end sessions that lost a feature); a group → the
/// tunnels shared with it follow its members (reconcile group shares).
fn after_group_change(state: &AppState, p: &Provider, role: bool, gone: HashMap<i64, String>) {
    if role {
        state.features.invalidate();
        let (state, by) = (state.clone(), format!("{} (SCIM)", p.name));
        tokio::spawn(async move {
            crate::features::end_denied_sessions(&state, &by).await;
        });
    } else {
        crate::group_shares::kick_with(state, gone);
    }
}

/// 這個提供者推來的群組要變成角色還是群組。/ Whether this provider's pushed groups become roles or groups.
fn pushes_roles(p: &Provider) -> bool {
    p.scim_groups_as != "group"
}

async fn managed_group(state: &AppState, p: &Provider, id: i64) -> Result<ScimGroupRow, ScimError> {
    db::scim::group(&state.db, p.id, id).await.map_err(internal)?.ok_or_else(|| ScimError::new(404, None, "No such group."))
}

async fn list_groups(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<ListQuery>) -> Res {
    let p = provider(&state, &headers).await?;
    let filter = q.filter.as_deref().map(super::parse_filter).transpose()?;
    let rows: Vec<ScimGroupRow> = db::scim::groups(&state.db, p.id)
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|g| match &filter {
            None => true,
            Some(Filter::Eq { attr, value }) => match attr.as_str() {
                "displayname" => g.name.eq_ignore_ascii_case(value),
                "externalid" => g.external_id.as_deref() == Some(value.as_str()),
                "id" => g.group_id.to_string() == *value,
                _ => false,
            },
        })
        .collect();
    let without_members = q.excluded_attributes.as_deref().is_some_and(|x| x.split(',').any(|a| a.trim().eq_ignore_ascii_case("members")));
    let (skip, take) = super::page(q.start_index, q.count);
    let base = base(&state, &headers);
    let mut page = Vec::new();
    for g in rows.iter().skip(skip).take(take) {
        let members = if without_members { None } else { Some(managed_members(&state, &p, g.group_id).await?) };
        page.push(group_json(&base, g, members.as_deref()));
    }
    Ok(scim_response(StatusCode::OK, super::list_json(rows.len(), skip, page)))
}

async fn get_group(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<ListQuery>) -> Res {
    let p = provider(&state, &headers).await?;
    let g = managed_group(&state, &p, id_of(&id)?).await?;
    let without_members = q.excluded_attributes.as_deref().is_some_and(|x| x.split(',').any(|a| a.trim().eq_ignore_ascii_case("members")));
    let members = if without_members { None } else { Some(managed_members(&state, &p, g.group_id).await?) };
    Ok(scim_response(StatusCode::OK, group_json(&base(&state, &headers), &g, members.as_deref())))
}

fn check_group_name(name: &str) -> Result<(), ScimError> {
    if name.chars().count() > 64 {
        return Err(ScimError::bad("displayName is at most 64 characters in Telepy."));
    }
    Ok(())
}

async fn create_group(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Res {
    let p = provider(&state, &headers).await?;
    let g = super::group_from_resource(&body_json(&body)?)?;
    check_group_name(&g.display_name)?;
    // 角色跟角色比名稱，群組跟管理員維護的群組比。/ Roles are named among roles, groups among admin-kept groups.
    let role = pushes_roles(&p);
    let (taken, noun) = if role {
        (db::features::name_taken(&state.db, &g.display_name, None).await.map_err(internal)?, "role")
    } else {
        (db::features::share_group_name_taken(&state.db, &g.display_name, None).await.map_err(internal)?, "group")
    };
    if taken {
        return Err(ScimError::new(409, Some("uniqueness"), format!("Telepy already has a {noun} named {}.", g.display_name)));
    }
    // 同一個身分提供者不會有兩個同名的對應（中途改了「推送成角色 / 群組」也一樣），不然 displayName 篩選會找到兩個。
    // One provider never maps two groups of the same name (also after switching roles / groups), or a displayName filter
    // would find two.
    let wanted = g.display_name.to_lowercase();
    if db::scim::groups(&state.db, p.id).await.map_err(internal)?.iter().any(|r| r.name.to_lowercase() == wanted) {
        return Err(ScimError::new(409, Some("uniqueness"), format!("This provider already pushed a group named {}.", g.display_name)));
    }
    let description = format!("Managed by {} (SCIM)", p.name);
    let id = if role {
        db::features::create_group(&state.db, &g.display_name, &description).await
    } else {
        db::features::create_share_group(&state.db, &g.display_name, &description).await
    }
    .map_err(internal)?;
    db::scim::insert_group(&state.db, p.id, id, g.external_id.as_deref()).await.map_err(internal)?;
    set_members(&state, &p, id, role, &g.members).await?;
    state.gateway.event("scim_group", None, None, None, format!("{} (SCIM) created the {noun} \"{}\"", p.name, g.display_name)).await;
    let row = managed_group(&state, &p, id).await?;
    let members = managed_members(&state, &p, id).await?;
    Ok(scim_response(StatusCode::CREATED, group_json(&base(&state, &headers), &row, Some(&members))))
}

/// PUT / PATCH 之後：改名、externalId、成員。/ After PUT / PATCH: rename, externalId, members.
async fn store_group(state: &AppState, p: &Provider, row: &ScimGroupRow, g: &ScimGroup) -> Result<(), ScimError> {
    let role = row.is_role();
    let noun = if role { "role" } else { "group" };
    if g.display_name != row.name {
        check_group_name(&g.display_name)?;
        let taken = if role {
            db::features::name_taken(&state.db, &g.display_name, Some(row.group_id)).await
        } else {
            db::features::share_group_name_taken(&state.db, &g.display_name, Some(row.group_id)).await
        }
        .map_err(internal)?;
        if taken {
            return Err(ScimError::new(409, Some("uniqueness"), format!("Telepy already has a {noun} named {}.", g.display_name)));
        }
        if role {
            db::features::update_group(&state.db, row.group_id, Some(&g.display_name), None).await
        } else {
            db::features::update_share_group(&state.db, row.group_id, Some(&g.display_name), None).await
        }
        .map_err(internal)?;
        state.gateway.event("scim_group", None, None, None, format!("{} (SCIM) renamed the {noun} \"{}\" to \"{}\"", p.name, row.name, g.display_name)).await;
    }
    db::scim::touch_group(&state.db, p.id, row.group_id, g.external_id.as_deref()).await.map_err(internal)?;
    set_members(state, p, row.group_id, role, &g.members).await
}

async fn replace_group(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> Res {
    let p = provider(&state, &headers).await?;
    let row = managed_group(&state, &p, id_of(&id)?).await?;
    let g = super::group_from_resource(&body_json(&body)?)?;
    store_group(&state, &p, &row, &g).await?;
    let row = managed_group(&state, &p, row.group_id).await?;
    let members = managed_members(&state, &p, row.group_id).await?;
    Ok(scim_response(StatusCode::OK, group_json(&base(&state, &headers), &row, Some(&members))))
}

async fn patch_group(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> Res {
    let p = provider(&state, &headers).await?;
    let row = managed_group(&state, &p, id_of(&id)?).await?;
    let now = ScimGroup { display_name: row.name.clone(), external_id: row.external_id.clone(), members: managed_members(&state, &p, row.group_id).await?.into_iter().map(|(id, _)| id).collect() };
    let g = super::apply_group_patch(&now, &body_json(&body)?)?;
    store_group(&state, &p, &row, &g).await?;
    let row = managed_group(&state, &p, row.group_id).await?;
    let members = managed_members(&state, &p, row.group_id).await?;
    Ok(scim_response(StatusCode::OK, group_json(&base(&state, &headers), &row, Some(&members))))
}

async fn delete_group(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Res {
    let p = provider(&state, &headers).await?;
    let row = managed_group(&state, &p, id_of(&id)?).await?;
    let gone = crate::group_shares::gone_for_group(&state, row.group_id, &row.name).await.map_err(|e| internal(format!("{e:?}")))?;
    db::features::delete_group(&state.db, row.group_id).await.map_err(internal)?;
    db::oidc::forget_user_group(&state.db, row.group_id).await.map_err(internal)?;
    db::scim::forget_group(&state.db, row.group_id).await.map_err(internal)?;
    after_group_change(&state, &p, row.is_role(), gone);
    let noun = if row.is_role() { "role" } else { "group" };
    state.gateway.event("scim_group", None, None, None, format!("{} (SCIM) deleted the {noun} \"{}\"", p.name, row.name)).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scim_user_names_become_telepy_usernames() {
        assert_eq!(telepy_username("alice@corp.example").as_deref(), Some("alice"));
        assert_eq!(telepy_username("CORP\\bob").as_deref(), Some("CORP-bob"));
        assert_eq!(telepy_username("@corp.example"), None);
    }
}
