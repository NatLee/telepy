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
use crate::db::{self, users::User, webhooks::{DeliveryRow, Fields, OptOut, WebhookRow, MODE_DEFAULT, MODE_ENFORCED}};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{db_to_iso_utc_z, opt_db_to_iso_utc_z};
use crate::webhooks::{catalog, format::Format, target, text::Lang, validate_headers, Event, Header, Hook, How, Kind};

const NAME_MAX: usize = 80;
/// 狀態告警的延遲上限（一天）。/ The longest status alert delay (a day).
const DELAY_MAX: i64 = 86_400;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, create))
        .routes(routes!(retrieve, update, destroy))
        .routes(routes!(send_test))
        .routes(routes!(deliveries))
        .routes(routes!(redeliver))
        .routes(routes!(get_secret, rotate_secret))
        .routes(routes!(set_optout, clear_optout))
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

/// 全站 webhook 的退出清單（給管理員）：哪條隧道、誰退的、那個人現在還管不管那條隧道（不管了 = 不算數）。
/// A site webhook's opt-outs (for admins): tunnel, who, and whether that person still manages it (if not, it doesn't count).
fn optouts_json(rows: &[OptOut], names: &HashMap<i64, String>, users: &HashMap<i64, String>, managers: &HashMap<i64, Vec<i64>>) -> Value {
    json!(rows
        .iter()
        .map(|o| json!({
            "tunnel_id": o.tunnel_id,
            "tunnel_name": names.get(&o.tunnel_id),
            "by": users.get(&o.user_id),
            "at": db_to_iso_utc_z(&o.created_at),
            "active": managers.get(&o.tunnel_id).is_some_and(|m| m.contains(&o.user_id)),
        }))
        .collect::<Vec<_>>())
}

fn webhook_json(row: &WebhookRow, tunnels: &[i64], names: &HashMap<i64, String>, creators: &HashMap<i64, String>, headers: Result<Vec<Header>, ()>, optouts: Value) -> Value {
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
        "headers_unreadable": headers.is_err(),
        "headers": headers.unwrap_or_default(),
        "created_by": row.user_id.and_then(|u| creators.get(&u)),
        "mode": if row.is_site() { json!(row.mode) } else { Value::Null },
        "optouts": if row.is_site() { optouts } else { json!([]) },
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
    let names = tunnel_names(state).await?;
    let users = usernames(state).await?;
    let optouts = if row.is_site() {
        let rows = db::webhooks::optout_map(&state.db).await?.remove(&row.id).unwrap_or_default();
        optouts_json(&rows, &names, &users, &db::webhooks::all_managers(&state.db).await?)
    } else {
        json!([])
    };
    Ok(webhook_json(row, &tunnels, &names, &users, state.webhooks.headers(row), optouts))
}

/// 我管的隧道（owner 或現在有效權限是 ADMIN）。/ Tunnels I manage (owner, or ADMIN in force).
fn managed_by(managers: &HashMap<i64, Vec<i64>>, user_id: i64) -> HashSet<i64> {
    managers.iter().filter(|(_, m)| m.contains(&user_id)).map(|(t, _)| *t).collect()
}

/// 摘要裡「退出」相關的部分要用的東西。/ What the opt-out part of a summary needs.
struct OptOutContext<'a> {
    me: i64,
    managed: &'a HashSet<i64>,
    managers: &'a HashMap<i64, Vec<i64>>,
    optouts: &'a HashMap<i64, Vec<OptOut>>,
    users: &'a HashMap<i64, String>,
}

/// 我看得到的隧道（個人 webhook 只能限定在這些）。/ Tunnels I can see (what a personal webhook may be limited to).
async fn visible_tunnels(state: &AppState, me: &User) -> ApiResult<HashSet<i64>> {
    let mut ids: HashSet<i64> = db::tunnels::all(&state.db).await?.into_iter().filter(|t| t.user_id == me.id).map(|t| t.id).collect();
    ids.extend(db::sharing::all_pairs(&state.db).await?.into_iter().filter(|(_, u)| *u == me.id).map(|(t, _)| t));
    Ok(ids)
}

