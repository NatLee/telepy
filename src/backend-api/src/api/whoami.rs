//! `GET /api/whoami`：回傳「呼叫者自己的 IP」（純文字），依 X-Forwarded-For（`TRUSTED_PROXY_HOPS`）判定。
//! 裝置用它得知自己的公網 IP，不必呼叫第三方服務（`device_info` 登入裝置時讓它 curl 這裡）。只回呼叫者自己的位址。
//! Returns the caller's own IP as plain text, resolved like the sign-in history. Devices use it to learn their
//! public IP without a third-party service.

use axum::http::header;
use axum::response::IntoResponse;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::client_ip::ClientMeta;
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(whoami))
}

#[utoipa::path(get, path = "/api/whoami", tag = "Network", responses((status = 200, description = "Your IP address as Telepy sees it (text/plain, empty when unknown). Devices use it to learn their public IP without a third-party service.", content_type = "text/plain", body = String)))]
async fn whoami(meta: ClientMeta) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::CACHE_CONTROL, "no-store")],
        format!("{}\n", meta.ip.unwrap_or_default()),
    )
}
