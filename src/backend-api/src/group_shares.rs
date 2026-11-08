//! 分享給群組（組織群組或個人群組）：每位成員各自拿到一筆「經由群組」的分享列（`tunnels_tunnelsharing.group_share_id`），
//! 所以權限檢查、允許帳號、裝置金鑰、通知與失去存取時的收尾都照舊走同一條路。`plan`（純函式）比對群組分享 × 成員
//! 與現有的列；`reconcile` 套用它。直接分享給這個人的列優先，群組不碰。
//!
//! 哪些群組分享算數：組織群組要打開「可以被分享」；個人群組的成員由它的主人決定，所以只在主人還管得到那條通道時算
//! （他是通道擁有者，或經由自己那筆或組織群組拿到 ADMIN —— 經由別人的個人群組不算，不然兩個人可以互相保住對方）。
//! `diff`（純函式）算「改了之後誰多了 / 少了哪些通道」，給改成員、刪群組前的預告用。
//!
//! A tunnel shared with a group (organization or personal): each member gets a share row marked with the group share,
//! so permission checks, allowed accounts, device keys, notifications and the access-loss clean-up all keep working
//! unchanged. `plan` (pure) compares group shares × members with the rows that exist; `reconcile` applies it. A row
//! shared with the person directly wins; groups never touch it.
//!
//! Which group shares count: an organization group must be open to sharing; a personal group's members are picked by
//! its owner, so its shares count only while that owner still manages the tunnel (owns it, or holds ADMIN through
//! their own share or an organization group's — not through someone's personal group, or two people could keep each
//! other in). `diff` (pure) says who would gain or lose which tunnels, for the preview before a change.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde_json::json;

use crate::db::{self, tunnels::Tunnel};
use crate::error::ApiResult;
use crate::permissions::Permission;
use crate::state::AppState;
use crate::webhooks::{Event, Kind};

/// 一筆群組分享與它的成員。/ One group share with its group's members.
#[derive(Debug, Clone)]
pub struct Rule {
    pub id: i64,
    pub group_id: i64,
    pub tunnel_id: i64,
    pub owner_id: i64,
    pub shared_by: i64,
    pub permission: Permission,
    pub expires_at: Option<String>,
    pub accounts: BTreeSet<i64>,
    pub members: Vec<i64>,
}

/// 一位成員在一條通道上該有的分享（他的每個群組合起來）。/ What a member should hold on a tunnel (all their groups merged).
#[derive(Debug, Clone, PartialEq)]
pub struct Want {
    pub tunnel_id: i64,
    pub user_id: i64,
    /// 給最高權限的那筆群組分享（同樣高時取最早的）。/ The group share giving the highest permission (earliest on a tie).
    pub group_share_id: i64,
    pub shared_by: i64,
    pub permission: Permission,
    /// 任一筆不到期就不到期，否則取最晚的。/ No end if any has none, else the latest.
    pub expires_at: Option<String>,
    pub accounts: BTreeSet<i64>,
}

/// 現有的一筆分享列（群組管的那幾個欄位）。/ An existing share row (the fields a group manages).
#[derive(Debug, Clone)]
pub struct Row {
    pub id: i64,
    pub tunnel_id: i64,
    pub user_id: i64,
    pub group_share_id: Option<i64>,
    /// 群組管的權限：暫時提升時是它結束後回去的那個。/ The permission a group manages (the one a raise returns to).
    pub permission: String,
    pub raised: bool,
    pub expires_at: Option<String>,
    /// 永久的允許帳號（存取申請給的暫時帳號不算）。/ Permanent accounts (temporary ones from requests excluded).
    pub accounts: BTreeSet<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Create(Want),
    Update { row: i64, want: Want, old_permission: String, permission_changed: bool, accounts_changed: bool },
    Remove { row: i64, tunnel_id: i64, user_id: i64, group_share_id: i64 },
}

