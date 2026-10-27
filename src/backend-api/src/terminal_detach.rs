//! 網頁終端機斷線保留（detach / 重新接上）：瀏覽器斷線（換網路、筆電睡著、重新整理）時 shell 不跟著結束，
//! 在「保留時間」內同一個人帶 `resume: <shell id>` 重連就接回同一個 shell；時間到才收掉。
//! 保留時間是三層裡最窄的那個（[`effective`]）：
//! - 個人設定 `terminal_detach_secs`（0 = 斷線就結束，既有使用者的預設；否則 60 / 300 / 900 / 1800 / 3600 秒）；
//! - 站台上限 `terminal_detach_max_secs`（預設 1800，0 = 整個功能關閉）；
//! - 隧道政策 `terminal_detach_policy`：`user`（照個人）或 `never`（一律立刻結束，給敏感裝置）。
//!
//! 斷線期間 shell 照跑：輸出照錄影、照餵指令規則的畫面模型，並留最後 [`BUFFER_BYTES`] 給重連時補送（[`Backlog`]）。
//! 明確的結束（關分頁送 `{action:"end"}`、即時 session 頁結束、登出）一律立刻收掉。
//!
//! Web terminal detach / reattach: a dropped browser (network switch, sleeping laptop, reload) no longer ends the shell.
//! Within the grace time the same user reconnects with `resume: <shell id>` and continues the same shell; when time is
//! up it ends. The grace is the narrowest of three layers ([`effective`]): the user's choice, the site's ceiling and
//! the tunnel's policy. While detached the shell keeps running, recording and feeding the command-rule screen model,
//! and the last [`BUFFER_BYTES`] of output are kept for the replay. Explicit ends (closing the tab, the live sessions
//! page, signing out) always end it at once.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Instant;

use tokio::sync::{mpsc, oneshot};

use crate::db;
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::terminal_watch::Cmd as WatchCmd;

/// 個人可以選的保留秒數（0 = 斷線就結束）。/ The grace times a user can pick (0 = end at once).
pub const CHOICES: [i64; 6] = [0, 60, 300, 900, 1800, 3600];
/// 站台上限的合理範圍（秒）。/ The site ceiling's range in seconds.
pub const SITE_MAX_RANGE: std::ops::RangeInclusive<i64> = 0..=86_400;
/// 重連時補送的輸出最多留多少（UTF-8 位元組）。/ How much output is kept for the replay (UTF-8 bytes).
pub const BUFFER_BYTES: usize = 256 * 1024;
/// 一個人最多同時留幾個斷線中的 shell；再多就收掉最舊的。/ Detached shells kept per user; the oldest goes beyond this.
pub const MAX_DETACHED_PER_USER: usize = 10;
/// 4015：要接回的 shell 已經不在了（時間到、結束了、伺服器重啟）。/ 4015: the shell to resume is gone.
pub const CLOSE_SHELL_GONE: u16 = 4015;
/// 4016：這個 shell 在別的視窗接回去了。/ 4016: the shell was resumed in another window.
pub const CLOSE_TAKEN_OVER: u16 = 4016;

/// 隧道的斷線政策。/ A tunnel's detach policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// 照使用者自己的選擇（受站台上限）。/ Follow the user's choice (within the site ceiling).
    User,
    /// 一律斷線就結束（敏感裝置）。/ Always end at once (sensitive devices).
    Never,
}

impl Policy {
    pub const VALUES: [&'static str; 2] = ["user", "never"];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "user" => Some(Self::User),
            "never" => Some(Self::Never),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Never => "never",
        }
    }
}

/// 實際保留時間是哪一層決定的。/ Which layer decided the grace time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decider {
    /// 你自己的選擇。/ Your own choice.
    User,
    /// 站台上限（或整個功能被關掉）。/ The site ceiling (or the feature is off).
    Site,
    /// 這台裝置的政策。/ This device's policy.
    Tunnel,
}

impl Decider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Site => "site",
            Self::Tunnel => "tunnel",
        }
    }
}

