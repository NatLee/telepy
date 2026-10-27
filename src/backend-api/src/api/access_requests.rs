//! 存取申請：被分享的人要求更多（帳號 / 更高權限）一段時間；owner 或 ADMIN 核准後變成暫時授權，時間到自動收回。
//! Access requests: a sharee asks for more (accounts and/or a higher permission) for a while; once the owner or an
//! ADMIN approves, it is a temporary grant that ends on its own.

use std::collections::{BTreeSet, HashMap};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, access_requests::AccessRequest, tunnels::Tunnel};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Effective, Permission};
use crate::state::AppState;
use crate::util::{db_time, db_to_iso_utc_z, parse_db_datetime};
use crate::webhooks::{Event, Kind};

/// 最短 15 分鐘、最長 7 天。/ Between 15 minutes and 7 days.
pub const MIN_SECS: i64 = 15 * 60;
pub const MAX_SECS: i64 = 7 * 86_400;
const REASON_MAX: usize = 500;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, create))
        .routes(routes!(approve))
        .routes(routes!(deny))
        .routes(routes!(cancel))
}

fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// 申請內容的檢查（純函式）：時長在範圍內、權限比現在高、帳號屬於這條隧道；已經有的帳號略過。
/// 回傳真的要給的帳號與權限。
/// Validate a request (pure): duration in range, a higher permission, accounts of this tunnel; accounts already
/// allowed are dropped. Returns what is actually being asked for.
pub fn validate(
    current: Permission,
    permission: Option<Permission>,
    account_ids: &[i64],
    tunnel_account_ids: &[i64],
    allowed_ids: &[i64],
    duration_secs: i64,
) -> Result<(Vec<i64>, Option<Permission>), (&'static str, String)> {
    if !(MIN_SECS..=MAX_SECS).contains(&duration_secs) {
        return Err(("bad_duration", "Ask for between 15 minutes and 7 days.".into()));
    }
    if permission.is_some_and(|p| p <= current) {
        return Err(("permission_not_higher", "You already have that permission or a higher one.".into()));
    }
    let mut ids = BTreeSet::new();
    for id in account_ids {
        if !tunnel_account_ids.contains(id) {
            return Err(("unknown_account", format!("Account {id} is not on this tunnel.")));
        }
        if !allowed_ids.contains(id) {
            ids.insert(*id);
        }
    }
    if ids.is_empty() && permission.is_none() {
        return Err(("nothing_requested", "Pick an account you can't use yet, or a higher permission.".into()));
    }
    Ok((ids.into_iter().collect(), permission))
}

/// 「8 hours」「3 days」「45 minutes」。/ A short human duration.
pub fn human_duration(secs: i64) -> String {
    let unit = |n: i64, one: &str| if n == 1 { format!("1 {one}") } else { format!("{n} {one}s") };
    if secs % 86_400 == 0 {
        unit(secs / 86_400, "day")
    } else if secs % 3_600 == 0 {
        unit(secs / 3_600, "hour")
    } else {
        unit((secs + 59) / 60, "minute")
    }
}

