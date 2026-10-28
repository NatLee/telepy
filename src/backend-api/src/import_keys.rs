//! `telepy-server import-user-keys <file.json> [--dry-run]`：管理員把個人 SSH 公鑰（例如從舊的 Telepy 搬來）
//! 放到指定帳號下。在後端容器裡跑，走跟 `POST /api/reverse/user/keys` 完全一樣的檢查與寫入
//! （`api::user_keys::prepare_new` / `insert_new`），所以不用從外面動正式環境的 SQLite。
//! An admin moves personal SSH public keys (e.g. from an older Telepy server) onto the right accounts. It runs inside
//! the backend container and goes through exactly the checks and insert of `POST /api/reverse/user/keys`, so nobody
//! has to edit the live SQLite file from outside.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::api::user_keys::{insert_new, prepare_new};
use crate::db;
use crate::device_keys::authorized_keys::parse_public_key;
use crate::error::ApiError;
use crate::state::AppState;

/// 輸入檔的一筆。/ One entry of the input file.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub username: String,
    pub name: String,
    pub key: String,
    pub description: Option<String>,
    /// 跟 API 一樣：RFC 3339 或 `YYYY-MM-DD`（原樣交給 API 的解析）。/ As the API takes it.
    pub expires_at: Option<Value>,
}

/// 每筆的結果。/ What happened to one entry.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Added,
    /// `--dry-run`：會加入。/ Dry run: would be added.
    WouldAdd,
    AlreadyThere,
    Skipped(String),
}

#[derive(Debug, Clone)]
pub struct Line {
    /// 從 1 起算。/ 1-based position in the file.
    pub index: usize,
    pub username: String,
    pub name: String,
    pub fingerprint: Option<String>,
    pub outcome: Outcome,
}

/// 讀輸入檔：最外層必須是陣列；單筆格式錯只跳過那筆。/ Parse the file: a JSON array; a malformed entry only skips itself.
pub fn parse_items(text: &str) -> Result<Vec<Result<Item, String>>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))?;
    let Value::Array(entries) = v else {
        return Err("expected a JSON array of {\"username\", \"name\", \"key\"} objects".into());
    };
    Ok(entries.iter().map(parse_item).collect())
}

fn parse_item(v: &Value) -> Result<Item, String> {
    let Value::Object(o) = v else { return Err("entry is not an object".into()) };
    let text = |k: &str| -> Result<String, String> {
        match o.get(k) {
            Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.trim().to_string()),
            Some(Value::String(_)) | None | Some(Value::Null) => Err(format!("\"{k}\" is required")),
            Some(_) => Err(format!("\"{k}\" must be a string")),
        }
    };
    let description = match o.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err("\"description\" must be a string".into()),
    };
    if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "username" | "name" | "key" | "description" | "expires_at")) {
        return Err(format!("unknown field \"{k}\""));
    }
    Ok(Item {
        username: text("username")?,
        name: text("name")?,
        key: text("key")?,
        description,
        expires_at: o.get("expires_at").cloned(),
    })
}

