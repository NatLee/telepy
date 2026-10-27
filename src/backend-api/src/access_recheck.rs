//! 失去權限就結束進行中的 session：不只網頁終端機，每一種「使用中」都算——檔案管理、遠端瀏覽器、遠端桌面、
//! 網頁內 RustDesk、筆電經 gateway 的 ssh、看別人的終端機（MCP agent 的 session / 瀏覽器由 `crate::ai` 自己的規則收）。
//! 每筆「使用中」（[`crate::presence`]）用純函式 [`lost`] 判斷它的主人還有沒有那種 session 需要的權限，沒有就走
//! 即時 session 的結束路徑（[`crate::presence::Presence::end_because`]），所以每種 session 自己的收尾照跑：socket 以
//! 4009 關（原因 [`ENDED_BY`]）、gateway 丟掉 direct-tcpip 的橋、遠端桌面 / RustDesk 收掉、`*_close` 事件寫為什麼，
//! 本人收到 `SESSION-ENDED {reason, kind}`。
//! 觸發點：存取一變就 [`kick`]（取消分享、離開、分享到期、降權限、允許清單變小、帳號改名 / 刪除、暫時授權結束、
//! 帳號停用、斷線政策改成 never、功能權限寫入），加上每 10 秒的 [`run`] 接住其他的（群組變動、站台上限…）。
//!
//! Losing access ends live sessions of every kind, not only web terminals: files, remote browser, desktop, RustDesk,
//! laptop SSH through the gateway and terminal watchers (MCP agent sessions / browsers keep `crate::ai`'s own rule).
//! For each presence entry the pure [`lost`] decides whether its owner still has what that session needs; if not,
//! it is ended through the live-session path, so each kind's own teardown runs (4009 with [`ENDED_BY`], the gateway
//! drops the bridge, desktop / RustDesk stop, the close event says why) and the person gets `SESSION-ENDED`.
//! Triggers: [`kick`] right after every access change, plus the 10 s [`run`] loop for the rest.

use std::collections::{HashMap, HashSet};

use serde_json::json;

use crate::db;
use crate::features::{Feature, Policy as FeaturePolicy};
use crate::permissions::{self, Effective, Permission};
use crate::presence::Kind;
use crate::state::AppState;
use crate::terminal_detach::{grace_for, Decider};

/// 誰結束的（`SESSION-ENDED.by`、socket 的 4009 原因）。/ Who ended it (`SESSION-ENDED.by`, the 4009 reason).
pub const ENDED_BY: &str = "Telepy (access changed)";

/// 一個進行中的 session，判斷要用的部分。/ The parts of a live session the decision needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionView<'a> {
    pub kind: Kind,
    pub user_id: i64,
    /// 登入的裝置帳號（終端機 / 檔案 / 遠端瀏覽器 / 遠端桌面 / RustDesk 的跳板帳號）。/ The device account it runs as.
    pub account: Option<&'a str>,
    /// 區網主機的終端機（另外要 `network`）。/ A LAN-host terminal (also needs `network`).
    pub lan: bool,
    /// 斷線保留中的終端機。/ A detached web terminal.
    pub detached: bool,
    /// 看別人的終端機時，被看的那個人。/ For a watcher: whose shell.
    pub watched_user: Option<i64>,
}

/// 這個人現在對這條隧道還有什麼（[`recheck`] 從資料庫讀出來）。/ What the person has on the tunnel, as of now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessNow {
    /// 帳號還啟用著。/ The account is still active.
    pub active: bool,
    pub is_superuser: bool,
    /// 對隧道的有效權限（None = 看不到了：沒分享、隧道不見了）。/ Effective permission (None = no longer visible).
    pub eff: Option<Effective>,
    /// 現在能用的裝置帳號。/ The device accounts they may use now.
    pub accounts: Vec<String>,
    /// 被關掉的功能。/ Features turned off for them.
    pub features_off: Vec<Feature>,
    /// 斷線保留中的終端機現在的保留時間（[`crate::terminal_detach::effective`]；連著的不看）。
    /// The grace as of now, for a detached terminal (unused otherwise).
    pub grace: (u64, Decider),
}

