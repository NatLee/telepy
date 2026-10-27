//! `telepy api tokens` / `telepy api activity`：自己的 API token 與用它們（以及已連接 app）打過的呼叫，跟網頁 API 頁的
//! 「你的 token」「活動」同一份資料（`GET /api/auth/tokens`、`GET /api/auth/tokens/calls`）。這裡只放純函式：參數解析
//! （`--since` 的長度、狀態分組、方法）、查詢字串、表格列、`--follow` 的單行格式。
//! `telepy api tokens` / `telepy api activity`: your API tokens and the calls made with them (and with connected apps),
//! the same data as the web API page's tokens and Activity tabs. Pure helpers only: argument parsing (`--since`
//! durations, status buckets, methods), the query string, table rows and the one-line `--follow` format.

use chrono::{FixedOffset, TimeZone};
use serde_json::Value;

use crate::table;

/// 後端一次最多給幾列。/ The most rows the backend returns per page.
pub const PAGE_MAX: usize = 1000;

/// `--status`：跟網頁 / 後端同一組分類。/ The status buckets the backend understands.
pub fn parse_status(raw: &str) -> Result<String, String> {
    let s = raw.trim().to_ascii_lowercase();
    match s.as_str() {
        "ok" | "4xx" | "5xx" | "error" => Ok(s),
        _ => Err(format!("--status must be ok, 4xx, 5xx or error (not '{raw}')")),
    }
}

/// `--method`：HTTP 方法或 `MCP`（個人 token 的工具呼叫）。/ An HTTP method, or MCP for tool calls.
pub fn parse_method(raw: &str) -> Result<String, String> {
    let m = raw.trim().to_ascii_uppercase();
    match m.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "MCP" => Ok(m),
        _ => Err(format!("--method must be GET, POST, PUT, PATCH, DELETE or MCP (not '{raw}')")),
    }
}

/// `--since`：`45s` / `30m` / `2h` / `7d` / `1w`（從現在往回）或 RFC 3339 時間 → Unix 秒。
/// `--since`: a duration back from now (`45s`, `30m`, `2h`, `7d`, `1w`) or an RFC 3339 time → Unix seconds.
pub fn parse_since(raw: &str, now: i64) -> Result<i64, String> {
    let r = raw.trim();
    let bad = || format!("Write --since as 30m, 2h, 7d (back from now) or an RFC 3339 time such as 2026-10-27T09:00:00+08:00 (not '{raw}')");
    if let Some(unit) = r.chars().last().filter(|c| c.is_ascii_alphabetic()) {
        let n: i64 = r[..r.len() - 1].parse().map_err(|_| bad())?;
        let secs = match unit.to_ascii_lowercase() {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86_400,
            'w' => 7 * 86_400,
            _ => return Err(bad()),
        };
        if n < 0 {
            return Err(bad());
        }
        return Ok(now - n.saturating_mul(secs));
    }
    table::parse_iso(r).ok_or_else(bad)
}

/// 送給 `GET /api/auth/tokens/calls` 的篩選（都已經驗過）。/ The filters for the calls endpoint, already validated.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Filters {
    /// 管理員看全站。/ The admin view.
    pub all: bool,
    pub token_id: Option<i64>,
    pub user_id: Option<i64>,
    pub username: Option<String>,
    pub status: Option<String>,
    pub method: Option<String>,
}

/// `--user <name|id>`：數字 = id，否則 = 帳號名。/ A number is a user id, anything else a username.
pub fn user_filter(raw: &str, f: &mut Filters) {
    match raw.trim().parse::<i64>() {
        Ok(id) => f.user_id = Some(id),
        Err(_) => f.username = Some(raw.trim().to_string()),
    }
}

pub fn query(f: &Filters, limit: usize, before: Option<i64>) -> String {
    let mut q = vec![format!("scope={}", if f.all { "all" } else { "mine" }), format!("limit={}", limit.clamp(1, PAGE_MAX))];
    if let Some(t) = f.token_id {
        q.push(format!("token_id={t}"));
    }
    if let Some(u) = f.user_id {
        q.push(format!("user_id={u}"));
    }
    if let Some(u) = &f.username {
        q.push(format!("username={}", crate::url_escape(u)));
    }
    if let Some(s) = &f.status {
        q.push(format!("status={s}"));
    }
    if let Some(m) = &f.method {
        q.push(format!("method={m}"));
    }
    if let Some(b) = before {
        q.push(format!("before={b}"));
    }
    format!("/api/auth/tokens/calls?{}", q.join("&"))
}

