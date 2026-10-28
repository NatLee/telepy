//! 站內通知偏好的三張表（規則在 `crate::notify_prefs`）。/ The three tables behind `crate::notify_prefs`.

use super::Db;
use crate::util::now_db;

/// 全站預設的一列。/ One site-default row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DefaultRow {
    pub event: String,
    pub channel: String,
    pub enabled: Option<bool>,
    pub locked: bool,
}

/// 個人覆寫的一列。/ One personal override.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PrefRow {
    pub event: String,
    pub channel: String,
    pub enabled: bool,
}

/// 一條隧道的靜音（附隧道名稱）。/ A tunnel mute, with the tunnel's name.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MuteRow {
    pub tunnel_id: i64,
    pub scope: String,
    pub tunnel_name: String,
}

pub async fn defaults(db: &Db) -> sqlx::Result<Vec<DefaultRow>> {
    sqlx::query_as("SELECT event, channel, enabled, locked FROM telepy_notify_default").fetch_all(&db.read).await
}

/// 設全站的開 / 關（None = 回到內建），保留鎖。/ Set a site value (None = built-in), keeping the lock.
pub async fn set_default(db: &Db, event: &str, channel: &str, enabled: Option<bool>) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO telepy_notify_default (event, channel, enabled, locked, updated_at) VALUES (?, ?, ?, 0, ?) \
         ON CONFLICT (event, channel) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
    )
    .bind(event)
    .bind(channel)
    .bind(enabled)
    .bind(now_db())
    .execute(&db.write)
    .await?;
    Ok(())
}

/// 鎖 / 解鎖一個事件（每個管道都設）。/ Lock or unlock an event (on every channel row).
pub async fn set_locked(db: &Db, event: &str, channels: &[&str], locked: bool) -> sqlx::Result<()> {
    for ch in channels {
        sqlx::query(
            "INSERT INTO telepy_notify_default (event, channel, enabled, locked, updated_at) VALUES (?, ?, NULL, ?, ?) \
             ON CONFLICT (event, channel) DO UPDATE SET locked = excluded.locked, updated_at = excluded.updated_at",
        )
        .bind(event)
        .bind(ch)
        .bind(locked)
        .bind(now_db())
        .execute(&db.write)
        .await?;
    }
    Ok(())
}

pub async fn prefs(db: &Db, user_id: i64) -> sqlx::Result<Vec<PrefRow>> {
    sqlx::query_as("SELECT event, channel, enabled FROM telepy_notify_pref WHERE user_id = ?").bind(user_id).fetch_all(&db.read).await
}

/// 設我的值；None = 刪掉（繼承）。/ Set my value; None deletes it (inherit).
pub async fn set_pref(db: &Db, user_id: i64, event: &str, channel: &str, enabled: Option<bool>) -> sqlx::Result<()> {
    match enabled {
        None => {
            sqlx::query("DELETE FROM telepy_notify_pref WHERE user_id = ? AND event = ? AND channel = ?")
                .bind(user_id)
                .bind(event)
                .bind(channel)
                .execute(&db.write)
                .await?;
        }
        Some(v) => {
            sqlx::query(
                "INSERT INTO telepy_notify_pref (user_id, event, channel, enabled, updated_at) VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT (user_id, event, channel) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
            )
            .bind(user_id)
            .bind(event)
            .bind(channel)
            .bind(v)
            .bind(now_db())
            .execute(&db.write)
            .await?;
        }
    }
    Ok(())
}

pub async fn mutes(db: &Db, user_id: i64) -> sqlx::Result<Vec<MuteRow>> {
    sqlx::query_as(
        "SELECT m.tunnel_id, m.scope, t.host_friendly_name AS tunnel_name FROM telepy_notify_tunnel_mute m \
         JOIN authorized_keys_reverseserverauthorizedkeys t ON t.id = m.tunnel_id WHERE m.user_id = ? ORDER BY t.host_friendly_name",
    )
    .bind(user_id)
    .fetch_all(&db.read)
    .await
}

pub async fn set_mute(db: &Db, user_id: i64, tunnel_id: i64, scope: Option<&str>) -> sqlx::Result<()> {
    match scope {
        None => {
            sqlx::query("DELETE FROM telepy_notify_tunnel_mute WHERE user_id = ? AND tunnel_id = ?").bind(user_id).bind(tunnel_id).execute(&db.write).await?;
        }
        Some(s) => {
            sqlx::query(
                "INSERT INTO telepy_notify_tunnel_mute (user_id, tunnel_id, scope, created_at) VALUES (?, ?, ?, ?) \
                 ON CONFLICT (user_id, tunnel_id) DO UPDATE SET scope = excluded.scope",
            )
            .bind(user_id)
            .bind(tunnel_id)
            .bind(s)
            .bind(now_db())
            .execute(&db.write)
            .await?;
        }
    }
    Ok(())
}
