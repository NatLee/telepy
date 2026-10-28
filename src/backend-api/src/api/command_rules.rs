//! 指令規則 API：個人規則（每個人自己寫：管他是 owner / ADMIN 的隧道上的人，或「只有我」只管自己；所有隧道或指定的幾條）、
//! 全站規則（管理員改、大家看得到；所有隧道或指定的幾條）、一條隧道上現在算數的規則、試跑一個指令，以及核准申請的清單與
//! 核准 / 拒絕 / 撤回。「要核准」規則可以指定核准人（`approver_ids`）：個人規則只能指定自己管的隧道的 owner / ADMIN
//! sharee，全站規則任何啟用中的帳號都行。
//! Command rules API: personal rules (anyone's own: for people on the tunnels they own or administer, or "only me";
//! every tunnel or picked ones), site-wide rules (admins edit, everyone reads; every tunnel or picked ones), the rules
//! in force on one tunnel, trying a command, and the approval requests with approve / deny / withdraw. An "approve"
//! rule may name its approvers (`approver_ids`): a personal rule only owners / ADMIN sharees of tunnels its author
//! manages, a site-wide rule any active account.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::command_rules::{self as rules, matcher, Action, Ctx, DecideError, Kind, Matcher, Rule, Source, Who};
use crate::db::{self, command_rules::{NewRule, RuleRow}, tunnels::Tunnel, users::User};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;

/// 每個人（或全站）最多幾條規則。/ Rules per person (or site-wide) at most.
pub const MAX_RULES: usize = 100;
const NOTE_MAX: usize = 300;
/// 一條規則最多指定幾位核准人。/ Approvers a rule may name at most.
pub const MAX_APPROVERS: usize = 20;
/// 一條規則最多列幾條隧道。/ Tunnels a rule may list at most.
pub const MAX_TUNNELS: usize = 200;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, create))
        .routes(routes!(update, destroy))
        .routes(routes!(tunnel_list, tunnel_create))
        .routes(routes!(check))
        .routes(routes!(requests))
        .routes(routes!(approve))
        .routes(routes!(deny))
        .routes(routes!(cancel))
}

fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

fn tunnel_not_found() -> ApiError {
    ApiError::not_found("Tunnel not found")
}

fn rule_not_found() -> ApiError {
    ApiError::not_found("Rule not found")
}

/// 看得到這條隧道嗎；我是不是它的 owner / ADMIN。/ Whether the tunnel is visible, and whether I own or administer it.
async fn tunnel_access(state: &AppState, me: &User, id: i64) -> ApiResult<(Tunnel, bool)> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(tunnel_not_found)?;
    let eff = permissions::effective_for(&state.db, me.id, &t).await?.ok_or_else(tunnel_not_found)?;
    Ok((t, eff.satisfies(Permission::Admin)))
}

/// 我看得到哪些隧道、管哪些（owner / ADMIN）；管理員另外知道所有隧道的名字。
/// The tunnels I can see and the ones I manage (owner / ADMIN); admins also get every tunnel's name.
struct Reach {
    visible: Vec<Tunnel>,
    manage: HashSet<i64>,
    /// 規則 JSON 裡能寫出名字的隧道（管理員 = 全部）。/ Tunnels whose names rule JSON may show (admins: all).
    names: HashMap<i64, String>,
}

impl Reach {
    async fn of(state: &AppState, me: &User) -> ApiResult<Self> {
        let mut visible = db::tunnels::visible_to(&state.db, me.id).await?;
        visible.sort_by(|a, b| a.host_friendly_name.to_lowercase().cmp(&b.host_friendly_name.to_lowercase()).then(a.id.cmp(&b.id)));
        let (mine, _) = db::sharing::permission_context(&state.db, me.id).await?;
        let manage = visible
            .iter()
            .filter(|t| permissions::effective(me.id, t.user_id, mine.get(&t.id).map(String::as_str)).is_some_and(|e| e.satisfies(Permission::Admin)))
            .map(|t| t.id)
            .collect();
        let names = if me.is_superuser {
            db::tunnels::all(&state.db).await?.into_iter().map(|t| (t.id, t.host_friendly_name)).collect()
        } else {
            visible.iter().map(|t| (t.id, t.host_friendly_name.clone())).collect()
        };
        Ok(Self { visible, manage, names })
    }

    fn sees(&self, id: i64) -> bool {
        self.visible.iter().any(|t| t.id == id)
    }
}

/// 表單 → 一列規則的欄位（含比對式與套用範圍）。/ The form → a rule's fields (pattern and targets included).
struct Parsed {
    action: String,
    kind: String,
    pattern: String,
    who: String,
    via: String,
    note: String,
    enabled: bool,
    all_tunnels: bool,
    /// 已排序去重；`all_tunnels` 時是空的。/ Sorted, de-duplicated; empty with `all_tunnels`.
    tunnel_ids: Vec<i64>,
    /// 已排序去重；空 = 預設核准人。/ Sorted, de-duplicated; empty = the default approvers.
    approver_ids: Vec<i64>,
}

