//! 指令規則 API：全站規則（管理員改、大家看得到）、隧道規則（owner / ADMIN 改、看得到隧道的人都看得到）、
//! 試跑一個指令，以及核准申請的清單與核准 / 拒絕 / 撤回。
//! Command rules API: site-wide rules (admins edit, everyone reads), tunnel rules (owner / ADMIN edit, anyone who
//! sees the tunnel reads), trying a command, and the approval requests with approve / deny / withdraw.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::command_rules::{self as rules, matcher, DecideError, Kind, Matcher, Source};
use crate::db::{self, command_rules::{NewRule, RuleRow}, tunnels::Tunnel, users::User};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;

/// 每個範圍（全站 / 一條隧道）最多幾條規則。/ Rules per scope at most.
pub const MAX_RULES: usize = 100;
const NOTE_MAX: usize = 300;

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
        return Err(ApiError::field("action", "Choose block or approve."));
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
    Ok(Parsed { action, kind, pattern, who, via, note, enabled })
}

impl Parsed {
    fn new_rule(&self, tunnel_id: Option<i64>) -> NewRule<'_> {
        NewRule { tunnel_id, action: &self.action, kind: &self.kind, pattern: &self.pattern, who: &self.who, via: &self.via, note: &self.note, enabled: self.enabled }
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
    format!("{} `{}` ({who}, {via}{off})", if r.action == "block" { "block" } else { "needs approval" }, r.pattern)
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
    Ok(Json(json!({ "rules": rows.iter().map(rules::rule_json).collect::<Vec<_>>(), "can_edit": me.is_superuser })))
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
    let row = db::command_rules::create_rule(&state.db, &p.new_rule(tunnel_id), me.id).await?;
    state.commands.invalidate();
    log_rule(state, me, "added", &row, tunnel).await;
    Ok((StatusCode::CREATED, Json(rules::rule_json(&row))))
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
    let row = db::command_rules::update_rule(&state.db, rid, &p.new_rule(row.tunnel_id)).await?.ok_or_else(|| ApiError::not_found("Rule not found"))?;
    state.commands.invalidate();
    log_rule(&state, &me, "changed", &row, tunnel.as_ref()).await;
    Ok(Json(rules::rule_json(&row)))
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
    Ok(Json(json!({
        "tunnel": { "id": t.id, "name": t.host_friendly_name },
        "rules": own.iter().map(rules::rule_json).collect::<Vec<_>>(),
        "site_rules": site.iter().map(rules::rule_json).collect::<Vec<_>>(),
        "can_edit": can_edit,
        "can_edit_site": me.is_superuser,
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

/// 試一個指令：對你、對被分享的人各是什麼結果；帶 `rule` 時也看這條（還沒存的）規則符不符合。
/// Try a command: the verdict for you and for shared users; with `rule`, whether that (unsaved) rule matches too.
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
    let (rule_set, me_approver) = match body.get("tunnel_id").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))) {
        Some(id) => {
            let (t, approver) = tunnel_access(&state, &me, id).await?;
            (rules::rules_for(&state, t.id).await, approver)
        }
        None => {
            let rows = db::command_rules::rules_for(&state.db, None).await?;
            (std::sync::Arc::new(rows.iter().filter_map(rules::compile).collect::<Vec<_>>()), false)
        }
    };
    let lines = vec![command.clone()];
    let verdict = |approver: bool| match matcher::evaluate(&rule_set, &lines, approver, source) {
        Some(r) => json!({ "action": r.action.as_str(), "rule": rules::matched_json(r) }),
        None => json!({ "action": "allow", "rule": null }),
    };
    let mut out = json!({
        "commands": matcher::commands(&command).into_iter().map(|c| json!({ "program": c.program, "args": c.args })).collect::<Vec<_>>(),
        "for_approvers": verdict(true),
        "for_sharees": verdict(false),
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
    let items: Vec<Value> = rows
        .iter()
        .map(|e| {
            let mut v = rules::event_json(e, names.get(&e.tunnel_id).map(String::as_str));
            let pending = e.status == "pending";
            v["can_decide"] = json!(pending && approves.contains_key(&e.tunnel_id));
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
        DecideError::NotApprover => coded(StatusCode::FORBIDDEN, "not_approver", "Only the tunnel owner or an ADMIN sharee can approve commands."),
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
