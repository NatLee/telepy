//! 身分提供者的群組 → Telepy 的角色（管理員、功能權限的使用者群組）。純的部分：從 id_token 讀群組 claim、
//! 「只有這些群組能登入」、規則算出該有的角色，以及這次登入要加什麼、拿掉什麼。
//!
//! 只拿掉**這個提供者自己給過的**（`telepy_oidc_grant` 有紀錄的）：管理員手動加的成員資格與管理員身分永遠不動；
//! 這個提供者給的管理員，在它是最後一位啟用中的管理員時也不拿掉（不讓網站沒有管理員）。id_token 沒有群組 claim 時
//! 什麼都不改（不知道就不動），claim 在但是空的才算「不在任何群組」。比對完全相同（含大小寫）。
//!
//! Provider groups → Telepy roles (administrator, feature-access user groups). The pure part: reading the groups claim,
//! "only these groups may sign in", the roles the rules call for, and what a sign-in adds and removes. Only what
//! **this provider granted** (recorded in `telepy_oidc_grant`) is ever taken away: memberships and admin rights an
//! administrator gave by hand stay, and an admin right this provider gave stays while it is the last active
//! administrator. A token without the claim changes nothing; a present but empty claim means "in no group".
//! Matching is exact, case included.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

/// 一條規則的對象。/ What a rule grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Target {
    Admin,
    Group(i64),
}

impl Target {
    pub fn kind(self) -> &'static str {
        match self {
            Target::Admin => "admin",
            Target::Group(_) => "group",
        }
    }

    pub fn group_id(self) -> Option<i64> {
        match self {
            Target::Admin => None,
            Target::Group(id) => Some(id),
        }
    }

    pub fn from_parts(kind: &str, group_id: Option<i64>) -> Option<Self> {
        match (kind, group_id) {
            ("admin", _) => Some(Target::Admin),
            ("group", Some(id)) => Some(Target::Group(id)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub idp_group: String,
    pub target: Target,
}

/// 一個提供者最多幾條規則、幾個「只限群組」。/ Limits per provider.
pub const MAX_RULES: usize = 100;
pub const MAX_REQUIRED: usize = 50;
/// 一個群組名稱最長幾個字。/ The longest group name accepted.
pub const MAX_GROUP_LEN: usize = 256;

/// claim 路徑：字母、數字、`_ - : / .`，`.` 分層（`realm_access.roles`）。/ A claim path; `.` goes one level down.
pub fn check_claim_path(path: &str) -> Result<(), String> {
    let ok = !path.is_empty() && path.len() <= 128 && path.chars().all(|c| c.is_ascii_alphanumeric() || "_-:/.".contains(c)) && !path.starts_with('.') && !path.ends_with('.') && !path.contains("..");
    if ok {
        Ok(())
    } else {
        Err("Use a claim name such as groups, roles or realm_access.roles (letters, digits, _ - : / and dots between levels).".into())
    }
}

/// 從 claim 裡讀群組：整個路徑先當一個名字找（有的 claim 名字本身就有點），找不到才一層一層往下。
/// 字串陣列或數字陣列都行，單一字串 = 一個群組；沒有這個 claim 或型別不對 = None。
/// Read the groups: the whole path as one name first (some claim names contain dots), then level by level. An array of
/// strings / numbers, or one string = one group; missing or another type = None.
pub fn claim_groups(claims: &Map<String, Value>, path: &str) -> Option<Vec<String>> {
    let found = claims.get(path).or_else(|| {
        let mut parts = path.split('.');
        let mut v = claims.get(parts.next()?)?;
        for p in parts {
            v = v.as_object()?.get(p)?;
        }
        Some(v)
    })?;
    let one = |v: &Value| match v {
        Value::String(s) => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    };
    let mut out: Vec<String> = match found {
        Value::Array(items) => items.iter().filter_map(one).collect(),
        Value::String(s) => vec![s.trim().to_string()],
        _ => return None,
    };
    let mut seen = std::collections::HashSet::new();
    out.retain(|g| !g.is_empty() && seen.insert(g.clone()));
    Some(out)
}

/// 「只有這些群組能登入」。清單空 = 不限。/ "Only these groups may sign in"; empty = anyone.
pub fn allowed(required: &[String], groups: Option<&[String]>) -> Result<(), &'static str> {
    if required.is_empty() {
        return Ok(());
    }
    match groups {
        None => Err("sso_no_groups"),
        Some(g) if g.iter().any(|x| required.contains(x)) => Ok(()),
        Some(_) => Err("sso_group_not_allowed"),
    }
}

/// 這些群組照規則該有的角色。/ The roles the rules give these groups.
pub fn desired(rules: &[Rule], groups: &[String]) -> BTreeSet<Target> {
    rules.iter().filter(|r| groups.iter().any(|g| *g == r.idp_group)).map(|r| r.target).collect()
}

/// 現在的狀態。/ Where the person stands now.
#[derive(Debug, Clone, Default)]
pub struct Current {
    /// 他現在在哪些使用者群組（不論誰加的）。/ The user groups they are in now (whoever added them).
    pub member_of: BTreeSet<i64>,
    pub is_admin: bool,
    /// 這個提供者給過、還記著的。/ What this provider granted and still has on record.
    pub granted: BTreeSet<Target>,
    /// 拿掉他的管理員之後還有別的啟用中管理員。/ Another active administrator remains if this one goes.
    pub other_admins: bool,
}

/// 這次登入要做的事。/ What a sign-in does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncPlan {
    pub join: Vec<i64>,
    pub leave: Vec<i64>,
    pub make_admin: bool,
    pub revoke_admin: bool,
    /// 該拿掉但他是最後一位管理員，所以留著（紀錄也留著，下次再試）。/ Kept: the last administrator.
    pub kept_last_admin: bool,
    /// 新記下的（這個提供者給的）。/ Newly recorded grants.
    pub record: Vec<Target>,
    /// 不再記著的。/ Grants no longer recorded.
    pub forget: Vec<Target>,
}

