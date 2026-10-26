//! Webhook API：每個人管自己的 webhook（只收得到他本來就會收到的通知），管理員共管全站 webhook（精選事件）。
//! 也提供事件目錄、測試送出、送出紀錄與簽章密鑰。
//! Webhooks API: everyone manages their own webhooks (which only carry notifications they already get); admins
//! share the site-wide ones (a curated set of events). Also the event catalogue, test sends, delivery history
//! and signing secrets.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, users::User, webhooks::{DeliveryRow, Fields, WebhookRow}};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{db_to_iso_utc_z, opt_db_to_iso_utc_z};
use crate::webhooks::{catalog, format::Format, target, text::Lang, Event, Hook, Kind};

const NAME_MAX: usize = 80;
/// 狀態告警的延遲上限（一天）。/ The longest status alert delay (a day).
const DELAY_MAX: i64 = 86_400;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, create))
        .routes(routes!(retrieve, update, destroy))
        .routes(routes!(send_test))
        .routes(routes!(deliveries))
        .routes(routes!(get_secret, rotate_secret))
}

fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// 欄位錯誤 + 機器可讀的 code（前端翻譯用）。/ A field error plus a code the frontend translates.
fn field_coded(field: &str, code: &str, msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, json!({ field: [msg], "code": code }))
}

fn not_found() -> ApiError {
    ApiError::not_found("Webhook not found")
}

