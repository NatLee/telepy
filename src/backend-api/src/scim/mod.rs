//! SCIM 2.0（RFC 7643 / 7644）帳號同步：身分提供者（Okta、Entra ID…）主動在 Telepy 建帳號、改資料、停用，
//! 以及同步群組成員，不必等人第一次登入。這個檔是純的部分（下面有測試）：解析 User / Group 資源、套用 PATCH
//! （Okta 與 Entra 的寫法都收：op 大小寫、`"False"` 字串、沒有 path 的物件、`name.givenName` 這種鍵）、
//! `attr eq "value"` 的 filter、分頁與回應格式。I/O 在 `api.rs`。
//!
//! SCIM 2.0 provisioning: an identity provider creates, updates and deactivates Telepy accounts and keeps group
//! members in step, ahead of anyone's first sign-in. This file is the pure part (tested below): parsing User / Group
//! resources, applying PATCH (Okta's and Entra's dialects: op case, `"False"` strings, path-less objects, keys such as
//! `name.givenName`), `attr eq "value"` filters, paging and the response shapes. The I/O is in `api.rs`.

pub mod api;

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

pub const USER_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:User";
pub const GROUP_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:Group";
pub const LIST_SCHEMA: &str = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
pub const ERROR_SCHEMA: &str = "urn:ietf:params:scim:api:messages:2.0:Error";
/// 一頁最多幾筆。/ The most resources one page returns.
pub const MAX_COUNT: usize = 200;

/// SCIM 的錯誤（`status` 是字串，照規格）。/ A SCIM error (`status` is a string, as the spec says).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScimError {
    pub status: u16,
    pub scim_type: Option<&'static str>,
    pub detail: String,
}

impl ScimError {
    pub fn new(status: u16, scim_type: Option<&'static str>, detail: impl Into<String>) -> Self {
        Self { status, scim_type, detail: detail.into() }
    }

    pub fn bad(detail: impl Into<String>) -> Self {
        Self::new(400, Some("invalidValue"), detail)
    }

    pub fn json(&self) -> Value {
        let mut v = json!({ "schemas": [ERROR_SCHEMA], "status": self.status.to_string(), "detail": self.detail });
        if let Some(t) = self.scim_type {
            v["scimType"] = json!(t);
        }
        v
    }
}

/// 一個 SCIM 使用者在 Telepy 這邊記得的樣子。/ A SCIM user as Telepy keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScimUser {
    /// 身分提供者送的 userName，原樣記著並原樣回（Okta 會比對）。/ The provider's userName, kept and echoed as sent.
    pub user_name: String,
    pub external_id: Option<String>,
    pub given_name: String,
    pub family_name: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub active: bool,
}

/// `True` / `"False"` / `"true"` 都收（Entra 送字串）。/ Booleans, or the strings Entra sends.
pub fn bool_value(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) if s.eq_ignore_ascii_case("true") => Some(true),
        Value::String(s) if s.eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}

