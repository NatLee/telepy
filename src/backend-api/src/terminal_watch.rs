//! 看別人的網頁終端機（唯讀）與一起打字（共同操作）。
//! - 看：隧道 owner / ADMIN sharee / 管理員可以開 `/ws/terminal-watch/{shell id}/`，先拿到現在的畫面（vt100 重畫）與大小，
//!   之後是即時輸出與視窗大小變更；不收按鍵。被看的人會在終端機裡看到一行 `[Telepy] <name> is watching this session.`，
//!   並收到 `TERMINAL-WATCHED` 通知；看的人算「使用中」（kind `watch`）。
//! - 一起打字：看的人送 `{type:"control", want:true}` → 被看的人的終端機頁出現「X 想打字：允許 / 拒絕」；允許後看的人的
//!   按鍵送進同一個 PTY（這段期間指令規則把那一行算在他頭上）；被看的人隨時能收回。隧道 owner / ADMIN 可以
//!   `{type:"control", force:true}` 直接接手（被看的人會看到提示）。每一步都記進隧道的 Logs。
//!
//! 這裡是純邏輯（誰在看、誰能打字的狀態機、提示文字、權限判斷）與 shell ⇄ 觀看 socket 之間傳的型別；
//! I/O 在 `ws::terminal`（shell 那一端）與 `ws::terminal_watch`（看的人那一端）。
//!
//! Watching someone's web terminal (read-only) and typing along (shared control). Managers of the tunnel open
//! `/ws/terminal-watch/{shell id}/`: the current screen (a vt100 redraw) and size first, then live output and
//! resizes; no input. The watched user sees a notice line in their terminal and gets `TERMINAL-WATCHED`; watching
//! counts as presence (kind `watch`). A watcher may ask to type; the watched user allows / denies / revokes, and
//! owners / ADMIN sharees may force it. This module holds the pure state machine, the notice texts, the permission
//! rules and the types passed between a shell and its watchers' sockets.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};

use crate::permissions::{Effective, Permission};

/// 給看的人的 broadcast 佇列長度；跟不上（落後太多）就整個重新加入（重拿一次畫面）。
/// Broadcast queue per shell; a watcher that falls this far behind rejoins (gets a fresh screen).
pub const QUEUE: usize = 1024;
/// 一個 shell 最多幾個人同時看。/ Watchers per shell at most.
pub const MAX_WATCHERS: usize = 8;

/// shell → 看的人。`Output` 走 text frame（寫進 xterm），`Event` 走 binary JSON。/ Shell → watchers.
#[derive(Debug, Clone)]
pub enum Frame {
    Output(Arc<str>),
    Event(Arc<Value>),
}

/// 一個在看的人。/ One watcher.
#[derive(Debug, Clone)]
pub struct Watcher {
    /// 看的人那條連線的 presence id（同一個人開兩個視窗 = 兩個 watcher）。/ The watching socket's presence id.
    pub id: u64,
    pub user_id: i64,
    pub username: String,
    /// 開始看的時間（ISO）。/ When they started watching.
    pub since: String,
    /// 能不能直接接手（隧道 owner / ADMIN）。/ May take control without asking (tunnel owner / ADMIN).
    pub can_force: bool,
    /// 想打字、等被看的人決定。/ Asked to type; waiting for the watched user.
    pub requested: bool,
}

/// 看的人那條 socket → shell。/ A watcher's socket → the shell.
pub enum Cmd {
    /// 加入（或落後太多後重新加入：同一個 id 只換新的畫面與佇列）。/ Join, or rejoin after lagging (same id).
    Join { watcher: Watcher, reply: oneshot::Sender<Joined> },
    Leave { id: u64 },
    /// `want` = 要 / 不要打字；`force` = 直接接手。/ Ask for / give back control; `force` takes it.
    Control { id: u64, want: bool, force: bool },
    Input { id: u64, text: String },
}

/// 加入時 shell 給的東西：現在的畫面、大小、狀態，以及之後的即時佇列（同一刻拿，不會漏也不會重複）。
/// What a joining watcher gets, taken at one instant with the subscription: no gap, no duplicate.
pub struct Joined {
    /// vt100 重畫現在畫面的跳脫序列（含游標位置與模式）。/ Escape sequences that redraw the current screen.
    pub screen: String,
    pub cols: u32,
    pub rows: u32,
    pub detached: bool,
    /// `watchers` frame（誰在看、誰能打字）。/ The `watchers` frame.
    pub watchers: Value,
    /// 還在等核准的指令通知（有的話）。/ The pending command notice, if any.
    pub pending: Option<Value>,
    pub rx: broadcast::Receiver<Frame>,
}