/// 一個 session 為什麼不能再開著。/ Why a session may not stay open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lost {
    /// 帳號被停用。/ The account was disabled.
    Account,
    /// 這種 session 需要的功能被關掉了。/ The feature this kind of session needs was turned off.
    Feature(Feature),
    /// 分享被收回（或隧道不見了）。/ The share ended (or the tunnel is gone).
    Tunnel,
    /// 登入帳號被拿掉了（允許清單變小、權限降低、帳號被刪 / 改名）；筆電 ssh = 一個允許帳號都沒有了。
    /// The login account was taken away; for laptop SSH: no allowed account left.
    Login,
    /// 看終端機：不再是這條隧道的 owner / ADMIN（也不是管理員）。/ A watcher no longer manages the tunnel.
    NotManager,
    /// 斷線中，而隧道政策（`never`）或站台現在說「斷線就結束」。/ Detached, and the tunnel or the site now says "end at once".
    DetachOff,
}

impl Lost {
    /// `SESSION-ENDED.reason`。/ The `SESSION-ENDED` reason.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Account => "account_disabled",
            Self::Feature(_) => "feature_disabled",
            Self::Tunnel | Self::NotManager => "access_removed",
            Self::Login => "login_removed",
            Self::DetachOff => "detach_off",
        }
    }

    /// 寫進結束事件的那句。/ The sentence for the close event.
    pub fn why(self) -> String {
        match self {
            Self::Account => "the account was disabled".into(),
            Self::Feature(f) => format!("{} was turned off for this account", f.label()),
            Self::Tunnel => "access to the tunnel was removed".into(),
            Self::Login => "the login account is no longer allowed".into(),
            Self::NotManager => "they no longer manage this tunnel".into(),
            Self::DetachOff => "this tunnel no longer keeps disconnected shells".into(),
        }
    }
}

/// 純函式：這個 session 還能不能開著。帳號 → 功能 → 各種 session 自己要的權限：
/// - 終端機 / 檔案 / 遠端瀏覽器 / 遠端桌面 / RustDesk：VIEW + 登入的帳號還在允許清單裡；
/// - 筆電經 gateway 的 ssh：gateway 放行的同一條規則（[`permissions::can_reach_device`]）；
/// - 看終端機：還是這條隧道的 owner / ADMIN 或管理員（[`crate::terminal_watch::may_watch`]）；
/// - 斷線保留中的終端機另外看保留時間：只有隧道政策或站台說「立刻結束」才收（使用者自己後來改成 0 不影響）；
/// - MCP agent：不在這裡判斷（`crate::ai` 的 reaper 有自己的規則，含 OAuth 授權）。
///
/// Pure: may the session stay? Account → feature → what each kind needs (VIEW + its account still allowed; laptop
/// SSH = the gateway's own admission rule; watchers = still owner / ADMIN / superuser; detached terminals also check
/// the grace). MCP agent sessions are left to `crate::ai`.
pub fn lost(s: &SessionView<'_>, a: &AccessNow) -> Option<Lost> {
    if s.kind == Kind::Ai {
        return None;
    }
    if !a.active {
        return Some(Lost::Account);
    }
    if let Some(f) = Feature::needed_by(s.kind, s.lan).into_iter().find(|f| a.features_off.contains(f)) {
        return Some(Lost::Feature(f));
    }
    match s.kind {
        Kind::Watch => {
            if a.eff.is_none() && !a.is_superuser {
                return Some(Lost::Tunnel);
            }
            if !crate::terminal_watch::may_watch(a.eff, a.is_superuser, s.user_id, s.watched_user.unwrap_or(0)) {
                return Some(Lost::NotManager);
            }
            None
        }
        Kind::Ssh => {
            if a.eff.is_none() {
                return Some(Lost::Tunnel);
            }
            (!permissions::can_reach_device(a.eff, !a.accounts.is_empty())).then_some(Lost::Login)
        }
        _ => {
            if !a.eff.is_some_and(|e| e.satisfies(Permission::View)) {
                return Some(Lost::Tunnel);
            }
            // 沒記帳號的（不該發生）只看隧道。/ No account recorded (should not happen): the tunnel check only.
            if s.account.is_some_and(|acc| !a.accounts.iter().any(|x| x == acc)) {
                return Some(Lost::Login);
            }
            if s.kind == Kind::Terminal && s.detached && a.grace.0 == 0 && a.grace.1 != Decider::User {
                return Some(Lost::DetachOff);
            }
            None
        }
    }
}

