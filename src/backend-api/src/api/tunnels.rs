//! `/api/reverse/server/*`：隧道（ReverseServerAuthorizedKeys）ViewSet、dashboard、狀態、
//! 目標使用者名稱查詢、預設使用者名稱、服務金鑰。對應 authorized_keys/views.py。

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::notify;
use super::serialize::{endpoint_json, presence_json, tunnel_json};
use super::AppJson;
use crate::auth::extractor::Delegated;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::{NewTunnel, Tunnel, TunnelPatch}};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::{json_i64, json_str};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(status_ports))
        .routes(routes!(status_latency))
        .routes(routes!(dashboard))
        .routes(routes!(list, create))
        .routes(routes!(retrieve, update, partial_update, destroy))
        .routes(routes!(delete_check))
        .routes(routes!(usernames_for_server))
        .routes(routes!(set_default_username))
        .routes(routes!(service_keys))
        .routes(routes!(pin, unpin))
        .routes(routes!(set_labels))
        .routes(routes!(connections))
        .routes(routes!(probe_now))
}

/// `{port: bool}`；取樣不可用回 `{}`。/ Port map, `{}` when the sample is unavailable.
pub async fn ports_json(state: &AppState) -> ApiResult<Value> {
    let map = state.status.ports_status(&state.db).await?.unwrap_or_default();
    Ok(Value::Object(map.into_iter().map(|(p, v)| (p.to_string(), Value::Bool(v))).collect()))
}

pub fn latency_json(state: &AppState) -> Value {
    let map: BTreeMap<u16, f64> = state.status.latency().unwrap_or_default().into_iter().collect();
    Value::Object(map.into_iter().map(|(p, v)| (p.to_string(), json!(v))).collect())
}

#[utoipa::path(get, path = "/api/reverse/server/status/ports", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, description = "{\"<reverse_port>\": listening} for every tunnel; {} when the status source is unavailable", body = Object)))]
async fn status_ports(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(ports_json(&state).await?))
}

#[utoipa::path(get, path = "/api/reverse/server/status/latency", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, description = "{\"<reverse_port>\": rtt_ms}", body = Object)))]
async fn status_latency(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(latency_json(&state)))
}

