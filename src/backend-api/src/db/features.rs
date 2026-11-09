//! 角色、群組、成員、各功能的允許 / 拒絕（`crate::features` 解析）。同一張表放三種，靠 `owner_id` + `purpose` 分開：
//! - **角色**（`owner_id` NULL、`purpose = 'role'`）：管理員 / 單一登入 / SCIM 管，只決定功能權限，永遠不能拿來分享通道。
//! - **管理員維護的群組**（`owner_id` NULL、`purpose = 'group'`）：管理員 / 單一登入 / SCIM 管，只用來分享通道。
//! - **個人群組**（`owner_id` = 建立的人、`purpose = 'group'`）：某人自己建、只有他看得到，只用來分享通道。
//! 功能權限只看角色；分享只看群組。下面的函式名稱就說明它們看哪一種，呼叫的地方不必自己再過濾。
//! Roles, groups, members and per-feature allow / deny rows (resolved by `crate::features`). One table holds three
//! kinds, told apart by `owner_id` + `purpose`:
//! - **roles** (`owner_id` NULL, `purpose = 'role'`): kept by admins / single sign-on / SCIM; feature permissions only,
//!   never shared with;
//! - **admin-kept groups** (`owner_id` NULL, `purpose = 'group'`): kept by admins / single sign-on / SCIM; sharing only;
//! - **personal groups** (`owner_id` = their maker, `purpose = 'group'`): made by one person, seen only by them; sharing
//!   only.
//! Feature permissions read roles only; sharing reads groups only. Each function's name says which kind it reads, so
//! callers never have to filter again.

use super::Db;

const GROUP: &str = "telepy_user_group";
const MEMBER: &str = "telepy_user_group_member";
const GRANT: &str = "telepy_feature_grant";
const COLS: &str = "id, name, description, created_at, owner_id, display_name, purpose";
/// 角色（功能權限）。/ Roles (feature permissions).
pub const ROLE: &str = "owner_id IS NULL AND purpose = 'role'";
/// 管理員維護的群組（分享）。/ Admin-kept groups (sharing).
pub const ADMIN_KEPT: &str = "owner_id IS NULL AND purpose = 'group'";
/// 分享用的群組（管理員維護的或個人的）。/ Groups used for sharing (admin-kept or personal).
pub const SHARING: &str = "purpose = 'group'";
/// SQL 裡群組給人看的名稱（`g` = 群組表）。/ A group's shown name in SQL (`g` = the group table).
pub const LABEL: &str = "COALESCE(g.display_name, g.name)";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Group {
    pub id: i64,
    /// 角色的名稱；群組（管理員維護的或個人的）這裡是佔位，名稱在 `display_name`（用 `label()`）。/ Use `label()`.
    pub name: String,
    pub description: String,
    pub created_at: String,
    /// NULL = 角色或管理員維護的群組；否則 = 建立這個個人群組的人。/ NULL = a role or an admin-kept group; else the personal group's owner.
    pub owner_id: Option<i64>,
    pub display_name: Option<String>,
    /// role | group
    pub purpose: String,
}

impl Group {
    /// 給人看的名稱（佔位永遠不給人看）。/ The name people see (a placeholder is never shown).
    pub fn label(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.name)
    }

    /// 角色：只決定功能權限。/ A role: feature permissions only.
    pub fn is_role(&self) -> bool {
        self.owner_id.is_none() && self.purpose == "role"
    }

    /// 管理員維護的群組：只用來分享。/ An admin-kept group: sharing only.
    pub fn is_admin_kept(&self) -> bool {
        self.owner_id.is_none() && self.purpose == "group"
    }

    pub fn is_personal(&self) -> bool {
        self.owner_id.is_some() && self.purpose == "group"
    }

    /// 這個人能不能拿它來分享通道：自己的個人群組、任何管理員維護的群組；角色永遠不行。
    /// Whether this person may share tunnels with it: their own personal group or any admin-kept group; never a role.
    pub fn shareable_by(&self, user_id: i64) -> bool {
        if self.is_personal() {
            self.owner_id == Some(user_id)
        } else {
            self.is_admin_kept()
        }
    }

    /// 分享 JSON 裡的種類：`org` = 管理員維護的群組（沿用舊的值）、`personal`；角色是 `role`（不會出現在分享 JSON）。
    /// The kind in sharing JSON: `org` = an admin-kept group (the wire value is kept), `personal`; a role is `role`
    /// (which never appears in sharing JSON).
    pub fn kind(&self) -> &'static str {
        if self.is_personal() {
            "personal"
        } else if self.is_admin_kept() {
            "org"
        } else {
            "role"
        }
    }
}

