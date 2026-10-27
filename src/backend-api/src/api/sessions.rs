//! 即時 session：誰現在連在哪台裝置上（網頁終端機 / 檔案 / 遠端瀏覽器 / 遠端桌面 / 筆電經 gateway 的 ssh / MCP agent），
//! 以及結束其中一個。看得到：自己的；自己擁有或 ADMIN 的隧道上所有人的；管理員看全部。結束的權限一樣。
//! Live sessions: who is connected to which device right now, and ending one. Visible: your own, everyone's on
//! tunnels you own or ADMIN, and everything for admins; ending follows the same rule.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::extractor::Delegated;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Tunnel, users::User};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::presence::{Entry, Kind};
use crate::state::AppState;
use crate::util::db_to_iso_utc_z;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list)).routes(routes!(end))
}

/// 這個人能管的隧道：{tunnel_id: 隧道}（管理員 = 全部）。/ Tunnels this user manages (all for admins).
pub(super) async fn managed(state: &AppState, me: &User) -> ApiResult<HashMap<i64, Tunnel>> {
    if me.is_superuser {
        return Ok(db::tunnels::all(&state.db).await?.into_iter().map(|t| (t.id, t)).collect());
    }
    let (mine, _) = db::sharing::permission_context(&state.db, me.id).await?;
    Ok(db::tunnels::visible_to(&state.db, me.id)
        .await?
        .into_iter()
        .filter(|t| permissions::effective(me.id, t.user_id, mine.get(&t.id).map(String::as_str)).is_some_and(|e| e.satisfies(Permission::Admin)))
        .map(|t| (t.id, t))
        .collect())
}

/// 看得到、能結束這一筆嗎（純函式）：自己的，或能管那條隧道。/ Visible and endable: your own, or on a tunnel you manage.
pub fn may_end(entry_user: i64, me: i64, manages_tunnel: bool) -> bool {
    entry_user == me || manages_tunnel
}

/// 誰在看哪個 shell：{shell id: [看的人]}。/ Who watches which shell.
fn watchers_by_shell(all: &[Entry]) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for e in all {
        if let Some(w) = &e.watching {
            out.entry(w.shell.clone()).or_default().push(e.username.clone());
        }
    }
    out
}

fn session_json(state: &AppState, e: &Entry, tunnel_name: Option<&str>, me: i64, manages: bool, watchers: &HashMap<String, Vec<String>>) -> Value {
    // MCP agent 的 SSH session：開著幾個互動 shell。/ An MCP agent's SSH session: how many interactive shells are open.
    let shells = (e.kind == Kind::Ai).then(|| state.ai.list().into_iter().find(|s| s.presence_id() == e.id).map(|s| s.shell_count()).unwrap_or(0));
    // 網頁終端機：能管的人拿得到 shell 代號（「看」按鈕），也看得到誰在看。/ Web terminals: the shell id for managers, and who watches.
    let shell = if e.kind == Kind::Terminal { state.shells.by_presence(e.id) } else { None };
    let shell_id = shell.as_ref().filter(|_| manages && e.user_id != me);
    let watched_by = shell.as_ref().and_then(|s| watchers.get(s)).cloned().unwrap_or_default();
    let watching = e.watching.as_ref().map(|w| json!({ "user": { "id": w.user_id, "username": w.username }, "shell_id": w.shell }));
    json!({
        "id": e.id,
        "tunnel": { "id": e.tunnel_id, "name": tunnel_name },
        "user": { "id": e.user_id, "username": e.username },
        "kind": e.kind.as_str(),
        "ip": e.ip,
        "geo": state.geoip.json(e.ip.as_deref()),
        "since": db_to_iso_utc_z(&e.since),
        "client": e.client,
        "shells": shells,
        "detached": super::serialize::detached_json(e),
        "mine": e.user_id == me,
        "shell_id": shell_id,
        "watched_by": watched_by,
        "watching": watching,
    })
}