/// 列表序列化：以預先算好的表避免每列查詢（`tunnel_permission_context`）。
/// 列表多一個 `endpoint`（裝置的公網 IP）：只給 [`permissions::can_see_endpoint`] 允許的人，其他人是 null；
/// 和 `presence`（誰在用：人數給大家，細節給 [`permissions::can_see_presence_details`]）；`shared_with`（分享給誰）只給 owner / ADMIN。
/// `health`（online / degraded / offline / never，見 [`crate::monitor::Health`]）與 `last_seen_at`（離線時最後
/// 一次有連線的時間，連著時 null）不含 IP，所以給所有看得到隧道的人。
async fn list_json(state: &AppState, user_id: i64, is_superuser: bool) -> ApiResult<Vec<Value>> {
    let tunnels = db::tunnels::visible_to(&state.db, user_id).await?;
    let (my_shares, counts) = db::sharing::permission_context(&state.db, user_id).await?;
    let sharees = db::sharing::sharees_of_visible(&state.db, user_id).await?;
    let with_accounts = db::sharing::tunnels_with_allowed_usernames(&state.db, user_id).await?;
    let last = db::tunnel_endpoints::visible_to(&state.db, user_id).await?;
    let live = state.status.endpoints();
    let using = state.presence.by_tunnel();
    let seen = db::tunnel_endpoints::last_seen_visible_to(&state.db, user_id).await?;
    let pins = db::tunnel_tags::pinned_by(&state.db, user_id).await?;
    let my_groups = db::groups::tunnel_group_of(&state.db, user_id).await?;
    let my_expiries = db::sharing::my_expiries(&state.db, user_id).await?;
    let requests = db::access_requests::pending_counts(&state.db).await?;
    let labels = db::tunnel_tags::labels_visible_to(&state.db, user_id).await?;
    let listen = state.status.listen_ports().unwrap_or_default();
    let key_alerts = db::host_keys::tunnels_with_rejected(&state.db).await?;
    let claimed = state.host_keys.claimed_tunnels();
    let tz = state.config.tz_offset_minutes;
    Ok(tunnels
        .iter()
        .map(|t| {
            let eff = permissions::effective(user_id, t.user_id, my_shares.get(&t.id).map(String::as_str));
            let mut v = tunnel_json(t, eff, counts.get(&t.id).copied().unwrap_or(0), tz);
            v["endpoint"] = if permissions::can_see_endpoint(eff, with_accounts.contains(&t.id), is_superuser) {
                let port = u16::try_from(t.reverse_port).ok();
                endpoint_json(port.and_then(|p| live.get(&p)), last.get(&t.id), &state.geoip)
            } else {
                Value::Null
            };
            let entries = using.get(&t.id).map(Vec::as_slice).unwrap_or(&[]);
            v["presence"] = presence_json(entries, permissions::can_see_presence_details(eff, is_superuser), &state.geoip);
            let port = u16::try_from(t.reverse_port).ok();
            let listening = port.is_some_and(|p| listen.contains(&p));
            let failures = port.map(|p| state.status.probe_failures(p)).unwrap_or(0);
            let health = crate::monitor::health(listening, failures, listening || seen.contains_key(&t.id));
            v["health"] = json!(health.as_str());
            v["pinned"] = json!(pins.contains(&t.id));
            // 我把它放在哪個通道群組（每個人自己的）。/ My tunnel group for it (personal).
            v["group_id"] = json!(my_groups.get(&t.id));
            // 被分享的人：我的存取到什麼時候（限時分享）。/ For sharees: when my access ends (timed shares).
            v["share_expires_at"] = json!(my_expiries.get(&t.id).map(|e| crate::util::db_to_iso_utc_z(e)));
            // owner / ADMIN：還在等我決定的存取申請。/ Owner / ADMIN: access requests waiting for a decision.
            let decides = eff.is_some_and(|e| e.satisfies(permissions::Permission::Admin));
            v["access_requests"] = json!(if decides { requests.get(&t.id).copied().unwrap_or(0) } else { 0 });
            // owner / ADMIN（能管分享的人）：分享給誰，給「已分享給 N 人」的 hover；其他人 null。
            // Owner / ADMIN (who manage sharing): who it is shared with, for the "Shared with N" hover; null for everyone else.
            v["shared_with"] = if decides {
                let list = sharees.get(&t.id).map(Vec::as_slice).unwrap_or(&[]);
                json!(list.iter().map(|s| json!({ "id": s.id, "username": s.username, "permission": s.permission })).collect::<Vec<_>>())
            } else {
                Value::Null
            };
            v["labels"] = json!(labels.get(&t.id).cloned().unwrap_or_default());
            // 裝置出示了和釘選不同的 host key、正等擁有者確認。/ The device presented a different host key; waiting for review.
            v["host_key_changed"] = json!(key_alerts.contains(&t.id));
            // 這條隧道指到的機器屬於別的帳號，連線被拒。/ The machine behind this tunnel belongs to another account; refused.
            v["device_claimed"] = json!(claimed.contains(&t.id));
            v["last_seen_at"] = match (listening, seen.get(&t.id)) {
                (false, Some(at)) => json!(crate::util::db_to_iso_utc_z(at)),
                _ => Value::Null,
            };
            v
        })
        .collect())
}

async fn single_json(state: &AppState, user_id: i64, t: &Tunnel) -> ApiResult<Value> {
    let eff = permissions::effective_for(&state.db, user_id, t).await?;
    let count = db::sharing::sharee_ids(&state.db, t.id).await?.len() as i64;
    let mut v = tunnel_json(t, eff, count, state.config.tz_offset_minutes);
    // 標籤與我的釘選也給單筆（詳細資訊視窗編輯標籤用）。/ Labels and my pin, for the details dialog.
    v["labels"] = json!(db::tunnel_tags::labels_of(&state.db, t.id).await?);
    v["pinned"] = json!(db::tunnel_tags::pinned_by(&state.db, user_id).await?.contains(&t.id));
    v["group_id"] = json!(db::groups::tunnel_group_of(&state.db, user_id).await?.get(&t.id));
    // 這條隧道自己的服務金鑰（裝置要授權的那把）。/ The tunnel's own service key (the one the device authorizes).
    v["service_key"] = json!(crate::ssh::tunnel_keys::ensure(state, t.id).await?);
    Ok(v)
}

#[utoipa::path(get, path = "/api/reverse/server/dashboard", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, description = "Tunnels visible to the user plus live port status and latency", body = super::schemas::Dashboard)))]
async fn dashboard(State(state): State<AppState>, AuthUser(user): AuthUser, d: Delegated) -> ApiResult<Json<Value>> {
    Ok(Json(json!({
        "tunnels": restrict(list_json(&state, user.id, user.is_superuser).await?, &d),
        "ports": ports_json(&state).await?,
        "latency": latency_json(&state),
    })))
}

#[utoipa::path(get, path = "/api/reverse/server/keys", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, body = Vec<super::schemas::Tunnel>)))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser, d: Delegated) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Array(restrict(list_json(&state, user.id, user.is_superuser).await?, &d))))
}

