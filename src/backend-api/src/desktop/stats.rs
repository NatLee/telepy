//! 串流統計：中繼每秒給瀏覽器一個 `telepy-stats` 指令（JSON），讓畫面上看得到延遲與串流狀況。
//!
//! 三個延遲，各量一段：
//! - **畫面往返**（`frame_ms`）：guacd 每一幀結尾送 `sync <ts>`，瀏覽器把那一幀畫完才回 `sync <ts>`；
//!   從中繼送出到收到回音 = WebSocket 來回 + 瀏覽器解碼／繪製，就是使用者感覺到的「卡」。
//! - **網路往返**（`net_ms`）：中繼每秒送 `telepy-ping <n>`，瀏覽器立刻回 `telepy-pong <n>`（不經 guacd、
//!   不畫圖），桌面靜止時也量得到。
//! - **隧道**（`tunnel_ms`）：monitor 每 15 秒經轉發通道量到的裝置 sshd 往返，由中繼從 `StatusState` 帶上。
//!
//! 另有每秒幀數、上下行位元組、瀏覽器落後幾幀（送出但還沒回音的 sync）、guacd 合併了幾個邏輯幀
//! （`sync` 的第二個參數 > 1 = 瀏覽器跟不上，guacd 在併幀），以及聲音串流（guacd 開的 `audio` 串流上的 `blob`）
//! 的位元組：`audio` = 這一秒的量，沒開過聲音串流時是 null（瀏覽器就能分「遠端沒開聲音通道」與「開了但安靜」）。
//!
//! 純邏輯、無 I/O；`ws/desktop.rs` 餵事件、每秒 `tick`。
//! Stream statistics for the remote desktop relay: frame round-trip (sync echo), network round-trip
//! (ping / pong), the device's tunnel latency, frames per second, bytes and how far behind the browser is.
//! Pure; the relay feeds it and calls `tick` every second.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use serde_json::json;

use super::guac::{self, Unit};

/// 統計與 ping 的週期。/ How often stats and pings go out.
pub const INTERVAL: Duration = Duration::from_secs(1);
/// 沒回音的 sync 最多記幾個（guacd 可能一秒送幾十幀）。/ Cap on unacknowledged syncs.
pub const MAX_PENDING: usize = 128;
/// 多久沒有新的樣本就不再報上一個值。/ A sample older than this is no longer reported.
pub const STALE_AFTER: Duration = Duration::from_secs(3);
pub const OPCODE_STATS: &str = "telepy-stats";
pub const OPCODE_PING: &str = "telepy-ping";
pub const OPCODE_PONG: &str = "telepy-pong";

#[derive(Debug, Default, Clone, Copy)]
struct Window {
    frames: u32,
    merged: u32,
    down: u64,
    up: u64,
    /// 聲音串流的 blob（base64 字元數）。/ Base64 bytes of blobs on audio streams.
    audio: u64,
}

pub struct Stats {
    pending_syncs: VecDeque<(u64, Instant)>,
    pending_pings: VecDeque<(u64, Instant)>,
    next_ping: u64,
    window: Window,
    window_started: Instant,
    last_frame: Option<(u32, Instant)>,
    last_net: Option<(u32, Instant)>,
    // 整段 session 的總計（結束時寫進日誌）。/ Session totals for the close log line.
    total_down: u64,
    total_up: u64,
    total_frames: u64,
    frame_sum_ms: u64,
    frame_samples: u64,
    frame_max_ms: u32,
    /// guacd 目前開著的聲音串流（stream index）。/ guacd's open audio streams, by index.
    audio_streams: HashSet<String>,
    audio_opened: bool,
    total_audio: u64,
}

impl Default for Stats {
    fn default() -> Self {
        Self::new(Instant::now())
    }
}

impl Stats {
    pub fn new(now: Instant) -> Self {
        Self {
            pending_syncs: VecDeque::new(),
            pending_pings: VecDeque::new(),
            next_ping: 1,
            window: Window::default(),
            window_started: now,
            last_frame: None,
            last_net: None,
            total_down: 0,
            total_up: 0,
            total_frames: 0,
            frame_sum_ms: 0,
            frame_samples: 0,
            frame_max_ms: 0,
            audio_streams: HashSet::new(),
            audio_opened: false,
            total_audio: 0,
        }
    }

