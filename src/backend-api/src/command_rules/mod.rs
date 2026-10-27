//! 指令規則：網頁終端機與 MCP agent 要跑的指令先比對規則——全站規則（管理員）加上隧道自己的規則（owner / ADMIN）。
//! 「擋下」直接取消；「要核准」先停住，通知 owner 與 ADMIN sharee（或規則自己指定的核准人），有人核准才送出（逾時 = 拒絕）；
//! 「允許」是例外，只豁免同一個範圍的規則（見 `matcher`）。
//! 這是防手滑的護欄，不是安全邊界：只看得到網頁終端機畫面上那一行與 agent 送來的指令字串；腳本、alias、
//! 編輯器、筆電直接 ssh 都不經過這裡。
//! Command rules: commands from the web terminal and MCP agents are matched against the site-wide rules (admins)
//! plus the tunnel's own (owner / ADMIN). "Block" cancels the command; "approve" holds it, notifies the owner and
//! ADMIN sharees (or the approvers the rule names) and runs it once someone approves (a timeout counts as a
//! denial); "allow" is an exception that exempts the same scope's rules only (see `matcher`). A guard against mistakes, not
//! a security boundary: only the line on the web terminal's screen and the agent's command string are seen;
//! scripts, aliases, editors and ssh from a laptop never pass through here.

pub mod line;
pub mod matcher;
pub mod terminal;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use dashmap::DashMap;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::db::{self, command_rules::{EventRow, NewEvent, RuleRow}, tunnels::Tunnel, users::User};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{db_time, db_to_iso_utc_z, now_db};
use crate::webhooks::{Event, Kind as WebhookKind};
pub use matcher::{Action, Kind, Matcher, Rule, Scope, Source, Verdict, Via, Who};

/// agent 的一次 tool call 最多等核准這麼久，之後回「還在等」。/ How long one agent tool call waits for a decision.
pub const AGENT_WAIT: Duration = Duration::from_secs(45);
/// 核准後 agent 的同一個指令多久內可以跑（一次）。/ How long an approved agent command stays usable (once).
pub const APPROVAL_REUSE_SECS: i64 = 600;
const REAP_INTERVAL: Duration = Duration::from_secs(5);
/// 存進紀錄的指令最多幾個字元。/ Characters of a command kept in the record.
pub const COMMAND_MAX: usize = 2000;

/// 一筆核准申請的結果。/ What became of an approval request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    Approved { by: String },
    Denied { by: String, reason: String },
    Cancelled { reason: String },
    Expired,
}

impl Outcome {
    pub fn status(&self) -> &'static str {
        match self {
            Outcome::Pending => "pending",
            Outcome::Approved { .. } => "approved",
            Outcome::Denied { .. } => "denied",
            Outcome::Cancelled { .. } => "cancelled",
            Outcome::Expired => "expired",
        }
    }
}

/// 規則快取（每條隧道 = 全站 + 自己的，編譯好）與等待中申請的通知管道。
/// The rule cache (per tunnel: site-wide + its own, compiled) and the channels pending requests wait on.
#[derive(Default)]
pub struct CommandRules {
    cache: Mutex<HashMap<i64, Arc<Vec<Rule>>>>,
    waiters: DashMap<i64, watch::Sender<Outcome>>,
}

impl CommandRules {
    /// 規則改了：整個快取丟掉（全站規則影響每條隧道）。/ Rules changed: drop the whole cache.
    pub fn invalidate(&self) {
        self.cache.lock().unwrap().clear();
    }

    /// 等這筆申請的結果（不在了 = None）。/ Wait on a request's outcome (None when it is not pending here).
    pub fn subscribe(&self, id: i64) -> Option<watch::Receiver<Outcome>> {
        self.waiters.get(&id).map(|tx| tx.subscribe())
    }

    fn settle(&self, id: i64, outcome: Outcome) {
        if let Some((_, tx)) = self.waiters.remove(&id) {
            let _ = tx.send(outcome);
        }
    }
}