fn id_list(v: &Value, field: &str, what: &str) -> ApiResult<Vec<i64>> {
    let Value::Array(items) = v else { return Err(ApiError::field(field, format!("{field} must be a list of {what} ids."))) };
    let mut ids = Vec::with_capacity(items.len());
    for v in items {
        let Some(id) = v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())) else {
            return Err(ApiError::field(field, format!("{field} must be a list of {what} ids.")));
        };
        ids.push(id);
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// `approver_ids`：沒帶 = 保留現在的（新增時 = 空）；null / [] = 預設核准人。只有「要核准」而且不是「只有我」的規則留著。
/// `approver_ids`: omitted = keep the current list (empty on create); null / [] = default. Kept for approve rules
/// that aren't "only me".
fn parse_approvers(body: &Value, current: Option<&RuleRow>, action: &str, who: &str) -> ApiResult<Vec<i64>> {
    let ids = match body.get("approver_ids") {
        None => rules::parse_approver_ids(current.and_then(|c| c.approver_ids.as_deref())),
        Some(Value::Null) => Vec::new(),
        Some(v) => id_list(v, "approver_ids", "user")?,
    };
    if ids.len() > MAX_APPROVERS {
        return Err(ApiError::field("approver_ids", format!("Name at most {MAX_APPROVERS} approvers.")));
    }
    // 擋下 / 允許用不到核准人；「只有我」的核准人就是自己。默默清掉，免得之後改回來時冒出舊名單。
    // Block / allow rules have no approvers, and "only me" rules are approved by their owner.
    Ok(if action == "approve" && who != "me" { ids } else { Vec::new() })
}

fn parse_rule(body: &Value, current: Option<(&RuleRow, &[i64])>, site: bool) -> ApiResult<Parsed> {
    let row = current.map(|c| c.0);
    let text = |k: &str, fallback: Option<&str>, default: &str| -> String {
        match body.get(k).and_then(Value::as_str) {
            Some(s) => s.trim().to_string(),
            None => fallback.unwrap_or(default).to_string(),
        }
    };
    let action = text("action", row.map(|c| c.action.as_str()), "");
    if rules::Action::parse(&action).is_none() {
        return Err(ApiError::field("action", "Choose block, approve or allow."));
    }
    let kind = text("kind", row.map(|c| c.kind.as_str()), "command");
    let Some(k) = Kind::parse(&kind) else { return Err(ApiError::field("kind", "Choose command or regex.")) };
    let pattern = text("pattern", row.map(|c| c.pattern.as_str()), "");
    Matcher::new(k, &pattern).map_err(|m| ApiError::field("pattern", m))?;
    let who = text("who", row.map(|c| c.who.as_str()), "everyone");
    match Who::parse(&who) {
        Some(Who::Me) if site => return Err(ApiError::field("who", "A site-wide rule covers everyone or shared users.")),
        Some(_) => {}
        None if site => return Err(ApiError::field("who", "Choose everyone or sharees.")),
        None => return Err(ApiError::field("who", "Choose everyone, sharees or me.")),
    }
    let via = text("via", row.map(|c| c.via.as_str()), "all");
    if rules::Via::parse(&via).is_none() {
        return Err(ApiError::field("via", "Choose all, terminal or agents."));
    }
    let note = text("note", row.map(|c| c.note.as_str()), "");
    if note.chars().count() > NOTE_MAX {
        return Err(ApiError::field("note", format!("Keep the note under {NOTE_MAX} characters.")));
    }
    let flag = |k: &str, fallback: bool| -> ApiResult<bool> {
        match body.get(k) {
            None | Some(Value::Null) => Ok(fallback),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(ApiError::field(k, format!("{k} must be true or false"))),
        }
    };
    let enabled = flag("enabled", row.map(|c| c.enabled).unwrap_or(true))?;
    let all_tunnels = flag("all_tunnels", row.map(|c| c.all_tunnels).unwrap_or(true))?;
    let tunnel_ids = match body.get("tunnel_ids") {
        None | Some(Value::Null) => current.map(|c| c.1.to_vec()).unwrap_or_default(),
        Some(v) => id_list(v, "tunnel_ids", "tunnel")?,
    };
    let tunnel_ids = if all_tunnels { Vec::new() } else { tunnel_ids };
    if !all_tunnels && tunnel_ids.is_empty() {
        return Err(ApiError::field("tunnel_ids", "Pick at least one tunnel, or choose every tunnel."));
    }
    if tunnel_ids.len() > MAX_TUNNELS {
        return Err(ApiError::field("tunnel_ids", format!("Pick at most {MAX_TUNNELS} tunnels.")));
    }
    let approver_ids = parse_approvers(body, row, &action, &who)?;
    Ok(Parsed { action, kind, pattern, who, via, note, enabled, all_tunnels, tunnel_ids, approver_ids })
}

impl Parsed {
    fn new_rule<'a>(&'a self, scope: &'a str, user_id: Option<i64>, approvers_json: Option<&'a str>) -> NewRule<'a> {
        NewRule {
            scope,
            user_id,
            all_tunnels: self.all_tunnels,
            action: &self.action,
            kind: &self.kind,
            pattern: &self.pattern,
            who: &self.who,
            via: &self.via,
            note: &self.note,
            enabled: self.enabled,
            approver_ids: approvers_json,
        }
    }
}

