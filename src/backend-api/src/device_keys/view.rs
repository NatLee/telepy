//! 裝置金鑰面板的合併檢視：清單（應該在哪）× Telepy 裝過的 × 裝置上實際的 authorized_keys（最近一次讀到的），
//! 每個帳號一張卡、每把金鑰一列，一眼看出「清單上的有沒有真的在裝置上、裝置上有什麼不是 Telepy 加的」。純函式。
//! Merged view for the device-key panel: the list (where keys should be) × what Telepy installed × the
//! account's authorized_keys as last read. One card per account, one row per key. Pure.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::Serialize;

use super::authorized_keys::{parse_authorized_keys, ParsedKey};
use super::platform::{Platform, USER_FILE_LABEL};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowState {
    /// Telepy 的服務金鑰（不能移除）。/ Telepy's service key (never removed).
    Service,
    /// 在清單上，已裝上。/ On the list and installed.
    Installed,
    /// 在清單上，還沒裝上（等同步或裝置上線）。/ On the list, not installed yet.
    Pending,
    /// 在清單上，同步失敗。/ On the list, the sync failed.
    Error,
    /// Telepy 裝過、已不該在，等著移除。/ Installed by Telepy, no longer wanted, waiting to be removed.
    Removing,
    /// Telepy 使用者的金鑰，但不在清單上（手動加的）。/ A Telepy user's key added by hand.
    Manual,
    /// 不是 Telepy 認得的金鑰。/ Not a key Telepy knows.
    Unknown,
    /// 無法解析的行。/ An unreadable line.
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub state: RowState,
    /// `service` 列：全站共用的舊服務金鑰（隧道都改用自己的金鑰後會被移掉）。/ `service` rows: the legacy shared key.
    pub legacy: bool,
    /// 最近一次讀檔時在檔案裡看到。/ Seen in the file at the last read.
    pub verified: bool,
    pub on_list: bool,
    pub mine: bool,
    pub user_key_id: Option<i64>,
    pub name: Option<String>,
    pub owner: Option<String>,
    pub fingerprint: Option<String>,
    pub key_type: Option<&'static str>,
    pub bits: Option<u32>,
    pub comment: Option<String>,
    pub options: Option<String>,
    pub line_no: Option<usize>,
    /// 這把金鑰在檔案裡佔幾行（同一把重複貼上時 > 1；移除會刪掉每一行）。/ Lines holding this key (> 1 for duplicates).
    pub line_count: usize,
    pub error: Option<String>,
    pub raw: Option<String>,
    /// 清單上的金鑰只裝到這些帳號（username id）；None = 擁有者能用的每個帳號。/ The entry's chosen accounts; None = all.
    pub accounts: Option<Vec<i64>>,
    /// 清單上的金鑰：直接加進清單的（能直接移出）。/ Listed keys: added to the list directly (can be taken off directly).
    pub direct: bool,
    /// 清單上的金鑰：經由哪些金鑰群組來的。/ Listed keys: the key groups that bring it here.
    pub groups: Vec<GroupRef>,
    /// 金鑰擁有者的帳號停用了：`removing` = Telepy 正在把它拿掉；`manual` = 手動加的，Telepy 不會動，要管理者自己移除。
    /// The key owner's account is disabled: `removing` = Telepy is taking it off; `manual` = added by hand, Telepy
    /// leaves it, a manager has to remove it.
    pub owner_disabled: bool,
}

/// 一個金鑰群組（名稱給畫面用）。/ A key group, named for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupRef {
    pub id: i64,
    pub name: String,
}

