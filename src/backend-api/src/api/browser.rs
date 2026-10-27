//! `/api/browser/*`：MCP `browser_*` tool 的 REST 版（`telepy browse`、腳本、CI）。開一個經裝置上網的 Chromium
//! （`ai::browser`，跟 MCP 同一套：上限、「誰在用」、即時 session、reaper、稽核），一次一個動作、每個 ≤ 30 秒。
//! 個人 API token / OAuth app 的 token 要 `browser:use`；網頁登入也能打（瀏覽器 console 裡寫腳本），功能 = 遠端瀏覽器。
//! 每個 session 只屬於開它的那把憑證。敏感（step-up）隧道一律拒絕。
//! REST equivalents of the MCP `browser_*` tools (`telepy browse`, scripts, CI): a Chromium that browses through the
//! device (`ai::browser` — same limits, presence, live sessions, reaper and audit as MCP), one action at a time, each
//! bounded to 30 s. Tokens need `browser:use`; web sign-ins may call them too. A browser belongs to the credential
//! that opened it. Step-up tunnels are refused.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::ai::{self, browser::AiBrowser, CloseReason};
use crate::auth::extractor::Delegated;
use crate::auth::mcp::McpPrincipal;
use crate::auth::AuthUser;
use crate::client_ip::ClientMeta;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, open))
        .routes(routes!(close))
        .routes(routes!(navigate))
        .routes(routes!(text))
        .routes(routes!(screenshot))
        .routes(routes!(click))
        .routes(routes!(type_text))
}

/// 呼叫者：委派 token 用它自己的 principal；網頁登入 = `McpPrincipal::web`。/ The caller as a principal.
fn caller(me: crate::db::users::User, d: &Delegated, meta: &ClientMeta) -> Arc<McpPrincipal> {
    d.0.clone().unwrap_or_else(|| Arc::new(McpPrincipal::web(me, meta.ip.clone())))
}

fn err(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

fn find(state: &AppState, p: &McpPrincipal, id: &str) -> ApiResult<Arc<AiBrowser>> {
    ai::browser::lookup(state, p, id).map_err(|closed| match closed {
        Some(why) => err(StatusCode::NOT_FOUND, "browser_closed", format!("The browser '{id}' was closed ({why}). Open a new one if you still need it.")),
        None => err(StatusCode::NOT_FOUND, "browser_not_found", format!("No open browser '{id}' for this credential. Browsers close when idle, at their maximum lifetime or when the device goes offline.")),
    })
}

async fn act(state: &AppState, p: &McpPrincipal, tool: &str, id: &str, action: Value, detail: String) -> ApiResult<(Arc<AiBrowser>, Value)> {
    let b = find(state, p, id)?;
    let v = ai::browser::run_action(state, p, tool, &b, action, detail).await.map_err(|e| err(StatusCode::BAD_REQUEST, "browser_action_failed", format!("The browser action failed: {e}")))?;
    Ok((b, v))
}

fn json_of(b: &AiBrowser, state: &AppState) -> Value {
    let mut v = ai::browser::browser_json(b, state.config.tz_offset_minutes);
    v["id"] = v["browser_id"].clone();
    v
}

#[utoipa::path(get, path = "/api/browser/sessions", tag = "Browser Automation", security(("bearer" = [])), responses((status = 200, description = "The browsers this credential (token, connected app or web sign-in) has open, oldest first", body = Vec<super::schemas::ApiBrowser>)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, meta: ClientMeta) -> ApiResult<Json<Value>> {
    let p = caller(me, &d, &meta);
    let out: Vec<Value> = state.ai.browsers.list().iter().filter(|b| b.user_id == p.user.id && b.credential == p.credential).map(|b| json_of(b, &state)).collect();
    Ok(Json(Value::Array(out)))
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct OpenBody {
    tunnel_id: i64,
    username: Option<String>,
    url: Option<String>,
    idle_timeout_s: Option<u64>,
    max_lifetime_s: Option<u64>,
}

#[utoipa::path(post, path = "/api/browser/sessions", tag = "Browser Automation", security(("bearer" = [])), request_body = super::schemas::ApiBrowserOpen, responses(
    (status = 201, description = "Opened: a Chromium that reaches the web through the tunnel's device (its LAN, localhost and public IP); `page` when a url was given", body = super::schemas::ApiBrowser),
    (status = 400, description = "Bad url, unknown tunnel / account, the per-person limit, or the device is offline ({error, code: browser_open_failed})", body = super::schemas::ErrorBody),
    (status = 403, description = "token_scope (browser:use), feature_disabled, or step_up_refused (the tunnel asks for step-up before every session)", body = super::schemas::ErrorBody),
))]
async fn open(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, meta: ClientMeta, AppJson(body): AppJson<OpenBody>) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = caller(me, &d, &meta);
    let url = body.url.as_deref().filter(|u| !u.trim().is_empty()).map(ai::browser::normalize_url).transpose().map_err(|e| ApiError::field("url", e))?;
    let req = ai::browser::OpenBrowserRequest { tunnel_id: body.tunnel_id, username: body.username, idle_timeout_s: body.idle_timeout_s, max_lifetime_s: body.max_lifetime_s };
    let (b, page, nav_error) = ai::browser::open_at(&state, &p, req, url).await.map_err(|e| {
        if e == crate::mcp::STEP_UP_REFUSAL {
            err(StatusCode::FORBIDDEN, "step_up_refused", "This tunnel asks people to confirm it's them (step-up) before every session, so scripted browsers can't open there. Use the remote browser in the Telepy web app, or turn the setting off for this tunnel.")
        } else {
            err(StatusCode::BAD_REQUEST, "browser_open_failed", e)
        }
    })?;
    let mut v = json_of(&b, &state);
    if let Some(page) = page {
        v["page"] = page;
    }
    if let Some(e) = nav_error {
        v["navigate_error"] = json!(e);
    }
    Ok((StatusCode::CREATED, Json(v)))
}