/// 套用的隧道要合理：全站 = 存在的隧道；「只有我」= 看得到的；管別人的個人規則 = 自己管的（owner / ADMIN）。原本就在清單上
/// 而且「管誰」沒改的不再檢查（之後失去管理權的隧道只是不算數）。
/// Targets must make sense: site-wide = existing tunnels; "only me" = visible ones; a personal rule for other people =
/// tunnels I own or administer. Tunnels already listed are not re-checked while `who` is unchanged (a tunnel I stopped
/// managing just doesn't count).
async fn check_targets(state: &AppState, reach: &Reach, site: bool, p: &Parsed, current: Option<(&RuleRow, &[i64])>) -> ApiResult<()> {
    let kept: &[i64] = match current {
        Some((row, ids)) if row.who == p.who => ids,
        _ => &[],
    };
    for id in p.tunnel_ids.iter().filter(|id| !kept.contains(id)) {
        if site {
            if db::tunnels::by_id(&state.db, *id).await?.is_none() {
                return Err(ApiError::field("tunnel_ids", format!("Tunnel #{id} doesn't exist.")));
            }
            continue;
        }
        let Some(t) = reach.visible.iter().find(|t| t.id == *id) else {
            return Err(ApiError::field("tunnel_ids", format!("Tunnel #{id} isn't one you can use.")));
        };
        if p.who != "me" && !reach.manage.contains(id) {
            return Err(ApiError::field(
                "tunnel_ids",
                format!("{} isn't yours to set rules on for other people: you need to own it or be an Admin there. Use \"only me\" to guard just your own commands.", t.host_friendly_name),
            ));
        }
    }
    Ok(())
}