/// API 的錯誤本文 → 一行原因（`{field: [msg]}` / `{error}` / `{detail}`）。/ An API error body as one line.
pub fn reason(body: &Value) -> String {
    let Value::Object(o) = body else { return body.to_string() };
    let mut parts = Vec::new();
    for (field, v) in o {
        let msgs = match v {
            Value::Array(a) => a.iter().map(|m| m.as_str().map(str::to_string).unwrap_or_else(|| m.to_string())).collect::<Vec<_>>().join(" "),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        if matches!(field.as_str(), "error" | "detail" | "non_field_errors") {
            parts.push(msgs);
        } else {
            parts.push(format!("{field}: {msgs}"));
        }
    }
    parts.join("; ")
}

fn api_reason(e: &ApiError) -> String {
    reason(&e.body)
}

/// API 會收到的本文。/ The body the API would get.
fn api_body(item: &Item) -> Value {
    let mut body = json!({ "host_friendly_name": item.name, "key": item.key });
    if let Some(d) = &item.description {
        body["description"] = json!(d);
    }
    if let Some(e) = &item.expires_at {
        body["expires_at"] = e.clone();
    }
    body
}

/// 逐筆匯入（`dry_run` = 只檢查不寫）。/ Import every entry (`dry_run` = check only).
pub async fn run(state: &AppState, items: &[Result<Item, String>], dry_run: bool) -> anyhow::Result<Vec<Line>> {
    let db = &state.db;
    // 試跑時記下「這次會加的」，檔案裡前後重複也照真跑的結果判斷。/ Dry run: what this run would add, so in-file
    // duplicates come out as a real run would.
    let mut planned_keys: HashMap<String, i64> = HashMap::new();
    let mut planned_names: HashSet<String> = HashSet::new();
    let mut lines = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let index = i + 1;
        let item = match item {
            Ok(it) => it,
            Err(msg) => {
                lines.push(Line { index, username: String::new(), name: String::new(), fingerprint: None, outcome: Outcome::Skipped(msg.clone()) });
                continue;
            }
        };
        let parsed = parse_public_key(item.key.trim());
        let mut line = Line { index, username: item.username.clone(), name: item.name.clone(), fingerprint: parsed.as_ref().map(|p| p.fingerprint.clone()), outcome: Outcome::Added };
        let user = match db::users::by_username(db, &item.username).await? {
            Some(u) if u.is_active => u,
            Some(_) => {
                line.outcome = Outcome::Skipped(format!("account \"{}\" is disabled", item.username));
                lines.push(line);
                continue;
            }
            None => {
                line.outcome = Outcome::Skipped(format!("no account named \"{}\"", item.username));
                lines.push(line);
                continue;
            }
        };
        // 同一把金鑰已經在這個人名下（不看 comment）= 已經有了，不是錯。/ Already this user's key (comment ignored).
        if let Some(p) = &parsed {
            let mine = db::keys::user_keys(db, user.id).await?;
            let owned = mine.iter().any(|k| parse_public_key(&k.key).is_some_and(|q| q.bare == p.bare));
            if owned || planned_keys.get(&p.bare) == Some(&user.id) {
                line.outcome = Outcome::AlreadyThere;
                lines.push(line);
                continue;
            }
            if dry_run && planned_keys.contains_key(&p.bare) {
                line.outcome = Outcome::Skipped("key: user keys with this SSH Key (public) already exists.".into());
                lines.push(line);
                continue;
            }
        }
        let new = match prepare_new(db, &api_body(item), user.id).await {
            Ok(n) => n,
            Err(e) => {
                line.outcome = Outcome::Skipped(api_reason(&e));
                lines.push(line);
                continue;
            }
        };
        if dry_run {
            // 名稱的唯一性在 API 是寫入時由 DB 擋；試跑先查。/ The API leaves name uniqueness to the insert; check it here.
            if planned_names.contains(&new.name) || db::keys::user_key_name_taken(db, &new.name).await? {
                line.outcome = Outcome::Skipped("host_friendly_name: user keys with this Host Friendly Name already exists.".into());
            } else {
                planned_names.insert(new.name.clone());
                if let Some(p) = &parsed {
                    planned_keys.insert(p.bare.clone(), user.id);
                }
                line.outcome = Outcome::WouldAdd;
            }
            lines.push(line);
            continue;
        }
        match insert_new(db, user.id, &new).await {
            Ok(_) => {
                let fp = line.fingerprint.clone().unwrap_or_default();
                state.gateway.event("user_key_import", None, None, None, format!("{} ({fp}) added to {} by import-user-keys", new.name, user.username)).await;
                line.outcome = Outcome::Added;
            }
            Err(e) => line.outcome = Outcome::Skipped(api_reason(&e)),
        }
        lines.push(line);
    }
    Ok(lines)
}

