//! 定時重掃與「注意這台」的純函式：可選的間隔、下次什麼時候，以及一台被注意的主機在一次掃描後算不算「不見了 /
//! 回來了 / port 變了」。執行在 `schedule.rs` 與 `scan.rs`。
//! Pure helpers for scheduled rescans and watched hosts: the intervals on offer, when the next run is, and whether a
//! watched host went down, came back or changed ports in a scan. `schedule.rs` and `scan.rs` run them.

use serde::Serialize;

/// 可以選的重掃間隔（秒）：每小時、6 / 12 小時、每天、每週。/ The rescan intervals on offer (seconds).
pub const EVERY: &[i64] = &[3600, 6 * 3600, 12 * 3600, 86_400, 7 * 86_400];

/// 裝置離線或同一條隧道正在掃：過這麼久再看一次。/ Device offline or a scan running: look again after this long.
pub const RETRY_SECS: i64 = 300;

pub fn valid_every(secs: i64) -> bool {
    EVERY.contains(&secs)
}

/// 被注意的主機在一次掃描後怎麼了。/ What happened to a watched host in a scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchState {
    /// 之前看得到，這次沒看到。/ Seen before, not this time.
    Down,
    /// 之前沒看到，這次又看到了。/ Not seen before, seen again now.
    Up,
    /// 兩次都在，port 有開有關。/ Seen both times, ports opened or closed.
    Ports,
}

impl WatchState {
    pub fn as_str(self) -> &'static str {
        match self {
            WatchState::Down => "down",
            WatchState::Up => "up",
            WatchState::Ports => "ports",
        }
    }
}

/// `was_up` = 掃描前它算「看得到」；`now_up` = 這次找到了；`opened` / `closed` = 這次探過的 port 的差別。
/// 沒變就是 None（一直不在也不吵）。
/// `was_up` = it counted as seen before the scan; `now_up` = found this time; `opened` / `closed` = the change among
/// the ports probed this time. None when nothing changed (a host that stays away doesn't nag).
pub fn transition(was_up: bool, now_up: bool, opened: &[u16], closed: &[u16]) -> Option<WatchState> {
    match (was_up, now_up) {
        (true, false) => Some(WatchState::Down),
        (false, true) => Some(WatchState::Up),
        (true, true) if !opened.is_empty() || !closed.is_empty() => Some(WatchState::Ports),
        _ => None,
    }
}

/// 「掃描前算不算看得到」：掃過才算數（沒有 `last_seen` = 從沒被掃到，不算在）；有 `checked_at` 就看它，否則看最近一次
/// 整網段掃描的時間（`fallback_scanned_at`，較早的資料只有這個）。
/// Whether a host counted as seen before a scan: only once a scan has seen it; with `checked_at` that decides,
/// otherwise the time of the last full scan (`fallback_scanned_at`, all older data has).
pub fn was_seen(last_seen: Option<&str>, checked_at: Option<&str>, fallback_scanned_at: Option<&str>) -> bool {
    let Some(seen) = last_seen else { return false };
    match checked_at.or(fallback_scanned_at) {
        Some(at) => seen >= at,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions() {
        assert_eq!(transition(true, false, &[], &[]), Some(WatchState::Down));
        assert_eq!(transition(false, true, &[], &[]), Some(WatchState::Up));
        assert_eq!(transition(true, true, &[443], &[]), Some(WatchState::Ports));
        assert_eq!(transition(true, true, &[], &[]), None);
        assert_eq!(transition(false, false, &[], &[]), None, "a host that stays away doesn't nag");
        assert_eq!(WatchState::Ports.as_str(), "ports");
    }

    #[test]
    fn seen_before_a_scan() {
        let t = |s: &str| Some(s.to_string());
        let (a, b) = (t("2026-11-03 10:00:00.000000"), t("2026-11-03 11:00:00.000000"));
        assert!(was_seen(b.as_deref(), a.as_deref(), None), "seen at the last check");
        assert!(was_seen(a.as_deref(), a.as_deref(), None), "the same instant = found by that scan");
        assert!(!was_seen(a.as_deref(), b.as_deref(), None), "the last check didn't see it");
        assert!(!was_seen(a.as_deref(), None, b.as_deref()), "no check yet: the last full scan decides");
        assert!(was_seen(a.as_deref(), None, None), "never compared: seen");
        assert!(!was_seen(None, b.as_deref(), None), "never found by a scan");
    }

    #[test]
    fn intervals() {
        assert!(valid_every(3600) && valid_every(604_800));
        assert!(!valid_every(60) && !valid_every(0));
    }
}
