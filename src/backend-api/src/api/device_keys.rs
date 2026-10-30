//! 裝置金鑰清單的 REST 端點（模型見 `device_keys` 模組）。
//! - `GET    /api/reverse/server/{id}/device-keys`：這台裝置的清單、每把金鑰裝在哪些帳號、同步狀態
//! - `POST   /api/reverse/server/{id}/device-keys`：把「自己的」金鑰加進清單（任何有存取權的人；`accounts` = 只裝到這些帳號）
//! - `PATCH  /api/reverse/server/{id}/device-keys/{key_id}`：改這把金鑰只裝到哪些帳號（`{accounts: ids | null}`）
//! - `DELETE /api/reverse/server/{id}/device-keys/{key_id}`：移出清單（金鑰擁有者；擁有者 / ADMIN 可移任何人的）
//! - `POST   /api/reverse/server/{id}/device-keys/sync`：立刻同步（重讀每個帳號的 authorized_keys）
//! - `GET    /api/reverse/server/{id}/authorized-keys`：稽核——實際讀裝置每個帳號的 authorized_keys（擁有者 / ADMIN）
//! - `POST   /api/reverse/server/{id}/authorized-keys/remove`：從某帳號移除清單外的金鑰（一把或一批；擁有者 / ADMIN；回 `removal_id`）
//! - `POST   /api/reverse/server/{id}/authorized-keys/restore/{removal_id}`：把移掉的行接回去（7 天內；擁有者 / ADMIN）
//! - `GET    /api/reverse/server/{id}/authorized-keys/removals`：最近的移除（擁有者 / ADMIN）
//! - `GET    /api/reverse/user/keys/devices`：金鑰頁的矩陣——我的金鑰 × 我能用的裝置（依裝置名稱排序）
//!
//! REST endpoints for per-device key lists, the live authorized_keys audit, removal undo and the keys-page matrix.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, device_keys::Installed, device_keys::SyncStatus, tunnels::Tunnel};
use crate::device_keys::authorized_keys::{parse_authorized_keys, parse_public_key, plan_removal, remove_key_lines, restore_lines};
use crate::device_keys::view::{self, KnownKey};
use crate::device_keys::{self as dk, remote::AuthorizedKeysFile, Desired};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Effective, Permission};
use crate::state::AppState;
use crate::util::{db_to_iso, json_str, parse_db_datetime};
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(show, add))
        .routes(routes!(remove, set_accounts))
        .routes(routes!(sync_now))
        .routes(routes!(audit))
        .routes(routes!(audit_remove))
        .routes(routes!(audit_restore))
        .routes(routes!(audit_removals))
        .routes(routes!(my_devices))
}

/// 稽核讀檔的整體逾時（每個帳號一條 SSH 連線，並行）。/ Overall audit deadline.
const AUDIT_TIMEOUT: Duration = Duration::from_secs(45);
/// 「立即同步」時，這麼新的讀檔結果就不再讀一次（連按也不會一直連裝置）。
/// A read this recent is reused by "sync now" (repeated clicks don't keep dialing the device).
const FRESH: Duration = Duration::from_secs(5);

fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

/// 有存取權才看得到（否則 404，不洩漏存在與否）。/ 404 unless the caller can see the tunnel.
async fn access(state: &AppState, user_id: i64, id: i64) -> ApiResult<(Tunnel, Effective)> {
    let not_found = || ApiError::not_found("Tunnel not found or access denied");
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(not_found)?;
    let eff = permissions::effective_for(&state.db, user_id, &t).await?.ok_or_else(not_found)?;
    Ok((t, eff))
}

fn require_manager(eff: Effective) -> ApiResult<()> {
    if eff.satisfies(Permission::Admin) {
        Ok(())
    } else {
        Err(coded(StatusCode::FORBIDDEN, "not_manager", "Only the tunnel owner or an ADMIN sharee can manage this device's authorized_keys."))
    }
}

/// 一把金鑰實際用到的帳號（username id）：每一列（直接 / 各群組授予）的聯集；有一列是「全部」就是 None。
/// 群組授予用帳號名稱，對照這台裝置上的帳號換成 id。
/// The accounts a key really goes to: the union over its entries (direct and each group grant); None when any
/// of them means "all". Grants name accounts, mapped to this device's account ids.
fn union_accounts(entries: &[&db::device_keys::Entry], tunnel_accounts: &[(i64, String)]) -> Option<Vec<i64>> {
    let mut ids = BTreeSet::new();
    for e in entries {
        match (e.account_ids(), e.grant_accounts()) {
            (Some(chosen), _) => ids.extend(chosen),
            (None, Some(names)) => ids.extend(tunnel_accounts.iter().filter(|(_, n)| names.contains(n)).map(|(id, _)| *id)),
            (None, None) => return None,
        }
    }
    Some(ids.into_iter().collect())
}

/// 一把金鑰經由哪些群組來到這台裝置（JSON）。/ The group grants bringing a key to this device (JSON).
fn group_sources(entries: &[&db::device_keys::Entry]) -> Vec<Value> {
    entries
        .iter()
        .filter(|e| !e.is_direct())
        .map(|e| {
            json!({
                "id": e.via_group,
                "name": e.group_name,
                "tunnel_group": e.via_tunnel_group.map(|id| json!({ "id": id, "name": e.tunnel_group_name })),
                "accounts": e.grant_accounts(),
            })
        })
        .collect()
}

