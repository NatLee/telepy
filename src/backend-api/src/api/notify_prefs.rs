//! `/api/notifications/*`：站內通知（toast / 桌面通知）的偏好。規則見 `crate::notify_prefs`。
//! - `GET/PUT /api/notifications/preferences`：我的（每個事件 × 管道：全站值、鎖、我的值、結果與來源；隧道靜音）
//! - `PUT/DELETE /api/notifications/mute/{tunnel_id}`：靜音一條看得到的隧道（`all` / `status`）
//! - `GET/PUT /api/notifications/defaults`：全站預設與鎖（管理員，否則 403 `admin_only`）
//!
//! In-app notification preferences (rules in `crate::notify_prefs`): mine, tunnel mutes, and the site defaults.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Map, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, users::User};
use crate::error::{ApiError, ApiResult};
use crate::notify_prefs::{self as np, Channel, Layers, Mute};
use crate::permissions;
use crate::state::AppState;
use crate::webhooks::catalog::Kind;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_mine, put_mine))
        .routes(routes!(mute, unmute))
        .routes(routes!(get_defaults, put_defaults))
}

fn admin_only(me: &User) -> ApiResult<()> {
    if !me.is_superuser {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            json!({ "error": "Only administrators can change the site's notification defaults.", "code": "admin_only" }),
        ));
    }
    Ok(())
}

/// 全站預設：(事件, 管道) → 值，以及鎖住的事件。/ Site defaults: (event, channel) → value, and the locked events.
struct Site {
    values: HashMap<(String, String), Option<bool>>,
    locked: Vec<String>,
}

async fn site(state: &AppState) -> sqlx::Result<Site> {
    let rows = db::notify_prefs::defaults(&state.db).await?;
    let mut values = HashMap::new();
    let mut locked = Vec::new();
    for r in rows {
        if r.locked && !locked.contains(&r.event) {
            locked.push(r.event.clone());
        }
        values.insert((r.event, r.channel), r.enabled);
    }
    Ok(Site { values, locked })
}

fn bool_or_null(v: Option<bool>) -> Value {
    v.map(Value::Bool).unwrap_or(Value::Null)
}

/// 一個事件的共同欄位。/ The fields every row carries.
fn event_base(k: Kind, site: &Site) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("event".into(), json!(k.name()));
    m.insert("group".into(), json!(k.group().as_str()));
    m.insert("audience".into(), json!(k.audience().as_str()));
    m.insert("tunnel".into(), json!(k.about_tunnel()));
    m.insert("status".into(), json!(k.is_status()));
    m.insert("channels".into(), json!(np::channels(k).iter().map(|c| c.as_str()).collect::<Vec<_>>()));
    m.insert("locked".into(), json!(site.locked.iter().any(|e| e == k.name())));
    let mut sv = Map::new();
    for c in np::channels(k) {
        sv.insert(c.as_str().into(), bool_or_null(site.values.get(&(k.name().to_string(), c.as_str().to_string())).copied().flatten()));
    }
    m.insert("site".into(), Value::Object(sv));
    m
}

async fn mine_json(state: &AppState, user: &User) -> ApiResult<Value> {
    let site = site(state).await?;
    let prefs: HashMap<(String, String), bool> =
        db::notify_prefs::prefs(&state.db, user.id).await?.into_iter().map(|p| ((p.event, p.channel), p.enabled)).collect();
    let events: Vec<Value> = np::events()
        .map(|k| {
            let mut m = event_base(k, &site);
            let locked = m["locked"].as_bool().unwrap_or(false);
            let (mut mine, mut eff, mut src) = (Map::new(), Map::new(), Map::new());
            for c in np::channels(k) {
                let key = (k.name().to_string(), c.as_str().to_string());
                let my = prefs.get(&key).copied();
                let (v, s) = np::resolve(k, Layers { locked, site: site.values.get(&key).copied().flatten(), mine: my, mute: None });
                mine.insert(c.as_str().into(), bool_or_null(my));
                eff.insert(c.as_str().into(), json!(v));
                src.insert(c.as_str().into(), json!(s.as_str()));
            }
            m.insert("mine".into(), Value::Object(mine));
            m.insert("effective".into(), Value::Object(eff));
            m.insert("source".into(), Value::Object(src));
            Value::Object(m)
        })
        .collect();
    // 只列還看得到的隧道（取消分享後留下的列不顯示）。/ Only tunnels still visible (rows left by an unshare are hidden).
    let mut mutes = Vec::new();
    for r in db::notify_prefs::mutes(&state.db, user.id).await? {
        let Some(t) = db::tunnels::by_id(&state.db, r.tunnel_id).await? else { continue };
        if permissions::effective_for(&state.db, user.id, &t).await?.is_none() {
            continue;
        }
        mutes.push(json!({ "tunnel_id": r.tunnel_id, "tunnel_name": r.tunnel_name, "scope": r.scope }));
    }
    Ok(json!({ "events": events, "mutes": mutes }))
}