/// 控制權變化（給 shell 寫提示、稽核、通知）。/ A control change, for notices and the audit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Requested { who: String },
    /// `replaced` = 原本在打字、被換掉的人。/ `replaced` = who had control before.
    Granted { who: String, forced: bool, replaced: Option<String> },
    Denied { who: String },
    /// `by_owner` = 被看的人收回；否則是看的人自己交回（或離開）。/ Taken back by the watched user, or given back.
    Revoked { who: String, by_owner: bool },
    /// 撤回自己的申請。/ Withdrew their own request.
    Withdrawn { who: String },
}

/// 一個 shell 的觀看狀態：誰在看、誰能打字（最多一個人）。/ Who watches a shell and who may type (one at most).
#[derive(Debug, Default)]
pub struct Watchers {
    list: Vec<Watcher>,
    control: Option<u64>,
}

impl Watchers {
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn get(&self, id: u64) -> Option<&Watcher> {
        self.list.iter().find(|w| w.id == id)
    }

    /// 加入；已經在了（重新加入）回 Some(false)，滿了回 None。/ Join; Some(false) on a rejoin, None when full.
    pub fn join(&mut self, w: Watcher) -> Option<bool> {
        if self.get(w.id).is_some() {
            return Some(false);
        }
        if self.list.len() >= MAX_WATCHERS {
            return None;
        }
        self.list.push(w);
        Some(true)
    }

    /// 離開；回傳他是誰、離開時是不是正在打字。/ Leave; returns who and whether they had control.
    pub fn leave(&mut self, id: u64) -> Option<(Watcher, bool)> {
        let i = self.list.iter().position(|w| w.id == id)?;
        let w = self.list.remove(i);
        let had = self.control == Some(id);
        if had {
            self.control = None;
        }
        Some((w, had))
    }

    pub fn controller(&self) -> Option<&Watcher> {
        self.control.and_then(|id| self.get(id))
    }

    pub fn has_control(&self, id: u64) -> bool {
        self.control == Some(id)
    }

    /// 看的人的控制要求。/ A watcher's control message.
    pub fn control(&mut self, id: u64, want: bool, force: bool) -> Option<Change> {
        let w = self.get(id)?.clone();
        if force {
            if !w.can_force || self.control == Some(id) {
                return None;
            }
            let replaced = self.take_control(id);
            return Some(Change::Granted { who: w.username, forced: true, replaced });
        }
        match (want, self.control == Some(id), w.requested) {
            // 要打字：還沒有、也還沒申請過 → 申請。/ Ask once.
            (true, false, false) => {
                self.set_requested(id, true);
                Some(Change::Requested { who: w.username })
            }
            // 不要了：在打字 → 交回；在申請 → 撤回。/ Give back, or withdraw the request.
            (false, true, _) => {
                self.control = None;
                Some(Change::Revoked { who: w.username, by_owner: false })
            }
            (false, false, true) => {
                self.set_requested(id, false);
                Some(Change::Withdrawn { who: w.username })
            }
            _ => None,
        }
    }

    /// 被看的人回應申請：允許 / 拒絕（只對有申請的人）。/ The watched user answers a request.
    pub fn answer(&mut self, id: u64, allow: bool) -> Option<Change> {
        let w = self.get(id)?.clone();
        if !w.requested {
            return None;
        }
        if !allow {
            self.set_requested(id, false);
            return Some(Change::Denied { who: w.username });
        }
        let replaced = self.take_control(id);
        Some(Change::Granted { who: w.username, forced: false, replaced })
    }

    /// 被看的人收回控制權。/ The watched user takes control back.
    pub fn revoke(&mut self) -> Option<Change> {
        let w = self.controller()?.clone();
        self.control = None;
        Some(Change::Revoked { who: w.username, by_owner: true })
    }

    fn take_control(&mut self, id: u64) -> Option<String> {
        let replaced = self.controller().filter(|c| c.id != id).map(|c| c.username.clone());
        self.control = Some(id);
        self.set_requested(id, false);
        replaced
    }

    fn set_requested(&mut self, id: u64, v: bool) {
        if let Some(w) = self.list.iter_mut().find(|w| w.id == id) {
            w.requested = v;
        }
    }

