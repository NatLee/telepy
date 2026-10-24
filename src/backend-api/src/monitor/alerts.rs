//! 隧道狀態告警（給管理員設定的 webhook：Slack / Discord / Google Chat / 自己的服務）。
//! 每條隧道兩種狀況各自計時：離線（down）與降級（degraded）。狀況開始後要「持續」超過設定的延遲才發出
//! offline / degraded；只有發過的狀況結束時才發 online / recovered——裝置閃斷幾秒不會洗版。
//! 狀態機是純的（時間由呼叫端給），I/O（送 webhook）在 [`deliver`]。
//! Tunnel status alerts for the admin's webhook. Two conditions per tunnel, each timed separately: down and
//! degraded. A condition must last longer than the configured delay before offline / degraded is sent, and only
//! a condition that was announced sends online / recovered when it ends, so a device that blips for a few
//! seconds sends nothing. The state machine is pure (the caller passes the time); [`deliver`] does the I/O.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Condition {
    Down,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alert {
    Offline,
    Online,
    Degraded,
    Recovered,
    /// 裝置換了公網 IP（不經狀態機，連上時直接送，見 [`send_ip_change`]）。/ The device connected from a new IP.
    IpChanged,
}

impl Alert {
    pub fn event(self) -> &'static str {
        match self {
            Alert::Offline => "tunnel.offline",
            Alert::Online => "tunnel.online",
            Alert::Degraded => "tunnel.degraded",
            Alert::Recovered => "tunnel.recovered",
            Alert::IpChanged => "tunnel.ip_changed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Pending(Instant),
    Announced,
}

#[derive(Default)]
pub struct Alerts {
    state: HashMap<(i64, Condition), Phase>,
}

impl Alerts {
    /// 狀況開始（隧道斷線 / 降級）。離線開始時一併靜靜清掉降級：斷線之後再發「SSH 已恢復」會誤導人。
    /// A condition starts. Going down silently clears degraded, so no misleading "recovered" follows.
    pub fn start(&mut self, tunnel_id: i64, c: Condition, now: Instant) {
        if c == Condition::Down {
            self.state.remove(&(tunnel_id, Condition::Degraded));
        }
        self.state.entry((tunnel_id, c)).or_insert(Phase::Pending(now));
    }

    /// 狀況結束：發過開始的才回結束的告警；還在等的就當沒發生。/ A condition ends; only announced ones alert.
    pub fn end(&mut self, tunnel_id: i64, c: Condition) -> Option<Alert> {
        match self.state.remove(&(tunnel_id, c)) {
            Some(Phase::Announced) => Some(match c {
                Condition::Down => Alert::Online,
                Condition::Degraded => Alert::Recovered,
            }),
            _ => None,
        }
    }

    /// 持續超過 `delay` 的狀況現在發出。/ Conditions that lasted longer than `delay` are announced now.
    pub fn due(&mut self, now: Instant, delay: Duration) -> Vec<(i64, Alert)> {
        let mut out = Vec::new();
        for ((tunnel_id, c), phase) in self.state.iter_mut() {
            if let Phase::Pending(since) = *phase {
                if now.saturating_duration_since(since) >= delay {
                    *phase = Phase::Announced;
                    out.push((*tunnel_id, if *c == Condition::Down { Alert::Offline } else { Alert::Degraded }));
                }
            }
        }
        out.sort_by_key(|(id, _)| *id);
        out
    }

    /// 隧道刪掉了：忘記它。/ The tunnel is gone.
    pub fn forget(&mut self, tunnel_id: i64) {
        self.state.retain(|(id, _), _| *id != tunnel_id);
    }

    /// 只留還存在的隧道。/ Keep only tunnels that still exist.
    pub fn keep_only(&mut self, ids: &std::collections::HashSet<i64>) {
        self.state.retain(|(id, _), _| ids.contains(id));
    }
}

/// webhook 的內容：`text`（Slack / Google Chat / Mattermost）與 `content`（Discord）放同一句話，
/// 其餘欄位給自己寫的接收端用。
/// The webhook body: the same sentence as `text` (Slack, Google Chat, Mattermost) and `content` (Discord),
/// plus structured fields for custom receivers.
pub fn payload(alert: Alert, tunnel_id: i64, name: &str, port: i64, server: Option<&str>, at_iso: &str) -> Value {
    let what = match alert {
        Alert::Offline => "is offline",
        Alert::Online => "is back online",
        Alert::Degraded => "is connected, but its SSH server is not answering",
        Alert::Recovered => "answers SSH again",
        Alert::IpChanged => "connected from a new IP address",
    };
    let text = format!("[Telepy] {name} {what} (port {port})");
    json!({
        "text": text,
        "content": text,
        "event": alert.event(),
        "tunnel": { "id": tunnel_id, "name": name, "reverse_port": port },
        "server": server,
        "at": at_iso,
    })
}

/// IP 變更的 webhook 內容：一般欄位再加上 `previous_ip` / `ip`。/ The IP-change body: the usual fields plus both IPs.
pub fn ip_changed_payload(tunnel_id: i64, name: &str, port: i64, previous: &str, ip: &str, server: Option<&str>, at_iso: &str) -> Value {
    let mut body = payload(Alert::IpChanged, tunnel_id, name, port, server, at_iso);
    let text = format!("[Telepy] {name} connected from a new IP address: {ip} (was {previous}, port {port})");
    body["text"] = json!(text);
    body["content"] = json!(text);
    body["previous_ip"] = json!(previous);
    body["ip"] = json!(ip);
    body
}

/// 告警用的 HTTP client（gateway 沒有 AppState，所以自己留一個）。/ An HTTP client for alerts, usable without AppState.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("reqwest client"))
}

