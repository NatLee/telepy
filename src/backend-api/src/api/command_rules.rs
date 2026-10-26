//! 指令規則 API：全站規則（管理員改、大家看得到）、隧道規則（owner / ADMIN 改、看得到隧道的人都看得到）、
//! 試跑一個指令，以及核准申請的清單與核准 / 拒絕 / 撤回。「要核准」規則可以指定核准人（`approver_ids`）：隧道規則只能
//! 指定 owner / ADMIN sharee / 管理員，全站規則任何啟用中的帳號都行。
//! Command rules API: site-wide rules (admins edit, everyone reads), tunnel rules (owner / ADMIN edit, anyone who
//! sees the tunnel reads), trying a command, and the approval requests with approve / deny / withdraw. An "approve"
//! rule may name its approvers (`approver_ids`): a tunnel rule only the owner / ADMIN sharees / admins, a site-wide
//! rule any active account.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::command_rules::{self as rules, matcher, Action, DecideError, Kind, Matcher, Source};
use crate::db::{self, command_rules::{NewRule, RuleRow}, tunnels::Tunnel, users::User};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;

/// 每個範圍（全站 / 一條隧道）最多幾條規則。/ Rules per scope at most.
pub const MAX_RULES: usize = 100;
const NOTE_MAX: usize = 300;
/// 一條規則最多指定幾位核准人。/ Approvers a rule may name at most.
pub const MAX_APPROVERS: usize = 20;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(site_list, site_create))
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

/// 看得到這條隧道嗎；能不能改它的規則（owner / ADMIN）。/ Whether the tunnel is visible, and whether its rules can be edited.
async fn tunnel_access(state: &AppState, me: &User, id: i64) -> ApiResult<(Tunnel, bool)> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(tunnel_not_found)?;
    let eff = permissions::effective_for(&state.db, me.id, &t).await?.ok_or_else(tunnel_not_found)?;
    Ok((t, eff.satisfies(Permission::Admin)))
}

/// 表單 → 一列規則的欄位（含比對式檢查）。/ The form → a rule's fields (pattern included).
struct Parsed {
    action: String,
    kind: String,
    pattern: String,
    who: String,
    via: String,
    note: String,
    enabled: bool,
    /// 已排序去重；空 = 預設核准人。/ Sorted, de-duplicated; empty = the default approvers.
    approver_ids: Vec<i64>,
}

/// `approver_ids`：沒帶 = 保留現在的（新增時 = 空）；null / [] = 預設核准人。只有「要核准」規則留著。
/// `approver_ids`: omitted = keep the current list (empty on create); null / [] = default. Kept for approve rules only.
fn parse_approvers(body: &Value, current: Option<&RuleRow>, action: &str) -> ApiResult<Vec<i64>> {
    let ids = match body.get("approver_ids") {
        None => rules::parse_approver_ids(current.and_then(|c| c.approver_ids.as_deref())),
        Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut ids = Vec::with_capacity(items.len());
            for v in items {
                let Some(id) = v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())) else {
                    return Err(ApiError::field("approver_ids", "approver_ids must be a list of user ids."));
                };
                ids.push(id);
            }
            ids.sort_unstable();
            ids.dedup();
            ids
        }
        Some(_) => return Err(ApiError::field("approver_ids", "approver_ids must be a list of user ids.")),
    };
    if ids.len() > MAX_APPROVERS {
        return Err(ApiError::field("approver_ids", format!("Name at most {MAX_APPROVERS} approvers.")));
    }
    // 擋下 / 允許用不到核准人；默默清掉，免得之後改成「要核准」時冒出舊名單。/ Block / allow rules have no approvers.
    Ok(if action == "approve" { ids } else { Vec::new() })
}

/// 核准人要是這條隧道的 owner / ADMIN sharee / 管理員（全站規則：任何啟用中的帳號）。
/// Approvers must be the tunnel's owner / ADMIN sharees / admins (site rules: any active account).
async fn check_approvers(state: &AppState, tunnel: Option<&Tunnel>, ids: &[i64]) -> ApiResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let allowed: Option<Vec<i64>> = match tunnel {
        Some(t) => Some(rules::default_approvers(state, t).await),
        None => None,
    };
    for id in ids {
        let user = db::users::by_id(&state.db, *id).await?.filter(|u| u.is_active);
        let Some(user) = user else { return Err(ApiError::field("approver_ids", format!("User #{id} is not an active account."))) };
        if let Some(allowed) = &allowed {
            if !allowed.contains(id) && !user.is_superuser {
                return Err(ApiError::field("approver_ids", format!("{} can't approve here: approvers must be the tunnel owner, an Admin sharee or a site admin.", user.username)));
            }
        }
    }
    Ok(())
}

