//! `GET /api/site/ssh-host`（管理員）：設定頁「SSH 主機」旁的即時檢查——網頁與 SSH 各用哪個名稱、解析到哪裡、有沒有
//! 落在 Cloudflare 的代理上（DNS，加上這次請求有沒有 Cloudflare 的標頭），以及兩者合起來的結論（`ssh_host::Verdict`）。
//! The live check beside "SSH host" on the settings page (superusers): which name the web and SSH use, what each
//! resolves to, whether it sits on Cloudflare's proxy (DNS, plus whether this request carried Cloudflare's headers),
//! and the verdict on both together.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::ssh_host::{lookup, verdict, via_cloudflare};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(ssh_host_check))
}

#[utoipa::path(get, path = "/api/site/ssh-host", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "Where the web and SSH names resolve, whether either is on Cloudflare's proxy, and the verdict (superusers)", body = super::schemas::SshHostCheck),
    (status = 403, body = super::schemas::ErrorBody)
))]
async fn ssh_host_check(State(state): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Only administrators can check the server's names.", "code": "admin_only" })));
    }
    // 網頁的名稱：PUBLIC_URL 的主機，沒設就是這次請求的 Host。/ The web name: PUBLIC_URL's host, else this request's Host.
    let public = state.config.public_base().and_then(|u| reqwest::Url::parse(&u).ok()).and_then(|u| u.host_str().map(str::to_ascii_lowercase));
    let (web_host, web_from) = match public {
        Some(h) => (h, "public_url"),
        None => (super::scripts::server_domain(&headers, &state).to_ascii_lowercase(), "request"),
    };
    let set = state.config.ssh_host();
    let (_, source) = state.config.effective("server_ssh_host");
    let ssh_host = set.clone().unwrap_or_else(|| web_host.clone());
    let ssh = lookup(&ssh_host).await;
    let web = if ssh_host == web_host { ssh.clone() } else { lookup(&web_host).await };
    let via_cf = via_cloudflare(&headers);
    let web_proxied = web.cloudflare() || via_cf;
    let mut ssh_json = ssh.json();
    ssh_json["port"] = json!(state.config.reverse_server_ssh_port);
    ssh_json["source"] = json!(if set.is_some() { source.as_str() } else { "web" });
    let mut web_json = web.json();
    web_json["from"] = json!(web_from);
    web_json["via_cloudflare"] = json!(via_cf);
    web_json["proxied"] = json!(web_proxied);
    Ok(Json(json!({
        "ssh": ssh_json,
        "web": web_json,
        "same": ssh_host == web_host,
        "verdict": verdict(&ssh, &web_host, web_proxied).as_str(),
    })))
}