#[utoipa::path(delete, path = "/api/browser/sessions/{id}", tag = "Browser Automation", security(("bearer" = [])), params(("id" = String, Path, description = "Browser id (aib_…)")), responses((status = 204, description = "Closed"), (status = 404, body = super::schemas::ErrorBody)))]
async fn close(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, meta: ClientMeta, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let p = caller(me, &d, &meta);
    let b = find(&state, &p, &id)?;
    // 稽核由 ai::browser::close 寫。/ ai::browser::close writes the audit row.
    ai::browser::close(&state, &b.id, CloseReason::ClosedByAgent, None).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct NavigateBody {
    url: String,
}

#[utoipa::path(post, path = "/api/browser/sessions/{id}/navigate", tag = "Browser Automation", security(("bearer" = [])), params(("id" = String, Path, description = "Browser id (aib_…)")), request_body = super::schemas::ApiBrowserNavigate, responses(
    (status = 200, description = "Loaded: the final url and the page title", body = super::schemas::ApiBrowserPage),
    (status = 400, description = "Not an http / https url, or the page did not load within 30 s", body = super::schemas::ErrorBody),
    (status = 404, body = super::schemas::ErrorBody),
))]
async fn navigate(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, meta: ClientMeta, Path(id): Path<String>, AppJson(body): AppJson<NavigateBody>) -> ApiResult<Json<Value>> {
    let p = caller(me, &d, &meta);
    let url = ai::browser::normalize_url(&body.url).map_err(|e| ApiError::field("url", e))?;
    let (b, v) = act(&state, &p, "browser_navigate", &id, json!({ "action": "navigate", "url": url }), url.clone()).await?;
    Ok(Json(json!({ "id": b.id, "url": v.get("url"), "title": v.get("title") })))
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct TextQuery {
    selector: Option<String>,
}

#[utoipa::path(get, path = "/api/browser/sessions/{id}/text", tag = "Browser Automation", security(("bearer" = [])), params(("id" = String, Path, description = "Browser id (aib_…)"), ("selector" = Option<String>, Query, description = "CSS selector; omit for the whole page")), responses(
    (status = 200, description = "Title, url, the visible text (≤ 100,000 characters) and the links on the page", body = super::schemas::ApiBrowserText),
    (status = 400, body = super::schemas::ErrorBody),
    (status = 404, body = super::schemas::ErrorBody),
))]
async fn text(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, meta: ClientMeta, Path(id): Path<String>, Query(q): Query<TextQuery>) -> ApiResult<Json<Value>> {
    let p = caller(me, &d, &meta);
    let selector = q.selector.filter(|s| !s.trim().is_empty());
    let detail = selector.clone().unwrap_or_else(|| "(page)".into());
    let action = json!({ "action": "read", "selector": selector, "max_chars": ai::browser::MAX_PAGE_TEXT });
    let (b, mut v) = act(&state, &p, "browser_read", &id, action, detail).await?;
    if let Some(o) = v.as_object_mut() {
        o.insert("id".into(), json!(b.id));
    }
    Ok(Json(v))
}