/// 一列規則 → 能比對的規則；停用或不合法（理論上存不進來）就略過。/ A row → a rule; disabled or invalid rows are skipped.
pub fn compile(row: &RuleRow) -> Option<Rule> {
    if !row.enabled {
        return None;
    }
    let kind = Kind::parse(&row.kind)?;
    Some(Rule {
        id: row.id,
        tunnel_id: row.tunnel_id,
        action: Action::parse(&row.action)?,
        who: Who::parse(&row.who)?,
        via: Via::parse(&row.via)?,
        pattern: row.pattern.clone(),
        kind,
        note: row.note.clone(),
        approver_ids: parse_approver_ids(row.approver_ids.as_deref()),
        matcher: Matcher::new(kind, &row.pattern).ok()?,
    })
}

/// 存在資料庫的核准人 JSON 陣列 → id（壞掉 / 空 = 預設核准人）。/ The stored JSON array → ids (broken / empty = default).
pub fn parse_approver_ids(json: Option<&str>) -> Vec<i64> {
    let mut ids: Vec<i64> = json.and_then(|j| serde_json::from_str(j).ok()).unwrap_or_default();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// id → 存進資料庫的 JSON 陣列（空 = NULL）。/ ids → the stored JSON array (empty = NULL).
pub fn approver_ids_json(ids: &[i64]) -> Option<String> {
    (!ids.is_empty()).then(|| serde_json::to_string(ids).unwrap_or_default())
}

/// 一條隧道適用的規則（全站在前）。讀不到資料庫就當沒有規則（護欄，不是安全邊界）。
/// The rules that apply to a tunnel (site-wide first). A database error means no rules (a guard rail, not a lock).
pub async fn rules_for(state: &AppState, tunnel_id: i64) -> Arc<Vec<Rule>> {
    if let Some(r) = state.commands.cache.lock().unwrap().get(&tunnel_id) {
        return r.clone();
    }
    let load = async {
        let mut rows = db::command_rules::rules_for(&state.db, None).await?;
        rows.extend(db::command_rules::rules_for(&state.db, Some(tunnel_id)).await?);
        Ok::<_, sqlx::Error>(rows)
    };
    let rules = match load.await {
        Ok(rows) => Arc::new(rows.iter().filter_map(compile).collect::<Vec<_>>()),
        Err(e) => {
            tracing::warn!(error = %e, tunnel_id, "command rules: load failed");
            return Arc::new(Vec::new());
        }
    };
    state.commands.cache.lock().unwrap().insert(tunnel_id, rules.clone());
    rules
}

/// 誰、在哪裡要跑指令。/ Who wants to run a command, and where.
#[derive(Debug, Clone)]
pub struct Requester {
    pub tunnel_id: i64,
    pub user_id: i64,
    pub username: String,
    pub source: Source,
    /// 裝置上的帳號（區網主機時是跳板那一段的帳號）。/ The device account (the jump account for a LAN host).
    pub account: String,
    /// `login@address`（區網主機終端機）。/ `login@address` for a LAN host terminal.
    pub lan_host: Option<String>,
    /// agent 的 app 名稱。/ The agent's app name.
    pub client: Option<String>,
    pub grant_id: Option<i64>,
    /// 個人 API token（agent 用 token 時）。/ The personal API token, when the agent used one.
    pub token_id: Option<i64>,
    pub session_ref: Option<String>,
}

/// 預設的核准人：owner 與 ADMIN sharee。/ The default approvers: the owner and ADMIN sharees.
pub async fn default_approvers(state: &AppState, t: &Tunnel) -> Vec<i64> {
    let mut ids = vec![t.user_id];
    ids.extend(db::sharing::admin_sharee_ids(&state.db, t.id).await.unwrap_or_default());
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// 這條規則在這條隧道上的核准人：規則自己指定的那些，否則 owner + ADMIN。
/// Who decides on this rule for this tunnel: the rule's own list, else the owner + ADMIN sharees.
pub async fn approvers_for(state: &AppState, t: &Tunnel, rule_approvers: &[i64]) -> Vec<i64> {
    if rule_approvers.is_empty() {
        default_approvers(state, t).await
    } else {
        rule_approvers.to_vec()
    }
}

/// 一筆申請的核准人：建立時的快照，沒有就是現在的 owner + ADMIN。/ A request's approvers: its snapshot, else today's owner + ADMIN.
pub async fn request_approvers(state: &AppState, row: &EventRow, t: &Tunnel) -> Vec<i64> {
    approvers_for(state, t, &parse_approver_ids(row.approver_ids.as_deref())).await
}

/// owner / ADMIN：「只管 sharee」的規則不管他們，也是預設的核准人。/ Owner / ADMIN: skipped by sharees-only rules, default approvers.
async fn is_approver(state: &AppState, user_id: i64, t: &Tunnel) -> bool {
    permissions::effective_for(&state.db, user_id, t).await.ok().flatten().is_some_and(|e| e.satisfies(Permission::Admin))
}

/// 這個人能決定這筆申請嗎（規則指定的核准人，否則 owner / ADMIN）。/ Whether this person decides on this request.
pub async fn decides(state: &AppState, user_id: i64, row: &EventRow) -> bool {
    match db::tunnels::by_id(&state.db, row.tunnel_id).await {
        Ok(Some(t)) => request_approvers(state, row, &t).await.contains(&user_id),
        _ => false,
    }
}

/// 比對規則：擋下 / 要核准 / None = 放行。/ Match the rules: block, approve, or None = allowed.
pub async fn check(state: &AppState, r: &Requester, lines: &[String]) -> Option<Rule> {
    if lines.iter().all(|l| l.trim().is_empty()) {
        return None;
    }
    let rules = rules_for(state, r.tunnel_id).await;
    if rules.is_empty() {
        return None;
    }
    let tunnel = db::tunnels::by_id(&state.db, r.tunnel_id).await.ok().flatten()?;
    let approver = is_approver(state, r.user_id, &tunnel).await;
    matcher::evaluate(&rules, lines, approver, r.source).decision().cloned()
}

fn clip(command: &str) -> String {
    match command.char_indices().nth(COMMAND_MAX) {
        Some((i, _)) => format!("{}…", &command[..i]),
        None => command.to_string(),
    }
}

fn scope_of(rule: &Rule) -> &'static str {
    rule.scope().as_str()
}

fn new_event<'a>(r: &'a Requester, command: &'a str, rule: &'a Rule, approver_ids: Option<&'a str>, status: &'a str, expires_at: Option<&'a str>) -> NewEvent<'a> {
    NewEvent {
        tunnel_id: r.tunnel_id,
        user_id: r.user_id,
        username: &r.username,
        source: r.source.as_str(),
        client: r.client.as_deref(),
        grant_id: r.grant_id,
        token_id: r.token_id,
        session_ref: r.session_ref.as_deref(),
        account: &r.account,
        lan_host: r.lan_host.as_deref(),
        command,
        rule_id: rule.id,
        rule_pattern: &rule.pattern,
        rule_kind: rule.kind.as_str(),
        rule_scope: scope_of(rule),
        rule_note: &rule.note,
        approver_ids,
        status,
        expires_at,
    }
}

/// 「在網頁終端機」/「經 MCP app X」。/ How the command arrived, for log lines.
fn via_words(r: &Requester) -> String {
    match (r.source, r.client.as_deref()) {
        (Source::Agent, Some(app)) => format!("MCP app \"{app}\" as {}", r.account),
        (Source::Agent, None) => format!("an MCP app as {}", r.account),
        (Source::Terminal, _) => match &r.lan_host {
            Some(h) => format!("web terminal to {h}"),
            None => format!("web terminal as {}", r.account),
        },
    }
}

fn reverse_port(t: Option<&Tunnel>) -> Option<u16> {
    t.and_then(|t| u16::try_from(t.reverse_port).ok())
}

/// 記下一個被擋下的指令（紀錄 + 隧道 Logs）。/ Record a blocked command (event row + the tunnel's Logs).
pub async fn record_block(state: &AppState, r: &Requester, command: &str, rule: &Rule) -> Option<EventRow> {
    let command = clip(command);
    let row = db::command_rules::create_event(&state.db, &new_event(r, &command, rule, None, "blocked", None)).await;
    let tunnel = db::tunnels::by_id(&state.db, r.tunnel_id).await.ok().flatten();
    if let Some(t) = &tunnel {
        state.webhooks.emit(
            Event::new(WebhookKind::CommandBlocked)
                .tunnel(t)
                .to(default_approvers(state, t).await, Some(r.user_id))
                .data(json!({ "by": r.username, "account": r.account, "lan_host": r.lan_host, "command": command, "via": r.source.as_str(), "client": r.client, "rule": rule.pattern }))
                .link(format!("/tunnels/commands?tunnel={}&tab=history", t.id)),
        );
    }
    state
        .gateway
        .event(
            "command_blocked",
            None,
            reverse_port(tunnel.as_ref()),
            Some(r.tunnel_id),
            format!("{}: a command was blocked by the {} rule `{}` ({})", r.username, scope_of(rule), rule.pattern, via_words(r)),
        )
        .await;
    match row {
        Ok(e) => Some(e),
        Err(e) => {
            tracing::warn!(error = %e, "command rules: could not record a blocked command");
            None
        }
    }
}

/// 送出核准申請：寫紀錄（含核准人快照）、通知核准人（規則指定的，否則 owner 與 ADMIN）與申請人，回傳申請與等結果的管道。
/// File an approval request: record it (approvers snapshotted), notify the approvers (the rule's own, else the owner
/// and ADMINs) and the requester, return it with its channel.
pub async fn request(state: &AppState, r: &Requester, command: &str, rule: &Rule) -> anyhow::Result<(EventRow, watch::Receiver<Outcome>)> {
    let command = clip(command);
    let timeout = db::settings::get_solo(&state.db).await.map(|s| s.command_approval_timeout).unwrap_or(300).clamp(30, 86_400);
    let expires = db_time(Utc::now() + chrono::Duration::seconds(timeout));
    let tunnel = db::tunnels::by_id(&state.db, r.tunnel_id).await?.ok_or_else(|| anyhow::anyhow!("tunnel is gone"))?;
    let deciders = approvers_for(state, &tunnel, &rule.approver_ids).await;
    let snapshot = approver_ids_json(&deciders);
    let row = db::command_rules::create_event(&state.db, &new_event(r, &command, rule, snapshot.as_deref(), "pending", Some(&expires))).await?;
    let (tx, rx) = watch::channel(Outcome::Pending);
    state.commands.waiters.insert(row.id, tx);
    let mut audience = deciders.clone();
    audience.push(r.user_id);
    audience.sort_unstable();
    audience.dedup();
    let details = format!("{} wants to run `{}` on \"{}\"", r.username, short(&command, 80), tunnel.host_friendly_name);
    // 自己在終端機打的指令有橫幅可以按，不另外送 webhook；自己的 agent 的指令還是要送（人可能不在電腦前）。
    // Your own terminal command has the banner; your own agent's commands still go out (you may be away).
    state.webhooks.emit(
        Event::new(WebhookKind::CommandApprovalRequested)
            .tunnel(&tunnel)
            .to(deciders.clone(), (r.source == Source::Terminal).then_some(r.user_id))
            .data(json!({
                "request_id": row.id,
                "by": r.username,
                "account": r.account,
                "lan_host": r.lan_host,
                "command": command,
                "via": r.source.as_str(),
                "client": r.client,
                "expires_at": db_to_iso_utc_z(&expires),
            }))
            .link(format!("/tunnels/commands?tunnel={}", tunnel.id)),
    );
    state.hub.notify_users(
        audience,
        &json!({
            "action": "COMMAND-APPROVAL-REQUESTED",
            "details": details,
            "tunnel_id": tunnel.id,
            "approver_ids": deciders,
            "request": event_json(&row, Some(&tunnel.host_friendly_name)),
        }),
    );
    state
        .gateway
        .event(
            "command_held",
            None,
            reverse_port(Some(&tunnel)),
            Some(tunnel.id),
            format!("{}: a command is waiting for approval under the {} rule `{}` (request #{}, {})", r.username, scope_of(rule), rule.pattern, row.id, via_words(r)),
        )
        .await;
    Ok((row, rx))
}

fn short(s: &str, n: usize) -> String {
    let one_line = s.replace('\n', " ⏎ ");
    match one_line.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &one_line[..i]),
        None => one_line,
    }
}