/// 依金鑰分好的列（保留第一次出現的順序：直接的在前）。/ Entries grouped per key, in first-seen order (direct first).
fn by_key(entries: &[db::device_keys::Entry]) -> Vec<(i64, Vec<&db::device_keys::Entry>)> {
    let mut out: Vec<(i64, Vec<&db::device_keys::Entry>)> = Vec::new();
    for e in entries {
        match out.iter_mut().find(|(k, _)| *k == e.user_key_id) {
            Some((_, v)) => v.push(e),
            None => out.push((e.user_key_id, vec![e])),
        }
    }
    out
}

/// 一台裝置算狀態要的資料。
struct Snapshot {
    desired: Desired,
    installed: Vec<Installed>,
    sync: HashMap<String, SyncStatus>,
}

async fn snapshot(state: &AppState, t: &Tunnel) -> ApiResult<Snapshot> {
    Ok(Snapshot {
        desired: dk::desired(&state.db, t).await?,
        installed: db::device_keys::installed_for_tunnel(&state.db, t.id).await?,
        sync: db::device_keys::sync_for_tunnel(&state.db, t.id).await?.into_iter().map(|s| (s.username.clone(), s)).collect(),
    })
}

impl Snapshot {
    /// 一把金鑰在每個（應裝的）帳號上的狀態：installed / pending / error。
    fn targets(&self, bare: &str) -> Vec<Value> {
        let installed: BTreeSet<(&str, &str)> = self.installed.iter().map(|i| (i.username.as_str(), i.key_bare.as_str())).collect();
        self.desired
            .iter()
            .filter(|(_, keys)| keys.contains_key(bare))
            .map(|(acct, _)| {
                let (status, error) = if installed.contains(&(acct.as_str(), bare)) {
                    ("installed", None)
                } else {
                    match self.sync.get(acct) {
                        Some(s) if !s.ok => ("error", s.error.clone()),
                        _ => ("pending", None),
                    }
                };
                json!({ "username": acct, "status": status, "error": error })
            })
            .collect()
    }

    /// 裝過但已不該在的（等裝置上線後移除）。
    fn removals(&self) -> Vec<&Installed> {
        self.installed.iter().filter(|i| !self.desired.get(&i.username).is_some_and(|k| k.contains_key(&i.key_bare))).collect()
    }
}

/// 面板要顯示的帳號：擁有者 / ADMIN = 隧道上的帳號 ∪ 清單會用到的 ∪ Telepy 裝過的；其他人 = 自己被允許的。
/// Accounts the panel shows: owner / ADMIN see every account involved; others only the ones they may use.
async fn visible_accounts(state: &AppState, t: &Tunnel, user_id: i64, manager: bool, desired: &Desired) -> ApiResult<Vec<String>> {
    if !manager {
        return Ok(permissions::allowed_usernames(&state.db, user_id, t).await?.into_iter().map(|u| u.username).collect());
    }
    let mut set: BTreeSet<String> = audit_accounts(state, t).await?.into_iter().collect();
    set.extend(desired.keys().cloned());
    Ok(set.into_iter().collect())
}

/// 合併檢視：清單 × Telepy 裝過的 × 最近一次讀到的檔案（`device_keys::view`）。不連裝置。
/// The merged per-account view; never dials the device.
async fn build_view(state: &AppState, t: &Tunnel, snap: &Snapshot, accounts: &[String], viewer: i64, manager: bool) -> ApiResult<Vec<view::AccountView>> {
    let desired: BTreeMap<String, BTreeSet<String>> = snap.desired.iter().map(|(a, keys)| (a.clone(), keys.keys().cloned().collect())).collect();
    let installed: Vec<(String, String, String, Option<i64>)> = snap.installed.iter().map(|i| (i.username.clone(), i.key_bare.clone(), i.fingerprint.clone(), i.user_id)).collect();
    let mut errors: HashMap<String, String> = snap.sync.values().filter(|s| !s.ok).filter_map(|s| s.error.clone().map(|e| (s.username.clone(), e))).collect();
    // 同一個 port 以前那條隧道留下的不算。/ Ignore snapshots left by an earlier tunnel on the same port.
    let since = parse_db_datetime(&t.created_at).map(|d| d.and_utc());
    let mut snapshots: HashMap<String, view::Snapshot> = HashMap::new();
    let mut file_paths: HashMap<String, String> = HashMap::new();
    for a in accounts {
        let Some(s) = state.device_keys.snapshot(t.reverse_port, a) else { continue };
        if since.is_some_and(|c| s.at < c) {
            continue;
        }
        if let Some(p) = s.path.clone() {
            file_paths.insert(a.clone(), p);
        }
        match s.error {
            Some(e) => {
                errors.entry(a.clone()).or_insert(e);
            }
            None => {
                snapshots.insert(a.clone(), (s.content, s.at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)));
            }
        }
    }
    let service: BTreeSet<String> = dk::service_bares(state, t.id).await?;
    let shared = dk::shared_bares(&state.db).await?;
    let mut known: HashMap<String, KnownKey> = HashMap::new();
    let mut users: HashMap<i64, String> = HashMap::new();
    for (id, key, name, uid, username) in db::keys::all_with_owner(&state.db).await? {
        users.insert(uid, username.clone());
        if let Some(parsed) = parse_public_key(&key) {
            known.insert(parsed.bare.clone(), KnownKey { user_key_id: id, name, owner_id: uid, owner: username, parsed });
        }
    }
    for uid in snap.installed.iter().filter_map(|i| i.user_id) {
        if let std::collections::hash_map::Entry::Vacant(slot) = users.entry(uid) {
            if let Some(u) = db::users::by_id(&state.db, uid).await? {
                slot.insert(u.username);
            }
        }
    }
    let platform = state.device_keys.cached_platform(t.reverse_port);
    let entries = db::device_keys::effective_entries_for_tunnel(&state.db, t.id).await?;
    let tunnel_accounts: Vec<(i64, String)> = db::tunnels::usernames_for_tunnel(&state.db, t.id).await?.into_iter().map(|u| (u.id, u.username)).collect();
    let mut restrictions: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut sources: HashMap<i64, view::Sources> = HashMap::new();
    for (key_id, list) in by_key(&entries) {
        if let Some(ids) = union_accounts(&list, &tunnel_accounts) {
            restrictions.insert(key_id, ids);
        }
        let groups = list.iter().filter_map(|e| e.via_group.map(|id| view::GroupRef { id, name: e.group_name.clone().unwrap_or_default() })).fold(Vec::new(), |mut acc: Vec<view::GroupRef>, g| {
            if !acc.contains(&g) {
                acc.push(g);
            }
            acc
        });
        sources.insert(key_id, view::Sources { direct: list.iter().any(|e| e.is_direct()), groups });
    }
    Ok(view::build(&view::Inputs {
        accounts,
        desired: &desired,
        installed: &installed,
        sync_errors: &errors,
        snapshots: &snapshots,
        file_paths: &file_paths,
        service: &service,
        shared: &shared,
        known: &known,
        users: &users,
        viewer,
        manager,
        platform: platform.as_ref(),
        restrictions: &restrictions,
        sources: &sources,
        disabled: &db::users::inactive_ids(&state.db).await?,
    }))
}

