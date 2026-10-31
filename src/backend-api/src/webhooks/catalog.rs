//! webhook 能送哪些事件：名稱、分組、誰收得到（個人 webhook）、管理員的全站 webhook 能不能訂。
//! 個人 webhook 的收件人一律沿用同一件事的站內通知對象，所以 webhook 不會讓人知道他在網頁上本來就看不到的事。
//! 全站 webhook（管理員）只開放少數「整個站都該知道」的事：狀態、裝置身分與安全、帳號。
//! What webhooks can send: event names, groups, who receives each one on a personal webhook (always the audience
//! of the matching in-app notification, so a webhook never tells anyone more than the web already shows them),
//! and which events the admins' site-wide webhooks may subscribe to (a curated set: status, device identity and
//! security, accounts).

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    TunnelOffline,
    TunnelOnline,
    TunnelDegraded,
    TunnelRecovered,
    TunnelIpChanged,
    TunnelHostKeyChanged,
    DeviceClaimAttempt,
    /// 裝置的磁碟 / 記憶體 / 負載 / 重開機警示（`device_facts`）。/ Disk / memory / load / reboot warnings.
    DeviceWarning,
    ShareReceived,
    ShareEnded,
    AccessRequested,
    AccessDecided,
    CommandApprovalRequested,
    CommandApprovalDecided,
    CommandBlocked,
    SessionStarted,
    /// 有人開始看你的網頁終端機（`crate::terminal_watch`）。/ Someone started watching your web terminal.
    SessionWatched,
    McpSessionOpened,
    McpSessionClosed,
    AccountSignIn,
    /// 從 90 天內沒見過的國家或瀏覽器登入。/ A sign-in from a country or browser not seen in 90 days.
    AccountSignInNewDevice,
    AccountSignInFailed,
    KeyExpiring,
    KeyExpired,
    UserCreated,
    /// 裝置載體（telepy-carrier）的快取換到新版。/ The cached device carriers were updated to a newer release.
    CarriersUpdated,
    /// 自動更新裝置載體失敗（同一個錯誤只送一次）。/ The automatic carrier update failed (each error once).
    CarriersUpdateFailed,
    /// 「送測試」按鈕。不在目錄裡，不能訂。/ The "Send test" button; not in the catalogue, cannot be subscribed to.
    Test,
}

/// 目錄的順序 = 畫面上的順序。/ Catalogue order = order on screen.
pub const ALL: &[Kind] = &[
    Kind::TunnelOffline,
    Kind::TunnelOnline,
    Kind::TunnelDegraded,
    Kind::TunnelRecovered,
    Kind::TunnelIpChanged,
    Kind::TunnelHostKeyChanged,
    Kind::DeviceClaimAttempt,
    Kind::DeviceWarning,
    Kind::ShareReceived,
    Kind::ShareEnded,
    Kind::AccessRequested,
    Kind::AccessDecided,
    Kind::CommandApprovalRequested,
    Kind::CommandApprovalDecided,
    Kind::CommandBlocked,
    Kind::SessionStarted,
    Kind::SessionWatched,
    Kind::McpSessionOpened,
    Kind::McpSessionClosed,
    Kind::AccountSignIn,
    Kind::AccountSignInNewDevice,
    Kind::AccountSignInFailed,
    Kind::KeyExpiring,
    Kind::KeyExpired,
    Kind::UserCreated,
    Kind::CarriersUpdated,
    Kind::CarriersUpdateFailed,
];

/// 狀態事件：由監控迴圈依每個 webhook 自己的延遲發出。/ Status events, timed per webhook by the monitor.
pub const STATUS: &[Kind] = &[Kind::TunnelOffline, Kind::TunnelOnline, Kind::TunnelDegraded, Kind::TunnelRecovered];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Status,
    Device,
    Sharing,
    Commands,
    Sessions,
    Account,
    Keys,
    Admin,
}

impl Group {
    pub fn as_str(self) -> &'static str {
        match self {
            Group::Status => "status",
            Group::Device => "device",
            Group::Sharing => "sharing",
            Group::Commands => "commands",
            Group::Sessions => "sessions",
            Group::Account => "account",
            Group::Keys => "keys",
            Group::Admin => "admin",
        }
    }
}