    /// `{type:"watchers", watchers:[{id, username, since, control, requested}], control}`。
    pub fn json(&self) -> Value {
        json!({
            "type": "watchers",
            "watchers": self.list.iter().map(|w| json!({
                "id": w.id,
                "username": w.username,
                "since": w.since,
                "control": self.control == Some(w.id),
                "requested": w.requested,
            })).collect::<Vec<_>>(),
            "control": self.control,
        })
    }
}

/// 終端機裡的一行提示（灰色）。/ A grey notice line in the terminal.
pub fn notice_line(text: &str) -> String {
    format!("\r\n\x1b[90m[Telepy] {text}\x1b[0m\r\n")
}

/// 被看的人終端機裡的那句話。/ The sentence shown in the watched user's terminal.
pub fn change_text(c: &Change) -> String {
    match c {
        Change::Requested { who } => format!("{who} asks to type in this session (Allow / Deny above)."),
        Change::Granted { who, forced: false, .. } => format!("{who} can type in this session now."),
        Change::Granted { who, forced: true, .. } => format!("{who} took control of this session."),
        Change::Denied { who } => format!("You declined {who}'s request to type."),
        Change::Revoked { who, by_owner: true } => format!("{who} can no longer type."),
        Change::Revoked { who, by_owner: false } => format!("{who} gave back control."),
        Change::Withdrawn { who } => format!("{who} withdrew the request to type."),
    }
}

pub fn watching_text(who: &str) -> String {
    format!("{who} is watching this session.")
}

pub fn stopped_text(who: &str) -> String {
    format!("{who} stopped watching.")
}

/// 控制權變化的稽核事件：(kind, 訊息)；申請 / 拒絕 / 撤回不記。/ The audit event of a change (None for requests).
pub fn change_event(c: &Change, owner: &str, shell: &str) -> Option<(&'static str, String)> {
    match c {
        Change::Granted { who, forced: false, replaced } => Some((
            "terminal_control_granted",
            format!("{owner} let {who} type in their web terminal{} (shell {shell})", replaced.as_ref().map(|r| format!(", replacing {r}")).unwrap_or_default()),
        )),
        Change::Granted { who, forced: true, replaced } => Some((
            "terminal_control_granted",
            format!("{who} took control of {owner}'s web terminal without asking{} (shell {shell})", replaced.as_ref().map(|r| format!(", replacing {r}")).unwrap_or_default()),
        )),
        Change::Revoked { who, by_owner: true } => Some(("terminal_control_revoked", format!("{owner} took back control from {who} (shell {shell})"))),
        Change::Revoked { who, by_owner: false } => Some(("terminal_control_revoked", format!("{who} gave back control of {owner}'s web terminal (shell {shell})"))),
        _ => None,
    }
}

/// 能看這個 shell 嗎：隧道 owner / ADMIN 或管理員，而且不是自己的。/ May watch: a tunnel manager or an admin, not your own.
pub fn may_watch(eff: Option<Effective>, is_superuser: bool, watcher: i64, shell_user: i64) -> bool {
    watcher != shell_user && (is_superuser || eff.is_some_and(|e| e.satisfies(Permission::Admin)))
}