/// 一列允許 / 拒絕：`subject_kind` = user | group | everyone（everyone 的 subject_id = 0）。
/// One allow / deny row; `subject_kind` = user | group | everyone (subject_id 0 for everyone).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GrantRow {
    pub subject_kind: String,
    pub subject_id: i64,
    pub feature: String,
    pub allowed: bool,
}

/// 所有角色。/ Every role.
pub async fn groups(db: &Db) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE {ROLE} ORDER BY name COLLATE NOCASE, id")).fetch_all(&db.read).await
}

/// 一個角色（群組 = None：角色的路徑碰不到它）。/ One role (a group of either kind is None).
pub async fn group(db: &Db, id: i64) -> sqlx::Result<Option<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE id = ? AND {ROLE}")).bind(id).fetch_optional(&db.read).await
}

/// 所有管理員維護的群組。/ Every admin-kept group.
pub async fn share_groups(db: &Db) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE {ADMIN_KEPT} ORDER BY display_name COLLATE NOCASE, id")).fetch_all(&db.read).await
}

/// 一個管理員維護的群組（角色、個人群組 = None）。/ One admin-kept group (a role or a personal group is None).
pub async fn share_group(db: &Db, id: i64) -> sqlx::Result<Option<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE id = ? AND {ADMIN_KEPT}")).bind(id).fetch_optional(&db.read).await
}

/// 分享用的一個群組（管理員維護的或個人的；角色 = None）。呼叫的地方還要看 `shareable_by`。
/// One group used for sharing (admin-kept or personal; a role is None). Callers still check `shareable_by`.
pub async fn sharing_group(db: &Db, id: i64) -> sqlx::Result<Option<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE id = ? AND {SHARING}")).bind(id).fetch_optional(&db.read).await
}

/// 每一列（三種都有；呼叫的地方自己看 `is_role()` 等）。/ Every row of all three kinds (callers check `is_role()` etc.).
pub async fn all_groups(db: &Db) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} ORDER BY id")).fetch_all(&db.read).await
}

/// 單一登入規則能指向的：角色與管理員維護的群組（永遠不含個人群組）。/ What a sign-in rule may target: roles and
/// admin-kept groups (never a personal group).
pub async fn sso_targets(db: &Db) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE owner_id IS NULL AND purpose IN ('role', 'group') ORDER BY id")).fetch_all(&db.read).await
}

/// 名稱是否已被別的角色用了（不分大小寫）。/ Whether another role has this name (case-insensitive).
pub async fn name_taken(db: &Db, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(&format!("SELECT id FROM {GROUP} WHERE lower(name) = lower(?) AND id != ? AND {ROLE} LIMIT 1"))
        .bind(name)
        .bind(except.unwrap_or(0))
        .fetch_optional(&db.read)
        .await?;
    Ok(row.is_some())
}

/// 名稱是否已被別的管理員維護的群組用了（不分大小寫；跟角色、個人群組各算各的）。
/// Whether another admin-kept group has this name (case-insensitive; roles and personal groups are separate namespaces).
pub async fn share_group_name_taken(db: &Db, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(&format!("SELECT id FROM {GROUP} WHERE lower(display_name) = lower(?) AND id != ? AND {ADMIN_KEPT} LIMIT 1"))
        .bind(name)
        .bind(except.unwrap_or(0))
        .fetch_optional(&db.read)
        .await?;
    Ok(row.is_some())
}

/// 建一個角色。/ Creates a role.
pub async fn create_group(db: &Db, name: &str, description: &str) -> sqlx::Result<i64> {
    let res = sqlx::query(&format!("INSERT INTO {GROUP} (name, description, created_at, purpose) VALUES (?, ?, ?, 'role')"))
        .bind(name)
        .bind(description)
        .bind(crate::util::now_db())
        .execute(&db.write)
        .await?;
    Ok(res.last_insert_rowid())
}

/// 改角色（只動角色的列）。/ Changes a role (only ever a role's row).
pub async fn update_group(db: &Db, id: i64, name: Option<&str>, description: Option<&str>) -> sqlx::Result<()> {
    if let Some(n) = name {
        sqlx::query(&format!("UPDATE {GROUP} SET name = ? WHERE id = ? AND {ROLE}")).bind(n).bind(id).execute(&db.write).await?;
    }
    if let Some(d) = description {
        sqlx::query(&format!("UPDATE {GROUP} SET description = ? WHERE id = ? AND {ROLE}")).bind(d).bind(id).execute(&db.write).await?;
    }
    Ok(())
}