/// 三層取最窄（純函式）：隧道 `never` 最優先，站台關掉其次，再來是個人選擇與站台上限較小的那個。
/// The narrowest of the three layers: a `never` tunnel wins, then a switched-off site, then min(user, ceiling).
pub fn effective(user_secs: i64, site_max: i64, policy: Policy) -> (u64, Decider) {
    if policy == Policy::Never {
        return (0, Decider::Tunnel);
    }
    if site_max <= 0 {
        return (0, Decider::Site);
    }
    if user_secs <= 0 {
        return (0, Decider::User);
    }
    if user_secs > site_max {
        return (site_max as u64, Decider::Site);
    }
    (user_secs as u64, Decider::User)
}

/// 這個人在這條隧道上的保留時間（讀三層設定；讀不到 = 0）。/ The grace for this user on this tunnel (0 when unreadable).
pub async fn grace_for(state: &AppState, user_id: i64, tunnel_id: i64) -> (u64, Decider) {
    let user = db::users::settings_for(&state.db, user_id).await.ok().flatten().map(|s| s.terminal_detach_secs).unwrap_or(0);
    let site = db::settings::get_solo(&state.db).await.map(|s| s.terminal_detach_max_secs).unwrap_or(0);
    let policy = db::tunnels::by_id(&state.db, tunnel_id).await.ok().flatten().and_then(|t| Policy::parse(&t.terminal_detach_policy)).unwrap_or(Policy::User);
    effective(user, site, policy)
}

/// 補送給重連的瀏覽器的內容。`offset` = 這段文字在整個輸出裡的起點（UTF-16 單位，跟瀏覽器的字串長度一樣算）；
/// `reset` = 瀏覽器要先清空畫面（重新整理過、或它看到的已經被擠出緩衝）。
/// What a reconnecting browser gets: `offset` is where `text` starts in the whole output (UTF-16 units, the way the
/// browser counts string lengths); `reset` = the browser must clear its screen first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replay {
    pub offset: u64,
    pub reset: bool,
    pub text: String,
}

/// 最後 [`BUFFER_BYTES`] 的輸出，一塊 = 送給瀏覽器的一個 text frame，所以瀏覽器記的位置一定落在塊與塊之間。
/// The last [`BUFFER_BYTES`] of output; one chunk = one text frame sent, so a browser's position is always a boundary.
#[derive(Debug)]
pub struct Backlog {
    chunks: VecDeque<(u64, String)>,
    /// 第一塊的起點（UTF-16）。/ Where the first chunk starts.
    start: u64,
    /// 下一塊的起點。/ Where the next chunk starts.
    end: u64,
    bytes: usize,
    cap: usize,
}

impl Default for Backlog {
    fn default() -> Self {
        Self::with_capacity(BUFFER_BYTES)
    }
}

impl Backlog {
    pub fn with_capacity(cap: usize) -> Self {
        Self { chunks: VecDeque::new(), start: 0, end: 0, bytes: 0, cap }
    }

    pub fn end(&self) -> u64 {
        self.end
    }

    pub fn push(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let units = text.encode_utf16().count() as u64;
        self.chunks.push_back((self.end, text.to_string()));
        self.end += units;
        self.bytes += text.len();
        // 太多就從最舊的整塊丟（至少留最新一塊）。/ Drop whole chunks from the front, keeping at least the newest.
        while self.bytes > self.cap && self.chunks.len() > 1 {
            if let Some((_, old)) = self.chunks.pop_front() {
                self.bytes -= old.len();
            }
            self.start = self.chunks.front().map(|c| c.0).unwrap_or(self.end);
        }
    }

    /// 瀏覽器看過 `seen` 為止（None = 什麼都沒有，例如重新整理）。/ The browser has seen everything before `seen`.
    pub fn replay(&self, seen: Option<u64>) -> Replay {
        if let Some(seen) = seen {
            if seen == self.end {
                return Replay { offset: seen, reset: false, text: String::new() };
            }
            if let Some(i) = self.chunks.iter().position(|c| c.0 == seen) {
                return Replay { offset: seen, reset: false, text: self.chunks.iter().skip(i).map(|c| c.1.as_str()).collect() };
            }
        }
        let mut text: String = self.chunks.iter().map(|c| c.1.as_str()).collect();
        let mut offset = self.start;
        // 前面被丟過：從第一個換行之後開始，免得半個跳脫序列畫出亂碼。/ Trimmed: start after the first newline.
        if self.start > 0 {
            if let Some(i) = text.find('\n') {
                offset += text[..=i].encode_utf16().count() as u64;
                text = text[i + 1..].to_string();
            }
        }
        Replay { offset, reset: true, text }
    }
}

