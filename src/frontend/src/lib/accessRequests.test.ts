import { test } from "node:test";
import assert from "node:assert/strict";
import { durationLabel, higherPermissions, requestErrorKey } from "./accessRequests.ts";

test("only higher permissions can be asked for", () => {
    assert.deepEqual(higherPermissions("view"), ["edit", "admin"]);
    assert.deepEqual(higherPermissions("edit"), ["admin"]);
    assert.deepEqual(higherPermissions("admin"), []);
    assert.deepEqual(higherPermissions("owner"), []);
});

test("duration labels", () => {
    assert.deepEqual(durationLabel(8 * 3600), { key: "share.request.h8" });
    assert.deepEqual(durationLabel(2 * 86400), { key: "share.request.days", n: 2 });
    assert.deepEqual(durationLabel(2 * 3600), { key: "share.request.hours", n: 2 });
    assert.deepEqual(durationLabel(45 * 60), { key: "share.request.minutes", n: 45 });
});

test("error codes", () => {
    assert.equal(requestErrorKey("request_pending"), "share.request.err.pending");
    assert.equal(requestErrorKey("something_else"), null);
    assert.equal(requestErrorKey(undefined), null);
});