/// 純函式：只看一條隧道 / 一個人時，這筆在不在範圍內。/ Pure: is the entry within the (tunnel, user) scope?
pub fn in_scope(tunnel_id: Option<i64>, user_id: Option<i64>, entry_tunnel: i64, entry_user: i64) -> bool {
    tunnel_id.is_none_or(|t| t == entry_tunnel) && user_id.is_none_or(|u| u == entry_user)
}

/// 這個人對這條隧道現在的存取（讀不到 = None：寧可留著，下一輪再看）。/ The access as of now (None on a read error).
async fn access_now(state: &AppState, policy: Option<&FeaturePolicy>, user_id: i64, tunnel_id: i64) -> Option<AccessNow> {
    let gone = |active: bool, is_superuser: bool| AccessNow { active, is_superuser, eff: None, accounts: vec![], features_off: vec![], grace: (0, Decider::User) };
    let Some(user) = db::users::by_id(&state.db, user_id).await.ok()?.filter(|u| u.is_active) else {
        return Some(gone(false, false));
    };
    let features_off: Vec<Feature> = match policy {
        Some(p) => Feature::ALL.into_iter().filter(|f| !p.allowed(&user, *f)).collect(),
        None => vec![],
    };
    let Some(tunnel) = db::tunnels::by_id(&state.db, tunnel_id).await.ok()? else {
        return Some(AccessNow { features_off, ..gone(true, user.is_superuser) });
    };
    let eff = permissions::effective_for(&state.db, user.id, &tunnel).await.ok()?;
    let accounts = permissions::allowed_usernames(&state.db, user.id, &tunnel).await.ok()?.into_iter().map(|u| u.username).collect();
    Some(AccessNow { active: true, is_superuser: user.is_superuser, eff, accounts, features_off, grace: (1, Decider::User) })
}

/// 結束了什麼（[`recheck`] 的回報）。/ What a recheck ended.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Ended {
    /// 網頁 / 筆電的 session（含斷線保留中的終端機）。/ Web / laptop sessions, detached terminals included.
    pub sessions: usize,
    /// MCP agent 的 session 與瀏覽器。/ MCP agent sessions and browsers.
    pub agent_sessions: usize,
}

/// 重新檢查進行中的 session（可只看一條隧道或一個人），失去存取的就結束。`by` = 誰結束的（[`ENDED_BY`]，
/// 功能權限寫入時是那位管理員）。
/// Re-check live sessions (optionally one tunnel or one person) and end the ones whose access is gone. `by` = who
/// ended them ([`ENDED_BY`], or the admin who changed a feature).
pub async fn recheck(state: &AppState, tunnel_id: Option<i64>, user_id: Option<i64>, by: &str) -> Ended {
    let entries: Vec<_> = state.presence.all().into_iter().filter(|e| in_scope(tunnel_id, user_id, e.tunnel_id, e.user_id)).collect();
    let mut out = Ended::default();
    if !entries.is_empty() {
        out.sessions = recheck_entries(state, entries, by).await;
    }
    out.agent_sessions = crate::ai::recheck(state, tunnel_id, user_id).await;
    out
}

async fn recheck_entries(state: &AppState, entries: Vec<crate::presence::Entry>, by: &str) -> usize {
    let shells: HashMap<u64, crate::terminal_detach::ShellRef> = state.shells.list().into_iter().map(|s| (s.presence_id, s)).collect();
    // agent 開的遠端瀏覽器也是一筆「使用中」，但歸 `crate::ai` 管。/ Agent browsers have presence too, but `crate::ai` owns them.
    let agent_browsers: HashSet<u64> = state.ai.browsers.list().iter().map(|b| b.presence_id()).collect();
    let policy = state.features.policy().await.ok();
    let mut cache: HashMap<(i64, i64), Option<AccessNow>> = HashMap::new();
    let mut ended = 0;
    for e in entries {
        if e.kind == Kind::Ai || agent_browsers.contains(&e.id) {
            continue;
        }
        let shell = shells.get(&e.id);
        let view = SessionView {
            kind: e.kind,
            user_id: e.user_id,
            account: shell.map(|s| s.account.as_str()).or(e.account.as_deref()),
            lan: shell.is_some_and(|s| s.lan_host.is_some()),
            detached: e.detached.is_some() || shell.is_some_and(|s| s.detached),
            watched_user: e.watching.as_ref().map(|w| w.user_id),
        };
        let key = (e.user_id, e.tunnel_id);
        if let std::collections::hash_map::Entry::Vacant(slot) = cache.entry(key) {
            slot.insert(access_now(state, policy.as_deref(), e.user_id, e.tunnel_id).await);
        }
        let Some(Some(mut access)) = cache.get(&key).cloned() else { continue };
        if view.kind == Kind::Terminal && view.detached && access.active {
            access.grace = grace_for(state, e.user_id, e.tunnel_id).await;
        }
        let Some(why) = lost(&view, &access) else { continue };
        if state.presence.end_because(e.id, by, &why.why()).is_none() {
            continue;
        }
        ended += 1;
        let kind = e.kind.as_str();
        tracing::info!(session = e.id, kind, user_id = e.user_id, tunnel_id = e.tunnel_id, reason = why.as_str(), "live session ended: access changed");
        let mut msg = json!({ "action": "SESSION-ENDED", "tunnel_id": e.tunnel_id, "kind": kind, "by": by,
                              "reason": why.as_str(), "detached": view.detached,
                              "details": format!("Your {kind} session ended: {}", why.why()) });
        if let Lost::Feature(f) = why {
            msg["feature"] = json!(f.id());
        }
        state.hub.notify_user(e.user_id, &msg);
    }
    ended
}

