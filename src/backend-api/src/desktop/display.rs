//! 遠端桌面的個人顯示偏好（`user_management_usersettings.desktop_display`，JSON）：縮放、RDP 解析度、HiDPI、VNC 要不要
//! 跟著視窗，以及每次連線的畫質與聲音預設。存在帳號上，換一台瀏覽器也一樣；前端（lib/desktopDisplay.ts）有同一份規則。
//! 空字串 = 這個帳號還沒選過（前端會把這台瀏覽器的值傳上來）。純函式。
//! A person's remote desktop display preferences, stored on the account as JSON (scaling, RDP resolution, HiDPI,
//! VNC resizing, the quality and sound defaults); empty = never chosen. Mirrored by the frontend. Pure.

use serde_json::{json, Map, Value};

pub const SCALES: [&str; 4] = ["fit", "shrink", "actual", "custom"];
pub const RESOLUTIONS: [&str; 2] = ["window", "fixed"];
pub const QUALITIES: [&str; 3] = ["auto", "speed", "sharp"];
pub const MIN_PERCENT: i64 = 25;
pub const MAX_PERCENT: i64 = 400;
pub const MIN_SIDE: i64 = 200;
pub const MAX_SIDE: i64 = 16384;

pub const RULE: &str = "Must be an object with scale (fit, shrink, actual, custom), percent (25-400), resolution (window, fixed), width and height (200-16384), hidpi, vnc_resize and audio (true / false) and quality (auto, speed, sharp).";

/// 預設值（和前端的 DEFAULT_DISPLAY 一樣）。/ The defaults, as in the frontend.
pub fn defaults() -> Map<String, Value> {
    let Value::Object(m) = json!({
        "scale": "fit", "percent": 100, "resolution": "window", "width": 1920, "height": 1080,
        "hidpi": false, "vnc_resize": false, "quality": "auto", "audio": false,
    }) else { unreachable!() };
    m
}

fn choice(v: &Value, allowed: &[&str]) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| allowed.contains(s)).map(str::to_string)
}

fn integer(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64))
}

/// 檢查並正規化：物件、只收認得的欄位、缺的補預設；百分比夾進 25–400，其他超出範圍就拒絕。回傳完整、鍵排序的 JSON。
/// Validate and normalise: an object of known fields only, missing ones get the default; the percentage is
/// clamped to 25–400, anything else out of range is refused. Returns the complete JSON with sorted keys.
pub fn parse(v: &Value) -> Result<String, &'static str> {
    let obj = v.as_object().ok_or(RULE)?;
    let mut out = defaults();
    for (k, val) in obj {
        let ok = match k.as_str() {
            "scale" => choice(val, &SCALES).map(Value::from),
            "resolution" => choice(val, &RESOLUTIONS).map(Value::from),
            "quality" => choice(val, &QUALITIES).map(Value::from),
            "percent" => integer(val).map(|n| Value::from(n.clamp(MIN_PERCENT, MAX_PERCENT))),
            "width" | "height" => integer(val).filter(|n| (MIN_SIDE..=MAX_SIDE).contains(n)).map(Value::from),
            "hidpi" | "vnc_resize" | "audio" => val.as_bool().map(Value::from),
            _ => None,
        };
        out.insert(k.clone(), ok.ok_or(RULE)?);
    }
    Ok(Value::Object(out).to_string())
}

/// 存的值 → JSON；空 / 壞掉 = null（前端就用這台瀏覽器的值，並傳上來）。/ Stored → JSON; empty or broken = null.
pub fn json(stored: &str) -> Value {
    if stored.trim().is_empty() {
        return Value::Null;
    }
    match serde_json::from_str::<Value>(stored).ok().and_then(|v| parse(&v).ok()) {
        Some(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_defaults_and_sorts() {
        let s = parse(&json!({"scale": "actual"})).unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["scale"], "actual");
        assert_eq!(v["percent"], 100);
        assert_eq!(v["resolution"], "window");
        assert_eq!((v["width"].as_i64(), v["height"].as_i64()), (Some(1920), Some(1080)));
        assert_eq!(v["quality"], "auto");
        assert_eq!(v["audio"], false);
        assert!(s.starts_with(r#"{"audio":false,"height":1080"#), "{s}");
    }

    #[test]
    fn clamps_the_percentage_and_refuses_the_rest() {
        let v: Value = serde_json::from_str(&parse(&json!({"percent": 999})).unwrap()).unwrap();
        assert_eq!(v["percent"], 400);
        let v: Value = serde_json::from_str(&parse(&json!({"percent": 10.4})).unwrap()).unwrap();
        assert_eq!(v["percent"], 25);
        assert!(parse(&json!({"scale": "zoomy"})).is_err());
        assert!(parse(&json!({"width": 100})).is_err());
        assert!(parse(&json!({"height": 20000})).is_err());
        assert!(parse(&json!({"hidpi": "yes"})).is_err());
        assert!(parse(&json!({"quality": "ultra"})).is_err());
        assert!(parse(&json!({"colour": "red"})).is_err(), "unknown fields are refused");
        assert!(parse(&json!(["fit"])).is_err());
        assert!(parse(&json!({"percent": "150"})).is_err());
    }

    #[test]
    fn stored_values_read_back_safely() {
        assert_eq!(json(""), Value::Null);
        assert_eq!(json("not json"), Value::Null);
        assert_eq!(json(r#"{"scale":"nope"}"#), Value::Null);
        assert_eq!(json(r#"{"scale":"shrink","hidpi":true}"#)["hidpi"], true);
    }
}
