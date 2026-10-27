//! `/ws/terminal-watch/{shell id}/`：看別人的網頁終端機（唯讀，可申請一起打字）。見 `crate::terminal_watch`。
//! - 第一則 `{type:"auth", token[, step_up]}`；shell 不在 = 4015 `shell_gone`，不能看 = 4004（隧道 owner / ADMIN /
//!   管理員才能看，而且不是自己的 shell），敏感隧道沒 step-up = 4008。
//! - 先送 binary `{type:"watch", shell, you, user, tunnel, account, lan_host, size, detached, can_force, recorded,
//!   watchers, reset}`，再一個 text frame = 現在的畫面（vt100 重畫），之後是即時輸出（text）與事件（binary：
//!   `resize` / `watchers` / `detached` / `command`）。跟不上就重新加入（再一個 `watch` frame，`reset: true`）。
//! - 看的人可以送 `{type:"control", want: true|false}`（申請 / 交回）、`{type:"control", force: true}`（owner /
//!   ADMIN 直接接手）、`{action:"pty_input", payload:{input}}`（有控制權才收）、`{action:"ping"}` → binary `pong`。
//! - shell 結束 = 4015 `ended`；從即時 session 頁結束這個觀看 = 4009；登出 = 4010。
//!
//! Watching someone's web terminal (see `crate::terminal_watch`): the current screen first, then live output and
//! events; control requests and (with control) input go to the shell.

use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};

use super::{auth, close, close_with, send, send_text, Heartbeat, CLOSE_ENDED};
use crate::client_ip::ClientMeta;
use crate::db;
use crate::permissions;
use crate::presence::{Entry, Kind, WatchOf};
use crate::state::AppState;
use crate::terminal_detach::CLOSE_SHELL_GONE;
use crate::terminal_watch::{self as watching, Cmd, Frame, Joined, Watcher};
use crate::util::fmt_duration;

async fn binary(socket: &mut WebSocket, v: &Value) -> bool {
    send(socket, Message::Binary(Bytes::from(v.to_string()))).await
}

/// 加入（或重新加入）那個 shell；shell 不在、不收 = None。/ Join (or rejoin) the shell; None when it is gone or full.
async fn join(tx: &mpsc::Sender<Cmd>, watcher: Watcher) -> Option<Joined> {
    let (reply, rx) = oneshot::channel();
    tx.send(Cmd::Join { watcher, reply }).await.ok()?;
    tokio::time::timeout(Duration::from_secs(10), rx).await.ok()?.ok()
}