/// 個人規則可以指定的核准人：我管的每條隧道的 owner 與 ADMIN sharee（加上我自己）。
/// Who a personal rule may name: the owners and ADMIN sharees of every tunnel I manage (me included).
async fn personal_candidates(state: &AppState, me: &User, reach: &Reach) -> ApiResult<Vec<i64>> {
    let mut ids = vec![me.id];
    for t in reach.visible.iter().filter(|t| reach.manage.contains(&t.id)) {
        ids.extend(rules::default_approvers(state, t).await);
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// 核准人要合理：全站 = 任何啟用中的帳號；個人 = 我管的隧道的 owner / ADMIN（或管理員）；原本就指定的人不再檢查。
/// Approvers must make sense: site-wide = any active account; personal = owners / ADMINs of tunnels I manage (or
/// admins); people already named are not re-checked.
async fn check_approvers(state: &AppState, me: &User, reach: &Reach, site: bool, ids: &[i64], current: &[i64]) -> ApiResult<()> {
    let new: Vec<i64> = ids.iter().copied().filter(|id| !current.contains(id)).collect();
    if new.is_empty() {
        return Ok(());
    }
    let allowed = if site { None } else { Some(personal_candidates(state, me, reach).await?) };
    for id in new {
        let user = db::users::by_id(&state.db, id).await?.filter(|u| u.is_active);
        let Some(user) = user else { return Err(ApiError::field("approver_ids", format!("User #{id} is not an active account."))) };
        if let Some(allowed) = &allowed {
            if !allowed.contains(&id) && !user.is_superuser {
                return Err(ApiError::field("approver_ids", format!("{} can't approve here: approvers must own or administer the tunnels this rule covers.", user.username)));
            }
        }
    }
    Ok(())
}

/// 「block `rm -rf` (everyone, terminal + agents)」：Logs 用。/ A rule in words, for the Logs.
fn rule_words(r: &RuleRow) -> String {
    let via = match r.via.as_str() {
        "terminal" => "web terminal",
        "agents" => "MCP agents",
        _ => "web terminal and MCP agents",
    };
    let who = match r.who.as_str() {
        "sharees" => "shared users",
        "me" => "only themselves",
        _ => "everyone",
    };
    let off = if r.enabled { "" } else { ", off" };
    let what = match r.action.as_str() {
        "block" => "block",
        "allow" => "allow (exception)",
        _ => "needs approval",
    };
    let approvers = match rules::parse_approver_ids(r.approver_ids.as_deref()).len() {
        0 => String::new(),
        n => format!(", {n} named approver{}", if n == 1 { "" } else { "s" }),
    };
    format!("{what} `{}` ({who}, {via}{approvers}{off})", r.pattern)
}

/// 規則 JSON：核准人的名字、套用的隧道（看不到的只算數量），自己的個人規則再說每條隧道算不算數。
/// Rules as JSON: approvers' names, the tunnels covered (ones the viewer can't see only counted), and for the viewer's
/// own personal rules whether each tunnel counts.
async fn rules_json(state: &AppState, me: &User, reach: &Reach, rows: &[RuleRow]) -> ApiResult<Vec<Value>> {
    let ids: Vec<i64> = rows.iter().flat_map(|r| rules::parse_approver_ids(r.approver_ids.as_deref())).collect();
    let names = db::users::usernames_for(&state.db, &ids).await?;
    let limited: Vec<i64> = rows.iter().filter(|r| !r.all_tunnels).map(|r| r.id).collect();
    let map = db::command_rules::tunnel_map(&state.db, &limited).await?;
    Ok(rows
        .iter()
        .map(|r| {
            let mut v = rules::rule_json(r);
            let mine = !r.is_site() && r.user_id == Some(me.id);
            v["mine"] = json!(mine);
            v["approvers"] = rules::parse_approver_ids(r.approver_ids.as_deref())
                .into_iter()
                .map(|id| json!({ "id": id, "username": names.get(&id).cloned().unwrap_or_else(|| format!("#{id}")) }))
                .collect();
            let mut hidden = 0;
            let mut tunnels = Vec::new();
            for id in map.get(&r.id).map(Vec::as_slice).unwrap_or(&[]) {
                match reach.names.get(id) {
                    Some(name) => {
                        let mut t = json!({ "id": id, "name": name });
                        if mine {
                            t["applies"] = json!(if r.who == "me" { reach.sees(*id) } else { reach.manage.contains(id) });
                        }
                        tunnels.push(t);
                    }
                    None => hidden += 1,
                }
            }
            tunnels.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
            v["tunnels"] = json!(tunnels);
            v["hidden_tunnels"] = json!(hidden);
            v
        })
        .collect())
}

fn briefs(ids: &[i64], names: &HashMap<i64, String>) -> Vec<Value> {
    let mut out: Vec<Value> = ids.iter().filter_map(|id| names.get(id).map(|n| json!({ "id": id, "username": n }))).collect();
    out.sort_by(|a, b| a["username"].as_str().unwrap_or("").to_lowercase().cmp(&b["username"].as_str().unwrap_or("").to_lowercase()));
    out
}

/// Logs：全站與管所有隧道的規則寫成站上的事件；指定隧道的寫進那幾條隧道的 Logs；「只有我」的不進隧道 Logs（自己的護欄）。
/// The Logs: site-wide and every-tunnel rules become site events; rules for picked tunnels go into those tunnels' Logs;
/// "only me" rules stay out of tunnel Logs (a personal guard).
async fn log_rule(state: &AppState, me: &User, verb: &str, r: &RuleRow) {
    let scope = if r.is_site() { "a site-wide rule" } else { "a personal rule" };
    let tunnels = if r.all_tunnels || r.who == "me" { Vec::new() } else { db::command_rules::tunnel_map(&state.db, &[r.id]).await.ok().and_then(|mut m| m.remove(&r.id)).unwrap_or_default() };
    let reach = if r.all_tunnels {
        if r.is_site() { " for every tunnel" } else { " for every tunnel they manage" }
    } else {
        ""
    };
    let line = format!("{} {verb} {scope}{reach}: {}", me.username, rule_words(r));
    if tunnels.is_empty() {
        state.gateway.event("command_rule", None, None, None, line).await;
        return;
    }
    for id in tunnels.into_iter().take(20) {
        let port = db::tunnels::by_id(&state.db, id).await.ok().flatten().and_then(|t| u16::try_from(t.reverse_port).ok());
        state.gateway.event("command_rule", None, port, Some(id), line.clone()).await;
    }
}

/// 我的個人規則與全站規則（大家都看得到全站的——它們也管你），加上表單要的隧道與核准人候選；管理員多拿所有隧道與帳號。
/// My personal rules and the site-wide ones (everyone reads them: they apply to you too), plus the tunnels and approver
/// candidates the form needs; admins also get every tunnel and account.
#[utoipa::path(get, path = "/api/command-rules", tag = "Command Rules", security(("bearer" = [])), responses((status = 200, body = super::schemas::CommandRuleList)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let reach = Reach::of(&state, &me).await?;
    let mine = db::command_rules::user_rules(&state.db, me.id).await?;
    let site = db::command_rules::site_rules(&state.db).await?;
    let candidates = personal_candidates(&state, &me, &reach).await?;
    let names = db::users::usernames_for(&state.db, &candidates).await?;
    // 全站規則的核准人候選與隧道：管理員才拿得到（跟 /api/user/users 一樣）。/ Site candidates and tunnels: admins only.
    let (site_candidates, site_tunnels) = if me.is_superuser {
        let users: Vec<Value> = db::users::active_brief(&state.db).await?.into_iter().map(|(id, username)| json!({ "id": id, "username": username })).collect();
        let mut all: Vec<(&i64, &String)> = reach.names.iter().collect();
        all.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then(a.0.cmp(b.0)));
        (json!(users), json!(all.into_iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>()))
    } else {
        (json!([]), Value::Null)
    };
    Ok(Json(json!({
        "mine": rules_json(&state, &me, &reach, &mine).await?,
        "site": rules_json(&state, &me, &reach, &site).await?,
        "can_edit_site": me.is_superuser,
        "limit": MAX_RULES,
        "tunnels": reach.visible.iter().map(|t| json!({ "id": t.id, "name": t.host_friendly_name, "manage": reach.manage.contains(&t.id) })).collect::<Vec<_>>(),
        "approver_candidates": briefs(&candidates, &names),
        "site_approver_candidates": site_candidates,
        "site_tunnels": site_tunnels,
    })))
}