/// 有隧道限制的 token 只看得到它那幾條。/ A token limited to some tunnels sees only those.
fn restrict(items: Vec<Value>, d: &Delegated) -> Vec<Value> {
    items.into_iter().filter(|t| t.get("id").and_then(Value::as_i64).is_some_and(|id| d.allows(id))).collect()
}

/// ViewSet.get_object()：只在「我看得到」的集合內找，否則 404。
async fn visible_tunnel(state: &AppState, user_id: i64, id: i64) -> ApiResult<Tunnel> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(ApiError::drf_not_found)?;
    if permissions::effective_for(&state.db, user_id, &t).await?.is_none() {
        return Err(ApiError::drf_not_found());
    }
    Ok(t)
}

fn unique_error(e: sqlx::Error) -> ApiError {
    if is_unique_violation(&e) {
        let msg = crate::error::db_error_message(&e);
        let (field, label) = if msg.contains("host_friendly_name") {
            ("host_friendly_name", "Host Friendly Name")
        } else if msg.contains("reverse_port") {
            ("reverse_port", "Reverse Port")
        } else {
            ("key", "SSH Key (public)")
        };
        ApiError::field(field, format!("reverse server key with this {label} already exists."))
    } else {
        ApiError::from(e)
    }
}

/// DRF ModelSerializer 的必填/型別檢查（create 與 PUT 用）。
fn validate_full(body: &Value) -> Result<(String, String, i64), ApiError> {
    let mut errors = serde_json::Map::new();
    let name = json_str(body, "host_friendly_name").filter(|s| !s.is_empty());
    let key = json_str(body, "key").filter(|s| !s.is_empty());
    let port = json_i64(body, "reverse_port");
    if name.is_none() {
        errors.insert("host_friendly_name".into(), json!(["This field is required."]));
    }
    if key.is_none() {
        errors.insert("key".into(), json!(["This field is required."]));
    }
    match port {
        None if body.get("reverse_port").is_none() => {
            errors.insert("reverse_port".into(), json!(["This field is required."]));
        }
        None => {
            errors.insert("reverse_port".into(), json!(["A valid integer is required."]));
        }
        Some(p) if p < 0 => {
            errors.insert("reverse_port".into(), json!(["Ensure this value is greater than or equal to 0."]));
        }
        _ => {}
    }
    if !errors.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, Value::Object(errors)));
    }
    Ok((name.unwrap(), key.unwrap(), port.unwrap()))
}

#[utoipa::path(post, path = "/api/reverse/server/keys", tag = "Reverse Server Keys", security(("bearer" = [])), request_body = super::schemas::TunnelWrite, responses((status = 201, body = super::schemas::Tunnel), (status = 400, description = "Validation error {field: [message]}", body = Object)))]
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (name, key, port) = validate_full(&body)?;
    let seed = super::device_keys::key_list_choice(&body)?;
    let description = json_str(&body, "description");
    let default_username_id = json_i64(&body, "default_username");
    let t = db::tunnels::create(
        &state.db,
        NewTunnel {
            user_id: user.id,
            host_friendly_name: &name,
            key: &key,
            reverse_port: port,
            description: description.as_deref(),
            default_username_id,
        },
    )
    .await
    .map_err(unique_error)?;
    if seed {
        super::device_keys::seed_key_list(&state, t.id, user.id).await?;
    }
    notify::tunnel_updated(&state, &t).await?;
    Ok((StatusCode::CREATED, Json(single_json(&state, user.id, &t).await?)))
}

#[utoipa::path(get, path = "/api/reverse/server/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::Tunnel), (status = 404, body = super::schemas::ErrorBody)))]
async fn retrieve(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(&state, user.id, id).await?;
    let mut v = single_json(&state, user.id, &t).await?;
    // 裝置的位址與基本狀況（詳細資訊視窗的「裝置」段落）；看得到的人同列表。/ Addresses and facts, same viewers as the list.
    v["endpoint"] = endpoint_for(&state, user.id, user.is_superuser, &t).await?;
    Ok(Json(v))
}

/// 一條隧道的 `endpoint`（同列表，只給 [`permissions::can_see_endpoint`] 允許的人，否則 null）。
/// One tunnel's `endpoint`, as on the list; null for viewers `can_see_endpoint` refuses.
async fn endpoint_for(state: &AppState, user_id: i64, is_superuser: bool, t: &Tunnel) -> ApiResult<Value> {
    let eff = permissions::effective_for(&state.db, user_id, t).await?;
    let with_accounts = db::sharing::tunnels_with_allowed_usernames(&state.db, user_id).await?.contains(&t.id);
    if !permissions::can_see_endpoint(eff, with_accounts, is_superuser) {
        return Ok(Value::Null);
    }
    let last = db::tunnel_endpoints::of_tunnel(&state.db, t.id).await?;
    let live = u16::try_from(t.reverse_port).ok().and_then(|p| state.status.endpoints().get(&p).cloned());
    Ok(endpoint_json(live.as_ref(), last.as_ref(), &state.geoip))
}