/// 「root, pi and Admin」。/ What a request asks for, in words.
fn what(accounts: &[String], permission: Option<&str>) -> String {
    let mut items: Vec<String> = accounts.to_vec();
    if let Some(p) = permission.and_then(Permission::parse) {
        items.push(format!("{} permission", p.display()));
    }
    match items.len() {
        0 => String::new(),
        1 => items.remove(0),
        n => format!("{} and {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

fn utc_minutes(db_time: &str) -> String {
    parse_db_datetime(db_time).map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string()).unwrap_or_else(|| db_time.to_string())
}

/// 看得到這條隧道才行（否則 404）。/ 404 unless the caller can see the tunnel.
async fn access(state: &AppState, user_id: i64, id: i64) -> ApiResult<(Tunnel, Effective)> {
    let not_found = || ApiError::not_found("Tunnel not found");
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(not_found)?;
    let eff = permissions::effective_for(&state.db, user_id, &t).await?.ok_or_else(not_found)?;
    Ok((t, eff))
}

/// 會收到申請通知、能決定的人：owner 與 ADMIN sharee。/ Who decides: the owner and ADMIN sharees.
async fn deciders(state: &AppState, t: &Tunnel) -> ApiResult<Vec<i64>> {
    let mut ids = vec![t.user_id];
    ids.extend(db::sharing::admin_sharee_ids(&state.db, t.id).await?);
    Ok(ids)
}

async fn account_names(state: &AppState, tunnel_id: i64) -> ApiResult<HashMap<i64, String>> {
    Ok(db::tunnels::usernames_for_tunnel(&state.db, tunnel_id).await?.into_iter().map(|u| (u.id, u.username)).collect())
}

async fn username_of(state: &AppState, id: Option<i64>) -> ApiResult<Option<String>> {
    Ok(match id {
        Some(id) => db::users::by_id(&state.db, id).await?.map(|u| u.username),
        None => None,
    })
}

async fn request_json(state: &AppState, r: &AccessRequest, names: &HashMap<i64, String>) -> ApiResult<Value> {
    let accounts: Vec<Value> = r.usernames().iter().map(|id| json!({ "id": id, "username": names.get(id) })).collect();
    Ok(json!({
        "id": r.id,
        "tunnel_id": r.tunnel_id,
        "requester": { "id": r.requester_id, "username": username_of(state, Some(r.requester_id)).await? },
        "accounts": accounts,
        "permission": r.permission,
        "duration_secs": r.duration_secs,
        "reason": r.reason,
        "status": r.status,
        "created_at": db_to_iso_utc_z(&r.created_at),
        "decided_by": username_of(state, r.decided_by_id).await?,
        "decided_at": r.decided_at.as_deref().map(db_to_iso_utc_z),
        "ends_at": r.ends_at.as_deref().map(db_to_iso_utc_z),
    }))
}

/// owner / ADMIN：還在等的與最近決定的申請；其他 sharee：自己的申請，加上能要的帳號與現在的權限。
/// Owner / ADMIN: pending and recently decided requests. Other sharees: their own requests, the accounts they could
/// ask for and their current permission.
#[utoipa::path(get, path = "/api/reverse/server/{id}/access-requests", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::AccessRequestList), (status = 404, body = super::schemas::ErrorBody)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    let names = account_names(&state, t.id).await?;
    let can_decide = eff.satisfies(Permission::Admin);
    let rows = if can_decide {
        db::access_requests::for_tunnel(&state.db, t.id, 10).await?
    } else {
        db::access_requests::of_requester(&state.db, t.id, me.id, 5).await?
    };
    let mut requests = Vec::with_capacity(rows.len());
    for r in &rows {
        requests.push(request_json(&state, r, &names).await?);
    }
    let mut body = json!({ "can_decide": can_decide, "can_request": !can_decide, "permission": eff.label(), "requests": requests });
    if let (false, Some(sharing)) = (can_decide, db::sharing::get(&state.db, t.id, me.id).await?) {
        let allowed: Vec<i64> = permissions::allowed_usernames(&state.db, me.id, &t).await?.iter().map(|u| u.id).collect();
        let ends = db::access_requests::username_ends(&state.db, sharing.id).await?;
        let mut accounts: Vec<(&i64, &String)> = names.iter().collect();
        accounts.sort_by(|a, b| a.1.cmp(b.1));
        body["accounts"] = json!(accounts
            .into_iter()
            .map(|(id, name)| json!({ "id": id, "username": name, "allowed": allowed.contains(id), "until": ends.get(id).map(|e| db_to_iso_utc_z(e)) }))
            .collect::<Vec<_>>());
        body["permission_until"] = json!(db::access_requests::raise_of(&state.db, sharing.id).await?.map(|(_, until)| db_to_iso_utc_z(&until)));
    }
    Ok(Json(body))
}

/// 被分享的人提出申請（一次一筆等待中的）。/ A sharee asks for more (one pending request at a time).
#[utoipa::path(post, path = "/api/reverse/server/{id}/access-requests", tag = "Tunnel Sharing", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::AccessRequestCreate, responses((status = 201, body = super::schemas::AccessRequestItem), (status = 400, description = "{error, code}: bad_duration, permission_not_higher, unknown_account, nothing_requested, bad_permission, reason_too_long, not_sharee", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "request_pending", body = super::schemas::ErrorBody)))]
async fn create(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (t, eff) = access(&state, me.id, id).await?;
    let current = match eff {
        Effective::Shared(p) if p < Permission::Admin => p,
        _ => return Err(coded(StatusCode::BAD_REQUEST, "not_sharee", "Only people this tunnel is shared with (below Admin) can ask for more access.")),
    };
    if db::access_requests::pending_of(&state.db, t.id, me.id).await?.is_some() {
        return Err(coded(StatusCode::CONFLICT, "request_pending", "You already have a request waiting on this tunnel. Cancel it to ask again."));
    }
    let permission = match body.get("permission") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => Some(Permission::parse(s.trim()).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "bad_permission", "permission must be view, edit or admin"))?),
        Some(_) => return Err(coded(StatusCode::BAD_REQUEST, "bad_permission", "permission must be view, edit or admin")),
    };
    let wanted: Vec<i64> = match body.get("account_ids") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).collect(),
        Some(_) => return Err(coded(StatusCode::BAD_REQUEST, "unknown_account", "account_ids must be a list")),
    };
    let duration = body.get("duration_secs").and_then(Value::as_i64).unwrap_or(0);
    let reason = body.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if reason.chars().count() > REASON_MAX {
        return Err(coded(StatusCode::BAD_REQUEST, "reason_too_long", format!("Keep the reason under {REASON_MAX} characters.")));
    }
    let names = account_names(&state, t.id).await?;
    let tunnel_ids: Vec<i64> = names.keys().copied().collect();
    let allowed: Vec<i64> = permissions::allowed_usernames(&state.db, me.id, &t).await?.iter().map(|u| u.id).collect();
    let (ids, permission) = validate(current, permission, &wanted, &tunnel_ids, &allowed, duration).map_err(|(c, m)| coded(StatusCode::BAD_REQUEST, c, m))?;

    let r = db::access_requests::create(&state.db, t.id, me.id, &ids, permission.map(Permission::as_str), duration, &reason).await?;
    let asked = what(&ids.iter().filter_map(|i| names.get(i).cloned()).collect::<Vec<_>>(), r.permission.as_deref());
    let details = format!("{} asks for {asked} on \"{}\" for {}", me.username, t.host_friendly_name, human_duration(duration));
    let deciders = deciders(&state, &t).await?;
    state.hub.notify_users(
        deciders.clone(),
        &json!({ "action": "ACCESS-REQUEST-CREATED", "details": details, "tunnel_id": t.id, "request_id": r.id, "by": me.username }),
    );
    state.webhooks.emit(
        Event::new(Kind::AccessRequested)
            .tunnel(&t)
            .to(deciders, Some(me.id))
            .data(json!({
                "request_id": r.id,
                "by": me.username,
                "accounts": ids.iter().filter_map(|i| names.get(i).cloned()).collect::<Vec<_>>(),
                "permission": r.permission,
                "duration_secs": duration,
                "reason": reason,
            }))
            .link("/tunnels"),
    );
    state.gateway.event("access_request", None, u16::try_from(t.reverse_port).ok(), Some(t.id), format!("access request #{}: {details}", r.id)).await;
    Ok((StatusCode::CREATED, Json(request_json(&state, &r, &names).await?)))
}