/// 新增規則：`scope` personal（預設，自己的）或 site（管理員）。/ Add a rule: `scope` personal (default, your own) or site (admins).
#[utoipa::path(post, path = "/api/command-rules", tag = "Command Rules", security(("bearer" = [])), request_body = super::schemas::CommandRuleInput, responses((status = 201, body = super::schemas::CommandRule), (status = 400, description = "{field: [message]}", body = Object), (status = 403, body = super::schemas::ErrorBody)))]
async fn create(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let site = match body.get("scope").and_then(Value::as_str).unwrap_or("personal") {
        "personal" | "user" => false,
        "site" => true,
        _ => return Err(ApiError::field("scope", "Choose personal or site.")),
    };
    if site && !me.is_superuser {
        return Err(ApiError::forbidden("Only administrators can change site-wide command rules."));
    }
    create_rule(&state, &me, site, &body).await
}

async fn create_rule(state: &AppState, me: &User, site: bool, body: &Value) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = parse_rule(body, None, site)?;
    let reach = Reach::of(state, me).await?;
    let existing = if site { db::command_rules::site_rules(&state.db).await? } else { db::command_rules::user_rules(&state.db, me.id).await? };
    if existing.len() >= MAX_RULES {
        return Err(ApiError::field("pattern", format!("There can be at most {MAX_RULES} rules here.")));
    }
    let lists = db::command_rules::tunnel_map(&state.db, &existing.iter().map(|r| r.id).collect::<Vec<_>>()).await?;
    let same = |r: &RuleRow| {
        r.action == p.action
            && r.kind == p.kind
            && r.pattern == p.pattern
            && r.who == p.who
            && r.via == p.via
            && r.all_tunnels == p.all_tunnels
            && lists.get(&r.id).map(Vec::as_slice).unwrap_or(&[]) == p.tunnel_ids.as_slice()
    };
    if existing.iter().any(same) {
        return Err(ApiError::field("pattern", "This rule already exists here."));
    }
    check_targets(state, &reach, site, &p, None).await?;
    check_approvers(state, me, &reach, site, &p.approver_ids, &[]).await?;
    let approvers = rules::approver_ids_json(&p.approver_ids);
    let (scope, owner) = if site { ("site", None) } else { ("user", Some(me.id)) };
    let row = db::command_rules::create_rule(&state.db, &p.new_rule(scope, owner, approvers.as_deref()), &p.tunnel_ids, me.id).await?;
    state.commands.invalidate();
    log_rule(state, me, "added", &row).await;
    Ok((StatusCode::CREATED, Json(rules_json(state, me, &reach, std::slice::from_ref(&row)).await?.pop().unwrap_or(Value::Null))))
}

/// 這條規則能不能改：全站 = 管理員；個人 = 寫它的人。看得到（它管到我看得到的隧道）但不能改 = 403，否則 404。
/// Who may change a rule: site-wide = admins; personal = its author. Visible (it covers a tunnel I can see) but not
/// mine = 403, anything else = 404.
async fn editable(state: &AppState, me: &User, rid: i64) -> ApiResult<(RuleRow, Vec<i64>)> {
    let row = db::command_rules::rule(&state.db, rid).await?.ok_or_else(rule_not_found)?;
    let tunnels = db::command_rules::tunnel_map(&state.db, &[rid]).await?.remove(&rid).unwrap_or_default();
    if row.is_site() {
        return if me.is_superuser { Ok((row, tunnels)) } else { Err(ApiError::forbidden("Only administrators can change site-wide command rules.")) };
    }
    if row.user_id == Some(me.id) {
        return Ok((row, tunnels));
    }
    let reach = Reach::of(state, me).await?;
    let visible = row.who != "me" && (row.all_tunnels || tunnels.iter().any(|t| reach.sees(*t)));
    if visible {
        Err(ApiError::forbidden("Only the person who wrote this rule can change it."))
    } else {
        Err(rule_not_found())
    }
}

/// 修改規則（只帶要改的欄位；範圍與主人不變）。/ Change a rule (send only the fields that change; scope and owner stay).
#[utoipa::path(patch, path = "/api/command-rules/{rid}", tag = "Command Rules", security(("bearer" = [])), params(("rid" = i64, Path, description = "Rule id")), request_body = super::schemas::CommandRuleInput, responses((status = 200, body = super::schemas::CommandRule), (status = 400, body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(me): AuthUser, Path(rid): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (row, tunnels) = editable(&state, &me, rid).await?;
    let site = row.is_site();
    let p = parse_rule(&body, Some((&row, &tunnels)), site)?;
    let reach = Reach::of(&state, &me).await?;
    check_targets(&state, &reach, site, &p, Some((&row, &tunnels))).await?;
    check_approvers(&state, &me, &reach, site, &p.approver_ids, &rules::parse_approver_ids(row.approver_ids.as_deref())).await?;
    let approvers = rules::approver_ids_json(&p.approver_ids);
    let scope = if site { "site" } else { "user" };
    let row = db::command_rules::update_rule(&state.db, rid, &p.new_rule(scope, row.user_id, approvers.as_deref()), &p.tunnel_ids).await?.ok_or_else(rule_not_found)?;
    state.commands.invalidate();
    log_rule(&state, &me, "changed", &row).await;
    Ok(Json(rules_json(&state, &me, &reach, std::slice::from_ref(&row)).await?.pop().unwrap_or(Value::Null)))
}