fn str_value(v: &Value) -> Option<String> {
    v.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 屬性名稱：小寫、拿掉 core schema 的 URN 前綴。/ An attribute name: lowercased, the core schema URN dropped.
fn attr_key(k: &str) -> String {
    let k = k.trim();
    let k = k.strip_prefix(USER_SCHEMA).or_else(|| k.strip_prefix(GROUP_SCHEMA)).map(|r| r.trim_start_matches(':')).unwrap_or(k);
    k.to_ascii_lowercase()
}

/// emails 陣列：primary 那個，沒有就第一個。/ The emails array: the primary one, else the first.
fn email_from(v: &Value) -> Option<String> {
    let arr = v.as_array()?;
    let pick = arr.iter().find(|e| e.get("primary").and_then(bool_value) == Some(true)).or_else(|| arr.first())?;
    pick.get("value").and_then(str_value)
}

/// POST / PUT 的 User 資源。userName 必填，active 預設 true。/ A User resource from POST / PUT; userName required.
pub fn user_from_resource(v: &Value) -> Result<ScimUser, ScimError> {
    let o = v.as_object().ok_or_else(|| ScimError::bad("The body must be a JSON object."))?;
    let get = |name: &str| o.iter().find(|(k, _)| attr_key(k) == name).map(|(_, v)| v);
    let user_name = get("username").and_then(str_value).ok_or_else(|| ScimError::bad("userName is required."))?;
    if user_name.chars().count() > 256 {
        return Err(ScimError::bad("userName is too long."));
    }
    let name = get("name");
    let part = |k: &str| name.and_then(|n| n.get(k)).and_then(str_value).unwrap_or_default();
    Ok(ScimUser {
        external_id: get("externalid").and_then(str_value),
        given_name: part("givenName"),
        family_name: part("familyName"),
        display_name: get("displayname").and_then(str_value),
        email: get("emails").and_then(email_from).or_else(|| user_name.contains('@').then(|| user_name.clone())),
        active: get("active").and_then(bool_value).unwrap_or(true),
        user_name,
    })
}

/// 一個屬性（path 或沒有 path 時物件裡的鍵）套到使用者上。不認得的屬性略過（Entra 會送職稱、地址、經理…）。
/// Apply one attribute (a path, or a key of a path-less object). Unknown attributes are skipped (Entra sends titles,
/// addresses, managers…).
fn set_user_attr(u: &mut ScimUser, path: &str, value: Option<&Value>, remove: bool) -> Result<(), ScimError> {
    let key = attr_key(path);
    let text = || if remove { None } else { value.and_then(str_value) };
    if key == "active" {
        if !remove {
            u.active = value.and_then(bool_value).ok_or_else(|| ScimError::bad("active must be true or false."))?;
        }
    } else if key == "username" {
        if let Some(v) = text() {
            u.user_name = v;
        }
    } else if key == "externalid" {
        u.external_id = text();
    } else if key == "displayname" {
        u.display_name = text();
    } else if key == "name.givenname" {
        u.given_name = text().unwrap_or_default();
    } else if key == "name.familyname" {
        u.family_name = text().unwrap_or_default();
    } else if key == "name" {
        let n = if remove { None } else { value };
        u.given_name = n.and_then(|n| n.get("givenName")).and_then(str_value).unwrap_or_default();
        u.family_name = n.and_then(|n| n.get("familyName")).and_then(str_value).unwrap_or_default();
    } else if key == "emails" {
        u.email = if remove { None } else { value.and_then(email_from) };
    } else if key.starts_with("emails[") && key.ends_with("].value") {
        u.email = text();
    }
    Ok(())
}

/// `{Operations: [{op, path?, value?}]}` 套到使用者上。/ Apply a PatchOp to a user.
pub fn apply_user_patch(cur: &ScimUser, body: &Value) -> Result<ScimUser, ScimError> {
    let mut u = cur.clone();
    for op in operations(body)? {
        let kind = op_kind(op)?;
        let value = op.get("value");
        match op.get("path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()) {
            Some(path) => set_user_attr(&mut u, path, value, kind == "remove")?,
            None if kind == "remove" => return Err(ScimError::new(400, Some("noTarget"), "remove needs a path.")),
            None => {
                let obj = value.and_then(Value::as_object).ok_or_else(|| ScimError::bad("An operation without a path needs an object value."))?;
                for (k, v) in obj {
                    set_user_attr(&mut u, k, Some(v), false)?;
                }
            }
        }
    }
    Ok(u)
}

fn operations(body: &Value) -> Result<&Vec<Value>, ScimError> {
    body.as_object()
        .and_then(|o| o.iter().find(|(k, _)| k.eq_ignore_ascii_case("operations")).map(|(_, v)| v))
        .and_then(Value::as_array)
        .ok_or_else(|| ScimError::bad("A PATCH body needs Operations."))
}

fn op_kind(op: &Value) -> Result<String, ScimError> {
    let k = op.get("op").and_then(Value::as_str).map(str::to_ascii_lowercase).unwrap_or_default();
    if matches!(k.as_str(), "add" | "replace" | "remove") {
        Ok(k)
    } else {
        Err(ScimError::bad("op must be add, replace or remove."))
    }
}

/// 一個 SCIM 群組。/ A SCIM group.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScimGroup {
    pub display_name: String,
    pub external_id: Option<String>,
    /// Telepy 使用者 id。/ Telepy user ids.
    pub members: BTreeSet<i64>,
}

/// `[{value: "12"}]` → id；不是數字的略過（不會是 Telepy 的使用者）。/ Member ids; non-numeric ones are skipped.
fn member_ids(v: Option<&Value>) -> BTreeSet<i64> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|m| m.get("value").and_then(|x| x.as_str().map(str::to_string).or_else(|| x.as_i64().map(|n| n.to_string())))).filter_map(|s| s.trim().parse().ok()).collect())
        .unwrap_or_default()
}

pub fn group_from_resource(v: &Value) -> Result<ScimGroup, ScimError> {
    let o = v.as_object().ok_or_else(|| ScimError::bad("The body must be a JSON object."))?;
    let get = |name: &str| o.iter().find(|(k, _)| attr_key(k) == name).map(|(_, v)| v);
    let display_name = get("displayname").and_then(str_value).ok_or_else(|| ScimError::bad("displayName is required."))?;
    Ok(ScimGroup { display_name, external_id: get("externalid").and_then(str_value), members: member_ids(get("members")) })
}