/// 每位成員在每條通道上該有什麼。/ What every member should hold on every tunnel.
pub fn wants(rules: &[Rule]) -> BTreeMap<(i64, i64), Want> {
    let mut out: BTreeMap<(i64, i64), Want> = BTreeMap::new();
    let mut sorted: Vec<&Rule> = rules.iter().collect();
    sorted.sort_by_key(|r| r.id);
    for r in sorted {
        for &u in &r.members {
            // 主人不需要；分享的人也不從自己的群組分享拿到（不然他被收回 ADMIN 後還留著）。
            // The owner needs none; the sharer gets nothing from their own group share (else they'd keep it after losing ADMIN).
            if u == r.owner_id || u == r.shared_by {
                continue;
            }
            match out.get_mut(&(r.tunnel_id, u)) {
                None => {
                    out.insert(
                        (r.tunnel_id, u),
                        Want {
                            tunnel_id: r.tunnel_id,
                            user_id: u,
                            group_share_id: r.id,
                            shared_by: r.shared_by,
                            permission: r.permission,
                            expires_at: r.expires_at.clone(),
                            accounts: r.accounts.clone(),
                        },
                    );
                }
                Some(w) => {
                    if r.permission > w.permission {
                        w.permission = r.permission;
                        w.group_share_id = r.id;
                        w.shared_by = r.shared_by;
                    }
                    w.expires_at = match (&w.expires_at, &r.expires_at) {
                        (Some(a), Some(b)) => Some(a.max(b).clone()),
                        _ => None,
                    };
                    w.accounts.extend(r.accounts.iter().copied());
                }
            }
        }
    }
    out
}

/// 比對要的與現有的列：建、改、收。直接分享的列不動。/ Compare wants with rows: create, update, remove. Direct rows stay.
pub fn plan(rules: &[Rule], rows: &[Row]) -> Vec<Step> {
    let mut want = wants(rules);
    let mut steps = Vec::new();
    for row in rows {
        let key = (row.tunnel_id, row.user_id);
        match (row.group_share_id, want.remove(&key)) {
            // 直接分享優先：群組不碰它（之後收掉直接分享，群組才補上）。/ A direct share wins.
            (None, _) => {}
            (Some(gs), None) => steps.push(Step::Remove { row: row.id, tunnel_id: row.tunnel_id, user_id: row.user_id, group_share_id: gs }),
            (Some(gs), Some(w)) => {
                let permission_changed = Permission::parse(&row.permission) != Some(w.permission);
                let accounts_changed = row.accounts != w.accounts;
                if permission_changed || accounts_changed || row.expires_at != w.expires_at || gs != w.group_share_id {
                    steps.push(Step::Update { row: row.id, old_permission: row.permission.clone(), permission_changed, accounts_changed, want: w });
                }
            }
        }
    }
    steps.extend(want.into_values().map(Step::Create));
    steps
}

/// 一筆個人群組的分享算不算數：主人的帳號還在用，而且他擁有這條通道，或他不靠任何個人群組就有 ADMIN（`held`，見
/// `counting`）。/ Whether a personal group's share counts: its owner's account is active and they own the tunnel, or
/// they hold ADMIN there without any personal group (`held`, see `counting`).
pub fn personal_share_counts(tunnel_owner: i64, group_owner: i64, owner_active: bool, held: Option<Permission>) -> bool {
    owner_active && (group_owner == tunnel_owner || held == Some(Permission::Admin))
}

/// 一筆群組分享，加上它的群組是誰建的（None = 組織群組）。/ A group share plus who made its group (None = organization).
#[derive(Debug, Clone)]
pub struct Candidate {
    pub rule: Rule,
    pub maker: Option<i64>,
    pub maker_active: bool,
}

/// 不靠個人群組時，一個人在一條通道上有什麼：直接分享那筆（現在的權限），或存取申請暫時提升、還在效期內的群組列。
/// What someone holds on a tunnel without personal groups: their direct row (permission in force), or a group-made row
/// raised by an access request and still in force.
#[derive(Debug, Clone, Default)]
pub struct Held {
    pub direct: HashMap<(i64, i64), Permission>,
    pub raised: HashMap<(i64, i64), Permission>,
}

/// 哪些群組分享算數。組織群組的都算；個人群組的看主人：直接分享優先，否則取組織群組給他的（照 `wants` 算，跟
/// 比對結果一樣）與暫時提升的較高者。一次算完，不看資料庫裡現有的群組列 —— 所以主人剛被移出組織群組時，他的個人
/// 群組分享在同一次比對、同一次預告裡就停，不必等下一輪。
/// Which group shares count. Organization groups' always do; a personal group's depends on its maker: their direct row
/// first, else the higher of what organization groups give them (computed with `wants`, exactly as the reconcile will
/// hold it) and a raise in force. One pass that never reads the existing group rows, so a maker just taken out of an
/// organization group stops counting in the same reconcile and the same preview, not a round later.
pub fn counting(candidates: &[Candidate], held: &Held) -> Vec<Rule> {
    let org: Vec<Rule> = candidates.iter().filter(|c| c.maker.is_none()).map(|c| c.rule.clone()).collect();
    let from_org = wants(&org);
    candidates
        .iter()
        .filter(|c| match c.maker {
            None => true,
            Some(maker) => {
                let key = (c.rule.tunnel_id, maker);
                let has = held.direct.get(&key).copied().or_else(|| from_org.get(&key).map(|w| w.permission).max(held.raised.get(&key).copied()));
                personal_share_counts(c.rule.owner_id, maker, c.maker_active, has)
            }
        })
        .map(|c| c.rule.clone())
        .collect()
}