/// 這個 CLI 自己輪詢紀錄的那些呼叫（`--follow` 不印，免得每 2 秒冒一行自己）。
/// The CLI's own polling of the log (hidden by `--follow`, or it would print itself every 2 s).
pub fn is_log_read(call: &Value) -> bool {
    call["method"] == "GET" && call["route"] == "/api/auth/tokens/calls"
}

/// 一列呼叫的時間（Unix 秒）。/ A call's time in Unix seconds.
pub fn call_time(call: &Value) -> Option<i64> {
    call["at"].as_str().and_then(table::parse_iso)
}

/// ISO 時間 → 本地時間 `YYYY-MM-DD HH:MM:SS`（`offset` = 本機時區，測試給固定的）。
/// An ISO time in local time (`offset` = this machine's zone; tests pass a fixed one).
pub fn local_time(iso: Option<&str>, offset: FixedOffset) -> String {
    let Some(secs) = iso.and_then(table::parse_iso) else { return iso.unwrap_or("-").to_string() };
    match offset.timestamp_opt(secs, 0).single() {
        Some(t) => t.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => iso.unwrap_or("-").to_string(),
    }
}

/// 誰打的：個人 token 的名字，否則 app 的名字。/ Who made it: the token's name, else the app's.
pub fn caller(call: &Value) -> String {
    call["token"]["name"].as_str().or(call["client_name"].as_str()).filter(|s| !s.is_empty()).unwrap_or("-").to_string()
}

fn dash(s: Option<&str>) -> String {
    s.filter(|x| !x.is_empty()).unwrap_or("-").to_string()
}

pub fn duration(call: &Value) -> String {
    table::ms(call["duration_ms"].as_f64())
}

pub fn headers(show_user: bool) -> Vec<&'static str> {
    let mut h = vec!["TIME"];
    if show_user {
        h.push("USER");
    }
    h.extend(["TOKEN", "METHOD", "ROUTE", "TUNNEL", "STATUS", "DURATION", "IP"]);
    h
}

/// 表格的一列（跟 [`headers`] 同順序）。/ One table row, in [`headers`] order.
pub fn row(call: &Value, offset: FixedOffset, show_user: bool) -> Vec<String> {
    let mut r = vec![local_time(call["at"].as_str(), offset)];
    if show_user {
        r.push(dash(call["user"]["username"].as_str()));
    }
    r.extend([
        caller(call),
        dash(call["method"].as_str()),
        dash(call["route"].as_str()),
        dash(call["tunnel"]["name"].as_str()),
        call["status"].as_i64().map(|s| s.to_string()).unwrap_or_else(|| "-".into()),
        duration(call),
        dash(call["ip"].as_str()),
    ]);
    r
}

/// `--follow` 的一行（不能事先量欄寬，所以用固定寬度）。/ One `--follow` line, fixed widths (rows arrive one by one).
pub fn follow_line(call: &Value, offset: FixedOffset, show_user: bool) -> String {
    let r = row(call, offset, show_user);
    let mut out = String::new();
    let mut i = 0;
    let mut push = |cell: &str, w: usize| {
        out.push_str(cell);
        let pad = w.saturating_sub(table::width(cell)) + 2;
        out.push_str(&" ".repeat(pad));
    };
    push(&r[i], 19);
    i += 1;
    if show_user {
        push(&r[i], 12);
        i += 1;
    }
    push(&r[i], 16); // token
    push(&r[i + 1], 6); // method
    push(&r[i + 2], 0); // route
    out.push_str(&format!("→ {}  {}", r[i + 4], r[i + 5]));
    if r[i + 3] != "-" {
        out.push_str(&format!("  tunnel {}", r[i + 3]));
    }
    if r[i + 6] != "-" {
        out.push_str(&format!("  {}", r[i + 6]));
    }
    if let Some(e) = call["error"].as_str().filter(|e| !e.is_empty()) {
        out.push_str(&format!("  ({e})"));
    }
    out.trim_end().to_string()
}

/// 一把 token 現在的狀態。/ A token's state.
pub fn token_state(t: &Value) -> &'static str {
    if t["revoked_at"].is_string() {
        "revoked"
    } else if t["expired"].as_bool() == Some(true) {
        "expired"
    } else {
        "active"
    }
}

pub const TOKEN_HEADERS: &[&str] = &["NAME", "PREFIX", "SCOPES", "TUNNELS", "EXPIRES", "LAST USED", "24H", "7D", "ERRORS 7D", "STATE"];

