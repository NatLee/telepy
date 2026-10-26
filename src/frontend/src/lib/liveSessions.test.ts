import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSessions, groupByPlace, parsePlaceKey, placeFromParams, placeKey, placeName } from "./liveSessions.ts";
import type { LiveSession } from "../types/liveSession.ts";

const s = (id: number, tunnel: [number, string], kind: string, mine: boolean, since: string): LiveSession => ({
    id, tunnel: { id: tunnel[0], name: tunnel[1] }, user: { id: mine ? 1 : 2, username: mine ? "me" : "bob" }, kind, ip: null, since, client: null, mine,
});
/** 經 Telepy RustDesk 伺服器：沒有隧道。/ Through Telepy's RustDesk server: no tunnel. */
const rd = (id: number, device: [number, string], mine: boolean, since: string): LiveSession => ({
    ...s(id, [0, ""], "rustdesk", mine, since), tunnel: { id: 0, name: null }, device: { id: device[0], name: device[1] },
});

const list = [
    s(1, [2, "office-pi"], "terminal", true, "2026-10-24T10:05:00Z"),
    s(2, [1, "homelab"], "ssh", false, "2026-10-24T10:01:00Z"),
    s(3, [2, "office-pi"], "files", false, "2026-10-24T10:00:00Z"),
    rd(4, [2, "Studio Mac"], false, "2026-10-24T10:02:00Z"),
    rd(5, [9, "Kiosk"], true, "2026-10-24T10:03:00Z"),
];

test("filters", () => {
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: false, place: null }).map((x) => x.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(filterSessions(list, { kind: "terminal", mineOnly: false, place: null }).map((x) => x.id), [1]);
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: true, place: null }).map((x) => x.id), [1, 5]);
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: false, place: { type: "tunnel", id: 2 } }).map((x) => x.id), [1, 3]);
    // 裝置 2 和隧道 2 是不同的地點。/ Device 2 and tunnel 2 are different places.
    assert.deepEqual(filterSessions(list, { kind: "all", mineOnly: false, place: { type: "device", id: 2 } }).map((x) => x.id), [4]);
    assert.deepEqual(filterSessions(list, { kind: "rustdesk", mineOnly: false, place: null }).map((x) => x.id), [4, 5]);
});

test("groups per place, sorted by name then start", () => {
    const g = groupByPlace(list);
    assert.deepEqual(g.map((x) => x.name), ["homelab", "Kiosk", "office-pi", "Studio Mac"]);
    assert.deepEqual(g.map((x) => x.key), ["tunnel:1", "device:9", "tunnel:2", "device:2"]);
    assert.deepEqual(g[2].sessions.map((x) => x.id), [3, 1]);
});

test("place keys and URL parameters", () => {
    assert.equal(placeKey({ type: "device", id: 7 }), "device:7");
    assert.deepEqual(parsePlaceKey("tunnel:3"), { type: "tunnel", id: 3 });
    assert.equal(parsePlaceKey("nope"), null);
    assert.deepEqual(placeFromParams("3", null), { type: "tunnel", id: 3 });
    assert.deepEqual(placeFromParams(null, "7"), { type: "device", id: 7 });
    assert.equal(placeFromParams("x", ""), null);
    assert.equal(placeName(list[3]), "Studio Mac");
    assert.equal(placeName({ ...list[0], tunnel: { id: 5, name: null } }), "#5");
});