/// 有沒有因為錯誤而跳過的。/ Was any entry skipped for an error?
pub fn failed(lines: &[Line]) -> bool {
    lines.iter().any(|l| matches!(l.outcome, Outcome::Skipped(_)))
}

/// 一筆一行 + 摘要。只印指紋，不印公鑰本體。/ One line per entry plus a summary; fingerprints only, never key blobs.
pub fn render(lines: &[Line], dry_run: bool) -> String {
    let mut out = String::new();
    let (mut added, mut there, mut skipped) = (0, 0, 0);
    for l in lines {
        let what = match &l.outcome {
            Outcome::Added => {
                added += 1;
                "added".to_string()
            }
            Outcome::WouldAdd => {
                added += 1;
                "would add".to_string()
            }
            Outcome::AlreadyThere => {
                there += 1;
                "already there".to_string()
            }
            Outcome::Skipped(r) => {
                skipped += 1;
                format!("skipped: {r}")
            }
        };
        let who = if l.username.is_empty() { "-".to_string() } else { l.username.clone() };
        let name = if l.name.is_empty() { "-".to_string() } else { format!("\"{}\"", l.name) };
        let fp = l.fingerprint.as_deref().unwrap_or("-");
        out.push_str(&format!("#{} {who} {name} {fp}: {what}\n", l.index));
    }
    let verb = if dry_run { "would add" } else { "added" };
    out.push_str(&format!(
        "{} entr{}: {added} {verb}, {there} already there, {skipped} skipped{}\n",
        lines.len(),
        if lines.len() == 1 { "y" } else { "ies" },
        if dry_run { " (dry run, nothing written)" } else { "" }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries_and_flags_bad_ones() {
        let items = parse_items(
            r#"[{"username":" alice ","name":"laptop","key":"ssh-ed25519 AAAA x","expires_at":"2099-01-01"},
                {"username":"bob","name":"","key":"k"},
                {"username":"bob","name":"n","key":"k","extra":1},
                3]"#,
        )
        .unwrap();
        assert_eq!(items.len(), 4);
        let a = items[0].as_ref().unwrap();
        assert_eq!(a.username, "alice");
        assert_eq!(a.expires_at, Some(json!("2099-01-01")));
        assert!(items[1].as_ref().unwrap_err().contains("\"name\" is required"));
        assert!(items[2].as_ref().unwrap_err().contains("unknown field \"extra\""));
        assert!(items[3].is_err());
        assert!(parse_items("{}").is_err());
        assert!(parse_items("nope").is_err());
    }

    #[test]
    fn reasons_flatten_api_errors() {
        assert_eq!(reason(&json!({"key": ["Bad key."]})), "key: Bad key.");
        assert_eq!(reason(&json!({"error": "nope"})), "nope");
        assert_eq!(reason(&json!({"expires_at": ["a", "b"], "key": ["c"]})), "expires_at: a b; key: c");
    }

    #[test]
    fn renders_lines_and_summary_without_key_blobs() {
        let lines = vec![
            Line { index: 1, username: "alice".into(), name: "laptop".into(), fingerprint: Some("SHA256:abc".into()), outcome: Outcome::Added },
            Line { index: 2, username: "bob".into(), name: "pc".into(), fingerprint: None, outcome: Outcome::Skipped("no account named \"bob\"".into()) },
            Line { index: 3, username: "alice".into(), name: "x".into(), fingerprint: Some("SHA256:def".into()), outcome: Outcome::AlreadyThere },
        ];
        let out = render(&lines, false);
        assert_eq!(
            out,
            "#1 alice \"laptop\" SHA256:abc: added\n#2 bob \"pc\" -: skipped: no account named \"bob\"\n#3 alice \"x\" SHA256:def: already there\n3 entries: 1 added, 1 already there, 1 skipped\n"
        );
        assert!(failed(&lines));
        assert!(!failed(&lines[..1]));
        assert!(render(&lines[..1], true).ends_with("1 entry: 1 would add, 0 already there, 0 skipped (dry run, nothing written)\n"));
    }
}
