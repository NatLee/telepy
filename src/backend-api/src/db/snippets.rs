//! 工具箱的指令片段（`telepy_snippet`）：scope `user`（`user_id` = 擁有者）、`tunnel`（`tunnel_id`）、`site`。
//! Toolbox command snippets (`telepy_snippet`): scope `user` (`user_id` = owner), `tunnel` (`tunnel_id`) or `site`.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

const T: &str = "telepy_snippet";

#[derive(Debug, Clone, FromRow)]
pub struct Snippet {
    pub id: i64,
    /// user / tunnel / site
    pub scope: String,
    pub user_id: Option<i64>,
    pub tunnel_id: Option<i64>,
    pub name: String,
    pub command: String,
    pub description: String,
    /// JSON 陣列 `[{name, label, default, secret}]`。/ A JSON array `[{name, label, default, secret}]`.
    pub variables: String,
    pub confirm: bool,
    pub sort_order: i64,
    pub use_count: i64,
    pub last_used_at: Option<String>,
    pub created_by_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

const COLS: &str = "id, scope, user_id, tunnel_id, name, command, description, variables, confirm, sort_order, use_count, last_used_at, created_by_id, created_at, updated_at";
const ORDER: &str = "ORDER BY sort_order, id";

/// 片段的內容（新增 / 修改共用）。/ A snippet's content (create and update).
pub struct Fields<'a> {
    pub name: &'a str,
    pub command: &'a str,
    pub description: &'a str,
    pub variables: &'a str,
    pub confirm: bool,
    pub sort_order: i64,
}

pub async fn create(db: &Db, scope: &str, user_id: Option<i64>, tunnel_id: Option<i64>, f: &Fields<'_>, by: i64) -> sqlx::Result<Snippet> {
    let now = now_db();
    let id = sqlx::query(&format!(
        "INSERT INTO {T} (scope, user_id, tunnel_id, name, command, description, variables, confirm, sort_order, use_count, created_by_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
    ))
    .bind(scope)
    .bind(user_id)
    .bind(tunnel_id)
    .bind(f.name)
    .bind(f.command)
    .bind(f.description)
    .bind(f.variables)
    .bind(f.confirm)
    .bind(f.sort_order)
    .bind(by)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?
    .last_insert_rowid();
    get(db, id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// 換掉內容（範圍不變）。/ Replace the content (the scope stays).
pub async fn update(db: &Db, id: i64, f: &Fields<'_>) -> sqlx::Result<Option<Snippet>> {
    sqlx::query(&format!("UPDATE {T} SET name = ?, command = ?, description = ?, variables = ?, confirm = ?, sort_order = ?, updated_at = ? WHERE id = ?"))
        .bind(f.name)
        .bind(f.command)
        .bind(f.description)
        .bind(f.variables)
        .bind(f.confirm)
        .bind(f.sort_order)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    get(db, id).await
}

pub async fn delete(db: &Db, id: i64) -> sqlx::Result<bool> {
    Ok(sqlx::query(&format!("DELETE FROM {T} WHERE id = ?")).bind(id).execute(&db.write).await?.rows_affected() > 0)
}

pub async fn get(db: &Db, id: i64) -> sqlx::Result<Option<Snippet>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

/// 某人自己的片段。/ Someone's own snippets.
pub async fn for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<Snippet>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE scope = 'user' AND user_id = ? {ORDER}")).bind(user_id).fetch_all(&db.read).await
}

/// 一條隧道的片段。/ One tunnel's snippets.
pub async fn for_tunnel(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<Snippet>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE scope = 'tunnel' AND tunnel_id = ? {ORDER}")).bind(tunnel_id).fetch_all(&db.read).await
}

/// 全站片段。/ Site-wide snippets.
pub async fn for_site(db: &Db) -> sqlx::Result<Vec<Snippet>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE scope = 'site' {ORDER}")).fetch_all(&db.read).await
}

/// 一個範圍裡有幾個（上限檢查）。/ How many a scope holds (for the limit).
pub async fn count(db: &Db, scope: &str, owner: Option<i64>) -> sqlx::Result<i64> {
    match scope {
        "user" => sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {T} WHERE scope = 'user' AND user_id = ?")).bind(owner).fetch_one(&db.read).await,
        "tunnel" => sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {T} WHERE scope = 'tunnel' AND tunnel_id = ?")).bind(owner).fetch_one(&db.read).await,
        _ => sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {T} WHERE scope = 'site'")).fetch_one(&db.read).await,
    }
}

/// 用了一次：計數 +1、記下時間。/ Used once: bump the counter and the time.
pub async fn mark_used(db: &Db, id: i64) -> sqlx::Result<Option<Snippet>> {
    sqlx::query(&format!("UPDATE {T} SET use_count = use_count + 1, last_used_at = ? WHERE id = ?")).bind(now_db()).bind(id).execute(&db.write).await?;
    get(db, id).await
}
