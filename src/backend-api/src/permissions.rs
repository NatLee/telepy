//! 隧道權限：VIEW < EDIT < ADMIN 階層 + 允許的目標使用者名稱。
//! 對應 Django 的 `TunnelPermissionManager` 與 `TunnelPermissionService.get_allowed_usernames`。
//! Tunnel permission hierarchy and allowed-usernames resolution (pure logic + thin DB wrappers).

use crate::db::{self, tunnels::Tunnel, tunnels::UsernameWithCreator, Db};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    View = 1,
    Edit = 2,
    Admin = 3,
}

impl Permission {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "view" => Some(Permission::View),
            "edit" => Some(Permission::Edit),
            "admin" => Some(Permission::Admin),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::View => "view",
            Permission::Edit => "edit",
            Permission::Admin => "admin",
        }
    }
    /// `get_permission_type_display()`
    pub fn display(self) -> &'static str {
        match self {
            Permission::View => "View Only",
            Permission::Edit => "Edit",
            Permission::Admin => "Admin",
        }
    }
}

/// 目前使用者對隧道的有效權限：Owner（等同 admin）/ Shared(level) / None。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effective {
    Owner,
    Shared(Permission),
}

impl Effective {
    pub fn level(self) -> Permission {
        match self {
            Effective::Owner => Permission::Admin,
            Effective::Shared(p) => p,
        }
    }
    pub fn satisfies(self, required: Permission) -> bool {
        self.level() >= required
    }
    /// serializer 的 `user_permission` 欄位：'owner' | 'admin' | 'edit' | 'view'。
    pub fn label(self) -> &'static str {
        match self {
            Effective::Owner => "owner",
            Effective::Shared(p) => p.as_str(),
        }
    }
}

/// 純函式版：由 owner 與（可能的）分享列決定有效權限。
pub fn effective(user_id: i64, tunnel_owner_id: i64, sharing_permission: Option<&str>) -> Option<Effective> {
    if user_id == tunnel_owner_id {
        return Some(Effective::Owner);
    }
    sharing_permission.and_then(Permission::parse).map(Effective::Shared)
}

pub async fn effective_for(db: &Db, user_id: i64, tunnel: &Tunnel) -> sqlx::Result<Option<Effective>> {
    if user_id == tunnel.user_id {
        return Ok(Some(Effective::Owner));
    }
    let sharing = db::sharing::get(db, tunnel.id, user_id).await?;
    Ok(effective(user_id, tunnel.user_id, sharing.as_ref().map(|s| s.permission_type.as_str())))
}

/// `TunnelPermissionManager.check_access`
pub async fn check_access(db: &Db, user_id: i64, tunnel: &Tunnel, required: Permission) -> sqlx::Result<bool> {
    Ok(effective_for(db, user_id, tunnel).await?.map(|e| e.satisfies(required)).unwrap_or(false))
}

/// `check_share_access` / `check_delete_access`：owner 或 ADMIN 分享。
pub async fn check_share_access(db: &Db, user_id: i64, tunnel: &Tunnel) -> sqlx::Result<bool> {
    check_access(db, user_id, tunnel, Permission::Admin).await
}

/// 能用哪些目標 OS 帳號（terminal / 檔案 / SFTP / 遠端瀏覽器 / 腳本 / MCP 全部走這裡）：
/// - owner / ADMIN → 該隧道全部 usernames（也只有他們能新增 / 改 / 刪 OS 帳號）
/// - VIEW / EDIT 分享 → 只有 owner / ADMIN 指派的允許清單；清單空 = 一個都沒有
/// - 未分享 → 無
/// 自己建立的不會自動算進去：裝置分不出是哪位 Telepy 使用者（大家都用同一把服務金鑰），所以允許清單是唯一的關卡。
/// Usable target accounts: everything for owner / ADMIN, exactly the allow-list for other sharees.
pub async fn allowed_usernames(db: &Db, user_id: i64, tunnel: &Tunnel) -> sqlx::Result<Vec<UsernameWithCreator>> {
    let all = db::tunnels::usernames_for_tunnel(db, tunnel.id).await?;
    let eff = effective_for(db, user_id, tunnel).await?;
    match eff {
        Some(e) if e.satisfies(Permission::Admin) => Ok(all),
        Some(_) => {
            let sharing = db::sharing::get(db, tunnel.id, user_id).await?;
            let Some(sharing) = sharing else { return Ok(vec![]) };
            let allowed = db::sharing::allowed_username_ids(db, sharing.id).await?;
            Ok(filter_allowed(all, &allowed))
        }
        None => Ok(vec![]),
    }
}

/// 從允許的 username 挑一個：指定的必須在清單內；沒指定就用隧道預設（若允許），清單只有一個就用它。
/// 錯誤訊息直接給人看（列出可用的）。/ Pick a target username: the requested one must be allowed;
/// otherwise the tunnel default (when allowed) or the only allowed one.
pub fn choose_username(allowed: &[UsernameWithCreator], default_id: Option<i64>, requested: Option<&str>, tunnel_name: &str) -> Result<String, String> {
    let names: Vec<&str> = allowed.iter().map(|u| u.username.as_str()).collect();
    if names.is_empty() {
        return Err(format!("No target username is available to you on '{tunnel_name}'. Add one in Telepy (tunnel → usernames) first."));
    }
    match requested.map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) if names.contains(&u) => Ok(u.to_string()),
        Some(u) => Err(format!("Username '{u}' is not allowed on '{tunnel_name}'. Allowed: {}", names.join(", "))),
        None => match default_id.and_then(|d| allowed.iter().find(|u| u.id == d)) {
            Some(u) => Ok(u.username.clone()),
            None if names.len() == 1 => Ok(names[0].to_string()),
            None => Err(format!("Pick a username for '{tunnel_name}': {}", names.join(", "))),
        },
    }
}

pub fn filter_allowed(all: Vec<UsernameWithCreator>, allowed: &[i64]) -> Vec<UsernameWithCreator> {
    all.into_iter().filter(|u| allowed.contains(&u.id)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(id: i64, user_id: i64) -> UsernameWithCreator {
        UsernameWithCreator {
            id,
            user_id,
            reverse_server_id: 1,
            username: format!("u{id}"),
            created_at: String::new(),
            updated_at: String::new(),
            created_by: String::new(),
        }
    }

    #[test]
    fn hierarchy() {
        assert!(Effective::Owner.satisfies(Permission::Admin));
        assert!(Effective::Shared(Permission::Edit).satisfies(Permission::View));
        assert!(!Effective::Shared(Permission::Edit).satisfies(Permission::Admin));
        assert_eq!(effective(1, 1, None), Some(Effective::Owner));
        assert_eq!(effective(2, 1, Some("edit")), Some(Effective::Shared(Permission::Edit)));
        assert_eq!(effective(2, 1, None), None);
        assert_eq!(effective(2, 1, Some("bogus")), None);
    }

    #[test]
    fn allowed_filtering() {
        // rows 2 and 3 were created by the sharee (user 20): creating a row grants nothing
        let all = vec![u(1, 10), u(2, 20), u(3, 20)];
        assert!(filter_allowed(all.clone(), &[]).is_empty(), "empty allow-list → nothing");
        let r = filter_allowed(all, &[1]);
        assert_eq!(r.iter().map(|x| x.id).collect::<Vec<_>>(), vec![1]);
    }
}
