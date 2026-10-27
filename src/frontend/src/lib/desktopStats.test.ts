import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMs, formatRate, laggingHop, latencyTone, parseStats, streamHealth } from "./desktopStats.ts";

test("parseStats turns the relay JSON into per-second numbers", () => {
    const s = parseStats('{"ms":2000,"frame_ms":48,"net_ms":12,"tunnel_ms":30,"frames":24,"merged":1,"down":204800,"up":2000,"behind":1}', 5000);
    assert.ok(s);
    assert.equal(s.windowMs, 2000);
    assert.equal(s.frameMs, 48);
    assert.equal(s.netMs, 12);
    assert.equal(s.tunnelMs, 30);
    assert.equal(s.fps, 12);
    assert.equal(s.downBps, 102400);
    assert.equal(s.upBps, 1000);
    assert.equal(s.behind, 1);
    assert.equal(s.at, 5000);
    const idle = parseStats('{"ms":1000,"frame_ms":null,"net_ms":null,"tunnel_ms":null,"frames":0,"merged":0,"down":0,"up":0,"behind":0}');
    assert.ok(idle);
    assert.equal(idle.frameMs, null);
    assert.equal(idle.fps, 0);
    assert.equal(parseStats("nope"), null);
    assert.equal(parseStats("[1]")?.fps, 0, "an array is an object with no fields");
    assert.equal(parseStats("null"), null);
    // 聲音串流：沒開 = null，開了 = 每秒的量。/ Sound stream: null when none is open, bytes per second otherwise.
    assert.equal(idle.audioBps, null);
    assert.equal(parseStats('{"ms":2000,"audio":null}')?.audioBps, null);
    assert.equal(parseStats('{"ms":2000,"audio":0}')?.audioBps, 0);
    assert.equal(parseStats('{"ms":2000,"audio":352800}')?.audioBps, 176400);
});

test("latency tiers and formatting", () => {
    assert.equal(latencyTone(null), "unknown");
    assert.equal(latencyTone(40), "good");
    assert.equal(latencyTone(200), "fair");
    assert.equal(latencyTone(900), "poor");
    assert.equal(formatRate(0), "0 B/s");
    assert.equal(formatRate(900), "900 B/s");
    assert.equal(formatRate(30 * 1024), "30 KB/s");
    assert.equal(formatRate(2.5 * 1024 * 1024), "2.5 MB/s");
    assert.equal(formatMs(null), "—");
    assert.equal(formatMs(47.6), "48 ms");
});

const base = { windowMs: 1000, frameMs: 50, netMs: 20, tunnelMs: 15, fps: 10, downBps: 1000, upBps: 100, behind: 0, merged: 1, at: 0 };

test("laggingHop blames the slowest hop only when it is slow", () => {
    assert.equal(laggingHop(base), null, "all quick");
    assert.equal(laggingHop({ ...base, netMs: 250, frameMs: 280 }), "web");
    assert.equal(laggingHop({ ...base, tunnelMs: 400 }), "tunnel");
    assert.equal(laggingHop({ ...base, netMs: 20, frameMs: 320 }), "browser", "frame far above network = rendering");
    assert.equal(laggingHop({ ...base, netMs: null, frameMs: null, tunnelMs: null }), null);
    assert.equal(laggingHop({ ...base, netMs: null, frameMs: 500, tunnelMs: 10 }), null, "frame alone cannot be split");
});

test("streamHealth", () => {
    assert.equal(streamHealth(null, false, 0), "stalled");
    assert.equal(streamHealth(base, false, 1000), "live");
    assert.equal(streamHealth(base, false, 5000), "stalled", "stats stopped arriving");
    assert.equal(streamHealth(base, true, 1000), "stalled", "tunnel unstable");
    assert.equal(streamHealth({ ...base, behind: 5 }, false, 1000), "slow");
    assert.equal(streamHealth({ ...base, merged: 3 }, false, 1000), "slow");
    assert.equal(streamHealth({ ...base, frameMs: 600 }, false, 1000), "slow");
    assert.equal(streamHealth({ ...base, fps: 0 }, false, 1000), "idle");
});