/// 決定前的共同檢查：申請存在、看得到隧道、我是 owner / ADMIN、不是自己的申請、還在等。
/// Shared checks before a decision.
async fn decidable(state: &AppState, me: i64, rid: i64) -> ApiResult<(AccessRequest, Tunnel)> {
    let not_found = || ApiError::not_found("Request not found");
    let r = db::access_requests::get(&state.db, rid).await?.ok_or_else(not_found)?;
    let (t, eff) = access(state, me, r.tunnel_id).await.map_err(|_| not_found())?;
    if !eff.satisfies(Permission::Admin) {
        return Err(coded(StatusCode::FORBIDDEN, "not_manager", "Only the tunnel owner or an ADMIN sharee can decide access requests."));
    }
    if r.requester_id == me {
        return Err(coded(StatusCode::FORBIDDEN, "own_request", "You can't decide your own request."));
    }
    if r.status != "pending" {
        return Err(coded(StatusCode::CONFLICT, "already_decided", format!("This request was already {}.", r.status)));
    }
    Ok((r, t))
}

/// 核准：帳號與權限暫時給到 now + 時長（可改時長）。/ Approve: accounts and permission until now + duration (which may be changed).
#[utoipa::path(post, path = "/api/reverse/access-requests/{rid}/approve", tag = "Tunnel Sharing", security(("bearer" = [])), params(("rid" = i64, Path, description = "Request id")), request_body = super::schemas::AccessRequestDecision, responses((status = 200, body = super::schemas::AccessRequestItem), (status = 400, body = super::schemas::ErrorBody), (status = 403, description = "not_manager / own_request", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "already_decided / share_gone", body = super::schemas::ErrorBody)))]
async fn approve(State(state): State<AppState>, AuthUser(me): AuthUser, Path(rid): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (r, t) = decidable(&state, me.id, rid).await?;
    let duration = match body.get("duration_secs") {
        None | Some(Value::Null) => r.duration_secs,
        Some(v) => v.as_i64().filter(|d| (MIN_SECS..=MAX_SECS).contains(d)).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "bad_duration", "Grant between 15 minutes and 7 days."))?,
    };
    let Some(sharing) = db::sharing::get(&state.db, t.id, r.requester_id).await? else {
        db::access_requests::decide(&state.db, r.id, "cancelled", None, None).await?;
        return Err(coded(StatusCode::CONFLICT, "share_gone", "The tunnel is no longer shared with this person."));
    };
    let until = db_time(Utc::now() + Duration::seconds(duration));
    if !db::access_requests::decide(&state.db, r.id, "approved", Some(me.id), Some(&until)).await? {
        return Err(coded(StatusCode::CONFLICT, "already_decided", "Someone else decided this request first."));
    }
    db::access_requests::grant_usernames(&state.db, sharing.id, t.id, &r.usernames(), &until).await?;
    if let Some(p) = r.permission.as_deref().and_then(Permission::parse) {
        let now = Permission::parse(sharing.permission()).unwrap_or(Permission::View);
        if p > now || (p == now && sharing.base_permission.is_some()) {
            db::access_requests::raise_permission(&state.db, sharing.id, p.as_str(), &until).await?;
        }
    }
    // 帳號變了：他的金鑰要裝進新帳號。/ Accounts changed: their keys go into the new ones.
    state.device_keys.kick(t.id);

    let names = account_names(&state, t.id).await?;
    let asked = what(&r.usernames().iter().filter_map(|i| names.get(i).cloned()).collect::<Vec<_>>(), r.permission.as_deref());
    let requester = username_of(&state, Some(r.requester_id)).await?.unwrap_or_default();
    let ends = utc_minutes(&until);
    state.hub.notify_user(
        r.requester_id,
        &json!({ "action": "ACCESS-REQUEST-DECIDED", "status": "approved", "tunnel_id": t.id, "request_id": r.id, "ends_at": db_to_iso_utc_z(&until),
                 "details": format!("{} approved your request on \"{}\": {asked} until {ends}", me.username, t.host_friendly_name) }),
    );
    state.webhooks.emit(
        Event::new(Kind::AccessDecided)
            .tunnel(&t)
            .to([r.requester_id], Some(me.id))
            .data(json!({ "request_id": r.id, "status": "approved", "by": me.username, "ends_at": db_to_iso_utc_z(&until) }))
            .link("/tunnels"),
    );
    // 決定的人自己也要刷新（卡片上的待審數）。/ Deciders, the one who decided included (the badge on their cards).
    state.hub.notify_users(deciders(&state, &t).await?, &json!({ "action": "ACCESS-REQUEST-UPDATED", "tunnel_id": t.id, "request_id": r.id }));
    state
        .gateway
        .event("access_request", None, u16::try_from(t.reverse_port).ok(), Some(t.id), format!("access request #{}: {} approved {requester}'s request for {asked} until {ends}", r.id, me.username))
        .await;
    let r = db::access_requests::get(&state.db, r.id).await?.unwrap_or(r);
    Ok(Json(request_json(&state, &r, &names).await?))
}

