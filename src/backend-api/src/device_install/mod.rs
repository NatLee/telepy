//! 隧道在裝置上的名稱與足跡：
//! - **安裝代號**（`names`）：每條隧道一個隨機代號，腳本裝到裝置上的服務、檔案都用它取名，記在 `telepy_device_install`。
//! - **盤點**（`survey`）：透過隧道跑 `remove_tunnel.sh` 的 survey 模式（只回報），記下裝置上跑這條隧道的是什麼、叫什麼。
//!   一鍵加入驗證後、詳細資料按「重新檢查」、以及 device_info 每天那一趟（沒盤點過或超過 7 天）都會跑。
//! - **改名**（`rename`）：把舊名稱（例如 `telepy-natlee.service`，看得出是誰裝的）換成用代號取名的新服務，**先接上
//!   再拆舊的**，因為指令本身就是經這條隧道送過去的：
//!   (1) 開交接（gateway 讓同一條隧道的第二條連線先當備援）→ (2) 經舊連線裝好並啟動新服務 → (3) 等新服務連上來當
//!   備援 → (4) 經備援登入一次確認到得了 → (5) 備援接手 forward → (6) 經**新**連線移除舊服務（relabel 模式：留下金鑰
//!   與新服務）→ (7) 確認舊連線斷了、沒有再連回來 → 再盤點一次記下結果。(2)–(4) 任何一步失敗都把剛裝的拆掉，舊的沒動過。
//!
//! A tunnel's names and footprint on its device: a random install id names everything Telepy installs; a survey (the
//! removal script in report-only mode, through the tunnel) records what runs the tunnel there; a rename replaces older
//! names make-before-break — the new service connects as a standby, is checked, takes over the forward, and only then
//! is the old one removed, over the new connection. Any failure before the switch undoes the new service only.

pub mod names;
pub mod plan;

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::db::{self, tunnels::Tunnel};
use crate::ssh::{device, exec};
use crate::state::AppState;
use crate::tunnel_service::{self, sh_quote, AccountResult, Item, Mode, Removal};
use crate::util::db_to_iso_utc_z;
use names::Names;

/// 交接開多久（裝新服務 + 等它連上 + 確認）。/ How long the handover stays open.
const HANDOVER_WINDOW: Duration = Duration::from_secs(150);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(60);
/// 新服務連上來當備援最多等多久（systemd / launchd 10 秒後重試一次）。/ How long the new service gets to connect.
static STANDBY_WAIT_MS: AtomicU64 = AtomicU64::new(45_000);

/// 測試用：縮短等新服務連上的時間。/ For tests: a shorter wait for the new service.
pub fn set_standby_wait(wait: Duration) {
    STANDBY_WAIT_MS.store(wait.as_millis() as u64, Ordering::Relaxed);
}
const MAX_OUTPUT: usize = 128 * 1024;
/// 背景盤點的間隔。/ How old a survey may get before the daily probe redoes it.
pub const SURVEY_EVERY_DAYS: i64 = 7;

/// 正在改名的隧道（以 reverse port 記：一個 port 一條隧道；同一條同時只跑一個）。
/// Tunnels being renamed right now, keyed by reverse port (one tunnel per port; one rename at a time each).
static BUSY: LazyLock<Mutex<HashSet<i64>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

pub fn busy(tunnel: &Tunnel) -> bool {
    BUSY.lock().unwrap().contains(&tunnel.reverse_port)
}

struct BusyGuard(i64);
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.lock().unwrap().remove(&self.0);
    }
}

fn online(state: &AppState, tunnel: &Tunnel) -> bool {
    crate::device_keys::online(state, tunnel.reverse_port)
}

async fn login_accounts(state: &AppState, tunnel: &Tunnel) -> sqlx::Result<Vec<String>> {
    Ok(db::tunnels::usernames_for_tunnel(&state.db, tunnel.id).await?.into_iter().map(|u| u.username).collect())
}

/// 讀出存著的盤點結果。/ The stored survey.
fn stored(row: &db::device_install::Row) -> Vec<AccountResult> {
    row.survey.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
}