/// 重讀這些帳號的檔案（最近 `fresh` 內讀過的跳過），失敗的記下原因。/ Re-read accounts not read within `fresh`.
async fn refresh_snapshots(state: &AppState, t: &Tunnel, accounts: &[String], fresh: Duration) {
    let cutoff = chrono::Utc::now() - chrono::Duration::from_std(fresh).unwrap_or_default();
    let reads = accounts
        .iter()
        .filter(|a| state.device_keys.snapshot(t.reverse_port, a).is_none_or(|s| s.at < cutoff))
        .map(|acct| {
            let (state, acct, port) = (state.clone(), acct.clone(), t.reverse_port);
            async move {
                let read = async { AuthorizedKeysFile::open(&state, &acct, port, false).await?.read().await }.await;
                if let Err(e) = read {
                    state.device_keys.record_failure(port, &acct, format!("{e:#}"));
                }
            }
        });
    let _ = tokio::time::timeout(AUDIT_TIMEOUT, futures::future::join_all(reads)).await;
}

async fn device_json(state: &AppState, user_id: i64, t: &Tunnel, eff: Effective) -> ApiResult<Value> {
    let tz = state.config.tz_offset_minutes;
    let manager = eff.satisfies(Permission::Admin);
    let snap = snapshot(state, t).await?;
    let allowed = permissions::allowed_usernames(&state.db, user_id, t).await?;
    let accounts: Vec<String> = allowed.iter().map(|u| u.username.clone()).collect();
    let account_ids: Vec<Value> = allowed.iter().map(|u| json!({ "id": u.id, "username": u.username })).collect();
    // 直接在清單上的 + 金鑰群組授予來的；同一把金鑰合成一筆，`direct` / `groups` 說它從哪來。
    // Direct entries plus the ones from key group grants, one item per key; `direct` / `groups` say why it is here.
    let entries = db::device_keys::effective_entries_for_tunnel(&state.db, t.id).await?;
    let direct: Vec<&db::device_keys::Entry> = entries.iter().filter(|e| e.is_direct()).collect();
    let in_list: BTreeSet<i64> = direct.iter().filter(|e| e.user_id == user_id).map(|e| e.user_key_id).collect();
    let my_restrictions: HashMap<i64, Option<Vec<i64>>> = direct.iter().filter(|e| e.user_id == user_id).map(|e| (e.user_key_id, e.account_ids())).collect();
    let mut names: HashMap<i64, String> = HashMap::new();
    let mut entry_values = Vec::new();
    let grouped = by_key(&entries);
    for (_, list) in grouped.iter().filter(|(_, l)| manager || l[0].user_id == user_id) {
        let e = list[0];
        let direct_entry = list.iter().find(|e| e.is_direct()).copied();
        let parsed = parse_public_key(&e.key);
        if let std::collections::hash_map::Entry::Vacant(slot) = names.entry(e.added_by_id) {
            let n = db::users::by_id(&state.db, e.added_by_id).await?.map(|u| u.username).unwrap_or_default();
            slot.insert(n);
        }
        entry_values.push(json!({
            "user_key_id": e.user_key_id,
            "name": e.name,
            "fingerprint": parsed.as_ref().map(|p| p.fingerprint.clone()),
            "key_type": parsed.as_ref().map(|p| p.label),
            "owner": { "id": e.user_id, "username": e.owner_username },
            "mine": e.user_id == user_id,
            // 擁有者的帳號停用了：還在清單上，但已不在（或正在離開）裝置上。/ The owner is disabled: listed, off the device.
            "owner_disabled": !e.owner_active,
            "added_by": names[&e.added_by_id],
            "created_at": db_to_iso(&e.created_at, tz),
            "accounts": direct_entry.and_then(|d| d.account_ids()),
            "direct": direct_entry.is_some(),
            "groups": group_sources(list),
            "targets": parsed.map(|p| snap.targets(&p.bare)).unwrap_or_default(),
        }));
    }
    let my_via: HashMap<i64, Vec<Value>> = grouped.iter().filter(|(_, l)| l[0].user_id == user_id).map(|(k, l)| (*k, group_sources(l))).collect();
    let owners: HashMap<i64, String> = entries.iter().map(|e| (e.user_id, e.owner_username.clone())).collect();
    let removals: Vec<Value> = if manager {
        let mut out = Vec::new();
        for i in snap.removals() {
            let owner = match i.user_id {
                Some(uid) => match owners.get(&uid) {
                    Some(n) => Some(n.clone()),
                    None => db::users::by_id(&state.db, uid).await?.map(|u| u.username),
                },
                None => None,
            };
            let failed = snap.sync.get(&i.username).filter(|s| !s.ok);
            out.push(json!({
                "username": i.username,
                "fingerprint": i.fingerprint,
                "owner": owner,
                "status": if failed.is_some() { "error" } else { "pending" },
                "error": failed.and_then(|s| s.error.clone()),
            }));
        }
        out
    } else {
        vec![]
    };
    let sync: Vec<Value> = snap
        .sync
        .values()
        .filter(|s| manager || accounts.contains(&s.username))
        .map(|s| json!({ "username": s.username, "ok": s.ok, "error": s.error, "synced_at": db_to_iso(&s.synced_at, tz) }))
        .collect();
    let my_group_of = db::groups::key_group_of(&state.db, user_id).await?;
    let my_keys: Vec<Value> = db::keys::user_keys(&state.db, user_id)
        .await?
        .iter()
        .map(|k| {
            let p = parse_public_key(&k.key);
            json!({
                "id": k.id,
                "name": k.host_friendly_name,
                "fingerprint": p.as_ref().map(|p| p.fingerprint.clone()),
                "key_type": p.as_ref().map(|p| p.label),
                "in_list": in_list.contains(&k.id),
                "expired": k.expired(),
                "accounts": my_restrictions.get(&k.id).cloned().flatten(),
                "group_id": my_group_of.get(&k.id),
                "via_groups": my_via.get(&k.id).cloned().unwrap_or_default(),
            })
        })
        .collect();
    let my_key_groups = my_key_groups_here(state, user_id, t.id, &my_group_of).await?;
    let view_accounts = visible_accounts(state, t, user_id, manager, &snap.desired).await?;
    let view = build_view(state, t, &snap, &view_accounts, user_id, manager).await?;
    let platform = state.device_keys.cached_platform(t.reverse_port).map(|p| json!({ "windows": p.windows, "error": p.error }));
    Ok(json!({
        "tunnel": { "id": t.id, "host_friendly_name": t.host_friendly_name, "online": dk::online(state, t.reverse_port), "role": eff.label() },
        "view": { "accounts": view, "keep_shared": state.config.keep_shared_service_key },
        "platform": platform,
        "can_manage": manager,
        "accounts": accounts,
        "account_ids": account_ids,
        "entries": entry_values,
        "removals": removals,
        "sync": sync,
        "my_keys": my_keys,
        "my_key_groups": my_key_groups,
    }))
}

