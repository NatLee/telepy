//! 站內通知偏好（toast = 網頁內提示、desktop = 桌面通知）：事件 × 管道，四層。
//! 1. 內建預設：開。2. 全站預設（管理員）：每個事件 × 管道開 / 關，每個事件可「強制」（鎖住，使用者不能關）。
//! 3. 我的預設（每個人）：繼承 / 開 / 關（鎖住的不能關）。4. 這條隧道（每個人）：靜音 `all` 或只有 `status`。
//!
//! 結果 = 鎖住 ? 開 : (隧道靜音蓋到 ? 關 : 我的 ?? 全站 ?? 開)。只有自己受影響的事，自己可以改。
//! 這裡只決定「要不要提示」：通知本身照送（頁面靠它們刷新），過濾在瀏覽器（`lib/notifyPrefs.ts` 同一套規則）。
//! 個人 webhook 不受影響（各自有事件清單）。
//!
//! In-app notification preferences per event × channel (`toast` = in-app, `desktop` = desktop notification), in
//! four layers: built-in (on) → site default (admins; per event a lock = enforced, people can't turn it off) → my
//! default (inherit / on / off) → this tunnel (mute `all` or only `status`). Effective = locked ? on : (a tunnel
//! mute covers it ? off : mine ?? site ?? on). Only whether to *show* it is decided here: hub notifications are
//! still sent (pages refresh on them) and the browser filters with the same rules (`lib/notifyPrefs.ts`).
//! Personal webhooks are not affected (they keep their own event lists).

use crate::webhooks::catalog::{self, Kind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Channel {
    Toast,
    Desktop,
}

pub const CHANNELS: [Channel; 2] = [Channel::Toast, Channel::Desktop];

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Toast => "toast",
            Channel::Desktop => "desktop",
        }
    }
    pub fn parse(s: &str) -> Option<Channel> {
        CHANNELS.into_iter().find(|c| c.as_str() == s)
    }
}

/// 每條隧道的靜音範圍。/ A per-tunnel mute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mute {
    /// 這條隧道的所有事件。/ Every event about the tunnel.
    All,
    /// 只有上線 / 離線 / 降級 / 恢復。/ Only online / offline / degraded / recovered.
    Status,
}

impl Mute {
    pub fn as_str(self) -> &'static str {
        match self {
            Mute::All => "all",
            Mute::Status => "status",
        }
    }
    pub fn parse(s: &str) -> Option<Mute> {
        match s {
            "all" => Some(Mute::All),
            "status" => Some(Mute::Status),
            _ => None,
        }
    }
    pub fn covers(self, kind: Kind) -> bool {
        kind.about_tunnel() && (self == Mute::All || kind.is_status())
    }
}

/// 有站內通知的事件（目錄順序）與它們有的管道。帳號建立、登入、指令被擋等只有 webhook，不在這裡。
/// The catalogue events that have an in-app notification, and on which channels. Others (sign-ins, account
/// creation, blocked commands…) only exist as webhooks.
pub fn channels(kind: Kind) -> &'static [Channel] {
    match kind {
        // 上線 / 離線只有桌面通知（頁面上已經有狀態點）；等核准的指令在頁面上是核准卡片，不是 toast。
        // Online / offline: desktop only (the page shows the status dot); a command awaiting approval is a card.
        Kind::TunnelOffline | Kind::TunnelOnline | Kind::CommandApprovalRequested => &[Channel::Desktop],
        Kind::TunnelDegraded
        | Kind::TunnelIpChanged
        | Kind::TunnelHostKeyChanged
        | Kind::DeviceClaimAttempt
        | Kind::DeviceWarning
        | Kind::ShareReceived
        | Kind::ShareEnded
        | Kind::AccessRequested
        | Kind::AccessDecided
        | Kind::SessionWatched
        | Kind::McpSessionOpened
        | Kind::McpSessionClosed
        | Kind::AccountSignInNewDevice => &CHANNELS,
        _ => &[],
    }
}

/// 偏好頁列出的事件。/ The events the preferences list.
pub fn events() -> impl Iterator<Item = Kind> {
    catalog::ALL.iter().copied().filter(|k| !channels(*k).is_empty())
}

pub fn parse_event(s: &str) -> Option<Kind> {
    Kind::parse(s).filter(|k| !channels(*k).is_empty())
}

