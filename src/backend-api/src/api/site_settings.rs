//! `/api/site/settings`（site_settings app）：`{"values": {...}, "meta": {...}}`。
//! meta 的 label/description 直接取自 Django model 的 verbose_name/help_text（前端以字典優先、meta 退回）。

use axum::extract::State;
use axum::Json;
use serde_json::{json, Map, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, settings::{SettingValue, SiteSettings, FIELDS}};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(get_settings, update_settings)).routes(routes!(notify_test))
}

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Int,
    Str(usize),
    /// 可以空白（= 關閉）；有值就必須是 http(s) 網址。/ May be blank (= off); otherwise an http(s) URL.
    Url(usize),
}

struct FieldMeta {
    name: &'static str,
    kind: Kind,
    label: &'static str,
    description: &'static str,
}

const META: &[FieldMeta] = &[
    FieldMeta { name: "allow_registration", kind: Kind::Bool, label: "Allow registration", description: "是否開放新帳號自行註冊。關閉時只有管理員能建立帳號。變更後立即生效。" },
    FieldMeta { name: "valid_register_domains", kind: Kind::Str(512), label: "Allowed Registration Email Domains", description: "允許用 Google 登入自行註冊的 email 網域白名單,用逗號分隔(例如 gmail.com,mycorp.com)。只有這些網域的 Google 帳號能註冊。留空則沿用系統預設。變更後立即生效。" },
    FieldMeta { name: "remote_browser_session_idle_timeout", kind: Kind::Int, label: "Remote Browser Session Idle Timeout (seconds)", description: "閒置多久沒有心跳就自動關閉並回收該瀏覽器 session(秒),避免沒人用的 session 一直占用資源與目標機連線。你開著瀏覽器分頁時,伺服器每 20 秒會自動續命,所以正常使用不會被關;只有分頁關掉/斷線後才開始倒數。變更後即時生效。" },
    FieldMeta { name: "remote_browser_max_sessions", kind: Kind::Int, label: "Remote Browser Max Concurrent Sessions", description: "同時可存在的代理瀏覽器 session 數上限,用來控管資源。達到上限時,新的「開啟瀏覽器」會被拒絕並提示稍後再試。設 0 = 不限制。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_geometry", kind: Kind::Str(32), label: "Remote Browser Screen Geometry", description: "每個代理瀏覽器桌面的解析度,格式「寬x高」(例如 1280x720、1920x1080)。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_ssh_timeout", kind: Kind::Int, label: "Remote Browser SSH Proxy Timeout (seconds)", description: "開啟瀏覽器時,等待『ssh -D SOCKS 代理』把本地埠拉起來的逾時(秒)。此連線經 telepy-ssh兩跳到目標裝置,冷啟較久;太短會把「還在連」誤判成裝置離線。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_ssh_attempts", kind: Kind::Int, label: "Remote Browser SSH Proxy Attempts", description: "SOCKS 代理起不來時的重試次數(含第一次)。第一次連線是冷的常較慢,第二次因連線已暖通常就會成功;真的離線的裝置會很快失敗、不會空等。建議 ≥ 2。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_kasm_create_timeout", kind: Kind::Int, label: "Remote Browser Startup Timeout (seconds)", description: "開啟瀏覽器時,等待瀏覽器容器把桌面(Xkasmvnc)與 chromium 起好的逾時(秒)。冷啟或機器忙碌時較久,太短會讓開啟失敗;太長則卡住較久才報錯。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_homepage", kind: Kind::Str(512), label: "Remote Browser Homepage", description: "代理瀏覽器啟動時自動開啟的首頁網址(需含 http:// 或 https://)。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_language", kind: Kind::Str(16), label: "Remote Browser Language", description: "代理瀏覽器的介面語系與 Accept-Language,格式如 zh-TW、en-US、ja-JP。也影響反爬蟲的navigator.languages(空語系是機器人特徵)。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "ai_session_idle_timeout", kind: Kind::Int, label: "AI Session Idle Timeout (seconds)", description: "AI 工具（MCP）開的 SSH session 閒置多久沒有指令就自動關閉(秒)。執行中的指令不算閒置。變更後對新開的 session 生效。" },
    FieldMeta { name: "ai_session_max_lifetime", kind: Kind::Int, label: "AI Session Max Lifetime (seconds)", description: "AI 工具開的 SSH session 最長存活時間(秒),到期一律關閉(包含正在執行的指令)。變更後對新開的 session 生效。" },
    FieldMeta { name: "lan_scan_enabled", kind: Kind::Bool, label: "Allow LAN discovery", description: "允許隧道擁有者與 ADMIN 分享者經由裝置掃描它所在的區網(只探測私有網段、由裝置的 sshd 發出連線,不在裝置上安裝任何東西)。關閉後只能手動新增跳板機。每次掃描都會記錄在該隧道的 Logs。" },
    FieldMeta { name: "notify_webhook_url", kind: Kind::Url(512), label: "Status alert webhook", description: "隧道離線、恢復、降級(連著但 SSH 沒回應)時 POST 到這個網址。內容同時有 text(Slack、Google Chat、Mattermost)與 content(Discord)欄位,另附 event / tunnel 等結構化欄位。留空 = 關閉。只有管理員能設定,伺服器會從自己這裡連到這個網址。" },
    FieldMeta { name: "notify_down_delay", kind: Kind::Int, label: "Alert delay (seconds)", description: "狀況要持續多久才發告警(秒);在這之前恢復就什麼都不發,所以裝置閃斷不會洗版。只有發過「離線」的隧道,回來時才會發「恢復」。設 0 = 立刻通知。" },
    FieldMeta { name: "user_key_max_days", kind: Kind::Int, label: "Personal key lifetime (days)", description: "個人 SSH 金鑰最長可以用幾天。設了之後,新增或續期的金鑰都必須在這個天數內到期(沒填就自動用最長效期);到期的金鑰會被 gateway 拒絕,並從裝置的 authorized_keys 移除。設 0 = 不限制。" },
    FieldMeta { name: "mfa_require_totp", kind: Kind::Bool, label: "Require an authenticator app", description: "要求每個帳號都設定驗證器 App(TOTP)。還沒設定的使用者登入後只能先完成設定,才能使用其他功能。開啟前你自己的帳號必須已經設定好。變更後立即生效。" },
    FieldMeta { name: "mfa_require_passkey", kind: Kind::Bool, label: "Require a passkey", description: "要求每個帳號都至少註冊一把 passkey。還沒註冊的使用者登入後只能先完成註冊,才能使用其他功能。passkey 需要以網域名稱(不是 IP)開啟網站。開啟前你自己的帳號必須已經有 passkey。變更後立即生效。" },
    FieldMeta { name: "recording_retention_days", kind: Kind::Int, label: "Keep terminal recordings (days)", description: "開了「錄下網頁終端機」的隧道，錄影檔要留幾天；超過就連檔案一起刪掉（每小時清一次）。設 0 = 一直留。" },
    FieldMeta { name: "command_approval_timeout", kind: Kind::Int, label: "Command approval timeout (seconds)", description: "指令規則要求核准時，等 owner / ADMIN 多久(秒)；沒人回應就當作拒絕，終端機那一行被取消。核准後 agent 的同一個指令 10 分鐘內可以跑一次。" },
    FieldMeta { name: "signin_lifetime", kind: Kind::Int, label: "Stay signed in for (seconds)", description: "網頁登入沒有任何造訪多久後要重新登入(秒)。只要有來,效期就從那時重新起算(分頁開著時瀏覽器會在背景自動續期),所以常用的人不會被登出;登出則立刻結束。300(5 分鐘)到 31536000(365 天)。" },
    FieldMeta { name: "signin_access_lifetime", kind: Kind::Int, label: "Access token lifetime (seconds)", description: "每顆短效 access token 的有效時間(秒);到期前瀏覽器會自動用登入 session 換一顆新的,使用者不會察覺。越短,外洩的 token 能用的時間越短。60(1 分鐘)到 86400(24 小時)。" },
    FieldMeta { name: "ai_max_sessions_per_user", kind: Kind::Int, label: "AI Sessions per User", description: "每位使用者同時可開的 AI SSH session 數上限(所有已授權的 app 合計)。設 0 = 不允許 AI 開 session。下次開 session 時生效。" },
    FieldMeta { name: "desktop_enabled", kind: Kind::Bool, label: "Allow remote desktop", description: "允許在網頁裡開裝置（或它區網裡主機）的 RDP / VNC 桌面。連線由裝置的 sshd 轉接到目標，經 guacd 轉成瀏覽器畫面；每個 session 都記錄在該隧道的 Logs。關閉後不能再開新的 session，已開著的不受影響。" },
    FieldMeta { name: "desktop_max_sessions", kind: Kind::Int, label: "Remote Desktop Max Concurrent Sessions", description: "同時可開的遠端桌面 session 數上限（整站合計）。達到上限時新的連線會被拒絕並提示稍後再試。設 0 = 不限制。" },
    FieldMeta { name: "desktop_session_idle_timeout", kind: Kind::Int, label: "Remote Desktop Idle Timeout (seconds)", description: "遠端桌面多久沒有鍵盤 / 滑鼠 / 剪貼簿輸入就自動斷線(秒)。設 0 = 不自動斷線。變更後即時生效。" },
    FieldMeta { name: "desktop_clipboard", kind: Kind::Str(16), label: "Remote Desktop Clipboard", description: "剪貼簿方向：both = 雙向、to_remote = 只能把文字貼進遠端、off = 關閉。下次開桌面時生效。" },
    FieldMeta { name: "desktop_max_resolution", kind: Kind::Int, label: "Remote Desktop Max Resolution", description: "遠端桌面畫面寬或高的上限(像素)，超過會被縮到這個值。下次開桌面時生效。" },
];

fn values_json(s: &SiteSettings) -> Value {
    let mut m = Map::new();
    m.insert("allow_registration".into(), json!(s.allow_registration));
    m.insert("valid_register_domains".into(), json!(s.valid_register_domains));
    m.insert("remote_browser_session_idle_timeout".into(), json!(s.remote_browser_session_idle_timeout));
    m.insert("remote_browser_max_sessions".into(), json!(s.remote_browser_max_sessions));
    m.insert("remote_browser_geometry".into(), json!(s.remote_browser_geometry));
    m.insert("remote_browser_ssh_timeout".into(), json!(s.remote_browser_ssh_timeout));
    m.insert("remote_browser_ssh_attempts".into(), json!(s.remote_browser_ssh_attempts));
    m.insert("remote_browser_kasm_create_timeout".into(), json!(s.remote_browser_kasm_create_timeout));
    m.insert("remote_browser_homepage".into(), json!(s.remote_browser_homepage));
    m.insert("remote_browser_language".into(), json!(s.remote_browser_language));
    m.insert("ai_session_idle_timeout".into(), json!(s.ai_session_idle_timeout));
    m.insert("ai_session_max_lifetime".into(), json!(s.ai_session_max_lifetime));
    m.insert("ai_max_sessions_per_user".into(), json!(s.ai_max_sessions_per_user));
    m.insert("lan_scan_enabled".into(), json!(s.lan_scan_enabled));
    m.insert("notify_webhook_url".into(), json!(s.notify_webhook_url));
    m.insert("notify_down_delay".into(), json!(s.notify_down_delay));
    m.insert("user_key_max_days".into(), json!(s.user_key_max_days));
    m.insert("desktop_enabled".into(), json!(s.desktop_enabled));
    m.insert("desktop_max_sessions".into(), json!(s.desktop_max_sessions));
    m.insert("desktop_session_idle_timeout".into(), json!(s.desktop_session_idle_timeout));
    m.insert("desktop_clipboard".into(), json!(s.desktop_clipboard));
    m.insert("desktop_max_resolution".into(), json!(s.desktop_max_resolution));
    m.insert("mfa_require_totp".into(), json!(s.mfa_require_totp));
    m.insert("mfa_require_passkey".into(), json!(s.mfa_require_passkey));
    m.insert("recording_retention_days".into(), json!(s.recording_retention_days));
    m.insert("command_approval_timeout".into(), json!(s.command_approval_timeout));
    m.insert("signin_lifetime".into(), json!(s.signin_lifetime));
    m.insert("signin_access_lifetime".into(), json!(s.signin_access_lifetime));
    Value::Object(m)
}

fn meta_json() -> Value {
    let mut m = Map::new();
    for f in META {
        let kind = match f.kind {
            Kind::Bool => "boolean",
            Kind::Int => "integer",
            Kind::Str(_) => "string",
            Kind::Url(_) => "url",
        };
        m.insert(f.name.into(), json!({ "label": f.label, "description": f.description, "type": kind }));
    }
    Value::Object(m)
}

#[utoipa::path(get, path = "/api/site/settings", tag = "Site Settings", security(("bearer" = [])), responses((status = 200, description = "values + meta; empty objects for non-admins", body = super::schemas::SiteSettingsResponse)))]
async fn get_settings(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Ok(Json(json!({ "values": {}, "meta": {} })));
    }
    let s = db::settings::get_solo(&state.db).await?;
    Ok(Json(json!({ "values": values_json(&s), "meta": meta_json() })))
}