/// 個人 webhook 上誰收得到（給畫面說明用；真正的收件人由發事件的地方依權限算好）。
/// Who receives it on a personal webhook (for the UI; the real audience is computed where the event happens).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Audience {
    /// 隧道的 owner 與所有被分享的人。/ The tunnel's owner and everyone it is shared with.
    Tunnel,
    /// owner 與 ADMIN 被分享者。/ The owner and ADMIN sharees.
    Managers,
    /// owner 與 ADMIN 被分享者，但不含做這件事的人。/ Managers, minus whoever did it.
    ManagersOthers,
    /// 分享的兩端（被分享的人與 owner），不含動手的人。/ Both sides of a share, minus whoever did it.
    ShareParties,
    /// 只有你（你的帳號、你的申請、分享給你）。/ Only you.
    You,
    /// 開 session 的人與隧道 owner。/ The person whose agent it is and the tunnel's owner.
    AgentAndOwner,
    /// 只有全站 webhook。/ Site-wide webhooks only.
    SiteOnly,
}

impl Audience {
    pub fn as_str(self) -> &'static str {
        match self {
            Audience::Tunnel => "tunnel",
            Audience::Managers => "managers",
            Audience::ManagersOthers => "managers_others",
            Audience::ShareParties => "share_parties",
            Audience::You => "you",
            Audience::AgentAndOwner => "agent_and_owner",
            Audience::SiteOnly => "site_only",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Ok,
    Warning,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::TunnelOffline => "tunnel.offline",
            Kind::TunnelOnline => "tunnel.online",
            Kind::TunnelDegraded => "tunnel.degraded",
            Kind::TunnelRecovered => "tunnel.recovered",
            Kind::TunnelIpChanged => "tunnel.ip_changed",
            Kind::TunnelHostKeyChanged => "tunnel.host_key_changed",
            Kind::DeviceClaimAttempt => "device.claim_attempt",
            Kind::DeviceWarning => "tunnel.device_warning",
            Kind::ShareReceived => "share.received",
            Kind::ShareEnded => "share.ended",
            Kind::AccessRequested => "access.requested",
            Kind::AccessDecided => "access.decided",
            Kind::CommandApprovalRequested => "command.approval_requested",
            Kind::CommandApprovalDecided => "command.approval_decided",
            Kind::CommandBlocked => "command.blocked",
            Kind::SessionStarted => "session.started",
            Kind::SessionWatched => "session.watched",
            Kind::McpSessionOpened => "mcp.session_opened",
            Kind::McpSessionClosed => "mcp.session_closed",
            Kind::AccountSignIn => "account.sign_in",
            Kind::AccountSignInNewDevice => "account.sign_in_new_device",
            Kind::AccountSignInFailed => "account.sign_in_failed",
            Kind::KeyExpiring => "key.expiring",
            Kind::KeyExpired => "key.expired",
            Kind::UserCreated => "user.created",
            Kind::CarriersUpdated => "carriers.updated",
            Kind::CarriersUpdateFailed => "carriers.update_failed",
            Kind::Test => "webhook.test",
        }
    }

    /// 只認目錄裡的事件（`webhook.test` 不能訂）。/ Catalogue events only (`webhook.test` cannot be subscribed to).
    pub fn parse(s: &str) -> Option<Kind> {
        ALL.iter().copied().find(|k| k.name() == s)
    }

    pub fn group(self) -> Group {
        match self {
            Kind::TunnelOffline | Kind::TunnelOnline | Kind::TunnelDegraded | Kind::TunnelRecovered => Group::Status,
            Kind::TunnelIpChanged | Kind::TunnelHostKeyChanged | Kind::DeviceClaimAttempt | Kind::DeviceWarning => Group::Device,
            Kind::ShareReceived | Kind::ShareEnded | Kind::AccessRequested | Kind::AccessDecided => Group::Sharing,
            Kind::CommandApprovalRequested | Kind::CommandApprovalDecided | Kind::CommandBlocked => Group::Commands,
            Kind::SessionStarted | Kind::SessionWatched | Kind::McpSessionOpened | Kind::McpSessionClosed => Group::Sessions,
            Kind::AccountSignIn | Kind::AccountSignInNewDevice | Kind::AccountSignInFailed => Group::Account,
            Kind::KeyExpiring | Kind::KeyExpired => Group::Keys,
            Kind::UserCreated | Kind::CarriersUpdated | Kind::CarriersUpdateFailed | Kind::Test => Group::Admin,
        }
    }

    pub fn audience(self) -> Audience {
        match self {
            Kind::TunnelOffline | Kind::TunnelOnline | Kind::TunnelDegraded | Kind::TunnelRecovered | Kind::TunnelHostKeyChanged => Audience::Tunnel,
            Kind::TunnelIpChanged | Kind::DeviceClaimAttempt | Kind::DeviceWarning | Kind::CommandApprovalRequested => Audience::Managers,
            Kind::AccessRequested | Kind::CommandBlocked | Kind::SessionStarted => Audience::ManagersOthers,
            Kind::ShareEnded => Audience::ShareParties,
            Kind::ShareReceived | Kind::SessionWatched | Kind::AccessDecided | Kind::CommandApprovalDecided | Kind::AccountSignIn | Kind::AccountSignInNewDevice | Kind::AccountSignInFailed | Kind::KeyExpiring | Kind::KeyExpired => Audience::You,
            Kind::McpSessionOpened | Kind::McpSessionClosed => Audience::AgentAndOwner,
            Kind::UserCreated | Kind::CarriersUpdated | Kind::CarriersUpdateFailed | Kind::Test => Audience::SiteOnly,
        }
    }

    /// 個人 webhook 能訂嗎。/ Available on personal webhooks.
    pub fn personal(self) -> bool {
        !matches!(self.audience(), Audience::SiteOnly)
    }

    /// 管理員的全站 webhook 能訂嗎（整個站都該知道的事）。/ Available on site-wide webhooks.
    pub fn site(self) -> bool {
        matches!(
            self,
            Kind::TunnelOffline
                | Kind::TunnelOnline
                | Kind::TunnelDegraded
                | Kind::TunnelRecovered
                | Kind::TunnelIpChanged
                | Kind::TunnelHostKeyChanged
                | Kind::DeviceClaimAttempt
                | Kind::DeviceWarning
                | Kind::AccountSignInFailed
                | Kind::UserCreated
                | Kind::CarriersUpdated
                | Kind::CarriersUpdateFailed
        )
    }

    pub fn is_status(self) -> bool {
        STATUS.contains(&self)
    }

    /// 跟某條隧道有關的事件才看隧道篩選。/ Only tunnel events go through the tunnel filter.
    pub fn about_tunnel(self) -> bool {
        !matches!(self.group(), Group::Account | Group::Keys | Group::Admin)
    }

    pub fn severity(self) -> Severity {
        match self {
            Kind::TunnelOffline
            | Kind::TunnelDegraded
            | Kind::TunnelHostKeyChanged
            | Kind::DeviceClaimAttempt
            | Kind::DeviceWarning
            | Kind::CommandBlocked
            | Kind::AccountSignInFailed
            | Kind::AccountSignInNewDevice
            | Kind::KeyExpiring
            | Kind::KeyExpired
            | Kind::CarriersUpdateFailed => Severity::Warning,
            Kind::TunnelOnline | Kind::TunnelRecovered => Severity::Ok,
            _ => Severity::Info,
        }
    }

    /// 英文短標題（ntfy 的標題、Teams 卡片的標題）。/ A short English title (ntfy title, Teams card heading).
    pub fn title(self) -> &'static str {
        match self {
            Kind::TunnelOffline => "Tunnel offline",
            Kind::TunnelOnline => "Tunnel back online",
            Kind::TunnelDegraded => "SSH not answering",
            Kind::TunnelRecovered => "SSH answering again",
            Kind::TunnelIpChanged => "New device IP address",
            Kind::TunnelHostKeyChanged => "Device host key changed",
            Kind::DeviceClaimAttempt => "Device claimed by another account",
            Kind::DeviceWarning => "Device needs attention",
            Kind::ShareReceived => "Tunnel shared with you",
            Kind::ShareEnded => "Share ended",
            Kind::AccessRequested => "Access requested",
            Kind::AccessDecided => "Access request decided",
            Kind::CommandApprovalRequested => "Command waiting for approval",
            Kind::CommandApprovalDecided => "Command request decided",
            Kind::CommandBlocked => "Command blocked",
            Kind::SessionStarted => "Session started",
            Kind::SessionWatched => "Someone is watching your terminal",
            Kind::McpSessionOpened => "MCP agent session opened",
            Kind::McpSessionClosed => "MCP agent session closed",
            Kind::AccountSignIn => "New sign-in",
            Kind::AccountSignInNewDevice => "Sign-in from a new device",
            Kind::AccountSignInFailed => "Failed sign-in",
            Kind::KeyExpiring => "SSH key expiring soon",
            Kind::KeyExpired => "SSH key expired",
            Kind::UserCreated => "New account",
            Kind::CarriersUpdated => "Device carriers updated",
            Kind::CarriersUpdateFailed => "Device carrier update failed",
            Kind::Test => "Test",
        }
    }
}