/// 面板的「你的金鑰群組」：每組有幾把金鑰、有沒有直接授予這台裝置、經由我的哪個通道群組授予了。
/// The panel's "your key groups": key count, a direct grant to this device, and grants through my tunnel group.
async fn my_key_groups_here(state: &AppState, user_id: i64, tunnel_id: i64, group_of: &HashMap<i64, i64>) -> ApiResult<Vec<Value>> {
    let groups = db::groups::key_groups(&state.db, user_id).await?;
    if groups.is_empty() {
        return Ok(vec![]);
    }
    let grants = db::groups::grants_of_user(&state.db, user_id).await?;
    let my_tunnel_group = db::groups::tunnel_group_of(&state.db, user_id).await?.get(&tunnel_id).copied();
    Ok(groups
        .iter()
        .map(|g| {
            let direct = grants.iter().find(|gr| gr.key_group_id == g.id && gr.tunnel_id == Some(tunnel_id));
            let via = grants.iter().find(|gr| gr.key_group_id == g.id && gr.tunnel_group_id.is_some() && gr.tunnel_group_id == my_tunnel_group);
            json!({
                "id": g.id,
                "name": g.name,
                "key_count": group_of.values().filter(|v| **v == g.id).count(),
                "grant": direct.map(|gr| json!({ "id": gr.id, "accounts": gr.account_names() })),
                "via_tunnel_group": via.map(|gr| json!({ "id": gr.tunnel_group_id, "name": gr.tunnel_group_name, "grant_id": gr.id, "accounts": gr.account_names() })),
            })
        })
        .collect())
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/device-keys", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::DeviceKeys), (status = 404, body = super::schemas::ErrorBody)))]
async fn show(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    Ok(Json(device_json(&state, me.id, &t, eff).await?))
}

/// `accounts`：沒給 / null = 每個允許的帳號；否則是這條隧道的 username id（非空、去重、排序），不是的回 400 `bad_accounts`。
/// 選到擁有者不被允許的帳號也存（只是不生效），權限放寬時就會裝上去。
/// `accounts`: absent / null = every allowed account; else username ids of this tunnel (non-empty, deduplicated,
/// sorted), 400 `bad_accounts` otherwise. Ids outside the owner's allow-list are kept (unused until access widens).
async fn chosen_accounts(state: &AppState, t: &Tunnel, body: &Value) -> ApiResult<Option<Vec<i64>>> {
    let bad = || coded(StatusCode::BAD_REQUEST, "bad_accounts", "accounts must be null or a non-empty list of this device's login account ids");
    let list = match body.get("accounts") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(a)) if !a.is_empty() => a,
        _ => return Err(bad()),
    };
    let known: BTreeSet<i64> = db::tunnels::usernames_for_tunnel(&state.db, t.id).await?.into_iter().map(|u| u.id).collect();
    let mut ids = BTreeSet::new();
    for v in list {
        let id = v.as_i64().filter(|i| known.contains(i)).ok_or_else(bad)?;
        ids.insert(id);
    }
    Ok(Some(ids.into_iter().collect()))
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/device-keys", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::DeviceKeysAdd, responses((status = 200, body = super::schemas::DeviceKeys), (status = 400, description = "Missing ids, a key that is not yours, or bad account ids (code bad_accounts)", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn add(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    let ids: Vec<i64> = match body.get("user_key_ids") {
        Some(Value::Array(a)) if !a.is_empty() => a.iter().filter_map(Value::as_i64).collect(),
        _ => return Err(coded(StatusCode::BAD_REQUEST, "user_key_ids_required", "user_key_ids must be a non-empty list of your key ids")),
    };
    for kid in &ids {
        // 只能放自己的金鑰。/ Only your own keys.
        if db::keys::user_key_by_id(&state.db, me.id, *kid).await?.is_none() {
            return Err(coded(StatusCode::BAD_REQUEST, "not_your_key", format!("Key {kid} is not one of your keys")));
        }
    }
    let accounts = chosen_accounts(&state, &t, &body).await?;
    for kid in ids {
        let added = db::device_keys::add_entry(&state.db, t.id, kid, me.id, me.id, accounts.as_deref()).await?;
        // 已在清單上又帶了 accounts：改成這次的選擇。/ Already listed and `accounts` given: take the new choice.
        if !added && body.get("accounts").is_some() {
            db::device_keys::set_entry_accounts(&state.db, t.id, kid, accounts.as_deref()).await?;
        }
    }
    state.device_keys.kick(t.id);
    Ok(Json(device_json(&state, me.id, &t, eff).await?))
}

