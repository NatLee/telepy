//! 裝置金鑰清單：Telepy 用 russh（服務金鑰）把使用者的公鑰裝進裝置各 OS 帳號的 `~/.ssh/authorized_keys`。
//!
//! 模型 / Model:
//! - 每台裝置（隧道）有一份清單：哪些使用者金鑰要裝上去。擁有者與被分享者都只能放「自己的」金鑰。
//! - 一把金鑰裝進哪些 OS 帳號 = 金鑰擁有者在這台裝置上「允許使用的帳號」（`permissions::allowed_usernames`，
//!   與網頁終端機同一道關卡）∩ 清單上這把金鑰「選定的帳號」（`telepy_device_key.accounts`；NULL = 全部）。
//!   所以撤銷分享、縮小允許清單、取消勾選帳號、刪帳號或刪金鑰，裝置上的金鑰就跟著被移除。
//! - Windows 裝置：本機 Administrators 的金鑰寫到共用的 `%ProgramData%\ssh\administrators_authorized_keys`（`platform`）。
//! - 「應該在」與「Telepy 裝過」（`telepy_device_key_installed`）相減就是待辦；裝置上線時同步。
//!   Telepy 只移除自己裝過的金鑰，也絕不移除服務金鑰。
//!
//! Each device has a key list; a key is installed into exactly the accounts its owner may use there (narrowed
//! further by the entry's chosen accounts), so revoking access removes it. Desired − installed is reconciled
//! whenever the device is online.

pub mod authorized_keys;
pub mod platform;
pub mod remote;
pub mod view;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde_json::json;
use tokio::sync::Notify;

use crate::db::{self, device_keys::Installed, tunnels::Tunnel};
use crate::permissions;
use crate::ssh::tunnel_keys;
use crate::state::AppState;
use authorized_keys::{managed_comment, parse_public_key, WantedKey};

/// 背景迴圈的間隔：沒事時只讀 DB，不連裝置。/ Loop period; idle ticks only read the DB.
pub const TICK: Duration = Duration::from_secs(15);
/// 某帳號同步失敗後多久再自動重試（手動同步或清單變動會立刻重試）。
const RETRY_AFTER: Duration = Duration::from_secs(120);
/// 「立即同步」每台裝置最多這麼頻繁地重讀全部帳號（任何有存取權的人都能按）。
/// A forced re-read of every account runs at most this often per device (any viewer can trigger it).
const FORCE_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct DeviceKeys {
    notify: Notify,
    dirty: Mutex<HashSet<i64>>,
    locks: DashMap<i64, Arc<tokio::sync::Mutex<()>>>,
    retry_at: Mutex<HashMap<(i64, String), Instant>>,
    forced_at: Mutex<HashMap<i64, Instant>>,
    /// 每台裝置（reverse port）每個帳號最近一次讀到 / 寫入的 authorized_keys，面板不必每次都連裝置。
    /// The authorized_keys last read or written per (reverse port, account), so the panel needn't dial the device.
    snapshots: Mutex<HashMap<(i64, String), FileSnapshot>>,
    /// 每台裝置的平台（Windows？哪些帳號是管理員？），探測一次快取 `platform::TTL`。/ Per-device platform, cached.
    platforms: Mutex<HashMap<i64, platform::Cached>>,
    platform_locks: DashMap<i64, Arc<tokio::sync::Mutex<()>>>,
}

/// 最近一次看到的檔案內容。/ The file as Telepy last saw it.
#[derive(Debug, Clone)]
pub struct FileSnapshot {
    /// None = 檔案不存在（或讀取失敗）。/ None = no such file (or the read failed).
    pub content: Option<String>,
    pub at: chrono::DateTime<chrono::Utc>,
    /// 讀取失敗的原因。/ Why the read failed.
    pub error: Option<String>,
}

impl DeviceKeys {
    /// 清單或權限變了：盡快同步這台裝置（略過失敗重試的等待）。
    pub fn kick(&self, tunnel_id: i64) {
        self.dirty.lock().unwrap().insert(tunnel_id);
        self.retry_at.lock().unwrap().retain(|(t, _), _| *t != tunnel_id);
        self.notify.notify_one();
    }

