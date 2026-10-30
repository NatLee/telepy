//! `GET /api/whoami`：回傳「呼叫者自己的 IP」（純文字），依 X-Forwarded-For（`TRUSTED_PROXY_HOPS`）判定。
//! 裝置用它得知自己的公網 IP，不必呼叫第三方服務（`device_info` 登入裝置時讓它 curl 這裡）。只回呼叫者自己的位址。
//! `GET /api/auth/client-ip-check`（管理員）：同一個判定攤開來看——每一段代理、相關標頭、選中哪一段、該怎麼設。
//! Returns the caller's own IP as plain text, resolved like the sign-in history. Devices use it to learn their
//! public IP without a third-party service. The admin-only check spells the same resolution out step by step.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::AuthUser;
use crate::client_ip::{diagnose_with, ClientMeta};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(whoami)).routes(routes!(client_ip_check))
}

#[utoipa::path(get, path = "/api/whoami", tag = "Network", responses((status = 200, description = "Your IP address as Telepy sees it (text/plain, empty when unknown). Devices use it to learn their public IP without a third-party service.", content_type = "text/plain", body = String)))]
async fn whoami(meta: ClientMeta) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::CACHE_CONTROL, "no-store")],
        format!("{}\n", meta.ip.unwrap_or_default()),
    )
}

#[utoipa::path(get, path = "/api/auth/client-ip-check", tag = "Network", security(("bearer" = [])), responses(
    (status = 200, description = "How Telepy resolved this request's address (superusers): every hop of X-Forwarded-For plus the socket peer, related headers, TRUSTED_PROXY_HOPS / CLIENT_IP_HEADER, the chosen entry and a verdict with a suggestion", body = super::schemas::ClientIpCheck),
    (status = 403, body = super::schemas::ErrorBody)
))]
async fn client_ip_check(State(state): State<AppState>, AuthUser(me): AuthUser, parts: axum::http::request::Parts) -> ApiResult<impl IntoResponse> {
    if !me.is_superuser {
        return Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Only administrators can run this check.", "code": "admin_only" })));
    }
    let cfg = &state.config;
    let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    // 生效的設定（環境變數 → 網站設定 → 預設）。/ The settings in effect (env → site setting → default).
    let hops = cfg.client_ip_hops();
    let header = cfg.client_ip_header_name();
    let d = diagnose_with(&parts.headers, peer, hops, header.as_deref(), cfg.client_ip_cloudflare());
    let body: Value = json!({
        "ip": d.ip,
        "scope": d.scope,
        "from": d.from,
        "geo": d.ip.as_deref().map(|ip| state.geoip.json(Some(ip))),
        // auto = 內部位址都算代理（trusted_proxy_hops 為 null）；fixed = 固定層數。/ auto (hops null) or fixed.
        "hops_mode": if hops.fixed().is_some() { "fixed" } else { "auto" },
        "trusted_proxy_hops": hops.fixed(),
        "skipped_hops": d.skipped_hops,
        "client_ip_header": header,
        // 每個值是誰決定的（env / setting / default）。/ Which layer decides each value.
        "sources": {
            "client_ip_hops": cfg.effective("client_ip_hops").1.as_str(),
            "client_ip_header": cfg.effective("client_ip_header").1.as_str(),
            "client_ip_cloudflare": cfg.effective("client_ip_cloudflare").1.as_str(),
        },
        "cloudflare": d.cloudflare,
        "hints": d.hints,
        "chain": d.chain,
        "headers": d.headers.iter().map(|h| json!({
            "name": h.name,
            "value": h.value,
            "addresses": h.addresses.iter().map(|(ip, scope)| json!({"ip": ip, "scope": scope})).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "verdict": d.verdict,
        "suggest": { "trusted_proxy_hops": d.suggest_hops, "client_ip_header": d.suggest_header },
        "short_chain": d.short_chain,
        "header_absent": d.header_absent,
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)))
}