/// 通知擁有者與 ADMIN 被分享者（詳細資料、改名對話框重新讀）。/ Tell the managers to refetch.
async fn notify(state: &AppState, tunnel: &Tunnel, extra: Value) {
    let mut users = vec![tunnel.user_id];
    if let Ok(admins) = db::sharing::admin_sharee_ids(&state.db, tunnel.id).await {
        users.extend(admins);
    }
    let mut msg = json!({ "action": "DEVICE-INSTALL-UPDATED", "tunnel_id": tunnel.id });
    if let (Some(m), Some(e)) = (msg.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    state.hub.notify_users(users, &msg);
}

/// 盤點並記下。全部帳號都失敗時只記錯誤（保留上次看到的）。/ Survey and record; when every account fails only the error is kept.
pub async fn survey_and_record(state: &AppState, tunnel: &Tunnel) -> Result<Vec<AccountResult>, String> {
    db::device_install::ensure(&state.db, tunnel.id).await.map_err(|e| format!("{e:#}"))?;
    let accounts = login_accounts(state, tunnel).await.map_err(|e| format!("{e:#}"))?;
    if accounts.is_empty() {
        return Err("the tunnel has no login accounts".into());
    }
    if !online(state, tunnel) {
        return Err("the device is offline".into());
    }
    let results = tunnel_service::survey(state, tunnel, &accounts).await;
    let ok = results.iter().any(|a| a.error.is_none() && a.platform.is_some());
    let error = if ok { None } else { results.iter().find_map(|a| a.error.clone()).or_else(|| Some("no account could be surveyed".into())) };
    let json = serde_json::to_string(&results).unwrap_or_else(|_| "[]".into());
    let _ = db::device_install::record_survey(&state.db, tunnel.id, ok.then_some(json.as_str()), error.as_deref()).await;
    notify(state, tunnel, json!({})).await;
    match error {
        None => Ok(results),
        Some(e) => Err(e),
    }
}

/// 背景盤點（device_info 每天那一趟用）：沒盤點過或太舊才跑，同時在改名的不跑。
/// Background survey for the daily probe: only when never done or stale, and not during a rename.
pub async fn survey_if_due(state: &AppState, tunnel: &Tunnel) {
    if busy(tunnel) {
        return;
    }
    if db::device_install::survey_due(&state.db, tunnel.id, SURVEY_EVERY_DAYS).await.unwrap_or(false) {
        if let Err(e) = survey_and_record(state, tunnel).await {
            tracing::debug!(tunnel = tunnel.id, error = %e, "device install survey skipped");
        }
    }
}

/// 列表項目的摘要（擁有者 / ADMIN）：代號、上次盤點找到的舊名稱服務。/ The list item summary for managers.
pub fn summary(row: Option<&db::device_install::Row>) -> Value {
    let Some(row) = row else { return Value::Null };
    let names = Names::new(&row.install_id);
    let older = plan::older_services(&plan::parts(&stored(row), &names));
    json!({ "id": row.install_id, "older": older })
}

/// `GET …/device-install` 的內容。/ The device-install JSON.
pub async fn view(state: &AppState, tunnel: &Tunnel) -> sqlx::Result<Value> {
    let id = db::device_install::ensure(&state.db, tunnel.id).await?;
    let row = db::device_install::get(&state.db, tunnel.id).await?;
    let names = Names::new(&id);
    let survey = row.as_ref().map(stored).unwrap_or_default();
    let parts = plan::parts(&survey, &names);
    let older = plan::older_services(&parts);
    let earlier = plan::earlier_services(&parts);
    let planned = plan::plan(&survey, &names);
    let rename = match &planned {
        Ok(p) => json!({
            "possible": true,
            "blocker": null,
            "method": p.method,
            "account": p.account,
            "run_user": p.run_user,
            "new_name": new_name(p.method, &names),
            "old": p.old,
        }),
        Err(b) => json!({ "possible": false, "blocker": b, "old": older.iter().chain(earlier.iter()).collect::<Vec<_>>() }),
    };
    let accounts: Vec<Value> = survey.iter().map(|a| json!({ "account": a.account, "platform": a.platform, "os": a.os, "error": a.error })).collect();
    let renamed_from: Vec<String> = row.as_ref().and_then(|r| r.renamed_from.as_deref()).and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
    Ok(json!({
        "install_id": id,
        "names": {
            "systemd": names.unit(),
            "launchd": names.launchd_label(),
            "loop": format!("~/.ssh/{}", names.runner()),
            "known_hosts": format!("~/.ssh/{}", names.known_hosts()),
            "container": names.base(),
            "description": names.description(),
        },
        "online": online(state, tunnel),
        "busy": busy(tunnel),
        "surveyed_at": row.as_ref().and_then(|r| r.surveyed_at.as_deref()).map(db_to_iso_utc_z),
        "survey_error": row.as_ref().and_then(|r| r.survey_error.clone()),
        "accounts": accounts,
        "parts": parts,
        "older": older,
        "earlier": earlier,
        "others": plan::others(&survey),
        "shared_key": plan::shared_key(&survey),
        "server_port": state.config.reverse_server_ssh_port.trim(),
        "rename": rename,
        "renamed_at": row.as_ref().and_then(|r| r.renamed_at.as_deref()).map(db_to_iso_utc_z),
        "renamed_from": renamed_from,
    }))
}

fn new_name(method: plan::Method, names: &Names) -> String {
    match method {
        plan::Method::Systemd | plan::Method::SystemdUser => names.unit(),
        plan::Method::LaunchdDaemon | plan::Method::LaunchdAgent => names.launchd_label(),
        plan::Method::Loop => names.runner(),
    }
}

/// 改名的一個步驟。/ One step of a rename.
#[derive(Debug, Clone, Serialize)]
pub struct Step {
    /// survey / install / standby / check / switch / remove / confirm
    pub id: &'static str,
    /// done / failed / undone
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Report {
    pub ok: bool,
    pub steps: Vec<Step>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<plan::Method>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_name: Option<String>,
    pub old: Vec<String>,
    pub install: Vec<Item>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo: Option<Vec<Item>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removal: Option<Removal>,
    /// 新服務沒連上來時它自己的 log 最後幾行。/ The new service's last log lines when it did not connect.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

pub enum RenameError {
    Busy,
    Offline,
    NoAccounts,
}

struct Run<'a> {
    state: &'a AppState,
    tunnel: &'a Tunnel,
    report: Report,
}

impl Run<'_> {
    async fn step(&mut self, id: &'static str, state: &'static str, detail: Option<String>) {
        self.report.steps.push(Step { id, state, detail });
        notify(self.state, self.tunnel, json!({ "step": id, "state": state })).await;
    }
    async fn fail(mut self, id: &'static str, code: &str, error: String) -> Report {
        self.step(id, "failed", Some(error.clone())).await;
        self.report.code = Some(code.to_string());
        self.report.error = Some(error);
        self.report
    }
}

/// 把裝置上跑這條隧道的服務換成用安裝代號取名的新服務（先接上再拆舊的）。/ Rename the device's service, make-before-break.
pub async fn rename(state: &AppState, tunnel: &Tunnel, by: &str) -> Result<Report, RenameError> {
    {
        let mut b = BUSY.lock().unwrap();
        if !b.insert(tunnel.reverse_port) {
            return Err(RenameError::Busy);
        }
    }
    let _guard = BusyGuard(tunnel.reverse_port);
    if !online(state, tunnel) {
        return Err(RenameError::Offline);
    }
    let accounts = login_accounts(state, tunnel).await.unwrap_or_default();
    if accounts.is_empty() {
        return Err(RenameError::NoAccounts);
    }
    let port = u16::try_from(tunnel.reverse_port).map_err(|_| RenameError::Offline)?;
    let mut run = Run { state, tunnel, report: Report::default() };

    // 1. 盤點（每次都重新看，不信舊的紀錄）。/ Survey afresh.
    let id = match db::device_install::ensure(&state.db, tunnel.id).await {
        Ok(id) => id,
        Err(e) => return Ok(run.fail("survey", "internal", format!("{e:#}")).await),
    };
    let names = Names::new(&id);
    let survey = match survey_and_record(state, tunnel).await {
        Ok(s) => s,
        Err(e) => return Ok(run.fail("survey", "survey_failed", e).await),
    };
    let p = match plan::plan(&survey, &names) {
        Ok(p) => p,
        Err(b) => {
            let code = serde_json::to_value(b).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
            return Ok(run.fail("survey", &code, format!("cannot rename automatically: {code}")).await);
        }
    };
    run.report.method = Some(p.method);
    run.report.account = Some(p.account.clone());
    run.report.new_name = Some(new_name(p.method, &names));
    run.report.old = p.old.clone();
    run.step("survey", "done", Some(p.old.join(", "))).await;

    // 2. 經舊連線裝好新服務。/ Install the new service over the current connection.
    let host = p.spec.dest.rsplit('@').next().unwrap_or("").to_string();
    let alias = crate::scripts::gateway_alias(&host, &p.spec.port.unwrap_or(22).to_string());
    let host_keys = state.gateway.host_public_keys();
    let known = crate::scripts::known_hosts_lines(&alias, &host_keys);
    let args = plan::ssh_args(&p, &names, &alias, !host_keys.is_empty());
    let Some(old_conn) = state.gateway.forward_conn(port) else {
        return Ok(run.fail("install", "device_offline", "the device went offline".into()).await);
    };
    state.gateway.arm_handover(port, HANDOVER_WINDOW);
    let conn = match device::connect(state, &p.account, tunnel.reverse_port).await {
        Ok(c) => c,
        Err(e) => {
            state.gateway.disarm_handover(port);
            return Ok(run.fail("install", "login_failed", format!("{e:#}")).await);
        }
    };
    let script = plan::install_script(&p, &names, &args, if host_keys.is_empty() { "" } else { &known });
    let installed = exec::run_script(&conn.device, &script, INSTALL_TIMEOUT, MAX_OUTPUT).await;
    let items = match installed {
        Ok(r) => {
            let items = tunnel_service::parse_items(&r.stdout.text);
            if !items.iter().any(|i| i.kind == "done") && !r.stderr.text.trim().is_empty() {
                run.report.log = Some(r.stderr.text.chars().take(2000).collect());
            }
            items
        }
        Err(e) => vec![Item { kind: "failed".into(), what: "exec".into(), detail: format!("{e:#}") }],
    };
    run.report.install = items.clone();
    if let Some(f) = items.iter().find(|i| i.kind == "failed").or(if items.iter().any(|i| i.kind == "done") { None } else { items.last() }) {
        let detail = format!("{} {}", f.what, f.detail);
        undo(&mut run, &conn, &p, &names, port).await;
        return Ok(run.fail("install", "install_failed", detail).await);
    }
    if !items.iter().any(|i| i.kind == "done") {
        undo(&mut run, &conn, &p, &names, port).await;
        return Ok(run.fail("install", "install_failed", "the install script stopped early".into()).await);
    }
    run.step("install", "done", run.report.new_name.clone()).await;

    // 3. 新服務連上來當備援。/ The new service connects as the standby.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(STANDBY_WAIT_MS.load(Ordering::Relaxed));
    while state.gateway.standby_conn(port).is_none() && tokio::time::Instant::now() < deadline {
        if !state.gateway.conn_alive(old_conn) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    // 舊連線剛好自己斷了、備援已經自動接手：那也算數。/ The old one dropped and the standby already took over: fine too.
    let auto_promoted = !state.gateway.conn_alive(old_conn) && state.gateway.forward_conn(port).is_some_and(|c| c != old_conn);
    if state.gateway.standby_conn(port).is_none() && !auto_promoted {
        run.report.log = service_log(&conn, &p, &names).await;
        undo(&mut run, &conn, &p, &names, port).await;
        return Ok(run.fail("standby", "standby_timeout", "the new service did not connect to Telepy".into()).await);
    }
    run.step("standby", "done", None).await;

    // 4. 經備援登入一次。/ Log in once through the standby.
    if !auto_promoted {
        match device::connect_standby(state, &p.account, tunnel.reverse_port).await {
            Ok(c) => drop(c),
            Err(e) => {
                undo(&mut run, &conn, &p, &names, port).await;
                return Ok(run.fail("check", "check_failed", format!("{e:#}")).await);
            }
        }
    }
    run.step("check", "done", None).await;

    // 5. 備援接手。/ Promote the standby.
    if !auto_promoted && !state.gateway.promote(port).await {
        undo(&mut run, &conn, &p, &names, port).await;
        return Ok(run.fail("switch", "switch_failed", "the new connection went away before it could take over".into()).await);
    }
    state.gateway.disarm_handover(port);
    drop(conn);
    run.step("switch", "done", None).await;

    // 6. 經新連線移除舊服務（留下金鑰與新服務）。/ Remove the older service over the new connection.
    let ctx = tunnel_service::Context { install_id: Some(id.clone()), gateway_port: tunnel_service::Context::load(state, tunnel).await.gateway_port };
    let prepared = tunnel_service::prepare_with(state, tunnel, &accounts, Mode::Relabel, &ctx).await;
    let removal = tunnel_service::finish_relabel(state, tunnel, prepared, old_conn).await;
    let removed_ok = removal.stopped && removal.handed_over == Some(true) && !removal.came_back;
    let needs_root: Vec<String> = removal.accounts.iter().flat_map(|a| a.items.iter().filter(|i| i.kind == "needs_root").map(|i| i.detail.clone())).collect();
    run.step("remove", if removed_ok && needs_root.is_empty() { "done" } else { "failed" }, (!needs_root.is_empty()).then(|| needs_root.join("\n"))).await;
    run.report.removal = Some(removal.clone());

    // 7. 再盤點一次記下現在的樣子。/ Survey once more to record the result.
    let after = survey_and_record(state, tunnel).await.unwrap_or_default();
    let after_parts = plan::parts(&after, &names);
    let mut still_old = plan::older_services(&after_parts);
    still_old.extend(plan::earlier_services(&after_parts));
    let _ = db::device_install::record_rename(&state.db, tunnel.id, &p.old).await;
    let confirmed = removed_ok && still_old.is_empty();
    run.step("confirm", if confirmed { "done" } else { "failed" }, (!still_old.is_empty()).then(|| still_old.join(", "))).await;
    run.report.ok = confirmed;
    if !confirmed {
        run.report.code = Some(if removal.came_back { "old_came_back" } else { "old_left" }.into());
    }
    state
        .gateway
        .event(
            "service_renamed",
            None,
            Some(port),
            Some(tunnel.id),
            format!(
                "Device service of '{}' renamed to {} ({}, as {}) by {by}; was {}{}",
                tunnel.host_friendly_name,
                run.report.new_name.as_deref().unwrap_or("?"),
                p.method.as_str(),
                p.run_user,
                p.old.join(", "),
                if confirmed { String::new() } else { format!("; still on the device: {}", if still_old.is_empty() { "the old connection".to_string() } else { still_old.join(", ") }) }
            ),
        )
        .await;
    notify(state, tunnel, json!({ "done": true })).await;
    Ok(run.report)
}

/// 新服務沒成：經舊連線把剛裝的拆掉（舊服務沒動過），關掉交接。/ Undo the new service over the old connection.
async fn undo(run: &mut Run<'_>, conn: &device::DeviceConn, p: &plan::Plan, names: &Names, port: u16) {
    let script = plan::undo_script(p, names);
    let items = match exec::run_script(&conn.device, &script, INSTALL_TIMEOUT, MAX_OUTPUT).await {
        Ok(r) => tunnel_service::parse_items(&r.stdout.text),
        Err(e) => vec![Item { kind: "failed".into(), what: "undo".into(), detail: format!("{e:#}") }],
    };
    run.state.gateway.disarm_handover(port);
    run.report.undo = Some(items);
}

/// 新服務自己的 log 最後幾行（它沒連上來時給人看為什麼）。/ The new service's last log lines.
async fn service_log(conn: &device::DeviceConn, p: &plan::Plan, names: &Names) -> Option<String> {
    let sudo = if p.sudo { "sudo -n " } else { "" };
    let cmd = match p.method {
        plan::Method::Systemd => format!("{sudo}journalctl -u {} -n 15 --no-pager 2>&1", names.unit()),
        plan::Method::SystemdUser => format!("journalctl --user -u {} -n 15 --no-pager 2>&1", names.unit()),
        plan::Method::LaunchdDaemon | plan::Method::LaunchdAgent => format!("tail -n 15 {} 2>&1", sh_quote(&format!("{}/Library/Logs/{}", p.home, names.log()))),
        plan::Method::Loop => format!("tail -n 15 {} 2>&1", sh_quote(&format!("{}/.ssh/{}", p.home, names.log()))),
    };
    let r = exec::run(&conn.device, &cmd, Duration::from_secs(15), 16 * 1024).await.ok()?;
    let text = r.stdout.text.trim().to_string();
    (!text.is_empty()).then_some(text)
}