/// 能不問就接手嗎：只有隧道 owner / ADMIN（管理員也要是這條隧道的 owner / ADMIN）。
/// May take control without asking: only the tunnel's owner / ADMIN sharees (admins too need that).
pub fn may_force(eff: Option<Effective>) -> bool {
    eff.is_some_and(|e| e.satisfies(Permission::Admin))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(id: u64, name: &str, can_force: bool) -> Watcher {
        Watcher { id, user_id: id as i64, username: name.into(), since: String::new(), can_force, requested: false }
    }

    #[test]
    fn ask_allow_revoke() {
        let mut ws = Watchers::default();
        assert_eq!(ws.join(w(1, "bob", false)), Some(true));
        assert_eq!(ws.join(w(1, "bob", false)), Some(false), "a rejoin keeps the watcher");
        assert_eq!(ws.answer(1, true), None, "nothing to allow before a request");
        assert_eq!(ws.control(1, true, false), Some(Change::Requested { who: "bob".into() }));
        assert_eq!(ws.control(1, true, false), None, "asking twice is one request");
        assert!(ws.get(1).unwrap().requested);
        assert_eq!(ws.answer(1, true), Some(Change::Granted { who: "bob".into(), forced: false, replaced: None }));
        assert!(ws.has_control(1));
        assert!(!ws.get(1).unwrap().requested, "the request is settled");
        assert_eq!(ws.json()["control"], 1);
        assert_eq!(ws.json()["watchers"][0]["control"], true);
        assert_eq!(ws.revoke(), Some(Change::Revoked { who: "bob".into(), by_owner: true }));
        assert!(ws.controller().is_none());
        assert_eq!(ws.revoke(), None);
    }

    #[test]
    fn deny_withdraw_give_back_and_leave() {
        let mut ws = Watchers::default();
        ws.join(w(1, "bob", false)).unwrap();
        ws.control(1, true, false);
        assert_eq!(ws.answer(1, false), Some(Change::Denied { who: "bob".into() }));
        assert!(!ws.get(1).unwrap().requested);
        ws.control(1, true, false);
        assert_eq!(ws.control(1, false, false), Some(Change::Withdrawn { who: "bob".into() }));
        ws.control(1, true, false);
        ws.answer(1, true);
        assert_eq!(ws.control(1, false, false), Some(Change::Revoked { who: "bob".into(), by_owner: false }));
        ws.control(1, true, false);
        ws.answer(1, true);
        let (left, had) = ws.leave(1).unwrap();
        assert_eq!(left.username, "bob");
        assert!(had, "leaving while typing gives control back");
        assert!(ws.controller().is_none() && ws.is_empty());
        assert!(ws.leave(1).is_none());
    }

    #[test]
    fn force_needs_the_right_and_replaces_whoever_types() {
        let mut ws = Watchers::default();
        ws.join(w(1, "bob", false)).unwrap();
        ws.join(w(2, "carol", true)).unwrap();
        assert_eq!(ws.control(1, false, true), None, "bob may not force");
        ws.control(1, true, false);
        ws.answer(1, true);
        assert_eq!(ws.control(2, false, true), Some(Change::Granted { who: "carol".into(), forced: true, replaced: Some("bob".into()) }));
        assert!(ws.has_control(2) && !ws.has_control(1), "one typist at a time");
        assert_eq!(ws.control(2, false, true), None, "already in control");
        assert_eq!(ws.control(9, true, false), None, "unknown watcher");
    }

    #[test]
    fn the_room_has_a_limit() {
        let mut ws = Watchers::default();
        for i in 0..MAX_WATCHERS as u64 {
            ws.join(w(i, "x", false)).unwrap();
        }
        assert_eq!(ws.join(w(99, "y", false)), None);
        assert_eq!(ws.len(), MAX_WATCHERS);
    }

    #[test]
    fn who_may_watch_and_force() {
        let owner = Some(Effective::Owner);
        let admin = Some(Effective::Shared(Permission::Admin));
        let edit = Some(Effective::Shared(Permission::Edit));
        assert!(may_watch(owner, false, 1, 2));
        assert!(may_watch(admin, false, 1, 2));
        assert!(!may_watch(edit, false, 1, 2), "EDIT sharees can't watch");
        assert!(may_watch(None, true, 1, 2), "admins watch everywhere");
        assert!(!may_watch(owner, true, 2, 2), "not your own shell");
        assert!(may_force(owner) && may_force(admin));
        assert!(!may_force(edit) && !may_force(None), "an admin who isn't on the tunnel only asks");
    }

    #[test]
    fn texts_and_events() {
        assert_eq!(notice_line("x"), "\r\n\x1b[90m[Telepy] x\x1b[0m\r\n");
        assert_eq!(watching_text("bob"), "bob is watching this session.");
        let g = Change::Granted { who: "bob".into(), forced: false, replaced: None };
        assert_eq!(change_text(&g), "bob can type in this session now.");
        assert_eq!(change_event(&g, "alice", "s1"), Some(("terminal_control_granted", "alice let bob type in their web terminal (shell s1)".into())));
        let f = Change::Granted { who: "carol".into(), forced: true, replaced: Some("bob".into()) };
        assert_eq!(change_event(&f, "alice", "s1").unwrap().1, "carol took control of alice's web terminal without asking, replacing bob (shell s1)");
        assert_eq!(change_event(&Change::Revoked { who: "bob".into(), by_owner: true }, "alice", "s1").unwrap().0, "terminal_control_revoked");
        assert_eq!(change_event(&Change::Requested { who: "bob".into() }, "alice", "s1"), None);
    }
}
