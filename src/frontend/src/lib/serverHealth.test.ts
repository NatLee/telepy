import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServerHealth, sortChecks, worstStatus } from "./serverHealth.ts";

const answer = {
    checks: [
        { name: "SECRET_KEY", status: "ok", detail: "set" },
        { name: "GeoIP", status: "info", detail: "not installed (optional)" },
        { name: "client addresses", status: "warn", detail: "all of the last 12 sign-ins came from internal addresses" },
        { name: "database", status: "ok", detail: "/data/db.sqlite3 (3 users, 5 tunnels)" },
        { name: "guacd (remote desktop)", status: "fail", detail: "cannot reach guacd:4822" },
    ],
    ok: 2,
    info: 1,
    warnings: 1,
    failures: 1,
    ran_at: "2026-10-30T01:02:03Z",
};

test("the backend answer is read safely", () => {
    const h = parseServerHealth(answer)!;
    assert.equal(h.checks.length, 5);
    assert.deepEqual([h.ok, h.info, h.warnings, h.failures], [2, 1, 1, 1]);
    assert.equal(h.ranAt, "2026-10-30T01:02:03Z");
    assert.equal(parseServerHealth(null), null);
    assert.equal(parseServerHealth({ ok: 3 }), null, "no checks = not this endpoint");
    const odd = parseServerHealth({ checks: [{ name: "" }, { name: "x", status: "great" }, { status: "ok" }], ok: -1 })!;
    assert.deepEqual(odd.checks, [{ name: "x", status: "info", detail: "" }]);
    assert.equal(odd.ok, 0);
    assert.equal(odd.ranAt, null);
});

test("the worst level ignores notes", () => {
    const h = parseServerHealth(answer)!;
    assert.equal(worstStatus(h.checks), "fail");
    assert.equal(worstStatus(h.checks.filter((c) => c.status !== "fail")), "warn");
    assert.equal(worstStatus(h.checks.filter((c) => c.status === "ok" || c.status === "info")), "ok");
    assert.equal(worstStatus([]), "ok");
});

test("failures come first and the doctor's order holds within a level", () => {
    const h = parseServerHealth(answer)!;
    assert.deepEqual(
        sortChecks(h.checks).map((c) => c.name),
        ["guacd (remote desktop)", "client addresses", "GeoIP", "SECRET_KEY", "database"],
    );
});