/// 給每個登入者看的全站 webhook 摘要：不含網址、header、密鑰、送出紀錄與建立者；隧道只列看得到的，其餘只算數量。
/// A redacted site-wide webhook for every signed-in user: no URL, headers, secret, deliveries or creator; only the
/// picked tunnels the caller can see are named, the rest are counted.
/// 沒取名時名稱 = 網址的主機（`host_of`）：非管理員不給，免得內部主機名露出去（畫面改顯示服務名稱）。
/// A webhook saved without a name is named after its URL's host: non-admins get null instead, so internal host names
/// don't leak (the page shows the service instead).
/// 退出：`mode`、`my_optout`（我退出的隧道 id）、`managed`（這個 webhook 涵蓋的、我管的隧道：
/// `{id, name, opted_out, by: [現在還管它、退出了的人], mine}`，依名稱排序）。
/// Opt-outs: `mode`, `my_optout` (tunnel ids I opted out) and `managed` (tunnels I manage that it covers, with
/// whether they are opted out now and by whom), by name.
fn site_summary_json(row: &WebhookRow, picked: &[i64], names: &HashMap<i64, String>, visible: &HashSet<i64>, admin: bool, ctx: &OptOutContext) -> Value {
    let service = url::Url::parse(&row.url).ok().map(|u| Format::parse(&row.format).unwrap_or(Format::Auto).resolve(&u).as_str());
    let mut shown: Vec<(i64, &str)> = Vec::new();
    let mut hidden = 0;
    if !row.all_tunnels {
        for id in picked {
            match names.get(id) {
                Some(name) if visible.contains(id) => shown.push((*id, name.as_str())),
                _ => hidden += 1,
            }
        }
    }
    shown.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then(a.0.cmp(&b.0)));
    let rows: &[OptOut] = ctx.optouts.get(&row.id).map(Vec::as_slice).unwrap_or(&[]);
    let mut mine_out: Vec<i64> = rows.iter().filter(|o| o.user_id == ctx.me).map(|o| o.tunnel_id).collect();
    mine_out.sort_unstable();
    let mut covered: Vec<(i64, &str)> = ctx
        .managed
        .iter()
        .filter(|t| row.all_tunnels || picked.contains(t))
        .filter_map(|t| names.get(t).map(|n| (*t, n.as_str())))
        .collect();
    covered.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then(a.0.cmp(&b.0)));
    let managed: Vec<Value> = covered
        .into_iter()
        .map(|(id, name)| {
            let current = ctx.managers.get(&id).map(Vec::as_slice).unwrap_or(&[]);
            let by: Vec<&String> = rows.iter().filter(|o| o.tunnel_id == id && current.contains(&o.user_id)).filter_map(|o| ctx.users.get(&o.user_id)).collect();
            json!({ "id": id, "name": name, "opted_out": !by.is_empty(), "by": by, "mine": mine_out.contains(&id) })
        })
        .collect();
    json!({
        "id": row.id,
        "name": if !admin && row.name == host_of(&row.url) { None } else { Some(&row.name) },
        "service": service,
        "events": catalog::parse_list(&row.events).iter().map(|k| k.name()).collect::<Vec<_>>(),
        "all_tunnels": row.all_tunnels,
        "tunnels": shown.into_iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "hidden_tunnels": hidden,
        "enabled": row.enabled,
        "paused": !row.paused_reason.is_empty(),
        "mode": row.mode,
        "my_optout": mine_out,
        "managed": managed,
    })
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
    /// enforced / default（個人的一律 default）。/ enforced / default (always default for personal webhooks).
    mode: &'static str,
    /// None = 沒改。/ None = unchanged.
    headers: Option<Vec<Header>>,
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
            mode: self.mode,
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
    // 模式只對全站的有意義；升級前的、沒指定的都是 default（可以退出）。/ Only site webhooks have a mode; unset = default.
    let mode = match body.get("mode") {
        None | Some(Value::Null) => {
            if cur.is_some_and(|c| c.mode == MODE_ENFORCED) {
                MODE_ENFORCED
            } else {
                MODE_DEFAULT
            }
        }
        Some(v) => match v.as_str() {
            Some("enforced") => MODE_ENFORCED,
            Some("default") => MODE_DEFAULT,
            _ => return Err(ApiError::field("mode", "Choose enforced or default.")),
        },
    };
    let mode = if site { mode } else { MODE_DEFAULT };
    let headers = match body.get("headers") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            let mut list = Vec::new();
            for item in items {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let value = item.get("value").and_then(Value::as_str).unwrap_or("").to_string();
                list.push(Header { name, value });
            }
            validate_headers(&list).map_err(|m| field_coded("headers", "bad_header", &m))?;
            Some(list)
        }
        Some(_) => return Err(ApiError::field("headers", "headers must be a list of {name, value}.")),
    };
    Ok(Form { name, url, format, language, events, all_tunnels, tunnel_ids, delay, enabled, mode, headers })
}

