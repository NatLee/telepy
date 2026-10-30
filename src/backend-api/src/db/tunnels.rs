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
    /// 網頁終端機斷線時：`user` = 照使用者的選擇保留 shell、`never` = 一律立刻結束（見 `crate::terminal_detach`）。
    /// When a web terminal's socket drops: `user` = keep the shell per the user's choice, `never` = always end it at once.
    pub terminal_detach_policy: String,
    /// 裝置設定成怎麼連 Telepy：`ssh` / `websocket`；還不知道 = None（見 [`set_way_in`]、[`fill_way_in`]）。
    /// How the device is set up to reach Telepy: `ssh` / `websocket`; None = not known yet.
    pub way_in: Option<String>,
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

const T_COLS: &str = "id, user_id, host_friendly_name, key, reverse_port, description, default_username_id, created_at, updated_at, require_step_up, record_sessions, terminal_detach_policy, way_in";
const T: &str = "authorized_keys_reverseserverauthorizedkeys";
const U_COLS: &str = "id, user_id, reverse_server_id, username, created_at, updated_at";
const U: &str = "authorized_keys_reverseserverusernames";

/// 加入時記下裝置設定成怎麼連（一鍵加入、裝置下載的一次性腳本；重新加入就覆蓋）。值是 `ssh` / `websocket`。
/// Record how the device is set up to reach Telepy (one-command join, the one-time script it downloaded; a rejoin
/// overwrites it). Values: `ssh` / `websocket`.
pub async fn set_way_in(db: &Db, id: i64, way: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET way_in = ? WHERE id = ?")).bind(way).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 還不知道怎麼加進來的（手動貼腳本、舊的隧道）：第一次連上時用那次的方式補上。
/// Not known yet (a script pasted by hand, an older tunnel): the first connection fills it in.
pub async fn fill_way_in(db: &Db, port: u16, way: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET way_in = ? WHERE reverse_port = ? AND way_in IS NULL")).bind(way).bind(port as i64).execute(&db.write).await?;
    Ok(())
}

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

/// 自己擁有的隧道的 (id, 名稱, 裝置金鑰)：個人金鑰標出「也是哪條隧道的裝置金鑰」用。
/// (id, name, device key) of the tunnels a user owns, to mark personal keys that double as one of them.
pub async fn owned_device_keys(db: &Db, user_id: i64) -> sqlx::Result<Vec<(i64, String, String)>> {
    sqlx::query_as(&format!("SELECT id, host_friendly_name, key FROM {T} WHERE user_id = ? ORDER BY id")).bind(user_id).fetch_all(&db.read).await
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

/// 依名稱找（名稱全站唯一）。/ By name (names are unique across all users).
pub async fn by_name(db: &Db, name: &str) -> sqlx::Result<Option<Tunnel>> {
    sqlx::query_as(&format!("SELECT {T_COLS} FROM {T} WHERE host_friendly_name = ?")).bind(name).fetch_optional(&db.read).await
}

/// 不分大小寫找名稱，完全相同的排前面。OpenSSH 會把 `HostName` 轉成小寫再交給 ProxyCommand 的 `%h`，所以名稱有大寫的
/// 隧道（`MyBox`）到閘道時是 `mybox`；SQLite 的 `lower()` 跟 OpenSSH 一樣只轉 ASCII。UNIQUE 是分大小寫的，所以可能有好幾條。
/// Names ignoring case, the exact one first. OpenSSH lowercases `HostName` before ProxyCommand's `%h`, so a tunnel named
/// `MyBox` reaches the gateway as `mybox`; SQLite's `lower()` folds ASCII only, like OpenSSH. UNIQUE is case-sensitive,
/// so several rows may match.
pub async fn by_name_ignoring_case(db: &Db, name: &str) -> sqlx::Result<Vec<Tunnel>> {
    sqlx::query_as(&format!("SELECT {T_COLS} FROM {T} WHERE lower(host_friendly_name) = lower(?) ORDER BY host_friendly_name = ? DESC, id"))
        .bind(name)
        .bind(name)
        .fetch_all(&db.read)
        .await
}

/// 名稱有沒有被用掉，不分大小寫（ssh 連線時主機名稱一律轉小寫，見 [`crate::tunnel_name`]）；`except` = 改名時的自己。
/// UNIQUE 本身分大小寫，所以新名稱在這裡擋。
/// Whether a name is taken ignoring case (ssh lowercases host names, see [`crate::tunnel_name`]); `except` = the tunnel
/// being renamed. The UNIQUE constraint is case-sensitive, so new names are checked here.
pub async fn name_taken_ignoring_case(db: &Db, name: &str, except: Option<i64>) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {T} WHERE lower(host_friendly_name) = lower(?) AND id != ?"))
        .bind(name)
        .bind(except.unwrap_or(-1))
        .fetch_one(&db.read)
        .await?;
    Ok(n > 0)
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

/// 設定斷線保留政策（`user` / `never`）。/ Set the detach policy (`user` / `never`).
pub async fn set_terminal_detach_policy(db: &Db, id: i64, policy: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET terminal_detach_policy = ?, updated_at = ? WHERE id = ?")).bind(policy).bind(now_db()).bind(id).execute(&db.write).await?;
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
    sqlx::query("DELETE FROM telepy_shell_history_pref WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_endpoint WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_pin WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_notify_tunnel_mute WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    // 每個人的分組與金鑰群組對它的授予。/ Everyone's grouping of it and key group grants to it.
    sqlx::query("DELETE FROM telepy_tunnel_group_member WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_key_group_grant WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_session WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_tunnel_label WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    // 錄影的列；檔案由呼叫端（`recording::forget_tunnel`）刪。/ Recording rows; the caller removes the files.
    sqlx::query("DELETE FROM telepy_terminal_recording WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_access_request WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    // 只套用它的指令規則刪掉，其他規則的清單拿掉它。/ Rules limited to it alone go; other lists drop it.
    super::command_rules::forget_tunnel(&mut tx, id).await?;
    sqlx::query("DELETE FROM telepy_command_event WHERE tunnel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM telepy_snippet WHERE scope = 'tunnel' AND tunnel_id = ?").bind(id).execute(&mut *tx).await?;
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
