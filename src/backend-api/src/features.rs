//! 功能權限：一個人能不能用某個 Telepy 功能（建立隧道、終端機、遠端桌面、MCP app…）。
//! 跟隧道分享（`crate::permissions` 的 VIEW / EDIT / ADMIN）是兩件事：分享決定「哪些隧道」，這裡決定「哪些工具」；
//! 兩道門都要過——功能先、隧道權限後。
//!
//! 解析（由上到下，第一個有設定的贏）：
//!   1. 管理員（superuser）永遠全部都有；
//!   2. 使用者自己的設定（最終端，蓋過群組）；
//!   3. 所屬群組：任何一個群組拒絕 = 拒絕；否則任何一個群組允許 = 允許；
//!   4. 「所有人」的設定；
//!   5. 功能的內建預設（目前全部允許，所以升級後什麼都不變）。
//!
//! Feature permissions: whether a person may use a Telepy feature at all. Orthogonal to tunnel sharing (which decides
//! *which tunnels*); both gates apply, the feature first. Resolution, first match wins: superuser → the user's own
//! setting (the leaf) → their groups (a deny in any group wins, else an allow in any group) → "everyone" → the
//! built-in default (allowed for every feature today, so nothing changes on upgrade).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};

use crate::db::{self, users::User, Db};
use crate::error::{ApiError, ApiResult};
use crate::presence;
use crate::state::AppState;

/// 一個可開關的功能。順序 = 管理介面的列順序。/ One feature that can be turned on or off; order = UI row order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Feature {
    TunnelsCreate,
    TunnelsShare,
    Terminal,
    Toolbox,
    Files,
    RemoteBrowser,
    RemoteDesktop,
    Network,
    KeysPersonal,
    RecordingsManage,
    CommandRulesManage,
    WebhooksPersonal,
    McpConnect,
    ApiDocs,
}

impl Feature {
    pub const ALL: [Feature; 14] = [
        Feature::TunnelsCreate,
        Feature::TunnelsShare,
        Feature::Terminal,
        Feature::Toolbox,
        Feature::Files,
        Feature::RemoteBrowser,
        Feature::RemoteDesktop,
        Feature::Network,
        Feature::KeysPersonal,
        Feature::RecordingsManage,
        Feature::CommandRulesManage,
        Feature::WebhooksPersonal,
        Feature::McpConnect,
        Feature::ApiDocs,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Feature::TunnelsCreate => "tunnels.create",
            Feature::TunnelsShare => "tunnels.share",
            Feature::Terminal => "terminal",
            Feature::Toolbox => "toolbox",
            Feature::Files => "files",
            Feature::RemoteBrowser => "remote_browser",
            Feature::RemoteDesktop => "remote_desktop",
            Feature::Network => "network",
            Feature::KeysPersonal => "keys.personal",
            Feature::RecordingsManage => "recordings.manage",
            Feature::CommandRulesManage => "command_rules.manage",
            Feature::WebhooksPersonal => "webhooks.personal",
            Feature::McpConnect => "mcp.connect",
            Feature::ApiDocs => "api.docs",
        }
    }

    pub fn from_id(id: &str) -> Option<Feature> {
        Feature::ALL.into_iter().find(|f| f.id() == id)
    }

    /// 錯誤訊息與稽核事件用的英文名稱（介面用 i18n 的 `access.feature.*`）。
    /// English name for error messages and events (the UI uses `access.feature.*`).
    pub fn label(self) -> &'static str {
        match self {
            Feature::TunnelsCreate => "Create tunnels",
            Feature::TunnelsShare => "Share tunnels",
            Feature::Terminal => "Web terminal",
            Feature::Toolbox => "Toolbox",
            Feature::Files => "File manager",
            Feature::RemoteBrowser => "Remote browser",
            Feature::RemoteDesktop => "Remote desktop",
            Feature::Network => "LAN discovery",
            Feature::KeysPersonal => "Personal SSH keys",
            Feature::RecordingsManage => "Recordings",
            Feature::CommandRulesManage => "Command rules",
            Feature::WebhooksPersonal => "Personal webhooks",
            Feature::McpConnect => "MCP apps",
            Feature::ApiDocs => "API docs",
        }
    }

    /// 沒有任何設定時的值。全部允許：升級前大家都能用，升級後也一樣。/ The value without any setting (all allowed).
    pub fn default_allowed(self) -> bool {
        true
    }

    /// MCP scope 對應的功能（跟 web 一樣的門）。/ The feature an MCP scope needs (mirrors the web).
    pub fn for_scope(scope: &str) -> Option<Feature> {
        match scope {
            "ssh:exec" => Some(Feature::Terminal),
            "ssh:files" => Some(Feature::Files),
            "network:scan" => Some(Feature::Network),
            "browser:use" => Some(Feature::RemoteBrowser),
            _ => None,
        }
    }

    /// 一個進行中的 session 需要的功能（被拒絕時把它結束）。/ The feature a live session needs.
    pub fn for_presence(kind: presence::Kind) -> Option<Feature> {
        match kind {
            presence::Kind::Terminal => Some(Feature::Terminal),
            presence::Kind::Files => Some(Feature::Files),
            presence::Kind::Browser => Some(Feature::RemoteBrowser),
            presence::Kind::Desktop | presence::Kind::RustDesk => Some(Feature::RemoteDesktop),
            presence::Kind::Ssh => Some(Feature::KeysPersonal),
            presence::Kind::Ai => Some(Feature::McpConnect),
        }
    }
}