#[utoipa::path(get, path = "/api/notifications/preferences", tag = "Notifications", security(("bearer" = [])), responses((status = 200, description = "Every event with an in-app notification: site value, lock, my value, the effective value and which layer decided it per channel; plus my tunnel mutes", body = super::schemas::NotifyPreferences)))]
async fn get_mine(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(mine_json(&state, &user).await?))
}

/// `[{event, channel, value: on|off|inherit}]` → 檢查過的清單。/ Parse and check a list of changes.
fn parse_changes(body: &Value, key: &str) -> ApiResult<Vec<(Kind, Channel, Option<bool>)>> {
    let Some(list) = body.get(key) else { return Ok(Vec::new()) };
    let list = list.as_array().ok_or_else(|| ApiError::field(key, "Expected a list."))?;
    let mut out = Vec::new();
    for item in list {
        let event = item.get("event").and_then(Value::as_str).unwrap_or("");
        let kind = np::parse_event(event).ok_or_else(|| ApiError::field(key, format!("Unknown event '{event}'.")))?;
        let channel = item.get("channel").and_then(Value::as_str).unwrap_or("");
        let ch = Channel::parse(channel).filter(|c| np::channels(kind).contains(c)).ok_or_else(|| ApiError::field(key, format!("'{event}' has no '{channel}' channel.")))?;
        let value = np::parse_value(item.get("value").unwrap_or(&Value::Null)).ok_or_else(|| ApiError::field(key, "value must be on, off or inherit."))?;
        out.push((kind, ch, value));
    }
    Ok(out)
}

#[utoipa::path(put, path = "/api/notifications/preferences", tag = "Notifications", security(("bearer" = [])), request_body = super::schemas::NotifyPrefsBody, responses((status = 200, description = "The whole preferences, after the change", body = super::schemas::NotifyPreferences), (status = 400, description = "{prefs: [message]}, or {error, code: locked, event} for turning off an enforced event", body = Object)))]
async fn put_mine(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let changes = parse_changes(&body, "prefs")?;
    let site = site(&state).await?;
    // 先全部檢查再寫：強制的事件不能關。/ Check everything first: an enforced event can't be turned off.
    if let Some((k, _, _)) = changes.iter().find(|(k, _, v)| *v == Some(false) && site.locked.iter().any(|e| e == k.name())) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            json!({ "error": "An administrator enforces this notification; it can't be turned off.", "code": "locked", "event": k.name() }),
        ));
    }
    for (k, c, v) in changes {
        db::notify_prefs::set_pref(&state.db, user.id, k.name(), c.as_str(), v).await?;
    }
    Ok(Json(mine_json(&state, &user).await?))
}

#[utoipa::path(put, path = "/api/notifications/mute/{tunnel_id}", tag = "Notifications", security(("bearer" = [])), params(("tunnel_id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::NotifyMuteBody, responses((status = 200, description = "{tunnel_id, scope}", body = super::schemas::NotifyMute), (status = 400, body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn mute(State(state): State<AppState>, AuthUser(user): AuthUser, Path(tunnel_id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = visible(&state, user.id, tunnel_id).await?;
    let raw = body.get("scope").and_then(Value::as_str).unwrap_or("all");
    let scope = Mute::parse(raw).ok_or_else(|| ApiError::field("scope", "scope must be all or status."))?;
    db::notify_prefs::set_mute(&state.db, user.id, t.id, Some(scope.as_str())).await?;
    Ok(Json(json!({ "tunnel_id": t.id, "scope": scope.as_str() })))
}

