import { test } from "node:test";
import assert from "node:assert/strict";
import { minShareDate, shareEndsIn, shareExpiryState, shareExpiryValue } from "./shareExpiry.ts";

const NOW = new Date(2026, 9, 24, 10, 0, 0); // local 2026-10-24 10:00

test("spans count from now, dates end at the end of a local day", () => {
    assert.equal(shareExpiryValue("never", "", NOW), null);
    assert.equal(shareExpiryValue("1h", "", NOW), new Date(2026, 9, 24, 11, 0, 0).toISOString());
    assert.equal(shareExpiryValue("7d", "", NOW), new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
    assert.equal(shareExpiryValue("date", "2026-11-02", NOW), new Date(2026, 10, 2, 23, 59, 59).toISOString());
    assert.equal(shareExpiryValue("date", "", NOW), undefined, "no date picked yet");
    assert.equal(minShareDate(NOW), "2026-10-25");
});

test("state", () => {
    const now = NOW.getTime();
    assert.equal(shareExpiryState(null, now), "none");
    assert.equal(shareExpiryState("garbage", now), "none");
    assert.equal(shareExpiryState(new Date(now + 2 * 86_400_000).toISOString(), now), "ok");
    assert.equal(shareExpiryState(new Date(now + 3_600_000).toISOString(), now), "soon");
    assert.equal(shareExpiryState(new Date(now - 1000).toISOString(), now), "ending");
});

test("ends in, rounded", () => {
    const now = NOW.getTime();
    const at = (ms: number) => new Date(now + ms).toISOString();
    assert.equal(shareEndsIn(at(8 * 3_600_000 - 60_000), "en", now), "in 8 hours");
    assert.equal(shareEndsIn(at(3 * 86_400_000 - 60_000), "en", now), "in 3 days");
    assert.equal(shareEndsIn(at(90_000), "en", now), "in 2 minutes");
    assert.equal(shareEndsIn(at(10_000), "en", now), "in 1 minute");
});
