import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, expiryState, expiryValue } from "./keyExpiry.ts";

const NOW = new Date(2026, 9, 24, 10, 0, 0); // local 2026-10-24 10:00

test("presets become the end of a local day", () => {
    assert.equal(addDays(30, NOW), "2026-11-23");
    assert.equal(expiryValue("30", "", "create", NOW), new Date(2026, 10, 23, 23, 59, 59).toISOString());
    assert.equal(expiryValue("custom", "2027-01-05", "update", NOW), new Date(2027, 0, 5, 23, 59, 59).toISOString());
    assert.equal(expiryValue("custom", "", "update", NOW), undefined, "no date picked yet");
});

test("never is omitted on create and null on update", () => {
    assert.equal(expiryValue("never", "", "create", NOW), undefined);
    assert.equal(expiryValue("never", "", "update", NOW), null);
});

test("card state", () => {
    const now = NOW.getTime();
    assert.equal(expiryState(null, now), "none");
    assert.equal(expiryState(new Date(now - 1000).toISOString(), now), "expired");
    assert.equal(expiryState(new Date(now + 3 * 86_400_000).toISOString(), now), "soon");
    assert.equal(expiryState(new Date(now + 30 * 86_400_000).toISOString(), now), "ok");
});