    /// guacd → 瀏覽器的一個指令：`sync` 記下時間戳與送出時刻；`audio` / `blob` / `end` 記聲音串流。
    /// An instruction on its way to the browser: syncs are timed, audio streams are counted.
    pub fn sent(&mut self, instruction: &guac::Instruction, now: Instant) {
        match instruction.opcode() {
            "sync" => {}
            "audio" => {
                if let Some(index) = instruction.element(1) {
                    self.audio_streams.insert(index.to_string());
                    self.audio_opened = true;
                }
                return;
            }
            "blob" => {
                if instruction.element(1).is_some_and(|i| self.audio_streams.contains(i)) {
                    let n = instruction.element(2).map(str::len).unwrap_or(0) as u64;
                    self.window.audio += n;
                    self.total_audio += n;
                }
                return;
            }
            "end" => {
                if let Some(index) = instruction.element(1) {
                    self.audio_streams.remove(index);
                }
                return;
            }
            _ => return,
        }
        self.window.frames += 1;
        self.total_frames += 1;
        if let Some(merged) = instruction.element(2).and_then(|f| f.parse::<u32>().ok()) {
            self.window.merged = self.window.merged.max(merged);
        }
        if let Some(ts) = instruction.element(1).and_then(|t| t.parse::<u64>().ok()) {
            // 同一毫秒的幾幀只會有一次回音：同一個時間戳只記一次。/ One echo per distinct timestamp.
            if self.pending_syncs.back().map(|(t, _)| *t != ts).unwrap_or(true) {
                self.pending_syncs.push_back((ts, now));
                while self.pending_syncs.len() > MAX_PENDING {
                    self.pending_syncs.pop_front();
                }
            }
        }
    }

    pub fn add_down(&mut self, bytes: usize) {
        self.window.down += bytes as u64;
        self.total_down += bytes as u64;
    }

    pub fn add_up(&mut self, bytes: usize) {
        self.window.up += bytes as u64;
        self.total_up += bytes as u64;
    }

    /// 瀏覽器 → guacd 的一個指令：`sync` 的回音結算那一幀（連同更早、沒回音的），`telepy-pong` 結算 ping。
    /// 回 true = 這是我們自己的 ping 回音，不要轉給 guacd。/ true = our own pong; do not forward it.
    pub fn received(&mut self, instruction: &guac::Instruction, now: Instant) -> bool {
        match instruction.opcode() {
            "sync" => {
                if let Some(ts) = instruction.element(1).and_then(|t| t.parse::<u64>().ok()) {
                    let mut matched = None;
                    while let Some(&(t, at)) = self.pending_syncs.front() {
                        if t > ts {
                            break;
                        }
                        self.pending_syncs.pop_front();
                        if t == ts {
                            matched = Some(at);
                        }
                    }
                    if let Some(at) = matched {
                        let ms = clamp_ms(now.saturating_duration_since(at));
                        self.last_frame = Some((ms, now));
                        self.frame_sum_ms += ms as u64;
                        self.frame_samples += 1;
                        self.frame_max_ms = self.frame_max_ms.max(ms);
                    }
                }
                false
            }
            OPCODE_PONG => {
                if let Some(n) = instruction.element(1).and_then(|t| t.parse::<u64>().ok()) {
                    while let Some(&(k, at)) = self.pending_pings.front() {
                        if k > n {
                            break;
                        }
                        self.pending_pings.pop_front();
                        if k == n {
                            self.last_net = Some((clamp_ms(now.saturating_duration_since(at)), now));
                        }
                    }
                }
                true
            }
            _ => false,
        }
    }

    /// 下一個 ping 的線路文字（瀏覽器端的長度單位）。/ The next ping, encoded for the browser.
    pub fn ping(&mut self, now: Instant) -> String {
        let n = self.next_ping;
        self.next_ping += 1;
        self.pending_pings.push_back((n, now));
        while self.pending_pings.len() > 8 {
            self.pending_pings.pop_front();
        }
        guac::encode(&[OPCODE_PING, &n.to_string()], Unit::Utf16)
    }

    /// 這一秒的統計（線路文字），並開始下一個視窗。/ This window's stats as an instruction; starts the next window.
    pub fn tick(&mut self, now: Instant, tunnel_ms: Option<f64>) -> String {
        let elapsed = now.saturating_duration_since(self.window_started).as_millis().max(1) as u64;
        let fresh = |s: Option<(u32, Instant)>| s.filter(|(_, at)| now.saturating_duration_since(*at) <= STALE_AFTER).map(|(ms, _)| ms);
        let w = self.window;
        let body = json!({
            "ms": elapsed,
            "frame_ms": fresh(self.last_frame),
            "net_ms": fresh(self.last_net),
            "tunnel_ms": tunnel_ms.map(|v| v.round() as u64),
            "frames": w.frames,
            "merged": w.merged,
            "down": w.down,
            "up": w.up,
            "behind": self.pending_syncs.len(),
            "audio": if self.audio_opened { Some(w.audio) } else { None },
        });
        self.window = Window::default();
        self.window_started = now;
        guac::encode(&[OPCODE_STATS, &body.to_string()], Unit::Utf16)
    }

