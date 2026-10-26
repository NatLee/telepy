//! 憑證庫的資料表（`telepy_credential`）：每列是一個使用者為「某條隧道上的某個桌面」存的登入。
//! 綁定 = (隧道, 區網主機或裝置本身, 協定)；密碼只存密文（`vault`）。隧道 / 區網主機刪除時一併刪。
//! Saved desktop logins: one row per user and target (tunnel, LAN host or the device, protocol); the password
//! is stored sealed only. Deleted with the tunnel or the LAN host.

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct Credential {
    pub id: i64,
    pub user_id: i64,
    pub label: String,
    pub protocol: String,
    pub tunnel_id: i64,
    pub lan_host_id: Option<i64>,
    pub port: Option<i64>,
    pub login: String,
    pub domain: String,
    /// 密文（`v1:…`）。/ Sealed secret.
    pub secret: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
}

const COLS: &str = "id, user_id, label, protocol, tunnel_id, lan_host_id, port, login, domain, secret, created_at, updated_at, last_used_at";

pub async fn for_user(db: &Db, user_id: i64) -> sqlx::Result<Vec<Credential>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_credential WHERE user_id = ? ORDER BY tunnel_id, lan_host_id, label"))
        .bind(user_id)
        .fetch_all(&db.read)
        .await
}

pub async fn by_id(db: &Db, user_id: i64, id: i64) -> sqlx::Result<Option<Credential>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_credential WHERE id = ? AND user_id = ?")).bind(id).bind(user_id).fetch_optional(&db.read).await
}

pub struct NewCredential<'a> {
    pub user_id: i64,
    pub label: &'a str,
    pub protocol: &'a str,
    pub tunnel_id: i64,
    pub lan_host_id: Option<i64>,
    pub port: Option<i64>,
    pub login: &'a str,
    pub domain: &'a str,
}

/// 插入一列並在同一個 transaction 裡寫入密文（AAD 要用到新列的 id）。/ Insert, then seal with the new id's AAD.
pub async fn create(db: &Db, new: NewCredential<'_>, seal: impl FnOnce(i64) -> String) -> sqlx::Result<Credential> {
    let now = now_db();
    let mut tx = db.write.begin().await?;
    let id = sqlx::query(
        "INSERT INTO telepy_credential (user_id, label, protocol, tunnel_id, lan_host_id, port, login, domain, secret, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)",
    )
    .bind(new.user_id)
    .bind(new.label)
    .bind(new.protocol)
    .bind(new.tunnel_id)
    .bind(new.lan_host_id)
    .bind(new.port)
    .bind(new.login)
    .bind(new.domain)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    sqlx::query("UPDATE telepy_credential SET secret = ? WHERE id = ?").bind(seal(id)).bind(id).execute(&mut *tx).await?;
    let row = sqlx::query_as(&format!("SELECT {COLS} FROM telepy_credential WHERE id = ?")).bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(row)
}

pub struct CredentialPatch<'a> {
    pub label: Option<&'a str>,
    pub port: Option<Option<i64>>,
    pub login: Option<&'a str>,
    pub domain: Option<&'a str>,
    /// 新的密文（換密碼時）。/ New sealed secret, when the password changes.
    pub secret: Option<String>,
}

pub async fn update(db: &Db, id: i64, p: CredentialPatch<'_>) -> sqlx::Result<()> {
    let mut tx = db.write.begin().await?;
    if let Some(v) = p.label {
        sqlx::query("UPDATE telepy_credential SET label = ? WHERE id = ?").bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.port {
        sqlx::query("UPDATE telepy_credential SET port = ? WHERE id = ?").bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.login {
        sqlx::query("UPDATE telepy_credential SET login = ? WHERE id = ?").bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.domain {
        sqlx::query("UPDATE telepy_credential SET domain = ? WHERE id = ?").bind(v).bind(id).execute(&mut *tx).await?;
    }
    if let Some(v) = p.secret {
        sqlx::query("UPDATE telepy_credential SET secret = ? WHERE id = ?").bind(v).bind(id).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE telepy_credential SET updated_at = ? WHERE id = ?").bind(now_db()).bind(id).execute(&mut *tx).await?;
    tx.commit().await
}

pub async fn delete(db: &Db, user_id: i64, id: i64) -> sqlx::Result<bool> {
    Ok(sqlx::query("DELETE FROM telepy_credential WHERE id = ? AND user_id = ?").bind(id).bind(user_id).execute(&db.write).await?.rows_affected() > 0)
}

pub async fn touch_used(db: &Db, id: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE telepy_credential SET last_used_at = ? WHERE id = ?").bind(now_db()).bind(id).execute(&db.write).await?;
    Ok(())
}
