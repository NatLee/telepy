import { test } from "node:test";
import assert from "node:assert/strict";
import { keepSpinning, rippleDelay } from "./refreshMotion.ts";

test("the icon keeps turning while either the click's work or a background load runs", () => {
    assert.equal(keepSpinning({ working: true, busy: false }), true);
    assert.equal(keepSpinning({ working: false, busy: true }), true);
    assert.equal(keepSpinning({ working: false, busy: false }), false);
});

test("ripple delays grow per item and flatten after the cap", () => {
    assert.equal(rippleDelay(0), 0);
    assert.equal(rippleDelay(1), 28);
    assert.equal(rippleDelay(5), 140);
    assert.equal(rippleDelay(12), 336);
    assert.equal(rippleDelay(90), 336);
    assert.equal(rippleDelay(3, 10, 2), 20);
    assert.equal(rippleDelay(-1), 0);
    assert.equal(rippleDelay(Number.NaN), 0);
});
