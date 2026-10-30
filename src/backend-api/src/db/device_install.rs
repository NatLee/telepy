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
    /// 一鍵加入腳本偵測到的環境（`join::parse_facts` 的 JSON）。/ What the join script found (JSON from `join::parse_facts`).
    pub join_facts: Option<String>,
    pub join_facts_at: Option<String>,
}

const COLS: &str = "tunnel_id, install_id, created_at, survey, surveyed_at, survey_error, renamed_at, renamed_from, join_facts, join_facts_at";

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

/// 記下一鍵加入腳本回報的環境（每次加入 / 重新加入都覆蓋）。/ Store what the join script found (overwritten on every join).
pub async fn record_join_facts(db: &Db, tunnel_id: i64, facts_json: &str) -> sqlx::Result<()> {
    ensure(db, tunnel_id).await?;
    sqlx::query("UPDATE telepy_device_install SET join_facts = ?, join_facts_at = ? WHERE tunnel_id = ?").bind(facts_json).bind(now_db()).bind(tunnel_id).execute(&db.write).await?;
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

pub async fn delete(db: &Db, tunnel_id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM telepy_device_install WHERE tunnel_id = ?").bind(tunnel_id).execute(&db.write).await?;
    Ok(())
}
