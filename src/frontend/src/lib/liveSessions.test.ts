import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSessions, groupByTunnel, usersIn } from "./liveSessions.ts";
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
    // 管理區的使用者篩選；null / 沒給 = 不篩。/ The admin user filter; null / missing = no filter.
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: false, tunnelId: null, userId: 2 }).map((x) => x.id), [2, 3]);
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: false, tunnelId: 2, userId: 2 }).map((x) => x.id), [3]);
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: false, tunnelId: null, userId: null }).map((x) => x.id), [1, 2, 3]);
});

test("the people in the list, once each, by name", () => {
    assert.deepEqual(usersIn(list), [{ id: 2, username: "bob" }, { id: 1, username: "me" }]);
    assert.deepEqual(usersIn([]), []);
});

test("groups per tunnel, sorted by name then start", () => {
    const g = groupByTunnel(list);
    assert.deepEqual(g.map((x) => x.name), ["homelab", "office-pi"]);
    assert.deepEqual(g[1].sessions.map((x) => x.id), [3, 1]);
});

test("SESSION-ENDED wording: feature, lost access, or who", async () => {
    const { endedNotice } = await import("./liveSessions.ts");
    assert.deepEqual(endedNotice({ feature: "terminal", by: "admin" }), { kind: "feature", feature: "terminal", detached: false });
    assert.deepEqual(endedNotice({ feature: "network", detached: true }), { kind: "feature", feature: "network", detached: true }, "a kept shell says so");
    assert.deepEqual(endedNotice({ reason: "access_removed", by: "Telepy (access changed)", detached: true }), { kind: "lost", reason: "accessRemoved", detached: true });
    assert.deepEqual(endedNotice({ reason: "detach_off" }), { kind: "lost", reason: "detachOff", detached: false });
    assert.deepEqual(endedNotice({ reason: "something_new", by: "Telepy" }), { kind: "by", by: "Telepy" }, "an unknown reason falls back to who");
    assert.deepEqual(endedNotice({ by: "carol" }), { kind: "by", by: "carol" });
});

test("an access-changed toast is worded per kind", async () => {
    const { lostToast } = await import("./liveSessions.ts");
    assert.deepEqual(lostToast("loginRemoved", "files"), { key: "sessions.lost.loginRemoved", need: "sessions.need.files" });
    assert.deepEqual(lostToast("accessRemoved", "rustdesk"), { key: "sessions.lost.accessRemoved", need: "sessions.need.desktop" }, "RustDesk needs what a desktop needs");
    assert.deepEqual(lostToast("loginRemoved", "ssh"), { key: "sessions.lost.ssh.loginRemoved", need: "sessions.need.ssh" }, "laptop SSH: no allowed account left");
    assert.deepEqual(lostToast("accessRemoved", "watch"), { key: "sessions.lost.watch", need: null }, "a watcher no longer manages the tunnel");
    assert.deepEqual(lostToast("accountDisabled", "terminal"), { key: "sessions.lost.accountDisabled", need: null }, "nothing to explain");
    assert.deepEqual(lostToast("detachOff", "terminal"), { key: "sessions.lost.detachOff", need: null });
    assert.deepEqual(lostToast("loginRemoved", "something"), { key: "sessions.lost.loginRemoved", need: null }, "an unknown kind gets the plain sentence");
});
