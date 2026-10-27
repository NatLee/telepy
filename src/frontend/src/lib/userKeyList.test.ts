// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterKeys, matrixColumns, sortKeys } from "./userKeyList.ts";
import type { UserKey } from "../types/keys.ts";

const key = (id: number, name: string, used: string | null, created = "2026-01-01T00:00:00Z"): UserKey =>
    ({ id, host_friendly_name: name, last_used_at: used, created_at: created, comment: null, fingerprint: `SHA256:${name}`, key_type: "ED25519", bits: 256, description: null, last_used_ip: null }) as unknown as UserKey;

const keys = [key(1, "old", "2026-01-01T00:00:00Z"), key(2, "fresh", "2026-10-01T00:00:00Z"), key(3, "never", null), key(4, "mid", "2026-05-01T00:00:00Z"), key(5, "late", "2026-09-01T00:00:00Z")];

test("recent sort puts unused keys last", () => {
    assert.deepEqual(sortKeys(keys, "recent").map((k) => k.id), [2, 5, 4, 1, 3]);
});

test("matrix columns default to the most recently used", () => {
    assert.deepEqual(matrixColumns(keys, null, 3).map((k) => k.id), [2, 5, 4]);
});

test("matrix columns keep the choice in recently-used order and skip deleted keys", () => {
    assert.deepEqual(matrixColumns(keys, [3, 1, 99], 3).map((k) => k.id), [1, 3]);
});

test("a choice with nothing left falls back to the default", () => {
    assert.deepEqual(matrixColumns(keys, [98, 99], 2).map((k) => k.id), [2, 5]);
    assert.deepEqual(matrixColumns(keys, [], 2).map((k) => k.id), [2, 5]);
});

test("filter counts follow the query", () => {
    const r = filterKeys(keys, "l", "all", "recent", () => 0);
    assert.deepEqual(r.keys.map((k) => k.id), [5, 1]);
    assert.equal(r.counts.all, 2);
    assert.equal(r.counts.unused, 0);
});