pub async fn handle(state: AppState, mut socket: WebSocket, shell_id: String, meta: ClientMeta) {
    let (user, msg, mut signout) = match auth::first_message(&state, &mut socket).await {
        Ok(v) => v,
        Err(0) => return,
        Err(code) => {
            close(&mut socket, code).await;
            return;
        }
    };
    // 功能權限先：看終端機也要能用終端機。/ Feature gate first: watching needs the terminal feature.
    if let Err(code) = auth::require_feature(&state, &user, crate::features::Feature::Terminal).await {
        close_with(&mut socket, code, crate::features::Feature::Terminal.id()).await;
        return;
    }
    let Some(target) = state.shells.watch_target(&shell_id) else {
        close_with(&mut socket, CLOSE_SHELL_GONE, "shell_gone").await;
        return;
    };
    let Ok(Some(tunnel)) = db::tunnels::by_id(&state.db, target.tunnel_id).await else {
        close(&mut socket, 4004).await;
        return;
    };
    let eff = permissions::effective_for(&state.db, user.id, &tunnel).await.ok().flatten();
    if !watching::may_watch(eff, user.is_superuser, user.id, target.user_id) {
        tracing::warn!(user = %user.username, shell = %shell_id, "Terminal watch refused");
        close(&mut socket, 4004).await;
        return;
    }
    if !crate::step_up::allows(tunnel.require_step_up, &state.step_up, user.id, msg.get("step_up").and_then(|v| v.as_str())) {
        close(&mut socket, crate::step_up::CLOSE_CODE).await;
        return;
    }
    let owner = db::users::by_id(&state.db, target.user_id).await.ok().flatten().map(|u| u.username).unwrap_or_else(|| format!("#{}", target.user_id));
    let lan_label = match target.lan_host.as_deref().and_then(|h| h.parse::<i64>().ok()) {
        Some(hid) => db::lan::host_by_id(&state.db, hid).await.ok().flatten().map(|h| h.label.clone().filter(|l| !l.is_empty()).unwrap_or(h.address)),
        None => None,
    };

    // 看的人也算「使用中」。/ Watching counts as presence.
    let mut entry = Entry::new(tunnel.id, user.id, &user.username, Kind::Watch, meta.ip.clone());
    entry.watching = Some(WatchOf { shell: shell_id.clone(), user_id: target.user_id, username: owner.clone() });
    let mut presence = state.presence.join(entry);
    let watcher = Watcher {
        id: presence.id(),
        user_id: user.id,
        username: user.username.clone(),
        since: crate::util::db_to_iso_utc_z(&crate::util::now_db()),
        can_force: watching::may_force(eff),
        requested: false,
    };
    let Some(joined) = join(&target.tx, watcher.clone()).await else {
        close_with(&mut socket, CLOSE_SHELL_GONE, "shell_gone").await;
        return;
    };
    let tx = target.tx.clone();
    let started = Instant::now();

    // 稽核 + 通知被看的人。/ Audit, and tell the watched user.
    let port = u16::try_from(tunnel.reverse_port).ok();
    let what = format!("{}'s web terminal as {}@{}", owner, target.account, lan_label.as_deref().unwrap_or(&tunnel.host_friendly_name));
    state.gateway.event("terminal_watch", None, port, Some(tunnel.id), format!("{} started watching {what} (shell {shell_id})", user.username)).await;
    let notify = |watching_now: bool| {
        json!({
            "action": "TERMINAL-WATCHED",
            "tunnel_id": tunnel.id,
            "tunnel_name": tunnel.host_friendly_name,
            "shell_id": shell_id,
            "by": user.username,
            "watching": watching_now,
            "details": if watching_now { format!("{} is watching your terminal on \"{}\"", user.username, tunnel.host_friendly_name) }
                       else { format!("{} stopped watching your terminal on \"{}\"", user.username, tunnel.host_friendly_name) },
        })
    };
    state.hub.notify_user(target.user_id, &notify(true));
    state.webhooks.emit(
        crate::webhooks::Event::new(crate::webhooks::Kind::SessionWatched)
            .tunnel(&tunnel)
            .to([target.user_id], None)
            .data(json!({ "by": user.username, "account": target.account, "lan_host": lan_label }))
            .link(format!("/tunnels/sessions?tunnel={}", tunnel.id)),
    );

    let first = |j: &Joined, reset: bool| {
        json!({
            "type": "watch",
            "shell": shell_id,
            "you": watcher.id,
            "user": { "id": target.user_id, "username": owner },
            "tunnel": { "id": tunnel.id, "name": tunnel.host_friendly_name },
            "account": target.account,
            "lan_host": lan_label,
            "size": { "cols": j.cols, "rows": j.rows },
            "detached": j.detached,
            "can_force": watcher.can_force,
            "recorded": tunnel.record_sessions,
            "watchers": j.watchers,
            "reset": reset,
        })
    };

    let mut joined = joined;
    let mut reset = false;
    let note: String = 'session: loop {
        // 先狀態、再畫面、再等核准的通知。/ State, then the screen, then a pending command notice.
        let ok = binary(&mut socket, &first(&joined, reset)).await && send_text(&mut socket, std::mem::take(&mut joined.screen)).await;
        if !ok {
            break 'session "the watcher left".into();
        }
        if let Some(p) = joined.pending.take() {
            let mut p = p;
            p["can_decide"] = Value::Bool(false);
            binary(&mut socket, &p).await;
        }
        let mut rx = joined.rx;
        let mut heartbeat = Heartbeat::new(&state.config);
        loop {
            tokio::select! {
                incoming = heartbeat.recv(&mut socket) => match incoming {
                    Some(Ok(Message::Text(t))) => {
                        let Ok(data) = serde_json::from_str::<Value>(&t) else { continue };
                        if data.get("action").and_then(Value::as_str) == Some("ping") {
                            if !send(&mut socket, Message::Binary(Bytes::from_static(b"pong"))).await {
                                break 'session "the watcher left".into();
                            }
                        } else if data.get("type").and_then(Value::as_str) == Some("control") {
                            let want = data.get("want").and_then(Value::as_bool).unwrap_or(false);
                            let force = data.get("force").and_then(Value::as_bool).unwrap_or(false);
                            let _ = tx.send(Cmd::Control { id: watcher.id, want, force }).await;
                        } else if data.get("action").and_then(Value::as_str) == Some("pty_input") {
                            if let Some(input) = data.pointer("/payload/input").and_then(Value::as_str) {
                                let _ = tx.send(Cmd::Input { id: watcher.id, text: input.to_string() }).await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break 'session "the watcher left".into(),
                    Some(Ok(_)) => {}
                },
                frame = rx.recv() => match frame {
                    Ok(Frame::Output(text)) => {
                        if !send_text(&mut socket, text.to_string()).await {
                            break 'session "the watcher left".into();
                        }
                    }
                    Ok(Frame::Event(v)) => {
                        if v.get("type").and_then(Value::as_str) == Some("ended") {
                            close_with(&mut socket, CLOSE_SHELL_GONE, "ended").await;
                            break 'session "the session ended".into();
                        }
                        if !binary(&mut socket, &v).await {
                            break 'session "the watcher left".into();
                        }
                    }
                    // 跟不上：重新加入，拿一個新畫面。/ Fell behind: rejoin for a fresh screen.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        match join(&tx, watcher.clone()).await {
                            Some(j) => {
                                // 外層迴圈再送一次狀態（reset）與畫面。/ The outer loop sends the state (reset) and screen again.
                                joined = j;
                                reset = true;
                                continue 'session;
                            }
                            None => {
                                close_with(&mut socket, CLOSE_SHELL_GONE, "ended").await;
                                break 'session "the session ended".into();
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        close_with(&mut socket, CLOSE_SHELL_GONE, "ended").await;
                        break 'session "the session ended".into();
                    }
                },
                by = presence.ended() => {
                    close_with(&mut socket, CLOSE_ENDED, &by).await;
                    break 'session format!("ended by {by}");
                }
                reason = signout.ended() => {
                    close_with(&mut socket, auth::CLOSE_SIGNED_OUT, &reason).await;
                    break 'session "signed out".into();
                }
            }
        }
    };

    drop(presence);
    let _ = tx.send(Cmd::Leave { id: watcher.id }).await;
    state
        .gateway
        .event(
            "terminal_watch_end",
            None,
            port,
            Some(tunnel.id),
            format!("{} stopped watching {what} after {} (shell {shell_id}); {note}", user.username, fmt_duration(started.elapsed())),
        )
        .await;
    state.hub.notify_user(target.user_id, &notify(false));
}