/// 交接：要接回的那一方送一個 oneshot，持有 shell 的那一方（連著的 socket 或斷線保留的工作）把 shell 交過去。
/// Hand-over: the resuming side sends a oneshot; whoever holds the shell (a socket or the keeper) sends it back.
pub type Takeover<T> = oneshot::Sender<Box<T>>;

struct Slot<T> {
    user_id: i64,
    tunnel_id: i64,
    account: String,
    lan_host: Option<String>,
    presence_id: u64,
    detached_since: Option<Instant>,
    tx: mpsc::Sender<Takeover<T>>,
    /// 給看的人用的入口（`crate::terminal_watch`）。/ The entrance for watchers.
    watch: Option<mpsc::Sender<WatchCmd>>,
}

/// 要看的那個 shell 是誰的、在哪、怎麼找它（`crate::terminal_watch`）。/ Whose shell a watcher wants, and how to reach it.
#[derive(Clone)]
pub struct WatchTarget {
    pub user_id: i64,
    pub tunnel_id: i64,
    pub account: String,
    pub lan_host: Option<String>,
    pub presence_id: u64,
    pub detached: bool,
    pub tx: mpsc::Sender<WatchCmd>,
}

/// 一個開著的 shell 的身分（[`Shells::list`]）。/ An open shell's identity ([`Shells::list`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellRef {
    pub id: String,
    pub user_id: i64,
    pub tunnel_id: i64,
    pub account: String,
    pub lan_host: Option<String>,
    pub presence_id: u64,
    pub detached: bool,
}

/// 這個人現在對一個 shell 還有什麼（[`recheck`] 從資料庫讀出來）。/ What the person still has for a shell, as of now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccessNow {
    /// 帳號還啟用著。/ The account is still active.
    pub active: bool,
    /// 還看得到這條隧道（自己的或被分享 VIEW 以上）。/ Can still see the tunnel (own, or shared VIEW and up).
    pub can_view: bool,
    /// shell 登入的那個帳號還在他能用的清單裡。/ The shell's account is still on their allow-list.
    pub account_allowed: bool,
    /// 現在的保留時間（[`effective`]）。/ The grace as of now ([`effective`]).
    pub grace: (u64, Decider),
}

/// 一個 shell 為什麼不能再留著。/ Why a shell may not stay open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lost {
    /// 帳號被停用。/ The account was disabled.
    Account,
    /// 分享被收回（或隧道不見了）。/ The share ended (or the tunnel is gone).
    Tunnel,
    /// 登入帳號被拿掉了（允許清單變小、權限降低、帳號被刪 / 改名）。/ The login account was taken away.
    Login,
    /// 斷線中，而隧道政策（`never`）或站台現在說「斷線就結束」。/ Detached, and the tunnel or the site now says "end at once".
    DetachOff,
}

impl Lost {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Account => "account_disabled",
            Self::Tunnel => "access_removed",
            Self::Login => "login_removed",
            Self::DetachOff => "detach_off",
        }
    }

    /// 寫進 `terminal_close` 事件的那句。/ The sentence for the `terminal_close` event.
    pub fn why(self) -> &'static str {
        match self {
            Self::Account => "the account was disabled",
            Self::Tunnel => "access to the tunnel was removed",
            Self::Login => "the login account is no longer allowed",
            Self::DetachOff => "this tunnel no longer keeps disconnected shells",
        }
    }
}