#[derive(Debug)]
pub enum DecideError {
    NotFound,
    NotApprover,
    NotRequester,
    AlreadyDecided(String),
    Db(sqlx::Error),
}

impl From<sqlx::Error> for DecideError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

/// 結束一筆申請並通知所有相關的人（compare-and-set，只有第一個決定算數）。
/// Close a request and tell everyone involved (compare-and-set: only the first decision counts).
async fn finish(state: &AppState, row: &EventRow, outcome: Outcome, by: Option<(i64, &str)>) -> Result<EventRow, DecideError> {
    let reason = match &outcome {
        Outcome::Denied { reason, .. } | Outcome::Cancelled { reason } => reason.clone(),
        _ => String::new(),
    };
    if !db::command_rules::decide(&state.db, row.id, outcome.status(), by, &reason).await? {
        let now = db::command_rules::event(&state.db, row.id).await?.ok_or(DecideError::NotFound)?;
        return Err(DecideError::AlreadyDecided(now.status));
    }
    state.commands.settle(row.id, outcome.clone());
    let updated = db::command_rules::event(&state.db, row.id).await?.ok_or(DecideError::NotFound)?;
    let tunnel = db::tunnels::by_id(&state.db, row.tunnel_id).await?;
    let mut audience = match &tunnel {
        Some(t) => request_approvers(state, row, t).await,
        None => Vec::new(),
    };
    audience.push(row.user_id);
    audience.sort_unstable();
    audience.dedup();
    let name = tunnel.as_ref().map(|t| t.host_friendly_name.as_str());
    state.hub.notify_users(audience, &json!({ "action": "COMMAND-APPROVAL-DECIDED", "tunnel_id": row.tunnel_id, "request": event_json(&updated, name) }));
    // 申請人自己決定的、或取消的，不用再通知他。/ Not when the requester decided or cancelled it themselves.
    if let Some(t) = tunnel.as_ref().filter(|_| updated.decided_by_id != Some(row.user_id) && !matches!(outcome, Outcome::Cancelled { .. })) {
        state.webhooks.emit(
            Event::new(WebhookKind::CommandApprovalDecided)
                .tunnel(t)
                .to([row.user_id], None)
                .data(json!({ "request_id": row.id, "status": outcome.status(), "by": updated.decided_by, "reason": reason, "command": row.command, "account": row.account }))
                .link(format!("/tunnels/commands?tunnel={}&tab=history", t.id)),
        );
    }
    let words = match &outcome {
        Outcome::Approved { by } => format!("approved by {by}"),
        Outcome::Denied { by, reason } if reason.is_empty() => format!("denied by {by}"),
        Outcome::Denied { by, reason } => format!("denied by {by}: {reason}"),
        Outcome::Cancelled { reason } => format!("cancelled ({reason})"),
        Outcome::Expired => "expired: nobody answered in time".into(),
        Outcome::Pending => "pending".into(),
    };
    let kind = match outcome {
        Outcome::Approved { .. } => "command_approved",
        Outcome::Denied { .. } => "command_denied",
        Outcome::Expired => "command_expired",
        _ => "command_cancelled",
    };
    state
        .gateway
        .event(kind, None, reverse_port(tunnel.as_ref()), Some(row.tunnel_id), format!("command request #{} from {}: {words}", row.id, row.username))
        .await;
    Ok(updated)
}