/// 一把金鑰為什麼在這台裝置的清單上。/ Why a key is on this device's list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sources {
    pub direct: bool,
    pub groups: Vec<GroupRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountView {
    pub username: String,
    /// 這個帳號的金鑰檔：`~/.ssh/authorized_keys`，Windows 管理員是共用的 `%ProgramData%\ssh\administrators_authorized_keys`。
    /// Which file holds this account's keys: the path actually read / written when known (exec mode reports it), else the
    /// platform's label (`~/.ssh/authorized_keys`, the Windows admin file).
    pub file: String,
    /// Windows 本機管理員：sshd 不看它自己的 `~/.ssh/authorized_keys`。/ A Windows administrator (own file ignored by sshd).
    pub windows_admin: bool,
    /// 最近一次讀到檔案的時間；None = 還沒讀過。/ When the file was last read; None = never.
    pub checked_at: Option<String>,
    /// 檔案存在嗎（讀過才知道）。/ Whether the file exists (known once read).
    pub exists: Option<bool>,
    /// 最近一次同步這個帳號的錯誤。/ Error of the last sync of this account.
    pub error: Option<String>,
    pub rows: Vec<Row>,
}

/// Telepy 認得的使用者金鑰。/ A user key Telepy knows.
#[derive(Debug, Clone)]
pub struct KnownKey {
    pub user_key_id: i64,
    pub name: String,
    pub owner_id: i64,
    pub owner: String,
    pub parsed: ParsedKey,
}

/// 一個帳號最近一次讀到的檔案：(內容；None = 檔案不存在, 讀取時間 ISO)。
pub type Snapshot = (Option<String>, String);

pub struct Inputs<'a> {
    /// 要顯示的帳號（呼叫端已依權限挑好）。/ Accounts to show (already scoped by the caller).
    pub accounts: &'a [String],
    /// 帳號 → 應該在的金鑰（bare）。/ Account → keys that should be there.
    pub desired: &'a BTreeMap<String, BTreeSet<String>>,
    /// Telepy 裝過的：(帳號, bare, 指紋, 金鑰擁有者)。/ Installed by Telepy.
    pub installed: &'a [(String, String, String, Option<i64>)],
    pub sync_errors: &'a HashMap<String, String>,
    pub snapshots: &'a HashMap<String, Snapshot>,
    /// 帳號 → 實際讀 / 寫的檔案路徑（知道的才有）。/ Account → the file actually read / written, when known.
    pub file_paths: &'a HashMap<String, String>,
    /// Telepy 的服務金鑰（這條隧道自己的 + 全站共用的）。/ Telepy's service keys (the tunnel's own + the shared one).
    pub service: &'a BTreeSet<String>,
    /// 其中全站共用的那把（舊；隧道都用自己的金鑰後會被移掉）。/ The shared one among them (legacy).
    pub shared: &'a BTreeSet<String>,
    /// bare → 金鑰。/ bare → key.
    pub known: &'a HashMap<String, KnownKey>,
    /// user id → username（金鑰已刪除時找擁有者用）。/ For keys that were deleted since.
    pub users: &'a HashMap<i64, String>,
    pub viewer: i64,
    /// 擁有者 / ADMIN 看到每一列；其他人只看到自己的金鑰。/ Owners / ADMIN see every row; others only their own keys.
    pub manager: bool,
    /// 裝置的平台（探測過才有）。/ The device's platform, once probed.
    pub platform: Option<&'a Platform>,
    /// 清單上有選定帳號的金鑰：user_key_id → 選定的 username id。/ Entries with chosen accounts: user_key_id → ids.
    pub restrictions: &'a HashMap<i64, Vec<i64>>,
    /// 清單上的金鑰從哪來（直接 / 金鑰群組）。/ Where listed keys come from (directly / key groups).
    pub sources: &'a HashMap<i64, Sources>,
    /// 停用中的帳號（user id）。/ Disabled accounts (user ids).
    pub disabled: &'a HashSet<i64>,
}

fn base(state: RowState) -> Row {
    Row {
        state,
        legacy: false,
        verified: false,
        on_list: false,
        mine: false,
        user_key_id: None,
        name: None,
        owner: None,
        fingerprint: None,
        key_type: None,
        bits: None,
        comment: None,
        options: None,
        line_no: None,
        line_count: 0,
        error: None,
        raw: None,
        accounts: None,
        direct: false,
        groups: Vec::new(),
        owner_disabled: false,
    }
}

