//! 長請求在自己的 task 裡跑完：刪通道、盤點 / 改名 / 換連線方式都要一兩分鐘，前面的代理（Nginx 預設 60 s、
//! Nginx Proxy Manager 約 90 s、Cloudflare 100 s）會先放棄這個請求回 504。axum 在連線斷掉時直接丟掉 handler 的 future，
//! 做到一半的刪除或交接就停在半路。這裡把工作交給 `tokio::spawn`：請求斷了工作照樣做完。
//! 瀏覽器在 `X-Telepy-Request` 帶一個自己產生的代號時，做完會送 `REQUEST-FINISHED {request, what, tunnel_id, status,
//! body}` 給發出請求的人（body 就是原本的回應），前端 `lib/longRequest.ts` 在請求被切斷時等它。
//!
//! Long requests run to the end in their own task: deleting a tunnel and surveying / renaming / switching a device's
//! service take a minute or two, and a proxy in front gives up first with a 504 (Nginx 60 s by default, Nginx Proxy
//! Manager ~90 s, Cloudflare 100 s). axum drops the handler's future when the connection goes, which stopped a delete or
//! a handover halfway. The work is spawned instead, so a cut request still finishes. When the browser sent its own id in
//! `X-Telepy-Request`, the person gets `REQUEST-FINISHED {request, what, tunnel_id, status, body}` (body = the response
//! it would have had); the frontend's `lib/longRequest.ts` waits for it when its request was cut.

use std::future::Future;

use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// 瀏覽器給這個請求的代號。/ The header with the browser's id for this request.
pub const REQUEST_HEADER: &str = "x-telepy-request";

/// 代號：1–64 個英數字、`-`、`_`；其他的當沒帶。純函式。/ The request id: 1–64 of `[A-Za-z0-9_-]`, else none. Pure.
pub fn request_id(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(REQUEST_HEADER)?.to_str().ok()?.trim();
    let ok = !raw.is_empty() && raw.len() <= 64 && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then(|| raw.to_string())
}

/// 做完的通知：狀態碼與原本的回應 body。純函式。/ The finish notification: the status and the response body. Pure.
pub fn finished_message(request: &str, what: &str, tunnel_id: Option<i64>, result: &ApiResult<Json<Value>>) -> Value {
    let (status, body) = match result {
        Ok(Json(v)) => (200, v.clone()),
        Err(e) => (e.status.as_u16(), e.body.clone()),
    };
    json!({ "action": "REQUEST-FINISHED", "request": request, "what": what, "tunnel_id": tunnel_id, "status": status, "body": body })
}

/// 在自己的 task 裡跑 `work`，等它做完回傳它的結果；請求被切斷時 task 照樣跑完，做完通知 `user_id`（有代號時）。
/// Run `work` in its own task and return its result; a cut request does not stop it, and `user_id` is told when it ends
/// (when the browser sent an id).
pub async fn run<F>(state: &AppState, user_id: i64, headers: &HeaderMap, what: &'static str, tunnel_id: Option<i64>, work: F) -> ApiResult<Json<Value>>
where
    F: Future<Output = ApiResult<Json<Value>>> + Send + 'static,
{
    let request = request_id(headers);
    let hub = state.hub.clone();
    let task = tokio::spawn(async move {
        let result = work.await;
        if let Some(id) = request {
            hub.notify_users([user_id], &finished_message(&id, what, tunnel_id, &result));
        }
        result
    });
    match task.await {
        Ok(result) => result,
        Err(e) => {
            tracing::error!(what, error = %e, "a detached request's task failed");
            Err(ApiError::internal(format!("The work stopped unexpectedly: {e}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderValue, StatusCode};

    fn headers(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(REQUEST_HEADER, HeaderValue::from_str(v).unwrap());
        h
    }

    #[test]
    fn request_ids_are_short_safe_words() {
        assert_eq!(request_id(&headers("r-1a_B")).as_deref(), Some("r-1a_B"));
        assert_eq!(request_id(&headers(" abc ")).as_deref(), Some("abc"));
        assert_eq!(request_id(&headers("")), None);
        assert_eq!(request_id(&headers("a b")), None);
        assert_eq!(request_id(&headers("<script>")), None);
        assert_eq!(request_id(&headers(&"x".repeat(65))), None);
        assert_eq!(request_id(&HeaderMap::new()), None);
    }

    #[test]
    fn the_finish_message_carries_the_response() {
        let ok: ApiResult<Json<Value>> = Ok(Json(json!({ "deleted": true })));
        let m = finished_message("r1", "tunnel.delete", Some(7), &ok);
        assert_eq!(m["action"], "REQUEST-FINISHED");
        assert_eq!(m["status"], 200);
        assert_eq!(m["body"]["deleted"], true);
        assert_eq!(m["tunnel_id"], 7);
        let err: ApiResult<Json<Value>> = Err(ApiError::error(StatusCode::CONFLICT, "busy"));
        let m = finished_message("r1", "device_install.rename", None, &err);
        assert_eq!(m["status"], 409);
        assert_eq!(m["body"]["error"], "busy");
        assert!(m["tunnel_id"].is_null());
    }
}