async fn apply_update(state: &AppState, user_id: i64, id: i64, body: Value, partial: bool) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(state, user_id, id).await?;
    if !partial {
        validate_full(&body)?;
    }
    if !permissions::check_access(&state.db, user_id, &t, Permission::Edit).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to edit this tunnel."));
    }
    let name = json_str(&body, "host_friendly_name");
    let key = json_str(&body, "key");
    let port = json_i64(&body, "reverse_port");
    let description = body.get("description").map(|v| v.as_str().map(str::to_string));
    let default_username = body.get("default_username").map(|v| v.as_i64());
    let updated = db::tunnels::update(
        &state.db,
        id,
        TunnelPatch {
            host_friendly_name: name.as_deref(),
            key: key.as_deref(),
            reverse_port: port,
            description: description.as_ref().map(|d| d.as_deref()),
            default_username_id: default_username,
        },
    )
    .await
    .map_err(unique_error)?;
    notify::tunnel_updated(state, &updated).await?;
    Ok(Json(single_json(state, user_id, &updated).await?))
}

#[utoipa::path(put, path = "/api/reverse/server/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::TunnelWrite, responses((status = 200, body = super::schemas::Tunnel), (status = 403, description = "Needs EDIT permission", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    apply_update(&state, user.id, id, body, false).await
}

#[utoipa::path(patch, path = "/api/reverse/server/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::TunnelPatch, responses((status = 200, body = super::schemas::Tunnel), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn partial_update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    apply_update(&state, user.id, id, body, true).await
}

/// 碰得到這條隧道的有效 grant。不限隧道的只算看得到這條隧道的人的（其他人的授權本來就碰不到它）。
/// Active grants that reach the tunnel; unrestricted ones only for people who can see it.
async fn affected_grants(state: &AppState, t: &Tunnel, audience: &[i64]) -> ApiResult<Vec<(db::oauth::GrantOverview, crate::oauth::Coverage)>> {
    Ok(db::oauth::active_grant_overview(&state.db)
        .await?
        .into_iter()
        .filter_map(|g| {
            let coverage = crate::oauth::coverage(g.tunnel_id_list().as_deref(), t.id)?;
            (coverage != crate::oauth::Coverage::All || audience.contains(&g.user_id)).then_some((g, coverage))
        })
        .collect())
}

/// 刪除前的檢查與刪除本身都要 owner / ADMIN。/ Both the check and the delete need owner / ADMIN.
async fn deletable_tunnel(state: &AppState, user_id: i64, id: i64) -> ApiResult<Tunnel> {
    let t = visible_tunnel(state, user_id, id).await?;
    if !permissions::check_share_access(&state.db, user_id, &t).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to delete this tunnel."));
    }
    Ok(t)
}