fn parse_rule(body: &Value, current: Option<&RuleRow>) -> ApiResult<Parsed> {
    let text = |k: &str, fallback: Option<&str>, default: &str| -> String {
        match body.get(k).and_then(Value::as_str) {
            Some(s) => s.trim().to_string(),
            None => fallback.unwrap_or(default).to_string(),
        }
    };
    let action = text("action", current.map(|c| c.action.as_str()), "");
    if rules::Action::parse(&action).is_none() {
        return Err(ApiError::field("action", "Choose block, approve or allow."));
    }
    let kind = text("kind", current.map(|c| c.kind.as_str()), "command");
    let Some(k) = Kind::parse(&kind) else { return Err(ApiError::field("kind", "Choose command or regex.")) };
    let pattern = text("pattern", current.map(|c| c.pattern.as_str()), "");
    Matcher::new(k, &pattern).map_err(|m| ApiError::field("pattern", m))?;
    let who = text("who", current.map(|c| c.who.as_str()), "everyone");
    if rules::Who::parse(&who).is_none() {
        return Err(ApiError::field("who", "Choose everyone or sharees."));
    }
    let via = text("via", current.map(|c| c.via.as_str()), "all");
    if rules::Via::parse(&via).is_none() {
        return Err(ApiError::field("via", "Choose all, terminal or agents."));
    }
    let note = text("note", current.map(|c| c.note.as_str()), "");
    if note.chars().count() > NOTE_MAX {
        return Err(ApiError::field("note", format!("Keep the note under {NOTE_MAX} characters.")));
    }
    let enabled = match body.get("enabled") {
        None | Some(Value::Null) => current.map(|c| c.enabled).unwrap_or(true),
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(ApiError::field("enabled", "enabled must be true or false")),
    };
    let approver_ids = parse_approvers(body, current, &action)?;
    Ok(Parsed { action, kind, pattern, who, via, note, enabled, approver_ids })
}

impl Parsed {
    fn new_rule<'a>(&'a self, tunnel_id: Option<i64>, approvers_json: Option<&'a str>) -> NewRule<'a> {
        NewRule { tunnel_id, action: &self.action, kind: &self.kind, pattern: &self.pattern, who: &self.who, via: &self.via, note: &self.note, enabled: self.enabled, approver_ids: approvers_json }
    }
}

/// 「block `rm -rf` (everyone, terminal + agents)」：Logs 用。/ A rule in words, for the Logs.
fn rule_words(r: &RuleRow) -> String {
    let via = match r.via.as_str() {
        "terminal" => "web terminal",
        "agents" => "MCP agents",
        _ => "web terminal and MCP agents",
    };
    let who = if r.who == "sharees" { "shared users" } else { "everyone" };
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

/// 規則 JSON 加上核准人的名字（一次查完）。/ Rules as JSON with the approvers' names (one lookup).
async fn rules_json(state: &AppState, rows: &[RuleRow]) -> ApiResult<Vec<Value>> {
    let ids: Vec<i64> = rows.iter().flat_map(|r| rules::parse_approver_ids(r.approver_ids.as_deref())).collect();
    let names = db::users::usernames_for(&state.db, &ids).await?;
    Ok(rows.iter().map(|r| rule_json_named(r, &names)).collect())
}

fn rule_json_named(r: &RuleRow, names: &HashMap<i64, String>) -> Value {
    let mut v = rules::rule_json(r);
    v["approvers"] = rules::parse_approver_ids(r.approver_ids.as_deref())
        .into_iter()
        .map(|id| json!({ "id": id, "username": names.get(&id).cloned().unwrap_or_else(|| format!("#{id}")) }))
        .collect();
    v
}

async fn one_rule_json(state: &AppState, r: &RuleRow) -> ApiResult<Value> {
    Ok(rules_json(state, std::slice::from_ref(r)).await?.pop().unwrap_or(Value::Null))
}

/// 隧道規則可以指定的核准人：owner 與 ADMIN sharee（管理員也可以把自己加進去）。
/// Who a tunnel rule may name: the owner and ADMIN sharees (an admin may add themselves too).
async fn tunnel_candidates(state: &AppState, me: &User, t: &Tunnel) -> ApiResult<Vec<Value>> {
    let mut ids = rules::default_approvers(state, t).await;
    if me.is_superuser && !ids.contains(&me.id) {
        ids.push(me.id);
    }
    let names = db::users::usernames_for(&state.db, &ids).await?;
    Ok(ids.into_iter().filter_map(|id| names.get(&id).map(|n| json!({ "id": id, "username": n }))).collect())
}

async fn log_rule(state: &AppState, me: &User, verb: &str, r: &RuleRow, tunnel: Option<&Tunnel>) {
    let scope = match tunnel {
        Some(t) => format!("a rule on {}", t.host_friendly_name),
        None => "a site-wide rule".to_string(),
    };
    state
        .gateway
        .event("command_rule", None, tunnel.and_then(|t| u16::try_from(t.reverse_port).ok()), tunnel.map(|t| t.id), format!("{} {verb} {scope}: {}", me.username, rule_words(r)))
        .await;
}

/// 全站規則（大家都看得到——它們也管你）。/ Site-wide rules (everyone can read them: they apply to you too).
#[utoipa::path(get, path = "/api/command-rules", tag = "Command Rules", security(("bearer" = [])), responses((status = 200, body = super::schemas::CommandRuleList)))]
async fn site_list(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let rows = db::command_rules::rules_for(&state.db, None).await?;
    // 核准人候選：管理員才拿得到全站名單（跟 /api/user/users 一樣）。/ Candidates: admins only, like /api/user/users.
    let candidates: Vec<Value> = if me.is_superuser {
        db::users::active_brief(&state.db).await?.into_iter().map(|(id, username)| json!({ "id": id, "username": username })).collect()
    } else {
        Vec::new()
    };
    Ok(Json(json!({ "rules": rules_json(&state, &rows).await?, "can_edit": me.is_superuser, "approver_candidates": candidates })))
}

/// 新增全站規則（管理員）。/ Add a site-wide rule (admins).
#[utoipa::path(post, path = "/api/command-rules", tag = "Command Rules", security(("bearer" = [])), request_body = super::schemas::CommandRuleInput, responses((status = 201, body = super::schemas::CommandRule), (status = 400, description = "{field: [message]}", body = Object), (status = 403, body = super::schemas::ErrorBody)))]
async fn site_create(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Only administrators can change site-wide command rules."));
    }
    create_rule(&state, &me, None, &body).await
}

