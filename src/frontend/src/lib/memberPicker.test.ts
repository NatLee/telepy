import { test } from "node:test";
import assert from "node:assert/strict";
import { pickerView, toggleMany } from "./memberPicker.ts";

const e = (id: number, name: string, group: number | null) => ({ id, text: [name, `fp-${id}`], group });
const entries = [e(1, "MacBook", null), e(2, "ThinkPad", 7), e(3, "iPad", 9), e(4, "Mac mini", null), e(5, "Pixel", 9)];

test("search narrows every bucket and its count", () => {
    const r = pickerView(entries, new Set([2]), "mac", "all");
    assert.deepEqual(r.shown.map((x) => x.id), [1, 4]);
    assert.deepEqual(r.counts, { all: 2, selected: 0, free: 2 });
});

test("all search terms must match, in any field", () => {
    assert.deepEqual(pickerView(entries, new Set(), "mac fp-4", "all").shown.map((x) => x.id), [4]);
});

test("in no group = not grouped when the editor opened, ticking doesn't move rows", () => {
    const r = pickerView(entries, new Set([1]), "", "free");
    assert.deepEqual(r.shown.map((x) => x.id), [1, 4]);
    assert.equal(r.counts.free, 2);
});

test("selected keeps rows unticked while the bucket is open", () => {
    const r = pickerView(entries, new Set([5]), "", "selected", new Set([3, 5]));
    assert.deepEqual(r.shown.map((x) => x.id), [3, 5]);
    assert.equal(r.counts.selected, 1);
});

test("toggleMany appends new ids and removes a batch", () => {
    assert.deepEqual(toggleMany([3, 1], [1, 2, 4], true), [3, 1, 2, 4]);
    assert.deepEqual(toggleMany([3, 1, 2, 4], [1, 4, 9], false), [3, 2]);
});
