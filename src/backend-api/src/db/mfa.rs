//! 兩步驟驗證的儲存：每位使用者一列（WebAuthn user handle、加密的 TOTP secret）、passkey、復原碼（只存雜湊）。
//! Two-factor storage: one row per user (WebAuthn user handle, encrypted TOTP secret), passkeys, hashed recovery codes.

use std::collections::HashSet;

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct MfaRow {
    pub user_id: i64,
    /// WebAuthn 的 user handle（UUID）；免帳號 passkey 登入時用它找回使用者。/ WebAuthn user handle.
    pub webauthn_user_id: String,
    /// 已啟用的 TOTP secret（`SecretBox` 加密）。/ Enabled TOTP secret, encrypted.
    pub totp_secret: Option<String>,
    /// 設定中、尚未用一組碼確認的 secret。/ Secret awaiting its first code.
    pub totp_pending_secret: Option<String>,
    pub totp_enabled_at: Option<String>,
    /// 最後一次接受的時間窗（防重放）。/ Last accepted time step (replay protection).
    pub totp_last_step: Option<i64>,
    pub updated_at: String,
}

impl MfaRow {
    pub fn totp_enabled(&self) -> bool {
        self.totp_secret.is_some() && self.totp_enabled_at.is_some()
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct PasskeyRow {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    /// base64url 的 credential id。/ base64url credential id.
    pub credential_id: String,
    /// webauthn-rs `Passkey` 的 JSON（含公鑰與計數器）。/ Serialised webauthn-rs `Passkey`.
    pub passkey: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

const M: &str = "telepy_user_mfa";
const M_COLS: &str = "user_id, webauthn_user_id, totp_secret, totp_pending_secret, totp_enabled_at, totp_last_step, updated_at";
const P: &str = "telepy_passkey";
const P_COLS: &str = "id, user_id, name, credential_id, passkey, created_at, last_used_at";
const R: &str = "telepy_recovery_code";

pub async fn get(db: &Db, user_id: i64) -> sqlx::Result<Option<MfaRow>> {
    sqlx::query_as(&format!("SELECT {M_COLS} FROM {M} WHERE user_id = ?")).bind(user_id).fetch_optional(&db.read).await
}

/// 沒有就建一列（配一個新的 WebAuthn user handle）。/ Get or create the row with a fresh user handle.
pub async fn ensure(db: &Db, user_id: i64) -> sqlx::Result<MfaRow> {
    sqlx::query(&format!("INSERT OR IGNORE INTO {M} (user_id, webauthn_user_id, updated_at) VALUES (?, ?, ?)"))
        .bind(user_id)
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(now_db())
        .execute(&db.write)
        .await?;
    sqlx::query_as(&format!("SELECT {M_COLS} FROM {M} WHERE user_id = ?")).bind(user_id).fetch_one(&db.write).await
}

pub async fn by_webauthn_user_id(db: &Db, handle: &str) -> sqlx::Result<Option<MfaRow>> {
    sqlx::query_as(&format!("SELECT {M_COLS} FROM {M} WHERE webauthn_user_id = ?")).bind(handle).fetch_optional(&db.read).await
}

pub async fn set_pending_totp(db: &Db, user_id: i64, sealed: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {M} SET totp_pending_secret = ?, updated_at = ? WHERE user_id = ?"))
        .bind(sealed)
        .bind(now_db())
        .bind(user_id)
        .execute(&db.write)
        .await?;
    Ok(())
}

/// 待確認的 secret 轉正，並記下確認時用掉的時間窗。/ Promote the pending secret; remember the step used.
pub async fn enable_totp(db: &Db, user_id: i64, step: i64) -> sqlx::Result<()> {
    let now = now_db();
    sqlx::query(&format!(
        "UPDATE {M} SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = ?, totp_last_step = ?, updated_at = ? \
         WHERE user_id = ? AND totp_pending_secret IS NOT NULL"
    ))
    .bind(&now)
    .bind(step)
    .bind(&now)
    .bind(user_id)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 記下用掉的時間窗；只有比上次新才成功（並行的兩次相同碼只會有一次過）。
/// Compare-and-set of the last step, so two concurrent uses of one code cannot both pass.
pub async fn claim_totp_step(db: &Db, user_id: i64, step: i64) -> sqlx::Result<bool> {
    let n = sqlx::query(&format!("UPDATE {M} SET totp_last_step = ? WHERE user_id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)"))
        .bind(step)
        .bind(user_id)
        .bind(step)
        .execute(&db.write)
        .await?
        .rows_affected();
    Ok(n == 1)
}

pub async fn disable_totp(db: &Db, user_id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "UPDATE {M} SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE user_id = ?"
    ))
    .bind(now_db())
    .bind(user_id)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 管理員重設：TOTP、passkey、復原碼全部清掉（WebAuthn user handle 保留）。/ Admin reset of every factor.
pub async fn reset(db: &Db, user_id: i64) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!(
        "UPDATE {M} SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE user_id = ?"
    ))
    .bind(now_db())
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!("DELETE FROM {P} WHERE user_id = ?")).bind(user_id).execute(&mut *tx).await?;
    sqlx::query(&format!("DELETE FROM {R} WHERE user_id = ?")).bind(user_id).execute(&mut *tx).await?;
    tx.commit().await
}