/// 這筆申請的核准人核准或拒絕（規則指定的人，否則 owner / ADMIN；自己的申請也可以：agent 用你的身分跑時，還是要你按一下）。
/// One of the request's approvers (the rule's own, else the owner / ADMINs) approves or denies — their own requests
/// too: an agent acting as you still needs your click.
pub async fn decide(state: &AppState, id: i64, approve: bool, by: &User, reason: &str) -> Result<EventRow, DecideError> {
    let row = db::command_rules::event(&state.db, id).await?.ok_or(DecideError::NotFound)?;
    let tunnel = db::tunnels::by_id(&state.db, row.tunnel_id).await?.ok_or(DecideError::NotFound)?;
    if !request_approvers(state, &row, &tunnel).await.contains(&by.id) {
        // 看不到這條隧道的人當作不存在。/ People who can't see the tunnel get a 404.
        return Err(if row.user_id == by.id || permissions::check_access(&state.db, by.id, &tunnel, Permission::View).await? { DecideError::NotApprover } else { DecideError::NotFound });
    }
    if row.status != "pending" {
        return Err(DecideError::AlreadyDecided(row.status));
    }
    let outcome = if approve {
        Outcome::Approved { by: by.username.clone() }
    } else {
        Outcome::Denied { by: by.username.clone(), reason: reason.trim().chars().take(500).collect() }
    };
    finish(state, &row, outcome, Some((by.id, &by.username))).await
}