/// 純函式：shell 還能不能留著。帳號 → 隧道 → 登入帳號；斷線中的另外看保留時間——只有隧道政策或站台
/// 說「立刻結束」才收（使用者自己後來改成 0 不影響已經在留的）。
/// Pure: may the shell stay? Account → tunnel → login account; a detached one also checks the grace — only the
/// tunnel policy or the site ending it at once counts (the user later picking 0 leaves kept shells alone).
pub fn lost(detached: bool, a: AccessNow) -> Option<Lost> {
    if !a.active {
        return Some(Lost::Account);
    }
    if !a.can_view {
        return Some(Lost::Tunnel);
    }
    if !a.account_allowed {
        return Some(Lost::Login);
    }
    if detached && a.grace.0 == 0 && a.grace.1 != Decider::User {
        return Some(Lost::DetachOff);
    }
    None
}

/// 誰結束的（`SESSION-ENDED.by`、連著的 socket 的 4009 原因）。/ Who ended it (`SESSION-ENDED.by`, the 4009 reason).
pub const ENDED_BY: &str = "Telepy (access changed)";

/// 這個 shell 的使用者現在的存取（讀不到 = None：寧可留著，下一輪再看）。/ The access as of now (None on a read error).
async fn access_now(state: &AppState, s: &ShellRef) -> Option<AccessNow> {
    let user = db::users::by_id(&state.db, s.user_id).await.ok()?;
    let Some(user) = user.filter(|u| u.is_active) else {
        return Some(AccessNow { active: false, can_view: false, account_allowed: false, grace: (0, Decider::User) });
    };
    let Some(tunnel) = db::tunnels::by_id(&state.db, s.tunnel_id).await.ok()? else {
        return Some(AccessNow { active: true, can_view: false, account_allowed: false, grace: (0, Decider::User) });
    };
    let can_view = permissions::check_access(&state.db, user.id, &tunnel, Permission::View).await.ok()?;
    let account_allowed = can_view && permissions::allowed_usernames(&state.db, user.id, &tunnel).await.ok()?.iter().any(|u| u.username == s.account);
    let grace = if s.detached { grace_for(state, user.id, tunnel.id).await } else { (1, Decider::User) };
    Some(AccessNow { active: true, can_view, account_allowed, grace })
}

/// 重新檢查開著的網頁終端機 shell（連著的與斷線保留中的都算；可只看一條隧道或一個人），失去存取的就結束：
/// 走即時 session 的同一條路（[`crate::presence::Presence::end_because`]），所以 shell 自己收掉 PTY / 程序、
/// 錄影、等核准的指令、「使用中」，並在 `terminal_close` 寫原因。回傳結束了幾個。
/// Re-check open web terminal shells (attached and detached; optionally one tunnel or one person) and end the ones
/// whose access is gone, through the live-session path, so the shell closes its PTY / process, recording, pending
/// approval and presence itself and the `terminal_close` event says why. Returns how many were ended.
pub async fn recheck(state: &AppState, tunnel_id: Option<i64>, user_id: Option<i64>) -> usize {
    let mut ended = 0;
    for s in state.shells.list() {
        if tunnel_id.is_some_and(|t| t != s.tunnel_id) || user_id.is_some_and(|u| u != s.user_id) {
            continue;
        }
        let Some(now) = access_now(state, &s).await else { continue };
        let Some(why) = lost(s.detached, now) else { continue };
        if state.presence.end_because(s.presence_id, ENDED_BY, why.why()).is_none() {
            continue;
        }
        ended += 1;
        tracing::info!(shell = %s.id, user_id = s.user_id, tunnel_id = s.tunnel_id, reason = why.as_str(), "web terminal ended: access changed");
        state.hub.notify_user(
            s.user_id,
            &serde_json::json!({ "action": "SESSION-ENDED", "tunnel_id": s.tunnel_id, "kind": "terminal", "by": ENDED_BY,
                                 "reason": why.as_str(), "detached": s.detached,
                                 "details": format!("Your terminal session ended: {}", why.why()) }),
        );
    }
    ended
}