/// 停用一個帳號會切掉什麼（[`disable_preview`] 的預估、[`account_disabled`] 的實際結果）。
/// What disabling an account cuts: the preview's estimate and, after [`account_disabled`], what was done.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DisableImpact {
    /// 撤銷的網頁登入（每個瀏覽器一個；開著的頁面以 4010 關掉）。/ Web sign-ins revoked (open pages close with 4010).
    pub web_sessions: usize,
    /// 結束的進行中 session（終端機含斷線保留中的、檔案、瀏覽器、桌面、RustDesk、筆電 ssh、看終端機）。
    /// Live sessions ended (terminals incl. detached, files, browser, desktop, RustDesk, laptop SSH, watching).
    pub live_sessions: usize,
    /// 關掉的 MCP agent session 與瀏覽器。/ MCP agent sessions and browsers closed.
    pub agent_sessions: usize,
    /// 暫停的個人 API token（還在清單上，重新啟用帳號就恢復）。/ Personal API tokens suspended (kept; back on re-enable).
    pub api_tokens: usize,
    /// 暫停的已連接 app（OAuth 授權，同上）。/ Connected apps (OAuth grants) suspended, likewise.
    pub connected_apps: usize,
    /// Telepy 替他裝在裝置上的金鑰（會被移除；離線的裝置等它回來）。/ Keys Telepy installed for them on devices.
    pub device_keys: DeviceKeyImpact,
}

/// 停用帳號時要從裝置拿掉的金鑰：幾台裝置（其中幾台離線、上線後才移除）、幾個帳號。手動加的不算（Telepy 不碰）。
/// The keys disabling takes off devices: how many devices (how many of them offline, cleaned when they reconnect)
/// and login accounts. Lines added by hand are not counted (Telepy never touches them).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DeviceKeyImpact {
    pub devices: usize,
    pub accounts: usize,
    pub offline_devices: usize,
}

impl DeviceKeyImpact {
    /// 純函式：(隧道, 帳號) 列 + 哪些隧道在線 → 數字。/ Pure: (tunnel, account) rows + which tunnels are online.
    pub fn count(rows: &[(i64, String)], online: &HashSet<i64>) -> Self {
        let devices: HashSet<i64> = rows.iter().map(|(t, _)| *t).collect();
        let accounts: HashSet<(i64, &str)> = rows.iter().map(|(t, a)| (*t, a.as_str())).collect();
        DeviceKeyImpact { devices: devices.len(), accounts: accounts.len(), offline_devices: devices.iter().filter(|t| !online.contains(t)).count() }
    }
}

/// 這個人的金鑰被 Telepy 裝在哪些裝置上。/ Where Telepy installed this person's keys.
async fn device_key_impact(state: &AppState, user_id: i64) -> sqlx::Result<DeviceKeyImpact> {
    let rows = db::device_keys::installed_accounts_of_user(&state.db, user_id).await?;
    let mut online = HashSet::new();
    for t in rows.iter().map(|(t, _)| *t).collect::<HashSet<_>>() {
        if let Some(tunnel) = db::tunnels::by_id(&state.db, t).await? {
            if crate::device_keys::online(state, tunnel.reverse_port) {
                online.insert(t);
            }
        }
    }
    Ok(DeviceKeyImpact::count(&rows, &online))
}