/// 申請人自己撤回。/ The requester withdraws.
pub async fn cancel_by_requester(state: &AppState, id: i64, by: &User) -> Result<EventRow, DecideError> {
    let row = db::command_rules::event(&state.db, id).await?.ok_or(DecideError::NotFound)?;
    if row.user_id != by.id {
        return Err(DecideError::NotRequester);
    }
    if row.status != "pending" {
        return Err(DecideError::AlreadyDecided(row.status));
    }
    finish(state, &row, Outcome::Cancelled { reason: format!("withdrawn by {}", by.username) }, None).await
}

/// 終端機那邊取消（Ctrl+C、關分頁）。/ Cancelled from the terminal (Ctrl+C, tab closed).
pub async fn cancel(state: &AppState, id: i64, reason: &str) {
    if let Ok(Some(row)) = db::command_rules::event(&state.db, id).await {
        if row.status == "pending" {
            let _ = finish(state, &row, Outcome::Cancelled { reason: reason.into() }, None).await;
        }
    }
}

/// 核准用掉了。/ Mark an approval used.
pub async fn mark_used(state: &AppState, id: i64) -> bool {
    db::command_rules::mark_used(&state.db, id).await.unwrap_or(false)
}

/// 到期沒人回應的申請 → expired。/ Requests nobody answered in time expire.
pub async fn expire_due(state: &AppState) {
    let Ok(ids) = db::command_rules::due_pending(&state.db, &now_db()).await else { return };
    for id in ids {
        if let Ok(Some(row)) = db::command_rules::event(&state.db, id).await {
            let _ = finish(state, &row, Outcome::Expired, None).await;
        }
    }
}

