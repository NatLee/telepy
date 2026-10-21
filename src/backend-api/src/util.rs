//! 小工具：Django 相容的時間格式、隨機字串、JSON 取值。
//! Helpers: Django-compatible datetime formats, random strings, JSON accessors.

use chrono::{DateTime, FixedOffset, NaiveDateTime, Utc};
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde_json::Value;

/// Django 以 USE_TZ=True 存進 SQLite 的格式：UTC、無時區、6 位微秒。
/// How Django stores aware datetimes in SQLite: naive UTC with microseconds.
pub fn now_db() -> String {
    Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

pub fn parse_db_datetime(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    let s = s.strip_suffix("+00:00").or_else(|| s.strip_suffix('Z')).unwrap_or(s);
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(dt);
        }
    }
    None
}

/// DRF `DateTimeField.to_representation`：轉成 TIME_ZONE（Asia/Taipei）後 `isoformat()`；
/// 微秒為 0 時不帶小數。/ DRF representation: localtime isoformat, fractional part only when non-zero.
pub fn db_to_iso(s: &str, tz_offset_minutes: i32) -> String {
    match parse_db_datetime(s) {
        Some(naive) => {
            let offset = FixedOffset::east_opt(tz_offset_minutes * 60).unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
            let local: DateTime<FixedOffset> = DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc).with_timezone(&offset);
            if local.timestamp_subsec_micros() == 0 {
                local.format("%Y-%m-%dT%H:%M:%S%:z").to_string()
            } else {
                local.format("%Y-%m-%dT%H:%M:%S%.6f%:z").to_string()
            }
        }
        None => s.to_string(),
    }
}

pub fn opt_db_to_iso(s: &Option<String>, tz_offset_minutes: i32) -> Value {
    match s {
        Some(v) => Value::String(db_to_iso(v, tz_offset_minutes)),
        None => Value::Null,
    }
}

/// DRF `JSONEncoder` 對 datetime 的處理（Response 直接放 datetime 物件時）：UTC isoformat，
/// `+00:00` 換成 `Z`。/ How DRF's JSONEncoder renders raw datetimes placed in a Response.
pub fn db_to_iso_utc_z(s: &str) -> String {
    match parse_db_datetime(s) {
        Some(naive) => {
            if naive.and_utc().timestamp_subsec_micros() == 0 {
                naive.format("%Y-%m-%dT%H:%M:%SZ").to_string()
            } else {
                naive.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
            }
        }
        None => s.to_string(),
    }
}

pub fn opt_db_to_iso_utc_z(s: &Option<String>) -> Value {
    match s {
        Some(v) => Value::String(db_to_iso_utc_z(v)),
        None => Value::Null,
    }
}

/// Python 的 `aware_dt.isoformat()`（UTC）：`+00:00` 原樣保留（ListSharedUsersView 的 shared_at）。
pub fn db_to_iso_utc_offset(s: &str) -> String {
    match parse_db_datetime(s) {
        Some(naive) => {
            if naive.and_utc().timestamp_subsec_micros() == 0 {
                naive.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
            } else {
                naive.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
            }
        }
        None => s.to_string(),
    }
}

/// Python `datetime.now().isoformat()`（容器內為 UTC、naive、無 offset）。
pub fn now_iso_naive() -> String {
    Utc::now().naive_utc().format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}

pub fn random_alnum(len: usize) -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(len).map(char::from).collect()
}

/// uuid4().hex — 32 個小寫 hex 字元（simplejwt 的 jti、一次性 token 都用這個）。
pub fn uuid_hex() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 從 JSON body 取字串欄位：允許數字（轉字串）、`null`/缺欄位回 None。
/// Django `request.data.get()` semantics for string-ish fields.
pub fn json_str(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

pub fn json_i64(v: &Value, key: &str) -> Option<i64> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

/// 去掉 Host 標頭的 port（IPv6 `[::1]:8787` → `::1`；`host:8787` → `host`）。
/// Strip the port from a Host header value, mirroring the regexes in tunnels/views.py.
pub fn host_without_port(host: &str) -> String {
    let host = host.trim();
    if let Some(rest) = host.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[..end].to_string();
        }
    }
    match host.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') && p.chars().all(|c| c.is_ascii_digit()) => h.to_string(),
        _ => host.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formatting_matches_drf() {
        assert_eq!(db_to_iso("2026-02-22 09:04:12.123456", 480), "2026-02-22T17:04:12.123456+08:00");
        assert_eq!(db_to_iso("2026-02-22 09:04:12", 480), "2026-02-22T17:04:12+08:00");
        assert_eq!(db_to_iso("2026-02-22 09:04:12.000000", 480), "2026-02-22T17:04:12+08:00");
    }

    #[test]
    fn utc_variants() {
        assert_eq!(db_to_iso_utc_z("2026-02-22 09:04:12.123456"), "2026-02-22T09:04:12.123456Z");
        assert_eq!(db_to_iso_utc_z("2026-02-22 09:04:12"), "2026-02-22T09:04:12Z");
        assert_eq!(db_to_iso_utc_offset("2026-02-22 09:04:12.5"), "2026-02-22T09:04:12.500000+00:00");
    }

    #[test]
    fn host_port_stripping() {
        assert_eq!(host_without_port("localhost:8787"), "localhost");
        assert_eq!(host_without_port("example.com"), "example.com");
        assert_eq!(host_without_port("[::1]:8787"), "::1");
        assert_eq!(host_without_port("10.0.0.1:80"), "10.0.0.1");
    }
}