/// 一個人多了 / 少了哪些通道。/ Which tunnels each person gains or loses.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Diff {
    pub gain: BTreeMap<i64, BTreeSet<i64>>,
    pub lose: BTreeMap<i64, BTreeSet<i64>>,
}

/// 規則從 `before` 換成 `after` 之後，誰經由群組多了 / 少了哪條通道。`direct` = 已經有直接分享的 (通道, 人)：他們
/// 照自己那筆，群組怎麼改都不算。
/// Who gains or loses which tunnel through groups when the rules go from `before` to `after`. `direct` = (tunnel,
/// person) pairs with a direct share of their own: groups change nothing for them.
pub fn diff(before: &[Rule], after: &[Rule], direct: &HashSet<(i64, i64)>) -> Diff {
    let had: BTreeSet<(i64, i64)> = wants(before).into_keys().filter(|k| !direct.contains(k)).collect();
    let has: BTreeSet<(i64, i64)> = wants(after).into_keys().filter(|k| !direct.contains(k)).collect();
    let mut out = Diff::default();
    for (t, u) in has.difference(&had) {
        out.gain.entry(*u).or_default().insert(*t);
    }
    for (t, u) in had.difference(&has) {
        out.lose.entry(*u).or_default().insert(*t);
    }
    out
}

/// 預告的改動。/ A change to preview.
#[derive(Debug, Clone)]
pub enum Change {
    /// 換掉成員名單。/ Replace the member list.
    Members(Vec<i64>),
    /// 群組的分享全部結束（刪群組、組織群組不再開放分享）。/ Every share with it ends (deleted, or no longer shareable).
    Unshared,
}

/// 把一個群組的改動套在群組分享上（純函式；之後再 `counting`，連帶的暫停也算進去）。
/// Apply a change to one group to the group shares (pure; `counting` afterwards also catches the pauses it causes).
pub fn changed(candidates: &[Candidate], group_id: i64, change: &Change) -> Vec<Candidate> {
    candidates
        .iter()
        .filter(|c| c.rule.group_id != group_id || matches!(change, Change::Members(_)))
        .map(|c| match change {
            Change::Members(m) if c.rule.group_id == group_id => Candidate { rule: Rule { members: m.clone(), ..c.rule.clone() }, ..c.clone() },
            _ => c.clone(),
        })
        .collect()
}

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 會改到群組列的地方（改成直接分享）跟 `reconcile` 輪流來，不讓比對到一半的計畫蓋掉它。
/// Taken by writers of group rows (making one direct) so a half-applied reconcile plan never overwrites them.
pub async fn lock() -> tokio::sync::MutexGuard<'static, ()> {
    LOCK.lock().await
}

/// 背景跑一次比對（成員或群組分享變了之後）。/ Reconcile in the background (after members or group shares changed).
pub fn kick(state: &AppState) {
    kick_with(state, HashMap::new());
}

/// 同上，帶著剛收掉的群組分享 → 群組名稱（說明用）。/ The same, with just-removed group shares → group names.
pub fn kick_with(state: &AppState, gone: HashMap<i64, String>) {
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = reconcile(&state, &gone).await {
            tracing::warn!(error = ?e, "group share reconcile failed");
        }
    });
}

/// 刪群組之前：它的群組分享 → 名稱，給之後的說明用。/ Before deleting a group: its shares → its name, for the wording.
pub async fn gone_for_group(state: &AppState, group_id: i64, name: &str) -> ApiResult<HashMap<i64, String>> {
    Ok(db::group_shares::ids_of_group(&state.db, group_id).await?.into_iter().map(|id| (id, name.to_string())).collect())
}