/// 背景工作：開機時把沒人在等的申請收掉，之後每 5 秒處理逾時。/ Background task: clear orphans, then expire every 5 s.
pub async fn run(state: AppState) {
    match db::command_rules::cancel_orphans(&state.db).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(n, "command rules: cancelled approval requests left from before the restart"),
        Err(e) => tracing::warn!(error = %e, "command rules: could not clear old requests"),
    }
    loop {
        tokio::time::sleep(REAP_INTERVAL).await;
        expire_due(&state).await;
    }
}

/// agent 這次呼叫的結果。/ The outcome for one agent call.
#[derive(Debug)]
pub enum AgentApproval {
    /// 核准了（已標記用掉），可以跑。/ Approved (and marked used): run it.
    Approved { id: i64, by: String },
    Denied { id: i64, message: String },
    /// 還在等。/ Still waiting.
    Waiting { id: i64 },
}

/// agent 的指令要核准：同一個 app 已經在等或剛核准的同一個指令就沿用，否則送新的申請；最多等 [`AGENT_WAIT`]。
/// An agent command that needs approval: reuse a pending or freshly approved request for the same command from the
/// same app, or file a new one; wait up to [`AGENT_WAIT`].
pub async fn agent_approval(state: &AppState, r: &Requester, command: &str, rule: &Rule) -> anyhow::Result<AgentApproval> {
    let command = clip(command);
    let since = db_time(Utc::now() - chrono::Duration::seconds(APPROVAL_REUSE_SECS));
    let existing = if r.grant_id.is_some() || r.token_id.is_some() {
        db::command_rules::reusable_agent_request(&state.db, r.user_id, r.grant_id, r.token_id, r.tunnel_id, &r.account, &command, &since).await?
    } else {
        None
    };
    let (id, rx) = match existing {
        Some(e) if e.status == "approved" => {
            return Ok(if mark_used(state, e.id).await {
                AgentApproval::Approved { id: e.id, by: e.decided_by.unwrap_or_default() }
            } else {
                AgentApproval::Denied { id: e.id, message: "That approval was already used.".into() }
            });
        }
        Some(e) => match state.commands.subscribe(e.id) {
            Some(rx) => (e.id, rx),
            None => return Ok(AgentApproval::Waiting { id: e.id }),
        },
        None => {
            let (row, rx) = request(state, r, &command, rule).await?;
            (row.id, rx)
        }
    };
    let mut rx = rx;
    let waited = tokio::time::timeout(AGENT_WAIT, async {
        loop {
            let now = rx.borrow().clone();
            if now != Outcome::Pending {
                return now;
            }
            if rx.changed().await.is_err() {
                return rx.borrow().clone();
            }
        }
    })
    .await;
    Ok(match waited {
        Ok(Outcome::Approved { by }) => {
            if mark_used(state, id).await {
                AgentApproval::Approved { id, by }
            } else {
                AgentApproval::Denied { id, message: "That approval was already used.".into() }
            }
        }
        Ok(Outcome::Denied { by, reason }) if reason.is_empty() => AgentApproval::Denied { id, message: format!("{by} denied this command.") },
        Ok(Outcome::Denied { by, reason }) => AgentApproval::Denied { id, message: format!("{by} denied this command: {reason}") },
        Ok(Outcome::Expired) => AgentApproval::Denied { id, message: "Nobody approved this command in time.".into() },
        Ok(Outcome::Cancelled { reason }) => AgentApproval::Denied { id, message: format!("The request was cancelled ({reason}).") },
        Ok(Outcome::Pending) | Err(_) => AgentApproval::Waiting { id },
    })
}

