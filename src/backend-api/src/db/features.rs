//! 群組（組織群組與個人群組）、成員、各功能的允許 / 拒絕（`crate::features` 解析）。
//! 組織群組（`owner_id` NULL）由管理員、單一登入或 SCIM 管，用在功能權限，打開「可以被分享」後也能拿來分享通道；
//! 個人群組是某個人自己建的，只有他看得到，只用來分享通道 —— 功能權限永遠不看它。
//! Groups (organization and personal), members and per-feature allow / deny rows (resolved by `crate::features`).
//! Organization groups (`owner_id` NULL) are kept by admins, single sign-on or SCIM, drive feature permissions and,
//! once "can be shared" is on, may be shared tunnels with; personal groups are made by one person, seen only by them
//! and used only for sharing tunnels — feature permissions never read them.

use super::Db;

const GROUP: &str = "telepy_user_group";
const MEMBER: &str = "telepy_user_group_member";
const GRANT: &str = "telepy_feature_grant";
const COLS: &str = "id, name, description, created_at, owner_id, display_name, shareable";
/// 組織群組。/ Organization groups only.
const ORG: &str = "owner_id IS NULL";
/// SQL 裡群組給人看的名稱（`g` = 群組表）。/ A group's shown name in SQL (`g` = the group table).
pub const LABEL: &str = "COALESCE(g.display_name, g.name)";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Group {
    pub id: i64,
    /// 組織群組的名稱；個人群組這裡是佔位，名稱在 `display_name`（用 `label()`）。/ Use `label()`.
    pub name: String,
    pub description: String,
    pub created_at: String,
    /// NULL = 組織群組；否則 = 建立這個個人群組的人。/ NULL = organization group; else the personal group's owner.
    pub owner_id: Option<i64>,
    pub display_name: Option<String>,
    pub shareable: bool,
}

impl Group {
    /// 給人看的名稱。/ The name people see.
    pub fn label(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.name)
    }

    pub fn is_personal(&self) -> bool {
        self.owner_id.is_some()
    }

    /// 這個人能不能拿它來分享通道：自己的個人群組，或打開分享的組織群組。
    /// Whether this person may share tunnels with it: their own personal group, or an organization group open to sharing.
    pub fn shareable_by(&self, user_id: i64) -> bool {
        match self.owner_id {
            Some(owner) => owner == user_id,
            None => self.shareable,
        }
    }

    pub fn kind(&self) -> &'static str {
        if self.is_personal() {
            "personal"
        } else {
            "org"
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

/// 所有組織群組。/ Every organization group.
pub async fn groups(db: &Db) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE {ORG} ORDER BY name COLLATE NOCASE, id")).fetch_all(&db.read).await
}

/// 一個組織群組（個人群組 = None：管理員的路徑碰不到它）。/ One organization group (a personal one is None).
pub async fn group(db: &Db, id: i64) -> sqlx::Result<Option<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE id = ? AND {ORG}")).bind(id).fetch_optional(&db.read).await
}

/// 任何一種群組（分享用）。/ A group of either kind (for sharing).
pub async fn any_group(db: &Db, id: i64) -> sqlx::Result<Option<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 每個群組（兩種）。/ Every group of both kinds.
pub async fn all_groups(db: &Db) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} ORDER BY id")).fetch_all(&db.read).await
}

/// 名稱是否已被別的組織群組用了（不分大小寫）。/ Whether another organization group has this name (case-insensitive).
pub async fn name_taken(db: &Db, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(&format!("SELECT id FROM {GROUP} WHERE lower(name) = lower(?) AND id != ? AND {ORG} LIMIT 1"))
        .bind(name)
        .bind(except.unwrap_or(0))
        .fetch_optional(&db.read)
        .await?;
    Ok(row.is_some())
}

pub async fn create_group(db: &Db, name: &str, description: &str) -> sqlx::Result<i64> {
    let res = sqlx::query(&format!("INSERT INTO {GROUP} (name, description, created_at) VALUES (?, ?, ?)"))
        .bind(name)
        .bind(description)
        .bind(crate::util::now_db())
        .execute(&db.write)
        .await?;
    Ok(res.last_insert_rowid())
}

pub async fn update_group(db: &Db, id: i64, name: Option<&str>, description: Option<&str>) -> sqlx::Result<()> {
    if let Some(n) = name {
        sqlx::query(&format!("UPDATE {GROUP} SET name = ? WHERE id = ?")).bind(n).bind(id).execute(&db.write).await?;
    }
    if let Some(d) = description {
        sqlx::query(&format!("UPDATE {GROUP} SET description = ? WHERE id = ?")).bind(d).bind(id).execute(&db.write).await?;
    }
    Ok(())
}

/// 組織群組能不能被分享。/ Whether an organization group may be shared with.
pub async fn set_shareable(db: &Db, id: i64, shareable: bool) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {GROUP} SET shareable = ? WHERE id = ? AND {ORG}")).bind(shareable).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 某人的個人群組。/ Someone's personal groups.
pub async fn personal_groups(db: &Db, owner: i64) -> sqlx::Result<Vec<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE owner_id = ? ORDER BY display_name COLLATE NOCASE, id")).bind(owner).fetch_all(&db.read).await
}

/// 某人的一個個人群組（別人的 = None）。/ One of someone's personal groups (another person's = None).
pub async fn personal_group(db: &Db, owner: i64, id: i64) -> sqlx::Result<Option<Group>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {GROUP} WHERE id = ? AND owner_id = ?")).bind(id).bind(owner).fetch_optional(&db.read).await
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
    let placeholder = format!("personal:{owner}:{}", crate::util::random_alnum(32));
    let res = sqlx::query(&format!("INSERT INTO {GROUP} (name, description, created_at, owner_id, display_name) VALUES (?, ?, ?, ?, ?)"))
        .bind(placeholder)
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

/// 刪群組連同成員與它的允許 / 拒絕。/ Deletes a group with its members and grants.
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

/// 組織群組的 (group_id, user_id) 全部（功能權限、管理頁、單一登入）。/ Every organization-group membership.
pub async fn memberships(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT m.group_id, m.user_id FROM {MEMBER} m JOIN {GROUP} g ON g.id = m.group_id WHERE g.{ORG} ORDER BY m.group_id, m.user_id"))
        .fetch_all(&db.read)
        .await
}

/// 兩種群組的成員資格（分享給群組用）。/ Memberships of both kinds (for group shares).
pub async fn all_memberships(db: &Db) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(&format!("SELECT group_id, user_id FROM {MEMBER} ORDER BY group_id, user_id")).fetch_all(&db.read).await
}

/// 這個人在哪些組織群組。/ The organization groups this person is in.
pub async fn groups_of(db: &Db, user_id: i64) -> sqlx::Result<std::collections::BTreeSet<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar(&format!("SELECT m.group_id FROM {MEMBER} m JOIN {GROUP} g ON g.id = m.group_id WHERE m.user_id = ? AND g.{ORG}"))
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

pub async fn grants(db: &Db) -> sqlx::Result<Vec<GrantRow>> {
    sqlx::query_as(&format!("SELECT subject_kind, subject_id, feature, allowed FROM {GRANT}")).fetch_all(&db.read).await
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