/// 現在的 session（依開始時間）。/ Live sessions, oldest first.
#[utoipa::path(get, path = "/api/sessions", tag = "Sessions", security(("bearer" = [])), responses((status = 200, body = super::schemas::LiveSessions)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated) -> ApiResult<Json<Value>> {
    let managed = managed(&state, &me).await?;
    let mut names: HashMap<i64, String> = managed.iter().map(|(id, t)| (*id, t.host_friendly_name.clone())).collect();
    let mut out = Vec::new();
    let all = state.presence.all();
    let watchers = watchers_by_shell(&all);
    // 「看」要能用終端機。/ Watching needs the terminal feature.
    let can_watch = state.features.allowed(&me, crate::features::Feature::Terminal).await.unwrap_or(false);
    for e in all {
        if !may_end(e.user_id, me.id, managed.contains_key(&e.tunnel_id)) || !d.allows(e.tunnel_id) {
            continue;
        }
        if !names.contains_key(&e.tunnel_id) {
            if let Some(t) = db::tunnels::by_id(&state.db, e.tunnel_id).await? {
                names.insert(t.id, t.host_friendly_name);
            }
        }
        let manages = managed.contains_key(&e.tunnel_id) && can_watch;
        out.push(session_json(&state, &e, names.get(&e.tunnel_id).map(String::as_str), me.id, manages, &watchers));
    }
    Ok(Json(json!({ "sessions": out })))
}

/// 結束一個 session：連線收掉（WebSocket 4009，原因 = 誰），MCP agent 的照「從網頁關閉」收；通知本人、記一筆事件。
/// End a session: the connection closes (WebSocket 4009 with who as the reason); an MCP agent session closes as
/// "closed from the web". The user is told and a gateway event is written.
#[utoipa::path(delete, path = "/api/sessions/{id}", tag = "Sessions", security(("bearer" = [])), params(("id" = u64, Path, description = "Session id from GET /api/sessions")), responses((status = 204, description = "Ended"), (status = 404, body = super::schemas::ErrorBody)))]
async fn end(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<u64>) -> ApiResult<StatusCode> {
    let not_found = || ApiError::not_found("Session not found");
    let entry = state.presence.get(id).ok_or_else(not_found)?;
    let managed = managed(&state, &me).await?;
    if !may_end(entry.user_id, me.id, managed.contains_key(&entry.tunnel_id)) {
        return Err(not_found());
    }
    if !end_entry(&state, &entry, &me.username).await {
        return Err(not_found());
    }
    let tunnel = db::tunnels::by_id(&state.db, entry.tunnel_id).await?;
    let name = tunnel.as_ref().map(|t| t.host_friendly_name.clone()).unwrap_or_default();
    let kind = entry.kind.as_str();
    if entry.user_id != me.id {
        state.hub.notify_user(
            entry.user_id,
            &json!({ "action": "SESSION-ENDED", "tunnel_id": entry.tunnel_id, "kind": kind, "by": me.username,
                     "details": format!("{} ended your {kind} session on \"{name}\"", me.username) }),
        );
    }
    let ip = entry.ip.as_deref().unwrap_or("-");
    let port = tunnel.as_ref().and_then(|t| u16::try_from(t.reverse_port).ok());
    state
        .gateway
        .event("session_ended", None, port, Some(entry.tunnel_id), format!("{} ended {}'s {kind} session on {name} (from {ip})", me.username, entry.username))
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// 結束一個進行中的 session（MCP agent session、agent 的瀏覽器、或有 socket 迴圈在等的那些）；不在了 = false。
/// 功能權限被關掉時（`features::end_denied_sessions`）也走這裡。
/// Ends one live session (an MCP agent session, an agent browser, or one with a socket loop); false when it is gone.
/// Also used when a feature is turned off (`features::end_denied_sessions`).
pub async fn end_entry(state: &AppState, entry: &crate::presence::Entry, by: &str) -> bool {
    let id = entry.id;
    if entry.kind == Kind::Ai {
        let Some(ai) = state.ai.list().into_iter().find(|s| s.presence_id() == id) else { return false };
        crate::ai::close(state, &ai.id, crate::ai::CloseReason::ClosedByUser).await;
    } else if let Some(b) = state.ai.browsers.list().into_iter().find(|b| b.presence_id() == id) {
        // agent 開的遠端瀏覽器：沒有 WebSocket 迴圈在等，直接收掉並記下是誰。/ An agent browser has no socket loop: close it here.
        crate::ai::browser::close(state, &b.id, crate::ai::CloseReason::ClosedByUser, Some(by)).await;
    } else if state.presence.end(id, by).is_none() {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::may_end;

    #[test]
    fn who_may_end_a_session() {
        assert!(may_end(7, 7, false), "your own");
        assert!(may_end(7, 9, true), "someone else's on a tunnel you manage");
        assert!(!may_end(7, 9, false), "someone else's elsewhere");
    }
}