/// 刪除規則。/ Delete a rule.
#[utoipa::path(delete, path = "/api/command-rules/{rid}", tag = "Command Rules", security(("bearer" = [])), params(("rid" = i64, Path, description = "Rule id")), responses((status = 204), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(me): AuthUser, Path(rid): Path<i64>) -> ApiResult<StatusCode> {
    let (row, _) = editable(&state, &me, rid).await?;
    log_rule(&state, &me, "removed", &row).await;
    db::command_rules::delete_rule(&state.db, rid).await?;
    state.commands.invalidate();
    Ok(StatusCode::NO_CONTENT)
}

/// 一條隧道上現在算數的規則：管理它的人（owner / ADMIN）寫的個人規則、我自己「只有我」的規則，加上也套用到它的全站規則。
/// The rules in force on a tunnel: personal rules by the people who own or administer it, my own "only me" rules, plus
/// the site-wide rules that cover it.
#[utoipa::path(get, path = "/api/reverse/server/{id}/command-rules", tag = "Command Rules", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::TunnelCommandRules), (status = 404, body = super::schemas::ErrorBody)))]
async fn tunnel_list(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, can_edit) = tunnel_access(&state, &me, id).await?;
    let managers = rules::default_approvers(&state, &t).await;
    let rows = db::command_rules::rules_targeting(&state.db, t.id).await?;
    let (site, personal): (Vec<RuleRow>, Vec<RuleRow>) = rows.into_iter().partition(RuleRow::is_site);
    let personal: Vec<RuleRow> = personal
        .into_iter()
        .filter(|r| match (r.who.as_str(), r.user_id) {
            ("me", owner) => owner == Some(me.id),
            (_, Some(owner)) => managers.contains(&owner),
            _ => false,
        })
        .collect();
    let reach = Reach::of(&state, &me).await?;
    let candidates = if can_edit {
        let mut ids = managers.clone();
        if me.is_superuser && !ids.contains(&me.id) {
            ids.push(me.id);
        }
        let names = db::users::usernames_for(&state.db, &ids).await?;
        briefs(&ids, &names)
    } else {
        Vec::new()
    };
    Ok(Json(json!({
        "tunnel": { "id": t.id, "name": t.host_friendly_name },
        "rules": rules_json(&state, &me, &reach, &personal).await?,
        "site_rules": rules_json(&state, &me, &reach, &site).await?,
        "can_edit": can_edit,
        "can_edit_site": me.is_superuser,
        "approver_candidates": candidates,
    })))
}

/// 在這條隧道加一條自己的規則（只套用它）：管別人的要是 owner / ADMIN，「只有我」看得到就行。
/// Add a personal rule for this tunnel alone: owner / ADMIN for rules about other people, anyone who sees it for "only me".
#[utoipa::path(post, path = "/api/reverse/server/{id}/command-rules", tag = "Command Rules", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::CommandRuleInput, responses((status = 201, body = super::schemas::CommandRule), (status = 400, body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn tunnel_create(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (t, can_edit) = tunnel_access(&state, &me, id).await?;
    let only_me = body.get("who").and_then(Value::as_str) == Some("me");
    if !can_edit && !only_me {
        return Err(ApiError::forbidden("Only the tunnel owner or an ADMIN sharee can make rules for other people here."));
    }
    let mut body = body;
    if let Some(obj) = body.as_object_mut() {
        obj.insert("all_tunnels".into(), json!(false));
        obj.insert("tunnel_ids".into(), json!([t.id]));
        obj.remove("scope");
    }
    create_rule(&state, &me, false, &body).await
}

/// 一個範圍的結果 JSON：`hit` = 符合的擋下 / 要核准規則（被豁免也列）、`allowed_by` = 豁免它的允許規則。
/// One scope's verdict as JSON: `hit` = the block / approve rule that matched (even when exempted), `allowed_by` = the allow.
fn scope_json(v: &matcher::ScopeVerdict<'_>) -> Value {
    json!({ "hit": v.hit.map(rules::matched_json), "allowed_by": v.allowed_by.map(rules::matched_json), "exempted": v.hit.is_some() && v.allowed_by.is_some() })
}