    /// 給結束日誌的一句：`1.2 MB to the browser, 2,340 frames, frame latency avg 48 ms (max 210 ms)`。
    /// One line for the close event.
    pub fn summary(&self) -> String {
        let mut s = format!("{} to the browser, {} frames", fmt_bytes(self.total_down), self.total_frames);
        if self.frame_samples > 0 {
            s.push_str(&format!(", frame latency avg {} ms (max {} ms)", self.frame_sum_ms / self.frame_samples, self.frame_max_ms));
        }
        if self.audio_opened {
            s.push_str(&format!(", sound {}", fmt_bytes(self.total_audio)));
        }
        s
    }

    /// guacd 開過聲音串流（RDP 伺服器接受了聲音轉送）。/ guacd opened an audio stream (the RDP server redirects sound).
    pub fn audio_opened(&self) -> bool {
        self.audio_opened
    }

    pub fn total_down(&self) -> u64 {
        self.total_down
    }

    pub fn total_up(&self) -> u64 {
        self.total_up
    }
}

fn clamp_ms(d: Duration) -> u32 {
    d.as_millis().min(u32::MAX as u128) as u32
}

pub fn fmt_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    let f = n as f64;
    if f >= KB * KB * KB {
        format!("{:.1} GB", f / (KB * KB * KB))
    } else if f >= KB * KB {
        format!("{:.1} MB", f / (KB * KB))
    } else if f >= KB {
        format!("{:.0} KB", f / KB)
    } else {
        format!("{n} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::guac::Parser;

    fn parse(unit: Unit, wire: &str) -> guac::Instruction {
        let mut p = Parser::new(unit);
        p.push(wire.as_bytes());
        p.next().unwrap().unwrap()
    }

    fn stats_json(wire: &str) -> serde_json::Value {
        let i = parse(Unit::Utf16, wire);
        assert_eq!(i.opcode(), OPCODE_STATS);
        serde_json::from_str(i.element(1).unwrap()).unwrap()
    }

    #[test]
    fn audio_stream_blobs_are_counted_and_other_streams_are_not() {
        let t0 = Instant::now();
        let mut s = Stats::new(t0);
        // 還沒開聲音串流：audio = null，結束那句不提聲音。/ No audio stream yet: null, and no sound in the summary.
        let v = stats_json(&s.tick(t0 + Duration::from_secs(1), None));
        assert!(v["audio"].is_null());
        assert!(!s.audio_opened());
        s.sent(&parse(Unit::CodePoints, "5.audio,1.1,31.audio/L16;rate=44100,channels=2;"), t0);
        s.sent(&parse(Unit::CodePoints, "4.blob,1.1,8.AAAAAAAA;"), t0);
        s.sent(&parse(Unit::CodePoints, "4.blob,1.1,4.QUJD;"), t0);
        // 剪貼簿（stream 2）的 blob 不算聲音。/ A clipboard stream's blob is not sound.
        s.sent(&parse(Unit::CodePoints, "4.blob,1.2,4.QUJD;"), t0);
        let v = stats_json(&s.tick(t0 + Duration::from_secs(2), None));
        assert_eq!(v["audio"], 12);
        assert!(s.audio_opened());
        let v = stats_json(&s.tick(t0 + Duration::from_secs(3), None));
        assert_eq!(v["audio"], 0, "an open but quiet stream reports 0, not null");
        s.sent(&parse(Unit::CodePoints, "3.end,1.1;"), t0);
        s.sent(&parse(Unit::CodePoints, "4.blob,1.1,4.QUJD;"), t0);
        assert_eq!(stats_json(&s.tick(t0 + Duration::from_secs(4), None))["audio"], 0, "an ended stream index is no longer sound");
        assert!(s.summary().ends_with(", sound 12 B"), "{}", s.summary());
    }

    #[test]
    fn a_sync_echo_measures_the_frame_round_trip() {
        let t0 = Instant::now();
        let mut s = Stats::new(t0);
        s.sent(&parse(Unit::CodePoints, "4.sync,4.1000,1.1;"), t0);
        s.sent(&parse(Unit::CodePoints, "4.sync,4.1000,1.1;"), t0 + Duration::from_millis(1));
        s.sent(&parse(Unit::CodePoints, "4.sync,4.1016,1.3;"), t0 + Duration::from_millis(16));
        assert_eq!(s.pending_syncs.len(), 2, "one entry per distinct timestamp");
        let forwarded = s.received(&parse(Unit::Utf16, "4.sync,4.1016;"), t0 + Duration::from_millis(66));
        assert!(!forwarded, "sync echoes still go to guacd");
        assert!(s.pending_syncs.is_empty(), "older unanswered syncs are settled too");
        let v = stats_json(&s.tick(t0 + Duration::from_secs(1), Some(12.4)));
        assert_eq!(v["frame_ms"], 50);
        assert_eq!(v["frames"], 3);
        assert_eq!(v["merged"], 3);
        assert_eq!(v["tunnel_ms"], 12);
        assert_eq!(v["behind"], 0);
        assert!(v["net_ms"].is_null());
        assert_eq!(v["ms"], 1000);
    }

    #[test]
    fn pongs_measure_the_network_and_are_not_forwarded() {
        let t0 = Instant::now();
        let mut s = Stats::new(t0);
        let ping = s.ping(t0);
        assert_eq!(ping, "11.telepy-ping,1.1;");
        let _ = s.ping(t0 + Duration::from_secs(1));
        assert!(s.received(&parse(Unit::Utf16, "11.telepy-pong,1.2;"), t0 + Duration::from_millis(1030)));
        let v = stats_json(&s.tick(t0 + Duration::from_secs(2), None));
        assert_eq!(v["net_ms"], 30);
        assert!(v["tunnel_ms"].is_null());
        assert!(s.pending_pings.is_empty(), "ping 1 was skipped by pong 2");
    }

    #[test]
    fn stale_samples_drop_out_and_windows_reset() {
        let t0 = Instant::now();
        let mut s = Stats::new(t0);
        s.sent(&parse(Unit::CodePoints, "4.sync,2.10;"), t0);
        s.received(&parse(Unit::Utf16, "4.sync,2.10;"), t0 + Duration::from_millis(40));
        s.add_down(2048);
        s.add_up(100);
        let v = stats_json(&s.tick(t0 + Duration::from_secs(1), None));
        assert_eq!(v["frame_ms"], 40);
        assert_eq!(v["down"], 2048);
        assert_eq!(v["up"], 100);
        let v = stats_json(&s.tick(t0 + Duration::from_secs(2), None));
        assert_eq!(v["frame_ms"], 40, "still fresh within 3 s");
        assert_eq!(v["down"], 0, "a new window");
        assert_eq!(v["frames"], 0);
        let v = stats_json(&s.tick(t0 + Duration::from_secs(5), None));
        assert!(v["frame_ms"].is_null(), "no echo for more than 3 s");
        assert_eq!(s.total_down(), 2048);
        assert_eq!(s.total_up(), 100);
        assert_eq!(s.summary(), "2 KB to the browser, 1 frames, frame latency avg 40 ms (max 40 ms)");
    }

    #[test]
    fn behind_counts_unanswered_syncs_and_is_capped() {
        let t0 = Instant::now();
        let mut s = Stats::new(t0);
        for i in 0..(MAX_PENDING + 20) {
            s.sent(&parse(Unit::CodePoints, &guac::encode(&["sync", &(1000 + i as u64).to_string()], Unit::CodePoints)), t0);
        }
        let v = stats_json(&s.tick(t0 + Duration::from_secs(1), None));
        assert_eq!(v["behind"], MAX_PENDING);
        assert_eq!(v["frames"], (MAX_PENDING + 20) as u64);
    }

    #[test]
    fn garbage_timestamps_are_ignored() {
        let t0 = Instant::now();
        let mut s = Stats::new(t0);
        s.sent(&parse(Unit::CodePoints, "4.sync,3.abc;"), t0);
        assert!(!s.received(&parse(Unit::Utf16, "4.sync,3.abc;"), t0));
        assert!(s.received(&parse(Unit::Utf16, "11.telepy-pong,1.x;"), t0));
        let v = stats_json(&s.tick(t0 + Duration::from_secs(1), None));
        assert!(v["frame_ms"].is_null());
        assert_eq!(v["frames"], 1);
    }

    #[test]
    fn byte_formatting() {
        assert_eq!(fmt_bytes(512), "512 B");
        assert_eq!(fmt_bytes(20 * 1024), "20 KB");
        assert_eq!(fmt_bytes(3 * 1024 * 1024 + 200 * 1024), "3.2 MB");
        assert_eq!(fmt_bytes(2 * 1024 * 1024 * 1024), "2.0 GB");
    }
}
