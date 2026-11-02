// node --test（Node 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finishedFor, isCutStatus, newRequestId, REQUEST_HEADER } from "./longRequest.ts";

test("proxy timeouts count as cut, a down backend does not", () => {
    for (const s of [502, 504, 520, 522, 524]) assert.equal(isCutStatus(s), true, String(s));
    for (const s of [200, 400, 404, 409, 500, 503, 525]) assert.equal(isCutStatus(s), false, String(s));
});

test("request ids are what the backend accepts", () => {
    const id = newRequestId();
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.notEqual(newRequestId(), newRequestId());
    assert.equal(newRequestId(() => 0), "r-0000000000000000");
});

test("only this request's finish is taken", () => {
    assert.deepEqual(finishedFor({ action: "REQUEST-FINISHED", request: "r-1", status: 200, body: { deleted: true } }, "r-1"), { status: 200, body: { deleted: true } });
    assert.equal(finishedFor({ action: "REQUEST-FINISHED", request: "r-2", status: 200 }, "r-1"), null);
    assert.equal(finishedFor({ action: "TUNNEL-DELETE-PROGRESS", request: "r-1" }, "r-1"), null);
    assert.deepEqual(finishedFor({ action: "REQUEST-FINISHED", request: "r-1" }, "r-1"), { status: 500, body: null });
});

test("the header and the notification match the backend", () => {
    const rs = readFileSync(new URL("../../../backend-api/src/api/detached.rs", import.meta.url), "utf8");
    assert.ok(rs.includes(`REQUEST_HEADER: &str = "${REQUEST_HEADER.toLowerCase()}"`), "header name");
    assert.ok(rs.includes('"action": "REQUEST-FINISHED"'), "notification action");
});