async fn create_rule(state: &AppState, me: &User, tunnel: Option<&Tunnel>, body: &Value) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = parse_rule(body, None)?;
    let tunnel_id = tunnel.map(|t| t.id);
    let existing = db::command_rules::rules_for(&state.db, tunnel_id).await?;
    if existing.len() >= MAX_RULES {
        return Err(ApiError::field("pattern", format!("There can be at most {MAX_RULES} rules here.")));
    }
    if existing.iter().any(|r| r.action == p.action && r.kind == p.kind && r.pattern == p.pattern && r.who == p.who && r.via == p.via) {
        return Err(ApiError::field("pattern", "This rule already exists here."));
    }
    check_approvers(state, tunnel, &p.approver_ids).await?;
    let approvers = rules::approver_ids_json(&p.approver_ids);
    let row = db::command_rules::create_rule(&state.db, &p.new_rule(tunnel_id, approvers.as_deref()), me.id).await?;
    state.commands.invalidate();
    log_rule(state, me, "added", &row, tunnel).await;
    Ok((StatusCode::CREATED, Json(one_rule_json(state, &row).await?)))
}

/// 這條規則能不能改：全站 = 管理員；隧道 = owner / ADMIN。看不到的回 404。
/// Who may change a rule: site-wide = admins; tunnel = owner / ADMIN. Invisible ones are a 404.
async fn editable(state: &AppState, me: &User, rid: i64) -> ApiResult<(RuleRow, Option<Tunnel>)> {
    let nf = || ApiError::not_found("Rule not found");
    let row = db::command_rules::rule(&state.db, rid).await?.ok_or_else(nf)?;
    match row.tunnel_id {
        None if me.is_superuser => Ok((row, None)),
        None => Err(ApiError::forbidden("Only administrators can change site-wide command rules.")),
        Some(tid) => {
            let (t, can_edit) = tunnel_access(state, me, tid).await.map_err(|_| nf())?;
            if !can_edit {
                return Err(ApiError::forbidden("Only the tunnel owner or an ADMIN sharee can change its command rules."));
            }
            Ok((row, Some(t)))
        }
    }
}

/// 修改規則（只帶要改的欄位）。/ Change a rule (send only the fields that change).
#[utoipa::path(patch, path = "/api/command-rules/{rid}", tag = "Command Rules", security(("bearer" = [])), params(("rid" = i64, Path, description = "Rule id")), request_body = super::schemas::CommandRuleInput, responses((status = 200, body = super::schemas::CommandRule), (status = 400, body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(me): AuthUser, Path(rid): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let (row, tunnel) = editable(&state, &me, rid).await?;
    let p = parse_rule(&body, Some(&row))?;
    check_approvers(&state, tunnel.as_ref(), &p.approver_ids).await?;
    let approvers = rules::approver_ids_json(&p.approver_ids);
    let row = db::command_rules::update_rule(&state.db, rid, &p.new_rule(row.tunnel_id, approvers.as_deref())).await?.ok_or_else(|| ApiError::not_found("Rule not found"))?;
    state.commands.invalidate();
    log_rule(&state, &me, "changed", &row, tunnel.as_ref()).await;
    Ok(Json(one_rule_json(&state, &row).await?))
}

