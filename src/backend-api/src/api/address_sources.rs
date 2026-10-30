//! `GET /api/site/address-sources`（管理員）：填「PROXY protocol 來源」時的選項。回答「要填什麼」——gateway 從
//! 啟動以來看到的來源位址（送過 PROXY header 的、內網的、已經列出的；其他公網位址是裝置或掃描器，只回數量），以及
//! 幾組常用的預設（本機、內網、Cloudflare Spectrum）。訪客位址標頭的選項在 `/api/auth/client-ip-check`（那次請求
//! 實際帶了哪些位址標頭）。
//! Options for "PROXY protocol sources" (superusers): the addresses the gateway has seen since it started (header
//! senders, private ones and listed ones; other public addresses are devices or scanners and only counted) plus a
//! few presets (this host, private networks, Cloudflare Spectrum). The visitor-header options come from
//! `/api/auth/client-ip-check` (the address headers that request actually carried).

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::SecondsFormat;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::geoip::{scope, Scope};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(address_sources))
}

/// 一鍵加入的預設（id 對應前端的說明文字）。/ One-click presets (the id picks the frontend's explanation).
pub fn presets() -> Value {
    json!([
        { "id": "loopback", "cidrs": ["127.0.0.1", "::1"] },
        { "id": "private", "cidrs": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"] },
        { "id": "cloudflare", "cidrs": crate::server_settings::CLOUDFLARE_RANGES },
    ])
}

#[utoipa::path(get, path = "/api/site/address-sources", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "Addresses the SSH gateway has seen since it started (PROXY header senders, private and listed ones; other public addresses only counted) and one-click presets for PROXY protocol sources (superusers)", body = super::schemas::AddressSources),
    (status = 403, body = super::schemas::ErrorBody)
))]
async fn address_sources(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Only administrators can see where connections come from.", "code": "admin_only" })));
    }
    let listed = state.config.proxy_protocol_from();
    let (seen, since) = state.gateway.peer_stats();
    let time = |t: chrono::DateTime<chrono::Utc>| t.to_rfc3339_opts(SecondsFormat::Secs, true);
    let mut peers = Vec::new();
    let mut other_public = 0u64;
    for (ip, s) in seen {
        let sc = scope(ip);
        let listed_now = listed.contains(ip);
        if sc == Scope::Public && s.proxy_headers == 0 && !listed_now {
            other_public += 1;
            continue;
        }
        peers.push(json!({
            "ip": ip.to_string(),
            "scope": sc.as_str(),
            "connections": s.connections,
            "proxy_headers": s.proxy_headers,
            "first_at": time(s.first_at),
            "last_at": time(s.last_at),
            "last_header_at": s.last_header_at.map(time),
            "listed": listed_now,
        }));
    }
    Ok(Json(json!({
        "since": time(since),
        "peers": peers,
        "other_public": other_public,
        "presets": presets(),
    })))
}

#[cfg(test)]
mod tests {
    #[test]
    fn presets_parse_and_fit_the_setting() {
        for p in super::presets().as_array().unwrap() {
            let cidrs: Vec<&str> = p["cidrs"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
            let spec = cidrs.join(", ");
            crate::gateway::proxy_protocol::Trusted::parse(&spec).unwrap_or_else(|e| panic!("{}: {e}", p["id"]));
            assert!(spec.len() <= 512, "{} does not fit the 512-character setting", p["id"]);
        }
    }
}