/// `members[value eq "12"]` → 12。/ The id inside a member filter path.
fn member_in_path(path: &str) -> Option<i64> {
    let inner = path.trim().strip_prefix("members[")?.strip_suffix(']')?;
    match parse_filter(inner).ok()? {
        Filter::Eq { attr, value } if attr == "value" => value.parse().ok(),
        _ => None,
    }
}

pub fn apply_group_patch(cur: &ScimGroup, body: &Value) -> Result<ScimGroup, ScimError> {
    let mut g = cur.clone();
    for op in operations(body)? {
        let kind = op_kind(op)?;
        let value = op.get("value");
        let path = op.get("path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty());
        match (kind.as_str(), path) {
            (_, Some(p)) if p.to_ascii_lowercase().starts_with("members[") => {
                let id = member_in_path(p).ok_or_else(|| ScimError::new(400, Some("invalidPath"), format!("Can't read {p}.")))?;
                if kind == "remove" {
                    g.members.remove(&id);
                } else {
                    g.members.insert(id);
                }
            }
            ("add", Some(p)) if attr_key(p) == "members" => g.members.extend(member_ids(value)),
            ("remove", Some(p)) if attr_key(p) == "members" => match value {
                Some(_) => {
                    for id in member_ids(value) {
                        g.members.remove(&id);
                    }
                }
                None => g.members.clear(),
            },
            ("replace", Some(p)) if attr_key(p) == "members" => g.members = member_ids(value),
            (_, Some(p)) if attr_key(p) == "displayname" => {
                if kind != "remove" {
                    if let Some(n) = value.and_then(str_value) {
                        g.display_name = n;
                    }
                }
            }
            (_, Some(p)) if attr_key(p) == "externalid" => g.external_id = if kind == "remove" { None } else { value.and_then(str_value) },
            ("remove", None) => return Err(ScimError::new(400, Some("noTarget"), "remove needs a path.")),
            (_, None) => {
                let obj: &Map<String, Value> = value.and_then(Value::as_object).ok_or_else(|| ScimError::bad("An operation without a path needs an object value."))?;
                for (k, v) in obj {
                    match attr_key(k).as_str() {
                        "displayname" => {
                            if let Some(n) = str_value(v) {
                                g.display_name = n;
                            }
                        }
                        "externalid" => g.external_id = str_value(v),
                        "members" if kind == "add" => g.members.extend(member_ids(Some(v))),
                        "members" => g.members = member_ids(Some(v)),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(g)
}

/// 只支援 `屬性 eq "值"`（Okta、Entra 用的就是這個）。/ Only `attr eq "value"` (what Okta and Entra use).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    Eq { attr: String, value: String },
}

pub fn parse_filter(s: &str) -> Result<Filter, ScimError> {
    let bad = || ScimError::new(400, Some("invalidFilter"), format!("Only `attribute eq \"value\"` filters are supported: {s}"));
    let s = s.trim();
    let (attr, rest) = s.split_once(char::is_whitespace).ok_or_else(bad)?;
    let rest = rest.trim_start();
    let (op, value) = rest.split_once(char::is_whitespace).ok_or_else(bad)?;
    if !op.eq_ignore_ascii_case("eq") {
        return Err(bad());
    }
    let value = value.trim();
    let value = if let Some(q) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
        q.replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        value.to_string()
    };
    Ok(Filter::Eq { attr: attr_key(attr), value })
}

/// `startIndex`（從 1 開始）與 `count` → (略過幾筆, 取幾筆)。/ Paging → (skip, take).
pub fn page(start_index: Option<i64>, count: Option<i64>) -> (usize, usize) {
    let start = start_index.unwrap_or(1).max(1) as usize;
    let take = count.map(|c| c.clamp(0, MAX_COUNT as i64) as usize).unwrap_or(100);
    (start - 1, take)
}

pub fn list_json(total: usize, skip: usize, resources: Vec<Value>) -> Value {
    json!({ "schemas": [LIST_SCHEMA], "totalResults": total, "startIndex": skip + 1, "itemsPerPage": resources.len(), "Resources": resources })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alice() -> ScimUser {
        user_from_resource(&json!({
            "schemas": [USER_SCHEMA], "userName": "alice@corp.example", "externalId": "00u1",
            "name": {"givenName": "Alice", "familyName": "W"},
            "emails": [{"value": "a.w@corp.example", "type": "work", "primary": true}, {"value": "x@y"}],
            "active": true, "title": "ignored"
        }))
        .unwrap()
    }

    #[test]
    fn users_are_read_from_okta_and_entra_shapes() {
        let a = alice();
        assert_eq!((a.user_name.as_str(), a.external_id.as_deref(), a.given_name.as_str(), a.email.as_deref(), a.active), ("alice@corp.example", Some("00u1"), "Alice", Some("a.w@corp.example"), true));
        let b = user_from_resource(&json!({"userName": "bob@corp.example", "active": "False"})).unwrap();
        assert_eq!((b.email.as_deref(), b.active), (Some("bob@corp.example"), false), "the email falls back to an email-shaped userName; Entra's string boolean");
        assert_eq!(user_from_resource(&json!({"name": {}})).unwrap_err().scim_type, Some("invalidValue"));
        assert!(user_from_resource(&json!([1])).is_err());
    }

    #[test]
    fn user_patches_in_both_dialects() {
        // Entra：op 大寫、字串布林、path 帶 filter。/ Entra: capitalised ops, string booleans, filtered paths.
        let entra = json!({"schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], "Operations": [
            {"op": "Replace", "path": "active", "value": "False"},
            {"op": "Replace", "path": "emails[type eq \"work\"].value", "value": "new@corp.example"},
            {"op": "Add", "path": "name.givenName", "value": "Ali"},
            {"op": "Add", "path": "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", "value": "R&D"}
        ]});
        let u = apply_user_patch(&alice(), &entra).unwrap();
        assert_eq!((u.active, u.email.as_deref(), u.given_name.as_str()), (false, Some("new@corp.example"), "Ali"));
        // Okta：沒有 path 的物件。/ Okta: a path-less object.
        let okta = json!({"Operations": [{"op": "replace", "value": {"active": true, "name.familyName": "Wong", "displayName": "Ali W"}}]});
        let u = apply_user_patch(&u, &okta).unwrap();
        assert_eq!((u.active, u.family_name.as_str(), u.display_name.as_deref()), (true, "Wong", Some("Ali W")));
        let u = apply_user_patch(&u, &json!({"Operations": [{"op": "remove", "path": "externalId"}]})).unwrap();
        assert_eq!(u.external_id, None);
        assert_eq!(apply_user_patch(&u, &json!({"Operations": [{"op": "move"}]})).unwrap_err().scim_type, Some("invalidValue"));
        assert_eq!(apply_user_patch(&u, &json!({"Operations": [{"op": "replace", "path": "active", "value": "maybe"}]})).unwrap_err().detail, "active must be true or false.");
        assert!(apply_user_patch(&u, &json!({})).is_err(), "no Operations");
    }

    #[test]
    fn group_patches_add_remove_and_replace_members() {
        let g = group_from_resource(&json!({"displayName": "Ops", "members": [{"value": "3"}, {"value": "x"}, {"value": 4}]})).unwrap();
        assert_eq!(g.members, BTreeSet::from([3, 4]));
        let p = |ops: Value| apply_group_patch(&g, &json!({ "Operations": ops })).unwrap();
        assert_eq!(p(json!([{"op": "Add", "path": "members", "value": [{"value": "5"}]}])).members, BTreeSet::from([3, 4, 5]));
        assert_eq!(p(json!([{"op": "remove", "path": "members[value eq \"3\"]"}])).members, BTreeSet::from([4]));
        assert_eq!(p(json!([{"op": "Remove", "path": "members", "value": [{"value": "4"}]}])).members, BTreeSet::from([3]));
        assert_eq!(p(json!([{"op": "remove", "path": "members"}])).members, BTreeSet::new());
        assert_eq!(p(json!([{"op": "replace", "path": "members", "value": [{"value": "9"}]}])).members, BTreeSet::from([9]));
        let r = p(json!([{"op": "replace", "value": {"id": "7", "displayName": "Ops team"}}]));
        assert_eq!((r.display_name.as_str(), r.members.len()), ("Ops team", 2), "Okta's rename keeps the members");
        assert_eq!(apply_group_patch(&g, &json!({"Operations": [{"op": "remove", "path": "members[x]"}]})).unwrap_err().scim_type, Some("invalidPath"));
    }

    #[test]
    fn filters_and_pages() {
        assert_eq!(parse_filter(r#"userName eq "alice@corp.example""#).unwrap(), Filter::Eq { attr: "username".into(), value: "alice@corp.example".into() });
        assert_eq!(parse_filter(r#"displayName  EQ  "A \"quoted\" name""#).unwrap(), Filter::Eq { attr: "displayname".into(), value: "A \"quoted\" name".into() });
        assert_eq!(parse_filter("id eq 12").unwrap(), Filter::Eq { attr: "id".into(), value: "12".into() });
        assert_eq!(parse_filter(r#"userName sw "a""#).unwrap_err().scim_type, Some("invalidFilter"));
        assert_eq!(page(None, None), (0, 100));
        assert_eq!(page(Some(11), Some(5)), (10, 5));
        assert_eq!(page(Some(0), Some(9999)), (0, MAX_COUNT));
        assert_eq!(list_json(3, 0, vec![json!({})])["itemsPerPage"], 1);
        assert_eq!(ScimError::new(409, Some("uniqueness"), "taken").json()["status"], "409");
    }
}