/// 收掉到期的群組分享，再比對一次。每 30 秒跟著分享到期一起跑。/ End expired group shares, then reconcile (every 30 s).
pub async fn tick(state: &AppState) -> ApiResult<()> {
    let mut gone = HashMap::new();
    for g in db::group_shares::expired(&state.db).await? {
        let name = group_name(state, g.group_id).await?;
        db::group_shares::delete(&state.db, g.id).await?;
        let tunnel = db::tunnels::by_id(&state.db, g.tunnel_id).await?.map(|t| t.host_friendly_name).unwrap_or_default();
        state.gateway.event("group_share", None, None, Some(g.tunnel_id), format!("The share of \"{tunnel}\" with the group \"{name}\" expired")).await;
        gone.insert(g.id, name);
    }
    reconcile(state, &gone).await
}

async fn group_name(state: &AppState, group_id: i64) -> ApiResult<String> {
    Ok(db::features::any_group(&state.db, group_id).await?.map(|g| g.label().to_string()).unwrap_or_default())
}

/// 比對要用的一切：算數的群組分享、現有的列、群組分享 → 名稱。/ Everything a reconcile needs.
struct Loaded {
    candidates: Vec<Candidate>,
    held: Held,
    rules: Vec<Rule>,
    rows: Vec<Row>,
    share_group: HashMap<i64, String>,
    tunnels: HashMap<i64, Tunnel>,
}

async fn load(state: &AppState) -> ApiResult<Loaded> {
    let shares = db::group_shares::live(&state.db).await?;
    let accounts = db::group_shares::all_username_ids(&state.db).await?;
    let mut members: HashMap<i64, Vec<i64>> = HashMap::new();
    for (g, u) in db::features::all_memberships(&state.db).await? {
        members.entry(g).or_default().push(u);
    }
    let groups: HashMap<i64, db::features::Group> = db::features::all_groups(&state.db).await?.into_iter().map(|g| (g.id, g)).collect();
    let sharing = db::group_shares::rows(&state.db).await?;
    let mut held = Held::default();
    for s in &sharing {
        let Some(p) = Permission::parse(s.permission()) else { continue };
        let key = (s.tunnel_id, s.shared_with_id);
        if s.group_share_id.is_none() {
            held.direct.insert(key, p);
        } else if s.base_permission.is_some() && s.permission() == s.permission_type {
            // 群組列上還在效期內的暫時提升（核准的存取申請）。/ A raise in force on a group row (an approved access request).
            held.raised.insert(key, p);
        }
    }
    let mut active: HashMap<i64, bool> = HashMap::new();
    let mut tunnels: HashMap<i64, Tunnel> = HashMap::new();
    let mut candidates = Vec::new();
    let mut share_group = HashMap::new();
    for g in &shares {
        let Some(t) = cached_tunnel(state, &mut tunnels, g.tunnel_id).await? else { continue };
        let Some(perm) = Permission::parse(&g.permission_type) else { continue };
        let Some(group) = groups.get(&g.group_id) else { continue };
        share_group.insert(g.id, group.label().to_string());
        // 沒開放分享的組織群組完全不算（關掉時它的分享已經刪了，這是保險）。/ A closed organization group never counts.
        if group.owner_id.is_none() && !group.shareable {
            continue;
        }
        let maker_active = match group.owner_id {
            None => true,
            Some(owner) => match active.get(&owner) {
                Some(on) => *on,
                None => {
                    let on = db::users::by_id(&state.db, owner).await?.is_some_and(|u| u.is_active);
                    active.insert(owner, on);
                    on
                }
            },
        };
        let rule = Rule {
            id: g.id,
            group_id: g.group_id,
            tunnel_id: g.tunnel_id,
            owner_id: t.user_id,
            shared_by: g.shared_by_id.unwrap_or(t.user_id),
            permission: perm,
            expires_at: g.expires_at.clone(),
            accounts: accounts.get(&g.id).cloned().unwrap_or_default(),
            members: members.get(&g.group_id).cloned().unwrap_or_default(),
        };
        candidates.push(Candidate { rule, maker: group.owner_id, maker_active });
    }
    let rules = counting(&candidates, &held);
    let permanent = db::group_shares::permanent_accounts(&state.db).await?;
    let rows: Vec<Row> = sharing
        .into_iter()
        .map(|s| Row {
            id: s.id,
            tunnel_id: s.tunnel_id,
            user_id: s.shared_with_id,
            group_share_id: s.group_share_id,
            permission: s.base_permission.clone().unwrap_or_else(|| s.permission_type.clone()),
            raised: s.base_permission.is_some(),
            expires_at: s.expires_at.clone(),
            accounts: permanent.get(&s.id).cloned().unwrap_or_default(),
        })
        .collect();
    Ok(Loaded { candidates, held, rules, rows, share_group, tunnels })
}

