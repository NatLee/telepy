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

fn session_json(state: &AppState, e: &Entry, tunnel_name: Option<&str>, me: i64) -> Value {
    json!({
        "id": e.id,
        "tunnel": { "id": e.tunnel_id, "name": tunnel_name },
        "user": { "id": e.user_id, "username": e.username },
        "kind": e.kind.as_str(),
        "ip": e.ip,
        "geo": state.geoip.json(e.ip.as_deref()),
        "since": db_to_iso_utc_z(&e.since),
        "client": e.client,
        "mine": e.user_id == me,
    })
}

/// 現在的 session（依開始時間）。/ Live sessions, oldest first.
#[utoipa::path(get, path = "/api/sessions", tag = "Sessions", security(("bearer" = [])), responses((status = 200, body = super::schemas::LiveSessions)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let managed = managed(&state, &me).await?;
    let mut names: HashMap<i64, String> = managed.iter().map(|(id, t)| (*id, t.host_friendly_name.clone())).collect();
    let mut out = Vec::new();
    for e in state.presence.all() {
        if !may_end(e.user_id, me.id, managed.contains_key(&e.tunnel_id)) {
            continue;
        }
        if !names.contains_key(&e.tunnel_id) {
            if let Some(t) = db::tunnels::by_id(&state.db, e.tunnel_id).await? {
                names.insert(t.id, t.host_friendly_name);
            }
        }
        out.push(session_json(&state, &e, names.get(&e.tunnel_id).map(String::as_str), me.id));
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
    if entry.kind == Kind::Ai {
        let ai = state.ai.list().into_iter().find(|s| s.presence_id() == id).ok_or_else(not_found)?;
        crate::ai::close(&state, &ai.id, crate::ai::CloseReason::ClosedByUser).await;
    } else {
        state.presence.end(id, &me.username).ok_or_else(not_found)?;
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
