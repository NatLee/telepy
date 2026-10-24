//! 隧道（ReverseServerAuthorizedKeys）與目標主機使用者名稱（ReverseServerUsernames）。

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct Tunnel {
    pub id: i64,
    pub user_id: i64,
    pub host_friendly_name: String,
    pub key: String,
    pub reverse_port: i64,
    pub description: Option<String>,
    pub default_username_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    /// 開 session 前要 step-up（見 `crate::step_up`）。/ Sessions need a step-up first (see `crate::step_up`).
    pub require_step_up: bool,
    /// 網頁終端機要錄影（見 `crate::recording`）。/ Web terminal sessions are recorded (see `crate::recording`).
    pub record_sessions: bool,
}

#[derive(Debug, Clone, FromRow)]
pub struct Username {
    pub id: i64,
    pub user_id: i64,
    pub reverse_server_id: i64,
    pub username: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Username + creator's auth_user.username (for the `created_by` field).
#[derive(Debug, Clone, FromRow)]
pub struct UsernameWithCreator {
    pub id: i64,
    pub user_id: i64,
    pub reverse_server_id: i64,
    pub username: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
}

const T_COLS: &str = "id, user_id, host_friendly_name, key, reverse_port, description, default_username_id, created_at, updated_at, require_step_up, record_sessions";
const T: &str = "authorized_keys_reverseserverauthorizedkeys";
const U_COLS: &str = "id, user_id, reverse_server_id, username, created_at, updated_at";
const U: &str = "authorized_keys_reverseserverusernames";

pub async fn by_id(db: &Db, id: i64) -> sqlx::Result<Option<Tunnel>> {
    sqlx::query_as(&format!("SELECT {T_COLS} FROM {T} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn all(db: &Db) -> sqlx::Result<Vec<Tunnel>> {
    sqlx::query_as(&format!("SELECT {T_COLS} FROM {T} ORDER BY id")).fetch_all(&db.read).await
}

pub async fn by_port(db: &Db, port: i64) -> sqlx::Result<Vec<Tunnel>> {
    sqlx::query_as(&format!("SELECT {T_COLS} FROM {T} WHERE reverse_port = ? ORDER BY id"))
        .bind(port)
        .fetch_all(&db.read)
        .await
}

pub async fn all_ports(db: &Db) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar(&format!("SELECT reverse_port FROM {T}")).fetch_all(&db.read).await
}

pub async fn keys_for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(&format!("SELECT key FROM {T} WHERE user_id = ?")).bind(user_id).fetch_all(&db.read).await
}

/// `user_tunnels_queryset(user)`：owned ∪ shared，依 id 排序。
pub async fn visible_to(db: &Db, user_id: i64) -> sqlx::Result<Vec<Tunnel>> {
    sqlx::query_as(&format!(
        "SELECT {T_COLS} FROM {T} WHERE user_id = ? OR id IN (SELECT tunnel_id FROM tunnels_tunnelsharing WHERE shared_with_id = ?) ORDER BY id"
    ))
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&db.read)
    .await
}

/// 以 `type base64` 前綴找隧道（gateway 的公鑰認證）。/ Tunnel whose key starts with the offered key.
pub async fn by_key_prefix(db: &Db, like: &str) -> sqlx::Result<Option<Tunnel>> {
    sqlx::query_as(&format!("SELECT {T_COLS} FROM {T} WHERE key LIKE ? ESCAPE '\\' ORDER BY id LIMIT 1"))
        .bind(like)
        .fetch_optional(&db.read)
        .await
}

pub fn like_prefix(prefix: &str) -> String {
    let escaped = prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("{escaped}%")
}

/// 名稱全站唯一（UNIQUE）。/ Names are unique across all users.
pub async fn name_taken(db: &Db, name: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {T} WHERE host_friendly_name = ?")).bind(name).fetch_one(&db.read).await?;
    Ok(n > 0)
}

pub async fn exists_name_for_user(db: &Db, user_id: i64, name: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {T} WHERE user_id = ? AND host_friendly_name = ?"))
        .bind(user_id)
        .bind(name)
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
}

pub struct NewTunnel<'a> {
    pub user_id: i64,
    pub host_friendly_name: &'a str,
    pub key: &'a str,
    pub reverse_port: i64,
    pub description: Option<&'a str>,
    pub default_username_id: Option<i64>,
}

