import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultExpanded, filterDevices, kindCounts } from "./topology.ts";

const dev = (id: number, hosts: number, online = false) => ({ id, hosts: Array.from({ length: hosts }, (_, i) => i), online });
const devices = [dev(1, 3, true), dev(2, 0), dev(3, 5), dev(4, 0, true)];
const on = (d: { online: boolean }) => d.online;

test("filter buckets and counts", () => {
    const r = filterDevices(devices, "hosts", on);
    assert.deepEqual(r.shown.map((d) => d.id), [1, 3]);
    assert.deepEqual(r.counts, { all: 4, hosts: 2, online: 2 });
    assert.deepEqual(filterDevices(devices, "online", on).shown.map((d) => d.id), [1, 4]);
});

test("an empty bucket falls back to all", () => {
    assert.equal(filterDevices([dev(1, 0)], "hosts", on).shown.length, 1);
});

test("kind counts: most first, ties in the given order", () => {
    const kinds = ["ssh", "web", "ssh", "other", "web", "desktop"];
    assert.deepEqual(kindCounts(kinds, (k) => k, ["ssh", "desktop", "files", "web", "other"]), [
        { kind: "ssh", count: 2 },
        { kind: "web", count: 2 },
        { kind: "desktop", count: 1 },
        { kind: "other", count: 1 },
    ]);
});

test("few devices: those with hosts start expanded; many: only the focused one", () => {
    assert.deepEqual([...defaultExpanded(devices, null)].sort(), [1, 3]);
    const many = Array.from({ length: 10 }, (_, i) => dev(i + 1, i % 2));
    assert.deepEqual([...defaultExpanded(many, null)], []);
    assert.deepEqual([...defaultExpanded(many, 7)], [7]);
});