/// 我能管的 webhook：自己的個人 webhook，或（管理員）全站的。別人的一律 404。
/// A webhook I manage: my own personal one, or (admins) a site-wide one. Anyone else's is a 404.
async fn manageable(state: &AppState, me: &User, id: i64) -> ApiResult<WebhookRow> {
    let row = db::webhooks::by_id(&state.db, id).await?.ok_or_else(not_found)?;
    let mine = if row.is_site() { me.is_superuser } else { row.user_id == Some(me.id) };
    if mine {
        Ok(row)
    } else {
        Err(not_found())
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

fn webhook_json(row: &WebhookRow, tunnels: &[i64], names: &HashMap<i64, String>, creators: &HashMap<i64, String>) -> Value {
    let resolved = url::Url::parse(&row.url).ok().map(|u| Format::parse(&row.format).unwrap_or(Format::Auto).resolve(&u).as_str());
    json!({
        "id": row.id,
        "scope": row.scope,
        "name": row.name,
        "url": row.url,
        "host": host_of(&row.url),
        "format": row.format,
        "format_resolved": resolved,
        "language": row.language,
        "events": catalog::parse_list(&row.events).iter().map(|k| k.name()).collect::<Vec<_>>(),
        "all_tunnels": row.all_tunnels,
        "tunnels": tunnels.iter().map(|id| json!({ "id": id, "name": names.get(id) })).collect::<Vec<_>>(),
        "delay": row.delay,
        "enabled": row.enabled,
        "paused_reason": if row.paused_reason.is_empty() { Value::Null } else { json!(row.paused_reason) },
        "failures": row.failures,
        "last": if row.last_status.is_empty() { Value::Null } else { json!({
            "status": row.last_status,
            "at": opt_db_to_iso_utc_z(&row.last_at),
            "http_status": row.last_code,
            "error": row.last_error,
        }) },
        "created_by": row.user_id.and_then(|u| creators.get(&u)),
        "created_at": db_to_iso_utc_z(&row.created_at),
        "updated_at": db_to_iso_utc_z(&row.updated_at),
    })
}

async fn tunnel_names(state: &AppState) -> ApiResult<HashMap<i64, String>> {
    Ok(db::tunnels::all(&state.db).await?.into_iter().map(|t| (t.id, t.host_friendly_name)).collect())
}

async fn usernames(state: &AppState) -> ApiResult<HashMap<i64, String>> {
    Ok(db::users::all_ordered(&state.db).await?.into_iter().map(|u| (u.id, u.username)).collect())
}

async fn one_json(state: &AppState, row: &WebhookRow) -> ApiResult<Value> {
    let tunnels = db::webhooks::tunnels_of(&state.db, row.id).await?;
    Ok(webhook_json(row, &tunnels, &tunnel_names(state).await?, &usernames(state).await?))
}

/// 我看得到的隧道（個人 webhook 只能限定在這些）。/ Tunnels I can see (what a personal webhook may be limited to).
async fn visible_tunnels(state: &AppState, me: &User) -> ApiResult<HashSet<i64>> {
    let mut ids: HashSet<i64> = db::tunnels::all(&state.db).await?.into_iter().filter(|t| t.user_id == me.id).map(|t| t.id).collect();
    ids.extend(db::sharing::all_pairs(&state.db).await?.into_iter().filter(|(_, u)| *u == me.id).map(|(t, _)| t));
    Ok(ids)
}

/// 表單驗證後的值。/ The validated form.
struct Form {
    name: String,
    url: String,
    format: Format,
    language: Lang,
    events: Vec<Kind>,
    all_tunnels: bool,
    tunnel_ids: Vec<i64>,
    delay: i64,
    enabled: bool,
}

impl Form {
    fn fields<'a>(&'a self, events: &'a str) -> Fields<'a> {
        Fields {
            name: &self.name,
            url: &self.url,
            format: self.format.as_str(),
            language: self.language.as_str(),
            events,
            all_tunnels: self.all_tunnels,
            delay: self.delay,
            enabled: self.enabled,
        }
    }
}

/// 驗證表單（PATCH 時沒帶的欄位沿用 `current`）。/ Validate the form; on PATCH missing fields keep `current`.
async fn parse_form(state: &AppState, me: &User, site: bool, body: &Value, current: Option<(&WebhookRow, Vec<i64>)>) -> ApiResult<Form> {
    let cur = current.as_ref().map(|(r, _)| *r);
    let text = |k: &str| body.get(k).and_then(Value::as_str).map(|s| s.trim().to_string());

    let url = text("url").or_else(|| cur.map(|c| c.url.clone())).unwrap_or_default();
    let url_changed = cur.is_none_or(|c| c.url != url);
    let allow_private = site || db::settings::get_solo(&state.db).await?.notify_private_targets;
    // 網址沒改就不重查（存的時候查過了；DNS 暫時不通不該讓人改不了名字）。/ An unchanged URL is not re-checked.
    if url_changed {
        if let Err(p) = target::check(&url, allow_private).await {
            return Err(field_coded("url", p.code(), p.message()));
        }
    }

    let mut name = text("name").or_else(|| cur.map(|c| c.name.clone())).unwrap_or_default();
    if name.is_empty() {
        name = host_of(&url);
    }
    if name.chars().count() > NAME_MAX {
        return Err(ApiError::field("name", format!("Keep the name under {NAME_MAX} characters.")));
    }

    let format = match text("format").or_else(|| cur.map(|c| c.format.clone())) {
        None => Format::Auto,
        Some(s) => Format::parse(&s).ok_or_else(|| ApiError::field("format", "Unknown format."))?,
    };
    let language = match text("language").or_else(|| cur.map(|c| c.language.clone())) {
        None => Lang::En,
        Some(s) => Lang::parse(&s).ok_or_else(|| ApiError::field("language", "Choose en, zh-TW or ja."))?,
    };

    let events: Vec<Kind> = match body.get("events") {
        None | Some(Value::Null) => cur.map(|c| catalog::parse_list(&c.events)).unwrap_or_else(|| catalog::STATUS.to_vec()),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for item in items {
                let kind = item.as_str().and_then(Kind::parse).filter(|k| if site { k.site() } else { k.personal() });
                match kind {
                    Some(k) => out.push(k),
                    None => return Err(ApiError::field("events", format!("{item} is not an event this webhook can receive."))),
                }
            }
            catalog::parse_list(&catalog::join_list(&out))
        }
        Some(_) => return Err(ApiError::field("events", "events must be a list.")),
    };
    if events.is_empty() {
        return Err(field_coded("events", "no_events", "Pick at least one event."));
    }

    let all_tunnels = match body.get("all_tunnels") {
        None | Some(Value::Null) => cur.map(|c| c.all_tunnels).unwrap_or(true),
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(ApiError::field("all_tunnels", "all_tunnels must be true or false.")),
    };
    let mut tunnel_ids: Vec<i64> = match body.get("tunnel_ids") {
        None | Some(Value::Null) => current.as_ref().map(|(_, t)| t.clone()).unwrap_or_default(),
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_i64).collect(),
        Some(_) => return Err(ApiError::field("tunnel_ids", "tunnel_ids must be a list of ids.")),
    };
    tunnel_ids.sort_unstable();
    tunnel_ids.dedup();
    if all_tunnels {
        tunnel_ids.clear();
    } else {
        // 個人的只能選自己看得到的隧道；全站的任何隧道。/ Personal: tunnels I can see; site: any tunnel.
        let allowed: HashSet<i64> = if site { tunnel_names(state).await?.into_keys().collect() } else { visible_tunnels(state, me).await? };
        if tunnel_ids.iter().any(|t| !allowed.contains(t)) {
            return Err(ApiError::field("tunnel_ids", "One of these tunnels does not exist or is not visible to you."));
        }
        if tunnel_ids.is_empty() {
            return Err(field_coded("tunnel_ids", "no_tunnels", "Pick at least one tunnel, or choose all tunnels."));
        }
    }

    let delay = match body.get("delay") {
        None | Some(Value::Null) => cur.map(|c| c.delay).unwrap_or(60),
        Some(v) => v.as_i64().ok_or_else(|| ApiError::field("delay", "A valid integer is required."))?,
    };
    if !(0..=DELAY_MAX).contains(&delay) {
        return Err(ApiError::field("delay", format!("Must be between 0 and {DELAY_MAX} seconds.")));
    }
    let enabled = match body.get("enabled") {
        None | Some(Value::Null) => cur.map(|c| c.enabled).unwrap_or(true),
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(ApiError::field("enabled", "enabled must be true or false.")),
    };
    Ok(Form { name, url, format, language, events, all_tunnels, tunnel_ids, delay, enabled })
}