/// 存取剛變過（取消分享、降權限、改允許清單、停用帳號、改斷線政策）：在背景馬上重新檢查。
/// Access just changed (unshare, permission, allow-list, disabled account, detach policy): re-check in the background.
pub fn kick(state: &AppState, tunnel_id: Option<i64>, user_id: Option<i64>) {
    if state.shells.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        recheck(&state, tunnel_id, user_id).await;
    });
}

/// 每 10 秒全部檢查一次，接住沒有馬上 kick 的變動（暫時授權到期、站台上限改成 0、群組變動…）。
/// Every 10 s, catch changes nobody kicked for (temporary grants ending, the site ceiling set to 0, …).
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if !state.shells.is_empty() {
            recheck(&state, None, None).await;
        }
    }
}

/// 要接回時的拒絕原因。/ Why a resume was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// 不存在（已結束 / 時間到 / 重啟）。/ Not there (ended, expired, restarted).
    Gone,
    /// 不是你的、或隧道 / 帳號 / 區網主機對不上。/ Someone else's, or a different tunnel / account / LAN host.
    NotYours,
}

/// 開著的網頁終端機 shell（連著或斷線保留中）。/ Open web terminal shells, attached or detached.
pub struct Shells<T> {
    map: Mutex<HashMap<String, Slot<T>>>,
}

impl<T> Default for Shells<T> {
    fn default() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }
}

/// 一個 shell 的身分（登記用）。/ A shell's identity, for registration.
pub struct ShellKey<'a> {
    pub user_id: i64,
    pub tunnel_id: i64,
    pub account: &'a str,
    pub lan_host: Option<&'a str>,
    pub presence_id: u64,
    pub watch: Option<mpsc::Sender<WatchCmd>>,
}

impl<T> Shells<T> {
    /// 登記，回傳交接用的接收端（持有 shell 的一方要在迴圈裡等它）。/ Register; the holder waits on the returned receiver.
    pub fn register(&self, id: &str, key: ShellKey<'_>) -> mpsc::Receiver<Takeover<T>> {
        let (tx, rx) = mpsc::channel(1);
        let slot = Slot {
            user_id: key.user_id,
            tunnel_id: key.tunnel_id,
            account: key.account.to_string(),
            lan_host: key.lan_host.map(str::to_string),
            presence_id: key.presence_id,
            detached_since: None,
            tx,
            watch: key.watch,
        };
        self.map.lock().unwrap().insert(id.to_string(), slot);
        rx
    }

    /// 同一個人、同一條隧道、同一個帳號與區網主機才能接回。/ Only the same user, tunnel, account and LAN host may resume.
    pub fn claim(&self, id: &str, user_id: i64, tunnel_id: i64, account: &str, lan_host: Option<&str>) -> Result<mpsc::Sender<Takeover<T>>, Refusal> {
        let map = self.map.lock().unwrap();
        let slot = map.get(id).ok_or(Refusal::Gone)?;
        if slot.user_id != user_id || slot.tunnel_id != tunnel_id || slot.account != account || slot.lan_host.as_deref() != lan_host {
            return Err(Refusal::NotYours);
        }
        Ok(slot.tx.clone())
    }

    pub fn set_detached(&self, id: &str, detached: bool) {
        if let Some(s) = self.map.lock().unwrap().get_mut(id) {
            s.detached_since = detached.then(Instant::now);
        }
    }

    /// 這個人斷線中的 shell 超過上限時，最舊那幾個的 presence id（呼叫端把它們結束）。
    /// Presence ids of this user's oldest detached shells beyond the cap (the caller ends them).
    pub fn over_limit(&self, user_id: i64, cap: usize) -> Vec<u64> {
        let map = self.map.lock().unwrap();
        let mut detached: Vec<(Instant, u64)> = map.values().filter(|s| s.user_id == user_id).filter_map(|s| s.detached_since.map(|t| (t, s.presence_id))).collect();
        detached.sort();
        let extra = detached.len().saturating_sub(cap);
        detached.into_iter().take(extra).map(|d| d.1).collect()
    }

