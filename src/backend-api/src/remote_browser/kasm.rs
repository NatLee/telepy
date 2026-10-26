//! kasm-browser session-manager 的 HTTP client（services/kasm_client.py）。

use std::time::Duration;

use serde_json::{json, Value};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct KasmError(pub String);

#[derive(Clone)]
pub struct KasmClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl KasmClient {
    pub fn new(http: reqwest::Client, base: &str, token: &str) -> Self {
        Self { http, base: base.trim_end_matches('/').to_string(), token: token.to_string() }
    }

    /// `POST /sessions` → (session_id, ws_port)
    pub async fn create_session(
        &self,
        proxy: &str,
        geometry: &str,
        lang: Option<&str>,
        homepage: Option<&str>,
        timeout: Duration,
    ) -> Result<(String, u16), KasmError> {
        let mut payload = json!({ "proxy": proxy, "geometry": geometry });
        if let Some(l) = lang {
            payload["lang"] = json!(l);
        }
        if let Some(h) = homepage {
            payload["homepage"] = json!(h);
        }
        let resp = self
            .http
            .post(format!("{}/sessions", self.base))
            .header("X-Internal-Token", &self.token)
            .json(&payload)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| KasmError(format!("create_session failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(KasmError(format!("create_session failed: {status} {body}")));
        }
        let data: Value = resp.json().await.map_err(|e| KasmError(format!("create_session: bad JSON response: {e}")))?;
        let sid = data.get("session_id").and_then(|v| v.as_str()).map(str::to_string);
        let port = data.get("ws_port").and_then(|v| v.as_u64()).and_then(|p| u16::try_from(p).ok());
        match (sid, port) {
            (Some(s), Some(p)) => Ok((s, p)),
            _ => Err(KasmError(format!("create_session: incomplete response {data}"))),
        }
    }

    /// `POST /sessions/{id}/cdp`：在該 session 的 Chromium 上跑一個 DevTools 動作（session-manager 持有 CDP 連線，
    /// 後端從不直接碰 CDP）。回 session-manager 的 JSON；失敗（HTTP 錯誤、逾時、動作錯誤）回它的 `error`。
    /// Run one DevTools action on the session's Chromium through the session-manager (the backend never talks CDP
    /// itself). Returns its JSON, or the `error` it reported.
    pub async fn cdp(&self, session_id: &str, action: Value, timeout: Duration) -> Result<Value, KasmError> {
        let resp = self
            .http
            .post(format!("{}/sessions/{session_id}/cdp", self.base))
            .header("X-Internal-Token", &self.token)
            .json(&action)
            .timeout(timeout + Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| KasmError(format!("browser action failed: {e}")))?;
        let status = resp.status();
        let data: Value = resp.json().await.map_err(|e| KasmError(format!("browser action: bad JSON response ({status}): {e}")))?;
        if !status.is_success() {
            let msg = data.get("error").and_then(Value::as_str).unwrap_or("unknown error");
            return Err(KasmError(format!("browser action failed ({status}): {msg}")));
        }
        Ok(data)
    }

    /// `DELETE /sessions/{id}`，best-effort。
    pub async fn stop_session(&self, session_id: &str) {
        let r = self
            .http
            .delete(format!("{}/sessions/{session_id}", self.base))
            .header("X-Internal-Token", &self.token)
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        if let Err(e) = r {
            tracing::warn!(session_id, error = %e, "kasm stop_session failed");
        }
    }
}