/// 全站 webhook 的變動記進 Logs（管理員看得到）。/ Site webhook changes go to the Logs (admins see them).
async fn log_site(state: &AppState, me: &User, verb: &str, row: &WebhookRow) {
    if row.is_site() {
        state.gateway.event("webhook", None, None, None, format!("{} {verb} the site-wide webhook \"{}\" ({})", me.username, row.name, host_of(&row.url))).await;
    }
}

/// 我的 webhook、（管理員）全站 webhook、兩個範圍的事件目錄與網站的限制。
/// My webhooks, the site-wide ones (admins), the event catalogue per scope and the site's limits.
#[utoipa::path(get, path = "/api/webhooks", tag = "Webhooks", security(("bearer" = [])), responses((status = 200, body = super::schemas::WebhookList)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let settings = db::settings::get_solo(&state.db).await?;
    let names = tunnel_names(&state).await?;
    let creators = usernames(&state).await?;
    let map = db::webhooks::tunnel_map(&state.db).await?;
    let render = |rows: Vec<WebhookRow>| -> Vec<Value> { rows.iter().map(|r| webhook_json(r, map.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), &names, &creators)).collect() };
    let mine = db::webhooks::for_user(&state.db, me.id).await?;
    let used = mine.len();
    let site = if me.is_superuser { Some(render(db::webhooks::site(&state.db).await?)) } else { None };
    Ok(Json(json!({
        "mine": render(mine),
        "site": site,
        "catalog": {
            "personal": catalog::catalog_json(false),
            "site": if me.is_superuser { catalog::catalog_json(true) } else { Value::Null },
        },
        "policy": {
            "personal_enabled": settings.notify_user_webhooks,
            "private_targets": settings.notify_private_targets,
            "max": settings.notify_max_webhooks,
            "used": used,
            "pause_after": crate::webhooks::PAUSE_AFTER,
            "per_minute": crate::webhooks::PER_MINUTE,
        },
        "can_manage_site": me.is_superuser,
        "public_url": state.webhooks.base_url(),
    })))
}

/// 新增 webhook（`scope: "site"` 只有管理員）。回傳 webhook 與簽章密鑰。
/// Add a webhook (`scope: "site"` for admins only). Returns it with its signing secret.
#[utoipa::path(post, path = "/api/webhooks", tag = "Webhooks", security(("bearer" = [])), request_body = super::schemas::WebhookInput, responses((status = 201, body = super::schemas::WebhookCreated), (status = 400, description = "{field: [message], code?}", body = Object), (status = 403, body = super::schemas::ErrorBody)))]
async fn create(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let site = match body.get("scope").and_then(Value::as_str).unwrap_or("user") {
        "user" => false,
        "site" => true,
        _ => return Err(ApiError::field("scope", "Choose user or site.")),
    };
    if site && !me.is_superuser {
        return Err(coded(StatusCode::FORBIDDEN, "admins_only", "Only administrators can add site-wide webhooks."));
    }
    if !site {
        let settings = db::settings::get_solo(&state.db).await?;
        if !settings.notify_user_webhooks {
            return Err(coded(StatusCode::FORBIDDEN, "personal_disabled", "An administrator has turned personal webhooks off."));
        }
        if db::webhooks::count_for_user(&state.db, me.id).await? >= settings.notify_max_webhooks {
            return Err(coded(StatusCode::BAD_REQUEST, "limit", format!("You can have at most {} webhooks.", settings.notify_max_webhooks)));
        }
    }
    let form = parse_form(&state, &me, site, &body, None).await?;
    let events = catalog::join_list(&form.events);
    let row = db::webhooks::create(&state.db, Some(me.id), if site { "site" } else { "user" }, &form.fields(&events)).await?;
    if !form.all_tunnels {
        db::webhooks::set_tunnels(&state.db, row.id, &form.tunnel_ids).await?;
    }
    let secret = state.webhooks.rotate_secret(row.id).await?;
    state.webhooks.invalidate();
    log_site(&state, &me, "added", &row).await;
    let row = db::webhooks::by_id(&state.db, row.id).await?.ok_or_else(not_found)?;
    Ok((StatusCode::CREATED, Json(json!({ "webhook": one_json(&state, &row).await?, "secret": secret }))))
}

