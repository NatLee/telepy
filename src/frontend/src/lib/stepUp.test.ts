import { test } from "node:test";
import assert from "node:assert/strict";
import { usableToken } from "./stepUp.ts";

test("a token is usable until shortly before it ends", () => {
    const now = Date.parse("2026-10-24T10:00:00Z");
    assert.equal(usableToken(null, now), null);
    assert.equal(usableToken({ token: "tps_a", until: "2026-10-24T10:15:00Z" }, now), "tps_a");
    assert.equal(usableToken({ token: "tps_a", until: "2026-10-24T10:00:05Z" }, now), null, "about to expire");
    assert.equal(usableToken({ token: "tps_a", until: "garbage" }, now), null);
    assert.equal(usableToken({ token: "", until: "2026-10-24T10:15:00Z" }, now), null);
});
