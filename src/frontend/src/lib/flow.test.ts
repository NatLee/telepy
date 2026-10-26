import { test } from "node:test";
import assert from "node:assert/strict";
import { statesAlong } from "./flow.ts";

const ORDER = ["a", "b", "c", "d"] as const;

test("statesAlong marks the failing spot red, earlier ones ok and later ones waiting", () => {
    assert.deepEqual(statesAlong(ORDER, { failedAt: "c" }), { a: "ok", b: "ok", c: "failed", d: "waiting" });
});

test("statesAlong marks an active range and the whole path when done", () => {
    assert.deepEqual(statesAlong(ORDER, { activeFrom: "b", activeTo: "c" }), { a: "ok", b: "active", c: "active", d: "waiting" });
    assert.deepEqual(statesAlong(ORDER, { activeFrom: "b" }), { a: "ok", b: "active", c: "waiting", d: "waiting" });
    assert.deepEqual(statesAlong(ORDER, { done: true }), { a: "ok", b: "ok", c: "ok", d: "ok" });
    assert.deepEqual(statesAlong(ORDER, {}), { a: "waiting", b: "waiting", c: "waiting", d: "waiting" });
    assert.deepEqual(statesAlong(ORDER, { okUntil: "b" }), { a: "ok", b: "ok", c: "waiting", d: "waiting" });
});