/// 全站 webhook 的變動記進 Logs（管理員看得到）。/ Site webhook changes go to the Logs (admins see them).
async fn log_site(state: &AppState, me: &User, verb: &str, row: &WebhookRow) {
    if row.is_site() {
        state.gateway.event("webhook", None, None, None, format!("{} {verb} the site-wide webhook \"{}\" ({})", me.username, row.name, host_of(&row.url))).await;
    }
}

/// 我的 webhook、（管理員）全站 webhook、兩個範圍的事件目錄與網站的限制。
/// My webhooks, the site-wide ones (admins; a redacted summary for everyone), the event catalogue per scope and the site's limits.
#[utoipa::path(get, path = "/api/webhooks", tag = "Webhooks", security(("bearer" = [])), responses((status = 200, body = super::schemas::WebhookList)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let settings = db::settings::get_solo(&state.db).await?;
    let names = tunnel_names(&state).await?;
    let creators = usernames(&state).await?;
    let map = db::webhooks::tunnel_map(&state.db).await?;
    let optouts = db::webhooks::optout_map(&state.db).await?;
    let managers = db::webhooks::all_managers(&state.db).await?;
    let managed = managed_by(&managers, me.id);
    let ctx = OptOutContext { me: me.id, managed: &managed, managers: &managers, optouts: &optouts, users: &creators };
    let render = |rows: Vec<WebhookRow>| -> Vec<Value> {
        rows.iter()
            .map(|r| {
                let o = optouts_json(optouts.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), &names, &creators, &managers);
                webhook_json(r, map.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), &names, &creators, state.webhooks.headers(r), o)
            })
            .collect()
    };
    let mine = db::webhooks::for_user(&state.db, me.id).await?;
    let used = mine.len();
    let site_rows = db::webhooks::site(&state.db).await?;
    // 每個人都看得到全站 webhook 的摘要；非管理員只看開著的和因為一直失敗而暫停的（暫停時 enabled = 0）。
    // Everyone gets the redacted site list; non-admins only the enabled ones and the paused ones (paused = enabled 0).
    let visible: HashSet<i64> = if me.is_superuser { names.keys().copied().collect() } else { visible_tunnels(&state, &me).await? };
    let site_summary: Vec<Value> = site_rows
        .iter()
        .filter(|r| me.is_superuser || r.enabled || !r.paused_reason.is_empty())
        .map(|r| site_summary_json(r, map.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), &names, &visible, me.is_superuser, &ctx))
        .collect();
    let site = if me.is_superuser { Some(render(site_rows)) } else { None };
    Ok(Json(json!({
        "mine": render(mine),
        "site": site,
        "site_summary": site_summary,
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
        // 全站 webhook 可以限定的隧道：整台伺服器的（只給管理員）。/ Tunnels a site-wide webhook may be limited to (admins only).
        "site_tunnels": if me.is_superuser {
            let mut all: Vec<(i64, String)> = names.iter().map(|(id, n)| (*id, n.clone())).collect();
            all.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then(a.0.cmp(&b.0)));
            json!(all.into_iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>())
        } else {
            Value::Null
        },
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
    if let Some(h) = &form.headers {
        state.webhooks.set_headers(row.id, h).await?;
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
    let mode_changed = row.is_site() && row.mode != form.mode;
    db::webhooks::set_tunnels(&state.db, id, &form.tunnel_ids).await?;
    if let Some(h) = &form.headers {
        state.webhooks.set_headers(id, h).await?;
    }
    state.webhooks.invalidate();
    let row = db::webhooks::by_id(&state.db, id).await?.ok_or_else(not_found)?;
    log_site(&state, &me, "changed", &row).await;
    if mode_changed {
        let verb = if row.is_enforced() { "enforced (tunnel owners can no longer opt out of)" } else { "let tunnel owners opt out of" };
        log_site(&state, &me, verb, &row).await;
    }
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
    let out = state.webhooks.deliver(&hook, &event, &How::Test, allow_private).await;
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
        "redelivered_from": d.redelivered_from,
        "can_redeliver": !d.test && !d.event_json.is_empty(),
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

/// 重送一筆（同一個 `webhook-id`，用 webhook 現在的格式、語言與 header；不重試、不算進連續失敗，關著的也能送）。
/// Re-send one delivery: same `webhook-id`, rendered with the webhook's current format, language and headers; no
/// retries, not counted toward failures, works while the webhook is off.
#[utoipa::path(post, path = "/api/webhooks/{id}/deliveries/{delivery_id}/redeliver", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path), ("delivery_id" = i64, Path)), responses((status = 200, body = super::schemas::WebhookTestResult), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "Test sends and old records can't be re-sent", body = super::schemas::ErrorBody)))]
async fn redeliver(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, delivery_id)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    let row = manageable(&state, &me, id).await?;
    let d = db::webhooks::delivery(&state.db, id, delivery_id).await?.ok_or_else(|| ApiError::not_found("Delivery not found"))?;
    let event = serde_json::from_str::<Value>(&d.event_json).ok().filter(|_| !d.test).and_then(|v| Event::from_json(&v));
    let Some(event) = event else {
        return Err(coded(StatusCode::CONFLICT, "not_redeliverable", "This delivery can't be sent again."));
    };
    let tunnels = db::webhooks::tunnels_of(&state.db, id).await?;
    let hook = Hook::new(row, tunnels);
    let allow_private = state.webhooks.allow_private(&hook).await;
    let out = state.webhooks.deliver(&hook, &event, &How::Again { from: d.id, message_id: d.message_id.clone() }, allow_private).await;
    Ok(Json(json!({ "ok": out.ok, "http_status": out.status, "error": if out.error.is_empty() { Value::Null } else { json!(out.error) }, "duration_ms": out.duration_ms })))
}

/// 退出用：全站 webhook（個人的、不存在的都 404）。/ For opt-outs: a site webhook (personal or unknown = 404).
async fn site_hook(state: &AppState, id: i64) -> ApiResult<WebhookRow> {
    db::webhooks::by_id(&state.db, id).await?.filter(WebhookRow::is_site).ok_or_else(not_found)
}

/// 這個人對這個 webhook 的摘要（退出改完後回傳）。/ This person's summary of a site webhook (returned after an opt-out change).
async fn summary_for(state: &AppState, me: &User, row: &WebhookRow) -> ApiResult<Value> {
    let names = tunnel_names(state).await?;
    let users = usernames(state).await?;
    let picked = db::webhooks::tunnels_of(&state.db, row.id).await?;
    let optouts = db::webhooks::optout_map(&state.db).await?;
    let managers = db::webhooks::all_managers(&state.db).await?;
    let managed = managed_by(&managers, me.id);
    let visible: HashSet<i64> = if me.is_superuser { names.keys().copied().collect() } else { visible_tunnels(state, me).await? };
    let ctx = OptOutContext { me: me.id, managed: &managed, managers: &managers, optouts: &optouts, users: &users };
    Ok(site_summary_json(row, &picked, &names, &visible, me.is_superuser, &ctx))
}

/// 退出 / 回來寫進那條隧道的 Logs。/ Opting out / back in goes to that tunnel's Logs.
async fn log_optouts(state: &AppState, me: &User, row: &WebhookRow, names: &HashMap<i64, String>, added: &[i64], removed: &[i64]) {
    let hook = if row.name.is_empty() { host_of(&row.url) } else { row.name.clone() };
    for (list, direction) in [(added, "out of"), (removed, "back into")] {
        for t in list {
            let tunnel = names.get(t).cloned().unwrap_or_else(|| format!("#{t}"));
            let msg = format!("{} opted {tunnel} {direction} the site webhook \"{hook}\"", me.username);
            state.gateway.event("webhook_optout", None, None, Some(*t), msg).await;
        }
    }
}

/// 把我管的隧道退出一個「預設」的全站 webhook（整組取代我的退出清單）。只有隧道的 owner / ADMIN 能退；強制的不能退。
/// Opt tunnels I manage out of a default site-wide webhook (replaces my opt-outs for it). Only a tunnel's owner /
/// ADMIN may; enforced webhooks can't be opted out of.
#[utoipa::path(put, path = "/api/webhooks/{id}/optout", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), request_body = super::schemas::WebhookOptOutInput, responses((status = 200, body = super::schemas::SiteWebhookSummary), (status = 400, description = "{tunnel_ids: [message]} or {error, code: enforced}", body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_optout(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let row = site_hook(&state, id).await?;
    if row.is_enforced() {
        return Err(coded(StatusCode::BAD_REQUEST, "enforced", "This site-wide webhook is enforced: tunnels can't be opted out of it."));
    }
    let mut ids: Vec<i64> = match body.get("tunnel_ids") {
        Some(Value::Array(items)) if items.iter().all(Value::is_i64) => items.iter().filter_map(Value::as_i64).collect(),
        _ => return Err(ApiError::field("tunnel_ids", "tunnel_ids must be a list of ids.")),
    };
    ids.sort_unstable();
    ids.dedup();
    let managers = db::webhooks::all_managers(&state.db).await?;
    let managed = managed_by(&managers, me.id);
    if ids.iter().any(|t| !managed.contains(t)) {
        return Err(field_coded("tunnel_ids", "not_manager", "Only a tunnel's owner or an ADMIN sharee can opt it out."));
    }
    let picked = db::webhooks::tunnels_of(&state.db, id).await?;
    if !row.all_tunnels && ids.iter().any(|t| !picked.contains(t)) {
        return Err(field_coded("tunnel_ids", "not_covered", "This webhook doesn't cover one of these tunnels."));
    }
    let (added, removed) = db::webhooks::set_optouts(&state.db, id, me.id, &ids).await?;
    state.webhooks.invalidate();
    let names = tunnel_names(&state).await?;
    log_optouts(&state, &me, &row, &names, &added, &removed).await;
    Ok(Json(summary_for(&state, &me, &row).await?))
}

/// 拿掉我對這個全站 webhook 的所有退出（強制的也可以清）。/ Remove all my opt-outs of a site webhook (works on enforced ones too).
#[utoipa::path(delete, path = "/api/webhooks/{id}/optout", tag = "Webhooks", security(("bearer" = [])), params(("id" = i64, Path)), responses((status = 204), (status = 404, body = super::schemas::ErrorBody)))]
async fn clear_optout(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let row = site_hook(&state, id).await?;
    let (_, removed) = db::webhooks::set_optouts(&state.db, id, me.id, &[]).await?;
    state.webhooks.invalidate();
    let names = tunnel_names(&state).await?;
    log_optouts(&state, &me, &row, &names, &[], &removed).await;
    Ok(StatusCode::NO_CONTENT)
}
