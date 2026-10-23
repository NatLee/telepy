//! 裝置金鑰面板的合併檢視：清單（應該在哪）× Telepy 裝過的 × 裝置上實際的 authorized_keys（最近一次讀到的），
//! 每個帳號一張卡、每把金鑰一列，一眼看出「清單上的有沒有真的在裝置上、裝置上有什麼不是 Telepy 加的」。純函式。
//! Merged view for the device-key panel: the list (where keys should be) × what Telepy installed × the
//! account's authorized_keys as last read. One card per account, one row per key. Pure.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;

use super::authorized_keys::{parse_authorized_keys, ParsedKey};

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
    pub error: Option<String>,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountView {
    pub username: String,
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
    pub service: &'a BTreeSet<String>,
    /// bare → 金鑰。/ bare → key.
    pub known: &'a HashMap<String, KnownKey>,
    /// user id → username（金鑰已刪除時找擁有者用）。/ For keys that were deleted since.
    pub users: &'a HashMap<i64, String>,
    pub viewer: i64,
    /// 擁有者 / ADMIN 看到每一列；其他人只看到自己的金鑰。/ Owners / ADMIN see every row; others only their own keys.
    pub manager: bool,
}

fn base(state: RowState) -> Row {
    Row {
        state,
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
        error: None,
        raw: None,
    }
}

fn with_key(mut r: Row, k: &ParsedKey) -> Row {
    r.fingerprint = Some(k.fingerprint.clone());
    r.key_type = Some(k.label);
    r.bits = k.bits;
    r
}

fn with_known(mut r: Row, k: &KnownKey, viewer: i64) -> Row {
    r.user_key_id = Some(k.user_key_id);
    r.name = Some(k.name.clone());
    r.owner = Some(k.owner.clone());
    r.mine = k.owner_id == viewer;
    with_key(r, &k.parsed)
}

pub fn build(i: &Inputs) -> Vec<AccountView> {
    i.accounts.iter().map(|acct| account(i, acct)).collect()
}

fn account(i: &Inputs, acct: &str) -> AccountView {
    let snapshot = i.snapshots.get(acct);
    let lines = snapshot.and_then(|(c, _)| c.as_deref()).map(parse_authorized_keys).unwrap_or_default();
    // bare → 檔案裡第一行。/ bare → first line in the file.
    let mut in_file: HashMap<&str, &super::authorized_keys::AuthorizedLine> = HashMap::new();
    for l in &lines {
        if let Some(k) = &l.key {
            in_file.entry(k.bare.as_str()).or_insert(l);
        }
    }
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
        }
        if let Some(k) = i.known.get(bare) {
            r = with_known(r, k, i.viewer);
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
            r = with_known(r, k, i.viewer);
        } else {
            r.owner = owner.and_then(|id| i.users.get(&id).cloned());
            r.mine = *owner == Some(i.viewer);
        }
        if let Some(l) = line {
            r.options = l.options.clone();
            r.line_no = Some(l.line_no);
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
        r.verified = true;
        r.options = l.options.clone();
        r.line_no = Some(l.line_no);
        if !k.comment.is_empty() {
            r.comment = Some(k.comment.clone());
        }
        if let Some(known) = i.known.get(&k.bare) {
            r = with_known(r, known, i.viewer);
        }
        rows.push(r);
    }
    if !i.manager {
        rows.retain(|r| r.mine);
    }
    rows.sort_by(|a, b| a.state.cmp(&b.state).then_with(|| a.name.cmp(&b.name)).then_with(|| a.line_no.cmp(&b.line_no)));
    AccountView {
        username: acct.to_string(),
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
            }
        }
        fn build(&self, viewer: i64, manager: bool) -> AccountView {
            let i = Inputs {
                accounts: &self.accounts,
                desired: &self.desired,
                installed: &self.installed,
                sync_errors: &self.errors,
                snapshots: &self.snapshots,
                service: &self.service,
                known: &self.known,
                users: &self.users,
                viewer,
                manager,
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
    fn missing_file() {
        let mut f = Fixture::new();
        f.snapshots.insert("ubuntu".into(), (None, "t".into()));
        let v = f.build(10, true);
        assert_eq!(v.exists, Some(false));
        assert!(v.rows.is_empty());
    }
}