/// 開 / 關錄影。/ Turn recording on or off.
pub async fn set_record_sessions(db: &Db, id: i64, on: bool) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET record_sessions = ?, updated_at = ? WHERE id = ?")).bind(on).bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 開 / 關 step-up。/ Turn step-up on or off.
pub async fn set_require_step_up(db: &Db, id: i64, required: bool) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET require_step_up = ?, updated_at = ? WHERE id = ?")).bind(required).bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}

pub async fn create(db: &Db, new: NewTunnel<'_>) -> sqlx::Result<Tunnel> {
    let now = now_db();
    let id = sqlx::query(&format!(
        "INSERT INTO {T} (user_id, host_friendly_name, key, reverse_port, description, default_username_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(new.user_id)
    .bind(new.host_friendly_name)
    .bind(new.key)
    .bind(new.reverse_port)
    .bind(new.description)
    .bind(new.default_username_id)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    Ok(by_id(db, id).await?.expect("tunnel just inserted"))
}

pub struct TunnelPatch<'a> {
    pub host_friendly_name: Option<&'a str>,
    pub key: Option<&'a str>,
    pub reverse_port: Option<i64>,
    pub description: Option<Option<&'a str>>,
    pub default_username_id: Option<Option<i64>>,
}

pub async fn update(db: &Db, id: i64, p: TunnelPatch<'_>) -> sqlx::Result<Tunnel> {
    let mut tx = db.write.begin().await?;
    if let Some(v) = p.host_friendly_name {
        sqlx::query(&format!("UPDATE {T} SET host_friendly_name = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.key {
        sqlx::query(&format!("UPDATE {T} SET key = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.reverse_port {
        sqlx::query(&format!("UPDATE {T} SET reverse_port = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.description {
        sqlx::query(&format!("UPDATE {T} SET description = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.default_username_id {
        sqlx::query(&format!("UPDATE {T} SET default_username_id = ? WHERE id = ?")).bind(v).bind(id).execute(&mut *tx).await?;
    }
    sqlx::query(&format!("UPDATE {T} SET updated_at = ? WHERE id = ?")).bind(now_db()).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(by_id(db, id).await?.expect("tunnel exists"))
}

pub async fn set_default_username(db: &Db, id: i64, username_id: Option<i64>) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET default_username_id = ? WHERE id = ?"))
        .bind(username_id)
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// Django `on_delete=CASCADE` 是在 Python 端做的（SQLite 表沒有 ON DELETE）；這裡手動串聯：
/// allowed usernames → sharing → usernames → tunnel。
pub async fn delete(db: &Db, id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM tunnels_tunnelsharingallowedusername WHERE tunnel_sharing_id IN (SELECT id FROM tunnels_tunnelsharing WHERE tunnel_id = ?)")
        .bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM tunnels_tunnelsharingallowedusername WHERE reverse_server_username_id IN (SELECT id FROM {U} WHERE reverse_server_id = ?)"))
        .bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM tunnels_tunnelsharing WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {U} WHERE reverse_server_id = ?")).bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_lan_host WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_credential WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_device_host_key WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_terminal_profile WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_endpoint WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_pin WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_session WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_label WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    // 錄影的列；檔案由呼叫端（`recording::forget_tunnel`）刪。/ Recording rows; the caller removes the files.
    sqlx::query("DELETE FROM telepy_terminal_recording WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_access_request WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_command_rule WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_command_event WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {T} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------- usernames

pub async fn username_by_id(db: &Db, id: i64) -> sqlx::Result<Option<Username>> {
    sqlx::query_as(&format!("SELECT {U_COLS} FROM {U} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn usernames_for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<UsernameWithCreator>> {
    sqlx::query_as(&format!(
        "SELECT u.id, u.user_id, u.reverse_server_id, u.username, u.created_at, u.updated_at, a.username AS created_by \
         FROM {U} u JOIN auth_user a ON a.id = u.user_id WHERE u.reverse_server_id = ? ORDER BY u.id"
    ))
    .bind(tunnel_id)
    .fetch_all(&db.read)
    .await
}

pub async fn usernames_exist_for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {U} WHERE reverse_server_id = ?"))
        .bind(tunnel_id)
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
}

/// ViewSet queryset：自己建立的 ∪ 分享給我的隧道上的全部。
pub async fn usernames_visible_to(db: &Db, user_id: i64) -> sqlx::Result<Vec<Username>> {
    sqlx::query_as(&format!(
        "SELECT {U_COLS} FROM {U} WHERE user_id = ? OR reverse_server_id IN (SELECT tunnel_id FROM tunnels_tunnelsharing WHERE shared_with_id = ?) ORDER BY id"
    ))
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&db.read)
    .await
}

pub async fn username_exists(db: &Db, user_id: i64, tunnel_id: i64, username: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {U} WHERE user_id = ? AND reverse_server_id = ? AND username = ?"))
        .bind(user_id)
        .bind(tunnel_id)
        .bind(username)
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
}

/// 隧道上是否已有這個名字（不分建立者；`except` = 改名時排除自己）。
pub async fn username_taken(db: &Db, tunnel_id: i64, username: &str, except: Option<i64>) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {U} WHERE reverse_server_id = ? AND username = ? AND id <> ?"))
        .bind(tunnel_id)
        .bind(username)
        .bind(except.unwrap_or(-1))
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
}

pub async fn username_create(db: &Db, user_id: i64, tunnel_id: i64, username: &str) -> sqlx::Result<Username> {
    let now = now_db();
    let id = sqlx::query(&format!("INSERT INTO {U} (username, created_at, updated_at, reverse_server_id, user_id) VALUES (?, ?, ?, ?, ?)"))
        .bind(username)
        .bind(&now)
        .bind(&now)
        .bind(tunnel_id)
        .bind(user_id)
        .execute(&db.write)
        .await?
        .last_insert_rowid();
    Ok(username_by_id(db, id).await?.expect("username just inserted"))
}

pub async fn username_update(db: &Db, id: i64, username: Option<&str>) -> sqlx::Result<Username> {
    if let Some(u) = username {
        sqlx::query(&format!("UPDATE {U} SET username = ?, updated_at = ? WHERE id = ?"))
            .bind(u)
            .bind(now_db())
            .bind(id)
            .execute(&db.write)
            .await?;
    }
    Ok(username_by_id(db, id).await?.expect("username exists"))
}

/// 刪除 username：連帶清掉 allowed-username 列，並把指向它的 default_username 設 NULL（SET_NULL）。
pub async fn username_delete(db: &Db, id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query("DELETE FROM tunnels_tunnelsharingallowedusername WHERE reverse_server_username_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("UPDATE {T} SET default_username_id = NULL WHERE default_username_id = ?")).bind(id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {U} WHERE id = ?")).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// `_transfer_usernames_to_owner`：把 `user` 在該隧道建立的 usernames 轉給擁有者；擁有者已有同名者則刪除。
pub async fn transfer_usernames_to_owner(db: &Db, tunnel_id: i64, owner_id: i64, user_id: i64) -> sqlx::Result<()> {
    if owner_id == user_id {
        return Ok(());
    }
    let mine: Vec<Username> = sqlx::query_as(&format!("SELECT {U_COLS} FROM {U} WHERE reverse_server_id = ? AND user_id = ?"))
        .bind(tunnel_id)
        .bind(user_id)
        .fetch_all(&db.read)
        .await?;
    for u in mine {
        if username_exists(db, owner_id, tunnel_id, &u.username).await? {
            username_delete(db, u.id).await?;
        } else {
            sqlx::query(&format!("UPDATE {U} SET user_id = ? WHERE id = ?")).bind(owner_id).bind(u.id).execute(&db.write).await?;
        }
    }
    Ok(())
}

/// 某隧道最近的 gateway 事件 (at, event, message)，新到舊。/ Latest gateway events of a tunnel, newest first.
pub async fn recent_gateway_events(db: &Db, tunnel_id: i64, limit: i64) -> sqlx::Result<Vec<(String, String, String)>> {
    sqlx::query_as("SELECT at, event, message FROM telepy_gateway_event WHERE tunnel_id = ? ORDER BY id DESC LIMIT ?")
        .bind(tunnel_id)
        .bind(limit)
        .fetch_all(&db.read)
        .await
}
