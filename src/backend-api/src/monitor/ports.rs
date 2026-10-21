//! `update_ports` 的純邏輯：去彈跳（hysteresis）與延遲廣播節流。
//! 從 Django management command 原封移植成純函式，M3 的監控迴圈與 M5 的 gateway 事件都用它。
//! Pure port-monitor logic (debounce + latency throttle) ported from the Django command.

use std::collections::{BTreeMap, HashMap};

/// port 狀態需連續 FLAP_THRESHOLD 次與「已承認狀態」不同，才承認變更。
pub const FLAP_THRESHOLD: u32 = 2;
pub const LATENCY_BROADCAST_THRESHOLD_MS: f64 = 5.0;
pub const LATENCY_BROADCAST_KEEPALIVE_CYCLES: u32 = 6;

#[derive(Default, Debug)]
pub struct Debouncer {
    counters: HashMap<i64, u32>,
}

impl Debouncer {
    /// 回傳本輪「承認」的狀態表。/ Returns the committed state map for this cycle.
    pub fn apply(&mut self, raw: &BTreeMap<i64, bool>, committed: &BTreeMap<i64, bool>) -> BTreeMap<i64, bool> {
        let mut now = BTreeMap::new();
        let mut next_counters = HashMap::new();
        for (port, raw_status) in raw {
            let prev = committed.get(port).copied().unwrap_or(false);
            if *raw_status == prev {
                now.insert(*port, prev);
            } else {
                let count = self.counters.get(port).copied().unwrap_or(0) + 1;
                if count >= FLAP_THRESHOLD {
                    now.insert(*port, *raw_status);
                } else {
                    now.insert(*port, prev);
                    next_counters.insert(*port, count);
                }
            }
        }
        self.counters = next_counters;
        now
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Transitions {
    pub connected: Vec<i64>,
    pub disconnected: Vec<i64>,
}

pub fn transitions(previous: &BTreeMap<i64, bool>, now: &BTreeMap<i64, bool>) -> Transitions {
    let mut t = Transitions { connected: vec![], disconnected: vec![] };
    for (port, status) in now {
        let prev = previous.get(port).copied().unwrap_or(false);
        if *status && !prev {
            t.connected.push(*port);
        } else if !*status && prev {
            t.disconnected.push(*port);
        }
    }
    t
}

#[derive(Default, Debug)]
pub struct LatencyThrottle {
    last: HashMap<u16, f64>,
    counter: u32,
}

impl LatencyThrottle {
    /// 任一 port 變化 ≥ 門檻、或 port 集合變動 → 廣播；否則累計，到 keep-alive 週期強制廣播一次。
    pub fn should_broadcast(&mut self, latency: &HashMap<u16, f64>) -> bool {
        let mut changed = latency.len() != self.last.len() || latency.keys().any(|k| !self.last.contains_key(k));
        if !changed {
            for (port, rtt) in latency {
                match self.last.get(port) {
                    Some(prev) if (rtt - prev).abs() < LATENCY_BROADCAST_THRESHOLD_MS => {}
                    _ => {
                        changed = true;
                        break;
                    }
                }
            }
        }
        let force = self.counter + 1 >= LATENCY_BROADCAST_KEEPALIVE_CYCLES;
        if changed || force {
            self.last = latency.clone();
            self.counter = 0;
            true
        } else {
            self.counter += 1;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pairs: &[(i64, bool)]) -> BTreeMap<i64, bool> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn debounce_requires_two_consecutive_cycles() {
        let mut d = Debouncer::default();
        let committed = m(&[(1, false)]);
        let c1 = d.apply(&m(&[(1, true)]), &committed);
        assert_eq!(c1, m(&[(1, false)]), "first differing sample is held");
        let c2 = d.apply(&m(&[(1, true)]), &c1);
        assert_eq!(c2, m(&[(1, true)]), "second consecutive sample commits");
        // a flap resets the counter
        let c3 = d.apply(&m(&[(1, false)]), &c2);
        assert_eq!(c3, m(&[(1, true)]));
        let c4 = d.apply(&m(&[(1, true)]), &c3);
        assert_eq!(c4, m(&[(1, true)]));
        assert!(d.counters.is_empty());
    }

    #[test]
    fn transition_detection() {
        let t = transitions(&m(&[(1, false), (2, true)]), &m(&[(1, true), (2, false), (3, false)]));
        assert_eq!(t, Transitions { connected: vec![1], disconnected: vec![2] });
    }

    #[test]
    fn latency_throttle() {
        let mut th = LatencyThrottle::default();
        let a: HashMap<u16, f64> = [(1u16, 80.0)].into_iter().collect();
        assert!(th.should_broadcast(&a), "first sample always broadcasts");
        let b: HashMap<u16, f64> = [(1u16, 83.0)].into_iter().collect();
        assert!(!th.should_broadcast(&b), "jitter under threshold is suppressed");
        let c: HashMap<u16, f64> = [(1u16, 90.0)].into_iter().collect();
        assert!(th.should_broadcast(&c), "change ≥ 5ms broadcasts");
        for _ in 0..(LATENCY_BROADCAST_KEEPALIVE_CYCLES - 1) {
            assert!(!th.should_broadcast(&c));
        }
        assert!(th.should_broadcast(&c), "keep-alive forces a broadcast");
        let d: HashMap<u16, f64> = [(1u16, 90.0), (2u16, 10.0)].into_iter().collect();
        assert!(th.should_broadcast(&d), "new port broadcasts");
    }
}
