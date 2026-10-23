// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTunnels, matchTunnel, parseQuery, tokenize, type MatchContext } from "./tunnelQuery.ts";
import type { Tunnel, TunnelHealth } from "../types/tunnel";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const tunnel = (over: Partial<Tunnel>): Tunnel => ({
    id: 1, host_friendly_name: "nas", reverse_port: 1024, is_owner: true, can_edit: true, can_share: true, can_delete: true, ...over,
});
const ctx = (health: TunnelHealth): MatchContext => ({ health, now: NOW });
const match = (q: string, t: Tunnel, health: TunnelHealth = "online") => matchTunnel(t, parseQuery(q), ctx(health));

test("tokenize keeps quoted phrases", () => {
    assert.deepEqual(tokenize(`status:up "home lab" -shared:in`), ["status:up", "home lab", "-shared:in"]);
    assert.deepEqual(tokenize(`user:"bob smith"`), ["user:bob smith"]);
});

test("parse separates filters, text and invalid terms", () => {
    const q = parseQuery("Status:Offline,never nas port:abc foo:bar");
    assert.deepEqual(q.filters.map((f) => [f.key, f.values]), [["status", ["offline", "never"]]]);
    assert.deepEqual(q.text, ["nas"]);
    assert.deepEqual(q.invalid, ["port:abc", "foo:bar"], "unknown keys are reported, not searched");
    assert.deepEqual(parseQuery("fe80::1 10.0.0.1:22").text, ["fe80::1", "10.0.0.1:22"], "addresses stay text");
});

test("status, up/down and negation", () => {
    const t = tunnel({});
    assert.ok(match("status:degraded", t, "degraded"));
    assert.ok(match("status:up", t, "degraded"));
    assert.ok(!match("status:down", t, "degraded"));
    assert.ok(match("status:offline,never", t, "never"));
    assert.ok(!match("-status:never", t, "never"));
});

test("shared", () => {
    assert.ok(match("shared:in", tunnel({ is_owner: false })));
    assert.ok(match("shared:out", tunnel({ shared_with_count: 2 })));
    assert.ok(match("shared:no", tunnel({ shared_with_count: 0 })));
    assert.ok(!match("shared:no", tunnel({ is_owner: false })));
});

test("port exact, range and comparison", () => {
    const t = tunnel({ reverse_port: 1500 });
    assert.ok(match("port:1500", t));
    assert.ok(match("port:2000-1000", t), "reversed ranges work");
    assert.ok(match("port:>1024", t));
    assert.ok(!match("port:<1024", t));
});

test("lastseen counts connected tunnels as now and never as missing", () => {
    const old = tunnel({ last_seen_at: "2026-10-20T12:00:00Z" });
    assert.ok(match("lastseen:>2d", old, "offline"));
    assert.ok(!match("lastseen:<1d", old, "offline"));
    assert.ok(match("lastseen:<5m", tunnel({}), "online"));
    assert.ok(match("lastseen:never", tunnel({}), "never"));
    assert.ok(!match("lastseen:>1h", tunnel({}), "never"));
});

test("text matches name, description, port, IP and users", () => {
    const t = tunnel({
        description: "Plex in the garage",
        endpoint: { ip: "203.0.113.7", live: true, connected_at: "", last_seen_at: null },
        presence: { count: 1, sessions: [{ user: "alice", kind: "terminal", ip: null, since: "", client: null }] },
    });
    for (const q of ["NAS", "garage", "1024", "203.0", "alice", "ip:203.0.113", "user:ali", `"in the garage"`]) assert.ok(match(q, t), q);
    assert.ok(!match("nas basement", t), "all terms must match");
});

test("status sort puts degraded first, lastseen puts never last", () => {
    const list = [
        tunnel({ id: 1, host_friendly_name: "a" }),
        tunnel({ id: 2, host_friendly_name: "b", last_seen_at: "2026-10-23T11:00:00Z" }),
        tunnel({ id: 3, host_friendly_name: "c" }),
        tunnel({ id: 4, host_friendly_name: "d", last_seen_at: "2026-10-01T00:00:00Z" }),
    ];
    const health: Record<number, TunnelHealth> = { 1: "never", 2: "offline", 3: "degraded", 4: "offline" };
    const c = (t: Tunnel) => ctx(health[t.id]);
    assert.deepEqual([...list].sort((x, y) => compareTunnels(x, y, "status", c)).map((t) => t.id), [3, 2, 4, 1]);
    assert.deepEqual([...list].sort((x, y) => compareTunnels(x, y, "lastseen", c)).map((t) => t.id), [3, 2, 4, 1]);
});