#[utoipa::path(patch, path = "/api/reverse/server/{id}/device-keys/{key_id}", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("key_id" = i64, Path, description = "User key id")), request_body = super::schemas::DeviceKeyAccounts, responses((status = 200, body = super::schemas::DeviceKeys), (status = 400, description = "Bad account ids (code bad_accounts)", body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn set_accounts(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, key_id)): Path<(i64, i64)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    let entry = db::device_keys::entries_for_tunnel(&state.db, t.id).await?.into_iter().find(|e| e.user_key_id == key_id);
    let Some(entry) = entry else { return Err(ApiError::not_found("This key is not in the device's key list")) };
    if entry.user_id != me.id {
        require_manager(eff)?;
    }
    let accounts = chosen_accounts(&state, &t, &body).await?;
    db::device_keys::set_entry_accounts(&state.db, t.id, key_id, accounts.as_deref()).await?;
    state.device_keys.kick(t.id);
    Ok(Json(device_json(&state, me.id, &t, eff).await?))
}

#[utoipa::path(delete, path = "/api/reverse/server/{id}/device-keys/{key_id}", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("key_id" = i64, Path, description = "User key id")), responses((status = 200, body = super::schemas::DeviceKeys), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn remove(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, key_id)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    let entry = db::device_keys::entries_for_tunnel(&state.db, t.id).await?.into_iter().find(|e| e.user_key_id == key_id);
    let Some(entry) = entry else { return Err(ApiError::not_found("This key is not in the device's key list")) };
    if entry.user_id != me.id {
        require_manager(eff)?;
    }
    db::device_keys::delete_entry(&state.db, t.id, key_id).await?;
    state.device_keys.kick(t.id);
    Ok(Json(device_json(&state, me.id, &t, eff).await?))
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/device-keys/sync", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::DeviceKeys), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "Device offline (code device_offline)", body = super::schemas::ErrorBody)))]
async fn sync_now(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    match dk::sync_tunnel(&state, t.id, true).await.map_err(|e| ApiError::error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))? {
        dk::SyncOutcome::Offline => Err(coded(StatusCode::CONFLICT, "device_offline", "The device is offline; changes will be applied when it reconnects.")),
        dk::SyncOutcome::Done { .. } => {
            // 同步只碰有金鑰要處理的帳號；面板上的其他帳號也要重讀，「裝置上實際有什麼」才是現在的。
            // The sync only touches accounts with work to do; re-read the rest so the panel shows the device as it is now.
            let desired = dk::desired(&state.db, &t).await?;
            let accounts = visible_accounts(&state, &t, me.id, eff.satisfies(Permission::Admin), &desired).await?;
            refresh_snapshots(&state, &t, &accounts, FRESH).await;
            Ok(Json(device_json(&state, me.id, &t, eff).await?))
        }
    }
}

/// 稽核用：bare → (金鑰 id, 金鑰名, 擁有者)。
async fn telepy_keys(state: &AppState) -> ApiResult<HashMap<String, (i64, String, String)>> {
    Ok(db::keys::all_with_owner(&state.db)
        .await?
        .into_iter()
        .filter_map(|(id, key, name, _uid, username)| parse_public_key(&key).map(|p| (p.bare, (id, name, username))))
        .collect())
}