// ---------------------------------------------------------------- passkeys

pub async fn passkeys_for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<PasskeyRow>> {
    sqlx::query_as(&format!("SELECT {P_COLS} FROM {P} WHERE user_id = ? ORDER BY id")).bind(user_id).fetch_all(&db.read).await
}

pub async fn passkey_by_id(db: &Db, id: i64) -> sqlx::Result<Option<PasskeyRow>> {
    sqlx::query_as(&format!("SELECT {P_COLS} FROM {P} WHERE id = ?")).bind(id).fetch_optional(&db.read).await
}

pub async fn passkey_create(db: &Db, user_id: i64, name: &str, credential_id: &str, passkey_json: &str) -> sqlx::Result<PasskeyRow> {
    let id = sqlx::query(&format!("INSERT INTO {P} (user_id, name, credential_id, passkey, created_at) VALUES (?, ?, ?, ?, ?)"))
        .bind(user_id)
        .bind(name)
        .bind(credential_id)
        .bind(passkey_json)
        .bind(now_db())
        .execute(&db.write)
        .await?
        .last_insert_rowid();
    Ok(passkey_by_id(db, id).await?.expect("passkey just inserted"))
}

/// 用過之後：更新 last_used_at，有新的計數器就一併存。/ After a use: last_used_at and, when changed, the counter.
pub async fn passkey_used(db: &Db, id: i64, updated_json: Option<&str>) -> sqlx::Result<()> {
    match updated_json {
        Some(j) => sqlx::query(&format!("UPDATE {P} SET passkey = ?, last_used_at = ? WHERE id = ?")).bind(j).bind(now_db()).bind(id).execute(&db.write).await?,
        None => sqlx::query(&format!("UPDATE {P} SET last_used_at = ? WHERE id = ?")).bind(now_db()).bind(id).execute(&db.write).await?,
    };
    Ok(())
}

pub async fn passkey_rename(db: &Db, id: i64, name: &str) -> sqlx::Result<()> {
    sqlx::query(&format!("UPDATE {P} SET name = ? WHERE id = ?")).bind(name).bind(id).execute(&db.write).await?;
    Ok(())
}

pub async fn passkey_delete(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query(&format!("DELETE FROM {P} WHERE id = ?")).bind(id).execute(&db.write).await?;
    Ok(())
}

// ---------------------------------------------------------------- recovery codes

/// 整組換新（舊的全部作廢）。/ Replace the whole set.
pub async fn recovery_replace(db: &Db, user_id: i64, hashes: &[String]) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    sqlx::query(&format!("DELETE FROM {R} WHERE user_id = ?")).bind(user_id).execute(&mut *tx).await?;
    let now = now_db();
    for h in hashes {
        sqlx::query(&format!("INSERT INTO {R} (user_id, code_hash, created_at) VALUES (?, ?, ?)"))
            .bind(user_id)
            .bind(h)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

/// 用掉一組（每組只能用一次）。/ Consume one code (single use).
pub async fn recovery_consume(db: &Db, user_id: i64, hash: &str) -> sqlx::Result<bool> {
    let n = sqlx::query(&format!("UPDATE {R} SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL"))
        .bind(now_db())
        .bind(user_id)
        .bind(hash)
        .execute(&db.write)
        .await?
        .rows_affected();
    Ok(n == 1)
}

pub async fn recovery_remaining(db: &Db, user_id: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {R} WHERE user_id = ? AND used_at IS NULL")).bind(user_id).fetch_one(&db.read).await
}

/// 已啟用 2FA 的使用者（管理員的使用者列表用）。/ Users with any second factor (for the admin list).
pub async fn users_with_mfa(db: &Db) -> sqlx::Result<HashSet<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar(&format!(
        "SELECT user_id FROM {M} WHERE totp_enabled_at IS NOT NULL UNION SELECT DISTINCT user_id FROM {P}"
    ))
    .fetch_all(&db.read)
    .await?;
    Ok(ids.into_iter().collect())
}
