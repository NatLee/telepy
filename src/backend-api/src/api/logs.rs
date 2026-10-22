//! `/api/log/ssh`：SSH 伺服器日誌。
//! - gateway 模式（預設）：從 `telepy_gateway_event` 渲染最後 500 筆成 sshd 風格文字行（JSON 字串，前端 unwrap），
//!   沒有事件時回空字串（200），不再 404。
//! - 外接 sshd 模式：讀 `SSH_LOGS_PATH` 的文字檔最後 500 行（舊行為）。
//! `/api/log/ssh/events`：結構化事件（JSON 陣列），給新版 Logs 頁與自動化用。

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use sqlx::FromRow;

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::db_to_iso;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/log/ssh", get(ssh_logs))
        .route("/api/log/ssh/events", get(ssh_events))
}

#[derive(Debug, FromRow)]
pub struct GatewayEvent {
    pub id: i64,
    pub at: String,
    pub event: String,
    pub peer: Option<String>,
    pub port: Option<i64>,
    pub tunnel_id: Option<i64>,
    pub message: String,
}

/// Python：`'\n'.join(f.readlines()[-500:])`（每行自帶換行，所以是雙換行分隔）。
pub fn tail_joined(content: &str, n: usize) -> String {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

async fn recent_events(state: &AppState, limit: i64, tunnel_id: Option<i64>) -> sqlx::Result<Vec<GatewayEvent>> {
    let limit = limit.clamp(1, 5000);
    let rows: Vec<GatewayEvent> = match tunnel_id {
        Some(t) => sqlx::query_as("SELECT id, at, event, peer, port, tunnel_id, message FROM telepy_gateway_event WHERE tunnel_id = ? ORDER BY id DESC LIMIT ?")
            .bind(t)
            .bind(limit)
            .fetch_all(&state.db.read)
            .await?,
        None => sqlx::query_as("SELECT id, at, event, peer, port, tunnel_id, message FROM telepy_gateway_event ORDER BY id DESC LIMIT ?")
            .bind(limit)
            .fetch_all(&state.db.read)
            .await?,
    };
    Ok(rows.into_iter().rev().collect())
}

/// sshd 風格文字行：`YYYY-MM-DD HH:MM:SS.ffffff  message`（Logs 頁的 regex 吃這個格式）。
fn render_line(e: &GatewayEvent, tz: i32) -> String {
    let ts = match crate::util::parse_db_datetime(&e.at) {
        Some(naive) => {
            let offset = chrono::FixedOffset::east_opt(tz * 60).unwrap_or_else(|| chrono::FixedOffset::east_opt(0).unwrap());
            chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc).with_timezone(&offset).format("%Y-%m-%d %H:%M:%S%.6f").to_string()
        }
        None => e.at.clone(),
    };
    format!("{ts}  {}", e.message)
}

async fn ssh_logs(State(state): State<AppState>, AuthUser(_): AuthUser) -> ApiResult<Json<Value>> {
    if state.config.gateway_enabled {
        let events = recent_events(&state, 500, None).await?;
        let tz = state.config.tz_offset_minutes;
        let text = events.iter().map(|e| render_line(e, tz)).collect::<Vec<_>>().join("\n");
        return Ok(Json(Value::String(text)));
    }
    let path = state.config.ssh_logs_path.clone();
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => Ok(Json(Value::String(tail_joined(&content, 500)))),
        Err(_) => Err(ApiError::new(StatusCode::NOT_FOUND, Value::String("Logs not found".into()))),
    }
}

/// `?limit=` (default 200, max 5000) `&tunnel_id=`
async fn ssh_events(State(state): State<AppState>, AuthUser(_): AuthUser, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let limit = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(200);
    let tunnel_id = q.get("tunnel_id").and_then(|v| v.parse().ok());
    let events = recent_events(&state, limit, tunnel_id).await?;
    let tz = state.config.tz_offset_minutes;
    Ok(Json(Value::Array(
        events
            .iter()
            .map(|e| json!({
                "id": e.id,
                "at": db_to_iso(&e.at, tz),
                "event": e.event,
                "peer": e.peer,
                "port": e.port,
                "tunnel_id": e.tunnel_id,
                "message": e.message,
            }))
            .collect(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_matches_python_join() {
        assert_eq!(tail_joined("a\nb\nc\n", 2), "b\n\nc\n");
        assert_eq!(tail_joined("a\nb", 5), "a\n\nb");
        assert_eq!(tail_joined("", 5), "");
    }
}