#[utoipa::path(get, path = "/api/webhooks/{id}", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 200, body = super::schemas::Webhook), (status = 404, body = super::schemas::ErrorBody)))]
async fn retrieve(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row = manageable(&state, &me, id).await?;
    Ok(Json(one_json(&state, &row).await?))
}

/// 修改（只帶要改的欄位）。重新開啟會清掉「一直失敗而暫停」。/ Change it (send only what changes); re-enabling clears a pause.
#[utoipa::path(patch, path = "/api/webhooks/{id}", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), request_body = super::schemas::WebhookInput, responses((status = 200, body = super::schemas::Webhook), (status = 400, description = "{field: [message], code?}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let row = manageable(&state, &me, id).await?;
    let tunnels = db::webhooks::tunnels_of(&state.db, id).await?;
    let form = parse_form(&state, &me, row.is_site(), &body, Some((&row, tunnels))).await?;
    let events = catalog::join_list(&form.events);
    db::webhooks::update(&state.db, id, &form.fields(&events)).await?;
    db::webhooks::set_tunnels(&state.db, id, &form.tunnel_ids).await?;
    state.webhooks.invalidate();
    let row = db::webhooks::by_id(&state.db, id).await?.ok_or_else(not_found)?;
    log_site(&state, &me, "changed", &row).await;
    Ok(Json(one_json(&state, &row).await?))
}

#[utoipa::path(delete, path = "/api/webhooks/{id}", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 204), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let row = manageable(&state, &me, id).await?;
    db::webhooks::delete(&state.db, id).await?;
    state.webhooks.invalidate();
    log_site(&state, &me, "removed", &row).await;
    Ok(StatusCode::NO_CONTENT)
}

/// 送一則測試訊息（等結果，不重試，關著的 webhook 也能測）。/ Send a test message and wait (no retries; works while off).
#[utoipa::path(post, path = "/api/webhooks/{id}/test", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 200, body = super::schemas::WebhookTestResult), (status = 404, body = super::schemas::ErrorBody)))]
async fn send_test(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row = manageable(&state, &me, id).await?;
    let tunnels = db::webhooks::tunnels_of(&state.db, id).await?;
    let hook = Hook::new(row, tunnels);
    let allow_private = state.webhooks.allow_private(&hook).await;
    let event = Event::new(Kind::Test).data(json!({ "by": me.username })).link("/tunnels/webhooks");
    let out = state.webhooks.deliver(&hook, &event, true, allow_private).await;
    Ok(Json(json!({ "ok": out.ok, "http_status": out.status, "error": if out.error.is_empty() { Value::Null } else { json!(out.error) }, "duration_ms": out.duration_ms })))
}

fn delivery_json(d: &DeliveryRow) -> Value {
    json!({
        "id": d.id,
        "event": d.event,
        "message_id": d.message_id,
        "at": db_to_iso_utc_z(&d.at),
        "status": d.status,
        "http_status": d.http_status,
        "error": d.error,
        "attempts": d.attempts,
        "duration_ms": d.duration_ms,
        "test": d.test,
        "body": d.body,
    })
}

/// 最近 50 次送出（新的在前），含送出的內容。/ The latest 50 deliveries, newest first, with what was sent.
#[utoipa::path(get, path = "/api/webhooks/{id}/deliveries", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 200, body = Vec<super::schemas::WebhookDelivery>), (status = 404, body = super::schemas::ErrorBody)))]
async fn deliveries(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    manageable(&state, &me, id).await?;
    let rows = db::webhooks::deliveries(&state.db, id).await?;
    Ok(Json(Value::Array(rows.iter().map(delivery_json).collect())))
}

/// 簽章密鑰（`whsec_…`）。/ The signing secret (`whsec_…`).
#[utoipa::path(get, path = "/api/webhooks/{id}/secret", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 200, body = super::schemas::WebhookSecret), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "The secret cannot be opened (SECRET_KEY changed): rotate it", body = super::schemas::ErrorBody)))]
async fn get_secret(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row = manageable(&state, &me, id).await?;
    match state.webhooks.secret(&row).await {
        Some(secret) => Ok(Json(json!({ "secret": secret }))),
        None => Err(coded(StatusCode::CONFLICT, "secret_unreadable", "The signing secret cannot be read any more (the server's SECRET_KEY changed). Rotate it.")),
    }
}

/// 換一把新的簽章密鑰（舊的立刻失效）。/ Rotate the signing secret (the old one stops working at once).
#[utoipa::path(post, path = "/api/webhooks/{id}/secret", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 200, body = super::schemas::WebhookSecret), (status = 404, body = super::schemas::ErrorBody)))]
async fn rotate_secret(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row = manageable(&state, &me, id).await?;
    let secret = state.webhooks.rotate_secret(row.id).await?;
    log_site(&state, &me, "rotated the signing secret of", &row).await;
    Ok(Json(json!({ "secret": secret })))
}
