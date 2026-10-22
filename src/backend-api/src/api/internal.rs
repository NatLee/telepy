//! `/api/reverse/internal/*`：服務間端點（Bearer INTERNAL_API_TOKEN）。
//! - `GET internal/keys?key_type&key`：sshd `AuthorizedKeysCommand` 用的金鑰反查（內建 gateway 之後
//!   仍保留，供外接 sshd 使用）。
//! - `POST internal/ss`、`POST internal/latency`：ssh 側取樣 push（過渡/備援來源）。

use std::collections::{BTreeSet, HashMap};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::auth::InternalService;
use crate::db::{self, tunnels::like_prefix};
use crate::error::ApiResult;
use crate::monitor::parse_ss_listen;
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(keys))
        .routes(routes!(push_ss))
        .routes(routes!(push_latency))
}

fn plain(body: String) -> Response {
    ([(header::CONTENT_TYPE, "text/plain")], body).into_response()
}

/// `InternalKeysView`：
/// 1. offered key → 反查擁有者（tunnel key → user key → service key）
/// 2. 擁有者有自己的隧道或被分享的隧道 → 含其個人金鑰
/// 3. 永遠附上所有隧道金鑰與服務金鑰，去重後 text/plain 輸出。
#[utoipa::path(get, path = "/api/reverse/internal/keys", tag = "Internal", security(("internal" = [])), params(("key_type" = String, Query, description = "e.g. ssh-ed25519"), ("key" = String, Query, description = "base64 key blob")), responses((status = 200, description = "Authorized keys for sshd AuthorizedKeysCommand, one per line (empty when none)", content_type = "text/plain", body = String), (status = 403, body = super::schemas::ErrorBody)))]
async fn keys(State(state): State<AppState>, _auth: InternalService, Query(q): Query<HashMap<String, String>>) -> ApiResult<Response> {
    let key_type = q.get("key_type").cloned().unwrap_or_default();
    let key_blob = q.get("key").cloned().unwrap_or_default();
    if key_type.is_empty() || key_blob.is_empty() {
        tracing::warn!("internal/keys: missing key_type or key param");
        return Ok(plain(String::new()));
    }
    let offered = format!("{key_type} {key_blob}");
    let like = like_prefix(&offered);
    tracing::info!(key_type, key_prefix = &key_blob[..key_blob.len().min(20)], "internal/keys lookup");

    let mut owner = db::tunnels::owner_by_key_prefix(&state.db, &offered).await?;
    if owner.is_none() {
        owner = db::keys::user_key_owner_by_prefix(&state.db, &like).await?;
    }
    if owner.is_none() && db::keys::service_key_matches_prefix(&state.db, &like).await? {
        tracing::info!("internal/keys: matched service key (no user)");
    }

    let mut all: BTreeSet<String> = BTreeSet::new();
    if let Some(uid) = owner {
        let own_tunnel_keys = db::tunnels::keys_for_user(&state.db, uid).await?;
        let has_shared = db::sharing::user_has_any_share(&state.db, uid).await?;
        if !own_tunnel_keys.is_empty() || has_shared {
            all.extend(own_tunnel_keys);
            all.extend(db::keys::user_key_strings(&state.db, uid).await?);
            tracing::info!(user_id = uid, has_shared, "internal/keys: owner authorized, including personal keys");
        } else {
            tracing::info!(user_id = uid, "internal/keys: owner has no tunnels and no shares; personal keys excluded");
        }
    }
    all.extend(db::tunnels::all_keys(&state.db).await?);
    all.extend(db::keys::service_key_strings(&state.db).await?);
    tracing::info!(count = all.len(), "internal/keys: returning keys");
    if all.is_empty() {
        return Ok(plain(String::new()));
    }
    let mut out = all.into_iter().collect::<Vec<_>>().join("\n");
    out.push('\n');
    Ok(plain(out))
}

/// Body = `ss -tlnp` 原文（或 JSON `{"ports":[...]}`）。
#[utoipa::path(post, path = "/api/reverse/internal/ss", tag = "Internal", security(("internal" = [])), request_body(content = String, description = "`ss -tlnp` output, or JSON {\"ports\": [..]}", content_type = "text/plain"), responses((status = 200, body = super::schemas::PushAck), (status = 403, body = super::schemas::ErrorBody)))]
async fn push_ss(State(state): State<AppState>, _auth: InternalService, body: Bytes) -> Json<Value> {
    let text = String::from_utf8_lossy(&body);
    let ports = match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.get("ports").is_some() => v["ports"].as_array().map(|a| a.iter().filter_map(|p| p.as_u64().map(|p| p as u16)).collect()).unwrap_or_default(),
        _ => parse_ss_listen(&text),
    };
    let n = ports.len();
    state.status.set_listen_ports(ports);
    Json(json!({ "status": "ok", "ports": n }))
}

/// Body = 多行 `port rtt_ms`（或 JSON `{"latency": {"port": rtt}}`）。
#[utoipa::path(post, path = "/api/reverse/internal/latency", tag = "Internal", security(("internal" = [])), request_body(content = String, description = "Lines `port rtt_ms`, or JSON {\"latency\": {port: rtt}}", content_type = "text/plain"), responses((status = 200, body = super::schemas::PushAck), (status = 403, body = super::schemas::ErrorBody)))]
async fn push_latency(State(state): State<AppState>, _auth: InternalService, body: Bytes) -> Json<Value> {
    let text = String::from_utf8_lossy(&body);
    let mut map: HashMap<u16, f64> = HashMap::new();
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        if let Some(obj) = v.get("latency").and_then(|l| l.as_object()) {
            for (k, val) in obj {
                if let (Ok(p), Some(r)) = (k.parse::<u16>(), val.as_f64()) {
                    map.insert(p, (r * 10.0).round() / 10.0);
                }
            }
        }
    }
    if map.is_empty() {
        for line in text.lines() {
            let mut it = line.split_whitespace();
            if let (Some(p), Some(r)) = (it.next(), it.next()) {
                if let (Ok(p), Ok(r)) = (p.parse::<u16>(), r.parse::<f64>()) {
                    map.insert(p, (r * 10.0).round() / 10.0);
                }
            }
        }
    }
    let n = map.len();
    state.status.set_latency(map);
    Json(json!({ "status": "ok", "ports": n }))
}