/// 給 gateway 用：裝置換 IP 時呼叫；有設 webhook 才在背景送，沒設就什麼都不做。
/// For the gateway: call when a device connects from a new IP. Sends in the background only if a webhook is set.
pub async fn send_ip_change(db: &crate::db::Db, server: Option<&str>, tunnel_id: i64, name: &str, port: i64, previous: &str, ip: &str) {
    let url = match crate::db::settings::get_solo(db).await {
        Ok(s) if !s.notify_webhook_url.trim().is_empty() => s.notify_webhook_url,
        _ => return,
    };
    let body = ip_changed_payload(tunnel_id, name, port, previous, ip, server, &crate::util::db_to_iso_utc_z(&crate::util::now_db()));
    let name = name.to_string();
    tokio::spawn(async move {
        if let Err(e) = deliver(client(), &url, &body).await {
            tracing::warn!(tunnel = %name, error = %e, "ip change alert failed");
        }
    });
}

/// 送出一則 webhook；回 HTTP 狀態碼或錯誤訊息。/ POST one webhook; the HTTP status or an error message.
pub async fn deliver(http: &reqwest::Client, url: &str, body: &Value) -> Result<u16, String> {
    let res = http.post(url).timeout(Duration::from_secs(10)).json(body).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if status.is_success() {
        Ok(status.as_u16())
    } else {
        Err(format!("HTTP {}", status.as_u16()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: Duration = Duration::from_secs(60);

    #[test]
    fn short_blips_send_nothing() {
        let t0 = Instant::now();
        let mut a = Alerts::default();
        a.start(1, Condition::Down, t0);
        assert!(a.due(t0 + Duration::from_secs(30), D).is_empty());
        assert_eq!(a.end(1, Condition::Down), None, "back before the delay: no online either");
        assert!(a.due(t0 + Duration::from_secs(120), D).is_empty());
    }

    #[test]
    fn long_outages_send_offline_then_online_once() {
        let t0 = Instant::now();
        let mut a = Alerts::default();
        a.start(1, Condition::Down, t0);
        a.start(1, Condition::Down, t0 + Duration::from_secs(10)); // repeated start keeps the first time
        assert_eq!(a.due(t0 + D, D), vec![(1, Alert::Offline)]);
        assert!(a.due(t0 + D * 2, D).is_empty(), "announced once");
        assert_eq!(a.end(1, Condition::Down), Some(Alert::Online));
        assert_eq!(a.end(1, Condition::Down), None);
    }

    #[test]
    fn going_down_clears_degraded_silently() {
        let t0 = Instant::now();
        let mut a = Alerts::default();
        a.start(7, Condition::Degraded, t0);
        assert_eq!(a.due(t0 + D, D), vec![(7, Alert::Degraded)]);
        a.start(7, Condition::Down, t0 + D);
        assert_eq!(a.end(7, Condition::Degraded), None, "no 'recovered' after the tunnel dropped");
        assert_eq!(a.due(t0 + D * 2, D), vec![(7, Alert::Offline)]);
    }

    #[test]
    fn zero_delay_and_forget() {
        let t0 = Instant::now();
        let mut a = Alerts::default();
        a.start(2, Condition::Down, t0);
        a.start(3, Condition::Down, t0);
        a.forget(3);
        assert_eq!(a.due(t0, Duration::ZERO), vec![(2, Alert::Offline)]);
    }

    #[test]
    fn ip_change_payload_has_both_addresses() {
        let p = ip_changed_payload(4, "nas", 1024, "198.51.100.1", "203.0.113.9", None, "2026-10-23T12:00:00Z");
        assert_eq!(p["event"], "tunnel.ip_changed");
        assert_eq!((p["previous_ip"].as_str(), p["ip"].as_str()), (Some("198.51.100.1"), Some("203.0.113.9")));
        assert!(p["content"].as_str().unwrap().contains("203.0.113.9"));
    }

    #[test]
    fn payload_works_for_slack_and_discord() {
        let p = payload(Alert::Degraded, 4, "office-pi", 1025, Some("https://telepy.example"), "2026-10-23T12:00:00Z");
        assert_eq!(p["text"], p["content"]);
        assert!(p["text"].as_str().unwrap().contains("office-pi"));
        assert_eq!(p["event"], "tunnel.degraded");
        assert_eq!(p["tunnel"]["reverse_port"], 1025);
    }
}
