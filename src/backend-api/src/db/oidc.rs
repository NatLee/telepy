//! OIDC 身分提供者與帳號連結（`telepy_oidc_provider`、`social_account` 裡 provider = `oidc:<id>` 的列）。
//! OIDC providers and account links (`telepy_oidc_provider`, `social_account` rows with provider `oidc:<id>`).

use super::Db;
use crate::db::users::User;
use crate::util::now_db;

const T: &str = "telepy_oidc_provider";
const COLS: &str = "id, slug, name, issuer, client_id, client_secret, scopes, username_from, allowed_domains, create_users, link_by_email, enabled, created_at, updated_at, groups_claim, required_groups, end_session";
const SESSION: &str = "telepy_oidc_session";
const RULE: &str = "telepy_oidc_group_rule";
const GRANT: &str = "telepy_oidc_grant";

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
    /// 群組 claim 的路徑（`groups`、`roles`、`realm_access.roles`…）。/ The groups claim path.
    pub groups_claim: String,
    /// 「只有這些群組能登入」（JSON 陣列；空 = 不限）。/ Required groups (JSON array; empty = anyone).
    pub required_groups: String,
    /// 登出時一併登出身分提供者。/ Sign out at the provider too.
    pub end_session: bool,
}

impl Provider {
    pub fn required(&self) -> Vec<String> {
        serde_json::from_str(&self.required_groups).unwrap_or_default()
    }

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
    pub groups_claim: &'a str,
    /// JSON 陣列。/ A JSON array.
    pub required_groups: &'a str,
    pub end_session: bool,
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
    Ok(sqlx::query(&format!("INSERT INTO {T} (slug, name, issuer, client_id, scopes, username_from, allowed_domains, create_users, link_by_email, enabled, created_at, updated_at, groups_claim, required_groups, end_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
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
        .bind(p.groups_claim)
        .bind(p.required_groups)
        .bind(p.end_session)
        .execute(&db.write)
        .await?
        .last_insert_rowid())
}

/// 整列換掉（secret 另外存）。/ Replace the row (the secret is stored separately).
pub async fn update(db: &Db, id: i64, p: &NewProvider<'_>) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET slug = ?, name = ?, issuer = ?, client_id = ?, scopes = ?, username_from = ?, allowed_domains = ?, create_users = ?, link_by_email = ?, enabled = ?, updated_at = ?, groups_claim = ?, required_groups = ?, end_session = ? WHERE id = ?"))
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
        .bind(p.groups_claim)
        .bind(p.required_groups)
        .bind(p.end_session)
        .bind(id)
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn set_secret(db: &Db, id: i64, sealed: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {T} SET client_secret = ?, updated_at = ? WHERE id = ?")).bind(sealed).bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}

/// 刪掉身分提供者，連結、群組規則與它給過什麼的紀錄一起刪（成員資格與管理員身分留著，變成一般的）。
/// Delete a provider with its links, group rules and grant records (the memberships themselves stay, as ordinary ones).
pub async fn delete(db: &Db, id: i64) -> sqlx::Result<u64> {
    sqlx::query("DELETE FROM social_account WHERE provider = ?").bind(link_key(id)).execute(&db.write).await?;
    sqlx::query(&format!("DELETE FROM {RULE} WHERE provider_id = ?")).bind(id).execute(&db.write).await?;
    sqlx::query(&format!("DELETE FROM {GRANT} WHERE provider_id = ?")).bind(id).execute(&db.write).await?;
    sqlx::query(&format!("DELETE FROM {SESSION} WHERE provider_id = ?")).bind(id).execute(&db.write).await?;
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

// ---------------------------------------------------------------- groups → roles

use crate::oidc::roles::{Rule, Target};
use std::collections::BTreeSet;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RuleRow {
    pub provider_id: i64,
    pub idp_group: String,
    pub target: String,
    pub group_id: Option<i64>,
}

impl RuleRow {
    pub fn rule(&self) -> Option<Rule> {
        Some(Rule { idp_group: self.idp_group.clone(), target: Target::from_parts(&self.target, self.group_id)? })
    }
}

pub async fn all_rules(db: &Db) -> sqlx::Result<Vec<RuleRow>> {
    sqlx::query_as(&format!("SELECT provider_id, idp_group, target, group_id FROM {RULE} ORDER BY provider_id, id")).fetch_all(&db.read).await
}

pub async fn rules(db: &Db, provider_id: i64) -> sqlx::Result<Vec<Rule>> {
    let rows: Vec<RuleRow> = sqlx::query_as(&format!("SELECT provider_id, idp_group, target, group_id FROM {RULE} WHERE provider_id = ? ORDER BY id")).bind(provider_id).fetch_all(&db.read).await?;
    Ok(rows.iter().filter_map(RuleRow::rule).collect())
}

/// 換掉一個提供者的整組規則。/ Replace a provider's rules.
pub async fn set_rules(db: &Db, provider_id: i64, rules: &[Rule]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {RULE} WHERE provider_id = ?")).bind(provider_id).execute(&mut *tx).await?;
    for r in rules {
        sqlx::query(&format!("INSERT INTO {RULE} (provider_id, idp_group, target, group_id) VALUES (?, ?, ?, ?)"))
            .bind(provider_id)
            .bind(&r.idp_group)
            .bind(r.target.kind())
            .bind(r.target.group_id())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 這個提供者給過這個人什麼。/ What this provider granted this person.
pub async fn granted(db: &Db, provider_id: i64, user_id: i64) -> sqlx::Result<BTreeSet<Target>> {
    let rows: Vec<(String, Option<i64>)> = sqlx::query_as(&format!("SELECT target, group_id FROM {GRANT} WHERE provider_id = ? AND user_id = ?")).bind(provider_id).bind(user_id).fetch_all(&db.read).await?;
    Ok(rows.into_iter().filter_map(|(k, g)| Target::from_parts(&k, g)).collect())
}

pub async fn record(db: &Db, provider_id: i64, user_id: i64, target: Target) -> sqlx::Result<()> {
    sqlx::query(&format!("INSERT OR IGNORE INTO {GRANT} (provider_id, user_id, target, group_id, created_at) VALUES (?, ?, ?, ?, ?)"))
        .bind(provider_id)
        .bind(user_id)
        .bind(target.kind())
        .bind(target.group_id())
        .bind(now_db())
        .execute(&db.write)
        .await?;
    Ok(())
}

pub async fn forget(db: &Db, provider_id: i64, user_id: i64, target: Target) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {GRANT} WHERE provider_id = ? AND user_id = ? AND target = ? AND IFNULL(group_id, 0) = ?"))
        .bind(provider_id)
        .bind(user_id)
        .bind(target.kind())
        .bind(target.group_id().unwrap_or(0))
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 使用者群組刪掉了：指向它的規則與紀錄一起走。/ A user group was deleted: its rules and grant records go too.
pub async fn forget_user_group(db: &Db, group_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {RULE} WHERE target = 'group' AND group_id = ?")).bind(group_id).execute(&db.write).await?;
    sqlx::query(&format!("DELETE FROM {GRANT} WHERE target = 'group' AND group_id = ?")).bind(group_id).execute(&db.write).await?;
    Ok(())
}

/// 單一登入給的成員資格：(group_id, user_id, 提供者名字)。/ Memberships a provider granted: (group, user, provider name).
pub async fn granted_memberships(db: &Db) -> sqlx::Result<Vec<(i64, i64, String)>> {
    sqlx::query_as(&format!("SELECT g.group_id, g.user_id, p.name FROM {GRANT} g JOIN {T} p ON p.id = g.provider_id WHERE g.target = 'group' ORDER BY g.group_id, g.user_id"))
        .fetch_all(&db.read)
        .await
}

/// 單一登入給的管理員：(user_id, 提供者名字)。/ Admin rights a provider granted: (user, provider name).
pub async fn granted_admins(db: &Db) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as(&format!("SELECT g.user_id, p.name FROM {GRANT} g JOIN {T} p ON p.id = g.provider_id WHERE g.target = 'admin' ORDER BY g.user_id")).fetch_all(&db.read).await
}

/// 除了這個人以外還有幾位啟用中的管理員。/ Active administrators other than this one.
pub async fn other_admins(db: &Db, user_id: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM auth_user WHERE is_superuser = 1 AND is_active = 1 AND id != ?").bind(user_id).fetch_one(&db.read).await
}

// ---------------------------------------------------------------- sign-out at the provider

/// 記下這個網頁登入是哪個身分提供者開的，以及它的 id_token（已封存）。/ Remember a web sign-in's provider and sealed id_token.
pub async fn set_session(db: &Db, session_id: i64, provider_id: i64, sealed_id_token: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("INSERT OR REPLACE INTO {SESSION} (session_id, provider_id, id_token, created_at) VALUES (?, ?, ?, ?)"))
        .bind(session_id)
        .bind(provider_id)
        .bind(sealed_id_token)
        .bind(now_db())
        .execute(&db.write)
        .await?;
    Ok(())
}

/// (provider_id, 封存的 id_token)。/ (provider id, sealed id_token).
pub async fn session(db: &Db, session_id: i64) -> sqlx::Result<Option<(i64, String)>> {
    sqlx::query_as(&format!("SELECT provider_id, id_token FROM {SESSION} WHERE session_id = ?")).bind(session_id).fetch_optional(&db.read).await
}

pub async fn forget_session(db: &Db, session_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {SESSION} WHERE session_id = ?")).bind(session_id).execute(&db.write).await?;
    Ok(())
}

/// 登入已經不在（登出、撤銷、到期）的就不用留 id_token。/ Drop id_tokens of sign-ins that are gone (logout, revoked, expired).
pub async fn purge_sessions(db: &Db) -> sqlx::Result<u64> {
    Ok(sqlx::query(&format!(
        "DELETE FROM {SESSION} WHERE session_id NOT IN (SELECT id FROM telepy_web_session WHERE revoked_at IS NULL AND expires_at > ?)"
    ))
    .bind(now_db())
    .execute(&db.write)
    .await?
    .rows_affected())
}
