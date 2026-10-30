import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECK_IDS, GROUP_OF, checksIn, countStatuses, groupCounts, groupStatuses, initialHealthTab, parseHealthTab, parseServerHealth, problems, sortChecks, worstStatus } from "./serverHealth.ts";

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
    assert.deepEqual(odd.checks, [{ id: null, name: "x", status: "info", detail: "", fingerprint: "", ack: null, staleAck: null }]);
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

test("checks are recognised by id, or by name from an older backend", () => {
    const h = parseServerHealth({ checks: [{ id: "guacd", name: "x", status: "warn" }, { name: "SSH gateway", status: "ok" }, { id: "nope", name: "Something new", status: "info" }] })!;
    assert.deepEqual(h.checks.map((c) => c.id), ["guacd", "gateway", null]);
    assert.deepEqual(checksIn(h.checks, "keys").map((c) => c.name), ["SSH gateway"]);
    assert.deepEqual(checksIn(h.checks, "config").map((c) => c.name), ["Something new"]);
    const g = groupStatuses(h.checks);
    assert.equal(g.services, "warn");
    assert.equal(g.keys, "ok");
    assert.equal(g.storage, "ok");
});

test("every id has a group, tabs parse", () => {
    for (const id of CHECK_IDS) assert.ok(GROUP_OF[id]);
    assert.equal(parseHealthTab("keys"), "keys");
    assert.equal(parseHealthTab("bogus"), "overview");
    assert.equal(parseHealthTab(null), "overview");
});

test("counts per level and per group, and the problems list", () => {
    const h = parseServerHealth(answer)!;
    assert.deepEqual(countStatuses(h.checks), { ok: 2, info: 1, warn: 1, fail: 1, acked: 0 });
    const g = groupCounts(h.checks);
    assert.deepEqual(g.services, { ok: 0, info: 1, warn: 0, fail: 1, acked: 0 });
    assert.deepEqual(g.addresses, { ok: 0, info: 0, warn: 1, fail: 0, acked: 0 });
    assert.deepEqual(g.keys, { ok: 0, info: 0, warn: 0, fail: 0, acked: 0 });
    assert.deepEqual(problems(h.checks).map((c) => c.id), ["guacd", "client_addresses"]);
    assert.deepEqual(problems([]), []);
});

test("old #client-ip links open the addresses tab", () => {
    assert.equal(initialHealthTab(null, "#client-ip"), "addresses");
    assert.equal(initialHealthTab("keys", "#client-ip"), "keys", "an explicit tab wins");
    assert.equal(initialHealthTab(null, ""), "overview");
    assert.equal(initialHealthTab("storage", null), "storage");
});

test("an acknowledged problem is no longer an alert; a stale one still is", () => {
    const ack = { by: "admin", at: "2026-10-30T02:00:00Z", note: "restored database" };
    const h = parseServerHealth({
        checks: [
            { id: "audit_log", name: "audit log", status: "fail", detail: "x", fingerprint: "f1", ack },
            { id: "guacd", name: "g", status: "warn", detail: "y", fingerprint: "f2", stale_ack: ack },
            { id: "database", name: "d", status: "ok", detail: "z", fingerprint: "f3" },
        ],
    })!;
    assert.deepEqual(h.checks[0].ack, ack);
    assert.equal(h.checks[1].ack, null);
    assert.deepEqual(h.checks[1].staleAck, ack);
    assert.equal(worstStatus(h.checks), "warn");
    assert.deepEqual(problems(h.checks).map((c) => c.id), ["guacd"]);
    assert.deepEqual(countStatuses(h.checks), { ok: 1, info: 0, warn: 1, fail: 0, acked: 1 });
    assert.equal(groupStatuses(h.checks).storage, "ok");
});