#[utoipa::path(get, path = "/api/browser/sessions/{id}/screenshot", tag = "Browser Automation", security(("bearer" = [])), params(("id" = String, Path, description = "Browser id (aib_…)")), responses(
    (status = 200, description = "A PNG of what the browser shows (≤ 1280 px wide); never stored. `X-Telepy-Page-Url` carries the page url", content_type = "image/png"),
    (status = 400, body = super::schemas::ErrorBody),
    (status = 404, body = super::schemas::ErrorBody),
))]
async fn screenshot(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, meta: ClientMeta, Path(id): Path<String>) -> ApiResult<Response> {
    let p = caller(me, &d, &meta);
    let action = json!({ "action": "screenshot", "max_width": ai::browser::SCREENSHOT_MAX_WIDTH });
    let (_, v) = act(&state, &p, "browser_screenshot", &id, action, "screenshot".into()).await?;
    let data = v.get("data").and_then(Value::as_str).ok_or_else(|| err(StatusCode::BAD_GATEWAY, "browser_action_failed", "The browser returned no image."))?;
    let png = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| err(StatusCode::BAD_GATEWAY, "browser_action_failed", "The browser returned a broken image."))?;
    let mut resp = ([(header::CONTENT_TYPE, "image/png")], png).into_response();
    if let Some(url) = v.get("url").and_then(Value::as_str).and_then(|u| HeaderValue::from_str(u).ok()) {
        resp.headers_mut().insert("x-telepy-page-url", url);
    }
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(resp)
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct ClickBody {
    selector: Option<String>,
    text: Option<String>,
}

#[utoipa::path(post, path = "/api/browser/sessions/{id}/click", tag = "Browser Automation", security(("bearer" = [])), params(("id" = String, Path, description = "Browser id (aib_…)")), request_body = super::schemas::ApiBrowserClick, responses(
    (status = 200, description = "Clicked (a real mouse click): what was clicked and the page afterwards", body = super::schemas::ApiBrowserPage),
    (status = 400, description = "Neither selector nor text, or nothing matched", body = super::schemas::ErrorBody),
    (status = 404, body = super::schemas::ErrorBody),
))]
async fn click(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, meta: ClientMeta, Path(id): Path<String>, AppJson(body): AppJson<ClickBody>) -> ApiResult<Json<Value>> {
    let p = caller(me, &d, &meta);
    let detail = match (&body.selector, &body.text) {
        (Some(s), _) if !s.trim().is_empty() => format!("selector: {s}"),
        (_, Some(t)) if !t.trim().is_empty() => format!("text: {t}"),
        _ => return Err(ApiError::field("selector", "Give a selector or a text to click.")),
    };
    let (b, v) = act(&state, &p, "browser_click", &id, json!({ "action": "click", "selector": body.selector, "text": body.text }), detail).await?;
    Ok(Json(json!({ "id": b.id, "clicked": v.get("clicked"), "url": v.get("url"), "title": v.get("title") })))
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct TypeBody {
    selector: String,
    text: String,
    press_enter: Option<bool>,
    sensitive: Option<bool>,
}

#[utoipa::path(post, path = "/api/browser/sessions/{id}/type", tag = "Browser Automation", security(("bearer" = [])), params(("id" = String, Path, description = "Browser id (aib_…)")), request_body = super::schemas::ApiBrowserType, responses(
    (status = 200, description = "Typed like a person; `press_enter` submits. The text is logged by length unless `sensitive: false`", body = super::schemas::ApiBrowserPage),
    (status = 400, body = super::schemas::ErrorBody),
    (status = 404, body = super::schemas::ErrorBody),
))]
async fn type_text(State(state): State<AppState>, AuthUser(me): AuthUser, d: Delegated, meta: ClientMeta, Path(id): Path<String>, AppJson(body): AppJson<TypeBody>) -> ApiResult<Json<Value>> {
    let p = caller(me, &d, &meta);
    if body.selector.trim().is_empty() {
        return Err(ApiError::field("selector", "selector is empty"));
    }
    let enter = body.press_enter.unwrap_or(false);
    let detail = ai::browser::type_detail(&body.selector, &body.text, enter, body.sensitive.unwrap_or(true));
    let action = json!({ "action": "type", "selector": body.selector, "text": body.text, "press_enter": enter });
    let (b, v) = act(&state, &p, "browser_type", &id, action, detail).await?;
    Ok(Json(json!({ "id": b.id, "typed": body.text.chars().count(), "url": v.get("url"), "title": v.get("title") })))
}