/// 帳號停用 / 重新啟用：馬上同步他的金鑰在的每台裝置（在線的幾秒內就清掉或裝回，離線的等 15 秒一輪的檢查）。
/// An account was disabled or enabled again: sync every device holding (or listing) their keys right away.
pub async fn kick_device_keys(state: &AppState, user_id: i64) -> sqlx::Result<()> {
    let mut tunnels: HashSet<i64> = db::device_keys::effective_entries_for_user(&state.db, user_id).await?.into_iter().map(|e| e.tunnel_id).collect();
    tunnels.extend(db::device_keys::installed_accounts_of_user(&state.db, user_id).await?.into_iter().map(|(t, _)| t));
    state.device_keys.kick_many(tunnels);
    Ok(())
}

impl DisableImpact {
    pub fn json(&self) -> serde_json::Value {
        json!({
            "web_sessions": self.web_sessions,
            "live_sessions": self.live_sessions,
            "agent_sessions": self.agent_sessions,
            "api_tokens": self.api_tokens,
            "connected_apps": self.connected_apps,
            "device_keys": {
                "devices": self.device_keys.devices,
                "accounts": self.device_keys.accounts,
                "offline_devices": self.device_keys.offline_devices,
            },
        })
    }
}

/// 只數 token 與 app（停用時兩者都不撤銷，只是暫停）。/ Count tokens and apps (suspended, never revoked).
async fn suspended_counts(state: &AppState, user_id: i64) -> sqlx::Result<(usize, usize)> {
    let tokens = db::api_tokens::active_count(&state.db, user_id).await?.max(0) as usize;
    let apps = db::oauth::active_grants_for_user(&state.db, user_id).await?.len();
    Ok((tokens, apps))
}

/// 停用之前：會切掉多少（不改任何東西）。/ Before disabling: how much would be cut (changes nothing).
pub async fn disable_preview(state: &AppState, user_id: i64) -> sqlx::Result<DisableImpact> {
    let agent_browsers: HashSet<u64> = state.ai.browsers.list().iter().map(|b| b.presence_id()).collect();
    let mine: Vec<_> = state.presence.all().into_iter().filter(|e| e.user_id == user_id).collect();
    let live = mine.iter().filter(|e| e.kind != Kind::Ai && !agent_browsers.contains(&e.id)).count();
    let agents = state.ai.list().iter().filter(|s| s.user_id == user_id).count() + state.ai.browsers.list().iter().filter(|b| b.user_id == user_id).count();
    let (api_tokens, connected_apps) = suspended_counts(state, user_id).await?;
    Ok(DisableImpact {
        web_sessions: db::web_sessions::active_for_user(&state.db, user_id).await?.len(),
        live_sessions: live,
        agent_sessions: agents,
        api_tokens,
        connected_apps,
        device_keys: device_key_impact(state, user_id).await?,
    })
}

/// 帳號剛被停用（`is_active` 已經寫成 false）：撤銷所有網頁登入（原因 `disabled`：開著的頁面 4010、access token
/// 立刻失效）、結束他所有進行中的 session（原因 `account_disabled`）與 MCP agent session。個人 API token 與已連接的
/// app 不撤銷：解析時就因帳號停用而拒絕，重新啟用帳號就回來。網頁登入不會回來（要重新登入）。
/// The account was just disabled (`is_active` is already false): revoke every web sign-in (reason `disabled`: open
/// pages get 4010, access tokens stop at once), end every live session (reason `account_disabled`) and MCP agent
/// session. API tokens and connected apps are not revoked: they are refused while the account is disabled and come
/// back when it is enabled again. Web sign-ins do not come back.
pub async fn account_disabled(state: &AppState, user_id: i64) -> crate::error::ApiResult<DisableImpact> {
    let web_sessions = crate::auth::sessions::revoke_all(state, user_id, None, "disabled").await?;
    let ended = recheck(state, None, Some(user_id), ENDED_BY).await;
    let (api_tokens, connected_apps) = suspended_counts(state, user_id).await?;
    // 先數（同步會把紀錄清掉）再叫同步。/ Count first (the sync clears the rows), then kick it.
    let device_keys = device_key_impact(state, user_id).await?;
    kick_device_keys(state, user_id).await?;
    Ok(DisableImpact { web_sessions, live_sessions: ended.sessions, agent_sessions: ended.agent_sessions, api_tokens, connected_apps, device_keys })
}