#[utoipa::path(delete, path = "/api/notifications/mute/{tunnel_id}", tag = "Notifications", security(("bearer" = [])), params(("tunnel_id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "{tunnel_id, scope: null}", body = super::schemas::NotifyMute), (status = 404, body = super::schemas::ErrorBody)))]
async fn unmute(State(state): State<AppState>, AuthUser(user): AuthUser, Path(tunnel_id): Path<i64>) -> ApiResult<Json<Value>> {
    // 看不到了也讓人清掉自己的列。/ Clearing your own row works even after losing access.
    if db::tunnels::by_id(&state.db, tunnel_id).await?.is_none() {
        return Err(ApiError::drf_not_found());
    }
    db::notify_prefs::set_mute(&state.db, user.id, tunnel_id, None).await?;
    Ok(Json(json!({ "tunnel_id": tunnel_id, "scope": Value::Null })))
}

async fn visible(state: &AppState, user_id: i64, id: i64) -> ApiResult<db::tunnels::Tunnel> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    if permissions::effective_for(&state.db, user_id, &t).await?.is_none() {
        return Err(ApiError::drf_not_found());
    }
    Ok(t)
}

async fn defaults_json(state: &AppState) -> ApiResult<Value> {
    let site = site(state).await?;
    Ok(json!({ "events": np::events().map(|k| Value::Object(event_base(k, &site))).collect::<Vec<_>>() }))
}

#[utoipa::path(get, path = "/api/notifications/defaults", tag = "Notifications", security(("bearer" = [])), responses((status = 200, description = "Site defaults per event × channel (null = built-in on) and which events are enforced (admins only)", body = super::schemas::NotifyDefaults), (status = 403, description = "admin_only", body = super::schemas::ErrorBody)))]
async fn get_defaults(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    Ok(Json(defaults_json(&state).await?))
}

#[utoipa::path(put, path = "/api/notifications/defaults", tag = "Notifications", security(("bearer" = [])), request_body = super::schemas::NotifyDefaultsBody, responses((status = 200, description = "The site defaults after the change", body = super::schemas::NotifyDefaults), (status = 400, body = Object), (status = 403, description = "admin_only", body = super::schemas::ErrorBody)))]
async fn put_defaults(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    admin_only(&me)?;
    let changes = parse_changes(&body, "defaults")?;
    let mut locks = Vec::new();
    if let Some(list) = body.get("locks") {
        for item in list.as_array().ok_or_else(|| ApiError::field("locks", "Expected a list."))? {
            let event = item.get("event").and_then(Value::as_str).unwrap_or("");
            let kind = np::parse_event(event).ok_or_else(|| ApiError::field("locks", format!("Unknown event '{event}'.")))?;
            let locked = item.get("locked").and_then(Value::as_bool).ok_or_else(|| ApiError::field("locks", "locked must be true or false."))?;
            locks.push((kind, locked));
        }
    }
    let mut said = Vec::new();
    for (k, c, v) in &changes {
        db::notify_prefs::set_default(&state.db, k.name(), c.as_str(), *v).await?;
        let v = match v {
            Some(true) => "on",
            Some(false) => "off",
            None => "built-in",
        };
        said.push(format!("{} {} {v}", k.name(), c.as_str()));
    }
    for (k, locked) in &locks {
        let chans: Vec<&str> = np::channels(*k).iter().map(|c| c.as_str()).collect();
        db::notify_prefs::set_locked(&state.db, k.name(), &chans, *locked).await?;
        said.push(format!("{} {}", k.name(), if *locked { "enforced" } else { "overridable" }));
    }
    if !said.is_empty() {
        state.gateway.event("notify_default", None, None, None, format!("{} changed site notification defaults: {}", me.username, said.join(", "))).await;
    }
    Ok(Json(defaults_json(&state).await?))
}