/// `name` 欄整張表 UNIQUE：群組（管理員維護的、個人的）放一個不會撞到的佔位（角色名稱最多 64 字，這個帶 32 個
/// 隨機英數字），名稱在 `display_name`。/ The table-wide UNIQUE `name` of a group (admin-kept or personal) holds a
/// placeholder that never collides (32 random letters and digits); the shown name lives in `display_name`.
pub fn placeholder(prefix: &str) -> String {
    format!("{prefix}:{}", crate::util::random_alnum(32))
}

/// 建一個管理員維護的群組。/ Creates an admin-kept group.
pub async fn create_share_group(db: &Db, name: &str, description: &str) -> sqlx::Result<i64> {
    // `shareable` = 1 只是給退回舊版用（新程式不讀）。/ `shareable` = 1 only helps a rollback (nothing reads it now).
    let res = sqlx::query(&format!("INSERT INTO {GROUP} (name, description, created_at, display_name, purpose, shareable) VALUES (?, ?, ?, ?, 'group', 1)"))
        .bind(placeholder("group"))
        .bind(description)
        .bind(crate::util::now_db())
        .bind(name)
        .execute(&db.write)
        .await?;
    Ok(res.last_insert_rowid())
}

/// 改管理員維護的群組（只動那種列）。/ Changes an admin-kept group (only ever such a row).
pub async fn update_share_group(db: &Db, id: i64, name: Option<&str>, description: Option<&str>) -> sqlx::Result<()> {
    if let Some(n) = name {
        sqlx::query(&format!("UPDATE {GROUP} SET display_name = ? WHERE id = ? AND {ADMIN_KEPT}")).bind(n).bind(id).execute(&db.write).await?;
    }
    if let Some(d) = description {
        sqlx::query(&format!("UPDATE {GROUP} SET description = ? WHERE id = ? AND {ADMIN_KEPT}")).bind(d).bind(id).execute(&db.write).await?;
    }
    Ok(())
}

/// 某人的個人群組。/ Someone's personal groups.
pub async fn personal_groups(db: &Db, owner: i64) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE owner_id = ? AND {SHARING} ORDER BY display_name COLLATE NOCASE, id")).bind(owner).fetch_all(&db.read).await
}

/// 某人的一個個人群組（別人的 = None）。/ One of someone's personal groups (another person's = None).
pub async fn personal_group(db: &Db, owner: i64, id: i64) -> sqlx::Result<Option<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE id = ? AND owner_id = ? AND {SHARING}")).bind(id).bind(owner).fetch_optional(&db.read).await
}

/// 這個人的個人群組裡有沒有同名的（不分大小寫）。/ Whether this person already has a personal group of this name.
pub async fn personal_name_taken(db: &Db, owner: i64, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(&format!("SELECT id FROM {GROUP} WHERE owner_id = ? AND lower(display_name) = lower(?) AND id != ? LIMIT 1"))
        .bind(owner)
        .bind(name)
        .bind(except.unwrap_or(0))
        .fetch_optional(&db.read)
        .await?;
    Ok(row.is_some())
}

/// 建一個個人群組。`name` 欄整張表 UNIQUE，放一個不會跟任何名稱撞到的佔位（組織群組的名稱最多 64 字、
/// 這個帶 32 個隨機英數字）；給人看的名稱在 `display_name`。
/// Creates a personal group. The table-wide UNIQUE `name` gets a placeholder that never collides (32 random
/// letters and digits); the shown name lives in `display_name`.
pub async fn create_personal(db: &Db, owner: i64, name: &str, description: &str) -> sqlx::Result<i64> {
    let res = sqlx::query(&format!("INSERT INTO {GROUP} (name, description, created_at, owner_id, display_name, purpose) VALUES (?, ?, ?, ?, ?, 'group')"))
        .bind(placeholder(&format!("personal:{owner}")))
        .bind(description)
        .bind(crate::util::now_db())
        .bind(owner)
        .bind(name)
        .execute(&db.write)
        .await?;
    Ok(res.last_insert_rowid())
}