/// 群組分享現在算不算數（暫停的個人群組分享 = 不算）。/ Which group shares count right now (paused personal ones don't).
pub async fn active_shares(state: &AppState) -> ApiResult<HashSet<i64>> {
    Ok(load(state).await?.rules.iter().map(|r| r.id).collect())
}

/// 預告一個群組的改動：誰會多了 / 少了哪些通道（什麼都不寫）。/ Preview a change to one group (writes nothing).
pub async fn preview(state: &AppState, group_id: i64, change: &Change) -> ApiResult<serde_json::Value> {
    let loaded = load(state).await?;
    let direct: HashSet<(i64, i64)> = loaded.rows.iter().filter(|r| r.group_share_id.is_none()).map(|r| (r.tunnel_id, r.user_id)).collect();
    let after = counting(&changed(&loaded.candidates, group_id, change), &loaded.held);
    let d = diff(&loaded.rules, &after, &direct);
    let ids: Vec<i64> = d.gain.keys().chain(d.lose.keys()).copied().collect();
    let names = db::users::usernames_for(&state.db, &ids).await?;
    let tunnels = loaded.tunnels;
    let side = |m: &BTreeMap<i64, BTreeSet<i64>>| -> Vec<serde_json::Value> {
        m.iter()
            .map(|(u, ts)| {
                json!({
                    "user_id": u,
                    "username": names.get(u).cloned().unwrap_or_else(|| format!("#{u}")),
                    "tunnels": ts.iter().map(|t| json!({ "id": t, "name": tunnels.get(t).map(|t| t.host_friendly_name.clone()).unwrap_or_default() })).collect::<Vec<_>>(),
                })
            })
            .collect()
    };
    let gain = side(&d.gain);
    let lose = side(&d.lose);
    let shares = match change {
        Change::Unshared => db::group_shares::ids_of_group(&state.db, group_id).await?.len(),
        Change::Members(_) => 0,
    };
    Ok(json!({ "gain": gain, "lose": lose, "shares": shares }))
}

/// 把所有成員的分享列對齊群組分享。`gone` = 剛收掉的群組分享 → 群組名稱（說明用）。
/// Bring every member's row in line with the group shares. `gone` = just-removed group shares → group names (for wording).
pub async fn reconcile(state: &AppState, gone: &HashMap<i64, String>) -> ApiResult<()> {
    let _held = LOCK.lock().await;
    let Loaded { rules, rows, share_group: names, mut tunnels, .. } = load(state).await?;
    let mut share_group: HashMap<i64, String> = gone.clone();
    share_group.extend(names);
    let raised: HashMap<i64, bool> = rows.iter().map(|r| (r.id, r.raised)).collect();
    for step in plan(&rules, &rows) {
        // 一步失敗只記下來，後面的照做（下次 tick 再試這一步）。/ A failed step is logged; the rest still run.
        if let Err(e) = apply(state, &mut tunnels, &share_group, &raised, step).await {
            tracing::warn!(error = ?e, "group share step failed");
        }
    }
    Ok(())
}

async fn apply(state: &AppState, tunnels: &mut HashMap<i64, Tunnel>, share_group: &HashMap<i64, String>, raised: &HashMap<i64, bool>, step: Step) -> ApiResult<()> {
    let tunnel_id = match &step {
        Step::Create(w) | Step::Update { want: w, .. } => w.tunnel_id,
        Step::Remove { tunnel_id, .. } => *tunnel_id,
    };
    let Some(t) = cached_tunnel(state, tunnels, tunnel_id).await? else { return Ok(()) };
    match step {
        Step::Create(w) => create(state, &t, &w, share_group.get(&w.group_share_id).map(String::as_str).unwrap_or_default()).await?,
        Step::Update { row, want, old_permission, permission_changed, accounts_changed } => {
            let group = share_group.get(&want.group_share_id).map(String::as_str).unwrap_or_default();
            update(state, &t, row, raised.get(&row).copied().unwrap_or(false), &want, &old_permission, permission_changed, accounts_changed, group).await?
        }
        Step::Remove { row, user_id, group_share_id, .. } => {
            let group = share_group.get(&group_share_id).cloned().unwrap_or_default();
            // 還是同一筆、還是經由群組才收：剛改成直接分享的不動。/ Only the same row, still from a group: a just-made direct share stays.
            if let Some(s) = db::sharing::get(&state.db, t.id, user_id).await?.filter(|s| s.id == row && s.group_share_id.is_some()) {
                crate::api::sharing::end_share(state, &t, &s, None, crate::api::sharing::EndReason::Group { group: &group }).await?;
                let user = username(state, user_id).await?;
                state.gateway.event("group_share", None, None, Some(t.id), format!("{user} no longer has access to \"{}\" through the group \"{group}\"", t.host_friendly_name)).await;
            }
        }
    }
    Ok(())
}