/// 刪隧道前給使用者看的清單：誰會失去存取、裝置上 Telepy 裝過哪些金鑰、哪些 MCP 授權 / AI session 受影響。
/// 只讀 DB 與記憶體狀態（不連裝置），所以開對話框很快。
/// What deleting the tunnel touches: people, keys Telepy installed on the device, MCP grants and AI sessions.
/// DB and in-memory state only (no device round-trip), so the dialog opens fast.
#[utoipa::path(get, path = "/api/reverse/server/{id}/delete-check", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "What a delete would affect", body = super::schemas::TunnelDeleteCheck), (status = 403, description = "Needs ADMIN / owner", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn delete_check(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = deletable_tunnel(&state, user.id, id).await?;
    let accounts: Vec<String> = db::tunnels::usernames_for_tunnel(&state.db, t.id).await?.into_iter().map(|u| u.username).collect();
    let sharees = db::sharing::for_tunnel(&state.db, t.id).await?;
    let audience = notify::tunnel_audience(&state, &t).await?;
    let using = state.presence.for_tunnel(t.id);
    let lan_hosts = db::lan::hosts_for_tunnel(&state.db, t.id).await?.len();
    let keys = crate::device_keys::installed_summary(&state.db, t.id).await?;
    let grants: Vec<Value> = affected_grants(&state, &t, &audience)
        .await?
        .into_iter()
        .map(|(g, coverage)| {
            let mine = g.user_id == user.id;
            json!({
                "id": g.id,
                "client_name": g.client_name,
                "user": { "id": g.user_id, "username": g.username },
                "mine": mine,
                "coverage": coverage.as_str(),
                "other_tunnels": match coverage {
                    crate::oauth::Coverage::Shared(n) => n,
                    _ => 0,
                },
                "can_revoke": crate::oauth::may_revoke_whole(mine, user.is_superuser, coverage),
            })
        })
        .collect();
    let tz = state.config.tz_offset_minutes;
    let sessions: Vec<Value> = state.ai.list().iter().filter(|s| s.tunnel_id == t.id).map(|s| super::ai::session_json(s, tz)).collect();
    // 同一台機器上的其他隧道（釘選了同一把 host key）：是最後一條時，刪除對話框預設一併移除服務金鑰，
    // 否則機器留在 Telepy 裡卻沒有主人，誰指一條隧道過去都能用那把金鑰登入。
    // Other tunnels on the same machine (same pinned host key): when this is the last one, the dialog defaults to
    // removing the service key too — otherwise the machine stays reachable with Telepy's key and has no owner.
    let on_machine = db::host_keys::same_machine(&state.db, t.id).await?;
    let mut same_machine = Vec::new();
    for c in &on_machine {
        if let Some(other) = db::tunnels::by_id(&state.db, c.tunnel_id).await? {
            if permissions::effective_for(&state.db, user.id, &other).await?.is_some() {
                same_machine.push(json!({ "id": other.id, "name": other.host_friendly_name }));
            }
        }
    }
    Ok(Json(json!({
        "tunnel": { "id": t.id, "name": t.host_friendly_name, "reverse_port": t.reverse_port },
        "online": crate::device_keys::online(&state, t.reverse_port),
        "last_on_machine": on_machine.is_empty(),
        "same_machine": same_machine,
        "accounts": accounts,
        "sharees": sharees.iter().map(|s| json!({ "id": s.shared_with_id, "username": s.username, "permission": s.permission_type })).collect::<Vec<_>>(),
        "in_use": crate::presence::distinct_users(&using),
        "lan_hosts": lan_hosts,
        "device_keys": keys,
        "grants": grants,
        "ai_sessions": sessions,
    })))
}

/// 刪除選項（query string）；沒帶 = 舊行為：移除 Telepy 裝過的金鑰、保留服務金鑰、不撤銷授權。
/// Delete options; omitted = the old behaviour (remove installed keys, keep the service key, keep grants).
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct DeleteOptions {
    remove_device_keys: Option<bool>,
    remove_service_key: Option<bool>,
    revoke_grants: Option<bool>,
    /// 逗號分隔的 grant id：整個撤銷（不只拿掉這條隧道）。/ Comma-separated grant ids to revoke entirely.
    revoke_grant_ids: Option<String>,
    /// 也把裝置上跑這條隧道的服務移除（每種安裝方式都試）。/ Also remove the tunnel's service from the device.
    remove_service: Option<bool>,
}