/// REST 路由 → 它需要的功能（`AuthUser` extractor 用；沒列到的路由不受功能權限影響）。
/// 刻意不擋的：停止 / ping 進行中的 session、取消分享、刪除自己的金鑰、看已連接的 app——收回權限永遠可以做。
/// REST route → the feature it needs (checked by the `AuthUser` extractor; unlisted routes are not gated). Deliberately
/// open: stopping / pinging a running session, unsharing, deleting your own keys, listing connected apps — taking
/// access away always works.
pub fn for_route(method: &str, path: &str) -> Option<Feature> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    use Feature::*;
    let f = match (method, segs.as_slice()) {
        ("GET", ["api", "reverse", "issue", "token"]) => TunnelsCreate,
        ("POST", ["api", "reverse", "create", "key", ..]) => TunnelsCreate,
        ("POST", ["api", "reverse", "server", "keys"]) => TunnelsCreate,
        ("POST", ["api", "reverse", "join"]) => TunnelsCreate,

        ("POST", ["tunnels", "share", _]) => TunnelsShare,
        ("PATCH", ["tunnels", "share", _, _, _]) => TunnelsShare,
        ("PATCH", ["tunnels", "update-permission", ..]) => TunnelsShare,
        ("GET", ["tunnels", "available-users", ..]) => TunnelsShare,
        ("POST", ["api", "reverse", "access-requests", _, "approve"]) => TunnelsShare,

        // 工具箱：新增 / 改 / 刪片段（用片段 = 打進終端機，要「網頁終端機」）。/ Toolbox: snippet writes (running one needs the terminal).
        ("POST", ["api", "snippets"]) => Toolbox,
        ("PATCH" | "DELETE", ["api", "snippets", _]) => Toolbox,

        // `shell` 是建立精靈的「登入測試」，不是檔案存取。/ `shell` is the wizard's login test, not file access.
        (_, ["api", "sftp", op, ..]) if *op != "shell" => Files,

        ("POST", ["api", "reverse", "server", _, "remote-browser", "start"]) => RemoteBrowser,

        (_, ["api", "reverse", "server", _, "desktop", ..]) => RemoteDesktop,
        ("POST", ["api", "reverse", "server", _, "rustdesk", "start"]) => RemoteDesktop,
        (_, ["api", "credentials", ..]) => RemoteDesktop,

        (_, ["api", "reverse", "server", _, "lan", ..]) => Network,
        (_, ["api", "reverse", "lan", ..]) => Network,

        ("POST" | "PUT" | "PATCH", ["api", "reverse", "user", "keys", ..]) => KeysPersonal,
        ("POST", ["api", "reverse", "server", _, "device-keys"]) => KeysPersonal,
        // 金鑰群組授權 = 把自己的金鑰裝到裝置上。/ Key-group grants install your own keys on devices.
        ("POST" | "PUT" | "PATCH", ["api", "reverse", "user", "key-groups", ..]) => KeysPersonal,

        (_, ["api", "recordings", ..]) => RecordingsManage,
        ("PUT", ["api", "reverse", "server", _, "recording"]) => RecordingsManage,

        ("POST", ["api", "command-rules"]) => CommandRulesManage,
        ("PATCH" | "DELETE", ["api", "command-rules", rid]) if *rid != "check" => CommandRulesManage,
        ("POST", ["api", "reverse", "server", _, "command-rules"]) => CommandRulesManage,

        (_, ["api", "webhooks", ..]) => WebhooksPersonal,

        (_, ["api", "oauth", "authorize"]) => McpConnect,

        ("GET", ["api", "openapi.json"]) => ApiDocs,
        _ => return None,
    };
    Some(f)
}