/// 拒絕。/ Deny.
#[utoipa::path(post, path = "/api/reverse/access-requests/{rid}/deny", tag = "Tunnel Sharing", security(("bearer" = [])), params(("rid" = i64, Path, description = "Request id")), responses((status = 200, body = super::schemas::AccessRequestItem), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, body = super::schemas::ErrorBody)))]
async fn deny(State(state): State<AppState>, AuthUser(me): AuthUser, Path(rid): Path<i64>) -> ApiResult<Json<Value>> {
    let (r, t) = decidable(&state, me.id, rid).await?;
    if !db::access_requests::decide(&state.db, r.id, "denied", Some(me.id), None).await? {
        return Err(coded(StatusCode::CONFLICT, "already_decided", "Someone else decided this request first."));
    }
    let names = account_names(&state, t.id).await?;
    let asked = what(&r.usernames().iter().filter_map(|i| names.get(i).cloned()).collect::<Vec<_>>(), r.permission.as_deref());
    let requester = username_of(&state, Some(r.requester_id)).await?.unwrap_or_default();
    state.hub.notify_user(
        r.requester_id,
        &json!({ "action": "ACCESS-REQUEST-DECIDED", "status": "denied", "tunnel_id": t.id, "request_id": r.id,
                 "details": format!("{} declined your request on \"{}\" ({asked})", me.username, t.host_friendly_name) }),
    );
    state.webhooks.emit(
        Event::new(Kind::AccessDecided)
            .tunnel(&t)
            .to([r.requester_id], Some(me.id))
            .data(json!({ "request_id": r.id, "status": "denied", "by": me.username }))
            .link("/tunnels"),
    );
    // 決定的人自己也要刷新（卡片上的待審數）。/ Deciders, the one who decided included (the badge on their cards).
    state.hub.notify_users(deciders(&state, &t).await?, &json!({ "action": "ACCESS-REQUEST-UPDATED", "tunnel_id": t.id, "request_id": r.id }));
    state
        .gateway
        .event("access_request", None, u16::try_from(t.reverse_port).ok(), Some(t.id), format!("access request #{}: {} declined {requester}'s request for {asked}", r.id, me.username))
        .await;
    let r = db::access_requests::get(&state.db, r.id).await?.unwrap_or(r);
    Ok(Json(request_json(&state, &r, &names).await?))
}

