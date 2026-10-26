// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootAt, fmtKb, fmtUptime, nextProbe, refreshWait, thresholdRows, usage, warningKinds } from "./deviceFacts.ts";
import type { TunnelEndpoint } from "../types/tunnel";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const ep = (over: Partial<TunnelEndpoint>): TunnelEndpoint => ({ ip: "198.51.100.7", live: true, connected_at: "2026-10-27T08:00:00Z", last_seen_at: null, ...over });

test("sizes match the backend's format", () => {
    assert.equal(fmtKb(512), "512 KB");
    assert.equal(fmtKb(1900 * 1024), "1.9 GB");
    assert.equal(fmtKb(250 * 1024 * 1024), "250 GB");
});

test("usage", () => {
    const u = usage(1000, 250)!;
    assert.equal(u.usedPct, 75);
    assert.equal(u.freePct, 25);
    assert.equal(usage(null, 1), null);
    assert.equal(usage(0, 0), null);
    assert.equal(usage(100, 200)!.freePct, 100, "clamped");
});

test("warning kinds come from the stored warnings, in a fixed order", () => {
    const e = ep({ facts: { warnings: [{ kind: "reboot", detail: "" }, { kind: "disk", detail: "" }, { kind: "future", detail: "" }] } });
    assert.deepEqual(warningKinds(e), ["disk", "reboot"]);
    assert.deepEqual(warningKinds(null), []);
});

test("boot time and uptime", () => {
    assert.equal(bootAt({ uptime_s: 3600 }, "2026-10-27T12:00:00Z"), NOW - 3_600_000);
    assert.equal(bootAt({}, "2026-10-27T12:00:00Z"), null);
    assert.equal(fmtUptime(3 * 86400 + 4 * 3600 + 5), "3d 4h");
    assert.equal(fmtUptime(5 * 3600 + 12 * 60), "5h 12m");
    assert.equal(fmtUptime(30), "0m");
});

test("next read", () => {
    assert.deepEqual(nextProbe(null, NOW), { kind: "never" });
    assert.deepEqual(nextProbe(ep({ live: false }), NOW), { kind: "reconnect" });
    assert.deepEqual(nextProbe(ep({}), NOW), { kind: "soon" }, "never read");
    assert.deepEqual(nextProbe(ep({ probed_at: "2026-10-27T07:00:00Z" }), NOW), { kind: "soon" }, "not asked during this connection");
    assert.deepEqual(nextProbe(ep({ probed_at: "2026-10-27T09:00:00Z" }), NOW), { kind: "at", at: Date.parse("2026-10-28T09:00:00Z") });
    assert.deepEqual(nextProbe(ep({ connected_at: "2026-10-20T00:00:00Z", probed_at: "2026-10-25T09:00:00Z" }), NOW), { kind: "soon" }, "overdue");
});

test("refresh cool-down", () => {
    assert.equal(refreshWait(null, NOW), 0);
    assert.equal(refreshWait(NOW - 15_000, NOW), 45);
    assert.equal(refreshWait(NOW - 60_000, NOW), 0);
});

test("threshold rows", () => {
    const rows = thresholdRows({ disk_total_kb: 1000, disk_avail_kb: 50, mem_total_kb: 1000, mem_avail_kb: 500, load: [0.5, 0.4, 0.3], cpus: 4, warnings: [{ kind: "disk", detail: "" }] });
    assert.deepEqual(rows.map((r) => [r.kind, r.state]), [["disk", "warn"], ["memory", "ok"], ["load", "ok"], ["reboot", "unknown"]]);
    assert.equal(rows[0].value, 5);
    assert.equal(rows[2].extra, 4);
    assert.ok(thresholdRows(null).every((r) => r.state === "unknown"));
});