    pub fn kick_many(&self, tunnel_ids: impl IntoIterator<Item = i64>) {
        for t in tunnel_ids {
            self.kick(t);
        }
    }

    /// 同一台裝置的 authorized_keys 一次只有一個人在改。/ One writer per device at a time.
    pub fn lock_for(&self, tunnel_id: i64) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.entry(tunnel_id).or_default().clone()
    }

    /// `remote` 每次讀 / 寫成功都記一筆。/ Recorded by `remote` after every successful read or write.
    pub fn record_snapshot(&self, reverse_port: i64, account: &str, content: Option<String>) {
        self.snapshots.lock().unwrap().insert((reverse_port, account.to_string()), FileSnapshot { content, at: chrono::Utc::now(), error: None });
    }

    /// 讀不到（例如服務金鑰不在這個帳號）。/ The read failed (e.g. the service key is not in that account).
    pub fn record_failure(&self, reverse_port: i64, account: &str, error: String) {
        self.snapshots.lock().unwrap().insert((reverse_port, account.to_string()), FileSnapshot { content: None, at: chrono::Utc::now(), error: Some(error) });
    }

    pub fn snapshot(&self, reverse_port: i64, account: &str) -> Option<FileSnapshot> {
        self.snapshots.lock().unwrap().get(&(reverse_port, account.to_string())).cloned()
    }

    /// 這台裝置的平台：快取還新就直接回，否則登入 `username` 探測一次（同一台同時只探測一次）。
    /// The device's platform: from the cache while fresh, else probed once (concurrent callers share the probe).
    pub async fn platform(&self, state: &AppState, reverse_port: i64, username: &str) -> platform::Platform {
        if let Some(p) = self.cached_platform(reverse_port) {
            return p;
        }
        let lock = self.platform_locks.entry(reverse_port).or_default().clone();
        let _guard = lock.lock().await;
        if let Some(p) = self.cached_platform(reverse_port) {
            return p;
        }
        let p = platform::probe(state, reverse_port, username).await;
        if let Some(e) = &p.error {
            tracing::info!(reverse_port, error = %e, "device keys: platform probe failed; assuming ~/.ssh/authorized_keys");
        } else if p.windows {
            tracing::info!(reverse_port, admins = ?p.admins, "device keys: Windows device; administrators use the shared admin key file");
        }
        self.platforms.lock().unwrap().insert(reverse_port, platform::Cached { platform: p.clone(), at: Instant::now() });
        p
    }

    /// 不連裝置：快取裡（還新的）平台。/ The cached platform, if still fresh; never dials the device.
    pub fn cached_platform(&self, reverse_port: i64) -> Option<platform::Platform> {
        self.platforms.lock().unwrap().get(&reverse_port).filter(|c| c.fresh(Instant::now())).map(|c| c.platform.clone())
    }

    /// 「立即同步」：下次重新探測。/ Forget the platform so the next open re-probes.
    pub fn forget_platform(&self, reverse_port: i64) {
        self.platforms.lock().unwrap().remove(&reverse_port);
    }
}

/// 應該裝在某帳號上的一把金鑰。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesiredKey {
    pub bare: String,
    pub fingerprint: String,
    pub comment: String,
    pub user_key_id: i64,
    pub user_id: i64,
}

/// OS 帳號 → (bare → 金鑰)。
pub type Desired = BTreeMap<String, BTreeMap<String, DesiredKey>>;