/// 哪一層決定的。/ Which layer decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// 管理員強制（鎖住）。/ Enforced by an admin.
    Locked,
    /// 這條隧道靜音了。/ Muted for this tunnel.
    Muted,
    /// 我的預設。/ My default.
    Mine,
    /// 全站預設。/ The site default.
    Site,
    /// 內建（開）。/ Built-in (on).
    Builtin,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Locked => "locked",
            Source::Muted => "muted",
            Source::Mine => "mine",
            Source::Site => "site",
            Source::Builtin => "builtin",
        }
    }
}

/// 一個事件 × 管道的各層值。/ The layers of one event × channel.
#[derive(Debug, Clone, Copy, Default)]
pub struct Layers {
    pub locked: bool,
    pub site: Option<bool>,
    pub mine: Option<bool>,
    pub mute: Option<Mute>,
}

/// 結果與決定的那一層。/ The effective value and the layer that decided it.
pub fn resolve(kind: Kind, l: Layers) -> (bool, Source) {
    if l.locked {
        return (true, Source::Locked);
    }
    if l.mute.is_some_and(|m| m.covers(kind)) {
        return (false, Source::Muted);
    }
    if let Some(v) = l.mine {
        return (v, Source::Mine);
    }
    if let Some(v) = l.site {
        return (v, Source::Site);
    }
    (true, Source::Builtin)
}

/// `"on"` / `"off"` / `"inherit"`（或 true / false / null）→ 值；認不得 = None。
/// Parse a preference value: on / off / inherit, or true / false / null.
pub fn parse_value(v: &serde_json::Value) -> Option<Option<bool>> {
    match v {
        serde_json::Value::Bool(b) => Some(Some(*b)),
        serde_json::Value::Null => Some(None),
        serde_json::Value::String(s) => match s.as_str() {
            "on" => Some(Some(true)),
            "off" => Some(Some(false)),
            "inherit" => Some(None),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layers_resolve_in_order() {
        let k = Kind::TunnelDegraded;
        assert_eq!(resolve(k, Layers::default()), (true, Source::Builtin));
        assert_eq!(resolve(k, Layers { site: Some(false), ..Default::default() }), (false, Source::Site));
        assert_eq!(resolve(k, Layers { site: Some(false), mine: Some(true), ..Default::default() }), (true, Source::Mine));
        assert_eq!(resolve(k, Layers { mine: Some(true), mute: Some(Mute::Status), ..Default::default() }), (false, Source::Muted));
        // 鎖住的贏過一切，包括靜音與我的關。/ A lock beats everything, mutes and my "off" included.
        assert_eq!(resolve(k, Layers { locked: true, site: Some(false), mine: Some(false), mute: Some(Mute::All) }), (true, Source::Locked));
    }

    #[test]
    fn mutes_cover_only_tunnel_events() {
        assert!(Mute::All.covers(Kind::TunnelIpChanged));
        assert!(!Mute::Status.covers(Kind::TunnelIpChanged));
        assert!(Mute::Status.covers(Kind::TunnelOffline));
        // 帳號事件不看隧道。/ Account events ignore tunnel mutes.
        assert!(!Mute::All.covers(Kind::AccountSignInNewDevice));
        assert_eq!(resolve(Kind::AccountSignInNewDevice, Layers { mute: Some(Mute::All), ..Default::default() }), (true, Source::Builtin));
    }

    #[test]
    fn only_events_with_an_in_app_notification_are_listed() {
        let names: Vec<&str> = events().map(|k| k.name()).collect();
        assert!(names.contains(&"tunnel.offline") && names.contains(&"account.sign_in_new_device"));
        assert!(!names.contains(&"user.created") && !names.contains(&"account.sign_in") && !names.contains(&"command.blocked"));
        assert_eq!(parse_event("user.created"), None);
        assert_eq!(channels(Kind::TunnelOnline), &[Channel::Desktop]);
        assert_eq!(Channel::parse("toast"), Some(Channel::Toast));
        assert_eq!(Channel::parse("email"), None);
    }

    #[test]
    fn values_parse() {
        use serde_json::json;
        assert_eq!(parse_value(&json!("on")), Some(Some(true)));
        assert_eq!(parse_value(&json!(false)), Some(Some(false)));
        assert_eq!(parse_value(&json!("inherit")), Some(None));
        assert_eq!(parse_value(&json!(null)), Some(None));
        assert!(parse_value(&json!("maybe")).is_none());
    }
}