#[utoipa::path(delete, path = "/api/reverse/server/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(
    ("id" = i64, Path, description = "Tunnel id"),
    ("remove_device_keys" = Option<bool>, Query, description = "Remove the keys Telepy installed on the device (default true; needs the device online)"),
    ("remove_service_key" = Option<bool>, Query, description = "Also remove Telepy's service key from every login account of the tunnel (default false; needs the device online)"),
    ("revoke_grants" = Option<bool>, Query, description = "Revoke the MCP authorizations restricted to this tunnel alone (default false; the tunnel is always dropped from restricted authorizations)"),
    ("revoke_grant_ids" = Option<String>, Query, description = "Comma-separated grant ids from the delete check to revoke entirely; only those with can_revoke (your own, admins, or limited to this tunnel) are honoured"),
    ("remove_service" = Option<bool>, Query, description = "Also remove what runs the tunnel on the device (one-command install, systemd, launchd, cron / background loop, Docker, ssh / autossh scripts, Windows tasks / services / loops) with its files and logs; every login account is tried, root first (default false; needs the device online)"),
), responses((status = 200, description = "Deleted (usernames, shares, LAN hosts cascade; AI sessions closed; the device is disconnected). Body = what was cleaned up", body = super::schemas::TunnelDeleteReport), (status = 403, description = "Needs ADMIN / owner", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, Query(opts): Query<DeleteOptions>) -> ApiResult<Json<Value>> {
    let t = deletable_tunnel(&state, user.id, id).await?;
    let audience = notify::tunnel_audience(&state, &t).await?;
    let accounts: Vec<String> = db::tunnels::usernames_for_tunnel(&state.db, t.id).await?.into_iter().map(|u| u.username).collect();
    // 要整個撤銷的 grant：只接受碰得到這條隧道、而且這個人可以撤銷的。/ Only grants that reach the tunnel and may be revoked.
    let requested: std::collections::HashSet<i64> = opts.revoke_grant_ids.as_deref().unwrap_or("").split(',').filter_map(|v| v.trim().parse().ok()).collect();
    let revoke: std::collections::HashSet<i64> = affected_grants(&state, &t, &audience)
        .await?
        .into_iter()
        .filter(|(g, c)| requested.contains(&g.id) && crate::oauth::may_revoke_whole(g.user_id == user.id, user.is_superuser, *c))
        .map(|(g, _)| g.id)
        .collect();
    // 裝置上的金鑰要趁隧道還連著時清（之後裝置就被踢掉了）。/ Clean the device while the tunnel is still up.
    let cleanup_opts = crate::device_keys::CleanupOptions {
        device_keys: opts.remove_device_keys.unwrap_or(true),
        service_key: opts.remove_service_key.unwrap_or(false),
    };
    // 裝置上的服務：先找出並刪檔（連線留著，等一下服務金鑰可能被移掉），金鑰清完再停它、看它有沒有真的停。
    // The device service: files first (keeping the sessions, the service key may go next), stop it after the keys.
    let service_prep = if opts.remove_service.unwrap_or(false) && crate::device_keys::online(&state, t.reverse_port) {
        Some(crate::tunnel_service::prepare(&state, &t, &accounts).await)
    } else {
        None
    };
    let cleanup = crate::device_keys::forget_tunnel(&state, &t, cleanup_opts, &accounts).await;
    let service = match service_prep {
        Some(p) => Some(crate::tunnel_service::finish(&state, &t, p).await),
        None => None,
    };
    let ai_closed = crate::ai::close_for_tunnel(&state, t.id, crate::ai::CloseReason::TunnelDeleted).await;
    // 錄影檔先刪（列跟著隧道刪）。/ Recording files first (their rows go with the tunnel).
    crate::recording::forget_tunnel(&state, id).await;
    db::tunnels::delete(&state.db, id).await?;
    // webhook 的限定清單裡也拿掉。/ Out of every webhook's tunnel list too.
    db::webhooks::forget_tunnel(&state.db, id).await?;
    state.webhooks.invalidate();
    // 個人 API token 的隧道清單裡也拿掉。/ Out of every API token's tunnel list too.
    db::api_tokens::detach_tunnel(&state.db, id).await?;
    state.api_tokens.invalidate();
    crate::ssh::tunnel_keys::forget(&state, id).await;
    // 釘選的 host key 跟著隧道刪了：這台機器從此沒有主人，快取與被拒的認領也清掉。
    // The pinned host keys went with the tunnel (the machine is unowned now); drop the cache and any refused claim.
    state.host_keys.invalidate(id);
    let (revoked, detached) = super::oauth::detach_tunnel(&state, t.id, opts.revoke_grants.unwrap_or(false), &revoke).await?;
    let disconnected = state.gateway.disconnect_tunnel(t.id).await;
    tracing::info!(tunnel = t.id, name = %t.host_friendly_name, keys_left = cleanup.keys_left, revoked, detached, ai_closed, disconnected, "tunnel deleted");
    state.hub.notify_users(
        audience,
        &json!({
            "action": "UPDATED-TUNNELS",
            "details": format!("Tunnel '{}' has been updated", t.host_friendly_name),
            "tunnel_id": t.id,
        }),
    );
    Ok(Json(json!({
        "deleted": true,
        "online": cleanup.online,
        "accounts": cleanup.accounts,
        "keys_left": cleanup.keys_left,
        "grants_revoked": revoked,
        "grants_detached": detached,
        "ai_sessions_closed": ai_closed,
        "device_disconnected": disconnected > 0,
        "service": service,
    })))
}

/// `ReverseServerUsernamesMapServerId`：`{"usernames": [...], "default_username_id": ...}`
#[utoipa::path(get, path = "/api/reverse/server/{id}/usernames", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "Target usernames the caller may use on this tunnel", body = super::schemas::UsernamesForServer), (status = 404, body = super::schemas::ErrorBody)))]
async fn usernames_for_server(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let not_found = || ApiError::not_found("Server not found");
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(not_found)?;
    let Some(eff) = permissions::effective_for(&state.db, user.id, &t).await? else { return Err(not_found()) };
    let usernames = permissions::allowed_usernames(&state.db, user.id, &t).await?;
    let ids: Vec<i64> = usernames.iter().map(|u| u.id).collect();
    let default_id = t.default_username_id.filter(|d| ids.contains(d));
    // 管理的人（owner / ADMIN）才看得到每個帳號分給了幾位 sharee、有幾位 ADMIN（他們不用清單、每個帳號都能用）。
    // Only managers (owner / ADMIN) see how many sharees hold each account and how many ADMIN sharees there are.
    let manager = eff.satisfies(Permission::Admin);
    let counts = if manager { db::sharing::allowed_counts(&state.db, t.id).await? } else { Default::default() };
    let admins = if manager { Some(db::sharing::admin_sharee_ids(&state.db, t.id).await?.len()) } else { None };
    Ok(Json(json!({
        "usernames": usernames.iter().map(|u| json!({
            "id": u.id,
            "username": u.username,
            "created_by": u.created_by,
            "created_by_id": u.user_id,
            "shared_with": manager.then(|| counts.get(&u.id).copied().unwrap_or(0)),
        })).collect::<Vec<_>>(),
        "default_username_id": default_id,
        "admin_sharees": admins,
        "can_manage": manager,
    })))
}

/// `SetDefaultUsernameView`
#[utoipa::path(patch, path = "/api/reverse/server/{id}/default-username", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::DefaultUsernameRequest, responses((status = 200, body = super::schemas::DefaultUsernameResponse), (status = 400, body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_default_username(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &t, Permission::Edit).await? {
        return Err(ApiError::forbidden("You do not have permission to update this tunnel"));
    }
    let details = format!("Default username updated for tunnel '{}'", t.host_friendly_name);
    match json_i64(&body, "default_username_id") {
        None => {
            db::tunnels::set_default_username(&state.db, id, None).await?;
            let t = db::tunnels::by_id(&state.db, id).await?.unwrap_or(t);
            notify::tunnel_updated(&state, &t).await?;
            notify::tunnel_users(&state, &t, "TUNNEL-USERNAMES-UPDATED", &details).await?;
            Ok(Json(json!({ "message": "Default username cleared" })))
        }
        Some(uid) => {
            let u = db::tunnels::username_by_id(&state.db, uid).await?.filter(|u| u.reverse_server_id == id);
            let Some(u) = u else {
                return Err(ApiError::bad_request("Username not found for this tunnel"));
            };
            db::tunnels::set_default_username(&state.db, id, Some(u.id)).await?;
            let t = db::tunnels::by_id(&state.db, id).await?.unwrap_or(t);
            notify::tunnel_updated(&state, &t).await?;
            notify::tunnel_users(&state, &t, "TUNNEL-USERNAMES-UPDATED", &details).await?;
            Ok(Json(json!({
                "message": format!("Default username set to {}", u.username),
                "default_username_id": u.id,
            })))
        }
    }
}