/// 由清單（含金鑰群組授予來的列）+ 每位擁有者允許的帳號（∩ 這一列選定的帳號）算出「應該在」的狀態。
/// 選定的帳號只是縮小範圍：`allowed_usernames` 仍是上限，選到不被允許的帳號就當沒選（之後權限放寬才生效）。
/// 同一把金鑰有好幾列（直接 + 群組）時取聯集。
/// Desired state from the list (including entries from key group grants) × each owner's allowed accounts ∩ the
/// entry's chosen accounts. The choice only narrows: `allowed_usernames` stays the ceiling, and a chosen account
/// outside it is simply not used (until access widens). Several entries for one key add up.
pub async fn desired(db: &db::Db, tunnel: &Tunnel) -> sqlx::Result<Desired> {
    let entries = db::device_keys::effective_entries_for_tunnel(db, tunnel.id).await?;
    let mut allowed: HashMap<i64, Vec<(i64, String)>> = HashMap::new();
    let mut out = Desired::new();
    for e in entries {
        // 到期的金鑰不該在裝置上：從期望狀態拿掉，同步就會把它移除。/ Expired keys drop out, so sync removes them.
        if db::keys::is_expired(e.expires_at.as_deref()) {
            continue;
        }
        // 擁有者的帳號停用了：同樣拿掉（清單留著，重新啟用就裝回去）；手動加的行 Telepy 不管。
        // The owner's account is disabled: drop it too (the list stays, so re-enabling puts it back).
        if !e.owner_active {
            continue;
        }
        let Some(parsed) = parse_public_key(&e.key) else { continue };
        if let std::collections::hash_map::Entry::Vacant(slot) = allowed.entry(e.user_id) {
            let names = permissions::allowed_usernames(db, e.user_id, tunnel).await?.into_iter().map(|u| (u.id, u.username)).collect();
            slot.insert(names);
        }
        for (id, os_user) in &allowed[&e.user_id] {
            if !e.covers(*id, os_user) {
                continue;
            }
            out.entry(os_user.clone()).or_default().insert(
                parsed.bare.clone(),
                DesiredKey {
                    bare: parsed.bare.clone(),
                    fingerprint: parsed.fingerprint.clone(),
                    comment: managed_comment(&e.owner_username, &e.name),
                    user_key_id: e.user_key_id,
                    user_id: e.user_id,
                },
            );
        }
    }
    Ok(out)
}

/// 某帳號要做的事。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AccountDiff {
    pub to_add: Vec<String>,
    pub to_remove: Vec<String>,
}

impl AccountDiff {
    pub fn is_empty(&self) -> bool {
        self.to_add.is_empty() && self.to_remove.is_empty()
    }
}

/// 每個 OS 帳號：應該在但還沒裝的、裝過但不該在的。
pub fn diff(desired: &Desired, installed: &[Installed]) -> BTreeMap<String, AccountDiff> {
    let mut have: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for i in installed {
        have.entry(i.username.as_str()).or_default().insert(i.key_bare.as_str());
    }
    let accounts: BTreeSet<&str> = desired.keys().map(String::as_str).chain(have.keys().copied()).collect();
    accounts
        .into_iter()
        .map(|acct| {
            let want = desired.get(acct);
            let got = have.get(acct);
            let to_add = want.map(|w| w.keys().filter(|b| !got.is_some_and(|g| g.contains(b.as_str()))).cloned().collect()).unwrap_or_default();
            let to_remove = got.map(|g| g.iter().filter(|b| !want.is_some_and(|w| w.contains_key(**b))).map(|b| b.to_string()).collect()).unwrap_or_default();
            (acct.to_string(), AccountDiff { to_add, to_remove })
        })
        .collect()
}

/// 全站共用的服務金鑰（舊）。/ The shared (legacy) service keys.
pub async fn shared_bares(db: &db::Db) -> sqlx::Result<BTreeSet<String>> {
    Ok(db::keys::service_keys(db).await?.iter().filter_map(|k| parse_public_key(&k.key)).map(|k| k.bare).collect())
}

/// Telepy 登入這台裝置會用的金鑰：這條隧道自己的 + 全站共用的。/ The keys Telepy logs in with: the tunnel's own + the shared ones.
pub async fn service_bares(state: &AppState, tunnel_id: i64) -> anyhow::Result<BTreeSet<String>> {
    let mut set = shared_bares(&state.db).await?;
    if let Some(line) = tunnel_keys::public_line(state, tunnel_id).await? {
        set.insert(tunnel_keys::bare(&line));
    }
    Ok(set)
}

/// 這條隧道自己的金鑰，當成要裝到每個登入帳號的 wanted。/ The tunnel's own key as a wanted entry for every login account.
async fn own_wanted(state: &AppState, tunnel_id: i64) -> anyhow::Result<WantedKey> {
    let line = tunnel_keys::ensure(state, tunnel_id).await?;
    Ok(WantedKey { bare: tunnel_keys::bare(&line), comment: tunnel_keys::comment(tunnel_id) })
}