/// 存取剛變過：在背景馬上重新檢查（範圍內沒有任何 session 就什麼都不做）。
/// Access just changed: re-check in the background (nothing to do when nobody is connected).
pub fn kick(state: &AppState, tunnel_id: Option<i64>, user_id: Option<i64>) {
    if state.presence.all().is_empty() && state.ai.list().is_empty() && state.ai.browsers.list().is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        recheck(&state, tunnel_id, user_id, ENDED_BY).await;
    });
}

/// 每 10 秒全部檢查一次，接住沒有馬上 kick 的變動（暫時授權到期、群組變動、站台上限改成 0…）。
/// Every 10 s, catch changes nobody kicked for (temporary grants ending, group changes, the site ceiling set to 0, …).
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let entries = state.presence.all();
        if !entries.is_empty() {
            recheck_entries(&state, entries, ENDED_BY).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_key_impact_counts_devices_accounts_and_offline_ones() {
        let rows = vec![(1, "pi".to_string()), (1, "root".to_string()), (2, "pi".to_string()), (3, "admin".to_string())];
        let online: HashSet<i64> = [1, 3].into_iter().collect();
        assert_eq!(DeviceKeyImpact::count(&rows, &online), DeviceKeyImpact { devices: 3, accounts: 4, offline_devices: 1 });
        assert_eq!(DeviceKeyImpact::count(&[], &online), DeviceKeyImpact::default());
    }

    fn ok() -> AccessNow {
        AccessNow {
            active: true,
            is_superuser: false,
            eff: Some(Effective::Shared(Permission::View)),
            accounts: vec!["ubuntu".into()],
            features_off: vec![],
            grace: (300, Decider::User),
        }
    }

    fn view(kind: Kind, account: Option<&str>) -> SessionView<'_> {
        SessionView { kind, user_id: 7, account, lan: false, detached: false, watched_user: None }
    }

    #[test]
    fn a_disabled_account_ends_everything_but_agent_sessions() {
        let off = AccessNow { active: false, ..ok() };
        for k in [Kind::Terminal, Kind::Files, Kind::Browser, Kind::Desktop, Kind::RustDesk, Kind::Ssh, Kind::Watch] {
            assert_eq!(lost(&view(k, Some("ubuntu")), &off), Some(Lost::Account), "{k:?}");
        }
        assert_eq!(lost(&view(Kind::Ai, None), &off), None, "agent sessions follow crate::ai");
        assert_eq!(Lost::Account.as_str(), "account_disabled");
    }

    #[test]
    fn account_bound_sessions_need_view_and_their_account() {
        for k in [Kind::Terminal, Kind::Files, Kind::Browser, Kind::Desktop, Kind::RustDesk] {
            assert_eq!(lost(&view(k, Some("ubuntu")), &ok()), None, "{k:?}");
            assert_eq!(lost(&view(k, Some("root")), &ok()), Some(Lost::Login), "{k:?}: the account left the allow-list");
            assert_eq!(lost(&view(k, Some("ubuntu")), &AccessNow { eff: None, accounts: vec![], ..ok() }), Some(Lost::Tunnel), "{k:?}: unshared");
        }
    }

    #[test]
    fn each_kind_needs_its_feature() {
        let no = |f: Feature| AccessNow { features_off: vec![f], ..ok() };
        assert_eq!(lost(&view(Kind::Files, Some("ubuntu")), &no(Feature::Files)), Some(Lost::Feature(Feature::Files)));
        assert_eq!(lost(&view(Kind::Files, Some("ubuntu")), &no(Feature::Terminal)), None, "another feature doesn't matter");
        assert_eq!(lost(&view(Kind::Browser, Some("ubuntu")), &no(Feature::RemoteBrowser)), Some(Lost::Feature(Feature::RemoteBrowser)));
        assert_eq!(lost(&view(Kind::Desktop, Some("ubuntu")), &no(Feature::RemoteDesktop)), Some(Lost::Feature(Feature::RemoteDesktop)));
        assert_eq!(lost(&view(Kind::RustDesk, Some("ubuntu")), &no(Feature::RemoteDesktop)), Some(Lost::Feature(Feature::RemoteDesktop)));
        assert_eq!(lost(&view(Kind::Ssh, None), &no(Feature::KeysPersonal)), Some(Lost::Feature(Feature::KeysPersonal)));
        let lan = SessionView { lan: true, ..view(Kind::Terminal, Some("ubuntu")) };
        assert_eq!(lost(&lan, &no(Feature::Network)), Some(Lost::Feature(Feature::Network)), "a LAN-host shell also needs network");
        assert_eq!(lost(&view(Kind::Terminal, Some("ubuntu")), &no(Feature::Network)), None);
        assert_eq!(Lost::Feature(Feature::Files).why(), format!("{} was turned off for this account", Feature::Files.label()));
    }

    #[test]
    fn laptop_ssh_follows_the_gateway_rule() {
        let ssh = view(Kind::Ssh, None);
        assert_eq!(lost(&ssh, &ok()), None, "a sharee with an account");
        assert_eq!(lost(&ssh, &AccessNow { accounts: vec![], ..ok() }), Some(Lost::Login), "status only now");
        assert_eq!(lost(&ssh, &AccessNow { eff: Some(Effective::Shared(Permission::Admin)), accounts: vec![], ..ok() }), None, "ADMIN without accounts");
        assert_eq!(lost(&ssh, &AccessNow { eff: Some(Effective::Owner), accounts: vec![], ..ok() }), None, "the owner");
        assert_eq!(lost(&ssh, &AccessNow { eff: None, accounts: vec![], ..ok() }), Some(Lost::Tunnel), "unshared");
    }

    #[test]
    fn watchers_must_still_manage_the_tunnel() {
        let w = SessionView { watched_user: Some(9), ..view(Kind::Watch, None) };
        let admin = AccessNow { eff: Some(Effective::Shared(Permission::Admin)), ..ok() };
        assert_eq!(lost(&w, &admin), None);
        assert_eq!(lost(&w, &AccessNow { eff: Some(Effective::Owner), ..ok() }), None);
        assert_eq!(lost(&w, &ok()), Some(Lost::NotManager), "lowered to VIEW");
        assert_eq!(lost(&w, &AccessNow { eff: None, ..ok() }), Some(Lost::Tunnel), "unshared");
        assert_eq!(lost(&w, &AccessNow { eff: None, is_superuser: true, ..ok() }), None, "superusers watch anything");
        assert_eq!(lost(&w, &AccessNow { features_off: vec![Feature::Terminal], ..admin }), Some(Lost::Feature(Feature::Terminal)));
        assert_eq!(Lost::NotManager.as_str(), "access_removed");
    }

    #[test]
    fn the_detach_policy_only_touches_detached_terminals() {
        let never = AccessNow { grace: (0, Decider::Tunnel), ..ok() };
        let t = view(Kind::Terminal, Some("ubuntu"));
        let detached = SessionView { detached: true, ..t.clone() };
        assert_eq!(lost(&t, &never), None, "an attached shell stays");
        assert_eq!(lost(&detached, &never), Some(Lost::DetachOff));
        assert_eq!(lost(&detached, &AccessNow { grace: (0, Decider::Site), ..ok() }), Some(Lost::DetachOff), "the site switched it off");
        assert_eq!(lost(&detached, &AccessNow { grace: (0, Decider::User), ..ok() }), None, "your own later choice keeps what is kept");
        assert_eq!(lost(&detached, &ok()), None);
        assert_eq!(lost(&SessionView { detached: true, ..view(Kind::Files, Some("ubuntu")) }, &never), None, "not a terminal");
        assert_eq!(Lost::DetachOff.as_str(), "detach_off");
    }

    #[test]
    fn order_account_then_feature_then_access() {
        let all_bad = AccessNow { active: false, eff: None, accounts: vec![], features_off: vec![Feature::Files], ..ok() };
        assert_eq!(lost(&view(Kind::Files, Some("ubuntu")), &all_bad), Some(Lost::Account));
        let no_feature_no_share = AccessNow { eff: None, accounts: vec![], features_off: vec![Feature::Files], ..ok() };
        assert_eq!(lost(&view(Kind::Files, Some("ubuntu")), &no_feature_no_share), Some(Lost::Feature(Feature::Files)));
    }

    #[test]
    fn scope() {
        assert!(in_scope(None, None, 1, 2));
        assert!(in_scope(Some(1), None, 1, 2));
        assert!(!in_scope(Some(3), None, 1, 2));
        assert!(in_scope(None, Some(2), 1, 2));
        assert!(!in_scope(Some(1), Some(5), 1, 2));
    }
}