/// `telepy api tokens` 的一列。/ One row of `telepy api tokens`.
pub fn token_row(t: &Value, now: i64, offset: FixedOffset) -> Vec<String> {
    let scopes: Vec<&str> = t["scopes"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let tunnels = match t["tunnels"].as_array() {
        None => "all".to_string(),
        Some(a) => a.iter().map(|x| x["name"].as_str().map(str::to_string).unwrap_or_else(|| format!("#{}", x["id"]))).collect::<Vec<_>>().join(","),
    };
    let expires = local_time(t["expires_at"].as_str(), offset);
    let n = |k: &str| t["calls"][k].as_i64().map(|x| x.to_string()).unwrap_or_else(|| "0".into());
    vec![
        dash(t["name"].as_str()),
        format!("{}…", t["prefix"].as_str().unwrap_or("")),
        scopes.join(" "),
        tunnels,
        expires.split(' ').next().unwrap_or("-").to_string(),
        table::ago(t["last_used_at"].as_str(), now),
        n("calls_24h"),
        n("calls_7d"),
        n("errors_7d"),
        token_state(t).to_string(),
    ]
}

/// `--api-token <name|id>` → 自己清單上的那把（名字不分大小寫、id、或前綴）；不在清單上的數字照用（管理員看別人的）。
/// A token by name (case-insensitive), id or prefix from your list; a bare number not on the list is used as is
/// (an admin looking at someone else's).
pub fn find_token(tokens: &[Value], raw: &str) -> Result<i64, String> {
    let r = raw.trim();
    let hit = tokens
        .iter()
        .find(|t| t["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(r)))
        .or_else(|| tokens.iter().find(|t| t["id"].as_i64().map(|i| i.to_string()).as_deref() == Some(r)))
        .or_else(|| tokens.iter().find(|t| t["prefix"].as_str().is_some_and(|p| p == r || (r.len() >= 6 && p.starts_with(r)))));
    if let Some(t) = hit {
        return t["id"].as_i64().ok_or_else(|| "the server sent a token without an id".to_string());
    }
    if let Ok(id) = r.parse::<i64>() {
        return Ok(id);
    }
    let names: Vec<&str> = tokens.iter().filter_map(|t| t["name"].as_str()).collect();
    Err(format!("No API token called '{raw}'. Yours: {}", if names.is_empty() { "(none)".to_string() } else { names.join(", ") }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn utc() -> FixedOffset {
        FixedOffset::east_opt(0).unwrap()
    }

    #[test]
    fn since_durations_and_times() {
        let now = 1_000_000;
        assert_eq!(parse_since("45s", now), Ok(now - 45));
        assert_eq!(parse_since("30m", now), Ok(now - 1800));
        assert_eq!(parse_since("2h", now), Ok(now - 7200));
        assert_eq!(parse_since("2D", now), Ok(now - 172_800));
        assert_eq!(parse_since("1w", now), Ok(now - 604_800));
        assert_eq!(parse_since("2026-10-27T08:00:00+08:00", now), Ok(table::parse_iso("2026-10-27T00:00:00Z").unwrap()));
        for bad in ["", "h", "3y", "-2h", "yesterday", "1.5h", "2026-10-27"] {
            assert!(parse_since(bad, now).is_err(), "{bad}");
        }
    }

    #[test]
    fn status_buckets_and_methods() {
        assert_eq!(parse_status("OK"), Ok("ok".into()));
        assert_eq!(parse_status("4xx"), Ok("4xx".into()));
        assert_eq!(parse_status("5XX"), Ok("5xx".into()));
        assert_eq!(parse_status("error"), Ok("error".into()));
        assert!(parse_status("404").is_err());
        assert_eq!(parse_method("delete"), Ok("DELETE".into()));
        assert_eq!(parse_method("mcp"), Ok("MCP".into()));
        assert!(parse_method("HEAD").is_err());
    }

    #[test]
    fn query_strings() {
        let mut f = Filters { status: Some("4xx".into()), method: Some("GET".into()), token_id: Some(3), ..Default::default() };
        assert_eq!(query(&f, 50, None), "/api/auth/tokens/calls?scope=mine&limit=50&token_id=3&status=4xx&method=GET");
        f.all = true;
        user_filter("ann lee", &mut f);
        assert_eq!(query(&f, 5000, Some(77)), "/api/auth/tokens/calls?scope=all&limit=1000&token_id=3&username=ann%20lee&status=4xx&method=GET&before=77");
        let mut g = Filters::default();
        user_filter("12", &mut g);
        assert_eq!((g.user_id, g.username), (Some(12), None));
    }

    fn call() -> Value {
        json!({"id": 9, "at": "2026-10-27T01:02:03.456Z", "user": {"id": 1, "username": "alice"}, "token": {"id": 3, "name": "ci deploy", "prefix": "tpt_abcd"},
               "method": "DELETE", "route": "/api/reverse/server/keys/{id}", "tunnel": {"id": 4, "name": "box"}, "status": 403, "duration_ms": 12.4, "ip": "10.0.0.5", "error": "token_scope"})
    }

    #[test]
    fn rows_and_follow_lines() {
        let c = call();
        let tpe = FixedOffset::east_opt(8 * 3600).unwrap();
        assert_eq!(row(&c, tpe, false), ["2026-10-27 09:02:03", "ci deploy", "DELETE", "/api/reverse/server/keys/{id}", "box", "403", "12 ms", "10.0.0.5"]);
        assert_eq!(row(&c, utc(), true)[..2], ["2026-10-27 01:02:03".to_string(), "alice".to_string()]);
        assert_eq!(headers(true).len(), row(&c, utc(), true).len());
        let app = json!({"at": "2026-10-27T01:02:03Z", "token": null, "client_name": "Cursor", "method": "GET", "route": "/api/sessions", "tunnel": null, "status": 200, "duration_ms": 1530.0, "ip": null});
        let r = row(&app, utc(), false);
        assert_eq!((r[1].as_str(), r[4].as_str(), r[6].as_str(), r[7].as_str()), ("Cursor", "-", "1.5 s", "-"));
        assert_eq!(follow_line(&c, utc(), false), "2026-10-27 01:02:03  ci deploy         DELETE  /api/reverse/server/keys/{id}  → 403  12 ms  tunnel box  10.0.0.5  (token_scope)");
        assert_eq!(follow_line(&app, utc(), false), "2026-10-27 01:02:03  Cursor            GET     /api/sessions  → 200  1.5 s");
        let rendered = table::render(&headers(false), &[row(&c, utc(), false)]);
        assert!(rendered.starts_with("TIME                 TOKEN      METHOD  ROUTE"), "{rendered}");
        assert!(is_log_read(&json!({"method": "GET", "route": "/api/auth/tokens/calls"})));
        assert!(!is_log_read(&c));
        assert_eq!(call_time(&c), table::parse_iso("2026-10-27T01:02:03Z"));
    }

    #[test]
    fn token_rows_and_lookup() {
        let now = table::parse_iso("2026-10-27T12:00:00Z").unwrap();
        let t = json!({"id": 3, "name": "ci deploy", "prefix": "tpt_abcdef", "scopes": ["tunnels:read", "ssh:exec"], "tunnels": [{"id": 4, "name": "box"}, {"id": 5, "name": null}],
                       "expires_at": "2026-12-01T00:00:00Z", "last_used_at": "2026-10-27T11:55:00Z", "revoked_at": null, "expired": false,
                       "calls": {"calls_24h": 4, "calls_7d": 10, "errors_7d": 1}});
        assert_eq!(token_row(&t, now, utc()), ["ci deploy", "tpt_abcdef…", "tunnels:read ssh:exec", "box,#5", "2026-12-01", "5m ago", "4", "10", "1", "active"]);
        let all = json!({"id": 8, "name": "nightly", "prefix": "tpt_zz", "scopes": [], "tunnels": null, "expires_at": "2026-10-01T00:00:00Z", "expired": true, "revoked_at": null, "calls": {}});
        let r = token_row(&all, now, utc());
        assert_eq!((r[3].as_str(), r[5].as_str(), r[6].as_str(), r[9].as_str()), ("all", "-", "0", "expired"));
        assert_eq!(token_state(&json!({"revoked_at": "2026-10-02T00:00:00Z", "expired": true})), "revoked");
        let list = vec![t, all];
        assert_eq!(find_token(&list, "CI DEPLOY"), Ok(3));
        assert_eq!(find_token(&list, "8"), Ok(8));
        assert_eq!(find_token(&list, "tpt_zz"), Ok(8));
        assert_eq!(find_token(&list, "41"), Ok(41), "an id not on my list (admin view)");
        assert!(find_token(&list, "nope").unwrap_err().contains("ci deploy, nightly"));
    }
}
