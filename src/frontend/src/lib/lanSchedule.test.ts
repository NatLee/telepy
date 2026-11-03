import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVERY, everyKey, labelled, scheduleChanged, timeline } from "./lanSchedule.ts";

test("the intervals are the backend's", () => {
    const rust = readFileSync(new URL("../../../backend-api/src/lan/watch.rs", import.meta.url), "utf8");
    const m = /pub const EVERY: &\[i64\] = &\[([^\]]+)\]/.exec(rust);
    assert.ok(m, "EVERY not found in lan/watch.rs");
    const values = m[1].split(",").map((x) => x.trim().replace(/_/g, "").split("*").map((n) => Number(n.trim())).reduce((a, b) => a * b, 1));
    assert.deepEqual(values, [...EVERY]);
    assert.deepEqual(EVERY.map(everyKey), ["1h", "6h", "12h", "1d", "1w"]);
    assert.equal(everyKey(60), null);
});

test("the timeline runs from the last run to the next few", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const pts = timeline("2026-11-03T10:00:00Z", "2026-11-03T16:00:00Z", 6 * 3600, now, 3);
    assert.deepEqual(pts.map((p) => p.kind), ["last", "now", "next", "next", "next"]);
    assert.equal(pts[0].at, 0);
    assert.equal(pts[4].at, 1);
    assert.ok(pts[1].at > 0 && pts[1].at < pts[2].at, "now sits between the last and the next run");
    // 沒跑過：從現在往前一個間隔開始，沒有「上次」的點。/ Never ran: starts one interval back, no "last" point.
    const fresh = timeline(null, "2026-11-03T13:00:00Z", 3600, now, 2);
    assert.deepEqual(fresh.map((p) => p.kind), ["now", "next", "next"]);
    // 過期了（裝置離線時）：下次就是現在。/ Overdue (device offline): the next run is now.
    const late = timeline("2026-11-03T05:00:00Z", "2026-11-03T06:00:00Z", 3600, now, 1);
    assert.equal(late.find((p) => p.kind === "next")?.time, now);
    assert.deepEqual(timeline(null, "nonsense", 3600, now), []);
});

test("whether the form differs from the saved schedule", () => {
    const defaults = [22, 80];
    const saved = { every_secs: 3600, subnets: null, ports: null, identify: true, username: "pi" };
    const draft = { every: 3600, subnets: [], ports: [80, 22], identify: true, username: "pi" };
    assert.equal(scheduleChanged(saved, draft, defaults), false, "no saved ports = the defaults, order doesn't matter");
    assert.equal(scheduleChanged(saved, { ...draft, every: 21600 }, defaults), true);
    assert.equal(scheduleChanged(saved, { ...draft, every: 0 }, defaults), true, "turning it off is a change");
    assert.equal(scheduleChanged(saved, { ...draft, ports: [22] }, defaults), true);
    assert.equal(scheduleChanged(saved, { ...draft, subnets: ["192.168.1.0/24"] }, defaults), true);
    assert.equal(scheduleChanged(null, { ...draft, every: 0 }, defaults), false, "nothing saved and no repeat");
    assert.equal(scheduleChanged(null, draft, defaults), true);
});

test("labels never crowd each other", () => {
    const pts = [
        { at: 0, time: 0, kind: "last" as const },
        { at: 0.3, time: 1, kind: "now" as const },
        { at: 0.33, time: 2, kind: "next" as const },
        { at: 0.66, time: 3, kind: "next" as const },
        { at: 1, time: 4, kind: "next" as const },
    ];
    assert.deepEqual(labelled(pts), [true, false, true, true, true], "now is too close to the next run, which wins");
    assert.deepEqual(labelled(pts, 0.5), [false, false, true, false, true], "a wide gap keeps the next run and the far end");
});