/// 規則的 JSON。/ A rule as JSON.
pub fn rule_json(r: &RuleRow) -> Value {
    json!({
        "id": r.id,
        "tunnel_id": r.tunnel_id,
        "scope": if r.tunnel_id.is_some() { "tunnel" } else { "site" },
        "action": r.action,
        "kind": r.kind,
        "pattern": r.pattern,
        "who": r.who,
        "via": r.via,
        "note": r.note,
        "enabled": r.enabled,
        "approver_ids": parse_approver_ids(r.approver_ids.as_deref()),
        "created_at": db_to_iso_utc_z(&r.created_at),
        "updated_at": db_to_iso_utc_z(&r.updated_at),
    })
}

/// 比對到的規則（給終端機與測試指令用）。/ A matched rule, for the terminal and the tester.
pub fn matched_json(r: &Rule) -> Value {
    json!({
        "id": r.id,
        "scope": scope_of(r),
        "action": r.action.as_str(),
        "kind": r.kind.as_str(),
        "pattern": r.pattern,
        "note": r.note,
        "who": r.who.as_str(),
        "via": r.via.as_str(),
        "approver_ids": r.approver_ids,
    })
}

/// 一筆紀錄 / 申請的 JSON。/ An event (block or request) as JSON.
pub fn event_json(e: &EventRow, tunnel_name: Option<&str>) -> Value {
    json!({
        "id": e.id,
        "tunnel_id": e.tunnel_id,
        "tunnel_name": tunnel_name,
        "user": { "id": e.user_id, "username": e.username },
        "source": e.source,
        "client": e.client,
        "account": e.account,
        "lan_host": e.lan_host,
        "command": e.command,
        "rule": { "id": e.rule_id, "pattern": e.rule_pattern, "kind": e.rule_kind, "scope": e.rule_scope, "note": e.rule_note, "approver_ids": parse_approver_ids(e.approver_ids.as_deref()) },
        "status": e.status,
        "created_at": db_to_iso_utc_z(&e.created_at),
        "expires_at": e.expires_at.as_deref().map(db_to_iso_utc_z),
        "decided_by": e.decided_by,
        "decided_at": e.decided_at.as_deref().map(db_to_iso_utc_z),
        "reason": e.reason,
        "used": e.used_at.is_some() && e.status == "approved",
    })
}