    /// 看的人要找的 shell。/ The shell a watcher asks for.
    pub fn watch_target(&self, id: &str) -> Option<WatchTarget> {
        let map = self.map.lock().unwrap();
        let s = map.get(id)?;
        Some(WatchTarget {
            user_id: s.user_id,
            tunnel_id: s.tunnel_id,
            account: s.account.clone(),
            lan_host: s.lan_host.clone(),
            presence_id: s.presence_id,
            detached: s.detached_since.is_some(),
            tx: s.watch.clone()?,
        })
    }

    /// 全部開著的 shell（連著或斷線中），給 [`recheck`] 與功能權限用。/ Every open shell, for [`recheck`] and feature checks.
    pub fn list(&self) -> Vec<ShellRef> {
        let map = self.map.lock().unwrap();
        let mut v: Vec<ShellRef> = map
            .iter()
            .map(|(id, s)| ShellRef {
                id: id.clone(),
                user_id: s.user_id,
                tunnel_id: s.tunnel_id,
                account: s.account.clone(),
                lan_host: s.lan_host.clone(),
                presence_id: s.presence_id,
                detached: s.detached_since.is_some(),
            })
            .collect();
        v.sort_by_key(|s| s.presence_id);
        v
    }

    /// 某筆「使用中」是哪個 shell（即時 session 頁的「看」按鈕）。/ The shell behind a presence entry.
    pub fn by_presence(&self, presence_id: u64) -> Option<String> {
        self.map.lock().unwrap().iter().find(|(_, s)| s.presence_id == presence_id).map(|(id, _)| id.clone())
    }