/// 目錄（給 API / 畫面）：`site` = 全站 webhook 的目錄，否則個人的。/ The catalogue as JSON for one scope.
pub fn catalog_json(site: bool) -> Value {
    Value::Array(
        ALL.iter()
            .filter(|k| if site { k.site() } else { k.personal() })
            .map(|k| {
                json!({
                    "event": k.name(),
                    "group": k.group().as_str(),
                    "audience": if site { "site" } else { k.audience().as_str() },
                    "status": k.is_status(),
                    "tunnel": k.about_tunnel(),
                    "severity": match k.severity() { Severity::Info => "info", Severity::Ok => "ok", Severity::Warning => "warning" },
                })
            })
            .collect(),
    )
}

/// 存在資料庫的事件清單（逗號分隔）。不認得的名稱略過，重複的去掉，順序照目錄。
/// The stored list (comma separated); unknown names are skipped, duplicates dropped, catalogue order kept.
pub fn parse_list(s: &str) -> Vec<Kind> {
    let names: Vec<&str> = s.split(',').map(str::trim).filter(|x| !x.is_empty()).collect();
    ALL.iter().copied().filter(|k| names.contains(&k.name())).collect()
}

pub fn join_list(kinds: &[Kind]) -> String {
    ALL.iter().filter(|k| kinds.contains(k)).map(|k| k.name()).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_test_is_not_subscribable() {
        for k in ALL {
            assert_eq!(Kind::parse(k.name()), Some(*k));
        }
        assert_eq!(Kind::parse("webhook.test"), None);
        assert_eq!(Kind::parse("nope"), None);
    }

    #[test]
    fn site_catalogue_is_curated() {
        let site: Vec<&str> = ALL.iter().filter(|k| k.site()).map(|k| k.name()).collect();
        assert!(site.contains(&"tunnel.offline") && site.contains(&"user.created") && site.contains(&"account.sign_in_failed"));
        // 個人的事（分享給你、你的申請結果、你的登入）不進全站。/ Personal matters stay personal.
        for k in [Kind::ShareReceived, Kind::AccessDecided, Kind::CommandApprovalDecided, Kind::AccountSignIn] {
            assert!(!k.site(), "{}", k.name());
        }
        assert!(!Kind::UserCreated.personal());
        // 裝置載體的更新只有全站 webhook 收得到。/ Carrier updates are site-wide only.
        for k in [Kind::CarriersUpdated, Kind::CarriersUpdateFailed] {
            assert!(k.site() && !k.personal() && !k.about_tunnel(), "{}", k.name());
        }
    }

    #[test]
    fn list_parsing_keeps_catalogue_order() {
        let k = parse_list(" share.received, tunnel.offline,bogus,tunnel.offline ");
        assert_eq!(k, vec![Kind::TunnelOffline, Kind::ShareReceived]);
        assert_eq!(join_list(&k), "tunnel.offline,share.received");
    }

    #[test]
    fn account_events_ignore_the_tunnel_filter() {
        assert!(!Kind::AccountSignIn.about_tunnel());
        assert!(!Kind::UserCreated.about_tunnel());
        assert!(Kind::SessionStarted.about_tunnel());
    }

    #[test]
    fn catalogue_json_per_scope() {
        let personal = catalog_json(false);
        let site = catalog_json(true);
        assert!(personal.as_array().unwrap().iter().all(|e| e["event"] != "user.created"));
        assert!(site.as_array().unwrap().iter().all(|e| e["audience"] == "site"));
        assert_eq!(site.as_array().unwrap().len(), ALL.iter().filter(|k| k.site()).count());
    }
}