/// 試一個指令：對 owner / ADMIN、對被分享的人各是什麼結果（其中一個是你；含兩個範圍各自的結果、豁免它的允許規則、誰核准）；
/// 帶 `tunnel_id` = 那條隧道上的規則，沒帶 = 全站管所有隧道的規則加上你自己管所有隧道的規則；`scope: "site"` 只看全站的。
/// 帶 `rule` 時也看這條（還沒存的）規則符不符合。
/// Try a command: the verdict for owners / ADMINs and for shared users (one of them is you; each scope's outcome, the
/// allow rule that exempted it, who approves). With `tunnel_id` = that tunnel's rules; without = the site's and your
/// own every-tunnel rules; `scope: "site"` = site-wide rules only. With `rule`, whether that (unsaved) rule matches too.
#[utoipa::path(post, path = "/api/command-rules/check", tag = "Command Rules", security(("bearer" = [])), request_body = super::schemas::CommandCheckInput, responses((status = 200, body = super::schemas::CommandCheckResult), (status = 400, body = Object), (status = 404, body = super::schemas::ErrorBody)))]
async fn check(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let command = body.get("command").and_then(Value::as_str).unwrap_or("").to_string();
    if command.chars().count() > matcher::MAX_LINE {
        return Err(ApiError::field("command", "That command is too long to check."));
    }
    let source = match body.get("source").and_then(Value::as_str) {
        Some("agent") => Source::Agent,
        _ => Source::Terminal,
    };
    let site_only = body.get("scope").and_then(Value::as_str) == Some("site");
    let tunnel_id = body.get("tunnel_id").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    let (rule_set, me_approver, tunnel, managers): (Vec<Rule>, bool, Option<Tunnel>, Vec<i64>) = match tunnel_id {
        Some(id) => {
            let (t, approver) = tunnel_access(&state, &me, id).await?;
            let set = rules::rules_for(&state, t.id).await.iter().filter(|r| !site_only || r.owner.is_none()).cloned().collect();
            let managers = rules::default_approvers(&state, &t).await;
            (set, approver, Some(t), managers)
        }
        // 沒選隧道：想成一條你管的隧道（你自己的規則才算數）。/ No tunnel: think of a tunnel you manage.
        None => {
            let mut rows: Vec<RuleRow> = db::command_rules::site_rules(&state.db).await?.into_iter().filter(|r| r.all_tunnels).collect();
            if !site_only {
                rows.extend(db::command_rules::user_rules(&state.db, me.id).await?.into_iter().filter(|r| r.all_tunnels));
            }
            (rows.iter().filter_map(rules::compile).collect(), !site_only, None, if site_only { Vec::new() } else { vec![me.id] })
        }
    };
    let lines = vec![command.clone()];
    let mut verdicts = Vec::with_capacity(2);
    for approver in [true, false] {
        let ctx = Ctx { approver, user: (approver == me_approver).then_some(me.id), managers: &managers, source };
        let v = matcher::evaluate(&rule_set, &lines, &ctx);
        let decision = v.decision();
        // 誰核准：規則指定的人（「只有我」= 寫它的人），否則這條隧道的 owner + ADMIN（沒選隧道 = 不知道是誰，`default: true`）。
        // Who approves: the rule's own (only me = its author), else this tunnel's owner + ADMIN (no tunnel = unknown, `default: true`).
        let approvers = match decision {
            Some(r) if r.action == Action::Approve => {
                let ids = match &tunnel {
                    Some(t) => rules::approvers_for(&state, t, r).await,
                    None if r.who == Who::Me => r.owner.into_iter().collect(),
                    None => r.approver_ids.clone(),
                };
                let names = db::users::usernames_for(&state.db, &ids).await?;
                json!({
                    "default": r.approver_ids.is_empty() && r.who != Who::Me,
                    "users": ids.iter().map(|id| json!({ "id": id, "username": names.get(id).cloned().unwrap_or_else(|| format!("#{id}")) })).collect::<Vec<_>>(),
                })
            }
            _ => Value::Null,
        };
        verdicts.push(json!({
            "action": decision.map(|r| r.action.as_str()).unwrap_or("allow"),
            "rule": decision.map(rules::matched_json),
            "allowed_by": v.allowed_by().map(rules::matched_json),
            "site": scope_json(&v.site),
            "personal": scope_json(&v.personal),
            "approvers": approvers,
        }));
    }
    let for_sharees = verdicts.pop().unwrap_or(Value::Null);
    let for_approvers = verdicts.pop().unwrap_or(Value::Null);
    let mut out = json!({
        "commands": matcher::commands(&command).into_iter().map(|c| json!({ "program": c.program, "args": c.args })).collect::<Vec<_>>(),
        "for_approvers": for_approvers,
        "for_sharees": for_sharees,
        "you_approve": me_approver,
    });
    if let Some(draft) = body.get("rule").filter(|v| v.is_object()) {
        let kind = draft.get("kind").and_then(Value::as_str).and_then(Kind::parse).unwrap_or(Kind::Command);
        let pattern = draft.get("pattern").and_then(Value::as_str).unwrap_or("");
        out["draft"] = match Matcher::new(kind, pattern) {
            Ok(m) => json!({ "matches": m.matches(&command, &matcher::commands(&command)), "error": null }),
            Err(e) => json!({ "matches": false, "error": e }),
        };
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct RequestQuery {
    /// `pending`（預設全部）。/ `pending` for waiting requests only (default: everything).
    pub status: Option<String>,
    pub tunnel_id: Option<i64>,
    /// 最多幾筆（預設 100，最多 500）。/ How many (default 100, max 500).
    pub limit: Option<i64>,
}

/// 我能決定的（owner / ADMIN 的隧道）加上我自己的；管理員看全部。新的在前。
/// What I can decide (tunnels I own / ADMIN) plus my own; admins see everything. Newest first.
#[utoipa::path(get, path = "/api/command-requests", tag = "Command Rules", security(("bearer" = [])), params(RequestQuery), responses((status = 200, body = super::schemas::CommandRequestList)))]
async fn requests(State(state): State<AppState>, AuthUser(me): AuthUser, Query(q): Query<RequestQuery>) -> ApiResult<Json<Value>> {
    let visible = db::tunnels::visible_to(&state.db, me.id).await?;
    let (mine, _) = db::sharing::permission_context(&state.db, me.id).await?;
    let approves: HashMap<i64, &Tunnel> = visible
        .iter()
        .filter(|t| permissions::effective(me.id, t.user_id, mine.get(&t.id).map(String::as_str)).is_some_and(|e| e.satisfies(Permission::Admin)))
        .map(|t| (t.id, t))
        .collect();
    let names: HashMap<i64, String> = if me.is_superuser {
        db::tunnels::all(&state.db).await?.into_iter().map(|t| (t.id, t.host_friendly_name)).collect()
    } else {
        visible.iter().map(|t| (t.id, t.host_friendly_name.clone())).collect()
    };
    let scope: Vec<i64> = if me.is_superuser { names.keys().copied().collect() } else { approves.keys().copied().collect() };
    let pending_only = q.status.as_deref() == Some("pending");
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let rows = db::command_rules::list(&state.db, &scope, me.id, q.tunnel_id, pending_only, limit).await?;
    // 規則點名我核准、但我看不到那條隧道：名字還是要給（核准卡片上要顯示在哪裡跑）。
    // Named as an approver on a tunnel I can't otherwise see: still show its name (the approval card says where).
    let mut names = names;
    for e in &rows {
        if !names.contains_key(&e.tunnel_id) {
            if let Some(t) = db::tunnels::by_id(&state.db, e.tunnel_id).await? {
                names.insert(t.id, t.host_friendly_name);
            }
        }
    }
    let items: Vec<Value> = rows
        .iter()
        .map(|e| {
            let mut v = rules::event_json(e, names.get(&e.tunnel_id).map(String::as_str));
            let pending = e.status == "pending";
            // 規則指定了核准人就只有他們；否則 owner / ADMIN。/ The rule's own approvers when it named some, else owner / ADMIN.
            let named = rules::parse_approver_ids(e.approver_ids.as_deref());
            let decides = if named.is_empty() { approves.contains_key(&e.tunnel_id) } else { named.contains(&me.id) };
            v["can_decide"] = json!(pending && decides);
            v["can_cancel"] = json!(pending && e.user_id == me.id);
            v
        })
        .collect();
    let pending = items.iter().filter(|v| v["can_decide"] == json!(true)).count();
    Ok(Json(json!({ "requests": items, "pending": pending })))
}

fn decide_error(e: DecideError) -> ApiError {
    match e {
        DecideError::NotFound => ApiError::not_found("Request not found"),
        DecideError::NotApprover => coded(StatusCode::FORBIDDEN, "not_approver", "Only this request's approvers (the tunnel owner and ADMIN sharees, or the people the rule names) can decide on it."),
        DecideError::NotRequester => coded(StatusCode::FORBIDDEN, "not_requester", "Only the person who asked can withdraw this request."),
        DecideError::AlreadyDecided(s) => coded(StatusCode::CONFLICT, "already_decided", format!("This request was already {s}.")),
        DecideError::Db(e) => e.into(),
    }
}

async fn decided(state: &AppState, row: db::command_rules::EventRow) -> ApiResult<Json<Value>> {
    let name = db::tunnels::by_id(&state.db, row.tunnel_id).await?.map(|t| t.host_friendly_name);
    Ok(Json(rules::event_json(&row, name.as_deref())))
}

/// 核准（owner / ADMIN；agent 用你的身分跑的指令也要你按）。/ Approve (owner / ADMIN; your own agent's commands too).
#[utoipa::path(post, path = "/api/command-requests/{id}/approve", tag = "Command Rules", security(("bearer" = [])), params(("id" = i64, Path, description = "Request id")), responses((status = 200, body = super::schemas::CommandRequest), (status = 403, description = "not_approver", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "already_decided", body = super::schemas::ErrorBody)))]
async fn approve(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row = rules::decide(&state, id, true, &me, "").await.map_err(decide_error)?;
    decided(&state, row).await
}

/// 拒絕，可以附原因。/ Deny, optionally with a reason.
#[utoipa::path(post, path = "/api/command-requests/{id}/deny", tag = "Command Rules", security(("bearer" = [])), params(("id" = i64, Path, description = "Request id")), request_body = super::schemas::CommandDecision, responses((status = 200, body = super::schemas::CommandRequest), (status = 403, description = "not_approver", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "already_decided", body = super::schemas::ErrorBody)))]
async fn deny(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let reason = body.get("reason").and_then(Value::as_str).unwrap_or("");
    let row = rules::decide(&state, id, false, &me, reason).await.map_err(decide_error)?;
    decided(&state, row).await
}

/// 申請人撤回。/ The requester withdraws.
#[utoipa::path(post, path = "/api/command-requests/{id}/cancel", tag = "Command Rules", security(("bearer" = [])), params(("id" = i64, Path, description = "Request id")), responses((status = 200, body = super::schemas::CommandRequest), (status = 403, description = "not_requester", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody), (status = 409, description = "already_decided", body = super::schemas::ErrorBody)))]
async fn cancel(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row = rules::cancel_by_requester(&state, id, &me).await.map_err(decide_error)?;
    decided(&state, row).await
}
