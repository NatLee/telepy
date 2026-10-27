import { test } from "node:test";
import assert from "node:assert/strict";
import { countApiCalls, filterApiCalls, formatDuration, statusClass, waysIn, type ApiCall } from "./apiCalls.ts";

const c = (id: number, method: string, route: string, status: number, extra: Partial<ApiCall> = {}): ApiCall => ({
    id,
    at: "2026-10-27T10:00:00Z",
    user: { id: 1, username: "alice" },
    token: { id: 3, name: "ci", prefix: "tpt_abcdef" },
    grant_id: null,
    client_name: 'API token "ci"',
    kind: method === "MCP" ? "mcp" : "rest",
    method,
    route,
    tunnel: null,
    status,
    duration_ms: 5,
    ip: "203.0.113.9",
    error: null,
    ...extra,
});

const ROWS = [
    c(1, "GET", "/api/reverse/server/dashboard", 200),
    c(2, "DELETE", "/api/reverse/server/keys/{id}", 403, { tunnel: { id: 4, name: "nas" } }),
    c(3, "POST", "/api/browser/sessions", 502),
    c(4, "MCP", "list_tunnels", 200),
    c(5, "MCP", "browser_open", 400, { error: "Tunnel 9 not found." }),
];

test("status classes", () => {
    assert.equal(statusClass(204), "ok");
    assert.equal(statusClass(302), "ok");
    assert.equal(statusClass(404), "4xx");
    assert.equal(statusClass(503), "5xx");
});

test("filters by status, method and search; counts follow the other filters", () => {
    const f = { query: "", status: "all" as const, method: "all" as const };
    assert.equal(filterApiCalls(ROWS, f).length, 5);
    assert.deepEqual(filterApiCalls(ROWS, { ...f, status: "4xx" }).map((r) => r.id), [2, 5]);
    assert.deepEqual(filterApiCalls(ROWS, { ...f, method: "MCP" }).map((r) => r.id), [4, 5]);
    assert.deepEqual(filterApiCalls(ROWS, { ...f, query: "nas delete" }).map((r) => r.id), [2]);
    assert.deepEqual(filterApiCalls(ROWS, { ...f, query: "not found" }).map((r) => r.id), [5], "errors are searchable");
    assert.deepEqual(filterApiCalls(ROWS, { ...f, query: "403" }).map((r) => r.id), [2]);
    const counts = countApiCalls(ROWS, { ...f, method: "MCP" });
    assert.deepEqual([counts.status.all, counts.status.ok, counts.status["4xx"], counts.status["5xx"]], [2, 1, 1, 0]);
    assert.equal(counts.method.all, 5, "method counts ignore the method filter itself");
    assert.equal(countApiCalls(ROWS, { ...f, status: "ok" }).method.GET, 1);
});

test("durations", () => {
    assert.equal(formatDuration(12.4), "12 ms");
    assert.equal(formatDuration(1430), "1.4 s");
    assert.equal(formatDuration(42_000), "42 s");
});

test("each revoke cuts only its own way in", () => {
    assert.ok(waysIn("none").every((w) => !w.cut && w.devices === "ok"));
    for (const which of ["web", "token", "app"] as const) {
        const ways = waysIn(which);
        const cut = ways.filter((w) => w.cut);
        assert.deepEqual(cut.map((w) => w.id), [which]);
        assert.equal(cut[0].credential, "failed");
        assert.ok(ways.filter((w) => !w.cut).every((w) => w.credential === "ok" && w.devices === "ok"));
    }
});
