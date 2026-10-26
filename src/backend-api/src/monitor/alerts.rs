//! 隧道狀態告警的計時（每個 webhook 一份）。每條隧道兩種狀況各自計時：離線（down）與降級（degraded）。
//! 狀況開始後要「持續」超過 webhook 設的延遲才發出 offline / degraded；只有發過的狀況結束時才發 online / recovered
//! ——裝置閃斷幾秒不會洗版。狀態機是純的（時間由呼叫端給）；送出在 `webhooks`。
//! Tunnel status alert timing, one per webhook. Two conditions per tunnel, each timed separately: down and
//! degraded. A condition must last longer than the webhook's delay before offline / degraded is sent, and only
//! a condition that was announced sends online / recovered when it ends, so a device that blips for a few
//! seconds sends nothing. The state machine is pure (the caller passes the time); sending lives in `webhooks`.

use std::collections::HashMap;
use std::time::{Duration, Instant};

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
}

impl Alert {
    pub fn kind(self) -> crate::webhooks::Kind {
        use crate::webhooks::Kind;
        match self {
            Alert::Offline => Kind::TunnelOffline,
            Alert::Online => Kind::TunnelOnline,
            Alert::Degraded => Kind::TunnelDegraded,
            Alert::Recovered => Kind::TunnelRecovered,
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
}
