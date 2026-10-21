//! `/api/site/settings`（site_settings app）：`{"values": {...}, "meta": {...}}`。
//! meta 的 label/description 直接取自 Django model 的 verbose_name/help_text（前端以字典優先、meta 退回）。

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, settings::{SettingValue, SiteSettings, FIELDS}};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/site/settings", get(get_settings).post(update_settings))
}

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Int,
    Str(usize),
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
    Value::Object(m)
}

fn meta_json() -> Value {
    let mut m = Map::new();
    for f in META {
        let kind = match f.kind {
            Kind::Bool => "boolean",
            Kind::Int => "integer",
            Kind::Str(_) => "string",
        };
        m.insert(f.name.into(), json!({ "label": f.label, "description": f.description, "type": kind }));
    }
    Value::Object(m)
}

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
    }
}

async fn update_settings(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can modify system settings."));
    }
    let mut updates = Vec::new();
    for f in META {
        if let Some(v) = body.get(f.name) {
            updates.push((f.name, parse_value(f, v)?));
        }
    }
    for (name, value) in updates {
        debug_assert!(FIELDS.contains(&name));
        db::settings::update_field(&state.db, name, value).await?;
    }
    let s = db::settings::get_solo(&state.db).await?;
    Ok(Json(json!({ "values": values_json(&s), "meta": meta_json() })))
}