/// 稽核要讀的帳號：隧道上的 OS 帳號 ∪ Telepy 裝過金鑰的帳號。
async fn audit_accounts(state: &AppState, t: &Tunnel) -> ApiResult<Vec<String>> {
    let mut set: BTreeSet<String> = db::tunnels::usernames_for_tunnel(&state.db, t.id).await?.into_iter().map(|u| u.username).collect();
    set.extend(db::device_keys::installed_for_tunnel(&state.db, t.id).await?.into_iter().map(|i| i.username));
    Ok(set.into_iter().collect())
}

#[utoipa::path(get, path = "/api/reverse/server/{id}/authorized-keys", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::AuthorizedKeysAudit), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "Device offline (code device_offline)", body = super::schemas::ErrorBody)))]
async fn audit(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    require_manager(eff)?;
    if !dk::online(&state, t.reverse_port) {
        return Err(coded(StatusCode::CONFLICT, "device_offline", "The device is offline."));
    }
    let accounts = audit_accounts(&state, &t).await?;
    let service: BTreeSet<String> = dk::service_bares(&state, t.id).await?;
    let telepy = telepy_keys(&state).await?;
    let snap = snapshot(&state, &t).await?;
    let managed: BTreeSet<(String, String)> = snap.installed.iter().map(|i| (i.username.clone(), i.key_bare.clone())).collect();

    let reads = accounts.iter().map(|acct| {
        let state = state.clone();
        let acct = acct.clone();
        async move {
            let r = async {
                let f: AuthorizedKeysFile = AuthorizedKeysFile::open(&state, &acct, t.reverse_port, false).await?;
                let exists = f.exists();
                anyhow::Ok((exists, f.read().await?))
            }
            .await;
            (acct, r)
        }
    });
    let results = tokio::time::timeout(AUDIT_TIMEOUT, futures::future::join_all(reads))
        .await
        .map_err(|_| coded(StatusCode::GATEWAY_TIMEOUT, "timeout", "Timed out reading authorized_keys from the device."))?;

    let mut out = Vec::new();
    for (acct, r) in results {
        match r {
            Err(e) => out.push(json!({ "username": acct, "ok": false, "error": format!("{e:#}"), "exists": false, "lines": [] })),
            Ok((exists, content)) => {
                let lines: Vec<Value> = parse_authorized_keys(&content)
                    .into_iter()
                    .filter(|l| !l.raw.trim().is_empty() && !l.raw.trim_start().starts_with('#'))
                    .map(|l| {
                        let Some(k) = l.key else {
                            return json!({ "line_no": l.line_no, "kind": "invalid", "raw": l.raw.chars().take(120).collect::<String>() });
                        };
                        let in_list = snap.desired.get(&acct).is_some_and(|d| d.contains_key(&k.bare));
                        let (kind, owner) = if service.contains(&k.bare) {
                            ("service", None)
                        } else if managed.contains(&(acct.clone(), k.bare.clone())) {
                            ("managed", telepy.get(&k.bare))
                        } else if let Some(o) = telepy.get(&k.bare) {
                            ("telepy_user", Some(o))
                        } else {
                            ("unknown", None)
                        };
                        json!({
                            "line_no": l.line_no,
                            "kind": kind,
                            "key_type": k.label,
                            "bits": k.bits,
                            "fingerprint": k.fingerprint,
                            "comment": if k.comment.is_empty() { None } else { Some(k.comment) },
                            "options": l.options,
                            "in_list": in_list,
                            "owner": owner.map(|(_, _, u)| u.clone()),
                            "key_name": owner.map(|(_, n, _)| n.clone()),
                        })
                    })
                    .collect();
                out.push(json!({ "username": acct, "ok": true, "error": null, "exists": exists, "lines": lines }));
            }
        }
    }
    Ok(Json(json!({ "tunnel_id": t.id, "accounts": out })))
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/authorized-keys/remove", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::AuthorizedKeyRemove, responses((status = 200, body = super::schemas::AuthorizedKeyRemoved), (status = 400, description = "Service key (code service_key) or bad request", body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "In the device key list (code in_key_list) or device offline (code device_offline)", body = super::schemas::ErrorBody)))]
async fn audit_remove(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    require_manager(eff)?;
    // `fingerprint`：一把（找不到 / 不能移時回錯誤）；`fingerprints`：一次多把，不能移的列在 `skipped`。
    // One key (errors as before) or a batch (`fingerprints`; what can't be removed is listed in `skipped`).
    let batch = body.get("fingerprints").is_some();
    let fps = if batch { batch_fingerprints(&body)? } else { json_str(&body, "fingerprint").into_iter().collect() };
    let (Some(acct), false) = (json_str(&body, "username"), fps.is_empty()) else {
        return Err(coded(StatusCode::BAD_REQUEST, "bad_request", "username and fingerprint are required"));
    };
    if !audit_accounts(&state, &t).await?.contains(&acct) {
        return Err(ApiError::not_found("Unknown account for this tunnel"));
    }
    if !dk::online(&state, t.reverse_port) {
        return Err(coded(StatusCode::CONFLICT, "device_offline", "The device is offline."));
    }
    let lock = state.device_keys.lock_for(t.id);
    let _guard = lock.lock().await;
    let file = AuthorizedKeysFile::open(&state, &acct, t.reverse_port, false).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, "device_error", format!("{e:#}")))?;
    let content = file.read().await.map_err(|e| coded(StatusCode::BAD_GATEWAY, "device_error", format!("{e:#}")))?;
    // 共用的舊服務金鑰：這台機器上每條隧道都用自己的金鑰登入過這個帳號，就可以手動移掉；隧道自己的金鑰永遠保護。
    // The legacy shared key may be removed by hand once every tunnel on the machine verified its own key there.
    let mut service: BTreeSet<String> = dk::service_bares(&state, t.id).await?;
    if crate::ssh::tunnel_keys::shared_removable(&state, t.id, &acct).await? {
        for b in dk::shared_bares(&state.db).await? {
            service.remove(&b);
        }
    }
    let desired: BTreeMap<String, _> = dk::desired(&state.db, &t).await?;
    let listed: BTreeSet<String> = desired.get(&acct).map(|d| d.keys().cloned().collect()).unwrap_or_default();
    let plan = plan_removal(&content, &fps, &service, &listed);
    if !batch {
        match plan.skipped.first().map(|(_, code)| *code) {
            Some("not_found") => return Err(ApiError::not_found("That key is not in this account's authorized_keys")),
            Some("service_key") => return Err(coded(StatusCode::BAD_REQUEST, "service_key", "This is Telepy's service key; removing it would cut Telepy off from this account.")),
            Some(_) => return Err(coded(StatusCode::CONFLICT, "in_key_list", "This key is in the device's key list; remove it from the list instead.")),
            None => {}
        }
    }
    let mut removed = 0;
    let mut removal_id = None;
    if !plan.remove.is_empty() {
        let (new, lines) = remove_key_lines(&content, &plan.remove);
        file.write(&new).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, "device_error", format!("{e:#}")))?;
        for bare in &plan.remove {
            db::device_keys::installed_delete(&state.db, t.id, &acct, bare).await?;
        }
        removed = lines.len();
        // 記下移掉的行，7 天內可還原。/ Keep the removed lines so the removal can be undone for 7 days.
        removal_id = Some(db::device_keys::removal_insert(&state.db, t.id, &acct, &lines, plan.remove.len(), me.id, &me.username).await?);
        tracing::info!(tunnel_id = t.id, account = %acct, keys = plan.remove.len(), lines = removed, by = %me.username, "device keys: removed keys from authorized_keys");
        let audience = super::notify::tunnel_audience(&state, &t).await?;
        state.hub.notify_users(audience, &json!({ "action": "DEVICE-KEYS-UPDATED", "tunnel_id": t.id }));
    }
    let skipped: Vec<Value> = plan.skipped.iter().map(|(fp, code)| json!({ "fingerprint": fp, "code": code })).collect();
    Ok(Json(json!({ "removed": removed, "keys": plan.remove.len(), "skipped": skipped, "removal_id": removal_id })))
}