pub fn online(state: &AppState, reverse_port: i64) -> bool {
    u16::try_from(reverse_port).ok().is_some_and(|p| state.status.listen_ports().is_some_and(|ports| ports.contains(&p)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncOutcome {
    Offline,
    Done { changed: bool, errors: usize },
}

/// 同步一台裝置。`force` = 每個相關帳號都重讀檔案（手動「立即同步」）；否則只處理有待辦的帳號。
pub async fn sync_tunnel(state: &AppState, tunnel_id: i64, force: bool) -> anyhow::Result<SyncOutcome> {
    let lock = state.device_keys.lock_for(tunnel_id);
    let _guard = lock.lock().await;
    let force = force && {
        let mut forced = state.device_keys.forced_at.lock().unwrap();
        let now = Instant::now();
        let due = forced.get(&tunnel_id).is_none_or(|t| now.duration_since(*t) >= FORCE_INTERVAL);
        if due {
            forced.insert(tunnel_id, now);
        }
        due
    };
    let Some(tunnel) = db::tunnels::by_id(&state.db, tunnel_id).await? else {
        db::device_keys::delete_tunnel(&state.db, tunnel_id).await?;
        return Ok(SyncOutcome::Done { changed: false, errors: 0 });
    };
    if force {
        // 重新探測平台（管理員群組可能變了）。/ Re-probe the platform (the admin group may have changed).
        state.device_keys.forget_platform(tunnel.reverse_port);
    }
    let desired = desired(&state.db, &tunnel).await?;
    let installed = db::device_keys::installed_for_tunnel(&state.db, tunnel.id).await?;
    let mut diffs = diff(&desired, &installed);
    // 隧道自己的服務金鑰要在每個登入帳號裡；還沒裝的帳號也是待辦。共用金鑰在每條隧道都驗證過後移掉：
    // 已驗證、而且最近一次讀到的檔案裡還有共用金鑰的帳號也算待辦（不然要等下一次有事才會碰那個帳號）。
    // The tunnel's own key belongs in every login account; accounts without it are to-do. The shared key goes once every
    // tunnel on the machine verified its own key: verified accounts whose last snapshot still holds it are to-do as well.
    let own = own_wanted(state, tunnel.id).await?;
    let shared = shared_bares(&state.db).await?;
    let key_accounts: HashMap<String, db::tunnel_keys::KeyAccount> = db::tunnel_keys::accounts(&state.db, tunnel.id).await?.into_iter().map(|a| (a.username.clone(), a)).collect();
    for u in db::tunnels::usernames_for_tunnel(&state.db, tunnel.id).await? {
        let d = diffs.entry(u.username.clone()).or_default();
        match key_accounts.get(&u.username) {
            None => d.to_add.push(own.bare.clone()),
            Some(a) if a.installed_at.is_none() => d.to_add.push(own.bare.clone()),
            Some(a) if a.verified_at.is_some() && !shared.is_empty() => {
                let snapshot_has_shared = state.device_keys.snapshot(tunnel.reverse_port, &u.username).and_then(|s| s.content).is_some_and(|c| {
                    authorized_keys::parse_authorized_keys(&c).iter().any(|l| l.key.as_ref().is_some_and(|k| shared.contains(&k.bare)))
                });
                if snapshot_has_shared && tunnel_keys::shared_removable(state, tunnel.id, &u.username).await? {
                    d.to_remove.extend(shared.iter().cloned());
                }
            }
            Some(_) => {}
        }
    }
    // 不再有任何金鑰的帳號：清掉它的同步狀態。/ Forget the status of accounts with nothing to manage.
    for s in db::device_keys::sync_for_tunnel(&state.db, tunnel.id).await? {
        if !diffs.contains_key(&s.username) {
            db::device_keys::sync_delete(&state.db, tunnel.id, &s.username).await?;
        }
    }
    let now = Instant::now();
    let todo: Vec<&String> = diffs
        .iter()
        .filter(|(acct, d)| force || (!d.is_empty() && state.device_keys.retry_at.lock().unwrap().get(&(tunnel.id, (*acct).clone())).is_none_or(|t| *t <= now)))
        .map(|(acct, _)| acct)
        .collect();
    if todo.is_empty() {
        return Ok(SyncOutcome::Done { changed: false, errors: 0 });
    }
    if !online(state, tunnel.reverse_port) {
        return Ok(SyncOutcome::Offline);
    }
    let (mut changed, mut errors) = (false, 0);
    // 停用帳號的金鑰被移掉了：每條隧道記一筆（哪些帳號、誰的）。/ Keys of disabled accounts removed: one event per tunnel.
    let disabled = db::users::inactive_ids(&state.db).await?;
    let mut owner_removed: BTreeMap<i64, BTreeSet<String>> = BTreeMap::new();
    for acct in todo {
        let empty = BTreeMap::new();
        let want = desired.get(acct).unwrap_or(&empty);
        let mine: Vec<&Installed> = installed.iter().filter(|i| &i.username == acct).collect();
        // 共用金鑰：這台機器上每條隧道都用自己的金鑰登入過這個帳號才移掉，否則保護。/ Shared key: removable or protected.
        let drop_shared = !shared.is_empty() && tunnel_keys::shared_removable(state, tunnel.id, acct).await?;
        let mut protected: BTreeSet<String> = if drop_shared { BTreeSet::new() } else { shared.clone() };
        protected.insert(own.bare.clone());
        let stale_shared = if drop_shared { shared.clone() } else { BTreeSet::new() };
        match sync_account(state, &tunnel, acct, want, &mine, &own, &protected, &stale_shared).await {
            Ok((c, removed)) => {
                changed |= c;
                for i in mine.iter().filter(|i| removed.contains(&i.key_bare)) {
                    if let Some(uid) = i.user_id.filter(|u| disabled.contains(u)) {
                        owner_removed.entry(uid).or_default().insert(acct.clone());
                    }
                }
                state.device_keys.retry_at.lock().unwrap().remove(&(tunnel.id, acct.clone()));
                db::device_keys::sync_set(&state.db, tunnel.id, acct, None).await?;
            }
            Err(e) => {
                errors += 1;
                let msg = format!("{e:#}");
                tracing::warn!(tunnel_id = tunnel.id, account = %acct, error = %msg, "device keys: sync failed");
                state.device_keys.retry_at.lock().unwrap().insert((tunnel.id, acct.clone()), now + RETRY_AFTER);
                db::device_keys::sync_set(&state.db, tunnel.id, acct, Some(&msg)).await?;
            }
        }
    }
    for (uid, accounts) in owner_removed {
        let who = db::users::by_id(&state.db, uid).await?.map(|u| u.username).unwrap_or_else(|| format!("user #{uid}"));
        let list = accounts.into_iter().collect::<Vec<_>>().join(", ");
        state
            .gateway
            .event(
                "device_key_owner_disabled",
                None,
                u16::try_from(tunnel.reverse_port).ok(),
                Some(tunnel.id),
                format!("{who}'s account is disabled: removed the keys Telepy installed for them from {list} on '{}' (keys added by hand stay)", tunnel.host_friendly_name),
            )
            .await;
    }
    let audience = crate::api::notify::tunnel_audience(state, &tunnel).await?;
    state.hub.notify_users(audience, &json!({ "action": "DEVICE-KEYS-UPDATED", "tunnel_id": tunnel.id }));
    Ok(SyncOutcome::Done { changed, errors })
}

/// 讀檔 → 規劃 → （需要時）原子寫回 → 更新「已裝」紀錄。回傳檔案是否有變。
/// `own` = 這條隧道自己的服務金鑰（一定要在）；`stale_shared` = 可以從這個帳號移掉的共用金鑰。
/// `own` = the tunnel's own key (always wanted); `stale_shared` = shared keys that may leave this account.
#[allow(clippy::too_many_arguments)]
async fn sync_account(
    state: &AppState,
    tunnel: &Tunnel,
    account: &str,
    want: &BTreeMap<String, DesiredKey>,
    installed: &[&Installed],
    own: &WantedKey,
    protected: &BTreeSet<String>,
    stale_shared: &BTreeSet<String>,
) -> anyhow::Result<(bool, Vec<String>)> {
    let file = remote::AuthorizedKeysFile::open(state, account, tunnel.reverse_port, true).await?;
    let content = file.read().await?;
    let mut wanted: Vec<WantedKey> = want.values().map(|d| WantedKey { bare: d.bare.clone(), comment: d.comment.clone() }).collect();
    wanted.push(own.clone());
    let mut managed: BTreeSet<String> = installed.iter().map(|i| i.key_bare.clone()).collect();
    managed.extend(stale_shared.iter().cloned());
    let plan = authorized_keys::plan(&content, &wanted, &managed, protected);
    if let Some(new) = &plan.content {
        file.write(new).await?;
    }
    db::tunnel_keys::mark_installed(&state.db, tunnel.id, account).await?;
    if plan.removed.iter().any(|b| stale_shared.contains(b)) {
        state
            .gateway
            .event("service_key_migrated", None, u16::try_from(tunnel.reverse_port).ok(), Some(tunnel.id), format!("Telepy now logs in to {account} on '{}' with this tunnel's own key; the shared service key was removed from that account", tunnel.host_friendly_name))
            .await;
    }
    for d in want.values() {
        db::device_keys::installed_insert(&state.db, tunnel.id, account, &d.bare, &d.fingerprint, Some(d.user_key_id), Some(d.user_id)).await?;
    }
    for i in installed {
        if !want.contains_key(&i.key_bare) {
            db::device_keys::installed_delete(&state.db, tunnel.id, account, &i.key_bare).await?;
        }
    }
    Ok((plan.content.is_some(), plan.removed))
}

/// 刪隧道時要不要動裝置上的金鑰。/ What to remove from the device when its tunnel is deleted.
#[derive(Debug, Clone, Copy)]
pub struct CleanupOptions {
    /// Telepy 依清單裝過的金鑰。/ Keys Telepy installed from the key list.
    pub device_keys: bool,
    /// 服務金鑰（移掉之後 Telepy 就登不進這些帳號了）。/ The service key (Telepy can no longer log in).
    pub service_key: bool,
}

/// 一個帳號的清理結果。/ Cleanup result of one account.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AccountCleanup {
    pub account: String,
    /// 移掉的 Telepy 管理金鑰數。/ Managed keys removed.
    pub removed: usize,
    pub service_key_removed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Cleanup {
    pub online: bool,
    pub accounts: Vec<AccountCleanup>,
    /// Telepy 裝過、還留在裝置上的金鑰數（不重複；離線、失敗或選擇保留）。/ Distinct installed keys still on the device.
    pub keys_left: usize,
}

/// 每個帳號最多等這麼久（裝置很慢或卡住時，刪除不能跟著卡住）。/ Per-account limit so a stuck device cannot hang the delete.
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(20);

/// 刪除前的檢查用：Telepy 裝在這台裝置上的金鑰，依金鑰分組（擁有者、名稱、帳號）。
/// Keys Telepy installed on the device, grouped per key (for the delete check).
pub async fn installed_summary(db: &db::Db, tunnel_id: i64) -> sqlx::Result<Vec<serde_json::Value>> {
    let installed = db::device_keys::installed_for_tunnel(db, tunnel_id).await?;
    let entries: HashMap<i64, db::device_keys::Entry> = db::device_keys::effective_entries_for_tunnel(db, tunnel_id).await?.into_iter().map(|e| (e.user_key_id, e)).collect();
    let mut keys: BTreeMap<String, (Option<i64>, Option<i64>, String, Vec<String>)> = BTreeMap::new();
    for i in installed {
        let k = keys.entry(i.key_bare.clone()).or_insert_with(|| (i.user_key_id, i.user_id, i.fingerprint.clone(), Vec::new()));
        k.3.push(i.username);
    }
    let mut out = Vec::with_capacity(keys.len());
    for (_, (key_id, user_id, fingerprint, accounts)) in keys {
        let entry = key_id.and_then(|id| entries.get(&id));
        let owner = match (entry, user_id) {
            (Some(e), _) => Some(e.owner_username.clone()),
            (None, Some(uid)) => db::users::by_id(db, uid).await?.map(|u| u.username),
            (None, None) => None,
        };
        out.push(json!({
            "fingerprint": fingerprint,
            "owner": owner,
            "name": entry.map(|e| e.name.clone()),
            "in_list": entry.is_some(),
            "accounts": accounts,
        }));
    }
    Ok(out)
}

/// 隧道刪除前：清掉清單與安裝紀錄；裝置在線時依選項把 Telepy 裝過的金鑰（與服務金鑰）從各帳號移掉。
/// 這要在隧道還連著時做（之後裝置就被踢掉、也連不回來了），所以是同步的，結果回報給刪除對話框。
/// Before a tunnel is deleted: drop its key list and install records and, while the device is still
/// connected, remove what the options ask for from every account. Synchronous so the result can be shown.
pub async fn forget_tunnel(state: &AppState, tunnel: &Tunnel, opts: CleanupOptions, accounts: &[String]) -> Cleanup {
    let lock = state.device_keys.lock_for(tunnel.id);
    let _guard = lock.lock().await;
    let installed = db::device_keys::installed_for_tunnel(&state.db, tunnel.id).await.unwrap_or_default();
    let _ = db::device_keys::delete_tunnel(&state.db, tunnel.id).await;
    let online = online(state, tunnel.reverse_port);
    let mut work: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    if opts.device_keys {
        for i in &installed {
            work.entry(i.username.clone()).or_default().insert(i.key_bare.clone());
        }
    }
    if opts.service_key {
        for a in accounts {
            work.entry(a.clone()).or_default();
        }
    }
    // 留在裝置上的「金鑰」數（同一把裝在兩個帳號算一把，和刪除前的檢查一致）。/ Distinct keys, like the check.
    let distinct = |rows: &mut dyn Iterator<Item = &Installed>| rows.map(|i| i.key_bare.as_str()).collect::<BTreeSet<_>>().len();
    // 這條隧道自己的服務金鑰：刪了隧道就沒用了，每個裝過它的帳號都移掉（不管選項）。
    // The tunnel's own service key is worthless after the delete: it leaves every account it was installed in.
    let own = tunnel_keys::public_line(state, tunnel.id).await.ok().flatten().map(|l| tunnel_keys::bare(&l));
    if let Some(own) = &own {
        for a in db::tunnel_keys::accounts(&state.db, tunnel.id).await.unwrap_or_default() {
            work.entry(a.username).or_default().insert(own.clone());
        }
        for a in accounts {
            work.entry(a.clone()).or_default().insert(own.clone());
        }
    }
    if !online || work.is_empty() {
        let keys_left = if opts.device_keys && online { 0 } else { distinct(&mut installed.iter()) };
        return Cleanup { online, accounts: Vec::new(), keys_left };
    }
    let mut service = shared_bares(&state.db).await.unwrap_or_default();
    service.extend(own.iter().cloned());
    let port = tunnel.reverse_port;
    let results: Vec<AccountCleanup> = futures::future::join_all(work.into_iter().map(|(account, managed)| {
        let (service, own) = (&service, &own);
        async move {
            let run = clean_account(state, port, &account, &managed, service, own.as_deref(), opts.service_key);
            match tokio::time::timeout(CLEANUP_TIMEOUT, run).await {
                Ok(Ok((removed, service_key_removed))) => AccountCleanup { account, removed, service_key_removed, error: None },
                Ok(Err(e)) => {
                    tracing::info!(account = %account, error = %format!("{e:#}"), "device keys: cleanup after tunnel delete failed");
                    AccountCleanup { account, removed: 0, service_key_removed: false, error: Some(format!("{e:#}")) }
                }
                Err(_) => AccountCleanup { account, removed: 0, service_key_removed: false, error: Some("timed out".to_string()) },
            }
        }
    }))
    .await;
    let failed: BTreeSet<&str> = results.iter().filter(|r| r.error.is_some()).map(|r| r.account.as_str()).collect();
    let keys_left = if opts.device_keys { distinct(&mut installed.iter().filter(|i| failed.contains(i.username.as_str()))) } else { distinct(&mut installed.iter()) };
    Cleanup { online, accounts: results, keys_left }
}

/// 一個帳號：移掉 `managed`（使用者金鑰 + 這條隧道自己的服務金鑰 `own`，`remove_service` 時連共用金鑰），一次寫回。
/// 回傳（移掉的使用者金鑰數, 有沒有移掉服務金鑰）。/ One account, one rewrite: (user keys removed, any service key removed).
async fn clean_account(state: &AppState, port: i64, account: &str, managed: &BTreeSet<String>, service: &BTreeSet<String>, own: Option<&str>, remove_service: bool) -> anyhow::Result<(usize, bool)> {
    let file = remote::AuthorizedKeysFile::open(state, account, port, false).await?;
    if !file.exists() {
        return Ok((0, false));
    }
    let mut remove = managed.clone();
    let mut keep = service.clone();
    if let Some(own) = own {
        remove.insert(own.to_string());
        keep.remove(own);
    }
    if remove_service {
        remove.extend(service.iter().cloned());
        keep.clear();
    }
    let plan = authorized_keys::plan(&file.read().await?, &[], &remove, &keep);
    if let Some(new) = &plan.content {
        file.write(new).await?;
    }
    let removed = plan.removed.iter().filter(|b| managed.contains(*b) && !service.contains(*b)).count();
    let service_key_removed = plan.removed.iter().any(|b| service.contains(b));
    Ok((removed, service_key_removed))
}

/// 背景同步：清單變動（kick）立刻跑；平時每 TICK 檢查一次（裝置剛上線也會在這時補上）。
pub async fn run(state: AppState) {
    loop {
        tokio::select! {
            _ = state.device_keys.notify.notified() => {}
            _ = tokio::time::sleep(TICK) => {}
        }
        let dirty: HashSet<i64> = std::mem::take(&mut *state.device_keys.dirty.lock().unwrap());
        let mut tunnels: BTreeSet<i64> = match db::device_keys::tunnels_with_state(&state.db).await {
            Ok(v) => v.into_iter().collect(),
            Err(e) => {
                tracing::warn!(error = %e, "device keys: cannot list tunnels");
                continue;
            }
        };
        tunnels.extend(dirty);
        for tunnel_id in tunnels {
            // 同一台正在同步就跳過；它結束後若又被 kick 會再通知。/ Skip a device already syncing.
            let lock = state.device_keys.lock_for(tunnel_id);
            if lock.try_lock().is_err() {
                state.device_keys.dirty.lock().unwrap().insert(tunnel_id);
                continue;
            }
            let state = state.clone();
            tokio::spawn(async move {
                if let Err(e) = sync_tunnel(&state, tunnel_id, false).await {
                    tracing::warn!(tunnel_id, error = %format!("{e:#}"), "device keys: sync error");
                }
                if state.device_keys.dirty.lock().unwrap().contains(&tunnel_id) {
                    state.device_keys.notify.notify_one();
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dk(bare: &str) -> DesiredKey {
        DesiredKey { bare: bare.into(), fingerprint: String::new(), comment: String::new(), user_key_id: 1, user_id: 1 }
    }

    fn inst(user: &str, bare: &str) -> Installed {
        Installed { tunnel_id: 1, username: user.into(), key_bare: bare.into(), fingerprint: String::new(), user_key_id: None, user_id: None, installed_at: String::new() }
    }

    #[test]
    fn diff_adds_missing_and_removes_revoked() {
        let mut desired = Desired::new();
        desired.entry("ubuntu".into()).or_default().insert("k1".into(), dk("k1"));
        desired.entry("ubuntu".into()).or_default().insert("k2".into(), dk("k2"));
        let installed = vec![inst("ubuntu", "k1"), inst("ubuntu", "k3"), inst("root", "k1")];
        let d = diff(&desired, &installed);
        assert_eq!(d["ubuntu"], AccountDiff { to_add: vec!["k2".into()], to_remove: vec!["k3".into()] });
        // root 不再允許：全部移除。/ An account no longer allowed loses everything.
        assert_eq!(d["root"], AccountDiff { to_add: vec![], to_remove: vec!["k1".into()] });
    }

    #[test]
    fn diff_is_empty_when_in_sync() {
        let mut desired = Desired::new();
        desired.entry("ubuntu".into()).or_default().insert("k1".into(), dk("k1"));
        let d = diff(&desired, &[inst("ubuntu", "k1")]);
        assert!(d["ubuntu"].is_empty());
    }
}