fn with_key(mut r: Row, k: &ParsedKey) -> Row {
    r.fingerprint = Some(k.fingerprint.clone());
    r.key_type = Some(k.label);
    r.bits = k.bits;
    r
}

fn with_known(mut r: Row, k: &KnownKey, i: &Inputs) -> Row {
    r.user_key_id = Some(k.user_key_id);
    r.name = Some(k.name.clone());
    r.owner = Some(k.owner.clone());
    r.mine = k.owner_id == i.viewer;
    r.owner_disabled = i.disabled.contains(&k.owner_id);
    r.accounts = i.restrictions.get(&k.user_key_id).cloned();
    if r.on_list {
        let src = i.sources.get(&k.user_key_id);
        // 沒有來源資料就當成直接加的（舊呼叫端）。/ No source data = listed directly.
        r.direct = src.is_none_or(|s| s.direct);
        r.groups = src.map(|s| s.groups.clone()).unwrap_or_default();
    }
    with_key(r, &k.parsed)
}

pub fn build(i: &Inputs) -> Vec<AccountView> {
    i.accounts.iter().map(|acct| account(i, acct)).collect()
}

fn account(i: &Inputs, acct: &str) -> AccountView {
    let snapshot = i.snapshots.get(acct);
    let lines = snapshot.and_then(|(c, _)| c.as_deref()).map(parse_authorized_keys).unwrap_or_default();
    // bare → 檔案裡第一行與行數。/ bare → first line in the file, and how many lines hold it.
    let mut in_file: HashMap<&str, &super::authorized_keys::AuthorizedLine> = HashMap::new();
    let mut line_counts: HashMap<&str, usize> = HashMap::new();
    for l in &lines {
        if let Some(k) = &l.key {
            in_file.entry(k.bare.as_str()).or_insert(l);
            *line_counts.entry(k.bare.as_str()).or_default() += 1;
        }
    }
    let count = |bare: &str| line_counts.get(bare).copied().unwrap_or(0);
    let read = snapshot.is_some();
    let error = i.sync_errors.get(acct).cloned();
    let empty = BTreeSet::new();
    let desired = i.desired.get(acct).unwrap_or(&empty);
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut rows = Vec::new();

    // 清單上的。/ On the list.
    for bare in desired {
        let line = in_file.get(bare.as_str());
        let installed = i.installed.iter().any(|(a, b, _, _)| a == acct && b == bare);
        let state = if (read && line.is_some()) || (!read && installed) {
            RowState::Installed
        } else if error.is_some() {
            RowState::Error
        } else {
            RowState::Pending
        };
        let mut r = base(state);
        r.on_list = true;
        r.verified = line.is_some();
        if state == RowState::Error {
            r.error = error.clone();
        }
        if let Some(l) = line {
            r.options = l.options.clone();
            r.line_no = Some(l.line_no);
            r.line_count = count(bare);
        }
        if let Some(k) = i.known.get(bare) {
            r = with_known(r, k, i);
        }
        rows.push(r);
        seen.insert(bare);
    }
    // Telepy 裝過但不該在的（讀過檔且已不在就不列：下次同步會清掉紀錄）。
    // Installed but no longer wanted (skipped once a read shows it is gone).
    for (a, bare, fp, owner) in i.installed {
        if a != acct || desired.contains(bare) || seen.contains(bare.as_str()) {
            continue;
        }
        let line = in_file.get(bare.as_str());
        if read && line.is_none() {
            continue;
        }
        let mut r = base(RowState::Removing);
        r.verified = line.is_some();
        r.fingerprint = Some(fp.clone());
        r.error = error.clone();
        if let Some(k) = i.known.get(bare) {
            r = with_known(r, k, i);
        } else {
            r.owner = owner.and_then(|id| i.users.get(&id).cloned());
            r.mine = *owner == Some(i.viewer);
            r.owner_disabled = owner.is_some_and(|id| i.disabled.contains(&id));
        }
        if let Some(l) = line {
            r.options = l.options.clone();
            r.line_no = Some(l.line_no);
            r.line_count = count(bare);
            if let Some(k) = &l.key {
                r = with_key(r, k);
            }
        }
        rows.push(r);
        seen.insert(bare);
    }
    // 檔案裡其餘的行。/ Everything else in the file.
    for l in &lines {
        let Some(k) = &l.key else {
            let trimmed = l.raw.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') {
                let mut r = base(RowState::Invalid);
                r.verified = true;
                r.line_no = Some(l.line_no);
                r.line_count = 1;
                r.raw = Some(trimmed.chars().take(120).collect());
                rows.push(r);
            }
            continue;
        };
        if !seen.insert(k.bare.as_str()) {
            continue;
        }
        let state = if i.service.contains(&k.bare) {
            RowState::Service
        } else if i.known.contains_key(&k.bare) {
            RowState::Manual
        } else {
            RowState::Unknown
        };
        let mut r = with_key(base(state), k);
        r.legacy = state == RowState::Service && i.shared.contains(&k.bare);
        r.verified = true;
        r.options = l.options.clone();
        r.line_no = Some(l.line_no);
        r.line_count = count(&k.bare);
        if !k.comment.is_empty() {
            r.comment = Some(k.comment.clone());
        }
        if let Some(known) = i.known.get(&k.bare) {
            r = with_known(r, known, i);
        }
        rows.push(r);
    }
    if !i.manager {
        rows.retain(|r| r.mine);
    }
    rows.sort_by(|a, b| a.state.cmp(&b.state).then_with(|| a.name.cmp(&b.name)).then_with(|| a.line_no.cmp(&b.line_no)));
    let (_, label, windows_admin) = i.platform.map(|p| p.file_for(acct)).unwrap_or((None, USER_FILE_LABEL, false));
    let file = i.file_paths.get(acct).cloned().unwrap_or_else(|| label.to_string());
    AccountView {
        username: acct.to_string(),
        file,
        windows_admin,
        checked_at: snapshot.map(|(_, at)| at.clone()),
        exists: snapshot.map(|(c, _)| c.is_some()),
        error,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::super::authorized_keys::parse_public_key;
    use super::*;

    const ALICE: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHAgjb8hhCbQ4/2TIVTp6pRlUi97oIezKoHrwtI5hIDU alice@laptop";
    const BOB: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC0IpUODAh6nEE6nsxVUVINtlvKLCYnrc/Xfzbp1ui1K bob";
    const SVC: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOImGUVF91v4SkbAF1fyhKvNvYOHAzaoMnVQkShaoyNY web-service";
    const STRANGER: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDfJoXhbfbTVWOGa30diB5dY07RMBntvLd+q1uT8vc7qLbQhsStQ3uK6g2kj2s/fMn9J3Ayan4au4KLfcMcnWaTy+A6J/vSFogh8q3M8w/80nkQ3clT/492fRCOWb1usAmMRJsl38BgO8BfbQtY65KFxC/mPvv6zBvKMbI4Vtd6Xw== stranger";

    fn bare(k: &str) -> String {
        parse_public_key(k).unwrap().bare
    }

    fn known(key: &str, id: i64, name: &str, owner_id: i64, owner: &str) -> (String, KnownKey) {
        let parsed = parse_public_key(key).unwrap();
        (parsed.bare.clone(), KnownKey { user_key_id: id, name: name.into(), owner_id, owner: owner.into(), parsed })
    }

    struct Fixture {
        accounts: Vec<String>,
        desired: BTreeMap<String, BTreeSet<String>>,
        installed: Vec<(String, String, String, Option<i64>)>,
        errors: HashMap<String, String>,
        snapshots: HashMap<String, Snapshot>,
        service: BTreeSet<String>,
        known: HashMap<String, KnownKey>,
        users: HashMap<i64, String>,
        platform: Option<Platform>,
        restrictions: HashMap<i64, Vec<i64>>,
        sources: HashMap<i64, Sources>,
        disabled: HashSet<i64>,
    }

    impl Fixture {
        fn new() -> Self {
            Fixture {
                accounts: vec!["ubuntu".into()],
                desired: BTreeMap::new(),
                installed: vec![],
                errors: HashMap::new(),
                snapshots: HashMap::new(),
                service: BTreeSet::from([bare(SVC)]),
                known: HashMap::from([known(ALICE, 1, "MacBook", 10, "alice"), known(BOB, 2, "bob-pc", 20, "bob")]),
                users: HashMap::from([(10, "alice".into()), (20, "bob".into())]),
                platform: None,
                restrictions: HashMap::new(),
                sources: HashMap::new(),
                disabled: HashSet::new(),
            }
        }
        fn build(&self, viewer: i64, manager: bool) -> AccountView {
            let no_paths = HashMap::new();
            let i = Inputs {
                file_paths: &no_paths,
                accounts: &self.accounts,
                desired: &self.desired,
                installed: &self.installed,
                sync_errors: &self.errors,
                snapshots: &self.snapshots,
                service: &self.service,
                shared: &self.service,
                known: &self.known,
                users: &self.users,
                viewer,
                manager,
                platform: self.platform.as_ref(),
                restrictions: &self.restrictions,
                sources: &self.sources,
                disabled: &self.disabled,
            };
            build(&i).remove(0)
        }
    }

    fn states(v: &AccountView) -> Vec<RowState> {
        v.rows.iter().map(|r| r.state).collect()
    }

    #[test]
    fn verified_against_the_file() {
        let mut f = Fixture::new();
        f.desired.insert("ubuntu".into(), BTreeSet::from([bare(ALICE), bare(BOB)]));
        f.installed.push(("ubuntu".into(), bare(ALICE), "fp".into(), Some(10)));
        f.snapshots.insert("ubuntu".into(), (Some(format!("{SVC}\nno-pty {ALICE}\n{STRANGER}\n# c\nbroken line\n")), "t".into()));
        let v = f.build(10, true);
        assert_eq!(states(&v), vec![RowState::Service, RowState::Installed, RowState::Pending, RowState::Unknown, RowState::Invalid]);
        let alice = &v.rows[1];
        assert!(alice.verified && alice.on_list && alice.mine);
        assert_eq!(alice.options.as_deref(), Some("no-pty"));
        assert_eq!(alice.name.as_deref(), Some("MacBook"));
        assert!(!v.rows[2].verified);
        assert_eq!(v.rows[3].comment.as_deref(), Some("stranger"));
        assert_eq!((alice.line_count, v.rows[2].line_count, v.rows[4].line_count), (1, 0, 1));
        assert_eq!(v.checked_at.as_deref(), Some("t"));
        assert_eq!(v.exists, Some(true));
    }

    #[test]
    fn without_a_read_trusts_what_telepy_installed() {
        let mut f = Fixture::new();
        f.desired.insert("ubuntu".into(), BTreeSet::from([bare(ALICE), bare(BOB)]));
        f.installed.push(("ubuntu".into(), bare(ALICE), "fp".into(), Some(10)));
        f.errors.insert("ubuntu".into(), "permission denied".into());
        let v = f.build(10, true);
        assert_eq!(states(&v), vec![RowState::Installed, RowState::Error]);
        assert!(!v.rows[0].verified);
        assert_eq!(v.rows[1].error.as_deref(), Some("permission denied"));
        assert_eq!(v.checked_at, None);
    }

    #[test]
    fn removals_and_hand_added_keys() {
        let mut f = Fixture::new();
        // bob 被撤銷：Telepy 裝過但已不在清單上；alice 自己手動加了一把。/ Bob revoked; alice added hers by hand.
        f.installed.push(("ubuntu".into(), bare(BOB), "fp-bob".into(), Some(20)));
        f.snapshots.insert("ubuntu".into(), (Some(format!("{BOB}\n{ALICE}\n")), "t".into()));
        let v = f.build(10, true);
        assert_eq!(states(&v), vec![RowState::Removing, RowState::Manual]);
        assert_eq!(v.rows[0].owner.as_deref(), Some("bob"));
        assert!(v.rows[1].mine && !v.rows[1].on_list);
        // 讀檔顯示已經不在：不再列出。/ Once a read shows it gone, the removal row disappears.
        f.snapshots.insert("ubuntu".into(), (Some(format!("{ALICE}\n")), "t2".into()));
        assert_eq!(states(&f.build(10, true)), vec![RowState::Manual]);
    }

    #[test]
    fn a_disabled_owners_keys_are_marked() {
        let mut f = Fixture::new();
        // bob 被停用：Telepy 裝過的那把正在移除；alice 被停用、她的那把是手動加的（Telepy 不會動）。
        // Bob is disabled: the key Telepy installed is being removed; Alice is disabled and hers was added by hand.
        f.disabled = HashSet::from([10, 20]);
        f.installed.push(("ubuntu".into(), bare(BOB), "fp-bob".into(), Some(20)));
        f.snapshots.insert("ubuntu".into(), (Some(format!("{BOB}
{ALICE}
{STRANGER}
")), "t".into()));
        let v = f.build(30, true);
        assert_eq!(states(&v), vec![RowState::Removing, RowState::Manual, RowState::Unknown]);
        assert!(v.rows[0].owner_disabled && v.rows[1].owner_disabled && !v.rows[2].owner_disabled);
        // 金鑰已刪、只剩擁有者 id 的移除列也認得。/ A removal whose key was deleted is matched by the owner id.
        f.known.remove(&bare(BOB));
        let v = f.build(30, true);
        assert!(v.rows[0].state == RowState::Removing && v.rows[0].owner_disabled);
        // 讀檔顯示已經拿掉：列消失；手動那行留著。/ Once gone, the removal row disappears; the hand-added line stays.
        f.snapshots.insert("ubuntu".into(), (Some(format!("{ALICE}
")), "t2".into()));
        let v = f.build(30, true);
        assert_eq!(states(&v), vec![RowState::Manual]);
        assert!(v.rows[0].owner_disabled);
        // 帳號還啟用：沒有標記。/ Active owners carry no mark.
        f.disabled.clear();
        assert!(!f.build(30, true).rows[0].owner_disabled);
    }

    #[test]
    fn sharees_only_see_their_own_keys() {
        let mut f = Fixture::new();
        f.desired.insert("ubuntu".into(), BTreeSet::from([bare(ALICE), bare(BOB)]));
        f.snapshots.insert("ubuntu".into(), (Some(format!("{SVC}\n{ALICE}\n{BOB}\n{STRANGER}\n")), "t".into()));
        let v = f.build(20, false);
        assert_eq!(v.rows.len(), 1);
        assert_eq!(v.rows[0].name.as_deref(), Some("bob-pc"));
        assert_eq!(v.rows[0].state, RowState::Installed);
    }

    #[test]
    fn duplicate_lines_are_one_row_with_a_count() {
        let mut f = Fixture::new();
        f.snapshots.insert("ubuntu".into(), (Some(format!("{STRANGER}\nno-pty {STRANGER}\n{SVC}\n{STRANGER}\n")), "t".into()));
        let v = f.build(10, true);
        assert_eq!(states(&v), vec![RowState::Service, RowState::Unknown]);
        assert_eq!((v.rows[0].line_count, v.rows[1].line_count, v.rows[1].line_no), (1, 3, Some(1)));
    }

    #[test]
    fn windows_admin_file_and_chosen_accounts() {
        let mut f = Fixture::new();
        f.accounts = vec!["nat".into(), "guest".into()];
        f.platform = Some(Platform { windows: true, program_data: Some("/C:/ProgramData".into()), admins: BTreeSet::from(["nat".to_string()]), error: None });
        f.desired.insert("nat".into(), BTreeSet::from([bare(ALICE)]));
        f.restrictions.insert(1, vec![7]);
        let no_paths = HashMap::new();
        let i = Inputs {
            file_paths: &no_paths,
            accounts: &f.accounts,
            desired: &f.desired,
            installed: &f.installed,
            sync_errors: &f.errors,
            snapshots: &f.snapshots,
            service: &f.service,
            shared: &f.service,
            known: &f.known,
            users: &f.users,
            viewer: 10,
            manager: true,
            platform: f.platform.as_ref(),
            restrictions: &f.restrictions,
            sources: &f.sources,
            disabled: &f.disabled,
        };
        let v = build(&i);
        assert_eq!((v[0].file.as_str(), v[0].windows_admin), (super::super::platform::ADMIN_FILE_LABEL, true));
        assert_eq!((v[1].file.as_str(), v[1].windows_admin), (USER_FILE_LABEL, false));
        assert_eq!(v[0].rows[0].accounts, Some(vec![7]));
        // 沒探測過：預設是帳號自己的檔案。/ Not probed: the account's own file.
        assert_eq!(Fixture::new().build(10, true).file, USER_FILE_LABEL);
        // exec 模式回報了實際路徑（OpenWrt 的 Dropbear：root 讀 /etc/dropbear/authorized_keys）。/ Exec mode reported the real path.
        let paths = HashMap::from([("ubuntu".to_string(), "/etc/dropbear/authorized_keys".to_string())]);
        let f = Fixture::new();
        let i = Inputs { file_paths: &paths, accounts: &f.accounts, desired: &f.desired, installed: &f.installed, sync_errors: &f.errors, snapshots: &f.snapshots, service: &f.service, shared: &BTreeSet::new(), known: &f.known, users: &f.users, viewer: 10, manager: true, platform: None, restrictions: &f.restrictions, sources: &f.sources, disabled: &f.disabled };
        assert_eq!(build(&i)[0].file, "/etc/dropbear/authorized_keys");
    }

    #[test]
    fn listed_rows_say_where_they_come_from() {
        let mut f = Fixture::new();
        f.desired.insert("ubuntu".into(), BTreeSet::from([bare(ALICE), bare(BOB)]));
        // alice 的金鑰只經由群組「Laptops」來；bob 的直接在清單上（沒有來源資料 = 直接）。
        // Alice's key comes only through the "Laptops" group; Bob's is listed directly (no source data = direct).
        f.sources.insert(1, Sources { direct: false, groups: vec![GroupRef { id: 5, name: "Laptops".into() }] });
        let v = f.build(10, true);
        let alice = v.rows.iter().find(|r| r.user_key_id == Some(1)).unwrap();
        let bob = v.rows.iter().find(|r| r.user_key_id == Some(2)).unwrap();
        assert!(!alice.direct);
        assert_eq!(alice.groups, vec![GroupRef { id: 5, name: "Laptops".into() }]);
        assert!(bob.direct && bob.groups.is_empty());
        // 不在清單上的列沒有來源。/ Rows not on the list carry no source.
        f.desired.clear();
        f.snapshots.insert("ubuntu".into(), (Some(format!("{ALICE}\n")), "t".into()));
        let v = f.build(10, true);
        assert!(!v.rows[0].direct && v.rows[0].groups.is_empty());
    }

    #[test]
    fn missing_file() {
        let mut f = Fixture::new();
        f.snapshots.insert("ubuntu".into(), (None, "t".into()));
        let v = f.build(10, true);
        assert_eq!(v.exists, Some(false));
        assert!(v.rows.is_empty());
    }
}