fn removal_json(r: &db::device_keys::Removal, tz: i32) -> Value {
    json!({
        "id": r.id,
        "username": r.username,
        "keys": r.keys,
        "lines": r.raw_lines().len(),
        "removed_by": r.removed_by,
        "removed_at": db_to_iso(&r.removed_at, tz),
        "restored_at": r.restored_at.as_deref().map(|at| db_to_iso(at, tz)),
    })
}

/// 面板的「最近的移除」最多列這麼多筆。/ How many recent removals the panel lists.
const REMOVALS_LIMIT: i64 = 50;

#[utoipa::path(get, path = "/api/reverse/server/{id}/authorized-keys/removals", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::AuthorizedKeyRemovals), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn audit_removals(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    require_manager(eff)?;
    let tz = state.config.tz_offset_minutes;
    let rows = db::device_keys::removals_for_tunnel(&state.db, t.id, REMOVALS_LIMIT).await?;
    Ok(Json(json!({ "tunnel_id": t.id, "retention_days": db::device_keys::REMOVAL_RETENTION_DAYS, "removals": rows.iter().map(|r| removal_json(r, tz)).collect::<Vec<_>>() })))
}

#[utoipa::path(post, path = "/api/reverse/server/{id}/authorized-keys/restore/{removal_id}", tag = "Device Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("removal_id" = i64, Path, description = "Removal record id (from the remove response or the removals list)")), responses((status = 200, body = super::schemas::AuthorizedKeyRestored), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "Device offline (code device_offline)", body = super::schemas::ErrorBody)))]
async fn audit_restore(State(state): State<AppState>, AuthUser(me): AuthUser, Path((id, removal_id)): Path<(i64, i64)>) -> ApiResult<Json<Value>> {
    let (t, eff) = access(&state, me.id, id).await?;
    require_manager(eff)?;
    let Some(record) = db::device_keys::removal_by_id(&state.db, t.id, removal_id).await? else {
        return Err(ApiError::not_found("No such removal (records are kept for 7 days)"));
    };
    if !dk::online(&state, t.reverse_port) {
        return Err(coded(StatusCode::CONFLICT, "device_offline", "The device is offline."));
    }
    let lock = state.device_keys.lock_for(t.id);
    let _guard = lock.lock().await;
    let file = AuthorizedKeysFile::open(&state, &record.username, t.reverse_port, true).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, "device_error", format!("{e:#}")))?;
    let content = file.read().await.map_err(|e| coded(StatusCode::BAD_GATEWAY, "device_error", format!("{e:#}")))?;
    let r = restore_lines(&content, &record.raw_lines());
    if let Some(new) = &r.content {
        file.write(new).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, "device_error", format!("{e:#}")))?;
        tracing::info!(tunnel_id = t.id, account = %record.username, lines = r.restored, by = %me.username, "device keys: restored removed lines to authorized_keys");
        let audience = super::notify::tunnel_audience(&state, &t).await?;
        state.hub.notify_users(audience, &json!({ "action": "DEVICE-KEYS-UPDATED", "tunnel_id": t.id }));
    }
    db::device_keys::removal_mark_restored(&state.db, record.id).await?;
    Ok(Json(json!({ "restored": r.restored, "skipped": r.skipped, "username": record.username })))
}

