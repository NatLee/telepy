//! 定時重掃：每分鐘看一次到期的排程，照設定的人的身分與權限、用存下來的參數掃（跟按下掃描走同一條路：
//! `api::lan::prepare_scan` → `scan::execute`）。網站關掉區網探索就不跑；設定的人失去 owner / ADMIN 或帳號停用就刪掉
//! 排程並寫進 Logs；裝置離線或正在掃就晚 5 分鐘再看。
//! Scheduled rescans: once a minute the due schedules run as whoever set them, with their saved parameters (the same
//! path as pressing Scan: `api::lan::prepare_scan` → `scan::execute`). Nothing runs while the site turns LAN discovery
//! off; a schedule whose person lost owner / ADMIN or was disabled is deleted (and logged); an offline device or a
//! running scan means another look in 5 minutes.

use std::time::Duration;

use chrono::Utc;

use super::scan::Trigger;
use super::watch::RETRY_SECS;
use crate::db;
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{db_time, now_db};

const TICK: Duration = Duration::from_secs(60);

pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        run_once(&state).await;
    }
}

fn later(secs: i64) -> String {
    db_time(Utc::now() + chrono::Duration::seconds(secs))
}

/// 一輪：把到期的都開始（不等它們掃完）。測試直接呼叫。/ One pass: start every due schedule (without waiting). Tests call it.
pub async fn run_once(state: &AppState) {
    match db::settings::get_solo(&state.db).await {
        Ok(s) if s.lan_scan_enabled => {}
        _ => return,
    }
    let due = match db::lan::due_schedules(&state.db, &now_db()).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "could not read the LAN scan schedules");
            return;
        }
    };
    for s in due {
        start(state, s).await;
    }
}

async fn drop_schedule(state: &AppState, s: &db::lan::LanSchedule, why: String) {
    let _ = db::lan::delete_schedule(&state.db, s.tunnel_id).await;
    state.gateway.event("lan_schedule", None, None, Some(s.tunnel_id), format!("Scheduled LAN scan removed: {why}")).await;
}

async fn start(state: &AppState, s: db::lan::LanSchedule) {
    let Ok(Some(tunnel)) = db::tunnels::by_id(&state.db, s.tunnel_id).await else {
        let _ = db::lan::delete_schedule(&state.db, s.tunnel_id).await;
        return;
    };
    let user = match db::users::by_id(&state.db, s.user_id).await {
        Ok(Some(u)) if u.is_active => u,
        _ => return drop_schedule(state, &s, "the person who set it is no longer active".into()).await,
    };
    let eff = match permissions::effective_for(&state.db, user.id, &tunnel).await {
        Ok(Some(e)) if e.satisfies(Permission::Admin) => e,
        _ => return drop_schedule(state, &s, format!("{} no longer manages the tunnel", user.username)).await,
    };
    // 區網功能被關掉：先不跑，功能回來就照常。/ The network feature is off for them: wait until it comes back.
    if crate::features::check(state, &user, crate::features::Feature::Network).await.is_err() {
        let _ = db::lan::postpone_schedule(&state.db, s.tunnel_id, &later(s.every_secs)).await;
        return;
    }
    let req = crate::api::lan::prepare_scan(state, &user, &tunnel, eff, s.username.as_deref(), s.subnet_list(), s.port_list(), s.identify, Trigger::Schedule).await;
    let req = match req {
        Ok(r) => r,
        Err(e) => {
            let body = e.body;
            let code = body["code"].as_str().unwrap_or_default().to_string();
            if matches!(code.as_str(), "device_offline" | "lan_scan_running") {
                // 晚一點再看，不算一次。/ Look again a bit later; it doesn't count as a run.
                let _ = db::lan::postpone_schedule(&state.db, s.tunnel_id, &later(RETRY_SECS)).await;
            } else {
                let at = now_db();
                let msg = body["error"].as_str().unwrap_or("could not start").to_string();
                let _ = db::lan::schedule_ran(&state.db, s.tunnel_id, &at, &later(s.every_secs), Some(&msg)).await;
            }
            return;
        }
    };
    // 先把下次排好，這一輪就不會再撿到它。/ Set the next run first so the next pass doesn't pick it again.
    let at = now_db();
    let next = later(s.every_secs);
    let _ = db::lan::postpone_schedule(&state.db, s.tunnel_id, &next).await;
    let st = state.clone();
    tokio::spawn(async move {
        let summary = super::scan::execute(st.clone(), req).await;
        let _ = db::lan::schedule_ran(&st.db, s.tunnel_id, &at, &next, summary.status.error.as_deref()).await;
    });
}
