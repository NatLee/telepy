//! `/api/log/ssh`：SSH 伺服器日誌最後 500 行（JSON 字串；前端會自行 unwrap）。

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::Value;

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/log/ssh", get(ssh_logs))
}

/// Python：`'\n'.join(f.readlines()[-500:])`（每行自帶換行，所以是雙換行分隔）。
pub fn tail_joined(content: &str, n: usize) -> String {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

async fn ssh_logs(State(state): State<AppState>, AuthUser(_): AuthUser) -> ApiResult<Json<Value>> {
    let path = state.config.ssh_logs_path.clone();
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => Ok(Json(Value::String(tail_joined(&content, 500)))),
        Err(_) => Err(ApiError::new(StatusCode::NOT_FOUND, Value::String("Logs not found".into()))),
    }
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