/// DRF 欄位驗證（BooleanField / IntegerField / CharField max_length、不可空白）。
fn parse_value(f: &FieldMeta, v: &Value) -> Result<SettingValue, ApiError> {
    match f.kind {
        Kind::Bool => match v {
            Value::Bool(b) => Ok(SettingValue::Bool(*b)),
            Value::String(s) if matches!(s.to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on") => Ok(SettingValue::Bool(true)),
            Value::String(s) if matches!(s.to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off") => Ok(SettingValue::Bool(false)),
            Value::Number(n) if n.as_i64() == Some(1) => Ok(SettingValue::Bool(true)),
            Value::Number(n) if n.as_i64() == Some(0) => Ok(SettingValue::Bool(false)),
            _ => Err(ApiError::field(f.name, "Must be a valid boolean.")),
        },
        Kind::Int => match v {
            Value::Number(n) => n.as_i64().ok_or_else(|| ApiError::field(f.name, "A valid integer is required.")).map(SettingValue::Int),
            Value::String(s) => s.trim().parse::<i64>().map(SettingValue::Int).map_err(|_| ApiError::field(f.name, "A valid integer is required.")),
            _ => Err(ApiError::field(f.name, "A valid integer is required.")),
        },
        Kind::Str(max) => match v {
            Value::String(s) if s.is_empty() => Err(ApiError::field(f.name, "This field may not be blank.")),
            Value::String(s) if s.chars().count() > max => Err(ApiError::field(f.name, format!("Ensure this field has no more than {max} characters."))),
            Value::String(s) => Ok(SettingValue::Str(s.clone())),
            Value::Null => Err(ApiError::field(f.name, "This field may not be null.")),
            other => Ok(SettingValue::Str(other.to_string())),
        },
        Kind::Url(max) => match v {
            Value::String(s) if s.trim().is_empty() => Ok(SettingValue::Str(String::new())),
            Value::String(s) if s.chars().count() > max => Err(ApiError::field(f.name, format!("Ensure this field has no more than {max} characters."))),
            Value::String(s) => match reqwest::Url::parse(s.trim()) {
                Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() => Ok(SettingValue::Str(s.trim().to_string())),
                _ => Err(ApiError::field(f.name, "Enter a valid http:// or https:// URL, or leave it blank.")),
            },
            _ => Err(ApiError::field(f.name, "Enter a valid http:// or https:// URL, or leave it blank.")),
        },
    }
}

#[utoipa::path(post, path = "/api/site/settings", tag = "Site Settings", security(("bearer" = [])), request_body(content = Object, description = "Partial update: {field: value, …} using the keys of `values`"), responses((status = 200, body = super::schemas::SiteSettingsResponse), (status = 400, description = "{field: [message]}", body = Object), (status = 403, body = super::schemas::ErrorBody)))]
async fn update_settings(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can modify system settings."));
    }
    let mut updates = Vec::new();
    for f in META {
        if let Some(v) = body.get(f.name) {
            let value = parse_value(f, v)?;
            validate(f.name, &value)?;
            updates.push((f.name, value));
        }
    }
    // 開啟「必須有 TOTP / passkey」前，管理員自己要先有，否則會把自己鎖在設定畫面外（關閉永遠可以）。
    // Turning a requirement on needs that factor on the admin's own account first; turning it off is always allowed.
    let current = db::settings::get_solo(&state.db).await?;
    let turning_on = |name: &str, was: bool| !was && updates.iter().any(|(n, v)| *n == name && matches!(v, SettingValue::Bool(true)));
    let need_totp = turning_on("mfa_require_totp", current.mfa_require_totp);
    let need_passkey = turning_on("mfa_require_passkey", current.mfa_require_passkey);
    if need_totp || need_passkey {
        let mine = super::mfa::factors(&state, me.id).await?;
        if need_totp && !mine.totp {
            return Err(ApiError::field("mfa_require_totp", "Set up an authenticator app on your own account first."));
        }
        if need_passkey && mine.passkeys == 0 {
            return Err(ApiError::field("mfa_require_passkey", "Register a passkey on your own account first."));
        }
    }
    let touches_mfa = updates.iter().any(|(n, _)| n.starts_with("mfa_require_"));
    for (name, value) in updates {
        debug_assert!(FIELDS.contains(&name));
        db::settings::update_field(&state.db, name, value).await?;
    }
    if touches_mfa {
        state.mfa.requirement.invalidate_all();
    }
    let s = db::settings::get_solo(&state.db).await?;
    Ok(Json(json!({ "values": values_json(&s), "meta": meta_json() })))
}

/// 個別欄位的值域（型別檢查之外）。/ Per-field value constraints beyond the type check.
fn validate(name: &str, value: &SettingValue) -> Result<(), ApiError> {
    match (name, value) {
        ("desktop_clipboard", SettingValue::Str(s)) if !crate::desktop::Clipboard::VALUES.contains(&s.as_str()) => {
            Err(ApiError::field(name, format!("Must be one of: {}.", crate::desktop::Clipboard::VALUES.join(", "))))
        }
        ("desktop_max_resolution", SettingValue::Int(n)) if !(640..=16384).contains(n) => Err(ApiError::field(name, "Must be between 640 and 16384.")),
        ("desktop_max_sessions" | "desktop_session_idle_timeout", SettingValue::Int(n)) if *n < 0 => Err(ApiError::field(name, "Must be 0 or more.")),
        ("command_approval_timeout", SettingValue::Int(n)) if !(30..=86_400).contains(n) => Err(ApiError::field(name, "Must be between 30 and 86400 seconds.")),
        ("signin_lifetime", SettingValue::Int(n)) if !crate::auth::sessions::SIGNIN_LIFETIME_RANGE.contains(n) => {
            Err(ApiError::field(name, "Must be between 300 seconds (5 minutes) and 31536000 seconds (365 days)."))
        }
        ("signin_access_lifetime", SettingValue::Int(n)) if !crate::auth::sessions::ACCESS_LIFETIME_RANGE.contains(n) => {
            Err(ApiError::field(name, "Must be between 60 seconds (1 minute) and 86400 seconds (24 hours)."))
        }
        _ => Ok(()),
    }
}

/// 用目前存的 webhook 網址送一則測試告警，回傳結果（管理員）。/ Send a test alert to the saved webhook (admins).
#[utoipa::path(post, path = "/api/site/settings/notify-test", tag = "Site Settings", security(("bearer" = [])), responses((status = 200, description = "{\"ok\": bool, \"status\": http status | null, \"error\": message | null}", body = Object), (status = 400, description = "No webhook URL saved", body = super::schemas::ErrorBody), (status = 403, body = super::schemas::ErrorBody)))]
async fn notify_test(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can modify system settings."));
    }
    let s = db::settings::get_solo(&state.db).await?;
    if s.notify_webhook_url.trim().is_empty() {
        return Err(ApiError::bad_request("Save a webhook URL first."));
    }
    let mut body = crate::monitor::alerts::payload(
        crate::monitor::alerts::Alert::Online,
        0,
        "test-tunnel",
        0,
        state.config.public_url.as_deref(),
        &crate::util::db_to_iso_utc_z(&crate::util::now_db()),
    );
    let text = format!("[Telepy] Test alert from {}: the webhook works.", me.username);
    body["text"] = json!(text);
    body["content"] = json!(text);
    body["event"] = json!("test");
    Ok(Json(match crate::monitor::alerts::deliver(&state.http, &s.notify_webhook_url, &body).await {
        Ok(status) => json!({ "ok": true, "status": status, "error": null }),
        Err(e) => json!({ "ok": false, "status": null, "error": e }),
    }))
}