/// 申請人收回還在等的申請。/ The requester withdraws a pending request.
#[utoipa::path(delete, path = "/api/reverse/access-requests/{rid}", tag = "Tunnel Sharing", security(("bearer" = [])), params(("rid" = i64, Path, description = "Request id")), responses((status = 204, description = "Cancelled"), (status = 404, body = super::schemas::ErrorBody), (status = 409, body = super::schemas::ErrorBody)))]
async fn cancel(State(state): State<AppState>, AuthUser(me): AuthUser, Path(rid): Path<i64>) -> ApiResult<StatusCode> {
    let not_found = || ApiError::not_found("Request not found");
    let r = db::access_requests::get(&state.db, rid).await?.filter(|r| r.requester_id == me.id).ok_or_else(not_found)?;
    if !db::access_requests::decide(&state.db, r.id, "cancelled", Some(me.id), None).await? {
        return Err(coded(StatusCode::CONFLICT, "already_decided", format!("This request was already {}.", r.status)));
    }
    if let Some(t) = db::tunnels::by_id(&state.db, r.tunnel_id).await? {
        state.hub.notify_users(deciders(&state, &t).await?, &json!({ "action": "ACCESS-REQUEST-UPDATED", "tunnel_id": t.id, "request_id": r.id }));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// 收回到期的暫時授權：暫時帳號移除、暫時權限回到原本的，通知本人並讓 owner 端刷新。回傳處理了幾筆。
/// End temporary grants that ran out: drop temporary accounts, put raised permissions back, tell the sharee and
/// refresh the owner's side. Returns how many grants ended.
pub async fn revert_once(state: &AppState) -> ApiResult<usize> {
    // (tunnel, sharee) → 結束的帳號名與權限。/ What ended, per (tunnel, sharee).
    let mut ended: HashMap<(i64, i64), (Vec<String>, Option<String>)> = HashMap::new();
    let mut n = 0;
    for (sharing_id, tunnel_id, user_id, username_id) in db::access_requests::expired_usernames(&state.db).await? {
        db::access_requests::remove_username(&state.db, sharing_id, username_id).await?;
        let name = db::tunnels::username_by_id(&state.db, username_id).await?.map(|u| u.username).unwrap_or_default();
        ended.entry((tunnel_id, user_id)).or_default().0.push(name);
        n += 1;
    }
    for (sharing_id, tunnel_id, user_id, _base) in db::access_requests::expired_raises(&state.db).await? {
        let raised = db::sharing::get(&state.db, tunnel_id, user_id).await?.map(|s| s.permission_type);
        db::access_requests::revert_raise(&state.db, sharing_id).await?;
        ended.entry((tunnel_id, user_id)).or_default().1 = raised;
        n += 1;
    }
    for ((tunnel_id, user_id), (accounts, permission)) in ended {
        let Some(t) = db::tunnels::by_id(&state.db, tunnel_id).await? else { continue };
        state.device_keys.kick(t.id);
        crate::access_recheck::kick(state, Some(t.id), Some(user_id));
        let asked = what(&accounts, permission.as_deref());
        state.hub.notify_user(
            user_id,
            &json!({ "action": "TUNNEL-PERMISSION-UPDATED", "tunnel_id": t.id, "temporary_ended": true,
                     "details": format!("Your temporary access on \"{}\" has ended: {asked}", t.host_friendly_name) }),
        );
        state.hub.notify_users(deciders(state, &t).await?, &json!({ "action": "TUNNEL-USERNAMES-UPDATED", "tunnel_id": t.id }));
        let who = username_of(state, Some(user_id)).await?.unwrap_or_default();
        state.gateway.event("access_request", None, u16::try_from(t.reverse_port).ok(), Some(t.id), format!("temporary access for {who} ended: {asked}")).await;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    const H8: i64 = 8 * 3600;

    #[test]
    fn validates_what_is_asked() {
        use Permission::*;
        // 已經有的帳號略過，重複的合併。/ Accounts already allowed are dropped, duplicates merged.
        assert_eq!(validate(View, None, &[2, 3, 3], &[1, 2, 3], &[2], H8), Ok((vec![3], None)));
        assert_eq!(validate(View, Some(Admin), &[], &[1], &[], H8), Ok((vec![], Some(Admin))));
        assert_eq!(validate(Edit, Some(Edit), &[], &[1], &[], H8).unwrap_err().0, "permission_not_higher");
        assert_eq!(validate(View, None, &[9], &[1], &[], H8).unwrap_err().0, "unknown_account");
        assert_eq!(validate(View, None, &[1], &[1], &[1], H8).unwrap_err().0, "nothing_requested");
        assert_eq!(validate(View, None, &[1], &[1], &[], 60).unwrap_err().0, "bad_duration");
        assert_eq!(validate(View, None, &[1], &[1], &[], MAX_SECS + 1).unwrap_err().0, "bad_duration");
    }

    #[test]
    fn words() {
        assert_eq!(human_duration(H8), "8 hours");
        assert_eq!(human_duration(86_400), "1 day");
        assert_eq!(human_duration(3 * 86_400), "3 days");
        assert_eq!(human_duration(45 * 60), "45 minutes");
        assert_eq!(what(&["root".into()], None), "root");
        assert_eq!(what(&["root".into(), "pi".into()], Some("admin")), "root, pi and Admin permission");
        assert_eq!(what(&[], Some("edit")), "Edit permission");
    }
}
