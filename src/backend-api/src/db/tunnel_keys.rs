//! 每條隧道自己的服務金鑰（`telepy_tunnel_service_key`）與它裝到了哪些 OS 帳號（`telepy_tunnel_key_account`）。
//! 私鑰只存密文（`ssh::tunnel_keys` 用 vault 封 / 解）。邏輯在 `ssh::tunnel_keys` 與 `device_keys`。
//! One service key pair per tunnel (private key stored sealed) and the accounts it was installed in / verified at.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct TunnelKey {
    pub tunnel_id: i64,
    /// `type base64 comment`
    pub public_key: String,
    /// vault 密文。/ Sealed.
    pub private_key: String,
    pub fingerprint: String,
    pub created_at: String,
    /// 第一次用這把金鑰登入成功。/ First successful login with this key.
    pub verified_at: Option<String>,
}

/// 隧道金鑰在某個 OS 帳號的狀態。/ The tunnel key's state in one OS account.
#[derive(Debug, Clone, FromRow)]
pub struct KeyAccount {
    pub tunnel_id: i64,
    pub username: String,
    /// Telepy 把它寫進了 authorized_keys。/ Telepy wrote it into authorized_keys.
    pub installed_at: Option<String>,
    /// 用它登入這個帳號成功過。/ A login with it succeeded there.
    pub verified_at: Option<String>,
}

const COLS: &str = "tunnel_id, public_key, private_key, fingerprint, created_at, verified_at";

pub async fn get(db: &Db, tunnel_id: i64) -> sqlx::Result<Option<TunnelKey>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_tunnel_service_key WHERE tunnel_id = ?")).bind(tunnel_id).fetch_optional(&db.read).await
}

/// 新增（已經有就不動，回傳現有的）。/ Insert; an existing row wins.
pub async fn insert(db: &Db, tunnel_id: i64, public_key: &str, private_key_sealed: &str, fingerprint: &str) -> sqlx::Result<TunnelKey> {
    sqlx::query("INSERT INTO telepy_tunnel_service_key (tunnel_id, public_key, private_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tunnel_id) DO NOTHING")
        .bind(tunnel_id)
        .bind(public_key)
        .bind(private_key_sealed)
        .bind(fingerprint)
        .bind(now_db())
        .execute(&db.write)
        .await?;
    get(db, tunnel_id).await.map(|k| k.expect("row just inserted"))
}

pub async fn set_verified(db: &Db, tunnel_id: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_tunnel_service_key SET verified_at = ? WHERE tunnel_id = ? AND verified_at IS NULL").bind(now_db()).bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}

pub async fn delete(db: &Db, tunnel_id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_tunnel_service_key WHERE tunnel_id = ?").bind(tunnel_id).execute(&db.write).await?;
    sqlx::query("DELETE FROM telepy_tunnel_key_account WHERE tunnel_id = ?").bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}

/// 這把公鑰（`type base64` 前綴）是哪條隧道的服務金鑰。/ Which tunnel's service key this public key is.
pub async fn tunnel_by_key_prefix(db: &Db, like: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT tunnel_id FROM telepy_tunnel_service_key WHERE public_key LIKE ? ESCAPE '\\' LIMIT 1").bind(like).fetch_optional(&db.read).await
}

/// 全部隧道金鑰的公鑰（`type base64 comment`）。/ Every tunnel key's public line.
pub async fn all_public_keys(db: &Db) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as("SELECT tunnel_id, public_key FROM telepy_tunnel_service_key ORDER BY tunnel_id").fetch_all(&db.read).await
}

pub async fn accounts(db: &Db, tunnel_id: i64) -> sqlx::Result<Vec<KeyAccount>> {
    sqlx::query_as("SELECT tunnel_id, username, installed_at, verified_at FROM telepy_tunnel_key_account WHERE tunnel_id = ? ORDER BY username")
        .bind(tunnel_id)
        .fetch_all(&db.read)
        .await
}

pub async fn account(db: &Db, tunnel_id: i64, username: &str) -> sqlx::Result<Option<KeyAccount>> {
    sqlx::query_as("SELECT tunnel_id, username, installed_at, verified_at FROM telepy_tunnel_key_account WHERE tunnel_id = ? AND username = ?")
        .bind(tunnel_id)
        .bind(username)
        .fetch_optional(&db.read)
        .await
}

pub async fn mark_installed(db: &Db, tunnel_id: i64, username: &str) -> sqlx::Result<()> {
    let now = now_db();
    sqlx::query(
        "INSERT INTO telepy_tunnel_key_account (tunnel_id, username, installed_at) VALUES (?, ?, ?) \
         ON CONFLICT (tunnel_id, username) DO UPDATE SET installed_at = COALESCE(installed_at, excluded.installed_at)",
    )
    .bind(tunnel_id)
    .bind(username)
    .bind(&now)
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 用隧道金鑰登入成功：記下這個帳號已驗證（也算已裝——不管是誰放進去的）。回傳是否第一次。
/// A login with the tunnel key succeeded: the account is verified (and installed, whoever put it there). Returns whether new.
pub async fn mark_verified(db: &Db, tunnel_id: i64, username: &str) -> sqlx::Result<bool> {
    let now = now_db();
    let done = sqlx::query(
        "INSERT INTO telepy_tunnel_key_account (tunnel_id, username, installed_at, verified_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (tunnel_id, username) DO UPDATE SET installed_at = COALESCE(installed_at, excluded.installed_at), verified_at = excluded.verified_at \
         WHERE verified_at IS NULL",
    )
    .bind(tunnel_id)
    .bind(username)
    .bind(&now)
    .bind(&now)
    .execute(&db.write)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// 帳號被刪、或金鑰從裝置移掉：忘掉。/ Forget one account (deleted, or the key was removed from the device).
pub async fn forget_account(db: &Db, tunnel_id: i64, username: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_tunnel_key_account WHERE tunnel_id = ? AND username = ?").bind(tunnel_id).bind(username).execute(&db.write).await?;
    Ok(())
}