// ---------------------------------------------------------------- resolution (pure)

/// 結果從哪一層來。/ Where a result came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Superuser,
    User,
    Group(i64),
    Everyone,
    Default,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolved {
    pub allowed: bool,
    pub source: Source,
}

impl Resolved {
    pub fn json(&self) -> Value {
        let (from, group) = match self.source {
            Source::Superuser => ("superuser", None),
            Source::User => ("user", None),
            Source::Group(id) => ("group", Some(id)),
            Source::Everyone => ("everyone", None),
            Source::Default => ("default", None),
        };
        json!({ "allowed": self.allowed, "from": from, "group_id": group })
    }
}

/// 一個功能的解析：使用者 → 群組（拒絕優先）→ 所有人 → 預設。`groups` 依群組 id 排序以得到穩定的來源。
/// One feature: user → groups (deny wins) → everyone → default. `groups` in id order gives a stable source.
pub fn resolve(user: Option<bool>, groups: &[(i64, Option<bool>)], everyone: Option<bool>, default: bool) -> Resolved {
    if let Some(allowed) = user {
        return Resolved { allowed, source: Source::User };
    }
    if let Some((gid, _)) = groups.iter().find(|(_, v)| *v == Some(false)) {
        return Resolved { allowed: false, source: Source::Group(*gid) };
    }
    if let Some((gid, _)) = groups.iter().find(|(_, v)| *v == Some(true)) {
        return Resolved { allowed: true, source: Source::Group(*gid) };
    }
    if let Some(allowed) = everyone {
        return Resolved { allowed, source: Source::Everyone };
    }
    Resolved { allowed: default, source: Source::Default }
}

type Grants = HashMap<Feature, bool>;

/// 整張表在記憶體裡的樣子（很小：功能數 × 對象數）。/ The whole policy in memory (small: features × subjects).
#[derive(Debug, Clone, Default)]
pub struct Policy {
    pub everyone: Grants,
    pub groups: HashMap<i64, Grants>,
    /// user → 所屬群組（id 排序）。/ user → their groups, in id order.
    pub member_of: HashMap<i64, Vec<i64>>,
    pub users: HashMap<i64, Grants>,
}

impl Policy {
    pub fn from_rows(grants: &[db::features::GrantRow], memberships: &[(i64, i64)]) -> Self {
        let mut p = Policy::default();
        for g in grants {
            let Some(f) = Feature::from_id(&g.feature) else { continue };
            match g.subject_kind.as_str() {
                "everyone" => {
                    p.everyone.insert(f, g.allowed);
                }
                "group" => {
                    p.groups.entry(g.subject_id).or_default().insert(f, g.allowed);
                }
                "user" => {
                    p.users.entry(g.subject_id).or_default().insert(f, g.allowed);
                }
                _ => {}
            }
        }
        for (gid, uid) in memberships {
            p.member_of.entry(*uid).or_default().push(*gid);
        }
        for v in p.member_of.values_mut() {
            v.sort_unstable();
            v.dedup();
        }
        p
    }

    pub fn resolve(&self, user_id: i64, is_superuser: bool, f: Feature) -> Resolved {
        if is_superuser {
            return Resolved { allowed: true, source: Source::Superuser };
        }
        let groups: Vec<(i64, Option<bool>)> = self
            .member_of
            .get(&user_id)
            .map(|gs| gs.iter().map(|g| (*g, self.groups.get(g).and_then(|m| m.get(&f).copied()))).collect())
            .unwrap_or_default();
        resolve(self.users.get(&user_id).and_then(|m| m.get(&f).copied()), &groups, self.everyone.get(&f).copied(), f.default_allowed())
    }

    pub fn allowed(&self, user: &User, f: Feature) -> bool {
        self.resolve(user.id, user.is_superuser, f).allowed
    }

    /// 這個人能用的功能 id（profile 的 `features`）。/ The feature ids this person may use (the profile's `features`).
    pub fn allowed_ids(&self, user: &User) -> Vec<&'static str> {
        Feature::ALL.into_iter().filter(|f| self.allowed(user, *f)).map(Feature::id).collect()
    }
}

