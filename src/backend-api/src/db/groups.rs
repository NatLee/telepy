//! 群組（每個人自己的）：
//! - 通道群組：通道列表的資料夾。一條通道在一個人那裡最多屬於一組；只能放自己看得到的通道（失去存取時自動拿掉）。
//! - 金鑰群組：自己的金鑰分組，一把金鑰最多一組。
//! - 授予：金鑰群組 → 一條通道，或自己的一個通道群組。授予是「活的」：組裡加減金鑰、通道群組加減通道，
//!   裝置上的金鑰就跟著裝上 / 移除（`db::device_keys::group_entries` 在每次同步時現算，不複製到清單）。
//!
//! Personal groups:
//! - tunnel groups are folders for the tunnel list; a tunnel is in at most one of a person's groups, and only
//!   tunnels they can see (membership goes when access goes);
//! - key groups hold a person's own keys, a key in at most one group;
//! - a grant gives a key group to one tunnel or to one of the owner's tunnel groups. Grants are live: keys added
//!   to the group, or tunnels added to the tunnel group, are installed (and removed) on the next sync, because
//!   `db::device_keys::group_entries` derives them every time instead of copying them into the key lists.

use std::collections::{BTreeSet, HashMap};

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

/// 一個人最多幾個通道群組 / 金鑰群組。/ Groups per person, per kind.
pub const MAX_GROUPS: usize = 100;
/// 群組名稱最長幾個字元。/ Longest group name, in characters.
pub const MAX_NAME_CHARS: usize = 48;
/// 一個金鑰群組最多授予幾處。/ Grants per key group.
pub const MAX_GRANTS: usize = 200;
/// 授予時最多指定幾個帳號名稱。/ Account names per grant.
pub const MAX_GRANT_ACCOUNTS: usize = 32;
/// 群組說明最長幾個字元。/ Longest group description, in characters.
pub const MAX_DESCRIPTION_CHARS: usize = 500;

#[derive(Debug, Clone, FromRow)]
pub struct TunnelGroup {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub description: String,
    /// JSON 字串陣列。/ JSON array of labels.
    pub labels: String,
    pub position: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct KeyGroup {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub description: String,
    /// JSON 字串陣列。/ JSON array of labels.
    pub labels: String,
    pub created_at: String,
}

/// 群組的說明與標籤（建立與修改共用）。/ A group's description and labels (create and update).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Meta {
    pub description: String,
    pub labels: Vec<String>,
}

/// `labels` 欄位 → 標籤；壞掉的 JSON 當成沒有。/ The `labels` column → labels (bad JSON = none).
pub fn parse_labels(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

fn labels_json(labels: &[String]) -> String {
    serde_json::to_string(labels).unwrap_or_else(|_| "[]".into())
}

/// 群組說明：去頭尾空白，最多 500 字；換行與 tab 可以，其他控制字元不行。/ A group description: trimmed, up to 500
/// characters; newlines and tabs are fine, other control characters are not.
pub fn normalize_description(raw: &str) -> Result<String, String> {
    let d = raw.trim().replace("\r\n", "\n");
    if d.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(format!("Use at most {MAX_DESCRIPTION_CHARS} characters."));
    }
    if d.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err("The description contains a control character.".into());
    }
    Ok(d)
}

/// 一筆授予，連同對象的名稱。/ One grant with the target's name.
#[derive(Debug, Clone, FromRow)]
pub struct Grant {
    pub id: i64,
    pub key_group_id: i64,
    pub tunnel_id: Option<i64>,
    pub tunnel_name: Option<String>,
    pub tunnel_group_id: Option<i64>,
    pub tunnel_group_name: Option<String>,
    /// 只裝到這些帳號名稱（JSON）；None = 每個允許的帳號。/ Account names (JSON); None = every allowed account.
    pub accounts: Option<String>,
    pub created_at: String,
}

impl Grant {
    pub fn account_names(&self) -> Option<Vec<String>> {
        parse_names(self.accounts.as_deref())
    }
}

/// `accounts` 欄位（JSON 字串陣列）→ 名稱；壞掉的 JSON 當成「全部」。/ The `accounts` column → names (bad JSON = all).
pub fn parse_names(json: Option<&str>) -> Option<Vec<String>> {
    serde_json::from_str(json?).ok()
}

/// 授予的對象。/ What a grant points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Tunnel(i64),
    TunnelGroup(i64),
}