/// 一次最多移除幾把（1 MiB 的檔案大約一萬把 Ed25519）。/ Batch cap (a 1 MiB file holds about 10k Ed25519 keys).
const MAX_BATCH: usize = 10_000;

/// `fingerprints`：非空、全是字串、不超過 `MAX_BATCH`；重複的只留一個（保留順序）。
fn batch_fingerprints(body: &Value) -> ApiResult<Vec<String>> {
    let bad = || coded(StatusCode::BAD_REQUEST, "bad_request", format!("fingerprints must be a list of 1 to {MAX_BATCH} fingerprints"));
    let list = body.get("fingerprints").and_then(Value::as_array).filter(|l| !l.is_empty() && l.len() <= MAX_BATCH).ok_or_else(bad)?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(list.len());
    for v in list {
        let fp = v.as_str().filter(|s| !s.is_empty()).ok_or_else(bad)?;
        if seen.insert(fp) {
            out.push(fp.to_string());
        }
    }
    Ok(out)
}

#[utoipa::path(get, path = "/api/reverse/user/keys/devices", tag = "Device Keys", security(("bearer" = [])), responses((status = 200, body = Vec<super::schemas::KeyDevice>)))]
async fn my_devices(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    // BTreeMap：金鑰依 id 排，裝置依名稱排，輸出才是固定的。/ Ordered maps so the output is deterministic.
    let mine: BTreeMap<i64, String> = db::keys::user_keys(&state.db, me.id).await?.into_iter().filter_map(|k| parse_public_key(&k.key).map(|p| (k.id, p.bare))).collect();
    // (隧道, 金鑰) → 這把金鑰在那台裝置上的每一列（直接 + 群組授予）。/ (tunnel, key) → its entries there.
    let entries = db::device_keys::effective_entries_for_user(&state.db, me.id).await?;
    let mut in_list: HashMap<(i64, i64), Vec<&db::device_keys::Entry>> = HashMap::new();
    for e in &entries {
        in_list.entry((e.tunnel_id, e.user_key_id)).or_default().push(e);
    }
    let my_groups = db::groups::tunnel_group_of(&state.db, me.id).await?;
    let (my_shares, _) = db::sharing::permission_context(&state.db, me.id).await?;
    let mut tunnels = db::tunnels::visible_to(&state.db, me.id).await?;
    tunnels.sort_by(|a, b| a.host_friendly_name.to_lowercase().cmp(&b.host_friendly_name.to_lowercase()).then(a.id.cmp(&b.id)));
    let mut out = Vec::new();
    for t in tunnels {
        let Some(eff) = permissions::effective(me.id, t.user_id, my_shares.get(&t.id).map(String::as_str)) else { continue };
        let allowed = permissions::allowed_usernames(&state.db, me.id, &t).await?;
        let accounts: Vec<String> = allowed.iter().map(|u| u.username.clone()).collect();
        let account_list: Vec<Value> = allowed.iter().map(|u| json!({ "id": u.id, "username": u.username })).collect();
        let has_entries = in_list.keys().any(|(tid, _)| *tid == t.id);
        let snap = if has_entries { Some(snapshot(&state, &t).await?) } else { None };
        let keys: Vec<Value> = mine
            .iter()
            .filter_map(|(kid, bare)| in_list.get(&(t.id, *kid)).map(|list| (kid, bare, list)))
            .map(|(kid, bare, list)| {
                let direct = list.iter().find(|e| e.is_direct());
                json!({
                    "user_key_id": kid,
                    "accounts": direct.and_then(|d| d.account_ids()),
                    "direct": direct.is_some(),
                    "groups": group_sources(list),
                    "targets": snap.as_ref().map(|s| s.targets(bare)).unwrap_or_default(),
                })
            })
            .collect();
        out.push(json!({
            "tunnel_id": t.id,
            "host_friendly_name": t.host_friendly_name,
            "group_id": my_groups.get(&t.id),
            "online": dk::online(&state, t.reverse_port),
            "role": eff.label(),
            "accounts": accounts,
            "account_list": account_list,
            "keys": keys,
        }));
    }
    Ok(Json(Value::Array(out)))
}

/// 建立隧道時的 `key_list`：`"mine"` = 清單從我所有的金鑰開始；`"empty"`（預設）= 空清單。
pub fn key_list_choice(body: &Value) -> ApiResult<bool> {
    match body.get("key_list") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::String(s)) if s == "empty" => Ok(false),
        Some(Value::String(s)) if s == "mine" => Ok(true),
        Some(_) => Err(ApiError::field("key_list", "Must be \"mine\" or \"empty\".")),
    }
}

/// `key_list = "mine"`：把建立者的每一把金鑰放進新裝置的清單（之後新增的金鑰要自己勾）。
pub async fn seed_key_list(state: &AppState, tunnel_id: i64, user_id: i64) -> ApiResult<()> {
    for k in db::keys::user_keys(&state.db, user_id).await? {
        db::device_keys::add_entry(&state.db, tunnel_id, k.id, user_id, user_id, None).await?;
    }
    state.device_keys.kick(tunnel_id);
    Ok(())
}