    pub fn remove(&self, id: &str) {
        self.map.lock().unwrap().remove(id);
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_narrowest_layer_wins() {
        assert_eq!(effective(300, 1800, Policy::User), (300, Decider::User));
        assert_eq!(effective(3600, 1800, Policy::User), (1800, Decider::Site), "the site ceiling caps the choice");
        assert_eq!(effective(0, 1800, Policy::User), (0, Decider::User), "0 = end at once, the default");
        assert_eq!(effective(900, 0, Policy::User), (0, Decider::Site), "the site switched the feature off");
        assert_eq!(effective(900, 1800, Policy::Never), (0, Decider::Tunnel), "a never tunnel wins over everything");
        assert_eq!(effective(0, 0, Policy::Never), (0, Decider::Tunnel));
        assert_eq!(effective(1800, 1800, Policy::User), (1800, Decider::User), "equal to the ceiling = still your choice");
        assert_eq!(Policy::parse("never"), Some(Policy::Never));
        assert_eq!(Policy::parse("always"), None);
    }

    #[test]
    fn replay_from_a_boundary_or_reset() {
        let mut b = Backlog::with_capacity(1024);
        b.push("login\r\n");
        b.push("$ ");
        b.push("中文");
        assert_eq!(b.end(), 7 + 2 + 2, "offsets count UTF-16 units like the browser");
        // 接著看過的地方補。/ Continue from where the browser is.
        assert_eq!(b.replay(Some(7)), Replay { offset: 7, reset: false, text: "$ 中文".into() });
        assert_eq!(b.replay(Some(11)), Replay { offset: 11, reset: false, text: String::new() });
        // 重新整理：全部重畫。/ A reload: everything, after a reset.
        assert_eq!(b.replay(None), Replay { offset: 0, reset: true, text: "login\r\n$ 中文".into() });
        // 不在邊界上的位置（不該發生）也一樣重畫。/ A position off a boundary also redraws.
        assert!(b.replay(Some(3)).reset);
        assert!(b.replay(Some(99)).reset);
    }

    #[test]
    fn the_backlog_keeps_only_the_tail() {
        let mut b = Backlog::with_capacity(10);
        b.push("aaaa\nbb");
        b.push("cccc");
        b.push("dd\nee");
        // 第一塊被擠掉。/ The first chunk is pushed out.
        let r = b.replay(Some(0));
        assert!(r.reset, "what the browser saw is gone");
        // 從第一個換行之後開始。/ Starts after the first newline.
        assert_eq!(r.text, "ee");
        assert_eq!(r.offset, b.end() - 2);
        // 單塊比上限大也留著。/ A single chunk over the cap is kept.
        let mut b = Backlog::with_capacity(2);
        b.push("hello");
        assert_eq!(b.replay(None).text, "hello");
    }

    #[test]
    fn only_the_owner_resumes_and_the_oldest_detached_go_first() {
        let shells: Shells<()> = Shells::default();
        let _rx = shells.register("a", ShellKey { user_id: 1, tunnel_id: 5, account: "ubuntu", lan_host: None, presence_id: 10, watch: None });
        assert!(shells.claim("a", 1, 5, "ubuntu", None).is_ok());
        assert_eq!(shells.claim("a", 2, 5, "ubuntu", None).err(), Some(Refusal::NotYours));
        assert_eq!(shells.claim("a", 1, 6, "ubuntu", None).err(), Some(Refusal::NotYours));
        assert_eq!(shells.claim("a", 1, 5, "root", None).err(), Some(Refusal::NotYours));
        assert_eq!(shells.claim("a", 1, 5, "ubuntu", Some("7")).err(), Some(Refusal::NotYours));
        assert_eq!(shells.claim("b", 1, 5, "ubuntu", None).err(), Some(Refusal::Gone));
        let _rx2 = shells.register("b", ShellKey { user_id: 1, tunnel_id: 5, account: "ubuntu", lan_host: None, presence_id: 11, watch: None });
        let _rx3 = shells.register("c", ShellKey { user_id: 1, tunnel_id: 5, account: "ubuntu", lan_host: None, presence_id: 12, watch: None });
        shells.set_detached("a", true);
        std::thread::sleep(std::time::Duration::from_millis(2));
        shells.set_detached("b", true);
        assert!(shells.over_limit(1, 2).is_empty(), "attached shells don't count");
        assert_eq!(shells.over_limit(1, 1), vec![10], "the oldest detached one goes");
        shells.remove("a");
        assert_eq!(shells.claim("a", 1, 5, "ubuntu", None).err(), Some(Refusal::Gone));
        assert_eq!(shells.len(), 2);
    }

    #[test]
    fn list_shows_every_shell_attached_or_not() {
        let shells: Shells<()> = Shells::default();
        let _a = shells.register("a", ShellKey { user_id: 1, tunnel_id: 5, account: "ubuntu", lan_host: None, presence_id: 11, watch: None });
        let _b = shells.register("b", ShellKey { user_id: 2, tunnel_id: 5, account: "root", lan_host: Some("7"), presence_id: 10, watch: None });
        shells.set_detached("a", true);
        let l = shells.list();
        assert_eq!(l.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"], "in presence order");
        assert_eq!((l[0].lan_host.as_deref(), l[0].detached), (Some("7"), false));
        assert_eq!((l[1].account.as_str(), l[1].detached), ("ubuntu", true));
    }

    #[test]
    fn what_ends_a_shell() {
        let ok = AccessNow { active: true, can_view: true, account_allowed: true, grace: (300, Decider::User) };
        assert_eq!(lost(false, ok), None);
        assert_eq!(lost(true, ok), None);
        assert_eq!(lost(true, AccessNow { active: false, ..ok }), Some(Lost::Account), "a disabled account comes first");
        assert_eq!(lost(false, AccessNow { can_view: false, account_allowed: false, ..ok }), Some(Lost::Tunnel), "unshared");
        assert_eq!(lost(false, AccessNow { account_allowed: false, ..ok }), Some(Lost::Login), "the account left the allow-list");
        // 斷線政策只管斷線中的。/ The detach policy only touches detached shells.
        let never = AccessNow { grace: (0, Decider::Tunnel), ..ok };
        assert_eq!(lost(false, never), None, "an attached shell stays");
        assert_eq!(lost(true, never), Some(Lost::DetachOff));
        assert_eq!(lost(true, AccessNow { grace: (0, Decider::Site), ..ok }), Some(Lost::DetachOff), "the site switched it off");
        assert_eq!(lost(true, AccessNow { grace: (0, Decider::User), ..ok }), None, "your own later choice keeps what is kept");
        assert_eq!(Lost::DetachOff.as_str(), "detach_off");
    }
}
