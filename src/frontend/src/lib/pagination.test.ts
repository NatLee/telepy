import { test } from "node:test";
import assert from "node:assert/strict";
import { clampPage, pageCount, pageRange, pageSlice, pageWindow } from "./pagination.ts";

test("page count, clamping and range", () => {
    assert.equal(pageCount(0, 10), 1);
    assert.equal(pageCount(10, 10), 1);
    assert.equal(pageCount(11, 10), 2);
    assert.equal(clampPage(0, 3), 1);
    assert.equal(clampPage(9, 3), 3);
    assert.equal(clampPage(Number.NaN, 3), 1);
    assert.deepEqual(pageRange(2, 10, 47), { from: 11, to: 20 });
    assert.deepEqual(pageRange(5, 10, 47), { from: 41, to: 47 });
    assert.deepEqual(pageRange(9, 10, 47), { from: 41, to: 47 });
    assert.deepEqual(pageRange(1, 10, 0), { from: 0, to: 0 });
});

test("slice follows the clamped page", () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    assert.deepEqual(pageSlice(items, 3, 10), [20, 21, 22]);
    assert.deepEqual(pageSlice(items, 7, 10), [20, 21, 22]);
    assert.deepEqual(pageSlice([], 1, 10), []);
});

test("page window keeps seven slots with gaps", () => {
    assert.deepEqual(pageWindow(1, 1), [1]);
    assert.deepEqual(pageWindow(3, 7), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(pageWindow(1, 20), [1, 2, 3, 4, 5, "gap", 20]);
    assert.deepEqual(pageWindow(4, 20), [1, 2, 3, 4, 5, "gap", 20]);
    assert.deepEqual(pageWindow(10, 20), [1, "gap", 9, 10, 11, "gap", 20]);
    assert.deepEqual(pageWindow(17, 20), [1, "gap", 16, 17, 18, 19, 20]);
    assert.deepEqual(pageWindow(20, 20), [1, "gap", 16, 17, 18, 19, 20]);
});
