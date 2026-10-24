import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSessions, groupByTunnel } from "./liveSessions.ts";
import type { LiveSession } from "../types/liveSession.ts";

const s = (id: number, tunnel: [number, string], kind: string, mine: boolean, since: string): LiveSession => ({
    id, tunnel: { id: tunnel[0], name: tunnel[1] }, user: { id: mine ? 1 : 2, username: mine ? "me" : "bob" }, kind, ip: null, since, client: null, mine,
});

const list = [
    s(1, [2, "office-pi"], "terminal", true, "2026-10-24T10:05:00Z"),
    s(2, [1, "homelab"], "ssh", false, "2026-10-24T10:01:00Z"),
    s(3, [2, "office-pi"], "files", false, "2026-10-24T10:00:00Z"),
];

test("filters", () => {
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: false, tunnelId: null }).map((x) => x.id), [1, 2, 3]);
    assert.deepEqual(filterSessions(list, { kind: "terminal", mineOnly: false, tunnelId: null }).map((x) => x.id), [1]);
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: true, tunnelId: null }).map((x) => x.id), [1]);
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: false, tunnelId: 2 }).map((x) => x.id), [1, 3]);
});

test("groups per tunnel, sorted by name then start", () => {
    const g = groupByTunnel(list);
    assert.deepEqual(g.map((x) => x.name), ["homelab", "office-pi"]);
    assert.deepEqual(g[1].sessions.map((x) => x.id), [3, 1]);
});