// ---------------------------------------------------------------- cache + checks

/// 快取多久：另一個程序（或直接改 DB）的變更最慢 5 秒生效；這個程序自己的寫入立即生效（`invalidate`）。
/// Cache lifetime: changes from elsewhere apply within 5 s; this process's own writes invalidate at once.
pub const CACHE_TTL: Duration = Duration::from_secs(5);

/// 功能權限的快取（gateway 擁有、`AppState.features` 共用，因為筆電的 SSH 也要查）。
/// The policy cache; owned by the gateway and shared as `AppState.features` (laptop SSH checks it too).
pub struct Features {
    db: Db,
    cache: moka::sync::Cache<(), Arc<Policy>>,
}

impl Features {
    pub fn new(db: Db) -> Self {
        Self { db, cache: moka::sync::Cache::builder().time_to_live(CACHE_TTL).max_capacity(1).build() }
    }

    pub async fn policy(&self) -> sqlx::Result<Arc<Policy>> {
        if let Some(p) = self.cache.get(&()) {
            return Ok(p);
        }
        let grants = db::features::grants(&self.db).await?;
        let members = db::features::memberships(&self.db).await?;
        let p = Arc::new(Policy::from_rows(&grants, &members));
        self.cache.insert((), p.clone());
        Ok(p)
    }

    pub fn invalidate(&self) {
        self.cache.invalidate_all();
    }

    pub async fn allowed(&self, user: &User, f: Feature) -> sqlx::Result<bool> {
        if user.is_superuser {
            return Ok(true);
        }
        Ok(self.policy().await?.allowed(user, f))
    }
}

pub const DISABLED_CODE: &str = "feature_disabled";

/// 給人看的拒絕說明（REST 的 `error`、MCP 的 tool error）。/ The human explanation (REST `error`, MCP tool error).
pub fn disabled_message(f: Feature) -> String {
    format!("{} is turned off for your account. Ask an administrator if you need it.", f.label())
}

/// 403 `{error, code: feature_disabled, feature}`。
pub fn disabled_error(f: Feature) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, json!({ "error": disabled_message(f), "code": DISABLED_CODE, "feature": f.id() }))
}

/// 唯一的檢查入口：任何代表某個使用者的身分（web 登入、MCP token、之後的個人 API token）都呼叫它。
/// The single check; every principal that acts for a user (web sign-in, MCP token, later personal API tokens) calls it.
pub async fn check(state: &AppState, user: &User, f: Feature) -> ApiResult<()> {
    if state.features.allowed(user, f).await? {
        Ok(())
    } else {
        Err(disabled_error(f))
    }
}