impl SyncPlan {
    pub fn is_empty(&self) -> bool {
        self.join.is_empty() && self.leave.is_empty() && !self.make_admin && !self.revoke_admin && self.record.is_empty() && self.forget.is_empty()
    }

    /// 有沒有讓人失去什麼（失去的話要重新檢查進行中的 session）。/ Whether anything was taken away.
    pub fn takes_away(&self) -> bool {
        !self.leave.is_empty() || self.revoke_admin
    }
}

/// 算出這次登入要加什麼、拿掉什麼。已經有的（不論誰給的）不重複加，也不記成這個提供者給的——
/// 管理員手動加的成員資格就不會因為提供者那邊的群組變動被拿掉。
/// What a sign-in adds and removes. Something already there (whoever gave it) is neither added again nor recorded as
/// this provider's, so a membership an administrator gave by hand never goes when the provider's groups change.
pub fn plan(want: &BTreeSet<Target>, now: &Current) -> SyncPlan {
    let mut p = SyncPlan::default();
    for t in want {
        match *t {
            Target::Group(id) if !now.member_of.contains(&id) => {
                p.join.push(id);
                p.record.push(*t);
            }
            Target::Admin if !now.is_admin => {
                p.make_admin = true;
                p.record.push(*t);
            }
            _ => {}
        }
    }
    for t in &now.granted {
        if want.contains(t) {
            continue;
        }
        match *t {
            Target::Group(id) => {
                if now.member_of.contains(&id) {
                    p.leave.push(id);
                }
                p.forget.push(*t);
            }
            Target::Admin => {
                if !now.is_admin {
                    p.forget.push(*t);
                } else if now.other_admins {
                    p.revoke_admin = true;
                    p.forget.push(*t);
                } else {
                    p.kept_last_admin = true;
                }
            }
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claims(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn groups_are_read_from_flat_dotted_and_nested_claims() {
        let c = claims(json!({"groups": ["ops", " dba ", "", 7], "realm_access": {"roles": ["admin"]}, "x.y": "flat", "single": "one", "obj": {"a": 1}}));
        assert_eq!(claim_groups(&c, "groups"), Some(vec!["ops".into(), "dba".into(), "7".into()]));
        assert_eq!(claim_groups(&c, "realm_access.roles"), Some(vec!["admin".into()]));
        assert_eq!(claim_groups(&c, "x.y"), Some(vec!["flat".into()]), "a claim whose name has a dot");
        assert_eq!(claim_groups(&c, "single"), Some(vec!["one".into()]));
        assert_eq!(claim_groups(&c, "missing"), None);
        assert_eq!(claim_groups(&c, "obj"), None, "an object is not a group list");
        assert_eq!(claim_groups(&claims(json!({"groups": []})), "groups"), Some(vec![]), "present but empty");
        assert!(check_claim_path("resource_access.telepy.roles").is_ok());
        assert!(check_claim_path("https://example.com/groups").is_ok());
        for bad in ["", ".groups", "groups.", "a..b", "group s", "g$"] {
            assert!(check_claim_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_listed_groups_may_sign_in() {
        let req = vec!["staff".to_string()];
        assert_eq!(allowed(&[], None), Ok(()));
        assert_eq!(allowed(&req, None), Err("sso_no_groups"));
        assert_eq!(allowed(&req, Some(&["Staff".to_string()])), Err("sso_group_not_allowed"), "case counts");
        assert_eq!(allowed(&req, Some(&["x".into(), "staff".into()])), Ok(()));
    }

    fn rules() -> Vec<Rule> {
        vec![Rule { idp_group: "ops".into(), target: Target::Group(1) }, Rule { idp_group: "dba".into(), target: Target::Group(2) }, Rule { idp_group: "root".into(), target: Target::Admin }]
    }

    #[test]
    fn a_sign_in_adds_what_the_groups_call_for_and_records_it() {
        let want = desired(&rules(), &["ops".into(), "root".into(), "other".into()]);
        assert_eq!(want, BTreeSet::from([Target::Admin, Target::Group(1)]));
        let p = plan(&want, &Current::default());
        assert_eq!((p.join.clone(), p.make_admin), (vec![1], true));
        assert_eq!(p.record, vec![Target::Admin, Target::Group(1)]);
        // 已經是成員（管理員手動加的）：不加也不記。/ Already a member by hand: neither added nor recorded.
        let p = plan(&want, &Current { member_of: BTreeSet::from([1]), is_admin: true, ..Default::default() });
        assert!(p.is_empty(), "{p:?}");
    }

    #[test]
    fn only_what_this_provider_gave_is_taken_away() {
        let now = Current { member_of: BTreeSet::from([1, 2, 3]), is_admin: true, granted: BTreeSet::from([Target::Group(1), Target::Admin]), other_admins: true };
        let p = plan(&desired(&rules(), &["dba".into()]), &now);
        assert_eq!(p.leave, vec![1], "group 1 was the provider's; 2 and 3 were given by hand");
        assert!(p.revoke_admin && p.takes_away());
        assert_eq!(p.forget, vec![Target::Admin, Target::Group(1)]);
        assert!(p.join.is_empty() && p.record.is_empty(), "already in group 2 by hand: not recorded");
        // 最後一位管理員：留著，紀錄也留著。/ The last administrator stays, and so does the record.
        let p = plan(&BTreeSet::new(), &Current { other_admins: false, ..now.clone() });
        assert!(p.kept_last_admin && !p.revoke_admin);
        assert!(!p.forget.contains(&Target::Admin));
        // 已經被手動拿掉的：只是不再記著。/ Already removed by hand: just forgotten.
        let p = plan(&BTreeSet::new(), &Current { member_of: BTreeSet::new(), is_admin: false, ..now });
        assert!(p.leave.is_empty() && !p.revoke_admin);
        assert_eq!(p.forget, vec![Target::Admin, Target::Group(1)]);
    }
}