pub async fn update_personal(db: &Db, id: i64, name: Option<&str>, description: Option<&str>) -> sqlx::Result<()> {
    if let Some(n) = name {
        sqlx::query(&format!("UPDATE {GROUP} SET display_name = ? WHERE id = ? AND owner_id IS NOT NULL")).bind(n).bind(id).execute(&db.write).await?;
    }
    if let Some(d) = description {
        sqlx::query(&format!("UPDATE {GROUP} SET description = ? WHERE id = ? AND owner_id IS NOT NULL")).bind(d).bind(id).execute(&db.write).await?;
    }
    Ok(())
}

/// 刪一列（任何一種）連同成員、允許 / 拒絕與分享給它的群組分享；呼叫的地方先確認種類。
/// Deletes a row (any kind) with its members, grants and group shares; callers check the kind first.
pub async fn delete_group(db: &Db, id: i64) -> sqlx::Result<bool> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {MEMBER} WHERE group_id = ?")).bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {GRANT} WHERE subject_kind = 'group' AND subject_id = ?")).bind(id).execute(&mut *tx).await?;
    // 分享給這個群組的通道也收回（成員那幾筆分享由 `group_shares::reconcile` 收掉）。/ Its tunnel shares go too.
    sqlx::query("DELETE FROM telepy_group_share_username WHERE group_share_id IN (SELECT id FROM telepy_group_share WHERE group_id = ?)").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_group_share WHERE group_id = ?").bind(id).execute(&mut *tx).await?;
    let res = sqlx::query(&format!("DELETE FROM {GROUP} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(res.rows_affected() > 0)
}

/// 群組的成員 id。/ A group's member ids.
pub async fn members_of(db: &Db, group_id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(&format!("SELECT user_id FROM {MEMBER} WHERE group_id = ? ORDER BY user_id")).bind(group_id).fetch_all(&db.read).await
}

/// 角色的 (group_id, user_id) 全部（功能權限、管理頁）。群組的成員資格永遠不在這裡。
/// Every role membership (feature permissions, the admin page). Group memberships are never here.
pub async fn memberships(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT m.group_id, m.user_id FROM {MEMBER} m JOIN {GROUP} g ON g.id = m.group_id WHERE g.owner_id IS NULL AND g.purpose = 'role' ORDER BY m.group_id, m.user_id"))
        .fetch_all(&db.read)
        .await
}

/// 每一列的成員資格（分享的比對自己用 `is_role()` 跳過角色）。/ Memberships of every row (the share reconcile skips roles itself).
pub async fn all_memberships(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT group_id, user_id FROM {MEMBER} ORDER BY group_id, user_id")).fetch_all(&db.read).await
}

/// 這個人有哪些角色。/ The roles this person has.
pub async fn groups_of(db: &Db, user_id: i64) -> sqlx::Result<std::collections::BTreeSet<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar(&format!("SELECT m.group_id FROM {MEMBER} m JOIN {GROUP} g ON g.id = m.group_id WHERE m.user_id = ? AND g.owner_id IS NULL AND g.purpose = 'role'"))
        .bind(user_id)
        .fetch_all(&db.read)
        .await?;
    Ok(ids.into_iter().collect())
}

/// 這個人所在、單一登入規則能指向的列（角色 + 管理員維護的群組）。/ The rows a sign-in rule may target that this person
/// is in (roles + admin-kept groups).
pub async fn sso_groups_of(db: &Db, user_id: i64) -> sqlx::Result<std::collections::BTreeSet<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar(&format!("SELECT m.group_id FROM {MEMBER} m JOIN {GROUP} g ON g.id = m.group_id WHERE m.user_id = ? AND g.owner_id IS NULL AND g.purpose IN ('role', 'group')"))
        .bind(user_id)
        .fetch_all(&db.read)
        .await?;
    Ok(ids.into_iter().collect())
}

/// 加進一個群組（已經在就不動）。/ Add to a group (no-op when already in).
pub async fn add_member(db: &Db, group_id: i64, user_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("INSERT OR IGNORE INTO {MEMBER} (group_id, user_id) VALUES (?, ?)")).bind(group_id).bind(user_id).execute(&db.write).await?;
    Ok(())
}

pub async fn remove_member(db: &Db, group_id: i64, user_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {MEMBER} WHERE group_id = ? AND user_id = ?")).bind(group_id).bind(user_id).execute(&db.write).await?;
    Ok(())
}