#[utoipa::path(get, path = "/api/reverse/service/keys", tag = "Service Keys", security(("bearer" = [])), responses((status = 200, description = "Public keys devices must authorize (the backend's own key)", body = Vec<super::schemas::ServiceKey>)))]
async fn service_keys(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    let keys = db::keys::service_keys(&state.db).await?;
    Ok(Json(Value::Array(
        keys.iter()
            .map(|k| json!({ "id": k.id, "service": k.service, "key": k.key, "description": k.description }))
            .collect(),
    )))
}

// ---------------------------------------------------------------- pins / labels

/// 釘選是每個人自己的：看得到這條隧道就能釘。/ Pins are per user: anyone who can see the tunnel may pin it.
#[utoipa::path(put, path = "/api/reverse/server/{id}/pin", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "{\"pinned\": true}", body = super::schemas::PinState), (status = 404, body = super::schemas::ErrorBody)))]
async fn pin(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(&state, user.id, id).await?;
    db::tunnel_tags::set_pin(&state.db, user.id, t.id, true).await?;
    Ok(Json(json!({ "pinned": true })))
}

#[utoipa::path(delete, path = "/api/reverse/server/{id}/pin", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "{\"pinned\": false}", body = super::schemas::PinState), (status = 404, body = super::schemas::ErrorBody)))]
async fn unpin(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(&state, user.id, id).await?;
    db::tunnel_tags::set_pin(&state.db, user.id, t.id, false).await?;
    Ok(Json(json!({ "pinned": false })))
}

