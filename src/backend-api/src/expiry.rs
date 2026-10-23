//! 到期時間的解析與檢查（分享、個人金鑰共用）。純函式。
//! Parsing and validating expiry times (shares, personal keys). Pure functions.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::Value;

/// null / "" = 不到期；RFC 3339 時間，或 `YYYY-MM-DD`（那天 UTC 23:59:59）。
/// null / "" = never; an RFC 3339 time, or `YYYY-MM-DD` (the end of that day, UTC).
pub fn parse_expiry(v: &Value) -> Result<Option<DateTime<Utc>>, String> {
    let bad = || "Use an ISO date or time, for example 2026-12-31.".to_string();
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.trim().is_empty() => Ok(None),
        Value::String(s) => {
            let s = s.trim();
            DateTime::parse_from_rfc3339(s)
                .map(|d| d.with_timezone(&Utc))
                .or_else(|_| NaiveDate::parse_from_str(s, "%Y-%m-%d").map(|d| d.and_hms_opt(23, 59, 59).unwrap().and_utc()))
                .map(Some)
                .map_err(|_| bad())
        }
        _ => Err(bad()),
    }
}

/// 要在未來；`max_days` > 0 時不能不到期、也不能超過上限（容許幾分鐘誤差）。
/// In the future; with `max_days` > 0 it must exist and stay within the limit (a few minutes of slack).
pub fn check_expiry(at: Option<DateTime<Utc>>, now: DateTime<Utc>, max_days: i64) -> Result<Option<DateTime<Utc>>, String> {
    let limit = || format!("Keys on this server must expire within {max_days} days.");
    match at {
        None if max_days > 0 => Err(limit()),
        None => Ok(None),
        Some(t) if t <= now => Err("Pick a time in the future.".to_string()),
        Some(t) if max_days > 0 && t > now + Duration::days(max_days) + Duration::minutes(10) => Err(limit()),
        Some(t) => Ok(Some(t)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn values() {
        assert_eq!(parse_expiry(&json!(null)).unwrap(), None);
        assert_eq!(parse_expiry(&json!("")).unwrap(), None);
        assert_eq!(parse_expiry(&json!("2026-12-31")).unwrap(), Some(at("2026-12-31T23:59:59Z")));
        assert_eq!(parse_expiry(&json!("2026-12-31T08:00:00+08:00")).unwrap(), Some(at("2026-12-31T00:00:00Z")));
        assert!(parse_expiry(&json!("next week")).is_err());
        assert!(parse_expiry(&json!(5)).is_err());
    }

    #[test]
    fn rules() {
        let now = at("2026-10-24T00:00:00Z");
        assert_eq!(check_expiry(None, now, 0).unwrap(), None);
        assert!(check_expiry(None, now, 90).is_err());
        assert!(check_expiry(Some(at("2026-10-23T00:00:00Z")), now, 0).is_err());
        assert!(check_expiry(Some(at("2027-02-01T00:00:00Z")), now, 90).is_err());
        assert!(check_expiry(Some(at("2026-12-01T00:00:00Z")), now, 90).is_ok());
    }
}