/// 換掉群組的成員名單。/ Replaces a group's member list.
pub async fn set_members(db: &Db, group_id: i64, users: &[i64]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {MEMBER} WHERE group_id = ?")).bind(group_id).execute(&mut *tx).await?;
    for uid in users {
        sqlx::query(&format!("INSERT OR IGNORE INTO {MEMBER} (group_id, user_id) VALUES (?, ?)")).bind(group_id).bind(uid).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 一個交易裡套用成員的增減（已在 / 不在的忽略），回傳 (真的加進的, 真的拿掉的)；兩個管理員同時改不會互相覆蓋。
/// Applies a member delta in one transaction (already in / not in is ignored); returns (really added, really removed),
/// so two concurrent edits never overwrite each other like a whole-list replace would.
pub async fn apply_delta(db: &Db, group_id: i64, add: &[i64], remove: &[i64]) -> sqlx::Result<(Vec<i64>, Vec<i64>)> {
    let mut tx = db.write.begin().await?;
    let (mut added, mut removed) = (Vec::new(), Vec::new());
    for uid in remove {
        if sqlx::query(&format!("DELETE FROM {MEMBER} WHERE group_id = ? AND user_id = ?")).bind(group_id).bind(uid).execute(&mut *tx).await?.rows_affected() > 0 {
            removed.push(*uid);
        }
    }
    for uid in add {
        if sqlx::query(&format!("INSERT OR IGNORE INTO {MEMBER} (group_id, user_id) VALUES (?, ?)")).bind(group_id).bind(uid).execute(&mut *tx).await?.rows_affected() > 0 {
            added.push(*uid);
        }
    }
    tx.commit().await?;
    Ok((added, removed))
}

/// 所有允許 / 拒絕。`group` 那幾列只算指向角色的（保險：群組永遠不決定功能）。
/// Every allow / deny row. `group` rows count only when they point at a role (defence in depth: groups never decide features).
pub async fn grants(db: &Db) -> sqlx::Result<Vec<GrantRow>> {
    sqlx::query_as(&format!(
        "SELECT subject_kind, subject_id, feature, allowed FROM {GRANT} \
         WHERE subject_kind != 'group' OR subject_id IN (SELECT id FROM {GROUP} WHERE {ROLE})"
    ))
    .fetch_all(&db.read)
    .await
}

/// `allowed` = None 刪掉那一列（回到「沿用」）。/ `allowed` = None removes the row (back to "inherit").
pub async fn set_grant(db: &Db, subject_kind: &str, subject_id: i64, feature: &str, allowed: Option<bool>) -> sqlx::Result<()> {
    match allowed {
        None => {
            sqlx::query(&format!("DELETE FROM {GRANT} WHERE subject_kind = ? AND subject_id = ? AND feature = ?"))
                .bind(subject_kind)
                .bind(subject_id)
                .bind(feature)
                .execute(&db.write)
                .await?;
        }
        Some(a) => {
            sqlx::query(&format!(
                "INSERT INTO {GRANT} (subject_kind, subject_id, feature, allowed, updated_at) VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT (subject_kind, subject_id, feature) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at"
            ))
            .bind(subject_kind)
            .bind(subject_id)
            .bind(feature)
            .bind(a)
            .bind(crate::util::now_db())
            .execute(&db.write)
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Group;

    fn g(owner: Option<i64>, purpose: &str) -> Group {
        Group { id: 1, name: "x".into(), description: String::new(), created_at: String::new(), owner_id: owner, display_name: None, purpose: purpose.into() }
    }

    /// 角色永遠不能拿來分享；管理員維護的群組誰都能選；個人群組只有主人能選。
    /// A role is never shareable; an admin-kept group is for anyone; a personal group only for its owner.
    #[test]
    fn only_groups_are_shareable_and_roles_never() {
        let role = g(None, "role");
        let kept = g(None, "group");
        let mine = g(Some(7), "group");
        assert!(role.is_role() && !role.is_admin_kept() && !role.is_personal());
        assert!(!role.shareable_by(7) && !role.shareable_by(1));
        assert_eq!(role.kind(), "role");
        assert!(kept.is_admin_kept() && kept.shareable_by(7) && kept.shareable_by(1));
        assert_eq!(kept.kind(), "org");
        assert!(mine.is_personal() && mine.shareable_by(7) && !mine.shareable_by(1));
        assert_eq!(mine.kind(), "personal");
        // 一列說自己是角色卻有主人：哪一種都不是，也不能分享。/ An owned row claiming to be a role is neither, and not shareable.
        let odd = g(Some(7), "role");
        assert!(!odd.is_role() && !odd.is_personal() && !odd.shareable_by(7));
    }
}