/// 群組名稱：去頭尾空白、連續空白變一個；1–48 字、不能有控制字元。/ A group name: trimmed, inner whitespace
/// collapsed, 1–48 characters, no control characters.
pub fn normalize_name(raw: &str) -> Result<String, String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("Give the group a name.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("Use at most {MAX_NAME_CHARS} characters."));
    }
    if name.chars().any(char::is_control) {
        return Err("The name contains a control character.".into());
    }
    Ok(name)
}

/// 授予的帳號名稱：None = 全部；否則非空、去空白、去重複、排序。名稱只拿來和通道上的帳號名稱比對（不會進 shell），
/// 所以規則和通道帳號一樣寬：1–150 字、沒有控制字元。
/// A grant's account names: None = all; else non-empty, trimmed, de-duplicated, sorted. They are only compared with
/// a tunnel's account names (never reach a shell), so the rule is as loose as for those: 1–150 characters, no
/// control characters.
pub fn normalize_accounts(input: Option<&[String]>) -> Result<Option<Vec<String>>, String> {
    let Some(input) = input else { return Ok(None) };
    let mut out = BTreeSet::new();
    for raw in input {
        let n = raw.trim();
        let ok = !n.is_empty() && n.chars().count() <= 150 && !n.chars().any(char::is_control);
        if !ok {
            return Err(format!("\"{n}\" is not a valid account name."));
        }
        out.insert(n.to_string());
    }
    if out.is_empty() {
        return Err("Pick at least one account, or none for every account.".into());
    }
    if out.len() > MAX_GRANT_ACCOUNTS {
        return Err(format!("Pick at most {MAX_GRANT_ACCOUNTS} accounts."));
    }
    Ok(Some(out.into_iter().collect()))
}

fn names_json(accounts: Option<&[String]>) -> Option<String> {
    accounts.map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".into()))
}

// ---------------------------------------------------------------- tunnel groups

const TG_COLS: &str = "id, user_id, name, description, labels, position, created_at";

pub async fn tunnel_groups(db: &Db, user_id: i64) -> sqlx::Result<Vec<TunnelGroup>> {
    sqlx::query_as(&format!("SELECT {TG_COLS} FROM telepy_tunnel_group WHERE user_id = ? ORDER BY position, id")).bind(user_id).fetch_all(&db.read).await
}

pub async fn tunnel_group(db: &Db, user_id: i64, id: i64) -> sqlx::Result<Option<TunnelGroup>> {
    sqlx::query_as(&format!("SELECT {TG_COLS} FROM telepy_tunnel_group WHERE user_id = ? AND id = ?")).bind(user_id).bind(id).fetch_optional(&db.read).await
}

/// 同名（不分大小寫）的另一個群組。/ Another group with the same name, ignoring case.
async fn name_taken(db: &Db, table: &str, user_id: i64, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE user_id = ? AND lower(name) = lower(?) AND id != ?"))
        .bind(user_id)
        .bind(name)
        .bind(except.unwrap_or(-1))
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
}

pub async fn tunnel_group_name_taken(db: &Db, user_id: i64, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    name_taken(db, "telepy_tunnel_group", user_id, name, except).await
}

pub async fn key_group_name_taken(db: &Db, user_id: i64, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    name_taken(db, "telepy_key_group", user_id, name, except).await
}

/// 新群組排在最後。/ A new group goes last.
pub async fn create_tunnel_group(db: &Db, user_id: i64, name: &str, meta: &Meta) -> sqlx::Result<TunnelGroup> {
    let r = sqlx::query(
        "INSERT INTO telepy_tunnel_group (user_id, name, description, labels, position, created_at) \
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM telepy_tunnel_group WHERE user_id = ?), ?)",
    )
    .bind(user_id)
    .bind(name)
    .bind(&meta.description)
    .bind(labels_json(&meta.labels))
    .bind(user_id)
    .bind(now_db())
    .execute(&db.write)
    .await?;
    let id = r.last_insert_rowid();
    sqlx::query_as(&format!("SELECT {TG_COLS} FROM telepy_tunnel_group WHERE id = ?")).bind(id).fetch_one(&db.write).await
}

