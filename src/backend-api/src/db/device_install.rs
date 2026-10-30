//! `telepy_device_install`：每條隧道在裝置上用的安裝代號，與最近一次盤點（裝置上跑這條隧道的是什麼）。
//! 邏輯在 `crate::device_install`。/ A tunnel's install id on its device and the latest survey; logic in `crate::device_install`.

use std::collections::HashMap;

use sqlx::FromRow;

use super::Db;
use crate::util::now_db;

#[derive(Debug, Clone, FromRow)]
pub struct Row {
    pub tunnel_id: i64,
    pub install_id: String,
    pub created_at: String,
    /// `[AccountResult]` JSON（`tunnel_service::survey`）。
    pub survey: Option<String>,
    pub surveyed_at: Option<String>,
    pub survey_error: Option<String>,
    pub renamed_at: Option<String>,
    /// 改名前的服務名稱（JSON 字串陣列）。/ The service names before the rename (JSON array).
    pub renamed_from: Option<String>,
}

const COLS: &str = "tunnel_id, install_id, created_at, survey, surveyed_at, survey_error, renamed_at, renamed_from";

pub async fn get(db: &Db, tunnel_id: i64) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM telepy_device_install WHERE tunnel_id = ?")).bind(tunnel_id).fetch_optional(&db.read).await
}

/// 隧道的安裝代號；還沒有就產生一個（撞到就重抽）。/ The tunnel's install id, made on first use (redrawn on a clash).
pub async fn ensure(db: &Db, tunnel_id: i64) -> sqlx::Result<String> {
    if let Some(r) = get(db, tunnel_id).await? {
        return Ok(r.install_id);
    }
    for _ in 0..8 {
        let id = crate::device_install::names::new_id();
        // 刪掉的隧道用過的代號不再發（裝置上可能還留著它的東西）。/ Never reissue a deleted tunnel's id.
        if is_retired(db, &id).await? {
            continue;
        }
        let r = sqlx::query("INSERT INTO telepy_device_install (tunnel_id, install_id, created_at) VALUES (?, ?, ?) ON CONFLICT (tunnel_id) DO NOTHING")
            .bind(tunnel_id)
            .bind(&id)
            .bind(now_db())
            .execute(&db.write)
            .await;
        match r {
            Ok(_) => break,
            Err(e) if crate::error::is_unique_violation(&e) => continue,
            Err(e) => return Err(e),
        }
    }
    get(db, tunnel_id).await?.map(|r| r.install_id).ok_or(sqlx::Error::RowNotFound)
}

/// 每條有代號的隧道 → 那一列（列表用）。/ tunnel → its row, for list items.
pub async fn all(db: &Db) -> sqlx::Result<HashMap<i64, Row>> {
    let rows: Vec<Row> = sqlx::query_as(&format!("SELECT {COLS} FROM telepy_device_install")).fetch_all(&db.read).await?;
    Ok(rows.into_iter().map(|r| (r.tunnel_id, r)).collect())
}

/// 用代號找隧道（裝置管理員看到 `telepy-k7m2q9xd.service` 時）。/ The tunnel an install id belongs to.
pub async fn tunnel_by_install_id(db: &Db, install_id: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT tunnel_id FROM telepy_device_install WHERE install_id = ?").bind(install_id).fetch_optional(&db.read).await
}

/// 存盤點結果（失敗只記錯誤，保留上次看到的）。/ Store a survey; a failed one keeps the previous result.
pub async fn record_survey(db: &Db, tunnel_id: i64, survey: Option<&str>, error: Option<&str>) -> sqlx::Result<()> {
    ensure(db, tunnel_id).await?;
    match survey {
        Some(json) => {
            sqlx::query("UPDATE telepy_device_install SET survey = ?, surveyed_at = ?, survey_error = ? WHERE tunnel_id = ?").bind(json).bind(now_db()).bind(error).bind(tunnel_id).execute(&db.write).await?;
        }
        None => {
            sqlx::query("UPDATE telepy_device_install SET surveyed_at = ?, survey_error = ? WHERE tunnel_id = ?").bind(now_db()).bind(error).bind(tunnel_id).execute(&db.write).await?;
        }
    }
    Ok(())
}

pub async fn record_rename(db: &Db, tunnel_id: i64, from: &[String]) -> sqlx::Result<()> {
    let from = serde_json::to_string(from).unwrap_or_else(|_| "[]".into());
    sqlx::query("UPDATE telepy_device_install SET renamed_at = ?, renamed_from = ? WHERE tunnel_id = ?").bind(now_db()).bind(from).bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}

/// 還沒盤點過，或上次盤點超過 `older_than_days` 天。/ Never surveyed, or not within `older_than_days`.
pub async fn survey_due(db: &Db, tunnel_id: i64, older_than_days: i64) -> sqlx::Result<bool> {
    let at: Option<Option<String>> = sqlx::query_scalar("SELECT surveyed_at FROM telepy_device_install WHERE tunnel_id = ?").bind(tunnel_id).fetch_optional(&db.read).await?;
    let Some(Some(at)) = at else { return Ok(true) };
    let cutoff = crate::util::db_time(chrono::Utc::now() - chrono::Duration::days(older_than_days));
    Ok(at < cutoff)
}

/// 刪掉的隧道留下的代號（帳本裡的一列）。/ An install id of a deleted tunnel (a ledger row).
#[derive(Debug, Clone, FromRow)]
pub struct Retired {
    pub install_id: String,
    pub tunnel_id: i64,
    pub tunnel_name: String,
    pub user_id: i64,
    pub retired_at: String,
}

/// 隧道刪除時：代號記進帳本，再刪這一列。/ On tunnel delete: put the id in the ledger, then drop the row.
pub async fn retire(db: &Db, tunnel_id: i64, tunnel_name: &str, user_id: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO telepy_device_install_retired (install_id, tunnel_id, tunnel_name, user_id, retired_at)
         SELECT install_id, tunnel_id, ?, ?, ? FROM telepy_device_install WHERE tunnel_id = ?
         ON CONFLICT (install_id) DO NOTHING",
    )
    .bind(tunnel_name)
    .bind(user_id)
    .bind(now_db())
    .bind(tunnel_id)
    .execute(&db.write)
    .await?;
    sqlx::query("DELETE FROM telepy_device_install WHERE tunnel_id = ?").bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}

/// 帳本裡的這些代號。/ Ledger rows for these ids.
pub async fn retired(db: &Db, ids: &[String]) -> sqlx::Result<HashMap<String, Retired>> {
    let mut out = HashMap::new();
    for id in ids {
        if let Some(r) = sqlx::query_as::<_, Retired>("SELECT install_id, tunnel_id, tunnel_name, user_id, retired_at FROM telepy_device_install_retired WHERE install_id = ?")
            .bind(id)
            .fetch_optional(&db.read)
            .await?
        {
            out.insert(id.clone(), r);
        }
    }
    Ok(out)
}

async fn is_retired(db: &Db, id: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telepy_device_install_retired WHERE install_id = ?").bind(id).fetch_one(&db.read).await?;
    Ok(n > 0)
}