/// 設定改了之後：結束那些人現在不能再用的進行中 session（終端機、檔案、桌面、筆電 SSH、MCP agent…）。
/// 跟「即時 session」頁的結束一樣：他們會看到誰結束的（這裡 = 管理員），重新連線時就被功能權限擋下。
/// After a change: end the live sessions whose feature their user just lost, like ending them from the live sessions
/// page (the reason names the admin); reconnecting is then refused by the feature gate.
pub async fn end_denied_sessions(state: &AppState, by: &str) -> usize {
    let Ok(policy) = state.features.policy().await else { return 0 };
    let mut users: HashMap<i64, Option<User>> = HashMap::new();
    let mut ended = 0;
    for entry in state.presence.all() {
        let Some(f) = Feature::for_presence(entry.kind) else { continue };
        if let std::collections::hash_map::Entry::Vacant(slot) = users.entry(entry.user_id) {
            slot.insert(db::users::by_id(&state.db, entry.user_id).await.ok().flatten());
        }
        let Some(Some(user)) = users.get(&entry.user_id) else { continue };
        if policy.allowed(user, f) {
            continue;
        }
        if crate::api::sessions::end_entry(state, &entry, by).await {
            ended += 1;
            state.hub.notify_user(
                entry.user_id,
                &json!({ "action": "SESSION-ENDED", "tunnel_id": entry.tunnel_id, "kind": entry.kind.as_str(), "by": by, "feature": f.id(),
                         "details": format!("{} was turned off for your account, so your {} session ended", f.label(), entry.kind.as_str()) }),
            );
        }
    }
    ended
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_and_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for f in Feature::ALL {
            assert_eq!(Feature::from_id(f.id()), Some(f));
            assert!(seen.insert(f.id()), "{}", f.id());
            assert!(f.default_allowed(), "every feature is on by default, so upgrading changes nothing");
        }
        assert_eq!(Feature::from_id("nope"), None);
    }

    #[test]
    fn resolution_order() {
        // 沒有任何設定 → 預設。/ Nothing set → the default.
        assert_eq!(resolve(None, &[], None, true), Resolved { allowed: true, source: Source::Default });
        // 所有人 → 蓋過預設。/ Everyone beats the default.
        assert_eq!(resolve(None, &[], Some(false), true), Resolved { allowed: false, source: Source::Everyone });
        // 群組允許蓋過所有人的拒絕（「只有這個群組可以」）。/ A group allow beats everyone's deny ("only this group").
        assert_eq!(resolve(None, &[(1, None), (2, Some(true))], Some(false), true), Resolved { allowed: true, source: Source::Group(2) });
        // 任何一個群組拒絕就拒絕，不管別的群組允許。/ A deny in any group wins over another group's allow.
        assert_eq!(resolve(None, &[(1, Some(true)), (2, Some(false))], None, true), Resolved { allowed: false, source: Source::Group(2) });
        // 使用者自己的設定是最終端。/ The user's own setting is the leaf.
        assert_eq!(resolve(Some(true), &[(2, Some(false))], Some(false), true), Resolved { allowed: true, source: Source::User });
        assert_eq!(resolve(Some(false), &[(2, Some(true))], Some(true), true), Resolved { allowed: false, source: Source::User });
    }

    fn user(id: i64, superuser: bool) -> User {
        User {
            id,
            password: String::new(),
            last_login: None,
            is_superuser: superuser,
            username: format!("u{id}"),
            first_name: String::new(),
            last_name: String::new(),
            email: String::new(),
            is_staff: false,
            is_active: true,
            date_joined: String::new(),
        }
    }

    #[test]
    fn policy_from_rows() {
        let row = |k: &str, id: i64, f: &str, a: bool| db::features::GrantRow { subject_kind: k.into(), subject_id: id, feature: f.into(), allowed: a };
        let p = Policy::from_rows(
            &[
                row("group", 10, "terminal", false),
                row("user", 2, "terminal", true),
                row("everyone", 0, "remote_desktop", false),
                row("group", 11, "remote_desktop", true),
                row("user", 3, "unknown.feature", false),
            ],
            &[(10, 1), (10, 2), (11, 2), (11, 2)],
        );
        let (alice, bob, carol, admin) = (user(1, false), user(2, false), user(3, false), user(9, true));
        assert_eq!(p.resolve(1, false, Feature::Terminal).source, Source::Group(10));
        assert!(!p.allowed(&alice, Feature::Terminal));
        assert!(p.allowed(&bob, Feature::Terminal), "the user's allow overrides the group's deny");
        assert!(p.allowed(&carol, Feature::Terminal));
        assert!(!p.allowed(&alice, Feature::RemoteDesktop), "everyone's deny");
        assert!(p.allowed(&bob, Feature::RemoteDesktop), "group 11 allows it");
        assert!(p.allowed(&admin, Feature::RemoteDesktop) && p.allowed(&admin, Feature::Terminal), "superusers have everything");
        assert_eq!(p.member_of[&2], vec![10, 11]);
        assert_eq!(p.allowed_ids(&carol).len(), Feature::ALL.len() - 1);
        assert!(!p.allowed_ids(&alice).contains(&"terminal"));
    }

    #[test]
    fn routes_map_to_features() {
        use Feature::*;
        let cases: &[(&str, &str, Option<Feature>)] = &[
            ("GET", "/api/reverse/issue/token", Some(TunnelsCreate)),
            ("POST", "/api/reverse/create/key/abc", Some(TunnelsCreate)),
            ("POST", "/api/reverse/create/key/duplicate/abc", Some(TunnelsCreate)),
            ("POST", "/api/reverse/server/keys", Some(TunnelsCreate)),
            ("GET", "/api/reverse/server/keys", None),
            ("PATCH", "/api/reverse/server/keys/4", None),
            ("POST", "/api/reverse/join", Some(TunnelsCreate)),
            ("GET", "/api/reverse/join/3", None),
            ("POST", "/tunnels/share/4", Some(TunnelsShare)),
            ("PATCH", "/tunnels/share/4/7/expiry", Some(TunnelsShare)),
            ("PATCH", "/tunnels/update-permission/4/7", Some(TunnelsShare)),
            ("DELETE", "/tunnels/unshare/4/7", None),
            ("GET", "/tunnels/shared-users/4", None),
            ("POST", "/api/reverse/access-requests/5/approve", Some(TunnelsShare)),
            ("POST", "/api/reverse/access-requests/5/deny", None),
            ("POST", "/api/snippets", Some(Toolbox)),
            ("PATCH", "/api/snippets/3", Some(Toolbox)),
            ("GET", "/api/snippets", None),
            ("POST", "/api/snippets/3/used", None),
            ("GET", "/api/sftp/list/4/root", Some(Files)),
            ("POST", "/api/sftp/upload/4/root", Some(Files)),
            ("GET", "/api/sftp/shell/4/root", None),
            ("POST", "/api/reverse/server/4/remote-browser/start", Some(RemoteBrowser)),
            ("POST", "/api/reverse/server/remote-browser/abc/stop", None),
            ("POST", "/api/reverse/server/4/desktop/start", Some(RemoteDesktop)),
            ("GET", "/api/reverse/server/4/desktop/probe", Some(RemoteDesktop)),
            ("POST", "/api/reverse/server/desktop/abc/stop", None),
            ("POST", "/api/reverse/server/4/rustdesk/start", Some(RemoteDesktop)),
            ("GET", "/api/credentials", Some(RemoteDesktop)),
            ("GET", "/api/reverse/server/4/lan/hosts", Some(Network)),
            ("POST", "/api/reverse/server/4/lan/scan", Some(Network)),
            ("GET", "/api/reverse/lan/topology", Some(Network)),
            ("POST", "/api/reverse/user/keys", Some(KeysPersonal)),
            ("PATCH", "/api/reverse/user/keys/3", Some(KeysPersonal)),
            ("GET", "/api/reverse/user/keys", None),
            ("DELETE", "/api/reverse/user/keys/3", None),
            ("POST", "/api/reverse/server/4/device-keys", Some(KeysPersonal)),
            ("POST", "/api/reverse/server/4/device-keys/sync", None),
            ("POST", "/api/reverse/user/key-groups/2/grants", Some(KeysPersonal)),
            ("DELETE", "/api/reverse/user/key-groups/2/grants/5", None),
            ("PUT", "/api/reverse/tunnel-groups/order", None),
            ("GET", "/api/recordings", Some(RecordingsManage)),
            ("PUT", "/api/reverse/server/4/recording", Some(RecordingsManage)),
            ("POST", "/api/command-rules", Some(CommandRulesManage)),
            ("PATCH", "/api/command-rules/3", Some(CommandRulesManage)),
            ("POST", "/api/command-rules/check", None),
            ("GET", "/api/command-rules", None),
            ("POST", "/api/reverse/server/4/command-rules", Some(CommandRulesManage)),
            ("POST", "/api/command-requests/3/approve", None),
            ("GET", "/api/webhooks", Some(WebhooksPersonal)),
            ("POST", "/api/webhooks/3/test", Some(WebhooksPersonal)),
            ("GET", "/api/oauth/authorize", Some(McpConnect)),
            ("POST", "/api/oauth/authorize", Some(McpConnect)),
            ("GET", "/api/oauth/grants", None),
            ("GET", "/api/openapi.json", Some(ApiDocs)),
            ("GET", "/api/auth/user/profile", None),
            ("GET", "/api/reverse/server/dashboard", None),
        ];
        for (m, p, want) in cases {
            assert_eq!(for_route(m, p), *want, "{m} {p}");
        }
    }

    #[test]
    fn scopes_and_sessions_map_to_features() {
        assert_eq!(Feature::for_scope("ssh:exec"), Some(Feature::Terminal));
        assert_eq!(Feature::for_scope("ssh:files"), Some(Feature::Files));
        assert_eq!(Feature::for_scope("network:scan"), Some(Feature::Network));
        assert_eq!(Feature::for_scope("browser:use"), Some(Feature::RemoteBrowser));
        assert_eq!(Feature::for_scope("tunnels:read"), None);
        assert_eq!(Feature::for_presence(presence::Kind::RustDesk), Some(Feature::RemoteDesktop));
        assert_eq!(Feature::for_presence(presence::Kind::Ssh), Some(Feature::KeysPersonal));
    }
}