/// 改名稱、說明、標籤（三個一起寫；呼叫的人先把沒改的填成原本的值）。/ Write name, description and labels.
pub async fn update_tunnel_group(db: &Db, id: i64, name: &str, meta: &Meta) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_tunnel_group SET name = ?, description = ?, labels = ? WHERE id = ?")
        .bind(name)
        .bind(&meta.description)
        .bind(labels_json(&meta.labels))
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 依給的順序重排（沒列到的接在後面，保持原順序）。/ Reorder: listed ids first, the rest after in their old order.
pub async fn reorder_tunnel_groups(db: &Db, user_id: i64, ids: &[i64]) -> sqlx::Result<()> {
    let current = tunnel_groups(db, user_id).await?;
    let mut order: Vec<i64> = ids.iter().copied().filter(|id| current.iter().any(|g| g.id == *id)).collect();
    let mut seen: BTreeSet<i64> = BTreeSet::new();
    order.retain(|id| seen.insert(*id));
    order.extend(current.iter().map(|g| g.id).filter(|id| !seen.contains(id)));
    let mut tx = db.write.begin().await?;
    for (pos, id) in order.iter().enumerate() {
        sqlx::query("UPDATE telepy_tunnel_group SET position = ? WHERE id = ? AND user_id = ?").bind(pos as i64).bind(id).bind(user_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 刪掉通道群組：成員回到「未分組」，授予給它的也刪掉。回傳原本的成員（要重新同步金鑰）。
/// Delete a tunnel group: its tunnels become ungrouped and grants to it go. Returns the former members.
pub async fn delete_tunnel_group(db: &Db, user_id: i64, id: i64) -> sqlx::Result<Vec<i64>> {
    let members = tunnel_group_members(db, id).await?;
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM telepy_tunnel_group_member WHERE group_id = ? AND user_id = ?").bind(id).bind(user_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_key_group_grant WHERE tunnel_group_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_group WHERE id = ? AND user_id = ?").bind(id).bind(user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(members)
}

/// 這個人的分組：tunnel id → group id。/ This person's grouping: tunnel id → group id.
pub async fn tunnel_group_of(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, i64>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as("SELECT tunnel_id, group_id FROM telepy_tunnel_group_member WHERE user_id = ?").bind(user_id).fetch_all(&db.read).await?;
    Ok(rows.into_iter().collect())
}

pub async fn tunnel_group_members(db: &Db, group_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar("SELECT tunnel_id FROM telepy_tunnel_group_member WHERE group_id = ? ORDER BY tunnel_id").bind(group_id).fetch_all(&db.read).await
}

/// 把一條通道放進某組（None = 拿出來）。回傳它原本在哪一組。/ Put a tunnel in a group (None = ungroup); returns the old group.
pub async fn set_tunnel_group(db: &Db, user_id: i64, tunnel_id: i64, group_id: Option<i64>) -> sqlx::Result<Option<i64>> {
    let old: Option<i64> = sqlx::query_scalar("SELECT group_id FROM telepy_tunnel_group_member WHERE user_id = ? AND tunnel_id = ?")
        .bind(user_id)
        .bind(tunnel_id)
        .fetch_optional(&db.read)
        .await?;
    match group_id {
        Some(g) => {
            sqlx::query(
                "INSERT INTO telepy_tunnel_group_member (user_id, tunnel_id, group_id, created_at) VALUES (?, ?, ?, ?) \
                 ON CONFLICT (user_id, tunnel_id) DO UPDATE SET group_id = excluded.group_id, created_at = excluded.created_at",
            )
            .bind(user_id)
            .bind(tunnel_id)
            .bind(g)
            .bind(now_db())
            .execute(&db.write)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM telepy_tunnel_group_member WHERE user_id = ? AND tunnel_id = ?").bind(user_id).bind(tunnel_id).execute(&db.write).await?;
        }
    }
    Ok(old)
}

/// 整組成員換掉：給的通道移進這組（從別組移過來），原本在這組、這次沒給的回到未分組。回傳前後所有涉及的通道。
/// Replace a group's members: the given tunnels move in (out of any other group), former members not given become
/// ungrouped. Returns every tunnel involved (before ∪ after).
pub async fn replace_tunnel_group_members(db: &Db, user_id: i64, group_id: i64, tunnel_ids: &[i64]) -> sqlx::Result<BTreeSet<i64>> {
    let before = tunnel_group_members(db, group_id).await?;
    let now = now_db();
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM telepy_tunnel_group_member WHERE group_id = ? AND user_id = ?").bind(group_id).bind(user_id).execute(&mut *tx).await?;
    for t in tunnel_ids {
        sqlx::query(
            "INSERT INTO telepy_tunnel_group_member (user_id, tunnel_id, group_id, created_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT (user_id, tunnel_id) DO UPDATE SET group_id = excluded.group_id, created_at = excluded.created_at",
        )
        .bind(user_id)
        .bind(t)
        .bind(group_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(before.into_iter().chain(tunnel_ids.iter().copied()).collect())
}

// ---------------------------------------------------------------- key groups

const KG_COLS: &str = "id, user_id, name, description, labels, created_at";

/// 依名稱排（不分大小寫）。/ Ordered by name, ignoring case.
pub async fn key_groups(db: &Db, user_id: i64) -> sqlx::Result<Vec<KeyGroup>> {
    sqlx::query_as(&format!("SELECT {KG_COLS} FROM telepy_key_group WHERE user_id = ? ORDER BY lower(name), id")).bind(user_id).fetch_all(&db.read).await
}

pub async fn key_group(db: &Db, user_id: i64, id: i64) -> sqlx::Result<Option<KeyGroup>> {
    sqlx::query_as(&format!("SELECT {KG_COLS} FROM telepy_key_group WHERE user_id = ? AND id = ?")).bind(user_id).bind(id).fetch_optional(&db.read).await
}

pub async fn create_key_group(db: &Db, user_id: i64, name: &str, meta: &Meta) -> sqlx::Result<KeyGroup> {
    let r = sqlx::query("INSERT INTO telepy_key_group (user_id, name, description, labels, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(user_id)
        .bind(name)
        .bind(&meta.description)
        .bind(labels_json(&meta.labels))
        .bind(now_db())
        .execute(&db.write)
        .await?;
    sqlx::query_as(&format!("SELECT {KG_COLS} FROM telepy_key_group WHERE id = ?")).bind(r.last_insert_rowid()).fetch_one(&db.write).await
}

/// 改名稱、說明、標籤。/ Write name, description and labels.
pub async fn update_key_group(db: &Db, id: i64, name: &str, meta: &Meta) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_key_group SET name = ?, description = ?, labels = ? WHERE id = ?")
        .bind(name)
        .bind(&meta.description)
        .bind(labels_json(&meta.labels))
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 刪掉金鑰群組：金鑰留著（回到未分組），授予全部刪掉。呼叫前先用 [`key_group_reach`] 記下要同步的通道。
/// Delete a key group: the keys stay (ungrouped), its grants go. Take [`key_group_reach`] first to know what to sync.
pub async fn delete_key_group(db: &Db, user_id: i64, id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM telepy_key_group_member WHERE group_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_key_group_grant WHERE key_group_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_key_group WHERE id = ? AND user_id = ?").bind(id).bind(user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// 這個人的金鑰分組：key id → group id。/ This person's keys: key id → group id.
pub async fn key_group_of(db: &Db, user_id: i64) -> sqlx::Result<HashMap<i64, i64>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT m.user_key_id, m.group_id FROM telepy_key_group_member m JOIN telepy_key_group g ON g.id = m.group_id WHERE g.user_id = ?",
    )
    .bind(user_id)
    .fetch_all(&db.read)
    .await?;
    Ok(rows.into_iter().collect())
}

pub async fn key_group_of_key(db: &Db, user_key_id: i64) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT group_id FROM telepy_key_group_member WHERE user_key_id = ?").bind(user_key_id).fetch_optional(&db.read).await
}

pub async fn key_group_members(db: &Db, group_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar("SELECT user_key_id FROM telepy_key_group_member WHERE group_id = ? ORDER BY user_key_id").bind(group_id).fetch_all(&db.read).await
}

/// 把一把金鑰放進某組（None = 拿出來）。回傳原本的組。/ Put a key in a group (None = ungroup); returns the old group.
pub async fn set_key_group(db: &Db, user_key_id: i64, group_id: Option<i64>) -> sqlx::Result<Option<i64>> {
    let old = key_group_of_key(db, user_key_id).await?;
    match group_id {
        Some(g) => {
            sqlx::query(
                "INSERT INTO telepy_key_group_member (user_key_id, group_id, created_at) VALUES (?, ?, ?) \
                 ON CONFLICT (user_key_id) DO UPDATE SET group_id = excluded.group_id, created_at = excluded.created_at",
            )
            .bind(user_key_id)
            .bind(g)
            .bind(now_db())
            .execute(&db.write)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM telepy_key_group_member WHERE user_key_id = ?").bind(user_key_id).execute(&db.write).await?;
        }
    }
    Ok(old)
}

/// 整組成員換掉（同 [`replace_tunnel_group_members`]）。回傳被移出別組的金鑰原本所在的組（那些組的裝置也要同步）。
/// Replace a key group's members. Returns the groups keys were taken out of (their devices need a sync too).
pub async fn replace_key_group_members(db: &Db, group_id: i64, key_ids: &[i64]) -> sqlx::Result<BTreeSet<i64>> {
    let mut others = BTreeSet::new();
    for k in key_ids {
        if let Some(g) = key_group_of_key(db, *k).await? {
            if g != group_id {
                others.insert(g);
            }
        }
    }
    let now = now_db();
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM telepy_key_group_member WHERE group_id = ?").bind(group_id).execute(&mut *tx).await?;
    for k in key_ids {
        sqlx::query(
            "INSERT INTO telepy_key_group_member (user_key_id, group_id, created_at) VALUES (?, ?, ?) \
             ON CONFLICT (user_key_id) DO UPDATE SET group_id = excluded.group_id, created_at = excluded.created_at",
        )
        .bind(k)
        .bind(group_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(others)
}

/// 金鑰被刪除：從群組拿掉。/ A deleted key leaves its group.
pub async fn forget_key(db: &Db, user_key_id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_key_group_member WHERE user_key_id = ?").bind(user_key_id).execute(&db.write).await?;
    Ok(())
}

// ---------------------------------------------------------------- grants

const GRANT_SELECT: &str = "SELECT gr.id, gr.key_group_id, gr.tunnel_id, t.host_friendly_name AS tunnel_name, gr.tunnel_group_id, tg.name AS tunnel_group_name, \
     gr.accounts, gr.created_at FROM telepy_key_group_grant gr \
     LEFT JOIN authorized_keys_reverseserverauthorizedkeys t ON t.id = gr.tunnel_id \
     LEFT JOIN telepy_tunnel_group tg ON tg.id = gr.tunnel_group_id";

/// 這個人所有金鑰群組的授予。/ Every grant of this person's key groups.
pub async fn grants_of_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<Grant>> {
    sqlx::query_as(&format!("{GRANT_SELECT} WHERE gr.key_group_id IN (SELECT id FROM telepy_key_group WHERE user_id = ?) ORDER BY gr.id"))
        .bind(user_id)
        .fetch_all(&db.read)
        .await
}

pub async fn grant(db: &Db, key_group_id: i64, id: i64) -> sqlx::Result<Option<Grant>> {
    sqlx::query_as(&format!("{GRANT_SELECT} WHERE gr.key_group_id = ? AND gr.id = ?")).bind(key_group_id).bind(id).fetch_optional(&db.read).await
}

pub async fn grant_count(db: &Db, key_group_id: i64) -> sqlx::Result<usize> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_key_group_grant WHERE key_group_id = ?").bind(key_group_id).fetch_one(&db.read).await?;
    Ok(n as usize)
}

/// 授予（已有同一個對象就改帳號）。回傳授予的 id。/ Grant (or update the accounts of the existing grant to the same target).
pub async fn upsert_grant(db: &Db, key_group_id: i64, target: Target, accounts: Option<&[String]>) -> sqlx::Result<i64> {
    let (tunnel, tunnel_group) = match target {
        Target::Tunnel(t) => (Some(t), None),
        Target::TunnelGroup(g) => (None, Some(g)),
    };
    let existing: Option<i64> = sqlx::query_scalar("SELECT id FROM telepy_key_group_grant WHERE key_group_id = ? AND tunnel_id IS ? AND tunnel_group_id IS ?")
        .bind(key_group_id)
        .bind(tunnel)
        .bind(tunnel_group)
        .fetch_optional(&db.read)
        .await?;
    if let Some(id) = existing {
        sqlx::query("UPDATE telepy_key_group_grant SET accounts = ? WHERE id = ?").bind(names_json(accounts)).bind(id).execute(&db.write).await?;
        return Ok(id);
    }
    let r = sqlx::query("INSERT INTO telepy_key_group_grant (key_group_id, tunnel_id, tunnel_group_id, accounts, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(key_group_id)
        .bind(tunnel)
        .bind(tunnel_group)
        .bind(names_json(accounts))
        .bind(now_db())
        .execute(&db.write)
        .await?;
    Ok(r.last_insert_rowid())
}

pub async fn set_grant_accounts(db: &Db, id: i64, accounts: Option<&[String]>) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_key_group_grant SET accounts = ? WHERE id = ?").bind(names_json(accounts)).bind(id).execute(&db.write).await?;
    Ok(())
}

pub async fn delete_grant(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_key_group_grant WHERE id = ?").bind(id).execute(&db.write).await?;
    Ok(())
}

/// 一筆授予碰到的通道。/ Tunnels a grant reaches.
pub async fn grant_reach(db: &Db, g: &Grant) -> sqlx::Result<Vec<i64>> {
    match (g.tunnel_id, g.tunnel_group_id) {
        (Some(t), _) => Ok(vec![t]),
        (None, Some(tg)) => tunnel_group_members(db, tg).await,
        (None, None) => Ok(vec![]),
    }
}

/// 一個金鑰群組（經授予）碰到的所有通道。/ Every tunnel a key group reaches through its grants.
pub async fn key_group_reach(db: &Db, key_group_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(
        "SELECT tunnel_id FROM telepy_key_group_grant WHERE key_group_id = ?1 AND tunnel_id IS NOT NULL \
         UNION SELECT m.tunnel_id FROM telepy_key_group_grant gr JOIN telepy_tunnel_group_member m ON m.group_id = gr.tunnel_group_id \
         WHERE gr.key_group_id = ?1",
    )
    .bind(key_group_id)
    .fetch_all(&db.read)
    .await
}

/// 失去一條通道的存取（取消分享 / 離開 / 到期）：他的分組與他的金鑰群組對這條通道的授予都拿掉。
/// Lost access to a tunnel: drop it from their tunnel group and drop their key groups' grants to it.
pub async fn forget_tunnel_for_user(db: &Db, user_id: i64, tunnel_id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM telepy_tunnel_group_member WHERE user_id = ? AND tunnel_id = ?").bind(user_id).bind(tunnel_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_key_group_grant WHERE tunnel_id = ? AND key_group_id IN (SELECT id FROM telepy_key_group WHERE user_id = ?)")
        .bind(tunnel_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_trimmed_and_checked() {
        assert_eq!(normalize_name("  Prod   web ").unwrap(), "Prod web");
        assert_eq!(normalize_name("家裡的機器").unwrap(), "家裡的機器");
        assert!(normalize_name("   ").is_err());
        assert!(normalize_name(&"x".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert!(normalize_name(&"字".repeat(MAX_NAME_CHARS)).is_ok());
        assert!(normalize_name("a\u{7}b").is_err());
    }

    #[test]
    fn grant_accounts_are_normalised() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(normalize_accounts(None).unwrap(), None);
        assert_eq!(normalize_accounts(Some(&s(&[" deploy", "ubuntu", "deploy"]))).unwrap(), Some(s(&["deploy", "ubuntu"])));
        assert!(normalize_accounts(Some(&[])).is_err());
        assert!(normalize_accounts(Some(&s(&["  "]))).is_err());
        assert!(normalize_accounts(Some(&s(&["a\nb"]))).is_err());
        let many: Vec<String> = (0..=MAX_GRANT_ACCOUNTS).map(|i| format!("u{i}")).collect();
        assert!(normalize_accounts(Some(&many)).is_err());
    }

    #[test]
    fn descriptions_are_trimmed_and_checked() {
        assert_eq!(normalize_description("  web servers\r\nin Tokyo  ").unwrap(), "web servers\nin Tokyo");
        assert_eq!(normalize_description("").unwrap(), "");
        assert!(normalize_description("tab\there").is_ok());
        assert!(normalize_description("bell\u{7}").is_err());
        assert!(normalize_description(&"字".repeat(MAX_DESCRIPTION_CHARS)).is_ok());
        assert!(normalize_description(&"x".repeat(MAX_DESCRIPTION_CHARS + 1)).is_err());
    }

    #[test]
    fn bad_label_json_counts_as_none() {
        assert_eq!(parse_labels("nope"), Vec::<String>::new());
        assert_eq!(parse_labels(r#"["env=prod","web"]"#), vec!["env=prod".to_string(), "web".to_string()]);
    }

    #[test]
    fn bad_account_json_counts_as_all() {
        assert_eq!(parse_names(Some("not json")), None);
        assert_eq!(parse_names(None), None);
        assert_eq!(parse_names(Some(r#"["a","b"]"#)), Some(vec!["a".to_string(), "b".to_string()]));
    }
}
