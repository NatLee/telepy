//! OIDC 身分提供者與帳號連結（`telepy_oidc_provider`、`social_account` 裡 provider = `oidc:<id>` 的列）。
//! OIDC providers and account links (`telepy_oidc_provider`, `social_account` rows with provider `oidc:<id>`).

use super::Db;
use crate::db::users::User;
use crate::util::now_db;

const T: &str = "telepy_oidc_provider";
const COLS: &str = "id, slug, name, issuer, client_id, client_secret, scopes, username_from, allowed_domains, create_users, link_by_email, enabled, created_at, updated_at";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Provider {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub issuer: String,
    pub client_id: String,
    /// vault 封存過的；空 = public client（只靠 PKCE）。/ Sealed; empty = a public client (PKCE only).
    pub client_secret: String,
    pub scopes: String,
    pub username_from: String,
    pub allowed_domains: String,
    pub create_users: bool,
    pub link_by_email: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Provider {
    /// social_account 裡的 provider 值。/ The provider value in social_account.
    pub fn link_key(&self) -> String {
        link_key(self.id)
    }
}

pub fn link_key(id: i64) -> String {
    format!("oidc:{id}")
}

pub struct NewProvider<'a> {
    pub slug: &'a str,
    pub name: &'a str,
    pub issuer: &'a str,
    pub client_id: &'a str,
    pub scopes: &'a str,
    pub username_from: &'a str,
    pub allowed_domains: &'a str,
    pub create_users: bool,
    pub link_by_email: bool,
    pub enabled: bool,
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<Provider>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} ORDER BY name COLLATE NOCASE, id")).fetch_all(&db.read).await
}

pub async fn enabled(db: &Db) -> sqlx::Result<Vec<Provider>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id")).fetch_all(&db.read).await
}

pub async fn by_id(db: &Db, id: i64) -> sqlx::Result<Option<Provider>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn by_slug(db: &Db, slug: &str) -> sqlx::Result<Option<Provider>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM {T} WHERE slug = ?")).bind(slug).fetch_optional(&db.read).await
}

pub async fn create(db: &Db, p: &NewProvider<'_>) -> sqlx::Result<i64> {
    let now = now_db();
    Ok(sqlx::query(&format!("INSERT INTO {T} (slug, name, issuer, client_id, scopes, username_from, allowed_domains, create_users, link_by_email, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
        .bind(p.slug)
        .bind(p.name)
        .bind(p.issuer)
        .bind(p.client_id)
        .bind(p.scopes)
        .bind(p.username_from)
        .bind(p.allowed_domains)
        .bind(p.create_users)
        .bind(p.link_by_email)
        .bind(p.enabled)
        .bind(&now)
        .bind(&now)
        .execute(&db.write)
        .await?
        .last_insert_rowid())
}

/// 整列換掉（secret 另外存）。/ Replace the row (the secret is stored separately).
pub async fn update(db: &Db, id: i64, p: &NewProvider<'_>) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET slug = ?, name = ?, issuer = ?, client_id = ?, scopes = ?, username_from = ?, allowed_domains = ?, create_users = ?, link_by_email = ?, enabled = ?, updated_at = ? WHERE id = ?"))
        .bind(p.slug)
        .bind(p.name)
        .bind(p.issuer)
        .bind(p.client_id)
        .bind(p.scopes)
        .bind(p.username_from)
        .bind(p.allowed_domains)
        .bind(p.create_users)
        .bind(p.link_by_email)
        .bind(p.enabled)
        .bind(now_db())
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn set_secret(db: &Db, id: i64, sealed: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET client_secret = ?, updated_at = ? WHERE id = ?")).bind(sealed).bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 刪掉身分提供者，連結一起刪。/ Delete a provider and its links.
pub async fn delete(db: &Db, id: i64) -> sqlx::Result<u64> {
    sqlx::query("DELETE FROM social_account WHERE provider = ?").bind(link_key(id)).execute(&db.write).await?;
    Ok(sqlx::query(&format!("DELETE FROM {T} WHERE id = ?")).bind(id).execute(&db.write).await?.rows_affected())
}

/// 這個身分提供者的 sub 連到誰。/ Who this provider's sub is linked to.
pub async fn user_for(db: &Db, provider_id: i64, sub: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT user_id FROM social_account WHERE provider = ? AND unique_id = ? ORDER BY id LIMIT 1").bind(link_key(provider_id)).bind(sub).fetch_optional(&db.read).await
}

/// 這個人在這個身分提供者連了哪個 sub。/ The sub this person linked at this provider.
pub async fn sub_for(db: &Db, provider_id: i64, user_id: i64) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT unique_id FROM social_account WHERE provider = ? AND user_id = ? ORDER BY id LIMIT 1").bind(link_key(provider_id)).bind(user_id).fetch_optional(&db.read).await
}

pub async fn link(db: &Db, provider_id: i64, user_id: i64, sub: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO social_account (provider, unique_id, user_id) VALUES (?, ?, ?)").bind(link_key(provider_id)).bind(sub).bind(user_id).execute(&db.write).await?;
    Ok(())
}

pub async fn unlink(db: &Db, provider_id: i64, user_id: i64) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM social_account WHERE provider = ? AND user_id = ?").bind(link_key(provider_id)).bind(user_id).execute(&db.write).await?.rows_affected())
}

/// 這個人連了哪些身分提供者（provider id）。/ The provider ids this person linked.
pub async fn linked_ids(db: &Db, user_id: i64) -> sqlx::Result<Vec<i64>> {
    let keys: Vec<String> = sqlx::query_scalar("SELECT provider FROM social_account WHERE user_id = ? AND provider LIKE 'oidc:%'").bind(user_id).fetch_all(&db.read).await?;
    Ok(keys.iter().filter_map(|k| k.strip_prefix("oidc:")?.parse().ok()).collect())
}

/// 這個人還有沒有別的登入方式（密碼、Google、別的 SSO）——拿掉最後一個會把自己鎖在外面。
/// Whether this person has another way in (password, Google, another SSO) — removing the last one locks them out.
/// 有 passkey 也算（passkey 可以免密碼登入）。/ A passkey counts too (it signs in without a password).
pub async fn other_ways_in(db: &Db, user: &User, has_passkey: bool, except_provider: i64) -> sqlx::Result<bool> {
    if has_passkey || (!user.password.starts_with('!') && !user.password.is_empty()) {
        return Ok(true);
    }
    let others: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM social_account WHERE user_id = ? AND provider != ?").bind(user.id).bind(link_key(except_provider)).fetch_one(&db.read).await?;
    Ok(others > 0)
}

/// 用 email 找既有帳號（不分大小寫；正好一個才算）。/ An existing account by email (case-insensitive; exactly one).
pub async fn user_by_email(db: &Db, email: &str) -> sqlx::Result<Option<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM auth_user WHERE lower(email) = lower(?) LIMIT 2").bind(email).fetch_all(&db.read).await?;
    Ok(if ids.len() == 1 { Some(ids[0]) } else { None })
}

/// 每個身分提供者連了幾個帳號。/ How many accounts each provider links.
pub async fn link_counts(db: &Db) -> sqlx::Result<std::collections::HashMap<i64, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as("SELECT provider, COUNT(*) FROM social_account WHERE provider LIKE 'oidc:%' GROUP BY provider").fetch_all(&db.read).await?;
    Ok(rows.into_iter().filter_map(|(k, n)| Some((k.strip_prefix("oidc:")?.parse().ok()?, n))).collect())
}