async fn cached_tunnel(state: &AppState, cache: &mut HashMap<i64, Tunnel>, id: i64) -> ApiResult<Option<Tunnel>> {
    if let Some(t) = cache.get(&id) {
        return Ok(Some(t.clone()));
    }
    let t = db::tunnels::by_id(&state.db, id).await?;
    if let Some(t) = &t {
        cache.insert(id, t.clone());
    }
    Ok(t)
}

async fn username(state: &AppState, id: i64) -> ApiResult<String> {
    Ok(db::users::by_id(&state.db, id).await?.map(|u| u.username).unwrap_or_default())
}

async fn create(state: &AppState, t: &Tunnel, w: &Want, group: &str) -> ApiResult<()> {
    let id = db::group_shares::create_row(&state.db, t.id, w.shared_by, w.user_id, w.permission.as_str(), w.expires_at.as_deref(), w.group_share_id).await?;
    db::group_shares::set_permanent_accounts(&state.db, id, t.id, &w.accounts).await?;
    let user = username(state, w.user_id).await?;
    let by = username(state, w.shared_by).await?;
    state.hub.notify_user(
        w.user_id,
        &json!({
            "action": "TUNNEL-SHARED",
            "details": format!("Tunnel \"{}\" has been shared with you through the group \"{group}\"", t.host_friendly_name),
            "tunnel_id": t.id,
            "shared_by": by,
            "permission_type": w.permission.as_str(),
            "group": group,
        }),
    );
    state.hub.notify_user(t.user_id, &json!({ "action": "TUNNEL-SHARED", "tunnel_id": t.id }));
    state.webhooks.emit(
        Event::new(Kind::ShareReceived)
            .tunnel(t)
            .to([w.user_id], None)
            .data(json!({ "by": by, "permission": w.permission.as_str(), "group": group, "expires_at": w.expires_at.as_deref().map(crate::util::db_to_iso_utc_z) }))
            .link("/tunnels"),
    );
    state.gateway.event("group_share", None, None, Some(t.id), format!("{user} can use \"{}\" through the group \"{group}\" ({})", t.host_friendly_name, w.permission.as_str())).await;
    state.device_keys.kick(t.id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn update(state: &AppState, t: &Tunnel, row: i64, raised: bool, w: &Want, old: &str, permission_changed: bool, accounts_changed: bool, group: &str) -> ApiResult<()> {
    if !db::group_shares::update_row(&state.db, row, w.permission.as_str(), w.expires_at.as_deref(), w.group_share_id).await? {
        return Ok(());
    }
    if accounts_changed {
        db::group_shares::set_permanent_accounts(&state.db, row, t.id, &w.accounts).await?;
    }
    if permission_changed && w.permission == Permission::View && matches!(Permission::parse(old), Some(Permission::Edit) | Some(Permission::Admin)) && !raised {
        db::tunnels::transfer_usernames_to_owner(&state.db, t.id, t.user_id, w.user_id).await?;
    }
    if permission_changed || accounts_changed {
        state.device_keys.kick(t.id);
        crate::access_recheck::kick(state, Some(t.id), Some(w.user_id));
        let user = username(state, w.user_id).await?;
        state.gateway.event("group_share", None, None, Some(t.id), format!("{user}'s access to \"{}\" through the group \"{group}\" changed ({})", t.host_friendly_name, w.permission.as_str())).await;
    }
    if permission_changed {
        state.hub.notify_user(
            w.user_id,
            &json!({
                "action": "TUNNEL-PERMISSION-UPDATED",
                "details": format!("Your permission for tunnel \"{}\" through the group \"{group}\" is now \"{}\"", t.host_friendly_name, w.permission.display()),
                "tunnel_id": t.id,
                "old_permission": old,
                "new_permission": w.permission.as_str(),
            }),
        );
    } else {
        state.hub.notify_user(w.user_id, &json!({ "action": "TUNNEL-USERNAMES-UPDATED", "tunnel_id": t.id }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: i64, tunnel: i64, perm: Permission, accounts: &[i64], members: &[i64], expires: Option<&str>) -> Rule {
        Rule {
            id,
            group_id: id * 100,
            tunnel_id: tunnel,
            owner_id: 1,
            shared_by: 1,
            permission: perm,
            expires_at: expires.map(str::to_string),
            accounts: accounts.iter().copied().collect(),
            members: members.to_vec(),
        }
    }

    fn row(id: i64, tunnel: i64, user: i64, gs: Option<i64>, perm: &str, accounts: &[i64]) -> Row {
        Row { id, tunnel_id: tunnel, user_id: user, group_share_id: gs, permission: perm.into(), raised: false, expires_at: None, accounts: accounts.iter().copied().collect() }
    }

    #[test]
    fn members_get_a_row_and_the_owner_does_not() {
        let steps = plan(&[rule(7, 10, Permission::View, &[3], &[1, 2, 4], None)], &[]);
        let made: Vec<i64> = steps.iter().filter_map(|s| if let Step::Create(w) = s { Some(w.user_id) } else { None }).collect();
        assert_eq!(made, vec![2, 4]);
    }

    #[test]
    fn the_sharer_gets_nothing_from_their_own_group_share() {
        let mut r = rule(7, 10, Permission::Admin, &[], &[2, 5], None);
        r.shared_by = 5;
        assert_eq!(wants(&[r]).keys().map(|k| k.1).collect::<Vec<_>>(), vec![2]);
    }

    #[test]
    fn a_direct_share_wins_over_the_group() {
        let steps = plan(&[rule(7, 10, Permission::Admin, &[], &[2], None)], &[row(50, 10, 2, None, "view", &[])]);
        assert!(steps.is_empty());
    }

    #[test]
    fn several_groups_merge_to_the_highest_permission_and_every_account() {
        let w = wants(&[rule(7, 10, Permission::View, &[3], &[2], Some("2030-01-01 00:00:00")), rule(8, 10, Permission::Edit, &[4], &[2], Some("2029-01-01 00:00:00"))]);
        let w = &w[&(10, 2)];
        assert_eq!(w.permission, Permission::Edit);
        assert_eq!(w.group_share_id, 8);
        assert_eq!(w.accounts, [3, 4].into_iter().collect());
        assert_eq!(w.expires_at.as_deref(), Some("2030-01-01 00:00:00"));
        let w = wants(&[rule(7, 10, Permission::View, &[], &[2], None), rule(8, 10, Permission::View, &[], &[2], Some("2029-01-01 00:00:00"))]);
        assert_eq!(w[&(10, 2)].expires_at, None, "one share without an end means no end");
        assert_eq!(w[&(10, 2)].group_share_id, 7, "the earliest on a tie");
    }

    #[test]
    fn changes_update_the_row_and_leaving_removes_it() {
        let rules = [rule(7, 10, Permission::Edit, &[3, 4], &[2], None)];
        let steps = plan(&rules, &[row(50, 10, 2, Some(7), "view", &[3]), row(51, 10, 9, Some(7), "view", &[3])]);
        assert_eq!(steps.len(), 2);
        assert!(matches!(&steps[0], Step::Update { row: 50, permission_changed: true, accounts_changed: true, .. }));
        assert_eq!(steps[1], Step::Remove { row: 51, tunnel_id: 10, user_id: 9, group_share_id: 7 });
        // 一樣就不動。/ Nothing changes, nothing happens.
        assert!(plan(&rules, &[row(50, 10, 2, Some(7), "edit", &[3, 4])]).is_empty());
    }

    #[test]
    fn a_raised_row_is_compared_by_the_permission_it_returns_to() {
        let mut r = row(50, 10, 2, Some(7), "view", &[]);
        r.raised = true;
        assert!(plan(&[rule(7, 10, Permission::View, &[], &[2], None)], &[r]).is_empty());
    }

    #[test]
    fn a_personal_groups_share_counts_only_while_its_owner_manages_the_tunnel() {
        // 主人自己的通道。/ The owner's own tunnel.
        assert!(personal_share_counts(1, 1, true, None));
        assert!(personal_share_counts(1, 2, true, Some(Permission::Admin)));
        assert!(!personal_share_counts(1, 2, true, Some(Permission::Edit)));
        assert!(!personal_share_counts(1, 2, true, None));
        // 停用的帳號什麼都不算，連自己的通道。/ A disabled owner counts for nothing, own tunnel included.
        assert!(!personal_share_counts(1, 1, false, None));
    }

    fn cand(r: Rule, maker: Option<i64>) -> Candidate {
        Candidate { rule: r, maker, maker_active: true }
    }

    #[test]
    fn a_makers_admin_comes_from_their_own_row_or_organization_groups_never_personal_ones() {
        // 通道 10（主人 1）：組織群組 7 給 2 ADMIN；2 的個人群組 8 = 5；3 的個人群組 9 = 6，3 只經由 2 的個人群組有 ADMIN。
        // Tunnel 10 (owner 1): org group 7 gives 2 ADMIN; 2's personal group 8 = 5; 3's personal group 9 = 6, and 3 holds
        // ADMIN only through 2's personal group.
        let org = cand(rule(7, 10, Permission::Admin, &[], &[2], None), None);
        let mut p2 = rule(8, 10, Permission::Admin, &[], &[3, 5], None);
        p2.shared_by = 2;
        let mut p3 = rule(9, 10, Permission::Admin, &[], &[6], None);
        p3.shared_by = 3;
        let all = vec![org, cand(p2, Some(2)), cand(p3, Some(3))];
        let ids = |rs: Vec<Rule>| rs.iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(counting(&all, &Held::default())), vec![7, 8], "3's group doesn't count: ADMIN through a personal group");
        // 2 被移出組織群組：他的個人群組在同一次就不算。/ 2 leaves the org group: their personal group stops at once.
        let after = changed(&all, 700, &Change::Members(vec![]));
        assert_eq!(ids(counting(&after, &Held::default())), vec![7]);
        // 但 2 有直接的 ADMIN（或還在效期內的暫時提升）就照樣算。/ A direct ADMIN, or a raise in force, keeps it.
        let direct = Held { direct: [((10, 2), Permission::Admin)].into_iter().collect(), ..Held::default() };
        assert_eq!(ids(counting(&after, &direct)), vec![7, 8]);
        let raised = Held { raised: [((10, 2), Permission::Admin)].into_iter().collect(), ..Held::default() };
        assert_eq!(ids(counting(&after, &raised)), vec![7, 8]);
        // 直接分享優先：直接那筆只有 VIEW，組織群組給 ADMIN 也不算（群組不碰直接分享）。/ A direct VIEW wins over the org group.
        let view = Held { direct: [((10, 2), Permission::View)].into_iter().collect(), ..Held::default() };
        assert_eq!(ids(counting(&all, &view)), vec![7]);
        // 預告也看得到連帶的影響：5 會失去 10。/ The preview sees the knock-on effect: 5 loses tunnel 10.
        let d = diff(&counting(&all, &Held::default()), &counting(&after, &Held::default()), &HashSet::new());
        assert_eq!(d.lose.keys().copied().collect::<Vec<_>>(), vec![2, 3, 5]);
    }

    #[test]
    fn a_preview_lists_who_gains_and_loses_but_not_people_with_a_share_of_their_own() {
        let cands = vec![cand(rule(7, 10, Permission::View, &[], &[2, 3], None), None), cand(rule(8, 11, Permission::View, &[], &[3], None), None)];
        let rules: Vec<Rule> = cands.iter().map(|c| c.rule.clone()).collect();
        let changed = |g, ch: &Change| changed(&cands, g, ch).into_iter().map(|c| c.rule).collect::<Vec<_>>();
        let direct: HashSet<(i64, i64)> = [(10, 4)].into_iter().collect();
        // 群組 700（= 規則 7 的群組）換成 3 + 4 + 5：2 少了 10；4 自己有分享不算；5 多了 10。
        // Group 700 (rule 7's) becomes 3 + 4 + 5: 2 loses 10; 4 has their own share; 5 gains 10.
        let d = diff(&rules, &changed(700, &Change::Members(vec![3, 4, 5])), &direct);
        assert_eq!(d.lose, [(2, [10].into_iter().collect())].into_iter().collect());
        assert_eq!(d.gain, [(5, [10].into_iter().collect())].into_iter().collect());
        // 群組 700 的分享全部結束：3 還經由群組 800 留著 11，只少了 10。/ Unshared: 3 keeps 11 through group 800.
        let d = diff(&rules, &changed(700, &Change::Unshared), &direct);
        assert_eq!(d.lose, [(2, [10].into_iter().collect()), (3, [10].into_iter().collect())].into_iter().collect());
        assert!(d.gain.is_empty());
        // 別的通道也經由同一個群組分享的話，3 不會因為還在群組 800 就不算。/ Another group's tunnel isn't touched.
        assert!(changed(700, &Change::Unshared).iter().all(|r| r.group_id == 800));
    }
}