/// 刪除規則。/ Delete a rule.
#[utoipa::path(delete, path = "/api/command-rules/{rid}", tag = "Command Rules", security(("bearer" = [])), params(("rid" = i64, Path, description = "Rule id")), responses((status = 204), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(me): AuthUser, Path(rid): Path<i64>) -> ApiResult<StatusCode> {
    let (row, tunnel) = editable(&state, &me, rid).await?;
    db::command_rules::delete_rule(&state.db, rid).await?;
    state.commands.invalidate();
    log_rule(&state, &me, "removed", &row, tunnel.as_ref()).await;
    Ok(StatusCode::NO_CONTENT)
}

/// 一條隧道的規則，加上也適用的全站規則。/ A tunnel's rules plus the site-wide rules that apply as well.
#[utoipa::path(get, path = "/api/reverse/server/{id}/command-rules", tag = "Command Rules", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), responses((status = 200, body = super::schemas::TunnelCommandRules), (status = 404, body = super::schemas::ErrorBody)))]
async fn tunnel_list(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let (t, can_edit) = tunnel_access(&state, &me, id).await?;
    let own = db::command_rules::rules_for(&state.db, Some(t.id)).await?;
    let site = db::command_rules::rules_for(&state.db, None).await?;
    let candidates = if can_edit { tunnel_candidates(&state, &me, &t).await? } else { Vec::new() };
    Ok(Json(json!({
        "tunnel": { "id": t.id, "name": t.host_friendly_name },
        "rules": rules_json(&state, &own).await?,
        "site_rules": rules_json(&state, &site).await?,
        "can_edit": can_edit,
        "can_edit_site": me.is_superuser,
        "approver_candidates": candidates,
    })))
}

/// 新增隧道規則（owner / ADMIN）。/ Add a tunnel rule (owner / ADMIN).
#[utoipa::path(post, path = "/api/reverse/server/{id}/command-rules", tag = "Command Rules", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id")), request_body = super::schemas::CommandRuleInput, responses((status = 201, body = super::schemas::CommandRule), (status = 400, body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn tunnel_create(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (t, can_edit) = tunnel_access(&state, &me, id).await?;
    if !can_edit {
        return Err(ApiError::forbidden("Only the tunnel owner or an ADMIN sharee can change its command rules."));
    }
    create_rule(&state, &me, Some(&t), &body).await
}

/// 一個範圍的結果 JSON：`hit` = 符合的擋下 / 要核准規則（被豁免也列）、`allowed_by` = 豁免它的允許規則。
/// One scope's verdict as JSON: `hit` = the block / approve rule that matched (even when exempted), `allowed_by` = the allow.
fn scope_json(v: &matcher::ScopeVerdict<'_>) -> Value {
    json!({ "hit": v.hit.map(rules::matched_json), "allowed_by": v.allowed_by.map(rules::matched_json), "exempted": v.hit.is_some() && v.allowed_by.is_some() })
}

/// 試一個指令：對你、對被分享的人各是什麼結果（含兩個範圍各自的結果、豁免它的允許規則、誰核准）；帶 `rule` 時也看這條
/// （還沒存的）規則符不符合。
/// Try a command: the verdict for approvers and for shared users (each scope's outcome, the allow rule that exempted
/// it, who approves); with `rule`, whether that (unsaved) rule matches too.
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
    let (rule_set, me_approver, tunnel) = match body.get("tunnel_id").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))) {
        Some(id) => {
            let (t, approver) = tunnel_access(&state, &me, id).await?;
            (rules::rules_for(&state, t.id).await, approver, Some(t))
        }
        None => {
            let rows = db::command_rules::rules_for(&state.db, None).await?;
            (std::sync::Arc::new(rows.iter().filter_map(rules::compile).collect::<Vec<_>>()), false, None)
        }
    };
    let lines = vec![command.clone()];
    let mut verdicts = Vec::with_capacity(2);
    for approver in [true, false] {
        let v = matcher::evaluate(&rule_set, &lines, approver, source);
        let decision = v.decision();
        // 誰核准：規則指定的人，否則這條隧道的 owner + ADMIN（沒選隧道 = 不知道是誰，`default: true`）。
        // Who approves: the rule's own list, else this tunnel's owner + ADMIN (no tunnel = unknown, `default: true`).
        let approvers = match decision {
            Some(r) if r.action == Action::Approve => {
                let ids = match (&tunnel, r.approver_ids.is_empty()) {
                    (_, false) => r.approver_ids.clone(),
                    (Some(t), true) => rules::default_approvers(&state, t).await,
                    (None, true) => Vec::new(),
                };
                let names = db::users::usernames_for(&state.db, &ids).await?;
                json!({
                    "default": r.approver_ids.is_empty(),
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
            "tunnel": scope_json(&v.tunnel),
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
