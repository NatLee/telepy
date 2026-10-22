//! 裝置金鑰清單：Telepy 用 russh（服務金鑰）把使用者的公鑰裝進裝置各 OS 帳號的 `~/.ssh/authorized_keys`。
//!
//! 模型 / Model:
//! - 每台裝置（隧道）有一份清單：哪些使用者金鑰要裝上去。擁有者與被分享者都只能放「自己的」金鑰。
//! - 一把金鑰裝進哪些 OS 帳號 = 金鑰擁有者在這台裝置上「允許使用的帳號」（`permissions::allowed_usernames`，
//!   與網頁終端機同一道關卡）。所以撤銷分享、縮小允許清單、刪帳號或刪金鑰，裝置上的金鑰就跟著被移除。
//! - 「應該在」與「Telepy 裝過」（`telepy_device_key_installed`）相減就是待辦；裝置上線時同步。
//!   Telepy 只移除自己裝過的金鑰，也絕不移除服務金鑰。
//!
//! Each device has a key list; a key is installed into exactly the accounts its owner may use there,
//! so revoking access removes it. Desired − installed is reconciled whenever the device is online.

pub mod authorized_keys;
pub mod remote;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde_json::json;
use tokio::sync::Notify;

use crate::db::{self, device_keys::Installed, tunnels::Tunnel};
use crate::permissions;
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

/// 由清單 + 每位擁有者允許的帳號算出「應該在」的狀態。
pub async fn desired(db: &db::Db, tunnel: &Tunnel) -> sqlx::Result<Desired> {
    let entries = db::device_keys::entries_for_tunnel(db, tunnel.id).await?;
    let mut allowed: HashMap<i64, Vec<String>> = HashMap::new();
    let mut out = Desired::new();
    for e in entries {
        let Some(parsed) = parse_public_key(&e.key) else { continue };
        if !allowed.contains_key(&e.user_id) {
            let names = permissions::allowed_usernames(db, e.user_id, tunnel).await?.into_iter().map(|u| u.username).collect();
            allowed.insert(e.user_id, names);
        }
        for os_user in &allowed[&e.user_id] {
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

/// 服務金鑰（永不移除）。/ Service keys are never removed.
async fn protected(db: &db::Db) -> sqlx::Result<BTreeSet<String>> {
    Ok(db::keys::service_keys(db).await?.iter().filter_map(|k| parse_public_key(&k.key)).map(|k| k.bare).collect())
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
    let desired = desired(&state.db, &tunnel).await?;
    let installed = db::device_keys::installed_for_tunnel(&state.db, tunnel.id).await?;
    let diffs = diff(&desired, &installed);
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
    let protected = protected(&state.db).await?;
    let (mut changed, mut errors) = (false, 0);
    for acct in todo {
        let empty = BTreeMap::new();
        let want = desired.get(acct).unwrap_or(&empty);
        let mine: Vec<&Installed> = installed.iter().filter(|i| &i.username == acct).collect();
        match sync_account(state, &tunnel, acct, want, &mine, &protected).await {
            Ok(c) => {
                changed |= c;
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
    let audience = crate::api::notify::tunnel_audience(state, &tunnel).await?;
    state.hub.notify_users(audience, &json!({ "action": "DEVICE-KEYS-UPDATED", "tunnel_id": tunnel.id }));
    Ok(SyncOutcome::Done { changed, errors })
}

/// 讀檔 → 規劃 → （需要時）原子寫回 → 更新「已裝」紀錄。回傳檔案是否有變。
async fn sync_account(
    state: &AppState,
    tunnel: &Tunnel,
    account: &str,
    want: &BTreeMap<String, DesiredKey>,
    installed: &[&Installed],
    protected: &BTreeSet<String>,
) -> anyhow::Result<bool> {
    let file = remote::AuthorizedKeysFile::open(state, account, tunnel.reverse_port, true).await?;
    let content = file.read().await?;
    let wanted: Vec<WantedKey> = want.values().map(|d| WantedKey { bare: d.bare.clone(), comment: d.comment.clone() }).collect();
    let managed: BTreeSet<String> = installed.iter().map(|i| i.key_bare.clone()).collect();
    let plan = authorized_keys::plan(&content, &wanted, &managed, protected);
    if let Some(new) = &plan.content {
        file.write(new).await?;
    }
    for d in want.values() {
        db::device_keys::installed_insert(&state.db, tunnel.id, account, &d.bare, &d.fingerprint, Some(d.user_key_id), Some(d.user_id)).await?;
    }
    for i in installed {
        if !want.contains_key(&i.key_bare) {
            db::device_keys::installed_delete(&state.db, tunnel.id, account, &i.key_bare).await?;
        }
    }
    Ok(plan.content.is_some())
}

/// 隧道刪除前：把 Telepy 裝過的金鑰從裝置移掉（盡力而為，裝置離線就算了），再清掉紀錄。
pub async fn forget_tunnel(state: &AppState, tunnel: &Tunnel) {
    let installed = db::device_keys::installed_for_tunnel(&state.db, tunnel.id).await.unwrap_or_default();
    let _ = db::device_keys::delete_tunnel(&state.db, tunnel.id).await;
    if installed.is_empty() || !online(state, tunnel.reverse_port) {
        return;
    }
    let state = state.clone();
    let port = tunnel.reverse_port;
    tokio::spawn(async move {
        let protected = protected(&state.db).await.unwrap_or_default();
        let mut by_account: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for i in installed {
            by_account.entry(i.username).or_default().insert(i.key_bare);
        }
        for (account, managed) in by_account {
            let result = async {
                let file = remote::AuthorizedKeysFile::open(&state, &account, port, false).await?;
                let plan = authorized_keys::plan(&file.read().await?, &[], &managed, &protected);
                if let Some(new) = plan.content {
                    file.write(&new).await?;
                }
                anyhow::Ok(())
            }
            .await;
            if let Err(e) = result {
                tracing::info!(account = %account, error = %format!("{e:#}"), "device keys: cleanup after tunnel delete failed");
            }
        }
    });
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
