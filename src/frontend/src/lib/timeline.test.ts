import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, dayRelation, groupByDay, highlightSegments, labelDays } from "./timeline.ts";

const items = [
    { id: 1, day: "2026-10-24", date: "Sat, Oct 24" },
    { id: 2, day: "2026-10-24", date: "Sat, Oct 24" },
    { id: 3, day: "2026-10-23", date: "Fri, Oct 23" },
    { id: 4, day: "2026-10-22", date: "Thu, Oct 22" },
];

test("group consecutive items per day", () => {
    assert.deepEqual(groupByDay(items).map((g) => [g.day, g.items.map((x) => x.id)]), [
        ["2026-10-24", [1, 2]],
        ["2026-10-23", [3]],
        ["2026-10-22", [4]],
    ]);
    assert.deepEqual(groupByDay([]), []);
});

test("headings say today / yesterday", () => {
    const t = (k: string) => ({ "ui.today": "Today", "ui.yesterday": "Yesterday" })[k] ?? k;
    const now = new Date(2026, 9, 24, 9, 0);
    assert.deepEqual(labelDays(items, now, t).map((g) => g.label), ["Today · Sat, Oct 24", "Yesterday · Fri, Oct 23", "Thu, Oct 22"]);
});

test("day keys and today / yesterday across a year", () => {
    const now = new Date(2026, 0, 1, 0, 30); // 1 Jan, just after midnight
    assert.equal(dayKey(now), "2026-01-01");
    assert.equal(dayRelation("2026-01-01", now), "today");
    assert.equal(dayRelation("2025-12-31", now), "yesterday");
    assert.equal(dayRelation("2025-12-30", now), null);
});

test("highlight segments", () => {
    assert.deepEqual(highlightSegments("abc", ""), [{ text: "abc", hit: false }]);
    assert.deepEqual(highlightSegments("Port 22 to port 2222", "port"), [
        { text: "Port", hit: true },
        { text: " 22 to ", hit: false },
        { text: "port", hit: true },
        { text: " 2222", hit: false },
    ]);
    assert.deepEqual(highlightSegments("2222", "22"), [
        { text: "22", hit: true },
        { text: "22", hit: true },
    ]);
    assert.deepEqual(highlightSegments("nothing here", "zzz"), [{ text: "nothing here", hit: false }]);
});