/// 標籤整組換掉；所有看得到隧道的人共用，所以要 EDIT 以上（owner / EDIT / ADMIN），改完通知大家重抓。
/// Replace the labels. They are shared, so EDIT and up only; the tunnel audience is told to refetch.
#[utoipa::path(put, path = "/api/reverse/server/{id}/labels", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::LabelsRequest, responses((status = 200, body = super::schemas::LabelsRequest), (status = 400, description = "{\"labels\": [message]}", body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_labels(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(&state, user.id, id).await?;
    if !permissions::check_access(&state.db, user.id, &t, Permission::Edit).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "You don't have permission to edit this tunnel."));
    }
    let Some(raw) = body.get("labels").and_then(Value::as_array) else {
        return Err(ApiError::field("labels", "Expected a list of labels."));
    };
    let input: Vec<String> = raw.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    if input.len() != raw.len() {
        return Err(ApiError::field("labels", "Labels must be strings."));
    }
    let labels = db::tunnel_tags::normalize_labels(&input).map_err(|m| ApiError::field("labels", m))?;
    db::tunnel_tags::replace_labels(&state.db, t.id, &labels).await?;
    notify::tunnel_updated(&state, &t).await?;
    Ok(Json(json!({ "labels": labels })))
}

// ---------------------------------------------------------------- connection history

/// 連線紀錄與在線率（看得到隧道就能看）。IP 依 [`permissions::can_see_endpoint`]：能登入裝置的人才有，其他人是 null。
/// Connection history and uptime for anyone who can see the tunnel; IPs follow `can_see_endpoint`.
#[utoipa::path(get, path = "/api/reverse/server/{id}/connections", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::TunnelConnections), (status = 404, body = super::schemas::ErrorBody)))]
async fn connections(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(&state, user.id, id).await?;
    let eff = permissions::effective_for(&state.db, user.id, &t).await?;
    let with_accounts = db::sharing::tunnels_with_allowed_usernames(&state.db, user.id).await?.contains(&t.id);
    let show_ip = permissions::can_see_endpoint(eff, with_accounts, user.is_superuser);
    let summary = db::tunnel_sessions::summary(&state.db, t.id).await?;
    let now = chrono::Utc::now().timestamp();
    let sessions: Vec<Value> = db::tunnel_sessions::recent(&state.db, t.id, 20)
        .await?
        .into_iter()
        .map(|r| {
            let start = db::tunnel_sessions::unix(&r.connected_at);
            let end = r.disconnected_at.as_deref().and_then(db::tunnel_sessions::unix).unwrap_or(now);
            json!({
                "ip": if show_ip { Value::String(r.ip) } else { Value::Null },
                "connected_at": crate::util::db_to_iso_utc_z(&r.connected_at),
                "disconnected_at": r.disconnected_at.as_deref().map(crate::util::db_to_iso_utc_z),
                "seconds": start.map(|s| (end - s).max(0)),
            })
        })
        .collect();
    Ok(Json(json!({
        "tracked_since": summary.tracked_since.as_deref().map(crate::util::db_to_iso_utc_z),
        "uptime": { "h24": summary.h24, "d7": summary.d7 },
        "hourly": summary.hourly,
        "sessions": sessions,
    })))
}

// ---------------------------------------------------------------- device facts

fn probe_error(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// 「立即重新整理」裝置的位址與基本狀況：跟每天那次同一個唯讀腳本，走連線池。owner / ADMIN；每條隧道每分鐘一次。
/// Refresh the device's addresses and facts now: the daily read-only script over the pooled connection.
/// Owner / ADMIN; once a minute per tunnel.
#[utoipa::path(post, path = "/api/reverse/server/{id}/probe", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, description = "The fresh endpoint (probe_error set when the device could not be asked)", body = super::schemas::TunnelEndpoint), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "code = device_offline", body = super::schemas::ProbeError), (status = 429, description = "code = too_soon; retry_after = seconds", body = super::schemas::ProbeError)))]
async fn probe_now(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let t = visible_tunnel(&state, user.id, id).await?;
    if !permissions::check_access(&state.db, user.id, &t, Permission::Admin).await? {
        return Err(ApiError::detail(StatusCode::FORBIDDEN, "Only the owner or an ADMIN sharee can refresh the device facts."));
    }
    let port = u16::try_from(t.reverse_port).map_err(|_| ApiError::internal("bad reverse port"))?;
    let Some(live) = state.status.endpoints().get(&port).cloned() else {
        return Err(probe_error(StatusCode::CONFLICT, "device_offline", format!("The device '{}' is offline.", t.host_friendly_name)));
    };
    if let Err(wait) = state.device_info.begin_refresh(t.id, std::time::Instant::now()) {
        let mut e = probe_error(StatusCode::TOO_MANY_REQUESTS, "too_soon", format!("Refreshed less than a minute ago; try again in {wait} s."));
        e.body["retry_after"] = json!(wait);
        return Err(e);
    }
    let peer_public = live.ip.parse::<std::net::IpAddr>().is_ok_and(|ip| crate::geoip::scope(ip) == crate::geoip::Scope::Public);
    crate::device_info::refresh(&state, &t, port, peer_public).await;
    Ok(Json(endpoint_for(&state, user.id, user.is_superuser, &t).await?))
}
